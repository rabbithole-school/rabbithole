import { describe, expect, it } from "vitest";

import {
  EXPR_BOX_BORDER,
  EXPR_BOX_MARGIN_X,
  EXPR_BOX_MIN,
  EXPR_BOX_PAD_X,
  EXPR_BOX_PAD_Y,
  EXPR_DIGIT_ADVANCE_EM,
  EXPR_GLYPH_BASELINE_EM,
  EXPR_GLYPH_LINE_HEIGHT,
  expressionBoxBaselineOffset,
  expressionBoxChrome,
  expressionBoxMinSize,
  expressionRadicandFloorSize,
} from "./expressionEditorBoxMetrics";

/** The size a box would take from its content alone, holding `n` glyphs. */
function contentSize(fontSize: number, n: number, borderWidth = EXPR_BOX_BORDER) {
  const chrome = expressionBoxChrome(borderWidth);
  return {
    width: fontSize * EXPR_DIGIT_ADVANCE_EM * n + chrome.x,
    height: fontSize * EXPR_GLYPH_LINE_HEIGHT + chrome.y,
  };
}

// The font sizes the editor actually renders at: the root (26), each nesting
// step of a fraction (× 0.82, floored at 13), and an exponent (× 0.7, floored
// at 12).
const REAL_FONT_SIZES = [26, 21, 18, 15, 13, 12, 20, 17, 14];

describe("expression box metrics — no layout shift on the first glyph", () => {
  for (const fontSize of REAL_FONT_SIZES) {
    it(`floor at ${fontSize}px is at least a one-glyph box`, () => {
      const floor = expressionBoxMinSize(fontSize);
      const one = contentSize(fontSize, 1);
      // The whole point: an empty box (pinned to the floor) is never narrower
      // or shorter than the same box holding one digit.
      expect(floor.minWidth).toBeGreaterThanOrEqual(one.width);
      expect(floor.minHeight).toBeGreaterThanOrEqual(one.height);
    });

    it(`floor at ${fontSize}px does not swallow a two-glyph box`, () => {
      // Overshoot is safe, but not so much that a box stops growing with real
      // content — two digits must still be wider than the floor.
      const floor = expressionBoxMinSize(fontSize);
      expect(contentSize(fontSize, 2).width).toBeGreaterThan(floor.minWidth);
    });
  }

  it("tracks the border shedding in the inert feedback state", () => {
    const withBorder = expressionBoxMinSize(21, EXPR_BOX_BORDER);
    const bare = expressionBoxMinSize(21, 0);
    expect(bare.minWidth).toBeLessThan(withBorder.minWidth);
    expect(bare.minWidth).toBeGreaterThanOrEqual(contentSize(21, 1, 0).width);
    expect(bare.minHeight).toBeGreaterThanOrEqual(contentSize(21, 1, 0).height);
  });

  it("never drops below the touch-target minimum", () => {
    const tiny = expressionBoxMinSize(1);
    expect(tiny.minWidth).toBe(EXPR_BOX_MIN);
    expect(tiny.minHeight).toBe(EXPR_BOX_MIN);
  });

  it("grows monotonically with font size", () => {
    let prevW = 0;
    let prevH = 0;
    for (const fontSize of [12, 13, 15, 18, 21, 26, 40]) {
      const { minWidth, minHeight } = expressionBoxMinSize(fontSize);
      expect(minWidth).toBeGreaterThanOrEqual(prevW);
      expect(minHeight).toBeGreaterThanOrEqual(prevH);
      prevW = minWidth;
      prevH = minHeight;
    }
  });

  it("chrome is padding plus border on both sides", () => {
    expect(expressionBoxChrome(2)).toEqual({
      x: 2 * (EXPR_BOX_PAD_X + 2),
      y: 2 * (EXPR_BOX_PAD_Y + 2),
    });
  });

  it.each([13, 16, 20, 26, 34])(
    "derives the %ipx leaf baseline from its centered line box",
    (fontSize) => {
      const expected =
        EXPR_BOX_BORDER +
        EXPR_BOX_PAD_Y +
        (fontSize * (EXPR_GLYPH_LINE_HEIGHT - 1)) / 2 +
        fontSize * EXPR_GLYPH_BASELINE_EM;
      expect(expressionBoxBaselineOffset(fontSize)).toBeCloseTo(expected);
      expect(expressionBoxBaselineOffset(fontSize, 0)).toBeCloseTo(
        expected - EXPR_BOX_BORDER,
      );
    },
  );

  it("radicand floor includes the interactive one-glyph box and its outer margins", () => {
    const fontSize = 26;
    const oneGlyphBox = contentSize(fontSize, 1);
    const measuredRadicand = {
      width: oneGlyphBox.width + 2 * EXPR_BOX_MARGIN_X,
      height: oneGlyphBox.height,
    };

    expect(expressionRadicandFloorSize(fontSize)).toEqual({
      minWidth: measuredRadicand.width,
      minHeight: measuredRadicand.height,
    });
  });

  it("regression: the old fontSize+8 floor was too narrow at fraction sizes", () => {
    // The shipped bug. At the inner font size of a fraction the old floor (29)
    // undershot a one-digit box (~29.8), so the box jumped on the first digit.
    const oldFloor = Math.max(EXPR_BOX_MIN, 21 + 8);
    expect(oldFloor).toBeLessThan(contentSize(21, 1).width);
    expect(expressionBoxMinSize(21).minWidth).toBeGreaterThanOrEqual(contentSize(21, 1).width);
  });

  it("regression: the old fontSize+12 floor was too short at fraction sizes", () => {
    const oldFloor = Math.max(EXPR_BOX_MIN, 21 + 12);
    expect(oldFloor).toBeLessThan(contentSize(21, 1).height);
    expect(expressionBoxMinSize(21).minHeight).toBeGreaterThanOrEqual(contentSize(21, 1).height);
  });
});
