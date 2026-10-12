import { describe, expect, test } from "vitest";
import { formatAnswer, fracAns } from "../practice/answers";
import { gradeTemplateItem, makeItemId } from "../practice/session";
import { generateItem, type PracticeItem } from "../practice/templates";

const SERVEABILITY_HOLE_KEYS = [
  "add_subtract_word_problems_multidigit",
  "add_subtract_word_problems_within_10",
  "order_fractions",
  "simplify_fractions",
  "add_subtract_mixed_like",
  "decompose_fraction",
  "fraction_scaling",
  "likelihood_scale",
  "experimental_probability",
  "law_of_large_numbers",
] as const;

function answerValue(item: PracticeItem): number {
  expect(item.answer.type).toBe("integer");
  return (item.answer as { type: "integer"; value: number }).value;
}

function numbers(stem: string): number[] {
  return (stem.match(/\d+/g) ?? []).map(Number);
}

function selectedChoice(item: PracticeItem): string {
  expect(item.answer.type, item.stem).toBe("multipleChoice");
  if (item.answer.type !== "multipleChoice") throw new Error(item.stem);
  const selected = item.choices?.[item.answer.choiceIndex];
  expect(selected, item.stem).toBeDefined();
  return selected!;
}

function fractionValue(label: string): number {
  const [numerator, denominator] = label.split("/").map(Number);
  return denominator === undefined ? numerator : numerator / denominator;
}

function gcd(a: number, b: number): number {
  a = Math.abs(a);
  b = Math.abs(b);
  while (b !== 0) {
    [a, b] = [b, a % b];
  }
  return a;
}

function lcm(a: number, b: number): number {
  return Math.abs(a * b) / gcd(a, b);
}

describe("practice templates — Wave A coverage", () => {
  test("each serveability-hole answer agrees with an independent stem derivation", () => {
    for (const [keyIndex, skillKey] of SERVEABILITY_HOLE_KEYS.entries()) {
      for (let sample = 1; sample <= 50; sample++) {
        const item = generateItem(skillKey, 90_000 + keyIndex * 1_000 + sample);
        expect(item, `${skillKey} sample=${sample}`).not.toBeNull();
        if (!item) continue;

        const ns = numbers(item.stem);
        if (skillKey === "add_subtract_word_problems_within_10") {
          const expected = item.stem.includes("join")
            ? ns[0] + ns[1]
            : ns[0] - ns[1];
          expect(item.answer).toEqual({ type: "integer", value: expected });
        } else if (skillKey === "add_subtract_word_problems_multidigit") {
          expect(item.answer).toEqual({ type: "integer", value: ns[0] + ns[1] - ns[2] });
        } else if (skillKey === "order_fractions") {
          const ordered = selectedChoice(item).split(" < ").map(fractionValue);
          expect(ordered).toEqual([...ordered].sort((a, b) => a - b));
          expect(new Set(ordered).size).toBe(3);
        } else if (skillKey === "simplify_fractions") {
          expect(item.answer).toEqual(fracAns(ns[0], ns[1]));
        } else if (skillKey === "add_subtract_mixed_like") {
          const match = item.stem.match(
            /^(\d+) (\d+)\/(\d+) ([+−]) (\d+) (\d+)\/(\d+) = \?/,
          );
          expect(match, item.stem).not.toBeNull();
          if (!match) continue;
          const denominator = Number(match[3]);
          expect(Number(match[7])).toBe(denominator);
          const left = Number(match[1]) * denominator + Number(match[2]);
          const right = Number(match[5]) * denominator + Number(match[6]);
          expect(item.answer).toEqual(
            fracAns(match[4] === "+" ? left + right : left - right, denominator),
          );
        } else if (skillKey === "decompose_fraction") {
          const fractions = selectedChoice(item).match(/\d+\/\d+/g) ?? [];
          expect(fractions).toHaveLength(3);
          const [whole, firstPart, secondPart] = fractions;
          if (!whole || !firstPart || !secondPart) throw new Error(item.stem);
          expect(fractionValue(whole)).toBeCloseTo(
            fractionValue(firstPart) + fractionValue(secondPart),
            12,
          );
        } else if (skillKey === "fraction_scaling") {
          const factor = ns[1] / ns[2];
          expect(selectedChoice(item)).toBe(
            factor < 1 ? `less than ${ns[0]}` : factor === 1 ? `equal to ${ns[0]}` : `greater than ${ns[0]}`,
          );
        } else if (skillKey === "likelihood_scale") {
          const [red, blue] = ns;
          const expected = red === 0
            ? "impossible"
            : blue === 0
              ? "certain"
              : red === blue
                ? "equally likely"
                : red < blue
                  ? "unlikely"
                  : "likely";
          expect(selectedChoice(item)).toBe(expected);
        } else if (skillKey === "experimental_probability") {
          expect(item.answer).toEqual(fracAns(ns[0], ns[1]));
        } else {
          expect(skillKey).toBe("law_of_large_numbers");
          expect(selectedChoice(item)).toBe(ns[0] > ns[1] ? "Experiment A" : "Experiment B");
        }
      }
    }
  });

  test("named construction guarantees hold", () => {
    for (let seed = 1; seed <= 80; seed++) {
      const add = generateItem("add_3digit_no_regroup", seed)!;
      const [a, b] = numbers(add.stem);
      for (let place = 1; place <= 100; place *= 10) {
        expect((Math.floor(a / place) % 10) + (Math.floor(b / place) % 10)).toBeLessThanOrEqual(9);
      }

      for (const skillKey of ["long_division_1digit_divisor", "long_division_2digit_divisor"]) {
        const div = generateItem(skillKey, seed)!;
        const [dividend, divisor] = numbers(div.stem);
        expect(dividend % divisor, `${skillKey} seed=${seed}: ${div.stem}`).toBe(0);
        expect(answerValue(div)).toBe(dividend / divisor);
      }

      const gcfItem = generateItem("gcf", seed)!;
      const [gcfA, gcfB] = numbers(gcfItem.stem);
      expect(answerValue(gcfItem)).toBe(gcd(gcfA, gcfB));

      const lcmItem = generateItem("lcm", seed)!;
      const [lcmA, lcmB] = numbers(lcmItem.stem);
      expect(answerValue(lcmItem)).toBe(lcm(lcmA, lcmB));

      const makeTen = generateItem("make_ten_strategy", seed)!;
      const [left, right] = numbers(makeTen.stem);
      expect(left >= 100 || (left >= 10 && right >= 10), makeTen.stem).toBe(true);
      // The "make ten" strategy only fits a pair that actually requires
      // regrouping (bridging through a ten in some place) — assert that
      // holds for BOTH generation branches so a "make ten"-named item never
      // presents a pair needing no regrouping at all.
      let requiresCarry = false;
      for (let place = 1; place <= 10; place *= 10) {
        if ((Math.floor(left / place) % 10) + (Math.floor(right / place) % 10) > 9) {
          requiresCarry = true;
        }
      }
      expect(requiresCarry, makeTen.stem).toBe(true);
    }
  });

  test("exponents_repeated_mult stays within the concept's computational range", () => {
    // Results above 256 (5^4, 4^5, 5^5) require the grade-4 3-digit × 1-digit
    // algorithm — not a prereq of this node — so the cap keeps the item about
    // the exponent concept, not multiplication stamina.
    const stems = new Set<string>();
    for (let seed = 1; seed <= 400; seed++) {
      const item = generateItem("exponents_repeated_mult", seed)!;
      const [base, exponent] = numbers(item.stem);
      expect(base, item.stem).toBeGreaterThanOrEqual(2);
      expect(base, item.stem).toBeLessThanOrEqual(5);
      expect(exponent, item.stem).toBeGreaterThanOrEqual(2);
      expect(answerValue(item), item.stem).toBe(Math.pow(base, exponent));
      expect(answerValue(item), item.stem).toBeLessThanOrEqual(256);
      stems.add(item.stem);
    }
    // The cap trims the three largest cells; it must not collapse the pool.
    expect(stems.size).toBeGreaterThanOrEqual(10);
  });

  test("order_of_operations enrichment includes subtraction, division, and nested parentheses", () => {
    const stems: string[] = [];
    for (let seed = 1; seed <= 200; seed++) {
      const item = generateItem("order_of_operations", seed)!;
      stems.push(item.stem);
      expect(gradeTemplateItem(makeItemId("order_of_operations", seed), formatAnswer(item.answer))?.correct).toBe(true);
    }

    expect(stems.some((stem) => stem.includes("−"))).toBe(true);
    expect(stems.some((stem) => stem.includes("÷"))).toBe(true);
    expect(stems.some((stem) => /\([^()]+ \+ \([^()]+ × [^()]+\)\)/.test(stem))).toBe(true);
  });
});
