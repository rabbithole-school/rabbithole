import { describe, expect, test } from "vitest";

import {
  splitStemBlocks,
  stemPreviewText,
  stemTableColumnWidths,
  stemToSpeech,
  type StemBlock,
} from "./practiceStemBlocks";

// The 7 real template stems (convex/lib/practice/templates.ts), with sample
// numbers substituted for the generated ones — the SHAPE is what matters.
const REAL_STEMS: { name: string; stem: string; expected: StemBlock[] }[] = [
  {
    name: "equivalent-ratio table (line 3908)",
    stem: "Complete the equivalent-ratio table.\nA | B\n4 | 7\n8 | 14\n20 | ?",
    expected: [
      { kind: "text", text: "Complete the equivalent-ratio table." },
      {
        kind: "table",
        header: ["A", "B"],
        rows: [
          ["4", "7"],
          ["8", "14"],
          ["20", "?"],
        ],
      },
    ],
  },
  {
    name: "double number line — NOT a header (line 3917)",
    stem:
      "Two aligned scales show equivalent ratios.\nMeters: 0 | 5 | 10 | 15\nSeconds: 0 | 3 | 6 | ?\nWhat value belongs at the final tick?",
    expected: [
      { kind: "text", text: "Two aligned scales show equivalent ratios." },
      {
        kind: "table",
        rows: [
          ["Meters: 0", "5", "10", "15"],
          ["Seconds: 0", "3", "6", "?"],
        ],
      },
      { kind: "text", text: "What value belongs at the final tick?" },
    ],
  },
  {
    name: "y = k times x (line 4173)",
    stem: "The rule is y = 5 times x.\nx | y\n1 | 5\n3 | 15\n7 | ?\nWhat is the missing output?",
    expected: [
      { kind: "text", text: "The rule is y = 5 times x." },
      {
        kind: "table",
        header: ["x", "y"],
        rows: [
          ["1", "5"],
          ["3", "15"],
          ["7", "?"],
        ],
      },
      { kind: "text", text: "What is the missing output?" },
    ],
  },
  {
    name: "proportional? choice item (line 4212)",
    stem: "Does this table represent a proportional relationship?\nx | y\n1 | 2\n2 | 4\n3 | 6\n4 | 8",
    expected: [
      { kind: "text", text: "Does this table represent a proportional relationship?" },
      {
        kind: "table",
        header: ["x", "y"],
        rows: [
          ["1", "2"],
          ["2", "4"],
          ["3", "6"],
          ["4", "8"],
        ],
      },
    ],
  },
  {
    name: "constant of proportionality — prose has a slash (line 4265)",
    stem: "Find the constant of proportionality k = y/x.\nx | y\n5 | 3\n10 | 6\n20 | 12",
    expected: [
      { kind: "text", text: "Find the constant of proportionality k = y/x." },
      {
        kind: "table",
        header: ["x", "y"],
        rows: [
          ["5", "3"],
          ["10", "6"],
          ["20", "12"],
        ],
      },
    ],
  },
  {
    name: "input-output rule (line 5216)",
    stem: "Every row follows the same input-output rule.\ninput | output\n1 | 2\n3 | 6\n5 | ?\n8 | 16\nWhat output replaces ?",
    expected: [
      { kind: "text", text: "Every row follows the same input-output rule." },
      {
        kind: "table",
        header: ["input", "output"],
        rows: [
          ["1", "2"],
          ["3", "6"],
          ["5", "?"],
          ["8", "16"],
        ],
      },
      { kind: "text", text: "What output replaces ?" },
    ],
  },
  {
    name: "linear rule x/y (line 5237)",
    stem: "The table follows one linear rule.\nx | y\n2 | 5\n3 | 8\n4 | 11\nWhat is y when x = 9?",
    expected: [
      { kind: "text", text: "The table follows one linear rule." },
      {
        kind: "table",
        header: ["x", "y"],
        rows: [
          ["2", "5"],
          ["3", "8"],
          ["4", "11"],
        ],
      },
      { kind: "text", text: "What is y when x = 9?" },
    ],
  },
];

describe("splitStemBlocks — real template stems", () => {
  test.each(REAL_STEMS)("$name", ({ stem, expected }) => {
    expect(splitStemBlocks(stem)).toEqual(expected);
  });
});

describe("splitStemBlocks — non-tables stay ordinary text", () => {
  test("a plain stem returns one byte-identical text block", () => {
    const stem = "What is 3/4 + 1/8? Give your answer in eighths.";
    expect(splitStemBlocks(stem)).toEqual([{ kind: "text", text: stem }]);
  });

  test("a multi-line stem with no pipe run is preserved verbatim", () => {
    const stem = "Line one.\nLine two.\nLine three.";
    expect(splitStemBlocks(stem)).toEqual([{ kind: "text", text: stem }]);
  });

  test("a ragged run (unequal cell counts) is left untouched", () => {
    const stem = "Sort these.\na | b | c\n1 | 2";
    expect(splitStemBlocks(stem)).toEqual([{ kind: "text", text: stem }]);
  });

  test("a single pipe line is left untouched", () => {
    const stem = "Compute a | b for the pair.";
    expect(splitStemBlocks(stem)).toEqual([{ kind: "text", text: stem }]);
  });

  test("absolute-value taxicab prose is not a table", () => {
    // storyRegistry.ts:2618 — |x1 - x2| + |y1 - y2| must stay plain text.
    const stem =
      "Taxicab geometry defines distance as horizontal blocks plus vertical blocks: |x1 - x2| + |y1 - y2|. Compute it.";
    expect(splitStemBlocks(stem)).toEqual([{ kind: "text", text: stem }]);
  });

  test("a rejected pipe run is emitted WHOLE as text, never partially re-parsed", () => {
    // The first row has 3 cells, the rest 2 — the maximal pipe run is not
    // uniform, so per the contract the WHOLE run stays ordinary text. It must
    // NOT drop the first line as a stray and re-parse the 2-cell suffix as a
    // table.
    const stem = "x | y | z\n1 | 2\n3 | 4";
    expect(splitStemBlocks(stem)).toEqual([{ kind: "text", text: stem }]);
  });

  test("a rejected run with surrounding prose keeps everything as one text block", () => {
    const stem = "Sort these.\na | b | c\n1 | 2\n3 | 4\nDone.";
    expect(splitStemBlocks(stem)).toEqual([{ kind: "text", text: stem }]);
  });
});

describe("splitStemBlocks — header rule", () => {
  test("a fraction-valued first row is data, not a header", () => {
    // hasFraction cells count as numeric, so "1/2 | 3/4" is NOT promoted to a
    // heading — it is the table's first data row.
    expect(splitStemBlocks("1/2 | 3/4\n1 | 1.5")).toEqual([
      {
        kind: "table",
        rows: [
          ["1/2", "3/4"],
          ["1", "1.5"],
        ],
      },
    ]);
  });

  test("a word-valued first row is still a header", () => {
    expect(splitStemBlocks("input | output\n1 | 2\n3 | 4")).toEqual([
      {
        kind: "table",
        header: ["input", "output"],
        rows: [
          ["1", "2"],
          ["3", "4"],
        ],
      },
    ]);
  });
});

describe("stemToSpeech", () => {
  test("reads a table coherently", () => {
    const stem = "Every row follows the same input-output rule.\ninput | output\n1 | 2\n3 | 6\nWhat output replaces ?";
    expect(stemToSpeech(stem)).toBe(
      "Every row follows the same input-output rule. Columns input, output. Row: 1, 2. Row: 3, 6. What output replaces ?",
    );
  });

  test("a no-table stem reads exactly like fractionsToSpeech", () => {
    const stem = "What is 3/4 of 8?";
    // fractionsToSpeech renders "3/4" as "3 over 4".
    expect(stemToSpeech(stem)).toBe("What is 3 over 4 of 8?");
  });

  test("a headerless table omits the Columns clause", () => {
    const stem = "Two aligned scales.\nMeters: 0 | 5 | 10\nSeconds: 0 | 3 | 6\nFinal tick?";
    expect(stemToSpeech(stem)).toBe(
      "Two aligned scales. Row: Meters: 0, 5, 10. Row: Seconds: 0, 3, 6. Final tick?",
    );
  });
});

describe("stemTableColumnWidths — per-column sizing", () => {
  test("a label column gets a wider ideal width than its numeric siblings", () => {
    // The real ratio_double_number_line case: the label column ("Meters: 0" /
    // "Seconds: 0") must be sized wider than the short numeric columns, instead
    // of every column being forced to the label's width (the #2498 bug).
    const rows = [
      ["Meters: 0", "4", "8", "12"],
      ["Seconds: 0", "5", "10", "?"],
    ];
    const widths = stemTableColumnWidths(undefined, rows, 22);
    expect(widths).toHaveLength(4);
    // The label column is wider than each numeric column…
    expect(widths[0]).toBeGreaterThan(widths[1]);
    expect(widths[0]).toBeGreaterThan(widths[2]);
    expect(widths[0]).toBeGreaterThan(widths[3]);
    // …and the two-digit columns ("10", "12") are at least as wide as the
    // single-digit one, never wider than the label.
    expect(widths[2]).toBeGreaterThanOrEqual(widths[1]);
    expect(widths[2]).toBeLessThan(widths[0]);
  });

  test("the header participates in a column's width", () => {
    // A short-valued column under a long header is sized for the header.
    const widths = stemTableColumnWidths(["quantity", "n"], [["1", "2"]], 22);
    expect(widths[0]).toBeGreaterThan(widths[1]);
  });

  test("returns one width per column", () => {
    const widths = stemTableColumnWidths(["x", "y"], [["1", "2"], ["3", "4"]], 22);
    expect(widths).toHaveLength(2);
  });

  test("numCols is the MAXIMUM column count across header and rows (ragged input)", () => {
    // Not reachable through splitStemBlocks (it only emits uniform >=2-col
    // tables), but stemTableColumnWidths is exported with permissive types, so a
    // ragged shape must never silently drop columns.
    // Empty header ⇒ still sized from the row.
    expect(stemTableColumnWidths([], [["1", "2"]], 22)).toHaveLength(2);
    // Short header ⇒ the extra row column is kept.
    expect(stemTableColumnWidths(["x"], [["1", "2"]], 22)).toHaveLength(2);
    // Ragged rows ⇒ sized to the widest row.
    expect(stemTableColumnWidths(undefined, [["1"], ["2", "3"]], 22)).toHaveLength(2);
  });
});

describe("stemPreviewText — one scannable line for dense rows", () => {
  test("a stem with no table comes back byte-identical", () => {
    const stem = "What is 3/4 + 1/8? Give your answer in eighths.";
    expect(stemPreviewText(stem)).toBe(stem);
  });

  test("a multi-line no-table stem is unchanged (no whitespace collapse)", () => {
    const stem = "Line one.\nLine two.\nLine three.";
    expect(stemPreviewText(stem)).toBe(stem);
  });

  test("a headered table collapses to 'a, b · c, d' inline with its prose", () => {
    const stem =
      "Every row follows the same input-output rule.\ninput | output\n1 | 2\n3 | 6\nWhat output replaces ?";
    expect(stemPreviewText(stem)).toBe(
      "Every row follows the same input-output rule. input, output · 1, 2 · 3, 6 What output replaces ?",
    );
  });

  test("a headerless table collapses every row, including the label row", () => {
    const stem =
      "Two aligned scales show equivalent ratios.\nMeters: 0 | 4 | 8 | 12\nSeconds: 0 | 5 | 10 | ?\nWhat value belongs at the final tick?";
    expect(stemPreviewText(stem)).toBe(
      "Two aligned scales show equivalent ratios. Meters: 0, 4, 8, 12 · Seconds: 0, 5, 10, ? What value belongs at the final tick?",
    );
  });
});
