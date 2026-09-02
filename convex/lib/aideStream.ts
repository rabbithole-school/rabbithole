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
// The tutor stream (/project-stream) is deliberately NOT folded in —
// it has a different event surface (artifacts, images, rubric, process
// steps, intermediate tool events) and is the scholar-facing learning
// loop, not an ACL-scoped aide.
//
// Runtime note: this file does NO static `@anthropic-ai/sdk` import —
// the caller constructs the client (lazily, as the http actions do) and
// passes it in. Only `import type` is used, which is erased at build and
// can't pull `node:*` into the edge bundle (see the SDK-pin TODO).

import type { Anthropic } from "@anthropic-ai/sdk";
import { MODELS } from "./models";
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
 * Staff-facing fallback when the model declines a request (`stop_reason:
 * "refusal"` — Fable 5 runs safety classifiers; a pre-output decline
 * returns an EMPTY content array, which would otherwise finalize as a
 * blank assistant bubble). Honest + actionable, never silent.
 *
 * Fable is the aide default and the only tier that runs these classifiers,
 * so a refusal is almost always Fable tripping a (frequently false-positive)
 * guard. In that case name the concrete fix — switch this chat to Opus
 * (nearly as capable, and it doesn't run that extra classifier) — rather
 * than a vague "try the default", which IS Fable. `switchHint` describes HOW
 * to switch on the calling surface: the web aides render a model picker
 * (default), while Slack has no picker and switches by asking the bot, so
 * that caller passes its own hint. Non-Fable refusals are rare (parent/meta
 * chats run on Sonnet); there we just suggest a rephrase instead of a
 * nonsensical "switch to Opus".
 */
export function refusalNotice(
  model: ToolRunnerParams["model"],
  switchHint = "with the model picker above",
): string {
  if (model === MODELS.FABLE) {
    return (
      "Claude Fable declined this request — its safety classifier fired, which is often a false positive. " +
      `Opus is nearly as capable and doesn't run that extra classifier — switch to it ${switchHint} and resend, or try rephrasing.`
    );
  }
  return "The model declined this request (a safety classifier fired — occasionally a false positive). Try rephrasing.";
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
 * TTL: the breakpoint defaults to the 5-minute ephemeral cache. A caller
 * whose matching calls are frequently >5 min apart (e.g. a Socratic tutor's
 * think-time reply gaps) can pass `{ ttl: "1h" }` to keep the prefix warm
 * for the whole session. The 1h write costs 2× the prefix (vs 1.25× for 5m),
 * so it only pays off when reuse spans the 5-minute window — leave it off for
 * dense-cadence callers. `ttl` is GA (no beta header). Omitting `options`
 * emits exactly `{ type: "ephemeral" }`, byte-identical to the prior form.
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

export interface AideStreamConfig {
  /** Lazily-constructed Anthropic client (caller owns the dynamic import). */
  anthropic: Anthropic;
  model: ToolRunnerParams["model"];
  maxTokens: number;
  /** string OR cache-control'd content blocks (for prompt caching). */
  system: ToolRunnerParams["system"];
  messages: ToolRunnerParams["messages"];
  tools: ToolRunnerParams["tools"];
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
   * How to switch models on this surface, injected into the Fable
   * guardrail-refusal notice (see `refusalNotice`). Web aides render a
   * picker, so the default ("with the model picker above") fits; pass an
   * override for surfaces without one (e.g. Slack).
   */
  refusalSwitchHint?: string;
  /**
   * When true, stream the model's summarized extended-thinking blocks inline
   * (`thinkingStart` + `thinkingText` SSE events) so a STAFF surface can render
   * the reasoning as a collapsible accordion. Default false: the monologue
   * never leaves the server for scholar/parent surfaces (anti-parasocial /
   * privacy) — they still get the lightweight once-per-turn `thinking` label.
   */
  streamThinking?: boolean;
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
  /** See `AideStreamConfig.refusalSwitchHint` — surface-specific "how to
   * switch models" phrasing for the Fable refusal notice. */
  refusalSwitchHint?: string;
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
    onToolUse,
    onThinking,
    shouldStop,
    maxIterations,
    label,
    refusalSwitchHint,
  } = config;

  let fullContent = "";
  let model_ = "";
  let tokensUsed = 0;
  const usage = emptyUsage();
  let needsSeparator = false;
  let refused = false;
  let thinkingSignaled = false;

  try {
    const runner = anthropic.beta.messages.toolRunner({
      model,
      max_tokens: maxTokens,
      system,
      messages,
      tools,
      stream: true,
      max_iterations: maxIterations,
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
  } catch (error) {
    console.error(`${label} loop error:`, error);
    throw error;
  }

  if (refused) {
    console.warn(`${label} loop: model refusal (stop_reason=refusal)`);
    const noticeText = refusalNotice(model, refusalSwitchHint);
    const notice = fullContent.trim()
      ? `\n\n_${noticeText}_`
      : `_${noticeText}_`;
    fullContent += notice;
    onText?.(notice);
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
    maxIterations,
    bindEmit,
    persist,
    finalize,
    onComplete,
    onUsage,
    label,
    refusalSwitchHint,
    streamThinking,
  } = config;

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      const rawEmit: AideEmit = (data) =>
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
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

      try {
        const runner = anthropic.beta.messages.toolRunner({
          model,
          max_tokens: maxTokens,
          system,
          messages,
          tools,
          // Undefined ⇒ the SDK leaves the loop uncapped (byte-identical to
          // before for every caller that doesn't set it).
          max_iterations: maxIterations,
          stream: true,
        });

        for await (const messageStream of runner) {
          // The SDK executes the previous turn's tools while we await THIS
          // messageStream, so any tool that started last turn has finished
          // exactly now — settle any that never reported. On the first
          // iteration `pending` is empty, so the call is a harmless no-op.
          // (Settling after the inner event loop instead would fire BEFORE the
          // tool runs, wrongly settling a tool about to report normally.)
          tracker.settleUnreported();
          for await (const event of messageStream) {
            if (
              event.type === "content_block_start" &&
              event.content_block?.type === "tool_use"
            ) {
              if (fullContent.trim() && !fullContent.endsWith("\n\n")) {
                needsSeparator = true;
              }
              const toolName = (event.content_block as { name?: string }).name;
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
                  await persist(fullContent);
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
        }

        // Settle any tool that started in the final turn and never reported
        // (the loop exits before a next iteration could settle it), so a
        // completed stream never leaves a spinner. Before `emit({ done: true })`.
        tracker.settleUnreported();

        if (refused) {
          console.warn(`${label} stream: model refusal (stop_reason=refusal)`);
          const noticeText = refusalNotice(model, refusalSwitchHint);
          const notice = fullContent.trim()
            ? `\n\n_${noticeText}_`
            : `_${noticeText}_`;
          fullContent += notice;
          emit({ text: notice });
        }

        await finalize({ content: fullContent, model: model_, tokensUsed });
        finalized = true;
        await recordUsageOnce();

        if (onComplete) {
          await onComplete({ content: fullContent });
        }

        emit({ done: true });
        controller.close();
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
        emit({ error: "Stream error" });
        controller.close();
      }
    },
  });

  return new Response(stream, { headers: SSE_HEADERS });
}
