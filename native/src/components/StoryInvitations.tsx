/**
 * StoryInvitations (native) — the scholar-home "New stories" section, the RN
 * twin of components/StoryInvitations.tsx. The durable home for the
 * world-connection story threads a scholar has unlocked but not yet followed.
 * Replaces UnlockedStories, re-skinned onto the InvitationCard family so a story
 * reads as a sibling of a suggested quest.
 *
 * MYSTERY SIDE OUT: the card shows the visual cue + hook + the teaser as a CLUE,
 * cited back to the skill that unlocked it ("Unlocked by <skill>"). "Follow the
 * thread" starts the SAME durable session a suggested quest / sky star starts
 * (`sessions.createFromSeed`), recording the story `opened`; "Let this one go"
 * records `dismissed` (terminal — the souvenir star stays in the Sky, the card
 * retires). Server: `seeds.standingStoryInvitationsForSelf` (capped at two,
 * newest first, already filtered to stories not yet followed).
 */

import { useMemo, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { Pressable, StyleSheet, Text, View, useColorScheme } from "react-native";
import { useRouter } from "expo-router";
import * as Haptics from "expo-haptics";

import { api } from "@/lib/convex";
import { InvitationCard, InvitationBand } from "@/components/InvitationCard";
import { forceList } from "@/lib/homeDevForce";
import { HOME_GAP, HOME_SECTION_GAP } from "@/lib/homeRhythm";
import { fonts, palette, useColors } from "@/theme";

type StoryInvitation =
  FunctionReturnType<typeof api.seeds.standingStoryInvitationsForSelf>[number];

// Spacing-harness content only (FORCE_ALL_HOME_CARDS); never reaches prod.
const DEMO_STORIES = [
  {
    seedId: "demo-story",
    eventId: "demo-event",
    fromKey: "demo-from",
    toKey: "demo-to",
    skillLabel: "dividing decimals",
    hook: "The GPS in your pocket is running Einstein's correction",
    teaser:
      "Satellite clocks tick faster than yours. Without adjusting for it, every map would drift kilometers off by lunchtime.",
    visualEmoji: "🛰️",
    kindLabel: "Story",
    hasApplication: true,
    offeredAt: 0,
  },
] as unknown as StoryInvitation[];

export function StoryInvitations() {
  const router = useRouter();
  const stories = forceList(
    useQuery(api.seeds.standingStoryInvitationsForSelf, {}),
    DEMO_STORIES,
  );
  const recordOutcome = useMutation(api.practiceMoments.recordMomentOutcome);
  const createFromSeed = useMutation(api.sessions.createFromSeed);
  const colors = useColors();
  const scheme = useColorScheme();
  const violet = scheme === "dark" ? palette.violet[300] : palette.violet[600];
  const sectionStyles = useMemo(() => makeSectionStyles(violet), [violet]);
  const cardStyles = useMemo(() => makeCardStyles(colors), [colors]);
  const [followingSeedId, setFollowingSeedId] = useState<string | null>(null);

  if (stories === undefined) return null; // stay quiet until loaded
  if (stories.length === 0) return null;

  const follow = async (s: StoryInvitation) => {
    if (followingSeedId) return;
    setFollowingSeedId(String(s.seedId));
    Haptics.selectionAsync().catch(() => {});
    // Record "opened" first: the scholar acted on the moment (vs. letting it
    // go). Best-effort — never blocks the session.
    void recordOutcome({ eventId: s.eventId, outcome: "opened" }).catch(() => {});
    try {
      const res = await createFromSeed({ seedId: s.seedId });
      if (res) {
        router.push({ pathname: "/session/[id]", params: { id: res.id, title: s.hook } });
      } else {
        setFollowingSeedId(null);
      }
    } catch {
      setFollowingSeedId(null);
    }
  };

  const letGo = (s: StoryInvitation) => {
    // Never race an in-flight follow: "dismissed" is TERMINAL server-side, so
    // letting it fire while createFromSeed is pending would route the scholar
    // into a session whose ledger reads dismissed.
    if (followingSeedId) return;
    Haptics.selectionAsync().catch(() => {});
    // Terminal — the reactive query drops the card once the outcome lands. The
    // souvenir star stays in the Sky; only this standing invitation retires.
    void recordOutcome({ eventId: s.eventId, outcome: "dismissed" }).catch(() => {});
  };

  return (
    <View style={sectionStyles.section}>
      <View style={sectionStyles.eyebrowRow}>
        <Text style={sectionStyles.eyebrowGlyph}>✨</Text>
        <Text style={sectionStyles.eyebrow}>NEW STORIES</Text>
      </View>
      <View style={sectionStyles.cards}>
        {stories.map((s) => (
          <InvitationCard
            key={String(s.seedId)}
            band={
              <InvitationBand
                emoji={s.visualEmoji ?? "✨"}
                imageUrl={s.artUrl}
                title={s.hook}
                titleLines={2}
              />
            }
            body={s.teaser}
            meta={
              <Text style={cardStyles.meta} numberOfLines={1}>
                Unlocked by {s.skillLabel}
              </Text>
            }
            accessibilityLabel={`Follow the thread: ${s.hook}`}
            onPress={() => follow(s)}
            loading={followingSeedId === String(s.seedId)}
            primaryAction={<Text style={cardStyles.cta}>Follow the thread ›</Text>}
            secondaryAction={
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Let this one go: ${s.hook}`}
                hitSlop={8}
                onPress={() => letGo(s)}
                style={({ pressed }) => [
                  cardStyles.secondaryAction,
                  pressed && cardStyles.secondaryActionPressed,
                ]}
              >
                <Text style={cardStyles.secondaryActionText}>Let this one go</Text>
              </Pressable>
            }
          />
        ))}
      </View>
    </View>
  );
}

function makeSectionStyles(violet: string) {
  return StyleSheet.create({
    section: {
      // Self-gates away entirely, as do both of its siblings in the Home's
      // quest footer — so it owns its LEADING gap rather than letting a
      // wrapper hang a gap that would outlive it.
      paddingTop: HOME_SECTION_GAP,
      gap: 8,
    },
    cards: { gap: HOME_GAP },
    eyebrowRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
      marginLeft: 4,
    },
    eyebrowGlyph: { fontSize: 14, color: violet },
    eyebrow: {
      fontSize: 12,
      lineHeight: 19.2,
      letterSpacing: 0.6,
      fontFamily: fonts.bold,
      color: violet,
    },
  });
}

function makeCardStyles(c: ReturnType<typeof useColors>) {
  return StyleSheet.create({
    meta: {
      fontSize: 12,
      lineHeight: 19.2,
      fontFamily: fonts.regular,
      color: c.charcoalSubtle,
    },
    cta: {
      fontSize: 14,
      lineHeight: 19,
      fontFamily: fonts.semibold,
      color: c.violetSolid,
    },
    secondaryAction: {
      paddingVertical: 2,
      paddingHorizontal: 6,
      borderRadius: 6,
    },
    secondaryActionPressed: { backgroundColor: c.gray50 },
    secondaryActionText: {
      fontSize: 12,
      lineHeight: 18,
      fontFamily: fonts.semibold,
      color: c.charcoalMuted,
    },
  });
}
