import { useMemo } from "react";
import { KeyboardAvoidingView, Platform } from "react-native";
import { Stack, useLocalSearchParams } from "expo-router";

import { ReflectionChat, makeStyles } from "@/app/meta";
import { useReflectionChat } from "@/hooks/useReflectionChat";
import { useColors } from "@/theme";

export default function AskRabbitholeScreen() {
  const colors = useColors();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const chat = useReflectionChat("introspection");
  const { seed: seedText, n } = useLocalSearchParams<{
    seed?: string;
    n?: string;
  }>();
  const nonce = Number(n);
  const seed =
    seedText != null && seedText !== ""
      ? { text: seedText, nonce: Number.isFinite(nonce) ? nonce : 1 }
      : null;

  return (
    <>
      <Stack.Screen options={{ title: "Ask Rabbithole" }} />
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <ReflectionChat
          chat={chat}
          seed={seed}
          purpose="introspection"
          colors={colors}
          styles={styles}
        />
      </KeyboardAvoidingView>
    </>
  );
}
