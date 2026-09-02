import { useMemo } from "react";
import { KeyboardAvoidingView, Platform } from "react-native";
import { Stack, useLocalSearchParams } from "expo-router";

import { ReflectionChat, makeStyles } from "@/app/meta";
import { useReflectionChat } from "@/hooks/useReflectionChat";
import { useColors } from "@/theme";

/**
 * The reflection view — "Today's wrap-up" chat alone (the shipped ReflectionChat,
 * reused as-is). Reached from the Scholar's-Prep chooser plainly, or from a
 * Workshop chip carrying a seed (`?seed=<phrase>&n=<nonce>`) that pre-fills the
 * composer. The seed rides route params so it survives the board → chat
 * navigation. review/prep-time-chooser.html.
 */
export default function ReflectionScreen() {
  const colors = useColors();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const chat = useReflectionChat();

  const { seed: seedText, n } = useLocalSearchParams<{
    seed?: string;
    n?: string;
  }>();
  // The nonce lets re-tapping the same chip re-seed (ChatComposer compares it);
  // a fresh `n` arrives with every chip tap that navigates here.
  const nonce = Number(n);
  const seed =
    seedText != null && seedText !== ""
      ? { text: seedText, nonce: Number.isFinite(nonce) ? nonce : 1 }
      : null;

  return (
    <>
      <Stack.Screen options={{ title: "Today's reflection" }} />
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <ReflectionChat chat={chat} seed={seed} colors={colors} styles={styles} />
      </KeyboardAvoidingView>
    </>
  );
}
