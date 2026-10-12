// Bot DRY Layer 4 — the shared *aide streaming runner*.
//
// Every teacher/parent-facing aide endpoint (/curriculum-stream,
// /unit-designer-stream, /parent-chat-stream) ran a near-identical
// ReadableStream: an `anthropic.beta.messages.toolRunner()` loop that
// streamed text deltas over SSE, inserted a paragraph break between
// pre-tool and post-tool text, persisted the partial every ~200 chars,
// and finalized (on success AND on error) into a per-surface message
// row. The three copies drifted (the unit designer lacked the
// separator fix; parent-chat tracked no tokens). This collapses them
// into one runner; each caller supplies only what differs: the model,
// the persist/finalize mutations, and an optional post-finalize hook
// (e.g. auto-naming a session).
//
// The tutor stream (/session-stream) is deliberately NOT folded in —
// it has a different event surface (artifacts, images, rubric, process
// steps, intermediate tool events) and is the scholar-facing learning
// loop, not an ACL-scoped aide.
//
// Runtime note: this file does NO static `@anthropic-ai/sdk` import —
// the caller constructs the client (lazily, as the http actions do) and
// passes it in. Only `import type` is used, which is erased at build and
// can't pull `node:*` into the edge bundle (see the SDK-pin TODO).

import type { Anthropic } from "@anthropic-ai/sdk";
import { modelLabel } from "./models";
import { aideEffort, aideRefusalFallback, aideThinking } from "./aideModel";
import { UNREPORTED_TOOL_RESULT } from "./toolActivityGroups";
import {
  emptyUsage,
  addStartUsage,
  addDeltaOutput,
  type UsageBreakdown,
} from "./usage";

type ToolRunnerParams = Parameters<
  Anthropic["beta"]["messages"]["toolRunner"]
>[0];

/** The tools array shape the runner accepts. Exported so callers can annotate
 *  their own array: left to inference, a literal with this many tools blows
 *  TS's union complexity limit (TS2590). */
export type AideTools = NonNullable<ToolRunnerParams["tools"]>;

/** One element of `AideTools`, minus the (never emitted here) MCP-toolset
 *  passthrough entry — every OTHER member carries a `name`, so annotating a
 *  tool array as `AideTool[]` still lets callers/tests do `tool.name` while
 *  keeping the same TS2590 fix as `AideTools`. */
export type AideTool = Exclude<AideTools[number], { type: "mcp_toolset" }>;

/**
 * Top-level automatic prompt caching for the tool loop. `cachedSystem` pins a
 * breakpoint after the static system prefix, but nothing marked the growing
 * tail, so every tool-loop iteration re-billed the whole transcript plus every
 * earlier tool result at the full input rate. Prod usage from 2026-09-03 to
 * 2026-09-24 put that at ~57K uncached tokens per Fable aide run: $288 of the
 * platform's $369 in uncached input, across slack-aide, aide-chat, and
 * curriculum-bot. Most runs take 2 to 8+ iterations.
 *
 * The automatic marker moves to the last cacheable block on every request, so
 * iteration N reads everything iteration N-1 sent, and only pays to write the
 * newest tool_use/tool_result delta. A cache read costs 0.025x the base input
 * rate on Fable and 0.05x on Opus 5.5. The tradeoff: a single-iteration run pays the 1.25x write premium on
 * its tail. This is "the robust combination for agent loops": one explicit
 * system breakpoint plus an automatic one, using 2 of the 4 breakpoint slots.
 *
 * Constraints callers own: automatic caching 400s if the LAST message block
 * already carries an explicit `cache_control` with a different TTL, and a 1h
 * entry may not follow this 5m one. No aide caller sets a message-level marker
 * today; the tutor, which does, runs its own loop in http.ts.
 */
const AIDE_LOOP_CACHE_CONTROL = { type: "ephemeral" } as const;

function observeToolResults(
  tools: AideTools,
  onToolResult?: (name: string, result: string) => void,
): AideTools {
  if (!onToolResult) return tools;
  return tools.map((tool) => {
    if (!("run" in tool)) return tool;
    const run = tool.run;
    return {
      ...tool,
      run: async (...args: Parameters<typeof run>) => {
        const result = await run(...args);
        onToolResult(
          tool.name,
          typeof result === "string" ? result : JSON.stringify(result) ?? "",
        );
        return result;
      },
    };
  });
}

/**
 * What the runner tells staff about a `stop_reason: "refusal"`.
 *
 * Opus 5.5 (the aide default) and Fable run pre-output safety classifiers,
 * and they false-positive on plainly benign staff asks (2026-09-03, on Fable:
 * "show a picture of a fulcrum and explain it briefly"). A refusal returns an
 * EMPTY content array, which would otherwise finalize as a blank bubble, so
 * something must always be said.
 *
 * This notice used to say "switch to Opus with the model picker above and
 * resend" — an instruction whose only available mechanism was a PERMANENT,
 * per-person, all-surfaces pin. Staff followed it, and a momentary classifier
 * miss became an invisible forever-downgrade off the best model, immune to the
 * next fleet upgrade. The runner now retries that ONE request on Opus itself
 * (see `aideRefusalFallback`), so the notice is a DISCLOSURE of what happened,
 * never an instruction to change a setting.
 *
 * Three outcomes, one sentence each:
 *  - `retried`  — the fallback answered; say which model spoke, and that
 *                 nothing about their settings changed.
 *  - `declined` — no answer. Suggest a rephrase. Never suggest switching
 *                 models: the switch has already been tried automatically
 *                 where it could help, and where it couldn't, a permanent pin
 *                 was never the right remedy for one request.
 */
export type RefusalOutcome =
  /** The retry produced a real answer, streamed above this notice. */
  | { kind: "retried"; fallback: string }
  /** Still no answer. `fallback` names a retry that ALSO refused, if there was one. */
  | { kind: "declined"; fallback?: string | null };

export function refusalNotice(
  refusedModel: string,
  outcome: RefusalOutcome,
): string {
  const refused = modelLabel(refusedModel);
  if (outcome.kind === "retried") {
    return (
      `${refused} declined this — its safety classifier fired, which is often a false positive. ` +
      `${modelLabel(outcome.fallback)} answered it instead; nothing about your settings changed.`
    );
  }
  if (outcome.fallback) {
    return (
      `${refused} declined this — its safety classifier fired, which is often a false positive. ` +
      `${modelLabel(outcome.fallback)} declined the retry too, so try rephrasing.`
    );
  }
  return `${refused} declined this request (a safety classifier fired — occasionally a false positive). Try rephrasing.`;
}

/**
 * The retry-safety gate: which model (if any) should re-run a refused
 * request.
 *
 * A refusal is only retryable when the run committed NOTHING — no visible
 * text streamed to the reader, no tool call started. Both halves matter:
 * re-running after text would duplicate a half-answer, and re-running after a
 * tool would re-execute its side effects (a created seed, a sent Slack DM).
 * Fable's decline is a PRE-OUTPUT classifier verdict, so the common case is
 * exactly this clean one.
 *
 * Returns the fallback model id, or `null` to leave the refusal alone.
 *
 * Streamed REASONING is deliberately not part of this gate, and reviewers
 * reliably want it to be. Fable always thinks before it speaks, so on a staff
 * surface (`streamThinking`) a reasoning block is emitted before essentially
 * every refusal — gating on it would silently disable this retry on exactly
 * the surface the incident happened on. Reasoning summaries are also live-only:
 * `lib/thinkingStreamState.ts` drops them when the stream ends and the backend
 * never persists them, so an abandoned attempt's reasoning is not a committed
 * half-answer the way streamed text is. The two things a retry must never
 * duplicate — visible answer text and tool side effects — are both still
 * covered.
 */
export function refusalRetryTarget(state: {
  refused: boolean;
  fullContent: string;
  toolsUsed: boolean;
  model: unknown;
}): string | null {
  if (!state.refused || state.fullContent || state.toolsUsed) return null;
  return aideRefusalFallback(String(state.model));
}

/**
 * The notice (if any) to append after a run, given what the retry did.
 * `null` = say nothing, which is the overwhelmingly common non-refusal path.
 */
export function refusalNoticeFor(state: {
  refusedModel: string;
  retriedOnto: string | null;
  /** Did the LAST attempt still end in a refusal? */
  stillRefused: boolean;
}): string | null {
  const { refusedModel, retriedOnto, stillRefused } = state;
  if (retriedOnto) {
    return refusalNotice(
      refusedModel,
      stillRefused
        ? { kind: "declined", fallback: retriedOnto }
        : { kind: "retried", fallback: retriedOnto },
    );
  }
  if (stillRefused) return refusalNotice(refusedModel, { kind: "declined" });
  return null;
}

/**
 * Pull the human-readable message out of an Anthropic API error so a caller
 * can surface the REAL cause instead of a generic "something went wrong".
 *
 * The SDK throws an `APIError` whose parsed body is
 * `{ type: "error", error: { type, message } }`, so the useful sentence lives
 * at `err.error.error.message` (e.g. "Your credit balance is too low to access
 * the Anthropic API. Please go to Plans & Billing…" for a depleted account, or
 * a rate-limit / invalid-request explanation). We read that (with a couple of
 * shape fallbacks) and return it verbatim; anything that isn't a recognizable
 * Anthropic API error returns `null` so the caller keeps its generic fallback
 * (we don't want to leak a raw stack trace / internal error into a reply).
 */
export function anthropicErrorMessage(err: unknown): string | null {
  if (!err || typeof err !== "object") return null;
  const e = err as {
    error?: { error?: { message?: unknown }; message?: unknown };
    status?: number;
  };
  const msg = e.error?.error?.message ?? e.error?.message;
  if (typeof msg === "string" && msg.trim()) return msg.trim();
  return null;
}

/** SSE emit function handed to tools so their `toolComplete` events reach the wire. */
export type AideEmit = (data: Record<string, unknown>) => void;

/**
 * Watches which started tool calls have reported a `toolComplete`, so the SSE
 * stream can settle the ones that never do. A tool reports completion by
 * calling `emit({ toolComplete: { name, result } })` itself; a tool that
 * THROWS never does — the Anthropic SDK converts the throw into an `is_error`
 * tool_result and the tool loop continues normally, so no `toolComplete` ever
 * fires and the row would sit `running` forever. Some tools also take an early
 * refusal return that skips their own emit. This mirrors Slack's
 * `settleRunningToolActivity`, which the non-SSE transport already runs at run
 * close (see `convex/slackBot.ts`).
 *
 * Pure and emit-injected (no globals, no Anthropic client) so the runner loop's
 * bookkeeping is unit-testable on its own.
 */
export function createToolReportTracker(rawEmit: AideEmit): {
  /** wraps rawEmit; forwards everything, and marks a name reported when it
   *  sees that name's `toolComplete` */
  emit: AideEmit;
  /** record that a tool call started (called on the tool_use content block) */
  started(name: string): void;
  /** emit a terminal `toolComplete` for every started-but-unreported call,
   *  oldest first, and clear the pending set */
  settleUnreported(): void;
} {
  // Names of started tool calls that have not yet reported a `toolComplete`, in
  // start order. A report removes the LAST matching entry (see below).
  const pending: string[] = [];

  const emit: AideEmit = (data) => {
    rawEmit(data);
    const tc = (data as { toolComplete?: { name?: unknown } }).toolComplete;
    if (tc && typeof tc.name === "string") {
      // Remove the LAST pending entry with this name, mirroring the
      // `for (let i = n-1; i >= 0; i--)` rule the Slack emit handler and both
      // web hooks (useAgentStream / useStreamRegistry) already use — so N
      // parallel calls of the same tool settle one-for-one instead of doubling.
      for (let i = pending.length - 1; i >= 0; i--) {
        if (pending[i] === tc.name) {
          pending.splice(i, 1);
          break;
        }
      }
    }
  };

  return {
    emit,
    started(name: string) {
      pending.push(name);
    },
    settleUnreported() {
      // Emit through the RAW emit — no need to re-observe our own synthetic
      // event. Oldest first, then clear so a second call is a no-op.
      for (const name of pending) {
        rawEmit({ toolComplete: { name, result: UNREPORTED_TOOL_RESULT } });
      }
      pending.length = 0;
    },
  };
}

/**
 * Build a `system` value with a prompt-cache breakpoint after the stable
 * prefix. A `cache_control` on the system block caches everything before
 * it in the request prefix — crucially the (large, per-turn-identical)
 * tools array AND this static prompt — so only the dynamic suffix +
 * conversation are re-billed at full rate. Typical 3–5× cost win on a
 * multi-turn aide (and lower TTFT on cache hits).
 *
 * `staticText` must be byte-stable across a session's turns (the system
 * prompt minus any per-request context). Per-request context goes in
 * `dynamicText`, which sits after the breakpoint and is never cached.
 *
 * Anthropic only caches prefixes above a model minimum (~1024 tokens for
 * Sonnet); below that the breakpoint is a harmless no-op. Since the tools
 * array is inside the cached prefix, the threshold is comfortably met for
 * the tool-heavy staff aides.
 *
 * TTL: the breakpoint defaults to the 5-minute ephemeral cache. A caller whose
 * matching calls are frequently >5 min apart can pass `{ ttl: "1h" }` to keep
 * the prefix warm longer. The 1h write costs 2× the prefix (vs 1.25× for 5m),
 * so it only pays off when reuse spans the 5-minute window — leave it off for
 * dense-cadence callers. `ttl` is GA (no beta header). Omitting `options` emits
 * exactly `{ type: "ephemeral" }`, byte-identical to the prior form.
 */
export function cachedSystem(
  staticText: string,
  dynamicText?: string | null,
  options?: { ttl?: "5m" | "1h" },
): ToolRunnerParams["system"] {
  const cacheControl: { type: "ephemeral"; ttl?: "5m" | "1h" } = {
    type: "ephemeral",
  };
  if (options?.ttl) cacheControl.ttl = options.ttl;
  const blocks: Array<{
    type: "text";
    text: string;
    cache_control?: { type: "ephemeral"; ttl?: "5m" | "1h" };
  }> = [{ type: "text", text: staticText, cache_control: cacheControl }];
  if (dynamicText && dynamicText.trim()) {
    blocks.push({ type: "text", text: dynamicText });
  }
  return blocks;
}

/** The minimal message shape {@link withConversationCacheBreakpoint} handles —
 *  structurally compatible with both `MessageParam` and `BetaMessageParam`. */
type CacheableMessage = {
  role: "user" | "assistant";
  content: string | Array<{ type: string } & Record<string, unknown>>;
};

/**
 * Add a ROLLING prompt-cache breakpoint on the last user message, so the
 * growing conversation history is read from cache each turn instead of being
 * re-billed in full (TRA-185 item 2).
 *
 * How it pays off: Anthropic looks up a cache hit at the explicit breakpoint
 * AND at every content-block boundary before it (~20 blocks back). On turn N
 * the breakpoint sits on user message N; the lookup walks back and hits the
 * entry turn N-1 wrote at user message N-1, so only the last assistant reply +
 * the new user message are written — everything earlier (tools + system + the
 * whole prior transcript) is a read at ~1/10th rate. Within a turn, the tool
 * runner's follow-up requests (tool_use → tool_result) hit the same entry.
 * Deepest win on long Socratic sessions, where the transcript outgrows the
 * system prompt.
 *
 * Preconditions the caller owns:
 * - The `system` must ALSO carry a breakpoint (see {@link cachedSystem}).
 * - The cross-turn hit requires the ENTIRE prefix — including any dynamic
 *   system block after the cached one — to be byte-identical between turns.
 *   A cache prefix is tools → system → messages; a changed byte anywhere in
 *   the system invalidates every message entry behind it. If observer-written
 *   dynamic system context changes between turns, this breakpoint misses until
 *   that context repeats; minute-varying context must ride after this marker.
 * - The transcript must be append-only across turns. A message rewritten or
 *   removed mid-history (e.g. a one-turn injected whisper) simply misses back
 *   to the system breakpoint on that turn — safe, just not a win that turn.
 * - TTL ordering: Anthropic requires 1h entries to precede 5m entries, so use
 *   the same TTL as the system breakpoint (or shorter).
 *
 * Returns a NEW array; the input is not mutated. A string content becomes a
 * single text block carrying `cache_control`; an array content gets the marker
 * on its last block (text, image, tool_result — all cacheable). Empty content
 * (which the API rejects anyway) and message lists with no user turn are
 * returned unchanged.
 */
export function withConversationCacheBreakpoint<M extends CacheableMessage>(
  messages: readonly M[],
  options?: { ttl?: "5m" | "1h" },
): M[] {
  const cacheControl: { type: "ephemeral"; ttl?: "5m" | "1h" } = {
    type: "ephemeral",
  };
  if (options?.ttl) cacheControl.ttl = options.ttl;
  let lastUser = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") {
      lastUser = i;
      break;
    }
  }
  if (lastUser === -1) return [...messages];
  const target = messages[lastUser];
  let content: M["content"];
  if (typeof target.content === "string") {
    if (target.content.length === 0) return [...messages];
    content = [
      { type: "text", text: target.content, cache_control: cacheControl },
    ];
  } else {
    if (target.content.length === 0) return [...messages];
    const blocks = [...target.content];
    blocks[blocks.length - 1] = {
      ...blocks[blocks.length - 1],
      cache_control: cacheControl,
    };
    content = blocks;
  }
  const out = [...messages];
  out[lastUser] = { ...target, content };
  return out;
}

export interface AideStreamConfig {
  /** Lazily-constructed Anthropic client (caller owns the dynamic import). */
  anthropic: Anthropic;
  model: ToolRunnerParams["model"];
  maxTokens: number;
  /** string OR cache-control'd content blocks (for prompt caching). */
  system: ToolRunnerParams["system"];
  messages: ToolRunnerParams["messages"];
  tools: ToolRunnerParams["tools"];
  onToolResult?: (name: string, result: string) => void;
  /**
   * Optional cap on the toolRunner loop's API requests (`max_iterations`).
   * Undefined → no cap (the SDK treats a falsy value as "unlimited"), so
   * callers that omit it get byte-identical behavior to before. Used by
   * /meta-stream's Code Explorer to keep a curious tool loop cost-bounded.
   */
  maxIterations?: number;
  /**
   * Called exactly once, the moment the stream opens, with the live SSE
   * emit. Callers that build tools closing over a late-bound `emit` point
   * it here (mirrors the old `let emitSSE = () => {}; emitSSE = …` dance).
   */
  bindEmit?: (emit: AideEmit) => void;
  /** Persist the partial transcript (~every 200 streamed chars). */
  // Returns `Promise<unknown>` not `Promise<void>` because Convex mutations
  // resolve to `null`, and callers pass `ctx.runMutation(...)` directly.
  persist: (content: string) => Promise<unknown>;
  /** Cheap row lookup used between persist ticks and immediately before tools. */
  isStopRequested?: () => Promise<boolean>;
  /** Finalize the message row. Runs on success AND on error. */
  finalize: (result: {
    content: string;
    model: string;
    tokensUsed: number;
  }) => Promise<unknown>;
  /** Optional post-finalize success hook (e.g. auto-name the session). */
  onComplete?: (result: { content: string }) => Promise<unknown>;
  /**
   * Optional usage sink. Called once (success AND error) with the full
   * accumulated token breakdown + resolved model id, so callers can record
   * cost via `recordUsage`. Best-effort: implementations should swallow
   * their own errors so accounting never breaks a stream.
   */
  onUsage?: (usage: UsageBreakdown, model: string) => Promise<unknown>;
  /** Short label for error logs, e.g. "curriculum" / "parent chat". */
  label: string;
  /**
   * When true, stream the model's summarized extended-thinking blocks inline
   * (`thinkingStart` + `thinkingText` SSE events) so a STAFF surface can render
   * the reasoning as a collapsible accordion. Default false: the monologue
   * never leaves the server for scholar/parent surfaces (anti-parasocial /
   * privacy) — they still get the lightweight once-per-turn `thinking` label.
   */
  streamThinking?: boolean;
}

export function stopRequestedFromPersistResult(result: unknown): boolean {
  return (
    typeof result === "object" &&
    result !== null &&
    "stopRequested" in result &&
    (result as { stopRequested?: unknown }).stopRequested === true
  );
}

export function createStreamStopPredicate({
  isLocallyStopped,
  isStopRequested,
  intervalMs = 1_500,
}: {
  isLocallyStopped: () => boolean;
  isStopRequested?: () => Promise<boolean>;
  intervalMs?: number;
}) {
  let stopObserved = false;
  let lastCheckAt: number | null = null;

  return async (force = false): Promise<boolean> => {
    if (stopObserved || isLocallyStopped()) return true;
    if (!isStopRequested) return false;

    const now = Date.now();
    if (
      !force &&
      lastCheckAt !== null &&
      now - lastCheckAt < intervalMs
    ) {
      return false;
    }

    lastCheckAt = now;
    stopObserved = await isStopRequested();
    return stopObserved;
  };
}

/**
 * Non-SSE sibling of `runAideStream` for transports that aren't an HTTP
 * response — the Slack bot consumes deltas via `onText` and tool events
 * via the same `emit` the tools were built over, then takes the final
 * content from the return value. Loop semantics (separator between
 * pre-/post-tool text, token accounting) match the SSE runner.
 */
export async function runAideLoop(config: {
  anthropic: Anthropic;
  model: ToolRunnerParams["model"];
  maxTokens: number;
  system: ToolRunnerParams["system"];
  messages: ToolRunnerParams["messages"];
  tools: ToolRunnerParams["tools"];
  onText?: (delta: string) => void;
  onToolResult?: (name: string, result: string) => void;
  /** Fires when the model STARTS a tool call (the tool's own emit fires on
   * completion) — lets transports render live "running X…" progress. */
  onToolUse?: (name: string) => void;
  /** Fires once when the model starts an extended-thinking block — lets
   * transports show a "thinking deeply…" status during Fable's long
   * pre-text pause (always-on thinking). */
  onThinking?: () => void;
  /**
   * Optional early-exit predicate, checked at the top of the tool-loop before
   * consuming each assistant turn. Returns true → break out cleanly (no error).
   * Used by the Slack bot's `react_only` affordance: once that tool runs and
   * decides to stay silent, there is no reply to generate, so we stop instead
   * of consuming (and streaming) the model's post-tool continuation. The tool
   * has already executed by the time this is checked (the SDK runs tools when
   * advancing to the next turn), so its side effects — reactions, flags — are
   * in place; we simply drop the now-unwanted trailing turn.
   */
  shouldStop?: () => boolean;
  /** See `AideStreamConfig.maxIterations` — cap on the tool loop's API
   * requests. Undefined → uncapped (the SDK treats falsy as unlimited). */
  maxIterations?: number;
  label: string;
}): Promise<{
  content: string;
  model: string;
  tokensUsed: number;
  usage: UsageBreakdown;
}> {
  const {
    anthropic,
    model,
    maxTokens,
    system,
    messages,
    tools,
    onText,
    onToolResult,
    onToolUse,
    onThinking,
    shouldStop,
    maxIterations,
    label,
  } = config;

  let fullContent = "";
  let model_ = "";
  let tokensUsed = 0;
  const usage = emptyUsage();
  let needsSeparator = false;
  let refused = false;
  let thinkingSignaled = false;
  // Any tool call started in this run — half of the retry-safety gate below.
  let toolsUsed = false;
  const runnerTools = observeToolResults(tools, onToolResult);

  // One full tool-loop pass on `activeModel`. Mutates the accumulators above
  // so a refusal retry (below) continues the same usage/token accounting —
  // both attempts really were billed.
  const attempt = async (activeModel: ToolRunnerParams["model"]) => {
    refused = false;
    const effort = aideEffort(String(activeModel));
    const runner = anthropic.beta.messages.toolRunner({
      model: activeModel,
      max_tokens: maxTokens,
      system,
      messages,
      tools: runnerTools,
      cache_control: AIDE_LOOP_CACHE_CONTROL,
      stream: true,
      max_iterations: maxIterations,
      // Fable and Opus 5.5 only — every other model omits output_config
      // entirely and keeps the API default. See lib/aideModel.aideEffort.
      ...(effort ? { output_config: { effort } } : {}),
    });

    for await (const messageStream of runner) {
      // A tool from the PREVIOUS turn asked us to stop (e.g. Slack's
      // react_only decided to stay silent). The SDK has already run that tool
      // and started this next turn; we break before consuming it so its text
      // is never streamed or accumulated. The runner's async-iterator cleanup
      // aborts the in-flight request.
      if (shouldStop?.()) break;
      for await (const event of messageStream) {
        if (
          event.type === "content_block_start" &&
          event.content_block?.type === "tool_use"
        ) {
          if (fullContent.trim() && !fullContent.endsWith("\n\n")) {
            needsSeparator = true;
          }
          toolsUsed = true;
          const name = (event.content_block as { name?: string }).name;
          if (name) onToolUse?.(name);
        } else if (
          event.type === "content_block_start" &&
          event.content_block?.type === "thinking"
        ) {
          if (!thinkingSignaled) {
            thinkingSignaled = true;
            onThinking?.();
          }
        } else if (event.type === "message_start") {
          model_ = event.message.model;
          // input + cache counts for this message (each tool-loop message
          // has its own prefill — they sum correctly across the loop).
          addStartUsage(usage, event.message.usage);
        } else if (event.type === "content_block_delta") {
          const delta = event.delta;
          if ("text" in delta) {
            let textOut = delta.text;
            if (needsSeparator) {
              textOut = "\n\n" + textOut.replace(/^\s+/, "");
              needsSeparator = false;
            }
            fullContent += textOut;
            onText?.(textOut);
          }
        } else if (event.type === "message_delta") {
          if (event.usage) {
            tokensUsed += event.usage.output_tokens;
            addDeltaOutput(usage, event.usage.output_tokens);
          }
          if (event.delta?.stop_reason === "refusal") {
            refused = true;
          }
        }
      }
    }
  };

  let retriedOnto: string | null = null;

  try {
    await attempt(model);
    retriedOnto = refusalRetryTarget({ refused, fullContent, toolsUsed, model });
    if (retriedOnto) {
      console.warn(
        `${label} loop: ${model} refused with nothing committed — retrying on ${retriedOnto}`,
      );
      await attempt(retriedOnto as ToolRunnerParams["model"]);
    }
  } catch (error) {
    console.error(`${label} loop error:`, error);
    throw error;
  }

  const notice = refusalNoticeFor({
    refusedModel: String(model),
    retriedOnto,
    stillRefused: refused,
  });
  if (notice) {
    const block = fullContent.trim() ? `\n\n_${notice}_` : `_${notice}_`;
    fullContent += block;
    onText?.(block);
  }

  return { content: fullContent, model: model_, tokensUsed, usage };
}

const SSE_HEADERS = {
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-cache",
  Connection: "keep-alive",
  "Access-Control-Allow-Origin": "*",
} as const;

/**
 * Run an aide tool-loop and return an SSE `Response`. Owns the
 * ReadableStream, the toolRunner loop, the streamed-text → SSE mapping,
 * the persist cadence, and finalize/error handling.
 */
export function runAideStream(config: AideStreamConfig): Response {
  const {
    anthropic,
    model,
    maxTokens,
    system,
    messages,
    tools,
    onToolResult,
    maxIterations,
    bindEmit,
    persist,
    isStopRequested,
    finalize,
    onComplete,
    onUsage,
    label,
    streamThinking,
  } = config;

  const encoder = new TextEncoder();
  let cancelled = false;
  let activeMessageStream: { abort: () => void } | null = null;

  const stream = new ReadableStream({
    async start(controller) {
      const rawEmit: AideEmit = (data) =>
        cancelled
          ? undefined
          : controller.enqueue(
              encoder.encode(`data: ${JSON.stringify(data)}\n\n`),
            );
      const tracker = createToolReportTracker(rawEmit);
      // The tools are built over the emit handed to bindEmit, so the WRAPPED
      // emit is what must see their `toolComplete`. Every existing emit(...)
      // call site below also uses the wrapped emit — it forwards untouched.
      const emit = tracker.emit;
      bindEmit?.(emit);

      let fullContent = "";
      let model_ = "";
      let tokensUsed = 0;
      const usage = emptyUsage();
      let usageRecorded = false;
      const recordUsageOnce = async () => {
        if (usageRecorded || !onUsage) return;
        usageRecorded = true;
        try {
          await onUsage(usage, model_ || String(model));
        } catch (usageErr) {
          console.error(`Failed to record ${label} usage:`, usageErr);
        }
      };
      let lastPersistLength = 0;
      let finalized = false;
      // When text streamed before a tool call, the post-tool continuation
      // must not visually concat with the pre-tool text — insert a break.
      let needsSeparator = false;
      let refused = false;
      let thinkingSignaled = false;
      // Any tool call started in this run — half of the retry-safety gate.
      let toolsUsed = false;
      let stopped = false;
      const runnerTools = observeToolResults(tools, onToolResult);
      const stopPredicate = createStreamStopPredicate({
        isLocallyStopped: () => cancelled || stopped,
        isStopRequested,
      });
      const checkStop = async (force = false) => {
        if (!(await stopPredicate(force))) return false;
        stopped = true;
        return true;
      };

      // One full tool-loop pass on `activeModel`, wrapped so a refused
      // request can be re-run on a fallback model (see `refusalRetryTarget`).
      // Accumulators live outside, so a retry keeps one honest usage total.
      const attempt = async (activeModel: ToolRunnerParams["model"]) => {
        refused = false;
        const effort = aideEffort(String(activeModel));
        // Keyed per ATTEMPT, so an Opus refusal-retry drops it on its own.
        const thinking = aideThinking(String(activeModel), streamThinking);
        const runner = anthropic.beta.messages.toolRunner({
          model: activeModel,
          max_tokens: maxTokens,
          system,
          messages,
          tools: runnerTools,
          cache_control: AIDE_LOOP_CACHE_CONTROL,
          // Undefined ⇒ the SDK leaves the loop uncapped (byte-identical to
          // before for every caller that doesn't set it).
          max_iterations: maxIterations,
          stream: true,
          // Fable and Opus 5.5 only — every other model omits output_config
          // entirely and keeps the API default. See lib/aideModel.aideEffort.
          ...(effort ? { output_config: { effort } } : {}),
          // Staff + Fable/Opus 5.5 only: without display "summarized" their
          // thinking arrives empty and the reasoning accordion never fills. See
          // lib/aideModel.aideThinking.
          ...(thinking ? { thinking } : {}),
        });

        try {
          streamLoop: for await (const messageStream of runner) {
            activeMessageStream = messageStream;
            // The SDK executes the previous turn's tools while we await THIS
            // messageStream, so any tool that started last turn has finished
            // exactly now — settle any that never reported. On the first
            // iteration `pending` is empty, so the call is a harmless no-op.
            // (Settling after the inner event loop instead would fire BEFORE the
            // tool runs, wrongly settling a tool about to report normally.)
            tracker.settleUnreported();
            if (await checkStop()) {
              messageStream.abort();
              break;
            }
            for await (const event of messageStream) {
              if (await checkStop()) {
                messageStream.abort();
                break streamLoop;
              }
              if (
                event.type === "content_block_start" &&
                event.content_block?.type === "tool_use"
              ) {
                if (await checkStop(true)) {
                  messageStream.abort();
                  break streamLoop;
                }
                if (fullContent.trim() && !fullContent.endsWith("\n\n")) {
                  needsSeparator = true;
                }
                const toolName = (event.content_block as { name?: string }).name;
                toolsUsed = true;
                // Only track a NAMED call: settling is name-matched, so a
                // nameless one would emit a `toolComplete` for "" that no
                // consumer's running row could ever match (it would append a
                // stray failed row instead). Mirrors `runAideLoop`'s `if (name)`.
                if (toolName) tracker.started(toolName);
                emit({ toolStart: { name: toolName } });
              } else if (
                event.type === "content_block_start" &&
                event.content_block?.type === "thinking"
              ) {
                // Fable thinks (silently) before its first visible token — and,
                // with tools, again between actions. Tell the UI so it can label
                // the pause instead of looking hung.
                if (streamThinking) {
                  // Staff surfaces stream the monologue inline: open a new
                  // thinking block positioned at the current visible-text length
                  // (thinking precedes the text/tool it reasons about).
                  emit({ thinkingStart: { textOffset: fullContent.length } });
                } else if (!thinkingSignaled) {
                  // Non-staff surfaces keep the lightweight once-per-turn label
                  // signal only; the monologue never leaves the server.
                  thinkingSignaled = true;
                  emit({ thinking: true });
                }
              } else if (event.type === "message_start") {
                model_ = event.message.model;
                addStartUsage(usage, event.message.usage);
              } else if (event.type === "content_block_delta") {
                const delta = event.delta;
                if ("text" in delta) {
                  let textOut = delta.text;
                  if (needsSeparator) {
                    textOut = "\n\n" + textOut.replace(/^\s+/, "");
                    needsSeparator = false;
                  }
                  fullContent += textOut;
                  emit({ text: textOut });
                  if (fullContent.length - lastPersistLength > 200) {
                    lastPersistLength = fullContent.length;
                    const persistResult = await persist(fullContent);
                    if (stopRequestedFromPersistResult(persistResult)) {
                      stopped = true;
                      messageStream.abort();
                      break streamLoop;
                    }
                  }
                } else if (streamThinking && "thinking" in delta && delta.thinking) {
                  // Summarized extended-thinking delta → append to the open block.
                  emit({ thinkingText: delta.thinking });
                }
              } else if (event.type === "message_delta") {
                if (event.usage) {
                  tokensUsed += event.usage.output_tokens;
                  addDeltaOutput(usage, event.usage.output_tokens);
                }
                if (event.delta?.stop_reason === "refusal") {
                  refused = true;
                }
              }
            }
            if (await checkStop(true)) {
              break streamLoop;
            }
            activeMessageStream = null;
          }
        } catch (error) {
          if (!cancelled && !stopped) throw error;
        } finally {
          activeMessageStream = null;
        }

        // Settle any tool that started in the final turn and never reported
        // (the loop exits before a next iteration could settle it), so a
        // completed stream never leaves a spinner. Before `emit({ done: true })`.
        tracker.settleUnreported();
      };

      try {
        await attempt(model);

        // A refusal that committed nothing is retryable on a fallback model —
        // the fix belongs to the REQUEST, not to the person (see
        // lib/aideModel.aideRefusalFallback).
        const retriedOnto = stopped || cancelled ? null : refusalRetryTarget({
          refused,
          fullContent,
          toolsUsed,
          model,
        });
        if (retriedOnto) {
          console.warn(
            `${label} stream: ${model} refused with nothing committed — retrying on ${retriedOnto}`,
          );
          await attempt(retriedOnto as ToolRunnerParams["model"]);
        }

        const noticeText = refusalNoticeFor({
          refusedModel: String(model),
          retriedOnto,
          stillRefused: refused,
        });
        if (!stopped && !cancelled && noticeText) {
          const notice = fullContent.trim()
            ? `\n\n_${noticeText}_`
            : `_${noticeText}_`;
          fullContent += notice;
          emit({ text: notice });
        }

        await finalize({ content: fullContent, model: model_, tokensUsed });
        finalized = true;
        await recordUsageOnce();

        if (!stopped && !cancelled && onComplete) {
          await onComplete({ content: fullContent });
        }

        emit({ done: true, ...(stopped || cancelled ? { stopped: true } : {}) });
        if (!cancelled) controller.close();
      } catch (error) {
        console.error(`${label} stream error:`, error);
        if (!finalized) {
          try {
            await finalize({
              content: fullContent || "",
              model: model_,
              tokensUsed,
            });
          } catch (finalizeErr) {
            console.error(
              `Failed to finalize ${label} stream on error:`,
              finalizeErr,
            );
          }
        }
        await recordUsageOnce();
        // A failed stream must not leave a spinner either — settle before the
        // error event.
        tracker.settleUnreported();
        if (!cancelled) {
          emit({ error: "Stream error" });
          controller.close();
        }
      }
    },
    cancel() {
      cancelled = true;
      activeMessageStream?.abort();
    },
  });

  return new Response(stream, { headers: SSE_HEADERS });
}
