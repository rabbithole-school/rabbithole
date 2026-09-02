/**
 * MultiStepSequenceNative — the native (iPad) twin of the web
 * `components/manipulative/challenges/MultiStepSequenceChallenge.tsx`. It renders
 * Model A of the standard multi-step challenge frame: a data-authored, ordered
 * playlist of linked `ManipulativeSpec` steps where state does NOT carry across
 * steps — each step is a fresh manipulative, checked in isolation against its
 * own goal/answer, and advancing just moves to the next spec.
 *
 * This is UNGRADED instructional content. It is pure local state: it never
 * submits, never calls a Convex mutation, never touches mastery. The verdict
 * chip is driven by the SAME pure `isSolved` from the vendored logic the web +
 * server grade with, so native/web can never drift on what "solved" means, and
 * ALL step math goes through the pure `currentSequenceStep` / `isSequenceComplete`
 * / `advanceSequence` / `sequenceProgress` helpers (no hand-rolled index math).
 *
 * Honest fallback: a step whose kind has no native renderer shows truthful
 * web-only copy (gated by `isNativeManipulativeKind`) with a skip affordance so
 * the sequence never renders an empty stage or gets stuck — mirroring the
 * posture of `LaunchpadContent`'s `ManipulativeAtom`.
 *
 * Scholar-facing web/native parity is mandatory: same rhythm (set up → Done →
 * verdict → Next), same progress legibility (Step X of Y dots), same verdict
 * feedback — in native-idiomatic styling at a kid-on-iPad type scale.
 */

import { useCallback, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";

import { fonts, useColors, type Colors } from "@/theme";
import {
  advanceSequence,
  currentSequenceStep,
  isSequenceComplete,
  isSolved,
  sequenceProgress,
} from "../../../vendor/manipulative/logic";
import { isChallenge, type MultiStepSequenceSpec } from "../../../vendor/manipulative/types";
import { isNativeManipulativeKind, NativeManipulative } from "./NativeManipulative";

type Verdict = "idle" | "correct" | "incorrect";

export interface MultiStepSequenceNativeProps {
  spec: MultiStepSequenceSpec;
  /** Fired once, when the final step is advanced past (the sequence completes). */
  onComplete?: () => void;
}

export function MultiStepSequenceNative({ spec, onComplete }: MultiStepSequenceNativeProps) {
  const colors = useColors();
  const styles = makeStyles(colors);

  const [stepIndex, setStepIndex] = useState(0);
  const [liveSolved, setLiveSolved] = useState(false);
  const [verdict, setVerdict] = useState<Verdict>("idle");
  const [state, setState] = useState<unknown>(null);
  // Remounts the stage between steps so no state carries across (the native
  // analogue of the web renderer's `resetKey`).
  const [resetKey, setResetKey] = useState(0);

  const step = currentSequenceStep(spec, stepIndex);
  const complete = isSequenceComplete(spec, stepIndex);
  const progress = sequenceProgress(spec, stepIndex);
  const stepIsNative = step ? isNativeManipulativeKind(step.kind) : false;
  const isLastStep = progress.current === progress.total;
  const exploreStep = step != null && !isChallenge(step);

  const onSolvedChange = useCallback((s: boolean) => {
    setLiveSolved(s);
    setVerdict("idle");
  }, []);
  const onStateChange = useCallback((s: unknown) => setState(s), []);

  const check = () => {
    const solved = step ? isSolved(step, state) : liveSolved;
    setVerdict(solved ? "correct" : "incorrect");
  };

  const next = () => {
    const nextIndex = advanceSequence(stepIndex);
    setStepIndex(nextIndex);
    setVerdict("idle");
    setLiveSolved(false);
    setState(null);
    setResetKey((k) => k + 1);
    if (isSequenceComplete(spec, nextIndex)) onComplete?.();
  };

  const playAgain = () => {
    setStepIndex(0);
    setVerdict("idle");
    setLiveSolved(false);
    setState(null);
    setResetKey((k) => k + 1);
  };

  return (
    <View style={styles.card} accessibilityLabel="multi-step-sequence-challenge">
      <Text style={styles.eyebrow}>{spec.concept.toUpperCase()}</Text>
      <Text style={styles.title}>{complete ? spec.title : (step?.prompt ?? spec.title)}</Text>
      {spec.source ? <Text style={styles.source}>Inspired by {spec.source}</Text> : null}

      <ProgressDots current={progress.current} total={progress.total} colors={colors} />

      {!complete && step ? (
        <>
          {stepIsNative ? (
            <>
              <View style={styles.stage}>
                <NativeManipulative
                  key={resetKey}
                  spec={step}
                  onSolvedChange={onSolvedChange}
                  onStateChange={onStateChange}
                />
              </View>
              <VerdictChip verdict={verdict} exploreStep={exploreStep} styles={styles} />
              <View style={styles.footer}>
                {verdict === "correct" || exploreStep ? (
                  <PrimaryButton label={isLastStep ? "Finish" : "Next step"} onPress={next} styles={styles} />
                ) : (
                  <PrimaryButton label="Done" onPress={check} styles={styles} />
                )}
              </View>
            </>
          ) : (
            // Honest fallback — no native renderer for this step's kind. Show
            // truthful web-only copy and let the sequence continue rather than
            // rendering an empty stage or getting stuck.
            <>
              <View style={styles.fallbackBox}>
                <Text style={styles.fallbackText}>
                  This step is web-only for now — try it on the web app; iPad support for this kind is coming.
                </Text>
              </View>
              <View style={styles.footer}>
                <PrimaryButton label={isLastStep ? "Finish" : "Skip this step"} onPress={next} styles={styles} />
              </View>
            </>
          )}
        </>
      ) : null}

      {complete ? (
        <View style={styles.completeBanner}>
          <Text style={styles.completeTitle}>Challenge complete! ✓</Text>
          {spec.completeSummary ? <Text style={styles.completeSummary}>{spec.completeSummary}</Text> : null}
          <View style={styles.footer}>
            <PrimaryButton label="Play again" onPress={playAgain} styles={styles} />
          </View>
        </View>
      ) : null}
    </View>
  );
}

function ProgressDots({ current, total, colors }: { current: number; total: number; colors: Colors }) {
  const styles = makeStyles(colors);
  return (
    <View style={styles.progressRow}>
      <View style={styles.dotsRow}>
        {Array.from({ length: total }, (_, i) => (
          <View key={i} style={[styles.dot, i < current ? styles.dotFilled : styles.dotEmpty]} />
        ))}
      </View>
      <Text style={styles.progressLabel}>
        Step {current} of {total}
      </Text>
    </View>
  );
}

function VerdictChip({
  verdict,
  exploreStep,
  styles,
}: {
  verdict: Verdict;
  exploreStep: boolean;
  styles: Styles;
}) {
  const chipStyle =
    verdict === "correct" ? styles.chipCorrect : verdict === "incorrect" ? styles.chipIncorrect : styles.chipIdle;
  const textStyle =
    verdict === "correct"
      ? styles.chipTextCorrect
      : verdict === "incorrect"
        ? styles.chipTextIncorrect
        : styles.chipTextIdle;
  const label =
    verdict === "correct"
      ? "That's it! ✓"
      : verdict === "incorrect"
        ? "Not quite — take another look."
        : exploreStep
          ? "Have a play. There's nothing to get wrong here."
          : "Set it up, then tap Done.";
  return (
    <View style={[styles.chip, chipStyle]}>
      <Text style={[styles.chipText, textStyle]}>{label}</Text>
    </View>
  );
}

function PrimaryButton({ label, onPress, styles }: { label: string; onPress: () => void; styles: Styles }) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={({ pressed }) => [styles.button, pressed && styles.buttonPressed]}
    >
      <Text style={styles.buttonText}>{label}</Text>
    </Pressable>
  );
}

type Styles = ReturnType<typeof makeStyles>;

function makeStyles(c: Colors) {
  return StyleSheet.create({
    card: {
      width: "100%",
      backgroundColor: c.bg,
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: 18,
      padding: 18,
      gap: 10,
    },
    eyebrow: {
      fontFamily: fonts.bold,
      fontSize: 12,
      letterSpacing: 0.9,
      color: c.fgMuted,
    },
    title: {
      fontFamily: fonts.bold,
      fontSize: 20,
      lineHeight: 26,
      color: c.navy,
    },
    source: {
      fontFamily: fonts.medium,
      fontSize: 13,
      color: c.charcoalSubtle,
    },
    progressRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: 10,
      flexWrap: "wrap",
    },
    dotsRow: { flexDirection: "row", alignItems: "center", gap: 7 },
    dot: { width: 13, height: 13, borderRadius: 7 },
    dotFilled: { backgroundColor: c.navy },
    dotEmpty: { backgroundColor: c.bgSubtle, borderWidth: 1, borderColor: c.border },
    progressLabel: { fontFamily: fonts.bold, fontSize: 14, color: c.fgMuted },
    stage: { alignItems: "center", justifyContent: "center", paddingVertical: 8 },
    chip: {
      alignSelf: "flex-start",
      borderRadius: 999,
      paddingHorizontal: 14,
      paddingVertical: 7,
    },
    chipIdle: { backgroundColor: c.bgSubtle },
    chipCorrect: { backgroundColor: "rgba(0,221,145,0.16)" },
    chipIncorrect: { backgroundColor: "rgba(255,166,57,0.16)" },
    chipText: { fontFamily: fonts.bold, fontSize: 14.5 },
    chipTextIdle: { color: c.fg },
    chipTextCorrect: { color: "#00875a" },
    chipTextIncorrect: { color: "#b4650f" },
    fallbackBox: {
      backgroundColor: c.bgSubtle,
      borderRadius: 12,
      paddingHorizontal: 14,
      paddingVertical: 12,
    },
    fallbackText: {
      fontFamily: fonts.regular,
      fontSize: 14.5,
      lineHeight: 23,
      color: c.fgMuted,
    },
    footer: { flexDirection: "row", justifyContent: "flex-end", flexWrap: "wrap", gap: 10 },
    button: {
      backgroundColor: c.navy,
      borderRadius: 12,
      paddingHorizontal: 20,
      paddingVertical: 12,
      minHeight: 48,
      minWidth: 96,
      alignItems: "center",
      justifyContent: "center",
    },
    buttonPressed: { opacity: 0.82 },
    buttonText: { fontFamily: fonts.bold, fontSize: 16, color: c.white },
    completeBanner: {
      backgroundColor: "rgba(0,221,145,0.16)",
      borderRadius: 14,
      padding: 16,
      gap: 8,
    },
    completeTitle: { fontFamily: fonts.bold, fontSize: 17, color: "#00875a" },
    completeSummary: { fontFamily: fonts.medium, fontSize: 14, color: "#00875a", lineHeight: 21 },
  });
}
