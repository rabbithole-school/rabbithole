/**
 * masteryGlyph — the ONE place a mastery state becomes a redundant,
 * colour-independent SHAPE (the sibling of `masteryDialPalette.ts`, which owns
 * state → colour).
 *
 * Why this exists: the mastery hues alone are not distinguishable under
 * red-green colour blindness (deuteranopia/protanopia) — `frontier` (amber) and
 * `fluent`/`placed` (green) collapse toward each other, and the whole set flattens
 * in greyscale. A distinct shape adds a SECOND channel so the state survives CVD
 * and monochrome, without discarding the brand hues (colour still rides along for
 * everyone who sees it). This is "Exploration A · glyph in the circle" from
 * `review/deuteranopia-mastery-shapes-study.html`.
 *
 * The mark is a TRANSPARENT KNOCKOUT — a shape punched through the coloured disc
 * so the background shows through — not ink painted on top. A hole reads by its
 * silhouette alone, so it is legible regardless of the disc's hue OR the ink's
 * contrast against it (there is no ink); it is the most hue-independent redundancy
 * available. `MasteryCenterDot` renders the disc + knockout; this module owns only
 * the vocabulary (state → which shape).
 *
 * The outer silhouette is left a circle everywhere ("a node is a dot" is the
 * locked map invariant); the punched shape carries the state. `placed` has NO
 * knockout — it already reads as a HOLLOW ring (vs. the solid fluent fill), which
 * is the existing redundant tell, so a second hole would be a second vocabulary
 * for one signal.
 */

import type { MasteryState } from "./treeMapLayout";

/**
 * Which shape is punched through the dot. These are DRAWN AS SVG GEOMETRY, not
 * typeset characters — a font glyph like "−" or "•" is centred on the font's
 * baseline/x-height, not the circle's centre, so it never sits perfectly in the
 * dot. Geometry (a rect, a circle, a path) is centred by construction.
 *
 *   bar   — "not started" (locked): a flat horizontal slot (the "−")
 *   dot   — "practicing" (frontier): a small centred hole → reads as a ring
 *   check — "fluent": a tick
 *   cross — "needs review" (struggling): an X, the tick's counterpart
 *   star  — "rock solid" (overlearned): a four-pointed sparkle (the "✦")
 *   none  — "placed": no knockout; the hollow ring is the whole signal
 */
export type MasteryGlyphKind = "bar" | "dot" | "check" | "cross" | "star" | "none";

/** State → the shape punched through its disc (Exploration A, as reviewed).
 *
 *  `struggling` is the state that needs this second channel MOST: its red is
 *  exactly the hue that collapses toward `fluent`/`placed` green under
 *  deuteranopia/protanopia, so on colour alone a teacher could read "recently
 *  failing" as "mastered" — an inversion, not just a loss. The X is the tick's
 *  natural counterpart and is unmistakable against the other four shapes. (The
 *  mark is legible, not editorial: the WORD stays the non-deficit "needs
 *  review", and the whole state is redacted from the scholar's own map.) */
export const MASTERY_GLYPH_KIND: Record<MasteryState, MasteryGlyphKind> = {
  locked: "bar",
  placed: "none", // hollow ring is the whole signal
  frontier: "dot",
  fluent: "check",
  struggling: "cross",
  overlearned: "star",
};

export function masteryGlyphKind(state: MasteryState): MasteryGlyphKind {
  return MASTERY_GLYPH_KIND[state];
}

/**
 * A punched mark needs ≈14px of dot DIAMETER to read. Below this a caller should
 * omit the knockout and let colour + hollow-ring carry the state (the dense tree
 * map's small nodes, tooltip micro-swatches). This is the size TIER from the
 * study: colour is invariant at every size; the shape is added only where legible.
 */
export const MASTERY_GLYPH_MIN_DIAMETER = 14;
