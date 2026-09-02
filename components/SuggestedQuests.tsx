"use client";

/**
 * "Suggested by your teacher" — the scholar-home section that surfaces the
 * teacher's STRUCTURED pushes (a built unit suggested at this scholar), above
 * the peer trails. Stronger than a star you might wander to on the map, softer
 * than an assigned task — a personal recommendation. See review/pr-258
 * SUGGESTED-QUEST. Reads api.seeds.suggestedQuestsForSelf; "Start the quest"
 * reuses the same seed-launch path as a star (createFromSeed via onStart).
 *
 * The card is a UnitGroupCard-family card: a quiet unit-path band along the top
 * (quest identity — emoji · title · teacher · "Guided path · N activities"),
 * the same treatment a multi-activity unit in progress uses (UnitGroupBand),
 * over an invitation body + Start CTA. The band is inert identity chrome here
 * (no progress yet); the whole card starts the quest.
 */

import { useQuery } from "convex/react";
import { Stack, HStack, Text } from "@chakra-ui/react";
import { ShootingStar } from "@phosphor-icons/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { UnitGroupBand } from "@/components/ui/UnitGroupCard";
import { ActivityCardCta } from "@/components/ui/ActivityCard";
import { InvitationCard } from "@/components/ui/InvitationCard";

export function SuggestedQuests({
  onStart,
  startingSeedId,
  pinAction,
}: {
  onStart: (seedId: Id<"seeds">) => void;
  startingSeedId: string | null;
  pinAction?: (quest: { seedId: Id<"seeds">; unitId: Id<"units">; title: string }) => React.ReactNode;
}) {
  const quests = useQuery(api.seeds.suggestedQuestsForSelf, {});

  if (quests === undefined) return null; // stay quiet until loaded
  if (quests.length === 0) return null;

  return (
    <Stack gap={2} pt={2}>
      <HStack gap={1.5} color="yellow.700">
        <ShootingStar size={14} weight="fill" />
        <Text
          fontFamily="heading"
          fontWeight="700"
          fontSize="xs"
          textTransform="uppercase"
          letterSpacing="0.05em"
        >
          Suggested by your teacher
        </Text>
      </HStack>

      <Stack gap={2}>
        {quests.map((q) => (
          <SuggestedQuestCard
            key={String(q.seedId)}
            emoji={q.emoji}
            title={q.title}
            teacherName={q.teacherName}
            teacherImage={q.teacherImage}
            activityCount={q.activityCount}
            body={q.description || q.rationale}
            ariaLabel={`Start ${q.title}`}
            onPress={() => onStart(q.seedId)}
            bandAction={pinAction?.(q)}
            primaryAction={
              <ActivityCardCta loading={startingSeedId === String(q.seedId)}>
                Start
              </ActivityCardCta>
            }
          />
        ))}
      </Stack>
    </Stack>
  );
}

/**
 * The presentational "Suggested by your teacher" card — a member of the
 * InvitationCard family: a quiet unit-path band (emoji · title · teacher chip ·
 * "Guided path · N activities") over an invitation body, with a `primaryAction`
 * affordance and an optional whole-card `onPress`, or a raised `secondaryAction`
 * slot. Extracted so the teacher-side Home mirror (components/ScholarHomeMirrorCard)
 * can render the SAME card the scholar sees — the scholar surface passes a Start
 * CTA + a whole-card start; the mirror passes a per-card actions menu (Retract).
 */
export function SuggestedQuestCard({
  emoji,
  title,
  teacherName,
  teacherImage,
  activityCount,
  body,
  primaryAction,
  secondaryAction,
  onPress,
  ariaLabel,
  bandAction,
}: {
  emoji: string;
  title: string;
  teacherName: string;
  teacherImage?: string | null;
  activityCount: number;
  body: string | null;
  /** The scholar's non-interactive Start CTA (sits under the full-card press). */
  primaryAction?: React.ReactNode;
  /** The mirror's raised actions menu (its own tap target, no whole-card press). */
  secondaryAction?: React.ReactNode;
  /** The scholar's whole-card start. */
  onPress?: () => void;
  ariaLabel?: string;
  bandAction?: React.ReactNode;
}) {
  const pathMeta =
    activityCount > 0
      ? `Guided path · ${activityCount} ${activityCount === 1 ? "activity" : "activities"}`
      : "Guided path";
  return (
    <InvitationCard
      band={
        <UnitGroupBand
          emoji={emoji}
          title={title}
          completedCount={null}
          activityCount={null}
          teacherName={teacherName}
          teacherImage={teacherImage ?? undefined}
          meta={pathMeta}
          action={bandAction}
        />
      }
      body={body}
      primaryAction={primaryAction}
      secondaryAction={secondaryAction}
      onPress={onPress}
      ariaLabel={ariaLabel}
    />
  );
}
