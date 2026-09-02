/**
 * StemCard — the problem card, and the HOME of the correctness feedback. On a
 * correct/miss result the verdict lands as an OVERLAY here: a corner stamp
 * (pops in), a ring (border tint), and a short shake on a miss — never an
 * inline box that grows the column and jumps the card. So submit→feedback
 * never moves it.
 *
 * Shared by the practice drill (`app/practice.tsx`) AND placement
 * (`NativePlacement.tsx`) — #unify: Andy's direct observation that placement
 * still ran a legacy full-screen correct-answer interstitial while practice
 * had this polished corner-stamp overlay. Both surfaces now render the
 * IDENTICAL verdict language instead of a hand-maintained copy. Web twin:
 * `components/practice/VerdictStemCard.tsx`.
 */
import { useEffect } from "react";
import type { ViewStyle } from "react-native";
import Reanimated, {
  useAnimatedStyle,
  useSharedValue,
  withSequence,
  withTiming,
} from "react-native-reanimated";

import { StemText } from "@/components/practice/StemText";
import { SpeakableLabel } from "@/components/SpeakableLabel";
import { PromptVisual } from "@/components/practice/PromptVisual";
import {
  PracticeVerdictStamp,
  type PracticeCardFeedback,
} from "@/components/practice/PracticeVerdictStamp";
import type { PracticeShellStyles } from "@/lib/practiceShell";
import { stemToSpeech } from "../../../vendor/shared/practiceStemBlocks";
import { superscriptExponents } from "../../../vendor/shared/mathNotation";
import type { PracticePromptVisual } from "../../../vendor/shared/practicePromptVisual";
import { STEM_FONT_LG, STEM_FONT_SM } from "../../../vendor/shared/practicePromptVisual";

/** The styles a StemCard consumer must provide: the shared verdict-overlay
 *  shell (ring + stamp, from `makePracticeShellStyles`) PLUS its own
 *  screen-specific neutral `stemBox` (practice's and placement's differ
 *  slightly in padding, so it isn't hoisted into the shared shell). */
export type StemCardStyles = PracticeShellStyles & { stemBox: ViewStyle };

export function StemCard({
  stem,
  promptVisual,
  feedback,
  reduceMotion,
  styles,
  stampLabel,
  stampAnnouncement,
  speakable = false,
  big = false,
}: {
  stem: string | null | undefined;
  promptVisual?: PracticePromptVisual;
  feedback: PracticeCardFeedback;
  reduceMotion: boolean;
  styles: StemCardStyles;
  /** Overrides the stamp's visible text (default "Correct" / "Not quite") —
   *  e.g. placement's honest "I haven't learned this yet" earns "Noted". */
  stampLabel?: string;
  /** Overrides the stamp's accessibility announcement (defaults to
   *  `stampLabel`) — lets a caller speak a fuller retired-title phrase. */
  stampAnnouncement?: string;
  /** Kindergarten (grade "K") item: wrap the stem in a tap-to-hear speaker so a
   *  pre-reader can hear the question. Uses the shared native `SpeakableLabel`
   *  (which respects the scholar's `ttsEnabled`). Default off ⇒ unchanged. */
  speakable?: boolean;
  /** A bare "Fast math" retrieval item — render the fact LARGER so a single-
   *  digit fact reads as an instant, focused recall prompt (the tactile FastMath
   *  feel on iPad), not a wordy card. Default off ⇒ the ordinary STEM_FONT_SM. */
  big?: boolean;
}) {
  // Miss shake — a short horizontal wobble that re-fires on each fresh miss (a
  // retry sends us back to answering, so the next miss is a new false→"miss"
  // transition). Reduced-motion: calm, no shake.
  const shake = useSharedValue(0);
  const isMiss = feedback === "miss";
  useEffect(() => {
    if (isMiss && !reduceMotion) {
      shake.set(withSequence(
        withTiming(-6, { duration: 45 }),
        withTiming(6, { duration: 90 }),
        withTiming(-4, { duration: 90 }),
        withTiming(0, { duration: 60 }),
      ));
    }
  }, [isMiss, reduceMotion, shake]);
  const shakeStyle = useAnimatedStyle(() => ({ transform: [{ translateX: shake.get() }] }));

  return (
    <Reanimated.View
      style={[
        styles.stemBox,
        feedback === "correct" && styles.stemBoxCorrect,
        feedback === "miss" && styles.stemBoxMiss,
        shakeStyle,
      ]}
    >
      {speakable ? (
        <SpeakableLabel
          text={stemToSpeech(stem ?? "")}
          tapAnywhere
          accessibilityLabel="Hear the question"
          iconSize={22}
        >
          <StemText value={superscriptExponents(stem ?? "")} fontSize={big ? STEM_FONT_LG : STEM_FONT_SM} align="center" />
        </SpeakableLabel>
      ) : (
        <StemText value={superscriptExponents(stem ?? "")} fontSize={big ? STEM_FONT_LG : STEM_FONT_SM} align="center" />
      )}
      {promptVisual ? <PromptVisual spec={promptVisual} /> : null}

      <PracticeVerdictStamp
        feedback={feedback}
        shell={styles}
        label={stampLabel}
        announcement={stampAnnouncement}
      />
    </Reanimated.View>
  );
}
