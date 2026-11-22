/**
 * Known-good `functionGraph` specs: two per goal, plus a left–right flip and
 * a rational with a removable hole. One list, three readers: the
 * web Manipulative Library playlist (components/manipulative/library.ts), the
 * dev practice-item seed (`devSeedManipulativePractice` in convex/practiceSkills.ts)
 * and the iPad dev gallery (`native/src/app/dev-function-graph.tsx`). Every
 * entry passes `assertGradableManipulative` (pinned by a test).
 *
 * These are demo items, not Algebra 2 curriculum content — the real items are
 * authored against the Algebra 2 graph.
 */
import type { FunctionGraphSpec } from "./types";

export const FUNCTION_GRAPH_EXAMPLES: FunctionGraphSpec[] = [
  {
    kind: "functionGraph",
    id: "fg-abs-reflect-shift",
    concept: "Transforming |x|",
    prompt: "Shape the graph of y = −2|x − 3| + 1.",
    xMin: -6,
    xMax: 8,
    yMin: -6,
    yMax: 6,
    goal: { type: "matchTransform", parent: "abs", target: { a: -2, h: 3, k: 1 } },
  },
  {
    kind: "functionGraph",
    id: "fg-quadratic-half",
    concept: "Transforming x²",
    prompt: "Shape the graph of y = 1/2(x + 2)² − 3.",
    xMin: -7,
    xMax: 5,
    yMin: -6,
    yMax: 6,
    goal: { type: "matchTransform", parent: "quadratic", target: { a: 0.5, h: -2, k: -3 } },
  },
  {
    kind: "functionGraph",
    id: "fg-sqrt-flip-left-right",
    concept: "Reflecting √x",
    prompt: "Shape the graph of y = −√(2 − x).",
    xMin: -6,
    xMax: 6,
    yMin: -6,
    yMax: 6,
    // y = −√(−(x − 2)): flipped left–right (b = −1) AND upside down (a = −1).
    goal: { type: "matchTransform", parent: "sqrt", target: { a: -1, b: -1, h: 2, k: 0 } },
  },
  {
    kind: "functionGraph",
    id: "fg-zeros-bounce-cross",
    concept: "Zeros and end behaviour",
    prompt: "Sketch y = −(x − 1)²(x + 3): place its zeros, mark each as a cross or a bounce, and set both ends.",
    xMin: -6,
    xMax: 6,
    yMin: -6,
    yMax: 6,
    goal: {
      type: "placeZeros",
      zeros: [
        { x: 1, multiplicity: 2 },
        { x: -3, multiplicity: 1 },
      ],
      leading: -1,
    },
  },
  {
    kind: "functionGraph",
    id: "fg-zeros-three-crossings",
    concept: "Zeros and end behaviour",
    prompt: "Sketch y = x(x − 2)(x + 4): place its zeros, mark each as a cross or a bounce, and set both ends.",
    xMin: -6,
    xMax: 6,
    yMin: -6,
    yMax: 6,
    goal: {
      type: "placeZeros",
      zeros: [
        { x: 0, multiplicity: 1 },
        { x: 2, multiplicity: 1 },
        { x: -4, multiplicity: 1 },
      ],
      leading: 1,
    },
  },
  {
    kind: "functionGraph",
    id: "fg-asymptotes-linear-over-linear",
    concept: "Asymptotes of a rational function",
    prompt: "Drag the dashed lines onto the asymptotes of y = (2x + 1)/(x + 3).",
    xMin: -8,
    xMax: 4,
    yMin: -4,
    yMax: 8,
    // (2x + 1)/(x + 3) = 2 − 5/(x + 3)
    goal: { type: "placeAsymptotes", rational: { vertical: [-3], horizontal: 2, scale: -5 } },
  },
  {
    kind: "functionGraph",
    id: "fg-asymptotes-two-verticals",
    concept: "Asymptotes of a rational function",
    prompt: "Drag the dashed lines onto the asymptotes of y = 4/((x − 1)(x + 2)) − 1.",
    xMin: -6,
    xMax: 6,
    yMin: -6,
    yMax: 6,
    goal: { type: "placeAsymptotes", rational: { vertical: [1, -2], horizontal: -1, scale: 4 } },
  },
  {
    kind: "functionGraph",
    id: "fg-asymptotes-with-hole",
    concept: "Asymptotes and holes",
    prompt: "Drag the dashed lines onto the asymptotes of y = (x + 1)/((x + 1)(x − 2)).",
    xMin: -6,
    xMax: 6,
    yMin: -6,
    yMax: 6,
    // Simplifies to 1/(x − 2) with a hole at x = −1 — a line there is wrong.
    goal: { type: "placeAsymptotes", rational: { vertical: [2], horizontal: 0, scale: 1, holes: [-1] } },
  },
];
