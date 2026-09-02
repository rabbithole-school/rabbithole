/**
 * Balance (native) — the RN port of the web Balance. A pan balance that tilts by
 * (left − right): level means equal. With a hidden mystery block on the right it
 * becomes solve-for-x — add units to the left until it's level and you've found
 * the block's value without ever being told it (control of error). Weights are
 * added/removed with Steppers.
 *
 * Unlike the web SVG (which recomputes rotated coordinates on every render),
 * the native tilt is a single reanimated shared value driven with `withSpring`
 * for a little juice: the beam rotates about the fulcrum and the two pans
 * translate to follow its ends while staying upright — all on the UI thread.
 * The tilt/verdict math is reused verbatim from the shared logic layer
 * (`balanceTilt`, `balanceSolved`, `initialBalance`).
 */

import { useEffect, useState } from "react";
import { Image, StyleSheet, Text, View, type LayoutChangeEvent } from "react-native";
import Svg, { Circle, Path } from "react-native-svg";
import { useThemeIcon } from "./useThemeIcon";
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withSpring,
} from "react-native-reanimated";

import { balanceSolved, balanceTilt, initialBalance } from "../../../vendor/manipulative/logic";
import type { BalanceState } from "../../../vendor/manipulative/logic";
import { isChallenge, type BalanceSpec } from "../../../vendor/manipulative/types";
import type { KindProps } from "./kit";
import { Stepper } from "./Stepper";
import { fonts, palette } from "@/theme";

const STAGE_H = 250;
const PIVOT_Y = 66; // beam pivot height from the top of the stage
const BEAM_THICKNESS = 8;
const MAX_BEAM_HALF = 150; // cap so wide screens don't stretch the beam absurdly
const EDGE_PAD = 66; // room on each side for a pan
const PAN_W = 116;
const BLOCK = 15;
const BLOCK_GAP = 3;
const PER_ROW = 5;
const STRING_H = 34;

export function BalanceNative({
  spec,
  onSolvedChange,
  onStateChange,
}: KindProps<BalanceSpec, BalanceState>) {
  const [width, setWidth] = useState(0);
  const [state, setState] = useState<BalanceState>(() => initialBalance(spec));
  const maxUnits = spec.maxUnits ?? 12;
  // Generative charm: the mystery weight can render as a themed icon
  // (`theme.fill.label`). Its value is still exactly spec.mysteryRight — a 1:1
  // visual stand-in with a "?" badge kept on top (matches web).
  const mysteryIconHref = useThemeIcon(spec.theme);

  const pivotX = width / 2;
  const beamHalf = width > 0 ? Math.min(width / 2 - EDGE_PAD, MAX_BEAM_HALF) : 0;

  // Tilt in radians, animated. left-heavy => negative angle => left end dips
  // (larger y), matching the web mapping angle = clamp(-tilt*4, -15, 15) deg.
  const angle = useSharedValue(0);
  const tilt = balanceTilt(spec, state);

  useEffect(() => {
    const deg = Math.max(-15, Math.min(15, -tilt * 4));
    angle.set(withSpring((deg * Math.PI) / 180, {
      damping: 12,
      stiffness: 90,
    }));
  }, [tilt, angle]);

  useEffect(() => {
    onSolvedChange(balanceSolved(spec, state));
    onStateChange?.(state);
  }, [spec, state, onSolvedChange, onStateChange]);

  const beamStyle = useAnimatedStyle(() => ({
    transform: [{ rotate: `${angle.get()}rad` }],
  }));

  // Each pan hangs from a rotated beam end but stays upright — translate only.
  const leftPanStyle = useAnimatedStyle(() => {
    const a = angle.get();
    const lx = pivotX - beamHalf * Math.cos(a);
    const ly = PIVOT_Y - beamHalf * Math.sin(a);
    return { transform: [{ translateX: lx - PAN_W / 2 }, { translateY: ly }] };
  });
  const rightPanStyle = useAnimatedStyle(() => {
    const a = angle.get();
    const rx = pivotX + beamHalf * Math.cos(a);
    const ry = PIVOT_Y + beamHalf * Math.sin(a);
    return { transform: [{ translateX: rx - PAN_W / 2 }, { translateY: ry }] };
  });

  const onLayout = (e: LayoutChangeEvent) => setWidth(e.nativeEvent.layout.width);

  const level = tilt === 0;
  // Control-of-error, mirroring web: for a CHALLENGE the balance never shows a
  // "solved" signal before the frame's Done — the level beam is the only
  // feedback (exactly like the web `BalanceManipulative`, which renders no
  // status text at all). So in challenge mode the readout stays neutral (no
  // green, no ✓); a free-explore balance keeps its live "Balanced ✓".
  const challenge = isChallenge(spec);
  const statusColor =
    level && !challenge ? palette.green[600] : palette.charcoal[400];
  const statusText = level
    ? challenge
      ? "Level"
      : "Balanced ✓"
    : tilt > 0
      ? "Left is heavier"
      : "Right is heavier";

  return (
    <View style={styles.wrap}>
      <View style={styles.stage} onLayout={onLayout}>
        {width > 0 && (
          <>
            {/* stand + fulcrum (static) */}
            <Svg
              width={width}
              height={STAGE_H}
              style={StyleSheet.absoluteFill}
            >
              <Path
                d={`M ${pivotX - 42},${STAGE_H - 16} L ${pivotX + 42},${STAGE_H - 16} L ${pivotX + 12},${PIVOT_Y + 6} L ${pivotX - 12},${PIVOT_Y + 6} Z`}
                fill={palette.navy[50]}
                stroke={palette.navy[500]}
                strokeWidth={2}
              />
              <Circle
                cx={pivotX}
                cy={PIVOT_Y}
                r={9}
                fill={palette.violet[500]}
                stroke={palette.navy[500]}
                strokeWidth={2}
              />
            </Svg>

            {/* beam — rotates about its center (the fulcrum) */}
            <Animated.View
              style={[
                styles.beam,
                {
                  width: beamHalf * 2,
                  left: pivotX - beamHalf,
                  top: PIVOT_Y - BEAM_THICKNESS / 2,
                },
                beamStyle,
              ]}
            />

            {/* pans (upright, follow the beam ends) */}
            <Animated.View style={[styles.pan, leftPanStyle]}>
              <PanContents units={state.left} color={palette.cyan[500]} />
            </Animated.View>
            <Animated.View style={[styles.pan, rightPanStyle]}>
              <PanContents
                units={state.right}
                color={palette.green[500]}
                mystery={spec.mysteryRight}
                mysteryIconHref={mysteryIconHref}
              />
            </Animated.View>
          </>
        )}
      </View>

      <View style={styles.statusRow}>
        <Text style={[styles.status, { color: statusColor }]}>
          {statusText}
        </Text>
      </View>

      <View style={styles.controls}>
        {spec.adjustable.includes("left") && (
          <Stepper
            value={state.left}
            min={0}
            max={maxUnits}
            label="left"
            onChange={(v) => setState((s) => ({ ...s, left: v }))}
          />
        )}
        {spec.adjustable.includes("right") && (
          <Stepper
            value={state.right}
            min={0}
            max={maxUnits}
            label="right"
            onChange={(v) => setState((s) => ({ ...s, right: v }))}
          />
        )}
      </View>
    </View>
  );
}

/** The string + tray + stacked unit weights that hang under one beam end. */
function PanContents({
  units,
  color,
  mystery,
  mysteryIconHref,
}: {
  units: number;
  color: string;
  mystery?: number;
  mysteryIconHref?: string;
}) {
  const blocks: React.ReactNode[] = [];
  for (let i = 0; i < units; i++) {
    const col = i % PER_ROW;
    const row = Math.floor(i / PER_ROW);
    blocks.push(
      <View
        key={`b-${i}`}
        style={[
          styles.block,
          {
            backgroundColor: color,
            left: col * (BLOCK + BLOCK_GAP),
            bottom: row * (BLOCK + BLOCK_GAP),
          },
        ]}
      />,
    );
  }
  if (mystery) {
    const idx = units;
    const col = idx % PER_ROW;
    const row = Math.floor(idx / PER_ROW);
    const pos = {
      left: col * (BLOCK + BLOCK_GAP) - 1,
      bottom: row * (BLOCK + BLOCK_GAP) - 1,
    };
    blocks.push(
      mysteryIconHref ? (
        <View key="mystery" style={[styles.mysteryIcon, pos]}>
          <Image
            source={{ uri: mysteryIconHref }}
            style={styles.mysteryImg}
            resizeMode="contain"
            alt=""
            aria-hidden
          />
          <View style={styles.mysteryBadge}>
            <Text style={styles.mysteryBadgeText}>?</Text>
          </View>
        </View>
      ) : (
        <View key="mystery" style={[styles.mystery, pos]}>
          <Text style={styles.mysteryText}>?</Text>
        </View>
      ),
    );
  }
  const rows = Math.ceil((units + (mystery ? 1 : 0)) / PER_ROW) || 1;
  const blocksH = rows * (BLOCK + BLOCK_GAP);
  return (
    <View style={styles.panInner}>
      <View style={styles.string} />
      <View style={[styles.blocks, { height: blocksH }]}>{blocks}</View>
      <View style={styles.tray} />
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { width: "100%", gap: 10 },
  stage: { width: "100%", height: STAGE_H, position: "relative" },
  beam: {
    position: "absolute",
    height: BEAM_THICKNESS,
    borderRadius: BEAM_THICKNESS / 2,
    backgroundColor: palette.navy[500],
  },
  pan: {
    position: "absolute",
    left: 0,
    top: 0,
    width: PAN_W,
    alignItems: "center",
  },
  panInner: { alignItems: "center", width: PAN_W },
  string: { width: 2, height: STRING_H, backgroundColor: palette.charcoal[500] },
  blocks: {
    width: PER_ROW * (BLOCK + BLOCK_GAP),
    justifyContent: "flex-end",
    position: "relative",
  },
  block: {
    position: "absolute",
    width: BLOCK,
    height: BLOCK,
    borderRadius: 3,
    borderWidth: 1.5,
    borderColor: palette.navy[500],
  },
  mystery: {
    position: "absolute",
    width: BLOCK + 2,
    height: BLOCK + 2,
    borderRadius: 3,
    borderWidth: 1.5,
    borderColor: palette.navy[500],
    backgroundColor: palette.orange[500],
    alignItems: "center",
    justifyContent: "center",
  },
  mysteryText: { fontFamily: fonts.bold, fontSize: 11, color: palette.navy[500] },
  mysteryIcon: {
    position: "absolute",
    width: BLOCK + 2,
    height: BLOCK + 2,
    alignItems: "center",
    justifyContent: "center",
  },
  mysteryImg: { width: BLOCK + 2, height: BLOCK + 2 },
  mysteryBadge: {
    position: "absolute",
    top: -3,
    right: -3,
    width: 12,
    height: 12,
    borderRadius: 6,
    backgroundColor: palette.orange[500],
    borderWidth: 1,
    borderColor: palette.navy[500],
    alignItems: "center",
    justifyContent: "center",
  },
  mysteryBadgeText: { fontFamily: fonts.bold, fontSize: 8, color: palette.navy[500] },
  tray: {
    width: PAN_W * 0.82,
    height: 12,
    borderBottomLeftRadius: 40,
    borderBottomRightRadius: 40,
    borderWidth: 3,
    borderTopWidth: 0,
    borderColor: palette.navy[500],
    marginTop: 2,
  },
  statusRow: { alignItems: "center" },
  status: { fontFamily: fonts.bold, fontSize: 14 },
  controls: {
    flexDirection: "row",
    flexWrap: "wrap",
    justifyContent: "space-around",
    gap: 16,
  },
});
