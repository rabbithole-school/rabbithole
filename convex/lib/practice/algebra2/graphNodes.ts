/**
 * Algebra 2 — the graph-dependent nodes of the other strands, kept in their own
 * file so the lanes editing those strand files never collide with this one:
 *   complex-quadratics      cx_plane_plot, quad_inequality
 *   exponential-logarithmic log_graph_inverse
 *   polynomials             poly_end_behavior, poly_sketch_factored
 *   rational                rat_graph_asymptotes
 *
 * As in `functions.ts`, a graph shows only what the scholar is meant to read
 * from it: an item that asks for an asymptote never draws one.
 */
import type { WorkedStep } from "../fadedSteps";
import type { Algebra2Kit, Rng, Template } from "../templates";
import {
  makeCoordinatePlanePromptVisual,
  makeFunctionPlotPromptVisual,
  makeNumberLinePromptVisual,
  type FunctionPlotCurve,
} from "../../../../shared/practicePromptVisual";
import type { CurveZero } from "../../../../shared/functionCurves";
import { complexAns, complexTex, expandRoots, factoredTex, fracTex, polyTex, tex } from "./format";
import { plotOf, texNum, transformCurve, windowAround } from "./functions";

function step(text: string, blankText: string): WorkedStep {
  return { text, blankText };
}

function nonZero(r: Rng, lo: number, hi: number): number {
  const n = r.int(lo, hi - 1);
  return n >= 0 ? n + 1 : n;
}

/** Two different integers in [lo, hi], smaller first. */
function twoRoots(r: Rng, lo: number, hi: number): [number, number] {
  const p = r.int(lo, hi);
  let q = r.int(lo, hi - 1);
  if (q >= p) q += 1;
  return p < q ? [p, q] : [q, p];
}

/** `y = -\frac{1}{2}(x - 1)^{2}(x + 3)` — zeros sorted, repeated as powers. */
function factoredRuleTex(zeros: CurveZero[], leading: number): string {
  // A bare x factor reads best first (x²(x − 3), not (x − 3)x²).
  const roots = [...zeros]
    .sort((p, q) => (p.x === 0 ? -1 : q.x === 0 ? 1 : p.x - q.x))
    .flatMap((z) => Array.from({ length: z.multiplicity }, () => z.x));
  // A leading 1 gets one extra (invisible, math-mode) space so the + and −
  // versions of a rule are the same length and length never hints at sign.
  const lead = leading === 1 ? " " : leading === -1 ? "-" : texNum(leading);
  return `y = ${lead}${factoredTex(roots, 1)}`;
}

const ENDS = {
  downUp: "Down on the left, up on the right",
  upDown: "Up on the left, down on the right",
  upUp: "Up on both ends",
  downDown: "Down on both ends",
} as const;

function endsOf(degree: number, leading: number): keyof typeof ENDS {
  const rightUp = leading > 0;
  const leftUp = degree % 2 === 0 ? rightUp : !rightUp;
  return leftUp ? (rightUp ? "upUp" : "upDown") : rightUp ? "downUp" : "downDown";
}

/** A polynomial written in standard form but with its terms shuffled, so the
 *  leading term is not always written first (the classic misread). */
function shuffledPolyTex(coefficients: number[], r: Rng): string {
  const degree = coefficients.length - 1;
  const terms = coefficients
    .map((c, i) => ({ c, power: degree - i }))
    .filter((t) => t.c !== 0);
  const offset = r.int(0, terms.length - 1);
  const order = terms.map((_, i) => terms[(i + offset) % terms.length]);
  let out = "";
  for (const { c, power } of order) {
    const magnitude = Math.abs(c);
    const coefficient = magnitude === 1 && power > 0 ? "" : String(magnitude);
    const body = power === 0 ? coefficient : `${coefficient}x${power > 1 ? `^{${power}}` : ""}`;
    out += out === "" ? `${c < 0 ? "-" : ""}${body}` : `${c < 0 ? " - " : " + "}${body}`;
  }
  return out;
}

export function graphNodeTemplates(kit: Algebra2Kit): Template[] {
  const { T, choiceItem, exprAns, fracAns, intAns } = kit;

  return [
    // ── complex-quadratics ────────────────────────────────────────────────
    // Read a + bi off the complex plane. Plotting runs the other way as a
    // `coordinatePlane` manipulative (convex/seed/algebra2Manipulatives.ts).
    T(
      "cx_plane_plot",
      "expression",
      (r) => {
        const tier = r.int(0, 2);
        let re: number;
        let im: number;
        if (tier === 0) {
          re = r.int(1, 5);
          im = r.int(1, 5);
        } else if (tier === 1) {
          re = nonZero(r, -5, 5);
          im = nonZero(r, -5, 5);
          if (re > 0 && im > 0) im = -im;
        } else if (r.int(0, 1) === 0) {
          // On an axis: a real number or a pure imaginary one.
          const onReal = r.int(0, 1) === 0;
          re = onReal ? nonZero(r, -5, 5) : 0;
          im = onReal ? 0 : nonZero(r, -5, 5);
        } else {
          re = nonZero(r, -5, 5);
          im = nonZero(r, -5, 5);
        }
        // Tier 2 sometimes adds a second labelled point: the swapped reading
        // (b, a), which is exactly the slip to rule out.
        const decoy = tier === 2 && re !== im && re !== 0 && im !== 0;
        const points = decoy
          ? r.int(0, 1) === 0
            ? [{ x: re, y: im, label: "A" }, { x: im, y: re, label: "B" }]
            : [{ x: im, y: re, label: "A" }, { x: re, y: im, label: "B" }]
          : [{ x: re, y: im, label: "z" }];
        const name = decoy ? points.find((p) => p.x === re && p.y === im)?.label ?? "z" : "z";
        return {
          stem: `Which complex number does the point ${name} show? Write it as ${tex("a + bi")}.`,
          answer: exprAns(complexAns(re, im)),
          promptVisual: makeCoordinatePlanePromptVisual({
            xMin: -6,
            xMax: 6,
            yMin: -6,
            yMax: 6,
            gridStep: 1,
            points,
            axisLabels: { x: "Re", y: "Im" },
          }),
          workedSteps: [
            step(`The horizontal axis is the real axis: ${name} is ${re === 0 ? "on the vertical axis, so the real part is 0" : `at ${re} across, so the real part is ${re}`}.`, "Real part: ?"),
            step(`The vertical axis is the imaginary axis: ${name} is ${im === 0 ? "on the horizontal axis, so the imaginary part is 0" : `at ${im} up, so the imaginary part is ${im}`}.`, "Imaginary part: ?"),
            step(`So ${name} is ${tex(complexTex(re, im))}.`, `${name} = ?`),
          ],
        };
      },
      { answerPalette: "complex", answerForm: "complexStandard" },
    ),

    // Quadratic inequalities: the judgement is between the roots or outside
    // them, strict or inclusive, so the answer is a choice between solution
    // descriptions. The first tier reads it off the parabola; the last runs it
    // backwards from a number line.
    T("quad_inequality", "multipleChoice", (r) => {
      const tier = r.int(0, 2);
      const [p, q] = twoRoots(r, -5, 5);
      const reverse = tier === 2 && r.int(0, 1) === 0;
      const leading = tier === 2 && !reverse ? r.pick([-1, 2, -2]) : tier === 0 ? r.pick([1, -1]) : 1;
      const rel = r.pick<"<" | "\\le" | ">" | "\\ge">(["<", "\\le", ">", "\\ge"]);
      const strict = rel === "<" || rel === ">";
      const wantsNegative = rel === "<" || rel === "\\le";
      // Below the axis between the roots when the parabola opens up.
      const between = wantsNegative === leading > 0;
      // `<` and `>` are padded to the length of `\le`/`\ge` (math mode drops the
      // spaces): unpadded, the strict options were recognisably the shortest.
      const LT = "<  ";
      const GT = ">  ";
      // Both shapes are two conditions joined by a word ("and" between the
      // roots, "or" outside them) so the four options are the same length; the
      // outside form's second span carries one extra math-mode space for the
      // shorter word.
      const describe = (inside: boolean, open: boolean, lo: number, hi: number) =>
        inside
          ? `${tex(`${lo} ${open ? LT : "\\le"} x`)} and ${tex(`x ${open ? LT : "\\le"} ${hi}`)}`
          : `${tex(`x ${open ? LT : "\\le"} ${lo}`)} or ${tex(`x ${open ? GT : "\\ge"}  ${hi}`)}`;
      const coefficients = expandRoots([p, q], leading);
      const polyText = polyTex(coefficients);

      if (reverse) {
        // A bounded interval on the number line ⇒ a "between" answer.
        const open = r.int(0, 1) === 0;
        const ineq = (poly: number[], relation: string) => tex(`${polyTex(poly)} ${relation} 0`);
        const correct = ineq(expandRoots([p, q]), open ? LT : "\\le");
        const distractors = [
          ineq(expandRoots([p, q]), open ? "\\le" : LT),
          ineq(expandRoots([p, q]), open ? GT : "\\ge"),
          ineq(expandRoots([p, q]), open ? "\\ge" : GT),
        ];
        return choiceItem(
          r,
          "This number line shows the solution of one of these inequalities. Which one?",
          correct,
          distractors,
          makeNumberLinePromptVisual({
            min: Math.min(-1, p - 2),
            max: Math.max(1, q + 2),
            step: 1,
            interval: { from: p, to: q, includeFrom: !open, includeTo: !open },
          }),
          [
            step(`The shading runs between ${p} and ${q}, so those are the roots, and the quadratic is negative between them.`, "Where are the roots? ?"),
            step(`${open ? "Open" : "Closed"} circles mean the roots are ${open ? "left out, so the inequality is strict" : "included, so the inequality allows equals"}.`, "Strict or not? ?"),
            step(`So it is ${correct}.`, "Which inequality? ?"),
          ],
        );
      }

      if (tier === 1 && (between || strict || q - p >= 2)) {
        // Typed: one integer that only comes out right after the full
        // judgement (between or outside, roots in or out). A bounded solution
        // asks how many integers it holds; two rays ask for the largest
        // integer that is NOT a solution.
        const count = q - p + (strict ? -1 : 1);
        const largestOutside = strict ? q : q - 1;
        const firstSteps = [
          step(
            `Factor: ${tex(factoredTex([p, q], 1))}, so the boundary points are ${tex(`x = ${p}`)} and ${tex(`x = ${q}`)}.`,
            "Where is the expression equal to 0? ?",
          ),
          step(
            `The parabola opens up, so it is below the x-axis between the roots and above it outside them. ${tex(`${rel} 0`)} asks for ${wantsNegative ? "below" : "above"}${strict ? "" : " or on"}: the solution is ${describe(between, strict, p, q)}.`,
            "Write the solution set: ?",
          ),
        ];
        return between
          ? {
              stem: `How many integers x satisfy ${tex(`${polyText} ${rel} 0`)}?`,
              answer: intAns(count),
              answerType: "integer" as const,
              workedSteps: [
                ...firstSteps,
                step(`Count the integers from ${strict ? p + 1 : p} to ${strict ? q - 1 : q}: there are ${count}.`, "How many integers? ?"),
              ],
            }
          : {
              stem: `What is the largest integer x that does NOT satisfy ${tex(`${polyText} ${rel} 0`)}?`,
              answer: intAns(largestOutside),
              answerType: "integer" as const,
              workedSteps: [
                ...firstSteps,
                step(`The integers left out lie ${strict ? `from ${p} to ${q}, roots included` : `strictly between ${p} and ${q}`}; the largest is ${largestOutside}.`, "The largest integer left out is: ?"),
              ],
            };
      }

      const correct = describe(between, strict, p, q);
      // The four between/outside × strict/inclusive descriptions. Equal-length
      // pairs, so no option's length singles it out. (The root-sign slip is
      // tested by the typed draws, which ask for a number.)
      const distractors = [
        describe(between, !strict, p, q),
        describe(!between, strict, p, q),
        describe(!between, !strict, p, q),
      ];
      // A sketch: where the parabola sits above or below the axis is what is
      // read, not its height, so the rule keeps its leading 1 or −1.
      const roots: CurveZero[] = [{ x: p, multiplicity: 1 }, { x: q, multiplicity: 1 }];
      const plotted = leading;
      const visual =
        tier === 0
          ? makeFunctionPlotPromptVisual({
              ...windowAround([p - 1, q + 1], [-5, 5], 1),
              curves: [{ form: "polynomial", zeros: roots, leading: plotted, sketch: true }],
            })
          : undefined;
      const stemPoly = visual ? `${plotted === 1 ? "" : plotted === -1 ? "-" : texNum(plotted)}${factoredTex([p, q], 1)}` : polyText;
      const stem = visual
        ? `The graph of ${tex(`y = ${stemPoly}`)} is shown. Solve ${tex(`${stemPoly} ${rel} 0`)}.`
        : `Solve ${tex(`${polyText} ${rel} 0`)}.`;
      return choiceItem(r, stem, correct, distractors, visual, [
        step(
          visual
            ? `The parabola crosses the x-axis at ${tex(`x = ${p}`)} and ${tex(`x = ${q}`)}.`
            : `Factor: ${tex(`${leading === 1 ? "" : leading === -1 ? "-" : leading}${factoredTex([p, q], 1)}`)}, so the boundary points are ${tex(`x = ${p}`)} and ${tex(`x = ${q}`)}.`,
          "Where is the expression equal to 0? ?",
        ),
        step(
          `The parabola opens ${leading > 0 ? "up" : "down"}, so it is ${leading > 0 ? "below" : "above"} the x-axis between the roots and ${leading > 0 ? "above" : "below"} it outside them.`,
          "Where is it above, and where below? ?",
        ),
        step(
          `${tex(`${rel} 0`)} asks where it is ${wantsNegative ? "below" : "above"} the axis${strict ? "" : " or on it, so the roots are included"}: ${between ? "between" : "outside"} the roots.`,
          "Between or outside, and are the roots included? ?",
        ),
        step(`So the solution is ${correct}.`, "The solution is: ?"),
      ]);
    }),

    // ── exponential-logarithmic ───────────────────────────────────────────
    // A logarithm's graph as the reflection of an exponential: swap a point,
    // read the asymptote or intercept that the reflection produced, or write
    // the inverse rule.
    T(
      "log_graph_inverse",
      "expression",
      (r) => {
        const tier = r.int(0, 2);
        if (tier === 0) {
          // The log's value must be WORKED OUT (or read off the reflected
          // graph); the exponential's matching point is not printed. An n
          // equal to the base would sit in the stem, so it is never drawn.
          const base = r.pick([2, 2, 3, 10]);
          const options = (base === 10 ? [0, 1, 2, 3] : [-2, -1, 0, 1, 2, 3]).filter((n) => n !== base);
          const n = r.pick(options);
          const value = n >= 0 ? String(base ** n) : fracTex(1, base ** -n);
          const visual =
            base === 2
              ? makeFunctionPlotPromptVisual({
                  xMin: -4,
                  xMax: 9,
                  yMin: -4,
                  yMax: 9,
                  curves: [transformCurve("exp2", { a: 1, h: 0, k: 0 }), transformCurve("log2", { a: 1, h: 0, k: 0 })],
                  referenceLine: "y=x",
                })
              : undefined;
          return {
            stem: `The graph of ${tex(`y = \\log_{${base}}(x)`)} is the reflection of the graph of ${tex(`y = ${base}^{x}`)} over the line ${tex("y = x")}. Fill in the missing number: ${tex(`(${value}, ?)`)} is on the graph of ${tex(`y = \\log_{${base}}(x)`)}.`,
            answer: exprAns(String(n)),
            ...(visual ? { promptVisual: visual } : {}),
            workedSteps: [
              step(`On the exponential, which input gives ${tex(value)}? ${tex(`${base}^{${n}} = ${value}`)}, so ${tex(`(${n}, ${value})`)} is on ${tex(`y = ${base}^{x}`)}.`, `Which power of ${base} gives it? ?`),
              step("Reflecting over y = x swaps the two coordinates of every point.", "What does the reflection do to a point? ?"),
              step(`So ${tex(`(${value}, ${n})`)} is on the logarithm: ${tex(`\\log_{${base}}(${value}) = ${n}`)}.`, "The missing number is: ?"),
            ],
          };
        }
        if (tier === 1) {
          // Read off the graph alone: the rule is not printed, so neither the
          // asymptote nor the intercept can be copied from the stem.
          const h = r.int(-3, 3);
          const k = r.pick([0, -1, -2, 1]);
          const askAsymptote = k > 0 || r.int(0, 1) === 0;
          const t = { a: 1, h, k };
          const visual = plotOf([transformCurve("log2", t)], windowAround([h, h + 8], [k - 3, k + 3], 1));
          const intro = `This is the graph of ${tex("y = \\log_{2}(x)")} moved left or right and up or down.`;
          if (askAsymptote) {
            return {
              stem: `${intro} Its vertical asymptote is the line ${tex("x = ?")}. What is the missing number?`,
              answer: exprAns(String(h)),
              promptVisual: visual,
              workedSteps: [
                step(`${tex("y = 2^{x}")} levels off along ${tex("y = 0")}; reflecting over ${tex("y = x")} turns that into the vertical asymptote ${tex("x = 0")} of ${tex("y = \\log_{2}(x)")}.`, "Where is the asymptote of log₂(x)? ?"),
                step("Moving the graph moves its asymptote with it. Follow the curve down: it dives toward one vertical line without touching it.", "Which vertical line does the curve dive toward? ?"),
                step(`The asymptote is ${tex(`x = ${h}`)}.`, "x = ?"),
              ],
            };
          }
          const intercept = h + 2 ** -k;
          return {
            stem: `${intro} Where does it cross the x-axis? ${tex("x = ?")}`,
            answer: exprAns(String(intercept)),
            promptVisual: visual,
            workedSteps: [
              step("On the x-axis, y = 0. Follow the x-axis until it meets the curve.", "What is y on the x-axis? ?"),
              step(`The curve crosses the x-axis at a grid line: ${tex(`(${intercept}, 0)`)}.`, "Where does the curve meet the axis? ?"),
              step(`${tex(`x = ${intercept}`)}.`, "x = ?"),
            ],
          };
        }
        // Write the inverse rule of a shifted exponential or logarithm.
        const kind = r.int(0, 2);
        const shift = nonZero(r, -4, 4);
        const sign = (n: number) => (n > 0 ? `- ${n}` : `+ ${-n}`);
        const signAns = (n: number) => (n > 0 ? `-${n}` : `+${-n}`);
        const plus = (n: number) => (n > 0 ? `+ ${n}` : `- ${-n}`);
        const plusAns = (n: number) => (n > 0 ? `+${n}` : `-${-n}`);
        let given: string;
        let answer: string;
        let answerTex: string;
        let visualCurve: FunctionPlotCurve;
        if (kind === 0) {
          // y = 2^x + k  ⇒  y = log₂(x − k)
          given = `y = 2^{x} ${plus(shift)}`;
          answer = `log_2(x${signAns(shift)})`;
          answerTex = `y = \\log_{2}(x ${sign(shift)})`;
          visualCurve = transformCurve("exp2", { a: 1, h: 0, k: shift });
        } else if (kind === 1) {
          // y = 2^(x − h)  ⇒  y = log₂(x) + h
          given = `y = 2^{x ${sign(shift)}}`;
          answer = `log_2(x)${plusAns(shift)}`;
          answerTex = `y = \\log_{2}(x) ${plus(shift)}`;
          visualCurve = transformCurve("exp2", { a: 1, h: shift, k: 0 });
        } else {
          // y = log₂(x − h)  ⇒  y = 2^x + h
          given = `y = \\log_{2}(x ${sign(shift)})`;
          answer = `2^x${plusAns(shift)}`;
          answerTex = `y = 2^{x} ${plus(shift)}`;
          visualCurve = transformCurve("log2", { a: 1, h: shift, k: 0 });
        }
        return {
          stem: `Write the rule for the inverse of ${tex(given)}, the function graphed here. Give the rule for y.`,
          answer: exprAns(answer),
          promptVisual: makeFunctionPlotPromptVisual({ xMin: -7, xMax: 7, yMin: -7, yMax: 7, curves: [visualCurve], referenceLine: "y=x" }),
          workedSteps: [
            step("Swap x and y in the rule.", "What do you swap? ?"),
            step(
              kind === 2
                ? "Rewrite the logarithm in exponential form, then get y alone."
                : "Get the power by itself, then rewrite it as a logarithm.",
              "Which form do you rewrite to? ?",
            ),
            step(`${tex(answerTex)}.`, "y = ?"),
          ],
        };
      },
      { answerPalette: "logs" },
    ),

    // ── polynomials ───────────────────────────────────────────────────────
    // End behaviour: four possible answers, one judgement — a classification.
    T("poly_end_behavior", "multipleChoice", (r) => {
      const tier = r.int(0, 2);
      if (tier === 2) {
        // Read degree parity and the sign of the leading coefficient OFF a graph.
        const count = r.int(2, 3);
        const xs = [-3, -2, -1, 0, 1, 2, 3];
        const zeros: CurveZero[] = [];
        while (zeros.length < count) {
          const x = r.pick(xs);
          if (!zeros.some((z) => z.x === x)) zeros.push({ x, multiplicity: r.pick([1, 1, 2]) });
        }
        const sign = r.pick([1, -1]);
        const degree = zeros.reduce((s, z) => s + z.multiplicity, 0);
        const leading = sign;
        const correct = `${degree % 2 === 0 ? "Even" : "Odd"} degree, ${sign > 0 ? "positive" : "negative"} leading coefficient`;
        const all = ["Even", "Odd"].flatMap((d) => ["positive", "negative"].map((s) => `${d} degree, ${s} leading coefficient`));
        return choiceItem(
          r,
          "What do the ends of this polynomial's graph tell you about its degree and leading coefficient?",
          correct,
          all.filter((o) => o !== correct),
          makeFunctionPlotPromptVisual({
            ...windowAround([Math.min(...zeros.map((z) => z.x)) - 2, Math.max(...zeros.map((z) => z.x)) + 2], [-7, 7], 0),
            curves: [{ form: "polynomial", zeros, leading, sketch: true }],
          }),
          [
            step(`The right end points ${sign > 0 ? "up" : "down"}, so the leading coefficient is ${sign > 0 ? "positive" : "negative"}.`, "Which way does the right end point? ?"),
            step(`The ends point ${degree % 2 === 0 ? "the same way" : "opposite ways"}, so the degree is ${degree % 2 === 0 ? "even" : "odd"}.`, "Same way or opposite? ?"),
            step(`So: ${correct.toLowerCase()}.`, "Degree and leading coefficient: ?"),
          ],
        );
      }
      let degree: number;
      let leading: number;
      let ruleTex: string;
      if (tier === 0) {
        degree = r.int(2, 5);
        leading = nonZero(r, -4, 4);
        const coefficients = [leading, ...Array.from({ length: degree }, () => r.int(-5, 5))];
        ruleTex = polyTex(coefficients);
      } else if (r.int(0, 1) === 0) {
        degree = r.int(3, 6);
        leading = nonZero(r, -4, 4);
        const coefficients = [leading, ...Array.from({ length: degree }, () => r.int(-5, 5))];
        if (coefficients[coefficients.length - 1] === 0) coefficients[coefficients.length - 1] = 1;
        // Lower terms are nonzero often enough that a shuffle actually moves the leading term.
        coefficients[1] = coefficients[1] === 0 ? 2 : coefficients[1];
        ruleTex = shuffledPolyTex(coefficients, r);
      } else {
        const zeros: CurveZero[] = [];
        const count = r.int(2, 3);
        while (zeros.length < count) {
          const x = r.int(-4, 4);
          if (!zeros.some((z) => z.x === x)) zeros.push({ x, multiplicity: r.pick([1, 1, 2, 3]) });
        }
        leading = r.pick([1, -1, 2, -3]);
        degree = zeros.reduce((s, z) => s + z.multiplicity, 0);
        ruleTex = factoredRuleTex(zeros, leading).slice(4);
      }
      const ends = endsOf(degree, leading);
      return choiceItem(
        r,
        `Describe the end behavior of the graph of ${tex(`y = ${ruleTex}`)}.`,
        ENDS[ends],
        Object.values(ENDS).filter((o) => o !== ENDS[ends]),
        undefined,
        [
          step(
            `For large x only the highest-power term matters: its degree is ${degree} and its coefficient is ${leading < 0 ? "negative" : "positive"}.`,
            "What are the degree and the sign of the leading coefficient? ?",
          ),
          step(`Degree ${degree} is ${degree % 2 === 0 ? "even, so both ends point the same way" : "odd, so the ends point opposite ways"}.`, "Same way or opposite ways? ?"),
          step(`A ${leading < 0 ? "negative" : "positive"} leading coefficient sends the right end ${leading < 0 ? "down" : "up"}.`, "Which way does the right end go? ?"),
          step(`So: ${ENDS[ends].toLowerCase()}.`, "The end behavior is: ?"),
        ],
      );
    }),

    // Sketching from factored form, run backwards: ONE graph, four rules that
    // differ in exactly the features a sketch shows (a zero's sign, a bounce
    // versus a cross, the end behaviour).
    T("poly_sketch_factored", "multipleChoice", (r) => {
      const tier = r.int(0, 2);
      const count = r.int(2, 3);
      const zeros: CurveZero[] = [];
      while (zeros.length < count) {
        const x = r.int(-3, 3);
        if (!zeros.some((z) => z.x === x)) zeros.push({ x, multiplicity: 1 });
      }
      zeros.sort((p, q) => p.x - q.x);
      const typed = tier >= 1 && r.int(0, 1) === 0;
      // A typed draw asks the power of one zero, and 1, 2 and 3 are drawn
      // equally often (a bounce on every graph made "2" the answer 68% of the
      // time). The asked zero is always a different one from the repeated one
      // when the asked power is 1.
      const askedPower = typed ? r.pick([1, 2, 3]) : 0;
      const repeated = r.int(0, zeros.length - 1);
      if (typed) {
        zeros[repeated].multiplicity = askedPower === 1 ? r.pick([2, 3]) : askedPower;
      } else if (tier >= 1) {
        zeros[repeated].multiplicity = tier === 2 && zeros.length === 2 ? r.pick([2, 3]) : 2;
      }
      const sign = tier === 0 ? r.pick([1, 1, -1]) : r.pick([1, -1]);
      // A sketch: zeros, crossings and ends are what is read, not heights, so
      // the rule keeps a leading 1 or −1.
      const leading = sign;
      const xs = zeros.map((z) => z.x);
      const window = windowAround([Math.min(...xs) - 2, Math.max(...xs) + 2], [-7, 7], 0);
      const visual = makeFunctionPlotPromptVisual({ ...window, curves: [{ form: "polynomial", zeros, leading, sketch: true }] });
      if (typed) {
        // Typed: the power of one zero, read from how the graph meets the axis
        // there (crosses straight, bounces, or flattens as it crosses).
        const asked =
          askedPower === 1 ? zeros.filter((z, i) => i !== repeated)[r.int(0, zeros.length - 2)] : zeros[repeated];
        const how =
          asked.multiplicity === 1 ? "crosses straight through" : asked.multiplicity === 2 ? "touches and bounces back" : "flattens out as it crosses";
        return {
          stem: `In the simplest rule for this graph, what power does the factor for the zero at ${tex(`x = ${asked.x}`)} have?`,
          answer: intAns(asked.multiplicity),
          answerType: "integer" as const,
          promptVisual: visual,
          workedSteps: [
            step(`At ${tex(`x = ${asked.x}`)} the graph ${how}.`, "What does the graph do at that zero? ?"),
            step(
              "Crossing straight through means power 1; bouncing means an even power, simplest 2; flattening as it crosses means an odd power above 1, simplest 3.",
              "Which power gives that shape? ?",
            ),
            step(`So the power is ${asked.multiplicity}.`, "The power is: ?"),
          ],
        };
      }
      const correct = tex(factoredRuleTex(zeros, leading));
      // Distractors: the ends flipped; the zeros' signs flipped (x + 1 for a
      // zero at 1); a different zero doing the bouncing (or none bouncing).
      const flippedZeros = zeros.map((z) => ({ x: -z.x, multiplicity: z.multiplicity }));
      const bounceIndex = zeros.findIndex((z) => z.multiplicity > 1);
      const movedBounce =
        bounceIndex >= 0
          ? zeros.map((z, i) => ({ x: z.x, multiplicity: i === (bounceIndex + 1) % zeros.length ? z.multiplicity + (zeros[bounceIndex].multiplicity - 1) : i === bounceIndex ? 1 : z.multiplicity }))
          : zeros.map((z, i) => ({ x: z.x, multiplicity: i === 0 ? 2 : 1 }));
      // Distractors come in ± pairs of one wrong reading (the bounce on the
      // wrong zero, else the zeros' signs flipped), so option lengths pair up
      // and never point at the answer.
      const flippedSame = factoredRuleTex(flippedZeros, leading) === factoredRuleTex(zeros, leading);
      const wrong = bounceIndex >= 0 || flippedSame ? movedBounce : flippedZeros;
      const distractors = [
        tex(factoredRuleTex(zeros, -leading)),
        tex(factoredRuleTex(wrong, leading)),
        tex(factoredRuleTex(wrong, -leading)),
      ];
      const bounces = zeros.filter((z) => z.multiplicity % 2 === 0).map((z) => z.x);
      const crosses = zeros.filter((z) => z.multiplicity % 2 === 1).map((z) => z.x);
      return choiceItem(
        r,
        "Which rule matches this graph?",
        correct,
        distractors,
        visual,
        [
          step(`The graph meets the x-axis at ${xs.map((x) => tex(`x = ${x}`)).join(", ")}; a zero at ${tex(`x = ${xs[0]}`)} comes from the factor ${tex(factoredTex([xs[0]], 1))}.`, "Where are the zeros, and which factors give them? ?"),
          step(
            `${crosses.length > 0 ? `It crosses at ${crosses.join(", ")} (odd power)` : "It crosses nowhere"}${bounces.length > 0 ? ` and bounces at ${bounces.join(", ")} (even power)` : " and never bounces"}.`,
            "Where does it cross, and where does it bounce? ?",
          ),
          step(`The right end points ${sign > 0 ? "up" : "down"}, so the leading coefficient is ${sign > 0 ? "positive" : "negative"}.`, "Which way does the right end point? ?"),
          step(`So the rule is ${correct}.`, "The rule is: ?"),
        ],
      );
    }),

    // ── rational ──────────────────────────────────────────────────────────
    // One asymptote at a time, typed. The top tier sets the hole trap: a
    // factor that cancels leaves a hole, not an asymptote.
    T("rat_graph_asymptotes", "fraction", (r) => {
      const tier = r.int(0, 2);
      const askVertical = r.int(0, 1) === 0;
      if (tier === 0) {
        // y = (ax + b)/(x − v) = a + (b + av)/(x − v), drawn without its asymptotes.
        const a = nonZero(r, -3, 3);
        const v = nonZero(r, -3, 3);
        let b = r.int(-6, 6);
        if (b + a * v === 0) b += 1;
        const rule = `y = \\frac{${polyTex([a, b])}}{${polyTex([1, -v])}}`;
        return {
          stem: `This is the graph of ${tex(rule)}. What is its ${askVertical ? "vertical" : "horizontal"} asymptote? ${tex(askVertical ? "x = ?" : "y = ?")}`,
          answer: askVertical ? fracAns(v, 1) : fracAns(a, 1),
          promptVisual: makeFunctionPlotPromptVisual({
            ...windowAround([v - 5, v + 5], [a - 6, a + 6], 0),
            curves: [{ form: "rational", rational: { vertical: [v], horizontal: a, scale: b + a * v } }],
          }),
          workedSteps: askVertical
            ? [
                step(`The graph shoots up and down beside one vertical line, where the denominator ${tex(polyTex([1, -v]))} is 0.`, "Where is the denominator 0? ?"),
                step(`${tex(`${polyTex([1, -v])} = 0`)} at ${tex(`x = ${v}`)}.`, "x = ?"),
              ]
            : [
                step(`Far left and far right, the graph levels off. The top and bottom have the same degree, so it levels off at the ratio of the leading coefficients.`, "What happens for very large x? ?"),
                step(`${tex(`\\frac{${a}}{1} = ${a}`)}, so the asymptote is ${tex(`y = ${a}`)}.`, "y = ?"),
              ],
        };
      }
      if (tier === 1) {
        // y = (ax + b)/(cx + d) with c > 1: fractional asymptotes.
        const c = r.pick([2, 3, 4]);
        const a = nonZero(r, -5, 5);
        const d = nonZero(r, -6, 6);
        let b = r.int(-6, 6);
        if (a * d === b * c) b += 1;
        const rule = `y = \\frac{${polyTex([a, b])}}{${polyTex([c, d])}}`;
        return {
          stem: `What is the ${askVertical ? "vertical" : "horizontal"} asymptote of ${tex(rule)}? ${tex(askVertical ? "x = ?" : "y = ?")}`,
          answer: askVertical ? fracAns(-d, c) : fracAns(a, c),
          workedSteps: askVertical
            ? [
                step(`A vertical asymptote sits where the denominator is 0 (and the top is not): ${tex(`${polyTex([c, d])} = 0`)}.`, "Set the denominator to 0: ?"),
                step(`${tex(`x = ${fracTex(-d, c)}`)}.`, "x = ?"),
              ]
            : [
                step("The top and bottom have the same degree, so the horizontal asymptote is the ratio of the leading coefficients.", "Compare the degrees: ?"),
                step(`${tex(`y = ${fracTex(a, c)}`)}.`, "y = ?"),
              ],
        };
      }
      // Degree-two denominators.
      const [p, q] = twoRoots(r, -4, 4);
      const denominator = expandRoots([p, q]);
      if (r.int(0, 2) === 0) {
        // Where is the HOLE? Top and bottom are both multiplied out, so the
        // common factor has to be found by factoring; it is never printed.
        const hole = r.pick([p, q]);
        const asymptote = hole === p ? q : p;
        let other = r.int(-4, 4);
        for (let tries = 0; other === hole || other === asymptote; tries++) other = r.int(-4, 4);
        const numerator = expandRoots([hole, other]);
        return {
          stem: `The graph of ${tex(`y = \\frac{${polyTex(numerator)}}{${polyTex(denominator)}}`)} has a hole. Where? ${tex("x = ?")}`,
          answer: fracAns(hole, 1),
          workedSteps: [
            step(`Factor the top and the bottom: ${tex(`\\frac{${factoredTex([hole, other], 1)}}{${factoredTex([p, q], 1)}}`)}.`, "Factor the top and the bottom: ?"),
            step(`The factor ${tex(factoredTex([hole], 1))} is in both, so it cancels. Where it is 0 the rule is undefined but the simplified rule is not: a hole.`, "Which factor cancels? ?"),
            step(`${tex(`x = ${hole}`)}.`, "x = ?"),
          ],
        };
      }
      if (askVertical) {
        // (x − hole)/((x − p)(x − q)): one factor cancels and leaves a hole.
        const hole = r.pick([p, q]);
        const asymptote = hole === p ? q : p;
        const k = r.pick([1, 2, 3, -1]);
        const numerator =
          k === 1 || hole === 0 ? polyTex([k, -k * hole]) : `${k === -1 ? "-" : k}(${polyTex([1, -hole])})`;
        return {
          stem: `${tex(`y = \\frac{${numerator}}{${polyTex(denominator)}}`)} has exactly one vertical asymptote. Find it: ${tex("x = ?")}`,
          answer: fracAns(asymptote, 1),
          workedSteps: [
            step(`Factor the bottom: ${tex(factoredTex([p, q], 1))}.`, "Factor the denominator: ?"),
            step(`The factor ${tex(factoredTex([hole], 1))} cancels with the top, so ${tex(`x = ${hole}`)} is a hole, not an asymptote.`, "Which factor cancels? ?"),
            step(`What is left, ${tex(factoredTex([asymptote], 1))}, is 0 at ${tex(`x = ${asymptote}`)}.`, "x = ?"),
          ],
        };
      }
      const sameDegree = r.int(0, 1) === 0;
      const lead = nonZero(r, -4, 4);
      const numerator = sameDegree ? [lead, 0, r.int(-6, 6)] : [lead, r.int(-6, 6)];
      return {
        stem: `What is the horizontal asymptote of ${tex(`y = \\frac{${polyTex(numerator)}}{${polyTex(denominator)}}`)}? ${tex("y = ?")}`,
        answer: fracAns(sameDegree ? lead : 0, 1),
        workedSteps: [
          step(
            sameDegree
              ? "Top and bottom both have degree 2, so the graph levels off at the ratio of the leading coefficients."
              : "The top has a lower degree than the bottom, so for large x the fraction shrinks toward 0.",
            "Compare the degrees: ?",
          ),
          step(`${tex(`y = ${sameDegree ? lead : 0}`)}.`, "y = ?"),
        ],
      };
    }),
  ];
}
