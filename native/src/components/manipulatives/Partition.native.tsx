/**
 * Partition (native) — the RN port of the web Partition. A whole cut into equal
 * wedges: TAP a wedge to shade (contiguous fill), and STEP the number of parts.
 * Isolates unit fractions, numerator/denominator, and — with two discs —
 * equivalence across unlike denominators. Challenge examples: "Make one half"
 * (2/4, 3/6 … all light up), "Shade both the same".
 *
 * No drag here (tap + stepper only), so this needs neither `useMovableHandle`
 * nor the ScrollView arbitration — react-native-svg's `<Path onPress>` handles
 * the wedge taps, with a generous whole-disc size so each wedge is an easy
 * target. The wedge geometry + the contiguous-fill tap rule are copied verbatim
 * from the web version; the math (`partitionSolved`, `initialPartition`,
 * `fractionValue`) is reused from the shared logic layer.
 */

import { useState } from "react";
import { StyleSheet, View } from "react-native";
import Svg, { Circle, G, Path } from "react-native-svg";

import { initialPartition, partitionSolved } from "../../../vendor/manipulative/logic";
import type { PartitionState } from "../../../vendor/manipulative/logic";
import type { PartitionSpec } from "../../../vendor/manipulative/types";
import { selectionTick, type KindProps } from "./kit";
import { Stepper } from "./Stepper";
import { palette } from "@/theme";

const DISC_COLORS = [palette.cyan[500], palette.violet[500]];
const R = 92; // wedge radius
const CY = 104; // disc center y
const VBH = 220;

/** Point on a circle at `deg` clockwise from 12 o'clock (matches the web). */
function point(cx: number, cy: number, r: number, deg: number): [number, number] {
  const rad = (deg * Math.PI) / 180;
  return [cx + r * Math.sin(rad), cy - r * Math.cos(rad)];
}
function wedgePath(cx: number, cy: number, r: number, i: number, n: number): string {
  const a0 = (i * 360) / n;
  const a1 = ((i + 1) * 360) / n;
  const [x0, y0] = point(cx, cy, r, a0);
  const [x1, y1] = point(cx, cy, r, a1);
  const large = a1 - a0 > 180 ? 1 : 0;
  if (n === 1) {
    return `M ${cx - r},${cy} A ${r} ${r} 0 1 1 ${cx + r},${cy} A ${r} ${r} 0 1 1 ${cx - r},${cy} Z`;
  }
  return `M ${cx},${cy} L ${x0.toFixed(2)},${y0.toFixed(2)} A ${r} ${r} 0 ${large} 1 ${x1.toFixed(2)},${y1.toFixed(2)} Z`;
}

/** A wash of a hex color at the given alpha (RN accepts 8-digit hex). */
function wash(hex: string, alpha: number): string {
  const a = Math.round(alpha * 255)
    .toString(16)
    .padStart(2, "0");
  return `${hex}${a}`;
}

export function PartitionNative({
  spec,
  onSolvedChange,
  onStateChange,
}: KindProps<PartitionSpec, PartitionState>) {
  const [width, setWidth] = useState(0);
  const [state, setState] = useState<PartitionState>(() => initialPartition(spec));
  const [minParts, maxParts] = spec.partsRange ?? [1, 12];
  const canParts = spec.adjustable.includes("parts");
  const canShade = spec.adjustable.includes("shaded");

  const two = state.discs.length > 1;
  const vbW = two ? 500 : 300;
  const centers: Array<[number, number]> = two
    ? [
        [130, CY],
        [370, CY],
      ]
    : [[150, CY]];

  // Reactive width so the responsive Svg keeps a fixed aspect ratio.
  const svgHeight = width > 0 ? (width * VBH) / vbW : 0;

  const commit = (next: PartitionState) => {
    setState(next);
    onSolvedChange(partitionSolved(spec, next));
    onStateChange?.(next);
  };

  const setParts = (di: number, parts: number) => {
    commit({
      discs: state.discs.map((d, i) =>
        i === di ? { parts, shaded: Math.min(d.shaded, parts) } : d,
      ),
    });
  };

  const tapWedge = (di: number, i: number) => {
    if (!canShade) return;
    selectionTick();
    commit({
      discs: state.discs.map((d, idx) => {
        if (idx !== di) return d;
        // contiguous fill: tapping the last-shaded wedge unshades it, else fill up to i
        const shaded = d.shaded === i + 1 ? i : i + 1;
        return { ...d, shaded };
      }),
    });
  };

  const showSteppers = canParts;

  return (
    <View style={styles.wrap}>
      <View
        style={styles.stage}
        onLayout={(e) => setWidth(e.nativeEvent.layout.width)}
      >
        {svgHeight > 0 && (
          <Svg width={width} height={svgHeight} viewBox={`0 0 ${vbW} ${VBH}`}>
            {centers.map(([cx, cy], di) => {
              const disc = state.discs[di];
              const color = DISC_COLORS[di % DISC_COLORS.length];
              return (
                <G key={`disc-${di}`}>
                  <Circle
                    cx={cx}
                    cy={cy}
                    r={R + 3}
                    fill="none"
                    stroke={palette.gray[200]}
                    strokeWidth={2}
                  />
                  {Array.from({ length: disc.parts }, (_, i) => {
                    const filled = i < disc.shaded;
                    return (
                      <Path
                        key={`w-${i}`}
                        d={wedgePath(cx, cy, R, i, disc.parts)}
                        fill={filled ? wash(color, 0.7) : palette.gray[50]}
                        stroke={palette.navy[500]}
                        strokeWidth={1.5}
                        onPress={canShade ? () => tapWedge(di, i) : undefined}
                      />
                    );
                  })}
                </G>
              );
            })}
          </Svg>
        )}
      </View>

      {showSteppers && (
        <View style={[styles.controls, two && styles.controlsTwo]}>
          {state.discs.map((d, di) => (
            <Stepper
              key={`step-${di}`}
              value={d.parts}
              min={minParts}
              max={maxParts}
              label="parts"
              onChange={(v) => setParts(di, v)}
            />
          ))}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { width: "100%", gap: 14 },
  stage: { width: "100%" },
  controls: {
    flexDirection: "row",
    flexWrap: "wrap",
    justifyContent: "center",
    gap: 16,
  },
  controlsTwo: { justifyContent: "space-around" },
});
