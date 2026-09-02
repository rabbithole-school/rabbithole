/**
 * Typed answers for the homegrown practice engine — the math answer types (the
 * pluggable seam other domains extend with their own verifier/answer kinds).
 *
 * The #1 lesson from the generation+verification spike (review/practice/
 * spikes.html §A): a model generates *correct arithmetic* reliably, and the
 * only residual failure mode is answer REPRESENTATION — "24 m^2" vs "24",
 * "x = 8" vs "8", "6.50" vs "6.5". So we never compare answers as free strings.
 * An answer is a typed value, and equivalence is computed on the value.
 *
 * Pure module — no Convex/React deps. Used by the template engine (which
 * constructs answers directly, so they're correct by construction) and by the
 * LLM-generation verifier (which parses a model's string answer into this
 * shape, then checks agreement).
 */

export type AnswerType =
  | "integer"
  | "decimal"
  | "fraction"
  | "expression"
  | "multipleChoice";

export type TypedAnswer =
  | { type: "integer"; value: number }
  | { type: "decimal"; value: number }
  | { type: "fraction"; num: number; den: number }
  | { type: "expression"; canonical: string }
  | { type: "multipleChoice"; choiceIndex: number };

// ── Measurement units ──────────────────────────────────────────────────────
// A unit is part of the ANSWER, not decoration on it: "the volume is 112" is an
// incomplete answer to "…in cubic centimeters", and stripping the unit away
// before grading (which is what this module used to do unconditionally) makes a
// bare number and a fully-labeled answer indistinguishable. The registry below
// is the ONE place a written unit becomes a canonical key, so the grader, the
// reveal, and the clients' input affordance all agree on what "cm³" means.
//
// Deliberately SMALL: only the length/area/volume units the geometry-measurement
// templates actually ask for. A unit with no template asking for it has no
// business here — an unrecognized trailing token still parses (it lands in
// `unitRaw` with a null `unit`), so nothing regresses, it just can't satisfy a
// `requiredUnit`.

/** The canonical unit keys a template may require. ASCII form so the key is
 *  typable/diffable; `formatUnit` renders the display form (cm², cm³, °, …).
 *  `deg` is the angle unit — the ONE dimensionless member (no ²/³ family), so
 *  it gets special handling in the keypad helpers (a single ° key, joined with
 *  no space). */
export type UnitKey = "cm" | "m" | "cm^2" | "m^2" | "cm^3" | "m^3" | "deg";

/** The canonical display glyph for the degree unit. */
export const DEGREE_SIGN = "°";

/** Display form of a canonical unit — what a scholar reads ("cm³"), and what a
 *  reveal appends to the numeric answer. */
export function formatUnit(key: UnitKey): string {
  switch (key) {
    case "cm":
      return "cm";
    case "m":
      return "m";
    case "cm^2":
      return "cm²";
    case "m^2":
      return "m²";
    case "cm^3":
      return "cm³";
    case "m^3":
      return "m³";
    case "deg":
      return DEGREE_SIGN;
  }
}

/**
 * Every written form of each unit, lowercase. Multi-word phrases ("cubic
 * centimeters") are first-class: the old single-token strip regex could never
 * see them, so "112 cubic centimeters" parsed as null — recognizing them is a
 * strict WIDENING of what a kid may type.
 */
const UNIT_ALIASES: Record<UnitKey, readonly string[]> = {
  cm: ["cm", "centimeter", "centimeters", "centimetre", "centimetres"],
  m: ["m", "meter", "meters", "metre", "metres"],
  "cm^2": [
    "cm²",
    "cm^2",
    "cm2",
    "sq cm",
    "sqcm",
    "square cm",
    "square centimeter",
    "square centimeters",
    "square centimetre",
    "square centimetres",
  ],
  "m^2": [
    "m²",
    "m^2",
    "m2",
    "sq m",
    "sqm",
    "square m",
    "square meter",
    "square meters",
    "square metre",
    "square metres",
  ],
  "cm^3": [
    "cm³",
    "cm^3",
    "cm3",
    "cc",
    "cubic cm",
    "cubic centimeter",
    "cubic centimeters",
    "cubic centimetre",
    "cubic centimetres",
  ],
  "m^3": [
    "m³",
    "m^3",
    "m3",
    "cubic m",
    "cubic meter",
    "cubic meters",
    "cubic metre",
    "cubic metres",
  ],
  // The angle unit. "°" is the display/tapped form; the written words let a
  // spoken or typed "65 degrees" satisfy the same required unit. Dimensionless,
  // so unlike cm/m it has no ²/³ family (see `unitKeyFamily`'s degree branch).
  deg: ["°", "deg", "degree", "degrees"],
};

const UNIT_BY_ALIAS = new Map<string, UnitKey>(
  (Object.entries(UNIT_ALIASES) as [UnitKey, readonly string[]][]).flatMap(
    ([key, aliases]) => aliases.map((alias) => [alias, key] as const),
  ),
);

/** Longest alias first, so "cm" wins over "m" and "square centimeters" wins
 *  over "centimeters" — a shorter suffix must never shadow a longer one. */
const UNIT_ALIASES_LONGEST_FIRST = [...UNIT_BY_ALIAS.keys()].sort(
  (a, b) => b.length - a.length,
);

/** Every canonical unit key, derived from the alias registry so it cannot drift
 *  from `UnitKey` (the record is keyed by it). This is the whole vocabulary a
 *  required unit may come from — an authoring surface or a generation tool that
 *  offers a unit choice enumerates THIS, never its own hand-typed list. */
export const UNIT_KEYS = Object.keys(UNIT_ALIASES) as UnitKey[];

/**
 * The canonical key for a unit written on its own ("cm³", "cubic centimeters",
 * "°") — the inverse of `formatUnit`, over every alias the grader accepts.
 * Null when the text isn't a unit this registry knows, which is how a caller
 * tells "no required unit" from "a token we can't enforce": both leave the item
 * graded unit-free rather than demanding something the grader can't check.
 *
 * Distinct from `splitUnitSuffix`, which takes a whole ANSWER and peels a unit
 * off its tail; this takes the unit alone.
 */
export function parseUnitKey(text: string): UnitKey | null {
  return UNIT_BY_ALIAS.get(text.trim().toLowerCase()) ?? null;
}

/** Characters that make a unit alias part of a longer token. A digit may sit
 *  immediately before a unit ("8m", "65°"), but not after it ("m2" is a
 *  distinct area alias, and "m4" is not the linear-meter unit). */
const UNIT_ALIAS_BEFORE_BOUNDARY = /[a-z_µ°²³^]/i;
const UNIT_ALIAS_AFTER_BOUNDARY = /[a-z0-9_µ°²³^]/i;
const ASCII_DIGIT = /[0-9]/;
const SIGN = /[+-]/;

function hasUnitAliasBeforeBoundary(text: string, aliasStart: number): boolean {
  let before = aliasStart - 1;
  while (before >= 0 && ASCII_DIGIT.test(text[before])) before -= 1;
  if (before >= 1 && SIGN.test(text[before]) && text[before - 1].toLowerCase() === "e") {
    return true;
  }
  return before >= 0 && UNIT_ALIAS_BEFORE_BOUNDARY.test(text[before]);
}

/**
 * Whether `text` (a problem stem) names this unit in words or symbols —
 * "…volume in cubic centimeters", "…how many cm³?", "…measure in degrees".
 *
 * This is the mechanical check behind the documented `ServablePrompt.answerUnit`
 * invariant: a required unit is NOT an answer leak precisely BECAUSE the stem
 * already asks for it. An item that demands a unit its own stem never mentions
 * marks a child wrong for an answer the question never asked for, so the write
 * sites gate on this before storing a unit.
 *
 * Deliberately a presence test, not a semantic audit: it proves the stem names
 * the unit, not that the unit is the right one for the mathematics (the value
 * check and the human/verifier gate own that).
 */
export function textNamesUnit(text: string, key: UnitKey): boolean {
  const lower = text.toLowerCase();
  return UNIT_ALIASES[key].some((alias) => {
    for (let from = 0; ; from += 1) {
      const at = lower.indexOf(alias, from);
      if (at < 0) return false;
      const after = at + alias.length < lower.length ? lower[at + alias.length] : "";
      if (
        !hasUnitAliasBeforeBoundary(lower, at) &&
        !UNIT_ALIAS_AFTER_BOUNDARY.test(after)
      ) {
        return true;
      }
      from = at;
    }
  });
}

/**
 * The pre-existing GENERIC trailing-unit pattern: any run of letters with an
 * optional exponent ("8 quarts", "24 m^2"). Retained as the fallback so an
 * UNKNOWN unit still parses exactly as it always did — it just can't satisfy a
 * `requiredUnit`. NOT applied to expressions, where a trailing letter is
 * meaningful (the remainder form "7r2").
 */
const GENERIC_UNIT_SUFFIX = /\s*[a-zµ°]+\s*(?:\^?\s*[0-9]|²|³)?\s*$/i;

/** A raw answer split into its numeric part and its trailing unit phrase.
 *  `unitRaw` is the text the learner actually wrote (null = no unit at all);
 *  `unit` is the canonical key, null when the token isn't one we recognize. */
export type UnitSuffixSplit = {
  value: string;
  unitRaw: string | null;
  unit: UnitKey | null;
};

/**
 * Split a trailing unit phrase off a raw answer.
 *
 * Order matters: a KNOWN alias is matched first (longest-first, so multi-word
 * phrases survive), then the generic single-token fallback. A known alias is
 * only accepted when the character before it isn't a letter — otherwise "8 gram"
 * would split as "8 gra" + "m" and stop parsing at all, when the generic
 * fallback correctly reads it as 8 with an unrecognized unit.
 *
 * Never applied to `expression` answers (see `parseAnswerWithUnit`), so the
 * remainder form "7 R 2" is untouched. A mixed number ("2 1/2") contains no
 * letters, so neither branch fires.
 */
export function splitUnitSuffix(raw: string): UnitSuffixSplit {
  const s = raw.trim();
  const lower = s.toLowerCase();
  for (const alias of UNIT_ALIASES_LONGEST_FIRST) {
    if (!lower.endsWith(alias)) continue;
    const start = s.length - alias.length;
    // Reject a match that is the tail of a longer word ("gram" ends in "m").
    if (start > 0 && /[a-zµ°]/i.test(s[start - 1])) continue;
    return {
      value: s.slice(0, start).trim(),
      unitRaw: s.slice(start).trim(),
      unit: UNIT_BY_ALIAS.get(alias) ?? null,
    };
  }
  const generic = s.match(GENERIC_UNIT_SUFFIX);
  if (generic) {
    return {
      value: s.slice(0, s.length - generic[0].length).trim(),
      unitRaw: generic[0].trim(),
      unit: null,
    };
  }
  return { value: s, unitRaw: null, unit: null };
}

/**
 * Whether a raw answer carries ANY trailing unit token — recognized or not.
 * The clients' pre-submit gate ("include the unit") reads this, so a kid who
 * wrote a wrong-but-present unit gets the grader's "wrong unit" feedback rather
 * than being blocked by the client. Only meaningful for numeric answer types:
 * an expression's remainder form ("7 R 2") reads as a unit token here, which is
 * exactly why expressions never unit-split.
 */
export function hasUnitToken(raw: string): boolean {
  return splitUnitSuffix(raw).unitRaw !== null;
}

/** Greatest common divisor (non-negative). */
export function gcd(a: number, b: number): number {
  a = Math.abs(a);
  b = Math.abs(b);
  while (b) {
    [a, b] = [b, a % b];
  }
  return a;
}

/** Reduce a fraction to lowest terms with a positive denominator. */
export function reduceFraction(num: number, den: number): { num: number; den: number } {
  if (den === 0) return { num, den: 0 };
  const sign = den < 0 ? -1 : 1;
  num *= sign;
  den *= sign;
  const g = gcd(num, den) || 1;
  return { num: num / g, den: den / g };
}

const EPS = 1e-9;

function fractionValue(a: Extract<TypedAnswer, { type: "fraction" }>): number {
  return a.den === 0 ? NaN : a.num / a.den;
}

/** Numeric value of a numeric-ish answer (integer/decimal/fraction), else NaN. */
export function numericValue(a: TypedAnswer): number {
  switch (a.type) {
    case "integer":
    case "decimal":
      return a.value;
    case "fraction":
      return fractionValue(a);
    default:
      return NaN;
  }
}

/** Collapse internal whitespace and lowercase, for expression comparison. */
function canonicalizeExpression(s: string): string {
  return s
    .trim()
    .toLowerCase()
    // A whole number followed by a bare fraction is a mixed number ("2 1/2").
    // Make the implied addition explicit — and parenthesize it — BEFORE
    // whitespace is collapsed, so it evaluates as (2 + 1/2) = 2.5 rather than
    // the meaningless "21/2", and so a leading sign folds over the whole value
    // (e.g. "-2 1/2" → "-(2+1/2)" = -2.5, "5-2 1/2" → "5-(2+1/2)").
    .replace(/(\d+)\s+(\d+\s*\/\s*\d+)/g, "($1+$2)")
    .replace(/\s+/g, "")
    .replace(/\*\*/g, "^"); // normalize exponent notation
}

type ExprNode =
  | { kind: "number"; value: number }
  | { kind: "variable"; name: string }
  | { kind: "root"; index: number; radicand: ExprNode }
  | { kind: "unary"; op: "-"; value: ExprNode }
  | { kind: "binary"; op: "+" | "-" | "*" | "/" | "^"; left: ExprNode; right: ExprNode };

type ParsedExpression = { ast: ExprNode; vars: string[] };

function parseRemainderExpression(s: string): { q: number; r: number } | null {
  const m = s.match(/^(-?\d+)r(-?\d+)$/i);
  if (!m) return null;
  return { q: Number(m[1]), r: Number(m[2]) };
}

function tokenizeExpression(s: string): string[] | null {
  const raw = canonicalizeExpression(s);
  if (!raw) return null;
  const tokens: string[] = [];
  for (let i = 0; i < raw.length; ) {
    const ch = raw[i];
    if (ch >= "0" && ch <= "9") {
      let j = i + 1;
      while (j < raw.length && raw[j] >= "0" && raw[j] <= "9") j += 1;
      if (j < raw.length && raw[j] === ".") {
        j += 1;
        if (!(j < raw.length && raw[j] >= "0" && raw[j] <= "9")) return null;
        while (j < raw.length && raw[j] >= "0" && raw[j] <= "9") j += 1;
      }
      tokens.push(raw.slice(i, j));
      i = j;
      continue;
    }
    if (ch === ".") return null;
    if (ch === "√") {
      if (raw[i + 1] === "[") {
        let j = i + 2;
        while (j < raw.length && raw[j] >= "0" && raw[j] <= "9") j += 1;
        if (j === i + 2 || raw[j] !== "]") return null;
        tokens.push(raw.slice(i, j + 1));
        i = j + 1;
        continue;
      }
      tokens.push(ch);
      i += 1;
      continue;
    }
    if (ch === "∛") {
      tokens.push(ch);
      i += 1;
      continue;
    }
    if ((ch >= "a" && ch <= "z") || ch === "π") {
      let j = i + 1;
      while (j < raw.length && raw[j] >= "a" && raw[j] <= "z") j += 1;
      tokens.push(raw.slice(i, j));
      i = j;
      continue;
    }
    if ("+-*/^()".includes(ch)) {
      tokens.push(ch);
      i += 1;
      continue;
    }
    return null;
  }
  const out: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    const prev = out[out.length - 1];
    if (prev && needsImplicitMultiply(prev, token)) out.push("*");
    out.push(token);
  }
  return out;
}

function needsImplicitMultiply(prev: string, next: string): boolean {
  const prevEndsValue = isNumberToken(prev) || isIdentifierToken(prev) || prev === ")";
  const nextStartsValue =
    isNumberToken(next) ||
    isIdentifierToken(next) ||
    next === "(" ||
    isRootToken(next);
  return prevEndsValue && nextStartsValue;
}

function isNumberToken(t: string): boolean {
  return /^\d+(?:\.\d+)?$/.test(t);
}

function rootIndexFromToken(token: string): number | null {
  if (token === "√") return 2;
  if (token === "∛") return 3;
  const match = token.match(/^√\[(\d+)\]$/);
  if (!match) return null;
  if (!/^(?:[2-9]\d*|1\d+)$/.test(match[1])) return null;
  const index = Number(match[1]);
  return Number.isSafeInteger(index) && index >= 2 ? index : null;
}

function isRootToken(token: string): boolean {
  return rootIndexFromToken(token) !== null;
}

function isIdentifierToken(t: string): boolean {
  return /^[a-zπ]+$/.test(t);
}

function parseExpression(raw: string): ParsedExpression | null {
  const tokens = tokenizeExpression(raw);
  if (!tokens || tokens.length === 0) return null;
  let index = 0;
  const vars = new Set<string>();

  const peek = () => tokens[index];
  const take = () => tokens[index++];

  const parsePrimary = (): ExprNode | null => {
    const token = peek();
    if (!token) return null;
    if (token === "(") {
      take();
      const inner = parseAddSub();
      if (!inner || take() !== ")") return null;
      return inner;
    }
    if (isNumberToken(token)) {
      take();
      return { kind: "number", value: Number(token) };
    }
    const rootIndex = rootIndexFromToken(token);
    if (rootIndex !== null) {
      take();
      const radicand = parseUnary();
      return radicand ? { kind: "root", index: rootIndex, radicand } : null;
    }
    if (isIdentifierToken(token)) {
      take();
      vars.add(token);
      return { kind: "variable", name: token };
    }
    return null;
  };

  const parseUnary = (): ExprNode | null => {
    if (peek() === "+") {
      take();
      return parseUnary();
    }
    if (peek() === "-") {
      take();
      const value = parseUnary();
      return value ? { kind: "unary", op: "-", value } : null;
    }
    return parsePrimary();
  };

  const parsePower = (): ExprNode | null => {
    const left = parseUnary();
    if (!left) return null;
    if (peek() !== "^") return left;
    take();
    const right = parsePower();
    return right ? { kind: "binary", op: "^", left, right } : null;
  };

  const parseMulDiv = (): ExprNode | null => {
    let left = parsePower();
    if (!left) return null;
    while (peek() === "*" || peek() === "/") {
      const op = take() as "*" | "/";
      const right = parsePower();
      if (!right) return null;
      left = { kind: "binary", op, left, right };
    }
    return left;
  };

  const parseAddSub = (): ExprNode | null => {
    let left = parseMulDiv();
    if (!left) return null;
    while (peek() === "+" || peek() === "-") {
      const op = take() as "+" | "-";
      const right = parseMulDiv();
      if (!right) return null;
      left = { kind: "binary", op, left, right };
    }
    return left;
  };

  const ast = parseAddSub();
  if (!ast || index !== tokens.length) return null;
  return { ast, vars: [...vars].sort() };
}

function evalExpression(node: ExprNode, env: Record<string, number>): number | null {
  switch (node.kind) {
    case "number":
      return node.value;
    case "variable":
      if (node.name === "π") return Math.PI;
      return Object.prototype.hasOwnProperty.call(env, node.name) ? env[node.name] : null;
    case "root": {
      const radicand = evalExpression(node.radicand, env);
      if (radicand === null || (node.index % 2 === 0 && radicand < 0)) return null;
      const magnitude = Math.pow(Math.abs(radicand), 1 / node.index);
      const value = radicand < 0 ? -magnitude : magnitude;
      return Number.isFinite(value) ? value : null;
    }
    case "unary": {
      const inner = evalExpression(node.value, env);
      return inner === null ? null : -inner;
    }
    case "binary": {
      const left = evalExpression(node.left, env);
      const right = evalExpression(node.right, env);
      if (left === null || right === null) return null;
      if (node.op === "+") return left + right;
      if (node.op === "-") return left - right;
      if (node.op === "*") return left * right;
      if (node.op === "/") return Math.abs(right) < EPS ? null : left / right;
      const value = Math.pow(left, right);
      return Number.isFinite(value) ? value : null;
    }
  }
}

export type AnswerComparisonOptions = {
  /** The simplifying-radicals skill assesses the requested canonical form. */
  requireSimplifiedRadical?: boolean;
};

/** Parse only canonical, simplified integer-index radical forms required by the
 * radical-simplification skill. */
function parseSimplifiedRadical(
  raw: string,
): { index: number; coefficient: number; radicand: number } | null {
  const s = canonicalizeExpression(raw);
  const match = s.match(/^(\d*)(√(?:\[(\d+)\])?|∛)(\d+)$/);
  if (!match) return null;
  const index = rootIndexFromToken(match[2]);
  if (index === null) return null;
  const coefficient = match[1] === "" ? 1 : Number(match[1]);
  const radicand = Number(match[4]);
  if (!Number.isSafeInteger(coefficient) || !Number.isSafeInteger(radicand) || radicand < 2) {
    return null;
  }
  for (let factor = 2; Math.pow(factor, index) <= radicand; factor++) {
    if (radicand % Math.pow(factor, index) === 0) return null;
  }
  return { index, coefficient, radicand };
}

function expressionsEquivalent(
  a: string,
  b: string,
  { requireSimplifiedRadical = false }: AnswerComparisonOptions = {},
): boolean {
  const remA = parseRemainderExpression(canonicalizeExpression(a));
  const remB = parseRemainderExpression(canonicalizeExpression(b));
  if (remA || remB) {
    return !!remA && !!remB && remA.q === remB.q && remA.r === remB.r;
  }

  if (requireSimplifiedRadical) {
    const radicalA = parseSimplifiedRadical(a);
    const radicalB = parseSimplifiedRadical(b);
    // This representation requirement belongs only to the explicit skill call
    // site. Other expression items retain normal mathematical equivalence.
    return (
      radicalA !== null &&
      radicalB !== null &&
      radicalA.index === radicalB.index &&
      radicalA.coefficient === radicalB.coefficient &&
      radicalA.radicand === radicalB.radicand
    );
  }

  const pa = parseExpression(a);
  const pb = parseExpression(b);
  if (!pa || !pb) {
    return canonicalizeExpression(a) === canonicalizeExpression(b);
  }

  const vars = [...new Set([...pa.vars, ...pb.vars])];
  if (vars.length === 0) {
    const av = evalExpression(pa.ast, {});
    const bv = evalExpression(pb.ast, {});
    return av !== null && bv !== null && Math.abs(av - bv) < EPS;
  }

  const sampleValues = [-3, -2, -1, 1, 2, 3, 5];
  let checked = 0;
  for (let i = 0; i < sampleValues.length + 5; i++) {
    const env: Record<string, number> = {};
    vars.forEach((name, idx) => {
      env[name] = sampleValues[(i + idx * 2) % sampleValues.length];
    });
    const av = evalExpression(pa.ast, env);
    const bv = evalExpression(pb.ast, env);
    if (av === null || bv === null) continue;
    checked += 1;
    if (Math.abs(av - bv) >= 1e-7) return false;
  }
  if (checked >= 3) return true;
  return canonicalizeExpression(a) === canonicalizeExpression(b);
}

/**
 * Value-equivalence across types. Numeric answers (integer/decimal/fraction)
 * compare by value with a tolerance, so 1/2 ≡ 0.5 ≡ 2/4. Expressions compare
 * on their mathematical value; multiple-choice on the selected index. A caller
 * may explicitly require simplified radical form for the relevant skill.
 */
export function answersEqual(
  a: TypedAnswer,
  b: TypedAnswer,
  options: AnswerComparisonOptions = {},
): boolean {
  if (a.type === "multipleChoice" || b.type === "multipleChoice") {
    return (
      a.type === "multipleChoice" &&
      b.type === "multipleChoice" &&
      a.choiceIndex === b.choiceIndex
    );
  }
  if (a.type === "expression" || b.type === "expression") {
    if (a.type === "expression" && b.type === "expression") {
      return expressionsEquivalent(a.canonical, b.canonical, options);
    }
    // Expression-vs-numeric comparisons keep the stricter original expression
    // numeric grammar (`parseExpressionNumeric`) so tolerance does not loosen
    // what counts as valid expression notation.
    let expressionValue: number | null = null;
    let numeric = NaN;
    if (a.type === "expression") {
      expressionValue = parseExpressionNumeric(a.canonical);
      numeric = numericValue(b);
    } else if (b.type === "expression") {
      expressionValue = parseExpressionNumeric(b.canonical);
      numeric = numericValue(a);
    }
    return (
      expressionValue !== null &&
      Number.isFinite(expressionValue) &&
      Number.isFinite(numeric) &&
      Math.abs(expressionValue - numeric) < EPS
    );
  }
  const av = numericValue(a);
  const bv = numericValue(b);
  return Number.isFinite(av) && Number.isFinite(bv) && Math.abs(av - bv) < EPS;
}

/**
 * Normalize symbols that are unambiguously equivalent in a numeric answer.
 * Bare commas/locale formats remain deliberately unsupported: "0,33" is
 * ambiguous. The existing "$1,250" currency form is retained only when the
 * comma placement is a conventional thousands grouping.
 */
function normalizeNumericInput(raw: string): string | null {
  const s = raw.trim().replace(/\u2212/g, "-");
  if (!s.includes("$")) {
    return s.includes(",") ? null : s;
  }
  const currency = s.match(
    /^\$\s*([+-]?(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d*)?)$/,
  );
  return currency ? currency[1].replace(/,/g, "") : null;
}

function parseFractionParts(s: string): { num: number; den: number } | null {
  // Mixed number "W N/D" (space-separated) → improper fraction (|W|·D + N),
  // re-signed by W's sign. This is the form the 2-D editor emits for a whole
  // number followed by a fraction (e.g. "2 1/2" → 5/2).
  const mixed = s.match(/^([+-]?\d+)\s+(\d+)\s*\/\s*(\d+)$/);
  if (mixed) {
    const whole = Number(mixed[1]);
    const n = Number(mixed[2]);
    const d = Number(mixed[3]);
    if (!Number.isFinite(whole) || !Number.isFinite(n) || !Number.isFinite(d) || d === 0) {
      return null;
    }
    const improper = Math.abs(whole) * d + n;
    return { num: mixed[1].startsWith("-") ? -improper : improper, den: d };
  }
  const frac = s.match(/^([+-]?\d+)\s*\/\s*([+-]?\d+)$/);
  if (frac) {
    const num = Number(frac[1]);
    const den = Number(frac[2]);
    return Number.isFinite(num) && Number.isFinite(den) && den !== 0
      ? { num, den }
      : null;
  }
  return null;
}

/**
 * Parse a numeric answer. A decimal point may lead or trail the digits, and an
 * ASCII/Unicode sign is normalized before this runs.
 */
function parseNumeric(raw: string): number | null {
  const s = normalizeNumericInput(raw);
  if (s === null) return null;
  const frac = parseFractionParts(s);
  if (frac) return frac.num / frac.den;
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/**
 * Expression-to-number comparison intentionally keeps its original grammar.
 * Numeric answer tolerances must not make leading dots, trailing dots, plus
 * signs, Unicode minus, or locale punctuation valid expression syntax.
 */
function parseExpressionNumeric(raw: string): number | null {
  const s = raw.trim();
  const frac = s.match(/^(-?\d+)\s*\/\s*(-?\d+)$/);
  if (frac) {
    const den = Number(frac[2]);
    return den === 0 ? null : Number(frac[1]) / den;
  }
  if (/^-?\d+(?:\.\d+)?$/.test(s)) return Number(s);
  return null;
}

/** A parsed answer together with the unit the learner wrote alongside it. */
export type ParsedAnswerWithUnit = {
  answer: TypedAnswer | null;
  unit: UnitKey | null;
  unitRaw: string | null;
};

/**
 * Parse a model/learner string answer into a TypedAnswer AND report the unit it
 * carried — the full-fidelity parse a unit-aware grader needs. Strips a leading
 * "x =", splits a trailing unit phrase (numeric types only), and accepts
 * conventional currency notation. `answer` is null if unparseable.
 *
 * The unit split is `splitUnitSuffix`, which supersedes the old single-token
 * strip regex: multi-word phrases ("112 cubic centimeters") now parse where they
 * previously returned null. That is a strict widening — every string the old
 * regex handled still parses to the same value.
 */
export function parseAnswerWithUnit(raw: string, type: AnswerType): ParsedAnswerWithUnit {
  let s = raw.trim();
  // strip a leading variable assignment ("x = 8" -> "8")
  s = s.replace(/^[a-zA-Z]\s*=\s*/, "");

  // `expression` — and any answerType outside the numeric set, matching the
  // previous `default` arm — is canonicalized as an expression and NEVER
  // unit-split: a trailing letter is meaningful there (the remainder form
  // "7r2"), and expression items retain their established grammar rather than
  // inheriting numeric tolerance.
  if (type !== "integer" && type !== "decimal" && type !== "fraction" && type !== "multipleChoice") {
    return {
      answer: { type: "expression", canonical: canonicalizeExpression(s) },
      unit: null,
      unitRaw: null,
    };
  }

  const split = splitUnitSuffix(s);
  const { value, unit, unitRaw } = split;
  const withUnit = (answer: TypedAnswer | null): ParsedAnswerWithUnit => ({
    answer,
    unit,
    unitRaw,
  });

  switch (type) {
    case "integer": {
      const n = parseNumeric(value);
      return withUnit(
        n !== null && Number.isInteger(n) ? { type: "integer", value: n } : null,
      );
    }
    case "decimal": {
      const n = parseNumeric(value);
      return withUnit(n !== null ? { type: "decimal", value: n } : null);
    }
    case "fraction": {
      const normalized = normalizeNumericInput(value);
      const fraction = normalized === null ? null : parseFractionParts(normalized);
      if (fraction) {
        const r = reduceFraction(fraction.num, fraction.den);
        return withUnit(r.den === 0 ? null : { type: "fraction", num: r.num, den: r.den });
      }
      // A bare INTEGER is accepted as n/1: a fraction item's value can be a
      // whole number (4/5 + 1/5 = 1), and #880 formats such an answer as "1",
      // so the canonical answer must round-trip — and a kid typing "1" has not
      // dodged the representation. A DECIMAL stays rejected: "0.75" may equal
      // 3/4 in value but does not demonstrate the representation the item
      // requested.
      if (/^[+-]?\d+$/.test(normalized ?? "")) {
        return withUnit({ type: "fraction", num: Number(normalized), den: 1 });
      }
      return withUnit(null);
    }
    case "multipleChoice": {
      const n = parseNumeric(value);
      return withUnit(
        n !== null && Number.isInteger(n) ? { type: "multipleChoice", choiceIndex: n } : null,
      );
    }
  }
}

/**
 * Parse a model/learner string answer into a TypedAnswer, given the expected
 * type. The unit-blind view of `parseAnswerWithUnit` — every existing caller
 * that only cares about the VALUE keeps this signature; a caller that must
 * enforce a unit (the grader) reads the full split instead.
 */
export function parseAnswer(raw: string, type: AnswerType): TypedAnswer | null {
  return parseAnswerWithUnit(raw, type).answer;
}

/**
 * Compare two raw answer strings through the canonical parser + typed
 * equivalence path. Client-side instructional checks use this instead of
 * rebuilding the normalization sequence independently.
 */
export function rawAnswersEqual(
  learnerRaw: string,
  expectedRaw: string,
  type: AnswerType,
): boolean {
  const learner = parseAnswer(learnerRaw, type);
  const expected = parseAnswer(expectedRaw, type);
  return learner !== null && expected !== null && answersEqual(learner, expected);
}

/** Human-readable canonical form of a typed answer (for storage / grading). */
export function formatAnswer(a: TypedAnswer): string {
  switch (a.type) {
    case "integer":
      return String(a.value);
    case "decimal":
      return String(a.value);
    case "fraction":
      return a.den === 1 ? String(a.num) : `${a.num}/${a.den}`;
    case "expression":
      return a.canonical;
    case "multipleChoice":
      return `choice ${a.choiceIndex}`;
  }
}

/**
 * Scholar-facing form of a typed answer. Multiple-choice answers must show the
 * option label, never the raw zero-based index ("choice 0").
 */
export function formatAnswerForDisplay(a: TypedAnswer, choices?: readonly string[] | null): string {
  if (a.type !== "multipleChoice") return formatAnswer(a);
  const label = choices?.[a.choiceIndex]?.trim();
  return label || "the correct choice";
}

// Convenience constructors (used by the template engine).
export const intAns = (value: number): TypedAnswer => ({ type: "integer", value });
export const decAns = (value: number): TypedAnswer => ({ type: "decimal", value });
export const fracAns = (num: number, den: number): TypedAnswer => {
  const r = reduceFraction(num, den);
  return { type: "fraction", num: r.num, den: r.den };
};
export const choiceAns = (choiceIndex: number): TypedAnswer => ({
  type: "multipleChoice",
  choiceIndex,
});
