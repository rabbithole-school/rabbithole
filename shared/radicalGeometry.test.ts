import { describe, expect, it } from "vitest";

import {
  EXPR_BOX_BORDER,
  EXPR_BOX_MARGIN_X,
  EXPR_BOX_PAD_X,
  EXPR_BOX_PAD_Y,
  EXPR_DIGIT_ADVANCE_EM,
  EXPR_GLYPH_LINE_HEIGHT,
  expressionBoxBaselineOffset,
  expressionRadicandFloorSize,
} from "./expressionEditorBoxMetrics";
import {
  radicalIndexBoxSize,
  radicalMarkGeometry,
  radicalMetrics,
  radicalRootPadding,
} from "./radicalGeometry";

const LEAF_FONT_SIZES = [13, 16, 20, 26, 34];

function leafGeometry(fontSize: number, radicandHeight: number, hasIndex = false) {
  const metrics = radicalMetrics(fontSize, hasIndex);
  return radicalMarkGeometry({
    markWidth: metrics.markWidth,
    radicandWidth: expressionRadicandFloorSize(fontSize).minWidth,
    radicandHeight,
    barHeight: metrics.barHeight,
    strokeWidth: metrics.strokeWidth,
    indexGutterWidth: metrics.indexGutterWidth,
    indexBoxWidth: metrics.indexBoxWidth,
    leafBaseline: {
      y: metrics.barInset + expressionBoxBaselineOffset(fontSize),
      fontSize,
    },
  });
}

describe("radicalMarkGeometry", () => {
  it.each(LEAF_FONT_SIZES)(
    "anchors a %ipx leaf radical foot 0.12em below its glyph baseline",
    (fontSize) => {
      const metrics = radicalMetrics(fontSize);
      const baseline = metrics.barInset + expressionBoxBaselineOffset(fontSize);
      const geometry = leafGeometry(
        fontSize,
        expressionRadicandFloorSize(fontSize).minHeight,
      );

      // SVG height reaches the round-capped foot's ink edge, not its centerline.
      expect(geometry.height - baseline).toBeCloseTo(fontSize * 0.12);
    },
  );

  it.each(LEAF_FONT_SIZES)(
    "keeps a %ipx leaf contour stable when measurement includes excess box height",
    (fontSize) => {
      const floorHeight = expressionRadicandFloorSize(fontSize).minHeight;
      const fromFloor = leafGeometry(fontSize, floorHeight);
      const fromExcessMeasurement = leafGeometry(fontSize, floorHeight + 120);

      expect(fromExcessMeasurement).toEqual(fromFloor);
    },
  );

  it.each(LEAF_FONT_SIZES)(
    "keeps the %ipx shoulder and overbar on one centreline",
    (fontSize) => {
      const metrics = radicalMetrics(fontSize);
      const geometry = leafGeometry(
        fontSize,
        expressionRadicandFloorSize(fontSize).minHeight,
      );

      expect(geometry.shoulder.y).toBe(geometry.bar.y);
      expect(geometry.barCenter).toBe(metrics.barHeight / 2);
      expect(geometry.path).toContain(`L${geometry.shoulder.x} ${geometry.barCenter} H`);
    },
  );

  it("extends only the descending contour when a structural radicand grows", () => {
    const metrics = radicalMetrics(26);
    const short = radicalMarkGeometry({
      markWidth: metrics.markWidth,
      radicandWidth: 42,
      radicandHeight: 30,
      barHeight: metrics.barHeight,
      strokeWidth: metrics.strokeWidth,
    });
    const tall = radicalMarkGeometry({
      markWidth: metrics.markWidth,
      radicandWidth: 42,
      radicandHeight: 128,
      barHeight: metrics.barHeight,
      strokeWidth: metrics.strokeWidth,
    });

    expect(tall.barCenter).toBe(short.barCenter);
    expect(tall.shoulder.y).toBe(short.shoulder.y);
    expect(tall.height).toBeGreaterThan(short.height);
  });

  it("starts with the same geometry as a measured one-glyph leaf radicand", () => {
    const fontSize = 26;
    const measuredRadicand = {
      width:
        fontSize * EXPR_DIGIT_ADVANCE_EM +
        2 * (EXPR_BOX_PAD_X + EXPR_BOX_BORDER + EXPR_BOX_MARGIN_X),
      height:
        fontSize * EXPR_GLYPH_LINE_HEIGHT +
        2 * (EXPR_BOX_PAD_Y + EXPR_BOX_BORDER),
    };
    const floor = expressionRadicandFloorSize(fontSize);
    const metrics = radicalMetrics(fontSize);
    const leafBaseline = {
      y: metrics.barInset + expressionBoxBaselineOffset(fontSize),
      fontSize,
    };
    const fromFloor = radicalMarkGeometry({
      markWidth: metrics.markWidth,
      radicandWidth: floor.minWidth,
      radicandHeight: floor.minHeight,
      barHeight: metrics.barHeight,
      strokeWidth: metrics.strokeWidth,
      leafBaseline,
    });
    const fromMeasuredGlyph = radicalMarkGeometry({
      markWidth: metrics.markWidth,
      radicandWidth: measuredRadicand.width,
      radicandHeight: measuredRadicand.height,
      barHeight: metrics.barHeight,
      strokeWidth: metrics.strokeWidth,
      leafBaseline,
    });

    expect(fromFloor).toEqual(fromMeasuredGlyph);
  });

  it.each(LEAF_FONT_SIZES)("balances root padding at %ipx", (fontSize) => {
    const { barInset } = radicalMetrics(fontSize);
    expect(radicalRootPadding(barInset)).toEqual({
      top: barInset,
      bottom: barInset,
    });
  });

  it.each(LEAF_FONT_SIZES)("keeps the indexed-root box in the mark gutter at %ipx", (fontSize) => {
    const metrics = radicalMetrics(fontSize, true);
    const geometry = leafGeometry(fontSize, expressionRadicandFloorSize(fontSize).minHeight, true);
    expect(metrics.indexFontSize).toBeLessThan(fontSize);
    expect(geometry.indexAnchor.x).toBeGreaterThanOrEqual(0);
    expect(geometry.indexAnchor.x + metrics.indexBoxWidth).toBeLessThanOrEqual(metrics.indexGutterWidth);
    expect(geometry.indexAnchor.y).toBe(0);
    expect(geometry.shoulder.x).toBeGreaterThan(metrics.indexGutterWidth);
  });

  it("widens the index gutter for multi-digit indices without crossing the radical stroke", () => {
    const single = radicalMetrics(26, true, 1);
    const multi = radicalMetrics(26, true, 4);
    const geometry = radicalMarkGeometry({
      markWidth: multi.markWidth,
      radicandWidth: 40,
      radicandHeight: 32,
      barHeight: multi.barHeight,
      strokeWidth: multi.strokeWidth,
      indexGutterWidth: multi.indexGutterWidth,
      indexBoxWidth: multi.indexBoxWidth,
    });

    expect(multi.indexBoxWidth).toBeGreaterThan(single.indexBoxWidth);
    expect(multi.indexGutterWidth).toBeGreaterThan(single.indexGutterWidth);
    expect(geometry.indexAnchor.x + multi.indexBoxWidth).toBeLessThanOrEqual(
      multi.indexGutterWidth,
    );
    expect(geometry.shoulder.x).toBeGreaterThan(multi.indexGutterWidth);
  });

  it.each([13, 16, 20, 22, 26])(
    "reserves a multi-digit index gutter at compact %ipx editor text",
    (fontSize) => {
      const metrics = radicalMetrics(fontSize, true, 4);
      const renderedIndexFont = Math.max(11, metrics.indexFontSize);
      expect(metrics.indexBoxWidth).toBe(radicalIndexBoxSize(renderedIndexFont, 4).minWidth);
    },
  );

  it.each(LEAF_FONT_SIZES)("keeps an implicit square root compact at %ipx", (fontSize) => {
    const implicit = radicalMetrics(fontSize);
    const indexed = radicalMetrics(fontSize, true);
    const geometry = leafGeometry(fontSize, expressionRadicandFloorSize(fontSize).minHeight);

    expect(implicit.indexGutterWidth).toBe(0);
    expect(implicit.markWidth).toBeLessThan(indexed.markWidth);
    expect(geometry.indexAnchor.x).toBe(0);
  });

  it("uses no index gutter when a production plain-root renderer omits it", () => {
    const metrics = radicalMetrics(26);
    const dimensions = {
      markWidth: metrics.markWidth,
      radicandWidth: 40,
      radicandHeight: 32,
      barHeight: metrics.barHeight,
      strokeWidth: metrics.strokeWidth,
    };

    expect(radicalMarkGeometry(dimensions)).toEqual(
      radicalMarkGeometry({
        ...dimensions,
        indexGutterWidth: 0,
        indexBoxWidth: 0,
      }),
    );
  });
});
