import { describe, it, expect } from "vitest";
import {
  computeLayout,
  logicalToScreen,
  screenToLogical,
  rotatePoint,
  hitTest,
  pickTopElement,
  resizeFrame,
  rotationFromPointer,
  frameCentre,
  frameCorners,
  slideHasContent,
  matchHistoryShortcut,
  framesEqual,
  type Point,
} from "./geometry";
import { CANVAS_W, CANVAS_H, MIN_ELEMENT_SIZE, type Frame } from "@/shared/slidesScene";

const f = (x: number, y: number, w: number, h: number, rotation = 0): Frame => ({
  x,
  y,
  w,
  h,
  rotation,
});

const near = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) <= eps;
const pointNear = (a: Point, b: Point, eps = 1e-6) => near(a.x, b.x, eps) && near(a.y, b.y, eps);

describe("computeLayout", () => {
  it("fits and centres uniformly in a wide container (letterboxed left/right)", () => {
    // 2000x720 → height-bound (scale 1), horizontal slack centred.
    const L = computeLayout(2000, 720);
    expect(near(L.scale, 1)).toBe(true);
    expect(near(L.offsetX, (2000 - 1280) / 2)).toBe(true);
    expect(near(L.offsetY, 0)).toBe(true);
  });

  it("fits and centres uniformly in a tall container (letterboxed top/bottom)", () => {
    // 1280x1440 → width-bound (scale 1), vertical slack centred.
    const L = computeLayout(1280, 1440);
    expect(near(L.scale, 1)).toBe(true);
    expect(near(L.offsetX, 0)).toBe(true);
    expect(near(L.offsetY, (1440 - 720) / 2)).toBe(true);
  });

  it("scales down to the tighter axis", () => {
    const L = computeLayout(640, 720); // width-bound: 640/1280 = 0.5
    expect(near(L.scale, 0.5)).toBe(true);
  });

  it("never returns a negative scale for a degenerate container", () => {
    expect(computeLayout(0, 0).scale).toBe(0);
  });
});

describe("logical ⇄ screen mapping", () => {
  it("round-trips an arbitrary point through both directions", () => {
    const L = computeLayout(1600, 900); // scale 0.703125, some centering
    const samples: Point[] = [
      { x: 0, y: 0 },
      { x: CANVAS_W, y: CANVAS_H },
      { x: 640, y: 360 },
      { x: 137.5, y: 402.25 },
    ];
    for (const p of samples) {
      const back = screenToLogical(logicalToScreen(p, L), L);
      expect(pointNear(back, p, 1e-6)).toBe(true);
    }
  });

  it("maps the logical centre to the screen centre of the container", () => {
    const L = computeLayout(1600, 900);
    const s = logicalToScreen({ x: CANVAS_W / 2, y: CANVAS_H / 2 }, L);
    expect(pointNear(s, { x: 800, y: 450 }, 1e-6)).toBe(true);
  });

  it("screenToLogical is safe on a zero-scale layout", () => {
    const L = computeLayout(0, 0);
    expect(screenToLogical({ x: 10, y: 10 }, L)).toEqual({ x: 0, y: 0 });
  });
});

describe("rotatePoint", () => {
  it("rotates clockwise in y-down space: right of centre → below centre at 90°", () => {
    const c = { x: 0, y: 0 };
    const r = rotatePoint({ x: 1, y: 0 }, c, 90);
    expect(pointNear(r, { x: 0, y: 1 }, 1e-9)).toBe(true);
  });

  it("is the inverse of itself under negation", () => {
    const c = { x: 100, y: 50 };
    const p = { x: 160, y: 40 };
    const back = rotatePoint(rotatePoint(p, c, 37), c, -37);
    expect(pointNear(back, p, 1e-9)).toBe(true);
  });
});

describe("hitTest under rotation", () => {
  it("hits and misses an axis-aligned box", () => {
    const box = f(100, 100, 200, 100);
    expect(hitTest({ x: 150, y: 150 }, box)).toBe(true);
    expect(hitTest({ x: 50, y: 150 }, box)).toBe(false); // outside left
    expect(hitTest({ x: 99, y: 150 }, box)).toBe(false);
    expect(hitTest({ x: 301, y: 150 }, box)).toBe(false);
  });

  it("a point in the pre-rotation corner is OUTSIDE a 45°-rotated box, but the centre stays inside", () => {
    // A tall thin box rotated 45°: its axis-aligned top-left corner region is no
    // longer covered once rotated, while the centre is invariant under rotation.
    const box = f(200, 200, 200, 40, 45);
    const c = frameCentre(box);
    expect(hitTest(c, box)).toBe(true);
    // Near the un-rotated top-left corner — inside before rotation, outside after.
    const preCorner = { x: 205, y: 205 };
    expect(hitTest(preCorner, f(200, 200, 200, 40, 0))).toBe(true);
    expect(hitTest(preCorner, box)).toBe(false);
  });

  it("hits a point on the rotated box's long axis (rotation-invariant along centreline ends)", () => {
    const box = f(200, 200, 200, 40, 90);
    const c = frameCentre(box);
    // 90° rotation swaps the visual extents: a point 80 below the centre (within
    // the now-vertical 200-long axis) is inside; 80 to the side (beyond the
    // now-20 half-height) is outside.
    expect(hitTest({ x: c.x, y: c.y + 80 }, box)).toBe(true);
    expect(hitTest({ x: c.x + 80, y: c.y }, box)).toBe(false);
  });
});

describe("pickTopElement", () => {
  const a = { id: "a", frame: f(0, 0, 400, 400) };
  const b = { id: "b", frame: f(100, 100, 100, 100) };

  it("returns the front-most (last in back-to-front order) element under a point", () => {
    // b is drawn after a, so where they overlap b wins.
    expect(pickTopElement([a, b], { x: 150, y: 150 })).toBe("b");
    // Only a covers this point.
    expect(pickTopElement([a, b], { x: 350, y: 350 })).toBe("a");
    // Neither covers this point.
    expect(pickTopElement([a, b], { x: 900, y: 900 })).toBe(null);
  });

  it("respects z-order when the array order is reversed", () => {
    expect(pickTopElement([b, a], { x: 150, y: 150 })).toBe("a");
  });
});

describe("resizeFrame in local space", () => {
  it("axis-aligned: dragging bottom-right keeps the top-left corner fixed", () => {
    const start = f(100, 100, 200, 100, 0);
    const out = resizeFrame(start, "bottomRight", { x: 360, y: 260 });
    // Top-left unchanged.
    expect(near(out.x, 100)).toBe(true);
    expect(near(out.y, 100)).toBe(true);
    // New size follows the pointer.
    expect(near(out.w, 260)).toBe(true);
    expect(near(out.h, 160)).toBe(true);
    expect(out.rotation).toBe(0);
  });

  it("axis-aligned: dragging top-left keeps the bottom-right corner fixed", () => {
    const start = f(100, 100, 200, 100, 0);
    const out = resizeFrame(start, "topLeft", { x: 120, y: 130 });
    // Bottom-right (300,200) stays put.
    expect(near(out.x + out.w, 300)).toBe(true);
    expect(near(out.y + out.h, 200)).toBe(true);
    expect(near(out.w, 180)).toBe(true);
    expect(near(out.h, 70)).toBe(true);
  });

  it("clamps to the minimum edge and still holds the anchor", () => {
    const start = f(100, 100, 200, 100, 0);
    // Drag bottom-right almost onto the top-left → both edges clamp to MIN.
    const out = resizeFrame(start, "bottomRight", { x: 101, y: 101 });
    expect(near(out.w, MIN_ELEMENT_SIZE)).toBe(true);
    expect(near(out.h, MIN_ELEMENT_SIZE)).toBe(true);
    expect(near(out.x, 100)).toBe(true);
    expect(near(out.y, 100)).toBe(true);
  });

  it("rotated: the opposite (anchor) corner stays welded in place", () => {
    const start = f(200, 200, 200, 100, 30);
    const anchorBefore = frameCorners(start).topLeft;
    // Move the bottom-right handle somewhere arbitrary.
    const out = resizeFrame(start, "bottomRight", { x: 520, y: 380 });
    const anchorAfter = frameCorners(out).topLeft;
    expect(pointNear(anchorBefore, anchorAfter, 1e-6)).toBe(true);
    expect(near(out.rotation, 30)).toBe(true);
  });

  it("rotated: resizing along the local width axis changes only width", () => {
    const start = f(200, 200, 200, 100, 40);
    const { u } = localAxesForTest(40);
    const anchor = frameCorners(start).topLeft;
    // Place the pointer exactly along the local width axis at distance 300 from
    // the anchor, at the SAME local-height offset as the dragged corner (h=100).
    const { v } = localAxesForTest(40);
    const pointer = {
      x: anchor.x + 300 * u.x + 100 * v.x,
      y: anchor.y + 300 * u.y + 100 * v.y,
    };
    const out = resizeFrame(start, "bottomRight", pointer);
    expect(near(out.w, 300, 1e-6)).toBe(true);
    expect(near(out.h, 100, 1e-6)).toBe(true);
    expect(near(out.rotation, 40)).toBe(true);
  });
});

describe("rotationFromPointer", () => {
  const c = { x: 300, y: 300 };
  it("pointer directly above the centre is 0°", () => {
    expect(near(rotationFromPointer(c, { x: 300, y: 100 }), 0)).toBe(true);
  });
  it("pointer to the right is 90°", () => {
    expect(near(rotationFromPointer(c, { x: 500, y: 300 }), 90)).toBe(true);
  });
  it("pointer below is 180°", () => {
    expect(near(rotationFromPointer(c, { x: 300, y: 500 }), 180)).toBe(true);
  });
  it("pointer to the left is 270°", () => {
    expect(near(rotationFromPointer(c, { x: 100, y: 300 }), 270)).toBe(true);
  });
});

// A local copy of the axis maths so the test doesn't depend on a private export.
function localAxesForTest(rotationDeg: number): { u: Point; v: Point } {
  const t = (rotationDeg * Math.PI) / 180;
  const cos = Math.cos(t);
  const sin = Math.sin(t);
  return { u: { x: cos, y: sin }, v: { x: -sin, y: cos } };
}

describe("framesEqual", () => {
  const base: Frame = { x: 10, y: 20, w: 30, h: 40, rotation: 5 };
  it("is true for identical frames (a no-move click commits the same frame)", () => {
    expect(framesEqual(base, { ...base })).toBe(true);
  });
  it("is false when any single field differs", () => {
    expect(framesEqual(base, { ...base, x: 11 })).toBe(false);
    expect(framesEqual(base, { ...base, y: 21 })).toBe(false);
    expect(framesEqual(base, { ...base, w: 31 })).toBe(false);
    expect(framesEqual(base, { ...base, h: 41 })).toBe(false);
    expect(framesEqual(base, { ...base, rotation: 6 })).toBe(false);
  });
});

describe("slideHasContent", () => {
  it("is false for a blank slide (no elements, no notes)", () => {
    expect(slideHasContent({ elementIds: [] })).toBe(false);
    expect(slideHasContent({ elementIds: [], speakerNotes: "" })).toBe(false);
    expect(slideHasContent({ elementIds: [], speakerNotes: "   \n\t" })).toBe(false);
  });

  it("is true when the slide has any element", () => {
    expect(slideHasContent({ elementIds: ["el1"] })).toBe(true);
  });

  it("is true when only non-whitespace speaker notes exist (they'd be lost)", () => {
    expect(slideHasContent({ elementIds: [], speakerNotes: "remember to smile" })).toBe(true);
  });
});

describe("matchHistoryShortcut", () => {
  const base = { key: "z", metaKey: false, ctrlKey: false, shiftKey: false };

  it("Cmd+Z and Ctrl+Z are undo", () => {
    expect(matchHistoryShortcut({ ...base, metaKey: true })).toBe("undo");
    expect(matchHistoryShortcut({ ...base, ctrlKey: true })).toBe("undo");
  });

  it("adding Shift makes it redo", () => {
    expect(matchHistoryShortcut({ ...base, metaKey: true, shiftKey: true })).toBe("redo");
    expect(matchHistoryShortcut({ ...base, ctrlKey: true, shiftKey: true })).toBe("redo");
  });

  it("is case-insensitive on the key (Shift often uppercases it)", () => {
    expect(matchHistoryShortcut({ ...base, key: "Z", metaKey: true, shiftKey: true })).toBe("redo");
    expect(matchHistoryShortcut({ ...base, key: "Z", ctrlKey: true })).toBe("undo");
  });

  it("returns null without a modifier or for another key", () => {
    expect(matchHistoryShortcut(base)).toBe(null);
    expect(matchHistoryShortcut({ ...base, shiftKey: true })).toBe(null);
    expect(matchHistoryShortcut({ ...base, key: "y", metaKey: true })).toBe(null);
    expect(matchHistoryShortcut({ ...base, key: "a", ctrlKey: true })).toBe(null);
  });
});
