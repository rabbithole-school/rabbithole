/**
 * Algebra 2 — polynomials strand: zeros and multiplicity, factoring (grouping,
 * cubes, quadratic form, factor theorem), long and synthetic division, the
 * Remainder Theorem, solving degree 3–4 equations, and binomial expansion.
 *
 * Not here: `poly_end_behavior` and `poly_sketch_factored`, which need the
 * function-curve visual another lane is building.
 *
 * Every answer is built first and the stem from it, so it is right by
 * construction; the tests re-derive each one independently.
 */
import type { WorkedStep } from "../fadedSteps";
import type { Algebra2Kit, Rng, Template } from "../templates";
import { evalPoly, expandRoots, polyAns, polyTex, tex } from "./format";

// ── Strand helpers (also used by rational.ts) ──────────────────────────────

/** A whole number in [lo, hi] other than 0 (lo < 0 < hi). */
export function nonzero(r: Rng, lo: number, hi: number): number {
  const v = r.int(lo, hi - 1);
  return v >= 0 ? v + 1 : v;
}

export function gcdInt(a: number, b: number): number {
  let x = Math.abs(a);
  let y = Math.abs(b);
  while (y) [x, y] = [y, x % y];
  return x;
}

/** Product of two polynomials (coefficients highest power first). */
export function polyMul(a: readonly number[], b: readonly number[]): number[] {
  const out = new Array<number>(a.length + b.length - 1).fill(0);
  a.forEach((x, i) => b.forEach((y, j) => (out[i + j] += x * y)));
  return out;
}

/** Sum of two polynomials, aligned at the constant term. */
export function polyAdd(a: readonly number[], b: readonly number[]): number[] {
  const n = Math.max(a.length, b.length);
  const out = new Array<number>(n).fill(0);
  a.forEach((x, i) => (out[n - a.length + i] += x));
  b.forEach((x, i) => (out[n - b.length + i] += x));
  return polyTrimLead(out);
}

export function polyScale(a: readonly number[], k: number): number[] {
  return a.map((x) => x * k);
}

/** Drop leading zero coefficients (keeps at least one entry). */
export function polyTrimLead(a: readonly number[]): number[] {
  let i = 0;
  while (i < a.length - 1 && a[i] === 0) i++;
  return a.slice(i).map((x) => (Object.is(x, -0) ? 0 : x));
}

/** Plain-text polynomial for worked steps: `x^3 - 2x^2 + 5`. */
export function polyPlain(coefficients: readonly number[]): string {
  return polyTex(coefficients).replace(/\^\{(\d+)\}/g, "^$1");
}

/** Plain-text monomial c·x^p. */
export function monoPlain(coefficient: number, power: number): string {
  const c = new Array<number>(power + 1).fill(0);
  c[0] = coefficient;
  return polyPlain(c);
}

/** The linear factor (ax + b) in answer grammar; bare `x` for a = 1, b = 0. */
export function linAns(a: number, b: number): string {
  return a === 1 && b === 0 ? "x" : `(${polyAns([a, b])})`;
}

export function linTex(a: number, b: number): string {
  return a === 1 && b === 0 ? "x" : `(${polyTex([a, b])})`;
}

/** The zero of ax + b as an answer member: `2`, `-3/2`. */
export function zeroOf(a: number, b: number): string {
  const num = -b;
  const g = gcdInt(num, a) || 1;
  const n = num / g;
  const d = a / g;
  const sign = n * d < 0 ? "-" : "";
  return Math.abs(d) === 1 ? String(n / d) : `${sign}${Math.abs(n)}/${Math.abs(d)}`;
}

/** Join signed numbers as a sum for a worked step: `8 - 12 + 0 + 5`. */
export function signedSum(values: readonly number[]): string {
  return values
    .map((v, i) => (i === 0 ? String(v) : v < 0 ? ` - ${-v}` : ` + ${v}`))
    .join("");
}

type DivisionCycle = { leadCoef: number; leadPow: number; termCoef: number; termPow: number; after: number[] };

/** Long division of n by d (integer coefficients, exact by construction):
 *  the quotient, the remainder, and each divide-multiply-subtract cycle. */
export function polyDivide(
  n: readonly number[],
  d: readonly number[],
): { q: number[]; r: number[]; cycles: DivisionCycle[] } {
  const rem = [...n];
  const qLen = n.length - d.length + 1;
  const q = new Array<number>(qLen).fill(0);
  const cycles: DivisionCycle[] = [];
  const top = n.length - 1;
  for (let i = 0; i < qLen; i++) {
    if (rem[i] === 0) continue;
    const coef = rem[i] / d[0];
    q[i] = coef;
    const lead = rem[i];
    for (let j = 0; j < d.length; j++) rem[i + j] -= coef * d[j];
    cycles.push({
      leadCoef: lead,
      leadPow: top - i,
      termCoef: coef,
      termPow: qLen - 1 - i,
      after: polyTrimLead(rem.slice(i + 1)),
    });
  }
  return { q: polyTrimLead(q), r: polyTrimLead(rem.slice(qLen)), cycles };
}

/** The synthetic-division bottom row for dividing by (x − a). */
function syntheticRow(coefficients: readonly number[], a: number): number[] {
  const row: number[] = [];
  coefficients.forEach((c, i) => row.push(i === 0 ? c : c + a * row[i - 1]));
  return row;
}

function binomial(n: number, k: number): number {
  let out = 1;
  for (let i = 1; i <= k; i++) out = (out * (n - k + i)) / i;
  return out;
}

/** A number for a product in a worked step: negatives in parentheses. */
function paren(v: number): string {
  return v < 0 ? `(${v})` : String(v);
}

function powerTex(base: string, m: number): string {
  return m === 1 ? base : `${base}^{${m}}`;
}

/** How many random draws a retry makes before its fallback. Tests set it to
 *  0 to serve (and check) every fallback. */
export const POLY_DRAW = { attempts: 200 };

/** Distinct whole numbers in [lo, hi], none in `avoid`. If the random draws
 *  run out, the rest are filled in order from lo, so the list is always full. */
function distinctInts(r: Rng, count: number, lo: number, hi: number, avoid: number[] = []): number[] {
  const out: number[] = [];
  let guard = 0;
  while (out.length < count && guard++ < POLY_DRAW.attempts) {
    const v = r.int(lo, hi);
    if (!out.includes(v) && !avoid.includes(v)) out.push(v);
  }
  for (let v = lo; out.length < count && v <= hi; v++) if (!out.includes(v) && !avoid.includes(v)) out.push(v);
  return out;
}

/** A linear factor (mx + n) with gcd(m, n) = 1, m > 1. */
function nonMonicLinear(r: Rng): [number, number] {
  for (let guard = 0; guard < POLY_DRAW.attempts; guard++) {
    const m = r.int(2, 3);
    const n = nonzero(r, -5, 5);
    if (gcdInt(m, n) === 1) return [m, n];
  }
  return [2, -1];
}

function divisionCycleStep(cycle: DivisionCycle, divisor: readonly number[], isLast: boolean, remainderNamed: boolean): WorkedStep {
  const degD = divisor.length - 1;
  const term = monoPlain(cycle.termCoef, cycle.termPow);
  const leave = polyPlain(cycle.after);
  return {
    text: `${monoPlain(cycle.leadCoef, cycle.leadPow)} ÷ ${monoPlain(divisor[0], degD)} = ${term}. Subtract ${term}(${polyPlain(divisor)}) to leave ${isLast && remainderNamed ? `the remainder ${leave}` : leave}.`,
    blankText: isLast && remainderNamed
      ? "Divide the leading terms, multiply and subtract to find the remainder: ?"
      : "Divide the leading terms, then multiply and subtract: ?",
  };
}

// ── The families ───────────────────────────────────────────────────────────

export function polynomialsTemplates(kit: Algebra2Kit): Template[] {
  const { T, exprAns, intAns, solutionSetAns, withWorkedSteps } = kit;

  return [
    // Zeros and multiplicities from factored form. Mostly "every zero" (a
    // solution set); some draws ask the multiplicity of one zero, typed as
    // an integer for that draw.
    T(
      "poly_zeros_multiplicity",
      "solutionSet",
      (r) => {
        const tier = r.int(0, 2);
        type F = { a: number; b: number; m: number };
        const factors: F[] = [];
        if (tier === 0) {
          const roots = distinctInts(r, r.int(2, 3), -6, 6);
          for (const root of roots) factors.push({ a: 1, b: -root, m: r.int(1, 3) });
        } else if (tier === 1) {
          const [m, n] = nonMonicLinear(r);
          const hasX = r.int(0, 1) === 0;
          const roots = distinctInts(r, 2, -6, 6, hasX ? [0] : []);
          if (hasX) factors.push({ a: 1, b: 0, m: r.int(2, 3) });
          factors.push({ a: 1, b: -roots[0], m: r.int(1, 2) });
          factors.push({ a: m, b: n, m: r.int(1, 2) });
          if (factors.length === 2) factors.push({ a: 1, b: -roots[1], m: 1 });
        }
        const lead = r.pick([1, 1, 2, -1, 3]);
        const leadTex = lead === 1 ? "" : lead === -1 ? "-" : String(lead);

        if (tier === 2) {
          // (x − c)^k(x² − c²)(x − d): x = c hides once more inside x² − c².
          const c = nonzero(r, -5, 5);
          const k = r.int(1, 2);
          const d = distinctInts(r, 1, -6, 6, [c, -c])[0];
          const pTex = `${leadTex}${powerTex(linTex(1, -c), k)}(x^{2} - ${c * c})${linTex(1, -d)}`;
          if (r.int(0, 1) === 0) {
            const mult = k + 1;
            return {
              stem: `What is the multiplicity of the zero ${tex(`x = ${c}`)} of ${tex(`p(x) = ${pTex}`)}?`,
              answerType: "integer" as const,
              answer: intAns(mult),
              ...withWorkedSteps([
                {
                  text: `Factor x^2 - ${c * c} = ${linAns(1, -c)}${linAns(1, c)}, so (x ${c > 0 ? "-" : "+"} ${Math.abs(c)}) appears ${k === 1 ? "once" : "twice"} before and once more inside it.`,
                  blankText: "Factor the difference of squares: ?",
                },
                {
                  text: `Count every copy of ${linAns(1, -c)}: ${k} + 1 = ${mult}. The multiplicity is ${mult}.`,
                  blankText: `Count the copies of ${linAns(1, -c)}: ?`,
                },
              ]),
            };
          }
          const zeros = [String(c), String(-c), String(d)];
          return {
            stem: `Find every zero of ${tex(`p(x) = ${pTex}`)}.`,
            answer: solutionSetAns(zeros),
            ...withWorkedSteps([
              {
                text: `Factor x^2 - ${c * c} = ${linAns(1, -c)}${linAns(1, c)}.`,
                blankText: "Factor the difference of squares: ?",
              },
              {
                text: `Set each factor to zero: x = ${c}, x = ${-c}, x = ${d}.`,
                blankText: "Set each factor equal to zero: ?",
              },
              {
                text: `List each zero once: ${zeros.join(", ")}.`,
                blankText: "List each zero once: ?",
              },
            ]),
          };
        }

        const pTex =
          leadTex + factors.map((f) => powerTex(linTex(f.a, f.b), f.m)).join("");
        if (tier === 1 && r.int(0, 2) === 0) {
          const target = factors[r.int(0, factors.length - 1)];
          const zero = zeroOf(target.a, target.b);
          const zeroTex = zero.includes("/")
            ? `${zero.startsWith("-") ? "-" : ""}\\frac{${zero.replace("-", "").split("/")[0]}}{${zero.split("/")[1]}}`
            : zero;
          return {
            stem: `What is the multiplicity of the zero ${tex(`x = ${zeroTex}`)} of ${tex(`p(x) = ${pTex}`)}?`,
            answerType: "integer" as const,
            answer: intAns(target.m),
            ...withWorkedSteps([
              {
                text: `The factor that is zero at x = ${zero} is ${linAns(target.a, target.b)}.`,
                blankText: `Find the factor that is zero at x = ${zero}: ?`,
              },
              {
                text: `Its exponent is the multiplicity: ${target.m}.`,
                blankText: "Read that factor's exponent: ?",
              },
            ]),
          };
        }
        const zeros = factors.map((f) => zeroOf(f.a, f.b));
        return {
          stem: `Find every zero of ${tex(`p(x) = ${pTex}`)}.`,
          answer: solutionSetAns(zeros),
          ...withWorkedSteps([
            {
              text: `p(x) = 0 exactly when one factor is 0: ${factors.map((f) => linAns(f.a, f.b)).join(", ")}.`,
              blankText: "Name the factors that can be zero: ?",
            },
            {
              text: `Set each factor to zero: ${factors.map((f) => `${polyPlain([f.a, f.b])} = 0`).join(", ")}.`,
              blankText: "Set each factor equal to zero: ?",
            },
            {
              text: `Solve each and list each zero once: ${zeros.join(", ")}.`,
              blankText: "Solve each factor = 0 and list the zeros: ?",
            },
          ]),
        };
      },
      { answerPalette: "algebra" },
    ),

    // Factor by grouping, and sums/differences of cubes.
    T(
      "poly_factor_grouping_cubes",
      "expression",
      (r) => {
        const tier = r.int(0, 2);
        if (tier === 0 || (tier === 2 && r.int(0, 1) === 0)) {
          // (mx + n)(x² + s), or tier 2: (x + n)(x − c)(x + c).
          const fullySquares = tier === 2;
          let m = 1;
          let n = nonzero(r, -6, 6);
          let s: number;
          let c = 0;
          if (fullySquares) {
            c = r.int(1, 5);
            while (Math.abs(n) === c) n = nonzero(r, -6, 6);
            s = -c * c;
          } else {
            if (r.int(0, 2) === 0) [m, n] = nonMonicLinear(r);
            s = r.pick([1, 2, 3, 4, 5, 6, 7, -2, -3, -5, -6, -7]);
          }
          const poly = polyMul([m, n], [1, 0, s]);
          const lin = linAns(m, n);
          const quad = `(x^2${s < 0 ? "-" : "+"}${Math.abs(s)})`;
          const answer = fullySquares ? `${lin}${linAns(1, -c)}${linAns(1, c)}` : `${lin}${quad}`;
          const steps: WorkedStep[] = [
            {
              text: `Group the terms: (${polyPlain([poly[0], poly[1], 0, 0])}) ${poly[2] < 0 ? "-" : "+"} (${polyPlain([Math.abs(poly[2]), Math.sign(poly[2]) * poly[3]])}).`,
              blankText: "Split into two groups of two terms: ?",
            },
            {
              text: `Factor each group: x^2${lin} ${s < 0 ? "-" : "+"} ${Math.abs(s)}${lin}.`,
              blankText: "Take the common factor out of each group: ?",
            },
          ];
          if (fullySquares) {
            steps.push({
              text: `Factor out ${lin}: ${lin}(x^2 - ${c * c}).`,
              blankText: `Factor out ${lin}: ?`,
            });
            steps.push({
              text: `x^2 - ${c * c} is a difference of squares, so factored completely: ${answer}.`,
              blankText: `Factor the difference of squares x^2 - ${c * c}: ?`,
            });
          } else {
            steps.push({
              text: `Factor out ${lin}: ${answer}.`,
              blankText: `Factor out the common binomial ${lin}: ?`,
            });
          }
          return {
            stem: `Factor completely: ${tex(polyTex(poly))}.`,
            answer: exprAns(answer),
            ...withWorkedSteps(steps),
          };
        }
        // Sum or difference of cubes, (px)³ ± q³, optionally with a GCF g.
        let p = r.pick([1, 1, 2, 3]);
        let q = r.int(1, 5);
        while (gcdInt(p, q) !== 1) {
          p = r.pick([1, 1, 2, 3]);
          q = r.int(1, 5);
        }
        const g = tier === 2 ? r.pick([2, 3, 5]) : 1;
        const sum = r.int(0, 1) === 0;
        const sgn = sum ? 1 : -1;
        const poly = [g * p ** 3, 0, 0, g * sgn * q ** 3];
        const a = p === 1 ? "x" : `${p}x`;
        const lin = `(${polyAns([p, sgn * q])})`;
        const quad = `(${polyAns([p * p, -sgn * p * q, q * q])})`;
        const answer = `${g === 1 ? "" : g}${lin}${quad}`;
        const steps: WorkedStep[] = [];
        if (g !== 1) {
          steps.push({
            text: `Take out the common factor ${g}: ${g}(${polyPlain([p ** 3, 0, 0, sgn * q ** 3])}).`,
            blankText: "Take out the greatest common factor: ?",
          });
        }
        steps.push({
          text: `Write it as cubes: ${p === 1 ? "x" : `(${a})`}^3 ${sum ? "+" : "-"} ${q}^3.`,
          blankText: "Write each term as a cube: ?",
        });
        steps.push({
          text: sum
            ? `Use a^3 + b^3 = (a + b)(a^2 - ab + b^2) with a = ${a}, b = ${q}.`
            : `Use a^3 - b^3 = (a - b)(a^2 + ab + b^2) with a = ${a}, b = ${q}.`,
          blankText: `Choose the ${sum ? "sum" : "difference"} of cubes pattern: ?`,
        });
        steps.push({
          text: `Fill in a and b and simplify: ${answer}.`,
          blankText: `Fill in a = ${a} and b = ${q}: ?`,
        });
        return {
          stem: `Factor completely: ${tex(polyTex(poly))}.`,
          answer: exprAns(answer),
          ...withWorkedSteps(steps),
        };
      },
      { answerPalette: "algebra", answerForm: "factored" },
    ),

    // x⁴ + Bx² + C seen as a quadratic in x².
    T(
      "poly_factor_quadratic_form",
      "expression",
      (r) => {
        const tier = r.int(0, 2);
        const positive = [1, 2, 3, 5, 6, 7];
        let lead = 1; // a in (a·u + s1)
        let rootLead = 1; // √a
        let s1: number;
        let s2: number;
        let perfectSquare = false;
        if (tier === 0) {
          [s1, s2] = distinctInts(r, 2, 1, 7);
        } else if (tier === 1) {
          s1 = -(r.int(1, 4) ** 2);
          s2 = r.int(0, 1) === 0 ? r.pick(positive) : -(r.int(1, 4) ** 2);
          while (s2 === s1) s2 = -(r.int(1, 4) ** 2);
        } else if (r.int(0, 1) === 0) {
          // (x² − c²)², a perfect square in x².
          perfectSquare = true;
          s1 = -(r.int(1, 4) ** 2);
          s2 = s1;
        } else {
          // (j²x² − k²)(x² + s): non-monic.
          rootLead = r.pick([2, 3]);
          lead = rootLead * rootLead;
          let k = r.int(1, 4);
          while (gcdInt(k, rootLead) !== 1) k = r.int(1, 4);
          s1 = -(k * k);
          s2 = r.pick([1, 2, 3, 5, -1, -4]);
        }
        const poly = polyMul([lead, 0, s1], [1, 0, s2]);
        const factorStrings = (a: number, root: number, s: number): string => {
          // a·x² + s, with a = root².
          if (s < 0 && Number.isInteger(Math.sqrt(-s))) {
            const k = Math.sqrt(-s);
            return `(${polyAns([root, -k])})(${polyAns([root, k])})`;
          }
          return `(${polyAns([a, 0, s])})`;
        };
        const quadAns = (a: number, s: number) => `(${polyAns([a, 0, s])})`;
        let answer: string;
        let substituted: string;
        if (perfectSquare) {
          const k = Math.sqrt(-s1);
          answer = `(x-${k})^2(x+${k})^2`;
          substituted = `(x^2-${k * k})^2`;
        } else {
          answer = factorStrings(lead, rootLead, s1) + factorStrings(1, 1, s2);
          substituted = quadAns(lead, s1) + quadAns(1, s2);
        }
        const uFactored = perfectSquare
          ? `(u - ${-s1})^2`
          : `(${polyPlain([lead, s1]).replace("x", "u")})(${polyPlain([1, s2]).replace("x", "u")})`;
        const steps: WorkedStep[] = [
          {
            text: `Let u = x^2. Then it reads ${polyPlain([poly[0], poly[2], poly[4]]).replace(/x/g, "u")}.`,
            blankText: "Substitute u = x^2: ?",
          },
          {
            text: `Factor it as a quadratic in u: ${uFactored}.`,
            blankText: "Factor the quadratic in u: ?",
          },
        ];
        if (answer === substituted) {
          steps.push({
            text: `Put x^2 back for u. Neither factor splits further: ${answer}.`,
            blankText: "Replace u with x^2: ?",
          });
        } else {
          steps.push({
            text: `Put x^2 back for u: ${substituted}.`,
            blankText: "Replace u with x^2: ?",
          });
          steps.push({
            text: `Factor each difference of squares: ${answer}.`,
            blankText: "Factor every difference of squares: ?",
          });
        }
        return {
          stem: `Factor completely: ${tex(polyTex(poly))}.`,
          answer: exprAns(answer),
          ...withWorkedSteps(steps),
        };
      },
      { answerPalette: "algebra", answerForm: "factored" },
    ),

    // Long division. Mostly exact (answer = quotient); one tier has a
    // remainder and asks for the remainder alone or the quotient alone.
    T(
      "poly_long_division",
      "expression",
      (r) => {
        const tier = r.int(0, 2);
        let divisor: number[];
        let quotient: number[];
        let remainder = 0;
        if (tier === 0) {
          divisor = [1, nonzero(r, -5, 5)];
          quotient = [1, r.int(-5, 5), nonzero(r, -6, 6)];
          // A third of the time, make the dividend's x² term vanish so a
          // placeholder 0 is needed.
          if (r.int(0, 2) === 0) quotient[1] = -divisor[1];
        } else if (tier === 1) {
          if (r.int(0, 1) === 0) {
            const [m, n] = nonMonicLinear(r);
            divisor = [m, n];
            quotient = [r.int(1, 3), r.int(-4, 4), nonzero(r, -5, 5)];
          } else {
            divisor = [1, 0, r.pick([1, 2, 3, -2, -3])];
            quotient = [1, r.int(-4, 4), nonzero(r, -5, 5)];
          }
        } else {
          divisor = [1, nonzero(r, -4, 4)];
          quotient = [r.int(1, 2), r.int(-4, 4), r.int(-5, 5)];
          remainder = nonzero(r, -9, 9);
        }
        const dividend = polyAdd(polyMul(quotient, divisor), [remainder]);
        const { q, r: rem, cycles } = polyDivide(dividend, divisor);
        const ask = tier === 2 ? (r.int(0, 1) === 0 ? "remainder" : "quotient") : "quotient";
        const lead = `Divide ${tex(polyTex(dividend))} by ${tex(polyTex(divisor))} using long division.`;
        const steps = cycles.map((cycle, i) =>
          divisionCycleStep(cycle, divisor, i === cycles.length - 1, ask === "remainder"),
        );
        if (ask === "remainder") {
          return {
            stem: `${lead} The division leaves a remainder. What is the remainder?`,
            answerType: "integer" as const,
            answer: intAns(remainder),
            ...withWorkedSteps(steps),
          };
        }
        steps.push({
          text: `Put the quotient terms together${remainder !== 0 ? ` (the remainder ${polyPlain(rem)} is not part of it)` : ""}: ${polyAns(q)}.`,
          blankText: "Put the quotient terms together: ?",
        });
        return {
          stem:
            remainder !== 0
              ? `${lead} There is a remainder. Write the quotient only, without the remainder.`
              : `${lead} Write the quotient.`,
          answer: exprAns(polyAns(quotient)),
          ...withWorkedSteps(steps),
        };
      },
      { answerPalette: "algebra", answerForm: "expanded" },
    ),

    // Synthetic division by x − a.
    T(
      "poly_synthetic_division",
      "expression",
      (r) => {
        const tier = r.int(0, 2);
        const a = nonzero(r, -5, 5);
        let quotient: number[];
        let remainder = 0;
        if (tier === 0) {
          quotient = [1, r.int(-5, 5), nonzero(r, -6, 6)];
        } else if (tier === 1) {
          quotient = [r.int(1, 2), r.int(-4, 4), r.int(-4, 4), nonzero(r, -5, 5)];
          // Make one middle term of the dividend vanish (needs a 0 placeholder).
          quotient[2] = quotient[1] * a;
        } else {
          quotient = [r.int(1, 2), r.int(-4, 4), r.int(-5, 5)];
          remainder = nonzero(r, -9, 9);
        }
        const dividend = polyAdd(polyMul(quotient, [1, -a]), [remainder]);
        const coefficients = [...dividend];
        const row = syntheticRow(coefficients, a);
        const ask = tier === 2 ? (r.int(0, 1) === 0 ? "remainder" : "quotient") : "quotient";
        const hasZero = coefficients.slice(1).includes(0);
        const columns = row
          .slice(1, -1)
          .map((v, i) => `${coefficients[i + 1]} + (${a})(${row[i]}) = ${v}`)
          .join("; ");
        const last = coefficients.length - 1;
        const steps: WorkedStep[] = [
          {
            text: `Use a = ${a} (from x ${a > 0 ? "-" : "+"} ${Math.abs(a)}) and the coefficients ${coefficients.join(", ")}${hasZero ? " (0 holds the missing power's place)" : ""}.`,
            blankText: "Write a and the coefficients, with 0 for any missing power: ?",
          },
          {
            text: `Bring down ${row[0]}, then multiply by ${a} and add down each column: ${columns}.`,
            blankText: `Bring down the first coefficient, then multiply by ${a} and add: ?`,
          },
          {
            text: `Last column: ${coefficients[last]} + (${a})(${row[last - 1]}) = ${row[last]}, the remainder.`,
            blankText: "Finish the last column to get the remainder: ?",
          },
        ];
        const lead = `Use synthetic division to divide ${tex(polyTex(dividend))} by ${tex(polyTex([1, -a]))}.`;
        if (ask === "remainder") {
          return {
            stem: `${lead} What is the remainder?`,
            answerType: "integer" as const,
            answer: intAns(remainder),
            ...withWorkedSteps(steps),
          };
        }
        steps.push({
          text: `The other numbers ${row.slice(0, -1).join(", ")} are the quotient's coefficients, one power lower: ${polyAns(quotient)}.`,
          blankText: "Read the quotient from the bottom row: ?",
        });
        return {
          stem:
            remainder !== 0
              ? `${lead} There is a remainder. Write the quotient only, without the remainder.`
              : `${lead} Write the quotient.`,
          answer: exprAns(polyAns(quotient)),
          ...withWorkedSteps(steps),
        };
      },
      { answerPalette: "algebra", answerForm: "expanded" },
    ),

    // The Remainder Theorem: the remainder on dividing by x − a is p(a); and
    // its converse in use — find k so that x − a is a factor.
    T("poly_remainder_theorem", "integer", (r) => {
      const tier = r.int(0, 2);
      const a = tier === 0 ? nonzero(r, -3, 3) : nonzero(r, -4, 4);
      if (tier === 2) {
        const k = nonzero(r, -5, 5);
        const b = r.int(-6, 6);
        const c = -(a ** 3 + k * a * a + b * a);
        const tail = polyTex([b, c]);
        const pTex =
          tail === "0" ? "x^{3} + kx^{2}" : tail.startsWith("-") ? `x^{3} + kx^{2} - ${tail.slice(1)}` : `x^{3} + kx^{2} + ${tail}`;
        const known = a ** 3 + b * a + c;
        return {
          stem: `For what value of k is ${tex(polyTex([1, -a]))} a factor of ${tex(`p(x) = ${pTex}`)}?`,
          answer: intAns(k),
          ...withWorkedSteps([
            {
              text: `x ${a > 0 ? "-" : "+"} ${Math.abs(a)} is a factor exactly when p(${a}) = 0.`,
              blankText: "Use the Factor Theorem: ?",
            },
            {
              text: `p(${a}) = ${a ** 3} + ${a * a}k${b * a === 0 ? "" : b * a < 0 ? ` - ${-b * a}` : ` + ${b * a}`}${c === 0 ? "" : c < 0 ? ` - ${-c}` : ` + ${c}`} = ${a * a}k ${known < 0 ? "-" : "+"} ${Math.abs(known)}.`,
              blankText: `Substitute x = ${a} into p(x): ?`,
            },
            {
              text: `Solve ${a * a}k ${known < 0 ? "-" : "+"} ${Math.abs(known)} = 0: k = ${k}.`,
              blankText: `Set p(${a}) = 0 and solve for k: ?`,
            },
          ]),
        };
      }
      const coefficients =
        tier === 0
          ? [r.pick([1, 1, 2]), r.int(-5, 5), r.int(-6, 6), r.int(-9, 9)]
          : [1, r.int(-3, 3), r.int(-5, 5), r.int(-6, 6), r.int(-9, 9)];
      // A quarter of the time the remainder is 0: x − a is a factor.
      if (r.int(0, 3) === 0) coefficients[coefficients.length - 1] -= evalPoly(coefficients, a);
      const value = evalPoly(coefficients, a);
      const degree = coefficients.length - 1;
      const termValues = coefficients.map((c, i) => c * a ** (degree - i));
      return {
        stem: `Use the Remainder Theorem: what is the remainder when ${tex(`p(x) = ${polyTex(coefficients)}`)} is divided by ${tex(polyTex([1, -a]))}?`,
        answer: intAns(value),
        ...withWorkedSteps([
          {
            text: `The remainder on dividing by x ${a > 0 ? "-" : "+"} ${Math.abs(a)} is p(${a}).`,
            blankText: "Name the value the Remainder Theorem gives: ?",
          },
          {
            text: `Evaluate each term at x = ${a}: ${termValues.join(", ")}.`,
            blankText: `Evaluate each term at x = ${a}: ?`,
          },
          {
            text: `Add them: ${signedSum(termValues)} = ${value}.`,
            blankText: "Add the term values: ?",
          },
        ]),
      };
    }),

    // A known zero → a linear factor → divide → finish the quadratic.
    T(
      "poly_factor_theorem",
      "expression",
      (r) => {
        const tier = r.int(0, 2);
        let given: [number, number]; // the factor (mx + n) the zero names
        let rest: number[][]; // the other factors, as coefficient lists
        let restAns: string;
        let quadNote: string;
        let repeated = false;
        const zeroGiven = r.int(-4, 4);
        if (tier === 0) {
          given = [1, -zeroGiven];
          const [b, c] = distinctInts(r, 2, -6, 6, [zeroGiven]);
          rest = [[1, -b], [1, -c]];
          restAns = `${linAns(1, -b)}${linAns(1, -c)}`;
          quadNote = `Factor it: ${restAns}.`;
        } else if (tier === 1) {
          given = [1, -zeroGiven];
          if (r.int(0, 1) === 0) {
            const [m, n] = nonMonicLinear(r);
            const c = distinctInts(r, 1, -5, 5, [zeroGiven])[0];
            rest = [[m, n], [1, -c]];
            restAns = `${linAns(m, n)}${linAns(1, -c)}`;
            quadNote = `Factor it: ${restAns}.`;
          } else {
            const s = r.pick([1, 2, 3, 4, 5]);
            rest = [[1, 0, s]];
            restAns = `(x^2+${s})`;
            quadNote = `x^2 + ${s} is never 0 for real x, so it does not factor further.`;
          }
        } else if (r.int(0, 1) === 0) {
          // The given zero is a fraction.
          const [m, n] = nonMonicLinear(r);
          given = [m, n];
          const [b, c] = distinctInts(r, 2, -5, 5);
          rest = [[1, -b], [1, -c]];
          restAns = `${linAns(1, -b)}${linAns(1, -c)}`;
          quadNote = `Factor it: ${restAns}.`;
        } else {
          // A repeated factor.
          repeated = true;
          given = [1, -zeroGiven];
          const b = distinctInts(r, 1, -5, 5, [zeroGiven])[0];
          rest = r.int(0, 1) === 0 ? [[1, -zeroGiven], [1, -b]] : [[1, -b], [1, -b]];
          restAns =
            rest[0][1] === rest[1][1]
              ? `${linAns(1, -b)}^2`
              : `${linAns(1, -zeroGiven)}${linAns(1, -b)}`;
          quadNote = `Factor it: ${restAns}.`;
        }
        const restPoly = rest.reduce((acc, f) => polyMul(acc, f), [1]);
        const poly = polyMul(given, restPoly);
        const givenAns = linAns(given[0], given[1]);
        // Merge a repeated given factor into one power.
        let answer = `${givenAns}${restAns}`;
        if (repeated && rest[0][1] === given[1] && rest[1][1] !== given[1]) {
          answer = `${givenAns}^2${linAns(1, rest[1][1])}`;
        }
        const zero = zeroOf(given[0], given[1]);
        const zeroTex = zero.includes("/")
          ? `${zero.startsWith("-") ? "-" : ""}\\frac{${zero.replace("-", "").split("/")[0]}}{${zero.split("/")[1]}}`
          : zero;
        const { q } = polyDivide(poly, given);
        return {
          stem: `${tex(`x = ${zeroTex}`)} is a zero of ${tex(`p(x) = ${polyTex(poly)}`)}. Factor ${tex("p(x)")} completely.`,
          answer: exprAns(answer),
          ...withWorkedSteps([
            {
              text: `x = ${zero} is a zero, so ${givenAns} is a factor.`,
              blankText: "Turn the zero into a factor: ?",
            },
            {
              text: `Divide p(x) by ${givenAns}: the quotient is ${polyPlain(q)}.`,
              blankText: `Divide p(x) by ${givenAns}: ?`,
            },
            { text: quadNote, blankText: `Factor ${polyPlain(q)} if it splits: ?` },
            {
              text: `Write every factor together: ${answer}.`,
              blankText: "Write p(x) as a product of all its factors: ?",
            },
          ]),
        };
      },
      { answerPalette: "algebra", answerForm: "factored" },
    ),

    // Solve degree 3–4 equations by factoring. Repeated roots are listed
    // once; some draws have an irrational pair, some a complex pair.
    T(
      "poly_solve_higher_degree",
      "solutionSet",
      (r) => {
        const tier = r.int(0, 2);
        const pick = r.int(0, 1);
        let poly: number[];
        let rhsTex = "0";
        let lhsTex: string;
        let members: string[];
        const steps: WorkedStep[] = [];
        const done = (list: string[]) => ({
          text: `Solve each factor = 0 and list every solution once: ${list.join(", ")}.`,
          blankText: "Solve each factor = 0: ?",
        });
        if (tier === 0 && pick === 0) {
          // (x − a)(x² − k²), by grouping; or x³ = k²x.
          const k = r.int(1, 5);
          if (r.int(0, 2) === 0) {
            poly = [1, 0, -k * k, 0];
            lhsTex = "x^{3}";
            rhsTex = polyTex([k * k, 0]);
            members = ["0", String(k), String(-k)];
            steps.push({
              text: `Move everything to one side: x^3 - ${k * k}x = 0. (Don't divide by x: that loses x = 0.)`,
              blankText: "Move every term to one side: ?",
            });
            steps.push({
              text: `Factor: x(x^2 - ${k * k}) = x(x - ${k})(x + ${k}) = 0.`,
              blankText: "Factor out x, then the difference of squares: ?",
            });
          } else {
            const a = distinctInts(r, 1, -5, 5, [k, -k])[0];
            poly = polyMul([1, -a], [1, 0, -k * k]);
            lhsTex = polyTex(poly);
            members = [String(a), String(k), String(-k)];
            steps.push({
              text: `Group: x^2${linAns(1, -a)} - ${k * k}${linAns(1, -a)} = ${linAns(1, -a)}(x^2 - ${k * k}).`,
              blankText: "Factor by grouping: ?",
            });
            steps.push({
              text: `Factor the difference of squares: ${linAns(1, -a)}(x - ${k})(x + ${k}) = 0.`,
              blankText: "Factor completely: ?",
            });
          }
        } else if (tier === 0) {
          // x(x − a)² = 0: a repeated root.
          const a = nonzero(r, -6, 6);
          poly = polyMul([1, 0], expandRoots([a, a]));
          lhsTex = polyTex(poly);
          members = ["0", String(a)];
          steps.push({
            text: `Factor out x: x(${polyPlain(expandRoots([a, a]))}) = 0.`,
            blankText: "Factor out x: ?",
          });
          steps.push({
            text: `The trinomial is a perfect square: x${linAns(1, -a)}^2 = 0.`,
            blankText: "Factor the trinomial: ?",
          });
        } else if (tier === 1) {
          // (x − a)(x² ∓ m): an irrational pair or a complex pair.
          const a = r.int(-5, 5);
          const complex = pick === 1;
          const m = complex ? r.pick([1, 4, 9, 3, 2]) : r.pick([2, 3, 5, 6, 7]);
          const s = complex ? m : -m;
          poly = polyMul([1, -a], [1, 0, s]);
          lhsTex = polyTex(poly);
          const pair = complex
            ? Number.isInteger(Math.sqrt(m))
              ? Math.sqrt(m) === 1
                ? ["i", "-i"]
                : [`${Math.sqrt(m)}i`, `-${Math.sqrt(m)}i`]
              : [`i√${m}`, `-i√${m}`]
            : [`√${m}`, `-√${m}`];
          members = [String(a), ...pair];
          steps.push({
            text: a === 0
              ? `Factor out x: x(x^2 ${s < 0 ? "-" : "+"} ${m}) = 0.`
              : `Group: x^2${linAns(1, -a)} ${s < 0 ? "-" : "+"} ${m}${linAns(1, -a)} = ${linAns(1, -a)}(x^2 ${s < 0 ? "-" : "+"} ${m}) = 0.`,
            blankText: a === 0 ? "Factor out x: ?" : "Factor by grouping: ?",
          });
          steps.push({
            text: complex
              ? `x^2 + ${m} = 0 means x^2 = -${m}, so x = ±${pair[0]}.`
              : `x^2 - ${m} = 0 means x^2 = ${m}, so x = ±√${m}.`,
            blankText: "Solve the quadratic factor by square roots: ?",
          });
        } else {
          // Quartics in quadratic form: (x² − p²)(x² + s), or (x² − c²)².
          if (pick === 0) {
            const c = r.int(1, 4);
            poly = polyMul([1, 0, -c * c], [1, 0, -c * c]);
            lhsTex = polyTex(poly);
            members = [String(c), String(-c)];
            steps.push({
              text: `Let u = x^2: u^2 - ${2 * c * c}u + ${c ** 4} = (u - ${c * c})^2 = 0.`,
              blankText: "Substitute u = x^2 and factor: ?",
            });
            steps.push({
              text: `So x^2 = ${c * c}, and the factors are (x - ${c})^2(x + ${c})^2.`,
              blankText: "Put x^2 back and factor: ?",
            });
          } else {
            const p = r.int(1, 4);
            const s = r.pick([1, 4, 9, -2, -3, -5]);
            poly = polyMul([1, 0, -p * p], [1, 0, s]);
            lhsTex = polyTex(poly);
            const pair =
              s > 0 ? (s === 1 ? ["i", "-i"] : [`${Math.sqrt(s)}i`, `-${Math.sqrt(s)}i`]) : [`√${-s}`, `-√${-s}`];
            members = [String(p), String(-p), ...pair];
            steps.push({
              text: `Let u = x^2: ${polyPlain([1, s - p * p, -p * p * s]).replace(/x/g, "u")} = (u - ${p * p})(u ${s < 0 ? "-" : "+"} ${Math.abs(s)}) = 0.`,
              blankText: "Substitute u = x^2 and factor: ?",
            });
            steps.push({
              text: `Put x^2 back: (x^2 - ${p * p})(x^2 ${s < 0 ? "-" : "+"} ${Math.abs(s)}) = 0.`,
              blankText: "Replace u with x^2: ?",
            });
          }
        }
        steps.push(done(members));
        void poly;
        return {
          stem: `Solve ${tex(`${lhsTex} = ${rhsTex}`)}. Give every real and complex solution.`,
          answer: solutionSetAns(members),
          ...withWorkedSteps(steps),
        };
      },
      { answerPalette: "complex" },
    ),

    // (ax + b)ⁿ: full expansion for small n; one coefficient for larger n.
    T(
      "poly_binomial_expansion",
      "expression",
      (r) => {
        const tier = r.int(0, 2);
        if (tier === 2) {
          const n = r.int(5, 7);
          const a = r.pick([1, 1, 2]);
          const b = r.pick(a === 2 ? [1, -1] : n === 5 ? [1, 2, -1, -2, 3, -3] : [1, 2, -1, -2]);
          const j = r.int(1, n - 1); // power of x
          const C = binomial(n, j);
          const value = C * a ** j * b ** (n - j);
          const aTex = a === 1 ? "x" : `${a}x`;
          return {
            stem: `What is the coefficient of ${tex(j === 1 ? "x" : `x^{${j}}`)} in the expansion of ${tex(`(${polyTex([a, b])})^{${n}}`)}?`,
            answerType: "integer" as const,
            answer: intAns(value),
            ...withWorkedSteps([
              {
                text: `The x^${j} term has (${aTex})^${j} and (${b})^${n - j}; its Pascal's triangle entry is row ${n}, entry ${n - j} (counting from 0): ${C}.`,
                blankText: `Find the row ${n} entry for the x^${j} term: ?`,
              },
              {
                text: `So the term is ${C}(${aTex})^${j}(${b})^${n - j}.`,
                blankText: "Write the term with its powers: ?",
              },
              {
                text: `Multiply the numbers: ${C} · ${a ** j} · ${paren(b ** (n - j))} = ${value}.`,
                blankText: `Multiply ${C} · ${a}^${j} · (${b})^${n - j}: ?`,
              },
            ]),
          };
        }
        const twoVariables = tier === 1 && r.int(0, 2) === 0;
        const n = tier === 0 ? r.int(3, 4) : 3;
        const a = tier === 0 ? 1 : twoVariables ? 1 : r.pick([2, 3]);
        const b = tier === 0 ? nonzero(r, -3, 3) : nonzero(r, -3, 3);
        const row = Array.from({ length: n + 1 }, (_, k) => binomial(n, k));
        const second = twoVariables ? (b === 1 ? "y" : b === -1 ? "-y" : `${b}y`) : String(b);
        const first = a === 1 ? "x" : `${a}x`;
        const coefficients = row.map((C, k) => C * a ** (n - k) * b ** k);
        let answer: string;
        let termsPlain: string[];
        if (twoVariables) {
          const parts = coefficients.map((c, k) => {
            const xs = n - k === 0 ? "" : n - k === 1 ? "x" : `x^${n - k}`;
            const ys = k === 0 ? "" : k === 1 ? "y" : `y^${k}`;
            const mag = Math.abs(c) === 1 ? "" : String(Math.abs(c));
            return { neg: c < 0, body: `${mag}${xs}${ys}` };
          });
          answer = parts.map((p, i) => (i === 0 ? (p.neg ? "-" : "") : p.neg ? "-" : "+") + p.body).join("");
          termsPlain = parts.map((p) => (p.neg ? "-" : "") + p.body);
        } else {
          answer = polyAns(coefficients);
          termsPlain = coefficients.map((c, k) => monoPlain(c, n - k));
        }
        const stemBinomial = twoVariables
          ? `(x ${b < 0 ? "-" : "+"} ${Math.abs(b) === 1 ? "" : Math.abs(b)}y)^{${n}}`
          : `(${polyTex([a, b])})^{${n}}`;
        return {
          stem: `Expand ${tex(stemBinomial)}. Combine like terms.`,
          answer: exprAns(answer),
          ...withWorkedSteps([
            {
              text: `Row ${n} of Pascal's triangle: ${row.join(", ")}.`,
              blankText: `Write row ${n} of Pascal's triangle: ?`,
            },
            {
              text: `Pair each entry with powers: ${row
                .map((C, k) => `${C}(${first})^${n - k}(${second})^${k}`)
                .join(" + ")}.`,
              blankText: `Pair each entry with falling powers of ${first} and rising powers of ${second}: ?`,
            },
            {
              text: `Simplify each term: ${termsPlain.join(", ")}.`,
              blankText: "Simplify each term: ?",
            },
            {
              text: `Add the terms: ${answer}.`,
              blankText: "Add the simplified terms: ?",
            },
          ]),
        };
      },
      { answerPalette: "algebra", answerForm: "expanded" },
    ),
  ];
}
