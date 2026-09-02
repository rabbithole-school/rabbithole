"use client";

import { useState } from "react";
import { Button, Spinner, Stack, Text } from "@chakra-ui/react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Id } from "@/convex/_generated/dataModel";
import { PaperPlaneTilt, WarningCircle } from "@phosphor-icons/react";
import { FlairChips } from "./FlairChips";
import { toaster } from "@/lib/toaster";

export interface ArtifactDeliverableButtonProps {
  sessionId: Id<"sessions">;
  activityId: Id<"activities">;
  artifactId: Id<"artifacts">;
  deliverableSpec: {
    kind: "photo" | "artifact" | "slides" | "text" | "audio" | "map";
    prompt: string;
    mode: "manual" | "auto" | "none";
    criteria: Array<{ id: string; label: string; description?: string }>;
    criteriaStatus?: "pending" | "ready" | "error" | null;
    criteriaError?: string | null;
  };
  /** Flush, submit, and (for rubric-backed work) ask the tutor to check it. */
  onSubmit?: () => Promise<void>;
  /** When true, the check button is disabled (e.g., a previous AI
   *  response is still streaming). */
  checkDisabled?: boolean;
  /** When true, the AI is mid-stream checking this work. Drives the
   *  button's spinner so the scholar sees the check is in flight. */
  isAiCheckingRubric?: boolean;
  /** False in the teacher remote view: newly earned flair is the scholar's own
   *  live event, so an observer's chips stay static. */
  animateFlairArrivals?: boolean;
}

/**
 * The scholar's submit-and-check affordance for an artifact deliverable, plus
 * the earned flair. The tutor awards a piece of flair per rubric criterion
 * (permanent); un-earned flair is invisible. There is no star meter, no
 * denominator, and no per-criterion verdict list on the scholar surface.
 */
export function ArtifactDeliverableButton({
  sessionId,
  activityId,
  artifactId,
  deliverableSpec,
  onSubmit,
  checkDisabled = false,
  isAiCheckingRubric = false,
  animateFlairArrivals = true,
}: ArtifactDeliverableButtonProps) {
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isRetryingSetup, setIsRetryingSetup] = useState(false);
  const retrySetup = useMutation(api.sessions.ensureActivitySetup);

  // Per-artifact deliverable lookup. Earned flair lives here.
  const existing = useQuery(api.deliverables.getForSessionActivity, {
    sessionId,
    activityId,
    artifactId,
  });

  const totalCount = deliverableSpec.criteria.length;
  const criteriaUnavailable =
    deliverableSpec.mode === "auto" && totalCount === 0;
  if (criteriaUnavailable) {
    const setupFailed = deliverableSpec.criteriaStatus === "error";
    return (
      <Stack gap={1.5} align="center">
        <Button
          size="sm"
          variant="outline"
          colorPalette="violet"
          disabled={!setupFailed || isRetryingSetup}
          onClick={async () => {
            if (!setupFailed || isRetryingSetup) return;
            setIsRetryingSetup(true);
            try {
              await retrySetup({
                sessionId,
                retryErroredCriteria: true,
              });
            } catch (error) {
              console.error("Error retrying rubric setup:", error);
              toaster.error({
                title: "Couldn't prepare the check",
                description: "Your work is still saved. Try again in a moment.",
              });
            } finally {
              setIsRetryingSetup(false);
            }
          }}
        >
          {setupFailed && !isRetryingSetup ? (
            <WarningCircle />
          ) : (
            <Spinner size="xs" />
          )}
          {setupFailed ? "Try preparing check again" : "Preparing check…"}
        </Button>
        {setupFailed && deliverableSpec.criteriaError && (
          <Text fontSize="xs" color="red.600" role="alert">
            The check could not be prepared. Your work is still saved.
          </Text>
        )}
      </Stack>
    );
  }

  const runSubmit = async () => {
    if (!onSubmit || checkDisabled || isAiCheckingRubric || isSubmitting) return;
    setIsSubmitting(true);
    try {
      await onSubmit();
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Stack gap={2.5} align="center">
      <FlairChips
        // Keyed by the document this panel is showing: the tab switch swaps
        // artifactId without remounting, and a stale baseline would treat the
        // other document's existing flair as arriving.
        key={artifactId}
        flairEarned={existing?.flairEarned}
        criteria={deliverableSpec.criteria}
        deliverableId={existing?._id}
        resolved={existing !== undefined}
        animateArrivals={animateFlairArrivals}
      />
      <Button
        size="sm"
        colorPalette="violet"
        onClick={() => void runSubmit()}
        disabled={!onSubmit || checkDisabled || isAiCheckingRubric || isSubmitting}
        fontFamily="heading"
        fontWeight="600"
      >
        {isSubmitting || isAiCheckingRubric ? (
          <Spinner size="xs" />
        ) : deliverableSpec.mode === "none" ? (
          <PaperPlaneTilt weight="fill" />
        ) : null}
        {deliverableSpec.mode === "none"
          ? "Send it"
          : "Check my work"}
      </Button>
    </Stack>
  );
}
