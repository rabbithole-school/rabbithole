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
  ];
}

export function sendParentMathCannedQuestion(
  question: string,
  seedComposer: SeedParentComposer,
) {
  seedComposer(question, { send: true });
}
