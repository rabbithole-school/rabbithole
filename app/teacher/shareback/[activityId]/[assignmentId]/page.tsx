"use client";

import { use } from "react";
import { ShareBackFacilitation } from "@/components/ShareBackFacilitation";
import type { Id } from "@/convex/_generated/dataModel";

/**
 * `/teacher/shareback/[activityId]/[assignmentId]` — full-screen,
 * projector-friendly facilitation view for a Share Back's AI digest,
 * scoped to a specific cohort (Phase 2 of the Assignments split — see
 * review/design-vs-execution-split.md). The cohort scope lives in the
 * path now (it used to be `?assignment=`); the bare
 * `/teacher/shareback/[activityId]` route still renders the lifetime /
 * legacy digest.
 */
export default function ShareBackCohortPage({
  params,
}: {
  params: Promise<{ activityId: string; assignmentId: string }>;
}) {
  const { activityId, assignmentId } = use(params);
  return (
    <ShareBackFacilitation
      activityId={activityId as Id<"activities">}
      assignmentId={assignmentId as Id<"assignments">}
    />
  );
}
