"use client";

/**
 * "Saved for later" on the done screen (TRA-519 B2): the session's parked
 * ideas come back once the activity is finished, each with two ways forward —
 *   • Build it now  → sessions.startFreePlay({ sessionId, idea }), which says
 *     which session to build in: this one (the caller's `onBuildHere` opens
 *     Edit with the idea ready to send), or an older free-play copy, which
 *     opens instead;
 *   • Make it a Quest → sessions.questFromParkedIdea plants (or reuses) a seed,
 *     then the existing seed flow (useExploreSeed: path picker → bake) runs.
 * The per-idea actions are one hook (`useSavedForLaterActions`), shared by the
 * chat done screen (SavedForLaterBlock below) and the builder's done state
 * (the Workshop strip, components/vibecode/ParkingLot.tsx), so both offer the
 * same two buttons. The caller decides WHEN they show (lot non-empty, viewer
 * owns the session, not a test drive, activity done). Native twin:
 * native/src/components/MissionDoneBlocks.tsx.
 */
import { Box, Button, Text } from "@chakra-ui/react";
import { useMutation } from "convex/react";
import { useRouter } from "next/navigation";
import { useState, type ReactNode } from "react";
import type { Id } from "@/convex/_generated/dataModel";
import { useExploreSeed } from "@/hooks/useExploreSeed";
import { useRemote } from "@/hooks/useRemote";
import { questFromParkedIdeaRef, startFreePlayRef } from "@/lib/missionApi";
import { serverErrorMessage } from "@/lib/serverErrorMessage";
import { toaster } from "@/lib/toaster";
import { MISSION_COPY } from "@/shared/missionCopy";
import { ParkedIdeaList, type ParkedIdea } from "./ParkedIdeaList";

/**
 * Build it now + Make it a Quest for each parked idea. `renderActions` goes to
 * ParkedIdeaList.
 */
export function useSavedForLaterActions({
  sessionId,
  canBuildNow,
  onBuildHere,
}: {
  sessionId: Id<"sessions">;
  /** `freePlayEligible` from getWithMessages — whether Build it now works. */
  canBuildNow: boolean;
  /** The builder's done state: carry on in this session with `idea`. Absent
   *  (the chat done screen), the session is opened instead. */
  onBuildHere?: (idea: ParkedIdea) => void;
}): { renderActions: (idea: ParkedIdea) => ReactNode } {
  const router = useRouter();
  const { stamp } = useRemote();
  const startFreePlay = useMutation(startFreePlayRef);
  const questFromParkedIdea = useMutation(questFromParkedIdeaRef);
  const { exploreSeed, exploringSeedId } = useExploreSeed();
  // The idea whose button is working, so only that row shows a spinner.
  const [busy, setBusy] = useState<{ text: string; action: "build" | "quest" } | null>(null);

  const buildNow = async (idea: ParkedIdea) => {
    setBusy({ text: idea.text, action: "build" });
    let next: Id<"sessions"> | null = null;
    try {
      next = (await startFreePlay({ sessionId, idea: idea.text })).sessionId;
    } catch (error) {
      toaster.error({ title: serverErrorMessage(error, "Couldn't start building that") });
    }
    setBusy(null);
    if (next === null) return;
    if (next === sessionId && onBuildHere) {
      // One app, one session: carry on here.
      onBuildHere(idea);
      return;
    }
    // A scholar with an older free-play copy is taken there (and the chat
    // done screen, which has no Edit of its own, opens the session).
    router.push(stamp(`/scholar/${next}`));
  };

  const makeQuest = async (idea: ParkedIdea) => {
    setBusy({ text: idea.text, action: "quest" });
    try {
      // Always ask the server: it is idempotent per idea and replaces a seed
      // that is no longer live, which a cached questSeedId cannot know.
      const { seedId } = await questFromParkedIdea({
        sessionId,
        text: idea.text,
      });
      await exploreSeed(seedId);
    } catch (error) {
      toaster.error({ title: serverErrorMessage(error, "Couldn't make that a Quest") });
    } finally {
      setBusy(null);
    }
  };

  const renderActions = (idea: ParkedIdea) => (
    <>
      {canBuildNow ? (
        <Button
          size="xs"
          colorPalette="violet"
          fontFamily="heading"
          disabled={busy !== null}
          loading={busy?.text === idea.text && busy.action === "build"}
          onClick={() => void buildNow(idea)}
        >
          {MISSION_COPY.buildItNow}
        </Button>
      ) : null}
      <Button
        size="xs"
        variant="outline"
        colorPalette="violet"
        fontFamily="heading"
        disabled={busy !== null || exploringSeedId !== null}
        loading={busy?.text === idea.text && busy.action === "quest"}
        onClick={() => void makeQuest(idea)}
      >
        {MISSION_COPY.makeItAQuest}
      </Button>
    </>
  );

  return { renderActions };
}

export function SavedForLaterBlock({
  sessionId,
  ideas,
  canBuildNow,
}: {
  sessionId: Id<"sessions">;
  ideas: readonly ParkedIdea[];
  /** `freePlayEligible` from getWithMessages — whether Build it now works. */
  canBuildNow: boolean;
}) {
  const { renderActions } = useSavedForLaterActions({
    sessionId,
    canBuildNow,
  });
  if (ideas.length === 0) return null;
  return (
    <Box
      as="section"
      aria-label={MISSION_COPY.savedForLater}
      alignSelf="center"
      maxW="md"
      w="full"
      mb={4}
      p={4}
      bg="gray.50"
      borderWidth="1px"
      borderColor="gray.200"
      borderRadius="xl"
    >
      <Text fontSize="sm" fontFamily="heading" fontWeight="700" color="navy.500" mb={2}>
        {MISSION_COPY.savedForLater}
      </Text>
      <ParkedIdeaList ideas={ideas} renderActions={renderActions} />
    </Box>
  );
}
