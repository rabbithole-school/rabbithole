import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation } from "convex/react";
import { useRouter } from "expo-router";
import * as Haptics from "expo-haptics";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { Modal } from "@/components/FreezableModal";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import {
  BakePathPicker,
  bakePathArg,
  type PathChoice,
} from "@/components/BakePathPicker";
import { api } from "@/lib/convex";
import { BUILD_IT_PATH } from "../../vendor/shared/missionCopy";
import { fonts, palette, useColors } from "@/theme";
import { AppTextInput } from "@/components/AppTextInput";

export function CreateQuestDialog({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const colors = useColors();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const createQuest = useMutation(api.units.createQuest);
  const createSession = useMutation(api.sessions.create);
  const scheduleBake = useMutation(api.units.scheduleCustomQuestBake);

  const [step, setStep] = useState<"details" | "path">("details");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [chosen, setChosen] = useState<PathChoice | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The picker found a specific build and handed off: launching without a menu.
  const [startingBuild, setStartingBuild] = useState(false);
  // The hand-off fires once per quest: after a failed auto-launch the picker
  // shows its menu instead of handing off (and relaunching) again.
  const [handOffSpent, setHandOffSpent] = useState(false);
  // Same, synchronously: the picker can report a cached hit twice before a
  // re-render (StrictMode's double effect).
  const handedOffRef = useRef(false);
  // Bumped to abandon an in-flight start (close, unmount): a late
  // resolve from an abandoned attempt must never navigate or touch state.
  const attemptRef = useRef(0);
  useEffect(
    () => () => {
      attemptRef.current += 1;
    },
    [],
  );

  const trimmedTitle = title.trim();
  const trimmedDescription = description.trim();

  const reset = () => {
    setStep("details");
    setTitle("");
    setDescription("");
    setChosen(null);
    setError(null);
    setStartingBuild(false);
    setHandOffSpent(false);
    handedOffRef.current = false;
  };

  // Always closable — even mid-start. On a locked fleet iPad there is no Home
  // gesture, so a disabled exit over a stalled request traps the scholar.
  const close = () => {
    attemptRef.current += 1;
    setSubmitting(false);
    setStartingBuild(false);
    onClose();
    reset();
  };

  const goToPath = () => {
    if (!trimmedTitle) return;
    Haptics.selectionAsync().catch(() => {});
    setError(null);
    setChosen(null);
    setStartingBuild(false);
    setHandOffSpent(false);
    handedOffRef.current = false;
    setStep("path");
  };

  const launch = async (choice: PathChoice) => {
    if (submitting || !trimmedTitle) return;
    const attempt = ++attemptRef.current;
    const live = () => attemptRef.current === attempt;
    setSubmitting(true);
    setError(null);

    // None of these writes is idempotent (each mints a new unit / session), so
    // an abandoned attempt stops at the next step rather than finishing a quest
    // nobody is waiting for.
    const start = async () => {
      const result = await createQuest({
        title: trimmedTitle,
        ...(trimmedDescription ? { description: trimmedDescription } : {}),
      });
      if (!live()) return null;
      const session = await createSession({ unitId: result.unitId });
      if (!session?.id) throw new Error("Session was not created");
      if (!live()) return null;

      const bakePath = bakePathArg(choice);
      try {
        await scheduleBake({
          unitId: result.unitId,
          sessionId: session.id,
          ...(bakePath ? { bakePath } : {}),
        });
      } catch (e) {
        console.warn("[custom-quest] bake scheduling failed", e);
      }
      return session;
    };

    try {
      const session = await start();
      if (!live() || !session) return;
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(
        () => {},
      );
      setSubmitting(false);
      onClose();
      reset();
      router.push({
        pathname: "/session/[id]",
        params: { id: session.id, title: trimmedTitle },
      });
    } catch (e) {
      if (!live()) return;
      attemptRef.current += 1;
      setSubmitting(false);
      // Back to the menu the hand-off skipped, so the scholar can still start.
      setStartingBuild(false);
      const message = e instanceof Error ? e.message : String(e);
      setError(message || "Please try again.");
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning).catch(
        () => {},
      );
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
                  ? "What do you want to learn?"
                  : trimmedTitle}
              </Text>
            </View>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Close"
              hitSlop={10}
              onPress={close}
              style={({ pressed }) => [
                styles.closeButton,
                pressed && styles.closePressed,
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
                {startingBuild ? (
                  <Text style={styles.startingBuild}>
                    🛠️ Starting your build…
                  </Text>
                ) : (
                  <BakePathPicker
                    source={{
                      kind: "topic",
                      topic: trimmedTitle,
                      ...(trimmedDescription
                        ? { rationale: trimmedDescription }
                        : {}),
                    }}
                    onSelect={setChosen}
                    {...(handOffSpent
                      ? {}
                      : {
                          onSpecificBuild: () => {
                            if (handedOffRef.current) return;
                            handedOffRef.current = true;
                            setHandOffSpent(true);
                            setStartingBuild(true);
                            void launch(BUILD_IT_PATH);
                          },
                        })}
                  />
                )}
                {error && <Text style={styles.errorText}>{error}</Text>}
              </ScrollView>
              <View style={styles.pathFooter}>
                <Pressable
                  accessibilityRole="button"
                  // Nothing is pickable until the suggestions land (the picker
                  // falls back on its own after a timeout), so Start waits for
                  // a choice instead of launching one the scholar never saw.
                  disabled={submitting || !chosen}
                  onPress={() => chosen && launch(chosen)}
                  style={({ pressed }) => [
                    styles.primaryButton,
                    styles.startButton,
                    pressed && !submitting && !!chosen && styles.primaryPressed,
                    (submitting || !chosen) && styles.primaryDisabled,
                  ]}
                >
                  {submitting ? (
                    <ActivityIndicator color={colors.white} />
                  ) : (
                    <Text style={styles.primaryText}>Start exploring →</Text>
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
    footerNote: {
      textAlign: "center",
      color: c.charcoalSubtle,
      fontSize: 11.5,
      fontFamily: fonts.medium,
      paddingHorizontal: 24,
      paddingBottom: 18,
    },
    startingBuild: {
      textAlign: "center",
      color: c.charcoalMuted,
      fontSize: 14,
      fontFamily: fonts.semibold,
      paddingVertical: 24,
    },
    errorText: {
      color: c.statusRed,
      fontSize: 13,
      lineHeight: 19,
      fontFamily: fonts.semibold,
    },
  });
}
