import { describe, expect, it } from "vitest";

import {
  answerFormHint,
  FORM_NUDGE_FALLBACK,
  formNudgeOf,
  nextFormNudgesUsed,
  usesAlgebraEditor,
} from "./practiceAnswerForm";

describe("answerFormHint", () => {
  it.each([
    "lowestTerms",
    "decimalNotation",
    "simplifiedRadical",
    "factored",
    "expanded",
    "complexStandard",
    "rationalizedDenominator",
    "singleLog",
    "expandedLog",
    "singleFraction",
    "positiveExponents",
    "radicalForm",
    "exponentForm",
  ])("has a short sentence for %s", (form) => {
    const hint = answerFormHint(form);
    expect(hint).toBeTruthy();
    expect(hint!.length).toBeLessThan(60);
    expect(hint).toMatch(/^[A-Z].*\.$/);
  });

  it("says nothing for no form or an unknown one", () => {
    expect(answerFormHint(undefined)).toBeNull();
    expect(answerFormHint("")).toBeNull();
    expect(answerFormHint("cursive")).toBeNull();
  });
});

describe("formNudgeOf", () => {
  it("reads the form-nudge outcome", () => {
    expect(
      formNudgeOf({ correct: false, formNudge: { form: "factored", message: "That's equal. Now factor it." } }),
    ).toBe("That's equal. Now factor it.");
    expect(formNudgeOf({ correct: false, formNudge: { form: "factored" } })).toBe(FORM_NUDGE_FALLBACK);
    // The mapping mutation returns outcome: null beside the nudge.
    expect(formNudgeOf({ outcome: null, formNudge: { form: "expanded", message: "Expand it." } })).toBe("Expand it.");
  });

  it("is null for an ordinary verdict", () => {
    expect(formNudgeOf({ correct: true })).toBeNull();
    expect(formNudgeOf({ correct: false, formOutcome: "notLowestTerms" })).toBeNull();
    expect(formNudgeOf(null)).toBeNull();
    expect(formNudgeOf("formNudge")).toBeNull();
    expect(formNudgeOf({ correct: false, formNudge: null })).toBeNull();
  });

  it("counts nudges per item", () => {
    expect(nextFormNudgesUsed(0, { correct: false, formNudge: { form: "factored", message: "m" } })).toBe(1);
    expect(nextFormNudgesUsed(1, { correct: false })).toBe(1);
  });
});

describe("usesAlgebraEditor", () => {
  it("is on for a palette or a solution set, off otherwise", () => {
    expect(usesAlgebraEditor({ answerType: "expression", answerPalette: "logs" })).toBe(true);
    expect(usesAlgebraEditor({ answerType: "solutionSet" })).toBe(true);
    expect(usesAlgebraEditor({ answerType: "expression" })).toBe(false);
    expect(usesAlgebraEditor({ answerType: "expression", answerPalette: "weird" })).toBe(false);
  });
});
