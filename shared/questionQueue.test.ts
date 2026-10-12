import { describe, expect, test } from "vitest";
import { answerGridColumns, answerGridRows } from "./questionQueue";

describe("answer grid layout", () => {
  test("4 choices: 2×2 narrow, 4 across wide", () => {
    expect(answerGridColumns(4)).toEqual({ narrow: 2, wide: 4 });
  });

  test("3 choices: stacked narrow, 3 across wide", () => {
    expect(answerGridColumns(3)).toEqual({ narrow: 1, wide: 3 });
  });

  test("2 choices: always side by side", () => {
    expect(answerGridColumns(2)).toEqual({ narrow: 2, wide: 2 });
  });

  test("every 2–4 choice layout fills its rows evenly (never 3+1)", () => {
    for (const count of [2, 3, 4]) {
      const choices = Array.from({ length: count }, (_, i) => i);
      for (const columns of Object.values(answerGridColumns(count))) {
        const rows = answerGridRows(choices, columns);
        expect(rows.flat()).toEqual(choices);
        expect(new Set(rows.map((row) => row.length)).size).toBe(1);
      }
    }
  });
});
