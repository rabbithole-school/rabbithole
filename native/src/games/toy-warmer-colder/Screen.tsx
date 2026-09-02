/**
 * `toy-warmer-colder` — the renderer. DELIBERATELY TRIVIAL AND DISPOSABLE.
 *
 * Its job is to prove the seams work, not to be fun: every phase transition,
 * every evidence kind, a checkpoint between moves (kill the app after the first
 * probe and it resumes exactly there), and a completion. If you find yourself
 * making this nicer, you want a new game instead.
 *
 * It adds NO new primitives: pressable tiles use `usePressPop` + the haptic /
 * audio tick helpers from `manipulatives/kit.tsx`, which already carry the
 * house tactility. The host owns time, "stuck", persistence and crash
 * containment — none of that appears here, which is the point.
 */
import { useCallback, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import Animated from "react-native-reanimated";

import { fonts, useColors } from "@/theme";
import {
  lightImpact,
  successNotify,
  usePressPop,
} from "@/components/manipulatives/kit";
import type { GameScreenProps } from "../../../vendor/games/contract";
import { bandFor, halfOf, type ToyConfig, type ToyState } from "./module";

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

function Tile({
  index,
  disabled,
  probed,
  revealed,
  onPress,
}: {
  index: number;
  disabled: boolean;
  probed: boolean;
  revealed: boolean;
  onPress: () => void;
}) {
  const colors = useColors();
  const pop = usePressPop();
  return (
    <AnimatedPressable
      accessibilityRole="button"
      accessibilityLabel={`Tile ${index + 1}`}
      disabled={disabled}
      onPress={() => {
        pop.pop();
        onPress();
      }}
      style={[
        styles.tile,
        pop.style,
        {
          backgroundColor: revealed
            ? colors.violetSolid
            : probed
              ? colors.violetMuted
              : colors.bgSubtle,
          // A probed tile stays legible: the digest reasons about WHERE they
          // probed, so the scholar has to be able to see it too.
          borderColor: probed ? colors.violet : colors.border,
          opacity: disabled && !probed ? 0.45 : 1,
        },
      ]}
    >
      <Text
        style={[styles.tileLabel, { color: revealed ? "#fff" : colors.charcoal }]}
      >
        {index + 1}
      </Text>
    </AnimatedPressable>
  );
}

function HalfButton({
  label,
  selected,
  onPress,
}: {
  label: string;
  selected: boolean;
  onPress: () => void;
}) {
  const colors = useColors();
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [
        styles.halfBtn,
        {
          backgroundColor: selected ? colors.violetSolid : colors.bgSubtle,
          borderColor: selected ? colors.violetSolid : colors.border,
          opacity: pressed ? 0.7 : 1,
        },
      ]}
    >
      <Text
        style={[
          styles.halfLabel,
          { color: selected ? "#fff" : colors.charcoal },
        ]}
      >
        {label}
      </Text>
    </Pressable>
  );
}

export default function ToyWarmerColderScreen({
  launch,
  checkpoint,
  host,
}: GameScreenProps<ToyConfig, ToyState>) {
  const colors = useColors();
  const [state, setState] = useState<ToyState>(launch.state);
  const { tiles } = launch.config;

  // Presentation-only. The durable record of what the scholar saw is the
  // `feedback_shown` event, not this string. A round always starts fresh, so
  // there is nothing to rebuild — which is exactly the tax that dropping
  // resume removes from every game author.
  const [banner, setBanner] = useState<string | null>(null);

  const commit = useCallback(
    async (next: ToyState, events: Parameters<typeof checkpoint.transact>[0]["events"]) => {
      setState(next);
      await checkpoint.transact({ state: next, events });
    },
    [checkpoint],
  );

  const pickHalf = useCallback(
    async (half: "left" | "right") => {
      lightImpact();
      await commit(
        { ...state, half, firstHalf: half, phase: "probe1" },
        [
          { eventKey: "guess_half", payload: { kind: "prediction_recorded", value: half } },
          { eventKey: "phase", payload: { kind: "phase_changed", phase: "probe1" } },
        ],
      );
    },
    [commit, state],
  );

  const revise = useCallback(
    async (half: "left" | "right") => {
      lightImpact();
      const changed = half !== state.half;
      await commit(
        { ...state, half, phase: "probe2" },
        [
          ...(changed
            ? ([
                {
                  eventKey: "half_revised",
                  payload: {
                    kind: "model_revised" as const,
                    before: state.half ?? "unset",
                    after: half,
                  },
                },
              ] as const)
            : []),
          { eventKey: "phase", payload: { kind: "phase_changed", phase: "probe2" } },
        ],
      );
    },
    [commit, state],
  );

  const probe = useCallback(
    async (index: number) => {
      const first = state.phase === "probe1";
      const band = bandFor(index, state.tokenIndex, tiles);
      setBanner(band);
      const next: ToyState = {
        ...state,
        probes: [...state.probes, index],
        phase: first ? "revise" : "done",
      };
      await commit(next, [
        {
          eventKey: first ? "first_tap" : "second_tap",
          payload: {
            kind: "choice_made",
            choice: `tile ${index + 1}`,
            // The option space is the TILES — what the scholar actually chose
            // among. Passing the two halves here made the digest read
            // "tile 2 (of 2)", which is a lie about how open the choice was.
            among: Array.from({ length: tiles }, (_, i) => `tile ${i + 1}`),
          },
        },
        {
          eventKey: "probe_read",
          payload: {
            kind: "strategy_inferred",
            // An INFERENCE, and labelled as one everywhere it surfaces. The
            // game is guessing at intent from a tap; it does not know.
            strategy:
              halfOf(index, tiles) === state.half
                ? "probed inside their predicted half"
                : "probed outside their predicted half",
          },
        },
        {
          eventKey: "feedback_shown",
          payload: { kind: "observation_recorded", value: band },
        },
        {
          eventKey: "phase",
          payload: { kind: "phase_changed", phase: next.phase },
        },
      ]);
      if (!first) successNotify();
    },
    [commit, state, tiles],
  );

  /**
   * Completion is a deliberate tap, not a side effect of the last move.
   * `host.complete()` is TERMINAL — it ends the session and tears the surface
   * down — so calling it inline from the final probe flung the scholar back to
   * the unit list before the reveal had rendered (observed on device: the
   * result was on screen for 493ms). Show the answer; let them leave.
   */
  const finish = useCallback(async () => {
    const found = state.probes.includes(state.tokenIndex);
    await host.complete({
      outcomeKey: found ? "found" : "missed",
      finalState: state,
      events: [
        {
          eventKey: "round_ended",
          payload: { kind: "outcome_claimed", outcomeKey: found ? "found" : "missed" },
        },
      ],
    });
  }, [host, state]);

  const busy = checkpoint.pending;
  const canProbe = state.phase === "probe1" || state.phase === "probe2";

  return (
    <View style={styles.root}>
      <Text style={[styles.prompt, { color: colors.navy }]}>
        {state.phase === "predict"
          ? "Which half is the token hiding in?"
          : state.phase === "probe1"
            ? "Tap a tile to probe."
            : state.phase === "revise"
              ? "Still think it's in that half?"
              : state.phase === "probe2"
                ? "One more probe."
                : "Round over."}
      </Text>

      {banner ? (
        <Text style={[styles.banner, { color: colors.violet }]}>{banner}</Text>
      ) : null}

      <View style={styles.strip}>
        {Array.from({ length: tiles }, (_, i) => (
          <Tile
            key={i}
            index={i}
            disabled={busy || !canProbe || state.probes.includes(i)}
            probed={state.probes.includes(i)}
            revealed={state.phase === "done" && i === state.tokenIndex}
            onPress={() => void probe(i)}
          />
        ))}
      </View>

      {(state.phase === "predict" || state.phase === "revise") && (
        <View style={styles.halves}>
          <HalfButton
            label="Left half"
            selected={state.half === "left"}
            onPress={() =>
              void (state.phase === "predict" ? pickHalf("left") : revise("left"))
            }
          />
          <HalfButton
            label="Right half"
            selected={state.half === "right"}
            onPress={() =>
              void (state.phase === "predict" ? pickHalf("right") : revise("right"))
            }
          />
        </View>
      )}

      {state.phase === "done" && (
        <>
          <Text style={[styles.done, { color: colors.charcoalMuted }]}>
            It was under tile {state.tokenIndex + 1}.
          </Text>
          <Pressable
            onPress={() => void finish()}
            disabled={busy}
            accessibilityRole="button"
            accessibilityLabel="Done"
            style={({ pressed }) => [
              styles.halfBtn,
              {
                backgroundColor: colors.violetSolid,
                borderColor: colors.violetSolid,
                opacity: pressed || busy ? 0.7 : 1,
              },
            ]}
          >
            <Text style={[styles.halfLabel, { color: "#fff" }]}>Done</Text>
          </Pressable>
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, alignItems: "center", justifyContent: "center", padding: 24, gap: 20 },
  prompt: { fontFamily: fonts.bold, fontSize: 20, textAlign: "center" },
  banner: { fontFamily: fonts.bold, fontSize: 28, textAlign: "center" },
  strip: { flexDirection: "row", flexWrap: "wrap", justifyContent: "center", gap: 8 },
  tile: {
    width: 56,
    height: 56,
    borderRadius: 10,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  tileLabel: { fontFamily: fonts.regular, fontSize: 16 },
  halves: { flexDirection: "row", gap: 12 },
  halfBtn: { paddingHorizontal: 20, paddingVertical: 12, borderRadius: 10, borderWidth: 1 },
  halfLabel: { fontFamily: fonts.bold, fontSize: 15 },
  done: { fontFamily: fonts.regular, fontSize: 15 },
});
