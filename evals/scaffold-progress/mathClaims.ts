/**
 * The arithmetic READER behind the tightened scaffold sweep — turns a worked
 * step's prose into the exact arithmetic CLAIMS it makes, so the sweep can ask
 * whether those claims are TRUE rather than only whether a number appeared.
 *
 * WHY THIS EXISTS. The original sweep's only content check was "a new number
 * shows up in each revealed step". That passes a step whose arithmetic is
 * simply wrong (`60 × 2 = 130`) and a step whose numbers were conjured
 * (`Break 364 into chunks: 350 + 15`). To catch either, the audit needs the
 * numbers as VALUES, not as regex captures — and it needs them exact, because
 * a decimal family's steps are full of values (0.1, 5.57, 1/3) that binary
 * floating point cannot compare reliably. Everything here is exact rational
 * arithmetic over `bigint`, so `0.1 + 0.2 === 0.3` is true and no epsilon
 * fudge is needed anywhere in the audit.
 *
 * ── What a CLAIM is ─────────────────────────────────────────────────────────
 * A step is prose with arithmetic embedded in it. We scan out the maximal
 * MATH SPANS (runs of digits, operators, parentheses, commas and spaces),
 * split each span on commas, and classify every segment:
 *
 *   equation    `660 − 103 = 557`, `1/(7 × 5) = 1/35 = 1/35` — a chain of
 *               expressions joined by `=`. Every side must evaluate equal.
 *   expression  `350 + 14`, `6.60 − 1.03` — an unasserted expression. Its
 *               value is either built from known operands or recombines to a
 *               known value (a decomposition: "break 364 into 350 + 14").
 *   value       `(5)`, `16` — a lone number the prose asserts.
 *   list        `7, 9, 10, 12, 14` — three or more lone numbers in a row,
 *               which is how the stats families state a data set.
 *   unparsed    a span with digits the grammar could not read. Reported, never
 *               silently dropped — an unparsed span is a hole in this reader,
 *               not a verdict about the generator.
 *
 * ── The one grammar subtlety: `/` ───────────────────────────────────────────
 * `/` is a fraction bar when it is glued to its operands (`1/8`, `4/16`) and
 * the generators never use it as a spaced division sign — they use `÷`. That
 * distinction is load-bearing: read left-associatively, `2 ÷ 1/8` would be
 * `(2 ÷ 1) ÷ 8 = 0.25`, but the sentence means `2 ÷ (1/8) = 16`. So a glued
 * `a/b` parses as a single FRACTION factor that binds tighter than `× ÷`.
 *
 * Pure module: no I/O, no clock, no model. Same text in, same claims out.
 */

// ── Exact rationals ──────────────────────────────────────────────────────────

/** `bigint` LITERALS (`1n`) need an ES2020 target and this repo compiles to
 *  ES2017, so the handful of constants the rational core needs are built once
 *  here rather than written inline. */
const B_NEG1 = BigInt(-1);
const B0 = BigInt(0);
const B1 = BigInt(1);
const B10 = BigInt(10);

/** An exact rational. `d` is always > 0 and gcd(|n|, d) === 1. */
export type Rat = { n: bigint; d: bigint };

function bigAbs(x: bigint): bigint {
  return x < B0 ? -x : x;
}

function bigGcd(a: bigint, b: bigint): bigint {
  let x = bigAbs(a);
  let y = bigAbs(b);
  while (y) [x, y] = [y, x % y];
  return x;
}

export function rat(n: bigint, d: bigint = B1): Rat {
  if (d === B0) throw new Error("rational with zero denominator");
  const sign = d < B0 ? B_NEG1 : B1;
  const nn = n * sign;
  const dd = d * sign;
  const g = bigGcd(nn, dd) || B1;
  return { n: nn / g, d: dd / g };
}

export const ZERO = rat(B0);
export const ONE = rat(B1);

export function ratEq(a: Rat, b: Rat): boolean {
  return a.n === b.n && a.d === b.d;
}

export function ratAdd(a: Rat, b: Rat): Rat {
  return rat(a.n * b.d + b.n * a.d, a.d * b.d);
}

export function ratSub(a: Rat, b: Rat): Rat {
  return rat(a.n * b.d - b.n * a.d, a.d * b.d);
}

export function ratMul(a: Rat, b: Rat): Rat {
  return rat(a.n * b.n, a.d * b.d);
}

/** Exact division. `null` on divide-by-zero — the audit reports that rather
 *  than throwing, because a generator CAN emit `x ÷ 0` and we want the verdict,
 *  not a crashed sweep. */
export function ratDiv(a: Rat, b: Rat): Rat | null {
  if (b.n === B0) return null;
  return rat(a.n * b.d, a.d * b.n);
}

export function ratIsInt(a: Rat): boolean {
  return a.d === B1;
}

/** A stable key for set/map membership. */
export function ratKey(a: Rat): string {
  return `${a.n}/${a.d}`;
}

export function ratToString(a: Rat): string {
  return a.d === B1 ? String(a.n) : `${a.n}/${a.d}`;
}

/** Parse a decimal or integer LITERAL ("0.07", "1024") exactly. */
export function ratFromLiteral(text: string): Rat | null {
  const m = text.trim().match(/^(-?)(\d+)(?:\.(\d+))?$/);
  if (!m) return null;
  const sign = m[1] === "-" ? B_NEG1 : B1;
  const whole = BigInt(m[2]);
  const frac = m[3] ?? "";
  const scale = B10 ** BigInt(frac.length);
  const n = whole * scale + (frac ? BigInt(frac) : B0);
  return rat(sign * n, scale);
}

/** Is `v` a power-of-ten rescale of `base` (10^k for |k| ≤ `maxShift`)? The
 *  audit's notion that moving a decimal point is a change of NOTATION, not new
 *  information: 557 and 5.57 are the same digits. */
export function isPowerOfTenMultiple(base: Rat, v: Rat, maxShift = 8): boolean {
  if (base.n === B0) return v.n === B0;
  if (v.n === B0) return false;
  const q = ratDiv(v, base);
  if (!q) return false;
  return isPowerOfTen(q, maxShift);
}

/** Is `q` exactly 10^k for some |k| ≤ maxShift (k may be 0)? */
export function isPowerOfTen(q: Rat, maxShift = 8): boolean {
  if (q.n <= B0) return false;
  if (q.n === B1 && q.d === B1) return true;
  if (q.d === B1) {
    let x = q.n;
    let k = 0;
    while (x % B10 === B0 && k < maxShift) {
      x /= B10;
      k++;
    }
    return x === B1;
  }
  if (q.n === B1) {
    let x = q.d;
    let k = 0;
    while (x % B10 === B0 && k < maxShift) {
      x /= B10;
      k++;
    }
    return x === B1;
  }
  return false;
}

// ── Expression grammar ───────────────────────────────────────────────────────

/**
 * A parsed expression. `value` is its exact worth; `atoms` are every numeric
 * literal it mentions, in reading order (the operands a provenance check has
 * to explain); `operators` counts the top-level and nested arithmetic signs.
 */
export type Expr = {
  text: string;
  value: Rat;
  atoms: Rat[];
  /** How many arithmetic operators the expression applies (0 for a bare
   *  number; a fraction bar counts as one). */
  operatorCount: number;
  /** True when the expression is a single factor — a number or one fraction —
   *  i.e. the shape a RESULT takes on the right of an `=`. */
  resultLike: boolean;
};

type Token =
  | { kind: "num"; text: string; value: Rat }
  | { kind: "op"; text: string }
  | { kind: "lparen" }
  | { kind: "rparen" }
  | { kind: "slash" };

const ADD_OPS = new Set(["+", "−", "-"]);
const MUL_OPS = new Set(["×", "÷", "*"]);

function tokenize(src: string): Token[] | null {
  const out: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (/\d/.test(ch)) {
      const m = src.slice(i).match(/^\d+(?:\.\d+)?/);
      if (!m) return null;
      const value = ratFromLiteral(m[0]);
      if (!value) return null;
      out.push({ kind: "num", text: m[0], value });
      i += m[0].length;
      continue;
    }
    if (ch === "(") {
      out.push({ kind: "lparen" });
      i++;
      continue;
    }
    if (ch === ")") {
      out.push({ kind: "rparen" });
      i++;
      continue;
    }
    if (ch === "/") {
      // A fraction bar only when GLUED to both sides (`1/8`, `1/(7 × 5)`); the
      // generators never write a spaced `/` for division.
      const prev = src[i - 1];
      const next = src[i + 1];
      if (prev === undefined || next === undefined) return null;
      if (/\s/.test(prev) || /\s/.test(next)) return null;
      out.push({ kind: "slash" });
      i++;
      continue;
    }
    if (ADD_OPS.has(ch) || MUL_OPS.has(ch)) {
      out.push({ kind: "op", text: ch });
      i++;
      continue;
    }
    return null;
  }
  return out;
}

type ParseState = { toks: Token[]; pos: number; atoms: Rat[]; ops: number };

function parseFactor(st: ParseState): Rat | null {
  const base = parsePrimary(st);
  if (base === null) return null;
  // A fraction bar binds tighter than × ÷, so `2 ÷ 1/8` is `2 ÷ (1/8)`.
  let acc = base;
  while (st.toks[st.pos]?.kind === "slash") {
    st.pos++;
    const den = parsePrimary(st);
    if (den === null) return null;
    const q = ratDiv(acc, den);
    if (!q) return null;
    st.ops++;
    acc = q;
  }
  return acc;
}

function parsePrimary(st: ParseState): Rat | null {
  const t = st.toks[st.pos];
  if (!t) return null;
  if (t.kind === "num") {
    st.pos++;
    st.atoms.push(t.value);
    return t.value;
  }
  if (t.kind === "lparen") {
    st.pos++;
    const inner = parseAdditive(st);
    if (inner === null) return null;
    if (st.toks[st.pos]?.kind !== "rparen") return null;
    st.pos++;
    return inner;
  }
  return null;
}

function parseMultiplicative(st: ParseState): Rat | null {
  let acc = parseFactor(st);
  if (acc === null) return null;
  for (;;) {
    const t = st.toks[st.pos];
    if (!t || t.kind !== "op" || !MUL_OPS.has(t.text)) break;
    st.pos++;
    const rhs = parseFactor(st);
    if (rhs === null) return null;
    st.ops++;
    if (t.text === "÷") {
      const q = ratDiv(acc, rhs);
      if (!q) return null;
      acc = q;
    } else {
      acc = ratMul(acc, rhs);
    }
  }
  return acc;
}

function parseAdditive(st: ParseState): Rat | null {
  let acc = parseMultiplicative(st);
  if (acc === null) return null;
  for (;;) {
    const t = st.toks[st.pos];
    if (!t || t.kind !== "op" || !ADD_OPS.has(t.text)) break;
    st.pos++;
    const rhs = parseMultiplicative(st);
    if (rhs === null) return null;
    st.ops++;
    acc = t.text === "+" ? ratAdd(acc, rhs) : ratSub(acc, rhs);
  }
  return acc;
}

/** Parse one arithmetic expression. `null` when the text is not a complete,
 *  well-formed expression (the caller reports that as an unparsed span). */
export function parseExpression(text: string): Expr | null {
  const trimmed = text.trim().replace(/\.$/, "").trim();
  if (!trimmed || !/\d/.test(trimmed)) return null;
  const toks = tokenize(trimmed);
  if (!toks || toks.length === 0) return null;
  const st: ParseState = { toks, pos: 0, atoms: [], ops: 0 };
  const value = parseAdditive(st);
  if (value === null || st.pos !== toks.length) return null;
  return {
    text: trimmed,
    value,
    atoms: st.atoms,
    operatorCount: st.ops,
    resultLike: isResultLike(toks),
  };
}

/** A RESULT-shaped expression: `557`, `5/6`, `(4)` — one number or one
 *  fraction, with no arithmetic applied on top. */
function isResultLike(toks: Token[]): boolean {
  const core = stripOuterParens(toks);
  if (core.length === 1) return core[0].kind === "num";
  if (core.length === 3) {
    return core[0].kind === "num" && core[1].kind === "slash" && core[2].kind === "num";
  }
  return false;
}

function stripOuterParens(toks: Token[]): Token[] {
  let core = toks;
  while (core.length >= 2 && core[0].kind === "lparen" && core[core.length - 1].kind === "rparen") {
    // Only strip when the outer pair actually wraps the whole run.
    let depth = 0;
    let wraps = true;
    for (let i = 0; i < core.length; i++) {
      if (core[i].kind === "lparen") depth++;
      else if (core[i].kind === "rparen") {
        depth--;
        if (depth === 0 && i !== core.length - 1) {
          wraps = false;
          break;
        }
      }
    }
    if (!wraps) break;
    core = core.slice(1, -1);
  }
  return core;
}

// ── Claims ───────────────────────────────────────────────────────────────────

export type Claim =
  | { kind: "equation"; text: string; sides: Expr[]; value: Rat; consistent: boolean }
  | { kind: "expression"; text: string; expr: Expr }
  | { kind: "value"; text: string; value: Rat }
  | { kind: "list"; text: string; values: Rat[] }
  | { kind: "unparsed"; text: string };

/** Characters that can appear inside a math span. Deliberately excludes the
 *  ASCII hyphen: the generators write minus as `−` (U+2212) and em-dash as `—`,
 *  so a hyphen in a span would only ever come from prose ("single-digit"). */
const MATH_SPAN_RE = /[0-9()+−×÷*=/,.\s]+/g;

/** Every maximal run of math characters in `text` that contains a digit. */
export function mathSpans(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(MATH_SPAN_RE)) {
    const span = m[0].trim();
    if (!/\d/.test(span)) continue;
    out.push(span);
  }
  return out;
}

/** Read every arithmetic claim a step (or stem) makes, in reading order. */
export function claimsIn(text: string): Claim[] {
  const out: Claim[] = [];
  for (const span of mathSpans(text)) {
    const segments = span
      .split(",")
      .map((s) => s.trim().replace(/^\.+|\.+$/g, "").trim())
      .filter((s) => /\d/.test(s));
    const parsed: Claim[] = [];
    for (const seg of segments) parsed.push(classifySegment(seg));
    out.push(...collapseLists(parsed));
  }
  return out;
}

function classifySegment(seg: string): Claim {
  if (seg.includes("=")) {
    const parts = seg
      .split("=")
      .map((p) => p.trim())
      .filter((p) => p.length > 0);
    if (parts.length < 2) return { kind: "unparsed", text: seg };
    const sides: Expr[] = [];
    for (const p of parts) {
      const e = parseExpression(p);
      if (!e) return { kind: "unparsed", text: seg };
      sides.push(e);
    }
    const value = sides[0].value;
    const consistent = sides.every((s) => ratEq(s.value, value));
    return { kind: "equation", text: seg, sides, value, consistent };
  }
  const expr = parseExpression(seg);
  if (!expr) return { kind: "unparsed", text: seg };
  if (expr.operatorCount === 0) return { kind: "value", text: seg, value: expr.value };
  return { kind: "expression", text: seg, expr };
}

/** Three or more bare numbers in a row inside one span is a DATA SET, not
 *  three unrelated assertions — that is how the stats stems and their ordering
 *  step write a list. */
function collapseLists(claims: Claim[]): Claim[] {
  const out: Claim[] = [];
  let run: Extract<Claim, { kind: "value" }>[] = [];
  const flush = () => {
    if (run.length >= 3) {
      out.push({
        kind: "list",
        text: run.map((r) => r.text).join(", "),
        values: run.map((r) => r.value),
      });
    } else {
      out.push(...run);
    }
    run = [];
  };
  for (const c of claims) {
    if (c.kind === "value") {
      run.push(c);
      continue;
    }
    flush();
    out.push(c);
  }
  flush();
  return out;
}
