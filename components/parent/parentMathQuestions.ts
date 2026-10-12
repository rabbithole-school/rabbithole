export type SeedParentComposer = (
  text: string,
  options: { send: true },
) => void;

export function parentMathCannedQuestions(scholarName: string): string[] {
  const firstName =
    scholarName.trim().split(/\s+/)[0] || "my child";

  return [
    "What's a fun math activity we could do at home this weekend?",
    `Give me a dinner-table math question ${firstName} would enjoy?`,
    // A "how does it work" chip on purpose: parents type this kind of question
    // unprompted, and the aide answers it from Rabbithole's own public code.
    // Worded as "how does it decide", not "which skills" — the aide answers
    // mechanism at topic altitude, never a per-skill list (GRANULARITY rule).
    `How does Rabbithole decide what's on ${firstName}'s math frontier?`,
  ];
}

export function sendParentMathCannedQuestion(
  question: string,
  seedComposer: SeedParentComposer,
) {
  seedComposer(question, { send: true });
}
