import { AUTOMATED_COMPLETION_CLOSING_GUIDANCE } from "./tutorClosingGuidance";

export const MARK_ACTIVITY_COMPLETE_TOOL_NAME = "mark_activity_complete" as const;

export const MARK_ACTIVITY_COMPLETE_TOOL_DESCRIPTION =
  `Mark this conversation activity complete. Call ONLY when its learning arc is genuinely finished — goals worked through, not merely touched. Once the scholar has already demonstrated the goal in their own words, do not delay completion by asking them to repeat a summary or adding one more extension/check. NEVER call in the opening exchanges, just because the scholar says they're done without engaging, or to escape an awkward conversation. On the turn you decide it is complete, the API response content array must contain exactly ONE tool_use block and ZERO text blocks. Forbidden: writing an assessment such as '[name] just demonstrated...' and then calling the tool. Put that assessment only in the summary JSON argument. ${AUTOMATED_COMPLETION_CLOSING_GUIDANCE} Completion does not close the chat; respond normally if the scholar messages later.`;

export const MARK_ACTIVITY_COMPLETE_SUMMARY_DESCRIPTION =
  "One sentence describing what the scholar worked through in this activity. This is JSON input stored as a private completion note; never also emit it as a text block.";

export const MARK_ACTIVITY_COMPLETE_SUCCESS_GUIDANCE =
  `The activity is now complete, and the app has already written its closing sentence. Do not emit any text now. If the scholar messages later, continue the conversation normally.`;

export const MARK_ACTIVITY_COMPLETE_PRETOOL_TEXT_GUIDANCE =
  "The activity is now complete. The text you already wrote before the tool call is the closing response the scholar has seen. Do not repeat, extend, or add to it; end this turn with no additional text.";

export const MARK_ACTIVITY_COMPLETE_INVALID_PRETOOL_GUIDANCE =
  "Completion was not recorded because the text before the tool was not a valid closing sentence. Continue the current conversation without claiming completion. On a later turn, call the completion tool before any text, then close only after it succeeds.";

const FOLLOW_UP_TASK_PATTERNS = [
  /(?:^|[.!;,:—-]\s*)(?:(?:now|next|then|please)\s+)?(?:try|solve|write|build|find|explain|tell|show|make|create|answer|explore|continue|do|give|work|take|spend|practice|start|read|summarize|repeat|check|review|think|consider|imagine|pick|choose|draw|say|describe)\b/i,
  /\b(?:let's|let us)\s+(?:try|solve|write|build|find|explain|tell|show|make|create|answer|explore|continue|do|practice|start|read|summarize|repeat|check|review|think|consider|imagine|pick|choose|draw|say|describe)\b/i,
  /\byou can\s+(?:now\s+)?(?:try|solve|write|build|find|tell|show|make|create|answer|explore|continue|do|give|work|take|practice|start|read|summarize|repeat|check|review|think|consider|imagine|pick|choose|draw|say)\b/i,
  /\b(?:so|then|and now|and)\s+(?:please\s+)?(?:try|solve|write|build|find|explain|tell|show|make|create|answer|explore|continue|do|give|work|take|spend|practice|start|read|summarize|repeat|check|review|think|consider|imagine|pick|choose|draw|say|describe)\b/i,
  /\b(?:try|solve|write|build|find|explain|answer|explore|do|read|summarize|repeat|check|review|describe)\s+(?:another|one more|the next|a new)\b/i,
  /\b(?:you\s+)?(?:should|must|need to|have to)\b/i,
  /\b(?:next|new)\s+(?:task|step|challenge|assignment)\b/i,
];

const COMPLETION_LANGUAGE_PATTERNS = [
  /\byou(?:'ve| have)?\s+(?:worked|built|connected|explained|figured|traced|showed|demonstrated|uncovered|identified|reasoned|made|used|developed|completed|finished|followed|found|named|described|understood|solved|created|tested|compared|analyzed|analysed|mapped|put|brought|nailed|got)\b/i,
  /\byou\s+(?:now\s+)?(?:understand|can explain|can describe|can show)\b/i,
  /\byour\s+(?:explanation|reasoning|model|work|analysis|thinking|idea)\s+(?:now\s+)?(?:connects|shows|captures|explains|traces|demonstrates|includes|names|describes)\b/i,
];

/**
 * The narrower half of `isValidActivityCompletionClosing`: does this closing
 * text avoid introducing a new question or task, independent of whether it
 * also happens to match that function's stricter COMPLETION_LANGUAGE_PATTERNS
 * vocabulary check (tuned for `mark_activity_complete`'s typical "you
 * worked/built/explained..." phrasing). The rubric tool's natural closing
 * register instead references the artifact ("your report covers...", "your
 * report nails every piece...") — same wind-down rule (no new task/question
 * after completion), different vocabulary — so a caller checking THAT rule
 * specifically (e.g. evals/rubric-integrity) should use this, not the
 * stricter function, to avoid false negatives on a perfectly valid closing
 * that just isn't phrased the way `mark_activity_complete` typically is.
 */
export function hasNoFollowUpQuestionOrTask(text: string): boolean {
  const closing = text.trim();
  if (!closing) return false;
  if (/[?!]/.test(closing) || closing.includes("\n")) return false;
  return !FOLLOW_UP_TASK_PATTERNS.some((pattern) => pattern.test(closing));
}

/**
 * Strict fallback gate for text the model emits before a completion tool.
 * Tool-first remains the expected path; this accepts only a short,
 * scholar-facing declarative sentence that can safely serve as the sole close.
 */
export function isValidActivityCompletionClosing(text: string): boolean {
  const closing = text.trim();
  if (!closing || closing.length > 320) return false;
  if (closing.split(/\s+/).length < 5) return false;
  if (!/^(?:you\b|your\b|that\b[^.]{0,120}\byou\b)/i.test(closing)) {
    return false;
  }
  if (!closing.endsWith(".") || closing.slice(0, -1).includes(".")) return false;
  if (/[?!]/.test(closing) || closing.includes("\n")) return false;
  if (/\b(?:the|a|an|to|of|with|through|from|for|and|or|but)\.$/i.test(closing)) {
    return false;
  }
  if (FOLLOW_UP_TASK_PATTERNS.some((pattern) => pattern.test(closing))) {
    return false;
  }
  return COMPLETION_LANGUAGE_PATTERNS.some((pattern) => pattern.test(closing));
}
