/**
 * Algebra 2 — exponential and logarithmic strand.
 *
 * Logarithms are met here for the first time, so base 2 and doubling/halving
 * carry the early tiers ("how many times can you halve 256?"), and every answer
 * stays exact: a logarithm the scholar cannot evaluate is typed as a
 * logarithm (`log_3(20)`, `ln(5)/2`), never as a rounded decimal. The grader
 * compares by value, so any correct rewrite (`log(20)/log(3)`) is accepted.
 *
 * `log_graph_inverse` is deliberately absent: it needs a function-curve
 * visual, which this strand does not draw.
 */
import type { WorkedStep } from "../fadedSteps";
import type { Algebra2Kit, Rng, Template } from "../templates";
import { fracTex, linearFactor, polyAns, polyTex, tex } from "./format";

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

/** Answer grammar: `5`, `-3`, `3/2`, `-1/2`. */
function ratAns(q: Rat): string {
  return q.d === 1 ? String(q.n) : `${q.n}/${q.d}`;
}

/** LaTeX: `5`, `-3`, `\frac{3}{2}`, `-\frac{1}{2}`. */
function ratTex(q: Rat): string {
  if (q.d === 1) return String(q.n);
  const f = fracTex(Math.abs(q.n), q.d);
  return q.n < 0 ? `-${f}` : f;
}

/** Plain step text: `3/2`, `-1/2`. */
const ratPlain = ratAns;

// ── Logarithm notation ──────────────────────────────────────────────────────

/** A logarithm base: a whole number (10 is the common log, written `log`), or e. */
type LogBase = number | "e";

function logAns(base: LogBase, arg: string): string {
  if (base === "e") return `ln(${arg})`;
  if (base === 10) return `log(${arg})`;
  return `log_${base}(${arg})`;
}

function logTex(base: LogBase, arg: string): string {
  const wrapped = arg.includes("\\frac") ? `\\left(${arg}\\right)` : `(${arg})`;
  if (base === "e") return `\\ln${wrapped}`;
  if (base === 10) return `\\log${wrapped}`;
  return `\\log_{${base}}${wrapped}`;
}

function baseWord(base: LogBase): string {
  return base === "e" ? "ln" : base === 10 ? "log base 10" : `log base ${base}`;
}

/** A polynomial for step text: `x^2 - 3x + 2` (LaTeX braces removed). */
function plainPoly(coefficients: readonly number[], variable = "x"): string {
  return polyTex(coefficients, variable).replace(/\^\{(-?\d+)\}/g, "^$1");
}

/** `2^(x+3)` style power for step text. */
function plainPow(base: string | number, exponent: string): string {
  return /^\d+$/.test(exponent) || /^[a-z]$/.test(exponent)
    ? `${base}^${exponent}`
    : `${base}^(${exponent})`;
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

/** The final division of a change-of-base item: `Divide: 6/4 = 3/2.` */
function divideText(top: number, bottom: number, value: Rat): string {
  const raw = `${top}/${bottom < 0 ? `(${bottom})` : bottom}`;
  const reduced = ratPlain(value);
  return raw === reduced ? `Divide: the value is ${reduced}.` : `Divide: ${raw} = ${reduced}.`;
}

/** `3(x - 2)`, or the bare exponent when the multiplier is 1. */
function scaled(k: number, exponent: string): string {
  return k === 1 ? exponent : `${k}(${exponent})`;
}

/** Is n an exact whole power b^k (k ≥ 1)? */
function isPowerOf(n: number, b: number): boolean {
  if (n < b) return n === 1;
  let v = 1;
  while (v < n) v *= b;
  return v === n;
}

/** How many draws a retry makes before using its fallback. Tests set it to 0
 *  to drive every fallback path. */
export const EXP_LOG_DRAW = { attempts: 80 };

/**
 * Retry a draw until it is acceptable; deterministic because it only uses r.
 * The fallback holds RAW parameters only: everything derived from them (a
 * constant term, a coefficient) is computed after the draw, from whichever
 * parameters won, so a fallback can never carry a stale derived value.
 */
function draw<T>(r: Rng, make: () => T | null, fallback: T): T {
  for (let tries = 0; tries < EXP_LOG_DRAW.attempts; tries++) {
    const candidate = make();
    if (candidate !== null) return candidate;
  }
  void r;
  return fallback;
}

/** Members of a solution set for step text: "x = 1 or x = 2", "no solution". */
function membersPlain(members: readonly string[]): string {
  return members.length === 0 ? "no solution" : members.map((m) => `x = ${m}`).join(" or ");
}

// ── Common powers ───────────────────────────────────────────────────────────

/** Bases that are powers of a common root g: value → exponent of g. */
const POWERS_OF: Record<number, number[]> = {
  2: [2, 4, 8, 16, 32],
  3: [3, 9, 27, 81],
  5: [5, 25, 125],
};

export function expLogTemplates(kit: Algebra2Kit): Template[] {
  return [
    // ── Solve by rewriting both sides with one base ─────────────────────────
    kit.T(
      "exp_solve_common_base",
      "solutionSet",
      (r) => {
        const tier = r.int(0, 2);
        if (tier === 0) {
          const g = r.pick([2, 2, 3, 5]);
          const maxK = g === 2 ? 8 : g === 3 ? 5 : 3;
          const { a, k, x0 } = draw(
            r,
            () => {
              const a = r.pick([1, 1, 2, 3]);
              const k = r.int(1, maxK);
              const x0 = r.int(-3, 6);
              const c = k - a * x0;
              if (Math.abs(c) > 9 || (a === 1 && c === 0)) return null;
              return { a, k, x0 };
            },
            { a: 1, k: 3, x0: 1 },
          );
          const c = k - a * x0;
          const value = g ** k;
          const exponent = polyTex([a, c]);
          return {
            stem: `Solve for ${tex("x")}. ${tex(`${g}^{${exponent}} = ${value}`)}`,
            ...numericAnswer(kit, rat(x0)),
            ...kit.withWorkedSteps([
              step(`Write ${value} as a power of ${g}: ${value} = ${g}^${k}.`, `Write ${value} as a power of ${g}: ?`),
              step(
                `The bases match, so the exponents are equal: ${exponent} = ${k}.`,
                "The bases match. Set the exponents equal: ?",
              ),
              step(`Solve ${exponent} = ${k}: x = ${x0}.`, `Solve ${exponent} = ${k} for x: ?`),
            ]),
          };
        }
        if (tier === 1) {
          const g = r.pick([2, 2, 3, 5]);
          const powers = POWERS_OF[g];
          if (r.int(0, 2) === 0) {
            // B^(ax + c) = 1/g^m: a reciprocal on the right, possibly a fractional answer.
            const p = r.int(2, powers.length);
            const B = powers[p - 1];
            const c = r.int(-2, 2);
            const m = r.int(1, Math.min(powers.length, 4));
            const answer = rat(-m - p * c, p);
            const exponent = polyTex([1, c]);
            const rhs = fracTex(1, g ** m);
            return {
              stem: `Solve for ${tex("x")}. ${tex(`${B}^{${exponent}} = ${rhs}`)}`,
              ...numericAnswer(kit, answer),
              ...kit.withWorkedSteps([
                step(
                  `Write both sides as powers of ${g}: ${B} = ${g}^${p} and 1/${g ** m} = ${g}^(-${m}).`,
                  `Write ${B} and 1/${g ** m} as powers of ${g}: ?`,
                ),
                step(
                  `So ${g}^(${p}(${exponent})) = ${g}^(-${m}), and the exponents are equal: ${p}(${exponent}) = -${m}.`,
                  "Set the exponents equal: ?",
                ),
                step(`Solve ${p}(${exponent}) = -${m}: x = ${ratPlain(answer)}.`, `Solve ${p}(${exponent}) = -${m}: ?`),
              ]),
            };
          }
          const built = draw(
            r,
            () => {
              const p = r.int(1, powers.length);
              const q = r.int(1, powers.length);
              if (p === q) return null;
              const a1 = r.pick([1, 1, 2]);
              const a2 = r.pick([1, 1, 2]);
              const c1 = r.int(-3, 3);
              const x0 = r.int(-3, 4);
              if (p * a1 === q * a2) return null;
              const top = p * (a1 * x0 + c1) - q * a2 * x0;
              if (top % q !== 0) return null;
              const c2 = top / q;
              if (Math.abs(c2) > 9) return null;
              if (a1 === 1 && c1 === 0 && a2 === 1 && c2 === 0) return null;
              return { p, q, a1, a2, c1, x0 };
            },
            // 2(x) = 3(x - 1) at x = 3: c2 = (2·3 - 3·3)/3 = -1.
            { p: 2, q: 3, a1: 1, a2: 1, c1: 0, x0: 3 },
          );
          const { p, q, a1, a2, c1, x0 } = built;
          const c2 = (p * (a1 * x0 + c1) - q * a2 * x0) / q;
          const B1 = powers[p - 1];
          const B2 = powers[q - 1];
          const e1 = polyTex([a1, c1]);
          const e2 = polyTex([a2, c2]);
          return {
            stem: `Solve for ${tex("x")}. ${tex(`${B1}^{${e1}} = ${B2}^{${e2}}`)}`,
            ...numericAnswer(kit, rat(x0)),
            ...kit.withWorkedSteps([
              step(
                `Write both bases as powers of ${g}: ${B1} = ${g}^${p} and ${B2} = ${g}^${q}.`,
                `Write ${B1} and ${B2} as powers of ${g}: ?`,
              ),
              step(
                `Power of a power multiplies exponents, so the exponents are equal: ${scaled(p, e1)} = ${scaled(q, e2)}.`,
                "Set the exponents equal: ?",
              ),
              step(
                `Solve ${scaled(p, e1)} = ${scaled(q, e2)}: x = ${x0}.`,
                `Solve ${scaled(p, e1)} = ${scaled(q, e2)} for x: ?`,
              ),
            ]),
          };
        }
        // Quadratic exponent: two solutions.
        const g = r.pick([2, 2, 3]);
        const built = draw(
          r,
          () => {
            const r1 = r.int(-3, 4);
            const r2 = r.int(-3, 4);
            if (r1 >= r2) return null;
            const c = r.int(-2, 3);
            const k = c - r1 * r2;
            if (Math.abs(k) > (g === 2 ? 6 : 4)) return null;
            return { r1, r2, c };
          },
          { r1: -1, r2: 2, c: 0 },
        );
        const { r1, r2, c } = built;
        const k = c - r1 * r2;
        const s = r1 + r2;
        const exponentCoefficients = [1, -s, c];
        const exponent = polyTex(exponentCoefficients);
        const rhs = k > 0 ? String(g ** k) : k === 0 ? "1" : fracTex(1, g ** -k);
        const rhsPlain = k > 0 ? String(g ** k) : k === 0 ? "1" : `1/${g ** -k}`;
        const zeroPoly = [1, -s, r1 * r2];
        return {
          stem: `Solve for ${tex("x")}. Give every solution. ${tex(`${g}^{${exponent}} = ${rhs}`)}`,
          answer: kit.solutionSetAns([String(r1), String(r2)]),
          ...kit.withWorkedSteps([
            step(`Write ${rhsPlain} as a power of ${g}: ${rhsPlain} = ${plainPow(g, String(k))}.`, `Write ${rhsPlain} as a power of ${g}: ?`),
            step(
              `Set the exponents equal and move everything to one side: ${plainPoly(zeroPoly)} = 0.`,
              "Set the exponents equal, with 0 on one side: ?",
            ),
            step(
              `Factor: ${linearFactor(r1)}${linearFactor(r2)} = 0, so ${membersPlain([String(r1), String(r2)])}.`,
              `Factor ${plainPoly(zeroPoly)} = 0 and solve: ?`,
            ),
          ]),
        };
      },
      { answerPalette: "algebra" },
    ),

    // ── Exponential form ↔ logarithmic form ─────────────────────────────────
    // Four shapes, each a genuine translation: a power's exponent written as a
    // logarithm; and a logarithm statement with the unknown in each of its three
    // places (value, base, and a whole exponent expression).
    kit.T(
      "log_definition",
      "expression",
      (r) => {
        const shape = r.int(0, 3);
        if (shape === 0) {
          // Exponential → logarithmic: name the exponent as a logarithm.
          const base = r.pick<LogBase>([2, 2, 3, 5, 10]);
          const value = draw(
            r,
            () => {
              const n = base === 10 ? r.pick([2, 3, 5, 20, 50, 300]) : r.int(3, 60);
              return typeof base === "number" && isPowerOf(n, base) ? null : n;
            },
            7,
          );
          const answer = logAns(base, String(value));
          const doubling =
            base === 2 && r.int(0, 1) === 0
              ? `Start at 1 and keep doubling. After ${tex("y")} doublings you reach ${value}, so ${tex(`2^{y} = ${value}`)}.`
              : `${tex(`${base}^{y} = ${value}`)}.`;
          return {
            stem: `${doubling} Rewrite it in logarithmic form: write ${tex("y")} as a single logarithm.`,
            answer: kit.exprAns(answer),
            answerForm: "singleLog" as const,
            ...kit.withWorkedSteps([
              step(
                `A logarithm names an exponent: ${base}^y = ${value} says y is the power of ${base} that gives ${value}.`,
                `What does ${base}^y = ${value} say about y?`,
              ),
              step(`Write that exponent as a logarithm with base ${base}: y = ${answer}.`, "Name the exponent as a logarithm: ?"),
            ]),
          };
        }
        const tier = r.int(0, 2);
        // (base, exponent) pairs whose power is a clean number.
        const pair = (() => {
          if (tier === 0) {
            const b = r.pick([2, 3, 4, 5]);
            const k = r.int(2, b === 2 ? 6 : 4);
            return { b, e: rat(k) };
          }
          if (tier === 1) {
            const b = r.pick([2, 3, 4, 5, 10]);
            const k = r.int(1, b >= 5 ? 2 : 3);
            return { b, e: rat(-k) };
          }
          const [b, n, d] = r.pick([
            [4, 1, 2],
            [9, 1, 2],
            [8, 1, 3],
            [8, 2, 3],
            [16, 3, 4],
            [27, 2, 3],
            [25, 3, 2],
            [4, 3, 2],
            [16, 1, 2],
            [32, 2, 5],
          ]);
          return { b, e: rat(n, d) };
        })();
        const { b, e } = pair;
        // value = b^e, exact.
        const root = Math.round(b ** (1 / e.d));
        const magnitude = root ** Math.abs(e.n);
        const value = e.n < 0 ? rat(1, magnitude) : rat(magnitude);
        if (shape === 1) {
          // Unknown value: log_b(x) = e.
          return {
            stem: `Find ${tex("x")}. ${tex(`\\log_{${b}}(x) = ${ratTex(e)}`)}`,
            ...numericAnswer(kit, value),
            ...kit.withWorkedSteps([
              step(
                `Rewrite in exponential form: log_${b}(x) = ${ratPlain(e)} means ${plainPow(b, ratPlain(e))} = x.`,
                "Rewrite the logarithm as a power: ?",
              ),
              step(`Work out ${plainPow(b, ratPlain(e))}: x = ${ratPlain(value)}.`, `Work out ${plainPow(b, ratPlain(e))}: ?`),
            ]),
          };
        }
        if (shape === 2) {
          // Unknown base: log_b(value) = e.
          return {
            stem: `Find the base ${tex("b")}. (A logarithm's base is positive.) ${tex(
              `\\log_{b}${value.d === 1 ? `(${value.n})` : `\\left(${ratTex(value)}\\right)`} = ${ratTex(e)}`,
            )}`,
            ...numericAnswer(kit, rat(b)),
            ...kit.withWorkedSteps([
              step(
                `Rewrite in exponential form: ${plainPow("b", ratPlain(e))} = ${ratPlain(value)}.`,
                "Rewrite the logarithm as a power: ?",
              ),
              step(
                `Find the positive number b with ${plainPow("b", ratPlain(e))} = ${ratPlain(value)}: b = ${b}.`,
                `Which positive number b has ${plainPow("b", ratPlain(e))} = ${ratPlain(value)}?`,
              ),
            ]),
          };
        }
        // Unknown expression: log_b(x) = (linear in y) → x = b^(…).
        const base = r.pick([2, 3, 5, 10]);
        const { m, c } = draw(
          r,
          () => {
            const m = r.int(1, 3);
            const c = r.int(-1, 2);
            return m === 1 && c === 0 ? null : { m, c };
          },
          { m: 2, c: 1 },
        );
        const exponentAns = polyAns([m, c], "y");
        const exponentTex = polyTex([m, c], "y");
        const answer = `${base}^(${exponentAns})`;
        return {
          stem: `Rewrite in exponential form, then write ${tex("x")} in terms of ${tex("y")}. ${tex(
            `${logTex(base, "x")} = ${exponentTex}`,
          )}`,
          answer: kit.exprAns(answer),
          ...kit.withWorkedSteps([
            step(
              `${logAns(base, "x")} = ${exponentAns} says ${base} raised to ${exponentAns} gives x.`,
              `What does ${logAns(base, "x")} = ${exponentAns} say?`,
            ),
            step(`Write it as a power: x = ${answer}.`, "Write x as a power of the base: ?"),
          ]),
        };
      },
      { answerPalette: "logs" },
    ),

    // ── Evaluate a logarithm without a calculator ───────────────────────────
    kit.T(
      "log_evaluate",
      "integer",
      (r) => {
        const tier = r.int(0, 2);
        if (tier === 0) {
          const base = r.pick([2, 2, 3, 4, 5, 10]);
          const k = r.int(2, base === 2 ? 10 : base === 10 ? 6 : base === 3 ? 5 : 4);
          const value = base ** k;
          const powers = Array.from({ length: k }, (_, i) => base ** (i + 1));
          const halving = base === 2 && r.int(0, 1) === 0;
          const stem = halving
            ? `How many times can you halve ${value} before you reach 1? That count is ${tex(
                logTex(2, String(value)),
              )}. Evaluate it.`
            : `Evaluate. ${tex(logTex(base, String(value)))}`;
          return {
            stem,
            ...numericAnswer(kit, rat(k)),
            ...kit.withWorkedSteps([
              step(`${logAns(base, String(value))} asks: ${base} to what power gives ${value}?`, `What question does ${logAns(base, String(value))} ask?`),
              step(`Multiply by ${base} again and again: ${powers.join(", ")}.`, `List the powers of ${base} up to ${value}: ?`),
              step(`Count the factors of ${base}: ${logAns(base, String(value))} = ${k}.`, `Count how many ${base}s multiply to ${value}: ?`),
            ]),
          };
        }
        if (tier === 1) {
          const base = r.pick([2, 2, 3, 4, 5, 10]);
          const kind = r.int(0, 4);
          if (kind === 0) {
            return {
              stem: `Evaluate. ${tex(logTex(base, "1"))}`,
              ...numericAnswer(kit, rat(0)),
              ...kit.withWorkedSteps([
                step(`${logAns(base, "1")} asks: ${base} to what power gives 1?`, `What question does ${logAns(base, "1")} ask?`),
                step(`Any nonzero number to the power 0 is 1, so ${logAns(base, "1")} = 0.`, `Which power of ${base} is 1?`),
              ]),
            };
          }
          const k = r.int(1, base === 2 ? 6 : base === 10 ? 4 : 3);
          const den = base ** k;
          const argTex = fracTex(1, den);
          return {
            stem: `Evaluate. ${tex(logTex(base, argTex))}`,
            ...numericAnswer(kit, rat(-k)),
            ...kit.withWorkedSteps([
              step(`${den} = ${plainPow(base, String(k))}.`, `Write ${den} as a power of ${base}: ?`),
              step(
                `A reciprocal is a negative exponent: 1/${plainPow(base, String(k))} = ${base}^(-${k}), so ${logAns(base, `1/${den}`)} = ${-k}.`,
                `Write 1/${plainPow(base, String(k))} as a power of ${base} and read off the exponent: ?`,
              ),
            ]),
          };
        }
        // Roots: fractional exponents.
        const base = r.pick([2, 3, 5, 7, 10]);
        const [argTex, argPlain, value, how] = r.pick<[string, string, Rat, string]>([
          [`\\sqrt{${base}}`, `√${base}`, rat(1, 2), `√${base} = ${base}^(1/2)`],
          [`\\sqrt[3]{${base}}`, `∛${base}`, rat(1, 3), `∛${base} = ${base}^(1/3)`],
          [`\\sqrt[3]{${base}^{2}}`, `∛(${base}^2)`, rat(2, 3), `∛(${base}^2) = ${base}^(2/3)`],
          [`${base}\\sqrt{${base}}`, `${base}√${base}`, rat(3, 2), `${base}√${base} = ${base}^1 · ${base}^(1/2) = ${base}^(3/2)`],
          [fracTex(1, `\\sqrt{${base}}`), `1/√${base}`, rat(-1, 2), `1/√${base} = ${base}^(-1/2)`],
        ]);
        return {
          stem: `Evaluate. ${tex(logTex(base, argTex))}`,
          ...numericAnswer(kit, value),
          ...kit.withWorkedSteps([
            step(
              "A square root is the power 1/2 and a cube root is the power 1/3; a reciprocal makes the exponent negative.",
              "How is a root written as a power?",
            ),
            step(
              `Write the input as a power of ${base}: ${how}, so ${logAns(base, argPlain)} = ${ratPlain(value)}.`,
              `Write ${argPlain} as a power of ${base} and read off the exponent: ?`,
            ),
          ]),
        };
      },
    ),

    // ── Expand with the product, quotient, and power rules ──────────────────
    kit.T(
      "log_rules_expand",
      "expression",
      (r) => {
        const spec = logProductSpec(r);
        const stemArg = argTex(spec);
        const answer = expandedAns(spec);
        const steps: WorkedStep[] = [];
        const top = numeratorPieces(spec);
        const bottom = denominatorPieces(spec);
        if (bottom.length > 0) {
          steps.push(
            step(
              `Quotient rule: ${logAns(spec.base, `${top.join("")}/${groupPlain(bottom)}`)} = ${logAns(spec.base, top.join(""))} - ${logAns(spec.base, bottom.join(""))}.`,
              "Split the quotient into a difference of logs: ?",
            ),
          );
        }
        const pieces = [...top.map((p) => ({ p, sign: "+" })), ...bottom.map((p) => ({ p, sign: "-" }))];
        if (pieces.length > 1) {
          const split = pieces
            .map(({ p, sign }, i) => `${i === 0 ? "" : ` ${sign} `}${logAns(spec.base, p)}`)
            .join("");
          steps.push(step(`Product rule: each factor gets its own log: ${split}.`, "Split each product into a sum of logs: ?"));
        }
        steps.push(
          step(
            `Power rule: bring each exponent to the front${
              spec.factors.some((f) => f.p.d > 1) ? " (a root is a fractional power: √y = y^(1/2), ∛y = y^(1/3))" : ""
            }${
              spec.constPower > 0 ? `, and ${logAns(spec.base, constPlain(spec))} = ${spec.constPower}` : ""
            }: ${answer}.`,
            "Apply the power rule to each log: ?",
          ),
        );
        return {
          stem: `Assume every variable is positive. Expand completely, so each logarithm holds one number or letter. ${tex(logTex(spec.base, stemArg))}`,
          answer: kit.exprAns(answer),
          ...kit.withWorkedSteps(steps),
        };
      },
      { answerPalette: "logs", answerForm: "expandedLog" },
    ),

    // ── Condense into a single logarithm ────────────────────────────────────
    kit.T(
      "log_rules_condense",
      "expression",
      (r) => {
        const spec = logProductSpec(r);
        // In the condense direction a constant is shown either as the plain
        // number it equals (+ 3) or, for a non-power, as its own log term.
        const answer = logAns(spec.base, condensedArg(spec));
        const stemTerms = expandedTex(spec);
        const steps: WorkedStep[] = [];
        const powered = spec.factors.filter((f) => !(f.p.n === 1 && f.p.d === 1));
        const firstMoves: string[] = [];
        if (powered.length > 0) {
          firstMoves.push(
            powered
              .map((f) => `${coefPlain(f.p)}${logAns(spec.base, f.v)} = ${logAns(spec.base, factorPlain(f))}`)
              .join(", "),
          );
        }
        if (spec.constPower > 0) {
          firstMoves.push(`${spec.constPower} = ${logAns(spec.base, constPlain(spec))}`);
        }
        if (firstMoves.length > 0) {
          steps.push(
            step(
              `Power rule first: move each coefficient up as an exponent: ${firstMoves.join(", ")}.`,
              "Move each coefficient into its log as an exponent: ?",
            ),
          );
        }
        const top = numeratorPieces(spec);
        const bottom = denominatorPieces(spec);
        if (bottom.length === 0) {
          steps.push(step(`Product rule: a sum of logs is the log of the product: ${answer}.`, "Combine the sum of logs into one log: ?"));
        } else {
          if (top.length > 1) {
            steps.push(
              step(
                `Product rule: the added logs combine into ${logAns(spec.base, top.join(""))}.`,
                "Combine the added logs into one log: ?",
              ),
            );
          }
          steps.push(
            step(
              `Quotient rule: subtracting a log divides by its input: ${answer}.`,
              `Subtract the log of ${groupPlain(bottom)}: ?`,
            ),
          );
        }
        return {
          stem: `Assume every variable is positive. Write as a single logarithm. ${tex(stemTerms)}`,
          answer: kit.exprAns(answer),
          ...kit.withWorkedSteps(steps),
        };
      },
      { answerPalette: "logs", answerForm: "singleLog" },
    ),

    // ── Change of base ──────────────────────────────────────────────────────
    kit.T(
      "log_change_of_base",
      "integer",
      (r) => {
        const tier = r.int(0, 2);
        const g = r.pick([2, 2, 3, 5]);
        const maxPow = g === 2 ? 5 : g === 3 ? 4 : 3;
        if (tier === 0) {
          // log_{g^p}(g^q) = q/p with p ≥ 2 and q not a multiple of p.
          const { p, q } = draw(
            r,
            () => {
              const p = r.int(2, maxPow);
              const q = r.int(1, maxPow);
              return q % p === 0 ? null : { p, q };
            },
            { p: 3, q: 5 },
          );
          const B = g ** p;
          const N = g ** q;
          const value = rat(q, p);
          return {
            stem: `Use the change-of-base formula to evaluate ${tex(logTex(B, String(N)))}.`,
            ...numericAnswer(kit, value),
            ...kit.withWorkedSteps([
              step(
                `${B} and ${N} are both powers of ${g}, so change to base ${g}: ${logAns(B, String(N))} = ${logAns(g, String(N))} / ${logAns(g, String(B))}.`,
                `Rewrite ${logAns(B, String(N))} as a quotient of base-${g} logs: ?`,
              ),
              step(`${logAns(g, String(N))} = ${q} and ${logAns(g, String(B))} = ${p}.`, `Evaluate ${logAns(g, String(N))} and ${logAns(g, String(B))}: ?`),
              step(divideText(q, p, value), `Divide ${q} by ${p}: ?`),
            ]),
          };
        }
        if (tier === 1) {
          if (r.int(0, 1) === 0) {
            // A fractional base: log_{1/g^p}(g^q) = -q/p.
            const p = r.int(1, 2);
            const q = r.int(1, maxPow);
            const B = g ** p;
            const N = g ** q;
            const value = rat(-q, p);
            return {
              stem: `Use the change-of-base formula to evaluate ${tex(`\\log_{${fracTex(1, B)}}(${N})`)}.`,
              ...numericAnswer(kit, value),
              ...kit.withWorkedSteps([
                step(
                  `Change to base ${g}: log_(1/${B})(${N}) = ${logAns(g, String(N))} / ${logAns(g, `1/${B}`)}.`,
                  `Rewrite log_(1/${B})(${N}) as a quotient of base-${g} logs: ?`,
                ),
                step(`${logAns(g, String(N))} = ${q} and ${logAns(g, `1/${B}`)} = ${-p}.`, `Evaluate ${logAns(g, String(N))} and ${logAns(g, `1/${B}`)}: ?`),
                step(divideText(q, -p, value), `Divide ${q} by ${-p}: ?`),
              ]),
            };
          }
          // The formula read backwards: a quotient of logs in any base.
          const outer = r.pick<LogBase>([5, 7, 10, "e"]);
          const { p, q } = draw(
            r,
            () => {
              const p = r.int(1, maxPow);
              const q = r.int(1, maxPow);
              return p === q ? null : { p, q };
            },
            { p: 2, q: 5 },
          );
          const B = g ** p;
          const N = g ** q;
          const value = rat(q, p);
          return {
            stem: `Evaluate without a calculator. ${tex(fracTex(logTex(outer, String(N)), logTex(outer, String(B))))}`,
            ...numericAnswer(kit, value),
            ...kit.withWorkedSteps([
              step(
                `By the change-of-base formula, a quotient of logs in the same base is one log: ${logAns(outer, String(N))} / ${logAns(outer, String(B))} = ${logAns(B, String(N))}.`,
                "Write the quotient as a single logarithm: ?",
              ),
              step(
                `In base ${g}: ${logAns(g, String(N))} = ${q} and ${logAns(g, String(B))} = ${p}.`,
                `Evaluate ${logAns(g, String(N))} and ${logAns(g, String(B))}: ?`,
              ),
              step(divideText(q, p, value), `Divide ${q} by ${p}: ?`),
            ]),
          };
        }
        // log_{g^p}(h^q) · log_{h^s}(g^t) = qt/(ps).
        const [g2, h] = r.pick([
          [2, 3],
          [3, 2],
          [2, 5],
          [5, 2],
          [3, 5],
        ]);
        const p = r.int(1, 2);
        const s = r.int(1, 2);
        const q = r.int(1, h === 5 ? 3 : 4);
        const t = r.int(1, g2 === 5 ? 3 : 4);
        const value = rat(q * t, p * s);
        const A = g2 ** p;
        const Hq = h ** q;
        const Hs = h ** s;
        const Gt = g2 ** t;
        return {
          stem: `Use the change-of-base formula to evaluate ${tex(`${logTex(A, String(Hq))} \\cdot ${logTex(Hs, String(Gt))}`)}.`,
          ...numericAnswer(kit, value),
          ...kit.withWorkedSteps([
            step(
              `Change both to natural logs: ${logAns(A, String(Hq))} = ln(${Hq})/ln(${A}) and ${logAns(Hs, String(Gt))} = ln(${Gt})/ln(${Hs}).`,
              "Rewrite each factor as a quotient of natural logs: ?",
            ),
            step(
              `Use the power rule: ${[
                ...new Set(
                  [
                    [Hq, q, h],
                    [A, p, g2],
                    [Gt, t, g2],
                    [Hs, s, h],
                  ]
                    .filter(([, k]) => k > 1)
                    .map(([N, k, root]) => `ln(${N}) = ${k}ln(${root})`),
                ),
              ].join(", ") || "every input is already a prime"}.`,
              `Write each log in terms of ln(${g2}) and ln(${h}): ?`,
            ),
            step(
              `ln(${g2}) and ln(${h}) cancel, leaving (${q} · ${t})/(${p} · ${s}) = ${ratPlain(value)}.`,
              `Cancel ln(${g2}) and ln(${h}) and simplify: ?`,
            ),
          ]),
        };
      },
    ),

    // ── Solve an exponential equation with logarithms ───────────────────────
    kit.T(
      "exp_solve_with_logs",
      "expression",
      (r) => {
        const tier = r.int(0, 2);
        const pickValue = (base: number) =>
          draw(
            r,
            () => {
              const n = base === 10 ? r.pick([2, 3, 5, 7, 20, 50]) : r.int(3, 40);
              return isPowerOf(n, base) ? null : n;
            },
            7,
          );
        if (tier === 0) {
          const base = r.pick([2, 2, 3, 5, 10]);
          const N = pickValue(base);
          const answer = logAns(base, String(N));
          return {
            stem: `Solve for ${tex("x")}. Give an exact answer. ${tex(`${base}^{x} = ${N}`)}`,
            answer: kit.exprAns(answer),
            ...kit.withWorkedSteps([
              step(`${N} is not a whole power of ${base}, so use a logarithm.`, `Can ${N} be written as a whole power of ${base}?`),
              step(`Take ${baseWord(base)} of both sides: x = ${answer}.`, `Take ${baseWord(base)} of both sides: ?`),
            ]),
          };
        }
        if (tier === 1) {
          const base = r.pick([2, 2, 3, 5]);
          const shape = r.int(0, 2);
          const M = pickValue(base);
          if (shape === 0) {
            // a·b^x + k = c
            const a = r.int(2, 5);
            const k = r.pick([-9, -6, -4, -3, -1, 1, 2, 4, 5, 7]);
            const c = a * M + k;
            const answer = logAns(base, String(M));
            const kTex = k < 0 ? `- ${-k}` : `+ ${k}`;
            return {
              stem: `Solve for ${tex("x")}. Give an exact answer. ${tex(`${a} \\cdot ${base}^{x} ${kTex} = ${c}`)}`,
              answer: kit.exprAns(answer),
              ...kit.withWorkedSteps([
                step(`${k < 0 ? `Add ${-k} to` : `Subtract ${k} from`} both sides: ${a} · ${base}^x = ${a * M}.`, "Undo the added number: ?"),
                step(`Divide both sides by ${a}: ${base}^x = ${M}.`, `Divide both sides by ${a}: ?`),
                step(`Take ${baseWord(base)} of both sides: x = ${answer}.`, `Take ${baseWord(base)} of both sides: ?`),
              ]),
            };
          }
          if (shape === 1) {
            // b^(x + h) = N
            const h = r.pick([-3, -2, -1, 1, 2, 3]);
            const answer = h > 0 ? `${logAns(base, String(M))}-${h}` : `${logAns(base, String(M))}+${-h}`;
            const exponent = polyTex([1, h]);
            return {
              stem: `Solve for ${tex("x")}. Give an exact answer. ${tex(`${base}^{${exponent}} = ${M}`)}`,
              answer: kit.exprAns(answer),
              ...kit.withWorkedSteps([
                step(`Take ${baseWord(base)} of both sides: ${exponent} = ${logAns(base, String(M))}.`, `Take ${baseWord(base)} of both sides: ?`),
                step(`${h > 0 ? `Subtract ${h}` : `Add ${-h}`}: x = ${answer}.`, `Solve ${exponent} = ${logAns(base, String(M))} for x: ?`),
              ]),
            };
          }
          // b^(px) = N
          const p = r.int(2, 4);
          const answer = `${logAns(base, String(M))}/${p}`;
          return {
            stem: `Solve for ${tex("x")}. Give an exact answer. ${tex(`${base}^{${p}x} = ${M}`)}`,
            answer: kit.exprAns(answer),
            ...kit.withWorkedSteps([
              step(`Take ${baseWord(base)} of both sides: ${p}x = ${logAns(base, String(M))}.`, `Take ${baseWord(base)} of both sides: ?`),
              step(`Divide by ${p}: x = ${answer}.`, `Divide both sides by ${p}: ?`),
            ]),
          };
        }
        // b^x = c^(x + h): no common base, so x is collected from both sides.
        const [b, c] = r.pick([
          [2, 3],
          [3, 2],
          [2, 5],
          [5, 2],
          [3, 5],
          [5, 3],
          [2, 7],
          [7, 3],
        ]);
        const h = r.pick([1, 1, -1, -1, 2]);
        const numerator = h === 1 ? `ln(${c})` : h === -1 ? `ln(${c})` : `${h}ln(${c})`;
        const answer =
          h > 0 ? `${numerator}/(ln(${b})-ln(${c}))` : `${numerator}/(ln(${c})-ln(${b}))`;
        const exponent = polyTex([1, h]);
        const hLn = h === 1 ? `ln(${c})` : h === -1 ? `-ln(${c})` : `${h}ln(${c})`;
        return {
          stem: `Solve for ${tex("x")}. Give an exact answer. ${tex(`${b}^{x} = ${c}^{${exponent}}`)}`,
          answer: kit.exprAns(answer),
          ...kit.withWorkedSteps([
            step(`Take ln of both sides: x·ln(${b}) = (${exponent})·ln(${c}).`, "Take ln of both sides: ?"),
            step(`Distribute: x·ln(${b}) = x·ln(${c}) ${h > 0 ? "+" : "-"} ${hLn.replace(/^-/, "")}.`, "Multiply out the right side: ?"),
            step(
              `Collect the x terms: x(ln(${b}) - ln(${c})) = ${hLn}.`,
              "Move every x term to one side and factor out x: ?",
            ),
            step(`Divide: x = ${answer}.`, `Divide by the factor next to x: ?`),
          ]),
        };
      },
      { answerPalette: "logs" },
    ),

    // ── Logarithmic equations, with the domain check ────────────────────────
    kit.T(
      "log_solve_equation",
      "solutionSet",
      (r) => {
        const shape = r.int(0, 3);
        const lead = `Solve for ${tex("x")}. If no value works, answer No solution.`;
        if (shape === 0) {
          // log_b(ax + c) = k
          const base = r.pick([2, 2, 3, 5, 10]);
          const built = draw(
            r,
            () => {
              const k = r.int(1, base === 2 ? 5 : base === 3 ? 3 : 2);
              const a = r.pick([1, 2, 3]);
              const x0 = r.int(-5, 10);
              const c = base ** k - a * x0;
              if (Math.abs(c) > 20 || (a === 1 && c === 0)) return null;
              return { k, a, x0 };
            },
            { k: 1, a: 1, x0: 1 },
          );
          const { k, a, x0 } = built;
          const c = base ** k - a * x0;
          const inside = polyTex([a, c]);
          const answer = [String(x0)];
          return {
            stem: `${lead} ${tex(`${logTex(base, inside)} = ${k}`)}`,
            answer: kit.solutionSetAns(answer),
            ...kit.withWorkedSteps([
              step(`Rewrite in exponential form: ${inside} = ${plainPow(base, String(k))} = ${base ** k}.`, "Rewrite the equation as a power: ?"),
              step(`Solve ${inside} = ${base ** k}: x = ${x0}.`, `Solve ${inside} = ${base ** k}: ?`),
              step(
                `Check: the log's input is ${base ** k}, which is positive, so ${membersPlain(answer)}.`,
                "Check that the log's input is positive and give the solution: ?",
              ),
            ]),
          };
        }
        if (shape === 1) {
          // log_b(m1 x + n1) = log_b(m2 x + n2): one candidate, valid or not.
          const base = r.pick<LogBase>([2, 3, 10, "e"]);
          const built = draw(
            r,
            () => {
              const m1 = r.int(1, 4);
              const m2 = r.int(1, 4);
              if (m1 === m2) return null;
              const x0 = r.int(-6, 6);
              const n1 = r.int(-8, 8);
              const n2 = m1 * x0 + n1 - m2 * x0;
              if (Math.abs(n2) > 12 || n1 === 0 || n2 === 0) return null;
              return { m1, m2, x0, n1 };
            },
            { m1: 2, m2: 1, x0: -4, n1: 1 },
          );
          const { m1, m2, x0, n1 } = built;
          const n2 = m1 * x0 + n1 - m2 * x0;
          const valid = m1 * x0 + n1 > 0;
          const answer = valid ? [String(x0)] : [];
          const f = polyTex([m1, n1]);
          const g = polyTex([m2, n2]);
          return {
            stem: `${lead} ${tex(`${logTex(base, f)} = ${logTex(base, g)}`)}`,
            answer: kit.solutionSetAns(answer),
            ...kit.withWorkedSteps([
              step(`Equal logs with the same base have equal inputs: ${f} = ${g}.`, "Set the two inputs equal: ?"),
              step(`Solve: x = ${x0}.`, `Solve ${f} = ${g}: ?`),
              step(
                `Check: at x = ${x0} the inputs are ${m1 * x0 + n1} and ${m2 * x0 + n2}, and a log needs a positive input. So ${membersPlain(answer)}.`,
                `Check whether x = ${x0} gives positive inputs: ?`,
              ),
            ]),
          };
        }
        if (shape === 2) {
          // log_b(x + a) + log_b(x + c) = k: exactly one root survives.
          const [base, N] = r.pick<[number, number]>([
            [2, 4],
            [2, 8],
            [2, 16],
            [3, 9],
            [3, 27],
            [10, 10],
            [2, 32],
          ]);
          const k = Math.round(Math.log(N) / Math.log(base));
          const pairs: [number, number][] = [];
          for (let u = 1; u <= N; u++) if (N % u === 0 && u !== N / u) pairs.push([u, N / u]);
          const [u, v] = r.pick(pairs);
          const a = r.int(-4, 4);
          const c = v - u + a;
          const x1 = u - a;
          const x2 = -v - a;
          const product = [1, a + c, a * c - N];
          return {
            stem: `${lead} ${tex(`${logTex(base, polyTex([1, a]))} + ${logTex(base, polyTex([1, c]))} = ${k}`)}`,
            answer: kit.solutionSetAns([String(x1)]),
            ...kit.withWorkedSteps([
              step(
                `Product rule: ${logAns(base, `${linearFactor(-a)}${linearFactor(-c)}`)} = ${k}, so ${linearFactor(-a)}${linearFactor(-c)} = ${N}.`,
                "Combine the logs, then rewrite as a power: ?",
              ),
              step(
                `Expand and move ${N} over: ${plainPoly(product)} = 0, so x = ${x1} or x = ${x2}.`,
                `Solve ${linearFactor(-a)}${linearFactor(-c)} = ${N}: ?`,
              ),
              step(
                `Check: x = ${x2} makes the input of ${logAns(base, plainPoly([1, a]).replace(/ /g, ""))} equal ${x2 + a}, which is negative, so reject it. The solution is x = ${x1}.`,
                "Check each candidate: does every log get a positive input?",
              ),
            ]),
          };
        }
        // log_b(x + a) + log_b(x + c) = log_b(mx + n): zero, one or two survive.
        const base = r.pick<LogBase>([2, 3, 10, "e"]);
        const built = draw(
          r,
          () => {
            const a = r.int(-4, 4);
            const c = r.int(-4, 4);
            if (a >= c) return null;
            const r1 = r.int(-6, 7);
            const r2 = r.int(-6, 7);
            if (r1 >= r2) return null;
            const m = a + c + r1 + r2;
            const n = a * c - r1 * r2;
            if (m < 1 || m > 9 || Math.abs(n) > 30) return null;
            if (m === 1 && (n === a || n === c)) return null;
            return { a, c, r1, r2 };
          },
          { a: -2, c: 1, r1: 1, r2: 3 },
        );
        const { a, c, r1, r2 } = built;
        // (x + a)(x + c) − (mx + n) = (x − r1)(x − r2), so the roots are r1, r2.
        const m = a + c + r1 + r2;
        const n = a * c - r1 * r2;
        const survives = (x: number) => x + a > 0 && x + c > 0;
        const answer = [r1, r2].filter(survives).map(String);
        const rejected = [r1, r2].filter((x) => !survives(x));
        return {
          stem: `${lead} ${tex(
            `${logTex(base, polyTex([1, a]))} + ${logTex(base, polyTex([1, c]))} = ${logTex(base, polyTex([m, n]))}`,
          )}`,
          answer: kit.solutionSetAns(answer),
          ...kit.withWorkedSteps([
            step(
              `Product rule on the left, then equal logs have equal inputs: ${linearFactor(-a)}${linearFactor(-c)} = ${plainPoly([m, n])}.`,
              "Combine the left side into one log and set the inputs equal: ?",
            ),
            step(
              `Expand and collect: ${plainPoly([1, -(r1 + r2), r1 * r2])} = 0, which factors as ${linearFactor(r1)}${linearFactor(r2)} = 0, so x = ${r1} or x = ${r2}.`,
              "Rearrange to a quadratic equal to 0 and solve it: ?",
            ),
            step(
              rejected.length === 0
                ? `Check: both give positive inputs to every log, so ${membersPlain(answer)}.`
                : `Check: ${rejected.map((x) => `x = ${x}`).join(" and ")} make${rejected.length === 1 ? "s" : ""} a log input zero or negative, so reject${rejected.length === 1 ? " it" : " them"}. That leaves ${membersPlain(answer)}.`,
              "Check each candidate in the original logs: ?",
            ),
          ]),
        };
      },
      { answerPalette: "logs" },
    ),

    // ── e and the natural logarithm ─────────────────────────────────────────
    kit.T(
      "exp_natural_base",
      "expression",
      (r) => {
        const tier = r.int(0, 2);
        if (tier === 0) {
          const shape = r.int(0, 2);
          if (shape === 0) {
            const N = r.int(2, 30);
            return {
              stem: `Solve for ${tex("x")}. Give an exact answer. ${tex(`e^{x} = ${N}`)}`,
              answer: kit.exprAns(`ln(${N})`),
              ...kit.withWorkedSteps([
                step("ln undoes e: ln(e^x) = x.", "What does ln do to e^x?"),
                step(`Take ln of both sides: x = ln(${N}).`, "Take ln of both sides: ?"),
              ]),
            };
          }
          if (shape === 1) {
            const k = r.pick([2, 3, 4, 5]);
            const N = r.int(2, 20);
            return {
              stem: `Solve for ${tex("x")}. Give an exact answer. ${tex(`e^{${k}x} = ${N}`)}`,
              answer: kit.exprAns(`ln(${N})/${k}`),
              ...kit.withWorkedSteps([
                step(`Take ln of both sides: ${k}x = ln(${N}).`, "Take ln of both sides: ?"),
                step(`Divide by ${k}: x = ln(${N})/${k}.`, `Divide both sides by ${k}: ?`),
              ]),
            };
          }
          const k = r.pick([-2, -1, 2, 3, 4]);
          const kAns = k < 0 ? `(${k})` : String(k);
          return {
            stem: `Solve for ${tex("x")}. Give an exact answer. ${tex(`\\ln(x) = ${k}`)}`,
            answer: kit.exprAns(`e^${kAns}`),
            ...kit.withWorkedSteps([
              step("ln is the logarithm with base e, so ln(x) = k means e^k = x.", "Rewrite ln(x) = k as a power of e: ?"),
              step(`So x = e^${kAns}.`, "Write x as a power of e: ?"),
            ]),
          };
        }
        if (tier === 1) {
          if (r.int(0, 1) === 0) {
            // a·e^(kx) + c = d
            const a = r.int(2, 5);
            const M = r.int(2, 12);
            const k = r.pick([1, 2, 3, -1]);
            const c = r.pick([-5, -3, -1, 2, 4, 6]);
            const d = a * M + c;
            const exponent = k === 1 ? "x" : k === -1 ? "-x" : `${k}x`;
            const answer = k === 1 ? `ln(${M})` : k === -1 ? `-ln(${M})` : `ln(${M})/${k}`;
            const cTex = c < 0 ? `- ${-c}` : `+ ${c}`;
            return {
              stem: `Solve for ${tex("x")}. Give an exact answer. ${tex(`${a}e^{${exponent}} ${cTex} = ${d}`)}`,
              answer: kit.exprAns(answer),
              ...kit.withWorkedSteps([
                step(`${c < 0 ? `Add ${-c}` : `Subtract ${c}`}, then divide by ${a}: e^(${exponent}) = ${M}.`, "Get the power of e by itself: ?"),
                step(`Take ln of both sides: ${exponent} = ln(${M}).`, "Take ln of both sides: ?"),
                step(`Solve for x: x = ${answer}.`, `Solve ${exponent} = ln(${M}) for x: ?`),
              ]),
            };
          }
          // ln(ax + c) = k → x = (e^k − c)/a
          const a = r.int(2, 4);
          const c = r.pick([-5, -3, -1, 1, 2, 4]);
          const k = r.int(1, 3);
          const top = c < 0 ? `e^${k}+${-c}` : `e^${k}-${c}`;
          const answer = `(${top})/${a}`;
          const inside = polyTex([a, c]);
          return {
            stem: `Solve for ${tex("x")}. Give an exact answer. ${tex(`\\ln(${inside}) = ${k}`)}`,
            answer: kit.exprAns(answer),
            ...kit.withWorkedSteps([
              step(`Rewrite as a power of e: ${inside} = e^${k}.`, "Rewrite the equation as a power of e: ?"),
              step(`${c < 0 ? `Add ${-c}` : `Subtract ${c}`}: ${a}x = ${top}.`, "Undo the added number: ?"),
              step(`Divide by ${a}: x = ${answer}.`, `Divide both sides by ${a}: ?`),
            ]),
          };
        }
        // Continuous growth or decay: A = P e^(rt).
        const [rate, inverse] = r.pick<[string, number]>([
          ["0.02", 50],
          ["0.04", 25],
          ["0.05", 20],
          ["0.1", 10],
          ["0.25", 4],
        ]);
        const factor = r.pick([2, 3, 5, 10]);
        const P = r.pick([20, 50, 100, 200, 500]);
        const growth = r.int(0, 2) !== 0;
        const percent = Math.round(Number(rate) * 100);
        const answer = `${inverse}ln(${factor})`;
        if (growth) {
          return {
            stem: `A population grows continuously at ${percent}% per year: ${tex(`P = ${P}e^{${rate}t}`)}. After how many years is it ${P * factor}? Give an exact answer.`,
            answer: kit.exprAns(answer),
            ...kit.withWorkedSteps([
              step(`Set P = ${P * factor} and divide by ${P}: e^(${rate}t) = ${factor}.`, `Set P = ${P * factor} and divide by ${P}: ?`),
              step(`Take ln of both sides: ${rate}t = ln(${factor}).`, "Take ln of both sides: ?"),
              step(`Divide by ${rate}: t = ${answer}.`, `Divide both sides by ${rate}: ?`),
            ]),
          };
        }
        const start = P * factor;
        return {
          stem: `A quantity decays continuously: ${tex(`A = ${start}e^{-${rate}t}`)}, with ${tex("t")} in hours. After how many hours is ${P} left? Give an exact answer.`,
          answer: kit.exprAns(answer),
          ...kit.withWorkedSteps([
            step(`Set A = ${P} and divide by ${start}: e^(-${rate}t) = 1/${factor}.`, `Set A = ${P} and divide by ${start}: ?`),
            step(`Take ln of both sides: -${rate}t = ln(1/${factor}) = -ln(${factor}).`, "Take ln of both sides: ?"),
            step(`Divide by -${rate}: t = ${answer}.`, `Divide both sides by -${rate}: ?`),
          ]),
        };
      },
      { answerPalette: "logs" },
    ),

    // ── Doubling time and half-life ─────────────────────────────────────────
    kit.T(
      "exp_model_doubling_halflife",
      "expression",
      (r) => {
        const tier = r.int(0, 2);
        if (tier === 0) {
          const kind = r.int(0, 2);
          if (kind === 0) {
            const D = r.pick([2, 3, 4, 5, 6]);
            const P = r.pick([10, 25, 50, 100, 300]);
            const m = r.int(3, 7);
            const target = P * 2 ** m;
            const thing = r.pick(["A colony of cells", "The number of views of a video", "A shared file's download count"]);
            const unit = r.pick(["hours", "days"]);
            return {
              stem: `${thing} starts at ${P} and doubles every ${D} ${unit}. After how many ${unit} is it ${target}?`,
              ...numericAnswer(kit, rat(m * D)),
              ...kit.withWorkedSteps([
                step(`Model: A = ${P} · 2^(t/${D}).`, "Write the doubling model: ?"),
                step(`Set A = ${target} and divide by ${P}: 2^(t/${D}) = ${2 ** m}.`, `Set A = ${target} and divide by ${P}: ?`),
                step(`${2 ** m} = 2^${m}, so t/${D} = ${m}.`, `Write ${2 ** m} as a power of 2 and match exponents: ?`),
                step(`Multiply by ${D}: t = ${m * D}.`, `Multiply both sides by ${D}: ?`),
              ]),
            };
          }
          if (kind === 1) {
            const H = r.pick([3, 5, 6, 8, 10]);
            const m = r.int(2, 6);
            const left = r.pick([2, 3, 5, 6]);
            const start = left * 2 ** m;
            return {
              stem: `A sample of ${start} grams has a half-life of ${H} days. After how many days are ${left} grams left?`,
              ...numericAnswer(kit, rat(m * H)),
              ...kit.withWorkedSteps([
                step(`Model: A = ${start} · (1/2)^(t/${H}).`, "Write the half-life model: ?"),
                step(`Set A = ${left} and divide by ${start}: (1/2)^(t/${H}) = 1/${2 ** m}.`, `Set A = ${left} and divide by ${start}: ?`),
                step(`1/${2 ** m} = (1/2)^${m}, so t/${H} = ${m}.`, `Write 1/${2 ** m} as a power of 1/2 and match exponents: ?`),
                step(`Multiply by ${H}: t = ${m * H}.`, `Multiply both sides by ${H}: ?`),
              ]),
            };
          }
          // A program's running time doubles each time the input grows by s items.
          const s = r.pick([5, 10, 20]);
          const n0 = r.pick([10, 20, 40]);
          const t0 = r.pick([1, 2, 3]);
          const m = r.int(3, 8);
          return {
            stem: `A program takes ${t0} ms on ${n0} items, and its running time doubles every time the input grows by ${s} items. How many items take ${t0 * 2 ** m} ms?`,
            ...numericAnswer(kit, rat(n0 + m * s)),
            ...kit.withWorkedSteps([
              step(`Model: time = ${t0} · 2^((n - ${n0})/${s}).`, "Write the doubling model in the number of items n: ?"),
              step(`Divide by ${t0}: 2^((n - ${n0})/${s}) = ${2 ** m}.`, `Set the time to ${t0 * 2 ** m} and divide by ${t0}: ?`),
              step(`${2 ** m} = 2^${m}, so (n - ${n0})/${s} = ${m}.`, `Write ${2 ** m} as a power of 2 and match exponents: ?`),
              step(`Solve: n = ${n0} + ${m} · ${s} = ${n0 + m * s}.`, `Solve (n - ${n0})/${s} = ${m}: ?`),
            ]),
          };
        }
        if (tier === 1) {
          // Read the doubling time or half-life off a bigger factor.
          const m = r.int(2, 5);
          const D = r.int(2, 6);
          const T = m * D;
          if (r.int(0, 1) === 0) {
            return {
              stem: `A quantity grows by a factor of ${2 ** m} every ${T} years. What is its doubling time, in years?`,
              ...numericAnswer(kit, rat(D)),
              ...kit.withWorkedSteps([
                step(`${2 ** m} = 2^${m}, so the quantity doubles ${m} times in ${T} years.`, `How many doublings make a factor of ${2 ** m}?`),
                step(`Each doubling takes ${T}/${m} = ${D} years.`, `Divide ${T} years by ${m} doublings: ?`),
              ]),
            };
          }
          return {
            stem: `A sample shrinks to ${tex(fracTex(1, 2 ** m))} of its mass in ${T} minutes. What is its half-life, in minutes?`,
            ...numericAnswer(kit, rat(D)),
            ...kit.withWorkedSteps([
              step(`1/${2 ** m} = (1/2)^${m}, so the sample halves ${m} times in ${T} minutes.`, `How many halvings make 1/${2 ** m}?`),
              step(`Each halving takes ${T}/${m} = ${D} minutes.`, `Divide ${T} minutes by ${m} halvings: ?`),
            ]),
          };
        }
        // A factor that is not a power of 2: the answer needs a logarithm.
        const R = r.pick([3, 5, 6, 10, 12]);
        if (r.int(0, 1) === 0) {
          const D = r.pick([2, 3, 4, 5]);
          const P = r.pick([10, 50, 100, 200]);
          const answer = `${D}log_2(${R})`;
          return {
            stem: `A colony of ${P} cells doubles every ${D} hours. After how many hours are there ${P * R} cells? Give an exact answer.`,
            answer: kit.exprAns(answer),
            ...kit.withWorkedSteps([
              step(`Model: A = ${P} · 2^(t/${D}).`, "Write the doubling model: ?"),
              step(`Set A = ${P * R} and divide by ${P}: 2^(t/${D}) = ${R}.`, `Set A = ${P * R} and divide by ${P}: ?`),
              step(`Take log base 2: t/${D} = log_2(${R}).`, "Take log base 2 of both sides: ?"),
              step(`Multiply by ${D}: t = ${answer}.`, `Multiply both sides by ${D}: ?`),
            ]),
          };
        }
        const H = r.pick([2, 4, 5, 8]);
        const left = r.pick([2, 4, 10]);
        const start = left * R;
        const answer = `${H}log_2(${R})`;
        return {
          stem: `A sample of ${start} grams has a half-life of ${H} years. After how many years are ${left} grams left? Give an exact answer.`,
          answer: kit.exprAns(answer),
          ...kit.withWorkedSteps([
            step(`Model: A = ${start} · (1/2)^(t/${H}).`, "Write the half-life model: ?"),
            step(`Set A = ${left} and divide by ${start}: (1/2)^(t/${H}) = 1/${R}, so 2^(t/${H}) = ${R}.`, `Set A = ${left}, divide by ${start}, and flip both sides: ?`),
            step(`Take log base 2: t/${H} = log_2(${R}).`, "Take log base 2 of both sides: ?"),
            step(`Multiply by ${H}: t = ${answer}.`, `Multiply both sides by ${H}: ?`),
          ]),
        };
      },
      { answerPalette: "logs" },
    ),
  ];
}

// ── The log-of-a-product model shared by expand and condense ────────────────

type LogFactor = { v: string; p: Rat; den: boolean };
type LogProductSpec = {
  base: LogBase;
  /** The constant inside is base^constPower (0 = none); for base e it is e^k. */
  constPower: number;
  factors: LogFactor[];
};

function logProductSpec(r: Rng): LogProductSpec {
  const tier = r.int(0, 2);
  const base = r.pick<LogBase>([2, 2, 3, 5, 10, "e"]);
  const maxConst = base === 2 ? 4 : base === "e" ? 2 : 2;
  if (tier === 0) {
    if (r.int(0, 2) === 0) {
      return { base, constPower: r.int(1, maxConst), factors: [{ v: "x", p: rat(1), den: r.int(0, 1) === 0 }] };
    }
    return {
      base,
      constPower: 0,
      factors: [
        { v: "x", p: rat(1), den: false },
        { v: "y", p: rat(1), den: r.int(0, 1) === 0 },
      ],
    };
  }
  if (tier === 1) {
    return {
      base,
      constPower: r.int(0, 1) === 0 ? 0 : r.int(1, maxConst),
      factors: [
        { v: "x", p: rat(r.int(2, 4)), den: false },
        { v: "y", p: rat(r.int(1, 3)), den: r.int(0, 1) === 0 },
      ],
    };
  }
  // A root and a quotient together, still in x and y only (the pad has no z):
  // one variable under a square root, the other a power, one of them on the bottom.
  const rootOnX = r.int(0, 1) === 0;
  const xDen = r.int(0, 1) === 0;
  return {
    base,
    constPower: r.int(0, 2) === 0 ? r.int(1, maxConst) : 0,
    factors: [
      { v: "x", p: rootOnX ? rat(1, 2) : rat(r.int(2, 4)), den: xDen },
      { v: "y", p: rootOnX ? rat(r.int(2, 4)) : rat(1, 2), den: !xDen },
    ],
  };
}

function constValue(spec: LogProductSpec): number | null {
  if (spec.constPower === 0 || spec.base === "e") return null;
  return spec.base ** spec.constPower;
}

function constPlain(spec: LogProductSpec): string {
  return spec.base === "e" ? `e^${spec.constPower}` : String(constValue(spec));
}

function constTex(spec: LogProductSpec): string {
  return spec.base === "e" ? `e^{${spec.constPower}}` : String(constValue(spec));
}

function factorTex(f: LogFactor): string {
  if (f.p.d === 2 && f.p.n === 1) return `\\sqrt{${f.v}}`;
  if (f.p.d === 3 && f.p.n === 1) return `\\sqrt[3]{${f.v}}`;
  return f.p.n === 1 ? f.v : `${f.v}^{${f.p.n}}`;
}

function factorPlain(f: LogFactor): string {
  if (f.p.d === 2 && f.p.n === 1) return `√(${f.v})`;
  if (f.p.d === 3 && f.p.n === 1) return `∛(${f.v})`;
  return f.p.n === 1 ? f.v : `${f.v}^${f.p.n}`;
}

function numeratorPieces(spec: LogProductSpec): string[] {
  const pieces = spec.constPower > 0 ? [constPlain(spec)] : [];
  return [...pieces, ...spec.factors.filter((f) => !f.den).map(factorPlain)];
}

function denominatorPieces(spec: LogProductSpec): string[] {
  return spec.factors.filter((f) => f.den).map(factorPlain);
}

function groupPlain(pieces: readonly string[]): string {
  return pieces.length > 1 ? `(${pieces.join("")})` : pieces.join("");
}

function argTex(spec: LogProductSpec): string {
  const top = (spec.constPower > 0 ? constTex(spec) : "") + spec.factors.filter((f) => !f.den).map(factorTex).join("");
  const bottom = spec.factors.filter((f) => f.den).map(factorTex).join("");
  return bottom === "" ? top : fracTex(top, bottom);
}

/** `log_2(x^2y/z^3)`'s argument in answer grammar. */
function condensedArg(spec: LogProductSpec): string {
  const top = numeratorPieces(spec).join("");
  const bottom = denominatorPieces(spec);
  return bottom.length === 0 ? top : `${top}/${groupPlain(bottom)}`;
}

/** A coefficient in front of a log: "", "3", "(1/2)". */
function coefPlain(p: Rat): string {
  if (p.n === 1 && p.d === 1) return "";
  return p.d === 1 ? String(p.n) : `(${ratAns(p)})`;
}

function coefTex(p: Rat): string {
  if (p.n === 1 && p.d === 1) return "";
  return p.d === 1 ? String(p.n) : fracTex(p.n, p.d);
}

/** The fully expanded form in answer grammar: `3+3log_2(x)-log_2(y)`. */
function expandedAns(spec: LogProductSpec): string {
  let out = spec.constPower > 0 ? String(spec.constPower) : "";
  for (const f of spec.factors) {
    const term = `${coefPlain(f.p)}${logAns(spec.base, f.v)}`;
    if (f.den) out += `-${term}`;
    else out += out === "" ? term : `+${term}`;
  }
  return out;
}

/** The expanded form as LaTeX for the condense stem. A constant is a number
 *  when it is a whole power of the base, written as `+ 3`. */
function expandedTex(spec: LogProductSpec): string {
  let out = "";
  for (const f of spec.factors) {
    const term = `${coefTex(f.p)}${logTex(spec.base, f.v)}`;
    if (f.den) out += out === "" ? `-${term}` : ` - ${term}`;
    else out += out === "" ? term : ` + ${term}`;
  }
  if (spec.constPower > 0) out += ` + ${spec.constPower}`;
  return out;
}
