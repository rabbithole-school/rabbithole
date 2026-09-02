/**
 * "Suggested by your teacher" — the native scholar-home section that surfaces
 * the teacher's STRUCTURED pushes (a built unit offered at this scholar), under
 * the quests in progress. Native parity with the web components/SuggestedQuests
 * — an "offered" quest belongs on Home on BOTH frontends, not just as a Sky
 * star. Reads api.seeds.suggestedQuestsForSelf (server already filters out
 * started/finished/inactive); "Start" reuses the same seed-launch path as a
 * star (createFromSeed → open the session).
 *
 * The card is a UnitBand-family card: the quiet unit-path band along the top
 * (quest identity — emoji · title · "with {teacher}" · "Guided path · N
 * activities"), the same treatment a unit in progress uses, over an invitation
 * body + Start CTA. The band is inert identity chrome here (no progress yet);
 * the whole card starts the quest. It uses the cyan Quests-lane family so a
 * suggested quest reads as part of the same lane it sits in.
 */

import { useMemo, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { useRouter } from "expo-router";
import { ActivityIndicator, StyleSheet, Text, View, useColorScheme } from "react-native";
import * as Haptics from "expo-haptics";

import { api, type Id } from "@/lib/convex";
import { UnitBand } from "@/components/UnitBand";
import { InvitationCard } from "@/components/InvitationCard";
import { forceList } from "@/lib/homeDevForce";
import { HOME_GAP, HOME_LABEL_GAP, HOME_SECTION_GAP } from "@/lib/homeRhythm";
import { fonts, palette, useColors } from "@/theme";
import { TakeHomePinButton } from "@/components/TakeHomePinButton";
import type { TakeHomePin, TakeHomePinning } from "@/components/TakeHomePlan";

type SuggestedQuest =
  FunctionReturnType<typeof api.seeds.suggestedQuestsForSelf>[number];

// Spacing-harness content only (FORCE_ALL_HOME_CARDS); never reaches prod.
const DEMO_QUESTS = [
  {
    seedId: "demo-quest",
    unitId: "demo-unit",
    title: "Why do zebras have stripes?",
    emoji: "🦓",
    activityCount: 4,
    rationale: "",
    description:
      "Alan Turing worked out the math behind animal patterns. Follow it from a coat to an equation.",
    teacherName: "Ms. Rivera",
    teacherImage: null,
  },
];

export function SuggestedQuests({
  pinning,
  onStartSeedInPlan,
  onTogglePin,
  onRemovePin,
  pendingPinKeys,
}: {
  pinning?: TakeHomePinning;
  onStartSeedInPlan?: (seedId: Id<"seeds">) => void | Promise<unknown>;
  onTogglePin?: (unitId: TakeHomePin["unitId"]) => void | Promise<unknown>;
  onRemovePin?: (itemId: Id<"takeHomePlanItems">) => void | Promise<unknown>;
  pendingPinKeys?: ReadonlySet<string>;
}) {
  const quests = forceList(
    useQuery(api.seeds.suggestedQuestsForSelf, {}),
    DEMO_QUESTS,
  );
  const colors = useColors();
  const scheme = useColorScheme();
  const amber = scheme === "dark" ? palette.yellow[400] : palette.yellow[800];
  const styles = useMemo(() => makeSectionStyles(amber), [amber]);

  if (quests === undefined) return null; // stay quiet until loaded
  if (quests.length === 0) return null;

  return (
    <View style={styles.section}>
      <View style={styles.eyebrowRow}>
        <Text style={styles.eyebrowGlyph}>✦</Text>
        <Text style={styles.eyebrow}>SUGGESTED BY YOUR TEACHER</Text>
      </View>
      <View style={styles.cards}>
        {quests.map((q) => (
        <SuggestedQuestCard key={String(q.seedId)} quest={q} colors={colors} pinning={pinning} onStartSeedInPlan={onStartSeedInPlan} onTogglePin={onTogglePin} onRemovePin={onRemovePin} pendingPinKeys={pendingPinKeys} />
        ))}
      </View>
    </View>
  );
}

function SuggestedQuestCard({
  quest: q,
  colors,
  pinning,
  onStartSeedInPlan,
  onTogglePin,
  onRemovePin,
  pendingPinKeys,
}: {
  quest: SuggestedQuest;
  colors: ReturnType<typeof useColors>;
  pinning?: TakeHomePinning;
  onStartSeedInPlan?: (seedId: Id<"seeds">) => void | Promise<unknown>;
  onTogglePin?: (unitId: TakeHomePin["unitId"]) => void | Promise<unknown>;
  onRemovePin?: (itemId: Id<"takeHomePlanItems">) => void | Promise<unknown>;
  pendingPinKeys?: ReadonlySet<string>;
}) {
  const router = useRouter();
  const createFromSeed = useMutation(api.sessions.createFromSeed);
  const [starting, setStarting] = useState(false);
  const styles = useMemo(() => makeCardStyles(colors), [colors]);

  const body = q.description || q.rationale;
  const pathMeta =
    q.activityCount > 0
      ? `Guided path · ${q.activityCount} ${q.activityCount === 1 ? "activity" : "activities"}`
      : "Guided path";
  const existingPin = q.unitId
    ? pinning?.pins.find((pin) => String(pin.unitId) === String(q.unitId))
    : undefined;
  const pendingKey = existingPin
    ? `item:${existingPin.itemId}`
    : `seed:${q.seedId}`;

  const start = async () => {
    if (starting) return;
    setStarting(true);
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(
      () => {},
    );
    try {
      const res = await createFromSeed({ seedId: q.seedId });
      router.push({
        pathname: "/session/[id]",
        params: { id: res.id, title: q.title },
      });
    } catch (e) {
      console.warn("[suggested-quest] start failed", e);
      setStarting(false);
    }
  };

  return (
    <InvitationCard
      band={
        <UnitBand
          emoji={q.emoji}
          title={q.title}
          teacherName={q.teacherName}
          subtle={colors.cyanSubtle}
          muted={colors.cyanMuted}
          meta={pathMeta}
          raisedAction={pinning?.dayKey && onTogglePin && q.unitId ? <TakeHomePinButton selected={!!existingPin} subject={q.title} busy={pendingPinKeys?.has(pendingKey)} onToggle={() => {
            if (existingPin && onRemovePin) return onRemovePin(existingPin.itemId);
            if (onStartSeedInPlan && q.seedId) return onStartSeedInPlan(q.seedId);
            return onTogglePin(q.unitId);
          }} /> : null}
        />
      }
      body={body}
      onPress={start}
      loading={starting}
      accessibilityLabel={`Start suggested quest ${q.title}`}
      primaryAction={
        starting ? (
          <ActivityIndicator color={colors.cyan} />
        ) : (
          <Text style={styles.cta}>Start ›</Text>
        )
      }
    />
  );
}

function makeSectionStyles(amber: string) {
  return StyleSheet.create({
    section: {
      // This section can self-gate away entirely, and so can both of its
      // siblings in the Home's quest footer — so it owns its LEADING gap
      // rather than letting a wrapper hang a gap that would survive it.
      paddingTop: HOME_SECTION_GAP,
      gap: HOME_LABEL_GAP,
    },
    cards: {
      gap: HOME_GAP,
    },
    eyebrowRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
      marginLeft: 4,
    },
    eyebrowGlyph: {
      fontSize: 12,
      color: amber,
    },
    eyebrow: {
      fontSize: 11.5,
      letterSpacing: 1.1,
      fontFamily: fonts.bold,
      color: amber,
    },
  });
}

function makeCardStyles(c: ReturnType<typeof useColors>) {
  return StyleSheet.create({
    cta: { fontSize: 16, fontFamily: fonts.bold, color: c.cyan },
  });
}
