/**
 * Pure logic for the done-screen QuestionCard (native), split out so it is
 * testable without a render harness: the equal-cell choice grid and the
 * answered / verdict state. Copy comes from the shared QUESTION_CARD_COPY, so
 * web and native read byte-identical strings.
 */
import {
  isCorrectChoice,
  questionRecap,
  type CardQuestion,
} from "../../../vendor/shared/questionCard";

/** Minimum height of every choice cell (pt). */
export const CHOICE_CELL_MIN_HEIGHT = 52;

/**
 * Columns for a choice grid. 3 choices are 3 equal columns (never a 2+1 wrap);
 * 2 and 4 are two columns (1x2 / 2x2). The card validates 2-4 choices.
 */
export function choiceGridColumns(choiceCount: number): number {
  return choiceCount === 3 ? 3 : 2;
}

/**
 * Rows of choice indexes. Every row has exactly `columns` entries for the
 * valid counts (2, 3, 4), so no row is ragged and every cell can be flex:1.
 */
export function choiceGridRows(choiceCount: number): number[][] {
  const columns = choiceGridColumns(choiceCount);
  const rows: number[][] = [];
  for (let i = 0; i < choiceCount; i += columns) {
    rows.push(
      Array.from({ length: Math.min(columns, choiceCount - i) }, (_, j) => i + j),
    );
  }
  return rows;
}

/** A choice cell's vertical padding and border width (pt). Both cell styles
 *  (QuestionCard, QuestionQueue) read these, so the chrome added back onto a
 *  measured CONTENT height can never drift from the style it stands for. */
export const CHOICE_CELL_PADDING_V = 8;
export const CHOICE_CELL_BORDER = 2;
const CHOICE_CELL_CHROME = 2 * (CHOICE_CELL_PADDING_V + CHOICE_CELL_BORDER);

/**
 * The one height every cell takes: the tallest cell CONTENT plus the cell's
 * padding + border, never below the minimum. Cells in a row already stretch
 * together; this equalises across rows.
 *
 * Feed it each cell's NATURAL content height (an inner wrapper with no
 * minHeight), never the cell's own layout: a cell already carrying the
 * computed minHeight reports that height back, so the value could only ever
 * grow — a rotation or a smaller font would leave every cell tall.
 */
export function commonCellHeight(
  contentHeights: Array<number | undefined>,
  min: number = CHOICE_CELL_MIN_HEIGHT,
): number {
  const tallest = contentHeights.reduce<number>((t, h) => Math.max(t, h ?? 0), 0);
  return Math.max(min, tallest + CHOICE_CELL_CHROME);
}

export type QuestionCardView =
  | { answered: false }
  | {
      answered: true;
      feedback: "correct" | "miss";
      recap: string;
    };

/** What the card shows for a given pick (null = not answered yet). Derived
 *  locally so the verdict never waits on the server. */
export function questionCardView(
  question: CardQuestion,
  picked: number | null,
): QuestionCardView {
  if (picked === null) return { answered: false };
  return {
    answered: true,
    feedback: isCorrectChoice(question, picked) ? "correct" : "miss",
    recap: questionRecap(question, picked),
  };
}
