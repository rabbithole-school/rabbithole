"use client";

/**
 * A session's deliverable, resolved once for every surface that shows it:
 * the chat's document panel (`SessionInterface` → `ArtifactPanel`) and the
 * full-screen app builder (`VibecodeWorkshop` → its footer and the Your work
 * drawer). Both read the same activity + per-session rubric snapshot, build
 * the same `deliverableContext`, and submit through the same path, so the two
 * views of one session can never disagree about what the work is or how it is
 * checked (TRA-519, T12).
 *
 * The hook owns the reads, the auto-rubric bootstrap, and the submit's
 * preparation (flush → submit → open the rubric-check turn). Streaming that
 * turn stays with the caller, which owns its stream and send lock.
 */

import { useCallback, useEffect, useMemo } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import type { ArtifactPanel } from "@/components/ArtifactPanel";
import { flushAllArtifactSaves } from "@/components/artifactSaveRegistry";
import { shouldProvideDeliverableContext } from "@/lib/deliverablePanelContext";
import { toaster } from "@/lib/toaster";

export type SessionDeliverableContext = NonNullable<
  Parameters<typeof ArtifactPanel>[0]["deliverableContext"]
>;

/** The rubric-check turn `startRubricCheck` opened, ready to stream. */
export type PreparedRubricCheck = {
  sessionId: Id<"sessions">;
  streamId: string;
  assistantMsgId: string;
};

export function useSessionDeliverable({
  sessionId,
  session,
}: {
  sessionId: Id<"sessions">;
  /** The session row once loaded (undefined while loading). */
  session: { _id: Id<"sessions">; activityId?: Id<"activities"> | null } | null | undefined;
}) {
  const activityId = session?.activityId ?? null;
  const activity = useQuery(
    api.activities.getPublic,
    activityId ? { id: activityId } : "skip",
  );
  const snapshot = useQuery(api.sessions.getDeliverableSnapshot, {
    sessionId,
  });
  const ensureActivitySetup = useMutation(api.sessions.ensureActivitySetup);
  const submitDeliverable = useMutation(api.deliverables.submit);
  const startRubricCheck = useMutation(api.sessions.startRubricCheck);

  // An auto-rubric deliverable generates its per-scholar criteria on first
  // open; whichever view opens the session first starts it.
  const deliverableMode = activity?.deliverable?.mode;
  useEffect(() => {
    if (
      deliverableMode === "auto" &&
      snapshot !== undefined &&
      snapshot?.status === null
    ) {
      void ensureActivitySetup({ sessionId }).catch((error) => {
        console.error("Error initializing activity deliverable:", error);
      });
    }
  }, [deliverableMode, snapshot, ensureActivitySetup, sessionId]);

  const deliverableContext = useMemo<SessionDeliverableContext | undefined>(() => {
    if (
      !session ||
      !activity?.deliverable ||
      !shouldProvideDeliverableContext({
        hasSession: true,
        deliverable: activity.deliverable,
        snapshotLoaded: snapshot !== undefined,
        snapshotStatus: snapshot?.status,
        snapshotHasCriteria: !!snapshot?.criteria,
      })
    ) {
      return undefined;
    }
    const deliverable = activity.deliverable;
    return {
      sessionId: session._id,
      activityId: activity._id as Id<"activities">,
      activityTitle: activity.title,
      deliverableSpec: {
        kind: deliverable.kind,
        prompt: deliverable.prompt,
        mode: deliverable.mode,
        criteria:
          deliverable.mode === "auto" && snapshot?.criteria
            ? snapshot.criteria
            : deliverable.criteria,
        criteriaStatus: snapshot?.status,
        criteriaError: snapshot?.error,
      },
    };
  }, [activity, session, snapshot]);

  /**
   * Submit `artifactId` as the deliverable and, when `shouldCheck`, open the
   * rubric-check turn. Persists NO user message: the check's instruction is
   * injected server-side (convex/http.ts). Returns the turn to stream, or
   * null when there is nothing to stream (send-only, a save conflict, an
   * error — each already told the scholar).
   */
  const prepareSubmit = useCallback(
    async ({
      artifactId,
      shouldCheck,
      mode,
      appArtifactId,
    }: {
      artifactId: Id<"artifacts">;
      shouldCheck: boolean;
      /** The builder's Edit | Play mode, so the check lands in that mode's
       * thread. Omitted by the chat view and a side app (no threads). */
      mode?: "edit" | "play";
      /** The app open in the builder, so the check's turn reads that app. */
      appArtifactId?: Id<"artifacts">;
    }): Promise<PreparedRubricCheck | null> => {
      if (!activity) return null;
      try {
        await flushAllArtifactSaves();
      } catch (error) {
        console.error("Error saving work before check:", error);
        toaster.error({
          title: "Finish saving your work",
          description:
            "Choose a saved version or retry the save before checking your work.",
        });
        return null;
      }
      try {
        await submitDeliverable({
          sessionId,
          activityId: activity._id as Id<"activities">,
          artifactId,
          intent: shouldCheck ? "check" : "send",
        });
        if (!shouldCheck) return null;
        return await startRubricCheck({
          sessionId,
          ...(mode ? { mode } : {}),
          ...(appArtifactId ? { appArtifactId } : {}),
        });
      } catch (error) {
        console.error("Error checking artifact:", error);
        toaster.error({
          title: shouldCheck
            ? "Couldn't check your work"
            : "Couldn't send your work",
          description: "Your work is still saved. Try again in a moment.",
        });
        return null;
      }
    },
    [activity, sessionId, startRubricCheck, submitDeliverable],
  );

  return {
    /** The session's activity (public projection), or undefined/null. */
    activity,
    /** The per-session rubric snapshot (auto mode). */
    snapshot,
    deliverableContext,
    prepareSubmit,
  };
}
