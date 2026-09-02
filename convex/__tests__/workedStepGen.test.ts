/**
 * Property-style tests for TEMPLATE worked-step generation (teach-as-action
 * content layer). For every template family that now emits `workedSteps`, sweep
 * many deterministic seeds and assert the invariants the teaching moment relies
 * on:
 *
 *   (a) every step parses/renders — non-empty `text` AND a `blankText` (the
 *       teaching moment blanks the final step by its `blankText`);
 *   (b) the FINAL step embeds the item's canonical answer (`formatAnswer`), so
 *       the answer-producing step is arithmetically consistent with the item;
 *   (c) forcing the single-blank fade (level 1 — what `teachingStep` does)
 *       yields exactly ONE faded step and ≥1 revealed step, and never leaks the
 *       faded (answer-producing) step's real text.
 *
 * A family may also, for a small tail of operands, emit NO steps at all — the
 * generators treat "no honest scaffold" (a single-place factor that is already
 * atomic, a single-digit quotient) as a first-class reveal-only outcome
 * (workedStepGen.ts), and the template omits `workedSteps` in that case. Those
 * items are exercised by the reveal-only path (no scaffold to check); the assert
 * below keeps reveal-only the rare exception, never the norm.
 *
 * This is the template twin of the stored-item wiring test in
 * fadedWorkedSteps.test.ts.
 */
import { describe, expect, test } from "vitest";
import { formatAnswer, intAns } from "../lib/practice/answers";
import { generateItem, hasTemplate } from "../lib/practice/templates";
import { applyFade } from "../lib/practice/fadedSteps";
import {
  columnAddSteps,
  columnSubtractSteps,
  longDivisionSteps,
  partialProductsSteps,
} from "../lib/practice/workedStepGen";

/** Families that MUST now emit worked steps, with the shape count(s) each can
 *  produce (so the sweep is sized to hit every branch). */
const FAMILIES: { skillKey: string; minSteps: number }[] = [
  // Fraction arithmetic
  { skillKey: "add_subtract_like", minSteps: 2 },
  { skillKey: "add_subtract_unlike", minSteps: 3 },
  { skillKey: "multiply_fraction_by_whole", minSteps: 2 },
  { skillKey: "multiply_fractions", minSteps: 2 },
  { skillKey: "divide_unit_fractions", minSteps: 2 },
  { skillKey: "divide_fractions", minSteps: 2 },
  // Whole-number arithmetic
  { skillKey: "add_multidigit_algorithm", minSteps: 2 },
  { skillKey: "subtract_multidigit_algorithm", minSteps: 2 },
  { skillKey: "mult_2digit_by_1digit", minSteps: 2 },
  { skillKey: "mult_3digit_by_1digit", minSteps: 2 },
  { skillKey: "mult_2digit_by_2digit", minSteps: 2 },
  { skillKey: "long_division_1digit_divisor", minSteps: 2 },
  { skillKey: "long_division_2digit_divisor", minSteps: 2 },
  { skillKey: "order_of_operations", minSteps: 2 },
  // Decimals
  { skillKey: "decimal_notation_fractions", minSteps: 2 },
  { skillKey: "add_subtract_decimals", minSteps: 2 },
  { skillKey: "multiply_decimals", minSteps: 2 },
  { skillKey: "divide_decimals", minSteps: 2 },
  // Probability (count favorable / total, complement, expected count, counting principle)
  { skillKey: "theoretical_probability_simple", minSteps: 2 },
  { skillKey: "probability_as_fraction", minSteps: 2 },
  { skillKey: "complement_probability", minSteps: 2 },
  { skillKey: "expected_frequency", minSteps: 2 },
  { skillKey: "sample_space", minSteps: 2 },
  // Statistics (mean / median / range — the canonical multi-step procedures)
  { skillKey: "mean", minSteps: 2 },
  { skillKey: "median", minSteps: 2 },
  { skillKey: "range", minSteps: 2 },
];

const SWEEP = 400;

describe("template worked-step generation — every priority family", () => {
  for (const { skillKey, minSteps } of FAMILIES) {
    test(`${skillKey}: emits consistent, single-blank-fadeable steps across ${SWEEP} draws`, () => {
      expect(hasTemplate(skillKey)).toBe(true);
      let seen = 0;
      let revealOnly = 0;
      for (let i = 0; i < SWEEP; i++) {
        const seed = 1 + i * 2654435761;
        const item = generateItem(skillKey, seed);
        expect(item, `${skillKey} seed=${seed}`).not.toBeNull();
        if (!item) continue;
        const steps = item.workedSteps;
        // No steps = a first-class reveal-only outcome (no honest scaffold for
        // these operands). Exercised by the reveal-only path; nothing to check.
        if (!steps || steps.length === 0) {
          revealOnly++;
          continue;
        }
        seen++;

        // (a) every step parses/renders.
        expect(steps.length).toBeGreaterThanOrEqual(minSteps);
        for (const s of steps) {
          expect(s.text.trim().length).toBeGreaterThan(0);
          expect(s.blankText && s.blankText.trim().length > 0).toBe(true);
        }

        // (b) the final step embeds the canonical answer.
        const answerStr = formatAnswer(item.answer);
        const finalText = steps[steps.length - 1].text;
        expect(
          finalText.includes(answerStr),
          `${skillKey} seed=${seed}: final step "${finalText}" must contain answer "${answerStr}"`,
        ).toBe(true);

        // (c) the teaching-moment single-blank fade: exactly one blank, ≥1
        //     revealed, and the faded step's real text never leaks.
        const fade = applyFade(steps, 1);
        expect(fade.faded).toHaveLength(1);
        expect(fade.revealed.length).toBe(steps.length - 1);
        expect(fade.revealed.length).toBeGreaterThan(0);
        expect(JSON.stringify(fade).includes(finalText)).toBe(false);
        // The completion prompt fires (there's a revealed step to build on).
        expect(fade.selfExplainPrompt).toBeTruthy();
      }
      // Every seed produced a decision (scaffold or reveal-only), and scaffolds
      // are the overwhelming norm — reveal-only is a small honest tail.
      expect(seen + revealOnly).toBe(SWEEP);
      expect(seen).toBeGreaterThan(0);
      expect(revealOnly).toBeLessThan(SWEEP * 0.1);
    });
  }
});

describe("template worked-step generation — the grader still round-trips", () => {
  // Adding workedSteps must not perturb the by-construction answer: a family's
  // generated answer is unchanged and still the value the last step embeds.
  test("multiply_fractions answer is unchanged and matches the embedded final step", () => {
    const item = generateItem("multiply_fractions", 12345);
    expect(item).not.toBeNull();
    if (!item) return;
    const answerStr = formatAnswer(item.answer);
    expect(item.workedSteps?.at(-1)?.text.includes(answerStr)).toBe(true);
  });
});

// ── Regression pins for the honest-edge-case fix (2026-07-25 re-review) ──────
// The sweep above allows a rare reveal-only tail, so it would NOT catch a
// regression that reintroduced a DISHONEST scaffold for these edge cases (a
// force-split "10 → 9 + 1", a single-place "break 900 apart by place value", or
// the single-digit-quotient count-up). These pin the exact contract: no honest
// multi-step decomposition exists → return [] (reveal-only), never a fabricated
// or answer-leaking scaffold.
describe("worked-step generators — honest edge cases degrade to reveal-only", () => {
  test("partialProductsSteps: a pure power of ten × a single-place factor emits nothing", () => {
    // 10 × d and 100 × d have no honest decomposition — the old code force-split
    // 10 → 9 + 1 (which is NOT place value and makes the problem harder).
    for (const d of [3, 6, 8, 9]) {
      expect(partialProductsSteps(10, d, intAns(10 * d))).toEqual([]);
      expect(partialProductsSteps(100, d, intAns(100 * d))).toEqual([]);
    }
    // A round second factor (10 × 60) is also single-place both ways → nothing.
    expect(partialProductsSteps(10, 60, intAns(600))).toEqual([]);
  });

  test("partialProductsSteps: a power of ten × a MULTI-place factor decomposes the other factor honestly", () => {
    // 10 × 55: distribute the shift over 55's real places — never "10 → 9 + 1".
    const steps = partialProductsSteps(10, 55, intAns(550));
    expect(steps.length).toBe(3);
    expect(steps[0].text).toContain("Break 55 apart by place value: 50 + 5");
    // The blank (final) step is the addition; no revealed step prints the answer.
    for (const s of steps.slice(0, -1)) expect(s.text).not.toContain("550");
    // A lead-digit single-place factor still uses fact-then-scale (30 → 3 × 10).
    const scale = partialProductsSteps(30, 2, intAns(60));
    expect(scale.length).toBe(3);
    expect(scale[0].text).toContain("30 is 3 × 10");
  });

  test("columnAddSteps / columnSubtractSteps: a single-place b emits nothing", () => {
    // Adding/subtracting 1000, 900, 300 is one place-value move — no honest
    // multi-step decomposition. The old code force-split (900 → 800 + 100).
    for (const b of [1000, 900, 300, 5000]) {
      expect(columnAddSteps(4628, b, intAns(4628 + b))).toEqual([]);
      expect(columnSubtractSteps(4628, b, intAns(4628 - b))).toEqual([]);
    }
    // A multi-place b still emits the running-chain scaffold.
    expect(columnAddSteps(4628, 1024, intAns(5652)).length).toBe(3);
    expect(columnSubtractSteps(6643, 117, intAns(6526)).length).toBe(3);
  });

  test("longDivisionSteps: a single-digit quotient emits nothing", () => {
    // 130 ÷ 26 = 5, 248 ÷ 31 = 8 — the answer is a COUNT, so no honest middle
    // rung is smaller than the stem. The old code disclosed it via a count-up.
    expect(longDivisionSteps(130, 26, intAns(5))).toEqual([]);
    expect(longDivisionSteps(248, 31, intAns(8))).toEqual([]);
    expect(longDivisionSteps(54, 6, intAns(9))).toEqual([]);
    // A multi-digit quotient still emits the partial-quotients scaffold.
    expect(longDivisionSteps(816, 6, intAns(136)).length).toBe(3);
  });

  test("a normal multiply (47 × 6) still emits a real multi-step scaffold with no early answer leak", () => {
    const steps = partialProductsSteps(47, 6, intAns(282));
    expect(steps.length).toBe(3);
    // The answer (282) appears ONLY in the final, blanked step.
    for (const s of steps.slice(0, -1)) expect(s.text).not.toContain("282");
    expect(steps[steps.length - 1].text).toContain("282");
    // Every step is a real, renderable rung.
    for (const s of steps) {
      expect(s.text.trim().length).toBeGreaterThan(0);
      expect(s.blankText?.trim().length ?? 0).toBeGreaterThan(0);
    }
  });
});
