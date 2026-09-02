import { describe, expect, it } from "vitest";
import {
  CLOSE_FRAC,
  DETENTS,
  MAX_FRAC,
  MIN_CROP,
  MIN_FRAC,
  OPEN_DX,
  SNAP_PX,
  clampFrac,
  drawerMetrics,
  inkCropRect,
  outlineToSvgPath,
  projectFling,
  snapTarget,
} from "./scratchpadGeometry";

/**
 * The Scratchpad drawer's decision model — the arithmetic that decides where a
 * released divider lands, whether a flick dismisses the pad, and how a capture
 * is cropped.
 *
 * These tests are the reason the geometry lives in `shared/` at all: CI's
 * `pnpm test` scans shared/ but NOT native/'s own vitest suite, so while this
 * arithmetic sat in `native/src/lib/` the merge gate never checked it.
 *
 * The centrepiece is the release physics from native PR #1213: a release
 * decision reads `position + projectFling(velocity)`, never the raw position.
 * Andy rejected the position-only version by hand on the iPad, because shoving
 * the divider to ~30% and letting go left the drawer open. That is exactly the
 * class of defect a test should catch before a device does.
 */

// An 1180pt landscape iPad, the fleet's default posture.
const SCREEN = 1180;
const m = drawerMetrics(SCREEN);

describe("projectFling — UIKit momentum projection", () => {
  it("projects nothing at rest, so a slow placement is judged where it stopped", () => {
    expect(projectFling(0)).toBe(0);
  });

  it("coasts 499ms worth of travel (UIScrollView's 0.998 deceleration)", () => {
    expect(projectFling(1000)).toBeCloseTo(499, 6);
    expect(projectFling(-1000)).toBeCloseTo(-499, 6);
  });

  it("clamps a stray high-velocity sample at 2500pt/s in both directions", () => {
    expect(projectFling(99999)).toBeCloseTo(projectFling(2500), 6);
    expect(projectFling(-99999)).toBeCloseTo(projectFling(-2500), 6);
  });
});

describe("the divider release — the defect PR #1213 fixed", () => {
  // The exact rejected interaction: the divider is at 30% of the screen (wider
  // than the 17% dismiss line) and the finger is still moving right, hard.
  const raw = SCREEN * 0.3;
  // The width shrinks as the finger moves right, so the width's velocity is the
  // negative of the finger's.
  const thrownShut = -1200;

  it("dismisses a hard throw that stopped ABOVE the dismiss line", () => {
    const projected = raw + projectFling(thrownShut);
    expect(projected).toBeLessThan(m.closeW);
  });

  it("keeps a SLOW release at the same pixel open, snapped to the ⅓ detent", () => {
    const projected = raw + projectFling(0);
    expect(projected).toBeGreaterThan(m.closeW);
    expect(snapTarget(projected, m)).toBeCloseTo(SCREEN * DETENTS[0], 6);
  });

  it("carries momentum into the detent choice — a gentle push lands one detent wider", () => {
    const atHalf = SCREEN * DETENTS[1];
    // Pushed leftward (widening) just hard enough to coast toward ⅔.
    const nudged = atHalf + projectFling(400);
    expect(snapTarget(nudged, m)).toBeCloseTo(SCREEN * DETENTS[2], 6);
    // The same position with no momentum stays exactly where it was let go.
    expect(snapTarget(atHalf, m)).toBeCloseTo(atHalf, 6);
  });
});

describe("snapTarget — magnetic, not sticky", () => {
  it("pulls onto a detent from just inside the snap radius", () => {
    const third = SCREEN * DETENTS[0];
    expect(snapTarget(third + SNAP_PX - 1, m)).toBeCloseTo(third, 6);
    expect(snapTarget(third - SNAP_PX + 1, m)).toBeCloseTo(third, 6);
  });

  it("leaves a release outside the snap radius exactly where it landed", () => {
    const free = SCREEN * DETENTS[0] + SNAP_PX + 30;
    expect(snapTarget(free, m)).toBeCloseTo(free, 6);
  });

  it("clamps a free release to 25–90% of the width", () => {
    expect(snapTarget(10, m)).toBeCloseTo(m.minW, 6);
    expect(snapTarget(SCREEN * 2, m)).toBeCloseTo(m.maxW, 6);
    expect(m.minW).toBeCloseTo(SCREEN * MIN_FRAC, 6);
    expect(m.maxW).toBeCloseTo(SCREEN * MAX_FRAC, 6);
    expect(m.closeW).toBeCloseTo(SCREEN * CLOSE_FRAC, 6);
  });

  it("treats both clamps as snap targets, so the extremes are reachable by feel", () => {
    expect(snapTarget(m.maxW - 8, m)).toBeCloseTo(m.maxW, 6);
    expect(snapTarget(m.minW + 8, m)).toBeCloseTo(m.minW, 6);
  });
});

describe("the right-edge open swipe — the same bug, opposite direction", () => {
  const opens = (translationX: number, velocityX: number) =>
    translationX + projectFling(velocityX) <= OPEN_DX;

  it("opens on a fast short flick that never travelled the threshold", () => {
    expect(opens(-20, 0)).toBe(false);
    expect(opens(-20, -900)).toBe(true);
  });

  it("opens on a slow deliberate drag past the threshold", () => {
    expect(opens(-60, 0)).toBe(true);
  });

  it("ignores a drag that is heading back the other way", () => {
    expect(opens(-20, 900)).toBe(false);
  });
});

describe("clampFrac — the sticky width can never be stored out of range", () => {
  it("clamps to the drawer's own 25–90% range", () => {
    expect(clampFrac(0.01)).toBe(MIN_FRAC);
    expect(clampFrac(1)).toBe(MAX_FRAC);
    expect(clampFrac(DETENTS[1])).toBe(DETENTS[1]);
  });
});

describe("inkCropRect — the capture is the WORK, not the paper", () => {
  const SHEET_W = 1034;
  const SHEET_H = 760;

  it("returns null with nothing drawn, so the caller falls back to the full sheet", () => {
    expect(inkCropRect(null, SHEET_W, SHEET_H)).toBeNull();
  });

  it("pads the tight bounds and stays inside the sheet", () => {
    const crop = inkCropRect(
      { minX: 300, minY: 200, maxX: 700, maxY: 500 },
      SHEET_W,
      SHEET_H,
    );
    expect(crop).toEqual({ x: 272, y: 172, width: 456, height: 356 });
  });

  it("grows a lone dot out to a legible minimum instead of a 4px PNG", () => {
    const crop = inkCropRect(
      { minX: 500, minY: 400, maxX: 502, maxY: 402 },
      SHEET_W,
      SHEET_H,
    );
    expect(crop!.width).toBe(MIN_CROP);
    expect(crop!.height).toBe(MIN_CROP);
    expect(crop!.x).toBeGreaterThanOrEqual(0);
    expect(crop!.y).toBeGreaterThanOrEqual(0);
    expect(crop!.x + crop!.width).toBeLessThanOrEqual(SHEET_W);
    expect(crop!.y + crop!.height).toBeLessThanOrEqual(SHEET_H);
  });

  it("never runs off the sheet for ink drawn hard against a corner", () => {
    const crop = inkCropRect({ minX: 0, minY: 0, maxX: 3, maxY: 3 }, SHEET_W, SHEET_H)!;
    expect(crop.x).toBe(0);
    expect(crop.y).toBe(0);
    expect(crop.x + crop.width).toBeLessThanOrEqual(SHEET_W);
    expect(crop.y + crop.height).toBeLessThanOrEqual(SHEET_H);
  });

  it("rejects degenerate bounds rather than emitting a broken rect", () => {
    expect(
      inkCropRect({ minX: NaN, minY: 0, maxX: 10, maxY: 10 }, SHEET_W, SHEET_H),
    ).toBeNull();
    expect(
      inkCropRect({ minX: 0, minY: 0, maxX: Infinity, maxY: 10 }, SHEET_W, SHEET_H),
    ).toBeNull();
  });
});

describe("outlineToSvgPath — the same outline string on both renderers", () => {
  it("is empty for an empty outline", () => {
    expect(outlineToSvgPath([])).toBe("");
  });

  it("emits a closed quadratic path starting at the first outline point", () => {
    const d = outlineToSvgPath([
      [0, 0],
      [10, 0],
      [10, 10],
    ]);
    expect(d.startsWith("M 0 0 Q")).toBe(true);
    expect(d.endsWith("Z")).toBe(true);
    // Every segment is a point plus the midpoint to its neighbour, wrapping
    // around — so the outline closes on itself with no seam.
    expect(d).toBe("M 0 0 Q 0 0 5 0 10 0 10 5 10 10 5 5 Z");
  });
});
