import { Text } from "react-native";
import Reanimated, { Keyframe, useReducedMotion } from "react-native-reanimated";

import type { PracticeShellStyles } from "@/lib/practiceShell";

export type PracticeCardFeedback = "correct" | "miss" | null;

const StampPop = new Keyframe({
  0: { opacity: 0, transform: [{ scale: 0.55 }] },
  60: { opacity: 1, transform: [{ scale: 1.08 }] },
  100: { opacity: 1, transform: [{ scale: 1 }] },
});

export function PracticeVerdictStamp({
  feedback,
  shell,
  label,
  announcement,
}: {
  feedback: PracticeCardFeedback;
  shell: PracticeShellStyles;
  /** Overrides the visible stamp text (default "Correct" / "Not quite") —
   *  e.g. placement's honest "I haven't learned this yet" earns its own
   *  non-judgmental "Noted" rather than reusing "Not quite" (a don't-know is
   *  honesty, not a wrong guess). */
  label?: string;
  /** Overrides the accessibility announcement (defaults to `label`) — lets a
   *  caller speak a fuller retired-title phrase (e.g. "That's okay — good to
   *  know.") while the sighted stamp stays a terse "Noted". */
  announcement?: string;
}) {
  const reduceMotion = useReducedMotion();

  if (!feedback) return null;

  const correct = feedback === "correct";
  const visibleLabel = label ?? (correct ? "Correct" : "Not quite");
  const a11yLabel = announcement ?? visibleLabel;

  return (
    <Reanimated.View
      key={feedback}
      entering={reduceMotion ? undefined : StampPop.duration(260)}
      style={[shell.stamp, correct ? shell.stampCorrect : shell.stampMiss]}
      pointerEvents="none"
      accessibilityLabel={a11yLabel}
      accessibilityLiveRegion="polite"
    >
      <Text style={correct ? shell.stampTextCorrect : shell.stampTextMiss}>{visibleLabel}</Text>
    </Reanimated.View>
  );
}
