/**
 * Math-format validator for tutor output — the mechanical side of "does the
 * prompt actually make the model write math the way our renderer expects?"
 *
 * The contract (see the math-format bullet in convex/prompts.ts): fractions and
 * short expressions are wrapped in `$...$` (inline) or `$$...$$` (display) as
 * LaTeX (`\frac{a}{b}`, mixed `1\frac{1}{2}`, `\square` blanks); whole numbers,
 * decimals and prices stay plain. This module reuses the SAME shared parser the
 * renderers use (shared/mathLatex), so "passes the check" == "renders as a real
 * stacked fraction on web + iPad", by construction.
 *
 * Two failure modes it catches:
 *  - a LEAKED fraction: a bare "3/4" / "9 4/9" left in prose, unwrapped — the
 *    ugly slash we're trying to kill (detected with the same conservative
 *    `hasFraction` rule the renderer bridges with, so dates / "and/or" / "TCP/IP"
 *    don't false-flag).
 *  - a MALFORMED span: a `$...$` that parses to a broken fraction (empty
 *    numerator or denominator) the renderer would draw as an empty box.
 */
import { splitMathSegments, hasFraction, parseMath, type MathNode } from "../../shared/mathLatex";

export interface MathFormatReport {
  /** Count of `$...$` / `$$...$$` spans that resolved to math. */
  mathSpans: number;
  /** How many of those used `$$...$$` display delimiters. */
  displaySpans: number;
  /** LaTeX of any span that parsed to a broken (empty num/den) fraction. */
  malformedSpans: string[];
  /** Prose fragments that still contain an un-wrapped bare fraction. */
  leakedFractions: string[];
  /** No leaks and no malformed spans. */
  compliant: boolean;
}

function fracWellFormed(nodes: MathNode[]): boolean {
  for (const n of nodes) {
    if (n.type === "frac") {
      if (n.num.length === 0 || n.den.length === 0) return false;
      if (!fracWellFormed(n.num) || !fracWellFormed(n.den)) return false;
    }
  }
  return true;
}

export function analyzeMathFormat(text: string): MathFormatReport {
  const segments = splitMathSegments(text);
  const malformedSpans: string[] = [];
  const leakedFractions: string[] = [];
  let mathSpans = 0;
  let displaySpans = 0;

  for (const seg of segments) {
    if (seg.type === "math") {
      mathSpans++;
      if (seg.display) displaySpans++;
      if (!fracWellFormed(parseMath(seg.latex))) malformedSpans.push(seg.latex);
    } else if (hasFraction(seg.value)) {
      // A bare fraction survived in prose — the tutor didn't wrap it.
      leakedFractions.push(seg.value.trim());
    }
  }

  return {
    mathSpans,
    displaySpans,
    malformedSpans,
    leakedFractions,
    compliant: leakedFractions.length === 0 && malformedSpans.length === 0,
  };
}
