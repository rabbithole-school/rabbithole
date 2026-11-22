import {
  readLevelOf,
  selectLevelSections,
  talkLevelOf,
  type ReadLevel,
} from "./readingLevels";

export const SCHOLAR_OWNED_COMPLETION_CLOSING_GUIDANCE =
  "Unless they explicitly asked for a recap, close with exactly one brief, plain sentence and no question or next task. Preserve ownership of the conclusion: name at most the shape of the thinking they did, never restate, paraphrase, improve, or evaluate their answer; never enumerate the components of their reasoning; and never list what they learned. If the sentence would remind a reader what the answer was, remove that detail. Avoid approving adjectives such as solid, strong, clear, good, great, or correct.";

export const AUTOMATED_COMPLETION_CLOSING_GUIDANCE =
  "Call the tool before any text: the assistant response containing the tool call must contain no text before it. After the tool succeeds, usually write nothing. The app adds a short note after your reply saying the activity is done, and that note is the whole reply. Write a sentence or two only when the scholar's latest message asked you something, corrected you, disagreed with you, or showed confusion, and then answer only that. Never restate or sum up what they figured out. Do not write your own closing, completion announcement, recap, praise, assessment, question, or new task.";

/**
 * Fed back as the tool result when a completion tool records a NEW completion
 * tool-first. The completing turn used to carry no tutor text at all, so a
 * scholar's last question, correction or pushback went unanswered and a stock
 * line stood in for the reply (TRA-703). Now the tutor answers what is still
 * open, and the app's status note follows it.
 */
export const COMPLETION_RECORDED_FOLLOW_UP_GUIDANCE =
  "The activity is now recorded complete. Usually write nothing now: the app adds a short note saying the activity is done, and that note is the whole reply. Only if the scholar's latest message asked you something, corrected you, disagreed, or showed confusion, answer that in a sentence or two and stop. Never restate or sum up what they figured out, and do not announce completion, praise, assess their thinking, or add a question or task.";

// The app-written note that marks an activity as finished (appended at the end
// of the turn on which a completion tool records a NEW completion; see
// tutorSessionTools.queueCompletionNote / appendPendingCompletionNote). It is
// a plain status, not a sentence about the scholar's reasoning: lines like
// "This activity is finished, and the thinking was yours." replaced the
// tutor's reply and confused kids ("What?", TRA-703). Completion does not
// close the chat, so the note says they can keep talking (TRA-501: no line
// may claim the CONVERSATION is over).
const PRE_READER_COMPLETION_NOTE =
  "All done with this one. You can keep talking or move on.";
const STANDARD_COMPLETION_NOTE =
  "This activity is done. You can keep talking or move on.";

const PRE_READER_COMPLETION_CLOSINGS = [PRE_READER_COMPLETION_NOTE] as const;
const STANDARD_COMPLETION_CLOSINGS = [STANDARD_COMPLETION_NOTE] as const;

// Stock lines the app wrote before TRA-703. Still recognized so older
// transcripts (evals, prod reads) classify as automatic closings.
const LEGACY_COMPLETION_CLOSINGS = [
  "All done with that one.",
  "You worked that one all the way through.",
  "That one is finished.",
  "You did the thinking on that one yourself.",
  "You finished that one.",
  "You thought that one all the way through.",
  "That one is all done.",
  "You worked that out in your own words.",
  "You did the thinking on that one.",
  "You worked that line of thinking through in your own words.",
  "This activity is finished, and the thinking was yours.",
  "You finished this activity with your own reasoning.",
  "You carried that reasoning through yourself.",
  "That's enough to let your reasoning stand on its own.",
] as const;

const ALL_COMPLETION_CLOSINGS: readonly string[] = [
  PRE_READER_COMPLETION_NOTE,
  STANDARD_COMPLETION_NOTE,
  ...LEGACY_COMPLETION_CLOSINGS,
];

/**
 * The completion note pool for a scholar, from the same section selection as
 * the tutor prompt (`selectLevelSections`), so the two can never disagree: the
 * pre-reader register (listener at talk K or unset) gets the spoken note;
 * everyone else gets the standard one. `readLevel` omitted (offline/eval
 * callers) is inferred from the talk string, so a legacy "pre-reader" still
 * lands in the pre-reader pool. A pool of one: the note is a status, so it
 * does not vary.
 */
export function completionClosingPool(
  readingLevel: string | null | undefined,
  readLevel?: ReadLevel,
): readonly string[] {
  const talk = talkLevelOf(readingLevel);
  const read = readLevel ?? readLevelOf({ readingLevel });
  const picked = selectLevelSections({ talk, read, write: "own" });
  if (picked.register === "preReader") return PRE_READER_COMPLETION_CLOSINGS;
  return STANDARD_COMPLETION_CLOSINGS;
}

function stableIndex(key: string, length: number): number {
  let hash = 2166136261;
  for (let i = 0; i < key.length; i += 1) {
    hash ^= key.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) % length;
}

export function selectCompletionClosing(
  readingLevel: string | null | undefined,
  key: string,
  readLevel?: ReadLevel,
): string {
  const pool = completionClosingPool(readingLevel, readLevel);
  return pool[stableIndex(key, pool.length)];
}

export function isAutomaticCompletionClosing(text: string): boolean {
  return ALL_COMPLETION_CLOSINGS.includes(text.trim());
}

export const TIME_LIMIT_WRAP_GUIDANCE =
  "Help the scholar finish the thought they are in without summarizing it for them. If they are still engaged and the thought is unfinished, invite at most one final line in their own words and point only to where they can resume, not what they concluded. If the thought is complete, close without another question. If they explicitly say they are leaving or say goodbye, reply with one brief content-free goodbye — no recap, praise, question, reflection, or suggested next step.";
