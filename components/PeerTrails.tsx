"use client";

/**
 * PeerTrails — scholar-facing social proof. Surfaces completion-badge quests
 * from the scholar's named group that the scholar hasn't done yet
 * (api.trophyCase.trailsForScholar — derived, group-scoped), each with its
 * earner roster. "Make your version" plants the trail as a star on the
 * scholar's own map (api.seeds.followBadgeSelf) — a fork, their own path.
 *
 * Tone: celebrate spread, never rank — names + "lit this trail", no counts
 * framed as a leaderboard, no percentages. Lives inside the Quests section,
 * right above the star map; self-view only.
 */

import { useState } from "react";
import {
  HStack,
  Stack,
  Text,
} from "@chakra-ui/react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import {
  ActivityCard,
  ActivityCardCta,
  ActivityCardMeta,
  ActivityCardTitle,
} from "@/components/ui/ActivityCard";
import { ScholarFacepile } from "@/components/ScholarFacepile";
import { ScholarHomeSectionHeader } from "@/components/ui/ScholarHomeSectionHeader";
import { toaster } from "@/lib/toaster";

type Trail = NonNullable<
  ReturnType<typeof useQuery<typeof api.trophyCase.trailsForScholar>>
>["trails"][number];

function earnerLine(earners: Trail["earners"], count: number): string {
  const names = earners.map((e) => e.firstName);
  if (names.length === 0) return "your pod lit this trail";
  if (count > names.length) {
    return `${names.join(", ")} +${count - names.length} more lit this trail`;
  }
  if (names.length === 1) return `${names[0]} completed this`;
  if (names.length === 2) return `${names[0]} & ${names[1]} completed this`;
  return `${names.slice(0, -1).join(", ")} & ${names[names.length - 1]} completed this`;
}

export function PeerTrails() {
  const data = useQuery(api.trophyCase.trailsForScholar, {});
  const follow = useMutation(api.seeds.followBadgeSelf);
  const [busy, setBusy] = useState<string | null>(null);

  if (data === undefined) return null; // stay quiet until loaded
  const { trails, group } = data;
  if (trails.length === 0) return null;

  const onFollow = async (tr: Trail) => {
    setBusy(String(tr.unitId));
    try {
      const res = await follow({
        topic: tr.unitTitle,
        domain: tr.domain ?? undefined,
        inspiredByName: tr.earners[0]?.firstName ?? "a friend",
        unitId: tr.unitId,
      });
      toaster.success(
        res.alreadyFollowing
          ? { title: "You're already on this trail 🌠" }
          : {
              title: "Joined the quest 🌠",
              description: `“${tr.unitTitle}” is now a star on your map — fly there to start it.`,
            },
      );
    } catch {
      toaster.error({ title: "Couldn't join that quest" });
    } finally {
      setBusy(null);
    }
  };

  return (
    <Stack gap={2} pt={2}>
      <ScholarHomeSectionHeader
        icon={
          <Text as="span" fontSize="sm" lineHeight="1" aria-hidden>
            {group?.emoji ?? "👣"}
          </Text>
        }
      >
        More quests from {group?.name ?? "your group"}
      </ScholarHomeSectionHeader>

      <Stack gap={2}>
        {trails.map((tr) => (
          <ActivityCard
            key={String(tr.unitId)}
            density="detailed"
            glyph={tr.badgeIcon}
            ariaLabel={`Join ${tr.unitTitle}`}
            onClick={() => onFollow(tr)}
            cta={
              <ActivityCardCta loading={busy === String(tr.unitId)}>
                Join
              </ActivityCardCta>
            }
          >
            <ActivityCardTitle density="detailed">{tr.unitTitle}</ActivityCardTitle>
            <HStack gap={1.5} minW={0}>
              <ScholarFacepile
                scholars={tr.earners.map((e, i) => ({
                  _id: e.name ?? String(i),
                  name: e.name ?? e.firstName,
                  image: e.image ?? undefined,
                  username: undefined,
                }))}
                size="2xs"
                max={tr.earners.length}
              />
              <ActivityCardMeta
                overflow="hidden"
                textOverflow="ellipsis"
                whiteSpace="nowrap"
              >
                {earnerLine(tr.earners, tr.earnerCount)}
              </ActivityCardMeta>
            </HStack>
            {tr.unitDescription && (
              <Text fontSize="sm" color="charcoal.500" fontFamily="body" lineHeight="1.45">
                {tr.unitDescription}
              </Text>
            )}
          </ActivityCard>
        ))}
      </Stack>
    </Stack>
  );
}
