"use client";

/**
 * NumberLine — drag the Mafs movable knob to a spot on a fixed scale. Horizontal
 * lines trace the directed distance from their start; vertical lines reuse the
 * same value contract for elevation and floor scenes.
 */
import { useEffect } from "react";
import { Box, Text as ChakraText } from "@chakra-ui/react";
import {
  Line,
  Mafs,
  Point,
  Polygon,
  Text as MafsText,
  useMovablePoint,
} from "mafs";
import type { KindProps } from "../Manipulative";
import type { NumberLineSpec } from "@/lib/manipulative/types";
import { C } from "../colors";
import {
  clamp,
  initialNumberLine,
  multipleTrackLandings,
  normalizeNumberLineValue,
  numberLineSolved,
} from "@/lib/manipulative/logic";

const SCALE = 10;

function formatValue(value: number): string {
  return String(Number(value.toFixed(3)));
}

export function NumberLineManipulative(props: KindProps<NumberLineSpec>) {
  return props.spec.orientation === "vertical" ? (
    <VerticalNumberLine {...props} />
  ) : (
    <HorizontalNumberLine {...props} />
  );
}

function HorizontalNumberLine({ spec, onSolvedChange, onStateChange }: KindProps<NumberLineSpec>) {
  const span = spec.max - spec.min;
  const toInternal = (v: number) => ((v - spec.min) / span) * SCALE;
  const fromInternal = (ix: number) => spec.min + (ix / SCALE) * span;
  const snapInternal = spec.snap ? (spec.snap / span) * SCALE : undefined;

  const knob = useMovablePoint([toInternal(initialNumberLine(spec).value), 0], {
    constrain: ([x]) => {
      let ix = clamp(x, 0, SCALE);
      if (snapInternal) ix = clamp(Math.round(ix / snapInternal) * snapInternal, 0, SCALE);
      return [ix, 0];
    },
    color: C.violet,
  });
  const value = normalizeNumberLineValue(spec, fromInternal(knob.point[0]));
  const distance = Math.abs(value - spec.start);
  const hasMoved = distance > 1e-9;
  const direction = value < spec.start ? "left" : "right";
  const movementSummary = hasMoved
    ? `Started at ${formatValue(spec.start)}. Moved ${formatValue(distance)} ${direction}. Now at ${formatValue(value)}.`
    : `Start at ${formatValue(spec.start)}. Drag the dot left or right.`;

  useEffect(() => {
    onSolvedChange(numberLineSolved(spec, { value }));
    onStateChange?.({ value });
  }, [spec, value, onSolvedChange, onStateChange]);

  const ticks = numberLineTicks(spec);
  const pad = 0.5;
  const revealedTracks = multipleTrackLandings(spec.multipleTracks, value, spec.max);
  const hasTracks = spec.multipleTracks != null;

  return (
    <Box className="manip-mafs">
      <Mafs
        viewBox={{ x: [-pad, SCALE + pad], y: hasTracks ? [-3.2, 0.7] : [-1.4, 0.7] }}
        pan={false}
        zoom={false}
        height={hasTracks ? 230 : 140}
      >
        <Line.Segment point1={[0, 0]} point2={[SCALE, 0]} color={C.navy} weight={2.5} />
        {hasMoved && (
          <Line.Segment
            point1={[toInternal(spec.start), 0]}
            point2={[knob.point[0], 0]}
            color={C.violet}
            weight={12}
            opacity={0.24}
          />
        )}
        {ticks.map((v, i) => (
          <Line.Segment key={i} point1={[toInternal(v), -0.32]} point2={[toInternal(v), 0.32]} color={C.navy} />
        ))}
        {ticks.map((v, i) => (
          <MafsText key={`t${i}`} x={toInternal(v)} y={-0.85} size={17} color={C.charcoal}>
            {String(v)}
          </MafsText>
        ))}
        {(spec.markers ?? []).map((m, i) => (
          <Point key={`m${i}`} x={toInternal(m.value)} y={0} color={C.teal} />
        ))}
        {(spec.markers ?? []).map((m, i) =>
          m.label ? (
            <MafsText key={`ml${i}`} x={toInternal(m.value)} y={0.5} size={14} color={C.teal}>
              {m.label}
            </MafsText>
          ) : null,
        )}
        {hasTracks &&
          revealedTracks.common.map((landing) => (
            <Line.Segment
              key={`common-${landing}`}
              point1={[toInternal(landing), -1]}
              point2={[toInternal(landing), -2]}
              color={C.charcoal}
              weight={2}
              opacity={0.7}
            />
          ))}
        {hasTracks &&
          revealedTracks.tracks.map((landings, trackIndex) => {
            const lane = trackIndex === 0 ? -1 : -2;
            const color = trackIndex === 0 ? C.green : C.orange;
            const period = spec.multipleTracks![trackIndex];
            return (
              <g key={`track-${period}`}>
                <Line.Segment point1={[0, lane]} point2={[SCALE, lane]} color={C.line} weight={1.5} />
                <MafsText x={0.2} y={lane - 0.35} size={14} color={color}>
                  {period}s
                </MafsText>
                {landings.map((landing) => (
                  <Point key={landing} x={toInternal(landing)} y={lane} color={color} />
                ))}
              </g>
            );
          })}
        {hasMoved && <Point x={toInternal(spec.start)} y={0} color={C.orange} />}
        {knob.element}
      </Mafs>
      <ChakraText
        mt={-1}
        textAlign="center"
        fontSize="sm"
        fontWeight="700"
        color={hasMoved ? "brand.primary" : "fg.muted"}
      >
        {movementSummary}
      </ChakraText>
    </Box>
  );
}

function VerticalNumberLine({ spec, onSolvedChange, onStateChange }: KindProps<NumberLineSpec>) {
  const span = spec.max - spec.min;
  const toInternal = (v: number) => ((v - spec.min) / span) * SCALE;
  const fromInternal = (iy: number) => spec.min + (iy / SCALE) * span;
  const snapInternal = spec.snap ? (spec.snap / span) * SCALE : undefined;
  const scene = spec.scene;
  const actorLabel =
    spec.handleLabel ??
    (scene?.type === "building"
      ? "Elevator"
      : scene?.type === "mountain"
        ? "Hiker"
        : undefined);
  const controlLabel =
    actorLabel
      ? `Move the ${actorLabel.toLowerCase()} along the vertical number line`
      : "Move the marker along the vertical number line";

  const knob = useMovablePoint([0, toInternal(spec.start)], {
    constrain: ([, y]) => {
      let iy = clamp(y, 0, SCALE);
      if (snapInternal) iy = clamp(Math.round(iy / snapInternal) * snapInternal, 0, SCALE);
      return [0, iy];
    },
    color: C.violet,
  });
  const value = normalizeNumberLineValue(spec, fromInternal(knob.point[1]));

  useEffect(() => {
    onSolvedChange(numberLineSolved(spec, { value }));
    onStateChange?.({ value });
  }, [spec, value, onSolvedChange, onStateChange]);

  const ticks = numberLineTicks(spec);
  const zeroY = toInternal(0);
  const hasZero = spec.min <= 0 && spec.max >= 0;

  return (
    <div className="manip-mafs" role="group" aria-label={controlLabel}>
      <span
        aria-live="polite"
        style={{
          position: "absolute",
          width: 1,
          height: 1,
          padding: 0,
          margin: -1,
          overflow: "hidden",
          clip: "rect(0, 0, 0, 0)",
          whiteSpace: "nowrap",
          border: 0,
        }}
      >
        {actorLabel ?? "Marker"} at {value}
      </span>
      <Mafs
        viewBox={{ x: [-2.2, 3.3], y: [-0.55, SCALE + 0.55] }}
        preserveAspectRatio={false}
        pan={false}
        zoom={false}
        height={360}
      >
        {scene?.type === "mountain" && hasZero && (
          <MountainScene seaLevel={zeroY} />
        )}
        {scene?.type === "building" && (
          <BuildingScene ticks={ticks} toInternal={toInternal} zeroY={zeroY} hasZero={hasZero} />
        )}
        {hasZero && (
          <Line.Segment point1={[-1.8, zeroY]} point2={[3.1, zeroY]} color={C.teal} weight={3} />
        )}
        <Line.Segment point1={[0, 0]} point2={[0, SCALE]} color={C.navy} weight={3} />
        {ticks.map((v, i) => (
          <Line.Segment key={i} point1={[-0.24, toInternal(v)]} point2={[0.24, toInternal(v)]} color={C.navy} weight={2} />
        ))}
        {ticks.map((v, i) => (
          <MafsText key={`t${i}`} x={-0.62} y={toInternal(v) - 0.08} size={16} color={C.charcoal}>
            {String(v)}
          </MafsText>
        ))}
        {(spec.markers ?? []).map((m, i) => (
          <Point key={`m${i}`} x={0} y={toInternal(m.value)} color={C.teal} />
        ))}
        {(spec.markers ?? []).map((m, i) =>
          m.label ? (
            <MafsText key={`ml${i}`} x={-1.85} y={toInternal(m.value) + 0.25} size={13} color={C.teal}>
              {m.label}
            </MafsText>
          ) : null,
        )}
        {scene?.type === "building" && (
          <Polygon
            points={[
              [0.72, knob.point[1] - 0.32],
              [0.72, knob.point[1] + 0.32],
              [1.78, knob.point[1] + 0.32],
              [1.78, knob.point[1] - 0.32],
            ]}
            color={C.violet}
            fillOpacity={0.18}
            weight={2}
          />
        )}
        {actorLabel && (
          <MafsText x={1.25} y={knob.point[1] + 0.12} size={14} color={C.charcoal}>
            {actorLabel}
          </MafsText>
        )}
        {knob.element}
      </Mafs>
    </div>
  );
}

function MountainScene({ seaLevel }: { seaLevel: number }) {
  const peak = Math.min(SCALE - 0.2, seaLevel + 5.8);
  return (
    <>
      <Polygon
        points={[
          [0.45, 0],
          [0.45, seaLevel],
          [3.1, seaLevel],
          [3.1, 0],
        ]}
        color={C.teal}
        fillOpacity={0.08}
        weight={0}
      />
      <Polygon
        points={[
          [0.45, seaLevel],
          [1.2, seaLevel + 1.5],
          [1.85, peak],
          [2.55, seaLevel + 2.1],
          [3.1, seaLevel],
        ]}
        color={C.green}
        fillOpacity={0.25}
        weight={2}
      />
    </>
  );
}

function BuildingScene({
  ticks,
  toInternal,
  zeroY,
  hasZero,
}: {
  ticks: number[];
  toInternal: (value: number) => number;
  zeroY: number;
  hasZero: boolean;
}) {
  return (
    <>
      <Polygon points={[[0.65, 0], [0.65, SCALE], [2.65, SCALE], [2.65, 0]]} color={C.navy} fillOpacity={0.06} weight={2} />
      {hasZero && zeroY > 0 && (
        <Polygon
          points={[[0.65, 0], [0.65, zeroY], [2.65, zeroY], [2.65, 0]]}
          color={C.charcoal}
          fillOpacity={0.1}
          weight={0}
        />
      )}
      {ticks.map((value) => (
        hasZero && value === 0 ? null : (
        <Line.Segment
          key={value}
          point1={[0.65, toInternal(value)]}
          point2={[2.65, toInternal(value)]}
          color={C.navy}
          weight={1}
        />
        )
      ))}
    </>
  );
}

function numberLineTicks(spec: NumberLineSpec): number[] {
  const ticks: number[] = [];
  for (let v = spec.min; v <= spec.max + 1e-9; v += spec.tickStep) {
    ticks.push(Math.round(v * 1e6) / 1e6);
  }
  return ticks;
}
