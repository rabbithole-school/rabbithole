/**
 * Pure geometry for the web slide editor. No React, no DOM — every function here
 * is a plain transform over numbers so it can be unit-tested in isolation and
 * reasoned about once. Two coordinate spaces are in play:
 *
 *  • LOGICAL space — the fixed 1280x720 canvas from shared/slidesScene. Every
 *    element frame lives here; the document never knows about device pixels.
 *  • SCREEN space — pixels relative to the editor's measured container. A single
 *    uniform {@link CanvasLayout} (scale + centering offset) maps between them.
 *
 * Rotation follows the model: CLOCKWISE degrees about an element's own centre,
 * in a y-down space — which is exactly what a CSS `rotate()` does, so the
 * renderer can draw a box axis-aligned and rotate it, while these helpers do the
 * inverse maths for hit-testing and resizing a rotated box in its LOCAL axes.
 */

import { CANVAS_W, CANVAS_H, MIN_ELEMENT_SIZE, type Frame, type Slide } from "@/shared/slidesScene";

export type Point = { x: number; y: number };

/** The uniform fit of the logical canvas inside a measured container. */
export type CanvasLayout = {
  /** Logical-unit → screen-pixel multiplier (uniform on both axes). */
  scale: number;
  /** Screen-pixel offset that centres the scaled canvas in the container. */
  offsetX: number;
  offsetY: number;
};

export type Corner = "topLeft" | "topRight" | "bottomRight" | "bottomLeft";

/** Local-axis sign of each corner relative to the box centre. */
const CORNER_SIGN: Record<Corner, { sx: number; sy: number }> = {
  topLeft: { sx: -1, sy: -1 },
  topRight: { sx: 1, sy: -1 },
  bottomRight: { sx: 1, sy: 1 },
  bottomLeft: { sx: -1, sy: 1 },
};

export const CORNERS: Corner[] = ["topLeft", "topRight", "bottomRight", "bottomLeft"];

// ─── Canvas ⇄ logical mapping ─────────────────────────────────────────────

/**
 * Fit the logical canvas uniformly inside a container and centre it. Uniform
 * scale (never stretch) keeps a deck laid out identically regardless of the
 * panel's aspect ratio.
 */
export function computeLayout(
  containerW: number,
  containerH: number,
  logicalW: number = CANVAS_W,
  logicalH: number = CANVAS_H,
): CanvasLayout {
  const scale = Math.max(0, Math.min(containerW / logicalW, containerH / logicalH));
  const offsetX = (containerW - logicalW * scale) / 2;
  const offsetY = (containerH - logicalH * scale) / 2;
  return { scale, offsetX, offsetY };
}

/** Logical point → screen pixel (relative to the container's top-left). */
export function logicalToScreen(p: Point, layout: CanvasLayout): Point {
  return { x: layout.offsetX + p.x * layout.scale, y: layout.offsetY + p.y * layout.scale };
}

/** Screen pixel (relative to the container's top-left) → logical point. */
export function screenToLogical(p: Point, layout: CanvasLayout): Point {
  if (layout.scale <= 0) return { x: 0, y: 0 };
  return { x: (p.x - layout.offsetX) / layout.scale, y: (p.y - layout.offsetY) / layout.scale };
}

// ─── Rotation ──────────────────────────────────────────────────────────────

/**
 * Rotate `p` about `centre` by `deg` CLOCKWISE degrees in a y-down space. This
 * is the same sense as a CSS `rotate(deg)`, so a positive rotation here matches
 * how the renderer visually rotates the element.
 */
export function rotatePoint(p: Point, centre: Point, deg: number): Point {
  const t = (deg * Math.PI) / 180;
  const cos = Math.cos(t);
  const sin = Math.sin(t);
  const dx = p.x - centre.x;
  const dy = p.y - centre.y;
  return {
    x: centre.x + dx * cos - dy * sin,
    y: centre.y + dx * sin + dy * cos,
  };
}

export function frameCentre(f: Frame): Point {
  return { x: f.x + f.w / 2, y: f.y + f.h / 2 };
}

/**
 * The box's local axes expressed in logical space. `u` is the width direction,
 * `v` the height direction, once the box is rotated by `rotationDeg`.
 */
function localAxes(rotationDeg: number): { u: Point; v: Point } {
  const t = (rotationDeg * Math.PI) / 180;
  const cos = Math.cos(t);
  const sin = Math.sin(t);
  return { u: { x: cos, y: sin }, v: { x: -sin, y: cos } };
}

/** The four corners of a frame in logical space, honouring its rotation. */
export function frameCorners(f: Frame): Record<Corner, Point> {
  const c = frameCentre(f);
  const out = {} as Record<Corner, Point>;
  for (const corner of CORNERS) {
    const { sx, sy } = CORNER_SIGN[corner];
    out[corner] = rotatePoint({ x: f.x + (sx > 0 ? f.w : 0), y: f.y + (sy > 0 ? f.h : 0) }, c, f.rotation);
  }
  return out;
}

/**
 * Anchor point of the rotate handle: above the box's top edge midpoint, `gap`
 * logical units clear of it, rotated with the box.
 */
export function rotateHandlePoint(f: Frame, gap = 36): Point {
  const c = frameCentre(f);
  return rotatePoint({ x: c.x, y: f.y - gap }, c, f.rotation);
}

// ─── Hit-testing ─────────────────────────────────────────────────────────

/**
 * Is the logical point inside the (possibly rotated) frame? Inverse-rotates the
 * point into the box's local axis-aligned space, then does a plain bounds test.
 */
export function hitTest(point: Point, f: Frame): boolean {
  const c = frameCentre(f);
  const local = rotatePoint(point, c, -f.rotation);
  return local.x >= f.x && local.x <= f.x + f.w && local.y >= f.y && local.y <= f.y + f.h;
}

/**
 * Top-most element under a point. `ordered` is back-to-front (the slide's
 * `elementIds` order), so we walk it in reverse and return the first hit.
 */
export function pickTopElement(
  ordered: Array<{ id: string; frame: Frame }>,
  point: Point,
): string | null {
  for (let i = ordered.length - 1; i >= 0; i--) {
    if (hitTest(point, ordered[i].frame)) return ordered[i].id;
  }
  return null;
}

// ─── Resize (in local space) ─────────────────────────────────────────────

function dot(a: Point, b: Point): number {
  return a.x * b.x + a.y * b.y;
}

/**
 * Resize a frame by dragging one corner to `pointer` (logical), holding the
 * OPPOSITE corner fixed. Works entirely in the box's LOCAL axes, so a rotated
 * box grows along its own edges rather than the screen's — the fixed corner
 * stays welded in place regardless of rotation.
 */
export function resizeFrame(
  start: Frame,
  corner: Corner,
  pointer: Point,
  minSize: number = MIN_ELEMENT_SIZE,
): Frame {
  const { sx, sy } = CORNER_SIGN[corner];
  const c = frameCentre(start);
  const { u, v } = localAxes(start.rotation);

  // The opposite corner is the fixed anchor.
  const anchor: Point = {
    x: c.x + -sx * (start.w / 2) * u.x + -sy * (start.h / 2) * v.x,
    y: c.y + -sx * (start.w / 2) * u.y + -sy * (start.h / 2) * v.y,
  };

  const d: Point = { x: pointer.x - anchor.x, y: pointer.y - anchor.y };
  const newW = Math.max(minSize, sx * dot(d, u));
  const newH = Math.max(minSize, sy * dot(d, v));

  const newCentre: Point = {
    x: anchor.x + sx * (newW / 2) * u.x + sy * (newH / 2) * v.x,
    y: anchor.y + sx * (newW / 2) * u.y + sy * (newH / 2) * v.y,
  };

  return {
    x: newCentre.x - newW / 2,
    y: newCentre.y - newH / 2,
    w: newW,
    h: newH,
    rotation: start.rotation,
  };
}

// ─── Rotate ──────────────────────────────────────────────────────────────

/**
 * The rotation, in [0, 360) clockwise degrees, that points the box's top edge
 * toward `pointer` from its centre. Pointer directly above the centre → 0°.
 */
export function rotationFromPointer(centre: Point, pointer: Point): number {
  const ang = (Math.atan2(pointer.y - centre.y, pointer.x - centre.x) * 180) / Math.PI;
  const rot = ang + 90; // handle nominally points up (−y) at 0°
  return ((rot % 360) + 360) % 360;
}

/** Move a frame's top-left by a logical delta, leaving size + rotation intact. */
export function translateFrame(start: Frame, dx: number, dy: number): Frame {
  return { ...start, x: start.x + dx, y: start.y + dy };
}

// ─── Editor input / content predicates ───────────────────────────────────
// Still pure functions over plain data (no React, no DOM event objects), so
// they live here alongside the geometry and are unit-tested the same way.

/** Exact equality of two frames across all five fields. */
export function framesEqual(a: Frame, b: Frame): boolean {
  return (
    a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h && a.rotation === b.rotation
  );
}

/**
 * Does a slide hold anything a child would be upset to lose on delete? Any
 * element counts; so does non-whitespace speaker-notes text, since deleting the
 * slide takes the notes with it. A truly blank slide returns false, so its
 * removal needs no confirmation (it is trivially undoable and loses nothing).
 */
export function slideHasContent(slide: Pick<Slide, "elementIds" | "speakerNotes">): boolean {
  if (slide.elementIds.length > 0) return true;
  return (slide.speakerNotes ?? "").trim().length > 0;
}

/**
 * Classify a keydown as an undo/redo shortcut, or null for anything else.
 * Cmd/Ctrl+Z is undo; adding Shift makes it redo — the platform convention we
 * expose. Takes the modifier flags as plain data (not a React event) so it is
 * pure and testable; the caller is responsible for NOT invoking it while a text
 * element is being edited (there the textarea owns undo).
 */
export function matchHistoryShortcut(e: {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
}): "undo" | "redo" | null {
  if (!(e.metaKey || e.ctrlKey)) return null;
  if (e.key.toLowerCase() !== "z") return null;
  return e.shiftKey ? "redo" : "undo";
}
