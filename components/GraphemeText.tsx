/**
 * GraphemeText (web) — the reading-ramp render layer.
 *
 * Renders tutor text with color-coded grapheme teams ("sh", "th", "ea", …) that
 * fade toward normal ink as a scholar's per-team decoding confidence grows
 * (review/young-learners-plan.html §10). Purely presentational and prop-driven:
 * the annotator's spans and each team's fade stage come in as props, so this
 * lands independently of the Haiku annotator (PR #463) and the per-scholar
 * confidence map + session wiring (post-#400). The segment math, palette, and
 * fade blending live in the framework-agnostic shared/graphemeSegments.ts, so
 * this component and the native one paint identically.
 *
 * Layout-safety: a "graduated" (or unknown) team emits PLAIN text — no wrapping
 * span, no styling — so when every team has graduated the output is byte-for-
 * byte the same DOM text as passing the raw string, and there is zero width
 * jump vs. unstyled text. Font size and line-height always inherit from the
 * parent; the only visual change on an active team is color (the data) plus a
 * subtle weight bump, so the component is safe to drop into existing prose.
 *
 * Accessibility: the coloring is decorative instruction, not information a
 * screen reader should announce. Segments are plain text nodes with no extra
 * ARIA, so assistive tech reads the sentence exactly as written.
 */

import {
  stageColor,
  toSegments,
  type GraphemeSpan,
  type GraphemeStages,
} from "@/shared/graphemeSegments";

// Active teams get color (the data) plus a subtle weight bump. Weight can shift
// glyph width slightly while a scaffold is live — that is intended (a training
// wheel should stand out) — but a GRADUATED team renders as plain text, so the
// "all graduated == unstyled" width invariant holds regardless of weight.
const STAGE_WEIGHT: Record<"training" | "fading", number> = {
  training: 600,
  fading: 500,
};

export type GraphemeTextProps = {
  /** The source text. Rendered verbatim; never altered. */
  text: string;
  /** Annotator spans (character offsets [start, end)). */
  spans: readonly GraphemeSpan[];
  /** Per-team fade stage. Missing / unknown teams render as plain ink. */
  stages: GraphemeStages;
};

export function GraphemeText({ text, spans, stages }: GraphemeTextProps) {
  const segments = toSegments(text, spans, stages);
  return (
    <>
      {segments.map((seg, i) => {
        // Graduated / plain runs: emit the bare text node — zero DOM overhead,
        // metric-identical to unstyled text.
        if (!seg.team || !seg.stage) return seg.text;
        return (
          <span
            key={i}
            style={{
              color: stageColor(seg.team, seg.stage),
              fontWeight: STAGE_WEIGHT[seg.stage],
            }}
          >
            {seg.text}
          </span>
        );
      })}
    </>
  );
}
