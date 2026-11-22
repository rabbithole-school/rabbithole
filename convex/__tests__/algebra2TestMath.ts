/**
 * Test-only math for the Algebra 2 template tests: a small complex-valued
 * evaluator for the answer grammar, a stem-LaTeX reader, polynomial
 * interpolation and a root finder. Deliberately independent of both the
 * generators and the grader, so the tests re-derive every answer instead of
 * re-running the code that produced it.
 */

export type C = { re: number; im: number };

const c = (re: number, im = 0): C => ({ re, im });
const add = (a: C, b: C): C => c(a.re + b.re, a.im + b.im);
const sub = (a: C, b: C): C => c(a.re - b.re, a.im - b.im);
const mul = (a: C, b: C): C => c(a.re * b.re - a.im * b.im, a.re * b.im + a.im * b.re);
const div = (a: C, b: C): C => {
  const d = b.re * b.re + b.im * b.im;
  return c((a.re * b.re + a.im * b.im) / d, (a.im * b.re - a.re * b.im) / d);
};
function pow(a: C, b: C): C {
  if (b.im === 0 && Number.isInteger(b.re)) {
    let out = c(1);
    for (let k = 0; k < Math.abs(b.re); k++) out = mul(out, a);
    return b.re < 0 ? div(c(1), out) : out;
  }
  const r = Math.hypot(a.re, a.im);
  const t = Math.atan2(a.im, a.re);
  const lr = Math.log(r);
  const mag = Math.exp(b.re * lr - b.im * t);
  const ang = b.im * lr + b.re * t;
  return c(mag * Math.cos(ang), mag * Math.sin(ang));
}
const sqrt = (a: C): C => pow(a, c(0.5));

type Token = { kind: "num"; value: number } | { kind: "id"; name: string } | { kind: "op"; op: string };

function tokenize(s: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (/\s/.test(ch)) {
      i++;
    } else if (/[\d.]/.test(ch)) {
      let j = i;
      while (j < s.length && /[\d.]/.test(s[j])) j++;
      out.push({ kind: "num", value: Number(s.slice(i, j)) });
      i = j;
    } else if (/[a-z]/.test(ch)) {
      out.push({ kind: "id", name: ch });
      i++;
    } else if ("+-*/^()√".includes(ch)) {
      out.push({ kind: "op", op: ch });
      i++;
    } else {
      throw new Error(`bad character ${ch} in ${s}`);
    }
  }
  return out;
}

/** Evaluate an answer-grammar string over the complex numbers. */
export function evaluate(s: string, env: Record<string, number | C> = {}): C {
  const tokens = tokenize(s.replace(/−/g, "-"));
  let pos = 0;
  const peek = () => tokens[pos];
  const isOp = (op: string) => {
    const t = peek();
    return t?.kind === "op" && t.op === op;
  };
  const startsPrimary = () => {
    const t = peek();
    return !!t && (t.kind !== "op" || t.op === "(" || t.op === "√");
  };
  const expr = (): C => {
    let v = term();
    while (isOp("+") || isOp("-")) {
      const op = (tokens[pos++] as { op: string }).op;
      const rhs = term();
      v = op === "+" ? add(v, rhs) : sub(v, rhs);
    }
    return v;
  };
  const term = (): C => {
    let v = unary();
    for (;;) {
      if (isOp("*")) {
        pos++;
        v = mul(v, unary());
      } else if (isOp("/")) {
        pos++;
        v = div(v, unary());
      } else if (startsPrimary()) {
        v = mul(v, power());
      } else return v;
    }
  };
  const unary = (): C => {
    if (isOp("-")) {
      pos++;
      return mul(c(-1), unary());
    }
    if (isOp("+")) {
      pos++;
      return unary();
    }
    return power();
  };
  const power = (): C => {
    const base = primary();
    if (isOp("^")) {
      pos++;
      return pow(base, unary());
    }
    return base;
  };
  const primary = (): C => {
    const t = tokens[pos++];
    if (!t) throw new Error(`unexpected end in ${s}`);
    if (t.kind === "num") return c(t.value);
    if (t.kind === "id") {
      if (t.name === "i") return c(0, 1);
      const v = env[t.name];
      if (v === undefined) throw new Error(`unbound ${t.name} in ${s}`);
      return typeof v === "number" ? c(v) : v;
    }
    if (t.op === "(") {
      const v = expr();
      if (!isOp(")")) throw new Error(`missing ) in ${s}`);
      pos++;
      return v;
    }
    if (t.op === "√") return sqrt(primary());
    throw new Error(`unexpected ${t.op} in ${s}`);
  };
  const v = expr();
  if (pos !== tokens.length) throw new Error(`trailing tokens in ${s}`);
  return v;
}

export function evalReal(s: string, env: Record<string, number> = {}): number {
  const v = evaluate(s, env);
  return Math.abs(v.im) < 1e-9 ? v.re : NaN;
}

/** The `\( … \)` spans of a stem, in order. */
export function texSpans(stem: string): string[] {
  return [...stem.matchAll(/\\\((.*?)\\\)/g)].map((m) => m[1]);
}

function matchBrace(s: string, open: number): number {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    if (s[i] === "{") depth++;
    else if (s[i] === "}" && --depth === 0) return i;
  }
  throw new Error(`unbalanced braces in ${s}`);
}

/** Stem LaTeX (our subset) → answer grammar. */
export function texToGrammar(t: string): string {
  let s = t;
  for (let at = s.indexOf("\\frac{"); at >= 0; at = s.indexOf("\\frac{")) {
    const aOpen = at + 5;
    const aClose = matchBrace(s, aOpen);
    const bClose = matchBrace(s, aClose + 1);
    const a = s.slice(aOpen + 1, aClose);
    const b = s.slice(aClose + 2, bClose);
    s = `${s.slice(0, at)}((${a})/(${b}))${s.slice(bClose + 1)}`;
  }
  for (let at = s.indexOf("^{"); at >= 0; at = s.indexOf("^{")) {
    const close = matchBrace(s, at + 1);
    s = `${s.slice(0, at)}^(${s.slice(at + 2, close)})${s.slice(close + 1)}`;
  }
  return s.replace(/\\cdot/g, "*").replace(/\\left|\\right/g, "").replace(/\s+/g, "");
}

/** Coefficients (highest first) of a real polynomial of degree ≤ n, by
 *  interpolating f at 0..n. Near-integers are rounded. */
export function interpolate(f: (x: number) => number, n: number): number[] {
  const xs = Array.from({ length: n + 1 }, (_, k) => k - Math.floor(n / 2));
  const m = xs.map((x) => [...Array.from({ length: n + 1 }, (_, j) => x ** (n - j)), f(x)]);
  for (let col = 0; col <= n; col++) {
    let pivot = col;
    for (let row = col + 1; row <= n; row++) if (Math.abs(m[row][col]) > Math.abs(m[pivot][col])) pivot = row;
    [m[col], m[pivot]] = [m[pivot], m[col]];
    for (let row = 0; row <= n; row++) {
      if (row === col) continue;
      const k = m[row][col] / m[col][col];
      for (let j = col; j <= n + 1; j++) m[row][j] -= k * m[col][j];
    }
  }
  const coefficients = m.map((row, i) => row[n + 1] / row[i]);
  const rounded = coefficients.map((v) => (Math.abs(v - Math.round(v)) < 1e-6 ? Math.round(v) : v));
  let lead = 0;
  while (lead < rounded.length - 1 && Math.abs(rounded[lead]) < 1e-9) lead++;
  return rounded.slice(lead);
}

/** All complex roots of a polynomial (Durand–Kerner), with multiplicity. */
export function roots(coefficients: readonly number[]): C[] {
  const n = coefficients.length - 1;
  if (n < 1) return [];
  const monic = coefficients.map((a) => a / coefficients[0]);
  const p = (z: C) => monic.reduce<C>((acc, a) => add(mul(acc, z), c(a)), c(0));
  let zs = Array.from({ length: n }, (_, k) => pow(c(0.4, 0.9), c(k)));
  for (let it = 0; it < 2000; it++) {
    zs = zs.map((z, i) => {
      let d = c(1);
      zs.forEach((w, j) => {
        if (j !== i) d = mul(d, sub(z, w));
      });
      return sub(z, div(p(z), d));
    });
  }
  return zs;
}

/** Distinct values (within tol) of a list of complex numbers. */
export function distinctValues(values: readonly C[], tol = 1e-4): C[] {
  const out: C[] = [];
  for (const v of values) if (!out.some((w) => Math.hypot(w.re - v.re, w.im - v.im) < tol)) out.push(v);
  return out;
}

export function sameValueSet(a: readonly C[], b: readonly C[], tol = 1e-4): boolean {
  const da = distinctValues(a, tol);
  const db = distinctValues(b, tol);
  return (
    da.length === db.length &&
    da.every((v) => db.some((w) => Math.hypot(w.re - v.re, w.im - v.im) < tol))
  );
}

/** Split a factored answer into its constant and its parenthesised / bare-x
 *  factors with powers: `-2(x-1)^2x` → {constant: -2, factors: [...]}. */
export function splitFactors(s: string): { constant: number; factors: { expr: string; power: number }[] } {
  let i = 0;
  let sign = 1;
  if (s[i] === "-") {
    sign = -1;
    i++;
  }
  let digits = "";
  while (i < s.length && /\d/.test(s[i])) digits += s[i++];
  const factors: { expr: string; power: number }[] = [];
  while (i < s.length) {
    let expr: string;
    if (s[i] === "(") {
      let depth = 0;
      let j = i;
      for (; j < s.length; j++) {
        if (s[j] === "(") depth++;
        else if (s[j] === ")" && --depth === 0) break;
      }
      expr = s.slice(i + 1, j);
      i = j + 1;
    } else if (s[i] === "x") {
      expr = "x";
      i++;
    } else if (s[i] === "*") {
      i++;
      continue;
    } else {
      throw new Error(`unexpected ${s[i]} in factored ${s}`);
    }
    let power = 1;
    if (s[i] === "^") {
      let j = i + 1;
      let p = "";
      while (j < s.length && /\d/.test(s[j])) p += s[j++];
      power = Number(p);
      i = j;
    }
    factors.push({ expr, power });
  }
  return { constant: sign * (digits ? Number(digits) : 1), factors };
}

/** Is this one-variable polynomial expression irreducible over the integers
 *  and primitive (no whole-number factor left inside)? Degree ≤ 2 only. */
export function irreducibleOverZ(expr: string): boolean {
  const p = interpolate((x) => evalReal(expr, { x }), 4);
  const g = p.reduce((acc, v) => gcd(acc, Math.round(v)), 0);
  if (Math.abs(g) !== 1) return false;
  if (p.length <= 2) return true;
  if (p.length === 3) {
    const disc = p[1] * p[1] - 4 * p[0] * p[2];
    return disc < 0 || !Number.isInteger(Math.sqrt(disc));
  }
  return false;
}

export function gcd(a: number, b: number): number {
  let x = Math.abs(a);
  let y = Math.abs(b);
  while (y) [x, y] = [y, x % y];
  return x;
}

/** Sample points that avoid small-integer poles. */
export const SAMPLES = [0.37, 1.61, -2.29, 3.73, -4.17, 5.53, 0.83];

export function sameFunction(a: string, b: string, variables: readonly string[] = ["x"]): boolean {
  let good = 0;
  for (let k = 0; k < SAMPLES.length; k++) {
    const env: Record<string, number> = {};
    variables.forEach((v, j) => (env[v] = SAMPLES[(k + j * 3) % SAMPLES.length] + j * 0.11));
    const va = evaluate(a, env);
    const vb = evaluate(b, env);
    if (![va.re, va.im, vb.re, vb.im].every(Number.isFinite)) continue;
    const scale = Math.max(1, Math.hypot(va.re, va.im));
    if (Math.hypot(va.re - vb.re, va.im - vb.im) > 1e-7 * scale) return false;
    good++;
  }
  return good >= 3;
}

/** The numerator and denominator LaTeX of a span that starts with \frac. */
export function fracParts(t: string): [string, string] {
  const at = t.indexOf("\\frac{");
  if (at < 0) throw new Error(`no \\frac in ${t}`);
  const aOpen = at + 5;
  const aClose = matchBrace(t, aOpen);
  const bClose = matchBrace(t, aClose + 1);
  return [t.slice(aOpen + 1, aClose), t.slice(aClose + 2, bClose)];
}

/** Answer-grammar polynomial from coefficients (highest first). */
export function polyString(coefficients: readonly number[], variable = "x"): string {
  const n = coefficients.length - 1;
  let out = "";
  coefficients.forEach((a, i) => {
    if (a === 0) return;
    const e = n - i;
    const mag = Math.abs(a);
    const body = (mag !== 1 || e === 0 ? String(mag) : "") + (e === 0 ? "" : e === 1 ? variable : `${variable}^${e}`);
    out += out === "" ? (a < 0 ? "-" : "") + body : (a < 0 ? "-" : "+") + body;
  });
  return out || "0";
}

/** Split an answer at its top-level fraction bar: `-(x+1)/(x-6)` → ["-(x+1)", "(x-6)"]. */
export function splitTopFraction(s: string): [string, string] | null {
  let depth = 0;
  let at = -1;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "(") depth++;
    else if (s[i] === ")") depth--;
    else if (s[i] === "/" && depth === 0) at = i;
  }
  return at < 0 ? null : [s.slice(0, at), s.slice(at + 1)];
}

/** Reverse the order of a sum's terms: `x^2+3x-4` → `-4+3x+x^2`. */
export function reverseTerms(s: string): string {
  const terms = s.match(/[+-]?[^+-]+/g) ?? [s];
  return terms
    .reverse()
    .map((t, i) => (i === 0 ? t.replace(/^\+/, "") : /^[+-]/.test(t) ? t : `+${t}`))
    .join("");
}

export const BANNED_STEM_PIECES =[/undefined/, /NaN/, /--/, /\+ -/, /(^|[^\d])1x/, /x\^1(?!\d)/];

/**
 * Can an item's canonical typed answer be entered on the pad it is served
 * with? Mirrors native/src/lib/algebraPad.ts: every algebra pad has digits,
 * `.`, x, y, + − ×, the fraction key (`/`), the exponent key (`^`),
 * parentheses, √ and the indexed root (`√[n]`, `∛`); `complex` adds i, `logs`
 * adds log (with a base), ln and e, `sequence` adds n; a solution set adds ±
 * and one box per answer. Integer, fraction and decimal draws use the number
 * pad: a plain number only. Returns the offending answer text, or null.
 */
export function untypableAnswer(item: {
  answer: { type: string } & Record<string, unknown>;
  answerPalette?: string;
}): string | null {
  const a = item.answer;
  if (a.type === "integer" || a.type === "decimal") return Number.isFinite(a.value as number) ? null : String(a.value);
  if (a.type === "fraction") return Number.isInteger(a.num) && Number.isInteger(a.den) ? null : `${a.num}/${a.den}`;
  if (a.type !== "expression" && a.type !== "solutionSet") return null;
  let allowed = "0123456789.xy+-*/^()√∛[] ";
  if (item.answerPalette === "complex") allowed += "i";
  if (item.answerPalette === "sequence") allowed += "n";
  if (a.type === "solutionSet") allowed += "±";
  const strings = a.type === "solutionSet" ? (a.members as string[]) : [a.canonical as string];
  for (const raw of strings) {
    // `sqrt(…)` is what the √ key's box writes in the answer grammar.
    let s = raw.replace(/sqrt/g, "√");
    if (item.answerPalette === "logs") s = s.replace(/log_|log|ln/g, "").replace(/e/g, "");
    if ([...s].some((ch) => !allowed.includes(ch))) return raw;
  }
  return null;
}
