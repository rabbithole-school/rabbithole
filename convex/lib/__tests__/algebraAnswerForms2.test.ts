/**
 * Second grader pass (Algebra 2): tightened forms — `factored` is FULLY
 * factored over the integers, `simplifiedRadical` combines like radicals and
 * leaves nothing to multiply out, `complexStandard` wants a and b each one
 * reduced real number — the implicit "write it as a fraction" nudge for a
 * decimal on a fraction item, and loosened notation: thousands separators, named left sides ("a_n =", "f(x) =")
 * (excluded-value members like "x ≠ 3" were removed again in the review pass).
 */

import { describe, expect, test } from "vitest";
import {
  answersEqual,
  decimalAsFraction,
  FORM_NUDGE_CAP,
  formatAnswer,
  meetsRequiredForm,
  parseAnswer,
  satisfiesAnswerForm,
  teachingBlankCorrect,
  type AnswerForm,
} from "../practice/answers";
import {
  buildTemplateServable,
  gradeSubmission,
  PLACEMENT_POLICY,
  PRACTICE_POLICY,
} from "../practice/servable";
import { gradeTemplateItem, makeItemId } from "../practice/session";
import { generateItem } from "../practice/templates";

const meets = (raw: string, form: AnswerForm) => satisfiesAnswerForm(raw, form);
const expr = (a: string, b: string) =>
  answersEqual(parseAnswer(a, "expression")!, parseAnswer(b, "expression")!);
const set = (a: string, b: string) => {
  const pa = parseAnswer(a, "solutionSet");
  const pb = parseAnswer(b, "solutionSet");
  return pa !== null && pb !== null && answersEqual(pa, pb);
};

describe("factored means fully factored over the integers", () => {
  test.each([
    "(x+1)(x-3)(x+3)",
    "(x-3)^2(x+3)^2",
    "(x-3)(x-3)(x+3)(x+3)",
    "2(x-5)(x^2+5x+25)",
    "(x-5)(x^2+5x+25)",
    "(x+3)(x-2)",
    "-(x-1)(x+1)",
    "2(x-1)^2",
    "x(x+4)",
    "x^2(x-1)",
    "(x^2+1)(x-1)",
    "(x^2+x+1)(x^2-x+1)",
    "(2x+1)(x-3)",
    "3(x^2+2)",
    "(x+y)(x-y)",
    "(x^2-y^2)(x+1)", // two variables: still permissive
  ])("accepts %s", (raw) => expect(meets(raw, "factored")).toBe(true));

  test.each([
    "(x+1)(x^2-9)",
    "(x^2-9)^2",
    "(2x-10)(x^2+5x+25)",
    "x(x^2-4)",
    "(x^4-1)(x+2)",
    "(x^4+4)(x-1)", // (x²+2x+2)(x²−2x+2): no rational root, but splits
    "(x^2-2x+1)(x+1)",
    "(x^3-8)(x+1)",
    "(2x+4)(x-1)",
    "x^2+x-6",
  ])("rejects %s", (raw) => expect(meets(raw, "factored")).toBe(false));

  test("a partly factored answer is equal but unfinished (the nudge case)", () => {
    expect(expr("(x+1)(x^2-9)", "(x+1)(x-3)(x+3)")).toBe(true);
    expect(meetsRequiredForm("(x+1)(x^2-9)", "(x+1)(x-3)(x+3)", "factored")).toBe(false);
  });
});

describe("simplifiedRadical: like radicals combined, nothing left to multiply out", () => {
  test.each(["7√2", "9+7√2", "2√3+√5", "-2√2", "2i√6", "3√7", "(1+√5)/2", "2(1+√5)", "2∛3"])(
    "accepts %s",
    (raw) => expect(meets(raw, "simplifiedRadical")).toBe(true),
  );
  test.each(["5√2+2√2", "(3+√5)(2-√5)", "3√2-5√2", "(1+√2)^2", "√2(1+√3)", "3+4+√2"])(
    "rejects %s",
    (raw) => expect(meets(raw, "simplifiedRadical")).toBe(false),
  );
});

describe("complexStandard: a and b each a single reduced real number", () => {
  test.each([
    "3+2i",
    "2i+3",
    "-i",
    "5",
    "3-i/2",
    "3-(1/2)i",
    "-3/2+(3/2)i",
    "14/5+(8/5)i",
    "2+i√3",
    "-1/2-(√3/2)i",
    "-3i√5",
    "3-0.5i",
  ])("accepts %s", (raw) => expect(meets(raw, "complexStandard")).toBe(true));
  test.each(["6i/2", "2(5i)/2", "4+6i/2", "8/2+3i", "4/2+6i/2", "2·3+i", "3+2i+1"])(
    "rejects %s",
    (raw) => expect(meets(raw, "complexStandard")).toBe(false),
  );
});

describe("expanded rejects uncombined like terms and parenthesised sums", () => {
  test.each(["x^2+2x+3x+6", "(x+2)(x+3)", "x(x+5)+6", "2(x+1)+x"])("rejects %s", (raw) =>
    expect(meets(raw, "expanded")).toBe(false),
  );
  test.each(["x^2+5x+6", "6+5x+x^2"])("accepts %s", (raw) =>
    expect(meets(raw, "expanded")).toBe(true),
  );
});

describe("a fraction item answered with an equal decimal gets the fraction nudge", () => {
  test("decimalAsFraction reads a terminating decimal exactly", () => {
    expect(decimalAsFraction("0.25")).toEqual({ type: "fraction", num: 1, den: 4 });
    expect(decimalAsFraction("-2.5")).toEqual({ type: "fraction", num: -5, den: 2 });
    expect(decimalAsFraction(".5")).toEqual({ type: "fraction", num: 1, den: 2 });
    expect(decimalAsFraction("3/4")).toBeNull();
    expect(parseAnswer("0.25", "fraction")).toBeNull(); // still not a fraction
  });

  /** Fraction-typed draws whose value is a short terminating decimal. */
  function decimalDraws(skillKey: string) {
    const out: { itemId: string; decimal: string; answer: string }[] = [];
    for (let seed = 1; seed <= 60; seed++) {
      const gen = generateItem(skillKey, seed)!;
      if (gen.answer.type !== "fraction" || gen.answer.den === 1) continue;
      const decimal = String(gen.answer.num / gen.answer.den);
      if (!/^-?\d*\.\d{1,6}$/.test(decimal)) continue;
      out.push({ itemId: makeItemId(skillKey, seed), decimal, answer: formatAnswer(gen.answer) });
    }
    expect(out.length, skillKey).toBeGreaterThan(0);
    return out;
  }

  test.each(["multiply_fractions", "simplify_fractions"])(
    "%s: nudge with no served form hint, then today's plain miss after the cap",
    (skillKey) => {
      for (const { itemId, decimal, answer } of decimalDraws(skillKey)) {
        const servable = buildTemplateServable(itemId, null, "test")!;
        if (skillKey === "multiply_fractions") expect(servable.prompt.answerForm).toBeUndefined();
        const nudged = gradeSubmission(servable, { kind: "typed", raw: decimal }, PRACTICE_POLICY, {
          formNudgesUsed: 0,
        });
        expect(nudged.formNudge).toEqual({
          form: "fraction",
          message: "That's the right value. Now write it as a fraction.",
        });
        expect(nudged.shouldRecordMastery).toBe(false);
        const spent = gradeSubmission(servable, { kind: "typed", raw: decimal }, PRACTICE_POLICY, {
          formNudgesUsed: FORM_NUDGE_CAP,
        });
        expect(spent.correct).toBe(false);
        expect(spent.formOutcome).toBeUndefined();
        // Placement after the cap: a miss too (never a credit from a count).
        expect(
          gradeSubmission(servable, { kind: "typed", raw: decimal }, PLACEMENT_POLICY, {
            formNudgesUsed: FORM_NUDGE_CAP,
          }).correct,
        ).toBe(false);
        // No count (installed builds, any pre-nudge caller): exactly today's
        // plain miss on the drill AND on placement — no nudge, no credit.
        for (const policy of [PRACTICE_POLICY, PLACEMENT_POLICY]) {
          const old = gradeSubmission(servable, { kind: "typed", raw: decimal }, policy);
          expect(old.correct).toBe(false);
          expect(old.formNudge).toBeUndefined();
          expect(old.formOutcome).toBeUndefined();
        }
        // The oracle and the teaching blank are unchanged: a decimal is not correct.
        expect(gradeTemplateItem(itemId, decimal)?.correct).toBe(false);
        expect(teachingBlankCorrect(decimal, answer, "fraction")).toBe(false);
      }
    },
  );

  test("a wrong decimal is a plain miss, and a lowestTerms dodge keeps its notLowestTerms outcome", () => {
    const [{ itemId }] = decimalDraws("multiply_fractions");
    const servable = buildTemplateServable(itemId, null, "test")!;
    const wrong = gradeSubmission(servable, { kind: "typed", raw: "0.123" }, PRACTICE_POLICY, {
      formNudgesUsed: 0,
    });
    expect(wrong.formNudge).toBeUndefined();
    expect(wrong.correct).toBe(false);
    for (let seed = 1; seed <= 10; seed++) {
      const gen = generateItem("simplify_fractions", seed)!;
      const dodge = gen.stem.match(/Simplify (\d+\/\d+)/)![1];
      const s = buildTemplateServable(makeItemId("simplify_fractions", seed), null, "test")!;
      const g = gradeSubmission(s, { kind: "typed", raw: dodge }, PRACTICE_POLICY, { formNudgesUsed: 0 });
      expect(g.formOutcome).toBe("notLowestTerms");
      expect(g.formNudge).toBeUndefined();
    }
  });
});

describe("notation the grader now reads", () => {
  test.each([
    ["a_n = 3n+2", "3n+2"],
    ["a_n=3n+2", "3n+2"],
    ["a_(n) = 3n+2", "3n+2"],
    ["a_{n} = 3n+2", "3n+2"],
    ["S_n = n^2", "n^2"],
    ["f(x) = 2x+1", "2x+1"],
    ["y = 2x+1", "2x+1"],
    ["f^-1(x) = (x-1)/2", "(x-1)/2"],
    ["f⁻¹(x) = (x-1)/2", "(x-1)/2"],
  ])("a named left side is stripped: %s", (raw, rhs) => expect(expr(raw, rhs)).toBe(true));

  test("an equation with a math left side is never reduced to its right side", () => {
    expect(expr("2x+1 = 5", "5")).toBe(false);
  });

  // Review fix #5: an excluded value is NOT stripped to an inclusion — "x ≠ 3"
  // on a solve item whose answer is 3 must not be graded correct.
  test.each([
    ["x≠3", "3"],
    ["x != 3", "3"],
    ["x≠3, x≠-3", "3, -3"],
    ["x ≠ 3 and x ≠ -3", "3, -3"],
  ])("solution-set members: %s is NOT %s", (a, b) => expect(set(a, b)).toBe(false));

  test.each([
    ["f(x) = 2, f(x) = 3", "2, 3"],
    ["a_1 = 4", "4"],
  ])("solution-set members: %s ≡ %s", (a, b) => expect(set(a, b)).toBe(true));

  test.each([
    ["1,395", 1395],
    ["12,000", 12000],
    ["-1,000,000", -1000000],
  ] as const)("thousands separator: %s", (raw, value) => {
    expect(parseAnswer(raw, "integer")).toEqual({ type: "integer", value });
  });

  test.each(["1,39", "13,95", "0,330", "1,0000"])(
    "misgrouped or decimal comma stays unparseable: %s",
    (raw) => {
      expect(parseAnswer(raw, "integer")).toBeNull();
      expect(parseAnswer(raw, "decimal")).toBeNull();
    },
  );

  test("in a solution set a comma still separates members", () => {
    expect(set("1,395", "1, 395")).toBe(true);
  });
});
