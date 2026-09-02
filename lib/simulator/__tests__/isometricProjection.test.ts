import { describe, expect, it } from "vitest";

import {
  clampIsometricCamera,
  fitIsometricCamera,
  isometricCellAtScreen,
  isometricCellCenter,
  isometricScreenPoint,
  isometricTileDiamond,
  projectIsometric,
  sortIsometricDepth,
  unprojectIsometric,
  unprojectIsometricScreen,
} from "../isometricProjection";

describe("isometric projection", () => {
  it("round-trips arbitrary logical points", () => {
    for (const point of [
      { x: 0, y: 0 },
      { x: 3.5, y: 7.25 },
      { x: 59.999, y: 39.001 },
    ]) {
      const roundTrip = unprojectIsometric(projectIsometric(point));
      expect(roundTrip.x).toBeCloseTo(point.x, 10);
      expect(roundTrip.y).toBeCloseTo(point.y, 10);
    }
  });

  it("places a sprite at the chess-square center, not the go-style intersection", () => {
    const cell = { x: 3, y: 5 };
    const intersection = projectIsometric(cell);
    const center = isometricCellCenter(cell);
    const [top, right, bottom, left] = isometricTileDiamond(cell);

    expect(center).not.toEqual(intersection);
    expect(center.x).toBeCloseTo((top.x + right.x + bottom.x + left.x) / 4);
    expect(center.y).toBeCloseTo((top.y + right.y + bottom.y + left.y) / 4);
    expect(unprojectIsometric(center)).toEqual({ x: 3.5, y: 5.5 });
  });

  it("sorts painter order by x+y, then semantic layer, then stable id", () => {
    const sorted = sortIsometricDepth([
      { id: "front", x: 3, y: 2, layer: 0 },
      { id: "upper", x: 2, y: 2, layer: 2 },
      { id: "lower-b", x: 2, y: 2, layer: 1 },
      { id: "lower-a", x: 2, y: 2, layer: 1 },
      { id: "back", x: 0, y: 1, layer: 9 },
    ]);
    expect(sorted.map(({ id }) => id)).toEqual(["back", "lower-a", "lower-b", "upper", "front"]);
  });

  it.each([
    { width: 2, height: 2 },
    { width: 12, height: 8 },
    { width: 60, height: 40 },
  ])("fits and inverse-projects a $width x $height world", (grid) => {
    const viewport = { width: 960, height: 640 };
    const fit = fitIsometricCamera(grid, viewport, 24);
    expect(fit.contentBounds.minX).toBeGreaterThanOrEqual(24);
    expect(fit.contentBounds.minY).toBeGreaterThanOrEqual(24);
    expect(fit.contentBounds.maxX).toBeLessThanOrEqual(viewport.width - 24);
    expect(fit.contentBounds.maxY).toBeLessThanOrEqual(viewport.height - 24);

    const logical = { x: grid.width - 0.5, y: grid.height - 0.5 };
    const screen = isometricScreenPoint(logical, fit);
    const roundTrip = unprojectIsometricScreen(screen, fit);
    expect(roundTrip.x).toBeCloseTo(logical.x, 8);
    expect(roundTrip.y).toBeCloseTo(logical.y, 8);
    expect(isometricCellAtScreen(screen, fit, { scale: 1, x: 0, y: 0 }, grid)).toEqual({
      x: grid.width - 1,
      y: grid.height - 1,
    });
  });

  it("clamps pan against fitted projected bounds at fit and zoom", () => {
    const viewport = { width: 900, height: 600 };
    const fit = fitIsometricCamera({ width: 12, height: 8 }, viewport, 20);
    expect(clampIsometricCamera({ scale: 1, x: 800, y: -800 }, fit, viewport)).toEqual({
      scale: 1,
      x: 0,
      y: 0,
    });

    const zoomed = clampIsometricCamera({ scale: 2, x: -100_000, y: 100_000 }, fit, viewport);
    expect(zoomed.x).toBe(viewport.width - 2 * fit.contentBounds.maxX);
    expect(zoomed.y).toBe(-2 * fit.contentBounds.minY);
  });
});
