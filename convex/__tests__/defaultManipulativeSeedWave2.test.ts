import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { internal } from "../_generated/api";
import { MANIPULATIVE_VERIFIER_KIND } from "../../lib/manipulative/practiceContract";
import { parseManipulativeSpec } from "../../lib/manipulative/grade";
import type { ManipulativeSpec } from "../../lib/manipulative/types";
import {
  isSolved,
  initialArray,
  initialAreaPerimeter,
  initialDistribute,
  initialDistributor,
  initialFunctionMachine,
  initialNumberLine,
  initialPartition,
  initialProtractor,
  initialRekenrek,
  functionMachineStateFromTypedAnswer,
} from "../../lib/manipulative/logic";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

/**
 * Content-coverage wave 2 (review/content-coverage-audit.md, ranks 1-6, the
 * next strands after wave 1): `seedDefaultManipulativePractice`
 * (convex/practiceSkills.ts) now authors a default manipulative for 33
 * additional nodes across geometry-measurement (area-perimeter, angles),
 * whole-number-arithmetic (number-theory, counting), ratio-proportion-percent
 * (ratios-rates), and early-algebra (expressions-variables). Same two
 * invariants as wave 1, locked per spec `id`:
 *
 *   1. NOT pre-solved — the kind-appropriate initial state (what a scholar
 *      actually sees on mount) must fail `isSolved`. A manipulative must
 *      never hand out a puzzle that's already done.
 *   2. Solvable by construction — the INTENDED solution state (the concrete
 *      numbers baked into the prompt) makes `isSolved` return true, exercising
 *      the exact same pure grader `gradeManipulativeSubmission` runs
 *      server-side.
 *
 * Any regression here — a mis-typed number, a goal that doesn't match the
 * story in the prompt, a spec that's accidentally already solved on mount —
 * fails loudly instead of silently shipping an ungradable or trivial item.
 *
 * Two fixes folded in from review (2026-08-03), both changing WHAT this file
 * verifies, not just what it asserts:
 *
 *   - The 10 `functionMachine` specs used to be checked by hand-constructing
 *     a `{predicted: N}` state object directly — bypassing the fact that the
 *     REAL renderer (`FunctionMachineManipulative`) never emitted any state
 *     at all, so practice-mode Done could never actually fire for one of
 *     these items. Now fixed (the renderer echoes the frame's typed answer
 *     into `state` via `functionMachineStateFromTypedAnswer`), so these specs
 *     are verified below by feeding a TYPED STRING through that exact
 *     function — the same mapping the renderer runs — never a hand-rolled
 *     `{predicted}` object.
 *   - Four `array` goals (`is_factor`, `is_multiple`, `factors_and_multiples`,
 *     `square_cube_numbers`) used bare `productEquals`, so an unrelated
 *     factor pair sharing the same product (e.g. a 3×8 array) would
 *     incorrectly pass a task about a SPECIFIC factor (6) or a square number.
 *     They now use the tightened `sideEqualsWithProduct` / `squareEquals`
 *     goals; `WRONG_ARRAY_SOLUTIONS` below locks in that the previously-
 *     accepted wrong states are correctly rejected.
 */
const WAVE2_SOLUTIONS: Record<string, unknown> = {
  // geometry-measurement — area-perimeter: array (partition/area/unit
  // squares), distribute (area-model split), areaPerimeter (reshape a
  // fixed-perimeter rectangle toward a target or maximal area).
  "array-partition-3x4-rect": { rows: 3, cols: 4 },
  "array-area-rect-5x6": { rows: 5, cols: 6 },
  "array-unit-squares-4x7": { rows: 4, cols: 7 },
  "distribute-area-6x7-at-4": { column: 4 },
  "area-perimeter-relationship-target16": { width: 2 },
  "area-perimeter-unknown-side-p24-a35": { width: 5 },
  "area-perimeter-optimize-p16": { width: 4 },

  // geometry-measurement — angles: protractor construction of a target
  // degree measure.
  "protractor-angle-concept-90": { angleDeg: 90 },
  "protractor-benchmark-angle-45": { angleDeg: 45 },
  "protractor-angle-turns-180": { angleDeg: 180 },
  "protractor-angle-classification-acute-30": { angleDeg: 30 },

  // whole-number-arithmetic — number-theory: array (factor/multiple/
  // factor-pair/square-number builds — is_factor, is_multiple, and
  // factors_and_multiples now use the tightened `sideEqualsWithProduct`
  // goal, and square_cube_numbers uses `squareEquals`; see
  // WRONG_ARRAY_SOLUTIONS below for the negative-case lock), number line
  // (common multiple, LCM), distributor (a remainder that wraps like a
  // clock).
  "array-is-factor-6-of-24": { rows: 6, cols: 4 },
  "array-is-multiple-35-of-5": { rows: 5, cols: 7 },
  "array-factor-pairs-24": { rows: 4, cols: 6 },
  "array-factors-multiples-4x5": { rows: 4, cols: 5 },
  "numberline-common-multiple-4-6": { value: 12 },
  "numberline-lcm-3-5": { value: 15 },
  "distributor-remainder-cycle-17-5": { perGroup: 3 },
  "array-square-number-4x4": { rows: 4, cols: 4 },

  // whole-number-arithmetic — counting: number line (count to 20/100 by
  // ones/tens, compare within 10, count on).
  "numberline-count-to-20": { value: 20 },
  "numberline-count-to-100-ones": { value: 63 },
  "numberline-count-to-100-tens": { value: 70 },
  "numberline-compare-within-10-7-vs-4": { value: 7 },
  "numberline-count-on-4-plus-3": { value: 7 },

  // ratio-proportion-percent — ratios-rates: number line (compare ratios,
  // scale an equivalent ratio), Dot Blaster (part-part ratio language),
  // partition (part-to-whole fraction reframing). The 6 function-machine
  // entries in this strand (ratio table, unit rate, unit conversion, unit
  // price, constant speed, fractional unit rate) are verified separately
  // below via WAVE2_FUNCTION_MACHINE_TYPED_ANSWERS.
  "numberline-ratio-compare-075-06": { value: 0.75 },
  "numberline-ratio-scale-2-3-at-8": { value: 12 },
  "dotblaster-ratio-concept-2-3": { left: 2 },
  "partition-ratio-part-whole-3-5": { discs: [{ parts: 5, shaded: 3 }] },

  // early-algebra — expressions-variables: distribute (the distributive
  // property as an algebra move). The 4 function-machine entries in this
  // strand are verified separately below.
  "distribute-expr-distributive-5x10-at-8": { column: 8 },
};

/**
 * Every `functionMachine` spec's intended solution, expressed as the TYPED
 * STRING a scholar would actually enter in the frame's answer field — never
 * a hand-rolled `{predicted}` object. `functionMachineStateFromTypedAnswer`
 * (the exact function `FunctionMachineManipulative` calls on every keystroke)
 * turns each of these into the state `isSolved` is checked against below, so
 * this exercises the renderer's real mapping end to end.
 */
const WAVE2_FUNCTION_MACHINE_TYPED_ANSWERS: Record<string, string> = {
  "fm-ratio-table-2-per-shirt": "12",
  "fm-rate-unit-derive-apples": "12",
  "fm-rate-convert-ft-in": "60",
  "fm-rate-unit-price-derive-pens": "3",
  "fm-rate-constant-speed-50mph": "150",
  "fm-rate-fractional-half-cup": "3",
  "fm-expr-eval-one-var-3x-plus-2": "17",
  "fm-expr-variable-meaning-n-plus-4": "13",
  "fm-expr-eval-fractions-half-x-plus-3": "6",
  "fm-expr-multi-step-signed-neg2x-plus5": "11",
};

/**
 * The previously-accepted WRONG array states for the four tightened
 * `sideEqualsWithProduct` / `squareEquals` goals — each shares the target
 * PRODUCT but proves a different (or no) fact. Before the fix these all
 * passed `isSolved` (the exact regression the review flagged); this locks in
 * that they now correctly fail.
 */
const WRONG_ARRAY_SOLUTIONS: Record<string, unknown[]> = {
  // "6 is a factor of 24" — a 3×8 array proves 3 is a factor, not 6.
  "array-is-factor-6-of-24": [{ rows: 3, cols: 8 }, { rows: 2, cols: 12 }],
  // "35 is a multiple of 5" — a 1×35 array doesn't show a 5-row grouping.
  "array-is-multiple-35-of-5": [{ rows: 1, cols: 35 }],
  // "4 is a factor of 20" — a 2×10 array proves 2 is a factor, not 4.
  "array-factors-multiples-4x5": [{ rows: 2, cols: 10 }, { rows: 1, cols: 20 }],
  // "4² = 16" — a 2×8 array isn't square.
  "array-square-number-4x4": [{ rows: 2, cols: 8 }, { rows: 1, cols: 16 }],
};

function initialStateForTest(spec: ManipulativeSpec): unknown {
  switch (spec.kind) {
    case "numberline":
      return initialNumberLine(spec);
    case "array":
      return initialArray(spec);
    case "rekenrek":
      return initialRekenrek(spec);
    case "distribute":
      return initialDistribute(spec);
    case "distributor":
      return initialDistributor(spec);
    case "functionMachine":
      return initialFunctionMachine();
    case "areaPerimeter":
      return initialAreaPerimeter(spec);
    case "protractor":
      return initialProtractor(spec);
    case "partition":
      return initialPartition(spec);
    default:
      throw new Error(`content-coverage wave 2 fixture used an unexpected kind: ${spec.kind}`);
  }
}

describe("content-coverage wave 2 — default manipulative seed (next-ranked strands)", () => {
  test("every wave-2 spec is not pre-solved, and its intended solution passes isSolved", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    await t.mutation(internal.practiceSkills.seedDefaultManipulativePractice, {});

    const rows = await t.run(async (ctx) => ctx.db.query("practiceItems").collect());
    const manipRows = rows.filter((r) => r.verifierKind === MANIPULATIVE_VERIFIER_KIND);

    const found = new Set<string>();
    for (const row of manipRows) {
      const spec = parseManipulativeSpec(row.manipulativeSpec);
      if (!spec) continue;

      const typedAnswer = WAVE2_FUNCTION_MACHINE_TYPED_ANSWERS[spec.id];
      const solution = typedAnswer !== undefined ? undefined : WAVE2_SOLUTIONS[spec.id];
      if (typedAnswer === undefined && solution === undefined) continue; // outside this wave.
      found.add(spec.id);

      expect(isSolved(spec, initialStateForTest(spec))).toBe(false);

      if (typedAnswer !== undefined) {
        // Drive the SAME mapping the renderer runs on every keystroke,
        // rather than asserting against a hand-built {predicted} object.
        const renderedState = functionMachineStateFromTypedAnswer(typedAnswer);
        expect(renderedState).not.toBeNull();
        expect(isSolved(spec, renderedState)).toBe(true);
        // An empty typed answer (mount state, before anything is typed)
        // never reads as solved either.
        expect(functionMachineStateFromTypedAnswer("")).toBeNull();
      } else {
        expect(isSolved(spec, solution)).toBe(true);
      }

      const wrongStates = WRONG_ARRAY_SOLUTIONS[spec.id];
      if (wrongStates) {
        for (const wrong of wrongStates) {
          expect(isSolved(spec, wrong)).toBe(false);
        }
      }
    }

    // Every wave-2 id was actually served from the seed (skillKey resolved to
    // a real knowledgeNodes row and the insert succeeded) — a typo'd id or a
    // silently-dropped entry fails here rather than passing vacuously.
    const allIds = [...Object.keys(WAVE2_SOLUTIONS), ...Object.keys(WAVE2_FUNCTION_MACHINE_TYPED_ANSWERS)];
    for (const id of allIds) {
      expect(found.has(id)).toBe(true);
    }
    expect(found.size).toBe(allIds.length);
  });

  test("every array id with a tightened goal has at least one locked-in wrong-state regression check", () => {
    // Guards the guard: if a future edit renames/removes one of the four
    // tightened array specs without updating WRONG_ARRAY_SOLUTIONS, this
    // fails loudly instead of the regression check silently vanishing.
    const tightenedIds = ["array-is-factor-6-of-24", "array-is-multiple-35-of-5", "array-factors-multiples-4x5", "array-square-number-4x4"];
    for (const id of tightenedIds) {
      expect(WRONG_ARRAY_SOLUTIONS[id]?.length).toBeGreaterThan(0);
    }
  });

  test("LCM and common-multiple seeds derive their first shared landing", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    await t.mutation(internal.practiceSkills.seedDefaultManipulativePractice, {});
    const rows = await t.run(async (ctx) => ctx.db.query("practiceItems").collect());
    const specs = rows
      .map((row) => parseManipulativeSpec(row.manipulativeSpec))
      .filter((spec): spec is ManipulativeSpec => spec != null);
    const lcm = specs.find((spec) => spec.id === "numberline-lcm-3-5");
    const common = specs.find((spec) => spec.id === "numberline-common-multiple-4-6");

    expect(lcm).toMatchObject({
      kind: "numberline",
      multipleTracks: [3, 5],
      goal: { type: "firstCommonMultiple" },
    });
    expect(common).toMatchObject({
      kind: "numberline",
      multipleTracks: [4, 6],
      goal: { type: "firstCommonMultiple" },
    });
    expect(lcm && isSolved(lcm, { value: 30 })).toBe(false);
    expect(common && isSolved(common, { value: 24 })).toBe(false);
  });
});
