/**
 * Default manipulative practice items for Algebra 2 — the nodes where dragging
 * a graph IS the skill, so the item is the graph the scholar builds:
 *
 *   fn_transform_translate      matchTransform, a = 1 (quadratic, |x|, √x, x³)
 *   fn_transform_scale_reflect  matchTransform, h = k = 0 (stretch, squash, flip)
 *   fn_transform_combined       matchTransform with a, h and k, including 2^x,
 *                               log₂x and 1/x (their asymptotes move with them)
 *   log_graph_inverse           matchTransform on log₂ and 2^x, mostly "shape the
 *                               INVERSE of …", so the inverse is worked out first
 *   poly_sketch_factored        placeZeros (crosses vs bounces, both ends)
 *   rat_graph_asymptotes        placeAsymptotes (one or two vertical lines)
 *   cx_plane_plot               coordinatePlane placePoint on the Re/Im plane
 *
 * Each list runs easy → hard. Seeded by `seedDefaultManipulativePractice`
 * (convex/practiceSkills.ts), which asserts every spec gradable; ids are
 * stable because re-seeding updates rows in place by `manipulativeSpec.id`.
 *
 * Reflections across the y-axis (f(−x)) are built with the board's "Flip
 * left–right" button (target `b: −1`), for √x, 2^x and log₂x, where it is a
 * different graph from −f(x).
 *
 * Prompts are PLAIN TEXT on the iPad (no math typesetting), so a fractional
 * coefficient is written ½, never "1/2x" (which reads as 1/(2x)).
 */
import {
  functionGraphPolynomialEquation,
  functionGraphTransformEquation,
} from "../../lib/manipulative/functionGraph";
import type {
  CoordinatePlaneSpec,
  FunctionGraphParent,
  FunctionGraphSpec,
  FunctionGraphZero,
  ManipulativeSpec,
} from "../../lib/manipulative/types";
import { ALGEBRA_2_DOMAIN } from "./algebra2Graph";

type Target = { domain: string; skillKey: string; spec: ManipulativeSpec };

type Window = { xMin: number; xMax: number; yMin: number; yMax: number };
const SQUARE: Window = { xMin: -6, xMax: 6, yMin: -6, yMax: 6 };

const PARENT_CONCEPT: Record<FunctionGraphParent, string> = {
  linear: "Transforming a line",
  quadratic: "Transforming x²",
  cubic: "Transforming x³",
  abs: "Transforming |x|",
  sqrt: "Transforming √x",
  exp2: "Transforming 2^x",
  log2: "Transforming log₂x",
  reciprocal: "Transforming 1/x",
};

/** A matchTransform board whose prompt states the target equation. */
function shape(
  id: string,
  parent: FunctionGraphParent,
  a: number,
  h: number,
  k: number,
  window: Window = SQUARE,
  prompt?: string,
  concept?: string,
  b?: -1,
): FunctionGraphSpec {
  const target = { a, h, k, ...(b === -1 ? { b } : {}) };
  return {
    kind: "functionGraph",
    id,
    concept: concept ?? PARENT_CONCEPT[parent],
    prompt: plainHalf(prompt ?? `Shape the graph of ${functionGraphTransformEquation(parent, target)}.`),
    ...window,
    goal: { type: "matchTransform", parent, target },
  };
}

/** ±½ is the only fractional stretch on the board; write it as one glyph. */
function plainHalf(text: string): string {
  return text.replace(/1\/2/g, "½");
}

/**
 * A board whose prompt names the graph without stating its rule ("the inverse
 * of y = 2^x + 1"): working the rule out is the task, so the goal is flagged
 * `targetUnstated` and the tutor describers never name it.
 */
function inverse(
  id: string,
  parent: FunctionGraphParent,
  a: number,
  h: number,
  k: number,
  prompt: string,
  concept: string,
): FunctionGraphSpec {
  const spec = shape(id, parent, a, h, k, SQUARE, prompt, concept);
  if (spec.goal.type !== "matchTransform") throw new Error(id);
  return { ...spec, goal: { ...spec.goal, targetUnstated: true } };
}

/** A left–right flip: y = a·f(−(x − h)) + k. */
function flipped(id: string, parent: FunctionGraphParent, a: number, h: number, k: number, concept?: string): FunctionGraphSpec {
  return shape(id, parent, a, h, k, SQUARE, undefined, concept ?? "Reflecting across the y-axis", -1);
}

function sketch(id: string, zeros: FunctionGraphZero[], leading: number, window: Window = SQUARE): FunctionGraphSpec {
  return {
    kind: "functionGraph",
    id,
    concept: "Zeros and end behaviour",
    prompt: `Sketch ${functionGraphPolynomialEquation(zeros, leading)}: place its zeros, mark each as a cross or a bounce, and set both ends.`,
    ...window,
    goal: { type: "placeZeros", zeros, leading },
  };
}

function asymptotes(
  id: string,
  rule: string,
  rational: { vertical: number[]; horizontal: number; scale: number; holes?: number[] },
  window: Window = SQUARE,
): FunctionGraphSpec {
  return {
    kind: "functionGraph",
    id,
    concept: "Asymptotes of a rational function",
    prompt: `Drag the dashed lines onto the asymptotes of y = ${rule}.`,
    ...window,
    goal: { type: "placeAsymptotes", rational },
  };
}

function plot(id: string, number: string, x: number, y: number): CoordinatePlaneSpec {
  return {
    kind: "coordinatePlane",
    id,
    concept: "The complex plane",
    prompt: `Plot ${number} on the complex plane.`,
    xMin: -6,
    xMax: 6,
    yMin: -6,
    yMax: 6,
    gridStep: 1,
    axisLabels: { x: "Re", y: "Im" },
    draggable: [{ start: { x: 0, y: 0 } }],
    goal: { type: "placePoint", x, y },
  };
}

const at = (skillKey: string, specs: ManipulativeSpec[]): Target[] =>
  specs.map((spec) => ({ domain: ALGEBRA_2_DOMAIN, skillKey, spec }));

export const ALGEBRA_2_MANIPULATIVE_TARGETS: Target[] = [
  // Translations only (a = 1). Left shifts (x + h inside) are the trap, so
  // half of these go left.
  ...at("fn_transform_translate", [
    shape("fg-a2-translate-quad-right-2", "quadratic", 1, 2, 0),
    shape("fg-a2-translate-abs-up-3", "abs", 1, 0, 3),
    shape("fg-a2-translate-quad-left-3-up-1", "quadratic", 1, -3, 1),
    shape("fg-a2-translate-sqrt-left-2-down-1", "sqrt", 1, -2, -1),
    shape("fg-a2-translate-abs-right-4-down-2", "abs", 1, 4, -2),
    shape("fg-a2-translate-cubic-right-1-up-2", "cubic", 1, 1, 2),
    shape("fg-a2-translate-sqrt-right-3-up-2", "sqrt", 1, 3, 2),
    shape("fg-a2-translate-cubic-left-2-down-3", "cubic", 1, -2, -3),
  ]),

  // Stretches, squashes and reflections about the parent's own anchor.
  ...at("fn_transform_scale_reflect", [
    shape("fg-a2-scale-quad-2", "quadratic", 2, 0, 0),
    shape("fg-a2-scale-abs-flip", "abs", -1, 0, 0),
    shape("fg-a2-scale-quad-half", "quadratic", 0.5, 0, 0),
    shape("fg-a2-scale-sqrt-3", "sqrt", 3, 0, 0),
    shape("fg-a2-scale-cubic-flip", "cubic", -1, 0, 0),
    shape("fg-a2-scale-abs-flip-2", "abs", -2, 0, 0),
    shape("fg-a2-scale-sqrt-flip-2", "sqrt", -2, 0, 0),
    shape("fg-a2-scale-quad-flip-half", "quadratic", -0.5, 0, 0),
    // f(−x) against −f(x): built with "Flip left–right", different graphs here.
    flipped("fg-a2-scale-sqrt-mirror", "sqrt", 1, 0, 0),
    flipped("fg-a2-scale-exp-mirror", "exp2", 1, 0, 0),
    flipped("fg-a2-scale-log-mirror", "log2", 1, 0, 0),
    flipped("fg-a2-scale-sqrt-mirror-and-flip", "sqrt", -1, 0, 0),
  ]),

  // All three moves at once; the last three parents carry asymptotes.
  ...at("fn_transform_combined", [
    shape("fg-a2-combined-quad-flip-right-2-up-3", "quadratic", -1, 2, 3),
    shape("fg-a2-combined-abs-2-left-1-down-3", "abs", 2, -1, -3),
    shape("fg-a2-combined-sqrt-flip-left-3-up-2", "sqrt", -1, -3, 2),
    shape("fg-a2-combined-cubic-half-left-1-up-1", "cubic", 0.5, -1, 1),
    shape("fg-a2-combined-exp-flip-right-1-up-3", "exp2", -1, 1, 3),
    shape("fg-a2-combined-log-2-left-2-down-1", "log2", 2, -2, -1),
    shape("fg-a2-combined-recip-3-right-1-down-2", "reciprocal", 3, 1, -2),
    shape("fg-a2-combined-exp-2-left-2-down-3", "exp2", 2, -2, -3),
    // The hardest two add a left–right flip.
    flipped("fg-a2-combined-sqrt-2-mirror-right-2-down-1", "sqrt", 2, 2, -1, "Transforming √x"),
    flipped("fg-a2-combined-exp-flip-mirror-right-1-up-3", "exp2", -1, 1, 3, "Transforming 2^x"),
  ]),

  // Logarithms as inverses of exponentials. Two plain log graphs first, then
  // "shape the inverse of …": the scholar must work the inverse out, then
  // build it. Every target is checked in algebra2Manipulatives.test.ts.
  ...at("log_graph_inverse", [
    shape("fg-a2-log-right-2", "log2", 1, 2, 0),
    shape("fg-a2-log-up-1", "log2", 1, 0, 1),
    // y = 2^x + 1  ⇒  x = 2^y + 1  ⇒  y = log₂(x − 1)
    inverse("fg-a2-log-inverse-of-exp-up-1", "log2", 1, 1, 0, "Shape the graph of the inverse of y = 2^x + 1.", "Logarithms as inverses"),
    // y = 2^(x − 3)  ⇒  y = log₂x + 3
    inverse("fg-a2-log-inverse-of-exp-right-3", "log2", 1, 0, 3, "Shape the graph of the inverse of y = 2^(x − 3).", "Logarithms as inverses"),
    // y = 2^(x + 1) − 2  ⇒  x + 2 = 2^(y + 1)  ⇒  y = log₂(x + 2) − 1
    inverse("fg-a2-log-inverse-of-exp-left-1-down-2", "log2", 1, -2, -1, "Shape the graph of the inverse of y = 2^(x + 1) − 2.", "Logarithms as inverses"),
    shape("fg-a2-log-flip-left-1", "log2", -1, -1, 0),
    // y = log₂x − 2  ⇒  x = log₂y − 2  ⇒  y = 2^(x + 2)
    inverse("fg-a2-exp-inverse-of-log-down-2", "exp2", 1, -2, 0, "Shape the graph of the inverse of y = log₂x − 2.", "Exponentials as inverses"),
    // y = log₂(x − 1)  ⇒  y = 2^x + 1
    inverse("fg-a2-exp-inverse-of-log-right-1", "exp2", 1, 0, 1, "Shape the graph of the inverse of y = log₂(x − 1).", "Exponentials as inverses"),
  ]),

  // Sketch from factored form: crosses (odd power), bounces (even power),
  // and the two ends from the degree and the leading sign.
  ...at("poly_sketch_factored", [
    sketch("fg-a2-sketch-two-crossings", [{ x: 2, multiplicity: 1 }, { x: -1, multiplicity: 1 }], 1),
    sketch("fg-a2-sketch-negative-quadratic", [{ x: 0, multiplicity: 1 }, { x: 3, multiplicity: 1 }], -1),
    sketch("fg-a2-sketch-bounce-left", [{ x: -2, multiplicity: 2 }, { x: 1, multiplicity: 1 }], 1),
    sketch("fg-a2-sketch-negative-bounce-right", [{ x: 1, multiplicity: 2 }, { x: -3, multiplicity: 1 }], -1),
    sketch("fg-a2-sketch-three-crossings", [{ x: -3, multiplicity: 1 }, { x: 1, multiplicity: 1 }, { x: 4, multiplicity: 1 }], 1),
    sketch("fg-a2-sketch-negative-2-bounce", [{ x: -1, multiplicity: 1 }, { x: 2, multiplicity: 2 }], -2),
    sketch("fg-a2-sketch-quartic-double-zero", [{ x: 0, multiplicity: 2 }, { x: 3, multiplicity: 1 }, { x: -2, multiplicity: 1 }], 1),
    // A triple zero crosses (odd), flattening as it goes: the bounce trap.
    sketch("fg-a2-sketch-quartic-triple-zero", [{ x: -2, multiplicity: 3 }, { x: 2, multiplicity: 1 }], -1),
  ]),

  // Asymptotes from the rule. Each rule is horizontal + scale/(…), worked out
  // beside it.
  ...at("rat_graph_asymptotes", [
    asymptotes("fg-a2-asym-shifted-reciprocal", "1/(x − 2) + 3", { vertical: [2], horizontal: 3, scale: 1 }),
    // (2x + 1)/(x − 1) = 2 + 3/(x − 1)
    asymptotes("fg-a2-asym-2x-plus-1-over-x-minus-1", "(2x + 1)/(x − 1)", { vertical: [1], horizontal: 2, scale: 3 }),
    // 3x/(x + 2) = 3 − 6/(x + 2)
    asymptotes("fg-a2-asym-3x-over-x-plus-2", "3x/(x + 2)", { vertical: [-2], horizontal: 3, scale: -6 }),
    // (x − 4)/(x + 1) = 1 − 5/(x + 1)
    asymptotes("fg-a2-asym-x-minus-4-over-x-plus-1", "(x − 4)/(x + 1)", { vertical: [-1], horizontal: 1, scale: -5 }),
    asymptotes("fg-a2-asym-two-factors", "4/((x − 1)(x + 3))", { vertical: [1, -3], horizontal: 0, scale: 4 }),
    // 2/(x² − 4) = 2/((x − 2)(x + 2))
    asymptotes("fg-a2-asym-2-over-x-sq-minus-4", "2/(x² − 4)", { vertical: [2, -2], horizontal: 0, scale: 2 }),
    // (2x² + 1)/(x² − 1) = 2 + 3/((x − 1)(x + 1))
    asymptotes("fg-a2-asym-2x-sq-plus-1-over-x-sq-minus-1", "(2x² + 1)/(x² − 1)", { vertical: [1, -1], horizontal: 2, scale: 3 }),
    // (x² − 2x − 1)/(x² − 2x − 3) = 1 + 2/((x − 3)(x + 1))
    asymptotes("fg-a2-asym-quadratic-over-quadratic", "(x² − 2x − 1)/(x² − 2x − 3)", { vertical: [3, -1], horizontal: 1, scale: 2 }),
    // A cancelled factor is a HOLE, not an asymptote: a line there is wrong.
    // (x − 1)/(x² + x − 2) = (x − 1)/((x − 1)(x + 2)) = 1/(x + 2), hole at 1
    asymptotes("fg-a2-asym-hole-at-1", "(x − 1)/(x² + x − 2)", { vertical: [-2], horizontal: 0, scale: 1, holes: [1] }),
    // (x² − x − 6)/(x² − 4x + 3) = (x + 2)/(x − 1) = 1 + 3/(x − 1), hole at 3
    asymptotes("fg-a2-asym-hole-at-3", "(x² − x − 6)/(x² − 4x + 3)", { vertical: [1], horizontal: 1, scale: 3, holes: [3] }),
  ]),

  // a + bi is the point (a, b). The axis cases (pure real, pure imaginary)
  // and the sign mixes are where the slips happen.
  ...at("cx_plane_plot", [
    plot("cp-a2-plot-3-plus-2i", "3 + 2i", 3, 2),
    plot("cp-a2-plot-neg-4-plus-i", "−4 + i", -4, 1),
    plot("cp-a2-plot-2-minus-5i", "2 − 5i", 2, -5),
    plot("cp-a2-plot-i", "i", 0, 1),
    plot("cp-a2-plot-neg-3i", "−3i", 0, -3),
    plot("cp-a2-plot-neg-5", "−5", -5, 0),
    plot("cp-a2-plot-neg-2-minus-4i", "−2 − 4i", -2, -4),
    plot("cp-a2-plot-neg-1-minus-i", "−1 − i", -1, -1),
  ]),
];
