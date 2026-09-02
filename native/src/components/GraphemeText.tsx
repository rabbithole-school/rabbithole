import { Text, type StyleProp, type TextStyle } from "react-native";

import { fonts } from "@/theme";
// Shared segment math + palette, vendored from shared/graphemeSegments.ts (the
// SAME source the web GraphemeText uses), so the two platforms color and fade
// identically. Kept in sync by native/scripts/sync-vendor.js — never edit the
// vendored copy directly; edit shared/ and re-run `npm run sync:vendor`.
import {
  stageColor,
  toSegments,
  type GraphemeSpan,
  type GraphemeStages,
} from "../../vendor/shared/graphemeSegments";

/**
 * GraphemeText (native) — the reading-ramp render layer for the Expo iPad app.
 *
 * The React Native twin of components/GraphemeText.tsx: color-coded grapheme
 * teams that fade toward normal ink as decoding confidence grows
 * (review/young-learners-plan.html §10). Prop-driven and presentational only —
 * the annotator's spans and per-team stages arrive as props — so it lands
 * independently of the Haiku annotator (PR #463) and the confidence map +
 * session wiring (post-#400).
 *
 * Layout-safety: a "graduated" (or unknown) team renders as a bare string child
 * (no nested <Text>, no style), so when every team has graduated the output is
 * exactly the parent-styled text — no metric shift vs. plain text. Font size and
 * family come from `style` (the caller's text style), inherited by nested runs;
 * an active team overrides only color (the data) plus a subtle family bump.
 *
 * Accessibility: nested <Text> inside one parent <Text> is announced by
 * VoiceOver as a single continuous string, so the coloring stays decorative and
 * the sentence reads exactly as written — no extra accessibility props.
 */

// Active teams get color plus a subtle weight bump. Custom fonts on iOS ignore
// numeric fontWeight, so we map to the app's named font families (the same
// idiom as the rest of native). A GRADUATED team is a bare string, so the
// "all graduated == parent text" metric invariant holds regardless.
const STAGE_FONT: Record<"training" | "fading", string> = {
  training: fonts.semibold,
  fading: fonts.medium,
};

export type GraphemeTextProps = {
  /** The source text. Rendered verbatim; never altered. */
  text: string;
  /** Annotator spans (character offsets [start, end)). */
  spans: readonly GraphemeSpan[];
  /** Per-team fade stage. Missing / unknown teams render as plain ink. */
  stages: GraphemeStages;
  /** Parent text style (size, family, line-height); inherited by all runs. */
  style?: StyleProp<TextStyle>;
};

export function GraphemeText({ text, spans, stages, style }: GraphemeTextProps) {
  const segments = toSegments(text, spans, stages);
  return (
    <Text style={style}>
      {segments.map((seg, i) => {
        // Graduated / plain runs: a bare string child inherits the parent style
        // with zero overhead — metric-identical to unstyled text.
        if (!seg.team || !seg.stage) return seg.text;
        return (
          <Text
            key={i}
            style={{ color: stageColor(seg.team, seg.stage), fontFamily: STAGE_FONT[seg.stage] }}
          >
            {seg.text}
          </Text>
        );
      })}
    </Text>
  );
}
