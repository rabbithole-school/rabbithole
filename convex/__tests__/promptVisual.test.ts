import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import {
  angleFigureGeometry,
  barGraphGeometry,
  compositeRectilinearGeometry,
  coordinatePlaneGeometry,
  labeledRectangleGeometry,
  linePlotGeometry,
  numberLineGeometry,
  makeAngleFigurePromptVisual,
  makeBarGraphPromptVisual,
  makeCompositeRectilinearPromptVisual,
  makeCoordinatePlanePromptVisual,
  makeLabeledRectanglePromptVisual,
  makeLinePlotPromptVisual,
  makeNumberLinePromptVisual,
  makePictographPromptVisual,
  makeRectangularPrismPromptVisual,
  pictographGeometry,
  rectangularPrismGeometry,
  type PracticePromptVisual,
} from "../../shared/practicePromptVisual";
import schema from "../schema";
import { allTemplatedSkillKeys, generateItem } from "../lib/practice/templates";
import { numericValue } from "../lib/practice/answers";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

const labeledRectangle = makeLabeledRectanglePromptVisual({
  width: 6,
  height: 4,
  unit: "cm",
  showUnitGrid: true,
});

const compositeRectilinear = makeCompositeRectilinearPromptVisual({
  rects: [
    { x: 0, y: 0, width: 4, height: 1 },
    { x: 0, y: 1, width: 1, height: 3 },
  ],
  sideLabels: [
    { x1: 0, y1: 0, x2: 4, y2: 0, label: "8 m" },
    { x1: 4, y1: 0, x2: 4, y2: 1 },
  ],
});

const angleFigure = makeAngleFigurePromptVisual({
  degrees: 90,
  orientation: 210,
  label: "?",
  parts: [
    { degrees: 35, label: "35°" },
    { degrees: 55 },
  ],
});

const protractorFigure = makeAngleFigurePromptVisual({
  degrees: 35,
  orientation: 205,
  label: "?",
  showProtractorScale: true,
});

const coordinatePlane = makeCoordinatePlanePromptVisual({
  xMin: -5,
  xMax: 5,
  yMin: -5,
  yMax: 5,
  gridStep: 1,
  points: [
    { x: -2, y: 1, label: "A" },
    { x: 3, y: 4, label: "B" },
    { x: 4, y: -2, label: "C" },
  ],
  connect: "polygon",
});

const rectangularPrism = makeRectangularPrismPromptVisual({
  length: 5,
  width: 3,
  height: 4,
  unit: "in",
  showUnitCubes: true,
});

const pictograph = makePictographPromptVisual({
  rows: [
    { label: "Owls", icons: 3 },
    { label: "Hawks", icons: 2.5 },
  ],
  key: 2,
});

const barGraph = makeBarGraphPromptVisual({
  bars: [
    { label: "Red", value: 6 },
    { label: "Blue" },
    { label: "Gold", value: 4 },
  ],
  scaleMax: 8,
  scaleStep: 2,
  xAxisLabel: "Color",
  yAxisLabel: "Votes",
  missingBarIndex: 1,
});

const linePlot = makeLinePlotPromptVisual({
  values: [2, 2.25, 2.25, 2.5, 2.75],
  axisMin: 2,
  axisMax: 3,
  axisStep: 0.25,
  fractionDenominator: 4,
  axisLabel: "Length (inches)",
  marker: { value: 2.5, label: "Mean" },
});

const twoSeriesLinePlot = makeLinePlotPromptVisual({
  values: [7, 8, 8, 8, 9],
  valuesB: [4, 6, 8, 10, 12],
  seriesALabel: "Set A",
  seriesBLabel: "Set B",
  axisMin: 3,
  axisMax: 13,
  axisStep: 1,
  axisLabel: "Value",
  marker: { value: 8, label: "Mean" },
});

const numberLine = makeNumberLinePromptVisual({
  min: -6,
  max: 6,
  step: 1,
  points: [
    { value: -4, label: "A" },
    { value: 3, label: "B", highlighted: true },
  ],
  interval: {
    from: -2,
    to: 2,
    includeFrom: false,
    includeTo: true,
    label: "|x| < 3",
  },
  unlabeledTicks: [-1],
  axisLabel: "Integers",
});

describe("prompt visuals — deterministic figure geometry", () => {
  test("labeledRectangle returns identical geometry for the same spec", () => {
    const first = labeledRectangleGeometry(labeledRectangle);
    expect(first).toEqual(labeledRectangleGeometry({ ...labeledRectangle }));
    expect(first.gridLines).toHaveLength(8);
  });

  test("compositeRectilinear returns identical geometry for the same spec", () => {
    const first = compositeRectilinearGeometry(compositeRectilinear);
    expect(first).toEqual(compositeRectilinearGeometry({
      ...compositeRectilinear,
      rects: compositeRectilinear.rects.map((rect) => ({ ...rect })),
      sideLabels: compositeRectilinear.sideLabels.map((side) => ({ ...side })),
    }));
    expect(first.cells).toHaveLength(7);
  });

  test("angleFigure returns identical geometry for the same spec", () => {
    const first = angleFigureGeometry(angleFigure);
    expect(first).toEqual(angleFigureGeometry({
      ...angleFigure,
      parts: angleFigure.parts?.map((part) => ({ ...part })),
    }));
    expect(first.rays).toHaveLength(3);
  });

  test("angleFigure with parts nests each part arc inside the total, spanning only its own sub-angle", () => {
    // Regression: part arcs used to share one radius outside the total arc and
    // meet exactly at the divider ray, merging into a second full-span ring —
    // so no arc visibly subtended the labeled part (the "47° arc drawn across
    // the full 70°" defect). Adjacent parts must now sit at different radii so
    // their arcs can never read as one continuous sweep.
    const geometry = angleFigureGeometry(angleFigure);
    const parseArc = (path: string) => {
      const match = path.match(
        /^M (-?[\d.]+) (-?[\d.]+) A (-?[\d.]+) -?[\d.]+ 0 [01] 1 (-?[\d.]+) (-?[\d.]+)$/,
      );
      if (!match) throw new Error(`unexpected arc path: ${path}`);
      const angleOf = (x: number, y: number) =>
        (Math.atan2(y - geometry.vertexY, x - geometry.vertexX) * 180) / Math.PI;
      const normalize = (value: number) => ((value % 360) + 360) % 360;
      return {
        radius: Number(match[3]),
        startDegrees: normalize(angleOf(Number(match[1]), Number(match[2]))),
        endDegrees: normalize(angleOf(Number(match[4]), Number(match[5]))),
      };
    };
    // Spec: 90° total from orientation 210, parts 35° (labeled) + 55°.
    const total = parseArc(geometry.arcPath);
    const [first, second] = geometry.partArcs.map((part) => parseArc(part.path));
    // The total arc spans the whole angle, OUTSIDE both part arcs.
    expect(total.startDegrees).toBeCloseTo(210, 1);
    expect(total.endDegrees).toBeCloseTo(300, 1);
    expect(total.radius).toBeGreaterThan(first.radius);
    expect(total.radius).toBeGreaterThan(second.radius);
    // Each part arc subtends exactly its own sub-angle (35°: 210–245, 55°: 245–300)…
    expect(first.startDegrees).toBeCloseTo(210, 1);
    expect(first.endDegrees).toBeCloseTo(245, 1);
    expect(second.startDegrees).toBeCloseTo(245, 1);
    expect(second.endDegrees).toBeCloseTo(300, 1);
    // …and adjacent part arcs sit at different radii so they can't merge at the divider.
    expect(Math.abs(first.radius - second.radius)).toBeGreaterThanOrEqual(8);
    // The labeled part's label sits on its bisector, between the part and total rings.
    const label = geometry.partArcs[0].label;
    expect(label?.text).toBe("35°");
    const labelRadius = Math.hypot(label!.x - geometry.vertexX, label!.y - 5 - geometry.vertexY);
    const labelAngle =
      (Math.atan2(label!.y - 5 - geometry.vertexY, label!.x - geometry.vertexX) * 180) / Math.PI;
    expect(((labelAngle % 360) + 360) % 360).toBeCloseTo(227.5, 1);
    expect(labelRadius).toBeGreaterThan(first.radius);
    expect(labelRadius).toBeLessThan(total.radius);
    // The total label sits just beyond the total arc, still inside the rays.
    const totalLabel = geometry.totalLabel;
    const totalLabelRadius = Math.hypot(
      totalLabel!.x - geometry.vertexX,
      totalLabel!.y - 5 - geometry.vertexY,
    );
    expect(totalLabelRadius).toBeGreaterThan(total.radius);
    expect(totalLabelRadius).toBeLessThan(94);
  });

  test("angleFigure without parts keeps the compact single-arc layout clear of the protractor band", () => {
    const geometry = angleFigureGeometry(protractorFigure);
    const radius = Number(geometry.arcPath.match(/A (-?[\d.]+)/)?.[1]);
    // The protractor ticks occupy radii 76–86; the angle arc must stay well inside.
    expect(radius).toBeLessThan(76);
  });

  test("angleFigure builds a readable 0–180 protractor scale when requested", () => {
    const scale = angleFigureGeometry(protractorFigure).protractorScale;
    expect(scale).toBeDefined();
    expect(scale?.ticks).toHaveLength(37);
    expect(scale?.ticks.filter((tick) => tick.major)).toHaveLength(19);
    expect(scale?.labels.map((label) => label.text)).toEqual(
      Array.from({ length: 10 }, (_, index) => String(index * 20)),
    );
  });

  test("coordinatePlane returns identical geometry for the same spec", () => {
    const first = coordinatePlaneGeometry(coordinatePlane);
    expect(first).toEqual(coordinatePlaneGeometry({
      ...coordinatePlane,
      points: coordinatePlane.points.map((point) => ({ ...point })),
    }));
    expect(first.closePath).toBe(true);
  });

  test("rectangularPrism returns identical geometry for the same spec", () => {
    const first = rectangularPrismGeometry(rectangularPrism);
    expect(first).toEqual(rectangularPrismGeometry({ ...rectangularPrism }));
    expect(first.subdivisionLines.length).toBeGreaterThan(0);
  });

  test("pictograph returns deterministic rows and a half-icon", () => {
    const first = pictographGeometry(pictograph);
    expect(first).toEqual(pictographGeometry({
      ...pictograph,
      rows: pictograph.rows.map((row) => ({ ...row })),
    }));
    expect(first.icons.filter((icon) => icon.half)).toHaveLength(1);
    expect(first.keyText).toBe("Each ⬤ = 2");
  });

  test("barGraph returns deterministic bars and highlights the missing bar", () => {
    const first = barGraphGeometry(barGraph);
    expect(first).toEqual(barGraphGeometry({
      ...barGraph,
      bars: barGraph.bars.map((bar) => ({ ...bar })),
    }));
    expect(first.bars.filter((bar) => bar.missing).map((bar) => bar.index)).toEqual([1]);
  });

  test("linePlot returns deterministic fractional ticks and a marker", () => {
    const first = linePlotGeometry(linePlot);
    expect(first).toEqual(linePlotGeometry({
      ...linePlot,
      values: [...linePlot.values],
      marker: linePlot.marker ? { ...linePlot.marker } : undefined,
    }));
    expect(first.ticks.map((tick) => tick.text)).toContain("2 1/2");
    expect(first.dots.filter((dot) => dot.value === 2.25)).toHaveLength(2);
    expect(first.marker?.label.text).toBe("Mean");
  });

  test("two-series linePlot stacks each series in its own lane above one shared axis", () => {
    const first = linePlotGeometry(twoSeriesLinePlot);
    expect(first).toEqual(linePlotGeometry({
      ...twoSeriesLinePlot,
      values: [...twoSeriesLinePlot.values],
      valuesB: twoSeriesLinePlot.valuesB ? [...twoSeriesLinePlot.valuesB] : undefined,
      marker: twoSeriesLinePlot.marker ? { ...twoSeriesLinePlot.marker } : undefined,
    }));
    expect(first.dots).toHaveLength(5);
    expect(first.dotsB).toHaveLength(5);
    // Series B anchors to the shared axis; series A anchors to the upper lane
    // baseline, and every A dot sits above every B dot.
    expect(Math.max(...(first.dotsB ?? []).map((dot) => dot.y))).toBe(first.axisY - 14);
    const laneY = first.laneABaseline?.y1 ?? Number.NaN;
    expect(laneY).toBeLessThan(first.axisY);
    expect(Math.max(...first.dots.map((dot) => dot.y))).toBe(laneY - 14);
    for (const dot of first.dotsB ?? []) expect(dot.y).toBeGreaterThan(laneY);
    for (const dot of first.dots) expect(dot.y).toBeLessThan(laneY);
    // Repeated values still stack within a lane (three 8s in series A).
    expect(first.dots.filter((dot) => dot.value === 8)).toHaveLength(3);
    expect(new Set(first.dots.filter((dot) => dot.value === 8).map((dot) => dot.y)).size).toBe(3);
    // The axis covers the union of both series.
    const tickValues = first.ticks.map((tick) => tick.value);
    expect(Math.min(...tickValues)).toBeLessThanOrEqual(4);
    expect(Math.max(...tickValues)).toBeGreaterThanOrEqual(12);
    // Lane labels render in the left gutter, one per series.
    expect(first.seriesLabels?.map((label) => label.text)).toEqual(["Set A", "Set B"]);
    for (const label of first.seriesLabels ?? []) {
      expect(label.x).toBeLessThan(first.axisX1);
    }
    // Single-series geometry is unchanged: no lane artifacts.
    const single = linePlotGeometry(linePlot);
    expect(single.dotsB).toBeUndefined();
    expect(single.laneABaseline).toBeUndefined();
    expect(single.seriesLabels).toBeUndefined();
    expect(single.axisX1).toBe(34);
  });

  test("numberLine returns deterministic negative ticks, points, and interval shading", () => {
    const first = numberLineGeometry(numberLine);
    expect(first).toEqual(numberLineGeometry({
      ...numberLine,
      points: numberLine.points?.map((point) => ({ ...point })),
      interval: numberLine.interval ? { ...numberLine.interval } : undefined,
      unlabeledTicks: numberLine.unlabeledTicks ? [...numberLine.unlabeledTicks] : undefined,
    }));
    expect(first.ticks.find((tick) => tick.value === -1)?.labeled).toBe(false);
    expect(first.points.find((point) => point.value === 3)?.highlighted).toBe(true);
    expect(first.interval).toMatchObject({ includeFrom: false, includeTo: true });
  });
});

const validatorCases: Array<{
  name: string;
  valid: PracticePromptVisual;
  malformed: unknown;
}> = [
  {
    name: "labeledRectangle",
    valid: labeledRectangle,
    malformed: { kind: "labeledRectangle", width: 6, height: 4, unit: "cm" },
  },
  {
    name: "compositeRectilinear",
    valid: compositeRectilinear,
    malformed: {
      ...compositeRectilinear,
      rects: [{ x: 0, y: 0, width: "four", height: 1 }],
    },
  },
  {
    name: "angleFigure",
    valid: angleFigure,
    malformed: { kind: "angleFigure", degrees: 90 },
  },
  {
    name: "coordinatePlane",
    valid: coordinatePlane,
    malformed: { ...coordinatePlane, connect: "curve" },
  },
  {
    name: "rectangularPrism",
    valid: rectangularPrism,
    malformed: { ...rectangularPrism, unit: 12 },
  },
  {
    name: "pictograph",
    valid: pictograph,
    malformed: { ...pictograph, rows: [{ label: "Owls", icons: "three" }] },
  },
  {
    name: "barGraph",
    valid: barGraph,
    malformed: { ...barGraph, missingBarIndex: "one" },
  },
  {
    name: "linePlot",
    valid: linePlot,
    malformed: { ...linePlot, fractionDenominator: 3 },
  },
  {
    name: "two-series linePlot",
    valid: twoSeriesLinePlot,
    malformed: { ...twoSeriesLinePlot, valuesB: "4, 6, 8, 10, 12" },
  },
  {
    name: "numberLine",
    valid: numberLine,
    malformed: { ...numberLine, interval: { ...numberLine.interval, includeFrom: "sometimes" } },
  },
];

async function insertWithPromptVisual(promptVisual: unknown) {
  const t = convexTest(schema, modules);
  return await t.run(async (ctx) =>
    ctx.db.insert("practiceItems", {
      skillKey: "geometry_test",
      domain: "geometry",
      stem: "Test figure",
      answerType: "integer",
      answerCanonical: "1",
      promptVisual: promptVisual as PracticePromptVisual,
      source: "test",
      verifiedAt: 1,
    }),
  );
}

describe("prompt visual validator — geometry and data-display kinds", () => {
  test.each(validatorCases)("accepts $name", async ({ valid }) => {
    await expect(insertWithPromptVisual(valid)).resolves.toBeTruthy();
  });

  test.each(validatorCases)("rejects malformed $name", async ({ malformed }) => {
    await expect(insertWithPromptVisual(malformed)).rejects.toThrow();
  });
});

// A number-line prompt plots dots on a tick-labelled axis. If a template marks
// the question's UNKNOWN with a "?"-labelled dot AT its own correct position,
// the axis quietly answers the question: the scholar reads the value off the
// labelled tick under the "?", and numberLineAccessibilityLabel literally speaks
// "? at -3 highlighted". So a "?"-labelled point must NEVER land on the item's
// numeric answer — plot only what is KNOWN. (A NON-"?" point sitting on the
// answer is fine and expected: for integers_on_number_line /
// signed_rationals_on_number_line, reading the plotted point IS the task.)
describe("number-line templates never print the answer under a '?'", () => {
  test("no '?'-labelled point sits at the numeric answer, across every template", () => {
    const legitPointAtAnswer = new Set<string>();
    for (const skillKey of allTemplatedSkillKeys()) {
      for (let seed = 1; seed <= 60; seed++) {
        const item = generateItem(skillKey, seed);
        if (item?.promptVisual?.kind !== "numberLine") continue;
        const answer = numericValue(item.answer);
        if (!Number.isFinite(answer)) continue;
        for (const point of item.promptVisual.points ?? []) {
          const atAnswer = Math.abs(point.value - answer) < 1e-6;
          if (!atAnswer) continue;
          const label = point.label ?? "";
          // BANNED: a "?"-labelled dot on the answer prints it on screen.
          expect(
            label.includes("?"),
            `${skillKey} seed ${seed} plots a "?"-labelled point at the answer ` +
              `${answer} — readable straight off the labelled axis and spoken by ` +
              `the a11y label. Stem: ${item.stem}`,
          ).toBe(false);
          // ALLOWED: a known/labelled dot on the answer is the whole exercise
          // for "read the plotted point" templates; the general case is not banned.
          legitPointAtAnswer.add(skillKey);
        }
      }
    }
    // Guard against a vacuous test: the reading-the-point templates genuinely do
    // plot a (non-"?") point at the answer, proving the "?"-only ban is the point.
    const legit = [...legitPointAtAnswer];
    expect(legit).toContain("integers_on_number_line");
    expect(legit).toContain("signed_rationals_on_number_line");
  });
});
