import { useMemo, useState } from "react";
import {
  ActivityIndicator,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";

import {
  BakePathPicker,
  type PathChoice,
} from "@/components/BakePathPicker";
import type { Id } from "@/lib/convex";
import { fonts, palette, useColors } from "@/theme";

export function ChoosePathDialog({
  open,
  seedId,
  topic,
  domain,
  submitting,
  onClose,
  onPick,
}: {
  open: boolean;
  seedId: Id<"seeds"> | null;
  topic: string | null;
  domain: string | null;
  submitting: boolean;
  onClose: () => void;
  onPick: (choice: PathChoice) => void;
}) {
  const colors = useColors();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const [chosen, setChosen] = useState<PathChoice | null>(null);

  return (
    <Modal
      visible={open}
      transparent
      animationType="fade"
      supportedOrientations={["landscape", "landscape-left", "landscape-right"]}
      onRequestClose={onClose}
    >
      <View style={styles.overlay}>
        {/* Exits stay live while a start is pending: closing abandons it
            (useExploreSeed). A locked fleet iPad has no other way out. */}
        <Pressable style={styles.backdrop} onPress={onClose} />
        <View style={styles.sheet}>
          <View style={styles.header}>
            <View style={styles.headerText}>
              <Text style={styles.eyebrow}>Your quest</Text>
              <Text style={styles.title}>How do you want to explore it?</Text>
              {topic ? (
                <Text style={styles.topic} numberOfLines={2}>
                  {topic}
                  {domain ? ` · ${domain}` : ""}
                </Text>
              ) : null}
            </View>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Close"
              hitSlop={10}
              onPress={onClose}
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
            showsVerticalScrollIndicator={false}
          >
            {open && seedId ? (
              <BakePathPicker
                source={{ kind: "seed", seedId }}
                onSelect={setChosen}
              />
            ) : null}
          </ScrollView>

          <View style={styles.footer}>
            <Pressable
              accessibilityRole="button"
              disabled={!chosen || submitting}
              onPress={() => chosen && onPick(chosen)}
              style={({ pressed }) => [
                styles.primaryButton,
                pressed && chosen && !submitting && styles.primaryPressed,
                (!chosen || submitting) && styles.disabled,
              ]}
            >
              {submitting ? (
                <ActivityIndicator color={colors.white} />
              ) : (
                <Text style={styles.primaryText}>Start exploring →</Text>
              )}
            </Pressable>
            <Text style={styles.note}>
              Every path goes somewhere real — these are just different ways in.
            </Text>
          </View>
        </View>
      </View>
    </Modal>
  );
}

function makeStyles(c: ReturnType<typeof useColors>) {
  return StyleSheet.create({
    overlay: {
      flex: 1,
      alignItems: "center",
      justifyContent: "center",
      padding: 24,
    },
    backdrop: {
      position: "absolute",
      top: 0,
      right: 0,
      bottom: 0,
      left: 0,
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
    topic: {
      color: c.charcoalMuted,
      fontSize: 14,
      lineHeight: 20,
      fontFamily: fonts.medium,
      marginTop: 5,
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
      fontSize: 26,
      lineHeight: 28,
      fontFamily: fonts.regular,
    },
    body: {
      flexShrink: 1,
    },
    bodyContent: {
      paddingHorizontal: 24,
      paddingVertical: 12,
    },
    footer: {
      paddingHorizontal: 24,
      paddingTop: 12,
      paddingBottom: 20,
      gap: 8,
    },
    primaryButton: {
      minHeight: 52,
      borderRadius: 15,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: c.violet,
    },
    primaryPressed: {
      opacity: 0.84,
    },
    primaryText: {
      color: c.white,
      fontSize: 16,
      fontFamily: fonts.bold,
    },
    disabled: {
      opacity: 0.5,
    },
    note: {
      color: c.charcoalSubtle,
      fontSize: 12,
      lineHeight: 17,
      textAlign: "center",
      fontFamily: fonts.regular,
    },
  });
}
