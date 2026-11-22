/**
 * Algebra 2 — complex numbers and quadratics (strand `complex-quadratics`).
 *
 * Every family draws its answer first and builds the question from it, so the
 * answer is correct by construction. Complex answers are typed in a + bi form
 * (`complexStandard`); a value-equal answer in another shape gets the grader's
 * no-penalty form nudge, not a miss.
 *
 * Not templated here: `cx_plane_plot` and `quad_inequality`, which need prompt
 * visuals another lane is building.
 */
import type { WorkedStep } from "../fadedSteps";
import type { Algebra2Kit, Rng, Template } from "../templates";
import { complexAns, complexTex, fracTex, polyAns, polyTex, tex } from "./format";

// ── Small exact-arithmetic helpers ───────────────────────────────────────────

function gcd(a: number, b: number): number {
  let x = Math.abs(a);
  let y = Math.abs(b);
  while (y) [x, y] = [y, x % y];
  return x;
}

/** A reduced fraction n/d with d > 0. */
function reduce(n: number, d: number): [number, number] {
  const g = gcd(n, d) || 1;
  const sign = d < 0 ? -1 : 1;
  return [(sign * n) / g, (sign * d) / g];
}

/** Answer-grammar rational: `3`, `-3/2`. */
function ratAns(n: number, d: number): string {
  const [rn, rd] = reduce(n, d);
  return rd === 1 ? String(rn) : `${rn}/${rd}`;
}

/** LaTeX rational: `3`, `-\frac{3}{2}`. */
function ratTex(n: number, d: number): string {
  const [rn, rd] = reduce(n, d);
  if (rd === 1) return String(rn);
  return `${rn < 0 ? "-" : ""}${fracTex(Math.abs(rn), rd)}`;
}

/** a + bi with rational parts in a + bi form: `-1/2+(3/2)i`, `2-i`, `(3/5)i`. */
function complexRatAns(reN: number, reD: number, imN: number, imD: number): string {
  const [rn, rd] = reduce(reN, reD);
  const [inn, ind] = reduce(imN, imD);
  if (rd === 1 && ind === 1) return complexAns(rn, inn);
  const re = rn === 0 ? "" : ratAns(rn, rd);
  if (inn === 0) return re === "" ? "0" : re;
  const magnitude =
    ind === 1 ? `${Math.abs(inn) === 1 ? "" : Math.abs(inn)}i` : `(${Math.abs(inn)}/${ind})i`;
  const sign = inn < 0 ? "-" : re === "" ? "" : "+";
  return `${re}${sign}${magnitude}`;
}

/** Signed sum for worked-step prose: [[8,""],[-2,"i"],[12,"i"],[-3,"i^2"]] →
 *  `8 - 2i + 12i - 3i^2`. A coefficient of ±1 hides before a unit. */
function terms(parts: ReadonlyArray<readonly [number, string]>): string {
  let out = "";
  for (const [coefficient, unit] of parts) {
    if (coefficient === 0) continue;
    const magnitude = Math.abs(coefficient);
    const body = (magnitude === 1 && unit !== "" ? "" : String(magnitude)) + unit;
    if (out === "") out = (coefficient < 0 ? "-" : "") + body;
    else out += (coefficient < 0 ? " - " : " + ") + body;
  }
  return out === "" ? "0" : out;
}

/** `(x - 3)`, `(x + 2)`, or bare `x` for 0 — worked-step prose. */
function xMinus(root: number): string {
  return root === 0 ? "x" : root > 0 ? `(x - ${root})` : `(x + ${-root})`;
}

/** A nonzero integer in [-max, -min] ∪ [min, max]. */
/** How many random draws a retry makes before its fallback. Tests set it to
 *  0 to serve (and check) every fallback. */
export const CX_DRAW = { attempts: 20 };

function signedInt(r: Rng, min: number, max: number): number {
  const n = r.int(min, max);
  return r.int(0, 1) === 0 ? n : -n;
}

const SQUAREFREE = [2, 3, 5, 6, 7];

/** `ki√m` (or `ki`, `i√m`) in the answer grammar. */
function imagSurdAns(k: number, m: number): string {
  const lead = k === 1 ? "" : k === -1 ? "-" : String(k);
  return m === 1 ? `${lead}i` : `${lead}i√${m}`;
}

/** The value i^n as an integer pair [re, im]. */
function iPower(n: number): [number, number] {
  const cycle: Array<[number, number]> = [
    [1, 0],
    [0, 1],
    [-1, 0],
    [0, -1],
  ];
  return cycle[((n % 4) + 4) % 4];
}

function complexMul(a: number, b: number, c: number, d: number): [number, number] {
  return [a * c - b * d, a * d + b * c];
}

/** Parenthesised a + bi for a stem span. */
function cxParen(re: number, im: number): string {
  return `(${complexTex(re, im)})`;
}

export function complexQuadraticsTemplates(kit: Algebra2Kit): Template[] {
  const { T, exprAns, solutionSetAns, withWorkedSteps } = kit;

  // ── cx_imaginary_unit ─────────────────────────────────────────────────────
  // Face A: √(−n) → i√n (tier 2: the √−a·√−b trap, whose answer is negative).
  // Face B: powers of i through the four-step cycle.
  const imaginaryUnit = T(
    "cx_imaginary_unit",
    "expression",
    (r) => {
      const tier = r.int(0, 2);
      if (r.int(0, 1) === 0) {
        if (tier === 0) {
          const k = r.int(2, 12);
          const n = k * k;
          return {
            stem: `Write ${tex(`\\sqrt{-${n}}`)} using i.`,
            answer: exprAns(imagSurdAns(k, 1)),
            answerForm: "simplifiedRadical" as const,
            ...withWorkedSteps([
              { text: `Split off the -1: √(-${n}) = √(-1)·√${n} = i√${n}.`, blankText: "Split off the -1: ?" },
              { text: `${n} is a perfect square: ${n} = ${k}^2.`, blankText: `Write ${n} as a square: ?` },
              {
                text: `√${n} = ${k}, so √(-${n}) = ${imagSurdAns(k, 1)}.`,
                blankText: `Take the square root of ${n} and attach the i: ?`,
              },
            ]),
          };
        }
        if (tier === 1) {
          const m = r.pick(SQUAREFREE);
          const k = r.int(1, 5);
          const n = k * k * m;
          const answer = imagSurdAns(k, m);
          const steps: WorkedStep[] = [
            { text: `Split off the -1: √(-${n}) = i√${n}.`, blankText: "Split off the -1: ?" },
          ];
          if (k > 1) {
            steps.push({
              text: `Find the largest square factor of ${n}: ${n} = ${k * k}·${m}.`,
              blankText: `Find the largest square factor of ${n}: ?`,
            });
            steps.push({
              text: `Take its square root out of the radical: i√${n} = ${answer}.`,
              blankText: "Take the square root of the square factor out: ?",
            });
          } else {
            steps.push({
              text: `Look for a square factor of ${n}: there is none, so √${n} is already simplified.`,
              blankText: `Look for a square factor of ${n}: ?`,
            });
            steps.push({
              text: `So √(-${n}) = ${answer}.`,
              blankText: "Write the simplified answer: ?",
            });
          }
          return {
            stem: `Write ${tex(`\\sqrt{-${n}}`)} using i. Simplify the radical.`,
            answer: exprAns(answer),
            answerForm: "simplifiedRadical" as const,
            ...withWorkedSteps(steps),
          };
        }
        // √(−p·s1²)·√(−p·s2²) = (s1 i√p)(s2 i√p) = −p·s1·s2.
        const p = r.pick([1, 1, 2, 3, 5]);
        const s1 = r.int(1, 4);
        let s2 = r.int(1, 4);
        if (p === 1 && s1 === s2) s2 = s1 === 4 ? 3 : s1 + 1;
        const a = p * s1 * s1;
        const b = p * s2 * s2;
        const value = -p * s1 * s2;
        const left = imagSurdAns(s1, p);
        const right = imagSurdAns(s2, p);
        return {
          stem: `Simplify ${tex(`\\sqrt{-${a}} \\cdot \\sqrt{-${b}}`)}.`,
          answer: exprAns(String(value)),
          answerForm: "simplifiedRadical" as const,
          ...withWorkedSteps([
            {
              text: `Write each root with i before multiplying: √(-${a}) = ${left} and √(-${b}) = ${right}.`,
              blankText: "Write each root with i first: ?",
            },
            {
              text:
                p === 1
                  ? `Multiply: (${left})(${right}) = ${s1 * s2}i^2.`
                  : `Multiply: (${left})(${right}) = ${s1 * s2}·(√${p})^2·i^2 = ${p * s1 * s2}i^2.`,
              blankText: "Multiply the two numbers: ?",
            },
            {
              text: `Replace i^2 with -1: ${p * s1 * s2}i^2 = ${value}.`,
              blankText: "Replace i^2 with -1: ?",
            },
          ]),
        };
      }
      // Face B — powers of i.
      const cycleStep: WorkedStep = {
        text: "The powers of i repeat every 4: i^1 = i, i^2 = -1, i^3 = -i, i^4 = 1.",
        blankText: "Recall the cycle of powers of i: ?",
      };
      if (tier < 2 || r.int(0, 1) === 0) {
        const n = tier === 0 ? r.int(5, 15) : tier === 1 ? r.int(20, 120) : -r.int(1, 15);
        const [re, im] = iPower(n);
        const answer = complexAns(re, im);
        const reduced = ((n % 4) + 4) % 4;
        const middle: WorkedStep =
          n > 0
            ? {
                text: `Divide the exponent by 4: ${n} = 4·${Math.floor(n / 4)} + ${reduced}, remainder ${reduced}.`,
                blankText: `Find the remainder of ${n} ÷ 4: ?`,
              }
            : {
                text: `Add a multiple of 4 to make the exponent positive (or zero): ${n} + ${4 * Math.ceil(-n / 4)} = ${reduced}.`,
                blankText: "Add a multiple of 4 to the exponent: ?",
              };
        return {
          stem: `Simplify ${tex(`i^{${n}}`)}.`,
          answer: exprAns(answer),
          answerForm: "complexStandard" as const,
          ...withWorkedSteps([
            cycleStep,
            middle,
            { text: `So i^${n} = i^${reduced} = ${answer}.`, blankText: `Use the cycle for i^${reduced}: ?` },
          ]),
        };
      }
      // i^a + i^b, two different powers whose values do not cancel.
      const a = r.int(10, 60);
      let b = r.int(10, 60);
      if (b === a) b += 4;
      if ((((b - a) % 4) + 4) % 4 === 2) b += 1;
      const [ar, ai] = iPower(a);
      const [br, bi] = iPower(b);
      const answer = complexAns(ar + br, ai + bi);
      return {
        stem: `Simplify ${tex(`i^{${a}} + i^{${b}}`)}. Write it in the form a + bi.`,
        answer: exprAns(answer),
        answerForm: "complexStandard" as const,
        ...withWorkedSteps([
          cycleStep,
          {
            text: `${a} has remainder ${a % 4} and ${b} has remainder ${b % 4} when divided by 4, so i^${a} = ${complexAns(ar, ai)} and i^${b} = ${complexAns(br, bi)}.`,
            blankText: "Reduce each power with the cycle: ?",
          },
          {
            text: `Add: (${complexAns(ar, ai)}) + (${complexAns(br, bi)}) = ${answer}.`,
            blankText: "Add the two values: ?",
          },
        ]),
      };
    },
    { answerPalette: "complex" },
  );

  // ── cx_add_subtract ───────────────────────────────────────────────────────
  const addSubtract = T(
    "cx_add_subtract",
    "expression",
    (r) => {
      const tier = r.int(0, 2);
      {
        // Raw parameters only; the fallback (both parts nonzero for every
        // tier) goes through the same arithmetic below.
        let raw = { a: 3, b: 2, c: 1, d: 4, k: tier === 2 ? 2 : 1, m: tier === 2 ? 3 : 1, subtract: tier !== 0 };
        for (let tries = 0; tries < CX_DRAW.attempts; tries++) {
          const q = {
            a: signedInt(r, 1, 9),
            b: signedInt(r, 1, 9),
            c: signedInt(r, 1, 9),
            d: signedInt(r, 1, 9),
            k: tier === 2 ? r.int(2, 4) : 1,
            m: tier === 2 ? r.pick([1, 2, 3]) : 1,
            subtract: tier === 0 ? r.int(0, 2) === 0 : true,
          };
          const s = q.subtract ? -1 : 1;
          if (q.k * q.a + s * q.m * q.c !== 0 && q.k * q.b + s * q.m * q.d !== 0) {
            raw = q;
            break;
          }
        }
        const { a, b, c, d, k, m, subtract } = raw;
        const sign = subtract ? -1 : 1;
        const re = k * a + sign * m * c;
        const im = k * b + sign * m * d;
        const answer = complexAns(re, im);
        const lead = k === 1 ? "" : String(k);
        const mult = m === 1 ? "" : String(m);
        const stem = `Simplify ${tex(`${lead}${cxParen(a, b)} ${subtract ? "-" : "+"} ${mult}${cxParen(c, d)}`)}. Write it in the form a + bi.`;
        const opened = terms([
          [k * a, ""],
          [k * b, "i"],
          [sign * m * c, ""],
          [sign * m * d, "i"],
        ]);
        return {
          stem,
          answer: exprAns(answer),
          ...withWorkedSteps([
            {
              text:
                subtract || k !== 1 || m !== 1
                  ? `Remove the parentheses, multiplying through and changing signs where needed: ${opened}.`
                  : `Remove the parentheses: ${opened}.`,
              blankText: "Remove the parentheses: ?",
            },
            {
              text: `Combine the real parts: ${terms([
                [k * a, ""],
                [sign * m * c, ""],
              ])} = ${re}.`,
              blankText: "Combine the real parts: ?",
            },
            {
              text: `Combine the imaginary parts: ${terms([
                [k * b, "i"],
                [sign * m * d, "i"],
              ])} = ${complexAns(0, im)}, so the answer is ${answer}.`,
              blankText: "Combine the imaginary parts and write a + bi: ?",
            },
          ]),
        };
      }
    },
    { answerPalette: "complex", answerForm: "complexStandard" },
  );

  // ── cx_multiply ───────────────────────────────────────────────────────────
  const multiply = T(
    "cx_multiply",
    "expression",
    (r) => {
      const tier = r.int(0, 2);
      if (tier === 0) {
        // bi(c + di) or k(c + di)·i-free monomial times binomial.
        const b = signedInt(r, 2, 6);
        const c = signedInt(r, 1, 7);
        const d = signedInt(r, 1, 7);
        const [re, im] = complexMul(0, b, c, d);
        const answer = complexAns(re, im);
        const bi = complexAns(0, b);
        return {
          stem: `Multiply ${tex(`${bi}${cxParen(c, d)}`)}. Write it in the form a + bi.`,
          answer: exprAns(answer),
          ...withWorkedSteps([
            {
              text: `Distribute: ${bi}·${c < 0 ? `(${c})` : c} + ${bi}·${d < 0 ? `(${complexAns(0, d)})` : complexAns(0, d)} = ${terms([
                [b * c, "i"],
                [b * d, "i^2"],
              ])}.`,
              blankText: `Distribute ${bi}: ?`,
            },
            {
              text: `Replace i^2 with -1: ${b * d}i^2 = ${-b * d}.`,
              blankText: "Replace i^2 with -1: ?",
            },
            {
              text: `Write the real part first: ${answer}.`,
              blankText: "Write it as a + bi: ?",
            },
          ]),
        };
      }
      let a: number;
      let b: number;
      let c: number;
      let d: number;
      let kind: "general" | "conjugate" | "square" = "general";
      if (tier === 1) {
        a = signedInt(r, 1, 6);
        b = signedInt(r, 1, 6);
        c = signedInt(r, 1, 6);
        d = signedInt(r, 1, 6);
      } else {
        kind = r.int(0, 1) === 0 ? "conjugate" : "square";
        a = signedInt(r, 1, 7);
        b = signedInt(r, 1, 7);
        c = a;
        d = kind === "conjugate" ? -b : b;
      }
      const [re, im] = complexMul(a, b, c, d);
      const answer = complexAns(re, im);
      const stem =
        kind === "square"
          ? `Simplify ${tex(`${cxParen(a, b)}^{2}`)}. Write it in the form a + bi.`
          : `Multiply ${tex(`${cxParen(a, b)}${cxParen(c, d)}`)}. Write it in the form a + bi.`;
      return {
        stem,
        answer: exprAns(answer),
        ...withWorkedSteps([
          {
            text: `Multiply every pair of terms: (${complexAns(a, b)})(${complexAns(c, d)}) = ${terms([
              [a * c, ""],
              [a * d, "i"],
              [b * c, "i"],
              [b * d, "i^2"],
            ])}.`,
            blankText: "Multiply every pair of terms: ?",
          },
          {
            text: `Replace i^2 with -1: ${b * d}i^2 = ${-b * d}.`,
            blankText: "Replace i^2 with -1: ?",
          },
          {
            text: `Combine the real parts (${a * c} + ${-b * d} = ${re}) and the imaginary parts (${a * d} + ${b * c} = ${im}): ${answer}.`,
            blankText: "Combine the real parts and the imaginary parts: ?",
          },
        ]),
      };
    },
    { answerPalette: "complex", answerForm: "complexStandard" },
  );

  // ── cx_divide ─────────────────────────────────────────────────────────────
  const divide = T(
    "cx_divide",
    "expression",
    (r) => {
      const tier = r.int(0, 2);
      if (tier === 0) {
        // (a + bi) / (ki): multiply top and bottom by i.
        const k = signedInt(r, 2, 5);
        const qr = signedInt(r, 1, 6);
        const qi = signedInt(r, 1, 6);
        const [nr, ni] = complexMul(qr, qi, 0, k);
        const answer = complexAns(qr, qi);
        const top = complexMul(nr, ni, 0, 1);
        return {
          stem: `Divide ${tex(fracTex(complexTex(nr, ni), complexTex(0, k)))}. Write it in the form a + bi.`,
          answer: exprAns(answer),
          ...withWorkedSteps([
            {
              text: "Multiply the top and the bottom by i to clear i from the bottom.",
              blankText: "Choose what to multiply the top and bottom by: ?",
            },
            {
              text: `Bottom: ${complexAns(0, k)}·i = ${k}i^2 = ${-k}.`,
              blankText: "Multiply out the bottom: ?",
            },
            {
              text: `Top: (${complexAns(nr, ni)})·i = ${terms([
                [nr, "i"],
                [ni, "i^2"],
              ])} = ${complexAns(top[0], top[1])}.`,
              blankText: "Multiply out the top: ?",
            },
            {
              text: `Divide each part by ${-k}: ${answer}.`,
              blankText: `Divide each part by ${-k}: ?`,
            },
          ]),
        };
      }
      const c = signedInt(r, 1, tier === 1 ? 4 : 3);
      const d = signedInt(r, 1, tier === 1 ? 4 : 3);
      const modulus = c * c + d * d;
      let nr: number;
      let ni: number;
      if (tier === 1) {
        // An integer quotient: numerator = quotient × divisor.
        const qr = signedInt(r, 1, 5);
        const qi = signedInt(r, 1, 5);
        [nr, ni] = complexMul(qr, qi, c, d);
      } else {
        // A fractional quotient: draw the numerator and keep one with a
        // non-integer part.
        const fractional = (u: number, v: number) => {
          const [tr, ti] = complexMul(u, v, c, -d);
          return tr % modulus !== 0 || ti % modulus !== 0;
        };
        // Fallback: the first numerator, in order, whose quotient has a
        // non-integer part (1 + 2i always works for these divisors).
        nr = 1;
        ni = 2;
        for (let u = 1, found = false; u <= 9 && !found; u++)
          for (let v = 1; v <= 9 && !found; v++) if (fractional(u, v)) [nr, ni, found] = [u, v, true];
        for (let tries = 0; tries < CX_DRAW.attempts; tries++) {
          const u = signedInt(r, 1, 9);
          const v = signedInt(r, 1, 9);
          if (fractional(u, v)) {
            [nr, ni] = [u, v];
            break;
          }
        }
      }
      const [tr, ti] = complexMul(nr, ni, c, -d);
      const answer = complexRatAns(tr, modulus, ti, modulus);
      return {
        stem: `Divide ${tex(fracTex(complexTex(nr, ni), complexTex(c, d)))}. Write it in the form a + bi.`,
        answer: exprAns(answer),
        ...withWorkedSteps([
          {
            text: `Multiply the top and the bottom by the conjugate of the bottom, ${complexAns(c, -d)}.`,
            blankText: "Find the conjugate of the bottom: ?",
          },
          {
            text: `Bottom: (${complexAns(c, d)})(${complexAns(c, -d)}) = ${c * c} + ${d * d} = ${modulus}.`,
            blankText: "Multiply out the bottom: ?",
          },
          {
            text: `Top: (${complexAns(nr, ni)})(${complexAns(c, -d)}) = ${terms([
              [nr * c, ""],
              [-nr * d, "i"],
              [ni * c, "i"],
              [-ni * d, "i^2"],
            ])} = ${complexAns(tr, ti)}.`,
            blankText: "Multiply out the top, using i^2 = -1: ?",
          },
          {
            text: `Divide each part by ${modulus}: ${answer}.`,
            blankText: `Divide each part by ${modulus}: ?`,
          },
        ]),
      };
    },
    { answerPalette: "complex", answerForm: "complexStandard" },
  );

  /**
   * A quadratic from a conjugate pair of roots h ± k·i (complex) or h ± √m
   * (radical): (x − h)² − (root part)². The complex pair is served by
   * quad_complex_roots, where i is a prerequisite; quad_from_roots keeps the
   * radical pair, since it is reachable from factoring alone.
   */
  const conjugatePairQuadratic = (r: Rng, complex: boolean) => {
    const h = r.int(-5, 5);
    const k = complex ? r.int(1, 6) : 1;
    const m = complex ? 1 : r.pick(SQUAREFREE);
    const square = complex ? -k * k : m; // (k i)² or (√m)²
    const coefficients = [1, -2 * h, h * h - square];
    const answer = polyAns(coefficients);
    const part = complex ? complexAns(0, k) : `√${m}`;
    const partTex = complex ? complexTex(0, k) : `\\sqrt{${m}}`;
    const solutionsTex =
      h === 0
        ? `${tex(partTex)} and ${tex(`-${partTex}`)}`
        : `${tex(`${h} + ${partTex}`)} and ${tex(`${h} - ${partTex}`)}`;
    const shifted = h === 0 ? "x" : `(x ${h > 0 ? "-" : "+"} ${Math.abs(h)})`;
    return {
      stem: `A quadratic equation ${tex("p(x) = 0")} has solutions ${solutionsTex}, and ${tex("p")} has leading coefficient 1. Write ${tex("p(x)")} in expanded form.`,
      answer: exprAns(answer),
      ...withWorkedSteps([
        {
          text: `Group each factor as (x - h) minus or plus the other part: p(x) = (${shifted} - ${part})(${shifted} + ${part}).`,
          blankText: "Write the two factors as a difference and a sum: ?",
        },
        {
          text: `That is a difference of squares: ${shifted}^2 - (${part})^2.`,
          blankText: "Use (A - B)(A + B) = A^2 - B^2: ?",
        },
        {
          text: `${shifted}^2 = ${polyAns([1, -2 * h, h * h])} and (${part})^2 = ${square}.`,
          blankText: "Square each part: ?",
        },
        {
          text: `Subtract: ${polyAns([1, -2 * h, h * h])} - (${square}) = ${answer}.`,
          blankText: "Subtract and combine like terms: ?",
        },
      ]),
    };
  };

  // ── quad_complex_roots ────────────────────────────────────────────────────
  const complexRoots = T(
    "quad_complex_roots",
    "solutionSet",
    (r) => {
      // One draw in five runs it backwards: write the quadratic whose solutions
      // are a given complex-conjugate pair (an expanded polynomial, not a set).
      if (r.int(0, 4) === 0) {
        return { ...conjugatePairQuadratic(r, true), answerType: "expression" as const, answerForm: "expanded" as const };
      }
      const tier = r.int(0, 2);
      if (tier === 0) {
        // x² + n = 0 or (x − h)² + k² = 0: take square roots.
        if (r.int(0, 1) === 0) {
          const m = r.pick([1, 1, 2, 3, 5]);
          const k = r.int(m === 1 ? 2 : 1, m === 1 ? 10 : 4);
          const n = k * k * m;
          const root = imagSurdAns(k, m);
          return {
            stem: `Solve ${tex(`x^{2} + ${n} = 0`)}. Give every solution.`,
            answer: solutionSetAns([root, `-${root}`]),
            ...withWorkedSteps([
              { text: `Subtract ${n}: x^2 = -${n}.`, blankText: `Subtract ${n} from both sides: ?` },
              { text: `Take square roots: x = ±√(-${n}).`, blankText: "Take the square root of both sides: ?" },
              {
                text: `√(-${n}) = ${root}, so x = ${root} or x = -${root}.`,
                blankText: `Write √(-${n}) using i: ?`,
              },
            ]),
          };
        }
        const h = signedInt(r, 1, 6);
        const k = r.int(1, 6);
        const roots = [complexAns(h, k), complexAns(h, -k)];
        return {
          stem: `Solve ${tex(`(x ${h > 0 ? "-" : "+"} ${Math.abs(h)})^{2} + ${k * k} = 0`)}. Give every solution.`,
          answer: solutionSetAns(roots),
          ...withWorkedSteps([
            {
              text: `Subtract ${k * k}: (x ${h > 0 ? "-" : "+"} ${Math.abs(h)})^2 = -${k * k}.`,
              blankText: `Subtract ${k * k} from both sides: ?`,
            },
            {
              text: `Take square roots: x ${h > 0 ? "-" : "+"} ${Math.abs(h)} = ±${complexAns(0, k)}.`,
              blankText: "Take the square root of both sides: ?",
            },
            {
              text: `${h > 0 ? "Add" : "Subtract"} ${Math.abs(h)}: x = ${roots[0]} or x = ${roots[1]}.`,
              blankText: `Solve for x: ?`,
            },
          ]),
        };
      }
      // Quadratic formula. Roots α ± β·i, with α = p/q and β = s√m / q.
      let a = 1;
      let p: number;
      let q = 1;
      let s: number;
      let m = 1;
      if (tier === 1) {
        p = signedInt(r, 1, 6);
        s = r.int(1, 6);
        a = r.int(0, 2) === 0 ? r.int(2, 3) : 1;
      } else if (r.int(0, 1) === 0) {
        // Half-integer parts: 2x² − 2p·x + (p² + s²)/2 with p, s odd.
        q = 2;
        a = 2;
        p = r.pick([-5, -3, -1, 1, 3, 5]);
        s = r.pick([1, 3, 5]);
      } else {
        // A radical imaginary part: α ± i√m.
        p = signedInt(r, 1, 5);
        s = 1;
        m = r.pick(SQUAREFREE);
      }
      // Monic polynomial with those roots, times a: a·(x² − 2α x + α² + β²).
      // α = p/q, β² = s²m/q², and a·q² is divisible by q² here (a = q or q = 1).
      const b = (-2 * a * p) / q;
      const c = (a * (p * p + s * s * m)) / (q * q);
      const disc = b * b - 4 * a * c;
      const re = ratAns(p, q);
      const imagCoefficient = (sign: number) => {
        const [sn, sd] = reduce(sign * s, q);
        const unit = m === 1 ? "i" : `i√${m}`;
        if (sd === 1) return `${sn === 1 ? "" : sn === -1 ? "-" : sn}${unit}`;
        return `${sn < 0 ? "-" : ""}(${Math.abs(sn)}/${sd})${unit}`;
      };
      const member = (sign: number) => {
        const im = imagCoefficient(sign);
        return `${re}${im.startsWith("-") ? "" : "+"}${im}`;
      };
      const roots = [member(1), member(-1)];
      const sqrtDisc =
        m === 1 ? complexAns(0, Math.sqrt(-disc)) : `${Math.sqrt(-disc / m) === 1 ? "" : Math.sqrt(-disc / m)}i√${m}`;
      return {
        stem: `Solve ${tex(`${polyTex([a, b, c])} = 0`)}. Give every solution in the form a + bi.`,
        answer: solutionSetAns(roots),
        ...withWorkedSteps([
          {
            text: `Use the quadratic formula with a = ${a}, b = ${b}, c = ${c}.`,
            blankText: "Name a, b and c: ?",
          },
          {
            text: `Discriminant: b^2 - 4ac = ${b * b} - ${4 * a * c} = ${disc}.`,
            blankText: "Work out the discriminant: ?",
          },
          {
            text: `The discriminant is negative, so √(${disc}) = ${sqrtDisc}.`,
            blankText: `Write √(${disc}) using i: ?`,
          },
          {
            text: `x = (${-b} ± ${sqrtDisc})/${2 * a}, so x = ${roots[0]} or x = ${roots[1]}.`,
            blankText: `Divide each part by 2a = ${2 * a}: ?`,
          },
        ]),
      };
    },
    { answerPalette: "complex", answerForm: "complexStandard" },
  );

  // ── quad_from_roots ───────────────────────────────────────────────────────
  const fromRoots = T(
    "quad_from_roots",
    "expression",
    (r) => {
      const tier = r.int(0, 2);
      if (tier === 0) {
        const r1 = r.int(-9, 9);
        let r2 = r.int(-9, 9);
        if (r2 === r1 && r.int(0, 3) !== 0) r2 = r1 === 9 ? -9 : r1 + 1;
        const coefficients = [1, -(r1 + r2), r1 * r2];
        const answer = polyAns(coefficients);
        const stem =
          r1 === r2
            ? `A quadratic equation ${tex("p(x) = 0")} has ${tex(String(r1))} as its only solution (a double root), and ${tex("p")} has leading coefficient 1. Write ${tex("p(x)")} in expanded form.`
            : `A quadratic equation ${tex("p(x) = 0")} has solutions ${tex(String(r1))} and ${tex(String(r2))}, and ${tex("p")} has leading coefficient 1. Write ${tex("p(x)")} in expanded form.`;
        return {
          stem,
          answer: exprAns(answer),
          ...withWorkedSteps([
            {
              text: `Each solution r gives a factor (x - r): p(x) = ${xMinus(r1)}${xMinus(r2)}.`,
              blankText: "Write a factor for each solution: ?",
            },
            {
              text: `Multiply out: ${terms([
                [1, "x^2"],
                [-r2, "x"],
                [-r1, "x"],
                [r1 * r2, ""],
              ])}.`,
              blankText: "Multiply the factors out: ?",
            },
            { text: `Combine like terms: ${answer}.`, blankText: "Combine like terms: ?" },
          ]),
        };
      }
      if (tier === 1) {
        if (r.int(0, 1) === 0) {
          // A given leading coefficient.
          const k = signedInt(r, 2, 4);
          const [r1, r2] = [r.int(-6, 6), r.int(-6, 6)];
          const monic = [1, -(r1 + r2), r1 * r2];
          const coefficients = monic.map((x) => k * x);
          const answer = polyAns(coefficients);
          const solutions = r1 === r2 ? tex(String(r1)) : `${tex(String(r1))} and ${tex(String(r2))}`;
          return {
            stem: `A quadratic equation ${tex("p(x) = 0")} has ${r1 === r2 ? "only the solution" : "solutions"} ${solutions}, and ${tex("p")} has leading coefficient ${tex(String(k))}. Write ${tex("p(x)")} in expanded form.`,
            answer: exprAns(answer),
            ...withWorkedSteps([
              {
                text: `Put the leading coefficient in front of the factors: p(x) = ${k}${xMinus(r1)}${xMinus(r2)}.`,
                blankText: "Write p(x) with its leading coefficient and factors: ?",
              },
              {
                text: `Multiply the factors: ${xMinus(r1)}${xMinus(r2)} = ${polyAns(monic)}.`,
                blankText: "Multiply the two factors: ?",
              },
              { text: `Multiply each term by ${k}: ${answer}.`, blankText: `Multiply each term by ${k}: ?` },
            ]),
          };
        }
        // A fractional root u/v and an integer root s (or a second fraction):
        // integer coefficients with no common factor and a positive leading one.
        const v = r.int(2, 5);
        let u = signedInt(r, 1, 7);
        while (gcd(u, v) !== 1) u += 1;
        let w = 1;
        let s = r.int(-6, 6);
        if (r.int(0, 2) === 0) {
          w = r.int(2, 4);
          s = signedInt(r, 1, 5);
          while (gcd(s, w) !== 1) s += 1;
          if (s * v === u * w) s += w;
        }
        // (v x − u)(w x − s)
        const coefficients = [v * w, -(v * s + u * w), u * s];
        const answer = polyAns(coefficients);
        const rootTex = (n: number, d: number) => ratTex(n, d);
        const factorText = (d: number, n: number) =>
          d === 1 ? (n === 0 ? "x" : `(x ${n > 0 ? "-" : "+"} ${Math.abs(n)})`) : `(${d}x ${n > 0 ? "-" : "+"} ${Math.abs(n)})`;
        return {
          stem: `A quadratic equation ${tex("p(x) = 0")} has solutions ${tex(rootTex(u, v))} and ${tex(rootTex(s, w))}. The coefficients of ${tex("p")} are integers with no common factor, and its leading coefficient is positive. Write ${tex("p(x)")} in expanded form.`,
          answer: exprAns(answer),
          ...withWorkedSteps([
            {
              text: `A solution u/v gives the integer factor (vx - u), which is zero at x = u/v: ${ratAns(u, v)} gives ${factorText(v, u)}.`,
              blankText: `Write an integer factor for ${ratAns(u, v)}: ?`,
            },
            {
              text: `${ratAns(s, w)} gives ${factorText(w, s)}, so p(x) = ${factorText(v, u)}${factorText(w, s)}.`,
              blankText: `Write a factor for ${ratAns(s, w)}: ?`,
            },
            {
              text: `Multiply out: ${terms([
                [v * w, "x^2"],
                [-v * s, "x"],
                [-u * w, "x"],
                [u * s, ""],
              ])}.`,
              blankText: "Multiply the factors out: ?",
            },
            { text: `Combine like terms: ${answer}.`, blankText: "Combine like terms: ?" },
          ]),
        };
      }
      // Radical-conjugate roots h ± √m. (Complex-conjugate roots need i, which
      // this node does not require: quad_complex_roots serves those.)
      return conjugatePairQuadratic(r, false);
    },
    { answerPalette: "algebra", answerForm: "expanded" },
  );

  // ── sys_linear_quadratic ──────────────────────────────────────────────────
  // y = a x² + b x + c meets y = m x + k where a x² + (b − m) x + (c − k) = 0.
  // The meeting x-values are drawn first; a no-meeting draw adds a positive
  // constant to a perfect square so the discriminant is negative.
  const linearQuadratic = T(
    "sys_linear_quadratic",
    "solutionSet",
    (r) => {
      const tier = r.int(0, 2);
      const caseDraw = r.int(0, 4);
      const meetings = caseDraw <= 2 ? 2 : caseDraw === 3 ? 1 : 0;
      const a = tier === 0 ? 1 : tier === 1 ? r.pick([1, -1]) : r.pick([2, -2, 1, -1]);
      const askY = tier === 2 && meetings > 0 && r.int(0, 1) === 0;
      let m = r.int(-4, 4);
      if (askY && m === 0) m = r.pick([-2, -1, 1, 2]);
      const k = r.int(-6, 6);
      let difference: number[]; // a x² + (b − m) x + (c − k), highest first
      let xs: number[] = [];
      if (meetings === 2) {
        const r1 = r.int(-5, 5);
        let r2 = r.int(-5, 5);
        if (r2 === r1) r2 = r1 === 5 ? -5 : r1 + 1;
        xs = [Math.min(r1, r2), Math.max(r1, r2)];
        difference = [a, -a * (r1 + r2), a * r1 * r2];
      } else if (meetings === 1) {
        const r1 = r.int(-5, 5);
        xs = [r1];
        difference = [a, -2 * a * r1, a * r1 * r1];
      } else {
        const h = r.int(-4, 4);
        const lift = r.int(1, 6);
        difference = [a, -2 * a * h, a * (h * h + lift)];
      }
      const parabola = [a, difference[1] + m, difference[2] + k];
      const line = [m, k];
      const ys = xs.map((x) => m * x + k);
      const members = askY ? ys : xs;
      const coordinate = askY ? "y" : "x";
      const disc = difference[1] * difference[1] - 4 * difference[0] * difference[2];
      const lineText = polyAns(line);
      const parabolaText = polyAns(parabola);
      const steps: WorkedStep[] = [
        {
          text: `Set the two right-hand sides equal: ${parabolaText} = ${lineText}.`,
          blankText: "Set the two expressions for y equal: ?",
        },
        {
          text: `Move everything to one side: ${polyAns(difference)} = 0.`,
          blankText: "Move every term to one side: ?",
        },
      ];
      if (meetings === 0) {
        steps.push({
          text: `Discriminant: ${difference[1]}^2 - 4(${difference[0]})(${difference[2]}) = ${disc}, which is negative.`,
          blankText: "Work out the discriminant: ?",
        });
        steps.push({
          text: "There is no real x, so the line and the parabola never meet: No solution.",
          blankText: "Decide what a negative discriminant means here: ?",
        });
      } else {
        const lead = a === 1 ? "" : a === -1 ? "-" : String(a);
        const factored =
          meetings === 2
            ? `${lead}${xMinus(xs[0])}${xMinus(xs[1])}`
            : `${lead}${xMinus(xs[0])}^2`;
        steps.push({
          text: `Factor: ${factored} = 0.`,
          blankText: "Factor the quadratic: ?",
        });
        if (askY) {
          steps.push({
            text: `So x = ${xs.join(" or x = ")}.`,
            blankText: "Solve for x: ?",
          });
          steps.push({
            text: `Put each x into the line y = ${lineText}: y = ${ys.join(" or y = ")}.`,
            blankText: "Substitute each x into the line: ?",
          });
        } else {
          steps.push({
            text:
              meetings === 1
                ? `So x = ${xs[0]} (the line just touches the parabola).`
                : `So x = ${xs.join(" or x = ")}.`,
            blankText: "Solve for x: ?",
          });
        }
      }
      return {
        stem: `Where does the line ${tex(`y = ${polyTex(line)}`)} meet the parabola ${tex(`y = ${polyTex(parabola)}`)}? Give the ${coordinate}-value of every meeting point. If they never meet, answer No solution.`,
        answer: solutionSetAns(members),
        ...withWorkedSteps(steps),
      };
    },
    { answerPalette: "algebra" },
  );

  return [imaginaryUnit, addSubtract, multiply, divide, complexRoots, fromRoots, linearQuadratic];
}
