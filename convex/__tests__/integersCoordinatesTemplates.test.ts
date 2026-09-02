import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { formatAnswer, numericValue, parseAnswer } from "../lib/practice/answers";
import { classifyDomain } from "../lib/domainTaxonomy";
import { gradeTemplateItem, makeItemId } from "../lib/practice/session";
import { COMPARE_CHOICES, generateItem, hasTemplate, type PracticeItem } from "../lib/practice/templates";
import {
  INTEGERS_COORDINATES_DOMAIN,
  INTEGERS_COORDINATES_EDGES,
  INTEGERS_COORDINATES_SKILLS,
} from "../seed/integersCoordinatesGraph";
import schema from "../schema";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

const SKILL_KEYS = INTEGERS_COORDINATES_SKILLS.map((skill) => skill.skillKey);
const SKILL_KEY_SET = new Set(SKILL_KEYS);
const CROSS_DOMAIN_FROM_KEYS = [
  "add_subtract_unlike",
  "divide_fractions",
  "four_quadrant_plane",
  "fraction_as_parts",
  "fraction_number_line",
  "long_division_2digit_divisor",
  "multiply_fractions",
  "order_fractions",
  "order_of_operations",
];

function requiredItem(skillKey: string, seed: number, form?: string): PracticeItem {
  const item = generateItem(skillKey, seed, form);
  expect(item, `${skillKey} seed=${seed} form=${form ?? "direct"}`).not.toBeNull();
  if (!item) throw new Error(`Missing integers-coordinates template: ${skillKey}`);
  return item;
}

function graderSubmission(item: PracticeItem): string {
  return item.answer.type === "multipleChoice"
    ? String(item.answer.choiceIndex)
    : formatAnswer(item.answer);
}

describe("integers-coordinates deterministic templates", () => {
  test("the authoritative graph has 31 nodes, 58 edges, and exactly nine foreign prerequisites", () => {
    expect(INTEGERS_COORDINATES_DOMAIN).toBe("integers-coordinates");
    expect(INTEGERS_COORDINATES_SKILLS).toHaveLength(31);
    expect(INTEGERS_COORDINATES_EDGES).toHaveLength(58);
    expect(new Set(SKILL_KEYS).size).toBe(31);
    expect(INTEGERS_COORDINATES_EDGES.filter((edge) => SKILL_KEY_SET.has(edge.fromKey))).toHaveLength(49);
    expect(
      INTEGERS_COORDINATES_EDGES
        .filter((edge) => !SKILL_KEY_SET.has(edge.fromKey))
        .map((edge) => edge.fromKey)
        .sort(),
    ).toEqual(CROSS_DOMAIN_FROM_KEYS);
    for (const skill of INTEGERS_COORDINATES_SKILLS) {
      expect(skill).not.toHaveProperty("servingNote");
    }
    expect(classifyDomain(INTEGERS_COORDINATES_DOMAIN, "rational-ordering")).toEqual({
      domain: INTEGERS_COORDINATES_DOMAIN,
      strand: "rational-ordering",
    });
  });

  test("every graph node has one registered deterministic template", () => {
    for (const skillKey of SKILL_KEYS) {
      expect(hasTemplate(skillKey), skillKey).toBe(true);
    }
    for (const skillKey of SKILL_KEYS) {
      for (let seed = 1; seed <= 30; seed++) {
        expect(generateItem(skillKey, seed), `${skillKey} seed=${seed}`).toEqual(
          generateItem(skillKey, seed),
        );
      }
    }
  });

  test("every generated answer round-trips through its own grader", () => {
    for (const skillKey of SKILL_KEYS) {
      for (let seed = 1; seed <= 30; seed++) {
        const item = requiredItem(skillKey, seed);
        const result = gradeTemplateItem(makeItemId(skillKey, seed), graderSubmission(item));
        expect(result, `${skillKey} seed=${seed}`).not.toBeNull();
        expect(result?.correct, `${skillKey} seed=${seed}: ${item.stem}`).toBe(true);
      }
    }
  });

  test("multiple-choice items offer 3 or 4 unique gradeable choices", () => {
    let multipleChoiceItems = 0;
    for (const skillKey of SKILL_KEYS) {
      for (let seed = 1; seed <= 40; seed++) {
        const item = requiredItem(skillKey, seed);
        if (item.answerType !== "multipleChoice") continue;
        multipleChoiceItems++;
        expect(item.choices?.length, `${skillKey} seed=${seed}`).toBeGreaterThanOrEqual(3);
        expect(item.choices?.length, `${skillKey} seed=${seed}`).toBeLessThanOrEqual(4);
        expect(new Set(item.choices).size, `${skillKey} seed=${seed}`).toBe(item.choices?.length);
        expect(item.answer.type, `${skillKey} seed=${seed}`).toBe("multipleChoice");
        if (item.answer.type === "multipleChoice") {
          expect(item.answer.choiceIndex).toBeGreaterThanOrEqual(0);
          expect(item.answer.choiceIndex).toBeLessThan(item.choices?.length ?? 0);
        }
      }
    }
    expect(multipleChoiceItems).toBeGreaterThan(0);
  });

  test("negative typed answers parse, and generated touch-pad answers can now use a minus key", () => {
    expect(parseAnswer("-13", "integer")).toEqual({ type: "integer", value: -13 });
    let typedNegatives = 0;
    let negativeChoices = 0;
    for (const skillKey of SKILL_KEYS) {
      for (let seed = 1; seed <= 80; seed++) {
        const item = requiredItem(skillKey, seed);
        if (item.answer.type === "multipleChoice") {
          const correct = item.choices?.[item.answer.choiceIndex] ?? "";
          if (/^-\d/.test(correct)) negativeChoices++;
          continue;
        }
        if (numericValue(item.answer) < 0) typedNegatives++;
      }
    }
    // Both pads now expose a `±` sign-toggle key, so negative answers are
    // typed practice — never routed to multiple choice as a workaround.
    expect(typedNegatives).toBeGreaterThan(0);
    // Still-legitimate multiple-choice templates (notation/structure
    // recognition, e.g. signed_rational_numbers) keep negative-looking labels.
    expect(negativeChoices).toBeGreaterThan(0);
  });

  test("ordering, opposite, and absolute-value items use numberLine; coordinate reads use coordinatePlane", async () => {
    const numberLineSkills = new Set([
      "opposite_numbers",
      "integers_on_number_line",
      "compare_integers",
      "absolute_value_distance_zero",
      "absolute_value_contexts",
      "compare_absolute_values",
      "additive_inverses_make_zero",
      "signed_rationals_on_number_line",
      "compare_signed_rationals",
      "rational_inequalities_contexts",
      "order_signed_rationals",
      "absolute_value_rationals",
      "rational_between_numbers",
    ]);
    const t = convexTest(schema, modules);
    const kinds = new Set<string>();
    await t.run(async (ctx) => {
      for (const skillKey of SKILL_KEYS) {
        for (let seed = 1; seed <= 8; seed++) {
          const item = requiredItem(skillKey, seed);
          if (numberLineSkills.has(skillKey)) {
            expect(item.promptVisual?.kind, `${skillKey} seed=${seed}`).toBe("numberLine");
          }
          if (skillKey === "rational_coordinate_pairs") {
            expect(item.promptVisual?.kind, `seed=${seed}`).toBe("coordinatePlane");
          }
          if (!item.promptVisual) continue;
          kinds.add(item.promptVisual.kind);
          await ctx.db.insert("practiceItems", {
            skillKey,
            domain: INTEGERS_COORDINATES_DOMAIN,
            stem: item.stem,
            answerType: item.answerType,
            answerCanonical: formatAnswer(item.answer),
            promptVisual: item.promptVisual,
            source: "template-test",
            verifiedAt: seed,
          });
        }
      }
    });
    expect([...kinds].sort()).toEqual(["coordinatePlane", "numberLine"]);
  });

  test("all comparison nodes use the fixed three-way relationship choices", () => {
    for (const skillKey of [
      "compare_integers",
      "compare_absolute_values",
      "compare_signed_rationals",
      "rational_inequalities_contexts",
    ]) {
      for (let seed = 1; seed <= 30; seed++) {
        const item = requiredItem(skillKey, seed);
        expect(item.answerType).toBe("multipleChoice");
        expect(item.choices).toEqual(COMPARE_CHOICES);
      }
    }
  });

  test("natural signed binary operations support the missing-operand form, negative hidden operands included", () => {
    let negativeHidden = 0;
    for (const skillKey of [
      "add_integers_same_sign",
      "add_integers_opposite_signs",
      "add_integers",
      "subtract_integers_add_opposite",
      "multiply_integers",
    ]) {
      for (let seed = 1; seed <= 20; seed++) {
        const item = requiredItem(skillKey, seed, "missing");
        expect(item.form).toBe("missing");
        expect(item.answerType, `${skillKey} seed=${seed}`).toBe("integer");
        expect(
          gradeTemplateItem(makeItemId(skillKey, seed, "missing"), graderSubmission(item))?.correct,
          `${skillKey} seed=${seed}: ${item.stem}`,
        ).toBe(true);
        if (numericValue(item.answer) < 0) negativeHidden++;
      }
    }
    // The `±` sign-toggle key means a negative hidden operand no longer needs
    // a multiple-choice fallback — prove that case is actually exercised.
    expect(negativeHidden).toBeGreaterThan(0);
  });
});
