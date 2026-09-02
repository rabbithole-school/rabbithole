// A GeometryLabel's (or tick's) `text` is sometimes a plain-ASCII fraction or
// mixed number ("2 1/2", formatAxisValue's output) — the SAME notation the
// stem's FractionText stacks into a proper numerator/vinculum/denominator
// glyph. SVG/RNSVG have no flexbox, so `layoutFractionLabel` below computes an
// EQUIVALENT absolute layout (see the bottom of this file) using the same
// direct parser (`./fractions`) FractionText uses, so both the stem and every
// figure's in-visual numerals read identically.
import { hasFraction, parseFractions, type FractionNode } from "./fractions";

/**
 * Font size for a practice card's STEM text, shared by the web
 * (`VerdictStemCard`) and native (`StemCard`) cards so the two can't drift.
 * `LG` is the "Fast math" bare-fact retrieval treatment — a single-digit fact
 * reads as an instant, focused recall prompt (the tactile FastMath feel); `SM`
 * is the ordinary wordy-card size. Lives here because this is the shared
 * practice-stem-visual module both cards already import (and it vendors to
 * native), so a font size can't fork.
 */
export const STEM_FONT_SM = 28;
export const STEM_FONT_LG = 46;

export type CountablesLayout = "scatter" | "grid" | "tenframe";

export type CountablesPromptVisual = {
  kind: "countables";
  /** Count shown in the prompt visual. This is prompt data, not a grading answer. */
  n: number;
  /** Renderer knob for future gen-art motifs; unknown motifs fall back to dots. */
  motif: string;
  layout: CountablesLayout;
  /** Deterministic layout jitter seed, mainly for scatter. */
  seed: number;
};

export type GroupsPromptVisual = {
  kind: "groups";
  groups: number;
  perGroup: number;
  /** Renderer knob for future gen-art motifs; unknown motifs fall back to dots. */
  motif: string;
  /** Deterministic layout jitter seed for within-box placement. */
  seed: number;
};

export type ArrayPromptVisual = {
  kind: "array";
  rows: number;
  cols: number;
  /** Renderer knob for future gen-art motifs; unknown motifs fall back to dots. */
  motif: string;
};

export type AreaModelPromptVisual = {
  kind: "areamodel";
  /** Horizontal factor decomposed left-to-right, e.g. [30, 4]. */
  widthParts: number[];
  /** Vertical factor decomposed top-to-bottom, e.g. [10, 2]. */
  heightParts: number[];
};

export type FractionPartPromptVisual = {
  kind: "fractionpart";
  parts: number;
  shaded: number;
  shape: "bar" | "circle";
};

export type ClockfacePromptVisual = {
  kind: "clockface";
  hours: 12;
  /** Prompt orientation mark, e.g. the start hour in a clock-addition item. */
  highlightHour?: number;
};

export type LabeledRectanglePromptVisual = {
  /** Discriminator for a side-labeled rectangle figure. */
  kind: "labeledRectangle";
  /** Horizontal side length, shown beneath the rectangle. */
  width: number;
  /** Vertical side length, shown beside the rectangle. */
  height: number;
  /** Unit suffix used by both side labels, e.g. "cm". */
  unit: string;
  /** Whether to divide the rectangle into visible one-by-one unit squares. */
  showUnitGrid: boolean;
};

export type RectilinearUnitRect = {
  /** Left edge in shared unit coordinates. */
  x: number;
  /** Top edge in shared unit coordinates. */
  y: number;
  /** Width in whole units. */
  width: number;
  /** Height in whole units. */
  height: number;
};

export type RectilinearSideLabel = {
  /** Horizontal coordinate of the side's first endpoint. */
  x1: number;
  /** Vertical coordinate of the side's first endpoint. */
  y1: number;
  /** Horizontal coordinate of the side's second endpoint. */
  x2: number;
  /** Vertical coordinate of the side's second endpoint. */
  y2: number;
  /** Exact displayed label, including units; omit for an intentionally unknown side. */
  label?: string;
};

export type CompositeRectilinearPromptVisual = {
  /** Discriminator for a composite rectilinear figure. */
  kind: "compositeRectilinear";
  /** Axis-aligned unit rectangles whose union forms the L- or T-shaped figure. */
  rects: RectilinearUnitRect[];
  /** Outer side segments, including intentionally unlabeled segments when needed. */
  sideLabels: RectilinearSideLabel[];
};

export type AnglePart = {
  /** Size of this consecutive sub-angle in degrees. */
  degrees: number;
  /** Known-angle text shown inside this part; omit for an unknown part. */
  label?: string;
};

export type AngleFigurePromptVisual = {
  /** Discriminator for a ray-and-arc angle figure. */
  kind: "angleFigure";
  /** Total angle between the two outside rays, in degrees. */
  degrees: number;
  /** Direction of the first ray in SVG degrees: 0 points right, positive turns clockwise. */
  orientation: number;
  /** Optional label for the total angle, e.g. "?" or "75°". */
  label?: string;
  /** Optional consecutive sub-angles used for angle-additivity figures. */
  parts?: AnglePart[];
  /** Draw a 0–180° scale aligned to the first ray for protractor-reading items. */
  showProtractorScale?: boolean;
};

export type CoordinatePoint = {
  /** Cartesian x-coordinate. */
  x: number;
  /** Cartesian y-coordinate. */
  y: number;
  /** Short point name displayed beside the marker. */
  label: string;
};

export type CoordinatePlanePromptVisual = {
  /** Discriminator for a Cartesian coordinate-plane figure. */
  kind: "coordinatePlane";
  /** Inclusive minimum horizontal axis value. */
  xMin: number;
  /** Inclusive maximum horizontal axis value. */
  xMax: number;
  /** Inclusive minimum vertical axis value. */
  yMin: number;
  /** Inclusive maximum vertical axis value. */
  yMax: number;
  /** Distance between adjacent grid lines on both axes. */
  gridStep: number;
  /** Labeled points plotted in the given order. */
  points: CoordinatePoint[];
  /** Optional path through the listed points; polygon closes back to the first point. */
  connect?: "segments" | "polygon";
};

export type RectangularPrismPromptVisual = {
  /** Discriminator for an isometric rectangular-prism figure. */
  kind: "rectangularPrism";
  /** Left-to-right edge length. */
  length: number;
  /** Receding edge length. */
  width: number;
  /** Vertical edge length. */
  height: number;
  /** Unit suffix used by all three edge labels, e.g. "in". */
  unit: string;
  /** Whether visible faces show one-unit cube subdivision lines. */
  showUnitCubes: boolean;
};

export type PictographRow = {
  /** Category label shown at the left of the row. */
  label: string;
  /** Number of displayed icons; halves are represented with a .5 value. */
  icons: number;
};

export type PictographPromptVisual = {
  kind: "pictograph";
  rows: PictographRow[];
  /** Quantity represented by one complete icon. */
  key: number;
};

export type BarGraphBar = {
  /** Category label shown beneath the bar. */
  label: string;
  /** Bar value; omitted for an intentionally missing bar. */
  value?: number;
};

export type BarGraphPromptVisual = {
  kind: "barGraph";
  bars: BarGraphBar[];
  scaleMax: number;
  scaleStep: number;
  xAxisLabel: string;
  yAxisLabel: string;
  /** Index of an intentionally missing bar, highlighted with a question mark. */
  missingBarIndex?: number;
};

export type LinePlotMarker = {
  value: number;
  label: string;
};

export type LinePlotPromptVisual = {
  kind: "linePlot";
  /** One entry per observation; repeated values become stacked dots. */
  values: number[];
  /**
   * Optional second dot series. When present, the plot renders two labeled
   * lanes over the same axis: `values` stacks from an upper baseline and
   * `valuesB` stacks from the shared axis, so the two distributions can be
   * compared side by side.
   */
  valuesB?: number[];
  /** Lane label for the first series (e.g. "Set A"); used only with valuesB. */
  seriesALabel?: string;
  /** Lane label for the second series (e.g. "Set B"); used only with valuesB. */
  seriesBLabel?: string;
  axisMin: number;
  axisMax: number;
  axisStep: number;
  /** Renders axis labels as halves or fourths instead of decimals. */
  fractionDenominator?: 2 | 4;
  axisLabel: string;
  /** Optional reference point, such as the mean-as-balance-point marker. */
  marker?: LinePlotMarker;
};

export type NumberLinePoint = {
  /** Numeric location of the point. */
  value: number;
  /** Optional short label displayed above the point. */
  label?: string;
  /** Whether the point should receive the warm emphasis treatment. */
  highlighted?: boolean;
};

export type NumberLineInterval = {
  /** Left endpoint of the shaded interval. */
  from: number;
  /** Right endpoint of the shaded interval. */
  to: number;
  /** Whether the left endpoint is included. */
  includeFrom: boolean;
  /** Whether the right endpoint is included. */
  includeTo: boolean;
  /** Optional short label displayed above the interval. */
  label?: string;
};

export type NumberLinePromptVisual = {
  kind: "numberLine";
  /** Inclusive minimum displayed value; negative-only ranges are supported. */
  min: number;
  /** Inclusive maximum displayed value. */
  max: number;
  /** Distance between adjacent tick marks. */
  step: number;
  /** Renders tick labels as halves or fourths instead of decimals. */
  fractionDenominator?: 2 | 4;
  /** Optional labeled or emphasized points. */
  points?: NumberLinePoint[];
  /** Optional shaded interval with open or closed endpoints. */
  interval?: NumberLineInterval;
  /** Tick values whose marks remain visible while their numeric labels are hidden. */
  unlabeledTicks?: number[];
  /** Optional caption centered beneath the number line. */
  axisLabel?: string;
};

export type PracticePromptVisual =
  | CountablesPromptVisual
  | GroupsPromptVisual
  | ArrayPromptVisual
  | AreaModelPromptVisual
  | FractionPartPromptVisual
  | ClockfacePromptVisual
  | LabeledRectanglePromptVisual
  | CompositeRectilinearPromptVisual
  | AngleFigurePromptVisual
  | CoordinatePlanePromptVisual
  | RectangularPrismPromptVisual
  | PictographPromptVisual
  | BarGraphPromptVisual
  | LinePlotPromptVisual
  | NumberLinePromptVisual;

export type CountablePoint = {
  index: number;
  x: number;
  y: number;
  r: number;
  rotation: number;
  scale: number;
};

export type TenFrameCell = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type CountablesGeometry = {
  width: number;
  height: number;
  points: CountablePoint[];
  tenFrameCells: TenFrameCell[];
};

export type GroupBox = {
  index: number;
  x: number;
  y: number;
  width: number;
  height: number;
};

export type GroupsGeometry = {
  width: number;
  height: number;
  boxes: GroupBox[];
  points: CountablePoint[];
};

export type ArrayGeometry = {
  width: number;
  height: number;
  points: CountablePoint[];
};

export type AreaModelCell = {
  row: number;
  col: number;
  x: number;
  y: number;
  width: number;
  height: number;
  label: string;
};

export type AreaModelLabel = {
  index: number;
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
};

export type AreaModelGeometry = {
  width: number;
  height: number;
  gridX: number;
  gridY: number;
  gridWidth: number;
  gridHeight: number;
  cells: AreaModelCell[];
  topLabels: AreaModelLabel[];
  sideLabels: AreaModelLabel[];
};

export type FractionPartSegment = {
  index: number;
  shaded: boolean;
  x: number;
  y: number;
  width: number;
  height: number;
  path?: string;
};

export type FractionPartGeometry = {
  width: number;
  height: number;
  segments: FractionPartSegment[];
  centerX?: number;
  centerY?: number;
  radius?: number;
};

export type ClockTick = {
  hour: number;
  x: number;
  y: number;
  labelX: number;
  labelY: number;
  highlighted: boolean;
};

export type ClockfaceGeometry = {
  width: number;
  height: number;
  centerX: number;
  centerY: number;
  radius: number;
  ticks: ClockTick[];
};

export type GeometryLine = {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
};

export type GeometryLabel = {
  text: string;
  x: number;
  y: number;
  rotation?: number;
};

/** One positioned piece of a fraction-aware label (see `layoutFractionLabel`). */
export type FractionLabelRun =
  | { kind: "text"; text: string; x: number; y: number }
  | {
      kind: "fraction";
      num: string;
      den: string;
      /** Horizontal center shared by the numerator, vinculum, and denominator. */
      x: number;
      numY: number;
      denY: number;
      barX1: number;
      barX2: number;
      barY: number;
      /** Font size for the numerator/denominator glyphs (smaller than the label's base size). */
      innerFontSize: number;
    };

/**
 * A label ready to render: `"plain"` for the common (no-fraction) case — draw
 * ONE text node exactly as before — or `"runs"` for a fraction-bearing label,
 * a deterministic left-to-right row of text/fraction runs whose combined
 * width is centered on the label's original anchor point.
 */
export type FractionLabelLayout =
  | { kind: "plain"; text: string; x: number; y: number }
  | { kind: "runs"; runs: FractionLabelRun[] };

export type LabeledRectangleGeometry = {
  width: number;
  height: number;
  rectX: number;
  rectY: number;
  rectWidth: number;
  rectHeight: number;
  gridLines: GeometryLine[];
  labels: GeometryLabel[];
};

export type RectilinearCell = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type CompositeRectilinearGeometry = {
  width: number;
  height: number;
  cells: RectilinearCell[];
  boundaryLines: GeometryLine[];
  labels: GeometryLabel[];
};

export type AnglePartArc = {
  index: number;
  path: string;
  label?: GeometryLabel;
};

export type AngleFigureGeometry = {
  width: number;
  height: number;
  vertexX: number;
  vertexY: number;
  rays: GeometryLine[];
  arcPath: string;
  totalLabel?: GeometryLabel;
  partArcs: AnglePartArc[];
  protractorScale?: {
    arcPath: string;
    baseline: GeometryLine;
    ticks: Array<GeometryLine & { degrees: number; major: boolean }>;
    labels: GeometryLabel[];
  };
};

export type CoordinateGridLine = GeometryLine & {
  value: number;
  axis: boolean;
};

export type CoordinateTick = {
  value: number;
  text: string;
  x: number;
  y: number;
};

export type CoordinatePlotPoint = CoordinatePoint & {
  index: number;
  plotX: number;
  plotY: number;
  labelX: number;
  labelY: number;
};

export type CoordinatePlaneGeometry = {
  width: number;
  height: number;
  plotX: number;
  plotY: number;
  plotWidth: number;
  plotHeight: number;
  verticalLines: CoordinateGridLine[];
  horizontalLines: CoordinateGridLine[];
  xTicks: CoordinateTick[];
  yTicks: CoordinateTick[];
  points: CoordinatePlotPoint[];
  path?: string;
  closePath: boolean;
};

export type PrismEdge = GeometryLine & {
  dashed: boolean;
};

export type RectangularPrismGeometry = {
  width: number;
  height: number;
  vertices: { x: number; y: number }[];
  edges: PrismEdge[];
  subdivisionLines: GeometryLine[];
  labels: GeometryLabel[];
};

export type PictographIcon = {
  rowIndex: number;
  iconIndex: number;
  x: number;
  y: number;
  radius: number;
  half: boolean;
};

export type PictographGeometry = {
  width: number;
  height: number;
  rows: Array<{ index: number; label: string; x: number; y: number }>;
  icons: PictographIcon[];
  keyIconX: number;
  keyIconY: number;
  keyText: string;
  keyTextX: number;
};

export type BarGraphBarGeometry = {
  index: number;
  label: string;
  value?: number;
  x: number;
  y: number;
  width: number;
  height: number;
  missing: boolean;
};

export type BarGraphGeometry = {
  width: number;
  height: number;
  plotX: number;
  plotY: number;
  plotWidth: number;
  plotHeight: number;
  gridLines: Array<GeometryLine & { value: number }>;
  yTicks: CoordinateTick[];
  bars: BarGraphBarGeometry[];
  axisLabels: GeometryLabel[];
};

export type LinePlotDot = {
  index: number;
  value: number;
  stack: number;
  x: number;
  y: number;
  radius: number;
};

export type LinePlotTick = CoordinateTick & {
  tickTop: number;
  tickBottom: number;
};

export type LinePlotGeometry = {
  width: number;
  height: number;
  axisX1: number;
  axisX2: number;
  axisY: number;
  ticks: LinePlotTick[];
  /** First-series dots; in a two-series plot they stack from laneABaseline. */
  dots: LinePlotDot[];
  /** Second-series dots, stacked from the shared axis (two-series plots only). */
  dotsB?: LinePlotDot[];
  /** Upper-lane baseline the first series stacks from (two-series plots only). */
  laneABaseline?: GeometryLine;
  /** Lane labels for [series A, series B] (two-series plots only). */
  seriesLabels?: [GeometryLabel, GeometryLabel];
  axisLabel: GeometryLabel;
  marker?: { x: number; y1: number; y2: number; label: GeometryLabel };
};

export type NumberLineTick = LinePlotTick & {
  labeled: boolean;
};

export type NumberLinePointGeometry = {
  index: number;
  value: number;
  x: number;
  y: number;
  radius: number;
  highlighted: boolean;
  label?: GeometryLabel;
};

export type NumberLineIntervalGeometry = {
  x: number;
  y: number;
  width: number;
  height: number;
  fromX: number;
  toX: number;
  includeFrom: boolean;
  includeTo: boolean;
  label?: GeometryLabel;
};

export type NumberLineGeometry = {
  width: number;
  height: number;
  axisX1: number;
  axisX2: number;
  axisY: number;
  arrowPaths: string[];
  ticks: NumberLineTick[];
  points: NumberLinePointGeometry[];
  interval?: NumberLineIntervalGeometry;
  axisLabel?: GeometryLabel;
};

export function makeCountablesPromptVisual({
  n,
  motif = "dot",
  layout,
  seed,
}: {
  n: number;
  motif?: string;
  layout: CountablesLayout;
  seed: number;
}): CountablesPromptVisual {
  return { kind: "countables", n, motif, layout, seed: seed >>> 0 };
}

export function makeGroupsPromptVisual({
  groups,
  perGroup,
  motif = "dot",
  seed,
}: {
  groups: number;
  perGroup: number;
  motif?: string;
  seed: number;
}): GroupsPromptVisual {
  return {
    kind: "groups",
    groups: clampInt(groups, 1, 8),
    perGroup: clampInt(perGroup, 1, 12),
    motif,
    seed: seed >>> 0,
  };
}

export function makeArrayPromptVisual({
  rows,
  cols,
  motif = "dot",
}: {
  rows: number;
  cols: number;
  motif?: string;
}): ArrayPromptVisual {
  return { kind: "array", rows: clampInt(rows, 1, 10), cols: clampInt(cols, 1, 10), motif };
}

export function makeAreaModelPromptVisual({
  widthParts,
  heightParts,
}: {
  widthParts: number[];
  heightParts: number[];
}): AreaModelPromptVisual {
  return {
    kind: "areamodel",
    widthParts: sanitizeParts(widthParts, 2),
    heightParts: sanitizeParts(heightParts, 2),
  };
}

export function makeFractionPartPromptVisual({
  parts,
  shaded,
  shape,
}: {
  parts: number;
  shaded: number;
  shape: "bar" | "circle";
}): FractionPartPromptVisual {
  const safeParts = clampInt(parts, 2, 12);
  return { kind: "fractionpart", parts: safeParts, shaded: clampInt(shaded, 0, safeParts), shape };
}

export function makeClockfacePromptVisual({
  highlightHour,
}: {
  highlightHour?: number;
} = {}): ClockfacePromptVisual {
  return {
    kind: "clockface",
    hours: 12,
    highlightHour: highlightHour === undefined ? undefined : normalizeHour(highlightHour),
  };
}

export function makeLabeledRectanglePromptVisual({
  width,
  height,
  unit,
  showUnitGrid,
}: Omit<LabeledRectanglePromptVisual, "kind">): LabeledRectanglePromptVisual {
  return {
    kind: "labeledRectangle",
    width: sanitizeDimension(width, showUnitGrid),
    height: sanitizeDimension(height, showUnitGrid),
    unit,
    showUnitGrid,
  };
}

export function makeCompositeRectilinearPromptVisual({
  rects,
  sideLabels,
}: Omit<CompositeRectilinearPromptVisual, "kind">): CompositeRectilinearPromptVisual {
  return {
    kind: "compositeRectilinear",
    rects: sanitizeUnitRects(rects),
    sideLabels: sideLabels.slice(0, 20).map((side) => ({
      x1: clampInt(side.x1, -24, 24),
      y1: clampInt(side.y1, -24, 24),
      x2: clampInt(side.x2, -24, 24),
      y2: clampInt(side.y2, -24, 24),
      label: side.label,
    })),
  };
}

export function makeAngleFigurePromptVisual({
  degrees,
  orientation,
  label,
  parts,
  showProtractorScale,
}: Omit<AngleFigurePromptVisual, "kind">): AngleFigurePromptVisual {
  const safeDegrees = clampNumber(degrees, 1, 180);
  return {
    kind: "angleFigure",
    degrees: safeDegrees,
    orientation: normalizeDegrees(orientation),
    label,
    parts: sanitizeAngleParts(parts, safeDegrees),
    showProtractorScale,
  };
}

export function makeCoordinatePlanePromptVisual({
  xMin,
  xMax,
  yMin,
  yMax,
  gridStep,
  points,
  connect,
}: Omit<CoordinatePlanePromptVisual, "kind">): CoordinatePlanePromptVisual {
  const [safeXMin, safeXMax] = sanitizeAxisRange(xMin, xMax);
  const [safeYMin, safeYMax] = sanitizeAxisRange(yMin, yMax);
  const maxStep = Math.max(safeXMax - safeXMin, safeYMax - safeYMin);
  const minStep = Math.max(0.25, maxStep / 20);
  return {
    kind: "coordinatePlane",
    xMin: safeXMin,
    xMax: safeXMax,
    yMin: safeYMin,
    yMax: safeYMax,
    gridStep: clampNumber(gridStep, minStep, maxStep),
    points: points.slice(0, 12).map((point) => ({
      x: clampNumber(point.x, safeXMin, safeXMax),
      y: clampNumber(point.y, safeYMin, safeYMax),
      label: point.label,
    })),
    connect,
  };
}

export function makeRectangularPrismPromptVisual({
  length,
  width,
  height,
  unit,
  showUnitCubes,
}: Omit<RectangularPrismPromptVisual, "kind">): RectangularPrismPromptVisual {
  return {
    kind: "rectangularPrism",
    length: sanitizeDimension(length, showUnitCubes),
    width: sanitizeDimension(width, showUnitCubes),
    height: sanitizeDimension(height, showUnitCubes),
    unit,
    showUnitCubes,
  };
}

export function makePictographPromptVisual({
  rows,
  key,
}: Omit<PictographPromptVisual, "kind">): PictographPromptVisual {
  const safeRows = rows.slice(0, 5).map((row, index) => ({
    label: sanitizeGraphLabel(row.label, `Category ${index + 1}`),
    icons: Math.round(clampNumber(row.icons, 0, 7) * 2) / 2,
  }));
  return {
    kind: "pictograph",
    rows: safeRows.length > 0 ? safeRows : [{ label: "Category 1", icons: 0 }],
    key: clampInt(key, 1, 20),
  };
}

export function makeBarGraphPromptVisual({
  bars,
  scaleMax,
  scaleStep,
  xAxisLabel,
  yAxisLabel,
  missingBarIndex,
}: Omit<BarGraphPromptVisual, "kind">): BarGraphPromptVisual {
  const safeBars = bars.slice(0, 5).map((bar, index) => ({
    label: sanitizeGraphLabel(bar.label, `Category ${index + 1}`),
    value: bar.value === undefined ? undefined : clampNumber(bar.value, 0, 100),
  }));
  const normalizedBars = safeBars.length > 0 ? safeBars : [{ label: "Category 1", value: 0 }];
  const greatestValue = Math.max(1, ...normalizedBars.map((bar) => bar.value ?? 0));
  const safeScaleMax = Math.max(greatestValue, clampNumber(scaleMax, 1, 100));
  const safeStep = clampNumber(scaleStep, Math.max(0.5, safeScaleMax / 10), safeScaleMax);
  const safeMissingIndex = missingBarIndex === undefined
    ? undefined
    : clampInt(missingBarIndex, 0, normalizedBars.length - 1);
  return {
    kind: "barGraph",
    bars: normalizedBars,
    scaleMax: safeScaleMax,
    scaleStep: safeStep,
    xAxisLabel: sanitizeGraphLabel(xAxisLabel, "Category", 28),
    yAxisLabel: sanitizeGraphLabel(yAxisLabel, "Count", 28),
    missingBarIndex: safeMissingIndex,
  };
}

export function makeLinePlotPromptVisual({
  values,
  valuesB,
  seriesALabel,
  seriesBLabel,
  axisMin,
  axisMax,
  axisStep,
  fractionDenominator,
  axisLabel,
  marker,
}: Omit<LinePlotPromptVisual, "kind">): LinePlotPromptVisual {
  const [safeMin, safeMax] = sanitizeAxisRange(axisMin, axisMax);
  const denominator = fractionDenominator ?? 1;
  const minimumStep = Math.max(
    1 / denominator,
    Math.ceil(((safeMax - safeMin) / 12) * denominator) / denominator,
  );
  const safeStep = clampNumber(axisStep, minimumStep, safeMax - safeMin);
  const snap = (value: number) => snapAxisValue(value, safeMin, safeMax, safeStep);
  const hasSecondSeries = valuesB !== undefined && valuesB.length > 0;
  return {
    kind: "linePlot",
    values: values.slice(0, 30).map(snap),
    valuesB: hasSecondSeries ? valuesB.slice(0, 30).map(snap) : undefined,
    seriesALabel: hasSecondSeries
      ? sanitizeGraphLabel(seriesALabel ?? "Set A", "Set A", 12)
      : undefined,
    seriesBLabel: hasSecondSeries
      ? sanitizeGraphLabel(seriesBLabel ?? "Set B", "Set B", 12)
      : undefined,
    axisMin: safeMin,
    axisMax: safeMax,
    axisStep: safeStep,
    fractionDenominator,
    axisLabel: sanitizeGraphLabel(axisLabel, "Value", 30),
    marker: marker
      ? {
          value: snap(marker.value),
          label: sanitizeGraphLabel(marker.label, "Marker", 20),
        }
      : undefined,
  };
}

export function makeNumberLinePromptVisual({
  min,
  max,
  step,
  fractionDenominator,
  points,
  interval,
  unlabeledTicks,
  axisLabel,
}: Omit<NumberLinePromptVisual, "kind">): NumberLinePromptVisual {
  const [safeMin, safeMax] = sanitizeAxisRange(min, max);
  const denominator = fractionDenominator ?? 1;
  const minimumStep = Math.max(
    1 / denominator,
    Math.ceil(((safeMax - safeMin) / 20) * denominator) / denominator,
  );
  const safeStep = clampNumber(step, minimumStep, safeMax - safeMin);
  const snap = (value: number) => snapAxisValue(value, safeMin, safeMax, safeStep);
  const safePoints = points?.slice(0, 12).map((point) => ({
    value: snap(point.value),
    label: point.label ? sanitizeGraphLabel(point.label, "", 12) : undefined,
    highlighted: point.highlighted,
  }));
  const safeInterval = interval
    ? {
        from: Math.min(snap(interval.from), snap(interval.to)),
        to: Math.max(snap(interval.from), snap(interval.to)),
        includeFrom: interval.includeFrom,
        includeTo: interval.includeTo,
        label: interval.label ? sanitizeGraphLabel(interval.label, "", 20) : undefined,
      }
    : undefined;
  const safeUnlabeledTicks = [...new Set((unlabeledTicks ?? []).slice(0, 12).map(snap))];
  return {
    kind: "numberLine",
    min: safeMin,
    max: safeMax,
    step: safeStep,
    fractionDenominator,
    points: safePoints && safePoints.length > 0 ? safePoints : undefined,
    interval: safeInterval,
    unlabeledTicks: safeUnlabeledTicks.length > 0 ? safeUnlabeledTicks : undefined,
    axisLabel: axisLabel ? sanitizeGraphLabel(axisLabel, "Number line", 30) : undefined,
  };
}

export function isCountablesPromptVisual(
  visual: PracticePromptVisual | null | undefined,
): visual is CountablesPromptVisual {
  return visual?.kind === "countables";
}

export function countablesMotifName(motif: string, n: number): string {
  const normalized = motif.trim().toLowerCase();
  if (!normalized || normalized === "dot") return n === 1 ? "dot" : "dots";
  const words = normalized.replace(/[-_]+/g, " ");
  if (n === 1) return words;
  if (words.endsWith("y")) return `${words.slice(0, -1)}ies`;
  if (words.endsWith("s")) return words;
  return `${words}s`;
}

export function countablesAccessibilityLabel(spec: CountablesPromptVisual): string {
  return `${spec.n} ${countablesMotifName(spec.motif, spec.n)} arranged in a ${spec.layout} counting picture.`;
}

export function groupsAccessibilityLabel(spec: GroupsPromptVisual): string {
  return `${spec.groups} equal groups with ${spec.perGroup} ${countablesMotifName(spec.motif, spec.perGroup)} in each group.`;
}

export function arrayAccessibilityLabel(spec: ArrayPromptVisual): string {
  return `${spec.rows} rows and ${spec.cols} columns of ${countablesMotifName(spec.motif, spec.rows * spec.cols)}.`;
}

export function areaModelAccessibilityLabel(spec: AreaModelPromptVisual): string {
  return `Area model with width ${spec.widthParts.join(" plus ")} and height ${spec.heightParts.join(" plus ")}.`;
}

export function fractionPartAccessibilityLabel(spec: FractionPartPromptVisual): string {
  return `${spec.shape} split into ${spec.parts} equal parts with ${spec.shaded} shaded.`;
}

export function clockfaceAccessibilityLabel(spec: ClockfacePromptVisual): string {
  return spec.highlightHour
    ? `12-hour clock face with ${spec.highlightHour} o'clock highlighted.`
    : "12-hour clock face.";
}

export function labeledRectangleAccessibilityLabel(spec: LabeledRectanglePromptVisual): string {
  const grid = spec.showUnitGrid ? " with a unit-square grid" : "";
  return `Rectangle ${dimensionLabel(spec.width, spec.unit)} wide and ${dimensionLabel(spec.height, spec.unit)} high${grid}.`;
}

export function compositeRectilinearAccessibilityLabel(spec: CompositeRectilinearPromptVisual): string {
  const known = spec.sideLabels.flatMap((side) => (side.label ? [side.label] : []));
  return `Composite rectilinear figure made from ${spec.rects.length} rectangles${
    known.length > 0 ? `, with side labels ${known.join(", ")}` : ""
  }.`;
}

export function angleFigureAccessibilityLabel(spec: AngleFigurePromptVisual): string {
  const degrees = clampNumber(spec.degrees, 1, 180);
  const known = sanitizeAngleParts(spec.parts, degrees)
    ?.flatMap((part) => (part.label ? [part.label] : [])) ?? [];
  const labels = [spec.label, ...known].filter((label): label is string => Boolean(label));
  const angleType = degrees < 90 ? "acute" : degrees === 90 ? "right" : degrees < 180 ? "obtuse" : "straight";
  return `${angleType[0].toUpperCase()}${angleType.slice(1)} angle figure${
    spec.showProtractorScale ? " on a 0 to 180 degree protractor scale" : ""
  }${
    labels.length > 0 ? `, with labels ${labels.join(", ")}` : ""
  }.`;
}

export function coordinatePlaneAccessibilityLabel(spec: CoordinatePlanePromptVisual): string {
  const points = spec.points.map((point) => `${point.label} at ${formatNumber(point.x)}, ${formatNumber(point.y)}`);
  const connection = spec.connect === "polygon"
    ? " The points form a closed polygon."
    : spec.connect === "segments"
      ? " The points are connected in order."
      : "";
  return `Coordinate plane from ${formatNumber(spec.xMin)} to ${formatNumber(spec.xMax)} on x and ${formatNumber(spec.yMin)} to ${formatNumber(spec.yMax)} on y${
    points.length > 0 ? `, with ${points.join("; ")}` : ""
  }.${connection}`;
}

export function rectangularPrismAccessibilityLabel(spec: RectangularPrismPromptVisual): string {
  const subdivisions = spec.showUnitCubes ? " with visible unit-cube subdivisions" : "";
  return `Rectangular prism ${dimensionLabel(spec.length, spec.unit)} long, ${dimensionLabel(spec.width, spec.unit)} wide, and ${dimensionLabel(spec.height, spec.unit)} high${subdivisions}.`;
}

export function pictographAccessibilityLabel(spec: PictographPromptVisual): string {
  const rows = spec.rows.map((row) => `${row.label}: ${formatNumber(row.icons * spec.key)}`);
  return `Pictograph where each icon represents ${formatNumber(spec.key)}. ${rows.join("; ")}.`;
}

export function barGraphAccessibilityLabel(spec: BarGraphPromptVisual): string {
  const bars = spec.bars.map((bar, index) => (
    index === spec.missingBarIndex || bar.value === undefined
      ? `${bar.label}: missing`
      : `${bar.label}: ${formatNumber(bar.value)}`
  ));
  return `Bar graph of ${spec.yAxisLabel} by ${spec.xAxisLabel}. ${bars.join("; ")}.`;
}

export function linePlotAccessibilityLabel(spec: LinePlotPromptVisual): string {
  const describe = (values: number[]) => {
    const counts = new Map<number, number>();
    for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
    return [...counts.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([value, count]) => `${formatAxisValue(value, spec.fractionDenominator)}: ${count}`)
      .join("; ");
  };
  const marker = spec.marker
    ? ` ${spec.marker.label} at ${formatAxisValue(spec.marker.value, spec.fractionDenominator)}.`
    : "";
  if (spec.valuesB !== undefined && spec.valuesB.length > 0) {
    const labelA = spec.seriesALabel ?? "Set A";
    const labelB = spec.seriesBLabel ?? "Set B";
    return `Line plot for ${spec.axisLabel} comparing ${labelA} and ${labelB}. ${labelA} — ${describe(spec.values)}. ${labelB} — ${describe(spec.valuesB)}.${marker}`;
  }
  return `Line plot for ${spec.axisLabel}. ${describe(spec.values)}.${marker}`;
}

export function numberLineAccessibilityLabel(spec: NumberLinePromptVisual): string {
  const points = spec.points?.map((point) => (
    `${point.label ? `${point.label} at ` : ""}${formatAxisValue(point.value, spec.fractionDenominator)}${
      point.highlighted ? " highlighted" : ""
    }`
  )) ?? [];
  const interval = spec.interval
    ? ` Shaded interval from ${formatAxisValue(spec.interval.from, spec.fractionDenominator)} ${
        spec.interval.includeFrom ? "inclusive" : "exclusive"
      } to ${formatAxisValue(spec.interval.to, spec.fractionDenominator)} ${
        spec.interval.includeTo ? "inclusive" : "exclusive"
      }.`
    : "";
  const unlabeled = spec.unlabeledTicks?.length
    ? ` Unlabeled ticks at ${spec.unlabeledTicks.map((value) => formatAxisValue(value, spec.fractionDenominator)).join(", ")}.`
    : "";
  return `Number line from ${formatAxisValue(spec.min, spec.fractionDenominator)} to ${formatAxisValue(spec.max, spec.fractionDenominator)}${
    points.length > 0 ? `, with ${points.join("; ")}` : ""
  }.${interval}${unlabeled}`;
}

function clampCount(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(40, Math.floor(n)));
}

function clampInt(n: number, min: number, max: number): number {
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

function clampNumber(n: number, min: number, max: number): number {
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, n));
}

function sanitizeGraphLabel(label: string, fallback: string, maxLength = 18): string {
  const normalized = label.trim().replace(/\s+/g, " ");
  return (normalized || fallback).slice(0, maxLength);
}

function snapAxisValue(value: number, min: number, max: number, step: number): number {
  const safe = clampNumber(value, min, max);
  const snapped = min + Math.round((safe - min) / step) * step;
  return Math.round(clampNumber(snapped, min, max) * 1_000_000) / 1_000_000;
}

function sanitizeDimension(n: number, wholeUnits: boolean): number {
  return wholeUnits ? clampInt(n, 1, 12) : clampNumber(n, 0.25, 99);
}

function normalizeDegrees(degrees: number): number {
  if (!Number.isFinite(degrees)) return 0;
  return ((degrees % 360) + 360) % 360;
}

function sanitizeAxisRange(min: number, max: number): [number, number] {
  const safeMin = clampNumber(min, -20, 20);
  const safeMax = clampNumber(max, -20, 20);
  if (safeMin < safeMax) return [safeMin, safeMax];
  if (safeMin >= 20) return [19, 20];
  return [safeMin, safeMin + 1];
}

function sanitizeUnitRects(rects: RectilinearUnitRect[]): RectilinearUnitRect[] {
  const sanitized = rects.slice(0, 8).map((rect) => ({
    x: clampInt(rect.x, -12, 12),
    y: clampInt(rect.y, -12, 12),
    width: clampInt(rect.width, 1, 12),
    height: clampInt(rect.height, 1, 12),
  }));
  return sanitized.length > 0 ? sanitized : [{ x: 0, y: 0, width: 1, height: 1 }];
}

function sanitizeAngleParts(parts: AnglePart[] | undefined, totalDegrees: number): AnglePart[] | undefined {
  if (!parts) return undefined;
  const sanitized: AnglePart[] = [];
  let usedDegrees = 0;
  for (const part of parts.slice(0, 6)) {
    const degrees = clampNumber(part.degrees, 1, totalDegrees);
    if (usedDegrees + degrees > totalDegrees) break;
    sanitized.push({ degrees, label: part.label });
    usedDegrees += degrees;
  }
  return sanitized;
}

function formatNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : String(Math.round(value * 100) / 100);
}

function formatAxisValue(value: number, denominator?: 2 | 4): string {
  if (!denominator) return formatNumber(value);
  const numerator = Math.round(value * denominator);
  const sign = numerator < 0 ? "-" : "";
  const absolute = Math.abs(numerator);
  const whole = Math.floor(absolute / denominator);
  const remainder = absolute % denominator;
  if (remainder === 0) return `${sign}${whole}`;
  const divisor = remainder % 2 === 0 && denominator % 2 === 0 ? 2 : 1;
  const fraction = `${remainder / divisor}/${denominator / divisor}`;
  return whole === 0 ? `${sign}${fraction}` : `${sign}${whole} ${fraction}`;
}

function dimensionLabel(value: number, unit: string): string {
  return `${formatNumber(value)}${unit.trim() ? ` ${unit.trim()}` : ""}`;
}

// ─── Fraction-aware label layout ─────────────────────────────────────────────
// Estimated glyph advances (× fontSize) — NOT real font metrics (SVG/RNSVG
// can't measure text synchronously on either platform), just enough to flow
// short runs ("2 1/2 cm", "3/4") into a row that reads as centered. Only the
// FLOW between runs depends on this estimate; each run's own glyphs still
// render as real, crisply-hinted platform text.
const GLYPH_WIDTH = 0.6;
const SPACE_WIDTH = 0.28;
const RUN_GAP = 3;
// Numerator/denominator size, relative to the label's base font size — a
// smaller ratio than the stem's FractionText (0.82) because these are compact
// axis-tick/figure labels, not display-size prose.
const FRAC_INNER_SCALE = 0.68;
// The vinculum sits barely above the plain-text baseline, not exactly on it
// (the standard optical correction so a bar centered between num/den doesn't
// read as sitting "low").
const FRAC_BAR_RISE = 0.05;
// The vinculum extends slightly beyond the numerator/denominator glyph width
// on each side (the typographic "the bar peeks past the digits" look). This
// is the ONLY horizontal padding a fraction run reserves, so it must be used
// for BOTH the run's reserved width (the anchor/centering math below) and the
// bar's actual drawn extent (barX1/barX2) — reserving more than is drawn (or
// vice versa) makes a start/end-anchored label land off its stated anchor.
const FRAC_BAR_OVERHANG = 1.5;
// A plain text run's baseline sits this far BELOW its own optical vertical
// center (the same baseline-to-center distance `FractionAwareLabel`'s
// `centered` mode already assumes elsewhere in the web/native renderers) —
// used to center a fraction-adjacent text run on the fraction bar rather than
// leave it sitting at the label's original single-line baseline.
const TEXT_OPTICAL_CENTER_OFFSET = 0.35;

function estimateTextWidth(text: string, fontSize: number): number {
  let width = 0;
  for (const ch of text) width += (ch === " " ? SPACE_WIDTH : GLYPH_WIDTH) * fontSize;
  return width;
}

// `parseFractions` can yield two ADJACENT text nodes with nothing in between
// — the only case is a symbol (a sign, a currency mark, …) immediately
// followed by a mixed number's whole part, e.g. "-2 3/4" parses to
// text("-"), text("2"), frac(3,4): the parser's fraction regex captures the
// whole part as its OWN node, distinct from whatever preceded it. Laid out as
// separate runs, RUN_GAP inserts a gap between them ("- 2 ¾", a detached
// sign). Concatenating adjacent text nodes (verbatim, no separator — they were
// contiguous in the source string, so there's nothing to insert) restores
// natural, un-gapped text flow for exactly this case, without touching the
// shared parser other callers (FractionText, prose scanning) depend on.
function mergeAdjacentTextNodes(nodes: FractionNode[]): FractionNode[] {
  const merged: FractionNode[] = [];
  for (const node of nodes) {
    const prev = merged[merged.length - 1];
    if (node.type === "text" && prev && prev.type === "text") {
      merged[merged.length - 1] = { type: "text", value: prev.value + node.value };
    } else {
      merged.push(node);
    }
  }
  return merged;
}

/**
 * Lay out `text` for SVG/RNSVG rendering at `fontSize`, using `baselineY` as
 * the text baseline (the convention plain `<text>`/`<SvgText>` already use for
 * axis ticks) and `anchor` for how the row sits relative to `x` (mirrors
 * `textAnchor`). Text with no fraction returns `"plain"` — the caller keeps
 * rendering exactly the single `<text>` it always has. Text containing a
 * fraction or mixed number (e.g. "2 1/2", "-1/2", "3/4 in" — always
 * `formatAxisValue`'s or an author's plain-ASCII notation, the SAME notation
 * `shared/fractions` parses for the stem's FractionText) is split into a
 * deterministic row of runs: a stacked numerator/vinculum/denominator
 * wherever a fraction appears, ordinary text otherwise. Pure and
 * deterministic — the same (text, x, baselineY, fontSize, anchor) always
 * produces the same runs, so every platform draws identically.
 *
 * A plain-text run beside a fraction is vertically centered on the fraction
 * BAR (the stacked composition's visual middle) rather than left at the
 * label's original single-line baseline — otherwise it rides the vinculum
 * and floats above the denominator (e.g. the trailing " turn" in
 * "90/360 turn"). A pure-fraction label (no text at all) or a fraction-free
 * label (the "plain" early return) is unaffected — only a run that is BOTH
 * plain text AND adjacent to a fraction moves.
 */
export function layoutFractionLabel(
  text: string,
  x: number,
  baselineY: number,
  fontSize: number,
  anchor: "start" | "middle" | "end" = "middle",
): FractionLabelLayout {
  if (!hasFraction(text)) return { kind: "plain", text, x, y: baselineY };
  // Underscore-run blanks ("___") are a FractionText concern (it draws a fill-in
  // box); this SVG manipulative-label renderer has no box primitive and such a
  // blank never appears in a short axis/point label, so collapse any blank back
  // to its literal "___" text — the exact behavior before blank nodes existed.
  const nodes: Array<Exclude<FractionNode, { type: "blank" }>> = mergeAdjacentTextNodes(parseFractions(text)).map(
    (node) => (node.type === "blank" ? { type: "text", value: "___" } : node),
  );
  const innerFontSize = Math.max(7, Math.round(fontSize * FRAC_INNER_SCALE));
  const barY = baselineY - fontSize * FRAC_BAR_RISE;
  const hasFractionRun = nodes.some((node) => node.type === "frac");
  const textRunY = hasFractionRun ? barY + fontSize * TEXT_OPTICAL_CENTER_OFFSET : baselineY;

  const glyphWidths = nodes.map((node) => {
    if (node.type === "text") return estimateTextWidth(node.value, fontSize);
    const numText = node.num.blank ? "?" : node.num.value;
    const denText = node.den.blank ? "?" : node.den.value;
    return Math.max(estimateTextWidth(numText, innerFontSize), estimateTextWidth(denText, innerFontSize));
  });
  const runWidths = nodes.map((node, i) => (node.type === "text" ? glyphWidths[i] : glyphWidths[i] + FRAC_BAR_OVERHANG * 2));
  const totalWidth = runWidths.reduce((sum, w) => sum + w, 0) + RUN_GAP * Math.max(0, nodes.length - 1);
  const rowStart = anchor === "middle" ? x - totalWidth / 2 : anchor === "end" ? x - totalWidth : x;

  let cursor = rowStart;
  const runs: FractionLabelRun[] = nodes.map((node, i) => {
    const runWidth = runWidths[i];
    const runX = cursor + runWidth / 2;
    cursor += runWidth + RUN_GAP;
    if (node.type === "text") return { kind: "text", text: node.value, x: runX, y: textRunY };
    const numText = node.num.blank ? "?" : node.num.value;
    const denText = node.den.blank ? "?" : node.den.value;
    const glyphWidth = glyphWidths[i];
    return {
      kind: "fraction",
      num: numText,
      den: denText,
      x: runX,
      numY: baselineY - fontSize * 0.65,
      denY: baselineY + fontSize * 1.15,
      barX1: runX - glyphWidth / 2 - FRAC_BAR_OVERHANG,
      barX2: runX + glyphWidth / 2 + FRAC_BAR_OVERHANG,
      barY,
      innerFontSize,
    };
  });
  return { kind: "runs", runs };
}

function sanitizeParts(parts: number[], maxParts: number): number[] {
  const out = parts
    .map((part) => clampInt(part, 1, 99))
    .filter((part) => part > 0)
    .slice(0, maxParts);
  return out.length > 0 ? out : [1];
}

function normalizeHour(hour: number): number {
  if (!Number.isFinite(hour)) return 12;
  return ((((Math.floor(hour) - 1) % 12) + 12) % 12) + 1;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffled<T>(items: T[], rand: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

export function countablesGeometry(spec: CountablesPromptVisual): CountablesGeometry {
  const n = clampCount(spec.n);
  if (spec.layout === "tenframe") return tenFrameGeometry(n);
  if (spec.layout === "grid") return gridGeometry(n);
  return scatterGeometry(n, spec.seed);
}

function tenFrameGeometry(n: number): CountablesGeometry {
  const width = 320;
  const frameWidth = 260;
  const frameHeight = 88;
  const frameX = (width - frameWidth) / 2;
  const padY = 8;
  const frameGap = 14;
  const frames = Math.max(1, Math.ceil(n / 10));
  const height = padY * 2 + frames * frameHeight + (frames - 1) * frameGap;
  const cellW = frameWidth / 5;
  const cellH = frameHeight / 2;
  const tenFrameCells: TenFrameCell[] = [];
  const points: CountablePoint[] = [];

  for (let frame = 0; frame < frames; frame++) {
    const y0 = padY + frame * (frameHeight + frameGap);
    for (let slot = 0; slot < 10; slot++) {
      const row = slot >= 5 ? 1 : 0;
      const col = slot % 5;
      tenFrameCells.push({
        x: frameX + col * cellW,
        y: y0 + row * cellH,
        width: cellW,
        height: cellH,
      });
    }
  }

  for (let i = 0; i < n; i++) {
    const frame = Math.floor(i / 10);
    const slot = i % 10;
    const row = slot >= 5 ? 1 : 0;
    const col = slot % 5;
    const y0 = padY + frame * (frameHeight + frameGap);
    points.push({
      index: i,
      x: frameX + col * cellW + cellW / 2,
      y: y0 + row * cellH + cellH / 2,
      r: 13.5,
      rotation: 0,
      scale: 1,
    });
  }

  return { width, height, points, tenFrameCells };
}

function gridGeometry(n: number): CountablesGeometry {
  const width = 320;
  const cols = Math.max(1, Math.min(5, n));
  const rows = Math.max(1, Math.ceil(n / cols));
  const gapX = 46;
  const gapY = 42;
  const height = 34 + rows * gapY;
  const startX = width / 2 - ((cols - 1) * gapX) / 2;
  const startY = height / 2 - ((rows - 1) * gapY) / 2;
  const points: CountablePoint[] = [];
  for (let i = 0; i < n; i++) {
    const row = Math.floor(i / cols);
    const col = i % cols;
    points.push({
      index: i,
      x: startX + col * gapX,
      y: startY + row * gapY,
      r: 13,
      rotation: 0,
      scale: 1,
    });
  }
  return { width, height, points, tenFrameCells: [] };
}

function scatterGeometry(n: number, seed: number): CountablesGeometry {
  const rand = mulberry32(seed >>> 0);
  const width = 320;
  const cols = 5;
  const rows = Math.max(1, Math.ceil(n / cols));
  const height = n <= 10 ? 134 : 178;
  const marginX = 34;
  const marginY = 24;
  const cellW = (width - marginX * 2) / cols;
  const cellH = (height - marginY * 2) / rows;
  const cells = [];
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) cells.push({ row, col });
  }
  const picked = shuffled(cells, rand).slice(0, n);
  const points = picked.map((cell, i) => ({
    index: i,
    x: marginX + cell.col * cellW + cellW / 2 + (rand() - 0.5) * cellW * 0.42,
    y: marginY + cell.row * cellH + cellH / 2 + (rand() - 0.5) * cellH * 0.38,
    r: 12.5,
    rotation: (rand() - 0.5) * 22,
    scale: 0.92 + rand() * 0.16,
  }));
  points.sort((a, b) => a.index - b.index);
  return { width, height, points, tenFrameCells: [] };
}

export function groupsGeometry(spec: GroupsPromptVisual): GroupsGeometry {
  const groups = clampInt(spec.groups, 1, 8);
  const perGroup = clampInt(spec.perGroup, 1, 12);
  const cols = groups <= 3 ? groups : Math.ceil(groups / 2);
  const rows = Math.ceil(groups / cols);
  const width = 320;
  const margin = 12;
  const gap = 10;
  const boxW = (width - margin * 2 - gap * (cols - 1)) / cols;
  const boxH = 88;
  const height = margin * 2 + rows * boxH + (rows - 1) * gap;
  const boxes: GroupBox[] = [];
  const points: CountablePoint[] = [];
  const rand = mulberry32(spec.seed >>> 0);
  let pointIndex = 0;

  for (let g = 0; g < groups; g++) {
    const row = Math.floor(g / cols);
    const col = g % cols;
    const x = margin + col * (boxW + gap);
    const y = margin + row * (boxH + gap);
    boxes.push({ index: g, x, y, width: boxW, height: boxH });

    const pointCols = Math.ceil(Math.sqrt(perGroup));
    const pointRows = Math.ceil(perGroup / pointCols);
    const innerX = 18;
    const innerY = 16;
    const cellW = (boxW - innerX * 2) / pointCols;
    const cellH = (boxH - innerY * 2) / pointRows;
    for (let i = 0; i < perGroup; i++) {
      const pr = Math.floor(i / pointCols);
      const pc = i % pointCols;
      points.push({
        index: pointIndex++,
        x: x + innerX + pc * cellW + cellW / 2 + (rand() - 0.5) * Math.min(cellW, 18) * 0.18,
        y: y + innerY + pr * cellH + cellH / 2 + (rand() - 0.5) * Math.min(cellH, 18) * 0.18,
        r: Math.min(10.5, Math.max(6.5, Math.min(cellW, cellH) * 0.22)),
        rotation: (rand() - 0.5) * 14,
        scale: 0.94 + rand() * 0.12,
      });
    }
  }
  return { width, height, boxes, points };
}

export function arrayGeometry(spec: ArrayPromptVisual): ArrayGeometry {
  const rows = clampInt(spec.rows, 1, 10);
  const cols = clampInt(spec.cols, 1, 10);
  const width = 320;
  const gapX = Math.min(42, 252 / Math.max(1, cols - 1));
  const gapY = Math.min(38, 170 / Math.max(1, rows - 1));
  const height = Math.max(112, 34 + (rows - 1) * gapY + 42);
  const startX = width / 2 - ((cols - 1) * gapX) / 2;
  const startY = height / 2 - ((rows - 1) * gapY) / 2;
  const points: CountablePoint[] = [];
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      points.push({
        index: row * cols + col,
        x: startX + col * gapX,
        y: startY + row * gapY,
        r: rows * cols > 64 ? 8 : 10.5,
        rotation: 0,
        scale: 1,
      });
    }
  }
  return { width, height, points };
}

export function areaModelGeometry(spec: AreaModelPromptVisual): AreaModelGeometry {
  const widthParts = sanitizeParts(spec.widthParts, 2);
  const heightParts = sanitizeParts(spec.heightParts, 2);
  const width = 340;
  const gridX = 62;
  const gridY = 42;
  const gridWidth = 252;
  const gridHeight = 154;
  const height = 218;
  const widthSum = widthParts.reduce((sum, part) => sum + part, 0);
  const heightSum = heightParts.reduce((sum, part) => sum + part, 0);
  const minCell = 54;
  const rawWidths = widthParts.map((part) => (part / widthSum) * gridWidth);
  const rawHeights = heightParts.map((part) => (part / heightSum) * gridHeight);
  const colWidths = balanceCells(rawWidths, gridWidth, minCell);
  const rowHeights = balanceCells(rawHeights, gridHeight, minCell);

  const topLabels: AreaModelLabel[] = [];
  let x = gridX;
  for (let col = 0; col < widthParts.length; col++) {
    const w = colWidths[col];
    topLabels.push({ index: col, text: String(widthParts[col]), x, y: 12, width: w, height: 24 });
    x += w;
  }

  const sideLabels: AreaModelLabel[] = [];
  let y = gridY;
  for (let row = 0; row < heightParts.length; row++) {
    const h = rowHeights[row];
    sideLabels.push({ index: row, text: String(heightParts[row]), x: 18, y, width: 34, height: h });
    y += h;
  }

  const cells: AreaModelCell[] = [];
  y = gridY;
  for (let row = 0; row < heightParts.length; row++) {
    x = gridX;
    for (let col = 0; col < widthParts.length; col++) {
      const w = colWidths[col];
      const h = rowHeights[row];
      cells.push({
        row,
        col,
        x,
        y,
        width: w,
        height: h,
        label: String(widthParts[col] * heightParts[row]),
      });
      x += w;
    }
    y += rowHeights[row];
  }

  return { width, height, gridX, gridY, gridWidth, gridHeight, cells, topLabels, sideLabels };
}

function balanceCells(raw: number[], total: number, minCell: number): number[] {
  if (raw.length <= 1) return [total];
  const clamped = raw.map((n) => Math.max(minCell, n));
  const sum = clamped.reduce((acc, n) => acc + n, 0);
  return clamped.map((n) => (n / sum) * total);
}

export function fractionPartGeometry(spec: FractionPartPromptVisual): FractionPartGeometry {
  const parts = clampInt(spec.parts, 2, 12);
  const shaded = clampInt(spec.shaded, 0, parts);
  if (spec.shape === "circle") return circleFractionGeometry(parts, shaded);
  return barFractionGeometry(parts, shaded);
}

function barFractionGeometry(parts: number, shaded: number): FractionPartGeometry {
  const width = 320;
  const height = 92;
  const x0 = 24;
  const y0 = 24;
  const w = width - x0 * 2;
  const h = 44;
  const segments: FractionPartSegment[] = [];
  for (let i = 0; i < parts; i++) {
    segments.push({
      index: i,
      shaded: i < shaded,
      x: x0 + (i * w) / parts,
      y: y0,
      width: w / parts,
      height: h,
    });
  }
  return { width, height, segments };
}

function circleFractionGeometry(parts: number, shaded: number): FractionPartGeometry {
  const width = 320;
  const height = 170;
  const centerX = width / 2;
  const centerY = height / 2;
  const radius = 62;
  const segments: FractionPartSegment[] = [];
  for (let i = 0; i < parts; i++) {
    const start = -Math.PI / 2 + (i / parts) * Math.PI * 2;
    const end = -Math.PI / 2 + ((i + 1) / parts) * Math.PI * 2;
    segments.push({
      index: i,
      shaded: i < shaded,
      x: centerX,
      y: centerY,
      width: radius,
      height: radius,
      path: wedgePath(centerX, centerY, radius, start, end),
    });
  }
  return { width, height, segments, centerX, centerY, radius };
}

function wedgePath(cx: number, cy: number, r: number, start: number, end: number): string {
  const x1 = cx + Math.cos(start) * r;
  const y1 = cy + Math.sin(start) * r;
  const x2 = cx + Math.cos(end) * r;
  const y2 = cy + Math.sin(end) * r;
  const largeArc = end - start > Math.PI ? 1 : 0;
  return `M ${cx} ${cy} L ${x1} ${y1} A ${r} ${r} 0 ${largeArc} 1 ${x2} ${y2} Z`;
}

export function clockfaceGeometry(spec: ClockfacePromptVisual): ClockfaceGeometry {
  const width = 320;
  const height = 220;
  const centerX = width / 2;
  const centerY = height / 2;
  const radius = 82;
  const highlight = spec.highlightHour === undefined ? undefined : normalizeHour(spec.highlightHour);
  const ticks: ClockTick[] = [];
  for (let hour = 1; hour <= 12; hour++) {
    const angle = -Math.PI / 2 + (hour / 12) * Math.PI * 2;
    ticks.push({
      hour,
      x: centerX + Math.cos(angle) * (radius - 12),
      y: centerY + Math.sin(angle) * (radius - 12),
      labelX: centerX + Math.cos(angle) * (radius - 34),
      labelY: centerY + Math.sin(angle) * (radius - 34),
      highlighted: highlight === hour,
    });
  }
  return { width, height, centerX, centerY, radius, ticks };
}

export function labeledRectangleGeometry(
  spec: LabeledRectanglePromptVisual,
): LabeledRectangleGeometry {
  const logicalWidth = sanitizeDimension(spec.width, spec.showUnitGrid);
  const logicalHeight = sanitizeDimension(spec.height, spec.showUnitGrid);
  const ratio = clampNumber(logicalWidth / logicalHeight, 0.45, 2.4);
  const width = 340;
  const rectWidth = ratio >= 1 ? 230 : Math.max(98, 164 * ratio);
  const rectHeight = ratio >= 1 ? Math.max(96, 230 / ratio) : 164;
  const rectX = (width - rectWidth) / 2;
  const rectY = 24;
  const height = rectY + rectHeight + 48;
  const gridLines: GeometryLine[] = [];

  if (spec.showUnitGrid) {
    const cols = clampInt(logicalWidth, 1, 12);
    const rows = clampInt(logicalHeight, 1, 12);
    for (let col = 1; col < cols; col++) {
      const x = rectX + (col / cols) * rectWidth;
      gridLines.push({ x1: x, y1: rectY, x2: x, y2: rectY + rectHeight });
    }
    for (let row = 1; row < rows; row++) {
      const y = rectY + (row / rows) * rectHeight;
      gridLines.push({ x1: rectX, y1: y, x2: rectX + rectWidth, y2: y });
    }
  }

  return {
    width,
    height,
    rectX,
    rectY,
    rectWidth,
    rectHeight,
    gridLines,
    labels: [
      {
        text: dimensionLabel(logicalWidth, spec.unit),
        x: rectX + rectWidth / 2,
        y: rectY + rectHeight + 30,
      },
      {
        text: dimensionLabel(logicalHeight, spec.unit),
        x: rectX - 24,
        y: rectY + rectHeight / 2,
        rotation: -90,
      },
    ],
  };
}

export function compositeRectilinearGeometry(
  spec: CompositeRectilinearPromptVisual,
): CompositeRectilinearGeometry {
  const rects = sanitizeUnitRects(spec.rects);
  const occupied = new Set<string>();
  for (const rect of rects) {
    for (let y = rect.y; y < rect.y + rect.height; y++) {
      for (let x = rect.x; x < rect.x + rect.width; x++) occupied.add(`${x},${y}`);
    }
  }

  const units = [...occupied].map((key) => {
    const [x, y] = key.split(",").map(Number);
    return { x, y };
  });
  const minX = Math.min(...units.map((cell) => cell.x));
  const maxX = Math.max(...units.map((cell) => cell.x + 1));
  const minY = Math.min(...units.map((cell) => cell.y));
  const maxY = Math.max(...units.map((cell) => cell.y + 1));
  const spanX = maxX - minX;
  const spanY = maxY - minY;
  const scale = Math.min(238 / spanX, 158 / spanY);
  const width = 340;
  const height = 230;
  const originX = (width - spanX * scale) / 2;
  const originY = 30 + (158 - spanY * scale) / 2;
  const plotX = (x: number) => originX + (x - minX) * scale;
  const plotY = (y: number) => originY + (y - minY) * scale;
  const cells = units
    .sort((a, b) => a.y - b.y || a.x - b.x)
    .map((cell) => ({
      x: plotX(cell.x),
      y: plotY(cell.y),
      width: scale,
      height: scale,
    }));
  const boundaryLines: GeometryLine[] = [];

  for (const cell of units) {
    if (!occupied.has(`${cell.x},${cell.y - 1}`)) {
      boundaryLines.push({
        x1: plotX(cell.x),
        y1: plotY(cell.y),
        x2: plotX(cell.x + 1),
        y2: plotY(cell.y),
      });
    }
    if (!occupied.has(`${cell.x + 1},${cell.y}`)) {
      boundaryLines.push({
        x1: plotX(cell.x + 1),
        y1: plotY(cell.y),
        x2: plotX(cell.x + 1),
        y2: plotY(cell.y + 1),
      });
    }
    if (!occupied.has(`${cell.x},${cell.y + 1}`)) {
      boundaryLines.push({
        x1: plotX(cell.x + 1),
        y1: plotY(cell.y + 1),
        x2: plotX(cell.x),
        y2: plotY(cell.y + 1),
      });
    }
    if (!occupied.has(`${cell.x - 1},${cell.y}`)) {
      boundaryLines.push({
        x1: plotX(cell.x),
        y1: plotY(cell.y + 1),
        x2: plotX(cell.x),
        y2: plotY(cell.y),
      });
    }
  }

  const centerX = plotX((minX + maxX) / 2);
  const centerY = plotY((minY + maxY) / 2);
  const labels = spec.sideLabels.flatMap((side): GeometryLabel[] => {
    if (!side.label) return [];
    const sideX1 = clampInt(side.x1, -24, 24);
    const sideY1 = clampInt(side.y1, -24, 24);
    const sideX2 = clampInt(side.x2, -24, 24);
    const sideY2 = clampInt(side.y2, -24, 24);
    const x1 = plotX(sideX1);
    const y1 = plotY(sideY1);
    const x2 = plotX(sideX2);
    const y2 = plotY(sideY2);
    const horizontal = Math.abs(x2 - x1) >= Math.abs(y2 - y1);
    const midX = (x1 + x2) / 2;
    const midY = (y1 + y2) / 2;
    const unitMidX = (sideX1 + sideX2) / 2;
    const unitMidY = (sideY1 + sideY2) / 2;
    const sampleX = unitMidX + (Number.isInteger(unitMidX) ? 0.01 : 0);
    const sampleY = unitMidY + (Number.isInteger(unitMidY) ? 0.01 : 0);
    const occupiedAt = (x: number, y: number) => occupied.has(`${Math.floor(x)},${Math.floor(y)}`);
    const firstSideOccupied = horizontal
      ? occupiedAt(sampleX, unitMidY - 0.1)
      : occupiedAt(unitMidX - 0.1, sampleY);
    const secondSideOccupied = horizontal
      ? occupiedAt(sampleX, unitMidY + 0.1)
      : occupiedAt(unitMidX + 0.1, sampleY);
    const exteriorDirection = firstSideOccupied !== secondSideOccupied
      ? firstSideOccupied ? 1 : -1
      : horizontal
        ? midY <= centerY ? -1 : 1
        : midX <= centerX ? -1 : 1;
    return [{
      text: side.label,
      x: horizontal ? midX : midX + exteriorDirection * 17,
      y: horizontal ? midY + (exteriorDirection < 0 ? -12 : 22) : midY,
      rotation: horizontal ? undefined : -90,
    }];
  });

  return { width, height, cells, boundaryLines, labels };
}

export function angleFigureGeometry(spec: AngleFigurePromptVisual): AngleFigureGeometry {
  const width = 340;
  const height = 220;
  const vertexX = width / 2;
  const vertexY = height / 2;
  const rayLength = 94;
  const degrees = clampNumber(spec.degrees, 1, 180);
  const orientation = normalizeDegrees(spec.orientation);
  const parts = sanitizeAngleParts(spec.parts, degrees) ?? [];
  const hasParts = parts.length > 0;
  // With parts (an angle-additivity figure) the rings are layered so every arc
  // subtends exactly the angle its label claims: part arcs innermost, each
  // spanning ONLY its own sub-angle — adjacent parts at ALTERNATING radii
  // (the textbook double-arc convention), because two same-radius arcs meeting
  // at the divider ray merge into what reads as one full-span ring, and a gap
  // hidden under the 3px ray doesn't separate them either — part labels on
  // their bisectors in the band between the rings, and the total arc OUTSIDE
  // all parts with its label just beyond it. Without parts, the compact
  // single-arc layout is unchanged (which also keeps the protractor-scale
  // figures clear of the outer band).
  const partArcRadius = (index: number) => (index % 2 === 0 ? 42 : 30);
  const partLabelRadius = 58;
  const totalArcRadius = hasParts ? 72 : 38;
  const totalLabelRadius = hasParts ? 88 : 62;
  const start = polarPoint(vertexX, vertexY, rayLength, orientation);
  const end = polarPoint(vertexX, vertexY, rayLength, orientation + degrees);
  const rays: GeometryLine[] = [
    { x1: vertexX, y1: vertexY, x2: start.x, y2: start.y },
    { x1: vertexX, y1: vertexY, x2: end.x, y2: end.y },
  ];
  const partArcs: AnglePartArc[] = [];
  let usedDegrees = 0;

  for (const [index, part] of parts.entries()) {
    const partDegrees = part.degrees;
    const partStart = orientation + usedDegrees;
    const partEnd = partStart + partDegrees;
    usedDegrees += partDegrees;
    if (usedDegrees < degrees) {
      const divider = polarPoint(vertexX, vertexY, rayLength, partEnd);
      rays.push({ x1: vertexX, y1: vertexY, x2: divider.x, y2: divider.y });
    }
    const labelPoint = polarPoint(vertexX, vertexY, partLabelRadius, partStart + partDegrees / 2);
    partArcs.push({
      index,
      path: angleArcPath(vertexX, vertexY, partArcRadius(index), partStart, partEnd),
      label: part.label
        ? { text: part.label, x: labelPoint.x, y: labelPoint.y + 5 }
        : undefined,
    });
  }

  const totalLabelPoint = polarPoint(vertexX, vertexY, totalLabelRadius, orientation + degrees / 2);
  const protractorScale = spec.showProtractorScale
    ? {
        arcPath: angleArcPath(vertexX, vertexY, 86, orientation, orientation + 180),
        baseline: (() => {
          const first = polarPoint(vertexX, vertexY, 86, orientation);
          const second = polarPoint(vertexX, vertexY, 86, orientation + 180);
          return { x1: first.x, y1: first.y, x2: second.x, y2: second.y };
        })(),
        ticks: Array.from({ length: 37 }, (_, index) => {
          const tickDegrees = index * 5;
          const major = tickDegrees % 10 === 0;
          const inner = polarPoint(
            vertexX,
            vertexY,
            major ? 76 : 80,
            orientation + tickDegrees,
          );
          const outer = polarPoint(vertexX, vertexY, 86, orientation + tickDegrees);
          return {
            degrees: tickDegrees,
            major,
            x1: inner.x,
            y1: inner.y,
            x2: outer.x,
            y2: outer.y,
          };
        }),
        labels: Array.from({ length: 10 }, (_, index) => {
          const labelDegrees = index * 20;
          const point = polarPoint(vertexX, vertexY, 102, orientation + labelDegrees);
          return { text: String(labelDegrees), x: point.x, y: point.y + 3 };
        }),
      }
    : undefined;
  return {
    width,
    height,
    vertexX,
    vertexY,
    rays,
    arcPath: angleArcPath(vertexX, vertexY, totalArcRadius, orientation, orientation + degrees),
    totalLabel: spec.label
      ? { text: spec.label, x: totalLabelPoint.x, y: totalLabelPoint.y + 5 }
      : undefined,
    partArcs,
    protractorScale,
  };
}

function polarPoint(
  cx: number,
  cy: number,
  radius: number,
  degrees: number,
): { x: number; y: number } {
  const radians = (degrees * Math.PI) / 180;
  return { x: cx + Math.cos(radians) * radius, y: cy + Math.sin(radians) * radius };
}

function angleArcPath(
  cx: number,
  cy: number,
  radius: number,
  startDegrees: number,
  endDegrees: number,
): string {
  const start = polarPoint(cx, cy, radius, startDegrees);
  const end = polarPoint(cx, cy, radius, endDegrees);
  const sweep = endDegrees - startDegrees;
  return `M ${start.x} ${start.y} A ${radius} ${radius} 0 ${sweep > 180 ? 1 : 0} 1 ${end.x} ${end.y}`;
}

export function coordinatePlaneGeometry(
  spec: CoordinatePlanePromptVisual,
): CoordinatePlaneGeometry {
  const [xMin, xMax] = sanitizeAxisRange(spec.xMin, spec.xMax);
  const [yMin, yMax] = sanitizeAxisRange(spec.yMin, spec.yMax);
  const maxStep = Math.max(xMax - xMin, yMax - yMin);
  const step = clampNumber(spec.gridStep, Math.max(0.25, maxStep / 20), maxStep);
  const width = 340;
  const height = 270;
  const plotX = 48;
  const plotY = 18;
  const plotWidth = 270;
  const plotHeight = 218;
  const scaleX = (x: number) => plotX + ((x - xMin) / (xMax - xMin)) * plotWidth;
  const scaleY = (y: number) => plotY + plotHeight - ((y - yMin) / (yMax - yMin)) * plotHeight;
  const verticalLines: CoordinateGridLine[] = axisValues(xMin, xMax, step).map((value) => ({
    value,
    x1: scaleX(value),
    y1: plotY,
    x2: scaleX(value),
    y2: plotY + plotHeight,
    axis: Math.abs(value) < 1e-9,
  }));
  const horizontalLines: CoordinateGridLine[] = axisValues(yMin, yMax, step).map((value) => ({
    value,
    x1: plotX,
    y1: scaleY(value),
    x2: plotX + plotWidth,
    y2: scaleY(value),
    axis: Math.abs(value) < 1e-9,
  }));
  const points = spec.points.slice(0, 12).map((point, index) => {
    const x = clampNumber(point.x, xMin, xMax);
    const y = clampNumber(point.y, yMin, yMax);
    const pointX = scaleX(x);
    const pointY = scaleY(y);
    return {
      index,
      x,
      y,
      label: point.label,
      plotX: pointX,
      plotY: pointY,
      labelX: pointX + 9,
      labelY: pointY - 8,
    };
  });
  const path = spec.connect && points.length >= 2
    ? points.map((point, index) => `${index === 0 ? "M" : "L"} ${point.plotX} ${point.plotY}`).join(" ")
    : undefined;

  return {
    width,
    height,
    plotX,
    plotY,
    plotWidth,
    plotHeight,
    verticalLines,
    horizontalLines,
    xTicks: verticalLines.map((line) => ({
      value: line.value,
      text: formatNumber(line.value),
      x: line.x1,
      y: plotY + plotHeight + 19,
    })),
    yTicks: horizontalLines
      .filter((line) => Math.abs(line.value) >= 1e-9)
      .map((line) => ({
        value: line.value,
        text: formatNumber(line.value),
        x: plotX - 9,
        y: line.y1 + 4,
      })),
    points,
    path,
    closePath: spec.connect === "polygon" && points.length >= 3,
  };
}

function axisValues(min: number, max: number, step: number): number[] {
  const values: number[] = [];
  const first = Math.ceil((min - 1e-9) / step) * step;
  for (let i = 0; i < 100; i++) {
    const value = first + i * step;
    if (value > max + 1e-9) break;
    values.push(Math.round(value * 1_000_000) / 1_000_000);
  }
  return values;
}

export function rectangularPrismGeometry(
  spec: RectangularPrismPromptVisual,
): RectangularPrismGeometry {
  const logicalLength = sanitizeDimension(spec.length, spec.showUnitCubes);
  const logicalWidth = sanitizeDimension(spec.width, spec.showUnitCubes);
  const logicalHeight = sanitizeDimension(spec.height, spec.showUnitCubes);
  const maxDimension = Math.max(logicalLength, logicalWidth, logicalHeight);
  const lengthPx = 92 + (logicalLength / maxDimension) * 86;
  const depthPx = 34 + (logicalWidth / maxDimension) * 34;
  const heightPx = 66 + (logicalHeight / maxDimension) * 54;
  const depthX = depthPx * 0.82;
  const depthY = depthPx * 0.57;
  const frontLeft = 58;
  const frontTop = 54 + depthY;
  const vertices = [
    { x: frontLeft, y: frontTop },
    { x: frontLeft + lengthPx, y: frontTop },
    { x: frontLeft + lengthPx, y: frontTop + heightPx },
    { x: frontLeft, y: frontTop + heightPx },
    { x: frontLeft + depthX, y: frontTop - depthY },
    { x: frontLeft + lengthPx + depthX, y: frontTop - depthY },
    { x: frontLeft + lengthPx + depthX, y: frontTop + heightPx - depthY },
    { x: frontLeft + depthX, y: frontTop + heightPx - depthY },
  ];
  const edge = (a: number, b: number, dashed = false): PrismEdge => ({
    x1: vertices[a].x,
    y1: vertices[a].y,
    x2: vertices[b].x,
    y2: vertices[b].y,
    dashed,
  });
  const edges = [
    edge(0, 1), edge(1, 2), edge(2, 3), edge(3, 0),
    edge(4, 5), edge(5, 6), edge(6, 7, true), edge(7, 4, true),
    edge(0, 4), edge(1, 5), edge(2, 6), edge(3, 7, true),
  ];
  const subdivisionLines: GeometryLine[] = [];

  if (spec.showUnitCubes) {
    const lengthUnits = clampInt(logicalLength, 1, 12);
    const widthUnits = clampInt(logicalWidth, 1, 12);
    const heightUnits = clampInt(logicalHeight, 1, 12);
    for (let i = 1; i < lengthUnits; i++) {
      const t = i / lengthUnits;
      subdivisionLines.push(lineBetween(lerpPoint(vertices[0], vertices[1], t), lerpPoint(vertices[3], vertices[2], t)));
      subdivisionLines.push(lineBetween(lerpPoint(vertices[0], vertices[1], t), lerpPoint(vertices[4], vertices[5], t)));
    }
    for (let i = 1; i < widthUnits; i++) {
      const t = i / widthUnits;
      subdivisionLines.push(lineBetween(lerpPoint(vertices[0], vertices[4], t), lerpPoint(vertices[1], vertices[5], t)));
      subdivisionLines.push(lineBetween(lerpPoint(vertices[1], vertices[5], t), lerpPoint(vertices[2], vertices[6], t)));
    }
    for (let i = 1; i < heightUnits; i++) {
      const t = i / heightUnits;
      subdivisionLines.push(lineBetween(lerpPoint(vertices[0], vertices[3], t), lerpPoint(vertices[1], vertices[2], t)));
      subdivisionLines.push(lineBetween(lerpPoint(vertices[1], vertices[2], t), lerpPoint(vertices[5], vertices[6], t)));
    }
  }

  const widthMid = lerpPoint(vertices[1], vertices[5], 0.55);
  return {
    width: 340,
    height: 245,
    vertices,
    edges,
    subdivisionLines,
    labels: [
      {
        text: dimensionLabel(logicalLength, spec.unit),
        x: (vertices[2].x + vertices[3].x) / 2,
        y: vertices[2].y + 27,
      },
      {
        text: dimensionLabel(logicalHeight, spec.unit),
        x: vertices[0].x - 22,
        y: (vertices[0].y + vertices[3].y) / 2,
        rotation: -90,
      },
      {
        text: dimensionLabel(logicalWidth, spec.unit),
        x: widthMid.x + 12,
        y: widthMid.y - 10,
        rotation: -35,
      },
    ],
  };
}

export function pictographGeometry(spec: PictographPromptVisual): PictographGeometry {
  const rowHeight = 43;
  const top = 16;
  const labelX = 90;
  const iconStartX = 118;
  const iconGap = 30;
  const radius = 10.5;
  const rows = spec.rows.map((row, index) => ({
    index,
    label: row.label,
    x: labelX,
    y: top + index * rowHeight + rowHeight / 2 + 5,
  }));
  const icons = spec.rows.flatMap((row, rowIndex) => {
    const iconCount = Math.ceil(row.icons);
    return Array.from({ length: iconCount }, (_, iconIndex) => ({
      rowIndex,
      iconIndex,
      x: iconStartX + iconIndex * iconGap,
      y: top + rowIndex * rowHeight + rowHeight / 2,
      radius,
      half: iconIndex === iconCount - 1 && !Number.isInteger(row.icons),
    }));
  });
  const keyIconY = top + spec.rows.length * rowHeight + 15;
  return {
    width: 340,
    height: keyIconY + 31,
    rows,
    icons,
    keyIconX: 104,
    keyIconY,
    keyText: `Each ⬤ = ${formatNumber(spec.key)}`,
    keyTextX: 124,
  };
}

export function barGraphGeometry(spec: BarGraphPromptVisual): BarGraphGeometry {
  const width = 340;
  const height = 270;
  const plotX = 54;
  const plotY = 18;
  const plotWidth = 266;
  const plotHeight = 190;
  const y = (value: number) => plotY + plotHeight - (value / spec.scaleMax) * plotHeight;
  const tickValues = axisValues(0, spec.scaleMax, spec.scaleStep);
  if (tickValues[tickValues.length - 1] !== spec.scaleMax) tickValues.push(spec.scaleMax);
  const slotWidth = plotWidth / spec.bars.length;
  const barWidth = Math.min(46, slotWidth * 0.62);
  const bars = spec.bars.map((bar, index) => {
    const missing = index === spec.missingBarIndex || bar.value === undefined;
    const value = bar.value ?? 0;
    const barTop = y(value);
    return {
      index,
      label: bar.label,
      value: bar.value,
      x: plotX + slotWidth * index + (slotWidth - barWidth) / 2,
      y: missing ? plotY : barTop,
      width: barWidth,
      height: missing ? plotHeight : plotY + plotHeight - barTop,
      missing,
    };
  });
  return {
    width,
    height,
    plotX,
    plotY,
    plotWidth,
    plotHeight,
    gridLines: tickValues.map((value) => ({
      value,
      x1: plotX,
      y1: y(value),
      x2: plotX + plotWidth,
      y2: y(value),
    })),
    yTicks: tickValues.map((value) => ({
      value,
      text: formatNumber(value),
      x: plotX - 8,
      y: y(value) + 4,
    })),
    bars,
    axisLabels: [
      { text: spec.xAxisLabel, x: plotX + plotWidth / 2, y: height - 5 },
      { text: spec.yAxisLabel, x: 14, y: plotY + plotHeight / 2, rotation: -90 },
    ],
  };
}

export function linePlotGeometry(spec: LinePlotPromptVisual): LinePlotGeometry {
  const width = 340;
  const valuesB = spec.valuesB !== undefined && spec.valuesB.length > 0 ? spec.valuesB : undefined;
  // A two-series plot reserves a left gutter for the per-lane series labels.
  const axisX1 = valuesB ? 76 : 34;
  const axisX2 = 316;
  const tickValues = axisValues(spec.axisMin, spec.axisMax, spec.axisStep);
  if (tickValues[tickValues.length - 1] !== spec.axisMax) tickValues.push(spec.axisMax);
  const x = (value: number) => (
    axisX1 + ((value - spec.axisMin) / (spec.axisMax - spec.axisMin)) * (axisX2 - axisX1)
  );
  const maxStackOf = (values: number[]) => {
    const frequency = new Map<number, number>();
    for (const value of values) frequency.set(value, (frequency.get(value) ?? 0) + 1);
    return Math.max(1, ...frequency.values());
  };
  const stackDots = (values: number[], baselineY: number): LinePlotDot[] => {
    const nextStack = new Map<number, number>();
    return values.map((value, index) => {
      const stack = nextStack.get(value) ?? 0;
      nextStack.set(value, stack + 1);
      return {
        index,
        value,
        stack,
        x: x(value),
        y: baselineY - 14 - stack * 18,
        radius: 6.5,
      };
    });
  };
  const maxStackA = maxStackOf(spec.values);
  const maxStackB = valuesB ? maxStackOf(valuesB) : 0;
  const laneGap = 30;
  const axisY = valuesB
    ? Math.max(150, 36 + (maxStackA + maxStackB) * 18 + laneGap)
    : Math.max(122, 36 + maxStackA * 18);
  const height = axisY + 68;
  // Series B sits on the shared axis; series A stacks from an upper baseline
  // placed just above series B's tallest stack.
  const laneABaselineY = valuesB
    ? axisY - 14 - (maxStackB - 1) * 18 - laneGap
    : axisY;
  const dots = stackDots(spec.values, laneABaselineY);
  const dotsB = valuesB ? stackDots(valuesB, axisY) : undefined;
  return {
    width,
    height,
    axisX1,
    axisX2,
    axisY,
    ticks: tickValues.map((value) => ({
      value,
      text: formatAxisValue(value, spec.fractionDenominator),
      x: x(value),
      y: axisY + 24,
      tickTop: axisY - 5,
      tickBottom: axisY + 6,
    })),
    dots,
    dotsB,
    laneABaseline: valuesB
      ? { x1: axisX1, y1: laneABaselineY, x2: axisX2, y2: laneABaselineY }
      : undefined,
    seriesLabels: valuesB
      ? [
          { text: spec.seriesALabel ?? "Set A", x: axisX1 / 2 - 2, y: laneABaselineY - 14 },
          { text: spec.seriesBLabel ?? "Set B", x: axisX1 / 2 - 2, y: axisY - 14 },
        ]
      : undefined,
    axisLabel: { text: spec.axisLabel, x: (axisX1 + axisX2) / 2, y: height - 4 },
    marker: spec.marker
      ? {
          x: x(spec.marker.value),
          y1: 18,
          y2: axisY + 7,
          label: { text: spec.marker.label, x: x(spec.marker.value), y: 13 },
        }
      : undefined,
  };
}

export function numberLineGeometry(spec: NumberLinePromptVisual): NumberLineGeometry {
  const [min, max] = sanitizeAxisRange(spec.min, spec.max);
  const denominator = spec.fractionDenominator ?? 1;
  const minimumStep = Math.max(
    1 / denominator,
    Math.ceil(((max - min) / 20) * denominator) / denominator,
  );
  const step = clampNumber(spec.step, minimumStep, max - min);
  const width = 340;
  const height = 150;
  const axisX1 = 28;
  const axisX2 = 312;
  const axisY = 70;
  const x = (value: number) => axisX1 + ((value - min) / (max - min)) * (axisX2 - axisX1);
  const snap = (value: number) => snapAxisValue(value, min, max, step);
  const unlabeled = new Set((spec.unlabeledTicks ?? []).map(snap));
  const tickValues = axisValues(min, max, step);
  if (tickValues[tickValues.length - 1] !== max) tickValues.push(max);
  const points = (spec.points ?? []).slice(0, 12).map((point, index) => {
    const value = snap(point.value);
    const pointX = x(value);
    const highlighted = point.highlighted ?? false;
    return {
      index,
      value,
      x: pointX,
      y: axisY,
      radius: highlighted ? 7 : 5.5,
      highlighted,
      label: point.label
        ? { text: point.label, x: pointX, y: axisY - 17 }
        : undefined,
    };
  });
  const interval = spec.interval
    ? (() => {
        const from = Math.min(snap(spec.interval.from), snap(spec.interval.to));
        const to = Math.max(snap(spec.interval.from), snap(spec.interval.to));
        const fromX = x(from);
        const toX = x(to);
        return {
          x: fromX,
          y: axisY - 8,
          width: Math.max(2, toX - fromX),
          height: 16,
          fromX,
          toX,
          includeFrom: spec.interval.includeFrom,
          includeTo: spec.interval.includeTo,
          label: spec.interval.label
            ? { text: spec.interval.label, x: (fromX + toX) / 2, y: axisY - 22 }
            : undefined,
        };
      })()
    : undefined;
  return {
    width,
    height,
    axisX1,
    axisX2,
    axisY,
    arrowPaths: [
      `M ${axisX1} ${axisY} L ${axisX1 + 9} ${axisY - 5} L ${axisX1 + 9} ${axisY + 5} Z`,
      `M ${axisX2} ${axisY} L ${axisX2 - 9} ${axisY - 5} L ${axisX2 - 9} ${axisY + 5} Z`,
    ],
    ticks: tickValues.map((value) => ({
      value,
      text: unlabeled.has(value) ? "" : formatAxisValue(value, spec.fractionDenominator),
      labeled: !unlabeled.has(value),
      x: x(value),
      y: axisY + 25,
      tickTop: axisY - 6,
      tickBottom: axisY + 7,
    })),
    points,
    interval,
    axisLabel: spec.axisLabel
      ? { text: spec.axisLabel, x: (axisX1 + axisX2) / 2, y: height - 5 }
      : undefined,
  };
}

function lerpPoint(
  a: { x: number; y: number },
  b: { x: number; y: number },
  t: number,
): { x: number; y: number } {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

function lineBetween(
  a: { x: number; y: number },
  b: { x: number; y: number },
): GeometryLine {
  return { x1: a.x, y1: a.y, x2: b.x, y2: b.y };
}
