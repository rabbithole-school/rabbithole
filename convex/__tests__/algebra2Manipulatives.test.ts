import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { internal } from "../_generated/api";
import { MANIPULATIVE_VERIFIER_KIND } from "../../lib/manipulative/practiceContract";
import { parseManipulativeSpec } from "../../lib/manipulative/grade";
import { assertGradableManipulative } from "../../lib/manipulative/authoring";
import { functionGraphTransformEquation, initialFunctionGraph } from "../../lib/manipulative/functionGraph";
import { describeState, goalText, initialCoordinatePlane, isSolved } from "../../lib/manipulative/logic";
import type { FunctionGraphSpec, ManipulativeSpec } from "../../lib/manipulative/types";
import { rationalValue, transformValue } from "../../shared/functionCurves";
import { ALGEBRA_2_DOMAIN, ALGEBRA_2_SKILLS } from "../seed/algebra2Graph";
import { ALGEBRA_2_MANIPULATIVE_TARGETS } from "../seed/algebra2Manipulatives";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

const EXPECTED_NODES = [
  "fn_transform_translate",
  "fn_transform_scale_reflect",
  "fn_transform_combined",
  "log_graph_inverse",
  "poly_sketch_factored",
  "rat_graph_asymptotes",
  "cx_plane_plot",
];

function initialState(spec: ManipulativeSpec): unknown {
  if (spec.kind === "functionGraph") return initialFunctionGraph(spec);
  if (spec.kind === "coordinatePlane") return initialCoordinatePlane(spec);
  throw new Error(`Unexpected kind ${spec.kind}`);
}

/** The board state a scholar who did it right ends with, built from the goal. */
function solution(spec: ManipulativeSpec): unknown {
  if (spec.kind === "coordinatePlane" && spec.goal?.type === "placePoint") {
    return { points: [{ x: spec.goal.x, y: spec.goal.y }] };
  }
  if (spec.kind !== "functionGraph") throw new Error(spec.kind);
  const g = spec.goal;
  if (g.type === "matchTransform") return { ...g.target };
  if (g.type === "placeZeros") {
    const degree = g.zeros.reduce((s, z) => s + z.multiplicity, 0);
    const rightUp = g.leading > 0;
    return {
      zeros: g.zeros.map((z) => ({ x: z.x, touch: z.multiplicity % 2 === 0 })),
      leftUp: degree % 2 === 0 ? rightUp : !rightUp,
      rightUp,
    };
  }
  return { vertical: [...g.rational.vertical], horizontal: g.rational.horizontal };
}

/** The slip each board is built to catch. */
function nearMiss(spec: ManipulativeSpec): unknown {
  if (spec.kind === "coordinatePlane" && spec.goal?.type === "placePoint") {
    const { x, y } = spec.goal;
    // Swapped coordinates, or (for a point on an axis) the wrong axis.
    return { points: [x !== y ? { x: y, y: x } : { x: -x, y }] };
  }
  if (spec.kind !== "functionGraph") throw new Error(spec.kind);
  const g = spec.goal;
  if (g.type === "matchTransform") {
    const t = g.target;
    // A left–right flip built as an upside-down one (f(−x) read as −f(x)),
    // else the horizontal-shift sign, else the reflection.
    if (t.b === -1) return { a: -t.a, h: t.h, k: t.k };
    return t.h !== 0 ? { ...t, h: -t.h } : { ...t, a: -t.a };
  }
  if (g.type === "placeZeros") {
    const good = solution(spec) as { zeros: Array<{ x: number; touch: boolean }>; leftUp: boolean; rightUp: boolean };
    // Every multiplicity read as a crossing (a triple zero is the trap the
    // other way round, so for those flip the leading sign instead).
    const anyBounce = good.zeros.some((z) => z.touch);
    return anyBounce
      ? { ...good, zeros: good.zeros.map((z) => ({ ...z, touch: false })) }
      : { ...good, rightUp: !good.rightUp, leftUp: !good.leftUp };
  }
  // A line at a hole: the cancelled factor treated as an asymptote.
  if ((g.rational.holes ?? []).length > 0) {
    return { vertical: [...g.rational.holes!], horizontal: g.rational.horizontal };
  }
  // A vertical asymptote at the factor's sign (x − 2 read as x = −2); for a
  // symmetric pair (x² − 4) that changes nothing, so miss the horizontal line.
  const flipped = g.rational.vertical.map((v) => -v);
  const symmetric = [...flipped].sort().join() === [...g.rational.vertical].sort().join();
  return symmetric
    ? { vertical: [...g.rational.vertical], horizontal: g.rational.horizontal + 1 }
    : { vertical: flipped, horizontal: g.rational.horizontal };
}

describe("algebra-2 default manipulatives", () => {
  test("6–12 specs per node, unique ids, every one gradable, unsolved at start, solvable, and not by its near miss", () => {
    const keys = new Set(ALGEBRA_2_SKILLS.map((s) => s.skillKey));
    const ids = ALGEBRA_2_MANIPULATIVE_TARGETS.map((t) => t.spec.id);
    expect(new Set(ids).size).toBe(ids.length);
    const perNode = new Map<string, number>();
    for (const { domain, skillKey, spec } of ALGEBRA_2_MANIPULATIVE_TARGETS) {
      expect(domain).toBe(ALGEBRA_2_DOMAIN);
      expect(keys.has(skillKey), skillKey).toBe(true);
      perNode.set(skillKey, (perNode.get(skillKey) ?? 0) + 1);
      expect(() => assertGradableManipulative(spec), spec.id).not.toThrow();
      expect(isSolved(spec, initialState(spec)), `${spec.id} starts solved`).toBe(false);
      expect(isSolved(spec, solution(spec)), `${spec.id} rejects its solution`).toBe(true);
      expect(isSolved(spec, nearMiss(spec)), `${spec.id} accepts its near miss`).toBe(false);
      expect(spec.prompt).not.toMatch(/undefined|NaN/);
      // Prompts are plain text on the iPad: "1/2x²" would read as 1/(2x²).
      expect(spec.prompt, spec.id).not.toMatch(/\d\/\d/);
    }
    expect([...perNode.keys()].sort()).toEqual([...EXPECTED_NODES].sort());
    for (const [key, n] of perNode) {
      expect(n, key).toBeGreaterThanOrEqual(6);
      expect(n, key).toBeLessThanOrEqual(12);
    }
  });

  test("translate items have a = 1; scale/reflect items have h = k = 0; combined items move all three", () => {
    for (const { skillKey, spec } of ALGEBRA_2_MANIPULATIVE_TARGETS) {
      if (spec.kind !== "functionGraph" || spec.goal.type !== "matchTransform") continue;
      const t = spec.goal.target;
      if (skillKey === "fn_transform_translate") expect(t.a, spec.id).toBe(1);
      if (skillKey === "fn_transform_scale_reflect") expect([t.h, t.k, t.a !== 1 || t.b === -1], spec.id).toEqual([0, 0, true]);
      if (skillKey === "fn_transform_combined") expect(t.a !== 1 && t.h !== 0 && t.k !== 0, spec.id).toBe(true);
    }
    const combinedParents = ALGEBRA_2_MANIPULATIVE_TARGETS.flatMap(({ skillKey, spec }) =>
      skillKey === "fn_transform_combined" && spec.kind === "functionGraph" && spec.goal.type === "matchTransform"
        ? [spec.goal.parent]
        : [],
    );
    expect(new Set(combinedParents)).toEqual(new Set(["quadratic", "abs", "sqrt", "cubic", "exp2", "log2", "reciprocal"]));
    // Mirror items exist for each parent where f(−x) differs from −f(x).
    const mirrored = ALGEBRA_2_MANIPULATIVE_TARGETS.flatMap(({ skillKey, spec }) =>
      skillKey === "fn_transform_scale_reflect" && spec.kind === "functionGraph" && spec.goal.type === "matchTransform" && spec.goal.target.b === -1
        ? [spec.goal.parent]
        : [],
    );
    expect(new Set(mirrored)).toEqual(new Set(["sqrt", "exp2", "log2"]));
  });

  test("every shape-the-graph board states its target rule in the prompt, or is flagged targetUnstated", () => {
    let flagged = 0;
    for (const { spec } of ALGEBRA_2_MANIPULATIVE_TARGETS) {
      if (spec.kind !== "functionGraph" || spec.goal.type !== "matchTransform") continue;
      const rule = functionGraphTransformEquation(spec.goal.parent, spec.goal.target);
      if (spec.goal.targetUnstated) {
        flagged += 1;
        // The tutor must not be handed the rule the scholar is working out.
        expect(spec.prompt, spec.id).not.toContain(rule);
        expect(goalText(spec), spec.id).not.toContain(rule);
        const start = describeState(spec, JSON.stringify(initialFunctionGraph(spec)));
        expect(start, spec.id).not.toContain(rule);
        expect(start, spec.id).not.toContain("equation in the prompt");
      } else {
        expect(spec.prompt, spec.id).toContain(rule);
      }
    }
    expect(flagged).toBe(5);
  });

  test("each 'shape the inverse' target really is the inverse of the function its prompt names", () => {
    // The function each prompt names, written out independently of the target.
    const named: Record<string, (x: number) => number> = {
      "fg-a2-log-inverse-of-exp-up-1": (x) => 2 ** x + 1,
      "fg-a2-log-inverse-of-exp-right-3": (x) => 2 ** (x - 3),
      "fg-a2-log-inverse-of-exp-left-1-down-2": (x) => 2 ** (x + 1) - 2,
      "fg-a2-exp-inverse-of-log-down-2": (x) => Math.log2(x) - 2,
      "fg-a2-exp-inverse-of-log-right-1": (x) => Math.log2(x - 1),
    };
    const byId = new Map(ALGEBRA_2_MANIPULATIVE_TARGETS.map((t) => [t.spec.id, t.spec]));
    for (const [id, f] of Object.entries(named)) {
      const spec = byId.get(id) as FunctionGraphSpec;
      expect(spec?.prompt, id).toMatch(/inverse of/);
      if (spec.goal.type !== "matchTransform") throw new Error(id);
      const { parent, target } = spec.goal;
      // f(inverse(y)) = y on inverse's domain, sampled.
      for (const y of [-0.5, 0.75, 1.5, 3, 4.5]) {
        const x = transformValue(parent, target, y);
        if (!Number.isFinite(x)) continue;
        expect(f(x), `${id} at ${y}`).toBeCloseTo(y, 9);
      }
    }
  });

  test("each asymptote board's rational form equals the rule its prompt states", () => {
    const rules: Record<string, (x: number) => number> = {
      "fg-a2-asym-shifted-reciprocal": (x) => 1 / (x - 2) + 3,
      "fg-a2-asym-2x-plus-1-over-x-minus-1": (x) => (2 * x + 1) / (x - 1),
      "fg-a2-asym-3x-over-x-plus-2": (x) => (3 * x) / (x + 2),
      "fg-a2-asym-x-minus-4-over-x-plus-1": (x) => (x - 4) / (x + 1),
      "fg-a2-asym-two-factors": (x) => 4 / ((x - 1) * (x + 3)),
      "fg-a2-asym-2-over-x-sq-minus-4": (x) => 2 / (x * x - 4),
      "fg-a2-asym-2x-sq-plus-1-over-x-sq-minus-1": (x) => (2 * x * x + 1) / (x * x - 1),
      "fg-a2-asym-quadratic-over-quadratic": (x) => (x * x - 2 * x - 1) / (x * x - 2 * x - 3),
      "fg-a2-asym-hole-at-1": (x) => (x - 1) / (x * x + x - 2),
      "fg-a2-asym-hole-at-3": (x) => (x * x - x - 6) / (x * x - 4 * x + 3),
    };
    for (const { skillKey, spec } of ALGEBRA_2_MANIPULATIVE_TARGETS) {
      if (skillKey !== "rat_graph_asymptotes") continue;
      const rule = rules[spec.id];
      expect(rule, spec.id).toBeDefined();
      if (spec.kind !== "functionGraph" || spec.goal.type !== "placeAsymptotes") throw new Error(spec.id);
      for (const x of [-5.5, -2.5, 0.3, 1.7, 4.2, 9.1]) {
        expect(rationalValue(spec.goal.rational, x), `${spec.id} at ${x}`).toBeCloseTo(rule(x), 9);
      }
    }
  });

  test("seeding lands every spec on its Algebra 2 node", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    await t.mutation(internal.practiceSkills.seedDefaultManipulativePractice, {});
    const rows = await t.run(async (ctx) => ctx.db.query("practiceItems").collect());
    const seeded = new Map<string, string>();
    for (const row of rows) {
      if (row.verifierKind !== MANIPULATIVE_VERIFIER_KIND) continue;
      const spec = parseManipulativeSpec(row.manipulativeSpec);
      if (spec) seeded.set(spec.id, row.skillKey);
    }
    for (const { skillKey, spec } of ALGEBRA_2_MANIPULATIVE_TARGETS) {
      expect(seeded.get(spec.id), spec.id).toBe(skillKey);
    }
  });
});
