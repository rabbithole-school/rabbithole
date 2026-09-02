import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { internal } from "../_generated/api";
import { MANIPULATIVE_VERIFIER_KIND } from "../../lib/manipulative/practiceContract";
import { parseManipulativeSpec } from "../../lib/manipulative/grade";
import {
  initialBalance,
  initialCoordinatePlane,
  initialGeoLocate,
  initialRiemann,
  isSolved,
} from "../../lib/manipulative/logic";
import type { GeoLocateSpec, ManipulativeSpec } from "../../lib/manipulative/types";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

type Fixture = {
  skillKey: string;
  solution: unknown;
};

const FIXTURES: Record<string, Fixture> = {
  "balance-equal-4-and-8": { skillKey: "compare_within_10", solution: { left: 4, right: 4 } },
  "balance-mystery-block-6": { skillKey: "expr_variable_meaning", solution: { left: 6, right: 0 } },
  "balance-missing-addend-3-to-10": { skillKey: "eq_unknown_in_arithmetic", solution: { left: 10, right: 10 } },
  "balance-make-equation-true-8": { skillKey: "eq_solution_meaning", solution: { left: 8, right: 8 } },
  "balance-test-7-against-9": { skillKey: "eq_test_solution", solution: { left: 9, right: 9 } },
  "balance-solve-5-plus-x-equals-12": { skillKey: "eq_one_step_add_sub", solution: { left: 12, right: 12 } },

  "coordinate-across-3-up-2": { skillKey: "ordered_pair_meaning", solution: { points: [{ x: 3, y: 2 }] } },
  "coordinate-first-quadrant-5-4": { skillKey: "coordinate_plane_first_quadrant", solution: { points: [{ x: 5, y: 4 }] } },
  "coordinate-three-four-quadrant-points": {
    skillKey: "four_quadrant_plane",
    solution: { points: [{ x: 2, y: -5 }, { x: -3, y: -2 }, { x: -4, y: 3 }] },
  },
  "coordinate-reflect-3-2-across-x": { skillKey: "reflect_across_axis", solution: { points: [{ x: 3, y: -2 }] } },
  "coordinate-reflect-neg2-4-across-y": { skillKey: "reflect_across_axis", solution: { points: [{ x: 2, y: 4 }] } },
  "coordinate-complete-rectangle-neg4-3": { skillKey: "coordinate_missing_vertex", solution: { points: [{ x: 3, y: 4 }] } },
  "coordinate-seven-right-from-neg3-2": { skillKey: "coordinate_distance", solution: { points: [{ x: 4, y: 2 }] } },
  "coordinate-rational-neg1p5-2p5": { skillKey: "rational_coordinate_pairs", solution: { points: [{ x: -1.5, y: 2.5 }] } },

  "riemann-rover-1-plus-2t": { skillKey: "lin_fn_interpret_context", solution: { bars: 8 } },
  "riemann-drone-2-plus-t": { skillKey: "lin_fn_interpret_context", solution: { bars: 10 } },
  "riemann-runner-1-plus-half-t": { skillKey: "lin_fn_interpret_context", solution: { bars: 16 } },
  "riemann-train-3-plus-3t": { skillKey: "lin_fn_interpret_context", solution: { bars: 8 } },
  "riemann-sled-2-plus-1p5t": { skillKey: "lin_fn_interpret_context", solution: { bars: 18 } },
};

const NEAR_MISSES: Record<string, unknown> = {
  "coordinate-reflect-3-2-across-x": { points: [{ x: -3, y: 2 }] },
  "coordinate-reflect-neg2-4-across-y": { points: [{ x: -2, y: -4 }] },
  "coordinate-complete-rectangle-neg4-3": { points: [{ x: 3, y: -1 }] },
  "coordinate-seven-right-from-neg3-2": { points: [{ x: 3, y: 2 }] },
  "coordinate-rational-neg1p5-2p5": { points: [{ x: -1.5, y: 2 }] },
  "riemann-rover-1-plus-2t": { bars: 7 },
  "riemann-drone-2-plus-t": { bars: 9 },
  "riemann-runner-1-plus-half-t": { bars: 15 },
  "riemann-train-3-plus-3t": { bars: 7 },
  "riemann-sled-2-plus-1p5t": { bars: 17 },
};

const GEO_SKILLS: Record<string, string> = {
  "geo-route-honolulu-hilo-quarter": "rate_constant_speed",
  "geo-route-seattle-san-diego-two-fifths": "rate_constant_speed",
  "geo-route-la-new-york-four-sixths": "ratio_equivalent_scale",
};

const CONTENT_WAVE_SPEC_IDS = new Set([...Object.keys(FIXTURES), ...Object.keys(GEO_SKILLS)]);

function initialState(spec: ManipulativeSpec): unknown {
  switch (spec.kind) {
    case "balance":
      return initialBalance(spec);
    case "coordinatePlane":
      return initialCoordinatePlane(spec);
    case "riemann":
      return initialRiemann(spec);
    case "geoLocate":
      return initialGeoLocate();
    default:
      throw new Error(`Unexpected content-wave kind: ${spec.kind}`);
  }
}

function geoSolution(spec: GeoLocateSpec): unknown {
  const task = spec.map.task;
  if (task.kind !== "locate") throw new Error(`Expected locate task for ${spec.id}`);
  return { pins: [{ id: "answer", lngLat: task.target }] };
}

describe("default manipulative content wave", () => {
  test("every authored spec lands on its real node, starts unsolved, and accepts its intended solution", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    await t.mutation(internal.practiceSkills.seedDefaultManipulativePractice, {});

    const rows = await t.run(async (ctx) => ctx.db.query("practiceItems").collect());
    const matched: Array<{ skillKey: string; spec: ManipulativeSpec }> = [];
    for (const row of rows) {
      if (row.verifierKind !== MANIPULATIVE_VERIFIER_KIND) continue;
      const spec = parseManipulativeSpec(row.manipulativeSpec);
      if (!spec) continue;
      if (CONTENT_WAVE_SPEC_IDS.has(spec.id)) {
        matched.push({ skillKey: row.skillKey, spec });
      }
    }

    const duplicateSpecIds = matched
      .map(({ spec }) => spec.id)
      .filter((id, index, ids) => ids.indexOf(id) !== index);
    expect(duplicateSpecIds, "duplicate content-wave spec ids were seeded").toEqual([]);

    const authored = new Map(matched.map(({ skillKey, spec }) => [spec.id, { skillKey, spec }]));

    for (const [id, fixture] of Object.entries(FIXTURES)) {
      const found = authored.get(id);
      expect(found, `${id} was not seeded`).toBeDefined();
      expect(found!.skillKey).toBe(fixture.skillKey);
      expect(isSolved(found!.spec, initialState(found!.spec))).toBe(false);
      expect(isSolved(found!.spec, fixture.solution), `${id} rejected its intended solution`).toBe(true);
      const nearMiss = NEAR_MISSES[id];
      if (nearMiss !== undefined) {
        expect(isSolved(found!.spec, nearMiss), `${id} accepted a near miss`).toBe(false);
      }
    }

    for (const [id, skillKey] of Object.entries(GEO_SKILLS)) {
      const found = authored.get(id);
      expect(found, `${id} was not seeded`).toBeDefined();
      expect(found!.skillKey).toBe(skillKey);
      expect(found!.spec.kind).toBe("geoLocate");
      expect(isSolved(found!.spec, initialState(found!.spec))).toBe(false);
      expect(isSolved(found!.spec, geoSolution(found!.spec as GeoLocateSpec))).toBe(true);
      const task = (found!.spec as GeoLocateSpec).map.task;
      if (task.kind !== "locate") throw new Error(`Expected locate task for ${id}`);
      const startMarker = (found!.spec as GeoLocateSpec).map.markers?.[0];
      expect(startMarker).toBeDefined();
      expect(
        isSolved(found!.spec, { pins: [{ id: "wrong-endpoint", lngLat: startMarker!.lngLat }] }),
        `${id} accepted the route's start point`,
      ).toBe(false);
    }

    const counts = { balance: 0, coordinatePlane: 0, riemann: 0, geoLocate: 0 };
    for (const { spec } of authored.values()) {
      if (spec.kind in counts) counts[spec.kind as keyof typeof counts]++;
    }
    expect(counts).toEqual({ balance: 6, coordinatePlane: 8, riemann: 5, geoLocate: 3 });
  });
});
