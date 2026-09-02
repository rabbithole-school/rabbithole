/**
 * MakePictureDialog — the scholar types a short description and Rabbithole draws
 * an illustration for the current slide. Modelled on `CreateQuestDialog` so a kid
 * meets the SAME short-text-in-a-sheet idiom the rest of the native app uses
 * (centred card, `AppTextInput`, one primary button), rather than a debug form.
 *
 * Submitting is INSTANT and optimistic: the card closes the moment the scholar
 * taps "Make it", handing the prompt back to the host, which drops a spinner
 * placeholder on the canvas and runs the (slow) generation in the background.
 * So this file never blocks on generation, never shows a busy state, and never
 * holds a generation error — the placeholder and the editor's error banner own
 * that now. It stays a pure prompt → submit surface.
 */

import { useMemo, useState } from "react";
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppTextInput } from "@/components/AppTextInput";
import { fonts, palette, useColors } from "@/theme";
import {
  MAKE_PICTURE_COPY,
  MAKE_PICTURE_MAX_PROMPT,
  canSubmitMakePicture,
} from "./makePicture";

export function MakePictureDialog({
  initialPrompt = "",
  onSubmit,
  onCancel,
}: {
  initialPrompt?: string;
  /**
   * The scholar's finished prompt. The host closes the dialog, drops a canvas
   * placeholder, and runs generation in the background — this never awaits it.
   */
  onSubmit: (prompt: string) => void;
  /** Backed out without submitting. */
  onCancel: () => void;
}) {
  const insets = useSafeAreaInsets();
  const colors = useColors();
  const styles = useMemo(() => makeStyles(colors), [colors]);

  const [prompt, setPrompt] = useState(initialPrompt);

  const cancel = () => {
    setPrompt("");
    onCancel();
  };

  const submit = () => {
    if (!canSubmitMakePicture(prompt, false)) return;
    const value = prompt;
    setPrompt("");
    onSubmit(value);
  };

  const canSubmit = canSubmitMakePicture(prompt, false);

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === "ios" ? "padding" : undefined}
      style={[
        StyleSheet.absoluteFill,
        styles.overlay,
        { paddingBottom: Math.max(insets.bottom, 16) },
      ]}
    >
      <Pressable style={styles.backdrop} onPress={cancel} />
      <View style={styles.sheet}>
        <View style={styles.header}>
          <View style={styles.headerText}>
            <Text style={styles.eyebrow}>{MAKE_PICTURE_COPY.label}</Text>
            <Text style={styles.title} numberOfLines={2}>
              {MAKE_PICTURE_COPY.action}
            </Text>
          </View>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={MAKE_PICTURE_COPY.cancel}
            hitSlop={10}
            onPress={cancel}
            style={({ pressed }) => [
              styles.closeButton,
              pressed && styles.closePressed,
            ]}
          >
            <Text style={styles.closeText}>×</Text>
          </Pressable>
        </View>

        <ScrollView
          style={styles.body}
          contentContainerStyle={styles.bodyContent}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          <AppTextInput
            autoFocus
            value={prompt}
            onChangeText={setPrompt}
            maxLength={MAKE_PICTURE_MAX_PROMPT}
            onSubmitEditing={submit}
            returnKeyType="go"
            placeholder={MAKE_PICTURE_COPY.placeholder}
            accessibilityLabel={MAKE_PICTURE_COPY.label}
            placeholderTextColor={colors.charcoalSubtle}
            multiline
            textAlignVertical="top"
            style={[styles.input, styles.textarea]}
          />
          <Text style={styles.helpText}>{MAKE_PICTURE_COPY.help}</Text>
        </ScrollView>

        <View style={styles.footerRow}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={MAKE_PICTURE_COPY.submit}
            accessibilityState={{ disabled: !canSubmit }}
            disabled={!canSubmit}
            onPress={submit}
            style={({ pressed }) => [
              styles.primaryButton,
              pressed && canSubmit && styles.primaryPressed,
              !canSubmit && styles.primaryDisabled,
            ]}
          >
            <Text style={styles.primaryText}>{MAKE_PICTURE_COPY.submit}</Text>
          </Pressable>
        </View>
      </View>
    </KeyboardAvoidingView>
  );
}

function makeStyles(c: ReturnType<typeof useColors>) {
  return StyleSheet.create({
    overlay: {
      flex: 1,
      alignItems: "center",
      justifyContent: "center",
      paddingHorizontal: 24,
      paddingTop: 24,
      zIndex: 20,
    },
    backdrop: {
      position: "absolute",
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      backgroundColor: "rgba(8, 13, 30, 0.42)",
    },
    sheet: {
      width: "100%",
      maxWidth: 560,
      maxHeight: "92%",
      borderRadius: 26,
      overflow: "hidden",
      backgroundColor: c.bg,
      borderWidth: 1,
      borderColor: c.border,
      shadowColor: palette.navy[900],
      shadowOpacity: 0.22,
      shadowRadius: 30,
      shadowOffset: { width: 0, height: 14 },
    },
    header: {
      flexDirection: "row",
      alignItems: "flex-start",
      gap: 16,
      paddingHorizontal: 24,
      paddingTop: 22,
      paddingBottom: 12,
    },
    headerText: { flex: 1, minWidth: 0 },
    eyebrow: {
      color: c.charcoalSubtle,
      fontSize: 12,
      letterSpacing: 1.1,
      textTransform: "uppercase",
      fontFamily: fonts.bold,
      marginBottom: 3,
    },
    title: {
      color: c.navy,
      fontSize: 22,
      lineHeight: 27,
      fontFamily: fonts.bold,
    },
    closeButton: {
      width: 34,
      height: 34,
      borderRadius: 17,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: c.gray50,
    },
    closePressed: { backgroundColor: c.gray100 },
    closeText: {
      color: c.charcoalMuted,
      fontSize: 28,
      lineHeight: 30,
      fontFamily: fonts.regular,
      marginTop: -2,
    },
    body: { flexShrink: 1 },
    bodyContent: {
      paddingHorizontal: 24,
      paddingVertical: 12,
      gap: 12,
    },
    input: {
      minHeight: 48,
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: 14,
      backgroundColor: c.bgSubtle,
      color: c.fg,
      paddingHorizontal: 14,
      paddingVertical: 11,
      fontSize: 16,
      fontFamily: fonts.regular,
    },
    textarea: { minHeight: 92, lineHeight: 22 },
    helpText: {
      color: c.charcoalMuted,
      fontSize: 13.5,
      lineHeight: 20,
      fontFamily: fonts.regular,
    },
    footerRow: {
      flexDirection: "row",
      justifyContent: "flex-end",
      paddingHorizontal: 24,
      paddingTop: 6,
      paddingBottom: 20,
    },
    primaryButton: {
      flex: 1,
      minHeight: 46,
      borderRadius: 14,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: c.violet,
      paddingHorizontal: 18,
    },
    primaryPressed: { backgroundColor: c.violetSolid },
    primaryDisabled: { opacity: 0.48 },
    primaryText: {
      color: c.white,
      fontSize: 16,
      fontFamily: fonts.bold,
    },
  });
}
