/**
 * Seed data: authored "Launchpad" instruction for the Algebra 2 domain.
 *
 * Two grains, both stored through the same verify→store gate as the rest of
 * `instructionSeed.ts` (which spreads these lists into `AUTHORED_LAUNCHPADS`):
 *
 *  - STRAND doorways (`strand:algebra-2:<strand>`), one per strand. Each opens
 *    with a real reason the idea exists, says the one idea, works one example
 *    on its own numbers, then hands the scholar a try_it. Three strands add a
 *    `functionGraph` (or complex-plane) manipulative where dragging a graph
 *    teaches the idea faster than words.
 *  - NODE entries (`node:<nodeKey>`, via `nodeKey`) for the nodes where a
 *    first-timer needs a specific idea or trap named: one micro_explain, a
 *    3–5 step worked example, and a try_it. These are what "See the move"
 *    shows for that node, and the inline move for a framed item that has no
 *    worked steps of its own (instructionEntries.ts, "The MOVE").
 *
 * Written for a young scholar working alone on an iPad: short, one idea per
 * atom, concrete before abstract, and the question before the telling.
 *
 * Rendering (checked 2026-11): worked-example and try_it steps, prompts and
 * answers go through `FractionText` on web and native, which typesets `\( … \)`
 * spans, so those use spans for anything with a fraction, root, log or
 * subscript. story_hook and micro_explain render as plain text on both
 * clients, so they use Unicode (x², √, log₂) and never a span.
 *
 * Try_it answers are graded by value only (`gradeTryItAtom`), never by form.
 * Where the node's skill IS a form (simplify, rationalize, expand), the try_it
 * asks for a number or a part, so typing the question back cannot pass.
 */

import { ALGEBRA_2_DOMAIN } from "./algebra2Graph";
import { tex } from "../lib/practice/algebra2/format";
import type { CoordinatePlaneSpec, FunctionGraphSpec } from "../../lib/manipulative/types";
import type { SeedLaunchpad } from "./instructionSeed";

export const ALGEBRA_2_ANCHOR_STRANDS: { domain: string; strand: string }[] = [
  { domain: ALGEBRA_2_DOMAIN, strand: "functions" },
  { domain: ALGEBRA_2_DOMAIN, strand: "complex-quadratics" },
  { domain: ALGEBRA_2_DOMAIN, strand: "polynomials" },
  { domain: ALGEBRA_2_DOMAIN, strand: "rational" },
  { domain: ALGEBRA_2_DOMAIN, strand: "radicals-rational-exponents" },
  { domain: ALGEBRA_2_DOMAIN, strand: "exponential-logarithmic" },
  { domain: ALGEBRA_2_DOMAIN, strand: "sequences-series" },
];

// ── Manipulatives (ungraded explainer use; each spec has a goal so the stage
// can say "you did it") ──────────────────────────────────────────────────────

const SLIDE_PARABOLA: FunctionGraphSpec = {
  kind: "functionGraph",
  id: "alg2-launchpad-slide-parabola",
  concept: "Sliding a parabola",
  prompt: `Shape the graph of ${tex("y = (x - 3)^{2} + 1")}. Which way did the minus send it?`,
  xMin: -4,
  xMax: 8,
  yMin: -3,
  yMax: 9,
  goal: { type: "matchTransform", parent: "quadratic", target: { a: 1, h: 3, k: 1 } },
};

const QUARTER_TURN: CoordinatePlaneSpec = {
  kind: "coordinatePlane",
  id: "alg2-launchpad-quarter-turn",
  concept: "Multiplying by i",
  prompt: `The point is 2 + i. Multiplying by i turns it a quarter-turn around 0. Drag the dot to ${tex("i(2 + i)")}.`,
  xMin: -4,
  xMax: 4,
  yMin: -4,
  yMax: 4,
  gridStep: 1,
  axisLabels: { x: "Re", y: "Im" },
  fixedPoints: [{ x: 2, y: 1, label: "2 + i" }],
  draggable: [{ start: { x: 0, y: 0 } }],
  // i(2 + i) = 2i + i² = −1 + 2i
  goal: { type: "placePoint", x: -1, y: 2 },
};

const CROSS_OR_BOUNCE: FunctionGraphSpec = {
  kind: "functionGraph",
  id: "alg2-launchpad-cross-or-bounce",
  concept: "Crossing or bouncing",
  prompt: `Sketch ${tex("y = (x - 1)^{2}(x + 2)")}: place its zeros, mark each as a cross or a bounce, and set both ends.`,
  xMin: -5,
  xMax: 5,
  yMin: -6,
  yMax: 6,
  goal: {
    type: "placeZeros",
    zeros: [
      { x: 1, multiplicity: 2 },
      { x: -2, multiplicity: 1 },
    ],
    leading: 1,
  },
};

const FORBIDDEN_INPUT: FunctionGraphSpec = {
  kind: "functionGraph",
  id: "alg2-launchpad-forbidden-input",
  concept: "Where the graph cannot go",
  prompt: `Drag the dashed lines onto the asymptotes of ${tex("y = \\frac{1}{x - 2} + 1")}.`,
  xMin: -4,
  xMax: 8,
  yMin: -5,
  yMax: 7,
  goal: { type: "placeAsymptotes", rational: { vertical: [2], horizontal: 1, scale: 1 } },
};

// ── Strand doorways ──────────────────────────────────────────────────────────

export const ALGEBRA_2_STRAND_LAUNCHPADS: SeedLaunchpad[] = [
  {
    domain: ALGEBRA_2_DOMAIN,
    strand: "functions",
    title: "Slide, stretch and flip a graph",
    subtitle: "Change the input or the output",
    atoms: [
      {
        kind: "story_hook",
        hook: "Drag a sprite in a level editor and its x and y change. A graph can be dragged the same way. One move has a twist: f(x − 3) slides the graph right, toward +3. Why right, when the sign says minus?",
      },
      {
        kind: "micro_explain",
        text: "f(x) + k moves the graph up k. f(x − h) moves it right h: the new graph reaches each old height h steps later. a·f(x) stretches it, and a negative a flips it over the x-axis.",
      },
      { kind: "manipulative", spec: JSON.stringify(SLIDE_PARABOLA) },
      {
        kind: "worked_example",
        strategyLabel: "Follow the vertex",
        steps: [
          `On ${tex("y = x^{2}")}, the low point is where the inside is 0: at x = 0.`,
          `On ${tex("y = (x - 3)^{2}")}, the inside is x − 3.`,
          "x − 3 is 0 when x = 3.",
          "So the low point moved from x = 0 to x = 3: the graph slid 3 to the right.",
        ],
        examplePrompt: `Which way does ${tex("y = (x - 3)^{2}")} move from ${tex("y = x^{2}")}?`,
        exampleAnswer: "3 to the right",
      },
      {
        kind: "try_it",
        strategyLabel: "Follow the corner",
        steps: [
          `The corner of ${tex("y = \\lvert x \\rvert")} is where the inside is 0.`,
          `On ${tex("y = \\lvert x + 4 \\rvert - 2")}, the inside is x + 4.`,
          "Solve x + 4 = 0.",
          "x = −4, so the graph slid 4 to the left.",
        ],
        examplePrompt: `What is the x-coordinate of the corner of ${tex("y = \\lvert x + 4 \\rvert - 2")}?`,
        exampleAnswer: "-4",
        answerType: "integer",
      },
    ],
  },
  {
    domain: ALGEBRA_2_DOMAIN,
    strand: "complex-quadratics",
    title: "A number for the square root of −1",
    subtitle: "Step off the line onto a plane",
    atoms: [
      {
        kind: "story_hook",
        hook: "Ask a calculator for √−1 and it says error. Every square on the number line is 0 or more, so x² = −1 has nowhere to land there. The answer was to step off the line, sideways.",
      },
      {
        kind: "micro_explain",
        text: "Call the new number i, with i² = −1. Multiplying by i turns a point a quarter-turn around 0: 1, i, −1, −i, then back to 1. Numbers a + bi live on a plane, real part across and imaginary part up.",
      },
      { kind: "manipulative", spec: JSON.stringify(QUARTER_TURN) },
      {
        kind: "worked_example",
        strategyLabel: "Trade i² for −1",
        steps: [
          `Find ${tex("i^{3}")}.`,
          `${tex("i^{3} = i^{2} \\cdot i")}.`,
          `${tex("i^{2} = -1")}, so ${tex("i^{3} = -1 \\cdot i")}.`,
          `So ${tex("i^{3} = -i")}: three quarter-turns from 1.`,
        ],
        examplePrompt: `What is ${tex("i^{3}")}?`,
        exampleAnswer: "-i",
      },
      {
        kind: "try_it",
        strategyLabel: "Trade i² for −1",
        steps: [
          `Find ${tex("i^{4}")}.`,
          `${tex("i^{4} = i^{2} \\cdot i^{2}")}.`,
          "That is (−1) · (−1).",
          `So ${tex("i^{4} = 1")}: four quarter-turns is a full turn.`,
        ],
        examplePrompt: `What is ${tex("i^{4}")}?`,
        exampleAnswer: "1",
        answerType: "integer",
      },
    ],
  },
  {
    domain: ALGEBRA_2_DOMAIN,
    strand: "polynomials",
    title: "Zeros are where the graph meets the axis",
    subtitle: "Each factor tells you one",
    atoms: [
      {
        kind: "story_hook",
        hook: "Where does y = (x − 1)²(x + 2) meet the x-axis? A product is 0 only when one of its factors is 0, so each factor points to a spot. Look closely and the curve does something different at each one.",
      },
      {
        kind: "micro_explain",
        text: "A zero is an x that makes the polynomial 0: a spot where the graph meets the x-axis. The factor (x − 1) gives x = 1. A factor used once crosses the axis. A squared factor only touches it and bounces back, since a square is never negative.",
      },
      { kind: "manipulative", spec: JSON.stringify(CROSS_OR_BOUNCE) },
      {
        kind: "worked_example",
        strategyLabel: "Set each factor to 0",
        steps: [
          `Find the zeros of ${tex("y = (x - 1)^{2}(x + 2)")}.`,
          "The product is 0 when one of its factors is 0.",
          "x − 1 = 0 gives x = 1. That factor is squared, so the graph bounces there.",
          "x + 2 = 0 gives x = −2. That factor appears once, so the graph crosses there.",
        ],
        examplePrompt: `Where does ${tex("y = (x - 1)^{2}(x + 2)")} meet the x-axis?`,
        exampleAnswer: "x = 1 (bounce) and x = −2 (cross)",
      },
      {
        kind: "try_it",
        strategyLabel: "Set each factor to 0",
        steps: [
          `Find every zero of ${tex("y = x(x - 3)^{2}(x + 1)")}.`,
          "The factor x gives x = 0.",
          "The factor (x − 3)² gives x = 3, a bounce.",
          "The factor x + 1 gives x = −1, so the zeros are 0, 3 and −1.",
        ],
        examplePrompt: `Give every zero of ${tex("y = x(x - 3)^{2}(x + 1)")}.`,
        exampleAnswer: "0, 3, -1",
        answerType: "solutionSet",
      },
    ],
  },
  {
    domain: ALGEBRA_2_DOMAIN,
    strand: "rational",
    title: "A fraction made of polynomials",
    subtitle: "Some inputs are not allowed",
    atoms: [
      {
        kind: "story_hook",
        hook: "Some programs crash on one input. Feed x = 2 into 1/(x − 2) and you get 1/0, which has no value at all. Fractions built from polynomials have inputs like that, and those inputs shape the whole graph.",
      },
      {
        kind: "micro_explain",
        text: "A rational expression is one polynomial over another. Any x that makes the bottom 0 is not allowed. Near it the values blow up, and the graph runs along a vertical line it never touches: an asymptote.",
      },
      { kind: "manipulative", spec: JSON.stringify(FORBIDDEN_INPUT) },
      {
        kind: "worked_example",
        strategyLabel: "Find where the bottom is 0",
        steps: [
          `Which x are not allowed in ${tex("\\frac{x + 1}{x^{2} - 9}")}?`,
          `Set the bottom to 0: ${tex("x^{2} - 9 = 0")}.`,
          `Factor: ${tex("(x - 3)(x + 3) = 0")}.`,
          "So x = 3 and x = −3 are not allowed.",
        ],
        examplePrompt: `Which x are not allowed in ${tex("\\frac{x + 1}{x^{2} - 9}")}?`,
        exampleAnswer: "x = 3 and x = −3",
      },
      {
        kind: "try_it",
        strategyLabel: "Find where the bottom is 0",
        steps: [
          `Set the bottom of ${tex("\\frac{5}{2x - 8}")} to 0: 2x − 8 = 0.`,
          "Add 8 to both sides: 2x = 8.",
          "Divide by 2: x = 4 is not allowed.",
        ],
        examplePrompt: `Which x is not allowed in ${tex("\\frac{5}{2x - 8}")}?`,
        exampleAnswer: "4",
        answerType: "integer",
      },
    ],
  },
  {
    domain: ALGEBRA_2_DOMAIN,
    strand: "radicals-rational-exponents",
    title: "What a fraction exponent has to mean",
    subtitle: "Keep the exponent rules working",
    atoms: [
      {
        kind: "story_hook",
        hook: "Multiplying powers adds exponents: 8² · 8³ = 8⁵. Keep that rule for fractions, and 8^(1/3) three times over is 8^(1/3 + 1/3 + 1/3) = 8¹ = 8. So which number is 8^(1/3)?",
      },
      {
        kind: "micro_explain",
        text: "If the rules keep working, x^(1/n) must be the nth root of x, since n copies multiply to x. Then x^(m/n) is that root raised to the m. The bottom of the fraction picks the root; the top picks the power.",
      },
      {
        kind: "worked_example",
        strategyLabel: "Root first, then power",
        steps: [
          `Evaluate ${tex("27^{2/3}")}.`,
          `The 3 on the bottom means a cube root: ${tex("\\sqrt[3]{27} = 3")}.`,
          `The 2 on top means square it: ${tex("3^{2} = 9")}.`,
          `So ${tex("27^{2/3} = 9")}.`,
        ],
        examplePrompt: `What is ${tex("27^{2/3}")}?`,
        exampleAnswer: "9",
      },
      {
        kind: "try_it",
        strategyLabel: "Root first, then power",
        steps: [
          `Evaluate ${tex("16^{3/4}")}.`,
          `The 4 on the bottom means a fourth root: ${tex("\\sqrt[4]{16} = 2")}.`,
          "The 3 on top means cube it.",
          `${tex("2^{3} = 8")}, so ${tex("16^{3/4} = 8")}.`,
        ],
        examplePrompt: `What is ${tex("16^{3/4}")}?`,
        exampleAnswer: "8",
        answerType: "integer",
      },
    ],
  },
  {
    domain: ALGEBRA_2_DOMAIN,
    strand: "exponential-logarithmic",
    title: "A logarithm answers \"what exponent?\"",
    subtitle: "Count the doublings",
    atoms: [
      {
        kind: "story_hook",
        hook: "Start at 1 and keep doubling: 2, 4, 8, 16. How many doublings until you pass a million? Binary search asks the same thing backward: how many halvings shrink a million items down to 1?",
      },
      {
        kind: "micro_explain",
        text: "log₂(8) = 3 because 2³ = 8. The log asks which exponent turns the base into the number. log₂(1,000,000) is about 20, which is why a binary search through a million sorted items takes about 20 steps.",
      },
      {
        kind: "worked_example",
        strategyLabel: "Count the doublings",
        steps: [
          `Evaluate ${tex("\\log_{2} 32")}: 2 to what power is 32?`,
          "Double from 1: 2, 4, 8, 16, 32.",
          `That is 5 doublings, so ${tex("2^{5} = 32")}.`,
          `So ${tex("\\log_{2} 32 = 5")}.`,
        ],
        examplePrompt: `What is ${tex("\\log_{2} 32")}?`,
        exampleAnswer: "5",
      },
      {
        kind: "try_it",
        strategyLabel: "Count the factors",
        steps: [
          `Evaluate ${tex("\\log_{3} 81")}: 3 to what power is 81?`,
          "Multiply by 3 from 1: 3, 9, 27, 81.",
          `That is 4 factors of 3, so ${tex("\\log_{3} 81 = 4")}.`,
        ],
        examplePrompt: `What is ${tex("\\log_{3} 81")}?`,
        exampleAnswer: "4",
        answerType: "integer",
      },
    ],
  },
  {
    domain: ALGEBRA_2_DOMAIN,
    strand: "sequences-series",
    title: "A rule that makes a list",
    subtitle: "Jump to any term without the loop",
    atoms: [
      {
        kind: "story_hook",
        hook: "A loop that adds 1 + 2 + … + 100 takes 100 passes. The story goes that a schoolboy did it in seconds with no loop: 1 + 100 = 101, 2 + 99 = 101, and every pair after that makes 101 too.",
      },
      {
        kind: "micro_explain",
        text: "An arithmetic sequence adds the same step d each time, like a loop running a = a + d. To jump straight to term n, take n − 1 steps: aₙ = a₁ + (n − 1)d. Adding up the terms of a sequence gives a series.",
      },
      {
        kind: "worked_example",
        strategyLabel: "Pair the ends",
        steps: [
          "Add 1 + 2 + 3 + … + 100.",
          "Pair the first and last: 1 + 100 = 101. Then 2 + 99 = 101, and so on.",
          "100 terms make 50 pairs.",
          "So the sum is 50 · 101 = 5050.",
        ],
        examplePrompt: "What is 1 + 2 + 3 + … + 100?",
        exampleAnswer: "5050",
      },
      {
        kind: "try_it",
        strategyLabel: "Count the steps",
        steps: [
          "In 3, 7, 11, 15, …, the first term is 3 and the step is 4.",
          "To reach term 20 from term 1 you take 19 steps.",
          "19 steps of 4 is 76.",
          "So the 20th term is 3 + 76 = 79.",
        ],
        examplePrompt: "What is the 20th term of 3, 7, 11, 15, …?",
        exampleAnswer: "79",
        answerType: "integer",
      },
    ],
  },
];

// ── Node entries ─────────────────────────────────────────────────────────────

/** One node entry: the idea (and its trap), a worked example, a try_it. */
function nodeEntry(
  strand: string,
  nodeKey: string,
  title: string,
  atoms: SeedLaunchpad["atoms"],
): SeedLaunchpad {
  return { domain: ALGEBRA_2_DOMAIN, strand, nodeKey, title, atoms };
}

export const ALGEBRA_2_NODE_LAUNCHPADS: SeedLaunchpad[] = [
  // ── functions ──
  nodeEntry("functions", "fn_transform_translate", "The inside moves it the other way", [
    {
      kind: "micro_explain",
      text: "f(x) + k moves the graph up k. f(x − h) moves it right h, opposite to the sign you see, because x has to be h bigger to give the same inside. So f(x + 2) moves left 2.",
    },
    {
      kind: "worked_example",
      strategyLabel: "Read the inside, then the outside",
      steps: [
        `Compare ${tex("y = (x + 2)^{2} - 5")} with ${tex("y = x^{2}")}.`,
        "Inside: x + 2 is 0 when x = −2, so the graph moves left 2.",
        "Outside: − 5 moves it down 5.",
        "So the vertex moves from (0, 0) to (−2, −5).",
      ],
      examplePrompt: `How does ${tex("y = (x + 2)^{2} - 5")} move from ${tex("y = x^{2}")}?`,
      exampleAnswer: "Left 2, down 5",
    },
    {
      kind: "try_it",
      strategyLabel: "Find where the inside is 0",
      steps: [
        `${tex("y = \\sqrt{x}")} starts at (0, 0), where the inside is 0.`,
        `On ${tex("y = \\sqrt{x - 6} + 1")}, the inside x − 6 is 0 when x = 6.`,
        "So the start moved to (6, 1), and h = 6.",
      ],
      examplePrompt: `${tex("y = \\sqrt{x - 6} + 1")} starts at (h, k). What is h?`,
      exampleAnswer: "6",
      answerType: "integer",
    },
  ]),
  nodeEntry("functions", "fn_compose", "Run the inside function first", [
    {
      kind: "micro_explain",
      text: "f(g(x)) is a pipeline: run g first, then feed its output into f, just like calling f(g(3)) in code. Work from the inside out. Order matters: f(g(x)) and g(f(x)) are usually different.",
    },
    {
      kind: "worked_example",
      strategyLabel: "Inside out",
      steps: [
        `Let ${tex("f(x) = 2x + 1")} and ${tex("g(x) = x^{2}")}. Find f(g(3)).`,
        `Inside first: ${tex("g(3) = 3^{2} = 9")}.`,
        "Feed 9 into f: f(9) = 2 · 9 + 1.",
        "So f(g(3)) = 19.",
      ],
      examplePrompt: `With ${tex("f(x) = 2x + 1")} and ${tex("g(x) = x^{2}")}, what is f(g(3))?`,
      exampleAnswer: "19",
    },
    {
      kind: "try_it",
      strategyLabel: "Inside out",
      steps: [
        "Same f and g. Now find g(f(3)): f runs first.",
        "f(3) = 2 · 3 + 1 = 7.",
        `Feed 7 into g: ${tex("g(7) = 7^{2}")}.`,
        "So g(f(3)) = 49, not the 19 that f(g(3)) gave.",
      ],
      examplePrompt: `With ${tex("f(x) = 2x + 1")} and ${tex("g(x) = x^{2}")}, what is g(f(3))?`,
      exampleAnswer: "49",
      answerType: "integer",
    },
  ]),
  nodeEntry("functions", "fn_inverse_find", "Swap x and y, then solve", [
    {
      kind: "micro_explain",
      text: "An inverse runs a function backward: if f sends 2 to 7, f⁻¹ sends 7 back to 2. To find it, write y = f(x), swap x and y, and solve for y. Careful: f⁻¹(x) means the inverse, not 1/f(x).",
    },
    {
      kind: "worked_example",
      strategyLabel: "Swap, then undo",
      steps: [
        "Write f(x) = 3x − 4 as y = 3x − 4.",
        "Swap x and y: x = 3y − 4.",
        "Add 4: x + 4 = 3y.",
        `Divide by 3: ${tex("f^{-1}(x) = \\frac{x + 4}{3}")}.`,
      ],
      examplePrompt: `Find ${tex("f^{-1}(x)")} for ${tex("f(x) = 3x - 4")}.`,
      exampleAnswer: "(x + 4)/3",
    },
    {
      kind: "try_it",
      strategyLabel: "Swap, then undo",
      steps: [
        "Write f(x) = 2x + 6 as y = 2x + 6.",
        "Swap x and y: x = 2y + 6.",
        "Subtract 6: x − 6 = 2y.",
        `Divide by 2: ${tex("f^{-1}(x) = \\frac{x - 6}{2}")}.`,
      ],
      examplePrompt: `Find ${tex("f^{-1}(x)")} for ${tex("f(x) = 2x + 6")}.`,
      exampleAnswer: "(x-6)/2",
      answerType: "expression",
    },
  ]),

  // ── complex-quadratics ──
  nodeEntry("complex-quadratics", "cx_imaginary_unit", "Square roots of negatives use i", [
    {
      kind: "micro_explain",
      text: "√ of a negative is not \"no answer\" any more. Pull out √−1 = i: √−9 = 3i. Powers of i repeat every four, like n % 4 in code: i¹ = i, i² = −1, i³ = −i, i⁴ = 1, then round again.",
    },
    {
      kind: "worked_example",
      strategyLabel: "Split off the −1",
      steps: [
        `${tex("\\sqrt{-12} = \\sqrt{12} \\cdot \\sqrt{-1}")}.`,
        `${tex("\\sqrt{-1} = i")}.`,
        `${tex("\\sqrt{12} = \\sqrt{4 \\cdot 3} = 2\\sqrt{3}")}.`,
        `So ${tex("\\sqrt{-12} = 2i\\sqrt{3}")}.`,
      ],
      examplePrompt: `Simplify ${tex("\\sqrt{-12}")}.`,
      exampleAnswer: "2i√3",
    },
    {
      kind: "try_it",
      strategyLabel: "Use the cycle of four",
      steps: [
        `Powers of i repeat every 4, and ${tex("i^{8} = 1")}.`,
        `10 = 8 + 2, so ${tex("i^{10} = i^{8} \\cdot i^{2}")}.`,
        `That is ${tex("1 \\cdot i^{2}")}.`,
        `So ${tex("i^{10} = -1")}.`,
      ],
      examplePrompt: `What is ${tex("i^{10}")}?`,
      exampleAnswer: "-1",
      answerType: "integer",
    },
  ]),
  nodeEntry("complex-quadratics", "cx_multiply", "Multiply out, then trade i² for −1", [
    {
      kind: "micro_explain",
      text: "Multiply complex numbers like binomials, every part by every part, then replace i² with −1. Watch where it lands: −1 is real, so the i² term joins the real part.",
    },
    {
      kind: "worked_example",
      strategyLabel: "Every part by every part",
      steps: [
        `${tex("(2 + 3i)(1 - i) = 2 - 2i + 3i - 3i^{2}")}.`,
        `Replace ${tex("i^{2}")} with −1: ${tex("-3i^{2} = +3")}.`,
        "Real parts: 2 + 3 = 5. Imaginary parts: −2i + 3i = i.",
        "So the product is 5 + i.",
      ],
      examplePrompt: `Multiply ${tex("(2 + 3i)(1 - i)")}.`,
      exampleAnswer: "5 + i",
    },
    {
      kind: "try_it",
      strategyLabel: "Every part by every part",
      steps: [
        `${tex("(3 + 2i)(3 - 2i) = 9 - 6i + 6i - 4i^{2}")}.`,
        "The i terms cancel: −6i + 6i = 0.",
        `${tex("-4i^{2} = -4(-1) = 4")}.`,
        "So the product is 9 + 4 = 13, with no i left.",
      ],
      examplePrompt: `Multiply ${tex("(3 + 2i)(3 - 2i)")}.`,
      exampleAnswer: "13",
      answerType: "integer",
    },
  ]),
  nodeEntry("complex-quadratics", "cx_divide", "Clear i from the bottom with the conjugate", [
    {
      kind: "micro_explain",
      text: "An answer in a + bi form has no i on the bottom. Multiply top and bottom by the conjugate, the same number with the sign of its i part flipped. The bottom becomes a plain real number.",
    },
    {
      kind: "worked_example",
      strategyLabel: "Multiply by the conjugate",
      steps: [
        `Divide ${tex("\\frac{5}{1 + 2i}")}. The conjugate of 1 + 2i is 1 − 2i.`,
        "Top: 5(1 − 2i) = 5 − 10i.",
        "Bottom: (1 + 2i)(1 − 2i) = 1 + 4 = 5.",
        `So the quotient is ${tex("\\frac{5 - 10i}{5} = 1 - 2i")}.`,
      ],
      examplePrompt: `Write ${tex("\\frac{5}{1 + 2i}")} in the form a + bi.`,
      exampleAnswer: "1 − 2i",
    },
    {
      kind: "try_it",
      strategyLabel: "Multiply by the conjugate",
      steps: [
        `For ${tex("\\frac{10}{3 + i}")}, multiply top and bottom by 3 − i.`,
        "Top: 10(3 − i) = 30 − 10i.",
        "Bottom: (3 + i)(3 − i) = 9 + 1 = 10.",
        "So the quotient is 3 − i, and a = 3.",
      ],
      examplePrompt: `Write ${tex("\\frac{10}{3 + i}")} as a + bi. What is a?`,
      exampleAnswer: "3",
      answerType: "integer",
    },
  ]),
  nodeEntry("complex-quadratics", "quad_complex_roots", "A negative discriminant gives a pair", [
    {
      kind: "micro_explain",
      text: "When b² − 4ac is negative the parabola never meets the x-axis, so there is no real solution. The quadratic formula still works: the square root of the negative gives an i, and the solutions come as a pair, p + qi and p − qi.",
    },
    {
      kind: "worked_example",
      strategyLabel: "Quadratic formula with i",
      steps: [
        `Solve ${tex("x^{2} + 2x + 5 = 0")}: a = 1, b = 2, c = 5.`,
        `Discriminant: ${tex("2^{2} - 4 \\cdot 1 \\cdot 5 = -16")}.`,
        `${tex("\\sqrt{-16} = 4i")}, so ${tex("x = \\frac{-2 \\pm 4i}{2}")}.`,
        "So x = −1 + 2i or x = −1 − 2i.",
      ],
      examplePrompt: `Solve ${tex("x^{2} + 2x + 5 = 0")}.`,
      exampleAnswer: "x = −1 + 2i or x = −1 − 2i",
    },
    {
      kind: "try_it",
      strategyLabel: "Undo the square, keep the i",
      steps: [
        `Solve ${tex("x^{2} + 9 = 0")}. Subtract 9: ${tex("x^{2} = -9")}.`,
        `Take square roots: ${tex("x = \\pm\\sqrt{-9}")}.`,
        `${tex("\\sqrt{-9} = 3i")}, so x = 3i or x = −3i.`,
      ],
      examplePrompt: `Solve ${tex("x^{2} + 9 = 0")}. Give every solution.`,
      exampleAnswer: "3i, -3i",
      answerType: "solutionSet",
    },
  ]),

  // ── polynomials ──
  nodeEntry("polynomials", "poly_zeros_multiplicity", "The power on a factor says cross or bounce", [
    {
      kind: "micro_explain",
      text: "Each factor (x − r) gives a zero at x = r, and its power is the multiplicity. An odd power crosses the x-axis; an even power touches it and bounces back. Mind the sign: (x + 4) gives the zero −4.",
    },
    {
      kind: "worked_example",
      strategyLabel: "Read each factor",
      steps: [
        `Find the zeros of ${tex("y = (x - 2)^{3}(x + 1)^{2}")}.`,
        "x − 2 = 0 gives x = 2. Its power is 3, odd, so the graph crosses.",
        "x + 1 = 0 gives x = −1. Its power is 2, even, so the graph bounces.",
      ],
      examplePrompt: `Find the zeros of ${tex("y = (x - 2)^{3}(x + 1)^{2}")} and their multiplicities.`,
      exampleAnswer: "2 (multiplicity 3) and −1 (multiplicity 2)",
    },
    {
      kind: "try_it",
      strategyLabel: "Read each factor",
      steps: [
        `In ${tex("y = x^{2}(x - 5)^{4}(x + 1)")}, the zero x = 5 comes from x − 5.`,
        "That factor is raised to the power 4.",
        "So its multiplicity is 4, an even power: a bounce.",
      ],
      examplePrompt: `What is the multiplicity of the zero x = 5 in ${tex("y = x^{2}(x - 5)^{4}(x + 1)")}?`,
      exampleAnswer: "4",
      answerType: "integer",
    },
  ]),
  nodeEntry("polynomials", "poly_long_division", "Divide, multiply, subtract, bring down", [
    {
      kind: "micro_explain",
      text: "Polynomial long division runs the same loop as long division of numbers: divide the leading terms, multiply back, subtract, bring down. Stop when what is left has a lower degree than the divisor. That leftover is the remainder.",
    },
    {
      kind: "worked_example",
      strategyLabel: "Run the division loop",
      steps: [
        `Divide ${tex("x^{2} + 5x + 6")} by x + 2.`,
        "x^2 ÷ x = x. Multiply back: x^2 + 2x. Subtract: 3x. Bring down + 6.",
        "3x ÷ x = 3. Multiply back: 3x + 6. Subtract: 0.",
        "So the quotient is x + 3 and the remainder is 0.",
      ],
      examplePrompt: `Divide ${tex("x^{2} + 5x + 6")} by x + 2.`,
      exampleAnswer: "x + 3",
    },
    {
      kind: "try_it",
      strategyLabel: "Run the division loop",
      steps: [
        `Divide ${tex("x^{2} + 6x + 11")} by x + 2.`,
        "x^2 ÷ x = x. Multiply back: x^2 + 2x. Subtract: 4x. Bring down + 11.",
        "4x ÷ x = 4. Multiply back: 4x + 8.",
        "Subtract: 11 − 8 = 3. Nothing divides by x now, so the remainder is 3.",
      ],
      examplePrompt: `What is the remainder when ${tex("x^{2} + 6x + 11")} is divided by x + 2?`,
      exampleAnswer: "3",
      answerType: "integer",
    },
  ]),
  nodeEntry("polynomials", "poly_synthetic_division", "Synthetic division keeps only the numbers", [
    {
      kind: "micro_explain",
      text: "To divide by x − a, write a and the coefficients. Bring the first one down, then loop: multiply by a, add to the next. The last number is the remainder; the rest are the quotient. For x + 3, a is −3.",
    },
    {
      kind: "worked_example",
      strategyLabel: "Multiply by a, add",
      steps: [
        `Divide ${tex("x^{3} - 2x^{2} - 5x + 6")} by x − 3: a = 3, coefficients 1, −2, −5, 6.`,
        "Bring down 1. Then 1 · 3 = 3, and −2 + 3 = 1.",
        "Then 1 · 3 = 3, and −5 + 3 = −2. Then −2 · 3 = −6, and 6 − 6 = 0.",
        `The quotient is ${tex("x^{2} + x - 2")}, remainder 0.`,
      ],
      examplePrompt: `Divide ${tex("x^{3} - 2x^{2} - 5x + 6")} by x − 3.`,
      exampleAnswer: "x^2 + x − 2",
    },
    {
      kind: "try_it",
      strategyLabel: "Multiply by a, add",
      steps: [
        `Divide ${tex("2x^{2} + 3x - 4")} by x + 2: a = −2, coefficients 2, 3, −4.`,
        "Bring down 2. Then 2 · (−2) = −4, and 3 + (−4) = −1.",
        "Then −1 · (−2) = 2, and −4 + 2 = −2: the remainder.",
      ],
      examplePrompt: `What is the remainder when ${tex("2x^{2} + 3x - 4")} is divided by x + 2?`,
      exampleAnswer: "-2",
      answerType: "integer",
    },
  ]),
  nodeEntry("polynomials", "poly_remainder_theorem", "The remainder is p(a)", [
    {
      kind: "micro_explain",
      text: "When p(x) is divided by x − a, the remainder equals p(a). So you can find a remainder just by plugging a in. A remainder of 0 means x − a is a factor.",
    },
    {
      kind: "worked_example",
      strategyLabel: "Plug in a",
      steps: [
        `Divide ${tex("p(x) = x^{3} - 4x + 1")} by x − 2, so a = 2.`,
        `${tex("p(2) = 2^{3} - 4 \\cdot 2 + 1")}.`,
        "That is 8 − 8 + 1 = 1, so the remainder is 1.",
      ],
      examplePrompt: `What is the remainder when ${tex("x^{3} - 4x + 1")} is divided by x − 2?`,
      exampleAnswer: "1",
    },
    {
      kind: "try_it",
      strategyLabel: "Plug in a",
      steps: [
        "x + 1 = x − (−1), so a = −1.",
        `${tex("p(-1) = (-1)^{4} - 3(-1)^{2} + 5")}.`,
        "That is 1 − 3 + 5 = 3.",
      ],
      examplePrompt: `What is the remainder when ${tex("x^{4} - 3x^{2} + 5")} is divided by x + 1?`,
      exampleAnswer: "3",
      answerType: "integer",
    },
  ]),

  // ── rational ──
  nodeEntry("rational", "rat_simplify", "Cancel factors, never terms", [
    {
      kind: "micro_explain",
      text: "Cancel factors, never terms. Factor first: (x² − 9)/(x − 3) is (x − 3)(x + 3)/(x − 3), and the shared factor x − 3 cancels to leave x + 3. Crossing out the x's in (x + 2)/x is the classic slip: that x is only part of a sum.",
    },
    {
      kind: "worked_example",
      strategyLabel: "Factor, then cancel",
      steps: [
        `Simplify ${tex("\\frac{x^{2} + 5x + 6}{x + 2}")}.`,
        "Factor the top: (x + 2)(x + 3).",
        "x + 2 is a factor of both the top and the bottom.",
        "Cancel it: x + 3, for every x except −2.",
      ],
      examplePrompt: `Simplify ${tex("\\frac{x^{2} + 5x + 6}{x + 2}")}.`,
      exampleAnswer: "x + 3",
    },
    {
      kind: "try_it",
      strategyLabel: "Factor, then cancel",
      steps: [
        `Factor the top of ${tex("\\frac{x^{2} - 16}{x + 4}")}: (x − 4)(x + 4).`,
        "Cancel the shared factor x + 4.",
        "What is left is x − 4, so c = −4.",
      ],
      examplePrompt: `${tex("\\frac{x^{2} - 16}{x + 4}")} simplifies to x + c. What is c?`,
      exampleAnswer: "-4",
      answerType: "integer",
    },
  ]),
  nodeEntry("rational", "rat_add_subtract", "Common bottom first, then add the tops", [
    {
      kind: "micro_explain",
      text: "Adding rational expressions works like adding number fractions: you need a common denominator first. Build it from the factors of each bottom, rewrite each fraction over it, then add the tops. The bottoms never get added.",
    },
    {
      kind: "worked_example",
      strategyLabel: "Rewrite over a common bottom",
      steps: [
        `Add ${tex("\\frac{2}{x} + \\frac{3}{x + 1}")}. Common bottom: x(x + 1).`,
        `Rewrite: ${tex("\\frac{2(x + 1)}{x(x + 1)} + \\frac{3x}{x(x + 1)}")}.`,
        "Add the tops: 2x + 2 + 3x = 5x + 2.",
        `So the sum is ${tex("\\frac{5x + 2}{x(x + 1)}")}.`,
      ],
      examplePrompt: `Add ${tex("\\frac{2}{x} + \\frac{3}{x + 1}")}.`,
      exampleAnswer: "(5x + 2)/(x(x + 1))",
    },
    {
      kind: "try_it",
      strategyLabel: "Rewrite over a common bottom",
      steps: [
        `For ${tex("\\frac{1}{x} + \\frac{1}{x + 2}")}, the common bottom is x(x + 2).`,
        `Rewrite: ${tex("\\frac{x + 2}{x(x + 2)} + \\frac{x}{x(x + 2)}")}.`,
        "Add the tops: N = 2x + 2.",
      ],
      examplePrompt: `${tex("\\frac{1}{x} + \\frac{1}{x + 2} = \\frac{N}{x(x + 2)}")}. What is N?`,
      exampleAnswer: "2x+2",
      answerType: "expression",
    },
  ]),
  nodeEntry("rational", "rat_solve_equation", "Clear the fractions, then check", [
    {
      kind: "micro_explain",
      text: "Multiply every term by the common denominator to clear the fractions, then solve. Check each answer against the original bottoms: a value that makes one of them 0 was never allowed, so it gets crossed off.",
    },
    {
      kind: "worked_example",
      strategyLabel: "Clear, solve, check",
      steps: [
        `Solve ${tex("\\frac{x}{x - 2} = \\frac{2}{x - 2} + 3")}. Multiply every term by x − 2.`,
        "That gives x = 2 + 3(x − 2), so x = 3x − 4.",
        "So 2x = 4 and x = 2.",
        "But x = 2 makes x − 2 = 0, which is not allowed. There is no solution.",
      ],
      examplePrompt: `Solve ${tex("\\frac{x}{x - 2} = \\frac{2}{x - 2} + 3")}.`,
      exampleAnswer: "No solution",
    },
    {
      kind: "try_it",
      strategyLabel: "Clear, solve, check",
      steps: [
        `Multiply both sides of ${tex("\\frac{6}{x} = \\frac{3}{x - 1}")} by x(x − 1): 6(x − 1) = 3x.`,
        "6x − 6 = 3x, so 3x = 6.",
        "x = 2 makes no bottom 0, so x = 2 stays.",
      ],
      examplePrompt: `Solve ${tex("\\frac{6}{x} = \\frac{3}{x - 1}")}. Give every solution.`,
      exampleAnswer: "2",
      answerType: "solutionSet",
    },
  ]),

  // ── radicals-rational-exponents ──
  nodeEntry("radicals-rational-exponents", "rexp_convert", "Top is the power, bottom is the root", [
    {
      kind: "micro_explain",
      text: "A fraction exponent is a root. x^(1/n) is the nth root of x, and x^(m/n) is the nth root of x raised to the m. Read the fraction as power over root: the top is the power, the bottom is the root.",
    },
    {
      kind: "worked_example",
      strategyLabel: "Power over root",
      steps: [
        `Write ${tex("\\sqrt[3]{x^{2}}")} with a fraction exponent.`,
        "The root is 3, so 3 goes on the bottom.",
        "The power is 2, so 2 goes on top.",
        `So ${tex("\\sqrt[3]{x^{2}} = x^{2/3}")}.`,
      ],
      examplePrompt: `Write ${tex("\\sqrt[3]{x^{2}}")} as a power of x.`,
      exampleAnswer: "x^(2/3)",
    },
    {
      kind: "try_it",
      strategyLabel: "Power over root",
      steps: [
        `In ${tex("\\sqrt[5]{x^{3}}")}, the root is 5: that goes on the bottom.`,
        "The power is 3: that goes on top.",
        `So ${tex("\\sqrt[5]{x^{3}} = x^{3/5}")}, and the exponent is 3/5.`,
      ],
      examplePrompt: `${tex("\\sqrt[5]{x^{3}}")} is x to what power?`,
      exampleAnswer: "3/5",
      answerType: "expression",
    },
  ]),
  nodeEntry("radicals-rational-exponents", "rad_rationalize", "Multiply by a well-chosen 1", [
    {
      kind: "micro_explain",
      text: "To clear a root from the bottom, multiply top and bottom by the same thing. For √3, use √3, since √3 · √3 = 3. For 2 + √3, use its conjugate 2 − √3: the middle terms cancel and the root disappears.",
    },
    {
      kind: "worked_example",
      strategyLabel: "Multiply by the root",
      steps: [
        `Rationalize ${tex("\\frac{6}{\\sqrt{3}}")}: multiply top and bottom by ${tex("\\sqrt{3}")}.`,
        `Top: ${tex("6\\sqrt{3}")}. Bottom: ${tex("\\sqrt{3} \\cdot \\sqrt{3} = 3")}.`,
        `So ${tex("\\frac{6}{\\sqrt{3}} = \\frac{6\\sqrt{3}}{3} = 2\\sqrt{3}")}.`,
      ],
      examplePrompt: `Rationalize ${tex("\\frac{6}{\\sqrt{3}}")}.`,
      exampleAnswer: "2√3",
    },
    {
      kind: "try_it",
      strategyLabel: "Multiply by the conjugate",
      steps: [
        `For ${tex("\\frac{1}{3 - \\sqrt{5}}")}, multiply top and bottom by ${tex("3 + \\sqrt{5}")}.`,
        `The bottom becomes ${tex("(3 - \\sqrt{5})(3 + \\sqrt{5})")}.`,
        `The middle terms cancel, leaving ${tex("3^{2} - (\\sqrt{5})^{2}")}.`,
        "That is 9 − 5 = 4.",
      ],
      examplePrompt: `Rationalize ${tex("\\frac{1}{3 - \\sqrt{5}}")}. What whole number is the new bottom?`,
      exampleAnswer: "4",
      answerType: "integer",
    },
  ]),
  nodeEntry("radicals-rational-exponents", "rad_solve_equation", "Squaring can invent a solution", [
    {
      kind: "micro_explain",
      text: "Squaring both sides can invent a solution, so check. Get the root alone, square both sides, and solve. Then put each answer back into the original. A square root is never negative, so an answer that needs one to be negative is crossed off.",
    },
    {
      kind: "worked_example",
      strategyLabel: "Square, solve, check",
      steps: [
        `Solve ${tex("\\sqrt{x + 2} = x")}. Square both sides: ${tex("x + 2 = x^{2}")}.`,
        `${tex("x^{2} - x - 2 = 0")}, so ${tex("(x - 2)(x + 1) = 0")}.`,
        `Check x = 2: ${tex("\\sqrt{4} = 2")}. It works.`,
        `Check x = −1: ${tex("\\sqrt{1} = 1")}, not −1. Only x = 2 is a solution.`,
      ],
      examplePrompt: `Solve ${tex("\\sqrt{x + 2} = x")}.`,
      exampleAnswer: "x = 2",
    },
    {
      kind: "try_it",
      strategyLabel: "Square, solve, check",
      steps: [
        `Solve ${tex("\\sqrt{x} = -3")}. Square both sides: x = 9.`,
        `Check x = 9 in the original: ${tex("\\sqrt{9} = 3")}.`,
        "3 is not −3, so x = 9 is crossed off: no solution.",
      ],
      examplePrompt: `Solve ${tex("\\sqrt{x} = -3")}. Give every solution, or say there is none.`,
      exampleAnswer: "no solution",
      answerType: "solutionSet",
    },
  ]),

  // ── exponential-logarithmic ──
  nodeEntry("exponential-logarithmic", "log_definition", "Two ways to write one fact", [
    {
      kind: "micro_explain",
      text: "log₂(8) = 3 and 2³ = 8 say the same thing. The base of the log is the base of the power, and the log's value is the exponent. To switch forms, keep the base and move the exponent.",
    },
    {
      kind: "worked_example",
      strategyLabel: "Keep the base, move the exponent",
      steps: [
        `Rewrite ${tex("5^{3} = 125")} as a log.`,
        "The base is 5, so it is a log base 5.",
        "The exponent 3 is the log's value, and 125 goes inside.",
        `So ${tex("\\log_{5} 125 = 3")}.`,
      ],
      examplePrompt: `Write ${tex("5^{3} = 125")} in logarithmic form.`,
      exampleAnswer: "log_5(125) = 3",
    },
    {
      kind: "try_it",
      strategyLabel: "Keep the base, move the exponent",
      steps: [
        `${tex("\\log_{4} x = 3")}: the base is 4 and the exponent is 3.`,
        `So ${tex("x = 4^{3}")}.`,
        "4 · 4 · 4 = 64, so x = 64.",
      ],
      examplePrompt: `If ${tex("\\log_{4} x = 3")}, what is x?`,
      exampleAnswer: "64",
      answerType: "integer",
    },
  ]),
  nodeEntry("exponential-logarithmic", "log_rules_expand", "Logs turn multiplying into adding", [
    {
      kind: "micro_explain",
      text: "Logs are exponents, and exponents add when powers multiply. So log(ab) = log a + log b, log(a/b) = log a − log b, and log(aⁿ) = n·log a. A sum inside, like log(a + b), does not split.",
    },
    {
      kind: "worked_example",
      strategyLabel: "Split, then bring powers down",
      steps: [
        `Expand ${tex("\\log_{2}(8x^{3})")}. Split the product: ${tex("\\log_{2} 8 + \\log_{2} x^{3}")}.`,
        `Bring the power down: ${tex("\\log_{2} x^{3} = 3\\log_{2} x")}.`,
        `${tex("\\log_{2} 8 = 3")}, since ${tex("2^{3} = 8")}.`,
        `So ${tex("\\log_{2}(8x^{3}) = 3 + 3\\log_{2} x")}.`,
      ],
      examplePrompt: `Expand ${tex("\\log_{2}(8x^{3})")}.`,
      exampleAnswer: "3 + 3log_2(x)",
    },
    {
      kind: "try_it",
      strategyLabel: "Split, then bring powers down",
      steps: [
        `Split: ${tex("\\log_{2}(xy^{2}) = \\log_{2} x + \\log_{2} y^{2}")}.`,
        `Bring the power down: ${tex("\\log_{2} x + 2\\log_{2} y")}.`,
        "Put in the values: 5 + 2 · 3.",
        "That is 11.",
      ],
      examplePrompt: `${tex("\\log_{2} x = 5")} and ${tex("\\log_{2} y = 3")}. What is ${tex("\\log_{2}(xy^{2})")}?`,
      exampleAnswer: "11",
      answerType: "integer",
    },
  ]),
  nodeEntry("exponential-logarithmic", "exp_solve_with_logs", "Take a log to bring x down", [
    {
      kind: "micro_explain",
      text: "When the two sides cannot share a base, as in 2^x = 10, take a log of both sides. The power rule brings x down: x·log 2 = log 10. Then divide. Here x lands between 3 and 4, since 2³ = 8 and 2⁴ = 16.",
    },
    {
      kind: "worked_example",
      strategyLabel: "Log both sides, then divide",
      steps: [
        `Solve ${tex("3^{x} = 20")}. Take a log of both sides: ${tex("\\log 3^{x} = \\log 20")}.`,
        `Bring x down: ${tex("x \\log 3 = \\log 20")}.`,
        `Divide: ${tex("x = \\frac{\\log 20}{\\log 3}")}.`,
        `That is about 2.73, between 2 and 3, since ${tex("3^{2} = 9")} and ${tex("3^{3} = 27")}.`,
      ],
      examplePrompt: `Solve ${tex("3^{x} = 20")}.`,
      exampleAnswer: "x = log(20)/log(3), about 2.73",
    },
    {
      kind: "try_it",
      strategyLabel: "Log both sides, then divide",
      steps: [
        `Take a log of both sides of ${tex("5^{x} = 7")}: ${tex("\\log 5^{x} = \\log 7")}.`,
        `Bring x down: ${tex("x \\log 5 = \\log 7")}.`,
        `Divide by ${tex("\\log 5")}: ${tex("x = \\frac{\\log 7}{\\log 5}")}.`,
      ],
      examplePrompt: `Solve ${tex("5^{x} = 7")}. Give the exact answer.`,
      exampleAnswer: "log(7)/log(5)",
      answerType: "expression",
    },
  ]),
  nodeEntry("exponential-logarithmic", "log_solve_equation", "Rewrite as an exponent, then check", [
    {
      kind: "micro_explain",
      text: "Gather the logs into one, rewrite it as an exponent equation, and solve. Then check every answer in the original: a log only takes positive inputs, so an answer that puts 0 or a negative inside a log is crossed off.",
    },
    {
      kind: "worked_example",
      strategyLabel: "Condense, rewrite, check",
      steps: [
        `Solve ${tex("\\log_{2} x + \\log_{2}(x - 2) = 3")}. Condense: ${tex("\\log_{2}(x(x - 2)) = 3")}.`,
        `Rewrite: ${tex("x(x - 2) = 2^{3} = 8")}.`,
        `${tex("x^{2} - 2x - 8 = 0")}, so ${tex("(x - 4)(x + 2) = 0")}.`,
        "x = −2 would put a negative inside a log, so only x = 4 works.",
      ],
      examplePrompt: `Solve ${tex("\\log_{2} x + \\log_{2}(x - 2) = 3")}.`,
      exampleAnswer: "x = 4",
    },
    {
      kind: "try_it",
      strategyLabel: "Rewrite, solve, check",
      steps: [
        `Rewrite ${tex("\\log_{3}(x + 1) = 2")} as an exponent: ${tex("x + 1 = 3^{2}")}.`,
        "x + 1 = 9, so x = 8.",
        "Check: x = 8 puts 9 inside the log, which is positive, so x = 8 stays.",
      ],
      examplePrompt: `Solve ${tex("\\log_{3}(x + 1) = 2")}. Give every solution.`,
      exampleAnswer: "8",
      answerType: "solutionSet",
    },
  ]),

  // ── sequences-series ──
  nodeEntry("sequences-series", "seq_recursive", "Next-term rules and jump-to rules", [
    {
      kind: "micro_explain",
      text: "A recursive rule says how to get the next term from the one before, like a loop body: a = a * 2. It needs a starting term. An explicit rule jumps straight to term n, like one function call.",
    },
    {
      kind: "worked_example",
      strategyLabel: "Count the passes",
      steps: [
        `Start: ${tex("a_{1} = 5")}, and ${tex("a_{n} = a_{n-1} + 3")}.`,
        "The list is 5, 8, 11, 14, …: add 3 each pass.",
        "Term n is n − 1 passes after the start.",
        `So ${tex("a_{n} = 5 + 3(n - 1)")}, which is 3n + 2.`,
      ],
      examplePrompt: `Write an explicit rule for ${tex("a_{1} = 5")}, ${tex("a_{n} = a_{n-1} + 3")}.`,
      exampleAnswer: "a_n = 3n + 2",
    },
    {
      kind: "try_it",
      strategyLabel: "Run the loop",
      steps: [
        `Start: ${tex("a_{1} = 2")}, and each term is 3 times the one before.`,
        `${tex("a_{2} = 6")}, ${tex("a_{3} = 18")}, ${tex("a_{4} = 54")}.`,
        `${tex("a_{5} = 3 \\cdot 54 = 162")}.`,
      ],
      examplePrompt: `${tex("a_{1} = 2")} and ${tex("a_{n} = 3a_{n-1}")}. What is ${tex("a_{5}")}?`,
      exampleAnswer: "162",
      answerType: "integer",
    },
  ]),
  nodeEntry("sequences-series", "series_sigma_notation", "Sigma is a for loop", [
    {
      kind: "micro_explain",
      text: "Σ is a for loop that adds. The number under it is where the counter starts, the number on top is where it stops, and the rule beside it is computed on each pass and added to a running total.",
    },
    {
      kind: "worked_example",
      strategyLabel: "Run the counter",
      steps: [
        `Evaluate ${tex("\\sum_{k=1}^{4} (2k + 1)")}.`,
        "k = 1 gives 3, k = 2 gives 5.",
        "k = 3 gives 7, k = 4 gives 9.",
        "Add them: 3 + 5 + 7 + 9 = 24.",
      ],
      examplePrompt: `What is ${tex("\\sum_{k=1}^{4} (2k + 1)")}?`,
      exampleAnswer: "24",
    },
    {
      kind: "try_it",
      strategyLabel: "Run the counter",
      steps: [
        `For ${tex("\\sum_{k=1}^{5} k^{2}")}, the terms are 1, 4, 9, 16, 25.`,
        "Running total: 1, 5, 14, 30.",
        "Add the last term: 30 + 25 = 55.",
      ],
      examplePrompt: `What is ${tex("\\sum_{k=1}^{5} k^{2}")}?`,
      exampleAnswer: "55",
      answerType: "integer",
    },
  ]),
  nodeEntry("sequences-series", "series_geometric_sum", "Shift by r and subtract", [
    {
      kind: "micro_explain",
      text: "Call the sum S. Multiply it by r and the terms shift one place, so S and rS share every middle term. Subtract and only the ends are left: S = a₁(1 − rⁿ)/(1 − r). That is why 1 + 2 + 4 + … + 2ⁿ⁻¹ = 2ⁿ − 1.",
    },
    {
      kind: "worked_example",
      strategyLabel: "Use the sum formula",
      steps: [
        "Add 1 + 3 + 9 + 27 + 81: a₁ = 1, r = 3, and there are 5 terms.",
        `${tex("S = \\frac{1(1 - 3^{5})}{1 - 3}")}.`,
        `${tex("S = \\frac{1 - 243}{-2} = 121")}.`,
      ],
      examplePrompt: "What is 1 + 3 + 9 + 27 + 81?",
      exampleAnswer: "121",
    },
    {
      kind: "try_it",
      strategyLabel: "Use the sum formula",
      steps: [
        `For 1 + 2 + 4 + … + 512: a₁ = 1, r = 2, and 512 = ${tex("2^{9}")}, so there are 10 terms.`,
        `${tex("S = \\frac{1 - 2^{10}}{1 - 2}")}.`,
        `${tex("S = \\frac{1 - 1024}{-1} = 1023")}.`,
      ],
      examplePrompt: "What is 1 + 2 + 4 + … + 512?",
      exampleAnswer: "1023",
      answerType: "integer",
    },
  ]),
  nodeEntry("sequences-series", "series_infinite_geometric", "Endless terms, a finite sum", [
    {
      kind: "micro_explain",
      text: "A ball that bounces forever can still travel a finite distance. If each term is r times the last, with r between −1 and 1, the total closes in on S = a₁/(1 − r). If r is 1 or more in size, the terms never shrink and there is no sum.",
    },
    {
      kind: "worked_example",
      strategyLabel: "Check r, then use the formula",
      steps: [
        "A ball falls 6 m, then 3, then 1.5, halving forever.",
        "a₁ = 6 and r = 1/2, which is between −1 and 1.",
        `${tex("S = \\frac{6}{1 - \\frac{1}{2}}")}.`,
        "That is 6 ÷ 1/2 = 12 m in all.",
      ],
      examplePrompt: "A ball falls 6 m, then 3, then 1.5, halving forever. What is the total of those falls?",
      exampleAnswer: "12 m",
    },
    {
      kind: "try_it",
      strategyLabel: "Check r, then use the formula",
      steps: [
        "In 9 + 3 + 1 + 1/3 + …, a₁ = 9 and r = 1/3.",
        `r is between −1 and 1, so ${tex("S = \\frac{9}{1 - \\frac{1}{3}}")}.`,
        "Dividing 9 by 2/3 is the same as 9 · 3/2, so S = 27/2.",
      ],
      examplePrompt: "What is 9 + 3 + 1 + 1/3 + …, going on forever?",
      exampleAnswer: "27/2",
      answerType: "expression",
    },
  ]),
];
