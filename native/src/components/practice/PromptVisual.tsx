import type { ReactNode } from "react";
import { View } from "react-native";
import Svg, { Circle, Defs, G, Line, Path, Polygon, RadialGradient, Rect, Stop, Text as SvgText } from "react-native-svg";

import {
  angleFigureAccessibilityLabel,
  angleFigureGeometry,
  areaModelAccessibilityLabel,
  areaModelGeometry,
  arrayAccessibilityLabel,
  arrayGeometry,
  barGraphAccessibilityLabel,
  barGraphGeometry,
  clockfaceAccessibilityLabel,
  clockfaceGeometry,
  compositeRectilinearAccessibilityLabel,
  compositeRectilinearGeometry,
  coordinatePlaneAccessibilityLabel,
  coordinatePlaneGeometry,
  fractionPartAccessibilityLabel,
  fractionPartGeometry,
  groupsAccessibilityLabel,
  groupsGeometry,
  labeledRectangleAccessibilityLabel,
  labeledRectangleGeometry,
  linePlotAccessibilityLabel,
  linePlotGeometry,
  numberLineAccessibilityLabel,
  numberLineGeometry,
  pictographAccessibilityLabel,
  pictographGeometry,
  rectangularPrismAccessibilityLabel,
  rectangularPrismGeometry,
  type AngleFigurePromptVisual,
  type AreaModelPromptVisual,
  type ArrayPromptVisual,
  type BarGraphPromptVisual,
  type ClockfacePromptVisual,
  type CompositeRectilinearPromptVisual,
  type CoordinatePlanePromptVisual,
  type CountablePoint,
  type FractionPartPromptVisual,
  type GeometryLabel,
  type GroupsPromptVisual,
  type LabeledRectanglePromptVisual,
  layoutFractionLabel,
  type LinePlotPromptVisual,
  type NumberLinePromptVisual,
  type PictographIcon,
  type PictographPromptVisual,
  type PracticePromptVisual as PracticePromptVisualSpec,
  type RectangularPrismPromptVisual,
} from "../../../vendor/shared/practicePromptVisual";
import { CountablesPromptVisual } from "./CountablesPromptVisual";

const DOT_FILL = "#16707e";
const DOT_STROKE = "#0f4f59";
const FRAME_STROKE = "#ded8cb";
const FRAME_FILL = "#fffdfa";
const WARM_FILL = "#f4efe3";
const WARM_ACCENT = "#d79b54";
const TEXT = "#3f3528";
// Second dot series in a two-series line plot: the house warm hue, with a
// darker stroke so the solid dots stay distinct from the dashed warm marker.
const SERIES_B_FILL = "#d79b54";
const SERIES_B_STROKE = "#8a5a24";
// Neutral ink for line-plot ANNOTATIONS (the mean/balance-point marker and the
// two-series lane baseline). These mark a reference position, not a data
// category, so they must not borrow a series hue — teal is Set A, warm/orange is
// Set B, and nothing else. A medium warm-gray keeps hue doing exactly one job.
const MARKER_NEUTRAL = "#8a857c";

export function PromptVisual({ spec }: { spec: PracticePromptVisualSpec }) {
  switch (spec.kind) {
    case "countables":
      return <CountablesPromptVisual spec={spec} />;
    case "groups":
      return <GroupsPromptVisual spec={spec} />;
    case "array":
      return <ArrayPromptVisual spec={spec} />;
    case "areamodel":
      return <AreaModelPromptVisual spec={spec} />;
    case "fractionpart":
      return <FractionPartPromptVisual spec={spec} />;
    case "clockface":
      return <ClockfacePromptVisual spec={spec} />;
    case "labeledRectangle":
      return <LabeledRectanglePromptVisual spec={spec} />;
    case "compositeRectilinear":
      return <CompositeRectilinearPromptVisual spec={spec} />;
    case "angleFigure":
      return <AngleFigurePromptVisual spec={spec} />;
    case "coordinatePlane":
      return <CoordinatePlanePromptVisual spec={spec} />;
    case "rectangularPrism":
      return <RectangularPrismPromptVisual spec={spec} />;
    case "pictograph":
      return <PictographPromptVisual spec={spec} />;
    case "barGraph":
      return <BarGraphPromptVisual spec={spec} />;
    case "linePlot":
      return <LinePlotPromptVisual spec={spec} />;
    case "numberLine":
      return <NumberLinePromptVisual spec={spec} />;
    default:
      return null;
  }
}

function VisualFrame({
  label,
  width,
  height,
  children,
}: {
  label: string;
  width: number;
  height: number;
  children: ReactNode;
}) {
  return (
    <View accessible accessibilityRole="image" accessibilityLabel={label} style={{ width: "100%", alignItems: "center" }}>
      <Svg width={width} height={height} viewBox={`0 0 ${width} ${height}`}>
        {children}
      </Svg>
    </View>
  );
}

function DotDefs({ id }: { id: string }) {
  return (
    <Defs>
      <RadialGradient id={id} cx="35%" cy="30%" r="70%">
        <Stop offset="0%" stopColor="#39a2b1" />
        <Stop offset="100%" stopColor={DOT_FILL} />
      </RadialGradient>
    </Defs>
  );
}

function MotifPoint({ point, motif, gradientId }: { point: CountablePoint; motif: string; gradientId: string }) {
  switch (motif) {
    case "dot":
    default:
      return (
        <G transform={`translate(${point.x}, ${point.y}) rotate(${point.rotation}) scale(${point.scale})`}>
          <Circle cx={0} cy={0} r={point.r} fill={`url(#${gradientId})`} stroke={DOT_STROKE} strokeWidth={1.4} />
        </G>
      );
  }
}

function GroupsPromptVisual({ spec }: { spec: GroupsPromptVisual }) {
  const geometry = groupsGeometry(spec);
  const gradientId = "groupsDot";
  return (
    <VisualFrame label={groupsAccessibilityLabel(spec)} width={geometry.width} height={geometry.height}>
      <DotDefs id={gradientId} />
      {geometry.boxes.map((box) => (
        <Rect
          key={box.index}
          x={box.x}
          y={box.y}
          width={box.width}
          height={box.height}
          rx={14}
          fill={FRAME_FILL}
          stroke={FRAME_STROKE}
          strokeWidth={1.6}
        />
      ))}
      {geometry.points.map((point) => (
        <MotifPoint key={point.index} point={point} motif={spec.motif} gradientId={gradientId} />
      ))}
    </VisualFrame>
  );
}

function ArrayPromptVisual({ spec }: { spec: ArrayPromptVisual }) {
  const geometry = arrayGeometry(spec);
  const gradientId = "arrayDot";
  return (
    <VisualFrame label={arrayAccessibilityLabel(spec)} width={geometry.width} height={geometry.height}>
      <DotDefs id={gradientId} />
      {geometry.points.map((point) => (
        <MotifPoint key={point.index} point={point} motif={spec.motif} gradientId={gradientId} />
      ))}
    </VisualFrame>
  );
}

function AreaModelPromptVisual({ spec }: { spec: AreaModelPromptVisual }) {
  const geometry = areaModelGeometry(spec);
  return (
    <VisualFrame label={areaModelAccessibilityLabel(spec)} width={geometry.width} height={geometry.height}>
      {geometry.topLabels.map((label) => (
        <SvgText key={`top-${label.index}`} x={label.x + label.width / 2} y={label.y + 17} textAnchor="middle" fontSize={16} fill={TEXT} fontWeight="700">
          {label.text}
        </SvgText>
      ))}
      {geometry.sideLabels.map((label) => (
        <SvgText key={`side-${label.index}`} x={label.x + label.width / 2} y={label.y + label.height / 2 + 5} textAnchor="middle" fontSize={16} fill={TEXT} fontWeight="700">
          {label.text}
        </SvgText>
      ))}
      <Line x1={geometry.gridX} y1={34} x2={geometry.gridX + geometry.gridWidth} y2={34} stroke={FRAME_STROKE} strokeWidth={1.4} />
      <Line x1={52} y1={geometry.gridY} x2={52} y2={geometry.gridY + geometry.gridHeight} stroke={FRAME_STROKE} strokeWidth={1.4} />
      {geometry.cells.map((cell) => (
        <G key={`${cell.row}-${cell.col}`}>
          <Rect
            x={cell.x}
            y={cell.y}
            width={cell.width}
            height={cell.height}
            fill={(cell.row + cell.col) % 2 === 0 ? FRAME_FILL : WARM_FILL}
            stroke={FRAME_STROKE}
            strokeWidth={1.6}
          />
          <SvgText x={cell.x + cell.width / 2} y={cell.y + cell.height / 2 + 6} textAnchor="middle" fontSize={18} fill={DOT_STROKE} fontWeight="800">
            {cell.label}
          </SvgText>
        </G>
      ))}
    </VisualFrame>
  );
}

function FractionPartPromptVisual({ spec }: { spec: FractionPartPromptVisual }) {
  const geometry = fractionPartGeometry(spec);
  return (
    <VisualFrame label={fractionPartAccessibilityLabel(spec)} width={geometry.width} height={geometry.height}>
      {spec.shape === "circle"
        ? geometry.segments.map((segment) => (
            <Path
              key={segment.index}
              d={segment.path ?? ""}
              fill={segment.shaded ? DOT_FILL : FRAME_FILL}
              stroke={FRAME_STROKE}
              strokeWidth={1.4}
            />
          ))
        : geometry.segments.map((segment) => (
            <Rect
              key={segment.index}
              x={segment.x}
              y={segment.y}
              width={segment.width}
              height={segment.height}
              rx={segment.index === 0 || segment.index === spec.parts - 1 ? 10 : 0}
              fill={segment.shaded ? DOT_FILL : FRAME_FILL}
              stroke={FRAME_STROKE}
              strokeWidth={1.4}
            />
          ))}
    </VisualFrame>
  );
}

function ClockfacePromptVisual({ spec }: { spec: ClockfacePromptVisual }) {
  const geometry = clockfaceGeometry(spec);
  const highlighted = geometry.ticks.find((tick) => tick.highlighted);
  return (
    <VisualFrame label={clockfaceAccessibilityLabel(spec)} width={geometry.width} height={geometry.height}>
      <Circle cx={geometry.centerX} cy={geometry.centerY} r={geometry.radius} fill={FRAME_FILL} stroke={FRAME_STROKE} strokeWidth={2} />
      {geometry.ticks.map((tick) => (
        <G key={tick.hour}>
          <Circle cx={tick.x} cy={tick.y} r={tick.highlighted ? 8 : 3.5} fill={tick.highlighted ? WARM_ACCENT : DOT_STROKE} opacity={tick.highlighted ? 1 : 0.45} />
          <SvgText x={tick.labelX} y={tick.labelY + 5} textAnchor="middle" fontSize={14} fill={TEXT} fontWeight={tick.highlighted ? "800" : "600"}>
            {tick.hour}
          </SvgText>
        </G>
      ))}
      {highlighted ? (
        <Line x1={geometry.centerX} y1={geometry.centerY} x2={highlighted.x} y2={highlighted.y} stroke={WARM_ACCENT} strokeWidth={4} strokeLinecap="round" />
      ) : null}
      <Circle cx={geometry.centerX} cy={geometry.centerY} r={5} fill={DOT_STROKE} />
    </VisualFrame>
  );
}

// Renders a label's text as plain SVG text, UNLESS it contains a fraction or
// mixed number (e.g. "2 1/2", formatAxisValue's output), in which case it
// stacks a numerator/vinculum/denominator the same way the stem's
// FractionText does — matching typography across the whole practice item.
// The non-fraction path is BYTE-IDENTICAL to the prior plain-`SvgText`
// rendering (same props), so every existing label is visually unaffected.
function FractionAwareLabel({
  text,
  x,
  y,
  fontSize,
  textAnchor = "middle",
  fontWeight,
  centered = false,
  rotation,
  fill = TEXT,
}: {
  text: string;
  x: number;
  y: number;
  fontSize: number;
  textAnchor?: "start" | "middle" | "end";
  fontWeight?: string;
  /** True for labels that vertically center on (x, y) via
   *  `alignmentBaseline="middle"` in the plain case (GeometryLabels) — shifts
   *  the baseline a fraction's runs use so the stacked glyph still centers
   *  on (x, y) the way the plain text did. */
  centered?: boolean;
  rotation?: number;
  fill?: string;
}) {
  const baselineY = centered ? y + fontSize * 0.35 : y;
  const layout = layoutFractionLabel(text, x, baselineY, fontSize, textAnchor);
  if (layout.kind === "plain") {
    return (
      <SvgText
        x={x}
        y={y}
        textAnchor={textAnchor}
        alignmentBaseline={centered ? "middle" : undefined}
        fontSize={fontSize}
        fill={fill}
        fontWeight={fontWeight}
        transform={rotation === undefined ? undefined : `rotate(${rotation} ${x} ${y})`}
      >
        {text}
      </SvgText>
    );
  }
  return (
    <G transform={rotation === undefined ? undefined : `rotate(${rotation} ${x} ${y})`}>
      {layout.runs.map((run, i) =>
        run.kind === "text" ? (
          <SvgText key={i} x={run.x} y={run.y} textAnchor="middle" fontSize={fontSize} fill={fill} fontWeight={fontWeight}>
            {run.text}
          </SvgText>
        ) : (
          <G key={i}>
            <SvgText x={run.x} y={run.numY} textAnchor="middle" fontSize={run.innerFontSize} fill={fill} fontWeight={fontWeight}>
              {run.num}
            </SvgText>
            <Line x1={run.barX1} x2={run.barX2} y1={run.barY} y2={run.barY} stroke={fill} strokeWidth={Math.max(1.3, fontSize * 0.1)} strokeLinecap="round" />
            <SvgText x={run.x} y={run.denY} textAnchor="middle" fontSize={run.innerFontSize} fill={fill} fontWeight={fontWeight}>
              {run.den}
            </SvgText>
          </G>
        ),
      )}
    </G>
  );
}

function GeometryLabels({
  labels,
  fontSize = 15,
  fill,
}: {
  labels: GeometryLabel[];
  fontSize?: number;
  fill?: string;
}) {
  return labels.map((label, index) => (
    <FractionAwareLabel
      key={`${label.text}-${index}`}
      text={label.text}
      x={label.x}
      y={label.y}
      fontSize={fontSize}
      fontWeight="700"
      centered
      rotation={label.rotation}
      fill={fill}
    />
  ));
}

function LabeledRectanglePromptVisual({ spec }: { spec: LabeledRectanglePromptVisual }) {
  const geometry = labeledRectangleGeometry(spec);
  return (
    <VisualFrame label={labeledRectangleAccessibilityLabel(spec)} width={geometry.width} height={geometry.height}>
      <Rect
        x={geometry.rectX}
        y={geometry.rectY}
        width={geometry.rectWidth}
        height={geometry.rectHeight}
        rx={6}
        fill={FRAME_FILL}
        stroke={DOT_STROKE}
        strokeWidth={2.4}
      />
      {geometry.gridLines.map((line, index) => (
        <Line key={index} {...line} stroke={FRAME_STROKE} strokeWidth={1.3} />
      ))}
      <GeometryLabels labels={geometry.labels} fontSize={16} />
    </VisualFrame>
  );
}

function CompositeRectilinearPromptVisual({ spec }: { spec: CompositeRectilinearPromptVisual }) {
  const geometry = compositeRectilinearGeometry(spec);
  return (
    <VisualFrame label={compositeRectilinearAccessibilityLabel(spec)} width={geometry.width} height={geometry.height}>
      {geometry.cells.map((cell, index) => (
        <Rect key={index} {...cell} fill={FRAME_FILL} />
      ))}
      {geometry.boundaryLines.map((line, index) => (
        <Line key={index} {...line} stroke={DOT_STROKE} strokeWidth={2.5} strokeLinecap="round" />
      ))}
      <GeometryLabels labels={geometry.labels} fontSize={16} />
    </VisualFrame>
  );
}

function AngleFigurePromptVisual({ spec }: { spec: AngleFigurePromptVisual }) {
  const geometry = angleFigureGeometry(spec);
  return (
    <VisualFrame label={angleFigureAccessibilityLabel(spec)} width={geometry.width} height={geometry.height}>
      {geometry.protractorScale && (
        <G opacity={0.82}>
          <Path
            d={geometry.protractorScale.arcPath}
            fill="none"
            stroke={DOT_STROKE}
            strokeWidth={2}
          />
          <Line
            {...geometry.protractorScale.baseline}
            stroke={DOT_STROKE}
            strokeWidth={2}
          />
          {geometry.protractorScale.ticks.map((tick) => (
            <Line
              key={tick.degrees}
              x1={tick.x1}
              y1={tick.y1}
              x2={tick.x2}
              y2={tick.y2}
              stroke={tick.major ? DOT_STROKE : TEXT}
              strokeWidth={tick.major ? 1.8 : 1}
            />
          ))}
          <GeometryLabels labels={geometry.protractorScale.labels} fontSize={9} />
        </G>
      )}
      {geometry.rays.map((ray, index) => (
        <Line key={index} {...ray} stroke={DOT_STROKE} strokeWidth={3} strokeLinecap="round" />
      ))}
      <Path d={geometry.arcPath} fill="none" stroke={WARM_ACCENT} strokeWidth={3.2} strokeLinecap="round" />
      {geometry.partArcs.map((part) => (
        <Path key={part.index} d={part.path} fill="none" stroke={DOT_FILL} strokeWidth={2} opacity={0.72} />
      ))}
      <Circle cx={geometry.vertexX} cy={geometry.vertexY} r={5.5} fill={DOT_STROKE} />
      {/* Labels match their arc's color; the total uses the darker shade of the
          arc's amber (SERIES_B_STROKE) — WARM_ACCENT itself is too low-contrast
          for 15px text. */}
      <GeometryLabels
        labels={geometry.totalLabel ? [geometry.totalLabel] : []}
        fontSize={15}
        fill={SERIES_B_STROKE}
      />
      <GeometryLabels
        labels={geometry.partArcs.flatMap((part) => (part.label ? [part.label] : []))}
        fontSize={15}
        fill={DOT_FILL}
      />
    </VisualFrame>
  );
}

function CoordinatePlanePromptVisual({ spec }: { spec: CoordinatePlanePromptVisual }) {
  const geometry = coordinatePlaneGeometry(spec);
  const path = geometry.path ? `${geometry.path}${geometry.closePath ? " Z" : ""}` : undefined;
  return (
    <VisualFrame label={coordinatePlaneAccessibilityLabel(spec)} width={geometry.width} height={geometry.height}>
      <Rect
        x={geometry.plotX}
        y={geometry.plotY}
        width={geometry.plotWidth}
        height={geometry.plotHeight}
        fill={FRAME_FILL}
        stroke={FRAME_STROKE}
        strokeWidth={1.5}
      />
      {[...geometry.verticalLines, ...geometry.horizontalLines].map((line, index) => (
        <Line
          key={index}
          x1={line.x1}
          y1={line.y1}
          x2={line.x2}
          y2={line.y2}
          stroke={line.axis ? DOT_STROKE : FRAME_STROKE}
          strokeWidth={line.axis ? 2.2 : 1}
        />
      ))}
      {path ? (
        <Path
          d={path}
          fill={geometry.closePath ? WARM_FILL : "none"}
          fillOpacity={0.64}
          stroke={WARM_ACCENT}
          strokeWidth={3}
          strokeLinejoin="round"
        />
      ) : null}
      {geometry.xTicks.map((tick) => (
        <FractionAwareLabel key={`x-${tick.value}`} text={tick.text} x={tick.x} y={tick.y} fontSize={11} textAnchor="middle" />
      ))}
      {geometry.yTicks.map((tick) => (
        <FractionAwareLabel key={`y-${tick.value}`} text={tick.text} x={tick.x} y={tick.y} fontSize={11} textAnchor="end" />
      ))}
      {geometry.points.map((point) => (
        <G key={point.index}>
          <Circle cx={point.plotX} cy={point.plotY} r={5.5} fill={DOT_FILL} stroke={DOT_STROKE} strokeWidth={1.5} />
          <SvgText x={point.labelX} y={point.labelY} fontSize={14} fill={TEXT} fontWeight="800">
            {point.label}
          </SvgText>
        </G>
      ))}
    </VisualFrame>
  );
}

function RectangularPrismPromptVisual({ spec }: { spec: RectangularPrismPromptVisual }) {
  const geometry = rectangularPrismGeometry(spec);
  const [frontTopLeft, frontTopRight, frontBottomRight, frontBottomLeft, backTopLeft, backTopRight, backBottomRight] = geometry.vertices;
  const points = (vertices: { x: number; y: number }[]) => vertices.map((point) => `${point.x},${point.y}`).join(" ");
  return (
    <VisualFrame label={rectangularPrismAccessibilityLabel(spec)} width={geometry.width} height={geometry.height}>
      <Polygon points={points([frontTopLeft, frontTopRight, backTopRight, backTopLeft])} fill={WARM_FILL} />
      <Polygon points={points([frontTopRight, frontBottomRight, backBottomRight, backTopRight])} fill="#efe6d5" />
      <Polygon points={points([frontTopLeft, frontTopRight, frontBottomRight, frontBottomLeft])} fill={FRAME_FILL} />
      {geometry.subdivisionLines.map((line, index) => (
        <Line key={index} {...line} stroke={FRAME_STROKE} strokeWidth={1.1} />
      ))}
      {geometry.edges.map((edge, index) => (
        <Line
          key={index}
          x1={edge.x1}
          y1={edge.y1}
          x2={edge.x2}
          y2={edge.y2}
          stroke={DOT_STROKE}
          strokeWidth={2.2}
          strokeDasharray={edge.dashed ? "5 4" : undefined}
          strokeLinecap="round"
        />
      ))}
      <GeometryLabels labels={geometry.labels} fontSize={15} />
    </VisualFrame>
  );
}

function halfIconPath(icon: PictographIcon): string {
  return [
    `M ${icon.x} ${icon.y - icon.radius}`,
    `A ${icon.radius} ${icon.radius} 0 0 0 ${icon.x} ${icon.y + icon.radius}`,
    `L ${icon.x} ${icon.y - icon.radius}`,
    "Z",
  ].join(" ");
}

function PictographPromptVisual({ spec }: { spec: PictographPromptVisual }) {
  const geometry = pictographGeometry(spec);
  return (
    <VisualFrame label={pictographAccessibilityLabel(spec)} width={geometry.width} height={geometry.height}>
      {geometry.rows.map((row) => (
        <SvgText key={row.index} x={row.x} y={row.y} textAnchor="end" fontSize={14} fill={TEXT} fontWeight="700">
          {row.label}
        </SvgText>
      ))}
      {geometry.icons.map((icon) => (
        <G key={`${icon.rowIndex}-${icon.iconIndex}`}>
          <Circle cx={icon.x} cy={icon.y} r={icon.radius} fill={FRAME_FILL} stroke={DOT_STROKE} strokeWidth={1.5} />
          {icon.half
            ? <Path d={halfIconPath(icon)} fill={DOT_FILL} />
            : <Circle cx={icon.x} cy={icon.y} r={icon.radius} fill={DOT_FILL} />}
        </G>
      ))}
      <Circle cx={geometry.keyIconX} cy={geometry.keyIconY} r={8} fill={DOT_FILL} stroke={DOT_STROKE} strokeWidth={1.3} />
      <SvgText x={geometry.keyTextX} y={geometry.keyIconY + 5} fontSize={13} fill={TEXT} fontWeight="700">
        {geometry.keyText}
      </SvgText>
    </VisualFrame>
  );
}

function BarGraphPromptVisual({ spec }: { spec: BarGraphPromptVisual }) {
  const geometry = barGraphGeometry(spec);
  return (
    <VisualFrame label={barGraphAccessibilityLabel(spec)} width={geometry.width} height={geometry.height}>
      {geometry.gridLines.map((line) => (
        <Line key={line.value} {...line} stroke={FRAME_STROKE} strokeWidth={1} />
      ))}
      <Line x1={geometry.plotX} y1={geometry.plotY} x2={geometry.plotX} y2={geometry.plotY + geometry.plotHeight} stroke={DOT_STROKE} strokeWidth={2.2} />
      <Line x1={geometry.plotX} y1={geometry.plotY + geometry.plotHeight} x2={geometry.plotX + geometry.plotWidth} y2={geometry.plotY + geometry.plotHeight} stroke={DOT_STROKE} strokeWidth={2.2} />
      {geometry.yTicks.map((tick) => (
        <SvgText key={tick.value} x={tick.x} y={tick.y} textAnchor="end" fontSize={11} fill={TEXT}>
          {tick.text}
        </SvgText>
      ))}
      {geometry.bars.map((bar) => (
        <G key={bar.index}>
          <Rect
            x={bar.x}
            y={bar.y}
            width={bar.width}
            height={bar.height}
            rx={4}
            fill={bar.missing ? WARM_FILL : DOT_FILL}
            fillOpacity={bar.missing ? 0.5 : 1}
            stroke={bar.missing ? WARM_ACCENT : DOT_STROKE}
            strokeWidth={bar.missing ? 2.5 : 1.5}
            strokeDasharray={bar.missing ? "6 4" : undefined}
          />
          {bar.missing ? (
            <SvgText x={bar.x + bar.width / 2} y={geometry.plotY + geometry.plotHeight / 2 + 9} textAnchor="middle" fontSize={28} fill={WARM_ACCENT} fontWeight="800">
              ?
            </SvgText>
          ) : null}
          <SvgText x={bar.x + bar.width / 2} y={geometry.plotY + geometry.plotHeight + 18} textAnchor="middle" fontSize={12} fill={TEXT} fontWeight="700">
            {bar.label}
          </SvgText>
        </G>
      ))}
      <GeometryLabels labels={geometry.axisLabels} fontSize={13} />
    </VisualFrame>
  );
}

function LinePlotPromptVisual({ spec }: { spec: LinePlotPromptVisual }) {
  const geometry = linePlotGeometry(spec);
  return (
    <VisualFrame label={linePlotAccessibilityLabel(spec)} width={geometry.width} height={geometry.height}>
      {geometry.marker ? (
        <G>
          <Line
            x1={geometry.marker.x}
            y1={geometry.marker.y1}
            x2={geometry.marker.x}
            y2={geometry.marker.y2}
            stroke={MARKER_NEUTRAL}
            strokeWidth={2.5}
            strokeDasharray="5 4"
          />
          <Path
            d={`M ${geometry.marker.x - 7} ${geometry.axisY + 9} L ${geometry.marker.x + 7} ${geometry.axisY + 9} L ${geometry.marker.x} ${geometry.axisY - 1} Z`}
            fill={MARKER_NEUTRAL}
          />
          <GeometryLabels labels={[geometry.marker.label]} fontSize={13} />
        </G>
      ) : null}
      <Line x1={geometry.axisX1} y1={geometry.axisY} x2={geometry.axisX2} y2={geometry.axisY} stroke={DOT_STROKE} strokeWidth={2.4} strokeLinecap="round" />
      {geometry.laneABaseline ? (
        <Line
          x1={geometry.laneABaseline.x1}
          y1={geometry.laneABaseline.y1}
          x2={geometry.laneABaseline.x2}
          y2={geometry.laneABaseline.y2}
          stroke={MARKER_NEUTRAL}
          strokeWidth={1.6}
          strokeDasharray="2 5"
          strokeLinecap="round"
          opacity={0.55}
        />
      ) : null}
      {geometry.ticks.map((tick) => (
        <G key={tick.value}>
          <Line x1={tick.x} y1={tick.tickTop} x2={tick.x} y2={tick.tickBottom} stroke={DOT_STROKE} strokeWidth={1.7} />
          <FractionAwareLabel text={tick.text} x={tick.x} y={tick.y} fontSize={11} textAnchor="middle" />
        </G>
      ))}
      {geometry.dots.map((dot) => (
        <Circle key={dot.index} cx={dot.x} cy={dot.y} r={dot.radius} fill={DOT_FILL} stroke={DOT_STROKE} strokeWidth={1.3} />
      ))}
      {geometry.dotsB?.map((dot) => (
        <Circle key={dot.index} cx={dot.x} cy={dot.y} r={dot.radius} fill={SERIES_B_FILL} stroke={SERIES_B_STROKE} strokeWidth={1.3} />
      ))}
      {geometry.seriesLabels ? (
        <G>
          <SvgText x={geometry.seriesLabels[0].x} y={geometry.seriesLabels[0].y} textAnchor="middle" alignmentBaseline="middle" fontSize={12} fill={DOT_STROKE} fontWeight="700">
            {geometry.seriesLabels[0].text}
          </SvgText>
          <SvgText x={geometry.seriesLabels[1].x} y={geometry.seriesLabels[1].y} textAnchor="middle" alignmentBaseline="middle" fontSize={12} fill={SERIES_B_STROKE} fontWeight="700">
            {geometry.seriesLabels[1].text}
          </SvgText>
        </G>
      ) : null}
      <GeometryLabels labels={[geometry.axisLabel]} fontSize={13} />
    </VisualFrame>
  );
}

function NumberLinePromptVisual({ spec }: { spec: NumberLinePromptVisual }) {
  const geometry = numberLineGeometry(spec);
  return (
    <VisualFrame label={numberLineAccessibilityLabel(spec)} width={geometry.width} height={geometry.height}>
      {geometry.interval ? (
        <G>
          <Rect
            x={geometry.interval.x}
            y={geometry.interval.y}
            width={geometry.interval.width}
            height={geometry.interval.height}
            rx={8}
            fill={WARM_ACCENT}
            opacity={0.28}
          />
          <Circle
            cx={geometry.interval.fromX}
            cy={geometry.axisY}
            r={6.5}
            fill={geometry.interval.includeFrom ? WARM_ACCENT : FRAME_FILL}
            stroke={WARM_ACCENT}
            strokeWidth={2.4}
          />
          <Circle
            cx={geometry.interval.toX}
            cy={geometry.axisY}
            r={6.5}
            fill={geometry.interval.includeTo ? WARM_ACCENT : FRAME_FILL}
            stroke={WARM_ACCENT}
            strokeWidth={2.4}
          />
          {geometry.interval.label ? <GeometryLabels labels={[geometry.interval.label]} fontSize={13} /> : null}
        </G>
      ) : null}
      <Line x1={geometry.axisX1} y1={geometry.axisY} x2={geometry.axisX2} y2={geometry.axisY} stroke={DOT_STROKE} strokeWidth={2.5} />
      {geometry.arrowPaths.map((path) => <Path key={path} d={path} fill={DOT_STROKE} />)}
      {geometry.ticks.map((tick) => (
        <G key={tick.value}>
          <Line x1={tick.x} y1={tick.tickTop} x2={tick.x} y2={tick.tickBottom} stroke={DOT_STROKE} strokeWidth={1.7} />
          {tick.labeled ? <FractionAwareLabel text={tick.text} x={tick.x} y={tick.y} fontSize={11} textAnchor="middle" /> : null}
        </G>
      ))}
      {geometry.points.map((point) => (
        <G key={point.index}>
          <Circle
            cx={point.x}
            cy={point.y}
            r={point.radius}
            fill={point.highlighted ? WARM_ACCENT : DOT_FILL}
            stroke={point.highlighted ? WARM_ACCENT : DOT_STROKE}
            strokeWidth={1.7}
          />
          {point.label ? <GeometryLabels labels={[point.label]} fontSize={13} /> : null}
        </G>
      ))}
      {geometry.axisLabel ? <GeometryLabels labels={[geometry.axisLabel]} fontSize={13} /> : null}
    </VisualFrame>
  );
}
