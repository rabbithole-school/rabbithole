/**
 * The scholar's ONE list of open items — the Quests tab and the Scholar's Prep
 * "Keep going" section both render rows from `questionQueue.forSelf`
 * (convex/questionQueue.ts). This module holds the copy and the small pure
 * layout rules both frontends share, so web and native can't drift.
 *
 * Shared by web and native (native reads it via native/vendor — re-run
 * `node native/scripts/sync-vendor.js` after editing).
 */

export const QUESTION_QUEUE_COPY = {
  /** Quests tab eyebrows. */
  openQuestions: "Open questions",
  fromTeacher: "From your teacher",
  /** Answered row: the follow-up pair (equal size). "Why? →" itself comes
   *  from the question (`whyLabel`) or QUESTION_CARD_COPY.why. */
  later: "Later",
  /** Teacher-suggested row actions. */
  start: "Start",
  notNow: "Not now",
  /** Scholar's Prep — the three plain questions. */
  prepDue: "Due",
  prepDueEmpty: "Nothing due tonight.",
  prepDoneToday: "Done today?",
  prepDoneTodayHint: "Only you know if these are finished.",
  prepDone: "✓ Done",
  prepKeepOpen: "Keep it open",
  prepUndo: "Undo",
  prepMarkedDone: "Marked done",
  prepKeepGoing: "Keep going · from your Quests",
} as const;

/** How many queue rows the Scholar's Prep "Keep going" section carries. */
export const PREP_KEEP_GOING_COUNT = 3;

/**
 * Equal-size answer grid columns for a question's choices. Narrow (phone /
 * iPad portrait) vs wide (≥ md): 4 → 2×2 / 4 across, 3 → stacked / 3 across,
 * 2 → 2 across. Never a 3+1 wrap and never text-sized pills.
 */
export function answerGridColumns(choiceCount: number): {
  narrow: number;
  wide: number;
} {
  if (choiceCount === 4) return { narrow: 2, wide: 4 };
  if (choiceCount === 3) return { narrow: 1, wide: 3 };
  return { narrow: 2, wide: 2 };
}

/** Split choices into equal rows of `columns` (native renders rows of flex:1
 *  cells with a common height; web uses CSS grid). Every row is full except
 *  when `columns` doesn't divide the count — which `answerGridColumns` never
 *  produces for 2–4 choices. */
export function answerGridRows<T>(choices: readonly T[], columns: number): T[][] {
  const size = Math.max(1, columns);
  const rows: T[][] = [];
  for (let i = 0; i < choices.length; i += size) {
    rows.push(choices.slice(i, i + size));
  }
  return rows;
}
