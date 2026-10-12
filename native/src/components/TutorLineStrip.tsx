// Native twin of web's components/TutorLineStrip.tsx. The tutor's chat beside
// a coached app is a bottom drawer that is closed by default (open, it hides
// the app), so a coach line from an app-update turn would otherwise land out
// of sight. The line sits in a slim slot under the app that is ALWAYS reserved
// in Play (empty when there is no line): the app never moves when a line
// arrives or is read, so a tap aimed at the app lands where it was aimed
// (TRA-477), and the line covers none of the app's own controls. A tap opens
// the drawer. The host decides when there is an unread line
// (useUnreadTutorLine).

import { Pressable, StyleSheet, Text, View } from "react-native";
import Reanimated, { FadeIn, useReducedMotion } from "react-native-reanimated";
import * as Haptics from "expo-haptics";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { fonts, useColors } from "@/theme";

const SLOT_HEIGHT = 40;

export function TutorLineSlot({
  line,
  onOpen,
}: {
  line: { id: string; preview: string } | null;
  onOpen: () => void;
}) {
  const colors = useColors();
  // The slot is the screen's bottom edge: keep its text above the home
  // indicator.
  const insets = useSafeAreaInsets();
  return (
    <View
      style={[
        styles.slot,
        {
          height: SLOT_HEIGHT + insets.bottom,
          paddingBottom: insets.bottom,
          backgroundColor: colors.bg,
          borderTopColor: colors.border,
        },
      ]}
    >
      {line ? (
        <TutorLineStrip key={line.id} preview={line.preview} onOpen={onOpen} />
      ) : null}
    </View>
  );
}

function TutorLineStrip({
  preview,
  onOpen,
}: {
  preview: string;
  onOpen: () => void;
}) {
  const colors = useColors();
  const reduceMotion = useReducedMotion();
  return (
    <Reanimated.View
      entering={reduceMotion ? undefined : FadeIn.duration(200)}
      style={styles.strip}
    >
      <Pressable
        onPress={() => {
          Haptics.selectionAsync();
          onOpen();
        }}
        style={styles.press}
        accessibilityRole="button"
        accessibilityLabel={`Tutor: ${preview}`}
        accessibilityHint="Opens the chat"
      >
        <Text style={[styles.label, { color: colors.navy }]}>Tutor</Text>
        <Text style={[styles.line, { color: colors.charcoal }]} numberOfLines={1}>
          {preview}
        </Text>
      </Pressable>
    </Reanimated.View>
  );
}

const styles = StyleSheet.create({
  slot: { borderTopWidth: StyleSheet.hairlineWidth, overflow: "hidden" },
  strip: { flex: 1 },
  press: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 16,
  },
  label: { fontFamily: fonts.semibold, fontSize: 14 },
  line: { flex: 1, fontFamily: fonts.regular, fontSize: 14 },
});
