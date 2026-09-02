import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { internal } from "../_generated/api";
import { MANIPULATIVE_VERIFIER_KIND } from "../../lib/manipulative/practiceContract";
import { parseManipulativeSpec } from "../../lib/manipulative/grade";
import type { ManipulativeSpec } from "../../lib/manipulative/types";
import { initialPlaceValue, isSolved } from "../../lib/manipulative/logic";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

/**
 * Content-coverage wave 4 (2026-08-04): the 9 place-value nodes wave 1 skipped
 * as having "no honest existing-kind fit," now covered by the NEW `placeValue`
 * manipulative kind. Same two invariants every wave locks, keyed by spec `id`:
 *
 *   1. NOT pre-solved — the mount state (what a scholar first sees) fails
 *      `isSolved`. A manipulative must never hand out a puzzle already done.
 *   2. Solvable by construction — the intended solution state (the canonical
 *      base-ten decomposition, or the shifted number for placeShift) makes
 *      `isSolved` return true, exercising the exact pure grader
 *      `gradeManipulativeSubmission` runs server-side.
 *
 * The intended-solution state is the `{counts}` the renderer would report once
 * the scholar has built the number (buildNumber/expandedForm) or slid the
 * digits to the target (placeShift).
 */
const WAVE4_SOLUTIONS: Record<string, { counts: number[] }> = {
  // buildNumber
  "placevalue-tens-ones-47": { counts: [4, 7] },
  "placevalue-hundreds-tens-ones-437": { counts: [4, 3, 7] },
  "placevalue-multidigit-build-34125": { counts: [3, 4, 1, 2, 5] },
  "placevalue-expanded-to-standard-682": { counts: [6, 8, 2] },
  "placevalue-number-name-253": { counts: [2, 5, 3] },
  // expandedForm
  "placevalue-expanded-3digit-347": { counts: [3, 4, 7] },
  "placevalue-expanded-multidigit-5208": { counts: [5, 2, 0, 8] },
  // placeShift
  "placevalue-shift-relationship-5-to-50": { counts: [0, 5, 0] },
  "placevalue-powers-of-ten-43-x100": { counts: [0, 4, 3, 0, 0] },
};

/**
 * The previously-tempting WRONG states for two buildValue specs: a regrouped
 * total that sums to the target but isn't the standard single-digit form (the
 * `placeValueSolved` canonical guard must reject it).
 */
const WRONG_BUILD_SOLUTIONS: Record<string, { counts: number[] }[]> = {
  // 437 = 3 hundreds + 13 tens + 7 ones sums right but isn't canonical.
  "placevalue-hundreds-tens-ones-437": [{ counts: [3, 13, 7] }, { counts: [4, 3, 8] }],
  // 47 = 3 tens + 17 ones sums right but isn't canonical.
  "placevalue-tens-ones-47": [{ counts: [3, 17] }],
};

describe("content-coverage wave 4 — placeValue default manipulative seed", () => {
  test("every wave-4 placeValue spec is not pre-solved, and its intended solution passes isSolved", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    await t.mutation(internal.practiceSkills.seedDefaultManipulativePractice, {});

    const rows = await t.run(async (ctx) => ctx.db.query("practiceItems").collect());
    const manipRows = rows.filter((r) => r.verifierKind === MANIPULATIVE_VERIFIER_KIND);

    const found = new Set<string>();
    for (const row of manipRows) {
      const spec = parseManipulativeSpec(row.manipulativeSpec) as ManipulativeSpec | null;
      if (!spec || spec.kind !== "placeValue") continue;
      const solution = WAVE4_SOLUTIONS[spec.id];
      if (!solution) continue; // outside this wave (defensive — all placeValue specs are wave 4)
      found.add(spec.id);

      // 1. never pre-solved on mount.
      expect(isSolved(spec, initialPlaceValue(spec))).toBe(false);
      // 2. solvable by construction with the intended state.
      expect(isSolved(spec, solution)).toBe(true);

      for (const wrong of WRONG_BUILD_SOLUTIONS[spec.id] ?? []) {
        expect(isSolved(spec, wrong)).toBe(false);
      }
    }

    // Every wave-4 id was actually served (skillKey resolved + insert succeeded).
    for (const id of Object.keys(WAVE4_SOLUTIONS)) {
      expect(found.has(id)).toBe(true);
    }
    expect(found.size).toBe(Object.keys(WAVE4_SOLUTIONS).length);
  });

  test("every buildValue id with a canonical-form guard keeps a locked-in wrong-state check", () => {
    for (const id of Object.keys(WRONG_BUILD_SOLUTIONS)) {
      expect(WRONG_BUILD_SOLUTIONS[id]?.length).toBeGreaterThan(0);
      expect(WAVE4_SOLUTIONS[id]).toBeDefined();
    }
  });
});
