import { useEffect, useMemo } from "react";
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import Animated, {
  cancelAnimation,
  Easing,
  type SharedValue,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from "react-native-reanimated";
import { SymbolView } from "expo-symbols";

import { MAX_RECORDING_MS } from "@/hooks/useVoiceDictation";
import { fonts, useColors } from "@/theme";

const BARS = 13;
// Bell curve weights: tallest in the centre, like a real voice meter.
const WEIGHTS = Array.from({ length: BARS }, (_, i) => {
  const t = i / (BARS - 1);
  return 0.4 + 0.6 * Math.sin(t * Math.PI);
});

function fmt(ms: number): string {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/**
 * One animated waveform bar. Runs on the UI thread via Reanimated so the
 * animation is smooth even if the JS thread is busy during transcription.
 */
function WaveBar({
  weight,
  index,
  levelSv,
  clockSv,
  waveBarStyle,
}: {
  weight: number;
  index: number;
  levelSv: SharedValue<number>;
  clockSv: SharedValue<number>;
  waveBarStyle: object;
}) {
  const style = useAnimatedStyle(() => {
    // Wobble varies per-bar so bars animate independently.
    const wobble = 0.55 + 0.45 * Math.abs(Math.sin((clockSv.get() + index * 2) * 0.5));
    const h = 4 + levelSv.get() * 30 * weight * wobble + 2 * weight;
    return { height: h };
  });
  return <Animated.View style={[waveBarStyle, style]} />;
}

/**
 * The recording bar — replaces the composer row while the scholar is speaking.
 *
 * States:
 *  - recording: live waveform + timer + cancel (✕) / stop (✓) buttons
 *  - isMaxed: 2-min cap reached; waveform replaced with a prompt to tap ✓
 *  - isTranscribing: native spinner + "Transcribing…" text
 *
 * isMaxed is optional (session/[id].tsx doesn't wire it yet); the bar also
 * shows the maxed state when durationMs ≥ MAX_RECORDING_MS so it degrades
 * gracefully without changes to the composer.
 */
export function RecordingBar({
  level,
  durationMs,
  isTranscribing,
  isMaxed = false,
  onCancel,
  onStop,
}: {
  level: number;
  durationMs: number;
  isTranscribing: boolean;
  isMaxed?: boolean;
  onCancel: () => void;
  onStop: () => void;
}) {
  const colors = useColors();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const levelSv = useSharedValue(0);
  const clockSv = useSharedValue(0);

  // maxed by either the optional prop or durationMs crossing the cap
  const showMaxed = isMaxed || durationMs >= MAX_RECORDING_MS;

  // Smooth incoming level changes (80 ms, matching the metering interval)
  useEffect(() => {
    levelSv.set(withTiming(isTranscribing || showMaxed ? 0 : level, { duration: 80 }));
  }, [level, isTranscribing, showMaxed, levelSv]);

  // Breathing clock — repeats forever, drives the per-bar wobble on the UI thread
  useEffect(() => {
    clockSv.set(withRepeat(
      withTiming(100, { duration: 9000, easing: Easing.linear }),
      -1,
      false,
    ));
    return () => cancelAnimation(clockSv);
  }, [clockSv]);

  // ── Transcribing ─────────────────────────────────────────────────────────────
  if (isTranscribing) {
    return (
      <View style={styles.bar}>
        <View style={styles.centered}>
          <ActivityIndicator color={colors.violet} size="small" />
          <Text style={styles.statusText}>Transcribing…</Text>
        </View>
      </View>
    );
  }

  // ── Max duration reached ──────────────────────────────────────────────────────
  if (showMaxed) {
    return (
      <View style={styles.bar}>
        <Pressable onPress={onCancel} hitSlop={12} style={styles.cancel}>
          <SymbolView name="xmark" size={18} tintColor={colors.charcoalMuted} />
        </Pressable>
        <View style={styles.maxedContent}>
          <SymbolView name="clock.badge.checkmark" size={18} tintColor={colors.orange} />
          <Text style={styles.maxedText}>Max length — tap ✓ to send</Text>
        </View>
        <Pressable onPress={onStop} hitSlop={12} style={styles.stop}>
          <SymbolView name="checkmark" size={24} tintColor={colors.white} />
        </Pressable>
      </View>
    );
  }

  // ── Recording ─────────────────────────────────────────────────────────────────
  return (
    <View style={styles.bar}>
      {/* Discard */}
      <Pressable onPress={onCancel} hitSlop={12} style={styles.cancel}>
        <SymbolView name="xmark" size={18} tintColor={colors.charcoalMuted} />
      </Pressable>

      {/* Live Reanimated waveform */}
      <View style={styles.wave}>
        {WEIGHTS.map((w, i) => (
          <WaveBar key={i} weight={w} index={i} levelSv={levelSv} clockSv={clockSv} waveBarStyle={styles.waveBar} />
        ))}
      </View>

      {/* Elapsed timer */}
      <Text style={styles.timer}>{fmt(durationMs)}</Text>

      {/* Stop + transcribe */}
      <Pressable onPress={onStop} hitSlop={12} style={styles.stop}>
        <SymbolView name="checkmark" size={24} tintColor={colors.white} />
      </Pressable>
    </View>
  );
}

function makeStyles(c: ReturnType<typeof useColors>) {
  return StyleSheet.create({
  bar: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingLeft: 8,
    paddingRight: 6,
    minHeight: 50,
  },
  cancel: {
    width: 38,
    height: 38,
    borderRadius: 19,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: c.gray100,
  },
  wave: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 4,
    height: 40,
  },
  waveBar: {
    width: 4,
    borderRadius: 2,
    backgroundColor: c.violet,
  },
  timer: {
    fontSize: 15,
    fontFamily: fonts.semibold,
    color: c.charcoalMuted,
    fontVariant: ["tabular-nums"],
    minWidth: 38,
    textAlign: "right",
  },
  stop: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: c.violet,
  },
  centered: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
    minHeight: 50,
  },
  statusText: { fontSize: 16, fontFamily: fonts.semibold, color: c.violet },
  maxedContent: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
  },
  maxedText: {
    fontSize: 15,
    fontFamily: fonts.semibold,
    color: c.orange,
  },
});};
