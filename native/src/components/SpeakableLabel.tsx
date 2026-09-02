/**
 * SpeakableLabel (native) — the RN counterpart of components/SpeakableLabel.tsx.
 *
 * Wraps a label and speaks it aloud through the EXISTING `/tts` action (via the
 * native tap-to-hear engine in lib/nativeTTS.ts). Built for pre-readers who
 * navigate by picture + audio (young-learners plan §6) — tap the little speaker
 * (or, with `tapAnywhere`, the whole label) to hear it.
 *
 * API mirrors web: pass `text` to speak and/or `children` as the visible label.
 * When TTS is disabled for the scholar the children render completely unadorned.
 */

import { useMemo, type ReactNode } from "react";
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { SymbolView } from "expo-symbols";
import { useQuery } from "convex/react";

import { api } from "@/lib/convex";
import { useNativeSpeaker } from "@/lib/nativeTTS";
import { useColors, type Colors } from "@/theme";

export type SpeakableLabelProps = {
  /** Text to speak. Falls back to `children` when it's a plain string. */
  text?: string;
  /** The visible label. Defaults to a Text of `text` when omitted. */
  children?: ReactNode;
  /** Tap the whole label (not just the speaker icon) to hear it. */
  tapAnywhere?: boolean;
  /** Side the speaker icon sits on. Default "after". */
  iconPlacement?: "before" | "after";
  /** Hide the speaker icon (only sensible with `tapAnywhere`). */
  hideIcon?: boolean;
  /** Speaker icon size in px. Default 16. */
  iconSize?: number;
  /** Icon tint. Defaults to the muted charcoal / violet-when-speaking. */
  color?: string;
  /** aria/accessibility label for the speak control. */
  accessibilityLabel?: string;
};

function stringFromChildren(children: ReactNode): string {
  return typeof children === "string" || typeof children === "number"
    ? String(children)
    : "";
}

export function SpeakableLabel({
  text,
  children,
  tapAnywhere = false,
  iconPlacement = "after",
  hideIcon = false,
  iconSize = 16,
  color,
  accessibilityLabel,
}: SpeakableLabelProps) {
  const colors = useColors();
  const styles = useMemo(() => makeStyles(colors), [colors]);

  const me = useQuery(api.users.currentUser, {});
  const ttsEnabled = me?.ttsEnabled !== false;

  const spokenText = (text ?? stringFromChildren(children)).trim();
  const { speaking, loading, paused, toggle } = useNativeSpeaker(spokenText);

  const visible = children ?? (text ? <Text style={styles.fallback}>{text}</Text> : null);

  // TTS off, or nothing to say → render the label untouched.
  if (!ttsEnabled || !spokenText) return <>{visible}</>;

  const tint = speaking || paused ? colors.violet : (color ?? colors.charcoalSubtle);
  const a11y = accessibilityLabel ?? `Hear ${spokenText}`;
  const controlLabel = speaking
    ? "Pause reading"
    : paused
      ? "Resume reading"
      : a11y;

  const icon = hideIcon ? null : (
    <Pressable
      onPress={tapAnywhere ? undefined : toggle}
      disabled={tapAnywhere}
      hitSlop={10}
      accessibilityRole={tapAnywhere ? "none" : "button"}
      accessibilityLabel={tapAnywhere ? undefined : controlLabel}
      style={({ pressed }) => [styles.iconBtn, pressed && !tapAnywhere && styles.pressed]}
    >
      {loading ? (
        <ActivityIndicator size="small" color={tint} />
      ) : (
        <SymbolView
          name={speaking ? "pause.fill" : paused ? "play.fill" : "speaker.wave.2.fill"}
          size={iconSize}
          tintColor={tint}
        />
      )}
    </Pressable>
  );

  const row = (
    <View style={styles.row}>
      {iconPlacement === "before" && icon}
      {visible}
      {iconPlacement === "after" && icon}
    </View>
  );

  if (!tapAnywhere) return row;

  return (
    <Pressable
      onPress={toggle}
      accessibilityRole="button"
      accessibilityLabel={controlLabel}
      style={({ pressed }) => [pressed && styles.pressed]}
    >
      {row}
    </Pressable>
  );
}

function makeStyles(colors: Colors) {
  return StyleSheet.create({
    row: {
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
    },
    iconBtn: {
      alignItems: "center",
      justifyContent: "center",
    },
    pressed: {
      opacity: 0.55,
    },
    fallback: {
      color: colors.fg,
      fontSize: 16,
    },
  });
}
