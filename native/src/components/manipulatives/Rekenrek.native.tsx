/**
 * Rekenrek (native) — the RN port of the web `RekenrekManipulative`. Up to two
 * rods of ten beads; per rod, put a finger on a bead and push a TRAIN of them
 * toward a stop (beads can't pass through each other, so a group is felt moving
 * as one). Release and the moved beads settle flush; a flick carries the train
 * on its own momentum. `left` = beads pushed left, summed across both rods.
 *
 * This is the additive number-bond material that replaces the old DotBlaster
 * slider. The math is reused verbatim from the shared logic layer
 * (`rekenrekSolved`, `initialRekenrek`, `clamp`); this file owns only pixels +
 * the drag. The frame (native NativeManipulativeItem chrome) supplies the
 * concept eyebrow, prompt, mode badge, self-check chip, and reset — so, exactly
 * like the web renderer, this is the STAGE only: no in-stage equation line, just
 * the material and its per-cluster count labels.
 *
 * ── Parity with the web renderer (the standing scholar-facing rule) ──────────
 * Every visible property the web version fixes is reproduced here, because a
 * bead rack that reads differently for a kid on iPad is a defect, not a
 * follow-up:
 *   • Two rods, ten each: total 1..10 → one rod; 11..20 → a full rod of ten
 *     above a partial second rod. Beads fill rod 1 to ten, then overflow.
 *   • Uniform bead diameter across both rods — sized off the FULLER rod (rod 1,
 *     a full ten whenever a second rod exists) by the SHARED `rekenrekGeometry`
 *     the web renderer calls, so the two can no longer drift. The bead reaches
 *     the 44px finger target on a stage ~590px wide and shrinks below it on a
 *     narrower one, because a rack that overflows its stage gets clipped.
 *   • Five-coloring is PER ROD and fixed to POSITION-IN-FIVES: beads 1–5 cyan,
 *     6–10 violet. A bead keeps its hue as it slides, so the left/right split is
 *     carried NOT by recoloring but by the GAP that opens between the clusters
 *     and by the small per-cluster count labels — the same reviewed-and-accepted
 *     tension the web renderer documents. Do not "fix" it by recoloring.
 *   • ~2.5 bead-widths of rail slack per rod (the `+ 2.5` in the sizing), so a
 *     split leaves an open span of bare rail that reads as two groups.
 *   • Per-cluster count labels at the resting cluster centers.
 *
 * ── Where native forced a divergence from the web implementation ─────────────
 * The web renderer drives beads with pointer events + React state + a
 * requestAnimationFrame momentum loop + a CSS transform transition for settle.
 * None of that is the RN idiom, so the DRAG, MOMENTUM, and SETTLE all run on the
 * UI thread via reanimated shared values (the same posture the kit's
 * `useMovableHandle` uses): a per-bead `Gesture.Pan` writes the grabbed bead's
 * target into a shared value, a `useAnimatedReaction` propagates the train
 * collision every frame, `withDecay` throws a flick, and a `withTiming` on an
 * interpolation parameter runs the settle. Because worklets can't call imported
 * functions, the rounding/clamp AND the train-collision + classify + rest-layout
 * math are INLINED inside every worklet (the same worklet constraint the kit's
 * `useMovableHandle` `constrain` documents) — the JS copies below are used only by the non-worklet
 * layout/effect paths. Behaviourally this matches the web's `applyGrab`,
 * `classifyLeft`, `restPositions`, and settle-on-release verbatim.
 *
 * Static linework (rail, end stops, count labels) is react-native-svg; the beads
 * are interactive `Animated.View` discs (RNGH v2 has no per-SVG-element gesture
 * detector — the same reason the kit draws its handle as a View over the SVG).
 * The disc itself is the touch target, so it wants to stay near 44px — see the
 * sizing note above for why fitting the stage wins when the two conflict.
 */

import {
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { StyleSheet, View, type LayoutChangeEvent } from "react-native";
import Svg, { Line, Rect, Text as SvgText } from "react-native-svg";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, {
  cancelAnimation,
  Easing,
  runOnJS,
  useAnimatedReaction,
  useAnimatedStyle,
  useSharedValue,
  withDecay,
  withTiming,
  type SharedValue,
} from "react-native-reanimated";

import {
  REKENREK_STOP_M as STOP_M, // inside edge of each stop / resting bead edge
  clamp,
  initialRekenrek,
  rekenrekGeometry,
  rekenrekSolved,
} from "../../../vendor/manipulative/logic";
import type { RekenrekState } from "../../../vendor/manipulative/logic";
import type { RekenrekSpec } from "../../../vendor/manipulative/types";
import {
  lightImpact,
  mediumImpact,
  selectionTick,
  ManipulativeScrollContext,
  type KindProps,
} from "./kit";
import { fonts, palette } from "@/theme";

const MAX_W = 560; // matches the web stage maxWidth
const ROD_H = 100; // per-rod block height (rail + beads + count label)
const RAIL_Y = 40; // rail centerline within a rod block
const ROD_CAP = 10; // beads per rod

// Grab feel, mirroring the kit's handle squish.
const GRAB_SCALE = 1.12;
const GRAB_MS = 120;
const SETTLE_MS = 300;
const FLICK_V = 350; // px/s release velocity above which a flick throws the train

// Structural marks stay neutral gray; cyan/violet mean position-in-fives only.
const RAIL_COLOR = palette.gray[200]; // #e6e8ea
const STOP_FILL = "rgba(54, 65, 83, 0.32)"; // wash(charcoal, 0.32)
const BEAD_BORDER = "rgba(34, 38, 86, 0.22)"; // wash(navy, 0.22)
const LABEL_COLOR = palette.navy[500];

// Drag lifecycle, as a single shared-value flag so the two reactions know which
// one owns `pos` right now.
const IDLE = 0;
const DRAG = 1;
const MOMENTUM = 2;
const SETTLE = 3;

/** Bead hue by position-in-fives within its rod (fixed to the bead). */
function hueFor(i: number): string {
  return Math.floor(i / 5) % 2 === 0 ? palette.cyan[500] : palette.violet[500];
}

/** Split a total into per-rod bead counts: rod 1 fills to ten, then rod 2. */
function rodCounts(total: number): number[] {
  const t = clamp(Math.round(total), 0, 2 * ROD_CAP);
  const r0 = Math.min(t, ROD_CAP);
  const r1 = Math.max(0, t - ROD_CAP);
  return r1 > 0 ? [r0, r1] : [r0];
}

/** Distribute a starting `left` across the rods (rod 1 first). */
function splitLeft(left: number, counts: number[]): number[] {
  const l0 = clamp(left, 0, counts[0]);
  const rest = counts.length > 1 ? clamp(left - counts[0], 0, counts[1]) : 0;
  return counts.length > 1 ? [l0, rest] : [l0];
}

export function RekenrekNative({
  spec,
  onSolvedChange,
  onStateChange,
}: KindProps<RekenrekSpec, RekenrekState>) {
  const total = clamp(Math.round(spec.total), 0, 2 * ROD_CAP);
  const counts = useMemo(() => rodCounts(total), [total]);

  const startTotalLeft = initialRekenrek(spec).left;
  const startLefts = useMemo(
    () => splitLeft(startTotalLeft, counts),
    [startTotalLeft, counts],
  );

  const [boxW, setBoxW] = useState(0);
  const width = boxW > 0 ? Math.min(boxW, MAX_W) : 0;
  // Bead size + rail geometry come from the SHARED helper the web renderer uses,
  // so the two surfaces can't drift — including its guarantee that the rack fits
  // the measured stage instead of holding a 44px bead and overflowing.
  const geom = useMemo(() => rekenrekGeometry(width, counts[0]), [width, counts]);

  // Per-rod left counts; summed for the reported state. Re-seeded when the
  // puzzle (total / startLeft) changes.
  const [lefts, setLefts] = useState<number[]>(startLefts);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- A new puzzle seeds each rod's React value before the next gesture can read it.
    setLefts(startLefts);
  }, [startLefts]);

  const onRodLeft = useCallback((rod: number, value: number) => {
    setLefts((prev) => {
      if (prev[rod] === value) return prev;
      const next = prev.slice();
      next[rod] = value;
      return next;
    });
  }, []);

  const totalLeft = lefts.reduce((a, b) => a + b, 0);
  useEffect(() => {
    onSolvedChange(rekenrekSolved(spec, { left: totalLeft }));
    onStateChange?.({ left: totalLeft });
  }, [spec, totalLeft, onSolvedChange, onStateChange]);

  const onLayout = (e: LayoutChangeEvent) => setBoxW(e.nativeEvent.layout.width);

  return (
    <View style={styles.wrap}>
      <View style={styles.measure} onLayout={onLayout}>
        {width > 0 && (
          <View style={{ width }}>
            {counts.map((count, rod) => (
              <Rod
                key={rod}
                rod={rod}
                count={count}
                initialLeft={startLefts[rod] ?? 0}
                width={width}
                D={geom.D}
                railLeft={geom.railLeft}
                railRight={geom.railRight}
                onLeftChange={onRodLeft}
              />
            ))}
          </View>
        )}
      </View>
    </View>
  );
}

interface RodProps {
  rod: number;
  count: number;
  initialLeft: number;
  width: number;
  D: number;
  railLeft: number;
  railRight: number;
  onLeftChange: (rod: number, left: number) => void;
}

/** One rod of the rack — the web `Rod`'s single-rail interaction, on the UI thread. */
function Rod({
  rod,
  count,
  initialLeft,
  width,
  D,
  railLeft,
  railRight,
  onLeftChange,
}: RodProps) {
  const scrollRef = useContext(ManipulativeScrollContext);

  // Bead centers (px) — the render source of truth, driven on the UI thread.
  const pos = useSharedValue<number[]>(restPositions(initialLeft, count, D, railLeft, railRight));
  const base = useSharedValue<number[]>([]); // layout snapshot at grab start
  const grabIdx = useSharedValue(-1);
  const grabX = useSharedValue(0); // target center of the grabbed bead
  const grabScale = useSharedValue(1);
  const mode = useSharedValue(IDLE);
  const liveLeft = useSharedValue(initialLeft); // last classified split (label throttle)
  const settleFrom = useSharedValue<number[]>([]);
  const settleTo = useSharedValue<number[]>([]);
  const settleT = useSharedValue(0);

  // Live split for the labels (updates as clusters cross a gap threshold).
  const [leftCount, setLeftCount] = useState(initialLeft);
  const leftCountRef = useRef(initialLeft);
  useEffect(() => {
    leftCountRef.current = leftCount;
  }, [leftCount]);

  // JS-side rest layout, for the non-worklet effects below.
  const restJS = useCallback(
    (l: number) => restPositions(l, count, D, railLeft, railRight),
    [count, D, railLeft, railRight],
  );
  const geometryRef = useRef({ D, railLeft, railRight });
  useEffect(() => {
    geometryRef.current = { D, railLeft, railRight };
  }, [D, railLeft, railRight]);

  // Settle generation, for de-duping overlapping settles and cancelling a pending
  // haptic on unmount — a shared value, NOT a ref. `scheduleLand` is reached from
  // the gesture closures (built in render) via startSettle → reportSettled, so
  // reading/writing a ref there would trip react-hooks/refs; a shared value is
  // exempt (the reason this file migrated to `.get()/.set()`). A newer settle —
  // or unmount — bumps `settleSeq`, so a superseded timer's `seq` no longer
  // matches and it stays silent, the same effect as clearing the timeout.
  const settleSeq = useSharedValue(0);
  useEffect(
    () => () => {
      settleSeq.set(settleSeq.get() + 1);
    },
    [settleSeq],
  );

  // Schedule the bead-landing haptic on a fixed JS timer (the ui/Drawer.tsx
  // idiom: 190ms → 210ms; here the settle is a fixed SETTLE_MS, so 300ms →
  // 320ms). The `mode === IDLE` guard fires the haptic only if the settle
  // actually landed — an interrupting grab flips `mode` to DRAG before the
  // timer, matching the old `finished`-guarded completion callback (no buzz on
  // an interrupted settle). Called from `reportSettled`, already on the JS thread
  // at settle start (`runOnJS(reportSettled)` in startSettle), so it adds no new
  // UI→JS hop.
  const scheduleLand = useCallback(() => {
    const seq = settleSeq.get() + 1;
    settleSeq.set(seq);
    setTimeout(() => {
      if (settleSeq.get() === seq && mode.get() === IDLE) lightImpact();
    }, SETTLE_MS + 20);
  }, [mode, settleSeq]);

  const reportSettled = useCallback(
    (l: number) => {
      setLeftCount(l);
      onLeftChange(rod, l);
      // Bead-landing haptic — off the settle completion callback, onto a JS timer
      // (see the startSettle CRASH NOTE). This runs at settle start on the JS
      // thread already, so it costs no extra UI→JS crossing.
      scheduleLand();
    },
    [onLeftChange, rod, scheduleLand],
  );

  // Re-seed when the rod's bead count or starting split changes (new puzzle).
  useEffect(() => {
    const geometry = geometryRef.current;
    const next = restPositions(
      initialLeft,
      count,
      geometry.D,
      geometry.railLeft,
      geometry.railRight,
    );
    pos.set(next);
    mode.set(IDLE);
    grabIdx.set(-1);
    liveLeft.set(initialLeft);
    // eslint-disable-next-line react-hooks/set-state-in-effect -- React state, gesture shared values, and the parent callback must reseed in this order for a changed rod input.
    setLeftCount(initialLeft);
    onLeftChange(rod, initialLeft);
  }, [count, grabIdx, initialLeft, liveLeft, mode, onLeftChange, pos, rod]);

  // Keep beads laid out to the current split when the rail is resized (idle only).
  useEffect(() => {
    if (mode.get() === IDLE) {
      pos.set(restJS(leftCountRef.current));
    }
  }, [D, mode, pos, railLeft, railRight, restJS]);

  // A worklet that snaps the rod to its resting split on release. Inlined
  // classify + rest layout (worklets can't call the JS helpers).
  //
  // CRASH NOTE — do NOT call runOnJS from the settle animation's COMPLETION
  // CALLBACK below. `runOnJS(...)` inside a withTiming/withSpring/withDecay
  // completion callback can hard-crash the iOS app (SIGABRT, no red box:
  // `JSIWorkletsModuleProxy::toOptimizedObject` → `JSScheduler::scheduleOnJS`)
  // once the React Compiler MEMOIZES this component. The current code is already
  // safe for that future: `reportSettled` schedules `lightImpact` on a plain JS
  // timer at settle start (the ui/Drawer.tsx remedy), while the completion
  // callback contains pure UI-thread writes only. `Rod` still happens to bail
  // out today on the captured update expression in the per-bead gesture loop,
  // but that bailout is not a safety mechanism and must not be relied on. Keep
  // the boundary safe when the compiler eventually supports that pattern.
  const startSettle = useCallback(() => {
    "worklet";
    const p = pos.get();
    const n = count;
    // classifyLeft: the widest inter-bead gap is the split; if none is wide
    // enough it's all-or-nothing toward the nearer stop.
    let bestGap = -1;
    let splitAt = 0;
    for (let i = 1; i < n; i++) {
      const g = p[i] - p[i - 1] - D;
      if (g > bestGap) {
        bestGap = g;
        splitAt = i;
      }
    }
    let l: number;
    if (bestGap < D * 0.4) {
      l = p[0] - railLeft <= railRight - p[n - 1] ? n : 0;
    } else {
      l = splitAt;
    }
    // restPositions(l)
    const to: number[] = [];
    for (let i = 0; i < n; i++) {
      to[i] = i < l ? railLeft + i * D : railRight - (n - 1 - i) * D;
    }
    settleFrom.set(p);
    settleTo.set(to);
    liveLeft.set(l);
    mode.set(SETTLE);
    settleT.set(0);
    settleT.set(withTiming(
      1,
      { duration: SETTLE_MS, easing: Easing.out(Easing.cubic) },
      (finished) => {
        "worklet";
        if (finished) {
          // Pure UI-thread writes only — the haptic is scheduled JS-side in
          // reportSettled (see the CRASH NOTE above); NEVER runOnJS from here.
          pos.set(settleTo.get());
          mode.set(IDLE);
        }
      },
    ));
    runOnJS(reportSettled)(l);
  }, [count, D, railLeft, railRight, reportSettled, pos, mode, settleFrom, settleTo, settleT, liveLeft]);

  // Propagate the grabbed bead through the train every frame (drag + momentum).
  // Inlined applyGrab + classify — the grabbed bead PUSHES neighbors it collides
  // with, never pulls them, then the train is clamped inside the rail.
  useAnimatedReaction(
    () => grabX.get(),
    (x) => {
      "worklet";
      if (mode.get() !== DRAG && mode.get() !== MOMENTUM) return;
      const g = grabIdx.get();
      if (g < 0) return;
      const b = base.get();
      const n = count;
      const cur = b.slice();
      let d = x;
      if (d < railLeft) d = railLeft;
      else if (d > railRight) d = railRight;
      cur[g] = d;
      for (let i = g - 1; i >= 0; i--) {
        if (cur[i] > cur[i + 1] - D) cur[i] = cur[i + 1] - D;
      }
      for (let i = g + 1; i < n; i++) {
        if (cur[i] < cur[i - 1] + D) cur[i] = cur[i - 1] + D;
      }
      if (cur[0] < railLeft) {
        cur[0] = railLeft;
        for (let i = 1; i < n; i++) {
          if (cur[i] < cur[i - 1] + D) cur[i] = cur[i - 1] + D;
        }
      }
      if (cur[n - 1] > railRight) {
        cur[n - 1] = railRight;
        for (let i = n - 2; i >= 0; i--) {
          if (cur[i] > cur[i + 1] - D) cur[i] = cur[i + 1] - D;
        }
      }
      pos.set(cur);
      // Live classify for the labels (only cross-report on an actual change).
      let bestGap = -1;
      let splitAt = 0;
      for (let i = 1; i < n; i++) {
        const gg = cur[i] - cur[i - 1] - D;
        if (gg > bestGap) {
          bestGap = gg;
          splitAt = i;
        }
      }
      let l: number;
      if (bestGap < D * 0.4) {
        l = cur[0] - railLeft <= railRight - cur[n - 1] ? n : 0;
      } else {
        l = splitAt;
      }
      if (l !== liveLeft.get()) {
        liveLeft.set(l);
        runOnJS(setLeftCount)(l);
        runOnJS(selectionTick)();
      }
    },
    [count, D, railLeft, railRight],
  );

  // Interpolate the beads to their resting split during the settle animation.
  useAnimatedReaction(
    () => settleT.get(),
    (t) => {
      "worklet";
      if (mode.get() !== SETTLE) return;
      const from = settleFrom.get();
      const to = settleTo.get();
      const n = from.length;
      const cur: number[] = [];
      for (let i = 0; i < n; i++) {
        cur[i] = from[i] + (to[i] - from[i]) * t;
      }
      pos.set(cur);
    },
    [],
  );

  // One Pan gesture per bead. Built in the render body (not memoised) so the
  // reanimated plugin recognises the callbacks as worklets — matching the kit.
  const gestures: ReturnType<typeof Gesture.Pan>[] = [];
  for (let i = 0; i < count; i++) {
    let g = Gesture.Pan()
      .minDistance(0)
      .onBegin(() => {
        "worklet";
        cancelAnimation(grabX);
        cancelAnimation(settleT);
        mode.set(DRAG);
        grabIdx.set(i);
        base.set(pos.get());
        grabX.set(pos.get()[i]);
        grabScale.set(withTiming(GRAB_SCALE, {
          duration: GRAB_MS,
          easing: Easing.out(Easing.quad),
        }));
        runOnJS(mediumImpact)();
      })
      .onUpdate((e) => {
        "worklet";
        let d = base.get()[i] + e.translationX;
        if (d < railLeft) d = railLeft;
        else if (d > railRight) d = railRight;
        grabX.set(d);
      })
      .onFinalize((e) => {
        "worklet";
        grabScale.set(withTiming(1, {
          duration: GRAB_MS,
          easing: Easing.out(Easing.quad),
        }));
        const v = e.velocityX;
        if (v > FLICK_V || v < -FLICK_V) {
          mode.set(MOMENTUM);
          grabX.set(withDecay(
            { velocity: v, clamp: [railLeft, railRight], deceleration: 0.996 },
            (finished) => {
              "worklet";
              if (finished) startSettle();
            },
          ));
        } else {
          startSettle();
        }
      });
    if (scrollRef) {
      g = g.blocksExternalGesture(
        scrollRef as Parameters<typeof g.blocksExternalGesture>[0],
      );
    }
    gestures.push(g);
  }

  const right = count - leftCount;
  const leftCenter = railLeft + ((leftCount - 1) * D) / 2;
  const rightCenter = railRight - ((right - 1) * D) / 2;

  return (
    <View style={{ width, height: ROD_H }}>
      <Svg width={width} height={ROD_H}>
        {/* rail + end stops (neutral gray scaffolding) */}
        <Line
          x1={0}
          y1={RAIL_Y}
          x2={width}
          y2={RAIL_Y}
          stroke={RAIL_COLOR}
          strokeWidth={4}
          strokeLinecap="round"
        />
        <Rect x={STOP_M - 6} y={RAIL_Y - 18} width={6} height={36} rx={3} fill={STOP_FILL} />
        <Rect x={width - STOP_M} y={RAIL_Y - 18} width={6} height={36} rx={3} fill={STOP_FILL} />

        {/* per-cluster count labels — carry the left/right split the color can't */}
        {leftCount > 0 && (
          <SvgText
            x={leftCenter}
            y={RAIL_Y + 42}
            fontSize={20}
            fontFamily={fonts.bold}
            fill={LABEL_COLOR}
            textAnchor="middle"
          >
            {leftCount}
          </SvgText>
        )}
        {right > 0 && (
          <SvgText
            x={rightCenter}
            y={RAIL_Y + 42}
            fontSize={20}
            fontFamily={fonts.bold}
            fill={LABEL_COLOR}
            textAnchor="middle"
          >
            {right}
          </SvgText>
        )}
      </Svg>

      {Array.from({ length: count }, (_, i) => (
        <Bead
          key={i}
          index={i}
          pos={pos}
          grabIdx={grabIdx}
          grabScale={grabScale}
          D={D}
          hue={hueFor(i)}
          gesture={gestures[i]}
        />
      ))}
    </View>
  );
}

interface BeadProps {
  index: number;
  pos: SharedValue<number[]>;
  grabIdx: SharedValue<number>;
  grabScale: SharedValue<number>;
  D: number;
  hue: string;
  gesture: ReturnType<typeof Gesture.Pan>;
}

/** A single interactive bead disc, positioned on the UI thread from `pos`. */
function Bead({ index, pos, grabIdx, grabScale, D, hue, gesture }: BeadProps) {
  const style = useAnimatedStyle(() => {
    const x = pos.get()[index] ?? 0;
    const s = grabIdx.get() === index ? grabScale.get() : 1;
    return {
      transform: [
        { translateX: x - D / 2 },
        { translateY: RAIL_Y - D / 2 },
        { scale: s },
      ],
    };
  });

  return (
    <GestureDetector gesture={gesture}>
      <Animated.View
        accessibilityLabel="rekenrek bead"
        style={[
          {
            position: "absolute",
            left: 0,
            top: 0,
            width: D,
            height: D,
            borderRadius: D / 2,
            backgroundColor: hue,
            borderWidth: 2,
            borderColor: BEAD_BORDER,
          },
          style,
        ]}
      />
    </GestureDetector>
  );
}

/** Resting bead centers for a given left-count: `left` beads flush at the left
 *  stop, the rest flush at the right stop. */
function restPositions(
  left: number,
  count: number,
  D: number,
  railLeft: number,
  railRight: number,
): number[] {
  return Array.from({ length: count }, (_, i) =>
    i < left ? railLeft + i * D : railRight - (count - 1 - i) * D,
  );
}

const styles = StyleSheet.create({
  wrap: { width: "100%", alignItems: "center" },
  measure: { width: "100%", alignItems: "center" },
});
