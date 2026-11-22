/**
 * Algebra 2 — sequences and series strand.
 *
 * Explicit rules are typed as expressions in n (palette `sequence`), and the
 * grader compares them by value, so `3n+2`, `5+3(n-1)` and `(5/2)*2^n` are all
 * accepted where they are equal. A recursive rule cannot be typed as one
 * expression, so `seq_recursive` asks for one part of it at a time (the first
 * term, the added number, the multiplier) or for the explicit rule it equals.
 * Convergence of an infinite series is the one genuine recognition judgement
 * here, so that family is multiple choice; every other answer is typed.
 */
import type { WorkedStep } from "../fadedSteps";
import type { Algebra2Kit, Rng, Template } from "../templates";
import { fracTex, polyAns, polyTex, tex } from "./format";

// ── Exact rationals ─────────────────────────────────────────────────────────

type Rat = { n: number; d: number };

function gcdInt(a: number, b: number): number {
  let x = Math.abs(a);
  let y = Math.abs(b);
  while (y) [x, y] = [y, x % y];
  return x || 1;
}

function rat(n: number, d = 1): Rat {
  if (d < 0) return rat(-n, -d);
  const g = gcdInt(n, d);
  return { n: n / g, d: d / g };
}

const mul = (a: Rat, b: Rat): Rat => rat(a.n * b.n, a.d * b.d);
const sub = (a: Rat, b: Rat): Rat => rat(a.n * b.d - b.n * a.d, a.d * b.d);
const div = (a: Rat, b: Rat): Rat => rat(a.n * b.d, a.d * b.n);
const ONE = rat(1);

function pow(a: Rat, k: number): Rat {
  let out = ONE;
  for (let i = 0; i < k; i++) out = mul(out, a);
  return out;
}

function ratAns(q: Rat): string {
  return q.d === 1 ? String(q.n) : `${q.n}/${q.d}`;
}

function ratTex(q: Rat): string {
  if (q.d === 1) return String(q.n);
  const f = fracTex(Math.abs(q.n), q.d);
  return q.n < 0 ? `-${f}` : f;
}

/** A number for running text: a true minus sign for negatives. */
function num(v: number): string {
  return v < 0 ? `−${-v}` : String(v);
}

/** A rational for step text, parenthesised when negative: `(-1/2)`. */
function par(q: Rat | number): string {
  const r = typeof q === "number" ? rat(q) : q;
  const s = ratAns(r);
  return r.n < 0 ? `(${s})` : s;
}

/** `7, 11, 15, 19, …` */
function listTerms(terms: readonly number[]): string {
  return `${terms.map(num).join(", ")}, …`;
}

/** A number answer in its natural type: a whole number or a fraction pad, not
 *  the algebra pad. */
function numericAnswer(kit: Algebra2Kit, q: Rat) {
  return q.d === 1
    ? { answer: kit.intAns(q.n), answerType: "integer" as const }
    : { answer: kit.fracAns(q.n, q.d), answerType: "fraction" as const };
}

function step(text: string, blankText: string): WorkedStep {
  return { text, blankText };
}

/** How many draws a retry makes before using its fallback. Tests set it to 0
 *  to drive every fallback path. */
export const SEQUENCES_DRAW = { attempts: 80 };

/** Retry a draw until it is acceptable. The fallback holds RAW parameters
 *  only; anything derived from them is computed after the draw. */
function draw<T>(make: () => T | null, fallback: T): T {
  for (let tries = 0; tries < SEQUENCES_DRAW.attempts; tries++) {
    const candidate = make();
    if (candidate !== null) return candidate;
  }
  return fallback;
}

/** The ratio as a token the answer grammar raises to a power: `2`, `(-2)`, `(1/2)`. */
function ratioToken(r: Rat): string {
  return r.d === 1 && r.n > 0 ? String(r.n) : `(${ratAns(r)})`;
}

/** `5*2^(n-1)`, `2^(n-1)`, `48*(1/2)^(n-1)`, `-3*(-2)^(n-1)`. */
function geometricRule(a1: number, r: Rat): string {
  const power = `${ratioToken(r)}^(n-1)`;
  return a1 === 1 ? power : a1 === -1 ? `-${power}` : `${a1}*${power}`;
}

/** The ratio inside a stem span: `2`, `\left(-2\right)`, `\left(\frac{1}{2}\right)`. */
function ratioTex(r: Rat): string {
  return r.d === 1 && r.n > 0 ? String(r.n) : `\\left(${ratTex(r)}\\right)`;
}

/** Signed addend for a LaTeX rule: `+ 3`, `- 3`. */
function signedTex(v: number): string {
  return v < 0 ? `- ${-v}` : `+ ${v}`;
}

/** A series written out for a stem: `3 + 7 + 11 + ⋯ + 99`, `12 − 6 + 3 − ⋯`.
 *  `next` is the first hidden term; its sign sets the sign before the dots. */
function seriesText(terms: readonly number[], next: number, last?: number): string {
  let out = num(terms[0]);
  for (const t of terms.slice(1)) out += t < 0 ? ` − ${-t}` : ` + ${t}`;
  out += next < 0 ? " − ⋯" : " + ⋯";
  if (last !== undefined) out += last < 0 ? ` + (${num(last)})` : ` + ${last}`;
  return out;
}

/** a_1, then a_n = p·a_(n−1) + q, up to a_k. */
function runRecursion(a1: number, p: number, q: number, k: number): number[] {
  const terms = [a1];
  for (let i = 1; i < k; i++) terms.push(p * terms[i - 1] + q);
  return terms;
}

function arithmeticTerms(a1: number, d: number, count = 4): number[] {
  return Array.from({ length: count }, (_, i) => a1 + i * d);
}

function geometricTerms(a1: number, r: Rat, count = 4): number[] {
  return Array.from({ length: count }, (_, i) => {
    const v = mul(rat(a1), pow(r, i));
    return v.n / v.d;
  });
}

/** Draw a geometric sequence whose first four terms are whole numbers. */
function geometricSequence(r: Rng, tier: number): { a1: number; ratio: Rat } {
  if (tier === 0) return { a1: r.pick([1, 2, 3, 5, 7]), ratio: rat(r.pick([2, 2, 3])) };
  if (tier === 1) return { a1: r.pick([1, 2, 3, 4]), ratio: rat(r.pick([-2, -3, 4, 5])) };
  const ratio = r.pick([rat(1, 2), rat(1, 3), rat(-1, 2), rat(2, 3), rat(3, 2)]);
  const scale = r.int(1, ratio.d === 3 ? 2 : 3);
  const a1 = ratio.n === 3 ? 8 * scale : ratio.d ** 3 * scale;
  return { a1, ratio };
}

export function sequencesTemplates(kit: Algebra2Kit): Template[] {
  return [
    // ── Arithmetic sequences: the explicit rule ─────────────────────────────
    kit.T(
      "seq_arithmetic_explicit",
      "expression",
      (r) => {
        const tier = r.int(0, 2);
        const d = tier === 0 ? r.int(2, 9) : tier === 1 ? -r.int(2, 9) : r.pick([-7, -5, -3, 3, 4, 6, 8, 11]);
        const a1 = r.int(-10, 25);
        const terms = arithmeticTerms(a1, d);
        const rule = polyAns([d, a1 - d], "n");
        const header = `Arithmetic sequence: ${listTerms(terms)}`;
        const diffStep = step(
          `Common difference: d = ${num(terms[1])} − ${par(terms[0])} = ${d}.`,
          "Find the common difference d: ?",
        );
        const shape = r.int(0, 3);
        if (shape === 0) {
          return {
            stem: `${header} Write an explicit rule for ${tex("a_{n}")}.`,
            answer: kit.exprAns(rule),
            ...kit.withWorkedSteps([
              diffStep,
              step(
                `Explicit rule: a_n = a_1 + (n − 1)d = ${a1} + (n − 1)${par(d)}.`,
                "Substitute a_1 and d into a_n = a_1 + (n − 1)d: ?",
              ),
              step(`Distribute and combine like terms: a_n = ${rule}.`, "Distribute and combine like terms: ?"),
            ]),
          };
        }
        if (shape === 1) {
          const k = r.int(20, 60);
          const value = a1 + (k - 1) * d;
          return {
            stem: `${header} Find ${tex(`a_{${k}}`)}.`,
            ...numericAnswer(kit, rat(value)),
            ...kit.withWorkedSteps([
              diffStep,
              step(`a_${k} = a_1 + (${k} − 1)d = ${a1} + ${k - 1} · ${par(d)}.`, `Write a_${k} using a_1 + (n − 1)d: ?`),
              step(
                `${k - 1} · ${par(d)} = ${(k - 1) * d}, and ${a1} + ${par((k - 1) * d)} = ${value}.`,
                `Work out ${a1} + ${k - 1} · ${par(d)}: ?`,
              ),
            ]),
          };
        }
        if (shape === 2) {
          const n = r.int(12, 60);
          const value = a1 + (n - 1) * d;
          return {
            stem: `${header} Which term is ${num(value)}? Give its position ${tex("n")}.`,
            ...numericAnswer(kit, rat(n)),
            ...kit.withWorkedSteps([
              diffStep,
              step(
                `Set the rule equal to ${value}: ${a1} + (n − 1)${par(d)} = ${value}, so (n − 1)${par(d)} = ${value - a1}.`,
                `Set a_1 + (n − 1)d equal to ${value} and subtract a_1: ?`,
              ),
              step(`Divide by ${d}: n − 1 = ${n - 1}, so n = ${n}.`, `Divide by ${d}, then add 1: ?`),
            ]),
          };
        }
        const p = r.int(2, 5);
        const q = p + r.int(3, 8);
        const Ap = a1 + (p - 1) * d;
        const Aq = a1 + (q - 1) * d;
        return {
          stem: `An arithmetic sequence has ${tex(`a_{${p}} = ${Ap}`)} and ${tex(`a_{${q}} = ${Aq}`)}. Write an explicit rule for ${tex("a_{n}")}.`,
          answer: kit.exprAns(rule),
          ...kit.withWorkedSteps([
            step(
              `From term ${p} to term ${q} is ${q - p} steps of d: d = (${Aq} − ${par(Ap)})/${q - p} = ${d}.`,
              `Find d from the change between term ${p} and term ${q}: ?`,
            ),
            step(
              `Step back to the first term: a_1 = ${Ap} − ${p - 1} · ${par(d)} = ${a1}.`,
              `Work back from a_${p} to a_1: ?`,
            ),
            step(
              `a_n = ${a1} + (n − 1)${par(d)} = ${rule}.`,
              "Substitute into a_n = a_1 + (n − 1)d and simplify: ?",
            ),
          ]),
        };
      },
      { answerPalette: "sequence" },
    ),

    // ── Geometric sequences: the explicit rule ──────────────────────────────
    kit.T(
      "seq_geometric_explicit",
      "expression",
      (r) => {
        const tier = r.int(0, 2);
        const { a1, ratio } = geometricSequence(r, tier);
        const terms = geometricTerms(a1, ratio);
        const rule = geometricRule(a1, ratio);
        const header = `Geometric sequence: ${listTerms(terms)}`;
        const ratioStep = step(
          `Common ratio: r = ${num(terms[1])} ÷ ${par(terms[0])} = ${ratAns(ratio)}.`,
          "Find the common ratio r: ?",
        );
        const shape = r.int(0, 3);
        if (shape === 0) {
          return {
            stem: `${header} Write an explicit rule for ${tex("a_{n}")}.`,
            answer: kit.exprAns(rule),
            ...kit.withWorkedSteps([
              ratioStep,
              step("Explicit rule: a_n = a_1 · r^(n − 1).", "Recall the explicit rule for a geometric sequence: ?"),
              step(`Substitute a_1 = ${a1} and r = ${ratAns(ratio)}: a_n = ${rule}.`, "Substitute a_1 and r: ?"),
            ]),
          };
        }
        if (shape === 1) {
          const k = tier === 0 ? r.int(6, ratio.n === 2 ? 11 : 8) : r.int(5, 7);
          const factor = pow(ratio, k - 1);
          const value = mul(rat(a1), factor);
          return {
            stem: `${header} Find ${tex(`a_{${k}}`)}.`,
            ...numericAnswer(kit, value),
            ...kit.withWorkedSteps([
              ratioStep,
              step(`a_${k} = a_1 · r^${k - 1} = ${a1} · ${par(ratio)}^${k - 1}.`, `Write a_${k} using a_1 · r^(n − 1): ?`),
              step(
                `${par(ratio)}^${k - 1} = ${ratAns(factor)}, so a_${k} = ${a1} · ${par(factor)} = ${ratAns(value)}.`,
                `Work out ${par(ratio)}^${k - 1}, then multiply by ${a1}: ?`,
              ),
            ]),
          };
        }
        if (shape === 2) {
          const n = tier === 0 ? r.int(6, ratio.n === 2 ? 12 : 8) : r.int(5, 7);
          const factor = pow(ratio, n - 1);
          const value = mul(rat(a1), factor);
          const valueText = value.d === 1 ? num(value.n) : tex(ratTex(value));
          return {
            stem: `${header} Which term is ${valueText}? Give its position ${tex("n")}.`,
            ...numericAnswer(kit, rat(n)),
            ...kit.withWorkedSteps([
              ratioStep,
              step(
                `Set a_1 · r^(n − 1) equal to it and divide by ${a1}: ${par(ratio)}^(n − 1) = ${ratAns(factor)}.`,
                `Set ${a1} · ${par(ratio)}^(n − 1) equal to ${ratAns(value)} and divide by ${a1}: ?`,
              ),
              step(
                `${ratAns(factor)} = ${par(ratio)}^${n - 1}, so n − 1 = ${n - 1} and n = ${n}.`,
                `Write ${ratAns(factor)} as a power of ${par(ratio)}, then solve for n: ?`,
              ),
            ]),
          };
        }
        // Two terms three apart: r^3 is the quotient (an odd gap keeps r unique).
        const p = r.int(2, 3);
        const q = p + 3;
        const Ap = mul(rat(a1), pow(ratio, p - 1));
        const Aq = mul(rat(a1), pow(ratio, q - 1));
        return {
          stem: `A geometric sequence has ${tex(`a_{${p}} = ${ratTex(Ap)}`)} and ${tex(`a_{${q}} = ${ratTex(Aq)}`)}. Write an explicit rule for ${tex("a_{n}")}.`,
          answer: kit.exprAns(rule),
          ...kit.withWorkedSteps([
            step(
              `From term ${p} to term ${q} you multiply by r three times: r^3 = ${ratAns(Aq)} ÷ ${par(Ap)} = ${ratAns(pow(ratio, 3))}, so r = ${ratAns(ratio)}.`,
              `Divide a_${q} by a_${p} and take the cube root: ?`,
            ),
            step(
              `Step back to the first term: a_1 = ${ratAns(Ap)} ÷ ${par(ratio)}^${p - 1} = ${a1}.`,
              `Divide a_${p} by r^${p - 1} to get a_1: ?`,
            ),
            step(`a_n = a_1 · r^(n − 1) = ${rule}.`, "Substitute a_1 and r into a_n = a_1 · r^(n − 1): ?"),
          ]),
        };
      },
      { answerPalette: "sequence" },
    ),

    // ── Recursive ↔ explicit ────────────────────────────────────────────────
    kit.T(
      "seq_recursive",
      "expression",
      (r) => {
        const shape = r.int(0, 4);
        if (shape === 0) {
          // Arithmetic recursive → explicit.
          const a1 = r.int(-5, 12);
          const d = r.pick([-6, -4, -3, -2, 2, 3, 4, 5, 7, 9]);
          const rule = polyAns([d, a1 - d], "n");
          return {
            stem: `A sequence has ${tex(`a_{1} = ${a1}`)} and ${tex(`a_{n} = a_{n-1} ${signedTex(d)}`)}. Write an explicit rule for ${tex("a_{n}")}.`,
            answer: kit.exprAns(rule),
            ...kit.withWorkedSteps([
              step(
                `Each term ${d < 0 ? `subtracts ${-d}` : `adds ${d}`}, so the sequence is arithmetic with a_1 = ${a1} and d = ${d}.`,
                "What kind of sequence is it, and what are a_1 and d?",
              ),
              step(`a_n = a_1 + (n − 1)d = ${a1} + (n − 1)${par(d)}.`, "Substitute into a_n = a_1 + (n − 1)d: ?"),
              step(`Distribute and combine like terms: a_n = ${rule}.`, "Distribute and combine like terms: ?"),
            ]),
          };
        }
        if (shape === 1) {
          // Geometric recursive → explicit.
          const a1 = r.int(1, 6);
          const ratio = rat(r.pick([2, 3, 4, 5, -2, -3]));
          const rule = geometricRule(a1, ratio);
          return {
            stem: `A sequence has ${tex(`a_{1} = ${a1}`)} and ${tex(`a_{n} = ${ratio.n}a_{n-1}`)}. Write an explicit rule for ${tex("a_{n}")}.`,
            answer: kit.exprAns(rule),
            ...kit.withWorkedSteps([
              step(
                `Each term is ${ratio.n} times the one before, so the sequence is geometric with a_1 = ${a1} and r = ${ratio.n}.`,
                "What kind of sequence is it, and what are a_1 and r?",
              ),
              step("a_n = a_1 · r^(n − 1).", "Recall the explicit rule for a geometric sequence: ?"),
              step(`Substitute: a_n = ${rule}.`, "Substitute a_1 and r: ?"),
            ]),
          };
        }
        if (shape === 2) {
          // Explicit arithmetic → the parts of its recursive rule.
          const d = r.pick([-5, -3, -2, 2, 3, 4, 6, 7]);
          const c = draw(() => {
            const c = r.int(-9, 12);
            return c === 0 ? null : c;
          }, 3);
          const a1 = d + c;
          const explicit = polyTex([d, c], "n");
          const askFirst = r.int(0, 1) === 0;
          return {
            stem: `Write ${tex(`a_{n} = ${explicit}`)} as a recursive rule: a first term ${tex("a_{1}")} and ${tex(
              "a_{n} = a_{n-1} + d",
            )}. What is ${tex(askFirst ? "a_{1}" : "d")}?`,
            ...numericAnswer(kit, rat(askFirst ? a1 : d)),
            ...kit.withWorkedSteps(
              askFirst
                ? [
                    step("The first term is the rule at n = 1.", "Which n gives the first term?"),
                    step(`a_1 = ${d}(1) ${c < 0 ? "−" : "+"} ${Math.abs(c)} = ${a1}.`, "Substitute n = 1 into the rule: ?"),
                  ]
                : [
                    step(`a_1 = ${a1} and a_2 = ${a1 + d}.`, "Work out a_1 and a_2 from the rule: ?"),
                    step(`d = a_2 − a_1 = ${a1 + d} − ${par(a1)} = ${d}.`, "Subtract a_1 from a_2: ?"),
                  ],
            ),
          };
        }
        if (shape === 3) {
          // Explicit geometric (with a shifted exponent) → its recursive parts.
          const A = r.int(1, 5);
          const R = r.pick([2, 3, 4, 5]);
          const shift = r.pick([-1, 0, 1]);
          const exponent = shift === -1 ? "n-1" : shift === 0 ? "n" : "n+1";
          const a1 = A * R ** (1 + shift);
          const askFirst = r.int(0, 1) === 0;
          const explicit = A === 1 ? `${R}^{${exponent}}` : `${A} \\cdot ${R}^{${exponent}}`;
          return {
            stem: `Write ${tex(`a_{n} = ${explicit}`)} as a recursive rule: a first term ${tex("a_{1}")} and ${tex(
              "a_{n} = r \\cdot a_{n-1}",
            )}. What is ${tex(askFirst ? "a_{1}" : "r")}?`,
            ...numericAnswer(kit, rat(askFirst ? a1 : R)),
            ...kit.withWorkedSteps(
              askFirst
                ? [
                    step("The first term is the rule at n = 1.", "Which n gives the first term?"),
                    step(
                      `a_1 = ${A === 1 ? "" : `${A} · `}${R}^${1 + shift} = ${a1}.`,
                      "Substitute n = 1 into the rule: ?",
                    ),
                  ]
                : [
                    step(`a_1 = ${a1} and a_2 = ${a1 * R}.`, "Work out a_1 and a_2 from the rule: ?"),
                    step(`r = a_2 ÷ a_1 = ${a1 * R} ÷ ${a1} = ${R}.`, "Divide a_2 by a_1: ?"),
                  ],
            ),
          };
        }
        // A recursion with no simple explicit form: run it forward.
        const built = draw(
          () => {
            const a1 = r.int(1, 5);
            const p = r.pick([2, 3, -1, -2]);
            const q = r.pick([-3, -2, -1, 1, 2, 3]);
            const k = r.int(4, 6);
            return runRecursion(a1, p, q, k).some((t) => Math.abs(t) > 3000) ? null : { a1, p, q, k };
          },
          { a1: 2, p: 3, q: -1, k: 5 },
        );
        const { a1, p, q, k } = built;
        const terms = runRecursion(a1, p, q, k);
        const recurrence = `${p === -1 ? "-" : p}a_{n-1} ${signedTex(q)}`;
        const steps = terms.slice(1).map((t, i) =>
          step(
            `a_${i + 2} = ${p} · ${par(terms[i])} ${q < 0 ? "−" : "+"} ${Math.abs(q)} = ${t}.`,
            `Use the rule on a_${i + 1} = ${terms[i]}: a_${i + 2} = ?`,
          ),
        );
        return {
          stem: `A sequence has ${tex(`a_{1} = ${a1}`)} and ${tex(`a_{n} = ${recurrence}`)}. Find ${tex(`a_{${k}}`)}.`,
          ...numericAnswer(kit, rat(terms[k - 1])),
          ...kit.withWorkedSteps(steps),
        };
      },
      { answerPalette: "sequence" },
    ),

    // ── Sigma notation ──────────────────────────────────────────────────────
    kit.T("series_sigma_notation", "integer", (r) => {
      const tier = r.int(0, 2);
      type Sigma = { lo: number; hi: number; summandTex: string; f: (k: number) => number };
      const linear = (a: number, b: number): Pick<Sigma, "summandTex" | "f"> => ({
        summandTex: b === 0 ? polyTex([a, 0], "k") : `\\left(${polyTex([a, b], "k")}\\right)`,
        f: (k) => a * k + b,
      });
      let sigma: Sigma;
      if (tier === 0) {
        const a = r.int(1, 5);
        const b = r.int(-5, 5);
        sigma = { lo: 1, hi: r.int(4, 7), ...linear(a, b) };
      } else if (tier === 1) {
        if (r.int(0, 1) === 0) {
          const c = r.int(1, 3);
          sigma = {
            lo: r.int(0, 1),
            hi: r.int(3, 6),
            summandTex: c === 1 ? "2^{k}" : `${c} \\cdot 2^{k}`,
            f: (k) => c * 2 ** k,
          };
        } else {
          sigma = { lo: 1, hi: r.int(3, 6), summandTex: "k^{2}", f: (k) => k * k };
        }
      } else {
        const lo = r.int(2, 4);
        const hi = lo + r.int(3, 5);
        const a = -r.int(2, 4);
        const b = r.int(5, 15);
        sigma = { lo, hi, summandTex: `\\left(${b} - ${-a}k\\right)`, f: (k) => a * k + b };
      }
      const { lo, hi, summandTex, f } = sigma;
      const sigmaTex = `\\sum_{k=${lo}}^{${hi}} ${summandTex}`;
      if (tier === 2 && r.int(0, 2) === 0) {
        const count = hi - lo + 1;
        return {
          stem: `How many terms does ${tex(sigmaTex)} add?`,
          answer: kit.intAns(count),
          ...kit.withWorkedSteps([
            step(`k runs from ${lo} up to ${hi}, counting both ends.`, "Which values does k take?"),
            step(`${hi} − ${lo} + 1 = ${count} terms.`, `Count from ${lo} to ${hi}, including both ends: ?`),
          ]),
        };
      }
      const terms: number[] = [];
      for (let k = lo; k <= hi; k++) terms.push(f(k));
      const total = terms.reduce((s, t) => s + t, 0);
      return {
        stem: `Evaluate. ${tex(sigmaTex)}`,
        answer: kit.intAns(total),
        ...kit.withWorkedSteps([
          step(
            `Substitute k = ${lo}, ${lo + 1}, …, ${hi}: the terms are ${terms.map(num).join(", ")}.`,
            `Write out the term for each k from ${lo} to ${hi}: ?`,
          ),
          step(
            `Add them: ${terms.map((t, i) => (i === 0 ? num(t) : t < 0 ? `− ${-t}` : `+ ${t}`)).join(" ")} = ${total}.`,
            "Add the terms: ?",
          ),
        ]),
      };
    }),

    // ── Finite arithmetic series ────────────────────────────────────────────
    kit.T("series_arithmetic_sum", "integer", (r) => {
      const tier = r.int(0, 2);
      const d = tier === 0 ? r.int(2, 7) : tier === 1 ? r.pick([-5, -4, -3, -2, 3, 4, 5, 6]) : r.pick([-3, 2, 3, 4]);
      const a1 = tier === 1 && d < 0 ? r.int(40, 90) : r.int(-5, 15);
      const n = r.int(10, tier === 2 ? 50 : 40);
      const last = a1 + (n - 1) * d;
      const total = (n * (a1 + last)) / 2;
      const shape = tier === 2 ? 2 : r.int(0, 1);
      const pairing = [
        step(`Pair the ends: first + last = ${a1} + ${par(last)} = ${a1 + last}.`, "Add the first and last terms: ?"),
        step(
          `There are ${n}/2 such pairs, so the sum is ${n} × ${par(a1 + last)} ÷ 2 = ${total}.`,
          "Multiply the number of terms by first + last, then halve: ?",
        ),
      ];
      if (shape === 0) {
        return {
          stem: `Find the sum of the first ${n} terms of the arithmetic sequence ${listTerms(arithmeticTerms(a1, d, 3))}`,
          answer: kit.intAns(total),
          ...kit.withWorkedSteps([
            step(`d = ${d}, so the last term is a_${n} = ${a1} + ${n - 1} · ${par(d)} = ${last}.`, `Find the ${n}th term: ?`),
            ...pairing,
          ]),
        };
      }
      if (shape === 1) {
        return {
          stem: `Find the sum. ${seriesText(arithmeticTerms(a1, d, 3), 1, last)}`,
          answer: kit.intAns(total),
          ...kit.withWorkedSteps([
            step(
              `d = ${d}. Count the terms: (${last} − ${par(a1)})/${par(d)} + 1 = ${n}.`,
              "Use d to count how many terms there are: ?",
            ),
            ...pairing,
          ]),
        };
      }
      // Sigma form: Σ_{k=1}^{n} (dk + c).
      const c = a1 - d;
      const summand = c === 0 ? polyTex([d, 0], "k") : `\\left(${polyTex([d, c], "k")}\\right)`;
      return {
        stem: `Find the sum. ${tex(`\\sum_{k=1}^{${n}} ${summand}`)}`,
        answer: kit.intAns(total),
        ...kit.withWorkedSteps([
          step(
            `The terms go up by ${d} each time, so this is an arithmetic series of ${n} terms from ${a1} to ${last}.`,
            "Find the first term, the last term and the number of terms: ?",
          ),
          ...pairing,
        ]),
      };
    }),

    // ── Finite geometric series ─────────────────────────────────────────────
    kit.T(
      "series_geometric_sum",
      "integer",
      (r) => {
        const tier = r.int(0, 2);
        const { a1, ratio } =
          tier === 0
            ? r.int(0, 3) === 0
              ? { a1: 1, ratio: rat(2) }
              : { a1: r.pick([1, 2, 3, 5]), ratio: rat(r.pick([2, 3])) }
            : tier === 1
              ? { a1: r.pick([1, 2, 3]), ratio: rat(r.pick([-2, -3, 4])) }
              : (() => {
                  const ratio = r.pick([rat(1, 2), rat(1, 3), rat(-1, 2)]);
                  return { a1: ratio.d ** r.int(2, 4) * r.int(1, 2), ratio };
                })();
        const n =
          ratio.d === 1 && Math.abs(ratio.n) === 2 ? r.int(5, 9) : ratio.d === 1 ? r.int(4, 6) : r.int(4, 7);
        const rn = pow(ratio, n);
        const total = div(mul(rat(a1), sub(ONE, rn)), sub(ONE, ratio));
        const lastTerm = mul(rat(a1), pow(ratio, n - 1));
        const formula = `S = a_1(1 − r^n)/(1 − r) = ${a1}(1 − ${par(ratio)}^${n})/(1 − ${par(ratio)})`;
        const finish = [
          step(`${formula}.`, "Substitute into S = a_1(1 − r^n)/(1 − r): ?"),
          step(`${par(ratio)}^${n} = ${ratAns(rn)}, so S = ${a1}(${ratAns(sub(ONE, rn))})/(${ratAns(sub(ONE, ratio))}) = ${ratAns(total)}.`, `Work out ${par(ratio)}^${n} and finish the arithmetic: ?`),
        ];
        if (tier === 0 && lastTerm.d === 1) {
          return {
            stem: `Find the sum. ${seriesText(geometricTerms(a1, ratio, 3), 1, lastTerm.n)}`,
            ...numericAnswer(kit, total),
            ...kit.withWorkedSteps([
              step(
                `r = ${ratAns(ratio)}, and ${lastTerm.n} = ${a1 === 1 ? "" : `${a1} · `}${ratio.n}^${n - 1}, so there are ${n} terms.`,
                "Find r and count the terms: ?",
              ),
              ...finish,
            ]),
          };
        }
        return {
          stem: `Find the sum of the first ${n} terms of the geometric sequence ${listTerms(geometricTerms(a1, ratio, 3))}`,
          ...numericAnswer(kit, total),
          ...kit.withWorkedSteps([
            step(`r = ${ratAns(ratio)} and n = ${n}.`, "Find the common ratio r: ?"),
            ...finish,
          ]),
        };
      },
    ),

    // ── Infinite geometric series: converge or not, and the sum ─────────────
    // Two kinds of draw. A judgement draw asks only whether the series
    // converges and why (multiple choice: the reasons are the content). A sum
    // draw says nothing about convergence and asks for the sum as a typed
    // solution set, empty when it diverges, so the scholar must decide and
    // compute.
    kit.T(
      "series_infinite_geometric",
      "multipleChoice",
      (r) => {
        const converges = r.int(0, 1) === 0;
        const ratio = converges
          ? r.pick([rat(1, 2), rat(1, 3), rat(1, 4), rat(2, 3), rat(3, 4), rat(-1, 2), rat(-1, 3), rat(-2, 3)])
          : r.pick([rat(2), rat(-2), rat(3), rat(3, 2), rat(-3, 2), rat(-1)]);
        // Written out, the first three terms must be whole numbers; in sigma
        // form any first term works.
        const showSigma = r.int(0, 1) === 0;
        const a1 = showSigma ? r.int(1, 9) : ratio.d ** 2 * r.int(1, 4) * (ratio.d === 1 ? r.int(1, 3) : 1);
        const sum = div(rat(a1), sub(ONE, ratio));
        const series = showSigma
          ? tex(`\\sum_{k=1}^{\\infty} ${a1 === 1 ? "" : `${a1} \\cdot `}${ratioTex(ratio)}^{k-1}`)
          : seriesText(geometricTerms(a1, ratio, 3), geometricTerms(a1, ratio, 4)[3]);
        const absRatio = rat(Math.abs(ratio.n), ratio.d);
        const ratioStep = step(
          `The ratio is r = ${ratAns(ratio)}, so |r| = ${ratAns(absRatio)}.`,
          "Find the common ratio r and its size |r|: ?",
        );
        if (r.int(0, 1) === 0) {
          const CONVERGES = "Converges, because |r| < 1";
          const DIVERGES = "Diverges, because |r| ≥ 1";
          const correct = converges ? CONVERGES : DIVERGES;
          return kit.choiceItem(
            r,
            `Does this infinite geometric series converge? ${series}`,
            correct,
            [converges ? DIVERGES : CONVERGES, "Diverges, because it adds infinitely many terms"],
            undefined,
            [
              ratioStep,
              step(
                converges
                  ? `|r| < 1, so the terms shrink toward 0 fast enough to add up to a number: ${CONVERGES}.`
                  : `|r| ≥ 1, so the terms never shrink toward 0 and the partial sums never settle: ${DIVERGES}.`,
                "Compare |r| with 1 to decide: ?",
              ),
            ],
          );
        }
        return {
          stem: `Find the sum of this infinite series, or answer No solution if it has none. ${series}`,
          answerType: "solutionSet" as const,
          answer: kit.solutionSetAns(converges ? [ratAns(sum)] : []),
          ...kit.withWorkedSteps([
            ratioStep,
            converges
              ? step(
                  `|r| < 1, so it converges. Sum = a_1/(1 − r) = ${a1}/(1 − ${par(ratio)}) = ${ratAns(sum)}.`,
                  "Compare |r| with 1, then use a_1/(1 − r): ?",
                )
              : step(
                  "|r| ≥ 1, so the terms never shrink toward 0 and the series has no sum: No solution.",
                  "Compare |r| with 1 to decide whether there is a sum: ?",
                ),
          ]),
        };
      },
      { answerPalette: "algebra" },
    ),
  ];
}
