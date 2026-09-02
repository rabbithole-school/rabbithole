import { describe, expect, test } from "vitest";
import { choiceAns, formatAnswer, fracAns, intAns, type TypedAnswer } from "../practice/answers";
import { gradeTemplateItem, makeItemId } from "../practice/session";
import { generateItem, generateSet, hasTemplate, COMPARE_CHOICES } from "../practice/templates";

const FRACTION_TEMPLATE_KEYS = [
  "unit_fraction",
  "add_subtract_like",
  "add_subtract_unlike",
  "multiply_fraction_by_whole",
  "multiply_fractions",
  "divide_unit_fractions",
  "divide_fractions",
  "equivalent_fractions_general",
  "common_denominators",
  "whole_as_fraction",
  "mixed_improper",
  "compare_same_denominator",
  "compare_same_numerator",
  "compare_benchmarks",
  "compare_unlike",
] as const;

const CONCEPTUAL_NON_TEMPLATE_KEYS = [
  "partition_shapes",
  "fraction_as_parts",
  "fraction_number_line",
  "equivalent_fractions_visual",
] as const;

function lcm(a: number, b: number): number {
  const gcd = (x: number, y: number): number => (y === 0 ? Math.abs(x) : gcd(y, x % y));
  return Math.abs(a * b) / gcd(a, b);
}

function comparisonChoice(leftNum: number, leftDen: number, rightNum: number, rightDen: number): number {
  const left = leftNum * rightDen;
  const right = rightNum * leftDen;
  if (left < right) return 0;
  if (left === right) return 1;
  return 2;
}

function expectedFromStem(skillKey: (typeof FRACTION_TEMPLATE_KEYS)[number], stem: string): TypedAnswer {
  let m: RegExpMatchArray | null;

  if (skillKey === "unit_fraction") {
    expect(stem).toBe("What fraction of the whole is shaded?");
    return fracAns(1, 1);
  }

  if (skillKey === "add_subtract_like" || skillKey === "add_subtract_unlike") {
    m = stem.match(/^(\d+)\/(\d+) ([+−]) (\d+)\/(\d+) = \?$/);
    expect(m, stem).not.toBeNull();
    if (!m) throw new Error(stem);
    const a = Number(m[1]);
    const d1 = Number(m[2]);
    const op = m[3];
    const b = Number(m[4]);
    const d2 = Number(m[5]);
    const num = op === "+" ? a * d2 + b * d1 : a * d2 - b * d1;
    return fracAns(num, d1 * d2);
  }

  if (skillKey === "multiply_fraction_by_whole") {
    m = stem.match(/^(\d+) × (\d+)\/(\d+) = \?$/);
    expect(m, stem).not.toBeNull();
    if (!m) throw new Error(stem);
    return fracAns(Number(m[1]) * Number(m[2]), Number(m[3]));
  }

  if (skillKey === "multiply_fractions") {
    m = stem.match(/^(\d+)\/(\d+) × (\d+)\/(\d+) = \?$/);
    expect(m, stem).not.toBeNull();
    if (!m) throw new Error(stem);
    return fracAns(Number(m[1]) * Number(m[3]), Number(m[2]) * Number(m[4]));
  }

  if (skillKey === "divide_unit_fractions") {
    m = stem.match(/^1\/(\d+) ÷ (\d+) = \?$/);
    if (m) return fracAns(1, Number(m[1]) * Number(m[2]));
    m = stem.match(/^(\d+) ÷ 1\/(\d+) = \?$/);
    expect(m, stem).not.toBeNull();
    if (!m) throw new Error(stem);
    return fracAns(Number(m[1]) * Number(m[2]), 1);
  }

  if (skillKey === "divide_fractions") {
    m = stem.match(/^(\d+)\/(\d+) ÷ (\d+)\/(\d+) = \?$/);
    expect(m, stem).not.toBeNull();
    if (!m) throw new Error(stem);
    return fracAns(Number(m[1]) * Number(m[4]), Number(m[2]) * Number(m[3]));
  }

  if (skillKey === "equivalent_fractions_general") {
    m = stem.match(/^(\d+)\/(\d+) = \?\/(\d+)$/);
    expect(m, stem).not.toBeNull();
    if (!m) throw new Error(stem);
    const a = Number(m[1]);
    const b = Number(m[2]);
    const den = Number(m[3]);
    expect(den % b).toBe(0);
    return intAns((den / b) * a);
  }

  if (skillKey === "common_denominators") {
    m = stem.match(/^To add 1\/(\d+) \+ 1\/(\d+), what's the least common denominator you could use\?$/);
    expect(m, stem).not.toBeNull();
    if (!m) throw new Error(stem);
    return intAns(lcm(Number(m[1]), Number(m[2])));
  }

  if (skillKey === "whole_as_fraction") {
    m = stem.match(/^Write (\d+) as a fraction over 1: (\d+) = \?\/1$/);
    expect(m, stem).not.toBeNull();
    if (!m) throw new Error(stem);
    expect(Number(m[1])).toBe(Number(m[2]));
    return intAns(Number(m[1]));
  }

  if (skillKey === "mixed_improper") {
    m = stem.match(/^Write (\d+) (\d+)\/(\d+) as \?\/(\d+)$/);
    expect(m, stem).not.toBeNull();
    if (!m) throw new Error(stem);
    const whole = Number(m[1]);
    const num = Number(m[2]);
    const den = Number(m[3]);
    expect(Number(m[4])).toBe(den);
    return intAns(whole * den + num);
  }

  if (skillKey === "compare_benchmarks") {
    m = stem.match(/^How does (\d+)\/(\d+) compare to 1\/2\?$/);
    expect(m, stem).not.toBeNull();
    if (!m) throw new Error(stem);
    return choiceAns(comparisonChoice(Number(m[1]), Number(m[2]), 1, 2));
  }

  m = stem.match(/^How does (\d+)\/(\d+) compare to (\d+)\/(\d+)\?$/);
  expect(m, stem).not.toBeNull();
  if (!m) throw new Error(stem);
  return choiceAns(comparisonChoice(Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])));
}

describe("fraction template generators", () => {
  test("each fraction template skill is deterministic, templated, and independently verifiable", () => {
    for (const [i, skillKey] of FRACTION_TEMPLATE_KEYS.entries()) {
      expect(hasTemplate(skillKey), skillKey).toBe(true);
      const items = generateSet(skillKey, 50, 20260702 + i * 9973);
      expect(items.length, skillKey).toBeGreaterThan(0);
      for (const item of items) {
        expect(item.skillKey).toBe(skillKey);
        if (skillKey === "unit_fraction") {
          expect(item.promptVisual?.kind, item.stem).toBe("fractionpart");
          if (item.promptVisual?.kind !== "fractionpart") throw new Error(item.stem);
          expect(item.promptVisual.shaded).toBe(1);
          expect(item.answer, `${skillKey}: ${item.stem}`).toEqual(fracAns(1, item.promptVisual.parts));
        } else {
          expect(item.answer, `${skillKey}: ${item.stem}`).toEqual(expectedFromStem(skillKey, item.stem));
        }
      }

      const sampleSeed = 88001 + i;
      const sampled = generateItem(skillKey, sampleSeed);
      expect(sampled, `${skillKey} sample`).not.toBeNull();
      if (!sampled) continue;
      const learnerRaw =
        sampled.answer.type === "multipleChoice"
          ? String(sampled.answer.choiceIndex)
          : formatAnswer(sampled.answer);
      const graded = gradeTemplateItem(makeItemId(skillKey, sampleSeed), learnerRaw);
      expect(graded, `${skillKey} sample`).not.toBeNull();
      expect(graded?.correct, `${skillKey} sample`).toBe(true);
    }
  });

  test("conceptual/visual fraction skills intentionally remain non-templated", () => {
    for (const skillKey of CONCEPTUAL_NON_TEMPLATE_KEYS) {
      expect(hasTemplate(skillKey), skillKey).toBe(false);
    }
  });
});

const COMPARE_TEMPLATE_KEYS = [
  "compare_same_denominator",
  "compare_same_numerator",
  "compare_benchmarks",
  "compare_unlike",
] as const;

describe("fraction comparison items are multiple choice", () => {
  test("each compare_* item emits structured choices and a choice-free stem", () => {
    for (const [i, skillKey] of COMPARE_TEMPLATE_KEYS.entries()) {
      const items = generateSet(skillKey, 30, 30260702 + i * 7919);
      expect(items.length, skillKey).toBeGreaterThan(0);
      for (const item of items) {
        expect(item.answer.type, `${skillKey}: ${item.stem}`).toBe("multipleChoice");
        expect(item.choices, `${skillKey}: ${item.stem}`).toEqual(COMPARE_CHOICES);
        // The choices must not leak back into the stem (they render as buttons).
        expect(item.stem, skillKey).not.toContain("Choices:");
      }
    }
  });

  test("compare_same_denominator never serves n/n or an identical pair", () => {
    // The degenerate draws ("How does 6/6 compare to 6/6?") are folded away in
    // the generator; both numerators are proper and distinct.
    for (let seed = 1; seed <= 400; seed++) {
      const item = generateItem("compare_same_denominator", seed)!;
      const [a, d1, b, d2] = (item.stem.match(/(\d+)\/(\d+)/g) ?? []).flatMap((f) =>
        f.split("/").map(Number),
      );
      expect(d1, item.stem).toBe(d2);
      expect(a, item.stem).toBeLessThan(d1);
      expect(b, item.stem).toBeLessThan(d1);
      expect(a, item.stem).not.toBe(b);
    }
  });

  test("compare_same_numerator uses distinct denominators", () => {
    for (let seed = 1; seed <= 400; seed++) {
      const item = generateItem("compare_same_numerator", seed)!;
      const [a, d1, b, d2] = (item.stem.match(/(\d+)\/(\d+)/g) ?? []).flatMap((f) =>
        f.split("/").map(Number),
      );
      expect(a, item.stem).toBe(b);
      expect(d1, item.stem).not.toBe(d2);
      expect(item.answer, item.stem).not.toEqual(choiceAns(1));
    }
  });

  test("compare_unlike intentionally retains equivalent-fraction comparisons", () => {
    const answers = Array.from({ length: 400 }, (_, index) =>
      generateItem("compare_unlike", index + 1)!.answer,
    );
    expect(answers).toContainEqual(choiceAns(1));
  });

  test("a multiple-choice compare item grades by submitting the choice index", () => {
    for (const [i, skillKey] of COMPARE_TEMPLATE_KEYS.entries()) {
      const seed = 91001 + i;
      const sampled = generateItem(skillKey, seed);
      expect(sampled, skillKey).not.toBeNull();
      if (!sampled || sampled.answer.type !== "multipleChoice") throw new Error(skillKey);
      const itemId = makeItemId(skillKey, seed);
      // The correct index round-trips.
      const graded = gradeTemplateItem(itemId, String(sampled.answer.choiceIndex));
      expect(graded?.correct, skillKey).toBe(true);
      // A different valid index is marked wrong.
      const wrong = (sampled.answer.choiceIndex + 1) % COMPARE_CHOICES.length;
      expect(gradeTemplateItem(itemId, String(wrong))?.correct, skillKey).toBe(false);
    }
  });
});
