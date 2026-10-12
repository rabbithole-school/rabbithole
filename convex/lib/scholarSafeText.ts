/**
 * Scholar-visible text guardrails for model output.
 *
 * This is deliberately structural and pure: it removes only segments with
 * machine-shaped signatures (internal markers, protocol fragments, stack traces,
 * raw answer indices, or explicit learner-turn planning), then lets normal
 * tutoring copy through unchanged. The streaming filter buffers until a
 * sentence/line boundary before emitting so a bad sentence cannot briefly flash
 * before the full pattern is recognizable.
 */

const INTERNAL_MARKER_RE =
  /^\s*(?:internal\s+(?:reasoning|analysis|scratch(?:\s|-)?pad|note)|scratch(?:\s|-)?pad|developer\s+note|debug|tool\s+(?:call|result|error))\s*:/i;

const LEARNER_TURN_REF =
  String.raw`(?:\bthe\s+(?:scholar|child|learner|user)\b|\btheir\s+(?:answer|question|response|reply|message|turn)\b)`;

const LEARNER_TURN_PLANNING_RE = new RegExp(
  String.raw`\bI(?:'ll| will| should| need to| can| would)\s+` +
    String.raw`(?:wait|address|answer|ask|respond|explain|handle|mention|bring|use|check|score|evaluate|assess|continue|keep)\b[\s\S]{0,220}` +
    LEARNER_TURN_REF,
  "i",
);

const BEFORE_ADDRESSING_LEARNER_TURN_RE = new RegExp(
  String.raw`\bbefore\s+addressing\b[\s\S]{0,160}${LEARNER_TURN_REF}`,
  "i",
);

const RAW_CHOICE_INDEX_RE = /\bchoice\s+\d+\b/i;

const RAW_ERROR_RE =
  /^\s*(?:failed|error|typeerror|referenceerror|syntaxerror|rangeerror|uncaught\s+(?:convex)?error)\s*:/i;

// A V8 stack frame — `at <fn> (<path>:<line>:<col>)`. The trailing `:line:col`
// location is required so ordinary tutor prose that starts a sentence with
// "At <word> (…)" (e.g. coordinates "At point (2, 3)…" or a ratio "(2:3)") is
// not mistaken for a frame.
const STACK_TRACE_RE =
  /(?:Traceback \(most recent call last\)|(?:^|\n)\s*at\s+[\w.$<>[\]]+\s+\([^)]*:\d+:\d+\))/i;

const PROTOCOL_FRAGMENT_RE =
  /\b(?:content_block_start|content_block_delta|tool_use|tool_result|input_json_delta|server_tool_use|stop_reason|sseEvent)\b|^\s*\{\s*"(?:type|role|content|toolUseId|tool_use_id)"\s*:/i;

export type ScholarSafeTextPattern =
  | "internal_marker"
  | "learner_turn_planning"
  | "before_addressing_learner_turn"
  | "raw_choice_index"
  | "raw_error"
  | "stack_trace"
  | "protocol_fragment";

export function matchMachineFacingPattern(
  segment: string,
): ScholarSafeTextPattern | null {
  const trimmed = segment.trim();
  if (!trimmed) return null;
  if (INTERNAL_MARKER_RE.test(trimmed)) return "internal_marker";
  if (LEARNER_TURN_PLANNING_RE.test(trimmed)) return "learner_turn_planning";
  if (BEFORE_ADDRESSING_LEARNER_TURN_RE.test(trimmed)) {
    return "before_addressing_learner_turn";
  }
  if (RAW_CHOICE_INDEX_RE.test(trimmed)) return "raw_choice_index";
  if (RAW_ERROR_RE.test(trimmed)) return "raw_error";
  if (STACK_TRACE_RE.test(trimmed)) return "stack_trace";
  if (PROTOCOL_FRAGMENT_RE.test(trimmed)) return "protocol_fragment";
  return null;
}

export function isMachineFacingTextSegment(segment: string): boolean {
  return matchMachineFacingPattern(segment) !== null;
}

type OnDrop = (drop: {
  pattern: ScholarSafeTextPattern;
  length: number;
}) => void;

export function sanitizeScholarVisibleText(text: string, onDrop?: OnDrop): string {
  const { segments } = takeSegments(text, true);
  return sanitizeSegments(segments, onDrop);
}

export function createScholarVisibleTextFilter(onDrop?: OnDrop) {
  let pending = "";

  return {
    push(delta: string): string {
      pending += delta;
      const { segments, rest } = takeSegments(pending, false);
      pending = rest;
      return sanitizeSegments(segments, onDrop);
    },
    finish(): string {
      const { segments } = takeSegments(pending, true);
      pending = "";
      return sanitizeSegments(segments, onDrop);
    },
  };
}

function sanitizeSegments(segments: string[], onDrop?: OnDrop): string {
  return segments
    .filter((segment) => {
      const pattern = matchMachineFacingPattern(segment);
      if (!pattern) return true;
      onDrop?.({ pattern, length: segment.length });
      return false;
    })
    .join("");
}

function takeSegments(text: string, flushAll: boolean): { segments: string[]; rest: string } {
  const segments: string[] = [];
  let start = 0;
  let i = 0;

  while (i < text.length) {
    const ch = text[i];
    const boundary =
      ch === "\n" ||
      ((ch === "." || ch === "!" || ch === "?") &&
        (i === text.length - 1 || /\s|["'”’)\]]/.test(text[i + 1] ?? "")));

    if (boundary) {
      let end = i + 1;
      while (end < text.length && /\s/.test(text[end])) end++;
      segments.push(text.slice(start, end));
      start = end;
      i = end;
      continue;
    }
    i++;
  }

  if (flushAll && start < text.length) {
    segments.push(text.slice(start));
    start = text.length;
  }

  return { segments, rest: text.slice(start) };
}
