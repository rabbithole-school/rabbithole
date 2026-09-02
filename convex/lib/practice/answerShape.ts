/**
 * 2-D expression-editor signals — derived server-side from an item's canonical
 * answer, NON-LEAKY by construction.
 *
 * The native practice surface has a direct-manipulation box editor for genuine
 * fraction / power / root answers (`native/src/components/practice/ExpressionEditor`).
 * Two signals ride on `ServedItem` to drive it:
 *
 *   • `answerShape: "twoD"` — this expression answer is BUILDABLE in the box
 *     editor (fractions, powers, and numeric/variable leaves — no `+ − ×`, no
 *     remainder, no leading minus, since the pad has no keys for those). Every
 *     OTHER expression answer (whole-number division's "7 R 1" remainder form, a
 *     sum, …) is left untagged so it routes to the ordinary keypad, which has
 *     the keys it needs.
 *
 *   • `answerFormat` — the L1 scaffold: a skeleton with the numbers blanked to
 *     boxes (`5/6` → `F(_/_)`, complex `(2/3)/4` → `F(F(_/_)/_)`). It gives away
 *     the SHAPE, never the digits. Provided only for an all-fraction answer, and
 *     `serveItems` further gates it on fluency — kept while the skill isn't yet
 *     access-proven (format given), dropped once it is (the scholar builds the
 *     shape unaided). Powers get a working L3 editor but no L1 skeleton (the
 *     client seed grammar is fractions-only).
 *
 * Pure + deterministic; no answer text ever crosses to the client.
 */

import type { AnswerType, TypedAnswer } from "./answers";

export type ExpressionAnswerSignals = {
  answerShape?: "twoD";
  answerFormat?: string;
};

type Shape =
  | { t: "num" }
  | { t: "var" }
  | { t: "neg"; v: Shape }
  | { t: "frac"; n: Shape; d: Shape }
  | { t: "pow"; b: Shape; e: Shape }
  | { t: "root"; r: Shape }
  | { t: "other" }; // +, −, × — not constructible in the box editor

/**
 * Parse a canonical expression into a shape tree, mirroring the grammar +
 * precedence of `answers.ts`'s grader (addSub < mulDiv < power < unary <
 * primary) so this classification never disagrees with what the grader accepts.
 * Returns null if the whole string isn't consumed (e.g. the "7r1" remainder
 * form — `r` is neither operator nor a clean trailing token).
 */
function parseShape(raw: string): Shape | null {
  const s = raw.trim().toLowerCase().replace(/\s+/g, "").replace(/\*\*/g, "^");
  // Roots have a deliberately narrow, canonical form: an optional whole-number
  // coefficient and a numeric radicand with an implicit square, cube, or
  // bracketed integer index. That maps exactly to the editor's
  // `tokens… + root{index,radicand}` shape.
  if (/^\d*(?:√(?:\[(?:[2-9]\d*|1\d+)\])?|∛)\d+$/.test(s)) {
    return { t: "root", r: { t: "num" } };
  }
  let pos = 0;
  const peek = () => s[pos] ?? "";

  function parsePrimary(): Shape | null {
    if (peek() === "(") {
      pos++;
      const inner = parseAddSub();
      if (peek() !== ")") return null;
      pos++;
      return inner;
    }
    const num = /^[0-9]+(\.[0-9]+)?/.exec(s.slice(pos));
    if (num) {
      pos += num[0].length;
      return { t: "num" };
    }
    if (/^[a-z]/.test(peek())) {
      pos++;
      return { t: "var" };
    }
    return null;
  }

  function parseUnary(): Shape | null {
    if (peek() === "-") {
      pos++;
      const v = parseUnary();
      return v ? { t: "neg", v } : null;
    }
    if (peek() === "+") {
      pos++;
      return parseUnary();
    }
    return parsePrimary();
  }

  function parsePower(): Shape | null {
    const base = parseUnary();
    if (!base) return null;
    if (peek() === "^") {
      pos++;
      const e = parsePower(); // right-associative
      return e ? { t: "pow", b: base, e } : null;
    }
    return base;
  }

  function parseMulDiv(): Shape | null {
    let left = parsePower();
    if (!left) return null;
    while (peek() === "*" || peek() === "/") {
      const op = peek();
      pos++;
      const right = parsePower();
      if (!right) return null;
      left = op === "/" ? { t: "frac", n: left, d: right } : { t: "other" };
    }
    return left;
  }

  function parseAddSub(): Shape | null {
    let left = parseMulDiv();
    if (!left) return null;
    while (peek() === "+" || peek() === "-") {
      pos++;
      const right = parseMulDiv();
      if (!right) return null;
      left = { t: "other" };
    }
    return left;
  }

  const tree = parseAddSub();
  return tree && pos === s.length ? tree : null;
}

/** True when every leaf/branch can be entered in the box editor (no additive/
 *  multiplicative op, no leading minus — the pad has no key for those). */
function isBuildable(shape: Shape): boolean {
  switch (shape.t) {
    case "num":
    case "var":
      return true;
    case "frac":
      return isBuildable(shape.n) && isBuildable(shape.d);
    case "pow":
      return isBuildable(shape.b) && isBuildable(shape.e);
    case "root":
      return isBuildable(shape.r);
    case "neg":
    case "other":
      return false;
  }
}

/** The box editor is only worth using when there's real 2-D structure. */
function hasStructure(shape: Shape): boolean {
  switch (shape.t) {
    case "frac":
    case "pow":
    case "root":
      return true;
    default:
      return false;
  }
}

/** The non-leaky L1 skeleton, defined ONLY for an all-fraction answer with
 *  numeric leaves (the client's `seedFromSkeleton` grammar: `side := '_' |
 *  frac`). Any variable / power / negative leaf ⇒ null (no L1 scaffold). */
function fractionSkeleton(shape: Shape): string | null {
  if (shape.t === "num") return "_";
  if (shape.t === "frac") {
    const n = fractionSkeleton(shape.n);
    const d = fractionSkeleton(shape.d);
    return n && d ? `F(${n}/${d})` : null;
  }
  return null;
}

/**
 * The shared core: classify a canonical answer STRING (already rendered to the
 * grader's `n/d` / `a^b` grammar). Returns `{}` for a non-box answerType, an
 * expression the box editor can't build, or an unparseable canonical — all of
 * which correctly fall back to the plain pad.
 *
 * Two answerTypes route to the box editor:
 *   • "expression" — the general grammar (nested fractions, powers, complex
 *     fractions like `(2/3)/4`).
 *   • "fraction"   — the dedicated single-fraction answer that most real
 *     fraction word problems carry (canonical `2/3`). This is the common case;
 *     without it the box editor would almost never appear, since template +
 *     stored fraction items are typed "fraction", not "expression".
 */
function signalsFromCanonical(
  answerType: string,
  canonical: string,
): ExpressionAnswerSignals {
  if (answerType !== "expression" && answerType !== "fraction") return {};
  const tree = parseShape(canonical);
  if (!tree || !isBuildable(tree) || !hasStructure(tree)) return {};
  const signals: ExpressionAnswerSignals = { answerShape: "twoD" };
  if (tree.t === "frac") {
    const skeleton = fractionSkeleton(tree);
    if (skeleton) signals.answerFormat = skeleton;
  }
  return signals;
}

/**
 * Derive the 2-D editor signals from a template item's TYPED answer (the
 * `buildSession` path, where the generated item's `answer` is in scope).
 * Renders the typed answer to its canonical string, then classifies.
 */
export function expressionAnswerSignals(
  answerType: AnswerType | "manipulative" | "dialogue",
  answer: TypedAnswer,
): ExpressionAnswerSignals {
  let canonical: string | null = null;
  if (answerType === "expression" && answer.type === "expression") {
    canonical = answer.canonical;
  } else if (answerType === "fraction" && answer.type === "fraction") {
    // A dedicated fraction answer IS a single top-level fraction — exactly what
    // the box editor builds. Render its canonical, matching the grader's display
    // (#880: a whole-number fraction, den 1, reads as just the integer — no
    // fraction structure, so it routes to the plain pad like a stored "1").
    canonical =
      answer.den === 1 ? `${answer.num}` : `${answer.num}/${answer.den}`;
  }
  if (canonical === null) return {};
  return signalsFromCanonical(answerType, canonical);
}

/**
 * Derive the 2-D editor signals from a stored item's canonical answer STRING
 * (the `servedItemFromServable` path — a stored `practiceItems` row carries its
 * answer as `answerCanonical`, e.g. a fraction word problem's `2/3`). Same
 * non-leaky classification as the template path.
 */
export function expressionAnswerSignalsFromCanonical(
  answerType: string,
  canonical: string,
): ExpressionAnswerSignals {
  return signalsFromCanonical(answerType, canonical);
}
