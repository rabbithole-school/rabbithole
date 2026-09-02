/**
 * Shared geometry for the editable radical mark on web and native.
 *
 * Renderers measure the radicand, then draw one physical-coordinate path for
 * the contour and overbar. Keeping the shoulder and bar in the same path means
 * their centreline and stroke can never drift as nested content changes height.
 */

import { EXPR_BOX_MIN } from "./expressionEditorBoxMetrics";

export const RADICAL_KEYPAD_VIEWBOX = "0 0 40 28";
export const RADICAL_KEYPAD_PATH = "M1.5 17 L7 23 L14 4 L21 4";

/** The index remains visually secondary, but it is still a real answer box.
 * Its width grows with multi-digit integer indices so they never collide with
 * either the coefficient or the radical's rising stroke. */
export function radicalIndexBoxSize(fontSize: number, digits = 1): {
  minWidth: number;
  minHeight: number;
} {
  return {
    minWidth: Math.max(EXPR_BOX_MIN, Math.round(fontSize * (digits * 0.7 + 0.7))),
    minHeight: EXPR_BOX_MIN,
  };
}

export function radicalMetrics(fontSize: number, hasIndex = false, indexDigits = 1) {
  const strokeWidth = Math.max(1.8, Math.round(fontSize * 0.095 * 10) / 10);
  // The renderer floors index text at 11px for legibility. Reserve the gutter
  // from that same clamped value so a multi-digit box cannot overlap the stroke
  // on compact web surfaces.
  const indexFontSize = Math.max(11, Math.round(fontSize * 0.42));
  // The editable index box needs a real touch target in the mark's crook. Give
  // it its own gutter so it never overlaps the radical's rising stroke.
  const indexBox = radicalIndexBoxSize(indexFontSize, indexDigits);
  const indexGutterWidth = hasIndex ? indexBox.minWidth + 2 : 0;
  return {
    markWidth: hasIndex
      ? indexGutterWidth + Math.max(14, Math.round(fontSize * 0.54))
      : Math.max(18, Math.round(fontSize * 0.72)),
    barInset: Math.ceil(strokeWidth * 1.5),
    barHeight: Math.ceil(strokeWidth),
    strokeWidth,
    indexFontSize,
    indexBoxWidth: indexBox.minWidth,
    indexBoxHeight: indexBox.minHeight,
    indexGutterWidth,
  };
}

/** Keep the root's contour wrapper vertically balanced around its radicand. */
export function radicalRootPadding(barInset: number): { top: number; bottom: number } {
  return { top: barInset, bottom: barInset };
}

export type RadicalMarkGeometry = {
  width: number;
  height: number;
  barCenter: number;
  shoulder: { x: number; y: number };
  bar: { fromX: number; toX: number; y: number };
  /** Top-left of the index ink in the mark gutter. Absolute placement means an
   * index never changes the root's footprint or the coefficient baseline. */
  indexAnchor: { x: number; y: number };
  path: string;
};

type RadicalMarkDimensions = {
  markWidth: number;
  radicandWidth: number;
  radicandHeight: number;
  barHeight: number;
  strokeWidth: number;
  indexGutterWidth?: number;
  indexBoxWidth?: number;
};

type LeafRadicandBaseline = {
  /** Baseline y in the radical contour's coordinate space. */
  y: number;
  /** The leaf glyph's local font size. */
  fontSize: number;
};

/**
 * Build the one continuous radical contour + overbar in rendered pixels.
 *
 * The SVG's viewBox matches these dimensions exactly, so this path is never
 * vertically stretched or clipped. `barCenter` is deliberately independent of
 * radicandHeight: a taller nested radicand lengthens only the descending check.
 *
 * A leaf radicand supplies its baseline explicitly. Its foot then follows the
 * glyph rather than the answer-box edge, whose padding and border vary by
 * state. Structural radicands omit it and retain height-tracking behavior.
 */
export function radicalMarkGeometry({
  markWidth,
  radicandWidth,
  radicandHeight,
  barHeight,
  strokeWidth,
  indexGutterWidth,
  indexBoxWidth,
  leafBaseline,
}: RadicalMarkDimensions & {
  leafBaseline?: LeafRadicandBaseline;
}): RadicalMarkGeometry {
  const width = Math.max(markWidth + radicandWidth, strokeWidth);
  // The radical foot's *ink* (not its path centerline) belongs just under a
  // leaf's baseline, like TeX. A nested fraction/root has no single baseline,
  // so it continues to grow from its measured box.
  const leafFootInkBottom = leafBaseline
    ? leafBaseline.y + leafBaseline.fontSize * 0.12
    : undefined;
  const height = Math.max(
    leafFootInkBottom ?? radicandHeight + Math.ceil(strokeWidth * 1.5),
    barHeight,
  );
  const barCenter = Math.max(barHeight / 2, strokeWidth / 2);
  const indexGutter = Math.min(
    Math.max(0, indexGutterWidth ?? 0),
    markWidth - strokeWidth,
  );
  const shoulder = {
    x: Math.round(
      (indexGutter + Math.max(7, (markWidth - indexGutter) * 0.6)) * 10,
    ) / 10,
    y: barCenter,
  };
  const bar = {
    fromX: shoulder.x,
    toX: Math.max(shoulder.x, width - strokeWidth / 2),
    y: barCenter,
  };
  const checkStart = {
    x: Math.max(strokeWidth / 2, indexGutter + 1),
    y: Math.max(barCenter + strokeWidth, Math.round(height * 0.58 * 10) / 10),
  };
  const checkBottom = {
    x: Math.min(shoulder.x, indexGutter + Math.max(3, (shoulder.x - indexGutter) * 0.45)),
    y: Math.max(
      checkStart.y,
      (leafFootInkBottom ?? height) - strokeWidth / 2,
    ),
  };
  return {
    width,
    height,
    barCenter,
    shoulder,
    bar,
    // The index is tucked above the crook, left of the rising stroke, never as a
    // baseline sibling that could read as a coefficient.
    indexAnchor: {
      x: Math.max(0, indexGutter - (indexBoxWidth ?? 0)),
      y: 0,
    },
    path: `M${checkStart.x} ${checkStart.y} L${checkBottom.x} ${checkBottom.y} L${shoulder.x} ${shoulder.y} H${bar.toX}`,
  };
}
