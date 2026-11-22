/**
 * Algebra 2 — the `functions` strand: graph-first families.
 *
 * Most of these items SHOW a graph (the `functionPlot` prompt visual) and ask
 * for something read from it, typed. Nothing that would give the answer away is
 * drawn: no labelled points, no asymptote lines, no shading of an answer.
 *
 * Two pad facts shape the answer choices (see the lane report):
 *  - the touch algebra pad has no |x| key, so a typed absolute-value RULE is
 *    never asked for; absolute value appears only where the answer is a number;
 *  - a template has ONE answer type, so a family that needs a judgement between
 *    statements (open vs closed, which direction) is multiple choice throughout.
 *
 * The helpers exported at the bottom (rule writing, windows) are shared with
 * `graphNodes.ts`, the other graph-first file.
 */
import type { WorkedStep } from "../fadedSteps";
import type { Algebra2Kit, Rng, Template } from "../templates";
import {
  makeFunctionPlotPromptVisual,
  type FunctionPlotCurve,
  type FunctionPlotPromptVisual,
} from "../../../../shared/practicePromptVisual";
import { parentValue, transformValue, type FunctionParent } from "../../../../shared/functionCurves";
import { evalPoly, polyAns, polyTex, tex } from "./format";

// ── Numbers, signs and rules ──────────────────────────────────────────────

/** A coefficient as a short fraction when it is one (0.5 → 1/2). */
function fractionOf(n: number): { num: number; den: number } {
  for (const den of [1, 2, 3, 4, 8]) {
    const num = n * den;
    if (Math.abs(num - Math.round(num)) < 1e-9) return { num: Math.round(num), den };
  }
  return { num: n, den: 1 };
}

/** LaTeX for a number: `3`, `-3`, `\frac{1}{2}`, `-\frac{1}{2}`. */
export function texNum(n: number): string {
  const { num, den } = fractionOf(n);
  if (den === 1) return String(num);
  return `${num < 0 ? "-" : ""}\\frac{${Math.abs(num)}}{${den}}`;
}

/** Answer-grammar number: `3`, `-3`, `1/2`, `-1/2`. */
export function ansNum(n: number): string {
  const { num, den } = fractionOf(n);
  return den === 1 ? String(num) : `${num}/${den}`;
}

function coefTex(a: number): string {
  if (a === 1) return "";
  if (a === -1) return "-";
  return texNum(a);
}

function coefAns(a: number): string {
  if (a === 1) return "";
  if (a === -1) return "-";
  // A fraction is bracketed so "(1/2)x^2" can never read as 1/(2x²).
  return Number.isInteger(a) ? ansNum(a) : `(${ansNum(a)})`;
}

/** `x`, `x - 3`, `x + 2` */
export function shiftTex(h: number): string {
  if (h === 0) return "x";
  return h > 0 ? `x - ${h}` : `x + ${-h}`;
}

function shiftAns(h: number): string {
  if (h === 0) return "x";
  return h > 0 ? `x-${h}` : `x+${-h}`;
}

/** ` + 3`, ` - 2`, `` */
export function tailTex(k: number): string {
  if (k === 0) return "";
  return k > 0 ? ` + ${k}` : ` - ${-k}`;
}

function tailAns(k: number): string {
  if (k === 0) return "";
  return k > 0 ? `+${k}` : `-${-k}`;
}

/** y = a·f(b(x − h)) + k, with b = −1 a flip left–right (omitted = 1). */
export type Transform = { a: number; h: number; k: number; b?: number };

/** The inside of f for a transform: `x - 3`, or flipped, `3 - x` / `-x`. */
function innerTex(t: Transform): string {
  if (t.b !== -1) return shiftTex(t.h);
  return t.h === 0 ? "-x" : `${t.h} - x`;
}

function innerAns(t: Transform): string {
  if (t.b !== -1) return shiftAns(t.h);
  return t.h === 0 ? "-x" : `${t.h}-x`;
}

/**
 * The body of a·f(x − h) for a parent, in LaTeX. `inner` is the text inside the
 * parent (normally `shiftTex(h)`, or a blank such as `x - ?`), `bare` says the
 * inner is just `x` (so x² needs no brackets), and `coef` is the coefficient
 * text (normally `coefTex(a)`).
 */
function bodyTex(parent: FunctionParent, coef: string, inner: string, bare: boolean): string {
  switch (parent) {
    case "linear":
      return `${coef}${bare ? "x" : `(${inner})`}`;
    case "quadratic":
      return `${coef}${bare ? "x" : `(${inner})`}^{2}`;
    case "cubic":
      return `${coef}${bare ? "x" : `(${inner})`}^{3}`;
    case "abs":
      return `${coef}\\lvert ${inner}\\rvert`;
    case "sqrt":
      return `${coef}\\sqrt{${inner}}`;
    case "exp2": {
      const power = `2^{${inner}}`;
      if (coef === "" || coef === "-") return `${coef}${power}`;
      return `${coef} \\cdot ${power}`;
    }
    case "log2":
      return `${coef}\\log_{2}(${inner})`;
    case "reciprocal":
      if (coef === "-") return `-\\frac{1}{${inner}}`;
      if (coef.startsWith("-")) return `-\\frac{${coef.slice(1)}}{${inner}}`;
      return `\\frac{${coef === "" ? "1" : coef}}{${inner}}`;
  }
}

/** y = a·f(x − h) + k in LaTeX (a linear parent is written as mx + b). */
export function ruleTex(parent: FunctionParent, t: Transform): string {
  if (parent === "linear") return polyTex([t.a, -t.a * t.h + t.k]);
  return bodyTex(parent, coefTex(t.a), innerTex(t), t.h === 0 && t.b !== -1) + tailTex(t.k);
}

/** y = a·f(x − h) + k in the answer grammar. Never used for abs (no pad key). */
export function ruleAns(parent: FunctionParent, t: Transform): string {
  const { a, h, k } = t;
  const c = coefAns(a);
  const bare = h === 0 && t.b !== -1;
  const inner = innerAns(t);
  const group = bare ? "x" : `(${inner})`;
  let body: string;
  switch (parent) {
    case "linear":
      return polyAns([a, -a * h + k]);
    case "quadratic":
      body = `${c}${group}^2`;
      break;
    case "cubic":
      body = `${c}${group}^3`;
      break;
    case "abs":
      body = `${c}|${inner}|`;
      break;
    case "sqrt":
      body = `${c}sqrt(${inner})`;
      break;
    case "exp2": {
      const power = bare ? "2^x" : `2^(${inner})`;
      body = a === 1 ? power : a === -1 ? `-${power}` : `${ansNum(a)}*${power}`;
      break;
    }
    case "log2":
      body = `${c}log_2(${inner})`;
      break;
    case "reciprocal":
      body = `${ansNum(a)}/${group}`;
      break;
  }
  return body + tailAns(k);
}

/** The parent function's own rule, `y = …`, in LaTeX. */
export function parentRuleTex(parent: FunctionParent): string {
  return `y = ${ruleTex(parent, { a: 1, h: 0, k: 0 })}`;
}

/** The point a scholar tracks on each parent, and what it is called. */
export const PARENT_ANCHOR: Record<FunctionParent, { x: number; y: number; name: string }> = {
  linear: { x: 0, y: 0, name: "point at the origin" },
  quadratic: { x: 0, y: 0, name: "vertex" },
  cubic: { x: 0, y: 0, name: "centre point" },
  abs: { x: 0, y: 0, name: "corner" },
  sqrt: { x: 0, y: 0, name: "starting point" },
  exp2: { x: 0, y: 1, name: "point (0, 1)" },
  log2: { x: 1, y: 0, name: "x-intercept" },
  reciprocal: { x: 0, y: 0, name: "centre, where the two asymptotes cross" },
};

/** Where the tracked point lands under y = a·f(x − h) + k. */
export function movedAnchor(parent: FunctionParent, t: Transform): { x: number; y: number } {
  const p = PARENT_ANCHOR[parent];
  return { x: t.h + (t.b === -1 ? -1 : 1) * p.x, y: t.a * p.y + t.k };
}

export function transformCurve(parent: FunctionParent, t: Transform, label?: string): FunctionPlotCurve {
  return { form: "transform", parent, a: t.a, h: t.h, k: t.k, ...(t.b === -1 ? { b: -1 } : {}), ...(label ? { label } : {}) };
}

/** A whole-unit window around the points that matter, always showing the origin. */
export function windowAround(
  xs: readonly number[],
  ys: readonly number[],
  pad = 2,
): { xMin: number; xMax: number; yMin: number; yMax: number } {
  const xMin = Math.floor(Math.min(0, ...xs)) - pad;
  const xMax = Math.ceil(Math.max(0, ...xs)) + pad;
  const yMin = Math.floor(Math.min(0, ...ys)) - pad;
  const yMax = Math.ceil(Math.max(0, ...ys)) + pad;
  return { xMin, xMax, yMin, yMax };
}

export function plotOf(
  curves: FunctionPlotCurve[],
  window: { xMin: number; xMax: number; yMin: number; yMax: number },
  extras: Pick<FunctionPlotPromptVisual, "shadeX"> = {},
): FunctionPlotPromptVisual {
  return makeFunctionPlotPromptVisual({ ...window, curves, ...extras });
}

/** Points worth keeping in view for a transformed parent: its anchor and one step right. */
function keyPoints(parent: FunctionParent, t: Transform): { xs: number[]; ys: number[] } {
  const anchor = movedAnchor(parent, t);
  const step = parent === "quadratic" && Math.abs(t.a) < 1 ? 2 : 1;
  const x2 = anchor.x + (t.b === -1 ? -1 : 1) * step;
  const y2 = transformValue(parent, t, x2);
  return { xs: [anchor.x, x2], ys: [anchor.y, Number.isFinite(y2) ? y2 : anchor.y] };
}

export function windowForTransforms(
  items: Array<{ parent: FunctionParent; t: Transform }>,
  pad = 3,
): { xMin: number; xMax: number; yMin: number; yMax: number } {
  const xs: number[] = [];
  const ys: number[] = [];
  for (const { parent, t } of items) {
    const kp = keyPoints(parent, t);
    xs.push(...kp.xs);
    ys.push(...kp.ys);
  }
  // Past 14 units the plot labels every other grid line; trim the margin first.
  for (let p = pad; p > 1; p--) {
    const w = windowAround(xs, ys, p);
    if (w.xMax - w.xMin <= 14 && w.yMax - w.yMin <= 14) return w;
  }
  return windowAround(xs, ys, 1);
}

function signedWords(n: number, positive: string, negative: string): string {
  return `${Math.abs(n)} ${n > 0 ? positive : negative}`;
}

function shiftWords(h: number, k: number): string {
  const parts: string[] = [];
  if (h !== 0) parts.push(signedWords(h, "to the right", "to the left"));
  if (k !== 0) parts.push(signedWords(k, "up", "down"));
  return parts.length === 0 ? "not at all" : parts.join(" and ");
}

const SHAPE_WORDS: Record<FunctionParent, string> = {
  linear: "a straight line through its points",
  quadratic: "a U shape with a rounded bottom",
  cubic: "an S shape that rises, flattens out, then rises again",
  abs: "a V shape with straight sides meeting at a sharp corner",
  sqrt: "half of a sideways parabola: it starts at a point and bends to the right",
  exp2: "a curve that hugs a horizontal line on one side and climbs faster and faster on the other",
  log2: "a curve that hugs a vertical line, then climbs more and more slowly to the right",
  reciprocal: "two separate branches, each hugging a vertical and a horizontal line",
};

/** Parents a scholar mixes up, most confusable first. */
const CONFUSABLE: Record<FunctionParent, FunctionParent[]> = {
  linear: ["abs", "cubic", "quadratic"],
  quadratic: ["abs", "cubic", "sqrt"],
  cubic: ["quadratic", "linear", "reciprocal"],
  abs: ["quadratic", "linear", "sqrt"],
  sqrt: ["log2", "quadratic", "exp2"],
  exp2: ["quadratic", "log2", "reciprocal"],
  log2: ["sqrt", "exp2", "reciprocal"],
  reciprocal: ["exp2", "cubic", "log2"],
};

// ── Domain and range statements ───────────────────────────────────────────

export type Rel = "ge" | "gt" | "le" | "lt" | "ne";
// `>` and `<` are padded to the length of `\ge`/`\le`. Math mode ignores the
// spaces, and on screen the symbols are equally wide; unpadded, the raw string
// lengths of the options would hint at which one is strict.
export const REL_TEX: Record<Rel, string> = { ge: "\\ge", gt: ">  ", le: "\\le", lt: "<  ", ne: "\\ne" };
const ALL_REALS = "All real numbers";

function statement(variable: "x" | "y", rel: Rel, n: number): string {
  return tex(`${variable} ${REL_TEX[rel]} ${n}`);
}

/** Domain/range options for one item: the correct statement first. */
function domainRangeOptions(
  parent: FunctionParent,
  t: Transform,
  ask: "domain" | "range",
): { correct: string; distractors: string[]; why: string } {
  const { a, h, k } = t;
  const fallbacks = [statement("x", "ge", 0), statement("y", "gt", 0), statement("y", "ge", 0)];
  const otherX = k !== h ? k : h !== 0 ? -h : 1;
  const otherY = h !== k ? h : k !== 0 ? -k : 1;
  if (ask === "domain") {
    switch (parent) {
      case "sqrt":
        return {
          correct: statement("x", "ge", h),
          distractors: [statement("x", "gt", h), statement("x", "le", h), statement("x", "ge", otherX), ALL_REALS],
          why: `The graph starts at ${tex(`x = ${h}`)}, includes that starting point, and runs right forever.`,
        };
      case "log2":
        return {
          correct: statement("x", "gt", h),
          distractors: [statement("x", "ge", h), statement("x", "lt", h), ALL_REALS, ...fallbacks],
          why: `The graph hugs the line ${tex(`x = ${h}`)} without ever touching it, then runs right forever.`,
        };
      case "reciprocal":
        return {
          correct: statement("x", "ne", h),
          distractors: [statement("x", "ne", otherX), statement("x", "gt", h), ALL_REALS, ...fallbacks],
          why: `The graph breaks only at ${tex(`x = ${h}`)}, where it shoots up and down; every other x is used.`,
        };
      default:
        return {
          correct: ALL_REALS,
          distractors: [statement("x", "ge", h), statement("x", "ge", otherX), statement("y", a > 0 ? "ge" : "le", k), ...fallbacks],
          why: "The graph keeps going left and right forever, with no gaps.",
        };
    }
  }
  switch (parent) {
    case "sqrt":
    case "quadratic":
    case "abs": {
      const rel: Rel = a > 0 ? "ge" : "le";
      const flip: Rel = a > 0 ? "le" : "ge";
      const strict: Rel = a > 0 ? "gt" : "lt";
      return {
        correct: statement("y", rel, k),
        distractors: [statement("y", flip, k), statement("y", rel, otherY), statement("y", strict, k), ALL_REALS],
        why: `The lowest${a > 0 ? "" : " (here, highest)"} point is at ${tex(`y = ${k}`)}, and the graph reaches it; from there it only goes ${a > 0 ? "up" : "down"}.`,
      };
    }
    case "exp2": {
      const rel: Rel = a > 0 ? "gt" : "lt";
      return {
        correct: statement("y", rel, k),
        distractors: [statement("y", a > 0 ? "ge" : "le", k), statement("y", a > 0 ? "lt" : "gt", k), ALL_REALS, statement("y", rel, otherY)],
        why: `The graph hugs the line ${tex(`y = ${k}`)} but never reaches it, and stays ${a > 0 ? "above" : "below"} it.`,
      };
    }
    case "reciprocal":
      return {
        correct: statement("y", "ne", k),
        distractors: [statement("y", "ne", otherY), statement("y", "gt", k), ALL_REALS, ...fallbacks],
        why: `The branches get close to ${tex(`y = ${k}`)} but never reach it; every other height is used.`,
      };
    default:
      return {
        correct: ALL_REALS,
        distractors: [statement("y", "gt", k), statement("y", "gt", 0), statement("x", "gt", h), statement("y", "ge", k)],
        why: "The graph keeps climbing up and falling down without limit, slowly but forever.",
      };
  }
}

// ── Small helpers for the typed families ──────────────────────────────────

function nonZero(r: Rng, lo: number, hi: number): number {
  const n = r.int(lo, hi - 1);
  return n >= 0 ? n + 1 : n;
}

function step(text: string, blankText: string): WorkedStep {
  return { text, blankText };
}

/** `g(x) = …` with one of a, h, k replaced by `?` (LaTeX). */
function blankedRule(
  parent: FunctionParent,
  t: Transform,
  blank: "a" | "h" | "k",
): string {
  const coef = blank === "a" ? "?" : coefTex(t.a);
  const inner = blank === "h" ? "x - ?" : shiftTex(t.h);
  const bare = blank !== "h" && t.h === 0;
  const tail = blank === "k" ? " + ?" : tailTex(t.k);
  return `g(x) = ${bodyTex(parent, coef, inner, bare)}${tail}`;
}

function blankValue(t: Transform, blank: "a" | "h" | "k"): number {
  return blank === "a" ? t.a : blank === "h" ? t.h : t.k;
}

function fractionText(num: number, den: number): string {
  if (den < 0) return fractionText(-num, -den);
  return den === 1 ? String(num) : `${num}/${den}`;
}

// ── The families ──────────────────────────────────────────────────────────

export function functionsTemplates(kit: Algebra2Kit): Template[] {
  const { T, choiceItem, exprAns, fracAns, intAns } = kit;

  return [
    // Domain/range: a judgement between statements (direction, open or closed,
    // x or y), so the whole family is multiple choice. The distractors are the
    // named misconceptions: the flipped direction, the wrong endpoint type, and
    // the domain/range swap.
    T("fn_domain_range_graph", "multipleChoice", (r) => {
      const tier = r.int(0, 3);
      if (tier === 3) {
        const d = restrictedDomainRange(r);
        return choiceItem(r, d.stem, d.correct, d.distractors, d.visual, d.steps);
      }
      const parent = r.pick<FunctionParent>(
        tier === 0 ? ["sqrt", "quadratic", "abs"] : tier === 1 ? ["sqrt", "exp2", "log2", "quadratic", "abs"] : ["exp2", "log2", "reciprocal", "sqrt"],
      );
      const a = tier === 0 ? r.pick([1, 2]) : r.pick([1, -1, 2, -2]);
      const t = { a, h: r.int(-3, 3), k: r.int(-3, 3) };
      const interesting: Record<FunctionParent, "domain" | "range" | "either"> = {
        linear: "range",
        quadratic: "range",
        cubic: "range",
        abs: "range",
        sqrt: "either",
        exp2: "range",
        log2: "domain",
        reciprocal: "either",
      };
      const lean = interesting[parent];
      const ask: "domain" | "range" =
        lean === "either"
          ? r.pick<"domain" | "range">(["domain", "range"])
          : r.int(0, 3) === 0
            ? lean === "domain" ? "range" : "domain"
            : lean;
      const { correct, distractors, why } = domainRangeOptions(parent, t, ask);
      const anchor = movedAnchor(parent, t);
      const window = windowAround([anchor.x - 4, anchor.x + 5], [anchor.y - 4, anchor.y + 4], 0);
      const variable = ask === "domain" ? "x" : "y";
      // Arrowheads show where the graph keeps going past the grid.
      const visual = plotOf([transformCurve(parent, t)], window);
      const scan = step(
        `The ${ask} is every ${variable}-value the graph uses. Scan ${ask === "domain" ? "from left to right" : "from bottom to top"}; an arrow means the graph keeps going.`,
        `Which values make up the ${ask}? ?`,
      );
      // Some draws TYPE the one number of the statement instead: the stem then
      // states the direction, and the scholar reads the bound off the grid
      // (typing the x-value for a range is the domain/range swap, caught).
      // The judgement draws (open or closed, which way, all reals) stay choice.
      const bound = correct.match(/^\\\((x|y) (\\ge|>|\\le|<|\\ne)\s+(-?\d+)\\\)$/);
      if (bound && tier < 2 && r.int(0, 1) === 0) {
        const [, v, rel, n] = bound;
        const blank = rel === "\\ne" ? `all real numbers except ${tex(`${v} = ?`)}` : tex(`${v} ${rel} ?`);
        return {
          stem: `The ${ask} of the function graphed here is ${blank}. What is the missing number?`,
          answer: intAns(Number(n)),
          answerType: "integer" as const,
          promptVisual: visual,
          workedSteps: [
            scan,
            step(why, "What does the graph do there? ?"),
            step(`So the ${ask} is ${correct}, and the missing number is ${n}.`, "The missing number is: ?"),
          ],
        };
      }
      return choiceItem(r, `What is the ${ask} of the function graphed here?`, correct, distractors, visual, [
        scan,
        step(why, "What does the graph do there? ?"),
        step(`So the ${ask} is ${correct}.`, `The ${ask} is: ?`),
      ]);
    }),

    // Average rate of change: read two points off a graph, or evaluate a rule
    // twice, then divide the change in output by the change in input.
    T("fn_avg_rate_of_change", "fraction", (r) => {
      const tier = r.int(0, 2);
      let f: (x: number) => number;
      let x1: number;
      let x2: number;
      let fTex = "";
      let visual: FunctionPlotPromptVisual | undefined;
      if (tier === 0) {
        const parent = r.pick<FunctionParent>(["quadratic", "quadratic", "exp2"]);
        const t: Transform =
          parent === "quadratic"
            ? { a: r.pick([1, -1]), h: r.int(-2, 2), k: r.int(-3, 3) }
            : { a: 1, h: r.int(-1, 1), k: r.int(-3, 0) };
        f = (x) => transformValue(parent, t, x);
        // Keep both points within two units of the vertex (or three of the
        // exponential's anchor) so every height sits on a labelled grid line.
        if (parent === "quadratic") {
          x1 = t.h + r.int(-2, 1);
          x2 = Math.min(t.h + 2, x1 + r.int(1, 3));
        } else {
          x1 = t.h + r.int(0, 1);
          x2 = x1 + r.int(1, 2);
        }
        const ys = [f(x1), f(x2), t.k];
        visual = plotOf([transformCurve(parent, t)], windowAround([x1, x2, t.h], ys, 2), {
          shadeX: { from: x1, to: x2 },
        });
      } else if (tier === 1) {
        const coefficients = [r.pick([1, -1, 2]), r.int(-5, 5), r.int(-6, 6)];
        f = (x) => evalPoly(coefficients, x);
        fTex = polyTex(coefficients);
        x1 = r.int(-3, 2);
        x2 = x1 + r.int(2, 4);
      } else if (r.int(0, 1) === 0) {
        const q = r.int(-4, 4);
        const coefficients = [1, 0, q, r.int(-3, 3)];
        f = (x) => evalPoly(coefficients, x);
        fTex = polyTex(coefficients);
        x1 = r.int(-2, 1);
        x2 = x1 + r.int(2, 3);
      } else {
        f = (x) => Math.pow(2, x);
        fTex = "2^{x}";
        x1 = r.int(0, 2);
        x2 = x1 + r.int(2, 3);
      }
      const y1 = f(x1);
      const y2 = f(x2);
      const dy = y2 - y1;
      const dx = x2 - x1;
      const answer = fracAns(dy, dx);
      const where = tex(`x = ${x1}`) + " to " + tex(`x = ${x2}`);
      const stem = visual
        ? `Use the graph of f. What is the average rate of change of f from ${where}?`
        : `${tex(`f(x) = ${fTex}`)}. What is the average rate of change of f from ${where}?`;
      const source = visual ? "Read from the graph" : "Substitute";
      return {
        stem,
        answer,
        ...(visual ? { promptVisual: visual } : {}),
        workedSteps: [
          step(`${source}: ${tex(`f(${x1}) = ${y1}`)}.`, `${source}: f(${x1}) = ?`),
          step(`${source}: ${tex(`f(${x2}) = ${y2}`)}.`, `${source}: f(${x2}) = ?`),
          step(
            `Change in f over change in x: ${tex(`\\frac{${y2} - (${y1})}{${x2} - (${x1})} = \\frac{${dy}}{${dx}}`)}.`,
            "Change in f over change in x: ?",
          ),
          step(`In simplest form, the average rate of change is ${formatFraction(dy, dx)}.`, "Average rate of change = ?"),
        ],
      };
    }),

    // Parent families: matching a graph to its parent rule is a recognition
    // judgement, and |x| has no key on the touch pad, so this one is choice.
    T("fn_parent_families", "multipleChoice", (r) => {
      const tier = r.int(0, 2);
      const parent = r.pick<FunctionParent>(
        tier === 0
          ? ["linear", "quadratic", "abs", "sqrt"]
          : ["cubic", "exp2", "log2", "reciprocal", "sqrt", "abs", "quadratic"],
      );
      const moved = tier === 2;
      const t: Transform = moved
        ? { a: r.pick([1, -1, 2, -2]), h: nonZero(r, -3, 3), k: r.int(-3, 3) }
        : { a: 1, h: 0, k: 0 };
      // The most confusable parent, then two drawn at random: a fixed
      // confusable set made the right rule the longest option every time.
      const rest = (["linear", "quadratic", "cubic", "abs", "sqrt", "exp2", "log2", "reciprocal"] as FunctionParent[]).filter(
        (p) => p !== parent && p !== CONFUSABLE[parent][0],
      );
      const picked: FunctionParent[] = [CONFUSABLE[parent][0]];
      while (picked.length < 3) {
        const p = r.pick(rest);
        if (!picked.includes(p)) picked.push(p);
      }
      const correct = tex(parentRuleTex(parent));
      const distractors = picked.map((p) => tex(parentRuleTex(p)));
      const anchor = movedAnchor(parent, t);
      const window = windowAround([anchor.x - 4, anchor.x + 4], [anchor.y - 4, anchor.y + 4], 0);
      const stem = moved
        ? "This graph is a parent function that has been moved, stretched or flipped. Which parent function is it built from?"
        : "Which parent function is graphed here?";
      return choiceItem(r, stem, correct, distractors, plotOf([transformCurve(parent, t)], window), [
        step(`Look at the shape: ${SHAPE_WORDS[parent]}.`, "Describe the shape you see: ?"),
        step(`That shape belongs to ${correct}${moved ? ", moved to a new place" : ""}.`, "Which parent has that shape? ?"),
      ]);
    }),

    // Translations, with the horizontal-shift sign trap set on purpose: half the
    // shifts go LEFT, which is x + h inside the function.
    T(
      "fn_transform_translate",
      "expression",
      (r) => {
        const tier = r.int(0, 2);
        const parent = r.pick<FunctionParent>(
          tier === 0 ? ["quadratic", "abs", "sqrt", "cubic"] : tier === 1 ? ["quadratic", "sqrt", "cubic"] : ["quadratic", "sqrt", "cubic", "exp2"],
        );
        const h = nonZero(r, -4, 4);
        const k = tier === 1 ? 0 : nonZero(r, -4, 4);
        const t: Transform = { a: 1, h, k };
        const identity: Transform = { a: 1, h: 0, k: 0 };
        const visual = plotOf(
          [transformCurve(parent, identity, "f"), transformCurve(parent, t, "g")],
          windowForTransforms([{ parent, t: identity }, { parent, t }]),
        );
        const from = movedAnchor(parent, identity);
        const to = movedAnchor(parent, t);
        const fTex = `f(x) = ${ruleTex(parent, identity)}`;
        const intro = `The graph of g is the graph of ${tex(fTex)} moved.`;
        const see = step(
          `The ${PARENT_ANCHOR[parent].name} of f is at (${from.x}, ${from.y}); on g it is at (${to.x}, ${to.y}): moved ${shiftWords(h, k)}.`,
          `How far did the ${PARENT_ANCHOR[parent].name} move? ?`,
        );
        const rule = step(
          `Moving ${h > 0 ? `right ${h}` : `left ${-h}`} puts ${tex(shiftTex(h))} inside f${k !== 0 ? `; moving ${k > 0 ? `up ${k}` : `down ${-k}`} adds ${tex(tailTex(k).trim())} outside` : ""}.`,
          "What goes inside f, and what goes outside? ?",
        );
        if (tier === 0) {
          const blank = r.pick<"h" | "k">(["h", "k"]);
          const value = blankValue(t, blank);
          return {
            stem: `${intro} Fill in the missing number: ${tex(blankedRule(parent, t, blank))}`,
            answer: exprAns(String(value)),
            promptVisual: visual,
            workedSteps: [
              see,
              rule,
              step(
                `So ${tex(`g(x) = ${ruleTex(parent, t)}`)}, and the missing number is ${value}.`,
                "The missing number is: ?",
              ),
            ],
          };
        }
        return {
          stem: `${intro} Write a rule for ${tex("g(x)")}.`,
          answer: exprAns(ruleAns(parent, t)),
          promptVisual: visual,
          workedSteps: [see, rule, step(`So ${tex(`g(x) = ${ruleTex(parent, t)}`)}.`, "g(x) = ?")],
        };
      },
      { answerPalette: "algebra" },
    ),

    // Stretches and reflections. The last tier names the reflection in words
    // (across the y-axis is f(−x), across the x-axis is −f(x)) because the
    // graph of √(−x) or 2^(−x) cannot be drawn as a·f(x − h) + k.
    T(
      "fn_transform_scale_reflect",
      "expression",
      (r) => {
        const tier = r.int(0, 2);
        if (tier === 2) {
          // −f(x) against f(−x), on a GRAPH: √x, 2^x and log₂x are the parents
          // where the two reflections differ (for x² and |x| a left–right flip
          // changes nothing).
          // log₂x is a curve to READ here, never a rule to type: this strand
          // opens from early Algebra 1, before logarithms, so a log₂ draw is
          // always the choice among −f(x), f(−x) and −f(−x).
          const parent = r.pick<FunctionParent>(["sqrt", "exp2", "log2"]);
          const choice = parent === "log2" || r.int(0, 1) === 0;
          const [a, b] = choice
            ? r.pick<[number, number]>([[-1, 1], [1, -1], [-1, -1]])
            : r.pick<[number, number]>([[-1, 1], [1, -1], [-1, -1], [2, -1], [-2, 1], [-2, -1]]);
          const t: Transform = { a, h: 0, k: 0, ...(b === -1 ? { b: -1 } : {}) };
          const identity: Transform = { a: 1, h: 0, k: 0 };
          const visual = plotOf([transformCurve(parent, identity, "f"), transformCurve(parent, t, "g")], {
            xMin: -6,
            xMax: 6,
            yMin: -6,
            yMax: 6,
          });
          const fTex = ruleTex(parent, identity);
          const flipStep =
            b === -1
              ? step(
                  "g is f mirrored left–right, across the y-axis: each point (x, y) goes to (−x, y), so the INPUT changes sign and x becomes −x inside f.",
                  "Is g mirrored left–right? ?",
                )
              : step("g is not mirrored left–right: its points sit on the same side of the y-axis as f's.", "Is g mirrored left–right? ?");
          const upStep = step(
            a < 0
              ? `g is also turned upside down, across the x-axis: the OUTPUT changes sign, so a minus goes in front${Math.abs(a) === 1 ? "" : `, and every height is ${Math.abs(a)} times as far from the axis`}.`
              : `g is not turned upside down${a === 1 ? "" : `, but every height is ${a} times as far from the axis`}.`,
            "Is g upside down, and is it stretched? ?",
          );
          const intro = `The graph of g is the graph of ${tex(`f(x) = ${fTex}`)} reflected${Math.abs(a) === 1 ? "" : " and stretched"}.`;
          if (choice) {
            const label = (aa: number, bb: number) => tex(`g(x) = ${aa < 0 ? "-" : ""}f(${bb < 0 ? "-x" : "x"})`);
            return {
              ...choiceItem(
                r,
                `${intro} Which rule describes g?`,
                label(a, b),
                [[-1, 1], [1, -1], [-1, -1]]
                  .filter(([aa, bb]) => aa !== a || bb !== b)
                  .map(([aa, bb]) => label(aa, bb))
                  .concat([tex("g(x) = \\frac{1}{f(x)}")]),
                visual,
                [flipStep, upStep, step(`So ${label(a, b)}.`, "Which rule is it? ?")],
              ),
              answerType: "multipleChoice" as const,
            };
          }
          return {
            stem: `${intro} Write a rule for ${tex("g(x)")}.`,
            answer: exprAns(ruleAns(parent, t)),
            promptVisual: visual,
            workedSteps: [flipStep, upStep, step(`So ${tex(`g(x) = ${ruleTex(parent, t)}`)}.`, "g(x) = ?")],
          };
        }
        const parent = r.pick<FunctionParent>(tier === 0 ? ["quadratic", "abs", "sqrt", "cubic"] : ["quadratic", "sqrt", "cubic"]);
        const halves = parent === "quadratic" || parent === "abs";
        const a = r.pick(halves ? [2, 3, -1, -2, 0.5, -0.5] : [2, 3, -1, -2, -3]);
        const t: Transform = { a, h: 0, k: 0 };
        const identity: Transform = { a: 1, h: 0, k: 0 };
        const visual = plotOf(
          [transformCurve(parent, identity, "f"), transformCurve(parent, t, "g")],
          { xMin: -6, xMax: 6, yMin: -7, yMax: 7 },
        );
        const probe = Math.abs(a) < 1 ? 2 : 1;
        const fAt = parentValue(parent, probe);
        const gAt = a * fAt;
        const read = step(
          `At ${tex(`x = ${probe}`)}, f is at height ${fAt} and g is at height ${texOrNum(gAt)}.`,
          `How high are f and g at x = ${probe}? ?`,
        );
        const factor = step(
          `Every height of g is ${texOrNum(gAt)} ÷ ${fAt} = ${texOrNum(a)} times the height of f${a < 0 ? " (the minus flips it across the x-axis)" : ""}.`,
          "What is g's height divided by f's height? ?",
        );
        const intro = `The graph of g is the graph of ${tex(`f(x) = ${ruleTex(parent, identity)}`)} stretched, squashed or flipped.`;
        if (tier === 0) {
          const power = parent === "quadratic" || parent === "cubic";
          const blank = power ? `? \\cdot ${bodyTex(parent, "", "x", true)}` : bodyTex(parent, "?", "x", true);
          return {
            stem: `${intro} Fill in the missing number: ${tex(`g(x) = ${blank}`)}`,
            answer: exprAns(ansNum(a)),
            promptVisual: visual,
            workedSteps: [read, factor, step(`The missing number is ${texOrNum(a)}.`, "The missing number is: ?")],
          };
        }
        return {
          stem: `${intro} Write a rule for ${tex("g(x)")}.`,
          answer: exprAns(ruleAns(parent, t)),
          promptVisual: visual,
          workedSteps: [read, factor, step(`So ${tex(`g(x) = ${ruleTex(parent, t)}`)}.`, "g(x) = ?")],
        };
      },
      { answerPalette: "algebra" },
    ),

    // a·f(x − h) + k read from a graph: the anchor gives h and k, a second point
    // gives a. The top tier uses exponential and reciprocal parents, where the
    // asymptotes (not drawn) move with the curve.
    T(
      "fn_transform_combined",
      "expression",
      (r) => {
        const tier = r.int(0, 2);
        const parent = r.pick<FunctionParent>(
          tier === 0 ? ["quadratic", "abs", "sqrt", "cubic"] : tier === 1 ? ["quadratic", "sqrt", "cubic"] : ["exp2", "reciprocal", "exp2", "reciprocal", "quadratic"],
        );
        const halves = parent === "quadratic" || parent === "abs";
        const a = r.pick(halves ? [2, -1, -2, 0.5, -0.5, 3] : parent === "reciprocal" ? [2, -1, -2, 3, -3] : [2, -1, -2, 3]);
        const t: Transform = { a, h: nonZero(r, -3, 3), k: nonZero(r, -3, 3) };
        const identity: Transform = { a: 1, h: 0, k: 0 };
        const visual = plotOf(
          [transformCurve(parent, identity, "f"), transformCurve(parent, t, "g")],
          windowForTransforms([{ parent, t: identity }, { parent, t }], 3),
        );
        const anchor = movedAnchor(parent, t);
        const probe = Math.abs(a) < 1 ? 2 : 1;
        const reference = PARENT_ANCHOR[parent];
        const fRise = parentValue(parent, reference.x + probe) - reference.y;
        const gRise = transformValue(parent, t, anchor.x + probe) - anchor.y;
        const anchorStep =
          parent === "exp2"
            ? step(
                `g levels off along ${tex(`y = ${t.k}`)}, so k = ${t.k}. The point (0, 1) of f landed at (${anchor.x}, ${anchor.y}), so h = ${t.h}.`,
                "Where does g level off, and where did (0, 1) go? ?",
              )
            : parent === "reciprocal"
              ? step(
                  `The branches of g hug ${tex(`x = ${t.h}`)} and ${tex(`y = ${t.k}`)}, so its centre moved from (0, 0) to (${t.h}, ${t.k}).`,
                  "Which lines does g hug? ?",
                )
              : step(
                  `The ${reference.name} moved from (${reference.x}, ${reference.y}) to (${anchor.x}, ${anchor.y}): ${shiftWords(t.h, t.k)}, so h = ${t.h} and k = ${t.k}.`,
                  `Where did the ${reference.name} go? ?`,
                );
        const stretchStep = step(
          `${probe} to the right of that point, f ${fRise >= 0 ? "rises" : "falls"} ${Math.abs(fRise)} but g ${gRise >= 0 ? "rises" : "falls"} ${texOrNum(Math.abs(gRise))}, so a = ${texOrNum(a)}.`,
          "Compare how far f and g rise: a = ?",
        );
        const full = `g(x) = ${ruleTex(parent, t)}`;
        if (tier === 0) {
          const blank = r.pick<"a" | "h" | "k">(["a", "h", "k"]);
          const value = blankValue(t, blank);
          return {
            stem: `The graph of g is the graph of ${tex(`f(x) = ${ruleTex(parent, identity)}`)} moved and stretched. Fill in the missing number: ${tex(blankedRule(parent, t, blank))}`,
            answer: exprAns(ansNum(value)),
            promptVisual: visual,
            workedSteps: [anchorStep, stretchStep, step(`So ${tex(full)}; the missing number is ${texOrNum(value)}.`, "The missing number is: ?")],
          };
        }
        return {
          stem: `The graph of g is the graph of ${tex(`f(x) = ${ruleTex(parent, identity)}`)} moved and stretched. Write a rule for ${tex("g(x)")} in the form ${tex("a \\cdot f(x - h) + k")}.`,
          answer: exprAns(ruleAns(parent, t)),
          promptVisual: visual,
          workedSteps: [anchorStep, stretchStep, step(`Put a, h and k into ${tex("a \\cdot f(x - h) + k")}: ${tex(full)}.`, "g(x) = ?")],
        };
      },
      { answerPalette: "algebra" },
    ),

    // Piecewise: decide which piece an input belongs to, then evaluate. The
    // boundary input is the trap: the pieces disagree there on purpose.
    T("fn_piecewise_evaluate", "integer", (r) => {
      const tier = r.int(0, 3);
      if (tier === 3) return piecewiseGraphItem(r);
      type Piece = { coefficients: number[]; cond: string; holds: (x: number) => boolean };
      const linear = () => [nonZero(r, -3, 3), r.int(-5, 5)];
      const quadratic = () => [r.pick([1, -1]), 0, r.int(-4, 4)];
      let pieces: Piece[];
      let x: number;
      if (tier < 2) {
        const c = r.int(-2, 3);
        const leftIncludes = r.int(0, 1) === 0;
        const left = linear();
        let right = tier === 0 ? linear() : r.pick([linear(), quadratic(), [r.int(-5, 5)]]);
        // The pieces must disagree at the boundary, or the boundary item could
        // not tell the right piece from the wrong one.
        if (evalPoly(left, c) === evalPoly(right, c)) right = right.map((n, i) => (i === right.length - 1 ? n + 3 : n));
        pieces = [
          { coefficients: left, cond: `x ${leftIncludes ? "\\le" : "<"} ${c}`, holds: (v) => (leftIncludes ? v <= c : v < c) },
          { coefficients: right, cond: `x ${leftIncludes ? ">" : "\\ge"} ${c}`, holds: (v) => (leftIncludes ? v > c : v >= c) },
        ];
        x = tier === 1 ? c : c + nonZero(r, -3, 3);
      } else {
        const c1 = r.int(-3, 0);
        const c2 = c1 + r.int(2, 4);
        const left = linear();
        const middle = quadratic();
        let right = linear();
        if (evalPoly(middle, c2) === evalPoly(right, c2)) right = [right[0], right[1] + 2];
        pieces = [
          { coefficients: left, cond: `x < ${c1}`, holds: (v) => v < c1 },
          { coefficients: middle, cond: `${c1} \\le x \\le ${c2}`, holds: (v) => v >= c1 && v <= c2 },
          { coefficients: right, cond: `x > ${c2}`, holds: (v) => v > c2 },
        ];
        x = r.pick([c1, c2, c1 - r.int(1, 2), c2 + r.int(1, 2), c1 + 1]);
      }
      const chosen = pieces.find((p) => p.holds(x)) as Piece;
      const value = evalPoly(chosen.coefficients, x);
      const rows = pieces.map((p) => `${polyTex(p.coefficients)} & ${p.cond}`).join(" \\\\ ");
      const pieceTex = polyTex(chosen.coefficients);
      return {
        stem: `${tex(`f(x) = \\begin{cases} ${rows} \\end{cases}`)} Find ${tex(`f(${x})`)}.`,
        answer: intAns(value),
        workedSteps: [
          step(
            `Find the line whose condition ${tex(`x = ${x}`)} meets: ${tex(chosen.cond.replace(/x/g, `(${x})`))} is true.`,
            `Which condition does x = ${x} meet? ?`,
          ),
          step(`So use ${tex(pieceTex)} and only that line.`, "Which rule do you use? ?"),
          step(`Substitute: ${tex(`f(${x}) = ${value}`)}.`, `f(${x}) = ?`),
        ],
      };
    }),

    // Composition: evaluate from the inside out, or write f(g(x)) and expand it.
    // Half the items ask g(f(…)) so the order of the letters matters.
    T(
      "fn_compose",
      "expression",
      (r) => {
        const tier = r.int(0, 2);
        const fQuadratic = tier === 2 && r.int(0, 1) === 0;
        const gQuadratic = tier === 2 && !fQuadratic;
        const f = fQuadratic ? [r.pick([1, 2, -1]), 0, r.int(-5, 5)] : [nonZero(r, -4, 4), r.int(-6, 6)];
        const g = gQuadratic ? [r.pick([1, -1]), 0, r.int(-5, 5)] : [nonZero(r, -4, 4), r.int(-6, 6)];
        const outerIsF = r.int(0, 1) === 0;
        const outer = outerIsF ? f : g;
        const inner = outerIsF ? g : f;
        const o = outerIsF ? "f" : "g";
        const i = outerIsF ? "g" : "f";
        const given = `${tex(`f(x) = ${polyTex(f)}`)} and ${tex(`g(x) = ${polyTex(g)}`)}.`;
        if (tier === 0 || (tier === 2 && r.int(0, 2) === 0)) {
          const at = r.int(-3, 4);
          const innerValue = evalPoly(inner, at);
          const value = evalPoly(outer, innerValue);
          return {
            stem: `${given} Find ${tex(`${o}(${i}(${at}))`)}.`,
            answer: exprAns(String(value)),
            workedSteps: [
              step(`Work from the inside out: ${tex(`${i}(${at}) = ${innerValue}`)}.`, `${i}(${at}) = ?`),
              step(`Then ${tex(`${o}(${innerValue}) = ${value}`)}.`, `${o}(${innerValue}) = ?`),
            ],
          };
        }
        const composed = composePoly(outer, inner);
        const innerGroup = `(${polyTex(inner)})`;
        const substituted = substituteTex(outer, innerGroup);
        return {
          stem: `${given} Write ${tex(`${o}(${i}(x))`)} and simplify. Multiply out and combine like terms.`,
          answer: exprAns(polyAns(composed)),
          answerForm: "expanded",
          workedSteps: [
            step(`The inside function is ${i}: ${tex(`${i}(x) = ${polyTex(inner)}`)}.`, `What is ${i}(x)? ?`),
            step(`Put it in for every x in ${o}: ${tex(`${o}(${i}(x)) = ${substituted}`)}.`, `Replace x in ${o} with ${i}(x): ?`),
            step(`Multiply out and combine like terms: ${tex(polyTex(composed))}.`, `${o}(${i}(x)) = ?`),
          ],
        };
      },
      { answerPalette: "algebra" },
    ),

    // Inverses: swap x and y, then solve. Tiers: linear, cube, then a
    // rational function or a squared function restricted so it is one-to-one.
    T(
      "fn_inverse_find",
      "expression",
      (r) => {
        const tier = r.int(0, 2);
        const swap = step("Write y for f(x), then swap x and y.", "What do you swap? ?");
        if (tier === 0) {
          const m = r.pick([2, 3, 4, 5, -2, -3]);
          const b = nonZero(r, -9, 9);
          // (x − b)/m, written with a positive denominator.
          const ans = m > 0 ? `(x${b > 0 ? `-${b}` : `+${-b}`})/${m}` : `(${polyAns([-1, b])})/${-m}`;
          const ansTex = m > 0 ? `\\frac{${shiftTex(b)}}{${m}}` : `\\frac{${polyTex([-1, b])}}{${-m}}`;
          return {
            stem: `${tex(`f(x) = ${polyTex([m, b])}`)}. Find ${tex("f^{-1}(x)")}.`,
            answer: exprAns(ans),
            workedSteps: [
              swap,
              step(`${tex(`x = ${polyTex([m, b], "y")}`)}.`, "After the swap: x = ?"),
              step(`${b > 0 ? "Subtract" : "Add"} ${Math.abs(b)}, then divide by ${m}.`, "Undo the steps in reverse order: ?"),
              step(`${tex(`f^{-1}(x) = ${ansTex}`)}.`, "f⁻¹(x) = ?"),
            ],
          };
        }
        if (tier === 1) {
          const h = nonZero(r, -4, 4);
          const k = nonZero(r, -6, 6);
          const fT = ruleTex("cubic", { a: 1, h, k });
          const ans = `∛(${shiftAns(k)})${h > 0 ? `+${h}` : `-${-h}`}`;
          const ansTex = `\\sqrt[3]{${shiftTex(k)}}${tailTex(h)}`;
          return {
            stem: `${tex(`f(x) = ${fT}`)}. Find ${tex("f^{-1}(x)")}.`,
            answer: exprAns(ans),
            workedSteps: [
              swap,
              step(`${tex(`x = ${fT.replace(/x/g, "y")}`)}.`, "After the swap: x = ?"),
              step(`${k > 0 ? "Subtract" : "Add"} ${Math.abs(k)}, take the cube root, then ${h > 0 ? "add" : "subtract"} ${Math.abs(h)}.`, "Undo the steps in reverse order: ?"),
              step(`${tex(`f^{-1}(x) = ${ansTex}`)}.`, "f⁻¹(x) = ?"),
            ],
          };
        }
        if (r.int(0, 1) === 0) {
          // f(x) = (ax + b)/(x − c)  ⇒  f⁻¹(x) = (cx + b)/(x − a)
          const a = r.pick([1, 2, 3, -2]);
          const c = nonZero(r, -4, 4);
          let b = nonZero(r, -6, 6);
          if (a * c + b === 0) b += 1;
          const fTex = `\\frac{${polyTex([a, b])}}{${shiftTex(c)}}`;
          const invTex = `\\frac{${polyTex([c, b])}}{${shiftTex(a)}}`;
          const ans = `(${polyAns([c, b])})/(${shiftAns(a)})`;
          return {
            stem: `${tex(`f(x) = ${fTex}`)} for ${tex(`x \\ne ${c}`)}. Find ${tex("f^{-1}(x)")}.`,
            answer: exprAns(ans),
            workedSteps: [
              swap,
              step(`${tex(`x(${shiftTex(c).replace("x", "y")}) = ${polyTex([a, b], "y")}`)}: multiply both sides by the denominator.`, "Clear the fraction: ?"),
              step(`Collect the y terms on one side and factor out y: ${tex(`y(${shiftTex(a)}) = ${polyTex([c, b])}`)}.`, "Factor out y: ?"),
              step(`${tex(`f^{-1}(x) = ${invTex}`)}.`, "f⁻¹(x) = ?"),
            ],
          };
        }
        const h = nonZero(r, -4, 4);
        const k = nonZero(r, -5, 5);
        const fT = ruleTex("quadratic", { a: 1, h, k });
        const ans = `sqrt(${shiftAns(k)})${h > 0 ? `+${h}` : `-${-h}`}`;
        return {
          stem: `${tex(`f(x) = ${fT}`)} for ${tex(`x \\ge ${h}`)}, so f is one-to-one. Find ${tex("f^{-1}(x)")}.`,
          answer: exprAns(ans),
          workedSteps: [
            swap,
            step(`${tex(`x = ${fT.replace(/x/g, "y")}`)}, with ${tex(`y \\ge ${h}`)}.`, "After the swap: x = ?"),
            step(
              `${k > 0 ? "Subtract" : "Add"} ${Math.abs(k)} and take the square root. Because ${tex(`y \\ge ${h}`)}, ${tex(shiftTex(h).replace("x", "y"))} is not negative, so keep the positive root.`,
              "Which square root do you keep? ?",
            ),
            step(`${tex(`f^{-1}(x) = \\sqrt{${shiftTex(k)}}${tailTex(h)}`)}.`, "f⁻¹(x) = ?"),
          ],
        };
      },
      { answerPalette: "algebra" },
    ),

    // Inverses on a graph, typed one number at a time: swap a point's
    // coordinates, read f⁻¹(c) off the graph of f, or find where to cut the
    // domain so f is one-to-one.
    T("fn_inverse_graph", "integer", (r) => {
      const tier = r.int(0, 2);
      if (tier < 2) {
        // f is GIVEN BY ITS GRAPH, drawn with the mirror line y = x, so the
        // needed number must be read off the picture, never copied from the
        // stem. "f⁻¹" is written in plain text: its "-1" is not a number to type.
        const parent = r.pick<FunctionParent>(["exp2", "cubic", "sqrt", "linear"]);
        const t: Transform =
          parent === "exp2"
            ? { a: 1, h: r.int(-1, 1), k: r.int(-2, 1) }
            : parent === "linear"
              ? { a: r.pick([2, -2, 3]), h: r.int(-2, 2), k: r.int(-3, 3) }
              : { a: 1, h: r.int(-2, 2), k: r.int(-2, 2) };
        const xs = parent === "exp2" ? [t.h, t.h + 1, t.h + 2] : parent === "sqrt" ? [t.h + 1, t.h + 4] : [t.h - 1, t.h + 1];
        // Prefer an input where "evaluate f at c" (the classic slip) gives a
        // different number from the right answer.
        const f = (x: number) => transformValue(parent, t, x);
        const tells = (x: number) => f(x) !== x && !(Math.abs(f(f(x)) - x) < 1e-9);
        // A curve that meets y = x at every candidate cannot tell the two apart;
        // lift it one unit.
        if (!xs.some(tells)) t.k += 1;
        const telling = xs.filter(tells);
        const input = r.pick(telling.length > 0 ? telling : xs);
        const c = f(input);
        const window = windowAround([input, t.h, c], [c, t.k, input], 2);
        const visual = makeFunctionPlotPromptVisual({ ...window, curves: [transformCurve(parent, t, "f")], referenceLine: "y=x" });
        if (tier === 0) {
          // Read the point of f above x = input, then swap it.
          return {
            stem: `Here is the graph of f and the line y = x. Read the point of f at ${tex(`x = ${input}`)}, then fill in the matching point on the graph of f⁻¹: ${tex(`(?, ${input})`)}`,
            answer: intAns(c),
            promptVisual: visual,
            workedSteps: [
              step(`Above ${tex(`x = ${input}`)} the graph of f is at height ${c}: the point ${tex(`(${input}, ${c})`)}.`, `Where is f at x = ${input}? ?`),
              step("Reflecting over the line y = x swaps the two coordinates of every point.", "What does the reflection do to a point? ?"),
              step(`So ${tex(`(${c}, ${input})`)} is on f⁻¹, and the missing number is ${c}.`, "The missing number is: ?"),
            ],
          };
        }
        return {
          stem: `Here is the graph of f and the line y = x. Use it to find f⁻¹(${c}).`,
          answer: intAns(input),
          promptVisual: visual,
          workedSteps: [
            step(`f⁻¹(${c}) asks: which input does f send to ${c}?`, `What does f⁻¹(${c}) ask? ?`),
            step(`Find height ${tex(`y = ${c}`)} on the graph and read across to the curve, then down to the x-axis.`, "Where is the curve at that height? ?"),
            step(`The curve is at height ${c} when ${tex(`x = ${input}`)}, so f⁻¹(${c}) = ${input}.`, `f⁻¹(${c}) = ?`),
          ],
        };
      }
      const parent = r.pick<FunctionParent>(["quadratic", "abs"]);
      const t: Transform = { a: r.pick([1, -1]), h: nonZero(r, -3, 3), k: r.int(-3, 3) };
      const anchor = movedAnchor(parent, t);
      const name = parent === "quadratic" ? "vertex" : "corner";
      return {
        stem: `This function f fails the horizontal line test, so it has no inverse. Restricting its domain to ${tex("x \\ge ?")} fixes that. What is the smallest number that works?`,
        answer: intAns(t.h),
        promptVisual: plotOf([transformCurve(parent, t, "f")], windowAround([anchor.x - 4, anchor.x + 4], [anchor.y - 4, anchor.y + 4], 0)),
        workedSteps: [
          step(`The graph turns around at its ${name}, (${anchor.x}, ${anchor.y}); a horizontal line crosses it twice, once on each side.`, "Where does the graph turn around? ?"),
          step(`Keep only the right-hand side, starting at the ${name}: every horizontal line then crosses once.`, "Which side do you keep? ?"),
          step(`So restrict to ${tex(`x \\ge ${t.h}`)}.`, "The smallest number that works is: ?"),
        ],
      };
    }),
  ];
}

// ── A piecewise graph: read f at the join from the filled dot ───────────────

/** How many random draws a retry makes before its fallback. Tests set it to
 *  0 to serve (and check) every fallback. */
export const FUNCTIONS_DRAW = { attempts: 20 };

/**
 * Two rays of lines meeting above x = c, one ending in a filled dot (on the
 * graph) and one in a hollow dot (not on the graph). f(c) is the filled dot's
 * height; the hollow dot's height is the trap. The answer is never c itself,
 * the one number in the stem.
 */
function piecewiseGraphItem(r: Rng) {
  // Fallback (raw): pieces 2x + 1 and −x meet x = 1 at heights 3 and −1.
  let c = 1;
  let left = [2, 1];
  let right = [-1, 0];
  for (let tries = 0; tries < FUNCTIONS_DRAW.attempts; tries++) {
    const cc = r.int(-2, 2);
    const cl = [r.pick([1, -1, 2, -2]), r.int(-3, 3)];
    const cr = [r.pick([1, -1, 2, -2]), r.int(-3, 3)];
    const l = evalPoly(cl, cc);
    const rr = evalPoly(cr, cc);
    if (l !== rr && l !== cc && rr !== cc && Math.abs(l) <= 5 && Math.abs(rr) <= 5) {
      [c, left, right] = [cc, cl, cr];
      break;
    }
  }
  const leftIncludes = r.int(0, 1) === 0;
  const lc = evalPoly(left, c);
  const rc = evalPoly(right, c);
  const value = leftIncludes ? lc : rc;
  const window = windowAround([c - 4, c + 4], [lc, rc, -4, 4], 1);
  const visual = makeFunctionPlotPromptVisual({
    ...window,
    curves: [
      { form: "transform", parent: "linear", a: left[0], h: 0, k: left[1], domain: { to: c } },
      { form: "transform", parent: "linear", a: right[0], h: 0, k: right[1], domain: { from: c } },
    ],
    points: [
      { x: c, y: lc, ...(leftIncludes ? {} : { open: true }) },
      { x: c, y: rc, ...(leftIncludes ? { open: true } : {}) },
    ],
  });
  return {
    stem: `Here is the graph of the piecewise function f. Find ${tex(`f(${c})`)}.`,
    answer: { type: "integer" as const, value },
    promptVisual: visual,
    workedSteps: [
      step(`Above ${tex(`x = ${c}`)} the graph has two dots: one at height ${lc} and one at height ${rc}.`, `What is above x = ${c}? ?`),
      step(
        `A hollow dot is NOT on the graph; the filled dot is. The filled one is at height ${value}.`,
        "Which dot belongs to the graph? ?",
      ),
      step(`So ${tex(`f(${c}) = ${value}`)}.`, `f(${c}) = ?`),
    ],
  };
}

// ── Graphs that stop: the open/closed judgement read off the picture ───────

/**
 * A line drawn over part of its domain: one end stops at a dot (filled: the
 * point is on the graph; hollow: it is not) and the other runs off the grid
 * under an arrow, or both ends stop. The options differ in exactly the
 * judgements the picture decides: which end is closed, which way it runs, and
 * x against y.
 */
function restrictedDomainRange(r: Rng) {
  const m = r.pick([1, -1, 2, -2, 3]);
  const c = r.int(-3, 3);
  const f = (x: number) => m * x + c;
  const shape = r.pick<"right" | "left" | "both">(["right", "left", "both"]);
  const d1 = r.int(-4, 1);
  const d2 = d1 + r.int(2, 4);
  const closed1 = r.int(0, 1) === 0;
  const closed2 = r.int(0, 1) === 0;
  const ask = r.pick<"domain" | "range">(["domain", "range"]);
  const v = ask === "domain" ? "x" : "y";
  const le = (closed: boolean) => (closed ? REL_TEX.le : REL_TEX.lt);
  const ge = (closed: boolean) => (closed ? REL_TEX.ge : REL_TEX.gt);
  const ray = (variable: string, n: number, up: boolean, closed: boolean) =>
    tex(`${variable} ${up ? ge(closed) : le(closed)} ${n}`);
  const between = (variable: string, lo: number, hi: number, cl: boolean, ch: boolean) =>
    tex(`${lo} ${le(cl)} ${variable} ${le(ch)} ${hi}`);

  const points: Array<{ x: number; y: number; open?: boolean }> = [];
  let domain: { from?: number; to?: number };
  let correct: string;
  let distractors: string[];
  let why: string;
  if (shape === "both") {
    domain = { from: d1, to: d2 };
    points.push({ x: d1, y: f(d1), ...(closed1 ? {} : { open: true }) }, { x: d2, y: f(d2), ...(closed2 ? {} : { open: true }) });
    // Along y the ends swap when the line falls.
    const [lo, hi, cl, ch] =
      ask === "domain" ? [d1, d2, closed1, closed2] : m > 0 ? [f(d1), f(d2), closed1, closed2] : [f(d2), f(d1), closed2, closed1];
    correct = between(v, lo, hi, cl, ch);
    distractors = [between(v, lo, hi, !cl, ch), between(v, lo, hi, cl, !ch), between(v, lo, hi, !cl, !ch)];
    why = `The graph stops at both ends: ${closed1 ? "a filled" : "a hollow"} dot at x = ${d1} and ${closed2 ? "a filled" : "a hollow"} dot at x = ${d2}. A filled dot is on the graph; a hollow one is not.`;
  } else {
    const d = shape === "right" ? d1 : d2;
    const closed = closed1;
    domain = shape === "right" ? { from: d } : { to: d };
    points.push({ x: d, y: f(d), ...(closed ? {} : { open: true }) });
    const n = ask === "domain" ? d : f(d);
    // Which way the values run from the dot.
    const up = ask === "domain" ? shape === "right" : (shape === "right") === m > 0;
    const other = ask === "domain" ? f(d) : d;
    correct = ray(v, n, up, closed);
    distractors = [ray(v, n, up, !closed), ray(v, n, !up, closed), other !== n ? ray(v, other, up, closed) : ray(v, n, !up, !closed)];
    why = `The graph stops at ${closed ? "a filled dot, which is on the graph" : "a hollow dot, which is not on the graph"}, at (${d}, ${f(d)}), and an arrow shows it keeps going ${shape === "right" ? "to the right" : "to the left"}${ask === "range" ? `, ${up ? "up" : "down"}` : ""}.`;
  }
  const xs = [d1, d2, 0];
  const ys = points.map((p) => p.y);
  const window = windowAround(xs, ys, 2);
  const visual = makeFunctionPlotPromptVisual({
    ...window,
    curves: [{ form: "transform", parent: "linear", a: m, h: 0, k: c, domain }],
    points,
  });
  return {
    stem: `What is the ${ask} of the function graphed here?`,
    correct,
    distractors,
    visual,
    steps: [
      step(`The ${ask} is every ${v}-value the graph uses. Look at how each end of the graph finishes.`, "How does each end finish? ?"),
      step(why, "Is each end included? ?"),
      step(`So the ${ask} is ${correct}.`, `The ${ask} is: ?`),
    ],
  };
}

// ── Local helpers used above ──────────────────────────────────────────────

function texOrNum(n: number): string {
  return Number.isInteger(n) ? String(n) : tex(texNum(n));
}

function formatFraction(num: number, den: number): string {
  const sign = num * den < 0 ? -1 : 1;
  let p = Math.abs(num);
  let q = Math.abs(den);
  const g = gcdLocal(p, q);
  p /= g;
  q /= g;
  return fractionText(sign * p, q);
}

function gcdLocal(a: number, b: number): number {
  return b === 0 ? Math.max(1, a) : gcdLocal(b, a % b);
}

/** Coefficients of outer(inner(x)), highest power first. */
export function composePoly(outer: readonly number[], inner: readonly number[]): number[] {
  let result: number[] = [0];
  for (const c of outer) {
    result = addPoly(mulPoly(result, inner), [c]);
  }
  return trimPoly(result);
}

function mulPoly(p: readonly number[], q: readonly number[]): number[] {
  const out = new Array<number>(p.length + q.length - 1).fill(0);
  p.forEach((a, i) => q.forEach((b, j) => (out[i + j] += a * b)));
  return out;
}

function addPoly(p: readonly number[], q: readonly number[]): number[] {
  const n = Math.max(p.length, q.length);
  const out = new Array<number>(n).fill(0);
  p.forEach((a, i) => (out[n - p.length + i] += a));
  q.forEach((b, i) => (out[n - q.length + i] += b));
  return out;
}

function trimPoly(p: number[]): number[] {
  let i = 0;
  while (i < p.length - 1 && p[i] === 0) i++;
  return p.slice(i);
}

/** LaTeX for outer(x) with x replaced by a bracketed group, e.g. `2(x - 3) + 1`. */
function substituteTex(outer: readonly number[], group: string): string {
  const degree = outer.length - 1;
  let out = "";
  outer.forEach((c, index) => {
    if (c === 0) return;
    const power = degree - index;
    const magnitude = Math.abs(c);
    const coefficient = magnitude === 1 && power > 0 ? "" : String(magnitude);
    const body = power === 0 ? coefficient : `${coefficient}${group}${power > 1 ? `^{${power}}` : ""}`;
    if (out === "") out = (c < 0 ? "-" : "") + body;
    else out += (c < 0 ? " - " : " + ") + body;
  });
  return out === "" ? "0" : out;
}
