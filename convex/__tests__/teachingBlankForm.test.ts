/**
 * The "show me" teaching step's final blank must not contradict the real
 * grader. Its expected value is the item's own answer, so an item that
 * declares an `answerForm` ("Write 12/15 in simplest form", "Write 82/100 as a
 * decimal") must reject the unconverted value in the step exactly as the
 * grader rejects it on the item. Pure: the step's check
 * (`teachingBlankCorrect`) is compared against `gradeSubmission` itself.
 */
import { describe, expect, test } from "vitest";
import {
  formatAnswer,
  teachingBlankCorrect,
  type AnswerType,
  type TypedAnswer,
} from "../lib/practice/answers";
import { allTemplatedSkillKeys, generateItem } from "../lib/practice/templates";
import { makeItemId } from "../lib/practice/session";
import { buildTemplateServable, gradeSubmission, PRACTICE_POLICY } from "../lib/practice/servable";

const SEEDS = Array.from({ length: 40 }, (_, i) => i + 1);

/** Value-equal answers in other representations — the shortcut each form closes. */
function sameValueOtherForms(a: TypedAnswer): string[] {
  if (a.type === "fraction") return [`${a.num * 2}/${a.den * 2}`, `${a.num * 3}/${a.den * 3}`];
  if (a.type === "decimal") {
    const places = (String(a.value).split(".")[1] ?? "").length;
    const den = 10 ** Math.max(places, 1);
    return [`${Math.round(a.value * den)}/${den}`];
  }
  return [];
}

// Every family that declares a form AND reaches the interactive step.
const FORM_FAMILIES = allTemplatedSkillKeys().filter((key) =>
  SEEDS.some((seed) => {
    const item = generateItem(key, seed);
    return !!item?.answerForm && (item.workedSteps?.length ?? 0) >= 2;
  }),
);

describe("teaching-step blank applies the item's answer form", () => {
  test("the families named in the audit are covered", () => {
    expect(FORM_FAMILIES).toEqual(
      expect.arrayContaining(["probability_as_fraction", "decimal_notation_fractions"]),
    );
  });

  test.each(FORM_FAMILIES)("%s: the step agrees with the real grader", (skillKey) => {
    for (const seed of SEEDS) {
      const gen = generateItem(skillKey, seed);
      if (!gen?.answerForm || (gen.workedSteps?.length ?? 0) < 2) continue;
      const servable = buildTemplateServable(makeItemId(skillKey, seed), null, "test");
      if (!servable) throw new Error(`no servable for ${skillKey}#${seed}`);
      const expected = formatAnswer(gen.answer);
      const type = gen.answer.type as AnswerType;
      for (const raw of [expected, ...sameValueOtherForms(gen.answer)]) {
        const grader = gradeSubmission(servable, { kind: "typed", raw }, PRACTICE_POLICY).correct;
        expect(teachingBlankCorrect(raw, expected, type, gen.answerForm), `${skillKey}#${seed} "${raw}"`).toBe(
          grader,
        );
      }
    }
  });

  test("simplest form: the unsimplified value is wrong in the step", () => {
    expect(teachingBlankCorrect("12/15", "4/5", "fraction", "lowestTerms")).toBe(false);
    expect(teachingBlankCorrect("4/5", "4/5", "fraction", "lowestTerms")).toBe(true);
  });

  test("decimal notation: the fraction is wrong in the step", () => {
    expect(teachingBlankCorrect("82/100", "0.82", "decimal", "decimalNotation")).toBe(false);
    expect(teachingBlankCorrect(".82", "0.82", "decimal", "decimalNotation")).toBe(true);
  });

  // The step's check is unit-blind, so a family that pairs worked steps with a
  // required unit would contradict the grader again. Fail loudly if one appears.
  test("no worked-step family requires a unit the step cannot check", () => {
    const offenders = allTemplatedSkillKeys().filter((key) =>
      SEEDS.some((seed) => {
        const item = generateItem(key, seed);
        return !!item?.answerUnit && (item.workedSteps?.length ?? 0) >= 2;
      }),
    );
    expect(offenders).toEqual([]);
  });

  test("no declared form: value equivalence is unchanged", () => {
    expect(teachingBlankCorrect("12/15", "4/5", "fraction")).toBe(true);
    expect(teachingBlankCorrect("12/15", "4/5", "fraction", null)).toBe(true);
  });
});
