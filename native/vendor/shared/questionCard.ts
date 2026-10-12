/**
 * The question card: one real, answerable question in place of a paragraph to
 * read (review: question-cards proposal, TRA-254 follow-up). It rides the
 * done-screen moment (a story's probe, or a cross-domain preview seed) as a
 * "Bonus question", and the Quests list / Scholar's Prep reuse the same shape.
 *
 * FEEDBACK-ONLY: answering never touches mastery or spaced repetition (the
 * story-surface invariant in .claude/rules/rabbithole-practice-engine.md). The
 * answer index ships to the client so the verdict shows instantly; there is
 * nothing to protect.
 *
 * Shared by web and native (native reads it via native/vendor — re-run
 * `node native/scripts/sync-vendor.js` after editing).
 */

export type CardQuestion = {
  /** The question, ≤ 25 words, big type. Never instructions ("work out…"). */
  prompt: string;
  /** 2–4 short choices (≤ 6 words each), rendered as an equal-size grid. */
  choices: string[];
  /** Index into `choices` of the right answer. Every card question has one —
   *  a gut-call prediction ("the million or the penny?") still has a true
   *  answer the reveal confirms. */
  answerIndex: number;
  /** The payoff shown after answering: ONE line, ≤ 14 words, stands alone
   *  without the question (the question collapses once answered). */
  reveal: string;
  /** Label of the follow-up button, e.g. "Why? →" / "How?! →". Defaults to
   *  QUESTION_CARD_COPY.why when absent. */
  whyLabel?: string;
};

export const QUESTION_CARD_COPY = {
  /** Eyebrow tag on a done-screen question. */
  bonusTag: "Bonus question",
  why: "Why? →",
  done: "Done for today",
  /** The canonical verdict stamps (match VerdictStemCard / PracticeVerdictStamp). */
  correct: "Correct",
  miss: "Not quite",
} as const;

/** Recap line once answered: the question collapses to what they picked. */
export function questionRecap(question: CardQuestion, choiceIndex: number): string {
  const picked = question.choices[choiceIndex] ?? "";
  return `You said "${picked}"`;
}

export function isCorrectChoice(question: CardQuestion, choiceIndex: number): boolean {
  return choiceIndex === question.answerIndex;
}

/** Structural validity — used by data tests and defensively by the selector,
 *  which never offers a card whose question is malformed. */
export function isValidCardQuestion(q: CardQuestion | undefined): q is CardQuestion {
  return (
    !!q &&
    q.prompt.trim().length > 0 &&
    q.choices.length >= 2 &&
    q.choices.length <= 4 &&
    q.choices.every((c) => c.trim().length > 0) &&
    new Set(q.choices).size === q.choices.length &&
    Number.isInteger(q.answerIndex) &&
    q.answerIndex >= 0 &&
    q.answerIndex < q.choices.length &&
    q.reveal.trim().length > 0
  );
}
