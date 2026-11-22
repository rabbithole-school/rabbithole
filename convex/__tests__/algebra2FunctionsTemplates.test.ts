import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  answersEqual,
  formatAnswer,
  meetsRequiredForm,
  numericValue,
  parseAnswer,
  type AnswerType,
} from "../lib/practice/answers";
import { FUNCTIONS_DRAW } from "../lib/practice/algebra2/functions";
import { untypableAnswer } from "./algebra2TestMath";
import { gradeTemplateItem, makeItemId } from "../lib/practice/session";
import { generateItem, hasTemplate, type PracticeItem } from "../lib/practice/templates";
import type { FunctionPlotPromptVisual } from "../../shared/practicePromptVisual";
import { transformValue, type FunctionParent } from "../../shared/functionCurves";

/**
 * The `functions` strand. Every check below re-derives the answer from what the
 * scholar is SHOWN (the plotted curve's parameters, the stem's numbers) rather
 * than reusing the generator's arithmetic, and grades through the real grader.
 */

const KEYS = [
  "fn_domain_range_graph",
  "fn_avg_rate_of_change",
  "fn_parent_families",
  "fn_transform_translate",
  "fn_transform_scale_reflect",
  "fn_transform_combined",
  "fn_piecewise_evaluate",
  "fn_compose",
  "fn_inverse_find",
  "fn_inverse_graph",
];

const MC_KEYS = new Set(["fn_domain_range_graph", "fn_parent_families"]);
const SEEDS = Array.from({ length: 220 }, (_, i) => i + 1);

function item(key: string, seed: number): PracticeItem {
  const it = generateItem(key, seed);
  if (!it) throw new Error(`no template for ${key}`);
  return it;
}

function submission(it: PracticeItem): string {
  return it.answer.type === "multipleChoice" ? String(it.answer.choiceIndex) : formatAnswer(it.answer);
}

function grade(key: string, seed: number, raw: string): boolean {
  return gradeTemplateItem(makeItemId(key, seed), raw)?.correct === true;
}

function same(a: string, b: string, type: AnswerType = "expression"): boolean {
  const pa = parseAnswer(a, type);
  const pb = parseAnswer(b, type);
  return pa !== null && pb !== null && answersEqual(pa, pb);
}

function plot(it: PracticeItem): FunctionPlotPromptVisual {
  const v = it.promptVisual;
  if (!v || v.kind !== "functionPlot") throw new Error(`expected a functionPlot: ${it.stem}`);
  return v;
}

type T = { parent: FunctionParent; a: number; h: number; k: number; b?: number };
function curve(it: PracticeItem, index: number): T {
  const c = plot(it).curves[index];
  if (!c || c.form !== "transform") throw new Error("expected a transform curve");
  return { parent: c.parent, a: c.a, h: c.h, k: c.k, ...(c.b === -1 ? { b: -1 } : {}) };
}

/** A rule for y = a·f(x − h) + k in deliberately different notation from the
 *  generator's (explicit products, bracketed shifts, abs()). */
function looseRule({ parent, a, h, k, b }: T): string {
  const inner = b === -1 ? `(-(x-(${h})))` : `(x-(${h}))`;
  const body: Record<FunctionParent, string> = {
    linear: inner,
    quadratic: `${inner}^2`,
    cubic: `${inner}^3`,
    abs: `abs${inner}`,
    sqrt: `sqrt${inner}`,
    exp2: `2^${inner}`,
    log2: `log_2${inner}`,
    reciprocal: `1/${inner}`,
  };
  return `(${k})+(${a})*${body[parent]}`;
}

/** Parse the generator's `polyTex` output back into coefficients (highest first). */
function parsePolyTex(text: string): number[] {
  const s = text.replace(/\s+/g, "");
  const terms = s.match(/[+-]?[^+-]+/g) ?? [];
  const byPower = new Map<number, number>();
  for (const term of terms) {
    const m = term.match(/^([+-]?)(\d*)(x(?:\^\{(\d+)\})?)?$/);
    if (!m) throw new Error(`cannot parse term ${term} in ${text}`);
    const sign = m[1] === "-" ? -1 : 1;
    const power = m[3] ? (m[4] ? Number(m[4]) : 1) : 0;
    const magnitude = m[2] === "" ? 1 : Number(m[2]);
    byPower.set(power, (byPower.get(power) ?? 0) + sign * magnitude);
  }
  const degree = Math.max(...byPower.keys());
  return Array.from({ length: degree + 1 }, (_, i) => byPower.get(degree - i) ?? 0);
}

const evalCoeffs = (c: number[], x: number) => c.reduce((acc, v) => acc * x + v, 0);
const polyString = (c: number[], v = "x") =>
  c.map((coef, i) => `(${coef})*${v}^${c.length - 1 - i}`).join("+");

/** Pull `name(x) = …` out of a stem span. */
function ruleIn(stem: string, name: string): string {
  const m = stem.match(new RegExp(`\\\\\\(${name}\\(x\\) = (.*?)\\\\\\)`));
  if (!m) throw new Error(`no ${name}(x) in ${stem}`);
  return m[1];
}

/** LaTeX (the subset these stems use) → answer grammar. */
function texToAns(t: string): string {
  return t
    .replace(/\\frac\{([^{}]*)\}\{([^{}]*)\}/g, "($1)/($2)")
    .replace(/\\sqrt\[3\]\{([^{}]*)\}/g, "∛($1)")
    .replace(/\\sqrt\{([^{}]*)\}/g, "sqrt($1)")
    .replace(/\^\{([^{}]*)\}/g, "^($1)")
    .replace(/\\lvert/g, "|")
    .replace(/\\rvert/g, "|")
    .replace(/\\cdot/g, "*")
    .replace(/\s+/g, "");
}

const FORBIDDEN = [/undefined/, /NaN/, /--/, /\+ -/, /(^|[^0-9.])1x/, /x\^\{?1(?![0-9])/];

// Every suite runs twice: as served, and with every retry exhausted so each
// fallback is served and re-derived like any other draw.
describe.each([false, true])("algebra-2 functions templates (every retry exhausted: %s)", (forced) => {
  beforeAll(() => {
    if (forced) FUNCTIONS_DRAW.attempts = 0;
  });
  afterAll(() => {
    FUNCTIONS_DRAW.attempts = 20;
  });

  test("every typed answer can be entered on the pad it is served with", () => {
    for (const key of KEYS) {
      for (const seed of SEEDS) {
        const it = generateItem(key, seed)!;
        expect(untypableAnswer(it), `${key}#${seed} on ${it.answerPalette ?? it.answerType}: ${it.stem}`).toBeNull();
      }
    }
  });

  test("every node has one reproducible template", () => {
    for (const key of KEYS) {
      expect(hasTemplate(key), key).toBe(true);
      for (let seed = 1; seed <= 30; seed++) expect(generateItem(key, seed)).toEqual(generateItem(key, seed));
    }
  });

  test("every family produces at least 12 distinct items", () => {
    for (const key of KEYS) {
      const signatures = new Set<string>();
      for (let seed = 1; seed <= 80; seed++) {
        const it = item(key, seed);
        signatures.add([it.stem, JSON.stringify(it.choices ?? null), JSON.stringify(it.promptVisual ?? null), formatAnswer(it.answer)].join("¦"));
      }
      // A forced fallback is one fixed draw; variety belongs to normal draws.
      if (!forced) expect(signatures.size, key).toBeGreaterThanOrEqual(12);
    }
  });

  test("canonical answers grade correct; stems are clean; worked steps are 2–5 and end on the answer", () => {
    for (const key of KEYS) {
      for (const seed of SEEDS) {
        const it = item(key, seed);
        expect(grade(key, seed, submission(it)), `${key}#${seed}: ${it.stem}`).toBe(true);
        for (const text of [it.stem, ...(it.choices ?? [])]) {
          for (const bad of FORBIDDEN) expect(text, `${key}#${seed}`).not.toMatch(bad);
        }
        const steps = it.workedSteps ?? [];
        expect(steps.length, `${key}#${seed}`).toBeGreaterThanOrEqual(2);
        expect(steps.length, `${key}#${seed}`).toBeLessThanOrEqual(5);
        for (const s of steps) expect(s.blankText, `${key}#${seed}`).toBeTruthy();
        if (it.answerType !== "expression") continue;
        // No functions-strand family asks for a typed logarithm (the strand opens
        // before logs), so every typed rule is on the plain algebra pad.
        expect(it.answerPalette, `${key}#${seed}`).toBe("algebra");
        expect(formatAnswer(it.answer), `${key}#${seed}`).not.toMatch(/log/);
      }
    }
  });

  test("multiple choice: 3–4 distinct options, exactly one of them the answer", () => {
    for (const key of MC_KEYS) {
      for (const seed of SEEDS) {
        const it = item(key, seed);
        if (it.answerType !== "multipleChoice") {
          // fn_domain_range_graph also has typed draws (one bound).
          expect([key, it.answerType, it.choices]).toEqual(["fn_domain_range_graph", "integer", undefined]);
          continue;
        }
        const choices = it.choices ?? [];
        expect(choices.length).toBeGreaterThanOrEqual(3);
        expect(choices.length).toBeLessThanOrEqual(4);
        expect(new Set(choices).size).toBe(choices.length);
        const right = choices.filter((_, i) => grade(key, seed, String(i)));
        expect(right, `${key}#${seed}`).toHaveLength(1);
      }
    }
  });

  test("fn_domain_range_graph: the right statement, found by sampling the plotted curve", () => {
    let typed = 0;
    const st = (v: string, rel: string, n: number) => `\\(${v} ${rel} ${n}\\)`;
    let stopped = 0;
    const norm = (text: string) => text.replace(/\s+/g, " ");
    /** "\(x \ge 3\)" or "\(-1 < y \le 4\)" → a membership test. */
    const statementTest = (label: string): ((v: number) => boolean) => {
      const L = norm(label);
      const cmp = (rel: string, a: number, b: number) =>
        rel === "<" ? a < b : rel === "\\le" ? a <= b : rel === ">" ? a > b : rel === "\\ge" ? a >= b : a !== b;
      const two = L.match(/^\\\((-?\d+) (<|\\le) [xy] (<|\\le) (-?\d+)\\\)$/);
      if (two) return (v) => cmp(two[2], Number(two[1]), v) && cmp(two[3], v, Number(two[4]));
      const one = L.match(/^\\\([xy] (<|\\le|>|\\ge|\\ne) (-?\d+)\\\)$/);
      if (one) return (v) => cmp(one[1], v, Number(one[2]));
      if (L === "All real numbers") return () => true;
      throw new Error(label);
    };
    for (const seed of SEEDS) {
      const it = item("fn_domain_range_graph", seed);
      const t = curve(it, 0);
      const f = (x: number) => transformValue(t.parent, t, x);
      const plotted = plot(it).curves[0];
      if (plotted.domain) {
        // A line that stops at dots: membership read from the domain and the
        // dots (hollow = left out), never from the generator's statements.
        stopped++;
        const { from, to } = plotted.domain;
        const dot = (x: number) => (plot(it).points ?? []).find((p) => p.x === x);
        const inDomain = (x: number) =>
          (from === undefined || x > from || (x === from && !dot(from)?.open)) &&
          (to === undefined || x < to || (x === to && !dot(to)?.open));
        const truth = it.stem.includes("domain") ? inDomain : (y: number) => inDomain((y - t.k) / t.a);
        const vs = Array.from({ length: 161 }, (_, i) => -20 + i * 0.25);
        const fits = (it.choices ?? []).filter((label) => vs.every((v) => statementTest(label)(v) === truth(v)));
        expect(fits, `#${seed}`).toHaveLength(1);
        expect(grade("fn_domain_range_graph", seed, String((it.choices ?? []).indexOf(fits[0])))).toBe(true);
        continue;
      }
      // A fine grid, the integers, and a few huge inputs so slow growth (√x, log x) shows.
      const xs = [
        ...Array.from({ length: 41 }, (_, i) => i - 20),
        ...Array.from({ length: 4001 }, (_, i) => -20 + i * 0.01),
        1e3,
        1e6,
        1e30,
        // Right beside the plotted vertical line, where 1/x and log x blow up.
        t.h + 1e-30,
        t.h - 1e-12,
        t.h + 1e-12,
      ];
      let expected: string;
      if (it.stem.includes("domain")) {
        const bad = xs.filter((x) => Number.isNaN(f(x)));
        if (bad.length === 0) expected = "All real numbers";
        else if (bad.every((x) => Math.abs(x - bad[0]) < 1e-6)) expected = st("x", "\\ne", Math.round(bad[0]));
        else {
          // Undefined on the left of an edge: is the edge itself defined?
          const edge = Math.round(Math.max(...bad));
          expected = Number.isFinite(f(edge)) ? st("x", "\\ge", edge) : st("x", ">", edge);
        }
      } else {
        const ys = xs.map(f).filter(Number.isFinite);
        const lo = Math.min(...ys);
        const hi = Math.max(...ys);
        const level = Math.round(lo > -30 ? lo : hi);
        const attained = ys.some((y) => Math.abs(y - level) < 1e-9);
        if (lo > -30 && hi > 30) expected = st("y", attained ? "\\ge" : ">", level);
        else if (hi < 30 && lo < -30) expected = st("y", attained ? "\\le" : "<", level);
        // Unbounded both ways: is the one level the asymptote never reaches missed?
        // (Huge inputs are left out here: 2/1e30 + 2 rounds to exactly 2.)
        else if (!xs.some((x) => Math.abs(x) < 1e7 && f(x) === t.k)) expected = st("y", "\\ne", t.k);
        else expected = "All real numbers";
      }
      if (it.answerType === "integer") {
        typed++;
        // The stem states the relation; the typed number completes the statement.
        const shown = it.stem.match(/\\\(([xy]) (\\ge|>|\\le|<) \?\\\)|except \\\(([xy]) = \?\\\)/);
        if (!shown) throw new Error(it.stem);
        const typedStatement = shown[1] ? `\\(${shown[1]} ${shown[2]} ${numericValue(it.answer)}\\)` : `\\(${shown[3]} \\ne ${numericValue(it.answer)}\\)`;
        expect(norm(typedStatement), `#${seed}`).toBe(norm(expected));
        // The domain/range swap: typing the other coordinate of the key point.
        const other = it.stem.includes("range") ? t.h : t.k;
        if (other !== numericValue(it.answer)) expect(grade("fn_domain_range_graph", seed, String(other))).toBe(false);
        continue;
      }
      const it2 = (it.choices ?? []).map(norm);
      expect(grade("fn_domain_range_graph", seed, String(it2.indexOf(norm(expected)))), `#${seed} ${t.parent} ${JSON.stringify(t)} expected ${expected} in ${JSON.stringify(it2)}`).toBe(true);
    }
    expect(typed).toBeGreaterThan(30);
    expect(stopped).toBeGreaterThan(30);
  });

  test("fn_avg_rate_of_change: (f(b) − f(a))/(b − a) from the graph or the rule", () => {
    for (const seed of SEEDS) {
      const it = item("fn_avg_rate_of_change", seed);
      const [x1, x2] = [...it.stem.matchAll(/x = (-?\d+)/g)].map((m) => Number(m[1]));
      let f: (x: number) => number;
      if (it.promptVisual) {
        const t = curve(it, 0);
        f = (x) => transformValue(t.parent, t, x);
        // The heights are on the grid, so they can be read.
        expect(Number.isInteger(f(x1)) && Number.isInteger(f(x2)), `#${seed}`).toBe(true);
        expect(plot(it).shadeX).toEqual({ from: x1, to: x2 });
      } else {
        const rule = ruleIn(it.stem, "f");
        f = rule === "2^{x}" ? (x) => 2 ** x : (x) => evalCoeffs(parsePolyTex(rule), x);
      }
      expect(numericValue(it.answer)).toBeCloseTo((f(x2) - f(x1)) / (x2 - x1), 9);
      const value = numericValue(it.answer);
      // Wrong: the change in f alone; the reciprocal (Δx/Δy); the sign slip.
      expect(grade("fn_avg_rate_of_change", seed, String(f(x2) - f(x1)))).toBe(f(x2) - f(x1) === value);
      if (value !== 0) expect(grade("fn_avg_rate_of_change", seed, String(-value))).toBe(false);
      // Equivalent: unreduced fraction, and a decimal-free equal fraction.
      expect(grade("fn_avg_rate_of_change", seed, `${(f(x2) - f(x1)) * 2}/${(x2 - x1) * 2}`)).toBe(true);
    }
  });

  test("fn_parent_families: the option is the plotted curve's parent", () => {
    const rule: Record<FunctionParent, string> = {
      linear: "y = x",
      quadratic: "y = x^{2}",
      cubic: "y = x^{3}",
      abs: "y = \\lvert x\\rvert",
      sqrt: "y = \\sqrt{x}",
      exp2: "y = 2^{x}",
      log2: "y = \\log_{2}(x)",
      reciprocal: "y = \\frac{1}{x}",
    };
    for (const seed of SEEDS) {
      const it = item("fn_parent_families", seed);
      const t = curve(it, 0);
      const expected = `\\(${rule[t.parent]}\\)`;
      expect(it.choices?.[it.answer.type === "multipleChoice" ? it.answer.choiceIndex : -1], `#${seed}`).toBe(expected);
      if (it.stem.includes("moved")) expect(t.h !== 0 || t.k !== 0 || t.a !== 1).toBe(true);
    }
  });

  test("transformation families: the answer matches the plotted g; the shift-sign and reflection slips are wrong", () => {
    const keys = ["fn_transform_translate", "fn_transform_scale_reflect", "fn_transform_combined"];
    let leftShifts = 0;
    let mirrored = 0;
    let upsideDown = 0;
    for (const key of keys) {
      for (const seed of SEEDS) {
        const it = item(key, seed);
        const answer = formatAnswer(it.answer);
        const curves = plot(it).curves;
        const g0 = curve(it, curves.length - 1);
        if (g0.b === -1) mirrored++;
        else if (g0.a < 0 && ["sqrt", "exp2", "log2"].includes(g0.parent)) upsideDown++;
        if (it.answerType === "multipleChoice") {
          // −f(x), f(−x) or −f(−x), chosen from the plotted g's own a and b.
          const label = `\\(g(x) = ${g0.a < 0 ? "-" : ""}f(${g0.b === -1 ? "-x" : "x"})\\)`;
          expect(it.choices?.[(it.answer as { choiceIndex: number }).choiceIndex], `${key}#${seed}`).toBe(label);
          continue;
        }
        expect(curves).toHaveLength(2);
        const f = curve(it, 0);
        const g = curve(it, 1);
        expect([f.a, f.h, f.k], `${key}#${seed}: f is the parent`).toEqual([1, 0, 0]);
        if (key === "fn_transform_translate") expect(g.a).toBe(1);
        if (key === "fn_transform_scale_reflect") expect([g.h, g.k]).toEqual([0, 0]);
        if (g.h < 0) leftShifts++;
        if (it.stem.includes("?")) {
          // Missing number: which slot is blank decides the expected value.
          const blankTex = it.stem.slice(it.stem.lastIndexOf("\\("));
          const expected = blankTex.includes("x - ?") ? g.h : blankTex.includes("+ ?") ? g.k : g.a;
          expect(eval1(answer), `${key}#${seed}`).toBeCloseTo(expected, 9);
          expect(grade(key, seed, String(expected + 1))).toBe(false);
          if (expected !== 0) expect(grade(key, seed, String(-expected))).toBe(false);
          continue;
        }
        expect(grade(key, seed, looseRule(g)), `${key}#${seed}: ${answer} vs ${looseRule(g)}`).toBe(true);
        // Equivalent rewrites: the canonical with its terms reversed, and √ for sqrt.
        expect(grade(key, seed, answer.replace(/sqrt/g, "√"))).toBe(true);
        if (g.h !== 0) expect(grade(key, seed, looseRule({ ...g, h: -g.h })), `${key}#${seed} accepted the shift-sign slip`).toBe(false);
        expect(grade(key, seed, looseRule({ ...g, a: -g.a })), `${key}#${seed}`).toBe(false);
        // f(−x) read as −f(x): the mirror built as an upside-down flip.
        if (g.b === -1) expect(grade(key, seed, looseRule({ ...g, b: undefined, a: -g.a })), `${key}#${seed}`).toBe(false);
        if (g.parent === "quadratic") {
          // Expanded form is the same function.
          const c = [g.a, -2 * g.a * g.h, g.a * g.h * g.h + g.k];
          expect(grade(key, seed, polyString(c))).toBe(true);
        }
      }
    }
    expect(leftShifts).toBeGreaterThan(50);
    expect(mirrored).toBeGreaterThan(20);
    expect(upsideDown).toBeGreaterThan(20);
  });

  test("fn_piecewise_evaluate: pick the piece from the conditions, then evaluate", () => {
    let boundary = 0;
    let graphed = 0;
    for (const seed of SEEDS) {
      const it = item("fn_piecewise_evaluate", seed);
      if (it.promptVisual) {
        // Read at the join: the FILLED dot is f(c); the hollow one is the trap.
        graphed++;
        const c = Number(it.stem.match(/f\((-?\d+)\)/)?.[1]);
        const dots = (plot(it).points ?? []).filter((p) => p.x === c);
        expect(dots).toHaveLength(2);
        const filled = dots.filter((p) => !p.open);
        expect(filled, `#${seed}`).toHaveLength(1);
        expect(numericValue(it.answer)).toBe(filled[0].y);
        const hollow = dots.find((p) => p.open);
        expect(grade("fn_piecewise_evaluate", seed, String(hollow?.y))).toBe(false);
        // The two pieces really do meet the dots.
        for (const curveSpec of plot(it).curves) {
          if (curveSpec.form !== "transform") throw new Error("expected lines");
          const end = curveSpec.domain?.to ?? curveSpec.domain?.from;
          expect(end).toBe(c);
          expect(dots.some((p) => p.y === curveSpec.a * c + curveSpec.k)).toBe(true);
        }
        continue;
      }
      const x = Number(it.stem.match(/Find \\\(f\((-?\d+)\)\\\)/)?.[1]);
      const body = it.stem.match(/\\begin\{cases\} (.*) \\end\{cases\}/)?.[1] ?? "";
      const rows = body.split(" \\\\ ").map((row) => row.split(" & "));
      const holds = (cond: string) => {
        const two = cond.match(/^(-?\d+) \\le x \\le (-?\d+)$/);
        if (two) return Number(two[1]) <= x && x <= Number(two[2]);
        const m = cond.match(/^x (<|>|\\le|\\ge) (-?\d+)$/);
        if (!m) throw new Error(cond);
        const c = Number(m[2]);
        if (c === x) boundary++;
        return m[1] === "<" ? x < c : m[1] === ">" ? x > c : m[1] === "\\le" ? x <= c : x >= c;
      };
      const matching = rows.filter(([, cond]) => holds(cond));
      expect(matching, `#${seed}`).toHaveLength(1);
      const value = evalCoeffs(parsePolyTex(matching[0][0]), x);
      expect(numericValue(it.answer)).toBe(value);
      // The other pieces at x are wrong answers (when they differ).
      for (const [p] of rows) {
        const other = evalCoeffs(parsePolyTex(p), x);
        if (other !== value) expect(grade("fn_piecewise_evaluate", seed, String(other))).toBe(false);
      }
      expect(grade("fn_piecewise_evaluate", seed, String(value + 1))).toBe(false);
    }
    expect(boundary).toBeGreaterThan(30);
    expect(graphed).toBeGreaterThan(30);
  });

  test("fn_compose: evaluated or written compositions agree with substitution; unexpanded answers get the form nudge", () => {
    let written = 0;
    let gOfF = 0;
    for (const seed of SEEDS) {
      const it = item("fn_compose", seed);
      const fC = parsePolyTex(ruleIn(it.stem, "f"));
      const gC = parsePolyTex(ruleIn(it.stem, "g"));
      const m = it.stem.match(/\\\(([fg])\(([fg])\((-?\d+|x)\)\)\\\)/);
      if (!m) throw new Error(it.stem);
      const outer = m[1] === "f" ? fC : gC;
      const inner = m[2] === "f" ? fC : gC;
      if (m[1] === "g") gOfF++;
      const answer = formatAnswer(it.answer);
      if (m[3] !== "x") {
        const at = Number(m[3]);
        expect(eval1(answer)).toBe(evalCoeffs(outer, evalCoeffs(inner, at)));
        // Wrong: the other order; the inner value alone.
        const swapped = evalCoeffs(inner, evalCoeffs(outer, at));
        if (swapped !== eval1(answer)) expect(grade("fn_compose", seed, String(swapped))).toBe(false);
        expect(grade("fn_compose", seed, String(eval1(answer) + 1))).toBe(false);
        continue;
      }
      written++;
      expect(it.answerForm).toBe("expanded");
      const substituted = outer.map((c, i) => `(${c})*(${polyString(inner)})^${outer.length - 1 - i}`).join("+");
      expect(same(answer, substituted), `#${seed}: ${answer} vs ${substituted}`).toBe(true);
      // Equal but not multiplied out: equivalent, not in form (a nudge, not a miss).
      expect(meetsRequiredForm(substituted, answer, "expanded", "expression")).toBe(false);
      expect(meetsRequiredForm(answer, answer, "expanded", "expression")).toBe(true);
      // Wrong order is wrong (unless the two orders happen to agree).
      const other = inner.map((c, i) => `(${c})*(${polyString(outer)})^${inner.length - 1 - i}`).join("+");
      if (!same(other, answer)) expect(grade("fn_compose", seed, other)).toBe(false);
      // Equivalent and expanded: terms in reverse order.
      const reversed = answer.match(/[+-]?[^+-]+/g)?.reverse().join("+").replace(/\+-/g, "-").replace(/^\+/, "") ?? answer;
      expect(grade("fn_compose", seed, reversed), `#${seed}: ${reversed}`).toBe(true);
    }
    expect(written).toBeGreaterThan(60);
    expect(gOfF).toBeGreaterThan(60);
  });

  test("fn_inverse_find: f(f⁻¹(x)) = x, checked by the grader's own evaluator", () => {
    let rational = 0;
    let restricted = 0;
    for (const seed of SEEDS) {
      const it = item("fn_inverse_find", seed);
      const answer = formatAnswer(it.answer);
      const fAns = texToAns(ruleIn(it.stem, "f"));
      const composed = fAns.replace(/x/g, `(${answer})`);
      expect(same(composed, "x"), `#${seed}: f = ${fAns}, f⁻¹ = ${answer}`).toBe(true);
      // Wrong: the reciprocal 1/f(x) and the negation −f(x) (the f⁻¹ notation slips).
      expect(grade("fn_inverse_find", seed, `1/(${fAns})`)).toBe(false);
      expect(grade("fn_inverse_find", seed, `-(${fAns})`)).toBe(false);
      // Equivalent: bracketed, and multiplied by 1.
      expect(grade("fn_inverse_find", seed, `(${answer})`)).toBe(true);
      expect(grade("fn_inverse_find", seed, `1*(${answer})+0`)).toBe(true);
      if (fAns.includes(")/(")) rational++;
      if (it.stem.includes("\\ge")) {
        restricted++;
        // The other square-root branch also undoes f, but not on x ≥ h.
        const other = answer.replace(/^sqrt/, "-sqrt");
        expect(grade("fn_inverse_find", seed, other), `#${seed}: ${other}`).toBe(false);
      }
    }
    expect(rational).toBeGreaterThan(15);
    expect(restricted).toBeGreaterThan(15);
  });

  test("fn_inverse_graph: swapped points, f⁻¹(c) read from the graph, and the turning point", () => {
    const tiers = { point: 0, read: 0, restrict: 0 };
    for (const seed of SEEDS) {
      const it = item("fn_inverse_graph", seed);
      const value = numericValue(it.answer);
      const t = curve(it, 0);
      const f = (x: number) => transformValue(t.parent, t, x);
      if (it.stem.includes("Read the point")) {
        tiers.point++;
        // (input, f(input)) on f is (f(input), input) on f⁻¹.
        const input = Number(it.stem.match(/\(\?, (-?\d+)\)/)?.[1]);
        expect(value, `#${seed}`).toBe(f(input));
        expect(plot(it).referenceLine).toBe("y=x");
        expect(grade("fn_inverse_graph", seed, String(input))).toBe(false);
        continue;
      }
      const c = it.stem.match(/f⁻¹\((-?\d+)\)/);
      if (c) {
        tiers.read++;
        const target = Number(c[1]);
        expect(f(value), `#${seed}`).toBeCloseTo(target, 9);
        // The classic slip, f(c), is a different number.
        if (Number.isFinite(f(target))) expect(f(target), `#${seed} ${JSON.stringify(t)} c=${target}`).not.toBeCloseTo(value, 9);
        const w = plot(it);
        expect(value >= w.xMin && value <= w.xMax && target >= w.yMin && target <= w.yMax).toBe(true);
        continue;
      }
      tiers.restrict++;
      // The turning point is where the graph changes direction.
      const xs = Array.from({ length: 401 }, (_, i) => -10 + i * 0.05);
      const turn = xs.reduce((best, x) => (t.a * f(x) < t.a * f(best) ? x : best), xs[0]);
      expect(value).toBeCloseTo(turn, 6);
      expect(grade("fn_inverse_graph", seed, String(value + 1))).toBe(false);
      expect(grade("fn_inverse_graph", seed, String(t.k))).toBe(t.k === value);
    }
    expect(Math.min(tiers.point, tiers.read, tiers.restrict)).toBeGreaterThan(40);
  });
});

/** Evaluate a numeric answer string (an integer or a/b). */
function eval1(raw: string): number {
  const m = raw.match(/^(-?\d+)\/(\d+)$/);
  return m ? Number(m[1]) / Number(m[2]) : Number(raw);
}
