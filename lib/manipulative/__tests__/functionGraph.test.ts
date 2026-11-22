import { describe, expect, it } from "vitest";

import {
  FUNCTION_GRAPH_A_VALUES,
  FUNCTION_GRAPH_HANDLES,
  FUNCTION_GRAPH_PARENTS,
  FUNCTION_GRAPH_LANDSCAPE_BOARD_HEIGHT,
  FUNCTION_GRAPH_TRAY_HINT,
  functionGraphAnchorLabel,
  functionGraphFlipOffered,
  functionGraphTickLabels,
  functionGraphTraySlot,
  functionGraphFlip,
  functionGraphDropZero,
  functionGraphGoalIsUsable,
  functionGraphHandles,
  functionGraphInitialSlots,
  functionGraphLayout,
  functionGraphMoveAnchor,
  functionGraphPolynomialEquation,
  functionGraphRationalEquation,
  functionGraphSetScale,
  functionGraphSketchInput,
  functionGraphTargetEnds,
  functionGraphToMath,
  functionGraphToPx,
  functionGraphTransformEquation,
  functionGraphTransformsEquivalent,
  functionGraphZerosState,
  initialFunctionGraph,
} from "../functionGraph";
import { FUNCTION_GRAPH_EXAMPLES } from "../functionGraphExamples";
import { assertGradableManipulative, assertRenderableManipulative } from "../authoring";
import { describeState, goalText, isSolved } from "../logic";
import { gradeManipulativeSubmission } from "../grade";
import { validateManipulativeSpec } from "../validate";
import type { FunctionGraphSpec } from "../types";
import {
  FUNCTION_PARENTS,
  parentValue,
  polynomialSketchCurve,
  rationalCurve,
  sampleCurve,
  transformCurve,
  transformValue,
} from "../../../shared/functionCurves";

const WINDOW = { xMin: -6, xMax: 6, yMin: -6, yMax: 6 };

const absSpec: FunctionGraphSpec = {
  kind: "functionGraph",
  id: "t-abs",
  concept: "Transforming |x|",
  prompt: "Shape the graph of y = −2|x − 3| + 1.",
  ...WINDOW,
  goal: { type: "matchTransform", parent: "abs", target: { a: -2, h: 3, k: 1 } },
};

const zerosSpec: FunctionGraphSpec = {
  kind: "functionGraph",
  id: "t-zeros",
  concept: "Zeros",
  prompt: "Sketch y = −(x − 1)²(x + 3).",
  ...WINDOW,
  goal: {
    type: "placeZeros",
    zeros: [
      { x: 1, multiplicity: 2 },
      { x: -3, multiplicity: 1 },
    ],
    leading: -1,
  },
};

const asymSpec: FunctionGraphSpec = {
  kind: "functionGraph",
  id: "t-asym",
  concept: "Asymptotes",
  prompt: "Find the asymptotes of y = 4/((x − 1)(x + 2)) − 1.",
  ...WINDOW,
  goal: { type: "placeAsymptotes", rational: { vertical: [1, -2], horizontal: -1, scale: 4 } },
};

const withGoal = (goal: FunctionGraphSpec["goal"], extra: Partial<FunctionGraphSpec> = {}): FunctionGraphSpec => ({
  ...absSpec,
  goal,
  ...extra,
});

describe("functionGraph — matchTransform self-check", () => {
  it("is solved exactly at the target and not at the start", () => {
    expect(isSolved(absSpec, { a: -2, h: 3, k: 1 })).toBe(true);
    expect(isSolved(absSpec, initialFunctionGraph(absSpec))).toBe(false);
  });

  it("rejects the right shape with the wrong reflection", () => {
    expect(isSolved(absSpec, { a: 2, h: 3, k: 1 })).toBe(false);
  });

  it("rejects the right reflection with the wrong stretch, and a shift off by one", () => {
    expect(isSolved(absSpec, { a: -1, h: 3, k: 1 })).toBe(false);
    expect(isSolved(absSpec, { a: -2, h: 2, k: 1 })).toBe(false);
    expect(isSolved(absSpec, { a: -2, h: 3, k: 0 })).toBe(false);
  });

  it("grades the GRAPH: any anchor on the target line passes for a linear parent", () => {
    const line = withGoal({ type: "matchTransform", parent: "linear", target: { a: 2, h: 1, k: -1 } });
    // y = 2(x − 1) − 1 = 2x − 3 = 2(x − 2) + 1
    expect(isSolved(line, { a: 2, h: 2, k: 1 })).toBe(true);
    expect(isSolved(line, { a: 2, h: 0, k: -3 })).toBe(true);
    expect(isSolved(line, { a: 2, h: 2, k: 0 })).toBe(false);
    expect(isSolved(line, { a: -2, h: 1, k: -1 })).toBe(false);
  });

  it("grades the GRAPH: 2^(x−h) shifts trade for doubling the stretch", () => {
    const exp = withGoal({ type: "matchTransform", parent: "exp2", target: { a: 1, h: 0, k: -2 } });
    expect(isSolved(exp, { a: 2, h: 1, k: -2 })).toBe(true);
    expect(isSolved(exp, { a: 0.5, h: -1, k: -2 })).toBe(true);
    expect(isSolved(exp, { a: 2, h: 1, k: -1 })).toBe(false);
    expect(isSolved(exp, { a: -2, h: 1, k: -2 })).toBe(false);
    // the equivalence claim is true of the actual curves
    for (const x of [-3, -1, 0, 0.5, 2]) {
      expect(transformValue("exp2", { a: 2, h: 1, k: -2 }, x)).toBeCloseTo(
        transformValue("exp2", { a: 1, h: 0, k: -2 }, x),
        9,
      );
    }
  });

  it("every other parent's parameters are unique (no false equivalence)", () => {
    for (const parent of ["quadratic", "cubic", "abs", "sqrt", "log2", "reciprocal"] as const) {
      expect(functionGraphTransformsEquivalent(parent, { a: 2, h: 1, k: 0 }, { a: 2, h: 1, k: 0 })).toBe(true);
      expect(functionGraphTransformsEquivalent(parent, { a: 2, h: 1, k: 0 }, { a: 1, h: 0, k: 0 })).toBe(false);
    }
  });

  it("never passes a forged or malformed state", () => {
    expect(isSolved(absSpec, null)).toBe(false);
    expect(isSolved(absSpec, { a: "-2", h: 3, k: 1 })).toBe(false);
    expect(isSolved(absSpec, { zeros: [] })).toBe(false);
    expect(gradeManipulativeSubmission(JSON.stringify(absSpec), "not json").correct).toBe(false);
    expect(gradeManipulativeSubmission(JSON.stringify(absSpec), JSON.stringify({ a: -2, h: 3, k: 1 })).correct).toBe(true);
  });
});

describe("functionGraph — placeZeros self-check", () => {
  const right = { zeros: [{ x: -3, touch: false }, { x: 1, touch: true }], leftUp: true, rightUp: false };

  it("derives end behaviour from degree parity and the leading sign", () => {
    // −(x − 1)²(x + 3): degree 3, leading < 0 → left up, right down
    expect(functionGraphTargetEnds([{ x: 1, multiplicity: 2 }, { x: -3, multiplicity: 1 }], -1)).toEqual({
      leftUp: true,
      rightUp: false,
    });
    expect(functionGraphTargetEnds([{ x: 0, multiplicity: 2 }], 3)).toEqual({ leftUp: true, rightUp: true });
    expect(functionGraphTargetEnds([{ x: 0, multiplicity: 1 }], 1)).toEqual({ leftUp: false, rightUp: true });
  });

  it("is solved for the right zeros, flags and ends in any order", () => {
    expect(isSolved(zerosSpec, right)).toBe(true);
    expect(isSolved(zerosSpec, { ...right, zeros: [...right.zeros].reverse() })).toBe(true);
  });

  it("rejects zeros in the right places with a touch flag wrong", () => {
    expect(isSolved(zerosSpec, { ...right, zeros: [{ x: -3, touch: false }, { x: 1, touch: false }] })).toBe(false);
    expect(isSolved(zerosSpec, { ...right, zeros: [{ x: -3, touch: true }, { x: 1, touch: true }] })).toBe(false);
  });

  it("rejects a wrong end, a missing zero, a duplicate and an extra zero", () => {
    expect(isSolved(zerosSpec, { ...right, leftUp: false })).toBe(false);
    expect(isSolved(zerosSpec, { ...right, rightUp: true })).toBe(false);
    expect(isSolved(zerosSpec, { ...right, zeros: [{ x: 1, touch: true }] })).toBe(false);
    expect(isSolved(zerosSpec, { ...right, zeros: [{ x: 1, touch: true }, { x: 1, touch: true }] })).toBe(false);
    expect(
      isSolved(zerosSpec, { ...right, zeros: [...right.zeros, { x: 4, touch: false }] }),
    ).toBe(false);
    expect(isSolved(zerosSpec, { ...right, zeros: [{ x: -2, touch: false }, { x: 1, touch: true }] })).toBe(false);
  });

  it("starts unsolved with an empty axis", () => {
    expect(initialFunctionGraph(zerosSpec)).toEqual({ zeros: [], leftUp: true, rightUp: true });
    expect(isSolved(zerosSpec, initialFunctionGraph(zerosSpec))).toBe(false);
  });
});

describe("functionGraph — placeAsymptotes self-check", () => {
  it("is solved when the lines match as sets", () => {
    expect(isSolved(asymSpec, { vertical: [-2, 1], horizontal: -1 })).toBe(true);
    expect(isSolved(asymSpec, { vertical: [1, -2], horizontal: -1 })).toBe(true);
  });

  it("rejects one asymptote off by one, a doubled line and a missing horizontal", () => {
    expect(isSolved(asymSpec, { vertical: [-2, 2], horizontal: -1 })).toBe(false);
    expect(isSolved(asymSpec, { vertical: [-2, 1], horizontal: 0 })).toBe(false);
    expect(isSolved(asymSpec, { vertical: [1, 1], horizontal: -1 })).toBe(false);
    expect(isSolved(asymSpec, { vertical: [-2, 1], horizontal: null })).toBe(false);
    expect(isSolved(asymSpec, { vertical: [-2], horizontal: -1 })).toBe(false);
  });

  it("starts with lines off every target", () => {
    const start = initialFunctionGraph(asymSpec) as { vertical: number[]; horizontal: number };
    expect(start.vertical).toHaveLength(2);
    for (const x of start.vertical) expect([1, -2]).not.toContain(x);
    expect(start.horizontal).not.toBe(-1);
    expect(isSolved(asymSpec, start)).toBe(false);
  });
});

describe("functionGraph — interaction model", () => {
  it("snaps the anchor to whole units and keeps both handles inside the window", () => {
    const t = functionGraphMoveAnchor(absSpec, "abs", { a: 1, h: 0, k: 0 }, { x: 2.6, y: 0.7 });
    expect(t).toEqual({ a: 1, h: 3, k: 1, b: 1 });
    const edge = functionGraphMoveAnchor(absSpec, "abs", { a: 1, h: 0, k: 0 }, { x: 40, y: -40 });
    // the stretch handle sits one unit right of the anchor, so h stops at xMax − 1
    expect(edge.h).toBe(5);
    expect(edge.k).toBe(-6);
  });

  it("moves a out of the way when the stretch handle would leave the window", () => {
    const t = functionGraphMoveAnchor(absSpec, "abs", { a: 3, h: 0, k: 0 }, { x: 0, y: 6 });
    const { scale } = functionGraphHandles("abs", t);
    expect(scale.y).toBeLessThanOrEqual(6);
    expect(t.k).toBe(6);
  });

  it("snaps the stretch to the allowed set and flips when dragged below the anchor", () => {
    const base = { a: 1, h: 0, k: 0 };
    expect(functionGraphSetScale(absSpec, "abs", base, 2.2).a).toBe(2);
    expect(functionGraphSetScale(absSpec, "abs", base, 0.4).a).toBe(0.5);
    expect(functionGraphSetScale(absSpec, "abs", base, -0.3).a).toBe(-0.5);
    expect(functionGraphSetScale(absSpec, "abs", base, -9).a).toBe(-3);
    for (let y = -6; y <= 6; y += 0.25) {
      expect(FUNCTION_GRAPH_A_VALUES).toContain(functionGraphSetScale(absSpec, "abs", base, y).a);
    }
  });

  it("drops markers on whole units and sends a clashing drop back to the tray", () => {
    let slots = functionGraphInitialSlots(zerosSpec);
    expect(slots).toEqual([{ x: null, touch: false }, { x: null, touch: false }]);
    slots = functionGraphDropZero(zerosSpec, slots, 0, 0.8);
    expect(slots[0].x).toBe(1);
    slots = functionGraphDropZero(zerosSpec, slots, 1, 1.2);
    expect(slots[1].x).toBeNull();
    slots = functionGraphDropZero(zerosSpec, slots, 1, -3.4);
    expect(functionGraphZerosState(slots, true, false).zeros).toEqual([
      { x: -3, touch: false },
      { x: 1, touch: false },
    ]);
  });

  it("feeds the sketch multiplicity 2 for a bounce and the right end's sign", () => {
    expect(
      functionGraphSketchInput({ zeros: [{ x: 1, touch: true }, { x: -3, touch: false }], leftUp: true, rightUp: false }),
    ).toEqual({ zeros: [{ x: 1, multiplicity: 2 }, { x: -3, multiplicity: 1 }], leading: -1 });
  });
});

describe("functionGraph — handle table matches the real curves", () => {
  it("lists the same parents as shared/functionCurves", () => {
    expect([...FUNCTION_GRAPH_PARENTS]).toEqual([...FUNCTION_PARENTS]);
  });

  it.each(FUNCTION_PARENTS)("%s: the stretch handle sits on the curve and the anchor maps with (h, k)", (parent) => {
    const hd = FUNCTION_GRAPH_HANDLES[parent];
    expect(parentValue(parent, hd.u)).toBeCloseTo(hd.fu, 12);
    const t = { a: -2, h: 3, k: 1 };
    const { scale } = functionGraphHandles(parent, t);
    expect(transformValue(parent, t, scale.x)).toBeCloseTo(scale.y, 12);
  });
});

describe("functionGraph — curve sampler", () => {
  const finite = (lines: { x: number; y: number }[][]) =>
    lines.every((line) => line.length >= 2 && line.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y)));
  const inWindow = (lines: { x: number; y: number }[][]) =>
    lines.every((line) =>
      line.every((p) => p.x >= WINDOW.xMin - 1e-9 && p.x <= WINDOW.xMax + 1e-9 && p.y >= WINDOW.yMin - 1e-9 && p.y <= WINDOW.yMax + 1e-9),
    );

  it.each(FUNCTION_PARENTS)("%s: no NaNs and clipped to the window", (parent) => {
    const lines = sampleCurve(transformCurve(parent, { a: -2, h: 1, k: 1 }), WINDOW);
    expect(lines.length).toBeGreaterThan(0);
    expect(finite(lines)).toBe(true);
    expect(inWindow(lines)).toBe(true);
  });

  it("breaks a reciprocal at its vertical asymptote and reaches the window edge beside it", () => {
    const lines = sampleCurve(transformCurve("reciprocal", { a: 1, h: 2, k: 0 }), WINDOW);
    expect(lines.length).toBe(2);
    expect(lines.some((line) => line.some((p) => p.x < 2) && line.some((p) => p.x > 2))).toBe(false);
    const right = lines.find((line) => line[0].x > 2)!;
    expect(right[0].y).toBeCloseTo(WINDOW.yMax, 6);
    expect(right[0].x - 2).toBeLessThan(0.2);
  });

  it("starts sqrt and log2 at their domain edge, nothing to the left", () => {
    for (const parent of ["sqrt", "log2"] as const) {
      const lines = sampleCurve(transformCurve(parent, { a: 1, h: -1, k: 0 }), WINDOW);
      expect(lines.flat().every((p) => p.x >= -1)).toBe(true);
    }
  });

  it("breaks a two-asymptote rational into three pieces", () => {
    const lines = sampleCurve(rationalCurve({ vertical: [1, -2], horizontal: -1, scale: 4 }), WINDOW);
    expect(finite(lines)).toBe(true);
    for (const v of [1, -2]) {
      expect(lines.some((line) => line.some((p) => p.x < v) && line.some((p) => p.x > v))).toBe(false);
    }
    expect(lines.length).toBeGreaterThanOrEqual(3);
  });

  it("scales a polynomial sketch into view and keeps its zeros on the axis", () => {
    const curve = polynomialSketchCurve([{ x: 1, multiplicity: 2 }, { x: -3, multiplicity: 1 }], -1, WINDOW);
    expect(curve.f(1)).toBeCloseTo(0, 9);
    expect(curve.f(-3)).toBeCloseTo(0, 9);
    let peak = 0;
    for (let x = -4; x <= 2; x += 0.01) peak = Math.max(peak, Math.abs(curve.f(x)));
    expect(peak).toBeGreaterThan(2);
    expect(peak).toBeLessThanOrEqual(6);
    expect(curve.f(5)).toBeLessThan(0); // leading −1, odd degree → right end down
  });
});

describe("functionGraph — tutor describers", () => {
  it("goalText names the given equation, and never the computed zeros or asymptotes", () => {
    expect(goalText(absSpec)).toContain("y = −2|x − 3| + 1");
    expect(goalText(absSpec)).toContain("y = |x|");
    const zeros = goalText(zerosSpec);
    expect(zeros).toContain("y = −(x − 1)²(x + 3)");
    expect(zeros).not.toMatch(/x = /);
    const asym = goalText(asymSpec);
    expect(asym).toContain("y = 4/((x − 1)(x + 2)) − 1");
    expect(asym).toContain("2 vertical lines");
    expect(asym).not.toMatch(/x = |y = [-−]1\b/);
  });

  it("describes what the scholar drew against the given equation", () => {
    const text = describeState(absSpec, JSON.stringify({ a: 2, h: 3, k: 1 }));
    expect(text).toContain("corner is at (3, 1)");
    expect(text).toContain("opens upward");
    expect(text).toContain("the upside-down reflection doesn't match (the target opens downward)");
    expect(text).not.toContain("not where the equation puts it");

    const quad = withGoal({ type: "matchTransform", parent: "quadratic", target: { a: -1, h: 3, k: 1 } });
    const off = describeState(quad, JSON.stringify({ a: -2, h: 2, k: 1 }));
    expect(off).toContain("vertex is at (2, 1)");
    expect(off).toContain("the stretch doesn't match");
    expect(off).toContain("the vertex is not where the equation puts it");
    expect(describeState(quad, JSON.stringify({ a: -1, h: 3, k: 1 }))).toContain(
      "That is exactly the graph of the equation in the prompt.",
    );
  });

  it("describes zeros and lines without leaking the target", () => {
    const z = describeState(zerosSpec, JSON.stringify({ zeros: [{ x: 1, touch: false }], leftUp: true, rightUp: true }));
    expect(z).toBe(
      "Markers sit on the x-axis at x = 1 (crosses); 1 marker is still in the tray. The left end points up and the right end points up.",
    );
    expect(z).not.toContain("-3");
    const a = describeState(asymSpec, JSON.stringify({ vertical: [3, -5], horizontal: 5 }));
    expect(a).toBe("The vertical dashed lines are at x = -5 and x = 3, and the horizontal dashed line is at y = 5.");
  });

  it("is total on garbage state", () => {
    expect(describeState(absSpec, "{")).toBe("The board hasn't been changed yet.");
    expect(describeState(zerosSpec, JSON.stringify({}))).toBe("No markers have been placed yet.");
    expect(describeState(asymSpec, JSON.stringify(null))).toBe("The dashed lines haven't been moved yet.");
  });

  it("formats equations the way stems are written", () => {
    expect(functionGraphTransformEquation("quadratic", { a: 0.5, h: -2, k: -3 })).toBe("y = ½(x + 2)² − 3");
    expect(functionGraphTransformEquation("abs", { a: -0.5, h: 1, k: 0 })).toBe("y = −½|x − 1|");
    expect(functionGraphTransformEquation("reciprocal", { a: 0.5, h: 0, k: 0 })).toBe("y = ½/x");
    expect(functionGraphTransformEquation("exp2", { a: 3, h: 1, k: 0 })).toBe("y = 3 · 2^(x − 1)");
    expect(functionGraphTransformEquation("log2", { a: -1, h: 0, k: 2 })).toBe("y = −log₂(x) + 2");
    expect(functionGraphTransformEquation("reciprocal", { a: -2, h: 1, k: -1 })).toBe("y = −2/(x − 1) − 1");
    expect(functionGraphTransformEquation("sqrt", { a: 1, h: 0, k: 0 })).toBe("y = √x");
    expect(functionGraphPolynomialEquation([{ x: 0, multiplicity: 1 }, { x: 2, multiplicity: 3 }], 2)).toBe("y = 2(x − 2)³x");
    expect(functionGraphRationalEquation({ vertical: [2], horizontal: 1, scale: 3 })).toBe("y = 3/(x − 2) + 1");
  });
});

describe("functionGraph — authoring guard", () => {
  it.each(FUNCTION_GRAPH_EXAMPLES.map((s) => [s.id, s] as const))("example %s is gradable and validates", (_id, spec) => {
    expect(() => assertGradableManipulative(spec)).not.toThrow();
    expect(() => assertRenderableManipulative(spec)).not.toThrow();
    expect(validateManipulativeSpec(spec)).toEqual({ ok: true, spec });
  });

  it("covers every goal at least twice", () => {
    const counts = new Map<string, number>();
    for (const s of FUNCTION_GRAPH_EXAMPLES) counts.set(s.goal.type, (counts.get(s.goal.type) ?? 0) + 1);
    expect(Object.fromEntries(counts)).toEqual({ matchTransform: 3, placeZeros: 2, placeAsymptotes: 3 });
  });

  it.each([
    ["a stretch outside the allowed set", withGoal({ type: "matchTransform", parent: "abs", target: { a: 1.5, h: 3, k: 1 } })],
    ["a fractional shift", withGoal({ type: "matchTransform", parent: "abs", target: { a: -2, h: 2.5, k: 1 } })],
    ["a target that is already the parent", withGoal({ type: "matchTransform", parent: "quadratic", target: { a: 1, h: 0, k: 0 } })],
    ["an exp2 target equivalent to the parent", withGoal({ type: "matchTransform", parent: "exp2", target: { a: 2, h: 1, k: 0 } })],
    ["a target whose stretch handle is off the grid", withGoal({ type: "matchTransform", parent: "abs", target: { a: 3, h: 3, k: 5 } })],
    ["an unknown parent", withGoal({ type: "matchTransform", parent: "sine" as never, target: { a: 2, h: 1, k: 0 } })],
    ["a fractional window", withGoal(absSpec.goal, { xMax: 6.5 })],
    ["a window too small", withGoal(absSpec.goal, { xMin: -1, xMax: 2 })],
    ["duplicate zeros", withGoal({ type: "placeZeros", zeros: [{ x: 1, multiplicity: 1 }, { x: 1, multiplicity: 2 }], leading: 1 })],
    ["a zero on the window edge", withGoal({ type: "placeZeros", zeros: [{ x: 6, multiplicity: 1 }], leading: 1 })],
    ["a non-integer zero", withGoal({ type: "placeZeros", zeros: [{ x: 0.5, multiplicity: 1 }], leading: 1 })],
    ["a zero leading coefficient", withGoal({ type: "placeZeros", zeros: [{ x: 1, multiplicity: 1 }], leading: 0 })],
    ["three vertical asymptotes", withGoal({ type: "placeAsymptotes", rational: { vertical: [1, 2, 3], horizontal: 0, scale: 1 } })],
    ["a horizontal asymptote off the grid", withGoal({ type: "placeAsymptotes", rational: { vertical: [1], horizontal: 9, scale: 1 } })],
    ["a zero scale", withGoal({ type: "placeAsymptotes", rational: { vertical: [1], horizontal: 0, scale: 0 } })],
    // Span 4 leaves only x = 0 free off both targets: the board could place one
    // line and has no control to add another, so it could never be solved.
    [
      "two vertical asymptotes in a window with room for only one starting line",
      withGoal({ type: "placeAsymptotes", rational: { vertical: [-1, 1], horizontal: 0, scale: 1 } }, { xMin: -2, xMax: 2 }),
    ],
    [
      "a targetUnstated flag that is not true",
      withGoal({ type: "matchTransform", parent: "abs", target: { a: -2, h: 3, k: 1 }, targetUnstated: false as never }),
    ],
  ])("rejects %s", (_name, spec) => {
    expect(functionGraphGoalIsUsable(spec)).toBe(false);
    expect(() => assertGradableManipulative(spec)).toThrow(/Ungradable/);
    expect(validateManipulativeSpec(spec).ok).toBe(false);
  });

  it("rejects a structurally broken spec before the cast", () => {
    const broken = { ...absSpec, xMin: "-6" };
    expect(validateManipulativeSpec(broken)).toEqual({
      ok: false,
      reason: 'functionGraph.xMin must be an integer, got "-6"',
    });
  });
});

describe("functionGraph — a target the prompt does not state", () => {
  // y = 2^x + 1 inverted is y = log₂(x − 1): finding the inverse IS the work.
  const inverseSpec: FunctionGraphSpec = {
    kind: "functionGraph",
    id: "t-inverse",
    concept: "Logarithms as inverses",
    prompt: "Shape the graph of the inverse of y = 2^x + 1.",
    ...WINDOW,
    goal: { type: "matchTransform", parent: "log2", target: { a: 1, h: 1, k: 0 }, targetUnstated: true },
  };
  const leaks = (text: string) => [
    text.includes("y = log₂(x − 1)"),
    text.includes("x − 1"),
    text.includes("(2, 0)"), // the target's x-intercept anchor
    text.includes("equation in the prompt"),
    text.includes("the target"),
  ];

  it("is gradable", () => {
    expect(functionGraphGoalIsUsable(inverseSpec)).toBe(true);
    expect(() => assertGradableManipulative(inverseSpec)).not.toThrow();
    expect(validateManipulativeSpec(inverseSpec).ok).toBe(true);
  });

  it("goalText gives the prompt's task, never the target rule", () => {
    const text = goalText(inverseSpec);
    expect(text).toContain("the inverse of y = 2^x + 1");
    expect(text).toContain("work that rule out");
    expect(leaks(text)).toEqual([false, false, false, false, false]);
  });

  it("describeState names only what was built, and whether it matches", () => {
    const start = describeState(inverseSpec, JSON.stringify(initialFunctionGraph(inverseSpec)));
    expect(start).toContain("The curve on the board is y = log₂(x).");
    expect(start).toContain("not yet the graph the prompt asks for");
    expect(leaks(start)).toEqual([false, false, false, false, false]);

    const nearMiss = describeState(inverseSpec, JSON.stringify({ a: 1, h: 2, k: 0, b: 1 }));
    expect(nearMiss).toContain("y = log₂(x − 2)");
    expect(nearMiss).toContain("not yet the graph the prompt asks for");
    expect(leaks(nearMiss)).toEqual([false, false, false, false, false]);

    const solved = describeState(inverseSpec, JSON.stringify({ a: 1, h: 1, k: 0, b: 1 }));
    expect(solved).toContain("That is the graph the prompt asks for.");
    expect(solved).not.toContain("equation in the prompt");
  });

  it("an unflagged spec still compares with the stated equation", () => {
    const stated: FunctionGraphSpec = {
      ...inverseSpec,
      prompt: "Shape the graph of y = log₂(x − 1).",
      goal: { type: "matchTransform", parent: "log2", target: { a: 1, h: 1, k: 0 } },
    };
    expect(goalText(stated)).toContain("y = log₂(x − 1)");
    expect(describeState(stated, JSON.stringify(initialFunctionGraph(stated)))).toContain("equation in the prompt");
  });
});

describe("functionGraph — flip left–right (b = −1)", () => {
  const grid = [-5, -3.5, -2, -1.25, -0.5, 0.25, 1, 2.5, 3.75, 5];
  const sameGraph = (
    parent: (typeof FUNCTION_PARENTS)[number],
    p: { a: number; h: number; k: number; b: number },
    q: { a: number; h: number; k: number; b: number },
  ) =>
    grid.every((x) => {
      const yp = transformValue(parent, p, x);
      const yq = transformValue(parent, q, x);
      if (!Number.isFinite(yp) || !Number.isFinite(yq)) return Number.isFinite(yp) === Number.isFinite(yq);
      return Math.abs(yp - yq) < 1e-9;
    });

  it.each(FUNCTION_PARENTS)("%s: graph equivalence agrees with the real curves, flips included", (parent) => {
    const params: Array<{ a: number; h: number; k: number; b: number }> = [];
    for (const a of [-2, -1, 0.5, 1, 2])
      for (const h of [-1, 0, 1]) for (const k of [0, 1]) for (const b of [1, -1]) params.push({ a, h, k, b });
    for (const p of params) {
      for (const q of params) {
        expect(functionGraphTransformsEquivalent(parent, p, q)).toBe(sameGraph(parent, p, q));
      }
    }
  });

  it("never requires a flip for an even parent, and does for √ and log", () => {
    const quad = withGoal({ type: "matchTransform", parent: "quadratic", target: { a: -1, h: 2, k: 1, b: -1 } });
    expect(isSolved(quad, { a: -1, h: 2, k: 1, b: 1 })).toBe(true);
    expect(isSolved(quad, { a: -1, h: 2, k: 1 })).toBe(true);
    const root = withGoal({ type: "matchTransform", parent: "sqrt", target: { a: 1, h: 0, k: 1, b: -1 } });
    expect(isSolved(root, { a: 1, h: 0, k: 1, b: -1 })).toBe(true);
    expect(isSolved(root, { a: 1, h: 0, k: 1, b: 1 })).toBe(false);
    expect(isSolved(root, { a: -1, h: 0, k: 1, b: 1 })).toBe(false); // upside down is not left–right
    expect(isSolved(root, { a: 1, h: 0, k: 1, b: 2 })).toBe(false);
  });

  it("a flip of an odd parent equals turning it upside down", () => {
    const cube = withGoal({ type: "matchTransform", parent: "cubic", target: { a: 2, h: 1, k: 0, b: -1 } });
    expect(isSolved(cube, { a: -2, h: 1, k: 0, b: 1 })).toBe(true);
  });

  it("the flip button keeps the anchor still, moves the stretch handle across, and undoes itself", () => {
    const root = withGoal({ type: "matchTransform", parent: "sqrt", target: { a: 1, h: 0, k: 1, b: -1 } });
    const start = { a: 2, h: 1, k: 1, b: 1 };
    const flipped = functionGraphFlip(root, "sqrt", start);
    expect(flipped).toEqual({ a: 2, h: 1, k: 1, b: -1 });
    const before = functionGraphHandles("sqrt", start);
    const after = functionGraphHandles("sqrt", flipped);
    expect(after.anchor).toEqual(before.anchor);
    expect(after.scale.x).toBe(before.anchor.x - 1);
    expect(functionGraphFlip(root, "sqrt", flipped)).toEqual(start);
    // log2's anchor is its x-intercept, one unit from x = h: the flip mirrors through it
    const log = withGoal({ type: "matchTransform", parent: "log2", target: { a: 1, h: 0, k: 0, b: -1 } });
    const lf = functionGraphFlip(log, "log2", { a: 1, h: 0, k: 0, b: 1 });
    expect(functionGraphHandles("log2", lf).anchor).toEqual({ x: 1, y: 0 });
    expect(transformValue("log2", lf, 1)).toBeCloseTo(0, 12);
  });

  it("at the window edge the flip nudges the anchor in so the stretch handle fits", () => {
    const t = functionGraphFlip(absSpec, "sqrt", { a: 1, h: -6, k: 0, b: 1 });
    const { anchor, scale } = functionGraphHandles("sqrt", t);
    expect(scale.x).toBeGreaterThanOrEqual(absSpec.xMin);
    expect(anchor.x).toBe(-5);
  });

  it("dragging a flipped anchor keeps both handles inside the window", () => {
    const t = functionGraphMoveAnchor(absSpec, "sqrt", { a: 1, h: 0, k: 0, b: -1 }, { x: -40, y: 0 });
    expect(t.b).toBe(-1);
    expect(functionGraphHandles("sqrt", t).scale.x).toBe(absSpec.xMin);
  });

  it("formats flipped equations as h − x", () => {
    expect(functionGraphTransformEquation("sqrt", { a: -1, h: 2, k: 0, b: -1 })).toBe("y = −√(2 − x)");
    expect(functionGraphTransformEquation("exp2", { a: 1, h: 0, k: 0, b: -1 })).toBe("y = 2^(−x)");
    expect(functionGraphTransformEquation("log2", { a: 1, h: -3, k: 1, b: -1 })).toBe("y = log₂(−3 − x) + 1");
  });

  it("the tutor hears about the flip in the task and on the board", () => {
    const root = withGoal({ type: "matchTransform", parent: "sqrt", target: { a: 1, h: 0, k: 1, b: -1 } });
    expect(goalText(root)).toContain('"Flip left–right" button');
    expect(goalText(root)).toContain("y = √(−x) + 1");
    const unflipped = describeState(root, JSON.stringify({ a: 1, h: 0, k: 1, b: 1 }));
    expect(unflipped).toContain("it still needs a flip left–right");
    const flipped = describeState(root, JSON.stringify({ a: 1, h: 0, k: 1, b: -1 }));
    expect(flipped).toContain("It is flipped left–right.");
    expect(flipped).toContain("exactly the graph");
  });

  it("validates b and rejects anything but ±1", () => {
    expect(
      functionGraphGoalIsUsable(withGoal({ type: "matchTransform", parent: "sqrt", target: { a: 1, h: 0, k: 1, b: -1 } })),
    ).toBe(true);
    expect(
      functionGraphGoalIsUsable(withGoal({ type: "matchTransform", parent: "sqrt", target: { a: 1, h: 0, k: 1, b: 2 } })),
    ).toBe(false);
    // a flipped even parent with no other change is still "already solved"
    expect(
      functionGraphGoalIsUsable(withGoal({ type: "matchTransform", parent: "abs", target: { a: 1, h: 0, k: 0, b: -1 } })),
    ).toBe(false);
  });
});

describe("functionGraph — fitting the landscape practice card", () => {
  // The iPad practice card in landscape: the column is 600pt wide less 18pt
  // padding a side; 674 covers a wider host. The board may be at most
  // FUNCTION_GRAPH_LANDSCAPE_BOARD_HEIGHT tall (820 less header, "Build it",
  // the pinned Done lane, card padding and the prompt).
  const frames = [564, 674].map((width) => ({ width, height: FUNCTION_GRAPH_LANDSCAPE_BOARD_HEIGHT }));
  const flipSpec = withGoal({ type: "matchTransform", parent: "sqrt", target: { a: 1, h: 0, k: 1, b: -1 } });
  const boards = [...FUNCTION_GRAPH_EXAMPLES, absSpec, zerosSpec, asymSpec, flipSpec];

  it("is the 820pt screen less the chrome above and below the board", () => {
    expect(FUNCTION_GRAPH_LANDSCAPE_BOARD_HEIGHT).toBe(432);
  });

  it.each(boards.map((b) => [b.id, b] as const))("%s fits the card in landscape, controls and all", (_id, spec) => {
    for (const frame of frames) {
      const l = functionGraphLayout(spec, frame);
      expect(l.height).toBeLessThanOrEqual(frame.height);
      expect(l.width).toBeLessThanOrEqual(frame.width);
      // square units and a readable grid: at least 24pt a unit on a 12-unit window
      expect(l.unit * Math.max(spec.xMax - spec.xMin, spec.yMax - spec.yMin)).toBeGreaterThanOrEqual(290);
      const within = (r: { x: number; y: number; width: number; height: number }) => {
        expect(r.x).toBeGreaterThanOrEqual(0);
        expect(r.y).toBeGreaterThanOrEqual(0);
        expect(r.x + r.width).toBeLessThanOrEqual(l.width + 1e-9);
        expect(r.y + r.height).toBeLessThanOrEqual(l.height + 1e-9);
      };
      if (l.controls) {
        within(l.controls);
        expect(l.controls.height).toBeGreaterThanOrEqual(44);
      }
      if (l.tray) {
        within(l.tray);
        const n = spec.goal.type === "placeZeros" ? spec.goal.zeros.length : 0;
        for (let i = 0; i < n; i++) {
          const slot = functionGraphTraySlot(l, i, n);
          // a 30pt marker sits wholly in the tray, under the hint
          expect(slot.x - 15).toBeGreaterThanOrEqual(l.tray.x);
          expect(slot.x + 15).toBeLessThanOrEqual(l.tray.x + l.tray.width);
          expect(slot.y - 15).toBeGreaterThanOrEqual(l.tray.y + FUNCTION_GRAPH_TRAY_HINT - 1);
          expect(slot.y + 15).toBeLessThanOrEqual(l.tray.y + l.tray.height);
        }
        // the end-behaviour arrows (44pt wide, centred 24pt outside the plot) stay on the board
        expect(l.plotLeft - 24 - 22).toBeGreaterThanOrEqual(0);
        expect(l.plotLeft + l.plotWidth + 24 + 22).toBeLessThanOrEqual(l.tray.x + (l.sideBySide ? 0 : l.width));
      }
    }
  });

  it("puts the tray beside the plot in landscape and under it where the page scrolls", () => {
    expect(functionGraphLayout(zerosSpec, frames[1]).sideBySide).toBe(true);
    const web = functionGraphLayout(zerosSpec, { width: 520 });
    expect(web.sideBySide).toBe(false);
    expect(web.tray!.y).toBeGreaterThan(web.plotTop + web.plotHeight);
  });

  it("offers the flip only where it changes the graph", () => {
    for (const parent of FUNCTION_PARENTS) {
      const spec = withGoal({ type: "matchTransform", parent, target: { a: 2, h: 1, k: 1 } });
      const offered = parent !== "quadratic" && parent !== "abs";
      expect(functionGraphFlipOffered(parent)).toBe(offered);
      expect(functionGraphLayout(spec, frames[0]).controls !== null).toBe(offered);
      expect(functionGraphLayout(spec, { width: 520 }).controls !== null).toBe(offered);
    }
    expect(functionGraphLayout(asymSpec, frames[0]).controls).toBeNull();
  });

  it("maps math ↔ pixels with square units and round-trips", () => {
    const l = functionGraphLayout(absSpec, { width: 560 });
    expect(l.plotWidth / (absSpec.xMax - absSpec.xMin)).toBeCloseTo(l.plotHeight / (absSpec.yMax - absSpec.yMin));
    const back = functionGraphToMath(l, functionGraphToPx(l, { x: 2, y: -3 }));
    expect(back.x).toBeCloseTo(2);
    expect(back.y).toBeCloseTo(-3);
    expect(l.tray).toBeNull();
  });
});

describe("functionGraph — the anchor's coordinate label", () => {
  const overlap = (a: { x: number; y: number; width: number; height: number }, b: typeof a) =>
    a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
  const frames = [
    { width: 564, height: FUNCTION_GRAPH_LANDSCAPE_BOARD_HEIGHT },
    { width: 520 },
  ];
  const states = [
    { a: 1, h: 0, k: 0, b: 1 },
    { a: -2, h: 1, k: 1, b: 1 },
    { a: 0.5, h: -2, k: -3, b: 1 },
    { a: 1, h: 0, k: 0, b: -1 },
    { a: -1, h: 2, k: 0, b: -1 },
    { a: 3, h: -4, k: 2, b: 1 },
  ];

  it.each(FUNCTION_PARENTS)("%s: clear of the stretch handle, its step, both knobs and every axis number", (parent) => {
    const spec = withGoal({ type: "matchTransform", parent, target: { a: 2, h: 1, k: 1 } }, { xMin: -6, xMax: 6, yMin: -6, yMax: 6 });
    for (const frame of frames) {
      const l = functionGraphLayout(spec, frame);
      for (const t of states) {
        const label = functionGraphAnchorLabel(l, parent, t, (x) => transformValue(parent, t, x));
        const { anchor, scale } = functionGraphHandles(parent, t);
        const a = functionGraphToPx(l, anchor);
        const sc = functionGraphToPx(l, scale);
        const corner = functionGraphToPx(l, { x: scale.x, y: anchor.y });
        const rects = [
          { x: a.x - 14, y: a.y - 14, width: 28, height: 28 },
          { x: sc.x - 11, y: sc.y - 11, width: 22, height: 22 },
          { x: Math.min(a.x, corner.x), y: corner.y - 1, width: Math.abs(corner.x - a.x), height: 2 },
          { x: corner.x - 1, y: Math.min(corner.y, sc.y), width: 2, height: Math.abs(sc.y - corner.y) },
          ...functionGraphTickLabels(l).map((tick) => tick.box),
        ];
        for (const r of rects) expect(overlap(label.box, r)).toBe(false);
        // on the plot
        expect(label.box.x).toBeGreaterThanOrEqual(l.plotLeft);
        expect(label.box.x + label.box.width).toBeLessThanOrEqual(l.plotLeft + l.plotWidth);
        expect(label.text).toBe(`(${anchor.x}, ${anchor.y})`);
      }
    }
  });

  it("at the start state it is not on the stretch handle nor the axis numbers (the device-review case)", () => {
    const l = functionGraphLayout(absSpec, { width: 564, height: FUNCTION_GRAPH_LANDSCAPE_BOARD_HEIGHT });
    const label = functionGraphAnchorLabel(l, "quadratic", { a: 1, h: 0, k: 0, b: 1 }, (x) => x * x);
    const ticks = functionGraphTickLabels(l);
    expect(ticks.some((tick) => overlap(label.box, tick.box))).toBe(false);
    // the stretch handle is up and to the right of the anchor; the label is not
    const a = functionGraphToPx(l, { x: 0, y: 0 });
    expect(label.box.x + label.box.width <= a.x || label.box.y >= a.y).toBe(true);
  });
});

describe("functionGraph — removable holes", () => {
  const holeSpec = FUNCTION_GRAPH_EXAMPLES.find((s) => s.id === "fg-asymptotes-with-hole")!;

  it("a vertical line at the hole is wrong; the asymptote alone is right", () => {
    expect(isSolved(holeSpec, { vertical: [-1], horizontal: 0 })).toBe(false);
    expect(isSolved(holeSpec, { vertical: [2], horizontal: 0 })).toBe(true);
  });

  it("goalText says there is a hole but not where", () => {
    const text = goalText(holeSpec);
    expect(text).toContain("hole");
    expect(text).not.toMatch(/x = |−1|-1/);
  });

  it("rejects a hole on an asymptote, off the grid, or repeated", () => {
    const base = holeSpec.goal as Extract<FunctionGraphSpec["goal"], { type: "placeAsymptotes" }>;
    for (const holes of [[2], [0.5], [-1, -1], [6]]) {
      expect(functionGraphGoalIsUsable({ ...holeSpec, goal: { ...base, rational: { ...base.rational, holes } } })).toBe(false);
    }
  });
});
