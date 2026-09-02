/**
 * fractions — a tiny, dependency-free parser that turns Rabbithole's plain-ASCII
 * fraction strings ("3/4", "9 4/9", "?/9") DIRECTLY into renderable nodes for the
 * stacked-fraction renderer (`FractionText`, web + native). `parsePracticeText`
 * adds the deliberately narrow static-radical fragments the same leaf sends to
 * KaTeX / SwiftMath; `parseFractions` stays fraction-only for SVG labels.
 *
 * WHY no LaTeX intermediary: the math we render is elementary and its source is
 * always simple ASCII. Practice stems are generated as "a/b", "w n/d", "?/d" (see
 * convex/lib/practice/templates.ts) and the tutor writes fractions the same way
 * in chat prose. There is nothing to gain from a LaTeX interchange layer for
 * "3/5" — we parse the ASCII straight to numerator / denominator / blank and
 * stack it. (Rich LaTeX — arbitrary expressions, a real math engine, a SwiftUI
 * math view — is deferred to a possible Phase 2; see
 * review/fraction-rendering-plan.html.)
 *
 * Pedagogy: elementary learners read a *stacked* fraction with a horizontal bar
 * (vinculum) far more reliably than a diagonal slash, so we always stack.
 *
 * Framework-free + deterministic: unit-tests with zero deps and vendors cleanly
 * into the native app (native/vendor/shared) like practiceLoop.ts.
 */

import { hasStaticRadical, scanStaticRadicals, type StaticRadicalSegment } from "./staticRadicals";

// ─── Nodes (what the renderer consumes) ──────────────────────────────────────

export type FractionNode =
  /** A run of ordinary text (words, whole numbers, operators, "="). */
  | { type: "text"; value: string }
  /** A stacked fraction: numerator over a vinculum over denominator. */
  | { type: "frac"; num: FracPart; den: FracPart }
  /** A fill-in blank written inline as a run of underscores ("___"), e.g. the
   *  missing addend in "754 = ___ + 50 + 4". The renderer draws it as a box. */
  | { type: "blank" };

/** A numerator or denominator: a run of digits, or a fill-in blank ("?"). */
export type FracPart = { blank: true } | { blank: false; value: string };

/** A static radical parsed from ordinary practice prose. Only `√<integer>` and
 * `a√b` are admitted; the leaf renderer sends its LaTeX to the static math
 * engine rather than the editable SVG radical. */
export type StaticRadicalNode = Extract<StaticRadicalSegment, { type: "radical" }>;

/** Every static-practice token `FractionText` can render. This separate name
 * keeps `FractionNode` honest for existing fraction-only consumers such as SVG
 * figure labels. */
export type PracticeTextNode = FractionNode | StaticRadicalNode;

// ─── The one regex ───────────────────────────────────────────────────────────
// A fraction is `num/den` where each side is digits or a "?" fill-in, optionally
// preceded by a whole number to form a mixed number ("9 4/9"). The guards keep it
// conservative so it never mangles prose:
//   • lookbehind (?<![\w.\/]) — not preceded by a word char, a dot, or a slash,
//     so "1.2/3", "a/b", and "http://x" are left alone.
//   • lookahead  (?![\w\/]|\.\d) — not followed by a word char, a slash, or a
//     REAL decimal ("/4.5"); a sentence-ending "." is fine ("... 3/4.").
// Whole + fraction share ONE match so "9 4/9" is a single mixed number, and the
// whole ("9") never re-matches as its own thing.
const FRACTION = /(?<![\w.\/])(?:(\d+)[ \t]+)?(\d+|\?)\s*\/\s*(\d+|\?)(?![\w\/]|\.\d)/g;

// A fill-in blank, written as a run of underscores ("___") — the convention the
// practice generators use for an in-equation missing value ("754 = ___ + 50 + 4",
// "9 + 0 = ___"). Two-or-more so a single stray "_" (a subscript, an emphasis
// marker) is left as literal text. Fraction tokens are digits / "?", so a blank
// run never overlaps a fraction match — blanks are split out of the text runs
// *between* fractions.
const BLANK = /_{2,}/g;

function part(token: string): FracPart {
  return token === "?" ? { blank: true } : { blank: false, value: token };
}

/** Push a plain-text run onto `nodes`, splitting any underscore-run blanks
 *  ("___") out into their own `blank` nodes so the renderer boxes them. A run
 *  with no blank becomes a single text node; an empty run pushes nothing. */
function pushText(nodes: FractionNode[], text: string): void {
  if (!text) return;
  let last = 0;
  let m: RegExpExecArray | null;
  BLANK.lastIndex = 0;
  while ((m = BLANK.exec(text))) {
    if (m.index > last) nodes.push({ type: "text", value: text.slice(last, m.index) });
    nodes.push({ type: "blank" });
    last = m.index + m[0].length;
  }
  if (last < text.length) nodes.push({ type: "text", value: text.slice(last) });
}

// ─── Prose scanning (text ⇄ fraction segments) ───────────────────────────────

export type FractionSegment =
  | { type: "text"; value: string }
  /** `value` is the raw matched substring ("9 4/9", "?/9") — hand it straight to
   *  <FractionText value=…> to render an inline stacked fraction. */
  | { type: "frac"; value: string };

/**
 * Split a string into ordinary-text runs and fraction runs. Used to render
 * fractions INLINE inside the tutor's prose. Never throws; a string with no
 * fraction comes back as a single text segment.
 */
export function scanFractions(input: string): FractionSegment[] {
  const out: FractionSegment[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  FRACTION.lastIndex = 0;
  while ((m = FRACTION.exec(input))) {
    if (m.index > last) out.push({ type: "text", value: input.slice(last, m.index) });
    out.push({ type: "frac", value: m[0] });
    last = m.index + m[0].length;
  }
  if (last < input.length) out.push({ type: "text", value: input.slice(last) });
  return out;
}

/** True if a string contains at least one renderable fraction — lets a call site
 *  decide whether to route a short label (a stem, a choice) or a prose line
 *  through the stacked renderer or leave it as plain text. */
export function hasFraction(input: string): boolean {
  FRACTION.lastIndex = 0;
  return FRACTION.test(input);
}

// ─── Render nodes (for a fraction-bearing string) ────────────────────────────

/**
 * Parse a string into render nodes for `FractionText`. A mixed number ("9 4/9")
 * becomes a whole-number text node followed by a stacked-fraction node, so the
 * whole part sits full-size beside the stack (the standard "9¾" layout).
 */
export function parseFractions(input: string): FractionNode[] {
  const nodes: FractionNode[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  FRACTION.lastIndex = 0;
  while ((m = FRACTION.exec(input))) {
    if (m.index > last) pushText(nodes, input.slice(last, m.index));
    const whole = m[1];
    if (whole) nodes.push({ type: "text", value: whole });
    nodes.push({ type: "frac", num: part(m[2]), den: part(m[3]) });
    last = m.index + m[0].length;
  }

  if (last < input.length) pushText(nodes, input.slice(last));
  return nodes;
}

/**
 * Parse the structured static-practice vocabulary at the canonical text leaf.
 * Fractions/blanks retain the exact historical parser; only ordinary text runs
 * are additionally scanned for the intentionally narrow radical notation.
 */
export function parsePracticeText(input: string): PracticeTextNode[] {
  // Preserve the established fraction/blank node sequence exactly for the
  // overwhelmingly common non-radical path.
  if (!hasStaticRadical(input)) return parseFractions(input);
  const out: PracticeTextNode[] = [];
  for (const node of parseFractions(input)) {
    if (node.type !== "text") {
      out.push(node);
      continue;
    }
    for (const segment of scanStaticRadicals(node.value)) {
      if (segment.type === "text") {
        if (segment.value) out.push(segment);
      } else {
        out.push(segment);
      }
    }
  }
  return out;
}

/** True when a label needs the shared static-practice renderer, not only the
 * historical stacked-fraction renderer. */
export function hasPracticeMath(input: string): boolean {
  return hasFraction(input) || hasStaticRadical(input);
}

// ─── Spoken form (accessibility) ─────────────────────────────────────────────
// A stacked fraction read verbatim by a screen reader is "3 slash 4"; the parsed
// form lets us say "3 over 4" ("9 and 4 over 9" for a mixed number, "blank" for a
// fill-in). Used as the aria-label / accessibilityLabel of FractionText.

function speakPart(p: FracPart): string {
  return p.blank ? "blank" : p.value;
}

/** A screen-reader-friendly reading of a fraction string. */
export function fractionsToSpeech(input: string): string {
  const nodes = parsePracticeText(input);
  const parts: string[] = [];
  for (const n of nodes) {
    if (n.type === "text") {
      parts.push(n.value);
      continue;
    }
    if (n.type === "blank") {
      parts.push(" blank ");
      continue;
    }
    if (n.type === "radical") {
      parts.push(` ${n.speech}${n.trailingPunctuation ?? ""} `);
      continue;
    }
    // Mixed number ("9 4/9") reads "9 and 4 over 9": insert "and" when the
    // preceding run ends in a digit (a whole part sits right before it).
    const prev = parts.length ? parts[parts.length - 1] : "";
    if (/\d\s*$/.test(prev)) parts.push(" and ");
    parts.push(` ${speakPart(n.num)} over ${speakPart(n.den)} `);
  }
  return parts.join("").replace(/\s+/g, " ").trim();
}
