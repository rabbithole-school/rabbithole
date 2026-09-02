// Materialize a resolved scanned/uploaded portfolio item into the execution
// model: an OFFLINE PROJECT that contains a file DELIVERABLE, plus an
// activity-completion stamp.
//
// The paradigm (see review/portfolio-offline-projects-plan.md): a scanned
// worksheet IS a project's deliverable. An "offline project" is a real
// `projects` row with no chat thread (isOffline: true) that holds the
// scholar's file deliverable(s) for one offline activity. This gives scanned
// work a real `projectId` (the one field `deliverables` requires) so it flows
// through the SAME submissions + share-back collation as digital work — no
// parallel path, no schema migration.
//
// Materialization is EAGER: the moment a portfolio item has BOTH a resolved
// scholar and an activityId, `reconcilePortfolioMaterialization` writes the
// project + deliverable + completion. It's idempotent and keyed on
// (scholarId, activityId, assignmentId), so re-tagging an item repoints its
// deliverable to a different offline project (GC'ing the old one if empty),
// and deleting/un-resolving an item cascades the deliverable away.
//
// This module is plain helpers over MutationCtx — NOT Convex functions. It's
// called from inside portfolio.ts mutations (assignScholar / setAssignment /
// setActivity / deleteItem), so it runs in the same transaction as the patch
// that changed the item.

import type { MutationCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { maybeScheduleArtifactAssessment } from "./granuleAssessment";
import { entryTargetsScholar } from "./assignments";
import { attributedScholarIds } from "./lib/portfolioAttributions";
import {
  clearScanAssessment,
  deleteScanObservations,
  maybeScheduleScanObservation,
} from "./portfolioAssess";
import { requireActiveLearnerInstitution } from "./lib/scholarEnrollment";

/** Resolve an activity's lesson + unit ancestors (best-effort). */
async function activityAncestors(
  ctx: MutationCtx,
  activityId: Id<"activities">,
): Promise<{
  activity: Doc<"activities"> | null;
  lessonId?: Id<"lessons">;
  unitId?: Id<"units">;
}> {
  const activity = await ctx.db.get(activityId);
  if (!activity) return { activity: null };
  let lessonId: Id<"lessons"> | undefined;
  let unitId: Id<"units"> | undefined;
  if (activity.lessonId) {
    lessonId = activity.lessonId;
    const lesson = await ctx.db.get(activity.lessonId);
    if (lesson) unitId = lesson.unitId;
  }
  return { activity, lessonId, unitId };
}

/** Two optional assignment ids refer to the same cohort scope (incl. "none"). */
function sameAssignment(
  a: Id<"assignments"> | undefined,
  b: Id<"assignments"> | undefined,
): boolean {
  return (a ?? null) === (b ?? null);
}

/**
 * Find-or-create the offline project for (scholar, activity, assignment).
 * One offline project per cohort-scoped activity per scholar — multiple
 * scanned segments for the same triple attach as multiple deliverables to
 * the same project.
 */
export async function ensureOfflineSession(
  ctx: MutationCtx,
  scholarId: Id<"users">,
  activityId: Id<"activities">,
  assignmentId: Id<"assignments"> | undefined,
): Promise<Id<"sessions">> {
  const existing = await ctx.db
    .query("sessions")
    .withIndex("by_user_and_archived", (q) =>
      q.eq("userId", scholarId).eq("isArchived", false),
    )
    .collect();
  const match = existing.find(
    (p) =>
      p.isOffline === true &&
      p.activityId === activityId &&
      sameAssignment(p.assignmentId, assignmentId),
  );
  if (match) return match._id;

  const { activity, lessonId, unitId } = await activityAncestors(
    ctx,
    activityId,
  );
  const institutionId = await requireActiveLearnerInstitution(ctx, scholarId);
  return await ctx.db.insert("sessions", {
    userId: scholarId,
    institutionId,
    activityId,
    lessonId,
    unitId,
    assignmentId,
    title: activity?.title ?? "Offline work",
    isArchived: false,
    isOffline: true,
  });
}

/**
 * Ensure an activityCompletions stamp exists for (scholar, activity,
 * assignment) — scanned offline work counts as having done the activity.
 * Cohort-scoped: a scholar can complete the same activity in two cohorts.
 */
async function ensureCompletion(
  ctx: MutationCtx,
  scholarId: Id<"users">,
  activityId: Id<"activities">,
  assignmentId: Id<"assignments"> | undefined,
  sessionId: Id<"sessions">,
): Promise<void> {
  const rows = await ctx.db
    .query("activityCompletions")
    .withIndex("by_scholar_activity", (q) =>
      q.eq("scholarId", scholarId).eq("activityId", activityId),
    )
    .collect();
  if (rows.some((c) => sameAssignment(c.assignmentId, assignmentId))) return;
  const { lessonId, unitId } = await activityAncestors(ctx, activityId);
  await ctx.db.insert("activityCompletions", {
    scholarId,
    activityId,
    lessonId,
    unitId,
    completedAt: Date.now(),
    sessionId,
    assignmentId,
  });
}

/**
 * Clear evidence from an offline session once it holds no deliverables.
 * Homework sessions remain as stable reading containers; scanner-only
 * classroom sessions are deleted when their last filed item moves away.
 */
async function clearOfflineSessionIfEmpty(
  ctx: MutationCtx,
  sessionId: Id<"sessions">,
): Promise<void> {
  const session = await ctx.db.get(sessionId);
  if (!session || session.isOffline !== true) return;
  const remaining = await ctx.db
    .query("deliverables")
    .withIndex("by_session", (q) => q.eq("sessionId", sessionId))
    .first();
  if (remaining) return; // still holds work — keep it

  // Drop the granule evidence this offline artifact produced (the artifact
  // assessor is the only writer for offline projects). Without this, untagging
  // or re-tagging a worksheet leaves phantom Understanding evidence behind,
  // since coverage queries read by assignmentId and the orphan rows keep it.
  const evidence = await ctx.db
    .query("granuleEvidence")
    .withIndex("by_session", (q) => q.eq("sessionId", sessionId))
    .collect();
  for (const e of evidence) await ctx.db.delete(e._id);

  // Drop the completion this offline project produced, scoped to its cohort.
  if (session.activityId) {
    const completions = await ctx.db
      .query("activityCompletions")
      .withIndex("by_scholar_activity", (q) =>
        q
          .eq("scholarId", session.userId)
          .eq("activityId", session.activityId as Id<"activities">),
      )
      .collect();
    for (const c of completions) {
      if (c.sessionId === sessionId) await ctx.db.delete(c._id);
    }
  }

  const assignment = session.assignmentId
    ? await ctx.db.get(session.assignmentId)
    : null;
  const isHomeworkContainer = assignment?.activitySchedule?.some(
    (entry) =>
      entry.activityId === session.activityId &&
      entry.mode === "homework" &&
      entryTargetsScholar(entry, session.userId),
  );
  if (isHomeworkContainer) return;

  await ctx.db.delete(sessionId);
}

/**
 * The one entry point. Bring the offline project + deliverable + completion
 * for `itemId` into line with the item's current (scholar, activity,
 * assignment). Idempotent — safe to call after any mutation that touches the
 * item, and as a teardown step before deleting it.
 *
 *  - scholar resolved AND activityId set → ensure project + deliverable +
 *    completion exist and point at the right cohort-scoped offline project
 *    (repointing + GC'ing the old one when keys changed).
 *  - otherwise → remove any deliverable this item previously materialized and
 *    GC the orphaned offline project.
 */
export async function reconcilePortfolioMaterialization(
  ctx: MutationCtx,
  itemId: Id<"portfolioItems">,
): Promise<void> {
  const item = await ctx.db.get(itemId);

  const scholarIds = item ? await attributedScholarIds(ctx, item) : [];
  const desired = item != null && scholarIds.length > 0 && item.activityId != null;

  if (!desired) {
    for (const row of await ctx.db
      .query("deliverables")
      .withIndex("by_portfolioItem", (q) => q.eq("portfolioItemId", itemId))
      .collect()) {
      const oldProjectId = row.sessionId as Id<"sessions">;
      await ctx.db.delete(row._id);
      await clearOfflineSessionIfEmpty(ctx, oldProjectId);
    }
    // Nothing materializes here — but a scan filed to a scholar with no
    // activity is still the kid's work, and the observer can read it directly
    // (portfolioAssess.ts). Claim + schedule it once; when the item is gone or
    // has no attributed scholar left, its scan-anchored evidence goes with it.
    if (item == null || scholarIds.length === 0) {
      await deleteScanObservations(ctx, itemId);
    } else {
      await maybeScheduleScanObservation(ctx, itemId);
    }
    return;
  }

  // This scan is now the DELIVERABLE path's — it gets assessed against the
  // activity's rubric (deliverableAssess), so any evidence the standalone scan
  // observer already recorded for it must go, or the same page is counted
  // twice. Clearing the stamp (rather than "skipped") is what lets a later
  // un-tag hand the item back to the scan observer.
  await clearScanAssessment(ctx, itemId);

  // Item is non-null and fully resolved here. Each attribution gets its own
  // execution row/session/completion while every row points at the same binary.
  const activityId = item.activityId as Id<"activities">;
  const assignmentId = item.assignmentId;
  const existingRows = await ctx.db
    .query("deliverables")
    .withIndex("by_portfolioItem", (q) => q.eq("portfolioItemId", itemId))
    .collect();
  const remaining = new Set(scholarIds);
  for (const existingRow of existingRows) {
    if (!remaining.has(existingRow.scholarId)) {
      await ctx.db.delete(existingRow._id);
      await clearOfflineSessionIfEmpty(ctx, existingRow.sessionId as Id<"sessions">);
    }
  }
  for (const scholarId of scholarIds) {
    const targetProjectId = await ensureOfflineSession(
      ctx, scholarId, activityId, assignmentId,
    );
    const existingRow = existingRows.find((row) => row.scholarId === scholarId);
    if (existingRow) {
      const oldProjectId = existingRow.sessionId as Id<"sessions">;
      await ctx.db.patch(existingRow._id, {
        sessionId: targetProjectId, scholarId, activityId, assignmentId,
      });
      if (oldProjectId !== targetProjectId) {
        await clearOfflineSessionIfEmpty(ctx, oldProjectId);
      }
      if (scholarIds.length === 1) {
        await maybeScheduleArtifactAssessment(ctx, existingRow._id);
      }
    } else {
      const deliverableId = await ctx.db.insert("deliverables", {
        activityId, scholarId, sessionId: targetProjectId, assignmentId,
        portfolioItemId: itemId, submittedAt: Date.now(),
      });
      if (scholarIds.length === 1) {
        await maybeScheduleArtifactAssessment(ctx, deliverableId);
      }
    }
    await ensureCompletion(ctx, scholarId, activityId, assignmentId, targetProjectId);
  }
}
