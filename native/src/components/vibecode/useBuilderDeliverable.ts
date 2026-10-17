/**
 * useBuilderDeliverable — what the app builder needs to know about the
 * session's deliverable (TRA-519): the header status chip for a side app
 * ("Your writing · in progress"), whether there is any of the scholar's own
 * work to open, and the criteria state behind the footer when the app IS the
 * deliverable. The chat-primary DeliverablePanel resolves the same facts for
 * its own footer; both read the same queries and share `criteriaFor` and
 * `useDeliverableSetup` from DeliverableFooter (T12: no fork).
 */
import { useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";

import { api, type Doc, type Id } from "@/lib/convex";
import {
  criteriaFor,
  useDeliverableSetup,
  type Criterion,
  type DeliverableMode,
} from "@/components/DeliverableFooter";
import {
  YOUR_WORK_LABEL,
  deliverableStatusFor,
  type AppRole,
} from "../../../vendor/shared/appSurface";

export type BuilderDeliverable = {
  /** The activity's deliverable kind, when it has one. */
  kind: string | null;
  mode: DeliverableMode | null;
  criteria: Criterion[];
  criteriaPending: boolean;
  criteriaFailed: boolean;
  /** The deliverables row for the app (kind "artifact") — flair, id. */
  appDeliverable:
    | FunctionReturnType<typeof api.deliverables.getForSessionActivity>
    | null
    | undefined;
  /** "Your writing · in progress" — null when the app IS the work or no
   *  deliverable exists. */
  statusLabel: string | null;
  /** The scholar has work of their own to open from the builder. */
  hasYourWork: boolean;
  retryCriteria: () => Promise<void>;
};

export function useBuilderDeliverable({
  sessionId,
  activityId,
  role,
  artifacts,
  appArtifactId,
  completed,
}: {
  sessionId: Id<"sessions">;
  activityId: Id<"activities"> | undefined;
  role: AppRole;
  artifacts: readonly Doc<"artifacts">[] | undefined;
  appArtifactId: Id<"artifacts"> | undefined;
  completed: boolean;
}): BuilderDeliverable {
  const activity = useQuery(
    api.activities.getPublic,
    activityId ? { id: activityId } : "skip",
  );
  const spec = activity?.deliverable ?? null;
  const snapshot = useQuery(
    api.sessions.getDeliverableSnapshot,
    activityId ? { sessionId } : "skip",
  );
  const isAppDeliverable = spec?.kind === "artifact";
  // The app's own row is scoped to the app artifact; for any other kind the
  // activity's first row says whether the scholar has handed anything in.
  const deliverable = useQuery(
    api.deliverables.getForSessionActivity,
    !activityId || !spec
      ? "skip"
      : isAppDeliverable
        ? appArtifactId
          ? { sessionId, activityId, artifactId: appArtifactId }
          : "skip"
        : { sessionId, activityId },
  );
  const { setupRepairFailed, retry } = useDeliverableSetup({
    sessionId,
    mode: spec?.mode,
    snapshotStatus: snapshot?.status,
  });

  const criteria = spec ? criteriaFor(spec, snapshot ?? null) : [];
  const criteriaPending =
    spec?.mode === "auto" &&
    snapshot?.status !== "ready" &&
    snapshot?.status !== "error" &&
    !setupRepairFailed;
  const criteriaFailed =
    spec?.mode === "auto" && (snapshot?.status === "error" || setupRepairFailed);

  const ownWork = (artifacts ?? []).filter(
    (artifact) => artifact.type !== "code",
  );
  const hasYourWork = !isAppDeliverable && (spec !== null || ownWork.length > 0);
  const hasWork =
    ownWork.some((artifact) => (artifact.content ?? "").trim() !== "") ||
    (!isAppDeliverable && !!deliverable);
  const status = deliverableStatusFor({ completed, hasWork });
  const statusLabel =
    role === "side" && spec && !isAppDeliverable
      ? `${YOUR_WORK_LABEL[spec.kind] ?? "Your work"} · ${status}`
      : null;

  return {
    kind: spec?.kind ?? null,
    mode: spec?.mode ?? null,
    criteria,
    criteriaPending: !!criteriaPending,
    criteriaFailed: !!criteriaFailed,
    appDeliverable: isAppDeliverable ? deliverable : null,
    statusLabel,
    hasYourWork,
    retryCriteria: retry,
  };
}
