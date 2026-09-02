/**
 * The rendering contract that the WEB renderer
 * (`components/slides/SlideCanvas.tsx`) and the NATIVE iPad renderer
 * (`native/src/components/slides/SlideElementContentNative.tsx`) must BOTH
 * honour, so that the same deck looks the same on both surfaces.
 *
 * These are two independent renderers over one deck model, and they have
 * already drifted repeatedly: native drew a `line` as a bordered rectangle,
 * rounded rect corners web drew square, and ignored `verticalAlign` outright.
 * Each was fixed by editing native to match a value retyped from web. That
 * keeps working only for as long as someone remembers web is the reference.
 *
 * So the values both surfaces have to agree on live here, and each renderer
 * reads them instead of restating them.
 *
 * UNITS. A deck is authored on a fixed 1280x720 LOGICAL canvas (see
 * `slidesScene.ts`) and each renderer scales it uniformly to fit its container.
 * Everything here is in LOGICAL units unless the function takes a `scale`.
 * Web scales the whole canvas with one CSS transform, so it consumes the
 * logical values directly; native multiplies per element, so it passes `scale`.
 */
import type { SlideElement, VerticalAlign } from "./slidesScene";

/** Inset between a text element's box and its text, in logical units. */
export const TEXT_PADDING = 4;

/** Line height as a multiple of font size. */
export const TEXT_LINE_HEIGHT_RATIO = 1.2;

/**
 * The flexbox `justifyContent` that realises a `verticalAlign`. Web CSS and
 * React Native accept the same three values, so one mapping serves both.
 */
export function verticalAlignToJustify(
  verticalAlign: VerticalAlign,
): "flex-start" | "center" | "flex-end" {
  if (verticalAlign === "middle") return "center";
  if (verticalAlign === "bottom") return "flex-end";
  return "flex-start";
}

/**
 * A line's stroke thickness in LOGICAL units, clamped so a hairline never
 * disappears entirely.
 *
 * The clamp belongs here — BEFORE either renderer scales — because clamping
 * after scaling silently changes the drawing. Native used to compute
 * `max(1, strokeWidth * scale)` in device pixels, so in a small thumbnail a
 * 2-unit rule at scale 0.25 came out 1px instead of web's 0.5px: the same deck,
 * with visibly heavier rules on the child's iPad than on the authoring screen.
 */
export function lineStrokeLogical(strokeWidth: number): number {
  return Math.max(1, strokeWidth);
}

/**
 * Whether an element's frame box clips its content.
 *
 * Only text clips. A `line` draws its stroke centred on a frame that is
 * typically 1 logical unit tall, so a thick stroke MUST be allowed to overflow
 * — native used to clip every element and rendered a strokeWidth-12 rule as a
 * hairline on the iPad while web drew the full bar. Rects and ellipses draw
 * their border inside the frame, and images/videos are `contain`-fitted, so
 * for them the clip is a no-op either way.
 */
export function clipsOverflow(elementType: SlideElement["type"]): boolean {
  return elementType === "text";
}

/**
 * Absolute line height in rendered pixels, for renderers that cannot express a
 * unitless multiplier. (Web can — it passes `TEXT_LINE_HEIGHT_RATIO` straight
 * to CSS — but React Native's `lineHeight` is always absolute.)
 */
export function textLineHeightPx(fontSize: number, scale: number): number {
  return fontSize * scale * TEXT_LINE_HEIGHT_RATIO;
}

/** A frame in logical units, as authored on the deck's 1280x720 canvas. */
export type LogicalFrame = {
  x: number;
  y: number;
  w: number;
  h: number;
  rotation: number;
};

/**
 * Shrinks a frame symmetrically by `inset` logical units on every side,
 * keeping its centre fixed (never producing a negative size).
 *
 * This is the one primitive behind two of this file's agreements:
 *   - a text box's content sits inset by `TEXT_PADDING` from its frame — web
 *     realises that with CSS `padding`, native with RN `padding`;
 *   - an ellipse's stroke is centred on a path inset by half its stroke width,
 *     so the OUTER edge of the stroke lands on the frame box (not half of it
 *     spilling past) — web gets this for free from a border-box div, native
 *     computes it explicitly for its SVG `rx`/`ry`.
 *
 * A renderer that instead draws a shape's outline centred on its full frame
 * box (as PDF/PPTX shape primitives do) needs this inset spelled out, and it
 * has to happen in LOGICAL units before the renderer's own unit conversion —
 * doing it after would need re-deriving the same math per target unit.
 */
export function insetFrameLogical(
  frame: LogicalFrame,
  inset: number,
): LogicalFrame {
  const w = Math.max(0, frame.w - 2 * inset);
  const h = Math.max(0, frame.h - 2 * inset);
  return {
    x: frame.x + (frame.w - w) / 2,
    y: frame.y + (frame.h - h) / 2,
    w,
    h,
    rotation: frame.rotation,
  };
}
