import { describe, expect, test } from "vitest";

import {
  answersEqual,
  decAns,
  fracAns,
  intAns,
  numericValue,
  parseAnswer,
  type AnswerType,
  type TypedAnswer,
} from "../practice/answers";
import {
  buildTemplateServable,
  gradeSubmission,
  PLACEMENT_POLICY,
  PRACTICE_POLICY,
} from "../practice/servable";
import { gradeTemplateItem } from "../practice/session";

type ToleranceCase = {
  label: string;
  input: string;
  type: AnswerType;
  expected: TypedAnswer;
  parsedValue: number;
};

const TOLERANCE_CASES: ToleranceCase[] = [
  {
    label: "leading-dot decimal",
    input: ".33",
    type: "decimal",
    expected: decAns(0.33),
    parsedValue: 0.33,
  },
  {
    label: "trailing zero",
    input: "0.330",
    type: "decimal",
    expected: decAns(0.33),
    parsedValue: 0.33,
  },
  {
    label: "value-preserving trailing zero",
    input: "0.50",
    type: "decimal",
    expected: decAns(0.5),
    parsedValue: 0.5,
  },
  {
    label: "integer leading zeros",
    input: "007",
    type: "integer",
    expected: intAns(7),
    parsedValue: 7,
  },
  {
    label: "decimal leading zeros",
    input: "00.33",
    type: "decimal",
    expected: decAns(0.33),
    parsedValue: 0.33,
  },
  {
    label: "fraction leading zeros",
    input: "02/04",
    type: "fraction",
    expected: fracAns(1, 2),
    parsedValue: 0.5,
  },
  {
    label: "integer leading plus",
    input: "+7",
    type: "integer",
    expected: intAns(7),
    parsedValue: 7,
  },
  {
    label: "decimal leading plus",
    input: "+.33",
    type: "decimal",
    expected: decAns(0.33),
    parsedValue: 0.33,
  },
  {
    label: "fraction leading plus",
    input: "+1/2",
    type: "fraction",
    expected: fracAns(1, 2),
    parsedValue: 0.5,
  },
  {
    label: "integer surrounding whitespace",
    input: "  7  ",
    type: "integer",
    expected: intAns(7),
    parsedValue: 7,
  },
  {
    label: "decimal surrounding whitespace",
    input: "  .33  ",
    type: "decimal",
    expected: decAns(0.33),
    parsedValue: 0.33,
  },
  {
    label: "fraction surrounding whitespace",
    input: "  1 / 2  ",
    type: "fraction",
    expected: fracAns(1, 2),
    parsedValue: 0.5,
  },
  {
    label: "trailing decimal point",
    input: "5.",
    type: "decimal",
    expected: decAns(5),
    parsedValue: 5,
  },
  {
    label: "integer-valued trailing decimal point",
    input: "5.",
    type: "integer",
    expected: intAns(5),
    parsedValue: 5,
  },
  {
    label: "integer Unicode minus",
    input: "−7",
    type: "integer",
    expected: intAns(-7),
    parsedValue: -7,
  },
  {
    label: "decimal Unicode minus",
    input: "−.33",
    type: "decimal",
    expected: decAns(-0.33),
    parsedValue: -0.33,
  },
  {
    label: "fraction Unicode minus",
    input: "−1/2",
    type: "fraction",
    expected: fracAns(-1, 2),
    parsedValue: -0.5,
  },
];

describe("numeric answer tolerance table", () => {
  test.each(TOLERANCE_CASES)("$label: $input", ({ input, type, expected, parsedValue }) => {
    const parsed = parseAnswer(input, type);
    if (parsed === null) throw new Error(`Expected ${JSON.stringify(input)} to parse as ${type}`);

    expect(parsed).toEqual(expected);
    expect(numericValue(parsed)).toBe(parsedValue);
    expect(answersEqual(parsed, expected)).toBe(true);
  });

  test("the live .33 regression grades correctly in practice and placement", () => {
    let item: ReturnType<typeof buildTemplateServable> = null;
    for (let seed = 0; seed < 50_000; seed++) {
      const candidate = buildTemplateServable(
        `decimal_notation_fractions#${seed}`,
        null,
        "fraction-arithmetic",
      );
      if (candidate?.prompt.stem === "Write 33/100 as a decimal.") {
        item = candidate;
        break;
      }
    }

    if (item === null) throw new Error("Could not derive the live decimal notation template");
    expect(gradeSubmission(item, { kind: "typed", raw: ".33" }, PRACTICE_POLICY).correct).toBe(
      true,
    );
    expect(gradeSubmission(item, { kind: "typed", raw: ".33" }, PLACEMENT_POLICY).correct).toBe(
      true,
    );
    expect(gradeTemplateItem(item.itemId, ".33")?.correct).toBe(true);
  });
});

describe("numeric tolerance boundaries", () => {
  test.each([
    ["decimal comma", "0,33", "decimal"],
    ["bare thousands separator", "1,000", "integer"],
    ["decimal submitted for a fraction", "0.5", "fraction"],
  ] as const)("rejects %s", (_label, input, type) => {
    expect(parseAnswer(input, type)).toBeNull();
  });

  test("numeric tolerance does not loosen expression grammar", () => {
    expect(answersEqual(parseAnswer(".33", "expression")!, decAns(0.33))).toBe(false);
    expect(answersEqual(parseAnswer("+7", "expression")!, intAns(7))).toBe(false);
    expect(answersEqual(parseAnswer("−7", "expression")!, intAns(-7))).toBe(false);
  });
});

describe("fraction items with whole-number values (the #880×#897 train regression)", () => {
  test("a bare integer parses as n/1 for fraction items and round-trips #880's whole-number display", () => {
    expect(parseAnswer("1", "fraction")).toEqual({ type: "fraction", num: 1, den: 1 });
    expect(parseAnswer("-3", "fraction")).toEqual({ type: "fraction", num: -3, den: 1 });
    // Equivalence both ways: typed "5/5" vs canonical "1", and vice versa.
    expect(answersEqual(parseAnswer("5/5", "fraction")!, parseAnswer("1", "fraction")!)).toBe(true);
    // A decimal still does NOT demonstrate the fraction representation.
    expect(parseAnswer("0.75", "fraction")).toBeNull();
  });
});

describe("mixed numbers (`W N/D`) — the 2-D editor's whole-plus-fraction form", () => {
  test("parses `2 1/2` as the reduced improper fraction 5/2", () => {
    expect(parseAnswer("2 1/2", "fraction")).toEqual({ type: "fraction", num: 5, den: 2 });
    // Value-equivalent to the improper form and the decimal, both directions.
    expect(answersEqual(parseAnswer("2 1/2", "fraction")!, parseAnswer("5/2", "fraction")!)).toBe(true);
    expect(answersEqual(parseAnswer("5/2", "fraction")!, parseAnswer("2 1/2", "fraction")!)).toBe(true);
  });

  test("carries the sign of the whole part across the fraction", () => {
    expect(parseAnswer("-2 1/2", "fraction")).toEqual({ type: "fraction", num: -5, den: 2 });
  });

  test("reduces the fractional part (`1 2/4` → 3/2)", () => {
    expect(parseAnswer("1 2/4", "fraction")).toEqual({ type: "fraction", num: 3, den: 2 });
  });

  test("a mixed number equals its improper form for expression items, sign included", () => {
    // Expression items route through the AST evaluator: "2 1/2" → (2+1/2) = 5/2.
    expect(
      answersEqual(parseAnswer("2 1/2", "expression")!, parseAnswer("5/2", "expression")!),
    ).toBe(true);
    expect(
      answersEqual(parseAnswer("-2 1/2", "expression")!, parseAnswer("-5/2", "expression")!),
    ).toBe(true);
    // A subtraction context folds correctly, too: 5 - 2 1/2 = 2.5 = 5/2.
    expect(
      answersEqual(parseAnswer("5 - 2 1/2", "expression")!, parseAnswer("5/2", "expression")!),
    ).toBe(true);
  });

  test("a compound fractional part uses explicit `+`, grading by its true value", () => {
    // The editor serializes a mixed number with a COMPOUND fractional part as
    // `2+(1/3)/4` (explicit plus), not the space form `2 (1/3)/4` — which the
    // implicit-multiplication rule would misread as 2×(1/3)/4 = 1/6.
    // True value: 2 + (1/3)/4 = 2 + 1/12 = 25/12.
    expect(
      answersEqual(parseAnswer("2+(1/3)/4", "expression")!, parseAnswer("25/12", "expression")!),
    ).toBe(true);
    // …and it must NOT collapse to the multiplication reading.
    expect(
      answersEqual(parseAnswer("2+(1/3)/4", "expression")!, parseAnswer("1/6", "expression")!),
    ).toBe(false);
  });
});

describe("expression equivalence by mathematical value", () => {
  test("treats regrouped symbolic forms as equivalent", () => {
    expect(
      answersEqual(
        parseAnswer("1/(x^2)", "expression")!,
        parseAnswer("1/((x)^2)", "expression")!,
      ),
    ).toBe(true);
    expect(
      answersEqual(
        parseAnswer("2(x+1)", "expression")!,
        parseAnswer("2*x+2", "expression")!,
      ),
    ).toBe(true);
  });

  test("keeps remainder-form expressions distinct from algebraic ones", () => {
    expect(
      answersEqual(
        parseAnswer("7 R 2", "expression")!,
        parseAnswer("7r2", "expression")!,
      ),
    ).toBe(true);
    expect(
      answersEqual(
        parseAnswer("7 R 2", "expression")!,
        parseAnswer("7+2", "expression")!,
      ),
    ).toBe(false);
  });
});

describe("radical expressions", () => {
  test("keeps ordinary equivalent radical expressions mathematically equivalent", () => {
    const expected = parseAnswer("3√7", "expression")!;
    expect(answersEqual(parseAnswer("3√7", "expression")!, expected)).toBe(true);
    expect(answersEqual(parseAnswer("√63", "expression")!, expected)).toBe(true);
    expect(answersEqual(parseAnswer("2√7", "expression")!, expected)).toBe(false);
  });

  test("requires canonical simplified radicals only when the skill opts in", () => {
    const expected = parseAnswer("3√7", "expression")!;
    expect(
      answersEqual(parseAnswer("√63", "expression")!, expected, {
        requireSimplifiedRadical: true,
      }),
    ).toBe(false);
    expect(
      answersEqual(parseAnswer("3√7", "expression")!, expected, {
        requireSimplifiedRadical: true,
      }),
    ).toBe(true);
  });

  test("grades cube roots by value but keeps their canonical index and cube-free radicand", () => {
    const expected = parseAnswer("3∛2", "expression")!;
    expect(answersEqual(parseAnswer("∛54", "expression")!, expected)).toBe(true);
    expect(answersEqual(parseAnswer("3∛2", "expression")!, expected, {
      requireSimplifiedRadical: true,
    })).toBe(true);
    expect(answersEqual(parseAnswer("∛54", "expression")!, expected, {
      requireSimplifiedRadical: true,
    })).toBe(false);
    expect(answersEqual(parseAnswer("3√2", "expression")!, expected)).toBe(false);
    expect(answersEqual(parseAnswer("∛-8", "expression")!, parseAnswer("-2", "expression")!)).toBe(true);
  });

  test("grades bracketed integer indices by value and enforces index-free canonical radicands", () => {
    const expected = parseAnswer("2√[4]2", "expression")!;
    expect(answersEqual(parseAnswer("√[4]32", "expression")!, expected)).toBe(true);
    expect(answersEqual(expected, expected, { requireSimplifiedRadical: true })).toBe(true);
    expect(
      answersEqual(parseAnswer("√[4]32", "expression")!, expected, {
        requireSimplifiedRadical: true,
      }),
    ).toBe(false);
    expect(answersEqual(parseAnswer("√[5]-32", "expression")!, parseAnswer("-2", "expression")!)).toBe(
      true,
    );
    expect(answersEqual(parseAnswer("√[4]-16", "expression")!, parseAnswer("2", "expression")!)).toBe(
      false,
    );
    expect(answersEqual(parseAnswer("√[1]9", "expression")!, parseAnswer("9", "expression")!)).toBe(
      false,
    );
  });

  test("keeps legacy plain-text expression parsing intact", () => {
    expect(
      answersEqual(parseAnswer("7 R 2", "expression")!, parseAnswer("7r2", "expression")!),
    ).toBe(true);
  });
});
