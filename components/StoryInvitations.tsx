"use client";

/**
 * StoryInvitations — the scholar-home "New stories" section: the durable home
 * for the world-connection story threads a scholar has unlocked but not yet
 * followed. It replaces UnlockedStories, re-skinned onto the InvitationCard
 * family so a story reads as a sibling of a suggested quest, not a different
 * vocabulary.
 *
 * WHY it exists: a story is revealed exactly once, on the practice done screen,
 * in the moment a kid is already halfway out the door. That reveal
 * (StoryMomentCard) is quiet and skippable — so every offered story is KEPT as a
 * standing invitation here (`seeds.standingStoryInvitationsForSelf`, lane B),
 * where a scholar actually passes through, until they follow it or let it go.
 *
 * MYSTERY SIDE OUT: the card shows the visual cue + hook + the teaser as a
 * CLUE, cited back to the skill that unlocked it ("Unlocked by <skill>") — that
 * attribution is the whole point: the story is evidence that getting fluent at
 * something opened a door onto the world.
 *
 * ONE thread, a durable session. "Follow the thread" starts the SAME session a
 * suggested quest / sky star starts (`sessions.createFromSeed`), recording the
 * story `opened`; "Let this one go" records `dismissed` (terminal — the star
 * stays in the Sky, the card retires). Native parity:
 * native/src/components/StoryInvitations.tsx.
 */

import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { useRouter } from "next/navigation";
import { Stack, HStack, Text, Button } from "@chakra-ui/react";
import { Sparkle } from "@phosphor-icons/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import {
  ActivityCardCta,
  ActivityCardMeta,
} from "@/components/ui/ActivityCard";
import { InvitationCard, InvitationBand } from "@/components/ui/InvitationCard";

export function StoryInvitations() {
  const stories = useQuery(api.seeds.standingStoryInvitationsForSelf, {});
  const recordOutcome = useMutation(api.practiceMoments.recordMomentOutcome);
  const createFromSeed = useMutation(api.sessions.createFromSeed);
  const router = useRouter();
  const [followingSeedId, setFollowingSeedId] = useState<string | null>(null);

  if (stories === undefined) return null; // stay quiet until loaded
  if (stories.length === 0) return null;

  const follow = async (
    seedId: Id<"seeds">,
    eventId: Id<"momentEvents">,
  ) => {
    if (followingSeedId) return;
    setFollowingSeedId(String(seedId));
    // Record "opened" first: the scholar acted on the moment (vs. letting it
    // go), so the funnel reflects it. Best-effort — never blocks the session.
    void recordOutcome({ eventId, outcome: "opened" }).catch(() => {});
    try {
      const res = await createFromSeed({ seedId });
      if (res) router.push(`/scholar/${res.id}`);
      else setFollowingSeedId(null);
    } catch {
      setFollowingSeedId(null);
    }
  };

  const letGo = (eventId: Id<"momentEvents">) => {
    // Never race an in-flight follow: "dismissed" is TERMINAL server-side, so
    // letting it fire while createFromSeed is pending would route the scholar
    // into a session whose ledger reads dismissed.
    if (followingSeedId) return;
    // Terminal — the reactive query drops the card once the outcome lands. The
    // souvenir star stays in the Sky; only this standing invitation retires.
    void recordOutcome({ eventId, outcome: "dismissed" }).catch(() => {});
  };

  return (
    <Stack gap={2} pt={2}>
      <HStack gap={1.5} color="violet.600">
        <Sparkle size={14} weight="fill" />
        <Text
          fontFamily="heading"
          fontWeight="700"
          fontSize="xs"
          textTransform="uppercase"
          letterSpacing="0.05em"
        >
          New stories
        </Text>
      </HStack>

      <Stack gap={2}>
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
            meta={<ActivityCardMeta>Unlocked by {s.skillLabel}</ActivityCardMeta>}
            ariaLabel={`Follow the thread: ${s.hook}`}
            onPress={() => follow(s.seedId, s.eventId)}
            primaryAction={
              <ActivityCardCta loading={followingSeedId === String(s.seedId)}>
                Follow the thread
              </ActivityCardCta>
            }
            secondaryAction={
              <Button
                size="xs"
                variant="plain"
                color="charcoal.400"
                fontFamily="heading"
                fontWeight="600"
                fontSize="xs"
                px={2}
                onClick={() => letGo(s.eventId)}
              >
                Let this one go
              </Button>
            }
          />
        ))}
      </Stack>
    </Stack>
  );
}
