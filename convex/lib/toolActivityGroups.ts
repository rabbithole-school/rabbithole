// Coalescing for the aide chat's tool-activity log.
//
// During a streaming turn the bot can fire a long series of tool calls
// (build a unit → set metadata → create 7 lessons → add 19 activities).
// The stream hooks accumulate one `ToolActivity` per call, in order. This
// module is the *render-time* concern: collapse consecutive same-type calls
// into a single counted group ("✓ Created 7 lessons") that an indicator can
// render as one row with an optional accordion of the individual results.
//
// Kept as a pure function (no React, no hook deps) so it's the cheapest,
// highest-value thing to unit-test — see lib/__tests__/toolActivityGroups.test.ts.

/** One tool call observed on the wire, as the stream hooks record it. */
export interface ToolActivity {
  name: string;
  status: "running" | "complete";
  result?: string;
  /**
   * Length of the streamed assistant text at the moment this tool started —
   * the call's *position* in the turn. Lets the UI render the tool inline,
   * right where the model fired it (between the pre- and post-tool text),
   * instead of dumping every tool below the finished message. Stamped by the
   * stream hooks; absent on transports that don't track it (e.g. Slack).
   */
  textOffset?: number;
  /**
   * Monotonic SSE event order within the live turn. Breaks ties when multiple
   * tools / reasoning blocks share the same text offset (no visible text was
   * emitted between them).
   */
  sequence?: number;
}

/**
 * One extended-thinking block observed on the wire (the model's summarized
 * internal monologue). Staff aide surfaces stream these so the reasoning can be
 * shown inline as a collapsible accordion; scholar/parent surfaces never
 * receive them (the backend gates emission — see aideStream `streamThinking`).
 */
export interface ThinkingActivity {
  /** The summarized thinking text streamed so far for this block. */
  text: string;
  /**
   * Length of the streamed *visible* assistant text when this thinking block
   * started — its position in the turn (thinking usually precedes the text /
   * tool it reasons about). Absent → treated as end-of-content.
   */
  textOffset?: number;
  /** Monotonic SSE event order within the live turn; see ToolActivity. */
  sequence?: number;
  /** True once the model has left this thinking block (text/tool followed). */
  done?: boolean;
}

/** A run of consecutive same-name tool calls, coalesced for display. */
export interface ToolGroup {
  /** tool name shared by every call in the run */
  name: string;
  /** running while the last call in the run is still running */
  status: "running" | "complete";
  /** one entry per coalesced call, in order (count === items.length) */
  items: { result?: string }[];
}

// ── Scholar-safe failure redaction ────────────────────────────────────
//
// Tool failures travel the wire as a `toolComplete` result of the form
// "Failed: <raw developer message>". That raw string is fine on teacher /
// debug surfaces (the aide chat, curriculum bot) but must NEVER reach a
// child's chat — a live pilot showed a scholar seeing
// "Failed: Pass artifact_id to score the document rubric." verbatim. Scholar
// surfaces opt into `toScholarSafeGroup`, which swaps any failure result for a
// non-rendered marker while leaving the underlying data untouched (so the same
// group still renders raw for staff).

export const SCHOLAR_TOOL_FAILURE_MARKER = "__SCHOLAR_TOOL_FAILURE_HIDDEN__";

/** True when a tool result encodes a failure (the "Failed:"/"Error:" convention
 * emitted by the streaming tool handlers on a caught error). */
export function isFailureResult(result?: string): boolean {
  return !!result && /^\s*(failed|error)\s*:/i.test(result);
}

/** Result stamped on a tool that ended without ever reporting a `toolComplete`.
 *  A tool that THROWS never emits: the Anthropic SDK converts the throw into an
 *  `is_error` tool_result and the tool loop continues normally, so no
 *  `toolComplete` ever fires and the entry would otherwise sit `running`
 *  forever (the exact prod symptom: a block frozen on "⋯ dispatch
 *  implementation…"). Some tools also take an early refusal return that skips
 *  their own emit. Settling to this failure result lets the block render a "⚠"
 *  instead of a permanent "⋯" — it deliberately conforms to the `Failed:`
 *  convention above so `isFailureResult` classifies it. Lives here, next to
 *  `isFailureResult`, so Slack (`settleRunningToolActivity`) and the SSE
 *  runner's tracker share one home; re-exported from `slackBot.ts` for existing
 *  importers. */
export const UNREPORTED_TOOL_RESULT = "Failed: no result reported";

/**
 * Return a copy of the group with every failure result replaced by the hidden
 * scholar-safe marker. Non-failure results (real progress, star scores) are
 * left as-is. Returns the original group unchanged when nothing needs redacting.
 */
export function toScholarSafeGroup(group: ToolGroup): ToolGroup {
  if (!group.items.some((it) => isFailureResult(it.result))) return group;
  return {
    ...group,
    items: group.items.map((it) =>
      isFailureResult(it.result)
        ? { result: SCHOLAR_TOOL_FAILURE_MARKER }
        : it,
    ),
  };
}

export function isScholarHiddenToolResult(result?: string): boolean {
  return result === SCHOLAR_TOOL_FAILURE_MARKER;
}

/**
 * Walk the log in order, merging each entry into the previous group iff it
 * has the **same name** AND is **adjacent** (consecutive). A non-consecutive
 * repeat starts a new group, so A,A,B,A → [A×2, B×1, A×1]. A group is
 * `running` when its last item is running, else `complete`.
 */
export function coalesceToolActivity(log: ToolActivity[]): ToolGroup[] {
  const groups: ToolGroup[] = [];
  for (const entry of log) {
    const prev = groups[groups.length - 1];
    if (prev && prev.name === entry.name) {
      prev.items.push({ result: entry.result });
      prev.status = entry.status;
    } else {
      groups.push({
        name: entry.name,
        status: entry.status,
        items: [{ result: entry.result }],
      });
    }
  }
  return groups;
}

/** One piece of a streaming turn, in chronological order. */
export type StreamSegment =
  | { kind: "text"; text: string }
  | { kind: "tools"; group: ToolGroup }
  | { kind: "thinking"; text: string; done: boolean };

/**
 * Interleave a streaming turn's text with its tool calls AND thinking blocks,
 * in the order they happened. Each tool's / thinking block's `textOffset` marks
 * how much assistant text had streamed when it fired, so we slice `content` at
 * those offsets and drop the coalesced tool group / thinking block in between —
 * restoring inline placement (each shows where the model produced it, not below
 * the whole message).
 *
 * Tools keep the same coalescing rule as `coalesceToolActivity` (consecutive
 * same-name calls merge) BUT a text run OR a thinking block between two
 * same-name calls breaks them apart. Thinking blocks never coalesce (each is a
 * distinct block). Equal offsets use the client-stamped SSE sequence so a
 * tool → reasoning → next-tool chain keeps its real chronology even when no
 * visible text separates the events. Legacy entries without a sequence keep
 * the old thinking-before-tool tie-break. Offsets are clamped monotonic, so an
 * out-of-order or missing offset degrades gracefully (the item lands at/after
 * the current cursor) rather than throwing.
 *
 * `thinking` defaults to `[]`, so existing two-arg callers are unaffected.
 */
export function splitStreamSegments(
  content: string,
  activity: ToolActivity[],
  thinking: ThinkingActivity[] = [],
): StreamSegment[] {
  const segments: StreamSegment[] = [];
  let cursor = 0;
  let ti = 0; // tool index
  let ki = 0; // thinking index

  const clampOffset = (raw: number | undefined) =>
    Math.min(Math.max(raw ?? content.length, cursor), content.length);

  while (ti < activity.length || ki < thinking.length) {
    const toolOff = ti < activity.length ? clampOffset(activity[ti].textOffset) : Infinity;
    const thinkOff = ki < thinking.length ? clampOffset(thinking[ki].textOffset) : Infinity;
    const toolSequence = ti < activity.length ? activity[ti].sequence : undefined;
    const thinkingSequence = ki < thinking.length ? thinking[ki].sequence : undefined;
    const takeThinking =
      ki < thinking.length &&
      (thinkOff < toolOff ||
        (thinkOff === toolOff &&
          (toolSequence === undefined ||
            thinkingSequence === undefined ||
            thinkingSequence < toolSequence)));
    const offset = takeThinking ? thinkOff : toolOff;

    if (offset > cursor) {
      segments.push({ kind: "text", text: content.slice(cursor, offset) });
      cursor = offset;
    }

    if (takeThinking) {
      const entry = thinking[ki++];
      segments.push({ kind: "thinking", text: entry.text, done: entry.done ?? true });
    } else {
      const entry = activity[ti++];
      const last = segments[segments.length - 1];
      if (last && last.kind === "tools" && last.group.name === entry.name) {
        last.group.items.push({ result: entry.result });
        last.group.status = entry.status;
      } else {
        segments.push({
          kind: "tools",
          group: {
            name: entry.name,
            status: entry.status,
            items: [{ result: entry.result }],
          },
        });
      }
    }
  }

  if (cursor < content.length) {
    segments.push({ kind: "text", text: content.slice(cursor) });
  }

  return segments;
}

/**
 * While a turn streams, the only affordance the interleaved view animates on
 * its own is a tool row whose group is still `running` (its spinner) or a
 * thinking block that's still in progress (its live header). Every OTHER live
 * state — the pre-first-token pause, the gap between a completed tool and the
 * next tool/text, a pause after text before a tool, or the wait for `done`
 * after the last token — leaves a STATIC turn on screen even though the model
 * is still working. This decides when to append a trailing "still working"
 * spinner so there's always motion during a live turn.
 *
 * Returns false when the turn isn't streaming, or when the trailing segment
 * already animates (a running tool group, or an unfinished thinking block) —
 * so we never double up an indicator.
 */
export function shouldShowStreamingTail(
  isStreaming: boolean,
  segments: StreamSegment[],
): boolean {
  if (!isStreaming) return false;
  const last = segments[segments.length - 1];
  if (last?.kind === "tools" && last.group.status === "running") return false;
  if (last?.kind === "thinking" && !last.done) return false;
  return true;
}
