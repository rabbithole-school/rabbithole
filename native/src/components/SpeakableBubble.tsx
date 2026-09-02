/**
 * Tap a settled tutor bubble to hear it read aloud — the native counterpart of
 * the web "Read aloud" speaker button (components/SessionInterface.tsx, ~3357).
 *
 * Wraps an already-built chat bubble in BubbleMenu (its long-press Copy/Flag menu
 * is untouched) and, when the row is a SETTLED tutor message and TTS is enabled
 * for the scholar, makes a single tap toggle read-aloud through the shared native
 * engine (useNativeSpeaker → the existing `/tts` action). Tapping a different
 * bubble steals playback — the engine serializes audio app-wide. User bubbles and
 * the in-flight streaming bubble pass `speakable={false}`, so they get no
 * tap-to-read (web parity: assistant-only, settled-only).
 *
 * Markdown is stripped before speaking with the SAME helper web uses
 * (stripMarkdownForSpeech, vendored from lib/sentenceStream.ts) so a spoken reply
 * reads as prose, not punctuation soup. While THIS bubble is loading/speaking an
 * icon-only indicator floats in the gutter beside the bubble (absolutely
 * positioned — appearing never shifts the message layout) so the tap visibly
 * registered — the /tts round-trip can take >1s.
 */

import { useMemo, type ReactNode } from "react";
import { ActivityIndicator, Pressable, StyleSheet, View } from "react-native";
import { SymbolView } from "expo-symbols";

import { BubbleMenu, type BubbleMenuAlign } from "@/components/BubbleMenu";
import { useNativeSpeaker } from "@/lib/nativeTTS";
import { useColors } from "@/theme";
import { stripMarkdownForSpeech } from "../../vendor/shared/sentenceStream";

type MaybePromise = void | Promise<void>;

export type SpeakableBubbleProps = {
  /** The already-built bubble (rendered inside BubbleMenu and as its lifted preview). */
  children: ReactNode;
  /** Raw message text; markdown is stripped before it's spoken. */
  content: string;
  /** True only for a settled, non-empty tutor message (assistant-only, not streaming). */
  speakable: boolean;
  /** The scholar's TTS setting — `currentUser.ttsEnabled !== false`. */
  ttsEnabled: boolean;
  onCopy: () => MaybePromise;
  onFlag?: () => MaybePromise;
  flagged?: boolean;
  disabled?: boolean;
  align?: BubbleMenuAlign;
};

const styles = makeStyles();

export function SpeakableBubble({
  children,
  content,
  speakable,
  ttsEnabled,
  onCopy,
  onFlag,
  flagged,
  disabled,
  align,
}: SpeakableBubbleProps) {
  const colors = useColors();

  const spokenText = useMemo(
    () => (speakable ? stripMarkdownForSpeech(content).trim() : ""),
    [speakable, content],
  );
  const { speaking, loading, paused, toggle } = useNativeSpeaker(spokenText);

  // Tap-to-read only when this is a speakable tutor message, TTS is on for the
  // scholar, and there's something to say. Otherwise BubbleMenu gets no onPress
  // and behaves exactly as before (long-press Copy/Flag only).
  const canRead = speakable && ttsEnabled && spokenText.length > 0;

  return (
    <View style={styles.wrap}>
      <BubbleMenu
        onCopy={onCopy}
        onFlag={onFlag}
        flagged={flagged}
        disabled={disabled}
        align={align}
        onPress={canRead ? () => toggle() : undefined}
        accessibilityHint={
          canRead
            ? speaking
              ? "Pauses reading aloud"
              : paused
                ? "Resumes reading aloud"
                : "Reads this message aloud"
            : undefined
        }
      >
        {children}
      </BubbleMenu>
      {canRead && (loading || speaking || paused) && (
        // The gutter glyph is now a live control (not just an indicator): tapping
        // it toggles play/pause exactly like tapping the bubble. Absolutely
        // positioned so it never shifts the message layout; a generous hitSlop
        // gives it the iOS 44pt minimum touch target without growing the glyph.
        // Hidden from VoiceOver (the bubble carries the labeled action) so there
        // aren't two competing screen-reader targets.
        <Pressable
          onPress={loading ? undefined : () => toggle()}
          disabled={loading}
          hitSlop={{ top: 15, bottom: 15, left: 15, right: 15 }}
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          style={({ pressed }) => [
            styles.sideIndicator,
            pressed && !loading && styles.pressed,
          ]}
        >
          {loading ? (
            <ActivityIndicator size="small" color={colors.violet} />
          ) : (
            <SymbolView
              name={speaking ? "pause.fill" : "play.fill"}
              size={15}
              tintColor={colors.violet}
            />
          )}
        </Pressable>
      )}
    </View>
  );
}

export default SpeakableBubble;

function makeStyles() {
  return StyleSheet.create({
    // Positioning anchor only — no layout of its own, so the wrapper hugs the
    // bubble exactly as bare BubbleMenu did under either column's alignItems
    // (tutor rows flex-start, scholar rows flex-end).
    wrap: {},
    sideIndicator: {
      position: "absolute",
      right: -28,
      top: 8,
    },
    // Repo native press idiom (matches SpeakableLabel's styles.pressed).
    pressed: {
      opacity: 0.55,
    },
  });
}
