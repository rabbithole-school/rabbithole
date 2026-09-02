import { v } from "convex/values";

const countablesPromptVisualValidator = v.object({
  kind: v.literal("countables"),
  n: v.number(),
  motif: v.string(),
  layout: v.union(v.literal("scatter"), v.literal("grid"), v.literal("tenframe")),
  seed: v.number(),
});

const groupsPromptVisualValidator = v.object({
  kind: v.literal("groups"),
  groups: v.number(),
  perGroup: v.number(),
  motif: v.string(),
  seed: v.number(),
});

const arrayPromptVisualValidator = v.object({
  kind: v.literal("array"),
  rows: v.number(),
  cols: v.number(),
  motif: v.string(),
});

const areaModelPromptVisualValidator = v.object({
  kind: v.literal("areamodel"),
  widthParts: v.array(v.number()),
  heightParts: v.array(v.number()),
});

const fractionPartPromptVisualValidator = v.object({
  kind: v.literal("fractionpart"),
  parts: v.number(),
  shaded: v.number(),
  shape: v.union(v.literal("bar"), v.literal("circle")),
});

const clockfacePromptVisualValidator = v.object({
  kind: v.literal("clockface"),
  hours: v.literal(12),
  highlightHour: v.optional(v.number()),
});

const labeledRectanglePromptVisualValidator = v.object({
  kind: v.literal("labeledRectangle"),
  width: v.number(),
  height: v.number(),
  unit: v.string(),
  showUnitGrid: v.boolean(),
});

const rectilinearUnitRectValidator = v.object({
  x: v.number(),
  y: v.number(),
  width: v.number(),
  height: v.number(),
});

const rectilinearSideLabelValidator = v.object({
  x1: v.number(),
  y1: v.number(),
  x2: v.number(),
  y2: v.number(),
  label: v.optional(v.string()),
});

const compositeRectilinearPromptVisualValidator = v.object({
  kind: v.literal("compositeRectilinear"),
  rects: v.array(rectilinearUnitRectValidator),
  sideLabels: v.array(rectilinearSideLabelValidator),
});

const anglePartValidator = v.object({
  degrees: v.number(),
  label: v.optional(v.string()),
});

const angleFigurePromptVisualValidator = v.object({
  kind: v.literal("angleFigure"),
  degrees: v.number(),
  orientation: v.number(),
  label: v.optional(v.string()),
  parts: v.optional(v.array(anglePartValidator)),
  showProtractorScale: v.optional(v.boolean()),
});

const coordinatePointValidator = v.object({
  x: v.number(),
  y: v.number(),
  label: v.string(),
});

const coordinatePlanePromptVisualValidator = v.object({
  kind: v.literal("coordinatePlane"),
  xMin: v.number(),
  xMax: v.number(),
  yMin: v.number(),
  yMax: v.number(),
  gridStep: v.number(),
  points: v.array(coordinatePointValidator),
  connect: v.optional(v.union(v.literal("segments"), v.literal("polygon"))),
});

const rectangularPrismPromptVisualValidator = v.object({
  kind: v.literal("rectangularPrism"),
  length: v.number(),
  width: v.number(),
  height: v.number(),
  unit: v.string(),
  showUnitCubes: v.boolean(),
});

const pictographRowValidator = v.object({
  label: v.string(),
  icons: v.number(),
});

const pictographPromptVisualValidator = v.object({
  kind: v.literal("pictograph"),
  rows: v.array(pictographRowValidator),
  key: v.number(),
});

const barGraphBarValidator = v.object({
  label: v.string(),
  value: v.optional(v.number()),
});

const barGraphPromptVisualValidator = v.object({
  kind: v.literal("barGraph"),
  bars: v.array(barGraphBarValidator),
  scaleMax: v.number(),
  scaleStep: v.number(),
  xAxisLabel: v.string(),
  yAxisLabel: v.string(),
  missingBarIndex: v.optional(v.number()),
});

const linePlotMarkerValidator = v.object({
  value: v.number(),
  label: v.string(),
});

const linePlotPromptVisualValidator = v.object({
  kind: v.literal("linePlot"),
  values: v.array(v.number()),
  valuesB: v.optional(v.array(v.number())),
  seriesALabel: v.optional(v.string()),
  seriesBLabel: v.optional(v.string()),
  axisMin: v.number(),
  axisMax: v.number(),
  axisStep: v.number(),
  fractionDenominator: v.optional(v.union(v.literal(2), v.literal(4))),
  axisLabel: v.string(),
  marker: v.optional(linePlotMarkerValidator),
});

const numberLinePointValidator = v.object({
  value: v.number(),
  label: v.optional(v.string()),
  highlighted: v.optional(v.boolean()),
});

const numberLineIntervalValidator = v.object({
  from: v.number(),
  to: v.number(),
  includeFrom: v.boolean(),
  includeTo: v.boolean(),
  label: v.optional(v.string()),
});

const numberLinePromptVisualValidator = v.object({
  kind: v.literal("numberLine"),
  min: v.number(),
  max: v.number(),
  step: v.number(),
  fractionDenominator: v.optional(v.union(v.literal(2), v.literal(4))),
  points: v.optional(v.array(numberLinePointValidator)),
  interval: v.optional(numberLineIntervalValidator),
  unlabeledTicks: v.optional(v.array(v.number())),
  axisLabel: v.optional(v.string()),
});

export const promptVisualValidator = v.union(
  countablesPromptVisualValidator,
  groupsPromptVisualValidator,
  arrayPromptVisualValidator,
  areaModelPromptVisualValidator,
  fractionPartPromptVisualValidator,
  clockfacePromptVisualValidator,
  labeledRectanglePromptVisualValidator,
  compositeRectilinearPromptVisualValidator,
  angleFigurePromptVisualValidator,
  coordinatePlanePromptVisualValidator,
  rectangularPrismPromptVisualValidator,
  pictographPromptVisualValidator,
  barGraphPromptVisualValidator,
  linePlotPromptVisualValidator,
  numberLinePromptVisualValidator,
);
