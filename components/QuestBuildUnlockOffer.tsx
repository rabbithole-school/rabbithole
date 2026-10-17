"use client";

/**
 * The B6 badge moment (TRA-519, learn before you build): a scholar who just
 * finished their own Quest WITHOUT a build step is offered "Unlock: build a
 * simulation of this". Tapping appends one build step to the same Quest
 * (quests.appendBuildStep, idempotent) and opens it the way the Quest page
 * starts an activity (sessions.create). Shown only on the completion surface,
 * and only while `units.get(...).canUnlockBuild` (Quest complete, no app step
 * yet, viewer is the author). Native twin: in native/src/app/session/[id].tsx.
 */
import { Box, Button } from "@chakra-ui/react";
import { useMutation, useQuery } from "convex/react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { useRemote } from "@/hooks/useRemote";
import { appendBuildStepRef, canUnlockBuildOf } from "@/lib/missionApi";
import { serverErrorMessage } from "@/lib/serverErrorMessage";
import { toaster } from "@/lib/toaster";
import { MISSION_COPY } from "@/shared/missionCopy";

export function QuestBuildUnlockOffer({ unitId }: { unitId: Id<"units"> }) {
  const router = useRouter();
  const { stamp } = useRemote();
  const unit = useQuery(api.units.get, { id: unitId });
  const appendBuildStep = useMutation(appendBuildStepRef);
  const createSession = useMutation(api.sessions.create);
  const [starting, setStarting] = useState(false);

  if (!canUnlockBuildOf(unit)) return null;

  const unlock = async () => {
    setStarting(true);
    try {
      const { activityId } = await appendBuildStep({ unitId });
      const session = await createSession({ activityId });
      if (session) router.push(stamp(`/scholar/${session.id}`));
      else setStarting(false);
    } catch (error) {
      toaster.error({ title: serverErrorMessage(error, "Couldn't unlock the build") });
      setStarting(false);
    }
  };

  return (
    <Box alignSelf="center" mb={4}>
      <Button
        colorPalette="violet"
        fontFamily="heading"
        fontWeight="600"
        loading={starting}
        onClick={() => void unlock()}
      >
        {MISSION_COPY.unlockBuild}
      </Button>
    </Box>
  );
}
