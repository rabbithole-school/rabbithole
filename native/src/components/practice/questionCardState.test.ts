import { describe, expect, it } from "vitest";

import {
  CHOICE_CELL_BORDER,
  CHOICE_CELL_MIN_HEIGHT,
  CHOICE_CELL_PADDING_V,
  choiceGridColumns,
  choiceGridRows,
  commonCellHeight,
  questionCardView,
} from "./questionCardState";
import type { CardQuestion } from "../../../vendor/shared/questionCard";

const q = (n: number, answerIndex = 1): CardQuestion => ({
  prompt: "The million or the penny?",
  choices: ["A", "B", "C", "D"].slice(0, n),
  answerIndex,
  reveal: "Doubling a penny beats a million.",
});

describe("choice grid", () => {
  it("lays 2 choices as 1x2, 3 as 3 equal columns, 4 as 2x2", () => {
    expect(choiceGridRows(2)).toEqual([[0, 1]]);
    expect(choiceGridRows(3)).toEqual([[0, 1, 2]]);
    expect(choiceGridRows(4)).toEqual([
      [0, 1],
      [2, 3],
    ]);
  });

  it("never produces a ragged row for a valid choice count", () => {
    for (const n of [2, 3, 4]) {
      const cols = choiceGridColumns(n);
      for (const row of choiceGridRows(n)) expect(row).toHaveLength(cols);
    }
  });

  const chrome = 2 * (CHOICE_CELL_PADDING_V + CHOICE_CELL_BORDER);

  it("is the tallest content plus the cell chrome, never below the minimum", () => {
    expect(commonCellHeight([])).toBe(CHOICE_CELL_MIN_HEIGHT);
    expect(commonCellHeight([19, undefined, 19])).toBe(CHOICE_CELL_MIN_HEIGHT);
    expect(commonCellHeight([19, 58, 38])).toBe(58 + chrome);
  });

  it("shrinks back when the content does (rotation / smaller font)", () => {
    // Content heights are natural (no minHeight), so a re-measure after the
    // text re-wraps shorter lowers the shared height instead of ratcheting.
    const tall = commonCellHeight([58, 19]);
    const after = commonCellHeight([19, 19]);
    expect(tall).toBe(58 + chrome);
    expect(after).toBe(CHOICE_CELL_MIN_HEIGHT);
    expect(after).toBeLessThan(tall);
  });
});

describe("questionCardView", () => {
  it("is unanswered before a pick", () => {
    expect(questionCardView(q(3), null)).toEqual({ answered: false });
  });

  it("reads correct vs miss from the pick and carries the recap", () => {
    expect(questionCardView(q(3, 1), 1)).toEqual({
      answered: true,
      feedback: "correct",
      recap: 'You said "B"',
    });
    expect(questionCardView(q(3, 1), 2)).toMatchObject({
      answered: true,
      feedback: "miss",
      recap: 'You said "C"',
    });
  });
});
