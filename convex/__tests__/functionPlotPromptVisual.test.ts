import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import {
  coordinatePlaneAccessibilityLabel,
  coordinatePlaneGeometry,
  functionPlotAccessibilityLabel,
  functionPlotGeometry,
  makeCoordinatePlanePromptVisual,
  makeFunctionPlotPromptVisual,
  type PracticePromptVisual,
} from "../../shared/practicePromptVisual";
import schema from "../schema";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

const twoCurves = makeFunctionPlotPromptVisual({
  xMin: -6,
  xMax: 6,
  yMin: -6,
  yMax: 6,
  curves: [
    { form: "transform", parent: "quadratic", a: -1, h: 1, k: 4, label: "f" },
    { form: "transform", parent: "abs", a: 1, h: -2, k: -3, label: "g" },
  ],
  points: [{ x: 1, y: 4, label: "V" }],
});

const rational = makeFunctionPlotPromptVisual({
  xMin: -6,
  xMax: 6,
  yMin: -6,
  yMax: 6,
  curves: [{ form: "rational", rational: { vertical: [2], horizontal: 1, scale: 3 } }],
  asymptotes: { vertical: [2], horizontal: [1] },
  shadeX: { from: 3, to: -1 },
});

const polynomial = makeFunctionPlotPromptVisual({
  xMin: -5,
  xMax: 5,
  yMin: -8,
  yMax: 8,
  curves: [
    {
      form: "polynomial",
      zeros: [
        { x: -2, multiplicity: 1 },
        { x: 1, multiplicity: 2 },
      ],
      leading: 0.5,
    },
  ],
});

const complexPlane = makeCoordinatePlanePromptVisual({
  xMin: -5,
  xMax: 5,
  yMin: -5,
  yMax: 5,
  gridStep: 1,
  points: [{ x: 3, y: -2, label: "z" }],
  axisLabels: { x: "Re", y: "Im" },
});

/** Every number in an SVG path `d` string. */
const pathNumbers = (d: string) => (d.match(/-?\d+(\.\d+)?/g) ?? []).map(Number);

describe("functionPlot prompt visual — geometry", () => {
  test("is deterministic for the same spec", () => {
    expect(functionPlotGeometry(twoCurves)).toEqual(functionPlotGeometry(structuredClone(twoCurves)));
  });

  test("draws one path per curve, with no NaN and every point inside the plot box", () => {
    for (const spec of [twoCurves, rational, polynomial]) {
      const g = functionPlotGeometry(spec);
      expect(g.curves).toHaveLength(spec.curves.length);
      for (const curve of g.curves) {
        expect(curve.d).not.toMatch(/NaN|Infinity/);
        const nums = pathNumbers(curve.d);
        expect(nums.length).toBeGreaterThan(10);
        for (let i = 0; i < nums.length; i += 2) {
          expect(nums[i]).toBeGreaterThanOrEqual(g.plotX - 0.01);
          expect(nums[i]).toBeLessThanOrEqual(g.plotX + g.plotWidth + 0.01);
          expect(nums[i + 1]).toBeGreaterThanOrEqual(g.plotY - 0.01);
          expect(nums[i + 1]).toBeLessThanOrEqual(g.plotY + g.plotHeight + 0.01);
        }
      }
    }
  });

  test("breaks a rational curve at its asymptote into separate sub-paths", () => {
    const g = functionPlotGeometry(rational);
    expect(g.curves[0].d.match(/M/g)?.length).toBe(2);
    expect(g.asymptotes).toHaveLength(2);
    expect(g.shade).toBeDefined();
    expect(g.shade!.width).toBeGreaterThan(0);
  });

  test("uses square units and labels curves and points", () => {
    const g = functionPlotGeometry(twoCurves);
    expect(g.plotWidth).toBeCloseTo(g.plotHeight);
    expect(g.curves.map((c) => c.label?.text)).toEqual(["f", "g"]);
    expect(g.points[0].label?.text).toBe("V");
  });

  test("the accessibility label states visible facts and never the equation", () => {
    const label = functionPlotAccessibilityLabel(rational);
    expect(label).toContain("Graph of a function on a grid from x = -6 to 6");
    expect(label).toContain("dashed asymptotes at x = 2 and y = 1");
    expect(label).toContain("shading from x = -1 to x = 3");
    expect(label).not.toMatch(/\//);
    expect(functionPlotAccessibilityLabel(twoCurves)).toContain("2 functions");
  });

  test("the sanitizer keeps at most three curves and drops out-of-window asymptotes", () => {
    const spec = makeFunctionPlotPromptVisual({
      xMin: -4,
      xMax: 4,
      yMin: -4,
      yMax: 4,
      curves: [
        { form: "transform", parent: "linear", a: 1, h: 0, k: 0 },
        { form: "transform", parent: "linear", a: 2, h: 0, k: 0 },
        { form: "transform", parent: "linear", a: 3, h: 0, k: 0 },
        { form: "transform", parent: "linear", a: 4, h: 0, k: 0 },
      ],
      asymptotes: { vertical: [9, 1], horizontal: [Number.NaN] },
    });
    expect(spec.curves).toHaveLength(3);
    expect(spec.asymptotes).toEqual({ vertical: [1], horizontal: [] });
  });
});

describe("coordinatePlane prompt visual — complex-plane axis labels", () => {
  test("places Re at the right end of the x-axis and Im at the top of the y-axis", () => {
    const g = coordinatePlaneGeometry(complexPlane);
    expect(g.axisLabels?.x.text).toBe("Re");
    expect(g.axisLabels?.y.text).toBe("Im");
    expect(g.axisLabels!.x.x).toBeGreaterThan(g.plotX + g.plotWidth / 2);
    expect(g.axisLabels!.y.y).toBeLessThan(g.plotY + g.plotHeight / 2);
    expect(coordinatePlaneAccessibilityLabel(complexPlane)).toContain("labeled Re");
  });

  test("a plane without axis labels is unchanged", () => {
    const { axisLabels: _drop, ...plain } = complexPlane;
    expect(coordinatePlaneGeometry(plain).axisLabels).toBeUndefined();
  });
});

async function insertWithPromptVisual(promptVisual: unknown) {
  const t = convexTest(schema, modules);
  return await t.run(async (ctx) =>
    ctx.db.insert("practiceItems", {
      skillKey: "function_plot_test",
      domain: "algebra",
      stem: "Read the graph",
      answerType: "integer",
      answerCanonical: "1",
      promptVisual: promptVisual as PracticePromptVisual,
      source: "test",
      verifiedAt: 1,
    }),
  );
}

describe("prompt visual validator — functionPlot and complex-plane axes", () => {
  test.each([
    ["two transforms", twoCurves],
    ["rational with asymptotes and shading", rational],
    ["polynomial", polynomial],
    ["complex plane", complexPlane],
  ])("accepts %s", async (_name, valid) => {
    await expect(insertWithPromptVisual(valid)).resolves.toBeTruthy();
  });

  test.each([
    ["an unknown parent", { ...twoCurves, curves: [{ form: "transform", parent: "sine", a: 1, h: 0, k: 0 }] }],
    ["a polynomial without a leading coefficient", { ...polynomial, curves: [{ form: "polynomial", zeros: [] }] }],
    ["a string asymptote", { ...rational, asymptotes: { vertical: ["2"] } }],
    ["axis labels that are not strings", { ...complexPlane, axisLabels: { x: 1, y: 2 } }],
  ])("rejects %s", async (_name, malformed) => {
    await expect(insertWithPromptVisual(malformed)).rejects.toThrow();
  });
});

// ── additions: flip, endpoints, arrows, y = x, sketch, holes, three curves ───

const W = { xMin: -6, xMax: 6, yMin: -6, yMax: 6 };
/** Pixel x of math x, read back off a geometry (square units). */
const pxOf = (g: ReturnType<typeof functionPlotGeometry>, x: number) => g.plotX + ((x - W.xMin) / (W.xMax - W.xMin)) * g.plotWidth;
const pyOf = (g: ReturnType<typeof functionPlotGeometry>, y: number) => g.plotY + ((W.yMax - y) / (W.yMax - W.yMin)) * g.plotHeight;
const xsOf = (d: string) => pathNumbers(d).filter((_, i) => i % 2 === 0);

describe("functionPlot — flip left–right", () => {
  test("√(−x) is drawn only left of the y-axis, √x only right", () => {
    const g = functionPlotGeometry(
      makeFunctionPlotPromptVisual({
        ...W,
        curves: [
          { form: "transform", parent: "sqrt", a: 1, h: 0, k: 0, b: -1 },
          { form: "transform", parent: "sqrt", a: 1, h: 0, k: 0 },
        ],
      }),
    );
    const zero = pxOf(g, 0);
    expect(Math.max(...xsOf(g.curves[0].d))).toBeLessThanOrEqual(zero + 0.01);
    expect(Math.min(...xsOf(g.curves[1].d))).toBeGreaterThanOrEqual(zero - 0.01);
  });
});

describe("functionPlot — domain, endpoints and arrows", () => {
  const restricted = makeFunctionPlotPromptVisual({
    ...W,
    curves: [
      { form: "transform", parent: "quadratic", a: 0.5, h: 0, k: -3, domain: { from: -2, to: 3 } },
      { form: "transform", parent: "linear", a: -1, h: 0, k: 4 },
    ],
    points: [
      { x: -2, y: -1 },
      { x: 3, y: 1.5, open: true },
    ],
  });
  const g = functionPlotGeometry(restricted);

  test("a domain stops the curve at its endpoints", () => {
    const xs = xsOf(g.curves[0].d);
    expect(Math.min(...xs)).toBeCloseTo(pxOf(g, -2), 1);
    expect(Math.max(...xs)).toBeCloseTo(pxOf(g, 3), 1);
  });

  test("a curve that stays inside its domain gets no arrows; one that leaves the window gets one per exit", () => {
    expect(g.curves[0].arrows).toEqual([]);
    // y = −x + 4 leaves through the top (at x = −2) and the right edge (x = 6, y = −2)
    expect(g.curves[1].arrows).toHaveLength(2);
    for (const d of g.curves[1].arrows) expect(d).toMatch(/^M[\d.]+ [\d.]+ L[\d.]+ [\d.]+ L[\d.]+ [\d.]+ Z$/);
  });

  test("arrows: false turns them off; a natural start (√ at x = h) never gets one", () => {
    const off = functionPlotGeometry(
      makeFunctionPlotPromptVisual({ ...W, curves: [{ form: "transform", parent: "linear", a: 1, h: 0, k: 0, arrows: false }] }),
    );
    expect(off.curves[0].arrows).toEqual([]);
    const root = functionPlotGeometry(
      makeFunctionPlotPromptVisual({ ...W, curves: [{ form: "transform", parent: "sqrt", a: 1, h: -6, k: 0 }] }),
    );
    // starts on the left window edge at its own domain start: only the right end continues
    expect(root.curves[0].arrows).toHaveLength(1);
  });

  test("open points are hollow; closed points are not", () => {
    expect(g.points.map((p) => p.open)).toEqual([false, true]);
    expect(functionPlotAccessibilityLabel(restricted)).toContain("an open dot at (3, 1.5)");
  });

  test("a three-piece piecewise function keeps all three curves; a fourth is dropped", () => {
    const piece = (k: number, from?: number, to?: number) => ({
      form: "transform" as const,
      parent: "linear" as const,
      a: 0,
      h: 0,
      k,
      domain: { from, to },
    });
    const spec = makeFunctionPlotPromptVisual({
      ...W,
      curves: [piece(1, undefined, -1), piece(2, -1, 2), piece(3, 2), piece(4)],
    });
    expect(spec.curves).toHaveLength(3);
    const geo = functionPlotGeometry(spec);
    expect(geo.curves.map((c) => c.index)).toEqual([0, 1, 2]);
    // the outer pieces run off the window (one arrow each), the middle one doesn't
    expect(geo.curves.map((c) => c.arrows.length)).toEqual([1, 0, 1]);
  });
});

describe("functionPlot — reference line, sketch and holes", () => {
  test("referenceLine y = x runs corner to corner of the square window", () => {
    const g = functionPlotGeometry(
      makeFunctionPlotPromptVisual({ ...W, curves: [{ form: "transform", parent: "exp2", a: 1, h: 0, k: 0 }], referenceLine: "y=x" }),
    );
    expect(g.referenceLine).toEqual({ x1: pxOf(g, -6), y1: pyOf(g, -6), x2: pxOf(g, 6), y2: pyOf(g, 6) });
  });

  test("a polynomial sketch keeps every sign, zero and bounce, and hides the y numbers", () => {
    const zeros = [
      { x: -3, multiplicity: 1 },
      { x: 1, multiplicity: 2 },
      { x: 4, multiplicity: 1 },
    ];
    const spec = makeFunctionPlotPromptVisual({ ...W, curves: [{ form: "polynomial", zeros, leading: 0.125, sketch: true }] });
    const g = functionPlotGeometry(spec);
    expect(g.yTicks).toEqual([]);
    expect(g.xTicks.length).toBeGreaterThan(0);
    expect(functionPlotAccessibilityLabel(spec)).toContain("sketch");
    const nums = pathNumbers(g.curves[0].d);
    const axis = pyOf(g, 0);
    const truth = (x: number) => 0.125 * (x + 3) * (x - 1) ** 2 * (x - 4);
    for (let i = 0; i < nums.length; i += 2) {
      const x = W.xMin + ((nums[i] - g.plotX) / g.plotWidth) * (W.xMax - W.xMin);
      const above = nums[i + 1] < axis - 0.5;
      const below = nums[i + 1] > axis + 0.5;
      if (above) expect(truth(x)).toBeGreaterThan(-1e-6);
      if (below) expect(truth(x)).toBeLessThan(1e-6);
    }
    // it touches the axis at the bounce without crossing it
    const nearBounce = [0.7, 1.3].map((x) => truth(x));
    expect(Math.sign(nearBounce[0])).toBe(Math.sign(nearBounce[1]));
  });

  test("a rational's hole is a hollow dot on the simplified curve", () => {
    const g = functionPlotGeometry(
      makeFunctionPlotPromptVisual({
        ...W,
        curves: [{ form: "rational", rational: { vertical: [2], horizontal: 0, scale: 1, holes: [-1] } }],
      }),
    );
    expect(g.curves[0].holes).toHaveLength(1);
    expect(g.curves[0].holes[0].x).toBeCloseTo(pxOf(g, -1));
    expect(g.curves[0].holes[0].y).toBeCloseTo(pyOf(g, -1 / 3));
  });
});

describe("prompt visual validator — functionPlot additions", () => {
  const full = makeFunctionPlotPromptVisual({
    ...W,
    curves: [
      { form: "transform", parent: "sqrt", a: 1, h: 0, k: 0, b: -1, domain: { to: 0 }, arrows: false, label: "f" },
      { form: "polynomial", zeros: [{ x: 1, multiplicity: 2 }], leading: 1, sketch: true, domain: { from: -2 } },
      { form: "rational", rational: { vertical: [2], horizontal: 0, scale: 1, holes: [-1] } },
    ],
    points: [{ x: 0, y: 0, open: true }],
    referenceLine: "y=x",
  });

  test("accepts every new optional field", async () => {
    await expect(insertWithPromptVisual(full)).resolves.toBeTruthy();
  });

  test.each([
    ["a non-boolean open", { ...full, points: [{ x: 0, y: 0, open: "yes" }] }],
    ["a non-boolean sketch", { ...full, curves: [{ ...full.curves[1], sketch: 1 }] }],
    ["a string domain bound", { ...full, curves: [{ ...full.curves[0], domain: { to: "0" } }] }],
    ["an unknown reference line", { ...full, referenceLine: "y=-x" }],
    ["string holes", { ...full, curves: [{ form: "rational", rational: { vertical: [2], horizontal: 0, scale: 1, holes: ["-1"] } }] }],
  ])("rejects %s", async (_name, malformed) => {
    await expect(insertWithPromptVisual(malformed)).rejects.toThrow();
  });
});
