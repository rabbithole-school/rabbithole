import { describe, expect, test } from "vitest";
import {
  answersEqual,
  formatAnswer,
  meetsRequiredForm,
  numericValue,
  parseAnswer,
} from "../lib/practice/answers";
import { untypableAnswer } from "./algebra2TestMath";
import { gradeTemplateItem, makeItemId } from "../lib/practice/session";
import { generateItem, hasTemplate, type PracticeItem } from "../lib/practice/templates";
import type { FunctionPlotPromptVisual } from "../../shared/practicePromptVisual";
import { polynomialValue, rationalValue, transformValue, type CurveZero } from "../../shared/functionCurves";

/**
 * The graph-dependent nodes of the other strands (graphNodes.ts). As in the
 * functions test, answers are re-derived from what the scholar is shown — the
 * plotted curve, the marked point, the stem's rule — and graded by the real
 * grader.
 */

const KEYS = [
  "cx_plane_plot",
  "quad_inequality",
  "log_graph_inverse",
  "poly_end_behavior",
  "poly_sketch_factored",
  "rat_graph_asymptotes",
];
const MC_KEYS = ["quad_inequality", "poly_end_behavior", "poly_sketch_factored"];
const SEEDS = Array.from({ length: 220 }, (_, i) => i + 1);
const FORBIDDEN = [/undefined/, /NaN/, /--/, /\+ -/, /(^|[^0-9.])1x/, /x\^\{?1(?![0-9])/];

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

function same(a: string, b: string): boolean {
  const pa = parseAnswer(a, "expression");
  const pb = parseAnswer(b, "expression");
  return pa !== null && pb !== null && answersEqual(pa, pb);
}

function plot(it: PracticeItem): FunctionPlotPromptVisual {
  const v = it.promptVisual;
  if (!v || v.kind !== "functionPlot") throw new Error(`expected a functionPlot: ${it.stem}`);
  return v;
}

function correctChoice(it: PracticeItem): string {
  if (it.answer.type !== "multipleChoice") throw new Error("not MC");
  return (it.choices ?? [])[it.answer.choiceIndex];
}

/** Parse polyTex output back to coefficients, highest power first. */
function parsePolyTex(text: string): number[] {
  const s = text.replace(/\s+/g, "");
  const terms = s.match(/[+-]?[^+-]+/g) ?? [];
  const byPower = new Map<number, number>();
  for (const term of terms) {
    const m = term.match(/^([+-]?)(\d*)(x(?:\^\{(\d+)\})?)?$/);
    if (!m) throw new Error(`cannot parse term ${term} in ${text}`);
    const power = m[3] ? (m[4] ? Number(m[4]) : 1) : 0;
    byPower.set(power, (byPower.get(power) ?? 0) + (m[1] === "-" ? -1 : 1) * (m[2] === "" ? 1 : Number(m[2])));
  }
  const degree = Math.max(...byPower.keys());
  return Array.from({ length: degree + 1 }, (_, i) => byPower.get(degree - i) ?? 0);
}
const evalCoeffs = (c: number[], x: number) => c.reduce((acc, v) => acc * x + v, 0);

/** Parse a factored rule `L(x+3)^{2}x(x-1)` into a leading number and zeros. */
function parseFactored(text: string): { leading: number; zeros: CurveZero[] } {
  const s = text.replace(/\s+/g, "");
  const firstFactor = s.search(/[(x]/);
  const lead = s.slice(0, firstFactor);
  const frac = lead.match(/^(-?)\\frac\{(\d+)\}\{(\d+)\}$/);
  const leading =
    lead === "" ? 1 : lead === "-" ? -1 : frac ? (frac[1] ? -1 : 1) * (Number(frac[2]) / Number(frac[3])) : Number(lead);
  const zeros: CurveZero[] = [];
  for (const m of s.slice(firstFactor).matchAll(/(?:\(x([+-]\d+)\)|x)(?:\^\{(\d+)\})?/g)) {
    zeros.push({ x: m[1] ? -Number(m[1]) : 0, multiplicity: m[2] ? Number(m[2]) : 1 });
  }
  return { leading, zeros };
}

/** The two brace-balanced arguments of the first \\frac in a string. */
function fracArgs(text: string): [string, string, string] {
  const start = text.indexOf("\\frac{");
  if (start < 0) throw new Error(text);
  const args: string[] = [];
  let i = start + 5;
  for (let n = 0; n < 2; n++) {
    let depth = 0;
    let j = i;
    for (; j < text.length; j++) {
      if (text[j] === "{") depth++;
      else if (text[j] === "}" && --depth === 0) break;
    }
    args.push(text.slice(i + 1, j));
    i = j + 1;
  }
  return [text, args[0], args[1]];
}

describe("algebra-2 graph-dependent templates", () => {
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
      expect(signatures.size, key).toBeGreaterThanOrEqual(12);
    }
  });

  test("canonical answers grade correct; stems and options are clean; worked steps present", () => {
    for (const key of KEYS) {
      for (const seed of SEEDS) {
        const it = item(key, seed);
        expect(grade(key, seed, submission(it)), `${key}#${seed}: ${it.stem}`).toBe(true);
        for (const text of [it.stem, ...(it.choices ?? [])]) {
          for (const bad of FORBIDDEN) expect(text, `${key}#${seed}: ${text}`).not.toMatch(bad);
        }
        expect((it.workedSteps ?? []).length, `${key}#${seed}`).toBeGreaterThanOrEqual(2);
        expect((it.workedSteps ?? []).length, `${key}#${seed}`).toBeLessThanOrEqual(5);
      }
    }
  });

  test("multiple choice: 3–4 distinct options, exactly one correct", () => {
    for (const key of MC_KEYS) {
      for (const seed of SEEDS) {
        const it = item(key, seed);
        if (it.answerType !== "multipleChoice") {
          // quad_inequality and poly_sketch_factored also have typed integer draws.
          expect(key === "quad_inequality" || key === "poly_sketch_factored", `${key}#${seed}`).toBe(true);
          expect([it.answerType, it.choices, it.answerForm]).toEqual(["integer", undefined, undefined]);
          continue;
        }
        const choices = it.choices ?? [];
        expect(choices.length).toBeGreaterThanOrEqual(3);
        expect(choices.length).toBeLessThanOrEqual(4);
        expect(new Set(choices).size).toBe(choices.length);
        expect(choices.filter((_, i) => grade(key, seed, String(i))), `${key}#${seed}`).toHaveLength(1);
      }
    }
  });

  test("cx_plane_plot: the asked point's coordinates are its real and imaginary parts", () => {
    let decoys = 0;
    let onAxis = 0;
    for (const seed of SEEDS) {
      const it = item("cx_plane_plot", seed);
      const v = it.promptVisual;
      if (!v || v.kind !== "coordinatePlane") throw new Error("expected a coordinate plane");
      expect(v.axisLabels).toEqual({ x: "Re", y: "Im" });
      const name = it.stem.match(/the point (\w)/)?.[1];
      const point = v.points.find((p) => p.label === name);
      if (!point) throw new Error(it.stem);
      if (v.points.length > 1) decoys++;
      if (point.x === 0 || point.y === 0) onAxis++;
      const answer = formatAnswer(it.answer);
      expect(it.answerPalette).toBe("complex");
      expect(it.answerForm).toBe("complexStandard");
      // Equivalent: the parts written the other way round, with explicit products.
      expect(grade("cx_plane_plot", seed, `(${point.y})*i+(${point.x})`), `#${seed} ${answer}`).toBe(true);
      expect(grade("cx_plane_plot", seed, `${point.x}+${point.y}i`.replace("+-", "-"))).toBe(true);
      // Wrong: the coordinates swapped; the conjugate.
      if (point.x !== point.y) expect(grade("cx_plane_plot", seed, `${point.y}+(${point.x})i`)).toBe(false);
      if (point.y !== 0) expect(grade("cx_plane_plot", seed, `${point.x}-(${point.y})i`)).toBe(false);
      // An unfinished form (i² left in) is equal but not a + bi.
      if (point.y !== 0) expect(meetsRequiredForm(`${point.x}-(${point.y})i^2*i`, answer, "complexStandard", "expression")).toBe(false);
    }
    expect(decoys).toBeGreaterThan(10);
    expect(onAxis).toBeGreaterThan(10);
  });

  test("quad_inequality: the chosen description is exactly where the quadratic has the asked sign", () => {
    const predicate = (raw: string): ((x: number) => boolean) => {
      const label = raw.replace(/\s+/g, " ");
      const between = label.match(/^\\\((-?\d+) (<|\\le) x\\\) and \\\(x (<|\\le) (-?\d+)\\\)$/);
      if (between) {
        const [lo, hi] = [Number(between[1]), Number(between[4])];
        return (x) => (between[2] === "<" ? lo < x : lo <= x) && (between[3] === "<" ? x < hi : x <= hi);
      }
      const outside = label.match(/^\\\(x (<|\\le) (-?\d+)\\\) or \\\(x (>|\\ge) (-?\d+)\\\)$/);
      if (!outside) throw new Error(label);
      const [lo, hi] = [Number(outside[2]), Number(outside[4])];
      return (x) => (outside[1] === "<" ? x < lo : x <= lo) || (outside[3] === ">" ? x > hi : x >= hi);
    };
    const holds = (rel: string, y: number) =>
      rel === "<" ? y < 0 : rel === "\\le" ? y <= 0 : rel === ">" ? y > 0 : y >= 0;
    const xs = Array.from({ length: 81 }, (_, i) => -10 + i * 0.25);
    let reverse = 0;
    let between = 0;
    let outside = 0;
    let typedCount = 0;
    let typedLargest = 0;
    for (const seed of SEEDS) {
      const it = item("quad_inequality", seed);
      const matches = (sign: (x: number) => boolean, label: string) => xs.every((x) => predicate(label)(x) === sign(x));
      if (it.answerType === "integer") {
        // Count (or find) integers straight from the inequality, over a wide range.
        const m = it.stem.match(/\\\((.*) (<|\\le|>|\\ge) 0\\\)\?$/);
        if (!m) throw new Error(it.stem);
        const c = parsePolyTex(m[1]);
        const ints = Array.from({ length: 61 }, (_, i) => i - 30);
        const solves = (x: number) => holds(m[2], evalCoeffs(c, x));
        const value = numericValue(it.answer);
        if (it.stem.startsWith("How many")) {
          typedCount++;
          expect(value, `#${seed}`).toBe(ints.filter(solves).length);
          // The slip of counting the roots in (or out) wrongly is a different number.
          expect(grade("quad_inequality", seed, String(value + 2))).toBe(false);
        } else {
          typedLargest++;
          const outside = ints.filter((x) => !solves(x));
          expect(outside.length).toBeGreaterThan(0);
          expect(value, `#${seed}`).toBe(Math.max(...outside));
          expect(grade("quad_inequality", seed, String(value + 1))).toBe(false);
          expect(grade("quad_inequality", seed, String(value - 1))).toBe(false);
        }
        continue;
      }
      if (it.promptVisual?.kind === "numberLine") {
        reverse++;
        const iv = it.promptVisual.interval;
        if (!iv) throw new Error("no interval");
        const shown = (x: number) =>
          (iv.includeFrom ? x >= iv.from : x > iv.from) && (iv.includeTo ? x <= iv.to : x < iv.to);
        const fits = (it.choices ?? []).filter((label) => {
          const m = label.replace(/\s+/g, " ").match(/^\\\((.*) (<|\\le|>|\\ge) 0\\\)$/);
          if (!m) throw new Error(label);
          const c = parsePolyTex(m[1]);
          return xs.every((x) => holds(m[2], evalCoeffs(c, x)) === shown(x));
        });
        expect(fits, `#${seed}`).toEqual([correctChoice(it)]);
        continue;
      }
      let f: (x: number) => number;
      let rel: string;
      if (it.promptVisual) {
        const c = plot(it).curves[0];
        if (c.form !== "polynomial") throw new Error("expected a polynomial curve");
        f = (x) => polynomialValue(c.zeros, c.leading, x);
        rel = it.stem.match(/ (<|\\le|>|\\ge) 0\\\)\.$/)?.[1] ?? "";
      } else {
        const m = it.stem.match(/^Solve \\\((.*) (<|\\le|>|\\ge) 0\\\)\.$/);
        if (!m) throw new Error(it.stem);
        const coefficients = parsePolyTex(m[1]);
        f = (x) => evalCoeffs(coefficients, x);
        rel = m[2];
      }
      const sign = (x: number) => holds(rel, f(x));
      expect(matches(sign, correctChoice(it)), `#${seed}: ${it.stem} → ${correctChoice(it)}`).toBe(true);
      for (const label of it.choices ?? []) if (label !== correctChoice(it)) expect(matches(sign, label)).toBe(false);
      if (correctChoice(it).includes(" or ")) outside++;
      else between++;
    }
    expect(Math.min(reverse, between, outside)).toBeGreaterThan(20);
    expect(Math.min(typedCount, typedLargest)).toBeGreaterThan(10);
  });

  test("log_graph_inverse: swapped points, the asymptote and intercept of the plotted log, and true inverses", () => {
    const tiers = { swap: 0, read: 0, inverse: 0 };
    for (const seed of SEEDS) {
      const it = item("log_graph_inverse", seed);
      expect(it.answerPalette).toBe("logs");
      const answer = formatAnswer(it.answer);
      if (it.stem.includes("is the reflection of")) {
        tiers.swap++;
        // (value, ?) on log_b: the missing number is log_b(value).
        const base = Number(it.stem.match(/y = (\d+)\^\{x\}/)?.[1]);
        const shown = it.stem.match(/\\\(\((\\frac\{1\}\{(\d+)\}|\d+), \?\)\\\)/);
        if (!shown) throw new Error(it.stem);
        const value = shown[2] ? 1 / Number(shown[2]) : Number(shown[1]);
        expect(Number(answer)).toBeCloseTo(Math.log(value) / Math.log(base), 9);
        expect(grade("log_graph_inverse", seed, `log_${base}(${value})`)).toBe(true);
        expect(grade("log_graph_inverse", seed, String(base))).toBe(Number(answer) === base);
        if (it.promptVisual) expect(plot(it).referenceLine).toBe("y=x");
        continue;
      }
      const c = plot(it).curves[0];
      if (c.form !== "transform") throw new Error("expected a transform curve");
      if (it.stem.includes("inverse")) {
        tiers.inverse++;
        // f(f⁻¹(x)) = x through the grader's evaluator, f written from the plotted curve.
        const f =
          c.parent === "exp2" ? (x: string) => `2^((${x})-(${c.h}))+(${c.k})` : (x: string) => `log_2((${x})-(${c.h}))+(${c.k})`;
        expect(same(f(answer), "x"), `#${seed}: ${answer}`).toBe(true);
        // Wrong: the reflection across the x-axis, and the reciprocal.
        expect(grade("log_graph_inverse", seed, `-(${f("x")})`)).toBe(false);
        expect(grade("log_graph_inverse", seed, `1/(${f("x")})`)).toBe(false);
        expect(grade("log_graph_inverse", seed, answer.replace("log_2", "log_(2)"))).toBe(true);
        continue;
      }
      tiers.read++;
      expect(c.parent).toBe("log2");
      const value = Number(answer);
      if (it.stem.includes("asymptote")) {
        expect(Number.isNaN(transformValue("log2", c, value))).toBe(true);
        expect(Number.isFinite(transformValue("log2", c, value + 1e-9))).toBe(true);
      } else {
        expect(transformValue("log2", c, value)).toBeCloseTo(0, 9);
      }
      expect(grade("log_graph_inverse", seed, String(-value))).toBe(value === 0);
    }
    expect(Math.min(tiers.swap, tiers.read, tiers.inverse)).toBeGreaterThan(40);
  });

  test("poly_end_behavior: the chosen ends are where the polynomial actually goes", () => {
    const words = (left: number, right: number) =>
      left > 0 ? (right > 0 ? "Up on both ends" : "Up on the left, down on the right") : right > 0 ? "Down on the left, up on the right" : "Down on both ends";
    let shuffledLeading = 0;
    for (const seed of SEEDS) {
      const it = item("poly_end_behavior", seed);
      if (it.promptVisual) {
        const c = plot(it).curves[0];
        if (c.form !== "polynomial") throw new Error("expected polynomial");
        const degree = c.zeros.reduce((s, z) => s + z.multiplicity, 0);
        const left = polynomialValue(c.zeros, c.leading, -1e3);
        const right = polynomialValue(c.zeros, c.leading, 1e3);
        // The graph's tails must leave the window, so the ends are visible.
        expect(Math.abs(left) > 7 && Math.abs(right) > 7).toBe(true);
        expect(correctChoice(it)).toBe(`${degree % 2 === 0 ? "Even" : "Odd"} degree, ${right > 0 ? "positive" : "negative"} leading coefficient`);
        expect(Math.sign(left) === Math.sign(right)).toBe(degree % 2 === 0);
        continue;
      }
      const rule = it.stem.match(/y = (.*)\\\)\.$/)?.[1] ?? "";
      // polyTex output never has a bracket; a factored rule always does.
      const f = rule.includes("(")
        ? (() => {
            const { leading, zeros } = parseFactored(rule);
            return (x: number) => polynomialValue(zeros, leading, x);
          })()
        : (() => {
            const c = parsePolyTex(rule);
            if (!rule.replace(/\s/g, "").startsWith(`${c[0] < 0 ? "-" : ""}${Math.abs(c[0]) === 1 ? "" : Math.abs(c[0])}x^{${c.length - 1}}`)) shuffledLeading++;
            return (x: number) => evalCoeffs(c, x);
          })();
      expect(correctChoice(it), `#${seed}: ${rule}`).toBe(words(f(-1e3), f(1e3)));
    }
    expect(shuffledLeading).toBeGreaterThan(20);
  });

  test("poly_sketch_factored: exactly one option is the plotted polynomial", () => {
    let bounces = 0;
    let typedPowers = 0;
    for (const seed of SEEDS) {
      const it = item("poly_sketch_factored", seed);
      const c = plot(it).curves[0];
      if (c.form !== "polynomial") throw new Error("expected polynomial");
      if (it.answerType === "integer") {
        typedPowers++;
        const x = Number(it.stem.match(/x = (-?\d+)/)?.[1]);
        const zero = c.zeros.find((z) => z.x === x);
        expect(zero, `#${seed}`).toBeDefined();
        expect(numericValue(it.answer)).toBe(zero?.multiplicity);
        // A bounce read as a crossing (or the reverse) is wrong.
        expect(grade("poly_sketch_factored", seed, String(zero?.multiplicity === 1 ? 2 : 1))).toBe(false);
        continue;
      }
      if (c.zeros.some((z) => z.multiplicity % 2 === 0)) bounces++;
      const xs = [-4.5, -2.3, -0.7, 0.4, 1.9, 3.3, 5.1];
      const matching = (it.choices ?? []).filter((label) => {
        const { leading, zeros } = parseFactored(label.replace(/^\\\(y = /, "").replace(/\\\)$/, ""));
        return xs.every((x) => Math.abs(polynomialValue(zeros, leading, x) - polynomialValue(c.zeros, c.leading, x)) < 1e-9);
      });
      expect(matching, `#${seed}`).toEqual([correctChoice(it)]);
      // The zeros are inside the window, and the bumps between them fit.
      const v = plot(it);
      for (const z of c.zeros) expect(z.x > v.xMin && z.x < v.xMax).toBe(true);
    }
    expect(bounces).toBeGreaterThan(40);
    expect(typedPowers).toBeGreaterThan(40);
  });

  test("rat_graph_asymptotes: the typed number is where the rule blows up, or where it levels off", () => {
    let holes = 0;
    let holeItems = 0;
    let fractional = 0;
    for (const seed of SEEDS) {
      const it = item("rat_graph_asymptotes", seed);
      const value = numericValue(it.answer);
      if (!Number.isInteger(value)) fractional++;
      const frac = fracArgs(it.stem);
      const top = frac[1].match(/^(-?\d*)\((.*)\)$/);
      const scale = top ? (top[1] === "-" ? -1 : top[1] === "" ? 1 : Number(top[1])) : 1;
      const n = top ? parsePolyTex(top[2]).map((c) => c * scale) : parsePolyTex(frac[1]);
      const d = parsePolyTex(frac[2]);
      const f = (x: number) => evalCoeffs(n, x) / evalCoeffs(d, x);
      if (it.stem.includes("has a hole")) {
        // Both top and bottom vanish there, and the rule stays finite beside it.
        holeItems++;
        expect(evalCoeffs(n, value)).toBe(0);
        expect(evalCoeffs(d, value)).toBe(0);
        expect(Math.abs(f(value + 1e-7))).toBeLessThan(1e3);
        // The other zero of the bottom is the asymptote, not the hole.
        const other = [-6, -5, -4, -3, -2, -1, 0, 1, 2, 3, 4, 5, 6].find((x) => x !== value && evalCoeffs(d, x) === 0);
        if (other !== undefined) expect(grade("rat_graph_asymptotes", seed, String(other))).toBe(false);
      } else if (it.stem.includes("y = ?")) {
        expect(f(1e7), `#${seed}`).toBeCloseTo(value, 5);
        expect(grade("rat_graph_asymptotes", seed, String(value + 1))).toBe(false);
      } else {
        // A vertical asymptote: the rule blows up next to it.
        expect(Math.abs(f(value + 1e-7)), `#${seed}: ${it.stem}`).toBeGreaterThan(1e4);
        // Any other zero of the denominator is a hole (the rule stays finite), the trap answer.
        const roots = [-6, -5, -4, -3, -2, -1, 0, 1, 2, 3, 4, 5, 6].filter((x) => evalCoeffs(d, x) === 0 && x !== value);
        for (const hole of roots) {
          holes++;
          expect(Math.abs(f(hole + 1e-7))).toBeLessThan(1e3);
          expect(grade("rat_graph_asymptotes", seed, String(hole))).toBe(false);
        }
      }
      if (it.promptVisual) {
        const c = plot(it).curves[0];
        if (c.form !== "rational") throw new Error("expected rational");
        for (const x of [-7.3, -1.1, 0.6, 2.9]) {
          if (Number.isFinite(f(x))) expect(rationalValue(c.rational, x)).toBeCloseTo(f(x), 9);
        }
        // An item asking for an asymptote never draws it.
        expect(plot(it).asymptotes).toBeUndefined();
      }
      // Equivalent: an unreduced fraction of the same value.
      expect(grade("rat_graph_asymptotes", seed, `${Math.round(value * 12) * 2}/24`)).toBe(Number.isInteger(value * 12));
    }
    expect(holes).toBeGreaterThan(20);
    expect(holeItems).toBeGreaterThan(10);
    expect(fractional).toBeGreaterThan(10);
  });
});
