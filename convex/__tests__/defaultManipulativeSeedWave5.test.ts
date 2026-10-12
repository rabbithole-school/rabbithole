import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { internal } from "../_generated/api";
import { MANIPULATIVE_VERIFIER_KIND } from "../../lib/manipulative/practiceContract";
import { parseManipulativeSpec } from "../../lib/manipulative/grade";
import {
  functionMachineStateFromTypedAnswer,
  initialArray,
  initialClock,
  initialCoordinatePlane,
  initialFunctionMachine,
  isSolved,
} from "../../lib/manipulative/logic";
import type { ManipulativeSpec } from "../../lib/manipulative/types";
import { ALGEBRA_1_DOMAIN } from "../seed/algebra1Graph";
import { DISCRETE_MATH_DOMAIN } from "../seed/discreteMathGraph";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

/**
 * Content-coverage wave 5 (TRA-96): the first manipulatives on `algebra-1`
 * beyond `lin_fn_interpret_context`, and the first on `discrete-math` at all.
 * Same two invariants as every prior wave, locked per spec `id`:
 *
 *   1. NOT pre-solved — the kind-appropriate initial state fails `isSolved`.
 *   2. Solvable by construction — the intended solution (the numbers the
 *      prompt actually asks for) passes the same pure grader the server runs.
 *
 * Plus a near-miss lock per item where the wave's honesty argument depends on
 * it (see the seed comments in `convex/practiceSkills.ts`): a 1×169 strip is
 * not a square root, a 1×6 strip is not "one row per letter", a 1×14 strip
 * does not show pairing, a point on only ONE of the system's lines is not a
 * solution, the parallel-not-perpendicular landing spot, and the
 * reciprocal-without-sign-flip slope.
 */
type Fixture = { domain: string; skillKey: string; solution: unknown; nearMiss?: unknown };

const FIXTURES: Record<string, Fixture> = {
  "function-machine-line-through-2-7-and-5-16": {
    domain: ALGEBRA_1_DOMAIN,
    skillKey: "lin_fn_from_two_points",
    solution: functionMachineStateFromTypedAnswer("28"),
    // The "+9 per row" misread (16 − 7 = 9 applied once more from x = 5).
    nearMiss: functionMachineStateFromTypedAnswer("25"),
  },
  "coordinate-plot-y-equals-2x-minus-3": {
    domain: ALGEBRA_1_DOMAIN,
    skillKey: "slope_intercept_form",
    solution: { points: [{ x: 3, y: 3 }, { x: -2, y: -7 }, { x: 0, y: -3 }] },
    // Reading b as +3 instead of −3 shifts every point up by 6.
    nearMiss: { points: [{ x: -2, y: -1 }, { x: 0, y: 3 }, { x: 3, y: 9 }] },
  },
  "coordinate-system-x-plus-1-and-5-minus-x": {
    domain: ALGEBRA_1_DOMAIN,
    skillKey: "sys_solve_graphing",
    solution: { points: [{ x: 2, y: 3 }] },
    // On y = x + 1 only.
    nearMiss: { points: [{ x: 3, y: 4 }] },
  },
  "coordinate-perpendicular-from-ab-slope-2-3": {
    domain: ALGEBRA_1_DOMAIN,
    skillKey: "lin_fn_parallel_perpendicular",
    solution: { points: [{ x: 6, y: 0 }] },
    // Reciprocal slope 3/2 from B without the sign flip: (6, 6).
    nearMiss: { points: [{ x: 6, y: 6 }] },
  },
  "coordinate-vertex-form-x-minus-2-sq-minus-4": {
    domain: ALGEBRA_1_DOMAIN,
    skillKey: "quad_vertex_form",
    solution: { points: [{ x: 0, y: 0 }, { x: 2, y: -4 }, { x: 4, y: 0 }] },
    // Vertex sign error: (−2, −4) with intercepts to match.
    nearMiss: { points: [{ x: -2, y: -4 }, { x: 0, y: 0 }, { x: -4, y: 0 }] },
  },
  "array-square-root-169": {
    domain: ALGEBRA_1_DOMAIN,
    skillKey: "roots_square_cube",
    solution: { rows: 13, cols: 13 },
    nearMiss: { rows: 1, cols: 169 },
  },
  "array-codes-3-letters-times-2-digits": {
    domain: DISCRETE_MATH_DOMAIN,
    skillKey: "count_organized_count",
    solution: { rows: 3, cols: 2 },
    nearMiss: { rows: 1, cols: 6 },
  },
  "array-shirts-4-colors-times-3-sizes": {
    domain: DISCRETE_MATH_DOMAIN,
    skillKey: "multiplication_principle",
    solution: { rows: 3, cols: 4 },
    nearMiss: { rows: 2, cols: 6 },
  },
  "array-even-14-two-equal-rows": {
    domain: DISCRETE_MATH_DOMAIN,
    skillKey: "nt_parity_classify",
    solution: { rows: 2, cols: 7 },
    nearMiss: { rows: 1, cols: 14 },
  },
  "clock-mod-12-from-5-advance-31-hours": {
    domain: DISCRETE_MATH_DOMAIN,
    skillKey: "nt_modular_clock",
    // 5:00 + 31 h = 36:00 ≡ 12:00 — dial minute 0 (or any full-turn alias).
    solution: { minutes: 0 },
    // Stopping after "31 − 24 = 7 hours" without accounting for the 5:00 start.
    nearMiss: { minutes: 7 * 60 },
  },
};

const WAVE5_SPEC_IDS = new Set(Object.keys(FIXTURES));

function initialState(spec: ManipulativeSpec): unknown {
  switch (spec.kind) {
    case "functionMachine":
      return initialFunctionMachine();
    case "coordinatePlane":
      return initialCoordinatePlane(spec);
    case "array":
      return initialArray(spec);
    case "clock":
      return initialClock(spec);
    default:
      throw new Error(`Unexpected wave-5 kind: ${spec.kind}`);
  }
}

describe("default manipulative content wave 5 (algebra-1 + discrete-math)", () => {
  test("every wave-5 spec lands on its node, starts unsolved, accepts its solution, rejects its near miss", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    await t.mutation(internal.practiceSkills.seedDefaultManipulativePractice, {});

    const rows = await t.run(async (ctx) => ctx.db.query("practiceItems").collect());
    const authored = new Map<string, { skillKey: string; spec: ManipulativeSpec }>();
    const seenIds: string[] = [];
    for (const row of rows) {
      if (row.verifierKind !== MANIPULATIVE_VERIFIER_KIND) continue;
      const spec = parseManipulativeSpec(row.manipulativeSpec);
      if (!spec || !WAVE5_SPEC_IDS.has(spec.id)) continue;
      seenIds.push(spec.id);
      authored.set(spec.id, { skillKey: row.skillKey, spec });
    }
    expect(
      seenIds.filter((id, i) => seenIds.indexOf(id) !== i),
      "duplicate wave-5 spec ids were seeded",
    ).toEqual([]);

    const nodes = await t.run(async (ctx) => ctx.db.query("knowledgeNodes").collect());
    const domainOf = new Map(nodes.map((n) => [n.nodeKey, n.domain]));

    for (const [id, fixture] of Object.entries(FIXTURES)) {
      const found = authored.get(id);
      expect(found, `${id} was not seeded`).toBeDefined();
      expect(found!.skillKey).toBe(fixture.skillKey);
      expect(domainOf.get(found!.skillKey), `${id} is on a node outside its domain`).toBe(fixture.domain);
      expect(isSolved(found!.spec, initialState(found!.spec)), `${id} starts already solved`).toBe(false);
      expect(isSolved(found!.spec, fixture.solution), `${id} rejected its intended solution`).toBe(true);
      if (fixture.nearMiss !== undefined) {
        expect(isSolved(found!.spec, fixture.nearMiss), `${id} accepted a near miss`).toBe(false);
      }
    }

    const counts = { functionMachine: 0, coordinatePlane: 0, array: 0, clock: 0 };
    for (const { spec } of authored.values()) {
      if (spec.kind in counts) counts[spec.kind as keyof typeof counts]++;
    }
    expect(counts).toEqual({ functionMachine: 1, coordinatePlane: 4, array: 4, clock: 1 });
  });
});
