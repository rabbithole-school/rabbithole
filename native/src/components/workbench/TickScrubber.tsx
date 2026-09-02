/**
 * The run transport — CONVENTIONAL MEDIA CONTROLS (plan §7.5). Three centered,
 * thumb-reachable controls — [⏮ step-back a day] [▶/⏸ play·pause] [⏭ step-forward
 * a day] — sit over a finger-draggable scrubber TRACK (with the day-detent haptic)
 * and a "Day t / max" caption. Play (driven by the parent) auto-advances one
 * recorded day at a watchable cadence, letting SimulatorViewport GLIDE each step; at
 * the live head it keeps FOLLOWING into each freshly-committed day as it bakes — a
 * quiet "computing…" hint, never a dead disabled button. When the run is over the
 * primary becomes ↺ Replay and a muted line states WHY it ended.
 *
 * Pedagogy: the transport reports the SIM's state + end reason. It never diagnoses
 * or judges the scholar's strategy — the end reason is about the world, not the kid.
 */

import { useCallback, useEffect, useState } from "react";
import {
  Animated,
  Easing,
  LayoutChangeEvent,
  Pressable,
  StyleSheet,
  Text,
  useAnimatedValue,
  View,
} from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import { runOnJS, useSharedValue } from "react-native-reanimated";
import * as Haptics from "expo-haptics";
import { SymbolView } from "expo-symbols";

import { fonts, useColors } from "@/theme";
import type { SimulatorRun } from "./useWorkbenchData";
import { workbenchTimeNoun } from "./workbenchTerminology";
import type { SimulatorSpec } from "../../../vendor/simulator/contract";

type RunStatus = SimulatorRun["status"];
type HaltReason = NonNullable<SimulatorRun["haltReason"]>;

/** A watchable day-per-tick cadence for playback (ms/day). */
export const DAY_ADVANCE_MS = 600;

/** A one-line, kid-legible reason a run is over — about the SIM, never the scholar. */
function endReasonLine(
  status: RunStatus,
  haltReason: HaltReason | undefined,
  targetTicks: number,
  _runKind: SimulatorRun["runKind"],
  timeNoun: "day" | "round",
  committedTicks: number,
): string | null {
  if (
    haltReason === "terminal_physics" &&
    (timeNoun === "day" || committedTicks < targetTicks)
  ) {
    return timeNoun === "round"
      ? "Ended early · no more rounds could be played"
      : "Ended early · the world reached a standstill";
  }
  switch (status) {
    case "completed":
      return `Simulation complete · reached ${targetTicks} ${timeNoun}${targetTicks === 1 ? "" : "s"}`;
    case "halted":
      switch (haltReason) {
        case "budget":
          return "Reached the run limit";
        case "scholar_stop":
          return "You stopped this run";
        case "teacher_pause":
          return "Your teacher paused runs";
        default:
          return "Run ended";
      }
    case "crashed":
      return "This run hit a snag";
    default:
      return null;
  }
}

/** A thin violet arc that spins around the play button's perimeter while a day
 *  bakes — a progress ring that reads as "working", not a broken corner badge. */
function PlayLoadingRing({ color }: { color: string }) {
  const spin = useAnimatedValue(0);
  useEffect(() => {
    const loop = Animated.loop(
      Animated.timing(spin, {
        toValue: 1,
        duration: 900,
        easing: Easing.linear,
        useNativeDriver: true,
      }),
    );
    loop.start();
    return () => loop.stop();
  }, [spin]);
  const rotate = spin.interpolate({ inputRange: [0, 1], outputRange: ["0deg", "360deg"] });
  return (
    <Animated.View
      pointerEvents="none"
      style={[
        styles.loadingRing,
        { borderColor: color, borderTopColor: "transparent", transform: [{ rotate }] },
      ]}
    />
  );
}

export function TickScrubber({
  tick,
  maxTick,
  moreComing,
  playing,
  onScrub,
  onTogglePlay,
  status,
  haltReason,
  targetTicks,
  runKind,
  spec,
}: {
  tick: number;
  maxTick: number;
  /** The engine is still committing ticks (run queued/ticking) — so being at the
   *  live head means "next day is baking", not "the end". */
  moreComing: boolean;
  /** Parent-owned playback flag (the auto-advance loop lives with the scrub state). */
  playing: boolean;
  onScrub: (tick: number) => void;
  onTogglePlay: () => void;
  status: RunStatus;
  haltReason: HaltReason | undefined;
  targetTicks: number;
  runKind: SimulatorRun["runKind"];
  spec?: SimulatorSpec;
}) {
  const colors = useColors();
  const timeNoun = workbenchTimeNoun(spec);
  const [trackWidth, setTrackWidth] = useState(0);
  const lastTick = useSharedValue(tick);

  const onLayout = useCallback((e: LayoutChangeEvent) => {
    setTrackWidth(e.nativeEvent.layout.width);
  }, []);

  // Map a finger x within the track to a whole day, clamp, and — when the day
  // actually changes — click a detent haptic and report it up (this pauses play,
  // since onScrub is the manual-seek path in the parent).
  const seekTo = useCallback(
    (x: number) => {
      if (trackWidth <= 0 || maxTick <= 0) return;
      const frac = Math.max(0, Math.min(1, x / trackWidth));
      const next = Math.round(frac * maxTick);
      if (next !== lastTick.get()) {
        lastTick.set(next);
        Haptics.selectionAsync().catch(() => {});
        onScrub(next);
      }
    },
    [lastTick, trackWidth, maxTick, onScrub],
  );

  const pan = Gesture.Pan()
    .onBegin((e) => runOnJS(seekTo)(e.x))
    .onUpdate((e) => runOnJS(seekTo)(e.x));
  const tap = Gesture.Tap().onEnd((e) => runOnJS(seekTo)(e.x));
  const gesture = Gesture.Race(pan, tap);

  const fillFrac = maxTick > 0 ? Math.min(1, tick / maxTick) : 0;

  const atHead = tick >= maxTick;
  const canBack = tick > 0;
  const canNext = tick < maxTick;
  // "The end" only when we're parked at the head AND nothing more is coming.
  const ended =
    atHead &&
    !moreComing &&
    (status === "completed" || status === "halted" || status === "crashed");
  const computing = atHead && moreComing; // waiting on the engine for the next day

  const step = (delta: number) => () => {
    Haptics.selectionAsync().catch(() => {});
    const next = Math.max(0, Math.min(maxTick, tick + delta));
    lastTick.set(next);
    onScrub(next); // stepping pauses playback (parent's manual-seek path)
  };

  const onPrimary = () => {
    Haptics.selectionAsync().catch(() => {});
    onTogglePlay();
  };

  const endReason = ended
    ? endReasonLine(
        status,
        haltReason,
        targetTicks,
        runKind,
        timeNoun,
        maxTick,
      )
    : null;

  // The muted line above the controls: the end reason once over, else a quiet
  // "computing…" hint while the head bakes — never a dead/disabled state.
  const statusLine = endReason ?? (computing ? `computing ${timeNoun} ${maxTick + 1}…` : null);

  const primaryIcon = ended ? "arrow.counterclockwise" : playing ? "pause.fill" : "play.fill";
  const primaryLabel = ended
    ? "Replay from the start"
    : playing
      ? "Pause"
      : computing
        ? `Play — following the live ${timeNoun}`
        : "Play";

  return (
    <View style={[styles.container, { borderTopColor: colors.border }]}>
      {statusLine ? (
        <Text style={[styles.statusLine, { color: colors.fgMuted }]} numberOfLines={1}>
          {statusLine}
        </Text>
      ) : null}

      <View style={styles.controls}>
        <Pressable
          onPress={step(-1)}
          disabled={!canBack}
          hitSlop={10}
          style={({ pressed }) => [
            styles.stepBtn,
            { opacity: canBack ? 1 : 0.3 },
            pressed && canBack ? styles.stepBtnPressed : null,
          ]}
          accessibilityRole="button"
          accessibilityLabel={`Step back one ${timeNoun}`}
        >
          <SymbolView name="backward.frame.fill" tintColor={colors.violet} size={22} />
        </Pressable>

        <Pressable
          onPress={onPrimary}
          hitSlop={8}
          style={({ pressed }) => [
            styles.primaryBtn,
            { backgroundColor: colors.violetSolid },
            pressed ? styles.primaryBtnPressed : null,
          ]}
          accessibilityRole="button"
          accessibilityLabel={primaryLabel}
        >
          <View style={computing && !playing ? styles.primaryGlyphBusy : null}>
            <SymbolView name={primaryIcon} tintColor={colors.white} size={22} />
          </View>
          {computing ? <PlayLoadingRing color={colors.violet} /> : null}
        </Pressable>

        <Pressable
          onPress={step(1)}
          disabled={!canNext}
          hitSlop={10}
          style={({ pressed }) => [
            styles.stepBtn,
            { opacity: canNext ? 1 : 0.3 },
            pressed && canNext ? styles.stepBtnPressed : null,
          ]}
          accessibilityRole="button"
          accessibilityLabel={`Step forward one ${timeNoun}`}
        >
          <SymbolView name="forward.frame.fill" tintColor={colors.violet} size={22} />
        </Pressable>
      </View>

      <GestureDetector gesture={gesture}>
        <View style={styles.trackHit} onLayout={onLayout}>
          <View style={[styles.track, { backgroundColor: colors.gray200 }]}>
            <View
              style={[styles.fill, { width: `${fillFrac * 100}%`, backgroundColor: colors.violet }]}
            />
            <View
              style={[
                styles.thumb,
                { left: `${fillFrac * 100}%`, backgroundColor: colors.violetSolid },
              ]}
            />
          </View>
        </View>
      </GestureDetector>

      <Text style={[styles.label, { color: colors.fg }]} numberOfLines={1}>
        {timeNoun === "day" ? "Day" : "Round"} {tick}
        <Text style={{ color: colors.fgMuted }}> / {maxTick}</Text>
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    paddingHorizontal: 16,
    paddingTop: 8,
    paddingBottom: 10,
    borderTopWidth: StyleSheet.hairlineWidth,
    gap: 6,
  },
  statusLine: {
    fontFamily: fonts.medium,
    fontSize: 12,
    textAlign: "center",
  },
  controls: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 28,
  },
  stepBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: "center",
    justifyContent: "center",
  },
  stepBtnPressed: {
    transform: [{ scale: 0.92 }],
    opacity: 0.55,
  },
  primaryBtn: {
    width: 52,
    height: 52,
    borderRadius: 26,
    alignItems: "center",
    justifyContent: "center",
  },
  primaryBtnPressed: {
    transform: [{ scale: 0.92 }],
    opacity: 0.85,
  },
  primaryGlyphBusy: {
    opacity: 0.4,
  },
  loadingRing: {
    position: "absolute",
    top: -3,
    left: -3,
    width: 58,
    height: 58,
    borderRadius: 29,
    borderWidth: 2,
  },
  trackHit: { justifyContent: "center", height: 28 },
  track: { height: 5, borderRadius: 3, justifyContent: "center" },
  fill: { position: "absolute", left: 0, top: 0, bottom: 0, borderRadius: 3 },
  thumb: {
    position: "absolute",
    width: 15,
    height: 15,
    borderRadius: 8,
    marginLeft: -7.5,
    top: -5,
  },
  label: {
    fontFamily: fonts.semibold,
    fontSize: 13,
    textAlign: "center",
  },
});
