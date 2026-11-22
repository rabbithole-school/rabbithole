/**
 * Algebra 2 — radicals and rational exponents (strand
 * `radicals-rational-exponents`).
 *
 * Each family draws its answer first and builds the question from it. Where
 * the skill is a rewrite (convert, rationalize, combine), the item asks for a
 * form, so typing the question back is a value-equal answer that gets a form
 * nudge rather than credit. Where no form could tell a finished answer from
 * the question (an evaluated number, a simplified exponent), the item asks for
 * a plain number instead.
 */
import type { WorkedStep } from "../fadedSteps";
import type { Algebra2Kit, Rng, Template } from "../templates";
import { fracTex, polyAns, polyTex, tex } from "./format";

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

/** A nonzero integer in [-max, -min] ∪ [min, max]. */
/** How many random draws a retry makes before its fallback. Tests set it to
 *  0 to serve (and check) every fallback. */
export const RADICAL_DRAW = { attempts: 31 };

function signedInt(r: Rng, min: number, max: number): number {
  const n = r.int(min, max);
  return r.int(0, 1) === 0 ? n : -n;
}

/** Largest k with k² dividing n, and the square-free rest: 90 → [3, 10]. */
function splitSquare(n: number): [number, number] {
  let k = 1;
  for (let f = 2; f * f <= n; f++) if (n % (f * f) === 0) k = f;
  return [k, n / (k * k)];
}

/** `k√m` in the answer grammar; m = 1 means a plain integer. */
function surdAns(k: number, m: number): string {
  if (m === 1 || k === 0) return String(k);
  return `${k === 1 ? "" : k === -1 ? "-" : k}√${m}`;
}

/** `k\sqrt{m}` in LaTeX. */
function surdTex(k: number, m: number): string {
  if (m === 1 || k === 0) return String(k);
  return `${k === 1 ? "" : k === -1 ? "-" : k}\\sqrt{${m}}`;
}

/** `X + Y√m` (either part may be zero) in the answer grammar. */
function binomialSurdAns(x: number, y: number, m: number): string {
  if (y === 0) return String(x);
  const root = surdAns(y, m);
  if (x === 0) return root;
  return root.startsWith("-") ? `${x}${root}` : `${x}+${root}`;
}

/** `X + Y\sqrt{m}` in LaTeX. */
function binomialSurdTex(x: number, y: number, m: number): string {
  if (y === 0) return String(x);
  const root = surdTex(Math.abs(y), m);
  if (x === 0) return y < 0 ? `-${root}` : root;
  return `${x} ${y < 0 ? "-" : "+"} ${root}`;
}

/** The root sign for index n in the answer grammar: √, ∛, √[n]. */
function rootAns(n: number, radicand: string): string {
  const bare = /^[a-z0-9]$/.test(radicand) || /^\d+$/.test(radicand);
  const body = bare ? radicand : `(${radicand})`;
  if (n === 2) return `√${body}`;
  if (n === 3) return `∛${body}`;
  return `√[${n}]${bare ? `(${radicand})` : body}`;
}

/** LaTeX root of index n. */
function rootTex(n: number, radicand: string): string {
  return n === 2 ? `\\sqrt{${radicand}}` : `\\sqrt[${n}]{${radicand}}`;
}

const ROOT_WORD: Record<number, string> = { 2: "square", 3: "cube", 4: "fourth", 5: "fifth" };

/** Base^(m/n) in the answer grammar (exponent always parenthesised). */
function powAns(base: string, m: number, n: number): string {
  return `${base}^(${ratAns(m, n)})`;
}

/** Base^{m/n} in LaTeX. */
function powTex(base: string, m: number, n: number): string {
  return `${base}^{${ratTex(m, n)}}`;
}

export function radicalsTemplates(kit: Algebra2Kit): Template[] {
  const { T, exprAns, fracAns, solutionSetAns, withWorkedSteps } = kit;

  // ── rexp_convert ──────────────────────────────────────────────────────────
  // Both directions; the draw's own `answerForm` says which notation it wants.
  const convert = T(
    "rexp_convert",
    "expression",
    (r) => {
      const tier = r.int(0, 2);
      const toExponent = r.int(0, 1) === 0;
      const n = r.pick([2, 3, 4, 5]);
      let m = tier === 0 ? 1 : r.int(2, 5);
      while (gcd(m, n) !== 1) m += 1;
      const numeric = tier === 2 && r.int(0, 1) === 0;
      const reciprocal = tier === 2 && !numeric;
      const base = numeric ? String(r.pick([2, 3, 5, 6, 7, 10])) : "x";
      const sign = reciprocal ? -1 : 1;
      const inner = m === 1 ? base : `${base}^${m}`;
      const innerTex = m === 1 ? base : `${base}^{${m}}`;
      const radical = rootAns(n, inner);
      const radicalTex = rootTex(n, innerTex);
      const radicalAnswer = reciprocal ? `1/${radical}` : radical;
      const radicalStem = reciprocal ? fracTex(1, radicalTex) : radicalTex;
      const exponentAnswer = powAns(base, sign * m, n);
      const exponentStem = powTex(base, sign * m, n);
      const indexWord = ROOT_WORD[n];
      if (toExponent) {
        const steps: WorkedStep[] = [
          {
            text: `The index of the root becomes the denominator of the exponent: a ${indexWord} root gives a denominator of ${n}.`,
            blankText: "Find the denominator from the root's index: ?",
          },
          {
            text: `The power inside the root becomes the numerator: ${m}.`,
            blankText: "Find the numerator from the power inside: ?",
          },
        ];
        if (reciprocal) {
          steps.push({
            text: `Dividing by a power makes the exponent negative: 1/${base}^(${m}/${n}) = ${base}^(-${m}/${n}).`,
            blankText: "Move the power out of the denominator: ?",
          });
        }
        steps.push({
          text: `So ${radicalAnswer} = ${exponentAnswer}.`,
          blankText: "Write the power with its fractional exponent: ?",
        });
        return {
          stem: `Write ${tex(radicalStem)} using a rational exponent.${base === "x" ? " Assume x is positive." : ""}`,
          answer: exprAns(exponentAnswer),
          answerForm: "exponentForm" as const,
          ...withWorkedSteps(steps),
        };
      }
      const steps: WorkedStep[] = [
        {
          text: `The denominator of the exponent, ${n}, is the index of the root: a ${indexWord} root.`,
          blankText: "Find the root's index from the denominator: ?",
        },
        {
          text: `The numerator, ${m}, is the power inside the root: ${inner}.`,
          blankText: "Find the power inside from the numerator: ?",
        },
      ];
      if (reciprocal) {
        steps.push({
          text: `A negative exponent means a reciprocal: ${base}^(-${m}/${n}) = 1/${base}^(${m}/${n}).`,
          blankText: "Rewrite the negative exponent as a reciprocal: ?",
        });
      }
      steps.push({
        text: `So ${exponentAnswer} = ${radicalAnswer}.`,
        blankText: "Write it with a root sign: ?",
      });
      return {
        stem: `Write ${tex(exponentStem)} in radical form.${base === "x" ? " Assume x is positive." : ""}`,
        answer: exprAns(radicalAnswer),
        answerForm: "radicalForm" as const,
        ...withWorkedSteps(steps),
      };
    },
    { answerPalette: "algebra" },
  );

  // ── rexp_evaluate ─────────────────────────────────────────────────────────
  // b^(m/n) with b a perfect nth power; the answer is a number (typed as a
  // fraction so the question itself cannot be typed back as an answer).
  const evaluate = T("rexp_evaluate", "fraction", (r) => {
    const tier = r.int(0, 2);
    const n = r.pick([2, 2, 3, 3, 4, 5]);
    const maxRoot: Record<number, number> = { 2: 9, 3: 5, 4: 3, 5: 3 };
    const root = r.int(2, maxRoot[n]);
    let m = 1;
    if (tier > 0) {
      m = r.int(2, n + 1);
      while (gcd(m, n) !== 1) m += 1;
      while (m > 1 && Math.pow(root, m) > 300) m -= 1;
      if (gcd(m, n) !== 1) m = 1;
    }
    const kind = tier < 2 ? "plain" : r.pick<"negative" | "fractionBase" | "negativeBase">(["negative", "fractionBase", "negativeBase"]);
    const power = (k: number) => Math.pow(k, m);
    const readExponent = (index: number, numerator: number): WorkedStep => ({
      text:
        numerator === 1
          ? `Read the exponent: 1/${index} means the ${ROOT_WORD[index]} root.`
          : `Read the exponent: the denominator ${index} means the ${ROOT_WORD[index]} root, and the numerator ${numerator} means the power ${numerator}.`,
      blankText: "Say what the exponent's denominator and numerator mean: ?",
    });
    if (kind === "fractionBase") {
      // (p/q)^(m/n) with p, q perfect nth powers — n = 2 or 3 keeps them small.
      const nn = r.pick([2, 3]);
      const pr = r.int(1, nn === 2 ? 5 : 3);
      let qr = r.int(2, nn === 2 ? 7 : 4);
      if (qr === pr) qr += 1;
      let mm = r.pick([1, 2, 3]);
      while (gcd(mm, nn) !== 1) mm += 1;
      const negativeExponent = r.int(0, 1) === 0;
      const p = Math.pow(pr, nn);
      const q = Math.pow(qr, nn);
      const [num, den] = negativeExponent
        ? [Math.pow(qr, mm), Math.pow(pr, mm)]
        : [Math.pow(pr, mm), Math.pow(qr, mm)];
      const [rn, rd] = reduce(num, den);
      const exponent = negativeExponent ? -mm : mm;
      const steps: WorkedStep[] = [readExponent(nn, mm)];
      if (negativeExponent) {
        steps.push({
          text: `A negative exponent flips the fraction: (${p}/${q})^(${ratAns(exponent, nn)}) = (${q}/${p})^(${ratAns(mm, nn)}).`,
          blankText: "Flip the fraction to make the exponent positive: ?",
        });
      }
      const [tp, tq] = negativeExponent ? [q, p] : [p, q];
      const [rp, rq] = negativeExponent ? [qr, pr] : [pr, qr];
      steps.push({
        text: `Take the ${ROOT_WORD[nn]} root of the top and the bottom: ${tp} → ${rp} and ${tq} → ${rq}.`,
        blankText: `Take the ${ROOT_WORD[nn]} root of the top and the bottom: ?`,
      });
      steps.push({
        text:
          mm === 1
            ? `The numerator of the exponent is 1, so the value is ${ratAns(rn, rd)}.`
            : `Raise both to the power ${mm}: ${rp}^${mm}/${rq}^${mm} = ${ratAns(rn, rd)}.`,
        blankText: mm === 1 ? "Write the fraction: ?" : `Raise the top and the bottom to the power ${mm}: ?`,
      });
      return {
        stem: `Evaluate ${tex(`\\left(${fracTex(p, q)}\\right)^{${ratTex(exponent, nn)}}`)}.`,
        answer: fracAns(rn, rd),
        ...withWorkedSteps(steps),
      };
    }
    if (kind === "negativeBase") {
      // (−b)^(m/n) with n and m odd, so the real odd root is the value.
      // [root index, root, odd numerator]
      const [nn, rr, odd] = r.pick<[number, number, number]>([
        [3, r.int(2, 5), 1],
        [3, 2, 5],
        [5, 2, 1],
        [5, 2, 3],
      ]);
      const b = Math.pow(rr, nn);
      const value = -Math.pow(rr, odd);
      return {
        stem: `Evaluate ${tex(`(-${b})^{${ratTex(odd, nn)}}`)}.`,
        answer: fracAns(value, 1),
        ...withWorkedSteps([
          readExponent(nn, odd),
          {
            text: `An odd root of a negative number is negative: the ${ROOT_WORD[nn]} root of -${b} is -${rr}, since (-${rr})^${nn} = -${b}.`,
            blankText: `Take the ${ROOT_WORD[nn]} root of -${b}: ?`,
          },
          {
            text:
              odd === 1
                ? `The numerator of the exponent is 1, so the value is ${value}.`
                : `Raise it to the power ${odd}: (-${rr})^${odd} = ${value}.`,
            blankText: odd === 1 ? "Write the value: ?" : `Raise -${rr} to the power ${odd}: ?`,
          },
        ]),
      };
    }
    const base = Math.pow(root, n);
    const negative = kind === "negative";
    const value = power(root);
    const [num, den] = negative ? [1, value] : [value, 1];
    const steps: WorkedStep[] = [readExponent(n, m)];
    if (negative) {
      steps.push({
        text: `A negative exponent means a reciprocal: ${base}^(-${ratAns(m, n)}) = 1/${base}^(${ratAns(m, n)}).`,
        blankText: "Rewrite the negative exponent as a reciprocal: ?",
      });
    }
    steps.push({
      text: `Take the ${ROOT_WORD[n]} root: ${base} = ${root}^${n}, so the root is ${root}.`,
      blankText: `Take the ${ROOT_WORD[n]} root of ${base}: ?`,
    });
    steps.push({
      text:
        m === 1
          ? `The numerator is 1, so ${base}^(1/${n}) = ${ratAns(num, den)}.`
          : `The numerator ${m} means a power: ${root}^${m} = ${value}${negative ? `, so the value is 1/${value}` : ""}.`,
      blankText: m === 1 ? "Write the value: ?" : `Raise ${root} to the power ${m}${negative ? " and take the reciprocal" : ""}: ?`,
    });
    return {
      stem: `Evaluate ${tex(powTex(String(base), negative ? -m : m, n))}.`,
      answer: fracAns(num, den),
      ...withWorkedSteps(steps),
    };
  });

  // ── rexp_simplify ─────────────────────────────────────────────────────────
  // Combine powers of x into one power x^k and give k. Asking for the exponent
  // keeps the item about the exponent rules, and a typed number can't be the
  // question copied back (no answer form tells x^(5/6) from x^(1/2)·x^(1/3)).
  const simplify = T("rexp_simplify", "fraction", (r) => {
    const tier = r.int(0, 2);
    const properFraction = (): [number, number] => {
      const d = r.pick([2, 3, 4, 5, 6]);
      let n = r.int(1, d + 2);
      while (gcd(n, d) !== 1) n += 1;
      return [n, d];
    };
    const steps: WorkedStep[] = [];
    let stemTex: string;
    let kn: number;
    let kd: number;
    const pick = tier === 0 ? r.int(0, 1) : tier === 1 ? r.int(1, 2) : 3;
    if (pick === 0 || pick === 1) {
      // Product (tier 0) or quotient (tier 1) of two powers.
      const [a, b] = properFraction();
      const [drawn, d] = properFraction();
      // A quotient of equal powers would be x^0; nudge the second exponent up by 1.
      const c = pick === 1 && a * d === b * drawn ? drawn + d : drawn;
      const product = pick === 0;
      [kn, kd] = reduce(product ? a * d + c * b : a * d - c * b, b * d);
      const common = (b * d) / gcd(b, d);
      stemTex = product
        ? `x^{${ratTex(a, b)}} \\cdot x^{${ratTex(c, d)}}`
        : fracTex(`x^{${ratTex(a, b)}}`, `x^{${ratTex(c, d)}}`);
      steps.push({
        text: product
          ? `Multiplying powers of the same base adds the exponents: k = ${a}/${b} + ${c}/${d}.`
          : `Dividing powers of the same base subtracts the exponents: k = ${a}/${b} - ${c}/${d}.`,
        blankText: product ? "Write k as a sum of the exponents: ?" : "Write k as a difference of the exponents: ?",
      });
      steps.push({
        text: `Use the common denominator ${common}: ${(a * common) / b}/${common} ${product ? "+" : "-"} ${(c * common) / d}/${common}.`,
        blankText: "Rewrite both exponents over a common denominator: ?",
      });
      steps.push({
        text: `${product ? "Add" : "Subtract"} and simplify: k = ${ratAns(kn, kd)}.`,
        blankText: `${product ? "Add" : "Subtract"} the numerators and simplify: ?`,
      });
    } else if (pick === 2) {
      // A power of a power.
      const [a, b] = properFraction();
      const [drawn, d] = properFraction();
      // Reciprocal exponents would give k = 1; nudge the second one up by 1.
      const c = a * drawn === b * d ? drawn + d : drawn;
      [kn, kd] = reduce(a * c, b * d);
      stemTex = `\\left(x^{${ratTex(a, b)}}\\right)^{${ratTex(c, d)}}`;
      steps.push({
        text: `A power of a power multiplies the exponents: k = (${a}/${b})·(${c}/${d}).`,
        blankText: "Write k as a product of the exponents: ?",
      });
      steps.push({
        text: `Multiply the numerators and the denominators: ${a * c}/${b * d}.`,
        blankText: "Multiply the numerators and the denominators: ?",
      });
      steps.push({ text: `Simplify: k = ${ratAns(kn, kd)}.`, blankText: "Simplify the fraction: ?" });
    } else {
      // Radicals and powers mixed, raised to a whole power: (ⁿ√(x^p) · x^(a/b))^e.
      const n = r.pick([2, 3, 4]);
      let p = r.int(1, n + 1);
      while (gcd(p, n) !== 1) p += 1;
      const [a, b] = properFraction();
      const e = r.pick([2, 3, 6]);
      const [sn, sd] = reduce(p * b + a * n, n * b);
      [kn, kd] = reduce(sn * e, sd);
      const innerTex = rootTex(n, p === 1 ? "x" : `x^{${p}}`);
      stemTex = `\\left(${innerTex} \\cdot x^{${ratTex(a, b)}}\\right)^{${e}}`;
      steps.push({
        text: `Write the root as a power: the ${ROOT_WORD[n]} root of x^${p} is x^(${ratAns(p, n)}).`,
        blankText: "Rewrite the root as a power of x: ?",
      });
      steps.push({
        text: `Add the exponents inside: ${ratAns(p, n)} + ${ratAns(a, b)} = ${ratAns(sn, sd)}.`,
        blankText: "Add the exponents inside the parentheses: ?",
      });
      steps.push({
        text: `Multiply by the outer power ${e}: k = ${ratAns(sn, sd)}·${e} = ${ratAns(kn, kd)}.`,
        blankText: `Multiply the exponent by ${e}: ?`,
      });
    }
    return {
      stem: `Write ${tex(stemTex)} as a single power ${tex("x^{k}")}. Assume x is positive. What is ${tex("k")}?`,
      answer: fracAns(kn, kd),
      ...withWorkedSteps(steps),
    };
  });

  // ── rad_add_multiply ──────────────────────────────────────────────────────
  const addMultiply = T(
    "rad_add_multiply",
    "expression",
    (r) => {
      const tier = r.int(0, 2);
      if (tier === 0) {
        // Like radicals: combine the coefficients. `expanded` requires the
        // like terms combined, so the question typed back is a nudge.
        const m = r.pick([2, 3, 5, 6, 7, 10]);
        const count = r.int(2, 3);
        const coefficients = Array.from({ length: count }, (_, i) => (i === 0 ? r.int(1, 9) : signedInt(r, 1, 9)));
        let total = coefficients.reduce((s, c) => s + c, 0);
        if (total === 0) {
          coefficients[0] += 1;
          total = 1;
        }
        const stemTex = coefficients
          .map((c, i) => (i === 0 ? surdTex(c, m) : `${c < 0 ? "-" : "+"} ${surdTex(Math.abs(c), m)}`))
          .join(" ");
        const answer = surdAns(total, m);
        return {
          stem: `Simplify ${tex(stemTex)}.`,
          answer: exprAns(answer),
          answerForm: "expanded" as const,
          ...withWorkedSteps([
            {
              text: `Every term has √${m}, so they are like terms.`,
              blankText: "Check that the radicals match: ?",
            },
            {
              text: `Like terms combine by adding the numbers in front; the √${m} stays as it is.`,
              blankText: "Decide what to add: ?",
            },
            {
              text: `Add the numbers in front: ${coefficients.join(" + ").replace(/\+ -/g, "- ")} = ${total}, so the sum is ${answer}.`,
              blankText: `Add the numbers in front of √${m}: ?`,
            },
          ]),
        };
      }
      if (tier === 1) {
        // Unlike radicals that become like after simplifying: a√(k₁²m) ± b√(k₂²m).
        const m = r.pick([2, 3, 5, 6, 7]);
        const k1 = r.int(1, 5);
        let k2 = r.int(2, 5);
        if (k2 === k1) k2 = k1 === 5 ? 2 : k1 + 1;
        const a = r.int(0, 2) === 0 ? r.int(2, 3) : 1;
        let b = signedInt(r, 1, 2);
        if (a * k1 + b * k2 === 0) b = -b;
        const total = a * k1 + b * k2;
        const n1 = k1 * k1 * m;
        const n2 = k2 * k2 * m;
        const answer = surdAns(total, m);
        return {
          stem: `Simplify ${tex(`${surdTex(a, n1)} ${b < 0 ? "-" : "+"} ${surdTex(Math.abs(b), n2)}`)}. Simplify the radical.`,
          answer: exprAns(answer),
          answerForm: "simplifiedRadical" as const,
          ...withWorkedSteps([
            {
              text: `Simplify each radical: √${n1} = ${surdAns(k1, m)} and √${n2} = ${surdAns(k2, m)}.`,
              blankText: "Pull the square factor out of each radical: ?",
            },
            {
              text: `Now they are like terms: ${surdAns(a * k1, m)} ${b < 0 ? "-" : "+"} ${surdAns(Math.abs(b) * k2, m)}.`,
              blankText: "Rewrite the sum with the simplified radicals: ?",
            },
            {
              text: `Combine the numbers in front: ${a * k1} ${b < 0 ? "-" : "+"} ${Math.abs(b) * k2} = ${total}, so the answer is ${answer}.`,
              blankText: "Combine the like terms: ?",
            },
          ]),
        };
      }
      if (r.int(0, 1) === 0) {
        // (p√u)(q√v) where uv has a square factor.
        const pool = [2, 3, 5, 6, 7, 10, 14, 15, 21];
        // Fallback: 2·6 = 12 = 4·3 still has a square factor to take out.
        let u = 2;
        let v = 6;
        for (let tries = 0; tries < RADICAL_DRAW.attempts; tries++) {
          const cu = r.pick(pool);
          const cv = r.pick(pool);
          if (splitSquare(cu * cv)[0] !== 1) {
            [u, v] = [cu, cv];
            break;
          }
        }
        const p = r.int(1, 4);
        const q = signedInt(r, 1, 4);
        const [k, w] = splitSquare(u * v);
        const coefficient = p * q * k;
        const answer = surdAns(coefficient, w);
        return {
          stem: `Multiply ${tex(`${surdTex(p, u)} \\cdot ${q < 0 ? `\\left(${surdTex(q, v)}\\right)` : surdTex(q, v)}`)}. Simplify the radical.`,
          answer: exprAns(answer),
          answerForm: "simplifiedRadical" as const,
          ...withWorkedSteps([
            {
              text: `Multiply the numbers in front and the numbers under the roots: ${p * q}√${u * v}.`,
              blankText: "Multiply outside by outside and inside by inside: ?",
            },
            {
              text: `Find the largest square factor of ${u * v}: ${u * v} = ${k * k}·${w}.`,
              blankText: `Find the largest square factor of ${u * v}: ?`,
            },
            {
              text: `Take its root out: ${p * q}·${k}${w === 1 ? "" : `√${w}`} = ${answer}.`,
              blankText: "Take the square root of the square factor out: ?",
            },
          ]),
        };
      }
      // (a + c√m)(b + d√m) = (ab + cdm) + (ad + bc)√m.
      const m = r.pick([2, 3, 5, 7]);
      // A third of the draws are a conjugate pair, whose product is a whole number.
      const conjugatePair = r.int(0, 2) === 0;
      const a = r.int(1, 6);
      const c = r.pick([1, 1, 2]);
      const b = conjugatePair ? a : signedInt(r, 1, 6);
      const d = conjugatePair ? -c : signedInt(r, 1, 2);
      const x = a * b + c * d * m;
      const y = a * d + b * c;
      const answer = binomialSurdAns(x, y, m);
      return {
        stem: `Multiply ${tex(`\\left(${binomialSurdTex(a, c, m)}\\right)\\left(${binomialSurdTex(b, d, m)}\\right)`)}.`,
        answer: exprAns(answer),
        answerForm: "expanded" as const,
        ...withWorkedSteps([
          {
            text: `Multiply every pair of terms: ${a}·${b} + ${a}·${surdAns(d, m)} + ${surdAns(c, m)}·${b} + ${surdAns(c, m)}·${surdAns(d, m)}.`,
            blankText: "Multiply every pair of terms: ?",
          },
          {
            text: `The last product is ${c}·${d}·(√${m})^2 = ${c * d * m}, because √${m}·√${m} = ${m}.`,
            blankText: `Multiply the two radical terms, using √${m}·√${m} = ${m}: ?`,
          },
          {
            text: `Combine the whole numbers (${a * b} + ${c * d * m} = ${x}) and the √${m} terms (${a * d} + ${b * c} = ${y}): ${answer}.`,
            blankText: "Combine the like terms: ?",
          },
        ]),
      };
    },
    { answerPalette: "algebra" },
  );

  // ── rad_rationalize ───────────────────────────────────────────────────────
  const rationalize = T(
    "rad_rationalize",
    "expression",
    (r) => {
      const tier = r.int(0, 2);
      if (tier < 2) {
        const cube = tier === 1 && r.int(0, 2) === 0;
        if (cube) {
          // a / ∛m → a∛(m²)/m.
          const m = r.pick([2, 3, 5]);
          const a = r.int(1, 9);
          const [num, den] = reduce(a, m);
          const root = `∛${m * m}`;
          const answer = `${num === 1 ? "" : num}${root}${den === 1 ? "" : `/${den}`}`;
          return {
            stem: `Rationalize the denominator of ${tex(fracTex(a, `\\sqrt[3]{${m}}`))}.`,
            answer: exprAns(answer),
            ...withWorkedSteps([
              {
                text: `To make a perfect cube under the root, multiply the top and the bottom by ∛${m * m}.`,
                blankText: "Choose what to multiply the top and bottom by: ?",
              },
              {
                text: `Bottom: ∛${m}·∛${m * m} = ∛${m * m * m} = ${m}. Top: ${a}∛${m * m}.`,
                blankText: "Multiply out the top and the bottom: ?",
              },
              { text: `Simplify the fraction: ${answer}.`, blankText: "Simplify the fraction: ?" },
            ]),
          };
        }
        // a / (b√m) → a√m / (b·m), reduced.
        const m = r.pick([2, 3, 5, 6, 7, 10]);
        const a = r.int(1, 12);
        const b = tier === 0 ? 1 : r.int(2, 4);
        const [num, den] = reduce(a, b * m);
        const answer = `${num === 1 ? "" : num}√${m}${den === 1 ? "" : `/${den}`}`;
        return {
          stem: `Rationalize the denominator of ${tex(fracTex(a, surdTex(b, m)))}.`,
          answer: exprAns(answer),
          ...withWorkedSteps([
            {
              text: `Multiply the top and the bottom by √${m}.`,
              blankText: "Choose what to multiply the top and bottom by: ?",
            },
            {
              text: `Bottom: ${b === 1 ? "" : b}√${m}·√${m} = ${b * m}. Top: ${a}√${m}.`,
              blankText: "Multiply out the top and the bottom: ?",
            },
            { text: `Simplify the fraction: ${answer}.`, blankText: "Simplify the fraction: ?" },
          ]),
        };
      }
      // a / (b ± √m) → a(b ∓ √m) / (b² − m).
      const m = r.pick([2, 3, 5, 6, 7, 10, 11]);
      const b = r.int(1, 4);
      const plus = r.int(0, 1) === 0;
      const denominator = b * b - m; // never 0: m is not a perfect square
      const a = r.int(0, 1) === 0 ? Math.abs(denominator) * r.int(1, 2) : r.int(1, 6);
      const [scale, rest] = reduce(a, denominator); // a/D = scale/rest, rest > 0
      const conjugateSign = plus ? -1 : 1;
      const x = scale * b;
      const y = scale * conjugateSign;
      const top = binomialSurdAns(x, y, m);
      const answer = rest === 1 ? top : `(${top})/${rest}`;
      const conjugate = `${b} ${plus ? "-" : "+"} √${m}`;
      return {
        stem: `Rationalize the denominator of ${tex(fracTex(a, `${b} ${plus ? "+" : "-"} \\sqrt{${m}}`))}.`,
        answer: exprAns(answer),
        ...withWorkedSteps([
          {
            text: `Multiply the top and the bottom by the conjugate, ${conjugate}.`,
            blankText: "Find the conjugate of the bottom: ?",
          },
          {
            text: `Bottom: (${b} ${plus ? "+" : "-"} √${m})(${conjugate}) = ${b * b} - ${m} = ${denominator}.`,
            blankText: "Multiply out the bottom as a difference of squares: ?",
          },
          {
            text: `Top: ${a}(${conjugate}).`,
            blankText: "Multiply out the top: ?",
          },
          {
            text: `Divide by ${denominator} and simplify: ${answer}.`,
            blankText: `Divide by ${denominator} and simplify: ?`,
          },
        ]),
      };
    },
    { answerPalette: "algebra", answerForm: "rationalizedDenominator" },
  );

  // ── rad_solve_equation ────────────────────────────────────────────────────
  const solveRadical = T(
    "rad_solve_equation",
    "solutionSet",
    (r) => {
      const tier = r.int(0, 2);
      const noSolution = "If no value works, answer No solution.";
      if (tier === 0) {
        // √(ax + b) + e = f.
        const a = r.int(1, 4);
        const e = r.int(0, 1) === 0 ? 0 : signedInt(r, 1, 6);
        const none = r.int(0, 2) === 0;
        const c = none ? -r.int(1, 5) : r.int(1, 6); // the value √(ax + b) must take
        const x = r.int(-5, 8);
        const b = c * c - a * x;
        const f = c + e;
        const inside = polyTex([a, b]);
        const lhs = e === 0 ? `\\sqrt{${inside}}` : `\\sqrt{${inside}} ${e > 0 ? "+" : "-"} ${Math.abs(e)}`;
        const steps: WorkedStep[] = [
          e !== 0
            ? {
                text: `Isolate the root: √(${polyAns([a, b])}) = ${f} ${e > 0 ? "-" : "+"} ${Math.abs(e)} = ${c}.`,
                blankText: "Get the square root by itself: ?",
              }
            : {
                text: `The square root is already by itself: √(${polyAns([a, b])}) = ${c}.`,
                blankText: "Get the square root by itself: ?",
              },
        ];
        steps.push({
          text: `Square both sides: ${polyAns([a, b])} = ${c * c}, so x = ${x}.`,
          blankText: "Square both sides and solve for x: ?",
        });
        steps.push({
          text: none
            ? `Check x = ${x}: √(${a * x + b}) = ${Math.abs(c)}, not ${c}. A square root is never negative, so x = ${x} is extraneous: No solution.`
            : `Check x = ${x}: √(${a * x + b}) = ${c}, which matches, so x = ${x}.`,
          blankText: `Check x = ${x} in the original equation: ?`,
        });
        return {
          stem: `Solve ${tex(`${lhs} = ${f}`)}. ${noSolution}`,
          answer: solutionSetAns(none ? [] : [x]),
          ...withWorkedSteps(steps),
        };
      }
      const kind = tier === 1 ? "quadratic" : r.pick<"quadratic" | "twoRoots" | "cubeRoot">(["quadratic", "twoRoots", "cubeRoot"]);
      if (kind === "quadratic") {
        // √(ax + b) = x + d squares to (x + d)² = ax + b, whose roots r satisfy
        // r + d = t with t₁ + t₂ = a. A root with t < 0 is extraneous.
        const a = tier === 1 ? 1 : r.pick([1, 2, 3]);
        const t1 = r.int(a, a + 6);
        const t2 = a - t1; // ≤ 0, and never equal to t1
        const d = r.int(-4, 4);
        const r1 = t1 - d;
        const r2 = t2 - d;
        const b = d * d - r1 * r2;
        const valid = [r1, r2].filter((root) => root + d >= 0).sort((p, q) => p - q);
        const candidates = [r1, r2].sort((p, q) => p - q);
        // Present it as √(ax + b) = x + d, or as √(ax + b) − d = x.
        const moved = r.int(0, 1) === 0 && d !== 0;
        const inside = polyTex([a, b]);
        const stemTex = moved
          ? `\\sqrt{${inside}} ${d > 0 ? "-" : "+"} ${Math.abs(d)} = x`
          : `\\sqrt{${inside}} = ${polyTex([1, d])}`;
        const rhs = polyAns([1, d]);
        const check = (root: number) => {
          const inner = a * root + b;
          const side = root + d;
          return side >= 0
            ? `x = ${root}: √(${inner}) = ${side} and ${rhs} = ${side}, so it works`
            : `x = ${root}: √(${inner}) = ${-side} but ${rhs} = ${side}, so it is extraneous`;
        };
        const steps: WorkedStep[] = [];
        if (moved) {
          steps.push({
            text: `Isolate the root: √(${polyAns([a, b])}) = ${rhs}.`,
            blankText: "Get the square root by itself: ?",
          });
        }
        steps.push({
          text: `Square both sides: ${polyAns([a, b])} = ${polyAns([1, 2 * d, d * d])}.`,
          blankText: "Square both sides: ?",
        });
        steps.push({
          text: `Move everything to one side: ${polyAns([1, 2 * d - a, d * d - b])} = 0, so x = ${candidates[0]} or x = ${candidates[1]}.`,
          blankText: "Solve the quadratic: ?",
        });
        steps.push({
          text: `Check each in the original equation. ${check(r1)}; ${check(r2)}. Solution: ${valid.length > 0 ? valid.join(", ") : "No solution"}.`,
          blankText: "Check each candidate in the original equation: ?",
        });
        return {
          stem: `Solve ${tex(stemTex)}. Give every solution that checks. ${noSolution}`,
          answer: solutionSetAns(valid),
          ...withWorkedSteps(steps),
        };
      }
      if (kind === "twoRoots") {
        // √(ax + b) = √(cx + e): the linear solution must keep both radicands ≥ 0.
        const a = r.int(1, 4);
        let c = r.int(1, 4);
        if (c === a) c = a === 4 ? 1 : a + 1;
        const x = r.int(-6, 8);
        const none = r.int(0, 1) === 0;
        const v = none ? -r.int(1, 9) : r.int(0, 9); // both radicands equal v at x
        const b = v - a * x;
        const e = v - c * x;
        return {
          stem: `Solve ${tex(`\\sqrt{${polyTex([a, b])}} = \\sqrt{${polyTex([c, e])}}`)}. ${noSolution}`,
          answer: solutionSetAns(none ? [] : [x]),
          ...withWorkedSteps([
            {
              text: `Square both sides: ${polyAns([a, b])} = ${polyAns([c, e])}.`,
              blankText: "Square both sides: ?",
            },
            {
              text: `Solve the linear equation: ${a - c}x = ${e - b}, so x = ${x}.`,
              blankText: "Solve for x: ?",
            },
            {
              text: none
                ? `Check x = ${x}: both radicands equal ${v}, which is negative, so the square roots do not exist. x = ${x} is extraneous: No solution.`
                : `Check x = ${x}: both radicands equal ${v}, so both sides are √${v}. Solution: ${x}.`,
              blankText: `Check x = ${x} in the original equation: ?`,
            },
          ]),
        };
      }
      // ∛(ax + b) = c: cubing never adds a solution, and c may be negative.
      const a = r.int(1, 3);
      const c = signedInt(r, 1, 4);
      const x = r.int(-6, 6);
      const b = c * c * c - a * x;
      return {
        stem: `Solve ${tex(`\\sqrt[3]{${polyTex([a, b])}} = ${c}`)}. ${noSolution}`,
        answer: solutionSetAns([x]),
        ...withWorkedSteps([
          {
            text: `Cube both sides: ${polyAns([a, b])} = ${c * c * c}.`,
            blankText: "Cube both sides: ?",
          },
          {
            text: `Solve for x: ${a === 1 ? "x" : `${a}x`} = ${c * c * c - b}, so x = ${x}.`,
            blankText: "Solve for x: ?",
          },
          {
            text: `Check: ∛(${a * x + b}) = ${c}. A cube root can be negative, so x = ${x} works.`,
            blankText: `Check x = ${x} in the original equation: ?`,
          },
        ]),
      };
    },
    { answerPalette: "algebra" },
  );

  return [convert, evaluate, simplify, addMultiply, rationalize, solveRadical];
}
