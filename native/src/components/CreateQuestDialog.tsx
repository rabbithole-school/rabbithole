import { useMemo, useState } from "react";
import { useMutation } from "convex/react";
import { useRouter } from "expo-router";
import * as Haptics from "expo-haptics";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import {
  BakePathPicker,
  ENDLESS_CHAT,
  type PathChoice,
} from "@/components/BakePathPicker";
import { api } from "@/lib/convex";
import { fonts, palette, useColors } from "@/theme";
import { AppTextInput } from "@/components/AppTextInput";

export function CreateQuestDialog({
  open,
  onClose,
  mode = "launch",
}: {
  open: boolean;
  onClose: () => void;
  mode?: "launch" | "addToTonight";
}) {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const colors = useColors();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const createQuest = useMutation(api.units.createQuest);
  const createSession = useMutation(api.sessions.create);
  const scheduleBake = useMutation(api.units.scheduleCustomQuestBake);
  const addSessionToPlan = useMutation(api.takeHomePlans.addSessionToPlan);

  const [step, setStep] = useState<"details" | "path">("details");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [chosen, setChosen] = useState<PathChoice | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const trimmedTitle = title.trim();
  const trimmedDescription = description.trim();

  const reset = () => {
    setStep("details");
    setTitle("");
    setDescription("");
    setChosen(null);
    setError(null);
  };

  const close = () => {
    if (submitting) return;
    onClose();
    reset();
  };

  const goToPath = () => {
    if (!trimmedTitle) return;
    Haptics.selectionAsync().catch(() => {});
    setError(null);
    setChosen(null);
    setStep("path");
  };

  const handleCreate = async () => {
    if (submitting || !trimmedTitle) return;
    const choice = chosen ?? ENDLESS_CHAT;
    setSubmitting(true);
    setError(null);
    try {
      const result = await createQuest({
        title: trimmedTitle,
        ...(trimmedDescription ? { description: trimmedDescription } : {}),
      });
      const session = await createSession({ unitId: result.unitId });
      if (!session?.id) throw new Error("Session was not created");
      if (mode === "addToTonight") {
        await addSessionToPlan({ sessionId: session.id });
      }

      const bakePath =
        choice === ENDLESS_CHAT
          ? undefined
          : { title: choice.title, blurb: choice.blurb };
      try {
        await scheduleBake({
          unitId: result.unitId,
          sessionId: session.id,
          ...(bakePath ? { bakePath } : {}),
        });
      } catch (e) {
        console.warn("[custom-quest] bake scheduling failed", e);
      }

      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(
        () => {},
      );
      onClose();
      reset();
      if (mode === "launch") {
        router.push({
          pathname: "/session/[id]",
          params: { id: session.id, title: trimmedTitle },
        });
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setError(message || "Please try again.");
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning).catch(
        () => {},
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      visible={open}
      transparent
      animationType="fade"
      supportedOrientations={["landscape", "landscape-left", "landscape-right"]}
      onRequestClose={close}
    >
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        style={[styles.overlay, { paddingBottom: Math.max(insets.bottom, 16) }]}
      >
        <Pressable style={styles.backdrop} onPress={close} />
        <View style={styles.sheet}>
          <View style={styles.header}>
            <View style={styles.headerText}>
              <Text style={styles.eyebrow}>Quest</Text>
              <Text style={styles.title} numberOfLines={2}>
                {step === "details"
                  ? mode === "addToTonight" ? "Shape a new quest" : "What do you want to learn?"
                  : trimmedTitle}
              </Text>
            </View>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Close"
              disabled={submitting}
              hitSlop={10}
              onPress={close}
              style={({ pressed }) => [
                styles.closeButton,
                pressed && styles.closePressed,
                submitting && styles.disabled,
              ]}
            >
              <Text style={styles.closeText}>×</Text>
            </Pressable>
          </View>

          {step === "details" ? (
            <>
              <ScrollView
                style={styles.body}
                contentContainerStyle={styles.bodyContent}
                keyboardShouldPersistTaps="handled"
                showsVerticalScrollIndicator={false}
              >
                <View style={styles.field}>
                  <Text style={styles.label}>Title</Text>
                  <AppTextInput
                    autoFocus
                    value={title}
                    onChangeText={setTitle}
                    onSubmitEditing={goToPath}
                    returnKeyType="next"
                    placeholder="e.g. Why do octopuses have 3 hearts?"
                    placeholderTextColor={colors.charcoalSubtle}
                    style={styles.input}
                  />
                </View>
                <View style={styles.field}>
                  <Text style={styles.label}>A little more (optional)</Text>
                  <AppTextInput
                    value={description}
                    onChangeText={setDescription}
                    placeholder="What got you curious about this? What would you like to know?"
                    placeholderTextColor={colors.charcoalSubtle}
                    multiline
                    textAlignVertical="top"
                    style={[styles.input, styles.textarea]}
                  />
                </View>
                <Text style={styles.helpText}>
                  Next you&apos;ll pick how to explore it — just chat, or a guided way
                  in. You earn a 🏆 badge when you finish.
                </Text>
              </ScrollView>
              <View style={styles.footerRow}>
                <Pressable
                  accessibilityRole="button"
                  disabled={!trimmedTitle}
                  onPress={goToPath}
                  style={({ pressed }) => [
                    styles.primaryButton,
                    styles.startButton,
                    pressed && trimmedTitle && styles.primaryPressed,
                    !trimmedTitle && styles.primaryDisabled,
                  ]}
                >
                  <Text style={styles.primaryText}>Continue</Text>
                </Pressable>
              </View>
            </>
          ) : (
            <>
              <ScrollView
                style={styles.body}
                contentContainerStyle={styles.pathContent}
                keyboardShouldPersistTaps="handled"
                showsVerticalScrollIndicator={false}
              >
                <BakePathPicker
                  source={{
                    kind: "topic",
                    topic: trimmedTitle,
                    ...(trimmedDescription
                      ? { rationale: trimmedDescription }
                      : {}),
                  }}
                  onSelect={setChosen}
                />
                {error && <Text style={styles.errorText}>{error}</Text>}
              </ScrollView>
              <View style={styles.pathFooter}>
                <Pressable
                  accessibilityRole="button"
                  disabled={submitting}
                  onPress={handleCreate}
                  style={({ pressed }) => [
                    styles.primaryButton,
                    styles.startButton,
                    pressed && !submitting && styles.primaryPressed,
                    submitting && styles.primaryDisabled,
                  ]}
                >
                  {submitting ? (
                    <ActivityIndicator color={colors.white} />
                  ) : (
                    <Text style={styles.primaryText}>{mode === "addToTonight" ? "Create & add to tonight" : "Start exploring →"}</Text>
                  )}
                </Pressable>
              </View>
              <Text style={styles.footerNote}>
                Every path goes somewhere real — these are just different ways in.
              </Text>
            </>
          )}
        </View>
      </KeyboardAvoidingView>
    </Modal>
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
    headerText: {
      flex: 1,
      minWidth: 0,
    },
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
    closePressed: {
      backgroundColor: c.gray100,
    },
    closeText: {
      color: c.charcoalMuted,
      fontSize: 28,
      lineHeight: 30,
      fontFamily: fonts.regular,
      marginTop: -2,
    },
    body: {
      flexShrink: 1,
      zIndex: 1,
    },
    bodyContent: {
      paddingHorizontal: 24,
      paddingVertical: 12,
      gap: 15,
    },
    pathContent: {
      paddingHorizontal: 24,
      paddingTop: 8,
      paddingBottom: 14,
      gap: 12,
    },
    field: {
      gap: 6,
    },
    label: {
      color: c.charcoalMuted,
      fontSize: 12,
      letterSpacing: 0.7,
      textTransform: "uppercase",
      fontFamily: fonts.bold,
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
    textarea: {
      minHeight: 92,
      lineHeight: 22,
    },
    helpText: {
      color: c.charcoalMuted,
      fontSize: 13.5,
      lineHeight: 20,
      fontFamily: fonts.regular,
    },
    footerRow: {
      flexDirection: "row",
      justifyContent: "flex-end",
      gap: 10,
      paddingHorizontal: 24,
      paddingTop: 6,
      paddingBottom: 20,
    },
    pathFooter: {
      position: "relative",
      zIndex: 2,
      elevation: 2,
      flexDirection: "row",
      alignItems: "center",
      gap: 10,
      paddingHorizontal: 24,
      paddingTop: 6,
      paddingBottom: 8,
    },
    primaryButton: {
      minHeight: 46,
      borderRadius: 14,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: c.violet,
      paddingHorizontal: 18,
    },
    startButton: {
      flex: 1,
    },
    primaryPressed: {
      backgroundColor: c.violetSolid,
    },
    primaryDisabled: {
      opacity: 0.48,
    },
    primaryText: {
      color: c.white,
      fontSize: 16,
      fontFamily: fonts.bold,
    },
    disabled: {
      opacity: 0.55,
    },
    footerNote: {
      textAlign: "center",
      color: c.charcoalSubtle,
      fontSize: 11.5,
      fontFamily: fonts.medium,
      paddingHorizontal: 24,
      paddingBottom: 18,
    },
    errorText: {
      color: c.statusRed,
      fontSize: 13,
      lineHeight: 19,
      fontFamily: fonts.semibold,
    },
  });
}
