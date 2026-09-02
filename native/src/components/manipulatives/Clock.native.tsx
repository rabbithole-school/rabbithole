/**
 * Clock (native) — the RN port of the web Clock. A geared 12-hour dial: BOTH
 * hands drag, and both are read off ONE state value (`minutes` past 12), so the
 * face can never contradict itself. The minute hand is the fine control (one
 * turn = one hour); the hour hand is the COARSE control (one turn = twelve
 * hours), which is what makes 12:00 → 4:30 a single short sweep instead of four
 * and a half revolutions of the long hand.
 *
 * Deliberately NOT two independent hands. A second degree of freedom would make
 * an IMPOSSIBLE face representable — hour hand parked on the 4 while the minute
 * hand reads :30 — and that impossible face is the single most common wrong
 * answer these items exist to correct. See the design note on `ClockState` in
 * `lib/manipulative/types.ts`.
 *
 * The drag is ANGULAR, not linear, so — exactly like `Protractor.native` — the
 * kit's linear `snapIncrement` can't express a minute step on a circular scale.
 *
 * ## Why ACCUMULATED rotation, not "snap to where the finger points"
 *
 * The pointer's absolute angle only says WHERE IN THE TURN the hand is; it
 * cannot say which turn. Reading the new position and taking the smaller signed
 * difference (the old model here) collapses the moment the dial is coarse:
 * at `snap = 30` the only readings are :00 and :30, both steps are exactly ±30,
 * "the smaller step" has no answer and the hour never turns over; at
 * `snap = 60` every rim position snaps to :00, so the delta is always 0 and the
 * dial is frozen. The shipped `clock-half-past-4` item (12:00 → 4:30, snap 30)
 * was unsolvable on iPad because of exactly this.
 *
 * So we accumulate instead: each frame contributes its own small signed turn
 * delta, those sum into a continuous rotation, and `minutes` is derived from the
 * total. Winding is then unambiguous at any gradation, and multi-turn winding
 * survives. The accumulation lives in the `constrain` WORKLET (UI thread) rather
 * than in the JS report, because `constrain` is the only place that sees the RAW
 * pointer angle — the kit hands `onChange` the already-constrained point, and
 * accumulating from a snapped point re-introduces the very ambiguity above.
 *
 * ## Why the hands render from TWO different values
 *
 * The hands are geared 12:1, so a drag of the hour hand spins the minute hand
 * twelve times as fast. Rendering that from the SNAPPED reading strobes: on a
 * `snap = 30` dial the minute hand has only two legal positions, so a smooth
 * sweep of the hour hand makes it flip 12 ↔ 6 a dozen times a turn. That reads
 * as a glitch, not as a gear.
 *
 * So each hand renders from whichever value is truthful for it:
 *   • the hand you are DRAGGING renders SNAPPED, so it detents under your finger
 *     and always agrees with the reading you are committing;
 *   • the hand being DRIVEN renders from the CONTINUOUS rotation, so it sweeps
 *     at frame rate like the gear it is, and settles onto the snap on release.
 * The two can differ by at most half a snap step, which on the driven hand's own
 * scale is imperceptible — but it is the whole difference between a strobe and a
 * sweep. Both hands are therefore drawn as Reanimated views driven by shared
 * values, NOT from React state, so they track the finger at 60fps.
 */

import { useCallback, useMemo, useRef, useState } from "react";
import { StyleSheet, Text, View, type LayoutChangeEvent } from "react-native";
import Svg, { Circle, Line, Text as SvgText } from "react-native-svg";
import Animated, {
  useAnimatedReaction,
  useAnimatedStyle,
  useSharedValue,
  type SharedValue,
} from "react-native-reanimated";

import {
  CLOCK_DIAL_MINUTES,
  clockNormalize,
  clockSnapMinutes,
  clockSolved,
  formatClockTime,
  initialClock,
  liveReadoutPolicy,
} from "../../../vendor/manipulative/logic";
import type { ClockState } from "../../../vendor/manipulative/logic";
import type { ClockSpec } from "../../../vendor/manipulative/types";
import {
  CoordinatePlane,
  MovableHandleView,
  selectionTick,
  useMovableHandle,
  type KindProps,
  type MovableHandle,
  type Vec2,
} from "./kit";
import { fonts, palette } from "@/theme";

const R = 4; // face radius, math units
const PAD = 0.7;
/**
 * The dial is drawn into a SQUARE stage. `useMovableHandle` maps math→px with
 * separate x and y scales, so a non-square stage would make the face an ellipse
 * and put the grab handle off the rim; clamping to a square keeps the two
 * scales equal (the web renderer gets this free from SVG's `xMidYMid meet`).
 */
const MAX_SIZE = 300;
/** Where the minute-hand grab handle rides — just inside the minute ring. */
const HAND_R = R - 0.55;
/** Where the hour-hand grab handle rides — on the short hand's tip. */
const HOUR_HAND_R = R - 1.85;
/**
 * The hour knob's touch target is deliberately smaller than the kit default
 * (46). The two knobs are only ~41px apart on a 300px dial, so two 92px targets
 * would completely swallow each other whenever the hands align — which is
 * exactly the 12:00 start position most items ship with. At 26 the hour target
 * is 52px across (still above Apple's 44pt minimum) and stops short of the
 * minute knob, so near the centre you catch the short hand and out at the rim
 * the long one — the same radius-ordered rule the web renderer uses.
 */
const HOUR_HIT_R = 26;

/** Clock angles run clockwise from 12; math angles run counter-clockwise from
 *  east. This converts a fraction-of-a-turn into a math-space point. */
function polar(fractionOfTurn: number, radius: number): Vec2 {
  const a = Math.PI / 2 - fractionOfTurn * Math.PI * 2;
  return { x: Math.cos(a) * radius, y: Math.sin(a) * radius };
}

/** The UI-thread twin of `polar` — worklets can't call a plain JS function. */
function polarWorklet(fractionOfTurn: number, radius: number): Vec2 {
  "worklet";
  const a = Math.PI / 2 - fractionOfTurn * Math.PI * 2;
  return { x: Math.cos(a) * radius, y: Math.sin(a) * radius };
}

interface HandBarProps {
  /** Distance from the centre to the centre of the pivot cap, px. */
  cx: number;
  cy: number;
  /** Hand length in px, measured from the centre. */
  length: number;
  /** Hand thickness in px. */
  thickness: number;
  color: string;
  /** Dial minutes for one full turn of THIS hand: 60 or `CLOCK_DIAL_MINUTES`. */
  minutesPerTurn: number;
  id: number;
  minutesSV: SharedValue<number>;
  liveSV: SharedValue<number>;
  activeSV: SharedValue<number>;
}

/**
 * One clock hand, drawn as a rounded bar and rotated on the UI thread. A View
 * rather than an SVG `<Line>` precisely so a shared value can drive it at frame
 * rate — an SVG line would have to come from React state and could only move as
 * fast as the JS thread commits.
 */
function HandBar({
  cx,
  cy,
  length,
  thickness,
  color,
  minutesPerTurn,
  id,
  minutesSV,
  liveSV,
  activeSV,
}: HandBarProps) {
  const animated = useAnimatedStyle(() => {
    // Snapped while THIS hand is the one under the finger; continuous while it
    // is merely being driven by the other one. See the file doc comment.
    const active = activeSV.get();
    const m = active === 0 || active === id ? minutesSV.get() : liveSV.get();
    const fraction = m / minutesPerTurn;
    const angle = fraction * Math.PI * 2;
    // The bar's own centre must sit on the hand's midpoint before it rotates
    // about that midpoint, so the pivot ends up exactly on the dial centre.
    return {
      transform: [
        { translateX: (length / 2) * Math.sin(angle) },
        { translateY: (-length / 2) * Math.cos(angle) },
        { rotate: `${fraction * 360 - 90}deg` },
      ],
    };
  });
  return (
    <Animated.View
      pointerEvents="none"
      style={[
        {
          position: "absolute",
          left: cx - length / 2,
          top: cy - thickness / 2,
          width: length,
          height: thickness,
          borderRadius: thickness / 2,
          backgroundColor: color,
        },
        animated,
      ]}
    />
  );
}

interface ClockHandOptions {
  plane: CoordinatePlane;
  /** Radius the knob rides at, math units. */
  radius: number;
  /**
   * The gear ratio: how many dial minutes one full turn of THIS hand is worth.
   * 60 for the minute hand, `CLOCK_DIAL_MINUTES` (720) for the hour hand. It is
   * the only thing that differs between the two — which is precisely why the
   * hour hand can be draggable without becoming a second degree of freedom.
   */
  minutesPerTurn: number;
  snap: number;
  /** The dial's reading at mount — used only for the knob's start position. */
  initialMinutes: number;
  /** 1 = minute hand, 2 = hour hand. Identity for the one-drag-at-a-time guard. */
  id: number;
  /** The dial's live SNAPPED reading, shared UI-side so the OTHER hand tracks it. */
  minutesSV: SharedValue<number>;
  /** The dial's live UNSNAPPED rotation — what the DRIVEN hand renders from. */
  liveSV: SharedValue<number>;
  /** Which hand currently owns the drag (0 = none). */
  activeSV: SharedValue<number>;
  /** Push `minutesSV` into React state. Runs on the JS thread. */
  commit: () => void;
}

/**
 * One draggable hand. Both hands run this identical machinery; only
 * `minutesPerTurn` and the ride radius differ.
 */
function useClockHand({
  plane,
  radius,
  minutesPerTurn,
  snap,
  initialMinutes,
  id,
  minutesSV,
  liveSV,
  activeSV,
  commit,
}: ClockHandOptions): MovableHandle {
  /** Does this hand own the in-flight drag? A second finger on the other hand
   *  is ignored outright rather than allowed to fight over the same `minutes`. */
  const owns = useSharedValue(false);
  /** True until the first frame of a drag, which seeds the accumulator. */
  const needsSeed = useSharedValue(true);
  /** The running, UNSNAPPED reading in dial minutes. */
  const accumulated = useSharedValue(0);
  /** Previous frame's raw pointer angle, as a fraction of a turn. */
  const lastTurn = useSharedValue(0);

  const constrain = useCallback(
    (p: Vec2): Vec2 => {
      "worklet";
      const turn = (Math.PI / 2 - Math.atan2(p.y, p.x)) / (Math.PI * 2);

      if (needsSeed.get()) {
        needsSeed.set(false);
        if (activeSV.get() !== 0) {
          owns.set(false); // the other hand got there first
        } else {
          owns.set(true);
          activeSV.set(id);
          // Seed from the CURRENT reading and from this frame's raw angle, so
          // the first frame contributes zero rotation and the hand can't jump.
          accumulated.set(minutesSV.get());
          liveSV.set(minutesSV.get());
          lastTurn.set(turn);
        }
      }
      if (!owns.get()) return polarWorklet(minutesSV.get() / minutesPerTurn, radius);

      // The frame's own signed step, taken the short way round so a crossing of
      // 12 reads as a few minutes rather than most of a turn.
      let step = turn - lastTurn.get();
      while (step > 0.5) step -= 1;
      while (step < -0.5) step += 1;
      lastTurn.set(turn);

      const raw = accumulated.get() + step * minutesPerTurn;
      accumulated.set(raw);
      liveSV.set(raw);
      const snapped = Math.round(raw / snap) * snap;
      const norm = ((snapped % CLOCK_DIAL_MINUTES) + CLOCK_DIAL_MINUTES) % CLOCK_DIAL_MINUTES;
      minutesSV.set(norm);
      return polarWorklet(norm / minutesPerTurn, radius);
    },
    [snap, id, radius, minutesPerTurn, minutesSV, liveSV, activeSV, owns, needsSeed, accumulated, lastTurn],
  );

  const settle = useCallback(() => {
    if (owns.get()) {
      activeSV.set(0);
      liveSV.set(minutesSV.get()); // the driven hand lands on the detent
    }
    owns.set(false);
    needsSeed.set(true);
    commit();
  }, [owns, activeSV, liveSV, minutesSV, needsSeed, commit]);

  const handle = useMovableHandle({
    plane,
    initial: polar(initialMinutes / minutesPerTurn, radius),
    constrain,
    onChange: commit,
    onSettled: settle,
    hitRadius: id === 2 ? HOUR_HIT_R : undefined,
  });

  // Both hands read the SAME value, so moving one must move the other. The
  // driven knob rides its hand's tip, so it follows the same continuous value
  // the hand does — on the UI thread, in the same frame.
  const { mx, my } = handle;
  useAnimatedReaction(
    () => (activeSV.get() === 0 || activeSV.get() === id ? minutesSV.get() : liveSV.get()),
    (m) => {
      if (owns.get()) return;
      const p = polarWorklet(m / minutesPerTurn, radius);
      mx.set(p.x);
      my.set(p.y);
    },
  );

  return handle;
}

export function ClockNative({ spec, onSolvedChange, onStateChange }: KindProps<ClockSpec, ClockState>) {
  const [width, setWidth] = useState(0);
  const snap = clockSnapMinutes(spec);
  const [initial] = useState(() => initialClock(spec).minutes);
  const [minutes, setMinutes] = useState(initial);
  // The live reading, mirrored into a ref so the report callback can read the
  // PREVIOUS value without re-creating itself every frame.
  const minutesRef = useRef(minutes);
  // …and mirrored UI-side, where the constrain worklets read and write it.
  const minutesSV = useSharedValue(minutes);
  /** The unsnapped rotation the DRIVEN hand renders from — see the doc comment. */
  const liveSV = useSharedValue(minutes);
  const activeSV = useSharedValue(0);

  const size = Math.min(width, MAX_SIZE);
  const viewBox = useMemo(
    () => ({ x: [-R - PAD, R + PAD] as [number, number], y: [-R - PAD, R + PAD] as [number, number] }),
    [],
  );
  const plane = useMemo(() => new CoordinatePlane(viewBox, { width: size, height: size }), [viewBox, size]);

  const commit = useCallback(() => {
    const next = clockNormalize(minutesSV.get());
    if (next === minutesRef.current) return;
    minutesRef.current = next;
    setMinutes(next);
    selectionTick();
    onSolvedChange(clockSolved(spec, { minutes: next }));
    onStateChange?.({ minutes: next });
  }, [minutesSV, spec, onSolvedChange, onStateChange]);

  const minuteHandle = useClockHand({
    plane,
    radius: HAND_R,
    minutesPerTurn: 60,
    snap,
    initialMinutes: initial,
    id: 1,
    minutesSV,
    liveSV,
    activeSV,
    commit,
  });
  const hourHandle = useClockHand({
    plane,
    radius: HOUR_HAND_R,
    minutesPerTurn: CLOCK_DIAL_MINUTES,
    snap,
    initialMinutes: initial,
    id: 2,
    minutesSV,
    liveSV,
    activeSV,
    commit,
  });

  const onLayout = (e: LayoutChangeEvent) => setWidth(e.nativeEvent.layout.width);
  const toPx = (p: Vec2) => ({ x: plane.x(p.x), y: plane.y(p.y) });
  const centre = toPx({ x: 0, y: 0 });
  const perUnit = plane.x(1) - plane.x(0);

  return (
    <View style={styles.wrap}>
      {/* The measuring row is full-width; the STAGE inside it is the square the
          handle's absolute positioning is relative to. */}
      <View style={styles.measure} onLayout={onLayout}>
        <View style={[styles.stage, { width: size, height: size }]}>
          {size > 0 && (
          <>
            <Svg width={size} height={size}>
              <Circle
                cx={centre.x}
                cy={centre.y}
                r={plane.x(R) - plane.x(0)}
                fill={palette.white}
                stroke={palette.navy[500]}
                strokeWidth={3}
              />
              {/* the minute ring: 60 ticks, every fifth long — the scale a
                  scholar counts by fives on */}
              {Array.from({ length: 60 }, (_, i) => {
                const major = i % 5 === 0;
                const outer = toPx(polar(i / 60, R - 0.4));
                const inner = toPx(polar(i / 60, R - (major ? 0.82 : 0.6)));
                return (
                  <Line
                    key={`tick-${i}`}
                    x1={outer.x}
                    y1={outer.y}
                    x2={inner.x}
                    y2={inner.y}
                    stroke={major ? palette.navy[500] : palette.charcoal[500]}
                    strokeWidth={major ? 2.6 : 1.1}
                    opacity={major ? 1 : 0.55}
                  />
                );
              })}
              {/* hour numerals */}
              {Array.from({ length: 12 }, (_, i) => {
                const hour = i === 0 ? 12 : i;
                const p = toPx(polar(i / 12, R - 1.5));
                return (
                  <SvgText
                    key={`hour-${hour}`}
                    x={p.x}
                    y={p.y + 8}
                    textAnchor="middle"
                    fontSize={22}
                    fontFamily={fonts.bold}
                    fill={palette.navy[500]}
                  >
                    {String(hour)}
                  </SvgText>
                );
              })}
              {/* the optional minute numerals — the early-grades scaffold */}
              {spec.showMinuteNumerals &&
                Array.from({ length: 12 }, (_, i) => {
                  const p = toPx(polar(i / 12, R - 2.55));
                  return (
                    <SvgText
                      key={`min-${i}`}
                      x={p.x}
                      y={p.y + 4}
                      textAnchor="middle"
                      fontSize={11}
                      fontFamily={fonts.bold}
                      fill={palette.darkCyan[500]}
                    >
                      {String(i * 5)}
                    </SvgText>
                  );
                })}
            </Svg>
            {/* The hands live OUTSIDE the Svg so shared values can drive them at
                frame rate: hour first (short, thick), then the minute hand over
                it, then the pivot cap hiding both butt ends. */}
            <HandBar
              cx={centre.x}
              cy={centre.y}
              length={(R - 1.85) * perUnit}
              thickness={8}
              color={palette.navy[500]}
              minutesPerTurn={CLOCK_DIAL_MINUTES}
              id={2}
              minutesSV={minutesSV}
              liveSV={liveSV}
              activeSV={activeSV}
            />
            <HandBar
              cx={centre.x}
              cy={centre.y}
              length={(R - 0.7) * perUnit}
              thickness={5}
              color={palette.violet[500]}
              minutesPerTurn={60}
              id={1}
              minutesSV={minutesSV}
              liveSV={liveSV}
              activeSV={activeSV}
            />
            <View
              pointerEvents="none"
              style={{
                position: "absolute",
                left: centre.x - 7,
                top: centre.y - 7,
                width: 14,
                height: 14,
                borderRadius: 7,
                backgroundColor: palette.navy[500],
              }}
            />
            {/* Grab handles, painted MINUTE first then HOUR, so the top-most
                hit target near the centre is the short hand and out at the rim
                it's the long one. They only overlap when the hands align. */}
            <MovableHandleView
              handle={minuteHandle}
              color={palette.violet[500]}
              ringColor={palette.white}
              accessibilityLabel="clock minute hand"
            />
            <MovableHandleView
              handle={hourHandle}
              color={palette.navy[500]}
              ringColor={palette.white}
              radius={11}
              accessibilityLabel="clock hour hand"
            />
          </>
          )}
        </View>
      </View>
      {/* Withheld when the goal NAMES the time; an `advanceBy` goal never
          names where you land, so its reading stays. See `liveReadoutPolicy`. */}
      {liveReadoutPolicy(spec).showValue && (
        <Text style={styles.readout}>{formatClockTime(minutes)}</Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { width: "100%", gap: 6 },
  measure: { width: "100%", alignItems: "center" },
  stage: { position: "relative", overflow: "visible" },
  readout: {
    fontFamily: fonts.bold,
    fontSize: 26,
    color: palette.navy[500],
    textAlign: "center",
    backgroundColor: palette.gray[50],
    borderRadius: 12,
    paddingVertical: 4,
  },
});
