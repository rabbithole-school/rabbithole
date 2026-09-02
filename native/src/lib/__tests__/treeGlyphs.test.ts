import { describe, expect, it } from "vitest";

import {
  airlineArc,
  arcDashArray,
  arcPathD,
  arrowheadPoints,
  dialArcLength,
  pointsAttr,
  straightEdge,
} from "../../components/tree/treeGeometry";

describe("treeGeometry — dial arc", () => {
  it("computes the real arc length (r·(π − 2·GAP_RAD)), no pathLength", () => {
    const gapRad = (3 * Math.PI) / 180;
    expect(dialArcLength(10)).toBeCloseTo(10 * (Math.PI - 2 * gapRad), 6);
    expect(dialArcLength(0)).toBe(0);
  });

  it("dashes by fill·L then a gap of L, clamped to [0,1]", () => {
    const L = dialArcLength(20);
    expect(arcDashArray(0.5, 20)).toEqual([0.5 * L, L]);
    expect(arcDashArray(-1, 20)).toEqual([0, L]); // clamps low
    expect(arcDashArray(2, 20)).toEqual([L, L]); // clamps high
  });

  it("builds a semicircle path per side", () => {
    expect(arcPathD(10, 10, 8, "left")).toMatch(/^M .* A 8 8 0 0 1 /);
    expect(arcPathD(10, 10, 8, "right")).toMatch(/^M .* A 8 8 0 0 0 /);
  });
});

describe("treeGeometry — edges", () => {
  it("gaps a straight edge symmetrically along its tangent", () => {
    const g = straightEdge(0, 0, 10, 0, 2);
    expect(g.sx).toBeCloseTo(2, 6);
    expect(g.ex).toBeCloseTo(8, 6);
    expect(g.sy).toBeCloseTo(0, 6);
    expect(g.tanX).toBeCloseTo(1, 6);
    expect(g.tanY).toBeCloseTo(0, 6);
  });

  it("bows the airline arc toward screen-up and returns a unit end tangent", () => {
    const g = airlineArc(0, 0, 10, 0, 5, 2);
    // control raised above (screen −y) the chord midpoint (5,0)
    expect(g.cx).toBeCloseTo(5, 6);
    expect(g.cy).toBeCloseTo(-5, 6);
    // end tangent is a unit vector
    expect(Math.hypot(g.tanX, g.tanY)).toBeCloseTo(1, 6);
    // both ends pulled back by `back` from the raw endpoints
    expect(Math.hypot(g.sx - 0, g.sy - 0)).toBeCloseTo(2, 6);
  });
});

describe("treeGeometry — arrowhead", () => {
  it("puts the tip at the target end with a base `size` behind, `size` wide", () => {
    const [tip, l, r] = arrowheadPoints(10, 0, 1, 0, 6);
    expect(tip).toEqual({ x: 10, y: 0 });
    expect(l.x).toBeCloseTo(4, 6);
    expect(r.x).toBeCloseTo(4, 6);
    expect(Math.abs(l.y - r.y)).toBeCloseTo(6, 6); // full width == size
  });

  it("formats an svg points string", () => {
    expect(pointsAttr([{ x: 1, y: 2 }, { x: 3.5, y: 4.25 }])).toBe("1.00,2.00 3.50,4.25");
  });
});
