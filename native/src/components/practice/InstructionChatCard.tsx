import { useCallback, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import { useMutation } from "convex/react";

import { api, type Doc, type Id } from "@/lib/convex";
import { fonts, useColors, type Colors } from "@/theme";
import { LaunchpadAtoms } from "@/components/practice/LaunchpadContent";

export type InstructionChatPayload = NonNullable<
  Doc<"messages">["instruction"]
>;
export type InstructionHandbackStart = {
  sessionId: Id<"sessions">;
  streamId: string;
  assistantMsgId: Id<"messages">;
};

export function InstructionChatCard({
  messageId,
  sessionId,
  scholarId,
  instruction,
  onHandback,
}: {
  messageId: Id<"messages">;
  sessionId: Id<"sessions">;
  scholarId: Id<"users">;
  instruction: InstructionChatPayload;
  onHandback: (handback: InstructionHandbackStart) => Promise<void>;
}) {
  const colors = useColors();
  const styles = makeStyles(colors);
  const completeInstruction = useMutation(
    api.chatInstruction.completeChatInstruction,
  );
  const [busy, setBusy] = useState(false);
  const [completed, setCompleted] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onComplete = useCallback(async () => {
    if (busy || completed) return;
    setBusy(true);
    setError(null);
    let result;
    try {
      result = await completeInstruction({
        scholarId,
        sessionId,
        messageId,
        key: instruction.key,
      });
    } catch (completionError) {
      console.error("Could not complete chat instruction", completionError);
      setError("Couldn't mark this done — try again.");
      setBusy(false);
      return;
    }
    setCompleted(true);
    if (result.handback) {
      try {
        await onHandback(result.handback);
      } catch (handbackError) {
        console.error("Could not resume tutor after instruction", handbackError);
        setError("You're done. Send your next thought to return to the problem.");
      }
    }
    setBusy(false);
  }, [
    busy,
    completeInstruction,
    completed,
    instruction.key,
    messageId,
    onHandback,
    scholarId,
    sessionId,
  ]);

  return (
    <View style={styles.card}>
      <View style={styles.heading}>
        <Text style={styles.eyebrow}>Quick show-and-do</Text>
        <Text style={styles.title}>{instruction.title}</Text>
        {instruction.subtitle ? (
          <Text style={styles.subtitle}>{instruction.subtitle}</Text>
        ) : null}
      </View>

      <LaunchpadAtoms atoms={instruction.atoms} />

      {completed ? (
        <Text style={styles.completed}>Done — back to your problem.</Text>
      ) : (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Done — back to my problem"
          disabled={busy}
          onPress={() => void onComplete()}
          style={({ pressed }) => [
            styles.button,
            busy && styles.buttonDisabled,
            pressed && styles.buttonPressed,
          ]}
        >
          {busy ? (
            <ActivityIndicator color={colors.white} />
          ) : (
            <Text style={styles.buttonText}>Done — back to my problem</Text>
          )}
        </Pressable>
      )}
      {error ? <Text style={styles.error}>{error}</Text> : null}
    </View>
  );
}

function makeStyles(colors: Colors) {
  return StyleSheet.create({
    card: {
      width: "100%",
      backgroundColor: colors.bg,
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: 18,
      padding: 18,
      gap: 16,
    },
    heading: { gap: 4 },
    eyebrow: {
      color: colors.charcoalMuted,
      fontFamily: fonts.semibold,
      fontSize: 12,
      letterSpacing: 0.7,
      textTransform: "uppercase",
    },
    title: {
      color: colors.charcoal,
      fontFamily: fonts.bold,
      fontSize: 20,
      lineHeight: 26,
    },
    subtitle: {
      color: colors.charcoalMuted,
      fontFamily: fonts.regular,
      fontSize: 15,
      lineHeight: 21,
    },
    button: {
      minHeight: 44,
      alignSelf: "flex-start",
      alignItems: "center",
      justifyContent: "center",
      borderRadius: 12,
      backgroundColor: colors.teal,
      paddingHorizontal: 16,
    },
    buttonDisabled: { opacity: 0.45 },
    buttonPressed: { opacity: 0.72 },
    buttonText: {
      color: colors.white,
      fontFamily: fonts.bold,
      fontSize: 15,
    },
    completed: {
      color: colors.teal,
      fontFamily: fonts.semibold,
      fontSize: 15,
    },
    error: {
      color: colors.statusRed,
      fontFamily: fonts.regular,
      fontSize: 14,
    },
  });
}
