export const SCHOLAR_OWNED_COMPLETION_CLOSING_GUIDANCE =
  "Unless they explicitly asked for a recap, close with exactly one brief, plain sentence and no question or next task. Preserve ownership of the conclusion: name at most the shape of the thinking they did, never restate, paraphrase, improve, or evaluate their answer; never enumerate the components of their reasoning; and never list what they learned. If the sentence would remind a reader what the answer was, remove that detail. Avoid approving adjectives such as solid, strong, clear, good, great, or correct.";

export const AUTOMATED_COMPLETION_CLOSING_GUIDANCE =
  "The app writes the scholar-facing completion close after the tool succeeds. The assistant response containing the tool call must contain no text, and you must not add a preface, assessment, recap, praise, question, task, or second closing before or after the tool.";

const PRE_READER_COMPLETION_CLOSINGS = [
  "All done with that one for now.",
  "You worked that one all the way through.",
  "That's where we can stop for now.",
  "You brought that thinking to the end.",
] as const;

const EARLY_READER_COMPLETION_CLOSINGS = [
  "You worked that line of thinking through.",
  "That's a clear place to stop for now.",
  "You brought that idea to a stopping point.",
  "That brings this thread to a close.",
  "You reached the end of that thread in your own words.",
] as const;

const STANDARD_COMPLETION_CLOSINGS = [
  "You worked that line of thinking through in your own words.",
  "That's a clear place to leave this for now.",
  "You brought that thread to its own conclusion.",
  "That brings this line of thinking to a close.",
  "You carried that reasoning to a stopping point yourself.",
  "That's enough to let your reasoning stand on its own.",
] as const;

const ALL_COMPLETION_CLOSINGS: readonly string[] = [
  ...PRE_READER_COMPLETION_CLOSINGS,
  ...EARLY_READER_COMPLETION_CLOSINGS,
  ...STANDARD_COMPLETION_CLOSINGS,
];

export function completionClosingPool(
  readingLevel: string | null | undefined,
): readonly string[] {
  if (readingLevel === "pre-reader") return PRE_READER_COMPLETION_CLOSINGS;
  if (readingLevel === "K") return EARLY_READER_COMPLETION_CLOSINGS;

  const gradeText = readingLevel?.match(/\d+(?:\.\d+)?/)?.[0] ?? "";
  const grade = Number.parseFloat(gradeText);
  return Number.isFinite(grade) && grade <= 3
    ? EARLY_READER_COMPLETION_CLOSINGS
    : STANDARD_COMPLETION_CLOSINGS;
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
