/**
 * Algebra 2 — rational strand: excluded values, simplifying, multiplying and
 * dividing, adding and subtracting, solving with extraneous solutions, and
 * inverse variation.
 *
 * Not here: `rat_graph_asymptotes`, which needs the function-curve visual
 * another lane is building.
 *
 * Denominators are products of monic linear factors (x − r) built from their
 * roots, so every answer is exact and in lowest terms by construction; the
 * tests re-derive each one independently.
 */
import type { WorkedStep } from "../fadedSteps";
import type { Algebra2Kit, Rng, Template } from "../templates";
import { evalPoly, expandRoots, polyAns, polyTex, tex } from "./format";
import {
  gcdInt,
  linAns,
  linTex,
  monoPlain,
  nonzero,
  polyAdd,
  polyDivide,
  polyMul,
  polyPlain,
  polyScale,
  zeroOf,
} from "./polynomials";

/** How many random draws a retry makes before its fallback. Tests set it to
 *  0 to serve (and check) every fallback. */
export const RATIONAL_DRAW = { attempts: 200 };

/** Retry a draw until it is acceptable (null = rejected). The fallback holds
 *  RAW parameters only; everything derived from them is computed after the
 *  draw, from whichever parameters won. */
function draw<T>(make: () => T | null, fallback: T): T {
  for (let i = 0; i < RATIONAL_DRAW.attempts; i++) {
    const candidate = make();
    if (candidate !== null) return candidate;
  }
  return fallback;
}

/** Distinct whole numbers in [lo, hi], none in `avoid`. If the random draws
 *  run out, the rest are filled in order from lo, so the list is always full. */
function distinct(r: Rng, count: number, lo: number, hi: number, avoid: number[] = []): number[] {
  const out: number[] = [];
  let guard = 0;
  while (out.length < count && guard++ < RATIONAL_DRAW.attempts) {
    const v = r.int(lo, hi);
    if (!out.includes(v) && !avoid.includes(v)) out.push(v);
  }
  for (let v = lo; out.length < count && v <= hi; v++) if (!out.includes(v) && !avoid.includes(v)) out.push(v);
  return out;
}

/** A denominator as LaTeX: one linear factor, or its product multiplied out. */
function denTexOf(t: { roots: number[] }): string {
  return t.roots.length === 1 ? polyTex([1, -t.roots[0]]) : polyTex(expandRoots(t.roots));
}

/** (x − r₁)(x − r₂)… in answer grammar: `(x-2)(x+3)`, `x(x-1)`. */
function rootsAns(roots: readonly number[]): string {
  return roots.map((root) => linAns(1, -root)).join("");
}

/** A denominator in answer grammar: one factor stands alone, several are
 *  wrapped so the fraction bar covers all of them. */
function denAns(roots: readonly number[]): string {
  return roots.length === 1 ? linAns(1, -roots[0]) : `(${rootsAns(roots)})`;
}

/** A numerator polynomial in answer grammar, wrapped when it is a sum. */
function numAns(coefficients: readonly number[]): string {
  const terms = coefficients.filter((c) => c !== 0).length;
  return terms > 1 ? `(${polyAns(coefficients)})` : polyAns(coefficients);
}

/** `+ \frac{a}{b}` or `- \frac{|a|}{b}` for a signed numerator constant. */
function signedFracTex(numerator: number, denominator: string, leading: boolean): string {
  const body = `\\frac{${Math.abs(numerator)}}{${denominator}}`;
  if (leading) return numerator < 0 ? `-${body}` : body;
  return numerator < 0 ? ` - ${body}` : ` + ${body}`;
}

/** A fraction's value as an answer string: `8`, `-5/2`. */
function fractionString(num: number, den: number): string {
  const g = gcdInt(num, den) || 1;
  const n = num / g;
  const d = den / g;
  if (Math.abs(d) === 1) return String(n * d);
  return `${n * Math.sign(d)}/${Math.abs(d)}`;
}

type Term = { num: number[]; roots: number[] };

/** Add (sign +1) or subtract (sign −1) two rational terms over the LCD, then
 *  cancel any linear factor the numerator shares with it. */
function combine(a: Term, b: Term, sign: 1 | -1) {
  const lcd = [...a.roots, ...b.roots.filter((root) => !a.roots.includes(root))];
  const missing = (t: Term) => lcd.filter((root) => !t.roots.includes(root));
  const scaled = (t: Term) => missing(t).reduce((acc, root) => polyMul(acc, [1, -root]), t.num);
  const raw = polyAdd(scaled(a), polyScale(scaled(b), sign));
  let num = raw;
  let roots = [...lcd];
  const cancelled: number[] = [];
  for (const root of lcd) {
    if (num.some((c) => c !== 0) && evalPoly(num, root) === 0) {
      num = polyDivide(num, [1, -root]).q;
      roots = roots.filter((x) => x !== root);
      cancelled.push(root);
    }
  }
  return { lcd, missingA: missing(a), missingB: missing(b), raw, num, roots, cancelled };
}

const CONTEXTS = [
  {
    // x = painters, y = hours
    stem: (x1: number, y1: number, x2: number) =>
      `Painting a fence takes ${x1} painters ${y1} hours. The time varies inversely with the number of painters. How many hours would ${x2} painters take?`,
    x: () => [2, 3, 4, 6],
    y: () => [2, 3, 4, 5, 6, 8],
    fallback: [2, 6, 3],
  },
  {
    // x = speed, y = hours
    stem: (x1: number, y1: number, x2: number) =>
      `A trip takes ${y1} hours at ${x1} miles per hour. The time varies inversely with the speed. How many hours does the trip take at ${x2} miles per hour?`,
    x: () => [30, 40, 50, 60],
    y: () => [2, 3, 4, 5, 6],
    fallback: [30, 4, 60],
  },
  {
    // x = people, y = slices each
    stem: (x1: number, y1: number, x2: number) =>
      `A tray of snacks is shared equally. With ${x1} people, each person gets ${y1} snacks. The share varies inversely with the number of people. How many snacks does each person get with ${x2} people?`,
    x: () => [2, 3, 4, 6, 8],
    y: () => [3, 4, 6, 8, 9, 12],
    fallback: [2, 6, 3],
  },
];

export function rationalTemplates(kit: Algebra2Kit): Template[] {
  const { T, exprAns, solutionSetAns, withWorkedSteps } = kit;

  return [
    // Excluded values: the zeros of the ORIGINAL denominator, before any
    // cancelling. Some denominators are never zero (no excluded values).
    T(
      "rat_excluded_values",
      "solutionSet",
      (r) => {
        const tier = r.int(0, 2);
        let numerator: number[];
        let denominator: number[];
        let factoredDen: string;
        let excluded: string[];
        let neverZero = false;
        if (tier === 0) {
          let a = r.pick([1, 1, 2, 3]);
          let b = nonzero(r, -9, 9);
          while (gcdInt(a, b) !== 1) {
            a = r.pick([1, 2, 3]);
            b = nonzero(r, -9, 9);
          }
          denominator = [a, b];
          numerator = [1, r.int(-6, 6)];
          factoredDen = polyPlain(denominator);
          excluded = [zeroOf(a, b)];
        } else if (tier === 1) {
          const [p, q] = distinct(r, 2, -7, 7);
          denominator = expandRoots([p, q]);
          numerator = r.int(0, 1) === 0 ? [1, r.int(-6, 6)] : [r.int(1, 9)];
          factoredDen = rootsAns([p, q]);
          excluded = [String(p), String(q)];
        } else {
          const kind = r.int(0, 2);
          if (kind === 0) {
            // (x − p)/(x² − p²): it simplifies, but x = p is still excluded.
            const p = nonzero(r, -6, 6);
            numerator = [1, -p];
            denominator = [1, 0, -p * p];
            factoredDen = rootsAns([p, -p]);
            excluded = [String(p), String(-p)];
          } else if (kind === 1) {
            const s = r.int(1, 9);
            numerator = [1, r.int(-6, 6)];
            denominator = [1, 0, s];
            factoredDen = polyPlain(denominator);
            excluded = [];
            neverZero = true;
          } else {
            const [p, q] = distinct(r, 2, -5, 5, [0]);
            numerator = [r.int(1, 5)];
            denominator = expandRoots([0, p, q]);
            factoredDen = rootsAns([0, p, q]);
            excluded = ["0", String(p), String(q)];
          }
        }
        const steps: WorkedStep[] = [
          {
            text: `A denominator can't be zero, so set it equal to zero: ${polyPlain(denominator)} = 0.`,
            blankText: "Set the denominator equal to zero: ?",
          },
        ];
        if (neverZero) {
          steps.push({
            text: `x^2 is never negative, so ${polyPlain(denominator)} is at least ${denominator[2]} and is never zero.`,
            blankText: "Decide whether the denominator can ever be zero: ?",
          });
          steps.push({
            text: "So no value of x is excluded: none.",
            blankText: "List the excluded values: ?",
          });
        } else {
          if (factoredDen !== polyPlain(denominator)) {
            steps.push({
              text: `Factor it: ${factoredDen} = 0.`,
              blankText: "Factor the denominator: ?",
            });
          }
          steps.push({
            text: `Solve: each value that makes it zero is excluded: ${excluded.join(", ")}.`,
            blankText: "Solve for the values that make it zero: ?",
          });
        }
        return {
          stem: `Which values of x must be excluded from the domain of ${tex(`\\frac{${polyTex(numerator)}}{${polyTex(denominator)}}`)}? List every one, or choose No solution if there are none.`,
          answer: solutionSetAns(excluded),
          ...withWorkedSteps(steps),
        };
      },
      { answerPalette: "algebra" },
    ),

    // Cancel common FACTORS (never terms).
    T(
      "rat_simplify",
      "expression",
      (r) => {
        const tier = r.int(0, 2);
        let numerator: number[];
        let denominator: number[];
        let numTex: string | null = null;
        let numFactored: string;
        let denFactored: string;
        let common: string;
        let answer: string;
        if (tier === 0) {
          const [c, p, q] = distinct(r, 3, -6, 6);
          denominator = expandRoots([c, q]);
          denFactored = rootsAns([c, q]);
          common = linAns(1, -c);
          if (r.int(0, 3) === 0) {
            numerator = [1, -c];
            numFactored = common;
            answer = `1/${linAns(1, -q)}`;
          } else {
            numerator = expandRoots([c, p]);
            numFactored = rootsAns([c, p]);
            answer = `${linAns(1, -p)}/${linAns(1, -q)}`;
          }
        } else if (tier === 1) {
          const [c, p] = distinct(r, 2, -6, 6);
          const g = r.int(2, 5);
          if (r.int(0, 1) === 0) {
            // g(x − c) over (x − c)(x − p)
            numerator = [g, -g * c];
            denominator = expandRoots([c, p]);
            numFactored = `${g}${linAns(1, -c)}`;
            denFactored = rootsAns([c, p]);
            answer = `${g}/${linAns(1, -p)}`;
          } else {
            // (x − c)(x − p) over g(x − c)
            numerator = expandRoots([c, p]);
            denominator = [g, -g * c];
            numFactored = rootsAns([c, p]);
            denFactored = `${g}${linAns(1, -c)}`;
            answer = `${linAns(1, -p)}/${g}`;
          }
          common = linAns(1, -c);
        } else if (r.int(0, 1) === 0) {
          // (c² − x²) over (x − c)(x − q): the opposite factor gives −1.
          const c = nonzero(r, -6, 6);
          const q = distinct(r, 1, -6, 6, [c, -c])[0];
          numerator = [-1, 0, c * c];
          numTex = `${c * c} - x^{2}`;
          denominator = expandRoots([c, q]);
          numFactored = `-${linAns(1, -c)}${linAns(1, c)}`;
          denFactored = rootsAns([c, q]);
          common = linAns(1, -c);
          answer = `-${linAns(1, c)}/${linAns(1, -q)}`;
        } else {
          // x(x − c)(x + c) over x(x − c): a polynomial is left.
          const c = nonzero(r, -6, 6);
          numerator = [1, 0, -c * c, 0];
          denominator = [1, -c, 0];
          numFactored = `x${linAns(1, -c)}${linAns(1, c)}`;
          denFactored = `x${linAns(1, -c)}`;
          common = `x${linAns(1, -c)}`;
          answer = polyAns([1, c]);
        }
        return {
          stem: `Simplify ${tex(`\\frac{${numTex ?? polyTex(numerator)}}{${polyTex(denominator)}}`)}. Write it as one fraction in lowest terms.`,
          answer: exprAns(answer),
          ...withWorkedSteps([
            { text: `Factor the numerator: ${numFactored}.`, blankText: "Factor the numerator: ?" },
            { text: `Factor the denominator: ${denFactored}.`, blankText: "Factor the denominator: ?" },
            {
              text: `Cancel the common factor ${common} (a factor, not a term): ${answer}.`,
              blankText: `Cancel the common factor ${common}: ?`,
            },
          ]),
        };
      },
      { answerPalette: "algebra", answerForm: "singleFraction" },
    ),

    // Multiply, or divide by multiplying by the reciprocal; factor first.
    T(
      "rat_multiply_divide",
      "expression",
      (r) => {
        const tier = r.int(0, 2);
        const divide = tier === 1 || (tier === 2 && r.int(0, 1) === 0);
        let a: string; // first fraction, LaTeX
        let b: string; // second fraction as shown, LaTeX
        let factoredLine: string;
        let cancelled: string;
        let answer: string;
        if (tier < 2) {
          const [f1, f2, f3, f4] = distinct(r, 4, -6, 6);
          a = `\\frac{${polyTex(expandRoots([f1, f2]))}}{${polyTex(expandRoots([f3, f4]))}}`;
          const second: [number[], number[]] = [[1, -f4], [1, -f1]]; // what we multiply by
          b = divide
            ? `\\frac{${polyTex(second[1])}}{${polyTex(second[0])}}`
            : `\\frac{${polyTex(second[0])}}{${polyTex(second[1])}}`;
          factoredLine = `${rootsAns([f1, f2])}/${denAns([f3, f4])} · ${linAns(1, -f4)}/${linAns(1, -f1)}`;
          cancelled = `${linAns(1, -f1)} and ${linAns(1, -f4)}`;
          answer = `${linAns(1, -f2)}/${linAns(1, -f3)}`;
        } else {
          const [f1, f2, f3, f4] = distinct(r, 4, -5, 5);
          let g = r.int(2, 6);
          let h = r.int(2, 6);
          while (g === h) h = r.int(2, 6);
          a = `\\frac{${polyTex([g, -g * f1])}}{${polyTex(expandRoots([f2, f3]))}}`;
          const secondNum = expandRoots([f3, f4]);
          const secondDen = [h, -h * f1];
          b = divide
            ? `\\frac{${polyTex(secondDen)}}{${polyTex(secondNum)}}`
            : `\\frac{${polyTex(secondNum)}}{${polyTex(secondDen)}}`;
          factoredLine = `${g}${linAns(1, -f1)}/${denAns([f2, f3])} · ${rootsAns([f3, f4])}/(${h}${linAns(1, -f1)})`;
          cancelled = `${linAns(1, -f1)} and ${linAns(1, -f3)}`;
          const k = gcdInt(g, h);
          g /= k;
          h /= k;
          const top = `${g === 1 ? "" : g}${linAns(1, -f4)}`;
          answer = h === 1 ? `${top}/${linAns(1, -f2)}` : `${top}/(${h}${linAns(1, -f2)})`;
        }
        const steps: WorkedStep[] = [];
        if (divide) {
          steps.push({
            text: "Dividing by a fraction means multiplying by its reciprocal, so flip the second fraction.",
            blankText: "Rewrite the division as a multiplication: ?",
          });
        }
        steps.push({ text: `Factor everything: ${factoredLine}.`, blankText: "Factor every numerator and denominator: ?" });
        steps.push({
          text: `Cancel the common factors ${cancelled}.`,
          blankText: "Cancel factors shared by a numerator and a denominator: ?",
        });
        steps.push({ text: `Multiply what is left: ${answer}.`, blankText: "Multiply the remaining factors: ?" });
        return {
          stem: divide
            ? `Divide ${tex(a)} ÷ ${tex(b)}. Write the answer as one fraction in lowest terms.`
            : `Multiply ${tex(`${a} \\cdot ${b}`)}. Write the answer as one fraction in lowest terms.`,
          answer: exprAns(answer),
          ...withWorkedSteps(steps),
        };
      },
      { answerPalette: "algebra", answerForm: "singleFraction" },
    ),

    // Add or subtract over the least common denominator.
    T(
      "rat_add_subtract",
      "expression",
      (r) => {
        {
          const { first, second, sign } = draw<{ first: Term; second: Term; sign: 1 | -1 }>(
            () => {
              const tier = r.int(0, 2);
              let first: Term;
              let second: Term;
              let sign: 1 | -1;
              if (tier === 0) {
                const [p, q] = distinct(r, 2, -6, 6);
                first = { num: [r.int(1, 6)], roots: [p] };
                second = { num: [r.int(1, 6)], roots: [q] };
                sign = 1;
              } else if (tier === 1) {
                const [p, q] = distinct(r, 2, -6, 6);
                first = { num: r.int(0, 1) === 0 ? [1, 0] : [r.int(1, 6)], roots: [p] };
                second = { num: [r.int(1, 6)], roots: [q] };
                sign = r.int(0, 2) === 0 ? 1 : -1;
              } else if (r.int(0, 1) === 0) {
                // a/(x² − c²) ± b/(x + c)
                const c = nonzero(r, -6, 6);
                first = { num: [r.int(1, 9)], roots: [c, -c] };
                second = { num: [r.int(1, 5)], roots: [-c] };
                sign = r.int(0, 1) === 0 ? 1 : -1;
              } else {
                // x/(x − c) − 2c²/(x² − c²): the result cancels down.
                const c = nonzero(r, -5, 5);
                first = { num: [1, 0], roots: [c] };
                second = { num: [2 * c * c], roots: [c, -c] };
                sign = -1;
              }
              const trial = combine(first, second, sign);
              const degenerate =
                trial.num.every((c) => c === 0) || trial.roots.length === 0 || first.roots.join() === second.roots.join();
              return degenerate ? null : { first, second, sign };
            },
            { first: { num: [3], roots: [1] }, second: { num: [2], roots: [-2] }, sign: 1 },
          );
          const firstDenTex = denTexOf(first);
          const secondDenTex = denTexOf(second);
          const result = combine(first, second, sign);
          const answer = `${numAns(result.num)}/${denAns(result.roots)}`;
          const termTex = (t: Term, denTex: string) => `\\frac{${polyTex(t.num)}}{${denTex}}`;
          const lcdAns = denAns(result.lcd);
          const rewritten = (t: Term, missing: number[]) =>
            missing.length === 0
              ? polyPlain(t.num)
              : t.num.length === 1 && t.num[0] === 1
                ? rootsAns(missing)
                : `${polyPlain(t.num)}${rootsAns(missing)}`;
          const steps: WorkedStep[] = [
            {
              text: `Factor the denominators. The least common denominator is ${rootsAns(result.lcd)}.`,
              blankText: "Find the least common denominator: ?",
            },
            {
              text: `Rewrite both over it: [${rewritten(first, result.missingA)} ${sign > 0 ? "+" : "-"} ${rewritten(second, result.missingB)}]/${lcdAns}.`,
              blankText: "Rewrite each fraction over the common denominator: ?",
            },
            {
              text: `Combine the numerators${sign < 0 ? " (the minus sign applies to the whole second numerator)" : ""}: ${polyPlain(result.raw)}.`,
              blankText: `${sign > 0 ? "Add" : "Subtract"} the numerators: ?`,
            },
          ];
          if (result.cancelled.length > 0) {
            steps.push({
              text: `Factor the numerator and cancel ${rootsAns(result.cancelled)}: ${answer}.`,
              blankText: "Factor the numerator and cancel any common factor: ?",
            });
          } else {
            steps.push({
              text: `Nothing cancels, so the answer is ${answer}.`,
              blankText: "Write the result as one fraction: ?",
            });
          }
          return {
            stem: `${sign > 0 ? "Add" : "Subtract"} ${tex(`${termTex(first, firstDenTex)} ${sign > 0 ? "+" : "-"} ${termTex(second, secondDenTex)}`)}. Write the answer as one fraction in lowest terms.`,
            answer: exprAns(answer),
            ...withWorkedSteps(steps),
          };
        }
      },
      { answerPalette: "algebra", answerForm: "singleFraction" },
    ),

    // Clear denominators, solve, then throw out any value that makes an
    // original denominator zero. Extraneous roots and "no solution" are common.
    T(
      "rat_solve_equation",
      "solutionSet",
      (r) => {
        const tier = r.int(0, 2);
        if (tier === 0) {
          if (r.int(0, 4) < 2) {
            // ax/(x − p) + k = ap/(x − p): clearing gives x = p, which is excluded.
            const p = nonzero(r, -6, 6);
            const a = r.int(1, 3);
            const k = r.int(1, 4);
            const den = polyTex([1, -p]);
            return {
              stem: `Solve ${tex(`\\frac{${polyTex([a, 0])}}{${den}} + ${k} = ${signedFracTex(a * p, den, true)}`)}. Give every solution, or choose No solution.`,
              answer: solutionSetAns([]),
              ...withWorkedSteps([
                { text: `x cannot be ${p}: it makes the denominator zero.`, blankText: "Find the excluded value: ?" },
                {
                  text: `Multiply every term by (${polyPlain([1, -p])}): ${polyPlain([a, 0])} + ${k}(${polyPlain([1, -p])}) = ${a * p}.`,
                  blankText: `Multiply every term by (${polyPlain([1, -p])}): ?`,
                },
                {
                  text: `Solve: ${a + k}x = ${(a + k) * p}, so x = ${p}.`,
                  blankText: "Solve the cleared equation: ?",
                },
                {
                  text: `But x = ${p} is excluded, so there is no solution: none.`,
                  blankText: "Check the solution against the excluded value: ?",
                },
              ]),
            };
          }
          // a/(x − p) = b/(x − q), solution s.
          const [p, q] = distinct(r, 2, -6, 6);
          const s = distinct(r, 1, Math.max(p, q) + 1, Math.max(p, q) + 6)[0];
          const g = gcdInt(s - p, s - q);
          const a = (s - p) / g;
          const b = (s - q) / g;
          return {
            stem: `Solve ${tex(`\\frac{${a}}{${polyTex([1, -p])}} = \\frac{${b}}{${polyTex([1, -q])}}`)}. Give every solution, or choose No solution.`,
            answer: solutionSetAns([s]),
            ...withWorkedSteps([
              { text: `x cannot be ${p} or ${q}.`, blankText: "Find the excluded values: ?" },
              {
                text: `Cross-multiply: ${a}(${polyPlain([1, -q])}) = ${b}(${polyPlain([1, -p])}).`,
                blankText: "Cross-multiply: ?",
              },
              {
                text: `Collect x terms: ${monoPlain(a - b, 1)} = ${a * q - b * p}, so x = ${s}.`,
                blankText: "Solve the linear equation: ?",
              },
              {
                text: `x = ${s} is not excluded, so the solution is: ${s}.`,
                blankText: "Check the solution against the excluded values: ?",
              },
            ]),
          };
        }
        // x/(x − p) + m/(x − t) = R/((x − p)(x − t)) clears to
        // x² + (m − t)x − mp − R = 0, built with roots u and v.
        {
          // Raw parameters only; t and R are derived below from the winner.
          const derive = (q: { caseRoll: number; p: number; m: number; u: number; v: number }) => ({
            t: q.caseRoll >= 8 ? q.v : q.m + q.u + q.v,
            R: -q.m * q.p - q.u * q.v,
          });
          const { caseRoll, p, m, u, v } = draw(
            () => {
              const caseRoll = r.int(0, 9);
              const p = nonzero(r, -6, 6);
              let m: number;
              let u: number;
              let v: number;
              if (caseRoll < 5) {
                // one extraneous root
                m = nonzero(r, -5, 5);
                u = p;
                v = r.int(-6, 6);
              } else if (caseRoll < 8) {
                // both roots valid
                m = nonzero(r, -5, 5);
                [u, v] = distinct(r, 2, -6, 6, [p]);
              } else {
                // both extraneous: no solution
                m = -p;
                u = p;
                v = r.int(-6, 6);
              }
              const q = { caseRoll, p, m, u, v };
              const { t, R } = derive(q);
              const ok =
                t !== p && t !== 0 && u !== v && R !== 0 && Math.abs(t) <= 9 && (caseRoll >= 8 || (v !== p && v !== t && u !== t));
              return ok ? q : null;
            },
            // One extraneous root: x² − x − 2 = 0 has roots 2 (excluded) and −1.
            { caseRoll: 0, p: 2, m: 3, u: 2, v: -1 },
          );
          const { t, R } = derive({ caseRoll, p, m, u, v });
          const excluded = [p, t];
          const solutions = [u, v].filter((x) => !excluded.includes(x));
          const lcdTex = tier === 1 ? `${linTex(1, -p)}${linTex(1, -t)}` : polyTex(expandRoots([p, t]));
          const answerText = solutions.length === 0 ? "none" : solutions.join(", ");
          const rejected = [u, v].filter((x) => excluded.includes(x));
          return {
            stem: `Solve ${tex(`\\frac{x}{${polyTex([1, -p])}}${signedFracTex(m, polyTex([1, -t]), false)} = ${signedFracTex(R, lcdTex, true)}`)}. Give every solution, or choose No solution.`,
            answer: solutionSetAns(solutions),
            ...withWorkedSteps([
              {
                text: `${tier === 2 ? `Factor ${polyPlain(expandRoots([p, t]))} = ${rootsAns([p, t])}. ` : ""}x cannot be ${p} or ${t}.`,
                blankText: "Find the excluded values: ?",
              },
              {
                text: `Multiply every term by ${rootsAns([p, t])}: x${linAns(1, -t)} ${m < 0 ? "-" : "+"} ${Math.abs(m)}${linAns(1, -p)} = ${R}.`,
                blankText: "Multiply every term by the common denominator: ?",
              },
              {
                text: `Simplify and factor: ${polyPlain(expandRoots([u, v]))} = ${rootsAns([u, v])} = 0, so x = ${u} or x = ${v}.`,
                blankText: "Simplify to a quadratic and solve it: ?",
              },
              {
                text:
                  rejected.length === 0
                    ? `Neither is excluded, so the solutions are: ${answerText}.`
                    : solutions.length === 0
                      ? `Both are excluded, so there is no solution: none.`
                      : `x = ${rejected[0]} is excluded, so the solution is: ${answerText}.`,
                blankText: "Throw out any excluded value: ?",
              },
            ]),
          };
        }
      },
      { answerPalette: "algebra" },
    ),

    // y = k/x: find k, then a value. Typed as an expression (not a fraction)
    // so 5/2 and 2.5 both grade correct.
    T("rat_inverse_variation", "expression", (r) => {
      const tier = r.int(0, 2);
      const askK = tier === 0 && r.int(0, 1) === 0;
      if (tier === 1) {
        const ctx = r.pick(CONTEXTS);
        {
          const [x1, y1, x2] = draw(() => {
            const pick = [r.pick(ctx.x()), r.pick(ctx.y()), r.pick(ctx.x())];
            return pick[2] === pick[0] || (pick[0] * pick[1]) % pick[2] !== 0 ? null : pick;
          }, ctx.fallback);
          const k = x1 * y1;
          return {
            stem: ctx.stem(x1, y1, x2),
            answer: exprAns(fractionString(k, x2)),
            ...withWorkedSteps([
              {
                text: "Inverse variation means the product stays the same: k = x · y.",
                blankText: "Write what stays constant: ?",
              },
              { text: `k = ${x1} · ${y1} = ${k}.`, blankText: "Find k from the first situation: ?" },
              { text: `Divide k by the new amount: ${k}/${x2} = ${fractionString(k, x2)}.`, blankText: `Divide ${k} by ${x2}: ?` },
            ]),
          };
        }
      }
      {
        // Tier 0 keeps whole answers; tier 2 wants a fraction.
        const [x1, y1, x2] = draw(
          () => {
            const pick = [nonzero(r, -9, 9), nonzero(r, -9, 9), nonzero(r, -9, 9)];
            const integral = (pick[0] * pick[1]) % pick[2] === 0;
            return pick[2] === pick[0] || (tier === 0 ? !integral : integral) || Math.abs(pick[0]) === 1 ? null : pick;
          },
          tier === 0 ? [4, 6, 3] : [3, 5, 2],
        );
        const k = x1 * y1;
        const intro = `${tex("y")} varies inversely with ${tex("x")}, and ${tex(`y = ${y1}`)} when ${tex(`x = ${x1}`)}.`;
        if (askK) {
          return {
            stem: `${intro} What is the constant of variation ${tex("k")} in ${tex("y = \\frac{k}{x}")}?`,
            answer: exprAns(String(k)),
            ...withWorkedSteps([
              { text: "Multiply both sides of y = k/x by x: k = x · y.", blankText: "Solve y = k/x for k: ?" },
              { text: `k = ${x1} · ${y1 < 0 ? `(${y1})` : y1} = ${k}.`, blankText: "Substitute the given values: ?" },
            ]),
          };
        }
        return {
          stem: `${intro} Find ${tex("y")} when ${tex(`x = ${x2}`)}.`,
          answer: exprAns(fractionString(k, x2)),
          ...withWorkedSteps([
            { text: "Inverse variation: y = k/x, so k = x · y.", blankText: "Write k in terms of x and y: ?" },
            { text: `k = ${x1} · ${y1 < 0 ? `(${y1})` : y1} = ${k}.`, blankText: "Find k from the given pair: ?" },
            {
              text:
                fractionString(k, x2) === `${k}/${x2}`
                  ? `y = k/x = ${k}/${x2}.`
                  : `y = ${k}/${x2 < 0 ? `(${x2})` : x2} = ${fractionString(k, x2)}.`,
              blankText: `Divide k by ${x2}: ?`,
            },
          ]),
        };
      }
    }, { answerPalette: "algebra" }),
  ];
}
