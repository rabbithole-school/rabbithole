/**
 * The Algebra 2 answer model: the extended expression grammar (complex numbers,
 * e and π, logs, |…|, roots, rational exponents, single-letter variables), the
 * `solutionSet` answer type, the algebraic `answerForm` checkers, and the
 * "right value, not yet in the form asked" nudge outcome with its cap.
 *
 * The bias throughout is against FALSE NEGATIVES: a correct answer marked
 * wrong is the failure that costs most, so most cases here are equalities the
 * grader must accept.
 */

import { describe, expect, test } from "vitest";
import {
  answersEqual,
  exprAns,
  FORM_NUDGE_CAP,
  formatAnswer,
  formatAnswerForDisplay,
  formNudgeMessage,
  isNudgeForm,
  meetsRequiredForm,
  parseAnswer,
  satisfiesAnswerForm,
  solutionSetAns,
  teachingBlankCorrect,
  type AnswerForm,
  type NudgeAnswerForm,
} from "../practice/answers";
import {
  buildTemplateServable,
  gradeSubmission,
  GRADE_ONLY_POLICY,
  PLACEMENT_POLICY,
  PRACTICE_POLICY,
  REHEARSE_POLICY,
  STORY_THREAD_POLICY,
  type ServableItem,
} from "../practice/servable";
import { gradeTemplateItem, makeItemId, templateInputHints } from "../practice/session";
import { servedItemFromServable } from "../practice/serve";
import { generateItem } from "../practice/templates";

const expr = (a: string, b: string) =>
  answersEqual(parseAnswer(a, "expression")!, parseAnswer(b, "expression")!);
const set = (a: string, b: string) => {
  const pa = parseAnswer(a, "solutionSet");
  const pb = parseAnswer(b, "solutionSet");
  return pa !== null && pb !== null && answersEqual(pa, pb);
};

describe("expression equivalence — must be EQUAL", () => {
  test.each([
    // the brief's named cases
    ["(x+3)(x-2)", "(x-2)(x+3)"],
    ["x^(1/2)", "√x"],
    ["1/√2", "√2/2"],
    ["log_2(8)", "3"],
    ["2 log(x)", "log(x^2)"],
    ["i^2", "-1"],
    ["(1+i)/(1-i)", "i"],
    ["e^(ln 5)", "5"],
    // polynomials and factoring
    ["x^2+5x+6", "(x+2)(x+3)"],
    ["(x-1)^2", "x^2-2x+1"],
    ["-x^2+1", "1-x^2"],
    ["-(x-1)(x+1)", "1-x^2"],
    ["2(x-1)^2", "2x^2-4x+2"],
    ["x(x+4)", "x^2+4x"],
    ["(x+y)^2", "x^2+2xy+y^2"],
    ["xy", "yx"],
    ["3xy^2", "3*y*y*x"],
    ["(a+b)(a-b)", "a^2-b^2"],
    ["x^3-8", "(x-2)(x^2+2x+4)"],
    // rational expressions
    ["(x^2-1)/(x-1)", "x+1"],
    ["1/x+1/y", "(x+y)/(xy)"],
    ["(x+1)/(x^2-1)", "1/(x-1)"],
    ["x/2+x/3", "5x/6"],
    ["1/2x", "x/2"],
    // exponents
    ["x^-1", "1/x"],
    ["2^-1", "1/2"],
    ["x^2*x^3", "x^5"],
    ["(x^2)^3", "x^6"],
    ["x^(2/3)", "∛(x^2)"],
    ["8^(2/3)", "4"],
    ["(-8)^(1/3)", "-2"],
    ["∛x", "x^(1/3)"],
    ["27^(-1/3)", "1/3"],
    ["x^0", "1"],
    // radicals
    ["√18", "3√2"],
    ["sqrt(18)", "3√2"],
    ["√8+√2", "3√2"],
    ["√(x^3)", "x√x"],
    ["√12/√3", "2"],
    ["2/√2", "√2"],
    ["√[4]16", "2"],
    ["∜16", "2"],
    ["∛-8", "-2"],
    // complex numbers
    ["(2+3i)+(1-i)", "3+2i"],
    ["(2+3i)(2-3i)", "13"],
    ["i^3", "-i"],
    ["i^4", "1"],
    ["√-4", "2i"],
    ["√(-9)", "3i"],
    ["1/i", "-i"],
    ["(1+i)^2", "2i"],
    ["2i+3", "3+2i"],
    ["3-i/2", "3-(1/2)i"],
    ["3-i/2", "3-0.5i"],
    ["(x+i)(x-i)", "x^2+1"],
    // logs and e
    ["log(100)", "2"],
    ["log 100", "2"],
    ["ln(e^2)", "2"],
    ["ln e", "1"],
    ["log_2 8", "3"],
    ["log₂8", "3"],
    ["log_3(81)", "4"],
    ["log_b(b^2)", "2"],
    ["log(x)+log(y)", "log(xy)"],
    ["log(x)-log(y)", "log(x/y)"],
    ["3ln(x)", "ln(x^3)"],
    ["log_2(x)", "ln(x)/ln(2)"],
    ["e^(2ln(x))", "x^2"],
    ["2^(log_2(7))", "7"],
    // absolute value
    ["|x-1|", "|1-x|"],
    ["abs(x-1)", "|1-x|"],
    ["|-3|", "3"],
    ["2|x|", "|2x|"],
    ["||x|-1|", "abs(abs(x)-1)"],
    // constants and Unicode
    ["π", "pi"],
    ["2π", "pi+pi"],
    ["x²", "x^2"],
    ["x⁻¹", "1/x"],
    ["3·2", "6"],
    ["6÷3", "2"],
    ["2x−1", "2x-1"],
    ["2×x", "2x"],
    // legacy strings keep working
    ["2 1/2", "5/2"],
    ["7 R 2", "7r2"],
    ["1/(x^2)", "1/((x)^2)"],
    ["2(x+1)", "2*x+2"],
    ["3∛2", "∛54"],
  ])("%s ≡ %s", (a, b) => {
    expect(expr(a, b)).toBe(true);
    expect(expr(b, a)).toBe(true);
  });
});

describe("expression equivalence — must NOT be equal", () => {
  test.each([
    ["-x^2+1", "x^2+1"],
    ["-3^2", "9"],
    ["(x+3)(x-2)", "(x+2)(x-3)"],
    ["x^2+5x+6", "(x+1)(x+6)"],
    ["|x|", "x"],
    ["2i", "-2i"],
    ["3+2i", "2+3i"],
    ["i^2", "1"],
    ["log(x)+log(y)", "log(x+y)"],
    ["log_2(8)", "4"],
    ["√2", "2"],
    ["1/x", "x"],
    ["x^(1/2)", "x^2"],
    ["e", "2.718"],
    ["(x+1)^2", "x^2+1"],
    ["√[4]-16", "2"],
    ["√[1]9", "9"],
    ["7 R 2", "7+2"],
    ["2√7", "3√7"],
    ["x", "y"],
  ])("%s ≢ %s", (a, b) => {
    expect(expr(a, b)).toBe(false);
    expect(expr(b, a)).toBe(false);
  });

  test("expression-vs-number keeps its strict grammar (no Unicode minus there)", () => {
    expect(answersEqual(parseAnswer("−7", "expression")!, { type: "integer", value: -7 })).toBe(
      false,
    );
  });
});

describe("solutionSet answers", () => {
  test.each([
    ["2, -3", "-3, 2"],
    ["2, -3", "x = -3 or x = 2"],
    ["2, -3", "x=2; x=-3"],
    ["2, -3", "{2, -3}"],
    ["2, -3", "2 and -3"],
    ["±2", "2, -2"],
    ["x = ±√2", "√2, -√2"],
    ["1±2i", "1-2i, 1+2i"],
    ["1+/-2i", "1+2i, 1-2i"],
    ["(2±√8)/2", "1+√2, 1-√2"],
    ["none", "no solution"],
    ["none", "∅"],
    ["none", "No Solutions"],
    ["3, 3", "3"],
    ["2, 4/2", "2"],
    ["x = 1/2, x = 3", "0.5, 3"],
    ["x₁ = 1, x₂ = 2", "2, 1"],
  ])("%s ≡ %s", (a, b) => {
    expect(set(a, b)).toBe(true);
    expect(set(b, a)).toBe(true);
  });

  test.each([
    ["2, -3", "2"],
    ["2, -3", "2, 3"],
    ["2", "none"],
    ["1+2i", "1+2i, 1-2i"],
    ["2, -3", "2, -3, 0"],
  ])("%s ≢ %s", (a, b) => {
    expect(set(a, b)).toBe(false);
    expect(set(b, a)).toBe(false);
  });

  test("blank input is unparseable; the wire form round-trips", () => {
    expect(parseAnswer("   ", "solutionSet")).toBeNull();
    const a = solutionSetAns([2, "-3", 2]);
    expect(a).toEqual({ type: "solutionSet", members: ["2", "-3"] });
    expect(formatAnswer(a)).toBe("2, -3");
    expect(answersEqual(parseAnswer(formatAnswer(a), "solutionSet")!, a)).toBe(true);
    const none = solutionSetAns([]);
    expect(formatAnswer(none)).toBe("none");
    expect(formatAnswerForDisplay(none)).toBe("No solution");
    expect(answersEqual(parseAnswer(formatAnswer(none), "solutionSet")!, none)).toBe(true);
  });

  test("a lone stored value matches a one-member set", () => {
    expect(answersEqual(parseAnswer("x = 3", "solutionSet")!, { type: "integer", value: 3 })).toBe(
      true,
    );
    expect(answersEqual(parseAnswer("3, 4", "solutionSet")!, exprAns("3"))).toBe(false);
  });
});

const meets = (raw: string, form: AnswerForm, type?: "solutionSet") =>
  satisfiesAnswerForm(raw, form, type);

describe("form checkers", () => {
  // `fraction` is the implicit form of fraction-typed items; it has its own tests.
  const cases: Record<Exclude<NudgeAnswerForm, "fraction">, { accept: string[]; reject: string[] }> = {
    factored: {
      accept: ["(x-2)(x+3)", "(x+3)(x-2)", "2(x-1)^2", "-(x-1)(x+1)", "x(x+4)", "(x+1)/(x-2)", "3x", "(x-i)(x+i)"],
      reject: ["x^2+x-6", "1(x^2+5x+6)", "-(x^2-1)", "x(x+1)+2"],
    },
    expanded: {
      accept: ["x^2+x-6", "-6+x+x^2", "3x^2-2x", "x+√2+1", "2xy-y^2", "x^2"],
      reject: ["(x+1)^2", "x^2+2x+x", "x(x+1)", "x+2+3", "(2x)^2", "2√2+3√2"],
    },
    complexStandard: {
      accept: ["3+2i", "2i+3", "-i", "5", "3-i/2", "3-(1/2)i", "i", "-2-√3i"],
      reject: ["i^2+3", "1/i", "(1+i)(1-i)", "√-4", "3+2i+1", "2i·i", "3/(2i)"],
    },
    rationalizedDenominator: {
      accept: ["√2/2", "(3+√5)/4", "x√x/x", "5"],
      reject: ["1/√2", "3/(1+√5)", "x^(-1/2)", "2/∛4"],
    },
    singleLog: {
      accept: ["log(x^2/y)", "ln(x^3)", "log_3(9x)"],
      reject: ["2log(x)", "log(x)+log(y)", "-log(x)", "log(x)-1"],
    },
    expandedLog: {
      accept: ["2log(x)-log(y)", "log(x)+log(y)", "3ln(x)", "log(8)", "5", "ln(e)"],
      // A sum inside is not expanded either (review fix #10).
      reject: ["log(x^2)", "log(xy)", "log(x/y)", "ln(√x)", "log(x+1)", "log(xy+0)"],
    },
    singleFraction: {
      accept: ["(x+1)/(x-2)", "x^2+1", "-(x+1)/(x-2)", "2x/(x+1)", "5/6", "(3x+2)/6"],
      // A sum of fractions is not one fraction, numeric or symbolic (review fix #11).
      reject: ["1/x+1", "1/x+1/y", "(x^2-1)/(x-1)", "(2x+4)/(2x+6)", "(1/x)/(x+1)", "6/4", "x/2+1/3", "1/2+1/3"],
    },
    positiveExponents: {
      accept: ["1/x^2", "x^2y", "x^(1/2)"],
      reject: ["x^-2", "x^(-1/2)", "2^(-x)"],
    },
    simplifiedRadical: {
      accept: ["3√7", "√7·3", "3*√7", "2√[4]2", "x√x", "3∛2", "(1+√5)/2", "√2/2", "5"],
      reject: ["√63", "∛54", "1/√2", "√2√3", "√(x^3)", "7^(1/2)", "√(1/2)", "√-4", "√4"],
    },
    radicalForm: {
      accept: ["√x", "∛(x^2)", "x^2"],
      reject: ["x^(1/2)", "x^(2/3)", "8^0.5"],
    },
    exponentForm: {
      accept: ["x^(1/2)", "x^(2/3)", "x^2"],
      reject: ["√x", "∛(x^2)", "sqrt(x)"],
    },
  };

  for (const [form, { accept, reject }] of Object.entries(cases) as [
    NudgeAnswerForm,
    { accept: string[]; reject: string[] },
  ][]) {
    test.each(accept)(`${form} accepts %s`, (raw) => expect(meets(raw, form)).toBe(true));
    test.each(reject)(`${form} rejects %s`, (raw) => expect(meets(raw, form)).toBe(false));
  }

  test("a leading assignment is ignored, and unparseable text is never rejected on form", () => {
    expect(meets("y = (x-2)(x+3)", "factored")).toBe(true);
    expect(meets("not math at all", "factored")).toBe(true);
  });

  test("solution-set members are each checked for the form", () => {
    expect(meets("1±2i", "complexStandard", "solutionSet")).toBe(true);
    expect(meets("x = 1+2i or x = 1-2i", "complexStandard", "solutionSet")).toBe(true);
    expect(meets("1+2i, (1-i)/(1+i)", "complexStandard", "solutionSet")).toBe(false);
    expect(meets("(2±√8)/2", "simplifiedRadical", "solutionSet")).toBe(false);
    expect(meets("1±√2", "simplifiedRadical", "solutionSet")).toBe(true);
    expect(meets("none", "simplifiedRadical", "solutionSet")).toBe(true);
  });

  test("a form the answer key itself fails is not enforced", () => {
    // "x+3" is a bare sum, so it can't be "factored" — the item can't hold a
    // scholar to a form its own canonical answer misses.
    expect(meetsRequiredForm("3+x", "x+3", "factored")).toBe(true);
    expect(meetsRequiredForm("x^2+5x+6", "(x+2)(x+3)", "factored")).toBe(false);
    // Legacy forms keep their exact rule.
    expect(meetsRequiredForm("12/15", "4/5", "lowestTerms")).toBe(false);
  });

  test("every algebraic form has a nudge sentence; the legacy forms have none", () => {
    for (const form of Object.keys(cases) as NudgeAnswerForm[]) {
      expect(isNudgeForm(form)).toBe(true);
      expect(formNudgeMessage(form)).toMatch(/^That's equal to the answer\. Now /);
    }
    expect(isNudgeForm("lowestTerms")).toBe(false);
    expect(isNudgeForm("decimalNotation")).toBe(false);
  });

  test("the teaching blank applies algebraic forms with the same safeguard", () => {
    expect(teachingBlankCorrect("x^2+5x+6", "(x+2)(x+3)", "expression", "factored")).toBe(false);
    expect(teachingBlankCorrect("(x+3)(x+2)", "(x+2)(x+3)", "expression", "factored")).toBe(true);
  });
});

// ── The nudge outcome, through the real dispatcher ─────────────────────────

/** A simplifying-radicals template item and its unsimplified value-equal dodge. */
function radicalItem(seed = 7): { item: ServableItem; dodge: string; right: string } {
  const itemId = makeItemId("roots_simplify_radicals", seed);
  const item = buildTemplateServable(itemId, null, "test")!;
  const match = item.prompt.stem.match(/Simplify (\S+)\./)!;
  const gen = generateItem("roots_simplify_radicals", seed)!;
  return { item, dodge: match[1], right: formatAnswer(gen.answer) };
}

describe("the form nudge (right value, not yet in the form asked)", () => {
  test("the simplifying-radicals template requests simplifiedRadical through answerForm", () => {
    const { item } = radicalItem();
    expect(item.prompt.answerForm).toBe("simplifiedRadical");
    expect(item.verifier.kind === "template" && item.verifier.requiredForm).toBe(
      "simplifiedRadical",
    );
  });

  test("an unsimplified radical nudges: no credit, nothing recorded, a sentence to show", () => {
    const { item, dodge } = radicalItem();
    const grade = gradeSubmission(item, { kind: "typed", raw: dodge }, PRACTICE_POLICY, {
      formNudgesUsed: 0,
    });
    expect(grade.correct).toBe(false);
    expect(grade.formNudge).toEqual({
      form: "simplifiedRadical",
      message: formNudgeMessage("simplifiedRadical"),
    });
    expect(grade.shouldRecordMastery).toBe(false);
    expect(grade.shouldRecordPracticeAttempt).toBe(false);
    expect(grade.shouldRecordLatency).toBe(false);
    expect(grade.shouldClassifyError).toBe(false);
    expect(grade.revealedAnswer).toBeUndefined();
    expect(grade.formOutcome).toBeUndefined();
  });

  test("the cap: two nudges, then the drill grades the form miss as incorrect", () => {
    const { item, dodge } = radicalItem();
    for (let used = 0; used < FORM_NUDGE_CAP; used++) {
      expect(
        gradeSubmission(item, { kind: "typed", raw: dodge }, PRACTICE_POLICY, {
          formNudgesUsed: used,
        }).formNudge,
      ).toBeDefined();
    }
    const graded = gradeSubmission(item, { kind: "typed", raw: dodge }, PRACTICE_POLICY, {
      formNudgesUsed: FORM_NUDGE_CAP,
    });
    expect(graded.formNudge).toBeUndefined();
    expect(graded.correct).toBe(false);
    expect(graded.formOutcome).toBeUndefined();
    expect(graded.shouldRecordMastery).toBe(true);
  });

  // The three states of the nudge count, on the drill and on placement.
  //   absent → legacy (exactly as before nudges: a plain miss, everywhere)
  //   < cap  → nudge
  //   ≥ cap  → graded normally: a miss on EVERY policy (review fix #1 — on
  //            "Simplify √18" the form is the skill, so placement must not
  //            credit an unsimplified answer)
  test.each([
    ["drill", PRACTICE_POLICY],
    ["placement", PLACEMENT_POLICY],
    ["grade-only (the re-probe batch)", GRADE_ONLY_POLICY],
  ] as const)("count states on %s", (_label, policy) => {
    const { item, dodge } = radicalItem();
    const raw = { kind: "typed", raw: dodge } as const;

    const legacy = gradeSubmission(item, raw, policy);
    expect(legacy.formNudge).toBeUndefined();
    expect(legacy.correct).toBe(false);
    expect(legacy.formOutcome).toBeUndefined();
    expect(legacy.shouldRecordMastery).toBe(policy.recordMastery);

    for (let used = 0; used < FORM_NUDGE_CAP; used++) {
      const nudged = gradeSubmission(item, raw, policy, { formNudgesUsed: used });
      expect(nudged.formNudge?.form).toBe("simplifiedRadical");
      expect(nudged.correct).toBe(false);
      expect(nudged.shouldRecordMastery).toBe(false);
    }

    const spent = gradeSubmission(item, raw, policy, { formNudgesUsed: FORM_NUDGE_CAP });
    expect(spent.formNudge).toBeUndefined();
    expect(spent.correct).toBe(false);
    expect(spent.formOutcome).toBeUndefined();
  });

  test("a client-carried count can never turn a miss into a credit, on any policy", () => {
    const { item, dodge, right } = radicalItem();
    const policies = [
      PRACTICE_POLICY,
      PLACEMENT_POLICY,
      GRADE_ONLY_POLICY,
      STORY_THREAD_POLICY,
      REHEARSE_POLICY,
    ];
    const submissions = [dodge, right, "99√2", "√2·√9", "3√2+0", dodge + "*1"];
    const counts = [undefined, 0, 1, 2, 3, 50, -1, 1e9];
    for (const policy of policies) {
      for (const raw of submissions) {
        const verdicts = counts.map((c) =>
          gradeSubmission(item, { kind: "typed", raw }, policy, c === undefined ? {} : { formNudgesUsed: c }),
        );
        // correctness never depends on the count: only nudge vs. graded does
        const correct = new Set(verdicts.map((v) => v.correct));
        expect(correct.size, policy.surface + " " + raw).toBe(1);
        for (const v of verdicts) if (v.formNudge) expect(v.correct).toBe(false);
      }
    }
  });

  test("a garbage nudge count can't do worse than grade sooner", () => {
    const { item, dodge } = radicalItem();
    const negative = gradeSubmission(item, { kind: "typed", raw: dodge }, PRACTICE_POLICY, {
      formNudgesUsed: -5,
    });
    expect(negative.formNudge).toBeDefined();
    const huge = gradeSubmission(item, { kind: "typed", raw: dodge }, PRACTICE_POLICY, {
      formNudgesUsed: 1e9,
    });
    expect(huge.formNudge).toBeUndefined();
    expect(huge.correct).toBe(false);
  });

  test("placement after the cap: a miss, and the reveal shows the asked-for form", () => {
    const { item, dodge, right } = radicalItem();
    expect(
      gradeSubmission(item, { kind: "typed", raw: dodge }, PLACEMENT_POLICY, { formNudgesUsed: 0 })
        .formNudge,
    ).toBeDefined();
    const capped = gradeSubmission(item, { kind: "typed", raw: dodge }, PLACEMENT_POLICY, {
      formNudgesUsed: FORM_NUDGE_CAP,
    });
    expect(capped.correct).toBe(false);
    expect(capped.revealedAnswer).toBe(right);
  });

  test("the right form is simply correct, a wrong value is a plain miss, a dontKnow never nudges", () => {
    const { item, right } = radicalItem();
    const ok = gradeSubmission(item, { kind: "typed", raw: right }, PRACTICE_POLICY);
    expect(ok.correct).toBe(true);
    expect(ok.formNudge).toBeUndefined();
    const wrong = gradeSubmission(item, { kind: "typed", raw: "99√2" }, PRACTICE_POLICY);
    expect(wrong.correct).toBe(false);
    expect(wrong.formNudge).toBeUndefined();
    expect(wrong.formOutcome).toBeUndefined();
    const dontKnow = gradeSubmission(item, { kind: "dontKnow" }, PRACTICE_POLICY, {
      formNudgesUsed: 0,
    });
    expect(dontKnow.formNudge).toBeUndefined();
  });

  test("a policy-forced credit retires the nudge", () => {
    const { item, dodge } = radicalItem();
    const credited = gradeSubmission(
      item,
      { kind: "typed", raw: dodge },
      { ...GRADE_ONLY_POLICY, finalCredit: true },
    );
    expect(credited.correct).toBe(true);
    expect(credited.formNudge).toBeUndefined();
  });

  test("the answer oracle (no scholar to nudge) just says not correct", () => {
    const seed = 7;
    const { dodge, right } = radicalItem(seed);
    const itemId = makeItemId("roots_simplify_radicals", seed);
    expect(gradeTemplateItem(itemId, dodge)?.correct).toBe(false);
    expect(gradeTemplateItem(itemId, right)?.correct).toBe(true);
  });
});

describe("served input hints", () => {
  test("a palette item serves palette + form and never the box-editor signals", () => {
    expect(
      templateInputHints({
        answerType: "expression",
        answer: exprAns("x^2"),
        answerPalette: "algebra",
        answerForm: "expanded",
      }),
    ).toEqual({ answerPalette: "algebra", answerForm: "expanded" });
    // Without a palette, the old 2-D signals are unchanged.
    expect(templateInputHints({ answerType: "expression", answer: exprAns("x^2") })).toEqual({
      answerShape: "twoD",
    });
    expect(
      templateInputHints({ answerType: "solutionSet", answer: solutionSetAns([1, 2]) }),
    ).toEqual({});
  });

  test("servedItemFromServable threads palette + form and drops answerShape for a palette item", () => {
    const { item } = radicalItem();
    expect(servedItemFromServable(item, false)).toMatchObject({
      answerShape: "twoD",
      answerForm: "simplifiedRadical",
    });
    const withPalette: ServableItem = {
      ...item,
      prompt: { ...item.prompt, answerPalette: "complex" },
    } as ServableItem;
    const served = servedItemFromServable(withPalette, false);
    expect(served.answerPalette).toBe("complex");
    expect(served.answerForm).toBe("simplifiedRadical");
    expect(served).not.toHaveProperty("answerShape");
  });
});
