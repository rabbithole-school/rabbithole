/**
 * mathLatex — a tiny, pure parser for the CONSTRAINED LaTeX subset Rabbithole's
 * math actually produces (fractions, mixed numbers, blanks, variables, K–5
 * operators). It is the shared "interchange" layer of the fraction-rendering
 * spike: ONE generated string drives every renderer —
 *
 *   • web:    KaTeX (remark-math + rehype-katex) consumes the LaTeX directly
 *   • iPad:   a SwiftUI LaTeX view (swiftui-math / LaTeXSwiftUI) consumes it
 *   • lite:   `MathText` (native + web) parses THIS module's output into a
 *             stacked-fraction layout — the dependency-free cross-platform
 *             fallback (Android / Expo Go / no-KaTeX), and the spike we can
 *             fully unit-test with no native toolchain.
 *
 * WHY a LaTeX subset (not raw ASCII "9 4/9"): we control problem generation, so
 * emitting `9\frac{4}{9}` is unambiguous and portable to real math engines,
 * whereas scanning ASCII `a/b` is fragile (dates, "24/7", ratios). `asciiToLatex`
 * is provided ONLY as a migration bridge for existing ASCII stems.
 *
 * Pedagogy: elementary learners read a *stacked* fraction with a horizontal bar
 * (vinculum) far more reliably than a diagonal slash — so the lite renderer
 * always stacks. See the spike writeup.
 *
 * Framework-free + deterministic so it unit-tests with zero deps and vendors
 * cleanly into the native app (native/vendor/shared) like practiceLoop.ts.
 */

// ─── AST ─────────────────────────────────────────────────────────────────────

export type MathNode =
  /** A run of ordinary text/atoms (numbers, variables, operators, words). */
  | { type: "text"; value: string }
  /** A stacked fraction. `num`/`den` are themselves node lists, so a numerator
   *  can be an expression, another fraction, or a blank. */
  | { type: "frac"; num: MathNode[]; den: MathNode[] }
  /** A missing value to fill in (`\square`, or a bare `?` inside a frac slot). */
  | { type: "blank" };

// ─── Operator prettification ───────────────────────────────────────────────
// Applied to text runs so `\times`/`\div`/etc. read as real math glyphs. Longer
// tokens first so `\leq` isn't shadowed by a shorter prefix.
// A trailing `\s?` swallows the single space LaTeX uses to terminate an
// alphabetic macro (`\div 2` → "÷2", not "÷ 2").
const OP_REPLACEMENTS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\\times\b\s?/g, "×"],
  [/\\div\b\s?/g, "÷"],
  [/\\cdot\b\s?/g, "·"],
  [/\\pm\b\s?/g, "±"],
  [/\\leq\b\s?/g, "≤"],
  [/\\geq\b\s?/g, "≥"],
  [/\\neq\b\s?/g, "≠"],
  [/\\ne\b\s?/g, "≠"],
  // A hyphen-minus flanked by math (digit/paren/space) → a true minus sign for
  // even glyph weight. Left alone inside words (e.g. "ten-thousands").
  [/(^|[\s(=<>+×÷·])-(?=[\s\d(]|$)/g, "$1−"],
];

function prettifyText(s: string): string {
  let out = s;
  for (const [re, rep] of OP_REPLACEMENTS) out = out.replace(re, rep);
  // Collapse LaTeX spacing macros to a single space.
  out = out.replace(/\\[,;:! ]/g, " ").replace(/~/g, " ");
  return out;
}

// ─── Brace matching ──────────────────────────────────────────────────────────
// Given `s` and an index at an opening "{", return the inner content and the
// index just past the matching "}". Returns null if unbalanced.
function readBraceGroup(s: string, open: number): { inner: string; next: number } | null {
  if (s[open] !== "{") return null;
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    const c = s[i];
    if (c === "\\") {
      i++; // skip the escaped char, so `\}` doesn't close the group
      continue;
    }
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return { inner: s.slice(open + 1, i), next: i + 1 };
    }
  }
  return null; // unbalanced
}

function skipSpaces(s: string, i: number): number {
  while (i < s.length && (s[i] === " " || s[i] === "\t")) i++;
  return i;
}

// A frac argument that is exactly a blank marker renders as a fill-in box.
function isBlankArg(raw: string): boolean {
  const t = raw.trim();
  return t === "?" || t === "\\square" || t === "\\Box" || t === "\\_" || t === "\\_\\_\\_";
}

// ─── Parser ────────────────────────────────────────────────────────────────

/**
 * Parse a constrained-LaTeX string into renderable nodes. Anything the subset
 * doesn't recognize degrades gracefully to a text node (never throws).
 */
export function parseMath(input: string): MathNode[] {
  const nodes: MathNode[] = [];
  let buf = "";
  let i = 0;

  const flush = () => {
    if (buf.length === 0) return;
    const pretty = prettifyText(buf);
    if (pretty.length > 0) nodes.push({ type: "text", value: pretty });
    buf = "";
  };

  while (i < input.length) {
    // \frac{..}{..}
    if (input.startsWith("\\frac", i) || input.startsWith("\\dfrac", i) || input.startsWith("\\tfrac", i)) {
      const macroLen = input.startsWith("\\frac", i) ? 5 : 6;
      let j = skipSpaces(input, i + macroLen);
      const g1 = readBraceGroup(input, j);
      if (g1) {
        j = skipSpaces(input, g1.next);
        const g2 = readBraceGroup(input, j);
        if (g2) {
          flush();
          nodes.push({
            type: "frac",
            num: isBlankArg(g1.inner) ? [{ type: "blank" }] : parseMath(g1.inner),
            den: isBlankArg(g2.inner) ? [{ type: "blank" }] : parseMath(g2.inner),
          });
          i = g2.next;
          continue;
        }
      }
      // Malformed \frac — treat the macro name as literal text and move on.
      buf += input.slice(i, i + macroLen);
      i += macroLen;
      continue;
    }

    // Standalone blank markers: \square / \Box
    if (input.startsWith("\\square", i) || input.startsWith("\\Box", i)) {
      flush();
      nodes.push({ type: "blank" });
      i += input.startsWith("\\square", i) ? 7 : 4;
      continue;
    }

    // Strip a few no-op wrappers that generators or KaTeX might include, so the
    // lite renderer sees the bare content: \left \right \! and $-delimiters.
    if (input.startsWith("\\left", i)) { i += 5; continue; }
    if (input.startsWith("\\right", i)) { i += 6; continue; }
    if (input[i] === "$") { i += 1; continue; }

    buf += input[i];
    i++;
  }

  flush();
  return nodes;
}

// ─── Generator helpers (the content side of the pipeline) ────────────────────

/** LaTeX for a simple fraction. `num`/`den` accept a number, a variable, or the
 *  blank sentinel. Pass `BLANK` (or "?") for a fill-in slot. */
export const BLANK = "\\square";

export function fracLatex(num: string | number, den: string | number): string {
  return `\\frac{${num}}{${den}}`;
}

/** LaTeX for a mixed number, e.g. mixedLatex(9,4,9) → "9\\frac{4}{9}". */
export function mixedLatex(whole: string | number, num: string | number, den: string | number): string {
  return `${whole}${fracLatex(num, den)}`;
}

// ─── ASCII → LaTeX migration bridge ──────────────────────────────────────────
// Converts the CURRENT plain-text stems ("9 4/9", "?/9", "3/4") into the LaTeX
// subset, so the lite renderer works against existing content while generators
// migrate to emitting LaTeX directly. Deliberately conservative: only rewrites
// `a/b` where both sides are digits or "?", optionally with a leading whole
// number, so it never mangles prose containing a stray slash.
export function asciiToLatex(s: string): string {
  // Mixed number: "9 4/9" (whole SPACE num/den) → "9\frac{4}{9}".
  // The trailing guard rejects a following word char or a REAL decimal
  // ("4.5"), but allows sentence punctuation ("9 4/9." at end of a sentence).
  let out = s.replace(
    /(?<![\w./])(\d+)\s+(\d+|\?)\/(\d+|\?)(?![\w]|\.\d)/g,
    (_m, w: string, n: string, d: string) => mixedLatex(w, toArg(n), toArg(d)),
  );
  // Simple fraction: "3/4", "?/9", "9/?".
  out = out.replace(
    /(?<![\w./])(\d+|\?)\/(\d+|\?)(?![\w/]|\.\d)/g,
    (_m, n: string, d: string) => fracLatex(toArg(n), toArg(d)),
  );
  return out;
}

function toArg(token: string): string {
  return token === "?" ? BLANK : token;
}

// ─── Inline math in prose (the tutor's markdown) ─────────────────────────────
// The tutor writes math delimited by `$...$` (inline) or `$$...$$` (display),
// the one convention that survives CommonMark unescaped (`\(...\)` gets eaten as
// an escaped paren) and that models emit natively. Currency ("$5", "$5 and $3")
// must NOT render as math — so a `$...$` run counts as math ONLY when its inner
// content looks like math: it contains a LaTeX macro (a backslash) or is a bare
// fraction / mixed number. Money has neither, so it stays literal text.

const BARE_FRACTION = /^\s*(?:\d+\s+)?(?:\d+|\?)\s*\/\s*(?:\d+|\?)\s*$/;

// Beyond a backslash-macro or a bare fraction, a `$...$` run is math when it
// carries a super/subscript (`^`/`_`), a LaTeX group (`{`/`}`), or an equals
// sign — none of which occur in the money text the currency guard must keep
// literal ("You have $5 and spend $3"). This lets bare-exponent spans render
// without a macro: `$10^{3}$`, `$2^{n}$`, `$10^{-3}$` → 10³, 2ⁿ, 10⁻³.
const MATH_SIGNAL = /[\\^_{}=]/;

/** True when the inside of a `$...$` span should be rendered as math rather than
 *  left as literal text (the currency guard). */
export function looksLikeMath(inner: string): boolean {
  return MATH_SIGNAL.test(inner) || BARE_FRACTION.test(inner);
}

export type MathSegment =
  | { type: "text"; value: string }
  | { type: "math"; latex: string; display: boolean };

// `$$...$$` (display) is tried before `$...$` (inline). Inline content may not
// span newlines, so an unterminated `$` never swallows a whole paragraph.
const MATH_DELIM = /\$\$([^$]+)\$\$|\$([^$\n]+)\$/g;

/**
 * Split a prose string into text and math segments. Math is `$$...$$` (display)
 * or `$...$` (inline); a run only becomes a math segment when `looksLikeMath` is
 * satisfied (so "$5" stays text). A math inner without a backslash (a bare
 * "3/4") is bridged through `asciiToLatex`, so both `$3/4$` and `$\frac{3}{4}$`
 * render identically. Never throws; returns a single text segment when there is
 * no math.
 */
export function splitMathSegments(input: string): MathSegment[] {
  const out: MathSegment[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  MATH_DELIM.lastIndex = 0;
  while ((m = MATH_DELIM.exec(input))) {
    const display = m[1] != null;
    const inner = display ? m[1] : m[2];
    if (!looksLikeMath(inner)) {
      // Currency / stray dollar — leave it literal, but rewind to just past the
      // opening `$` so a later delimiter this run swallowed (e.g. the closing `$`
      // of "$5 ... $1/2$") can still open a real math span.
      MATH_DELIM.lastIndex = m.index + 1;
      continue;
    }
    if (m.index > last) out.push({ type: "text", value: input.slice(last, m.index) });
    out.push({
      type: "math",
      latex: inner.includes("\\") ? inner : asciiToLatex(inner),
      display,
    });
    last = MATH_DELIM.lastIndex;
  }
  if (last < input.length) out.push({ type: "text", value: input.slice(last) });
  return out;
}

/** True if a prose string contains at least one renderable math span — lets a
 *  renderer skip the segment machinery on the common no-math line. */
export function hasInlineMath(input: string): boolean {
  return splitMathSegments(input).some((s) => s.type === "math");
}

/** True if a plain (ASCII) string contains a fraction/mixed number — lets a
 *  call site decide whether to route a short label (a stem, a multiple-choice
 *  option) through the stacked renderer or leave it as plain text. */
export function hasFraction(s: string): boolean {
  return s.includes("\\frac") || asciiToLatex(s).includes("\\frac");
}

// ─── Spoken form (accessibility) ─────────────────────────────────────────────
// A stacked fraction read verbatim by a screen reader is "3 slash 4"; the parsed
// form lets us say "3 over 4" (and "9 and 4 over 9" for a mixed number, "blank"
// for a fill-in). Used as the aria-label / accessibilityLabel of MathText.

function nodesToSpeech(nodes: MathNode[]): string {
  const parts: string[] = [];
  for (const n of nodes) {
    if (n.type === "text") {
      parts.push(n.value);
    } else if (n.type === "blank") {
      parts.push(" blank ");
    } else {
      // Mixed number ("9\frac{4}{9}") reads "9 and 4 over 9": insert "and" when
      // the preceding run ends in a digit (a whole part sits right before it).
      const prev = parts.length ? parts[parts.length - 1] : "";
      if (/\d\s*$/.test(prev)) parts.push(" and ");
      parts.push(` ${nodesToSpeech(n.num)} over ${nodesToSpeech(n.den)} `);
    }
  }
  return parts.join("");
}

/** A screen-reader-friendly spoken rendering of a constrained-LaTeX string. */
export function latexToSpeech(latex: string): string {
  return nodesToSpeech(parseMath(latex)).replace(/\s+/g, " ").trim();
}
