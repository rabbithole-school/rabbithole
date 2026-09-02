import { useMemo } from "react";
import { useQuery } from "convex/react";
import { router } from "expo-router";
import { Pressable, StyleSheet, Text, View } from "react-native";
import * as Haptics from "expo-haptics";
import { SymbolView } from "expo-symbols";

import { api } from "@/lib/convex";
import { SunHorizonIcon, ToolboxIcon } from "@/components/PrepIcons";
import { fonts, useColors } from "@/theme";

/** The native twin of the Now-tab sunset doorway into Scholar's Prep. */
export function PrepEntryCard({ onOpen }: { onOpen: () => void }) {
  const colors = useColors();
  const styles = useMemo(() => makeStyles(colors), [colors]);

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Open Scholar’s Prep"
      onPress={() => {
        Haptics.selectionAsync();
        onOpen();
      }}
      style={({ pressed }) => [
        styles.entryCard,
        pressed && styles.entryCardPressed,
      ]}
    >
      <View style={styles.sunIcon}>
        <SunHorizonIcon size={32} color={colors.danger} />
      </View>
      <View style={styles.entryBody}>
        <Text style={styles.entryTitle}>Time for Scholar’s Prep</Text>
        <Text style={styles.entrySubtitle}>
          Make your take-home plan, reflect on today, or visit The Workshop.
        </Text>
      </View>
      <SymbolView
        name="chevron.right"
        size={18}
        tintColor={colors.navy}
      />
    </Pressable>
  );
}

/** Reflection and The Workshop are separate Prep choices, not one workflow. */
export function PrepActivityCards() {
  const colors = useColors();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const reflectionSnippet = useQuery(api.metaChat.myReflectionSnippet, {});

  return (
    <View style={styles.activityStack}>
      <PrepActivityCard
        icon={<SunHorizonIcon size={28} color={colors.navy} />}
        title="Today's reflection"
        subtitle={
          reflectionSnippet?.subtitle ??
          "How did today actually go? Take a quick look back."
        }
        onOpen={() => router.push("/reflection")}
        styles={styles}
        colors={colors}
      />
      <PrepActivityCard
        icon={<ToolboxIcon size={28} color={colors.navy} />}
        title="The Workshop"
        subtitle="Got an idea for Rabbithole? See what's new and how it works."
        onOpen={() => router.push("/workshop")}
        styles={styles}
        colors={colors}
      />
    </View>
  );
}

function PrepActivityCard({
  icon,
  title,
  subtitle,
  onOpen,
  styles,
  colors,
}: {
  icon: React.ReactNode;
  title: string;
  subtitle: string;
  onOpen: () => void;
  styles: ReturnType<typeof makeStyles>;
  colors: ReturnType<typeof useColors>;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={title}
      onPress={() => {
        Haptics.selectionAsync();
        onOpen();
      }}
      style={({ pressed }) => [
        styles.activityCard,
        pressed && styles.activityCardPressed,
      ]}
    >
      <View style={styles.activityIcon}>{icon}</View>
      <View style={styles.activityBody}>
        <Text style={styles.activityTitle}>{title}</Text>
        <Text style={styles.activitySubtitle}>{subtitle}</Text>
      </View>
      <SymbolView
        name="chevron.right"
        size={16}
        tintColor={colors.gray300}
      />
    </Pressable>
  );
}

function makeStyles(c: ReturnType<typeof useColors>) {
  return StyleSheet.create({
    entryCard: {
      width: "100%",
      minHeight: 104,
      padding: 16,
      flexDirection: "row",
      alignItems: "center",
      gap: 14,
      backgroundColor: c.orangeMuted,
      borderWidth: 1,
      borderColor: c.orange,
      borderRadius: 18,
    },
    entryCardPressed: { backgroundColor: c.orangeSubtle },
    sunIcon: {
      width: 56,
      height: 56,
      borderRadius: 28,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: c.orangeSubtle,
    },
    entryBody: { flex: 1, minWidth: 0, gap: 4 },
    entryTitle: {
      fontFamily: fonts.bold,
      fontSize: 20,
      lineHeight: 25,
      color: c.navy,
    },
    entrySubtitle: {
      fontFamily: fonts.regular,
      fontSize: 14,
      lineHeight: 20,
      color: c.charcoal,
    },
    activityStack: { width: "100%", gap: 12 },
    activityCard: {
      width: "100%",
      minHeight: 88,
      padding: 14,
      flexDirection: "row",
      alignItems: "center",
      gap: 14,
      backgroundColor: c.bg,
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: 16,
    },
    activityCardPressed: { backgroundColor: c.gray50 },
    activityIcon: {
      width: 44,
      height: 44,
      borderRadius: 12,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: c.violetSubtle,
    },
    activityBody: { flex: 1, minWidth: 0, gap: 2 },
    activityTitle: {
      fontFamily: fonts.bold,
      fontSize: 16,
      lineHeight: 21,
      color: c.charcoal,
    },
    activitySubtitle: {
      fontFamily: fonts.regular,
      fontSize: 14,
      lineHeight: 20,
      color: c.charcoalMuted,
    },
  });
}
