import { useMemo, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import {
  ActivityIndicator,
  Alert,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import * as Haptics from "expo-haptics";

import { api } from "@/lib/convex";
import { HomeSectionHead } from "@/components/HomeSection";
import { FORCE_ALL_HOME_CARDS, forceList } from "@/lib/homeDevForce";
import { HOME_GAP, HOME_LABEL_GAP, HOME_SECTION_GAP } from "@/lib/homeRhythm";
import { fonts, palette, useColors } from "@/theme";

type Trail = FunctionReturnType<
  typeof api.trophyCase.trailsForScholar
>["trails"][number];

// Spacing-harness content only (FORCE_ALL_HOME_CARDS); never reaches prod.
const DEMO_TRAILS = [
  {
    unitId: "demo-trail",
    unitTitle: "How does a helicopter land with no engine?",
    unitDescription:
      "Autorotation: the rotor keeps spinning on the air rushing up through it.",
    unitEmoji: "🚁",
    badgeIcon: "🚁",
    domain: null,
    earnerCount: 3,
    earners: [
      { firstName: "Kai" },
      { firstName: "Lani" },
      { firstName: "Oliver" },
    ],
  },
];

function earnerLine(earners: Trail["earners"], count: number): string {
  const names = earners.map((earner) => earner.firstName);
  if (names.length === 0) return "Your pod lit this trail";
  if (count > names.length) {
    return `${names.join(", ")} +${count - names.length} more lit this trail`;
  }
  if (names.length === 1) return `${names[0]} completed this`;
  if (names.length === 2) return `${names[0]} & ${names[1]} completed this`;
  return `${names.slice(0, -1).join(", ")} & ${names[names.length - 1]} completed this`;
}

export function PeerTrails() {
  const data = useQuery(api.trophyCase.trailsForScholar, {});
  const trails = forceList(data?.trails, DEMO_TRAILS);
  const group =
    data?.group ??
    (FORCE_ALL_HOME_CARDS ? { emoji: "🌊", name: "YOUR POD" } : null);
  const follow = useMutation(api.seeds.followBadgeSelf);
  const [busy, setBusy] = useState<string | null>(null);
  const colors = useColors();
  const styles = useMemo(() => makeStyles(colors), [colors]);

  if (!trails || trails.length === 0) return null;

  const join = async (trail: Trail) => {
    const key = String(trail.unitId);
    if (busy === key) return;
    setBusy(key);
    Haptics.selectionAsync().catch(() => {});
    try {
      const result = await follow({
        topic: trail.unitTitle,
        domain: trail.domain ?? undefined,
        inspiredByName: trail.earners[0]?.firstName ?? "a friend",
        unitId: trail.unitId,
      });
      Alert.alert(
        result.alreadyFollowing ? "Already on your map" : "Joined the quest",
        result.alreadyFollowing
          ? "This trail is already one of your stars."
          : `${trail.unitTitle} is now a star on your map.`,
      );
    } catch (error) {
      console.warn("[peer-trail] join failed", error);
      Alert.alert("Couldn’t join that quest", "Check your connection and try again.");
    } finally {
      setBusy(null);
    }
  };

  return (
    <View style={styles.section}>
      <HomeSectionHead
        label={`More quests from ${group?.name ?? "your group"}`}
        icon={<Text style={styles.headingGlyph}>{group?.emoji ?? "👣"}</Text>}
      />
      <View style={styles.cards}>
      {trails.map((trail) => {
        const key = String(trail.unitId);
        const joining = busy === key;
        return (
          <Pressable
            key={key}
            accessibilityRole="button"
            accessibilityLabel={`Join ${trail.unitTitle}`}
            disabled={joining}
            onPress={() => void join(trail)}
            style={({ pressed }) => [
              styles.card,
              pressed && !joining && styles.cardPressed,
              joining && styles.cardBusy,
            ]}
          >
            <Text style={styles.badge} accessibilityElementsHidden>
              {trail.badgeIcon}
            </Text>
            <View style={styles.body}>
              <Text style={styles.title} numberOfLines={1}>
                {trail.unitTitle}
              </Text>
              <Text style={styles.meta} numberOfLines={1}>
                {earnerLine(trail.earners, trail.earnerCount)}
              </Text>
              {trail.unitDescription ? (
                <Text style={styles.description} numberOfLines={2}>
                  {trail.unitDescription}
                </Text>
              ) : null}
            </View>
            <View style={styles.cta}>
              {joining ? (
                <ActivityIndicator color={colors.cyan} />
              ) : (
                <Text style={styles.ctaText}>Join ›</Text>
              )}
            </View>
          </Pressable>
        );
      })}
      </View>
    </View>
  );
}

function makeStyles(colors: ReturnType<typeof useColors>) {
  return StyleSheet.create({
    section: {
      // Self-gates away entirely, as do both of its siblings in the Home's
      // quest footer — so it owns its LEADING gap rather than letting a
      // wrapper hang a gap that would outlive it.
      paddingTop: HOME_SECTION_GAP,
      gap: HOME_LABEL_GAP,
    },
    cards: {
      gap: HOME_GAP,
    },
    headingGlyph: {
      fontSize: 14,
    },
    card: {
      minHeight: 88,
      flexDirection: "row",
      alignItems: "center",
      gap: 12,
      paddingHorizontal: 16,
      paddingVertical: 14,
      backgroundColor: colors.bg,
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: 18,
      shadowColor: palette.navy[900],
      shadowOpacity: 0.05,
      shadowRadius: 10,
      shadowOffset: { width: 0, height: 3 },
    },
    cardPressed: {
      backgroundColor: colors.gray50,
    },
    cardBusy: {
      opacity: 0.6,
    },
    badge: {
      width: 34,
      textAlign: "center",
      fontSize: 28,
    },
    body: {
      flex: 1,
      minWidth: 0,
      gap: 3,
    },
    title: {
      fontSize: 16,
      fontFamily: fonts.bold,
      color: colors.navy,
    },
    meta: {
      fontSize: 14,
      fontFamily: fonts.semibold,
      color: colors.charcoalMuted,
    },
    description: {
      marginTop: 2,
      fontSize: 14,
      lineHeight: 19,
      fontFamily: fonts.regular,
      color: colors.charcoalMuted,
    },
    cta: {
      minWidth: 54,
      alignItems: "flex-end",
    },
    ctaText: {
      fontSize: 15,
      fontFamily: fonts.bold,
      color: colors.cyan,
    },
  });
}
