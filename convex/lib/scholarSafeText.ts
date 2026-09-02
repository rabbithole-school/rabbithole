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

export function isMachineFacingTextSegment(segment: string): boolean {
  const trimmed = segment.trim();
  if (!trimmed) return false;
  return (
    INTERNAL_MARKER_RE.test(trimmed) ||
    LEARNER_TURN_PLANNING_RE.test(trimmed) ||
    BEFORE_ADDRESSING_LEARNER_TURN_RE.test(trimmed) ||
    RAW_CHOICE_INDEX_RE.test(trimmed) ||
    RAW_ERROR_RE.test(trimmed) ||
    STACK_TRACE_RE.test(trimmed) ||
    PROTOCOL_FRAGMENT_RE.test(trimmed)
  );
}

export function sanitizeScholarVisibleText(text: string): string {
  const { segments } = takeSegments(text, true);
  return segments.filter((segment) => !isMachineFacingTextSegment(segment)).join("");
}

export function createScholarVisibleTextFilter() {
  let pending = "";

  return {
    push(delta: string): string {
      pending += delta;
      const { segments, rest } = takeSegments(pending, false);
      pending = rest;
      return segments.filter((segment) => !isMachineFacingTextSegment(segment)).join("");
    },
    finish(): string {
      const { segments } = takeSegments(pending, true);
      pending = "";
      return segments.filter((segment) => !isMachineFacingTextSegment(segment)).join("");
    },
  };
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
