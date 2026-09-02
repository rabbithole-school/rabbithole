/**
 * Geometry floors for an expression-editor answer box (web + native).
 *
 * WHY THIS EXISTS — the layout-shift class of bug.
 *
 * An answer box sizes itself as `max(floor, content + chrome)`. If the floor is
 * even a fraction of a pixel SMALLER than a single glyph's content box, then an
 * empty box sits at the floor while a one-digit box sits at its content size —
 * so the box (and everything laid out beside it) jumps the instant the first
 * character lands. Measured on the real surface before this rule existed: an
 * empty box in a fraction rendered 29.00 × 33.00 and the same box holding one
 * digit rendered 29.77 × 33.09.
 *
 * The rule: the floor must be >= the size of a box holding exactly one glyph.
 * Then an empty box and a one-digit box are both pinned to the floor and typing
 * the first character shifts nothing. Overshooting the floor is harmless (the
 * box is merely a hair roomier, in every state equally); undershooting is the
 * bug. So every term below is a deliberate UPPER bound.
 */

/** Absolute minimum box, for a comfortable touch target at tiny font sizes. */
export const EXPR_BOX_MIN = 22;

/** Horizontal padding inside a box, per side. */
export const EXPR_BOX_PAD_X = 8;

/** Vertical padding inside a box, per side. */
export const EXPR_BOX_PAD_Y = 4;

/** Horizontal margin outside a box, per side. */
export const EXPR_BOX_MARGIN_X = 1;

/** The line-height glyphs render at, so a glyph's line box is this × fontSize. */
export const EXPR_GLYPH_LINE_HEIGHT = 1.1;

/**
 * The baseline of a leaf glyph within its em box.
 *
 * This is deliberately shared with radical geometry rather than inferred from
 * an answer box's measured height: its baseline does not move when a browser
 * rounds a border or when feedback removes that border.
 */
export const EXPR_GLYPH_BASELINE_EM = 0.85;

/**
 * A digit's advance width as a fraction of font size.
 *
 * Measured 0.56 for the practice surface's font (Hanken Grotesk, weight 600 —
 * its digits are tabular, so every digit is identical and one constant covers
 * all ten). Carried at 0.60 for headroom: native renders in a different font,
 * and an overshoot only widens the box while an undershoot brings the layout
 * shift back.
 */
export const EXPR_DIGIT_ADVANCE_EM = 0.6;

/**
 * Border width of an interactive box.
 *
 * Declared as 1.75, but a browser SNAPS a fractional border to the device pixel
 * grid — it renders ~1px at dpr 1 and ~1.5px at dpr 2. The floor must hold on
 * every device, so it budgets the full declared width (the largest value the
 * border can ever occupy) rather than what any one screen happens to paint.
 */
export const EXPR_BOX_BORDER = 1.75;

/** Padding + border on both sides, i.e. everything around the glyph itself. */
export function expressionBoxChrome(borderWidth: number = EXPR_BOX_BORDER): {
  x: number;
  y: number;
} {
  return {
    x: 2 * (EXPR_BOX_PAD_X + borderWidth),
    y: 2 * (EXPR_BOX_PAD_Y + borderWidth),
  };
}

/**
 * The min-width / min-height an answer box must carry at a given font size so
 * that it never changes size when its first glyph arrives.
 *
 * `borderWidth` is passed explicitly because a box sheds its border in the
 * inert feedback state, and the floor has to track that.
 */
export function expressionBoxMinSize(
  fontSize: number,
  borderWidth: number = EXPR_BOX_BORDER,
): { minWidth: number; minHeight: number } {
  const chrome = expressionBoxChrome(borderWidth);
  return {
    minWidth: Math.max(EXPR_BOX_MIN, fontSize * EXPR_DIGIT_ADVANCE_EM + chrome.x),
    minHeight: Math.max(EXPR_BOX_MIN, fontSize * EXPR_GLYPH_LINE_HEIGHT + chrome.y),
  };
}

/**
 * The y coordinate of a leaf glyph's baseline from the top of its answer box.
 *
 * The glyph sits centered in its 1.1em line box. `borderWidth` remains
 * explicit because filled feedback boxes intentionally shed their border while
 * retaining the same baseline-relative radical geometry.
 */
export function expressionBoxBaselineOffset(
  fontSize: number,
  borderWidth: number = EXPR_BOX_BORDER,
): number {
  const lineBoxLeading = (fontSize * (EXPR_GLYPH_LINE_HEIGHT - 1)) / 2;
  return (
    borderWidth +
    EXPR_BOX_PAD_Y +
    lineBoxLeading +
    fontSize * EXPR_GLYPH_BASELINE_EM
  );
}

/**
 * The minimum footprint a radicand occupies inside a radical.
 *
 * The measured wrapper includes the interactive answer box's border and its
 * horizontal margins. Seeding the radical with this footprint prevents the
 * contour from snapping when the first measured box replaces the initial floor.
 */
export function expressionRadicandFloorSize(fontSize: number): {
  minWidth: number;
  minHeight: number;
} {
  const box = expressionBoxMinSize(fontSize, EXPR_BOX_BORDER);
  return {
    minWidth: box.minWidth + 2 * EXPR_BOX_MARGIN_X,
    minHeight: box.minHeight,
  };
}
