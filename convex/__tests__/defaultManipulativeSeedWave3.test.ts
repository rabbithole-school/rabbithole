import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { internal } from "../_generated/api";
import { MANIPULATIVE_VERIFIER_KIND } from "../../lib/manipulative/practiceContract";
import { parseManipulativeSpec } from "../../lib/manipulative/grade";
import type { ManipulativeSpec } from "../../lib/manipulative/types";
import { isSolved, initialNumberLine, initialPartition } from "../../lib/manipulative/logic";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

/**
 * Content-coverage wave 3 (review/content-coverage-audit.md, the
 * fraction-arithmetic strands that made the refreshed top-12 gap table:
 * rank 3 `operations` — all 9 K-6 nodes, rank 10 `concept` — its 4 remaining
 * uncovered nodes, rank 12 `decimals` — all 6 nodes): `seedDefaultManipulativePractice`
 * (convex/practiceSkills.ts) authors a default manipulative for these
 * fraction-arithmetic nodes. Same two invariants as waves 1-2, locked per
 * spec `id`:
 *
 *   1. NOT pre-solved — the kind-appropriate initial state (what a scholar
 *      actually sees on mount) must fail `isSolved`. A manipulative must
 *      never hand out a puzzle that's already done.
 *   2. Solvable by construction — the INTENDED solution state (the concrete
 *      numbers baked into the prompt) makes `isSolved` return true, exercising
 *      the exact same pure grader `gradeManipulativeSubmission` runs
 *      server-side.
 *
 * Post-review revision (findings 6+7, 2026-08-04): most operation seeds
 * originally placed a numberline handle at a bare precomputed value — a
 * typed-answer entry wearing a manipulative costume. Every operation entry
 * is now either RESPEC'd so the interaction genuinely acts out the
 * operation, or SKIPPED with a documented reason (see the per-item comments
 * in `convex/practiceSkills.ts`):
 *   • addition/subtraction (`add_subtract_like`, `add_subtract_mixed_like`,
 *     `add_subtract_unlike`, `add_subtract_decimals`) — a JUMP model: the
 *     numberline's `start` is now the FIRST OPERAND (never 0), so the
 *     intended solution's landing value differs from `spec.start` and the
 *     drag itself performs the operation.
 *   • `multiply_fraction_by_whole` — tick spacing equals the unit-fraction
 *     size, so counting ticks from 0 IS counting groups.
 *   • `decompose_fraction` — TWO discs, each with its OWN required value via
 *     `partition`'s new `partsEqual` goal (not one disc graded on the
 *     combined total) — the decomposition itself is what's graded.
 *   • `divide_unit_fractions`, `fraction_scaling`, `multiply_fractions` —
 *     switched from `numberline` to `partition`'s disc re-subdivision: the
 *     intended solution has a DIFFERENT part count than the initial disc,
 *     so simply "shading the right area of the given disc" can't pass —
 *     the disc must actually be re-cut.
 *   • `divide_fractions`, `multiply_decimals`, `divide_decimals` — no
 *     existing kind honestly models these (a whole-number quotient/count
 *     doesn't fit `partition`'s bounded 0..1 disc, and a non-whole number of
 *     repeated groups doesn't fit a tick-counting `numberline`), so they
 *     were REMOVED from the seed rather than shipped as fancy input boxes.
 *     `WAVE3_SOLUTIONS` has no entries for their old ids, and this suite
 *     asserts they are NOT served.
 *
 * Two additional regression locks specific to this wave's precision-sensitive
 * decimal/decomposition items: `compare_decimals` places 0.62 against a
 * marked-but-wrong 0.6, `decimal_place_value_round` places a rounded 3.14
 * against neighboring marked-but-wrong candidates (3.13, 3.15, and the
 * unrounded 3.14159), and `decompose_fraction` must reject shading the
 * combined total onto a SINGLE disc (the exact flaw the review cut) —
 * `WAVE3_WRONG_SOLUTIONS` locks in that none of these decoys read as solved.
 */
const WAVE3_SOLUTIONS: Record<string, unknown> = {
  // fraction-arithmetic — operations: numberline jump/tick models + partition
  // disc-subdivision models. `divide_fractions` was removed (skip-with-reason).
  "numberline-add-subtract-like-3-8-plus-2-8": { value: 0.625 },
  "numberline-add-subtract-mixed-like-3-14-minus-1-34": { value: 1.5 },
  "partition-decompose-5-8-into-3-8-plus-2-8": {
    discs: [
      { parts: 8, shaded: 3 },
      { parts: 8, shaded: 2 },
    ],
  },
  "numberline-multiply-fraction-by-whole-3x1-4": { value: 0.75 },
  "numberline-add-subtract-unlike-half-plus-third": { value: 5 / 6 },
  "partition-divide-unit-fractions-third-div-2": { discs: [{ parts: 6, shaded: 1 }] },
  "partition-fraction-scaling-half-of-three-fourths": { discs: [{ parts: 12, shaded: 6 }] },
  "partition-multiply-fractions-two-thirds-times-three-fifths": { discs: [{ parts: 15, shaded: 6 }] },

  // fraction-arithmetic — concept: the 4 nodes left uncovered after
  // partition_shapes/fraction_number_line/fraction_as_parts.
  "partition-unit-fraction-one-fourth": { discs: [{ parts: 4, shaded: 1 }] },
  "numberline-whole-as-fraction-4-4": { value: 1 },
  "numberline-mixed-improper-7-4": { value: 1.75 },
  "numberline-fraction-as-division-3-div-4": { value: 0.75 },

  // fraction-arithmetic — decimals: `multiply_decimals` and `divide_decimals`
  // were removed (skip-with-reason).
  "numberline-compare-decimals-062-vs-06": { value: 0.62 },
  "numberline-decimal-notation-fractions-25-100": { value: 0.25 },
  "numberline-add-subtract-decimals-235-plus-147": { value: 3.82 },
  "numberline-decimal-round-314159-nearest-hundredth": { value: 3.14 },
};

/** Old ids from the removed skip-with-reason items — must NOT be served. */
const WAVE3_REMOVED_IDS = [
  "numberline-divide-fractions-two-thirds-div-one-sixth",
  "numberline-multiply-decimals-06-times-07",
  "numberline-divide-decimals-45-div-05",
];

/**
 * Decoy states locked in as regressions: each is a plausible-looking but
 * WRONG state that must NOT read as solved.
 */
const WAVE3_WRONG_SOLUTIONS: Record<string, unknown[]> = {
  // "place 0.62" — landing on the marked decoy 0.6 must not pass.
  "numberline-compare-decimals-062-vs-06": [{ value: 0.6 }],
  // "round to 3.14" — landing on any neighboring marked candidate (the
  // unrounded original, or either adjacent hundredth) must not pass.
  "numberline-decimal-round-314159-nearest-hundredth": [
    { value: 3.14159 },
    { value: 3.13 },
    { value: 3.15 },
  ],
  // The exact flaw finding (7) cut: shading the COMBINED total (5/8) onto a
  // single disc while the other disc stays empty must NOT read as solved —
  // both distinct parts (3/8 and 2/8) must be built.
  "partition-decompose-5-8-into-3-8-plus-2-8": [
    { discs: [{ parts: 8, shaded: 5 }, { parts: 8, shaded: 0 }] },
    { discs: [{ parts: 8, shaded: 0 }, { parts: 8, shaded: 5 }] },
  ],
};

function initialStateForTest(spec: ManipulativeSpec): unknown {
  switch (spec.kind) {
    case "numberline":
      return initialNumberLine(spec);
    case "partition":
      return initialPartition(spec);
    default:
      throw new Error(`content-coverage wave 3 fixture used an unexpected kind: ${spec.kind}`);
  }
}

describe("content-coverage wave 3 — default manipulative seed (fraction-arithmetic)", () => {
  test("every wave-3 spec is not pre-solved, and its intended solution passes isSolved", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    await t.mutation(internal.practiceSkills.seedDefaultManipulativePractice, {});

    const rows = await t.run(async (ctx) => ctx.db.query("practiceItems").collect());
    const manipRows = rows.filter((r) => r.verifierKind === MANIPULATIVE_VERIFIER_KIND);

    const found = new Set<string>();
    const servedIds = new Set<string>();
    for (const row of manipRows) {
      const spec = parseManipulativeSpec(row.manipulativeSpec);
      if (!spec) continue;
      servedIds.add(spec.id);

      const solution = WAVE3_SOLUTIONS[spec.id];
      if (solution === undefined) continue; // outside this wave.
      found.add(spec.id);

      expect(isSolved(spec, initialStateForTest(spec))).toBe(false);
      expect(isSolved(spec, solution)).toBe(true);

      const wrongStates = WAVE3_WRONG_SOLUTIONS[spec.id];
      if (wrongStates) {
        for (const wrong of wrongStates) {
          expect(isSolved(spec, wrong)).toBe(false);
        }
      }
    }

    // Every wave-3 id was actually served from the seed (skillKey resolved to
    // a real knowledgeNodes row and the insert succeeded) — a typo'd id or a
    // silently-dropped entry fails here rather than passing vacuously.
    const allIds = Object.keys(WAVE3_SOLUTIONS);
    for (const id of allIds) {
      expect(found.has(id)).toBe(true);
    }
    expect(found.size).toBe(allIds.length);

    // The skip-with-reason items must genuinely be gone from the seed, not
    // just absent from this test's expectations.
    for (const removedId of WAVE3_REMOVED_IDS) {
      expect(servedIds.has(removedId)).toBe(false);
    }
  });

  test("every precision-sensitive decimal/decomposition id has at least one locked-in decoy-state regression check", () => {
    // Guards the guard: if a future edit renames/removes one of these
    // tightened specs without updating WAVE3_WRONG_SOLUTIONS, this fails
    // loudly instead of the regression check silently vanishing.
    const tightenedIds = [
      "numberline-compare-decimals-062-vs-06",
      "numberline-decimal-round-314159-nearest-hundredth",
      "partition-decompose-5-8-into-3-8-plus-2-8",
    ];
    for (const id of tightenedIds) {
      expect(WAVE3_WRONG_SOLUTIONS[id]?.length).toBeGreaterThan(0);
    }
  });
});
