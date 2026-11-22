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
  | "multipleChoice"
  | "solutionSet";

export type TypedAnswer =
  | { type: "integer"; value: number }
  | { type: "decimal"; value: number }
  | { type: "fraction"; num: number; den: number }
  | { type: "expression"; canonical: string }
  | { type: "multipleChoice"; choiceIndex: number }
  /** An unordered set of expressions — the solutions of an equation. Members
   *  are expression strings in the `expression` grammar; an empty array is
   *  "no solution". Wire form: members joined by "," (or the literal "none"). */
  | { type: "solutionSet"; members: string[] };

/**
 * Which extra keys the on-screen algebra pad shows for an item (contract §4).
 * Declared by the TEMPLATE, never derived from the answer, so the pad can't
 * leak it. `algebra` is the base set; `complex` adds i, `logs` adds log/ln/e,
 * `sequence` adds n. A `solutionSet` item also gets ",", "±" and "No solution"
 * whatever its palette.
 */
export type AnswerPalette = "algebra" | "complex" | "logs" | "sequence";

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
    // "log_2 8" (base, space, argument) → "log_(2)8" BEFORE whitespace is
    // collapsed, so the base and the argument cannot fuse into "log_28". Runs
    // before the mixed-number rule below, which would otherwise read "2 8/2"
    // inside "log_2 8/2" as a mixed number.
    .replace(/log_\s*(\d+(?:\.\d+)?|[a-z])\s+(?=\S)/g, "log_($1)")
    // A whole number followed by a bare fraction is a mixed number ("2 1/2").
    // Make the implied addition explicit — and parenthesize it — BEFORE
    // whitespace is collapsed, so it evaluates as (2 + 1/2) = 2.5 rather than
    // the meaningless "21/2", and so a leading sign folds over the whole value
    // (e.g. "-2 1/2" → "-(2+1/2)" = -2.5, "5-2 1/2" → "5-(2+1/2)").
    .replace(/(\d+)\s+(\d+\s*\/\s*\d+)/g, "($1+$2)")
    .replace(/\s+/g, "")
    .replace(/\*\*/g, "^"); // normalize exponent notation
}

// ── The expression grammar (Algebra 2 contract §1) ──────────────────────────
//
//   expr    := term (('+'|'-') term)*
//   term    := signed (('*'|'/') signed | <implicit ×> power)*
//   signed  := ('-'|'+') signed | power
//   power   := primary ('^' exponent)?          exponent := ('-'|'+') exponent | power
//   primary := number | variable | constant | '(' expr ')' | '|' expr '|'
//            | root operand | sqrt/ln/log/abs argument | log_base argument
//
// Precedence note: unary minus binds LOOSER than '^', so "-x^2" is -(x²) and
// "-3^2" is -9. The pre-Algebra-2 parser bound the sign tighter ((-x)² = x²),
// which would have marked "-x^2+1" equal to "x^2+1" — a false positive no
// stored item relied on (every pre-existing expression template answers with
// unsigned fractions, remainders or radicals).
//
// Letters: a run of letters is split into reserved words (sqrt, log, ln, abs,
// pi) and otherwise SINGLE-letter atoms — "xy" is x·y. `e` and `i` are the
// constants (Euler's number, the imaginary unit), never variables. Before this,
// a letter run was one opaque variable ("xy" was a single unknown). No template
// or seeded item uses a multi-letter identifier in an expression answer (the
// only expression families are remainders, fraction-as-division and radicals),
// and any identity that held for an opaque atom still holds once that atom is a
// product, so the change only ever widens what counts as equal.

type ExprNode =
  | { kind: "number"; value: number }
  | { kind: "variable"; name: string }
  | { kind: "constant"; name: "i" | "e" | "pi" }
  | { kind: "root"; index: number; radicand: ExprNode }
  | { kind: "unary"; op: "-"; value: ExprNode }
  | { kind: "binary"; op: "+" | "-" | "*" | "/" | "^"; left: ExprNode; right: ExprNode }
  | { kind: "call"; fn: "ln" | "log" | "abs"; arg: ExprNode; base?: ExprNode };

type ParsedExpression = { ast: ExprNode; vars: string[] };

function parseRemainderExpression(s: string): { q: number; r: number } | null {
  const m = s.match(/^(-?\d+)r(-?\d+)$/i);
  if (!m) return null;
  return { q: Number(m[1]), r: Number(m[2]) };
}

type Tok =
  | { t: "num"; text: string }
  | { t: "var"; name: string }
  | { t: "const"; name: "i" | "e" | "pi" }
  | { t: "fn"; name: "ln" | "log" | "abs" | "sqrt" }
  | { t: "logb" }
  | { t: "root"; index: number }
  | { t: "op"; op: "+" | "-" | "*" | "/" | "^" }
  | { t: "lp" }
  | { t: "rp" }
  | { t: "absOpen" }
  | { t: "absClose" };

const SUPERSCRIPTS: Record<string, string> = {
  "⁰": "0", "¹": "1", "²": "2", "³": "3", "⁴": "4",
  "⁵": "5", "⁶": "6", "⁷": "7", "⁸": "8", "⁹": "9", "⁻": "-", "⁺": "+",
};
const SUBSCRIPTS: Record<string, string> = {
  "₀": "0", "₁": "1", "₂": "2", "₃": "3", "₄": "4",
  "₅": "5", "₆": "6", "₇": "7", "₈": "8", "₉": "9",
};

/** The Unicode the clients may send (contract §1), rewritten to the ASCII
 *  grammar. Applied at TOKENIZE time only, never to the stored canonical string,
 *  so `parseExpressionNumeric`'s deliberately strict expression-vs-number path
 *  (which refuses "−7") is untouched. */
function normalizeMathSymbols(s: string): string {
  return s
    .replace(/[−–]/g, "-")
    .replace(/[×·⋅∙]/g, "*")
    .replace(/÷/g, "/")
    .replace(/∜/g, "√[4]")
    .replace(/log([₀₁₂₃₄₅₆₇₈₉]+)/g, (_m, sub: string) =>
      `log_(${[...sub].map((c) => SUBSCRIPTS[c]).join("")})`,
    )
    .replace(/[⁰¹²³⁴⁵⁶⁷⁸⁹⁻⁺]+/g, (sup) => `^(${[...sup].map((c) => SUPERSCRIPTS[c]).join("")})`);
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

function endsValue(tok: Tok | undefined): boolean {
  return (
    !!tok &&
    (tok.t === "num" || tok.t === "var" || tok.t === "const" || tok.t === "rp" || tok.t === "absClose")
  );
}

function startsValue(tok: Tok | undefined): boolean {
  return (
    !!tok &&
    (tok.t === "num" ||
      tok.t === "var" ||
      tok.t === "const" ||
      tok.t === "fn" ||
      tok.t === "logb" ||
      tok.t === "root" ||
      tok.t === "lp" ||
      tok.t === "absOpen")
  );
}

function tokenizeExpression(s: string): Tok[] | null {
  const raw = normalizeMathSymbols(canonicalizeExpression(s));
  if (!raw) return null;
  const tokens: Tok[] = [];
  let absDepth = 0;
  for (let i = 0; i < raw.length; ) {
    const ch = raw[i];
    if (ch === "." && raw[i + 1] >= "0" && raw[i + 1] <= "9") {
      // A leading-dot decimal: ".5" is 0.5.
      let j = i + 1;
      while (j < raw.length && raw[j] >= "0" && raw[j] <= "9") j += 1;
      tokens.push({ t: "num", text: `0${raw.slice(i, j)}` });
      i = j;
      continue;
    }
    if (ch >= "0" && ch <= "9") {
      let j = i + 1;
      while (j < raw.length && raw[j] >= "0" && raw[j] <= "9") j += 1;
      if (j < raw.length && raw[j] === ".") {
        j += 1;
        if (!(j < raw.length && raw[j] >= "0" && raw[j] <= "9")) return null;
        while (j < raw.length && raw[j] >= "0" && raw[j] <= "9") j += 1;
      }
      tokens.push({ t: "num", text: raw.slice(i, j) });
      i = j;
      continue;
    }
    if (ch === "√") {
      if (raw[i + 1] === "[") {
        let j = i + 2;
        while (j < raw.length && raw[j] >= "0" && raw[j] <= "9") j += 1;
        if (j === i + 2 || raw[j] !== "]") return null;
        const index = rootIndexFromToken(raw.slice(i, j + 1));
        if (index === null) return null;
        tokens.push({ t: "root", index });
        i = j + 1;
        continue;
      }
      tokens.push({ t: "root", index: 2 });
      i += 1;
      continue;
    }
    if (ch === "∛") {
      tokens.push({ t: "root", index: 3 });
      i += 1;
      continue;
    }
    if (ch === "π") {
      tokens.push({ t: "const", name: "pi" });
      i += 1;
      continue;
    }
    if (ch >= "a" && ch <= "z") {
      let j = i + 1;
      while (j < raw.length && raw[j] >= "a" && raw[j] <= "z") j += 1;
      const run = raw.slice(i, j);
      for (let k = 0; k < run.length; ) {
        if (run.startsWith("sqrt", k)) {
          tokens.push({ t: "fn", name: "sqrt" });
          k += 4;
        } else if (run.startsWith("log", k)) {
          if (k + 3 === run.length && raw[j] === "_") {
            tokens.push({ t: "logb" });
            j += 1; // consume the "_"
          } else {
            tokens.push({ t: "fn", name: "log" });
          }
          k += 3;
        } else if (run.startsWith("abs", k)) {
          tokens.push({ t: "fn", name: "abs" });
          k += 3;
        } else if (run.startsWith("ln", k)) {
          tokens.push({ t: "fn", name: "ln" });
          k += 2;
        } else if (run.startsWith("pi", k)) {
          tokens.push({ t: "const", name: "pi" });
          k += 2;
        } else {
          const letter = run[k];
          tokens.push(
            letter === "e" || letter === "i"
              ? { t: "const", name: letter }
              : { t: "var", name: letter },
          );
          k += 1;
        }
      }
      i = j;
      continue;
    }
    if (ch === "|") {
      // A bar closes when one is open and the previous token ends a value
      // ("|x|", "|x-1|"); otherwise it opens ("||x|-1|", "2|x|").
      if (absDepth > 0 && endsValue(tokens[tokens.length - 1])) {
        tokens.push({ t: "absClose" });
        absDepth -= 1;
      } else {
        tokens.push({ t: "absOpen" });
        absDepth += 1;
      }
      i += 1;
      continue;
    }
    if (ch === "(") {
      tokens.push({ t: "lp" });
      i += 1;
      continue;
    }
    if (ch === ")") {
      tokens.push({ t: "rp" });
      i += 1;
      continue;
    }
    if (ch === "+" || ch === "-" || ch === "*" || ch === "/" || ch === "^") {
      tokens.push({ t: "op", op: ch });
      i += 1;
      continue;
    }
    return null;
  }
  return absDepth === 0 ? tokens : null;
}

function isOp(tok: Tok | undefined, op: "+" | "-" | "*" | "/" | "^"): boolean {
  return !!tok && tok.t === "op" && tok.op === op;
}

function parseExpression(raw: string): ParsedExpression | null {
  const tokens = tokenizeExpression(raw);
  if (!tokens || tokens.length === 0) return null;
  let index = 0;
  const vars = new Set<string>();
  const peek = () => tokens[index];
  const take = () => tokens[index++];

  const parseSum = (): ExprNode | null => {
    let left = parseTerm();
    if (!left) return null;
    while (isOp(peek(), "+") || isOp(peek(), "-")) {
      const op = (take() as { op: "+" | "-" }).op;
      const right = parseTerm();
      if (!right) return null;
      left = { kind: "binary", op, left, right };
    }
    return left;
  };

  const parseTerm = (): ExprNode | null => {
    let left = parseSigned();
    if (!left) return null;
    for (;;) {
      if (isOp(peek(), "*") || isOp(peek(), "/")) {
        const op = (take() as { op: "*" | "/" }).op;
        const right = parseSigned();
        if (!right) return null;
        left = { kind: "binary", op, left, right };
      } else if (startsValue(peek())) {
        // Implicit multiplication: 2x, 3i, (x+1)(x-2), 2√3, x(x+1), 2|x|.
        const right = parsePower();
        if (!right) return null;
        left = { kind: "binary", op: "*", left, right };
      } else {
        return left;
      }
    }
  };

  const parseSigned = (): ExprNode | null => {
    if (isOp(peek(), "+")) {
      take();
      return parseSigned();
    }
    if (isOp(peek(), "-")) {
      take();
      const value = parseSigned();
      return value ? { kind: "unary", op: "-", value } : null;
    }
    return parsePower();
  };

  const parseExponent = (): ExprNode | null => {
    if (isOp(peek(), "+")) {
      take();
      return parseExponent();
    }
    if (isOp(peek(), "-")) {
      take();
      const value = parseExponent();
      return value ? { kind: "unary", op: "-", value } : null;
    }
    return parsePower();
  };

  const parsePower = (): ExprNode | null => {
    const base = parsePrimary();
    if (!base) return null;
    if (!isOp(peek(), "^")) return base;
    take();
    const exponent = parseExponent();
    return exponent ? { kind: "binary", op: "^", left: base, right: exponent } : null;
  };

  /** A root's operand: a signed primary, so "√-4" works and "√x^2" stays (√x)². */
  const parseRootOperand = (): ExprNode | null => {
    if (isOp(peek(), "+")) {
      take();
      return parseRootOperand();
    }
    if (isOp(peek(), "-")) {
      take();
      const value = parseRootOperand();
      return value ? { kind: "unary", op: "-", value } : null;
    }
    return parsePrimary();
  };

  /** A function's argument: parenthesised, or a signed power ("ln 5", "log x^2"). */
  const parseFnArg = (): ExprNode | null =>
    peek()?.t === "lp" ? parsePrimary() : parseSigned();

  const parsePrimary = (): ExprNode | null => {
    const tok = take();
    if (!tok) return null;
    switch (tok.t) {
      case "num":
        return { kind: "number", value: Number(tok.text) };
      case "var":
        vars.add(tok.name);
        return { kind: "variable", name: tok.name };
      case "const":
        return { kind: "constant", name: tok.name };
      case "lp": {
        const inner = parseSum();
        if (!inner || take()?.t !== "rp") return null;
        return inner;
      }
      case "absOpen": {
        const inner = parseSum();
        if (!inner || take()?.t !== "absClose") return null;
        return { kind: "call", fn: "abs", arg: inner };
      }
      case "root": {
        const radicand = parseRootOperand();
        return radicand ? { kind: "root", index: tok.index, radicand } : null;
      }
      case "fn": {
        const arg = parseFnArg();
        if (!arg) return null;
        if (tok.name === "sqrt") return { kind: "root", index: 2, radicand: arg };
        return { kind: "call", fn: tok.name, arg };
      }
      case "logb": {
        let base: ExprNode | null = null;
        const next = take();
        if (!next) return null;
        if (next.t === "lp") {
          base = parseSum();
          if (!base || take()?.t !== "rp") return null;
        } else if (next.t === "num") {
          base = { kind: "number", value: Number(next.text) };
        } else if (next.t === "var") {
          vars.add(next.name);
          base = { kind: "variable", name: next.name };
        } else if (next.t === "const") {
          base = { kind: "constant", name: next.name };
        } else {
          return null;
        }
        const arg = parseFnArg();
        return arg ? { kind: "call", fn: "log", arg, base } : null;
      }
      default:
        return null;
    }
  };

  const ast = parseSum();
  if (!ast || index !== tokens.length) return null;
  return { ast, vars: [...vars].sort() };
}

// ── Complex evaluation (principal branches) ─────────────────────────────────

type Cx = { re: number; im: number };

const cx = (re: number, im = 0): Cx => ({ re, im });

function cxFinite(z: Cx | null): z is Cx {
  return z !== null && Number.isFinite(z.re) && Number.isFinite(z.im);
}

function cxAbs(z: Cx): number {
  return Math.hypot(z.re, z.im);
}

function cxIsReal(z: Cx, tol = 1e-12): boolean {
  return Math.abs(z.im) <= tol * Math.max(1, Math.abs(z.re));
}

function cxMul(a: Cx, b: Cx): Cx {
  return cx(a.re * b.re - a.im * b.im, a.re * b.im + a.im * b.re);
}

function cxDiv(a: Cx, b: Cx): Cx | null {
  const d = b.re * b.re + b.im * b.im;
  if (d < 1e-24) return null;
  return cx((a.re * b.re + a.im * b.im) / d, (a.im * b.re - a.re * b.im) / d);
}

function cxLog(z: Cx): Cx | null {
  if (z.re === 0 && z.im === 0) return null;
  // Normalise a negative zero so log(-4 - 0i) is the principal ln 4 + iπ.
  const im = z.im === 0 ? 0 : z.im;
  return cx(Math.log(Math.hypot(z.re, im)), Math.atan2(im, z.re));
}

function cxExp(z: Cx): Cx {
  const m = Math.exp(z.re);
  return cx(m * Math.cos(z.im), m * Math.sin(z.im));
}

function nearInteger(x: number): number | null {
  const r = Math.round(x);
  return Math.abs(x - r) < 1e-12 ? r : null;
}

function cxPowInt(base: Cx, n: number): Cx | null {
  let result = cx(1);
  let b = base;
  let k = Math.abs(n);
  while (k > 0) {
    if (k & 1) result = cxMul(result, b);
    b = cxMul(b, b);
    k >>= 1;
  }
  return n < 0 ? cxDiv(cx(1), result) : result;
}

/**
 * base^exponent. Integer exponents multiply exactly (so i² is exactly −1). A
 * NEGATIVE REAL base with a rational exponent whose reduced denominator is odd
 * takes the real root, the high-school convention ((−8)^(1/3) = −2,
 * (−8)^(2/3) = 4) — the same value the ∛ sign gives, so ∛x ≡ x^(1/3) everywhere.
 * Everything else is the principal branch exp(w·log z).
 */
function cxPow(base: Cx, exponent: Cx): Cx | null {
  if (cxIsReal(exponent, 0)) {
    const x = exponent.re;
    const n = nearInteger(x);
    if (n !== null && Math.abs(n) <= 4096) return cxPowInt(base, n);
    if (cxIsReal(base, 0)) {
      if (base.re > 0) return cx(Math.pow(base.re, x));
      if (base.re === 0) return x > 0 ? cx(0) : null;
      // An odd reduced denominator (any odd q up to 99): the real root, so
      // (−2048)^(1/11) = −2. An even-denominator multiple (2/6) never gets
      // here at q = 3 unless it reduces to an odd denominator.
      for (let q = 3; q <= 99; q += 2) {
        const p = nearInteger(x * q);
        if (p !== null) {
          const magnitude = Math.pow(-base.re, x);
          return cx(Math.abs(p) % 2 === 0 ? magnitude : -magnitude);
        }
      }
    }
  }
  if (base.re === 0 && base.im === 0) return exponent.re > 0 ? cx(0) : null;
  const log = cxLog(base);
  return log ? cxExp(cxMul(exponent, log)) : null;
}

/** The n-th root: a real root for a non-negative radicand or an odd index of a
 *  negative one (∛−8 = −2, as before); the principal root otherwise (√−4 = 2i). */
function cxRoot(z: Cx, index: number): Cx | null {
  if (cxIsReal(z, 0)) {
    if (z.re >= 0) return cx(Math.pow(z.re, 1 / index));
    if (index % 2 === 1) return cx(-Math.pow(-z.re, 1 / index));
  }
  const log = cxLog(z);
  return log ? cxExp(cx(log.re / index, log.im / index)) : null;
}

/** Set when an evaluation left the real numbers: a root, power or log of
 *  REAL inputs produced a non-real value (√−2, log(−3), (−2)^0.37). */
type EvalTrace = { leftReals: boolean };

function evalExpression(
  node: ExprNode,
  env: Record<string, number>,
  trace?: EvalTrace,
): Cx | null {
  const value = evalNode(node, env, trace);
  return cxFinite(value) ? value : null;
}

/** Record whether a branch-dependent step turned real inputs into a non-real. */
function traced(result: Cx | null, inputs: Cx[], trace?: EvalTrace): Cx | null {
  if (
    trace &&
    cxFinite(result) &&
    !cxIsReal(result, 1e-9) &&
    inputs.every((z) => cxIsReal(z, 1e-12))
  ) {
    trace.leftReals = true;
  }
  return result;
}

function evalNode(node: ExprNode, env: Record<string, number>, trace?: EvalTrace): Cx | null {
  switch (node.kind) {
    case "number":
      return cx(node.value);
    case "variable":
      return Object.prototype.hasOwnProperty.call(env, node.name) ? cx(env[node.name]) : null;
    case "constant":
      return node.name === "i" ? cx(0, 1) : node.name === "e" ? cx(Math.E) : cx(Math.PI);
    case "root": {
      const radicand = evalNode(node.radicand, env, trace);
      return cxFinite(radicand) ? traced(cxRoot(radicand, node.index), [radicand], trace) : null;
    }
    case "unary": {
      const inner = evalNode(node.value, env, trace);
      return cxFinite(inner) ? cx(-inner.re, -inner.im) : null;
    }
    case "call": {
      const arg = evalNode(node.arg, env, trace);
      if (!cxFinite(arg)) return null;
      if (node.fn === "abs") return cx(cxAbs(arg));
      const lnArg = traced(cxLog(arg), [arg], trace);
      if (!lnArg) return null;
      if (node.fn === "ln") return lnArg;
      const base = node.base ? evalNode(node.base, env, trace) : cx(10);
      if (!cxFinite(base)) return null;
      const lnBase = traced(cxLog(base), [base], trace);
      return lnBase ? cxDiv(lnArg, lnBase) : null;
    }
    case "binary": {
      const left = evalNode(node.left, env, trace);
      const right = evalNode(node.right, env, trace);
      if (!cxFinite(left) || !cxFinite(right)) return null;
      switch (node.op) {
        case "+":
          return cx(left.re + right.re, left.im + right.im);
        case "-":
          return cx(left.re - right.re, left.im - right.im);
        case "*":
          return cxMul(left, right);
        case "/":
          return cxDiv(left, right);
        default:
          // Only a genuinely non-real result leaves the real domain: an odd
          // denominator keeps a negative base real by convention, so
          // (x^(2/3))^(3/2) is compared at x = −8 (it is 8 there, not −8).
          return traced(cxPow(left, right), [left, right], trace);
      }
    }
  }
}

function cxClose(a: Cx, b: Cx, absTol: number, relTol: number): boolean {
  const diff = Math.hypot(a.re - b.re, a.im - b.im);
  return diff <= Math.max(absTol, relTol * Math.max(cxAbs(a), cxAbs(b)));
}

function containsVariable(node: ExprNode): boolean {
  switch (node.kind) {
    case "variable":
      return true;
    case "number":
    case "constant":
      return false;
    case "root":
      return containsVariable(node.radicand);
    case "unary":
      return containsVariable(node.value);
    case "call":
      return containsVariable(node.arg) || (!!node.base && containsVariable(node.base));
    case "binary":
      return containsVariable(node.left) || containsVariable(node.right);
  }
}

/** The value of a variable-free subtree, or null if it has a variable or is
 *  undefined (division by zero, log 0). */
function constantValue(node: ExprNode): Cx | null {
  return containsVariable(node) ? null : evalExpression(node, {});
}

// ── Sampling equivalence ────────────────────────────────────────────────────
// Two expressions are equal when they agree at every sample point where both
// are defined. The points always include negatives, non-integers and large
// values, plus points on both sides of every constant either expression
// mentions (so |x−10| is sampled above and below 10). There is no mode switch
// a constant sub-expression could flip.
//
// At a point where BOTH sides are real they are compared — this is what makes
// √(x²) ≢ x and |x| ≢ x. A point where either side is non-real (a log or an
// even root of a negative) is skipped, which is what lets log(x²) ≡ 2 log x
// and √(x³) ≡ x√x hold on their shared real domain. When either expression
// contains the imaginary unit, the expressions are complex-valued by design and
// every defined point is compared as complex numbers.

const BASE_SAMPLES = [
  0.37, -0.61, 1.21, -1.47, 1.73, -2.23, 2.39, 0.83, -3.71, 3.11, 4.07, -5.3, 5.83, 7.9, -6.2, 11.3,
  // Small magnitudes, so |x²−0.01| and x²−0.01 are told apart on (−0.1, 0.1).
  0, 0.03, -0.03, 0.3, -0.3, 0.07,
];

/** A variable named n is a SEQUENCE INDEX: it is only ever a positive integer
 *  (4^(n−1) ≡ (−2)^(2n−2) for every term, though not for real n). */
const INDEX_VARIABLE = "n";
const INDEX_SAMPLES = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 15, 20, 27];

/** Distinct magnitudes of the numeric literals in an expression. */
function literalMagnitudes(node: ExprNode, out: Set<number>): void {
  walkNodes(node, (n) => {
    if (n.kind === "number" && n.value > 0 && n.value <= 1e4) out.add(n.value);
  });
}

function expressionLiterals(pa: ParsedExpression, pb: ParsedExpression): number[] {
  const magnitudes = new Set<number>();
  literalMagnitudes(pa.ast, magnitudes);
  literalMagnitudes(pb.ast, magnitudes);
  return [...magnitudes].sort((a, b) => b - a).slice(0, 10);
}

function addPoint(points: number[], p: number): void {
  if (!points.some((q) => Math.abs(q - p) < 1e-6)) points.push(p);
}

/** The everyday real sample points: the base table, plus both sides of each
 *  literal at either sign (c ± 1.5, c ± 0.3), offset slightly so a point
 *  never sits exactly on a pole at c. */
function samplePoints(literals: number[]): number[] {
  const points = [...BASE_SAMPLES];
  for (const c of literals) {
    for (const p of [c + 1.53, c - 1.47, -c + 1.47, -c - 1.53, c + 0.31, c - 0.29, -c + 0.29, -c - 0.31]) {
      addPoint(points, p);
    }
  }
  return points;
}

/** A wider sweep, used only to FIND a shared real domain the everyday points
 *  missed (2 log(x−20) and log((x−20)²) are both real only for x > 20). */
function sweepPoints(literals: number[]): number[] {
  const points: number[] = [];
  for (const c of [0, ...literals]) {
    for (const d of [1.53, 3.07, 7.13, 20.3, 50.7, 150.3, 500.9]) {
      for (const p of [c + d, c - d, -c + d, -c - d]) addPoint(points, p);
    }
  }
  for (let k = -3; k <= 3; k += 1) {
    for (const m of [1.37, 4.19]) {
      addPoint(points, m * Math.pow(10, k));
      addPoint(points, -m * Math.pow(10, k));
    }
  }
  return points;
}

/** Is the expression complex-valued by design — an i, or a variable-free
 *  piece that is not real (√(−144) is 12i written another way)? */
function containsImaginaryUnit(node: ExprNode): boolean {
  return someNode(node, (n) => {
    if (n.kind === "constant") return n.name === "i";
    if (containsVariable(n) || n.kind === "number") return false;
    const value = evalExpression(n, {});
    return value !== null && !cxIsReal(value, 1e-12);
  });
}

/** One sample point: every variable reads its own table at its own stride. */
function envFor(vars: string[], real: number[], point: number): Record<string, number> {
  const env: Record<string, number> = {};
  vars.forEach((name, k) => {
    const table = name === INDEX_VARIABLE ? INDEX_SAMPLES : real;
    env[name] = table[(point + 5 * k) % table.length];
  });
  return env;
}

function parsedExpressionsEquivalent(pa: ParsedExpression, pb: ParsedExpression): boolean {
  const vars = [...new Set([...pa.vars, ...pb.vars])].sort();
  if (vars.length === 0) {
    const av = evalExpression(pa.ast, {});
    const bv = evalExpression(pb.ast, {});
    return av !== null && bv !== null && cxClose(av, bv, 1e-9, 1e-13);
  }
  const complexValued = containsImaginaryUnit(pa.ast) || containsImaginaryUnit(pb.ast);
  const literals = expressionLiterals(pa, pb);
  const tableSize = (real: number[]) =>
    Math.max(...vars.map((v) => (v === INDEX_VARIABLE ? INDEX_SAMPLES.length : real.length)));

  // Pass 1 — the shared real domain. A point counts only where NEITHER side
  // produced a non-real value at any step (so (√(x³)·x^(5/2))³ isn't compared
  // at x < 0, where two imaginary halves multiply back to a real). With an i
  // anywhere the expressions are complex by design: every defined point counts.
  let compared = 0;
  let aRealSomewhere = false;
  let bRealSomewhere = false;
  const compareAt = (real: number[], point: number): boolean => {
    const env = envFor(vars, real, point);
    const ta: EvalTrace = { leftReals: false };
    const tb: EvalTrace = { leftReals: false };
    const av = evalExpression(pa.ast, env, ta);
    const bv = evalExpression(pb.ast, env, tb);
    if (av !== null && !ta.leftReals) aRealSomewhere = true;
    if (bv !== null && !tb.leftReals) bRealSomewhere = true;
    if (av === null || bv === null) return true; // a pole or log 0 on either side
    if (!complexValued && (ta.leftReals || tb.leftReals)) return true;
    compared += 1;
    return cxClose(av, bv, 1e-9, 1e-9);
  };
  const everyday = samplePoints(literals);
  for (let point = 0; point < tableSize(everyday); point++) {
    if (!compareAt(everyday, point)) return false;
  }
  if (compared >= 3) return true;

  // Pass 2 — too few shared real points: sweep outward and around each literal
  // until at least 5 are found or the budget runs out, and compare there.
  const sweep = sweepPoints(literals);
  for (let point = 0; point < Math.min(tableSize(sweep), 400) && compared < 5; point++) {
    if (!compareAt(sweep, point)) return false;
  }
  if (compared >= 3) return true;
  if (compared > 0 || aRealSomewhere || bRealSomewhere) return false;

  // Pass 3 — last resort: no shared real point exists and neither side is real
  // anywhere sampled (a sequence-like (−2)^x at real x): principal values.
  for (let point = 0; point < tableSize(everyday); point++) {
    const env = envFor(vars, everyday, point);
    const av = evalExpression(pa.ast, env);
    const bv = evalExpression(pb.ast, env);
    if (av === null || bv === null) continue;
    compared += 1;
    if (!cxClose(av, bv, 1e-9, 1e-9)) return false;
  }
  return compared >= 3;
}

export type AnswerComparisonOptions = {
  /** Legacy strict check: both sides must be the literal canonical `a√b` form.
   *  The grader no longer uses this (the simplifying-radicals template declares
   *  `answerForm: "simplifiedRadical"` instead, which nudges rather than fails);
   *  kept for any caller that wants the old exact-form comparison. */
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
  if (parsedExpressionsEquivalent(pa, pb)) return true;
  // Too few comparable points (every sample hit a pole) falls back to the
  // literal string, as before; a real disagreement already returned false
  // inside, which this re-check cannot overturn for different strings.
  return canonicalizeExpression(a) === canonicalizeExpression(b);
}


// ── Solution sets (contract §2) ─────────────────────────────────────────────

const NO_SOLUTION_WORDS = new Set([
  "none",
  "nosolution",
  "nosolutions",
  "norealsolution",
  "norealsolutions",
  "∅",
  "{}",
  "empty",
  "emptyset",
]);

/**
 * A leading assignment whose left side is only a NAME: a letter ("x =",
 * "y ="), a subscripted letter ("a_n =", "a_(n) =", "S_{n} =", "x₁ ="), or a
 * function of one variable ("f(x) =", "f^-1(x) =", "f⁻¹(x) ="). Stripped so
 * the answer is its right-hand side. An equation whose left side is math
 * ("2x+1 = 5") never matches, so it is never silently replaced by "5".
 */
const LEADING_ASSIGNMENT =
  /^\s*[a-zA-Z](?:\d+|_(?:[a-zA-Z0-9]+|\([a-zA-Z0-9+\-]+\)|\{[a-zA-Z0-9+\-]+\})|[₀₁₂₃₄₅₆₇₈₉]+)?(?:\^\(?-1\)?|⁻¹)?(?:\(\s*[a-zA-Z]\s*\))?\s*=\s*/;

/** Expand every ± in a member into both signs ("1±2i" → "1+2i", "1-2i").
 *  Only "±" and the spelled-out "+/-" mean plus-or-minus: "5+-2" is 5 plus
 *  negative 2 (= 3), never {7, 3}. At most three ± per member. A member written
 *  as an excluded value ("x ≠ 3") is NOT stripped — on a solve item that would
 *  turn an exclusion into an inclusion — so it stays unparseable. */
function expandPlusMinus(member: string): string[] {
  const s = member.replace(/\+\s*\/\s*-/g, "±");
  const parts = s.split("±");
  if (parts.length === 1) return [s];
  if (parts.length > 4) return [s];
  let out = [parts[0]];
  for (const part of parts.slice(1)) {
    out = out.flatMap((prefix) => [`${prefix}+${part}`, `${prefix}-${part}`]);
  }
  return out;
}

/**
 * Split a solution-set answer into canonical member expressions. Accepts ","
 * (the wire form), ";", " or ", " and ", optional braces, an optional "x ="
 * on each member, and ± (expanded to both members). "none" / "no solution" /
 * "∅" is the empty set. Null for blank input. Duplicates are collapsed at
 * comparison time (under equivalence, so "2, 4/2" is one solution).
 */
function parseSolutionSet(raw: string): string[] | null {
  let s = raw.trim().toLowerCase();
  if (!s) return null;
  if (NO_SOLUTION_WORDS.has(s.replace(/\s+/g, ""))) return [];
  if (s.startsWith("{") && s.endsWith("}")) s = s.slice(1, -1);
  const members: string[] = [];
  for (const piece of s.split(/\s*(?:,|;|\bor\b|\band\b)\s*/)) {
    const stripped = piece
      .trim()
      .replace(LEADING_ASSIGNMENT, "")
      .trim();
    if (!stripped) continue;
    for (const expanded of expandPlusMinus(stripped)) {
      const canonical = canonicalizeExpression(expanded);
      if (canonical && !members.includes(canonical)) members.push(canonical);
    }
  }
  return members.length > 0 ? members : null;
}

function dedupeEquivalent(members: readonly string[]): string[] {
  const kept: string[] = [];
  for (const m of members) {
    if (!kept.some((k) => expressionsEquivalent(k, m))) kept.push(m);
  }
  return kept;
}

function solutionSetsEqual(a: readonly string[], b: readonly string[]): boolean {
  const da = dedupeEquivalent(a);
  const db = dedupeEquivalent(b);
  if (da.length !== db.length) return false;
  return (
    da.every((m) => db.some((n) => expressionsEquivalent(m, n))) &&
    db.every((n) => da.some((m) => expressionsEquivalent(m, n)))
  );
}

/** A typed answer viewed as a solution set (a lone value is a one-member set). */
function solutionMembersOf(a: TypedAnswer): string[] | null {
  switch (a.type) {
    case "solutionSet":
      return a.members;
    case "expression":
      return [a.canonical];
    case "integer":
    case "decimal":
      return [String(a.value)];
    case "fraction":
      return [a.den === 1 ? String(a.num) : `${a.num}/${a.den}`];
    case "multipleChoice":
      return null;
  }
}

// ── Form checkers (contract §3) ─────────────────────────────────────────────
// Pure predicates over the parsed AST. Each is deliberately CONSERVATIVE: when
// a shape is unusual enough that the checker can't tell, it says "in form",
// because a correct answer marked wrong costs far more than a missed nudge.

/** Terms of a top-level sum, signs folded in: a−(b+c) → [a, b, c]. */
function sumTerms(node: ExprNode): ExprNode[] {
  if (node.kind === "binary" && (node.op === "+" || node.op === "-")) {
    return [...sumTerms(node.left), ...sumTerms(node.right)];
  }
  if (node.kind === "unary") return sumTerms(node.value);
  return [node];
}

function isSum(node: ExprNode): boolean {
  return node.kind === "binary" && (node.op === "+" || node.op === "-");
}

function stripSign(node: ExprNode): ExprNode {
  return node.kind === "unary" ? stripSign(node.value) : node;
}

/** Factors of a product/quotient chain with their multiplicities; signs are
 *  dropped and integer powers fold into the multiplicity. */
function productFactors(node: ExprNode): { node: ExprNode; mult: number }[] {
  const n = stripSign(node);
  if (n.kind === "binary" && (n.op === "*" || n.op === "/")) {
    return [...productFactors(n.left), ...productFactors(n.right)];
  }
  if (n.kind === "binary" && n.op === "^") {
    const exponent = constantValue(n.right);
    const k = exponent && cxIsReal(exponent) ? nearInteger(exponent.re) : null;
    if (k !== null && k >= 1) {
      return productFactors(n.left).map((f) => ({ node: f.node, mult: f.mult * k }));
    }
  }
  return [{ node: n, mult: 1 }];
}

function nodeKey(node: ExprNode): string {
  return JSON.stringify(node);
}

/** Visit every node (pre-order). */
function walkNodes(node: ExprNode, visit: (n: ExprNode) => void): void {
  visit(node);
  switch (node.kind) {
    case "root":
      walkNodes(node.radicand, visit);
      return;
    case "unary":
      walkNodes(node.value, visit);
      return;
    case "call":
      walkNodes(node.arg, visit);
      if (node.base) walkNodes(node.base, visit);
      return;
    case "binary":
      walkNodes(node.left, visit);
      walkNodes(node.right, visit);
      return;
    default:
      return;
  }
}

function someNode(node: ExprNode, pred: (n: ExprNode) => boolean): boolean {
  let found = false;
  walkNodes(node, (n) => {
    if (!found && pred(n)) found = true;
  });
  return found;
}

/** A constant exponent that is not an integer (x^(1/2), 8^(2/3)). */
function hasFractionalExponent(node: ExprNode): boolean {
  if (node.kind !== "binary" || node.op !== "^") return false;
  const exponent = constantValue(node.right);
  return !!exponent && cxIsReal(exponent) && nearInteger(exponent.re) === null;
}

function isRadicalNode(n: ExprNode): boolean {
  return n.kind === "root" || hasFractionalExponent(n);
}

function isLogCall(n: ExprNode): boolean {
  return n.kind === "call" && (n.fn === "log" || n.fn === "ln");
}

/** Positive divisors of a positive integer. */
function divisorsOf(n: number): number[] {
  const out: number[] = [];
  for (let d = 1; d * d <= n; d++) {
    if (n % d === 0) {
      out.push(d);
      if (d * d !== n) out.push(n / d);
    }
  }
  return out;
}

/** Does an integer polynomial (coefficients constant-first) have the rational
 *  root p/q? Exact: q^deg · P(p/q) = Σ a_k p^k q^(deg−k), in BigInt. */
function hasRationalRoot(coeffs: number[], p: number, q: number): boolean {
  const deg = coeffs.length - 1;
  let sum = BigInt(0);
  for (let k = 0; k <= deg; k++) {
    sum += BigInt(coeffs[k]) * BigInt(p) ** BigInt(k) * BigInt(q) ** BigInt(deg - k);
  }
  return sum === BigInt(0);
}

/** Does a quartic split into two integer quadratics (Ax²+bx+C)(Dx²+ex+F)? */
function quarticSplits(c: number[]): boolean {
  const [a0, a1, a2, a3, a4] = c;
  const bound = Math.min(2000, 2 * Math.max(...c.map(Math.abs)) + 10);
  for (const A of divisorsOf(Math.abs(a4))) {
    const D = a4 / A;
    for (const absC of divisorsOf(Math.abs(a0))) {
      for (const C of [absC, -absC]) {
        const Fc = a0 / C;
        const det = D * C - A * Fc;
        const fits = (b: number, e: number) =>
          Number.isInteger(b) &&
          Number.isInteger(e) &&
          A * e + b * D === a3 &&
          b * Fc + C * e === a1 &&
          A * Fc + b * e + C * D === a2;
        if (det !== 0) {
          if (fits((a3 * C - A * a1) / det, (D * a1 - Fc * a3) / det)) return true;
        } else {
          for (let b = -bound; b <= bound; b++) {
            if (fits(b, (a3 - D * b) / A)) return true;
          }
        }
      }
    }
  }
  return false;
}

/**
 * Is an integer-coefficient polynomial (constant term first, degree ≥ 1)
 * irreducible over the integers — content 1, and no rational factor? Degree
 * 2–3 is decided by the rational-root test, degree 4 also tries a split into
 * two integer quadratics, and anything the test can't settle (degree ≥ 5 with
 * no rational root, or coefficients too large to enumerate) counts as
 * irreducible: an undecidable case must never reject a correct answer.
 */
function irreducibleOverIntegers(coeffs: number[]): boolean {
  const deg = coeffs.length - 1;
  if (coeffs.reduce((g, c) => gcd(g, c), 0) > 1) return false; // a whole-number factor left inside
  if (deg <= 1) return true;
  const a0 = coeffs[0];
  const lead = coeffs[deg];
  if (a0 === 0) return false; // x divides it
  if (Math.abs(a0) > 1e6 || Math.abs(lead) > 1e6) return true;
  for (const p of divisorsOf(Math.abs(a0))) {
    for (const q of divisorsOf(Math.abs(lead))) {
      if (hasRationalRoot(coeffs, p, q) || hasRationalRoot(coeffs, -p, q)) return false;
    }
  }
  if (deg === 4 && quarticSplits(coeffs)) return false;
  return true;
}

/**
 * factored: FULLY factored over the integers. Not a bare sum, not a single sum
 * dressed up as a product ("1·(x²+5x+6)"), and — when the answer is a
 * polynomial in one variable with integer coefficients — no factor splits
 * further: no whole-number common factor left inside a bracket ((2x−10)…) and
 * no factor with a rational factor of its own ((x²−9), (x²−9)², x³−8).
 * x²+5x+25 left over from a difference of cubes is irreducible and passes.
 * Order, repeated factors as powers or written out, a leading minus or
 * constant, and x as a factor all pass. Several variables, or a factor that
 * isn't an integer polynomial, keep the permissive any-product rule.
 */
function isFactoredForm(node: ExprNode): boolean {
  const top = stripSign(node);
  if (isSum(top)) return false;
  const factors = productFactors(top);
  const variable = factors.filter((f) => containsVariable(f.node));
  const variableCount = variable.reduce((sum, f) => sum + f.mult, 0);
  if (variableCount === 1 && isSum(variable[0].node)) {
    // One sum factor: factored only when a real constant was pulled out (2(x+3)).
    const pulledOut = factors.some((f) => {
      if (containsVariable(f.node)) return false;
      const value = constantValue(f.node);
      return !!value && Math.abs(cxAbs(value) - 1) > 1e-12;
    });
    if (!pulledOut) return false;
  }
  // A factor of exactly 1 is padding, and so is a factor written with a
  // variable that is identically a constant ((x−x+1), (x/x)).
  if (factors.length > 1 && factors.some((f) => f.node.kind === "number" && f.node.value === 1)) {
    return false;
  }
  // The same factor above and below the line cancels to 1 ((x/x), (x+1)/(x+1)).
  const above = new Set<string>();
  const below = new Set<string>();
  const split = (n: ExprNode, under: boolean): void => {
    const m = stripSign(n);
    if (m.kind === "binary" && m.op === "*") {
      split(m.left, under);
      split(m.right, under);
    } else if (m.kind === "binary" && m.op === "/") {
      split(m.left, under);
      split(m.right, !under);
    } else if (containsVariable(m)) {
      (under ? below : above).add(nodeKey(m));
    }
  };
  split(top, false);
  for (const k of above) if (below.has(k)) return false;
  // Every one-variable factor is checked on its own, whatever else the product
  // holds — another variable elsewhere ("·y/y") switches nothing off.
  for (const f of variable) {
    const names = new Set<string>();
    walkNodes(f.node, (n) => {
      if (n.kind === "variable") names.add(n.name);
    });
    if (names.size !== 1) continue; // a several-variable factor: permissive
    const poly = toPoly(f.node, [...names][0]);
    if (!poly) continue;
    const trimmed = polyTrim(poly);
    if (polyDegree(trimmed) < 1) return false; // a constant dressed up with a variable
    const exact = trimmed.map((c) => nearInteger(c));
    if (exact.every((c) => c !== null)) {
      if (!irreducibleOverIntegers(exact as number[])) return false;
      continue;
    }
    // Rational (decimal or fraction) coefficients: scale to the primitive
    // integer polynomial first — x²−2.5x−1.5 is ½(2x²−5x−3) = ½(2x+1)(x−3).
    const primitive = primitiveIntegerPolynomial(trimmed);
    if (primitive && !irreducibleOverIntegers(primitive)) return false;
  }
  return true;
}

/** Smallest denominator (≤ 1000) that makes a coefficient an integer, or null. */
function rationalDenominator(c: number): number | null {
  for (let d = 1; d <= 1000; d++) {
    if (nearInteger(c * d) !== null) return d;
  }
  return null;
}

/** A rational-coefficient polynomial scaled to integers with content 1, or
 *  null when a coefficient isn't a recognisable rational. */
function primitiveIntegerPolynomial(coeffs: Poly): number[] | null {
  let l = 1;
  for (const c of coeffs) {
    const d = rationalDenominator(c);
    if (d === null) return null;
    l = (l * d) / gcd(l, d);
    if (l > 1e6) return null;
  }
  const ints = coeffs.map((c) => Math.round(c * l));
  const content = ints.reduce((g, c) => gcd(g, c), 0) || 1;
  return ints.map((c) => c / content);
}

/**
 * Numeric arithmetic a finished answer would have done: a term whose
 * numerator multiplies two numbers (2·3, 2·3√2, 6√2·1/2), a numeric quotient
 * not in lowest terms or over 1 (6/2, 4/2+√2, x/1), or a quotient whose
 * numerator's whole-number coefficients share a factor with its whole-number
 * denominator (6√2/2, (2+4√2)/2). Reduced rational coefficients — (1/2)x²,
 * x/2, 3√2/2 — are finished.
 */
function hasUndoneNumericArithmetic(node: ExprNode): boolean {
  const numeratorFactors = (n: ExprNode): ExprNode[] => {
    const m = stripSign(n);
    if (m.kind === "binary" && m.op === "/") return numeratorFactors(m.left);
    if (m.kind === "binary" && m.op === "*") {
      return [...numeratorFactors(m.left), ...numeratorFactors(m.right)];
    }
    return [m];
  };
  let undone = false;
  walkNodes(node, (n) => {
    if (undone) return;
    if (isSum(n) || n === node) {
      for (const term of sumTerms(n)) {
        if (numeratorFactors(term).filter((f) => f.kind === "number").length > 1) undone = true;
      }
    }
    if (n.kind !== "binary" || n.op !== "/") return;
    const den = stripSign(n.right);
    if (den.kind !== "number" || !Number.isInteger(den.value)) return;
    if (Math.abs(den.value) === 1) {
      undone = true;
      return;
    }
    let content = 0;
    for (const term of sumTerms(n.left)) {
      const literal = numeratorFactors(term).find((f) => f.kind === "number");
      const k = literal && literal.kind === "number" ? literal.value : 1;
      if (!Number.isInteger(k)) return;
      content = gcd(content, k);
    }
    if (gcd(content, den.value) > 1) undone = true;
  });
  return undone;
}

/** The like-term signature of one term: its variable powers plus any
 *  irrational constant atoms (√2, π, i), or null when it isn't a monomial. */
function monomialSignature(term: ExprNode): string | null {
  const powers = new Map<string, number>();
  const atoms: string[] = [];
  let ok = true;
  const visit = (n: ExprNode, sign: number): void => {
    switch (n.kind) {
      case "number":
        return;
      case "variable":
        powers.set(n.name, (powers.get(n.name) ?? 0) + sign);
        return;
      case "constant":
        atoms.push(n.name);
        return;
      case "unary":
        visit(n.value, sign);
        return;
      case "root":
      case "call":
        if (someNode(n, isSum)) ok = false;
        atoms.push(nodeKey(n));
        return;
      case "binary":
        if (n.op === "+" || n.op === "-") {
          ok = false;
          return;
        }
        if (n.op === "*") {
          visit(n.left, sign);
          visit(n.right, sign);
          return;
        }
        if (n.op === "/") {
          visit(n.left, sign);
          visit(n.right, -sign);
          return;
        }
        // ^
        if (!containsVariable(n.left)) {
          if (someNode(n, isSum)) ok = false;
          atoms.push(nodeKey(n));
          return;
        }
        if (n.left.kind === "variable") {
          const exponent = constantValue(n.right);
          const k = exponent && cxIsReal(exponent) ? exponent.re : null;
          if (k !== null) {
            powers.set(n.left.name, (powers.get(n.left.name) ?? 0) + sign * k);
            return;
          }
        }
        ok = false; // (2x)^2, (x+1)^2, x^y — not multiplied out
        return;
    }
  };
  visit(term, 1);
  if (!ok) return null;
  const vars = [...powers.entries()]
    .filter(([, k]) => Math.abs(k) > 1e-12)
    .map(([name, k]) => `${name}^${k}`)
    .sort();
  return `${vars.join("·")}|${atoms.sort().join("·")}`;
}

/** expanded: a sum of monomials, no parenthesised sums, like terms combined
 *  (terms may come in any order). */
function isExpandedForm(node: ExprNode): boolean {
  if (hasUndoneNumericArithmetic(node)) return false;
  const seen = new Set<string>();
  for (const term of sumTerms(node)) {
    const signature = monomialSignature(term);
    if (signature === null || seen.has(signature)) return false;
    seen.add(signature);
  }
  return true;
}

/** Where the imaginary unit sits inside one term: ok only as a plain factor
 *  (not under ^, a root, a function, or in a denominator). */
function countFreeI(node: ExprNode, inDenominator: boolean): { count: number; ok: boolean } {
  switch (node.kind) {
    case "constant":
      if (node.name !== "i") return { count: 0, ok: true };
      return { count: 1, ok: !inDenominator };
    case "number":
    case "variable":
      return { count: 0, ok: true };
    case "unary":
      return countFreeI(node.value, inDenominator);
    case "root":
    case "call": {
      const hasI = someNode(node, (n) => n.kind === "constant" && n.name === "i");
      return { count: hasI ? 1 : 0, ok: !hasI };
    }
    case "binary": {
      if (node.op === "^") {
        const hasI = someNode(node, (n) => n.kind === "constant" && n.name === "i");
        return { count: hasI ? 1 : 0, ok: !hasI };
      }
      const l = countFreeI(node.left, inDenominator);
      const r = countFreeI(node.right, inDenominator || node.op === "/");
      return { count: l.count + r.count, ok: l.ok && r.ok };
    }
  }
}

/** A term with its single free i replaced by 1 (2i → 2, i/2 → 1/2, i√3 → √3). */
function withoutI(node: ExprNode): ExprNode {
  if (node.kind === "constant" && node.name === "i") return { kind: "number", value: 1 };
  if (node.kind === "unary") return { kind: "unary", op: "-", value: withoutI(node.value) };
  if (node.kind === "binary" && node.op === "*") {
    if (node.left.kind === "constant" && node.left.name === "i") return withoutI(node.right);
    if (node.right.kind === "constant" && node.right.name === "i") return withoutI(node.left);
    return { kind: "binary", op: "*", left: withoutI(node.left), right: withoutI(node.right) };
  }
  if (node.kind === "binary" && node.op === "/") {
    return { kind: "binary", op: "/", left: withoutI(node.left), right: node.right };
  }
  return node;
}

/** An integer or decimal literal (possibly signed). */
function isNumberLiteral(n: ExprNode): n is { kind: "number"; value: number } {
  return n.kind === "number";
}

/** A radical atom with nothing left to do: √m, ∛m, … with a simplified radicand. */
function isSimplifiedRootAtom(n: ExprNode): boolean {
  return n.kind === "root" && radicandSimplified(n.radicand, n.index);
}

/** k, √m, k√m, π, kπ — one number with nothing left to compute. Returns the
 *  integer coefficient (1 when there is none), or null if it isn't one. */
function reducedRealNumerator(raw: ExprNode): number | null {
  const n = stripSign(raw);
  if (isNumberLiteral(n)) return Number.isInteger(n.value) ? n.value : null;
  if (isSimplifiedRootAtom(n) || (n.kind === "constant" && n.name !== "i")) return 1;
  if (n.kind === "binary" && n.op === "*") {
    // Signs may sit on either factor ("-3i√5" parses as (−3)·√5 once i is out).
    const left = stripSign(n.left);
    const right = stripSign(n.right);
    const pairs: [ExprNode, ExprNode][] = [
      [left, right],
      [right, left],
    ];
    for (const [k, atom] of pairs) {
      if (
        isNumberLiteral(k) &&
        Number.isInteger(k.value) &&
        (isSimplifiedRootAtom(atom) || (atom.kind === "constant" && atom.name !== "i"))
      ) {
        return k.value;
      }
    }
  }
  return null;
}

/**
 * Is one part of a + bi a single, reduced real number — an integer, a decimal,
 * a reduced fraction, or a simplified radical (or such a radical over a whole
 * number with no common factor)? "6/2", "2·5/2", "4/2" are unfinished.
 */
function isReducedReal(n: ExprNode): boolean {
  const node = stripSign(n);
  if (isNumberLiteral(node)) return true;
  if (reducedRealNumerator(node) !== null) return true;
  if (node.kind === "binary" && node.op === "/") {
    const den = stripSign(node.right);
    if (!isNumberLiteral(den) || !Number.isInteger(den.value) || Math.abs(den.value) < 2) return false;
    const k = reducedRealNumerator(stripSign(node.left));
    return k !== null && gcd(k, den.value) === 1;
  }
  return false;
}

/** complexStandard: a + bi with real a and b, at most one of each, no i in a
 *  denominator, no i² (or any power/root of i) left, and a and b each a single
 *  reduced real number — "6i/2", "8/2+3i" and "4+6i/2" are unfinished. "3+2i",
 *  "2i+3", "-i", "5", "3-i/2", "3-(1/2)i", "14/5+(8/5)i", "2+i√3" and
 *  "-1/2-(√3/2)i" all pass. An expression with variables is out of this
 *  form's scope and passes. */
function isComplexStandardForm(node: ExprNode): boolean {
  // A variable is not part of a + bi. (A key that itself has variables fails
  // this form, so `meetsRequiredForm` doesn't enforce it for that item.)
  if (containsVariable(node)) return false;
  let realTerms = 0;
  let imaginaryTerms = 0;
  for (const term of sumTerms(node)) {
    const free = countFreeI(term, false);
    const value = constantValue(term);
    if (!free.ok || free.count > 1 || !value) return false;
    if (free.count === 0) {
      if (!cxIsReal(value, 1e-9)) return false; // √(−4) is not yet a + bi
      if (!isReducedReal(term)) return false;
      realTerms += 1;
    } else {
      if (Math.abs(value.re) > 1e-9 * Math.max(1, cxAbs(value))) return false;
      if (!isReducedReal(withoutI(term))) return false;
      imaginaryTerms += 1;
    }
  }
  return realTerms <= 1 && imaginaryTerms <= 1;
}

/** rationalizedDenominator: no root (or fractional exponent) in a denominator. */
function isRationalizedForm(node: ExprNode): boolean {
  return !someNode(node, (n) => {
    if (n.kind === "binary" && n.op === "/") return someNode(n.right, isRadicalNode);
    if (n.kind === "binary" && n.op === "^") {
      const exponent = constantValue(n.right);
      const negative = n.right.kind === "unary" || (!!exponent && cxIsReal(exponent) && exponent.re < 0);
      if (!negative) return false;
      // x^(−1/2), and a radical to any negative power ((√2)^−1 is 1/√2).
      return (
        (!!exponent && nearInteger(exponent.re) === null) || someNode(n.left, isRadicalNode)
      );
    }
    return false;
  });
}

function hasPerfectPowerFactor(n: number, index: number): boolean {
  for (let factor = 2; Math.pow(factor, index) <= n; factor++) {
    if (n % Math.pow(factor, index) === 0) return true;
  }
  return false;
}

/** Is a variable-free radicand made only of numbers and arithmetic? */
function isRationalArithmetic(node: ExprNode): boolean {
  return !someNode(node, (n) => n.kind === "constant" || n.kind === "root" || n.kind === "call");
}

function radicandSimplified(radicand: ExprNode, index: number): boolean {
  if (!containsVariable(radicand)) {
    if (!isRationalArithmetic(radicand)) return true;
    const value = constantValue(radicand);
    if (!value || !cxIsReal(value)) return true;
    if (value.re < 0 && index % 2 === 0) return false; // write it with i
    const n = nearInteger(Math.abs(value.re));
    if (n === null) return false; // a fraction under the radical
    return n >= 2 && Number.isSafeInteger(n) && !hasPerfectPowerFactor(n, index);
  }
  // A monomial radicand: coefficient free of perfect powers, every variable
  // exponent below the index (√(x³) is not simplified; x√x is).
  const powers = new Map<string, number>();
  let coefficient = 1;
  let monomial = true;
  const visit = (n: ExprNode, sign: number): void => {
    if (!monomial) return;
    if (n.kind === "number") {
      coefficient *= sign > 0 ? n.value : 1 / n.value;
    } else if (n.kind === "variable") {
      powers.set(n.name, (powers.get(n.name) ?? 0) + sign);
    } else if (n.kind === "binary" && n.op === "*") {
      visit(n.left, sign);
      visit(n.right, sign);
    } else if (n.kind === "binary" && n.op === "/") {
      visit(n.left, sign);
      visit(n.right, -sign);
    } else if (n.kind === "binary" && n.op === "^" && n.left.kind === "variable") {
      const exponent = constantValue(n.right);
      const k = exponent && cxIsReal(exponent) ? nearInteger(exponent.re) : null;
      if (k === null) monomial = false;
      else powers.set(n.left.name, (powers.get(n.left.name) ?? 0) + sign * k);
    } else {
      monomial = false;
    }
  };
  visit(radicand, 1);
  if (!monomial) return true;
  for (const k of powers.values()) {
    if (k < 0 || k >= index) return false;
  }
  if (Math.abs(coefficient - 1) < 1e-12) return true;
  const n = nearInteger(Math.abs(coefficient));
  return n !== null && !hasPerfectPowerFactor(n, index);
}

/** simplifiedRadical: every radicand free of perfect powers (and of fractions),
 *  no root in a denominator, no rational exponents, and no two roots of the
 *  same index multiplied in one term (√2·√3 should be √6). */
function isSimplifiedRadicalForm(node: ExprNode): boolean {
  if (!isRationalizedForm(node)) return false;
  // No fraction inside a denominator (√2/(2/3) is 3√2/2 unfinished).
  if (someNode(node, (n) => n.kind === "binary" && n.op === "/" && someNode(n.right, (m) => m.kind === "binary" && m.op === "/"))) {
    return false;
  }
  if (hasUndoneNumericArithmetic(node)) return false;
  if (someNode(node, hasFractionalExponent)) return false;
  let ok = true;
  walkNodes(node, (n) => {
    if (n.kind === "root" && !radicandSimplified(n.radicand, n.index)) ok = false;
  });
  if (!ok) return false;
  for (const term of sumTerms(node)) {
    const byIndex = new Map<number, number>();
    for (const f of productFactors(term)) {
      if (f.node.kind === "root") {
        byIndex.set(f.node.index, (byIndex.get(f.node.index) ?? 0) + f.mult);
      }
    }
    for (const count of byIndex.values()) if (count > 1) return false;
  }
  // No product left to multiply out: two bracketed sums ((3+√5)(2−√5),
  // (1+√2)²), or a bracketed sum holding a radical times another radical
  // (√2(1+√3)). A sum over a whole number ((1+√5)/2) or a number times a sum
  // is a finished form and passes.
  let unexpanded = false;
  walkNodes(node, (n) => {
    if (unexpanded || !(n.kind === "binary" && (n.op === "*" || n.op === "^"))) return;
    const factors = productFactors(n);
    const sums = factors.filter((f) => isSum(f.node));
    const sumCount = sums.reduce((total, f) => total + f.mult, 0);
    const radicalSum = sums.some((f) => someNode(f.node, isRadicalNode));
    const otherRadical = factors.some((f) => !isSum(f.node) && someNode(f.node, isRadicalNode));
    if ((sumCount >= 2 && sums.some((f) => someNode(f.node, isRadicalNode))) || (radicalSum && otherRadical)) {
      unexpanded = true;
    }
  });
  if (unexpanded) return false;
  // Like radical terms combined: within every sum, no two terms carry the same
  // radical part (5√2+2√2 → 7√2; 3+4 → 7). Different radicals (2√3+√5) and a
  // whole number beside a radical (9+7√2) are finished.
  let uncombined = false;
  walkNodes(node, (n) => {
    if (uncombined || !isSum(n)) return;
    const seen = new Set<string>();
    for (const term of sumTerms(n)) {
      const signature = monomialSignature(term);
      if (signature === null) continue;
      if (seen.has(signature)) uncombined = true;
      seen.add(signature);
    }
  });
  // (Coefficients in lowest terms and combined: `hasUndoneNumericArithmetic`.)
  return !uncombined;
}

/** singleLog: the whole answer is one log/ln call, nothing added or multiplied. */
function isSingleLogForm(node: ExprNode): boolean {
  if (!isLogCall(node) || node.kind !== "call") return false;
  return !someNode(node.arg, isLogCall) && !(node.base && someNode(node.base, isLogCall));
}

/** expandedLog: every log argument is a bare number, variable or constant —
 *  no product, quotient, power, root or sum inside (log 8 need not become
 *  3 log 2). */
function isExpandedLogForm(node: ExprNode): boolean {
  return !someNode(node, (n) => {
    if (n.kind !== "call" || !isLogCall(n)) return false;
    const arg = n.arg;
    return !(arg.kind === "number" || arg.kind === "variable" || arg.kind === "constant");
  });
}

/** positiveExponents: no negative (or negated) exponent anywhere. */
function isPositiveExponentForm(node: ExprNode): boolean {
  return !someNode(node, (n) => {
    if (n.kind !== "binary" || n.op !== "^") return false;
    if (n.right.kind === "unary") return true;
    const exponent = constantValue(n.right);
    return !!exponent && cxIsReal(exponent) && exponent.re < 0;
  });
}

// Univariate polynomial helpers for singleFraction's lowest-terms check.
type Poly = number[]; // coefficients, constant term first

function polyTrim(p: Poly): Poly {
  const scale = Math.max(1, ...p.map(Math.abs));
  const out = [...p];
  while (out.length > 1 && Math.abs(out[out.length - 1]) <= 1e-9 * scale) out.pop();
  return out;
}

function polyAdd(a: Poly, b: Poly, sign = 1): Poly {
  const out = new Array(Math.max(a.length, b.length)).fill(0);
  a.forEach((c, i) => (out[i] += c));
  b.forEach((c, i) => (out[i] += sign * c));
  return polyTrim(out);
}

function polyMul(a: Poly, b: Poly): Poly {
  const out = new Array(a.length + b.length - 1).fill(0);
  a.forEach((x, i) => b.forEach((y, j) => (out[i + j] += x * y)));
  return polyTrim(out);
}

function toPoly(node: ExprNode, variable: string): Poly | null {
  switch (node.kind) {
    case "number":
      return [node.value];
    case "variable":
      return node.name === variable ? [0, 1] : null;
    case "constant":
    case "root":
    case "call":
      return null;
    case "unary": {
      const inner = toPoly(node.value, variable);
      return inner ? inner.map((c) => -c) : null;
    }
    case "binary": {
      const l = toPoly(node.left, variable);
      if (!l) return null;
      if (node.op === "^") {
        const k = node.right.kind === "number" ? nearInteger(node.right.value) : null;
        if (k === null || k < 0 || k > 24) return null;
        let out: Poly = [1];
        for (let n = 0; n < k; n++) out = polyMul(out, l);
        return out;
      }
      const r = toPoly(node.right, variable);
      if (!r) return null;
      if (node.op === "+") return polyAdd(l, r);
      if (node.op === "-") return polyAdd(l, r, -1);
      if (node.op === "*") return polyMul(l, r);
      // "/" — only by a nonzero constant keeps it a polynomial
      if (r.length !== 1 || Math.abs(r[0]) < 1e-12) return null;
      return l.map((c) => c / r[0]);
    }
  }
}

function polyDegree(p: Poly): number {
  const t = polyTrim(p);
  return t.length === 1 && Math.abs(t[0]) < 1e-12 ? -1 : t.length - 1;
}

/** Scale to a max-magnitude coefficient of 1, so Euclid's tolerances are relative. */
function polyNormalize(p: Poly): Poly {
  const scale = Math.max(...p.map(Math.abs));
  return scale > 0 ? p.map((c) => c / scale) : p;
}

function polyMod(x: Poly, y: Poly): Poly {
  let r = [...x];
  const dy = polyDegree(y);
  while (polyDegree(r) >= dy) {
    const dr = polyDegree(r);
    const factor = r[dr] / y[dy];
    for (let i = 0; i <= dy; i++) r[dr - dy + i] -= factor * y[i];
    r[dr] = 0;
    r = polyTrim(r.map((c) => (Math.abs(c) <= 1e-9 ? 0 : c)));
    if (polyDegree(r) < 0) break;
  }
  return r;
}

function polyGcdDegree(a: Poly, b: Poly): number {
  let x = polyNormalize(polyTrim(a));
  let y = polyNormalize(polyTrim(b));
  for (let guard = 0; polyDegree(y) >= 0 && guard < 64; guard++) {
    const r = polyMod(x, y);
    x = y;
    y = polyDegree(r) >= 0 ? polyNormalize(r) : r;
  }
  return polyDegree(x);
}

function integerContent(p: Poly): number | null {
  let g = 0;
  for (const c of p) {
    const n = nearInteger(c);
    if (n === null) return null;
    g = gcd(g, n);
  }
  return g;
}

/** Is num/den in lowest terms? Only decided for one variable (or none) with
 *  rational coefficients; anything richer passes. */
function fractionInLowestTerms(num: ExprNode, den: ExprNode): boolean {
  const vars = new Set<string>();
  walkNodes(num, (n) => n.kind === "variable" && vars.add(n.name));
  walkNodes(den, (n) => n.kind === "variable" && vars.add(n.name));
  if (vars.size > 1) return true;
  const variable = [...vars][0] ?? "x";
  const p = toPoly(num, variable);
  const q = toPoly(den, variable);
  if (!p || !q) return true;
  const cp = integerContent(p);
  const cq = integerContent(q);
  if (cp !== null && cq !== null && gcd(cp, cq) > 1) return false;
  return polyDegree(p) < 1 || polyDegree(q) < 1 || polyGcdDegree(p, q) < 1;
}

function hasVariableDenominator(node: ExprNode): boolean {
  return someNode(
    node,
    (n) =>
      (n.kind === "binary" && n.op === "/" && containsVariable(n.right)) ||
      (n.kind === "binary" &&
        n.op === "^" &&
        containsVariable(n.left) &&
        (n.right.kind === "unary" ||
          (() => {
            const e = constantValue(n.right);
            return !!e && cxIsReal(e) && e.re < 0;
          })())),
  );
}

/** singleFraction: one fraction (or a polynomial) — no sum of fractions, no
 *  fraction inside a fraction — with numerator and denominator in lowest terms. */
function isSingleFractionForm(node: ExprNode): boolean {
  const isQuotient = (n: ExprNode) => n.kind === "binary" && n.op === "/";
  const top = stripSign(node);
  if (top.kind === "binary" && top.op === "/") {
    // No fraction inside the fraction, numeric or symbolic.
    if (someNode(top.left, isQuotient) || someNode(top.right, isQuotient)) return false;
    if (hasVariableDenominator(top.left) || hasVariableDenominator(top.right)) return false;
    return fractionInLowestTerms(top.left, top.right);
  }
  // Not a quotient: a polynomial passes, but any fraction in it means it is a
  // sum of fractions (1/2+1/3, x/2+1/3) — not yet one fraction.
  return !someNode(top, isQuotient) && !hasVariableDenominator(top);
}

const NUDGE_FORM_CHECKERS: Record<NudgeAnswerForm, (node: ExprNode) => boolean> = {
  simplifiedRadical: isSimplifiedRadicalForm,
  factored: isFactoredForm,
  expanded: isExpandedForm,
  complexStandard: isComplexStandardForm,
  rationalizedDenominator: isRationalizedForm,
  singleLog: isSingleLogForm,
  expandedLog: isExpandedLogForm,
  singleFraction: isSingleFractionForm,
  positiveExponents: isPositiveExponentForm,
  radicalForm: (node) => !someNode(node, hasFractionalExponent),
  exponentForm: (node) => !someNode(node, (n) => n.kind === "root"),
  fraction: (node) => !someNode(node, (n) => n.kind === "number" && !Number.isInteger(n.value)),
};


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
  if (a.type === "solutionSet" || b.type === "solutionSet") {
    // A lone value on the other side is a one-member set, so a stored "3"
    // still matches a learner's "x = 3".
    const ma = solutionMembersOf(a);
    const mb = solutionMembersOf(b);
    return ma !== null && mb !== null && solutionSetsEqual(ma, mb);
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
    if (!s.includes(",")) return s;
    // A thousands separator ("1,395", "-12,000.5"): groups of exactly three
    // after a first group of one to three digits that doesn't start with 0.
    // "1,39", "13,95" and the decimal comma "0,330" stay unparseable.
    return /^[+-]?[1-9]\d{0,2}(?:,\d{3})+(?:\.\d*)?$/.test(s) ? s.replace(/,/g, "") : null;
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
  s = s.replace(LEADING_ASSIGNMENT, "");

  if (type === "solutionSet") {
    const members = parseSolutionSet(s);
    return {
      answer: members === null ? null : { type: "solutionSet", members },
      unit: null,
      unitRaw: null,
    };
  }

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
      // dodged the representation. A DECIMAL stays unparseable here: "0.75"
      // may equal 3/4 in value but does not demonstrate the representation the
      // item requested. The graders read it separately (`decimalAsFraction`)
      // to offer the "now write it as a fraction" nudge instead of a flat miss.
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

/**
 * A representation an item requires on top of the value. Value-equivalence
 * alone lets "Simplify 72/80" be answered by typing 72/80 back, and "Write
 * 82/100 as a decimal" by typing 82/100 — the item's whole skill is the
 * representation, so the grader must check it. Applied only after the value
 * matches; the value check stays `answersEqual`.
 *
 * Two families, graded differently (see `isNudgeForm`):
 *   • the LEGACY numeric forms (`lowestTerms`, `decimalNotation`) — a
 *     right-value, wrong-form answer is a miss that names the form
 *     (`GradeResult.formOutcome`), exactly as before;
 *   • the algebraic forms (everything else) — a right-value, wrong-form answer
 *     is NOT a miss: the grader returns a no-penalty nudge ("now write it in
 *     factored form"), up to `FORM_NUDGE_CAP` times per item.
 */
export type AnswerForm = LegacyAnswerForm | NudgeAnswerForm;

type LegacyAnswerForm = "lowestTerms" | "decimalNotation";

export type NudgeAnswerForm =
  | "simplifiedRadical"
  | "factored"
  | "expanded"
  | "complexStandard"
  | "rationalizedDenominator"
  | "singleLog"
  | "expandedLog"
  | "singleFraction"
  | "positiveExponents"
  | "radicalForm"
  | "exponentForm"
  /** IMPLICIT on every `fraction`-typed item — never declared by a template
   *  and never served as `answerForm` (so no form hint appears under existing
   *  fraction items). A terminating decimal equal to the answer ("0.25" for
   *  1/4) earns this nudge instead of a flat miss; see `decimalAsFraction`. */
  | "fraction";

/** How many "right value, not yet in the form asked" nudges one item gives
 *  before the next submission is graded normally. */
export const FORM_NUDGE_CAP = 2;

/** True for the algebraic forms whose miss is a no-penalty nudge (not the two
 *  legacy numeric forms, which stay ordinary misses). */
export function isNudgeForm(form: AnswerForm): form is NudgeAnswerForm {
  return form !== "lowestTerms" && form !== "decimalNotation";
}

const FORM_NUDGES: Record<NudgeAnswerForm, string> = {
  simplifiedRadical: "That's equal to the answer. Now simplify the radical as far as it goes.",
  factored: "That's equal to the answer. Now write it in factored form.",
  expanded: "That's equal to the answer. Now multiply it out and combine like terms.",
  complexStandard: "That's equal to the answer. Now write it in the form a + bi.",
  rationalizedDenominator: "That's equal to the answer. Now clear the root out of the denominator.",
  singleLog: "That's equal to the answer. Now write it as a single log.",
  expandedLog: "That's equal to the answer. Now expand it so each log holds one number or letter.",
  singleFraction: "That's equal to the answer. Now write it as one fraction in lowest terms.",
  positiveExponents: "That's equal to the answer. Now write it with only positive exponents.",
  radicalForm: "That's equal to the answer. Now write it with a root sign.",
  exponentForm: "That's equal to the answer. Now write it with a fractional exponent.",
  fraction: "That's the right value. Now write it as a fraction.",
};

/** The scholar-facing sentence for a form nudge. */
export function formNudgeMessage(form: NudgeAnswerForm): string {
  return FORM_NUDGES[form];
}

function stripAssignment(raw: string): string {
  return raw.trim().replace(LEADING_ASSIGNMENT, "");
}

/** Does one expression string meet an algebraic form? Unparseable text passes:
 *  the value check already decided it, and only a parsed shape can be judged. */
function expressionMeetsForm(raw: string, form: NudgeAnswerForm): boolean {
  const parsed = parseExpression(stripAssignment(raw));
  if (parsed === null) return true;
  // An answer padded with a do-nothing piece is not in any form: "+0x" can add
  // a variable that switches a checker's scope, "+0" makes a sum out of a
  // single term, and "y^0" smuggles in a variable that equals 1. (A factor of
  // 1 or an exponent of 1 is left to each checker: "(1)·i", "e^1" are honest.)
  // a + bi may honestly carry a zero part ("1+0i", "0+2i"); a zero term with
  // a variable ("+0x") is padding in every form.
  if (hasTrivialPadding(parsed.ast, form === "complexStandard")) return false;
  return NUDGE_FORM_CHECKERS[form](parsed.ast);
}

/** Does the expression carry a do-nothing piece — a zero term in a sum (0,
 *  0x, 0·√2) or an exponent of 0? With `allowConstantZero`, only a zero term
 *  that contains a variable counts. */
function hasTrivialPadding(node: ExprNode, allowConstantZero = false): boolean {
  const isLiteral = (n: ExprNode, v: number) => n.kind === "number" && n.value === v;
  return someNode(node, (n) => {
    if (isSum(n)) {
      return sumTerms(n).some(
        (term) =>
          (productFactors(term).some((f) => isLiteral(f.node, 0)) || isLiteral(term, 0)) &&
          (!allowConstantZero || containsVariable(term)),
      );
    }
    return n.kind === "binary" && n.op === "^" && isLiteral(n.right, 0);
  });
}

/**
 * A raw answer written as a terminating decimal ("0.25", "-2.5", ".5"), read
 * EXACTLY as a fraction (digit by digit, never through floating point), or
 * null when it isn't one. `parseAnswer(raw, "fraction")` still refuses a
 * decimal; the graders use this to tell "right value, written as a decimal"
 * (the implicit `fraction` nudge) from a wrong answer.
 */
export function decimalAsFraction(raw: string): TypedAnswer | null {
  const normalized = normalizeNumericInput(splitUnitSuffix(stripAssignment(raw)).value);
  const decimal = normalized?.match(/^([+-]?)(\d*)\.(\d*)$/);
  if (!decimal || !(decimal[2] || decimal[3]) || decimal[2].length + decimal[3].length > 15) {
    return null;
  }
  const sign = decimal[1] === "-" ? -1 : 1;
  const r = reduceFraction(
    sign * Number(`${decimal[2]}${decimal[3]}` || "0"),
    Math.pow(10, decimal[3].length),
  );
  return { type: "fraction", num: r.num, den: r.den };
}

/**
 * Does the learner's raw answer use the representation `form` requires? For a
 * `solutionSet` item pass `answerType: "solutionSet"` and every member must
 * meet the form ("1 ± 2i" is two members, each checked for a + bi).
 */
export function satisfiesAnswerForm(
  raw: string,
  form: AnswerForm,
  answerType?: AnswerType,
): boolean {
  if (isNudgeForm(form)) {
    if (answerType === "solutionSet") {
      const members = parseSolutionSet(stripAssignment(raw));
      return members === null || members.every((m) => expressionMeetsForm(m, form));
    }
    return expressionMeetsForm(raw, form);
  }
  const s = stripAssignment(raw);
  const normalized = normalizeNumericInput(splitUnitSuffix(s).value);
  if (normalized === null) return false;
  const fraction = parseFractionParts(normalized);
  switch (form) {
    case "lowestTerms":
      return fraction === null || gcd(fraction.num, fraction.den) === 1;
    case "decimalNotation":
      return fraction === null;
  }
}

/**
 * The form check a grader applies once the VALUE has matched: does the
 * learner's answer meet `form`? `expectedRaw` is the item's own canonical
 * answer — an algebraic form the canonical itself does not meet (an authoring
 * slip, or a checker too strict for that shape) is not enforced, so the
 * scholar can never be held to a form the answer key fails. The legacy forms
 * keep their exact prior rule.
 */
export function meetsRequiredForm(
  learnerRaw: string,
  expectedRaw: string,
  form: AnswerForm,
  answerType?: AnswerType,
): boolean {
  if (!isNudgeForm(form)) return satisfiesAnswerForm(learnerRaw, form);
  if (!satisfiesAnswerForm(expectedRaw, form, answerType)) return true;
  return satisfiesAnswerForm(learnerRaw, form, answerType);
}

/**
 * The teach-as-action blank's check: the value AND, when the item requires
 * one, the representation. The blank's expected value is the item's own
 * answer, so it must apply the same `answerForm` the real grader does —
 * otherwise "Write 12/15 in simplest form: ?" would accept 12/15 here while
 * the item itself rejects it. Intermediate rungs (`shared/hintLadder.ts`)
 * produce intermediate values and stay value-only.
 */
export function teachingBlankCorrect(
  learnerRaw: string,
  expectedRaw: string,
  type: AnswerType,
  form?: AnswerForm | null,
): boolean {
  return (
    rawAnswersEqual(learnerRaw, expectedRaw, type) &&
    (!form || meetsRequiredForm(learnerRaw, expectedRaw, form, type))
  );
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
    case "solutionSet":
      return a.members.length > 0 ? a.members.join(", ") : "none";
  }
}

/**
 * Scholar-facing form of a typed answer. Multiple-choice answers must show the
 * option label, never the raw zero-based index ("choice 0").
 */
export function formatAnswerForDisplay(a: TypedAnswer, choices?: readonly string[] | null): string {
  if (a.type === "solutionSet" && a.members.length === 0) return "No solution";
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

/** An expression answer, stored as the author wrote it (that string is also
 *  what a reveal shows, so write it the way a scholar should: "(x-2)(x+3)"). */
export const exprAns = (canonical: string): TypedAnswer => ({
  type: "expression",
  canonical: canonical.trim(),
});

/** A solution-set answer. Members may be numbers or expression strings;
 *  exact duplicates are dropped. `solutionSetAns([])` is "no solution". */
export const solutionSetAns = (members: readonly (string | number)[]): TypedAnswer => ({
  type: "solutionSet",
  members: [...new Set(members.map((m) => String(m).trim()))],
});
