"use client";

import { use } from "react";
import { ShareBackFacilitation } from "@/components/ShareBackFacilitation";
import type { Id } from "@/convex/_generated/dataModel";

/**
 * `/teacher/shareback/[activityId]` — full-screen, projector-friendly
 * facilitation view for a Share Back's AI digest at the lifetime scope (no
 * cohort). The cohort-scoped view lives at
 * `/teacher/shareback/[activityId]/[assignmentId]`.
 */
export default function ShareBackPage({
  params,
}: {
  params: Promise<{ activityId: string }>;
}) {
  const { activityId } = use(params);
  return <ShareBackFacilitation activityId={activityId as Id<"activities">} />;
}
