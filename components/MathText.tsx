"use client";

/**
 * MathText (web) — the full-power web math renderer for tutor PROSE. Renders a
 * LaTeX string with KaTeX (native vector typesetting, no MathJax/webview), the
 * DOM counterpart of the native SwiftMath renderer (native/src/components/
 * MathText.tsx). One LaTeX string drives both surfaces.
 *
 * WHY KaTeX (not the phase-1 flexbox stacked renderer): the tutor now writes
 * real LaTeX in prose — not just `a/b` fractions but sums, integrals, roots,
 * geometry (`\overline{AB}`, `\angle ABC`), and superscript/subscript. Only a
 * real LaTeX engine draws all of that; the flexbox renderer handles fractions.
 * Practice stems use `FractionText` for mixed prose and fractions, delegating
 * only static radical roots here.
 *
 * `throwOnError: false` means a malformed macro renders in red inline rather
 * than crashing the chat; the math-format eval (evals/spot-eval/mathFormat.ts)
 * is what actually holds the tutor to renderable LaTeX.
 *
 * Accessibility: KaTeX glyphs read as noise to a screen reader, so the wrapper
 * is `role="img"` with a spoken `aria-label` ("3 over 4", not "3 slash 4").
 *
 * NOTE: `katex/dist/katex.min.css` must be loaded once globally (see
 * app/globals.css / layout) so the fonts and layout rules are present.
 */

import { useMemo } from "react";
import katex from "katex";
import { latexToSpeech } from "@/shared/mathLatex";

export function MathText({
  latex,
  display = false,
  fontSize,
  color = "inherit",
  ariaLabel,
}: {
  /** A LaTeX string (already the math content, without `$` delimiters). */
  latex: string;
  /** Block/centered (`$$…$$`) vs inline (`$…$`). */
  display?: boolean;
  /** Font size in px; defaults to inheriting the surrounding prose size. */
  fontSize?: number;
  /** CSS color; defaults to inheriting the surrounding text color. */
  color?: string;
  /** Spoken label; defaults to a "3 over 4"-style reading of `latex`. */
  ariaLabel?: string;
}) {
  const html = useMemo(
    () =>
      katex.renderToString(latex, {
        displayMode: display,
        throwOnError: false,
        output: "html",
        strict: false,
        trust: false,
      }),
    [latex, display],
  );

  return (
    <span
      role="img"
      aria-label={ariaLabel ?? latexToSpeech(latex)}
      style={{
        color,
        ...(fontSize ? { fontSize } : {}),
        ...(display
          ? { display: "block", textAlign: "center", margin: "0.5em 0" }
          : { display: "inline-block", verticalAlign: "middle" }),
      }}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
