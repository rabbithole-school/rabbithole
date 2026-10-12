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
import { generateItem, hasTemplate, choiceItem, makeRng } from "../lib/practice/templates";
import { applyFade } from "../lib/practice/fadedSteps";
import {
  clockRemainderSteps,
  columnAddSteps,
  columnSubtractSteps,
  longDivisionSteps,
  partialProductsSteps,
  twoStepExpressionSteps,
  weekdayRemainderSteps,
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
  { skillKey: "subtract_3digit_regroup", minSteps: 2 },
  { skillKey: "area_model_multiplication", minSteps: 3 },
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

describe("choiceItem — worked steps round-trip", () => {
  test("workedSteps are omitted when absent, attached verbatim when supplied", () => {
    const rng = makeRng(42);
    const withoutSteps = choiceItem(rng, "2 + 2 = ?", "4", ["3", "5", "6"]);
    expect(withoutSteps).not.toHaveProperty("workedSteps");

    const steps = columnSubtractSteps(842, 317, intAns(525));
    expect(steps.length).toBeGreaterThan(0);
    const withSteps = choiceItem(rng, "842 − 317 = ?", "525", ["515", "535", "425"], undefined, steps);
    expect(withSteps.workedSteps).toEqual(steps);

    // The grading contract (answer/choices) is unaffected by attaching steps.
    expect(withSteps.choices).toContain("525");
    expect(withSteps.choices[(withSteps.answer as { choiceIndex: number }).choiceIndex]).toBe("525");
  });

  test("an empty workedSteps array is treated as reveal-only (field omitted)", () => {
    const rng = makeRng(7);
    const item = choiceItem(rng, "Which is prime?", "7", ["6", "8", "9"], undefined, []);
    expect(item).not.toHaveProperty("workedSteps");
  });
});

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

// ── Break-node families (lane B): the nodes prod scholars actually trip the ──
// breaker on, which shipped as bare {stem, answer} generators (PR #2527) with
// no repair rung. Each now emits a code-derived scaffold; these sweeps assert
// the same invariants the corpus above holds, plus a MECHANICAL leak check: no
// earlier (revealed) step may expose the answer as a gradeable value the way
// the hint ladder recovers it (`gradeableResultForStep`). Integer families
// embed `formatAnswer` in the final step; the multiple-choice graph/logic
// families embed the correct CHOICE LABEL instead (formatAnswer of a choice is
// "choice N", never rendered).
import { gradeableResultForStep } from "../../shared/hintLadder";

/** Integer-answer break-node families. `revealOnlyMax` is the fraction of draws
 *  allowed to legitimately emit NO scaffold (an honest edge case — e.g. a
 *  two-step expression whose ×/÷ intermediate already equals the answer, or a
 *  clock sum that never wraps). */
const BREAK_NODE_INT_FAMILIES: { skillKey: string; minSteps: number; revealOnlyMax: number }[] = [
  { skillKey: "permutations_r_from_n", minSteps: 2, revealOnlyMax: 0 },
  { skillKey: "pigeonhole_generalized", minSteps: 2, revealOnlyMax: 0 },
  { skillKey: "count_list_outcomes", minSteps: 2, revealOnlyMax: 0 },
  { skillKey: "nt_prime_gaps", minSteps: 2, revealOnlyMax: 0 },
  { skillKey: "nt_twin_primes", minSteps: 2, revealOnlyMax: 0 },
  // ~46% of prime_factorization draws ask the implicit-exponent-1 prime, where
  // the only helpful rule IS the answer — those honestly emit no scaffold.
  { skillKey: "prime_factorization", minSteps: 2, revealOnlyMax: 0.55 },
  { skillKey: "divisibility_rules_2_5_10", minSteps: 2, revealOnlyMax: 0 },
  { skillKey: "common_factors", minSteps: 3, revealOnlyMax: 0 },
  { skillKey: "exponents_repeated_mult", minSteps: 2, revealOnlyMax: 0 },
  { skillKey: "two_step_expressions", minSteps: 2, revealOnlyMax: 0.05 },
  { skillKey: "remainder_cycles", minSteps: 2, revealOnlyMax: 0.05 },
  { skillKey: "compare_3digit", minSteps: 2, revealOnlyMax: 0 },
  { skillKey: "add_within_20_regroup", minSteps: 2, revealOnlyMax: 0 },
];

/** Multiple-choice break-node families (graph theory / logic), attached via the
 *  `{ ...choiceItem(...), ...withWorkedSteps(steps) }` spread. */
const BREAK_NODE_MC_FAMILIES: { skillKey: string; minSteps: number }[] = [
  { skillKey: "prime_or_composite", minSteps: 2 },
  { skillKey: "gt_bipartite", minSteps: 2 },
  { skillKey: "gt_degree_sequence", minSteps: 3 },
  { skillKey: "lg_negate", minSteps: 2 },
  { skillKey: "nt_parity_proof", minSteps: 3 },
];

const BREAK_SWEEP = 800;

describe("break-node worked steps — integer families", () => {
  for (const { skillKey, minSteps, revealOnlyMax } of BREAK_NODE_INT_FAMILIES) {
    test(`${skillKey}: consistent, single-blank-fadeable, no early leak across ${BREAK_SWEEP} draws`, () => {
      expect(hasTemplate(skillKey)).toBe(true);
      let seen = 0;
      let revealOnly = 0;
      for (let i = 0; i < BREAK_SWEEP; i++) {
        const seed = 7 + i * 2654435761;
        const item = generateItem(skillKey, seed);
        expect(item, `${skillKey} seed=${seed}`).not.toBeNull();
        if (!item) continue;
        const steps = item.workedSteps;
        if (!steps || steps.length === 0) {
          revealOnly++;
          continue;
        }
        seen++;
        const answerStr = formatAnswer(item.answer);

        // (a) ≥ minSteps, and every step renders with a non-empty blank.
        expect(steps.length).toBeGreaterThanOrEqual(minSteps);
        for (const s of steps) {
          expect(s.text.trim().length).toBeGreaterThan(0);
          expect((s.blankText ?? "").trim().length).toBeGreaterThan(0);
        }

        // (b) the final step embeds the canonical answer.
        const finalText = steps[steps.length - 1].text;
        expect(
          finalText.includes(answerStr),
          `${skillKey} seed=${seed}: final "${finalText}" must contain "${answerStr}"`,
        ).toBe(true);

        // (c) MECHANICAL LEAK CHECK: no earlier step exposes the answer as a
        //     gradeable value (the ladder shows earlier steps in full).
        for (let s = 0; s < steps.length - 1; s++) {
          const recovered = gradeableResultForStep(steps[s]);
          expect(
            recovered?.expected !== answerStr,
            `${skillKey} seed=${seed}: step ${s} "${steps[s].text}" leaks the answer ${answerStr}`,
          ).toBe(true);
        }

        // (d) single-blank fade blanks exactly the final step and never leaks it.
        const fade = applyFade(steps, 1);
        expect(fade.faded).toHaveLength(1);
        expect(fade.revealed.length).toBe(steps.length - 1);
        expect(JSON.stringify(fade).includes(finalText)).toBe(false);
        expect(fade.selfExplainPrompt).toBeTruthy();
      }
      expect(seen + revealOnly).toBe(BREAK_SWEEP);
      expect(seen).toBeGreaterThan(0);
      expect(revealOnly).toBeLessThanOrEqual(Math.ceil(BREAK_SWEEP * revealOnlyMax));
    });
  }
});

describe("break-node worked steps — multiple-choice families", () => {
  for (const { skillKey, minSteps } of BREAK_NODE_MC_FAMILIES) {
    test(`${skillKey}: final step names the correct choice; no earlier step previews it`, () => {
      expect(hasTemplate(skillKey)).toBe(true);
      let seen = 0;
      for (let i = 0; i < BREAK_SWEEP; i++) {
        const seed = 11 + i * 2654435761;
        const item = generateItem(skillKey, seed);
        expect(item, `${skillKey} seed=${seed}`).not.toBeNull();
        if (!item) continue;
        const steps = item.workedSteps;
        // MC families always attach steps.
        expect(steps, `${skillKey} seed=${seed} must carry workedSteps`).toBeTruthy();
        if (!steps) continue;
        seen++;
        expect(steps.length).toBeGreaterThanOrEqual(minSteps);
        expect(item.answer.type).toBe("multipleChoice");
        if (item.answer.type !== "multipleChoice") continue;
        const label = (item.choices ?? [])[item.answer.choiceIndex];
        expect(label, `${skillKey} seed=${seed} choice label`).toBeTruthy();

        const finalText = steps[steps.length - 1].text;
        expect(
          finalText.includes(label),
          `${skillKey} seed=${seed}: final "${finalText}" must name choice "${label}"`,
        ).toBe(true);
        // No earlier step states the verdict label.
        for (let s = 0; s < steps.length - 1; s++) {
          expect(
            !steps[s].text.includes(label),
            `${skillKey} seed=${seed}: step ${s} "${steps[s].text}" previews verdict "${label}"`,
          ).toBe(true);
        }
        // Single-blank fade blanks exactly the final (verdict) step.
        const fade = applyFade(steps, 1);
        expect(fade.faded).toHaveLength(1);
        expect(JSON.stringify(fade).includes(finalText)).toBe(false);
      }
      expect(seen).toBeGreaterThan(0);
    });
  }
});

// ── Reveal-only edge-case pins for the new generators ────────────────────────
// The sweeps above tolerate a small reveal-only tail, so they would not catch a
// regression that reintroduced a DISHONEST scaffold for these edges. These pin
// the exact contract: when the only "first step" would already print the answer
// (a ×/÷ intermediate that equals the result, or a clock sum that never wraps),
// return [] rather than a scaffold that hands the answer back.
describe("break-node generators — honest reveal-only edges", () => {
  test("twoStepExpressionSteps: intermediate equal to the answer emits nothing", () => {
    // 12 − (6 × 1)… contrived: intermediate 6 == answer 6 → no honest scaffold.
    expect(twoStepExpressionSteps("6 × 2", 12, 24, "−", intAns(12))).toEqual([]);
    // A genuine two-step still emits both rungs, answer only in the last.
    const steps = twoStepExpressionSteps("6 × 4", 24, 5, "+", intAns(29));
    expect(steps.length).toBe(2);
    expect(steps[0].text).not.toContain("29");
    expect(steps[1].text).toContain("29");
  });

  test("clockRemainderSteps: a sum that never passes 12 emits nothing", () => {
    // 3 o'clock + 5 hours = 8: no wrap, so the sum IS the answer — reveal-only.
    expect(clockRemainderSteps(3, 5, intAns(8))).toEqual([]);
    // A wrapping sum emits the add-then-wrap scaffold; answer only in the last.
    const steps = clockRemainderSteps(10, 5, intAns(3));
    expect(steps.length).toBe(2);
    expect(steps[0].text).toContain("15");
    expect(steps[0].text).not.toContain("3 o'clock");
    expect(steps[1].text).toContain("3 o'clock");
  });

  test("weekdayRemainderSteps: always wraps (daysLater ≥ 20) — two honest rungs", () => {
    const steps = weekdayRemainderSteps(2, 20, intAns(1));
    expect(steps.length).toBe(2);
    expect(steps[0].text).toContain("22");
    expect(steps[1].text).toContain("day 1");
  });
});
