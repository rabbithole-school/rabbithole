import { useMemo } from "react";
import { ActivityIndicator, StyleSheet, Text, View } from "react-native";

import { fonts, useColors } from "@/theme";

/**
 * The transient status shown inside a chat transcript while the bot is working
 * BEFORE (or between) its visible text — a tool call, an extended-thinking
 * pause, or image generation. Shared by both native chat surfaces (the Workshop
 * reflection chat and the scholar tutor chat) so tool activity reads identically
 * in both.
 *
 * Deliberately quiet — one small muted spinner + a label, no chrome — the RN
 * idiom of the web AideThread's inline tool row and the SessionInterface tool
 * indicator. The host decides WHEN to render it (the reflection chat shows it
 * only pre-text, so it disappears the moment the reply starts).
 */
export type ChatActivity =
  | { kind: "thinking" }
  | { kind: "image" }
  | { kind: "tool"; label: string };

function labelFor(activity: ChatActivity): string {
  switch (activity.kind) {
    case "thinking":
      return "Thinking…";
    case "image":
      return "Making a picture…";
    case "tool":
      return `${activity.label}…`;
  }
}

export function ChatActivityRow({ activity }: { activity: ChatActivity }) {
  const colors = useColors();
  const styles = useMemo(
    () =>
      StyleSheet.create({
        row: { flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 4 },
        label: {
          fontSize: 14,
          lineHeight: 20,
          fontFamily: fonts.medium,
          color: colors.charcoalSubtle,
        },
      }),
    [colors],
  );
  const label = labelFor(activity);
  return (
    <View style={styles.row} accessibilityRole="text" accessibilityLabel={label}>
      <ActivityIndicator size="small" color={colors.charcoalSubtle} />
      <Text style={styles.label}>{label}</Text>
    </View>
  );
}
