import { isPreReader, needsYoungReaderTurnRules } from "./readingLevels";

export const SCHOLAR_OWNED_COMPLETION_CLOSING_GUIDANCE =
  "Unless they explicitly asked for a recap, close with exactly one brief, plain sentence and no question or next task. Preserve ownership of the conclusion: name at most the shape of the thinking they did, never restate, paraphrase, improve, or evaluate their answer; never enumerate the components of their reasoning; and never list what they learned. If the sentence would remind a reader what the answer was, remove that detail. Avoid approving adjectives such as solid, strong, clear, good, great, or correct.";

export const AUTOMATED_COMPLETION_CLOSING_GUIDANCE =
  "The app writes the scholar-facing completion close after the tool succeeds. The assistant response containing the tool call must contain no text, and you must not add a preface, assessment, recap, praise, question, task, or second closing before or after the tool.";

// The app-written line that marks an activity as finished (emitted only on the
// turn a completion tool actually records a NEW completion; see
// tutorSessionTools.emitCompletionClosing). Completion does not close the chat,
// and the scholar often keeps talking, so no line may claim the CONVERSATION is
// over ("That brings this thread to a close" read as the tutor hanging up on a
// six-year-old who was still mid-thought, TRA-501). Each line says only that
// THIS activity is finished, in words sized to the reader.
const PRE_READER_COMPLETION_CLOSINGS = [
  "All done with that one.",
  "You worked that one all the way through.",
  "That one is finished.",
  "You did the thinking on that one yourself.",
] as const;

const EARLY_READER_COMPLETION_CLOSINGS = [
  "You finished that one.",
  "You thought that one all the way through.",
  "That one is all done.",
  "You worked that out in your own words.",
  "You did the thinking on that one.",
] as const;

const STANDARD_COMPLETION_CLOSINGS = [
  "You worked that line of thinking through in your own words.",
  "This activity is finished, and the thinking was yours.",
  "You finished this activity with your own reasoning.",
  "You carried that reasoning through yourself.",
  "That's enough to let your reasoning stand on its own.",
] as const;

const ALL_COMPLETION_CLOSINGS: readonly string[] = [
  ...PRE_READER_COMPLETION_CLOSINGS,
  ...EARLY_READER_COMPLETION_CLOSINGS,
  ...STANDARD_COMPLETION_CLOSINGS,
];

/**
 * Which closing pool a scholar gets. Young readers are decided by the same
 * seam as the tutor's young-reader turn rules (`needsYoungReaderTurnRules`),
 * so the two can never disagree about who is a young reader. (This used to
 * hand-parse the level with its own `<= 3` cutoff, one band wider than the
 * early-reader register's `< 3`.)
 */
export function completionClosingPool(
  readingLevel: string | null | undefined,
): readonly string[] {
  if (isPreReader(readingLevel)) return PRE_READER_COMPLETION_CLOSINGS;
  if (needsYoungReaderTurnRules(readingLevel)) {
    return EARLY_READER_COMPLETION_CLOSINGS;
  }
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
): string {
  const pool = completionClosingPool(readingLevel);
  return pool[stableIndex(key, pool.length)];
}

export function isAutomaticCompletionClosing(text: string): boolean {
  return ALL_COMPLETION_CLOSINGS.includes(text.trim());
}

export const TIME_LIMIT_WRAP_GUIDANCE =
  "Help the scholar finish the thought they are in without summarizing it for them. If they are still engaged and the thought is unfinished, invite at most one final line in their own words and point only to where they can resume, not what they concluded. If the thought is complete, close without another question. If they explicitly say they are leaving or say goodbye, reply with one brief content-free goodbye — no recap, praise, question, reflection, or suggested next step.";
