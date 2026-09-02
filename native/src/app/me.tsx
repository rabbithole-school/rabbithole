import { useQuery } from "convex/react";
import { router, Stack } from "expo-router";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { Image } from "expo-image";
import { useMemo, useState } from "react";
import { SymbolView } from "expo-symbols";

import { api } from "@/lib/convex";
import { resolveUserImageUri } from "@/lib/webEmbedConfig";
import { colorForDomain, fonts, palette, useColors } from "@/theme";
import { useMapGates } from "@/hooks/useMapGates";
import WeeklyGoalsCard from "@/components/WeeklyGoalsCard";
import { strongestSignalHeadline } from "../../vendor/practice/calibration";

const MAXW = 720;
const MAX_LEAPS_SHOWN = 6;

export default function MyLearning() {
  const colors = useColors();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const me = useQuery(api.users.currentUser, {});
  const scholarId = me?._id;
  const badges = useQuery(api.scholarUnitBadges.myEarnedBadges, {});
  const growth = useQuery(
    api.masteryObservations.growthForScholar,
    scholarId ? { scholarId } : "skip",
  );
  const sky = useQuery(api.seeds.skyForSelf, {});
  // Milestone reveals (f6): the map card is hidden until at least one of the
  // scholar's two maps first has real data. No padlock/teaser — it simply
  // isn't here until then.
  const { anyUnlocked: mapUnlocked } = useMapGates();
  const calibration = useQuery(
    api.practiceCalibration.calibrationForSelf,
    scholarId ? { scholarId } : "skip",
  );
  const connections = useQuery(
    api.crossDomainConnections.listByScholar,
    scholarId ? { scholarId } : "skip",
  );
  const [leapsExpanded, setLeapsExpanded] = useState(false);

  if (me === undefined) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color={colors.violet} />
      </View>
    );
  }

  const name = me?.name ?? "You";
  const initials = name
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? "")
    .join("");
  const avatarUri = resolveUserImageUri(me?.image);
  // The kid's OWN authored leaps only (never observer-inferred connections),
  // newest first — listByScholar's index already orders desc.
  const leaps = (connections ?? []).filter((c) => c.studentInitiated);
  const visibleLeaps = leapsExpanded ? leaps : leaps.slice(0, MAX_LEAPS_SHOWN);
  const headline = calibration ? strongestSignalHeadline(calibration.byLevel) : null;

  return (
    <>
      <Stack.Screen options={{ title: "My Learning" }} />
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        style={styles.scroll}
        contentContainerStyle={styles.container}
      >
        {/* Profile header */}
        <Pressable
          onPress={() => router.push("/account")}
          style={({ pressed }) => [styles.profileRow, pressed && { opacity: 0.75 }]}
        >
          <View style={styles.profileLeft}>
            {avatarUri ? (
              <Image
                source={{ uri: avatarUri }}
                style={styles.avatar}
                contentFit="cover"
                alt="Your profile photo"
              />
            ) : (
              <View style={[styles.avatar, styles.avatarFallback]}>
                <Text style={styles.avatarInitials}>{initials}</Text>
              </View>
            )}
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text style={styles.profileName} numberOfLines={1}>{name}</Text>
              {me?.username && (
                <Text style={styles.profileUsername} numberOfLines={1}>@{me.username}</Text>
              )}
            </View>
          </View>
          <SymbolView name="chevron.right" size={14} tintColor={colors.charcoalSubtle} />
        </Pressable>
        {/* Curiosities → star map (hidden until a map has real data — f6) */}
        {mapUnlocked && (
        <Pressable
          onPress={() => router.push("/sky")}
          style={({ pressed }) => [styles.skyCard, pressed && { opacity: 0.92 }]}
        >
          <View style={[styles.skyDot, { top: 16, left: 26, opacity: 0.9 }]} />
          <View style={[styles.skyDot, { top: 38, right: 70, width: 4, height: 4, opacity: 0.6 }]} />
          <View style={[styles.skyDot, { bottom: 22, right: 120, width: 5, height: 5 }]} />
          <View style={styles.skyBody}>
            <Text style={styles.skyEyebrow}>YOUR MAP</Text>
            <Text style={styles.skyTitle}>
              {sky ? `${sky.seeds.length} curiosities to explore` : "Your curiosities"}
            </Text>
            {sky && sky.mastery.length > 0 ? (
              <Text style={styles.skyMasterySubtitle}>
                {sky.mastery.length} skill{sky.mastery.length === 1 ? "" : "s"} glowing bright
              </Text>
            ) : null}
            <Text style={styles.skyCta}>Open ›</Text>
          </View>
        </Pressable>
        )}

        {/* My goals this week — the learner-owned SRL loop (web parity). */}
        <WeeklyGoalsCard />

        {/* Getting to know what you know — the calibration mirror */}
        {calibration && (
          <>
            <Text style={styles.sectionLabel}>GETTING TO KNOW WHAT YOU KNOW</Text>
            <View style={styles.calibrationCard}>
              {headline && <Text style={styles.calibrationHeadline}>{headline}</Text>}
              {calibration.byLevel.map((row) => (
                <View key={row.level} style={styles.calibrationRow}>
                  <Text style={styles.calibrationLabel}>{row.label}</Text>
                  <View style={styles.calibrationMeterTrack}>
                    <View
                      style={[
                        styles.calibrationMeterFill,
                        {
                          width: `${row.total > 0 ? Math.round((row.correct / row.total) * 100) : 0}%`,
                        },
                      ]}
                    />
                  </View>
                  <Text style={styles.calibrationFraction}>
                    {row.total > 0 ? `${row.correct}/${row.total}` : "—"}
                  </Text>
                </View>
              ))}
              <Text style={styles.calibrationGrowthLine}>{calibration.growthLine}</Text>
            </View>
          </>
        )}

        {/* Badges */}
        <Text style={styles.sectionLabel}>THINGS YOU&apos;VE EARNED</Text>
        {badges === undefined ? (
          <ActivityIndicator color={colors.violet} style={{ marginVertical: 16 }} />
        ) : badges.length > 0 ? (
          <View style={styles.badgeGrid}>
            {badges.map((b) => (
              <View key={b._id} style={styles.badge}>
                {b.imageUrl ? (
                  <Image
                    source={b.imageUrl}
                    style={styles.badgeImg}
                    contentFit="cover"
                    transition={200}
                    alt={`${b.unitTitle} badge`}
                  />
                ) : (
                  <View style={[styles.badgeImg, styles.badgeEmojiWrap]}>
                    <Text style={styles.badgeEmoji}>{b.unitEmoji ?? "🏅"}</Text>
                  </View>
                )}
                <Text style={styles.badgeTitle} numberOfLines={2}>
                  {b.unitTitle}
                </Text>
              </View>
            ))}
          </View>
        ) : (
          <Text style={styles.empty}>
            Finish a quest — or any unit with a badge — to earn your first badge.
          </Text>
        )}

        {/* How you've grown */}
        <Text style={styles.sectionLabel}>HOW YOU&apos;VE GROWN</Text>
        {growth === undefined && scholarId ? (
          <ActivityIndicator color={colors.violet} style={{ marginVertical: 16 }} />
        ) : growth && growth.length > 0 ? (
          growth.map((g, i) => (
            <View key={`${g.conceptLabel}-${i}`} style={styles.growthCard}>
              <Text
                style={[styles.growthDomain, { color: colorForDomain(g.domain) }]}
              >
                {g.domain.toUpperCase()}
                {g.studentInitiated ? "  ·  YOU LED THIS" : ""}
              </Text>
              <Text style={styles.growthConcept}>{g.conceptLabel}</Text>
              {g.excerpt ? (
                <Text style={styles.growthExcerpt}>“{g.excerpt}”</Text>
              ) : null}
            </View>
          ))
        ) : (
          <Text style={styles.empty}>Your growth story is just beginning.</Text>
        )}

        {/* Leaps you made — the kid's OWN cross-domain connections */}
        {leaps.length > 0 && (
          <>
            <Text style={styles.sectionLabel}>LEAPS YOU MADE</Text>
            {visibleLeaps.map((leap) => {
              const pair = leapPair(leap);
              return (
                <View key={leap._id} style={styles.leapCard}>
                  {pair && (
                    <Text style={styles.leapPair}>
                      You connected {pair[0]} ↔ {pair[1]}
                    </Text>
                  )}
                  <Text style={styles.leapDescription}>{leap.description}</Text>
                </View>
              );
            })}
            {!leapsExpanded && leaps.length > MAX_LEAPS_SHOWN && (
              <Pressable onPress={() => setLeapsExpanded(true)} hitSlop={8}>
                <Text style={styles.leapMore}>
                  + {leaps.length - MAX_LEAPS_SHOWN} more
                </Text>
              </Pressable>
            )}
          </>
        )}

        <View style={{ height: 40 }} />
      </ScrollView>
    </>
  );
}

type Leap = NonNullable<
  ReturnType<typeof useQuery<typeof api.crossDomainConnections.listByScholar>>
>[number];

/** The two things a leap joined, for "You connected A ↔ B" — prefers the
 * concept labels (more specific than the domain names) and falls back to
 * domains if there aren't at least two concept labels. Extra labels beyond
 * the first two fold into the second slot. */
function leapPair(leap: Leap): [string, string] | null {
  const source = leap.conceptLabels.length >= 2 ? leap.conceptLabels : leap.domains;
  if (source.length < 2) return null;
  return [source[0], source.slice(1).join(" & ")];
}

function makeStyles(c: ReturnType<typeof useColors>) {
  return StyleSheet.create({
  center: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: c.bgSubtle,
  },
  scroll: { flex: 1, backgroundColor: c.bgSubtle },
  container: {
    width: "100%",
    maxWidth: MAXW,
    alignSelf: "center",
    paddingHorizontal: 24,
    paddingVertical: 18,
    gap: 12,
  },
  sectionLabel: {
    color: c.charcoalSubtle,
    fontSize: 12.5,
    letterSpacing: 1.2,
    fontFamily: fonts.bold,
    marginTop: 18,
    marginBottom: 2,
    marginLeft: 4,
  },
  empty: {
    color: c.fgMuted,
    fontSize: 16,
    fontFamily: fonts.regular,
    paddingVertical: 8,
    marginLeft: 4,
  },
  // Star map card — always dark navy
  skyCard: {
    backgroundColor: palette.navy[900],
    borderRadius: 22,
    minHeight: 120,
    overflow: "hidden",
    justifyContent: "flex-end",
  },
  skyDot: {
    position: "absolute",
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: c.white,
    opacity: 0.8,
  },
  skyBody: { padding: 22, gap: 4 },
  skyEyebrow: {
    color: palette.violet[200],
    fontSize: 12.5,
    letterSpacing: 1.2,
    fontFamily: fonts.bold,
  },
  skyTitle: { color: c.white, fontSize: 22, fontFamily: fonts.bold },
  skyMasterySubtitle: {
    color: palette.violet[200],
    fontSize: 13,
    fontFamily: fonts.semibold,
    marginTop: 2,
  },
  skyCta: {
    color: palette.violet[200],
    fontSize: 15,
    fontFamily: fonts.semibold,
    marginTop: 4,
  },
  // Badges
  badgeGrid: { flexDirection: "row", flexWrap: "wrap", gap: 16, marginTop: 6 },
  badge: { width: 132, alignItems: "center", gap: 8 },
  badgeImg: {
    width: 120,
    height: 120,
    borderRadius: 20,
    backgroundColor: c.bg,
    borderWidth: 1,
    borderColor: c.border,
  },
  badgeEmojiWrap: { alignItems: "center", justifyContent: "center" },
  badgeEmoji: { fontSize: 56 },
  badgeTitle: {
    fontSize: 14,
    fontFamily: fonts.semibold,
    color: c.navy,
    textAlign: "center",
  },
  // Growth
  growthCard: {
    backgroundColor: c.bg,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: c.border,
    padding: 18,
    gap: 6,
  },
  growthDomain: { fontSize: 12, letterSpacing: 0.8, fontFamily: fonts.bold },
  growthConcept: { fontSize: 18, fontFamily: fonts.semibold, color: c.navy },
  growthExcerpt: {
    fontSize: 15,
    lineHeight: 22,
    fontFamily: fonts.regular,
    color: c.charcoalMuted,
    fontStyle: "italic",
  },
  // Getting to know what you know — the calibration mirror
  calibrationCard: {
    backgroundColor: c.bg,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: c.border,
    padding: 18,
    gap: 10,
  },
  calibrationHeadline: {
    fontSize: 17,
    fontFamily: fonts.semibold,
    color: c.navy,
    marginBottom: 2,
  },
  calibrationRow: { flexDirection: "row", alignItems: "center", gap: 10 },
  calibrationLabel: {
    width: 78,
    fontSize: 13,
    fontFamily: fonts.semibold,
    color: c.charcoalMuted,
  },
  calibrationMeterTrack: {
    flex: 1,
    height: 7,
    borderRadius: 4,
    backgroundColor: c.gray200,
    overflow: "hidden",
  },
  calibrationMeterFill: {
    height: "100%",
    borderRadius: 4,
    backgroundColor: c.violet,
  },
  calibrationFraction: {
    width: 42,
    fontSize: 13,
    fontFamily: fonts.regular,
    color: c.charcoalSubtle,
    textAlign: "right",
    fontVariant: ["tabular-nums"],
  },
  calibrationGrowthLine: {
    fontSize: 14,
    fontFamily: fonts.regular,
    color: c.charcoalMuted,
    fontStyle: "italic",
    marginTop: 4,
  },
  // Leaps you made — the kid's OWN cross-domain connections
  leapCard: {
    backgroundColor: c.bg,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: c.border,
    padding: 18,
    gap: 6,
    marginBottom: 12,
  },
  leapPair: { fontSize: 16, fontFamily: fonts.semibold, color: c.navy },
  leapDescription: {
    fontSize: 14,
    lineHeight: 20,
    fontFamily: fonts.regular,
    color: c.charcoalMuted,
  },
  leapMore: {
    fontSize: 14,
    fontFamily: fonts.semibold,
    color: c.violet,
    marginLeft: 4,
    marginTop: -6,
    marginBottom: 8,
  },
  // Profile header row
  profileRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    backgroundColor: c.bg,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: c.border,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  profileLeft: { flexDirection: "row", alignItems: "center", gap: 12, flex: 1, minWidth: 0 },
  avatar: { width: 44, height: 44, borderRadius: 22 },
  avatarFallback: {
    backgroundColor: palette.violet[500],
    alignItems: "center",
    justifyContent: "center",
  },
  avatarInitials: { color: c.white, fontFamily: fonts.bold, fontSize: 17 },
  profileName: { fontSize: 16, fontFamily: fonts.semibold, color: c.navy },
  profileUsername: { fontSize: 13, fontFamily: fonts.regular, color: c.charcoalSubtle, marginTop: 1 },
  });
}
