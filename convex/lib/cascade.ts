/**
 * INSTITUTION CASCADE-DELETE — the pure deletion helpers.
 *
 * The most destructive operation in the product. This module owns the
 * blast-radius logic; the Convex functions that gate + drive it (auth,
 * type-to-confirm, batching, audit) live in convex/institutionDeletion.ts.
 *
 * Design invariants (see convex/schema.ts + CLAUDE.md "Multi-tenancy"):
 *
 *   • GLOBAL-SHARED data is NEVER touched: standards, the knowledge graph
 *     (knowledgeNodes / edges / embeddings), practiceItems, instructionContent,
 *     compiledPolicies, the app catalog (externalApps / appAudiences), the
 *     manipulative/story caches, webhook-dedupe tables, and the marketing
 *     singletons (the primary institution can't be deleted).
 *
 *   • A user is DELETED only when the target institution is their SOLE tie:
 *     a membership at ANOTHER institution, a platform-admin membership, or
 *     being the guardian of a surviving scholar all KEEP the user (we then
 *     strip only their target-institution membership + repoint their home).
 *
 *   • Legacy rows with `institutionId === undefined` are PRIMARY by convention
 *     and are never swept (the primary institution can't be deleted anyway).
 *
 *   • Field-level ownership only: a row is deleted for its OWNER (userId /
 *     scholarId / teacherId-as-author / parentUserId / ownerId), never merely
 *     because a deleted user appears in an audit field (createdBy / updatedBy /
 *     reviewedBy / …). Those become dangling ids — accepted, low-harm, the same
 *     posture convex/devPurge.ts documents.
 *
 * Every table + index name here is ground-truthed against convex/schema.ts.
 * Table/index names are written as string LITERALS (never a dynamic `table`
 * var) because a union table name trips Convex's index typing — see devPurge.
 */
import type { MutationCtx, QueryCtx } from "../_generated/server";
import type { Doc, Id, TableNames } from "../_generated/dataModel";
import {
  ROLES,
  isGloballyPrivilegedMembership,
  isGloballyPrivilegedRole,
} from "./roles";
import { deleteSessionAppStates } from "../appStates";
import { detachScholarFromPortfolio } from "./portfolioAttributions";
import { scheduleClaimDecommissionLocksForScholar } from "./deviceAppUnlockScheduling";
import { recheckUnlocksForRemovedMembers } from "./scholarGroupUnlocks";
import { settlePlacementAppPush } from "../masterSchedule";

// A running tally of deleted rows per table, merged across batched steps.
export type Counts = Record<string, number>;

// How many of a user's sessions to drain per purge call. The user row is
// deleted only once all sessions are gone, so a heavy user (long chat history)
// resumes across steps instead of exceeding a single mutation's limits.
const SESSION_CHUNK = 4;

/**
 * Does this user hold a membership that keeps them alive independent of the
 * target institution? — a membership scoped to ANOTHER institution, or a GLOBAL
 * role whose standing isn't derived from the target (platform_admin,
 * curriculum_designer, lifelong_learner). A bare `parent` membership does NOT
 * count (a parent's standing comes from guardianships, handled separately).
 */
export function hasSurvivingMembership(
  memberships: Doc<"memberships">[],
  targetId: Id<"institutions">,
): boolean {
  return memberships.some(
    (m) =>
      (m.institutionId !== undefined && m.institutionId !== targetId) ||
      isGloballyPrivilegedMembership(m),
  );
}

export function bump(counts: Counts, table: string, n: number) {
  if (n) counts[table] = (counts[table] ?? 0) + n;
}

/** Delete the given documents, tallying into `counts` under `table`. */
async function del(
  ctx: MutationCtx,
  counts: Counts,
  table: string,
  docs: { _id: Id<TableNames> }[],
) {
  for (const d of docs) await ctx.db.delete(d._id);
  bump(counts, table, docs.length);
}

/** Delete a storage blob if present, ignoring already-gone blobs. */
async function delBlob(
  ctx: MutationCtx,
  counts: Counts,
  id: Id<"_storage"> | undefined | null,
) {
  if (!id) return;
  try {
    await ctx.storage.delete(id);
    bump(counts, "_storage", 1);
  } catch {
    // Blob already gone (idempotent re-run) — ignore.
  }
}

// ─── Session cascade ──────────────────────────────────────────────────
//
// Deletes every row keyed to one session, plus the session row and any blobs
// it (or its messages) own. A superset of convex/devPurge.ts's session cascade
// — that one predates several tables (world runs, quality labels, teach-backs,
// physical tasks, message flags, …). Most session-scoped rows are ALSO
// scholar-owned and would be swept by the per-user purge, but session-scoped
// rows owned by a DIFFERENT (kept) user — a rater's quality label, a teacher's
// test-drive flag — only die here, so the session cascade must be complete.

export async function deleteSessionCascade(
  ctx: MutationCtx,
  counts: Counts,
  sessionId: Id<"sessions">,
) {
  bump(counts, "appStates", await deleteSessionAppStates(ctx, sessionId));

  // messages — delete their image blobs first
  const messages = await ctx.db
    .query("messages")
    .withIndex("by_session", (q) => q.eq("sessionId", sessionId))
    .collect();
  for (const m of messages) await delBlob(ctx, counts, m.imageId ?? null);
  await del(ctx, counts, "messages", messages);

  await del(ctx, counts, "analyses", await ctx.db.query("analyses").withIndex("by_session", (q) => q.eq("sessionId", sessionId)).collect());
  await del(ctx, counts, "artifacts", await ctx.db.query("artifacts").withIndex("by_session", (q) => q.eq("sessionId", sessionId)).collect());
  await del(ctx, counts, "processState", await ctx.db.query("processState").withIndex("by_session", (q) => q.eq("sessionId", sessionId)).collect());
  await del(ctx, counts, "sessionSignals", await ctx.db.query("sessionSignals").withIndex("by_session", (q) => q.eq("sessionId", sessionId)).collect());
  await del(ctx, counts, "crossDomainConnections", await ctx.db.query("crossDomainConnections").withIndex("by_session", (q) => q.eq("sessionId", sessionId)).collect());

  // deliverables (+ file blob) — reclaim the blob before deleting the row, so
  // the later by_scholar cleanup never finds the row already gone with a leaked
  // blob.
  const deliverables = await ctx.db.query("deliverables").withIndex("by_session", (q) => q.eq("sessionId", sessionId)).collect();
  for (const d of deliverables) await delBlob(ctx, counts, d.fileStorageId ?? null);
  await del(ctx, counts, "deliverables", deliverables);

  await del(ctx, counts, "testDriveFlags", await ctx.db.query("testDriveFlags").withIndex("by_session", (q) => q.eq("sessionId", sessionId)).collect());
  await del(ctx, counts, "observations", await ctx.db.query("observations").withIndex("by_session", (q) => q.eq("sessionId", sessionId)).collect());
  await del(ctx, counts, "granuleEvidence", await ctx.db.query("granuleEvidence").withIndex("by_session", (q) => q.eq("sessionId", sessionId)).collect());
  await del(ctx, counts, "teachBacks", await ctx.db.query("teachBacks").withIndex("by_session", (q) => q.eq("sessionId", sessionId)).collect());
  await del(ctx, counts, "qualityLabelQueue", await ctx.db.query("qualityLabelQueue").withIndex("by_session", (q) => q.eq("sessionId", sessionId)).collect());
  await del(ctx, counts, "qualityGoldLabels", await ctx.db.query("qualityGoldLabels").withIndex("by_session", (q) => q.eq("sessionId", sessionId)).collect());
  await del(ctx, counts, "qualityGoldTranscriptLabels", await ctx.db.query("qualityGoldTranscriptLabels").withIndex("by_session", (q) => q.eq("sessionId", sessionId)).collect());
  await del(ctx, counts, "qualityPulseSamples", await ctx.db.query("qualityPulseSamples").withIndex("by_session", (q) => q.eq("sessionId", sessionId)).collect());
  await del(ctx, counts, "messageFlags", await ctx.db.query("messageFlags").withIndex("by_session", (q) => q.eq("sessionId", sessionId)).collect());
  await del(ctx, counts, "simulatorBenches", await ctx.db.query("simulatorBenches").withIndex("by_session", (q) => q.eq("sessionId", sessionId)).collect());
  await del(ctx, counts, "simulatorBenches", await ctx.db.query("simulatorBenches").withIndex("by_session", (q) => q.eq("sessionId", sessionId)).collect());

  // simulatorRuns (+ their chunks)
  const runs = await ctx.db.query("simulatorRuns").withIndex("by_session", (q) => q.eq("sessionId", sessionId)).collect();
  for (const r of runs) {
    await del(ctx, counts, "simulatorRunChunks", await ctx.db.query("simulatorRunChunks").withIndex("by_run_startTick", (q) => q.eq("runId", r._id)).collect());
  }
  await del(ctx, counts, "simulatorRuns", runs);

  const simulatorRuns = await ctx.db.query("simulatorRuns").withIndex("by_session", (q) => q.eq("sessionId", sessionId)).collect();
  for (const run of simulatorRuns) {
    await del(ctx, counts, "simulatorRunChunks", await ctx.db.query("simulatorRunChunks").withIndex("by_run_startTick", (q) => q.eq("runId", run._id)).collect());
  }
  await del(ctx, counts, "simulatorRuns", simulatorRuns);

  // physicalTasks (+ photo blob)
  const tasks = await ctx.db.query("physicalTasks").withIndex("by_session", (q) => q.eq("sessionId", sessionId)).collect();
  for (const t of tasks) await delBlob(ctx, counts, t.photoStorageId ?? null);
  await del(ctx, counts, "physicalTasks", tasks);

  // masteryObservations by session (+ their teacher overrides)
  const mastery = await ctx.db.query("masteryObservations").withIndex("by_session", (q) => q.eq("sessionId", sessionId)).collect();
  for (const m of mastery) {
    await del(ctx, counts, "teacherMasteryOverrides", await ctx.db.query("teacherMasteryOverrides").withIndex("by_observation", (q) => q.eq("observationId", m._id)).collect());
  }
  await del(ctx, counts, "masteryObservations", mastery);

  // NOTE: seeds + activityCompletions carry a sessionId but have no by_session
  // index, so a per-session filter would full-scan those tables. They are
  // scholar-owned and swept by purgeScholarOwned (by_scholar), so they are NOT
  // handled here. groundedSessionVerdicts (eval data) is likewise left to
  // dangle rather than full-scan per session — low-harm, matching devPurge.

  await ctx.db.delete(sessionId);
  bump(counts, "sessions", 1);
}

/** Delete tenant-stamped sessions whose owner survives institution deletion. */
export async function deleteInstitutionSessionsBatch(
  ctx: MutationCtx,
  counts: Counts,
  targetId: Id<"institutions">,
): Promise<number> {
  const sessions = await ctx.db
    .query("sessions")
    .withIndex("by_institution", (q) => q.eq("institutionId", targetId))
    .take(SESSION_CHUNK);
  for (const session of sessions) {
    await deleteSessionCascade(ctx, counts, session._id);
  }
  return sessions.length;
}

// ─── Unit tree ────────────────────────────────────────────────────────
//
// Deletes a curriculum unit and everything scoped BELOW it: lessons →
// activities → activity-scoped design/sim rows, plus unit-scoped reviews and
// scholar unit badges. Used both by the per-user purge (a deleted teacher's or
// scholar-authored units) and by the institution scan (units.institutionId ===
// target authored by a KEPT teacher). Idempotent — a re-run finds an empty tree.

export async function deleteUnitTree(
  ctx: MutationCtx,
  counts: Counts,
  unitId: Id<"units">,
) {
  const lessons = await ctx.db.query("lessons").withIndex("by_unit", (q) => q.eq("unitId", unitId)).collect();
  for (const lesson of lessons) {
    const activities = await ctx.db.query("activities").withIndex("by_lesson", (q) => q.eq("lessonId", lesson._id)).collect();
    for (const a of activities) await deleteActivitySubtree(ctx, counts, a._id);
    await del(ctx, counts, "activities", activities);
  }
  await del(ctx, counts, "lessons", lessons);

  await del(ctx, counts, "unitReviews", await ctx.db.query("unitReviews").withIndex("by_unit", (q) => q.eq("unitId", unitId)).collect());

  // Assignments referencing this unit (may be authored by a KEPT teacher) →
  // cascade each so no orphaned tournament/digest rows survive.
  const unitAssignments = await ctx.db.query("assignments").withIndex("by_unit", (q) => q.eq("unitId", unitId)).collect();
  for (const a of unitAssignments) await deleteAssignmentCascade(ctx, counts, a._id);

  // scholarUnitBadges (scholar-owned, but unit-scoped) + their blobs
  const badges = await ctx.db.query("scholarUnitBadges").withIndex("by_unit", (q) => q.eq("unitId", unitId)).collect();
  for (const b of badges) await delBlob(ctx, counts, b.imageStorageId ?? null);
  await del(ctx, counts, "scholarUnitBadges", badges);

  await ctx.db.delete(unitId);
  bump(counts, "units", 1);
}

/**
 * Delete an assignment and its dependent execution rows (tournaments — which
 * REQUIRE an assignment — plus class/share-back digests keyed to it). Used both
 * for a deleted teacher's assignments and for assignments found via a deleted
 * institution-owned unit (which may be authored by a KEPT teacher).
 */
async function deleteAssignmentCascade(
  ctx: MutationCtx,
  counts: Counts,
  assignmentId: Id<"assignments">,
) {
  await del(ctx, counts, "tournaments", await ctx.db.query("tournaments").withIndex("by_assignment", (q) => q.eq("assignmentId", assignmentId)).collect());
  await del(ctx, counts, "classDigests", await ctx.db.query("classDigests").withIndex("by_assignment_activity", (q) => q.eq("assignmentId", assignmentId)).collect());
  await del(ctx, counts, "shareBackDigests", await ctx.db.query("shareBackDigests").withIndex("by_assignment_activity", (q) => q.eq("assignmentId", assignmentId)).collect());
  await ctx.db.delete(assignmentId);
  bump(counts, "assignments", 1);
}

async function deleteActivitySubtree(
  ctx: MutationCtx,
  counts: Counts,
  activityId: Id<"activities">,
) {
  // activityResources (+ file blob; blob lives in a discriminated `source` union)
  const resources = await ctx.db.query("activityResources").withIndex("by_activity", (q) => q.eq("activityId", activityId)).collect();
  for (const r of resources) {
    if (r.source.kind === "file") await delBlob(ctx, counts, r.source.fileStorageId);
  }
  await del(ctx, counts, "activityResources", resources);

  await del(ctx, counts, "shareBackDigests", await ctx.db.query("shareBackDigests").withIndex("by_activity", (q) => q.eq("activityId", activityId)).collect());
  await del(ctx, counts, "practiceGameBindings", await ctx.db.query("practiceGameBindings").withIndex("by_activity", (q) => q.eq("activityId", activityId)).collect());
  await del(ctx, counts, "activityReflections", await ctx.db.query("activityReflections").withIndex("by_activity_teacher", (q) => q.eq("activityId", activityId)).collect());
  await del(ctx, counts, "momentTriage", await ctx.db.query("momentTriage").withIndex("by_activity_teacher", (q) => q.eq("activityId", activityId)).collect());

  // curriculum experiments → simulated sessions; variants
  const experiments = await ctx.db.query("curriculumExperiments").withIndex("by_activity", (q) => q.eq("activityId", activityId)).collect();
  for (const e of experiments) {
    await del(ctx, counts, "simulatedSessions", await ctx.db.query("simulatedSessions").withIndex("by_experiment", (q) => q.eq("experimentId", e._id)).collect());
  }
  await del(ctx, counts, "curriculumExperiments", experiments);
  await del(ctx, counts, "curriculumVariants", await ctx.db.query("curriculumVariants").withIndex("by_activity", (q) => q.eq("activityId", activityId)).collect());
}

// ─── Per-user purge ───────────────────────────────────────────────────
//
// Deletes EVERYTHING owned by one user across the current schema, then the
// user row. Bounded by that one user's data (the batching in
// institutionDeletion.ts processes a small number of users per mutation).

// ─── Per-user purge ───────────────────────────────────────────────────
//
// Deletes EVERYTHING owned by one user across the current schema, then the user
// row. RESUMABLE: sessions (the dominant scale vector — chat history) are
// drained in bounded chunks and the user row is deleted only once none remain,
// so a heavy user makes forward progress across steps instead of exceeding a
// single mutation's limits. Returns `true` when the user is fully purged,
// `false` when more sessions remain (the caller revisits them next step).
//
// The per-user NON-session data (practice rows, learning record, parent data,
// auth) is deleted in one pass once sessions are drained; that is bounded by
// realistic per-user volume. The residual limits — a single user with tens of
// thousands of non-session rows, or a SINGLE session carrying tens of thousands
// of messages (neither of which a K-8 tutoring workflow produces) — are the
// documented bound: the step's mutation would exceed Convex limits and mark the
// job failed with an observable error, and that user/session can be purged out
// of band (convex/devPurge.ts) before re-running the (idempotent) job.

export async function purgeUserInner(
  ctx: MutationCtx,
  counts: Counts,
  uid: Id<"users">,
  targetId: Id<"institutions">,
): Promise<boolean> {
  const user = await ctx.db.get(uid);
  if (!user) return true; // already purged (idempotent)

  // 1. Sessions (full per-session cascade), in bounded chunks.
  const sessions = await ctx.db.query("sessions").withIndex("by_user", (q) => q.eq("userId", uid)).take(SESSION_CHUNK);
  for (const s of sessions) await deleteSessionCascade(ctx, counts, s._id);
  if (sessions.length === SESSION_CHUNK) return false; // more sessions may remain

  // 2. Scholar-keyed learning record + practice state (owner === scholarId)
  await purgeScholarOwned(ctx, counts, uid);

  // 3. Teacher/author-owned curriculum + execution
  await del(ctx, counts, "observations", await ctx.db.query("observations").withIndex("by_teacher", (q) => q.eq("teacherId", uid)).collect());
  await del(ctx, counts, "personas", await ctx.db.query("personas").withIndex("by_teacher", (q) => q.eq("teacherId", uid)).collect());
  await del(ctx, counts, "perspectives", await ctx.db.query("perspectives").withIndex("by_teacher", (q) => q.eq("teacherId", uid)).collect());
  await del(ctx, counts, "processes", await ctx.db.query("processes").withIndex("by_teacher", (q) => q.eq("teacherId", uid)).collect());
  for (const a of await ctx.db.query("assignments").withIndex("by_teacher", (q) => q.eq("teacherId", uid)).collect()) {
    await deleteAssignmentCascade(ctx, counts, a._id);
  }
  await del(ctx, counts, "teacherAffinities", await ctx.db.query("teacherAffinities").withIndex("by_teacher", (q) => q.eq("teacherId", uid)).collect());
  await del(ctx, counts, "rooms", await ctx.db.query("rooms").withIndex("by_owner", (q) => q.eq("ownerTeacherId", uid)).collect());

  // Teacher-owned chat threads
  await del(ctx, counts, "chats", await ctx.db.query("chats").withIndex("by_teacher", (q) => q.eq("teacherId", uid)).collect());
  await del(ctx, counts, "chats", await ctx.db.query("chats").withIndex("by_scholar", (q) => q.eq("scholarId", uid)).collect());
  await delCurriculumMessages(ctx, counts, uid);

  // Units authored as teacher OR as scholar (independent study) → full tree
  const teacherUnits = await ctx.db.query("units").withIndex("by_teacher", (q) => q.eq("teacherId", uid)).collect();
  for (const u of teacherUnits) await deleteUnitTree(ctx, counts, u._id);
  const scholarUnits = await ctx.db.query("units").withIndex("by_authorScholar", (q) => q.eq("authorScholarId", uid)).collect();
  for (const u of scholarUnits) await deleteUnitTree(ctx, counts, u._id);

  // 4. Parent / guardianship / notifications (both directions). Deleting this
  //    user's guardianship links can orphan a parent whose LAST target-scholar
  //    child is this user — that parent is purged here too (see purgeParentSide).
  await purgeParentSide(ctx, counts, uid, targetId);

  // 5. Synthetic scholar profiles the user owns
  await del(ctx, counts, "syntheticScholarProfiles", await ctx.db.query("syntheticScholarProfiles").withIndex("by_owner", (q) => q.eq("ownerId", uid)).collect());

  // Capability grants are authorization state, not durable activity history:
  // leaving any grantee/grantor/revoker reference behind would retain a row whose
  // audit chain cannot be resolved. The table is intentionally small and has no
  // audit-actor index, so one bounded administrative scan is safer than dangling
  // authority metadata.
  await del(
    ctx,
    counts,
    "staffCapabilityGrants",
    (
      await ctx.db.query("staffCapabilityGrants").collect()
    ).filter(
      (grant) =>
        grant.granteeUserId === uid ||
        grant.grantedBy === uid ||
        grant.revokedBy === uid,
    ),
  );

  // 6. Memberships + auth + per-user tokens + impersonation overlays
  await del(ctx, counts, "memberships", await ctx.db.query("memberships").withIndex("by_user", (q) => q.eq("userId", uid)).collect());
  await purgeAuthAndTokens(ctx, counts, uid);

  // 6b. A deleted scholar can never again be "authorized", but nothing else
  // in this cascade tells an already-unlocked managed device to re-lock —
  // schedule that BEFORE the user row disappears so the durable relock
  // record survives regardless of what happens to the claim row next (the
  // claim itself is institution-scoped state this cascade intentionally
  // doesn't touch — see the module header — so it's left dangling, same
  // posture as devPurge's other audit-field references).
  await scheduleClaimDecommissionLocksForScholar(ctx, uid);

  // 7. The user row
  await ctx.db.delete(uid);
  bump(counts, "users", 1);
  return true;
}

async function purgeScholarOwned(ctx: MutationCtx, counts: Counts, uid: Id<"users">) {
  // Simple scholar-owned tables (first index column === scholarId).
  await del(ctx, counts, "practiceMastery", await ctx.db.query("practiceMastery").withIndex("by_scholar", (q) => q.eq("scholarId", uid)).collect());
  await del(ctx, counts, "factFluency", await ctx.db.query("factFluency").withIndex("by_scholar", (q) => q.eq("scholarId", uid)).collect());
  await del(ctx, counts, "scholarCheckpointOverride", await ctx.db.query("scholarCheckpointOverride").withIndex("by_scholar", (q) => q.eq("scholarId", uid)).collect());
  await del(ctx, counts, "nodeReveals", await ctx.db.query("nodeReveals").withIndex("by_scholar", (q) => q.eq("scholarId", uid)).collect());
  await del(ctx, counts, "momentEvents", await ctx.db.query("momentEvents").withIndex("by_scholar", (q) => q.eq("scholarId", uid)).collect());
  await del(ctx, counts, "instructionEvents", await ctx.db.query("instructionEvents").withIndex("by_scholar", (q) => q.eq("scholarId", uid)).collect());
  await del(ctx, counts, "practiceGameOffers", await ctx.db.query("practiceGameOffers").withIndex("by_scholar", (q) => q.eq("scholarId", uid)).collect());
  await del(ctx, counts, "mapReveals", await ctx.db.query("mapReveals").withIndex("by_scholar_map", (q) => q.eq("scholarId", uid)).collect());
  await del(ctx, counts, "closureLines", await ctx.db.query("closureLines").withIndex("by_scholar_kind_hash", (q) => q.eq("scholarId", uid)).collect());
  await del(ctx, counts, "practicePlacements", await ctx.db.query("practicePlacements").withIndex("by_scholar_domain", (q) => q.eq("scholarId", uid)).collect());
  await del(ctx, counts, "practiceErrorEvents", await ctx.db.query("practiceErrorEvents").withIndex("by_scholar", (q) => q.eq("scholarId", uid)).collect());
  await del(ctx, counts, "practiceChoiceEvents", await ctx.db.query("practiceChoiceEvents").withIndex("by_scholar_createdAt", (q) => q.eq("scholarId", uid)).collect());
  await del(ctx, counts, "practiceTuneups", await ctx.db.query("practiceTuneups").withIndex("by_scholar", (q) => q.eq("scholarId", uid)).collect());
  await del(ctx, counts, "practicePredictions", await ctx.db.query("practicePredictions").withIndex("by_scholar", (q) => q.eq("scholarId", uid)).collect());
  await del(ctx, counts, "practiceHintReveals", await ctx.db.query("practiceHintReveals").withIndex("by_scholar_item_createdAt", (q) => q.eq("scholarId", uid)).collect());
  await del(ctx, counts, "teacherMasteryOverrides", await ctx.db.query("teacherMasteryOverrides").withIndex("by_scholar", (q) => q.eq("scholarId", uid)).collect());
  await del(ctx, counts, "teachBacks", await ctx.db.query("teachBacks").withIndex("by_scholar", (q) => q.eq("scholarId", uid)).collect());
  await del(ctx, counts, "sessionSignals", await ctx.db.query("sessionSignals").withIndex("by_scholar", (q) => q.eq("scholarId", uid)).collect());
  await del(ctx, counts, "crossDomainConnections", await ctx.db.query("crossDomainConnections").withIndex("by_scholar", (q) => q.eq("scholarId", uid)).collect());
  await del(ctx, counts, "activityCompletions", await ctx.db.query("activityCompletions").withIndex("by_scholar", (q) => q.eq("scholarId", uid)).collect());
  await del(ctx, counts, "scholarActivityAngles", await ctx.db.query("scholarActivityAngles").withIndex("by_scholar", (q) => q.eq("scholarId", uid)).collect());
  await del(ctx, counts, "messageFlags", await ctx.db.query("messageFlags").withIndex("by_scholar", (q) => q.eq("scholarId", uid)).collect());
  await del(ctx, counts, "scholarDossiers", await ctx.db.query("scholarDossiers").withIndex("by_scholar", (q) => q.eq("scholarId", uid)).collect());
  await del(ctx, counts, "graphemeInventories", await ctx.db.query("graphemeInventories").withIndex("by_scholar", (q) => q.eq("scholarId", uid)).collect());
  await del(ctx, counts, "graphemeHistory", await ctx.db.query("graphemeHistory").withIndex("by_scholar", (q) => q.eq("scholarId", uid)).collect());
  await del(ctx, counts, "teacherDirectives", await ctx.db.query("teacherDirectives").withIndex("by_scholar", (q) => q.eq("scholarId", uid)).collect());
  await del(ctx, counts, "scholarSuggestions", await ctx.db.query("scholarSuggestions").withIndex("by_scholar", (q) => q.eq("scholarId", uid)).collect());
  await del(ctx, counts, "readingLevelHistory", await ctx.db.query("readingLevelHistory").withIndex("by_scholar", (q) => q.eq("scholarId", uid)).collect());
  await del(ctx, counts, "courseNarratives", await ctx.db.query("courseNarratives").withIndex("by_scholar", (q) => q.eq("scholarId", uid)).collect());
  await del(ctx, counts, "wholeChildNarratives", await ctx.db.query("wholeChildNarratives").withIndex("by_scholar", (q) => q.eq("scholarId", uid)).collect());
  await del(ctx, counts, "selSyntheses", await ctx.db.query("selSyntheses").withIndex("by_scholar_week", (q) => q.eq("scholarId", uid)).collect());
  await del(ctx, counts, "granuleEvidence", await ctx.db.query("granuleEvidence").withIndex("by_scholar_unit", (q) => q.eq("scholarId", uid)).collect());
  await del(ctx, counts, "weeklyGoals", await ctx.db.query("weeklyGoals").withIndex("by_scholar", (q) => q.eq("scholarId", uid)).collect());
  await del(ctx, counts, "alerts", await ctx.db.query("alerts").withIndex("by_scholar", (q) => q.eq("scholarId", uid)).collect());
  await del(ctx, counts, "observations", await ctx.db.query("observations").withIndex("by_scholar", (q) => q.eq("scholarId", uid)).collect());
  await del(ctx, counts, "masteryObservations", await ctx.db.query("masteryObservations").withIndex("by_scholar", (q) => q.eq("scholarId", uid)).collect());
  await del(ctx, counts, "seeds", await ctx.db.query("seeds").withIndex("by_scholar_status", (q) => q.eq("scholarId", uid)).collect());
  await del(ctx, counts, "scholarApps", await ctx.db.query("scholarApps").withIndex("by_scholar", (q) => q.eq("scholarId", uid)).collect());

  // Blob-bearing scholar tables (reclaim the blob, then the row)
  const workImages = await ctx.db.query("practiceWorkImages").withIndex("by_scholar_item_createdAt", (q) => q.eq("scholarId", uid)).collect();
  for (const r of workImages) await delBlob(ctx, counts, r.storageId ?? null);
  await del(ctx, counts, "practiceWorkImages", workImages);

  const padHints = await ctx.db.query("practicePadHints").withIndex("by_scholar_item_createdAt", (q) => q.eq("scholarId", uid)).collect();
  for (const r of padHints) await delBlob(ctx, counts, r.imageId ?? null);
  await del(ctx, counts, "practicePadHints", padHints);

  const attempts = await ctx.db.query("practiceAttempts").withIndex("by_scholar", (q) => q.eq("scholarId", uid)).collect();
  for (const r of attempts) await delBlob(ctx, counts, r.workImageId ?? null);
  await del(ctx, counts, "practiceAttempts", attempts);

  const webSessions = await ctx.db.query("webActivitySessions").withIndex("by_scholar", (q) => q.eq("scholarId", uid)).collect();
  for (const r of webSessions) for (const b of r.screenshotIds ?? []) await delBlob(ctx, counts, b);
  await del(ctx, counts, "webActivitySessions", webSessions);

  // metaChats (+ messages + observer runs)
  const metaChats = await ctx.db.query("metaChats").withIndex("by_scholar_day", (q) => q.eq("scholarId", uid)).collect();
  for (const c of metaChats) {
    await del(ctx, counts, "metaMessages", await ctx.db.query("metaMessages").withIndex("by_chat", (q) => q.eq("chatId", c._id)).collect());
    await del(ctx, counts, "metaObserverRuns", await ctx.db.query("metaObserverRuns").withIndex("by_chat_range", (q) => q.eq("chatId", c._id)).collect());
  }
  await del(ctx, counts, "metaChats", metaChats);

  // gameSessions (+ events) + digests
  const games = await ctx.db.query("gameSessions").withIndex("by_scholar", (q) => q.eq("scholarId", uid)).collect();
  for (const g of games) {
    await del(ctx, counts, "gameEvents", await ctx.db.query("gameEvents").withIndex("by_session_seq", (q) => q.eq("sessionId", g._id)).collect());
  }
  await del(ctx, counts, "gameSessions", games);
  await del(ctx, counts, "gameSessionDigests", await ctx.db.query("gameSessionDigests").withIndex("by_scholar", (q) => q.eq("scholarId", uid)).collect());

  // simulatorRuns not tied to a (now-deleted) session (by_scholar) + chunks; benches
  const runs = await ctx.db.query("simulatorRuns").withIndex("by_scholar", (q) => q.eq("scholarId", uid)).collect();
  for (const r of runs) {
    await del(ctx, counts, "simulatorRunChunks", await ctx.db.query("simulatorRunChunks").withIndex("by_run_startTick", (q) => q.eq("runId", r._id)).collect());
  }
  await del(ctx, counts, "simulatorRuns", runs);
  await del(ctx, counts, "simulatorBenches", await ctx.db.query("simulatorBenches").withIndex("by_scholar_activity", (q) => q.eq("scholarId", uid)).collect());

  const simulatorRuns = await ctx.db.query("simulatorRuns").withIndex("by_scholar", (q) => q.eq("scholarId", uid)).collect();
  for (const run of simulatorRuns) {
    await del(ctx, counts, "simulatorRunChunks", await ctx.db.query("simulatorRunChunks").withIndex("by_run_startTick", (q) => q.eq("runId", run._id)).collect());
  }
  await del(ctx, counts, "simulatorRuns", simulatorRuns);
  await del(ctx, counts, "simulatorBenches", await ctx.db.query("simulatorBenches").withIndex("by_scholar_activity", (q) => q.eq("scholarId", uid)).collect());

  // scholarGoals (+ checkins)
  const goals = await ctx.db.query("scholarGoals").withIndex("by_scholar", (q) => q.eq("scholarId", uid)).collect();
  for (const g of goals) {
    await del(ctx, counts, "goalCheckins", await ctx.db.query("goalCheckins").withIndex("by_goal", (q) => q.eq("goalId", g._id)).collect());
  }
  await del(ctx, counts, "scholarGoals", goals);
  await del(ctx, counts, "goalCheckins", await ctx.db.query("goalCheckins").withIndex("by_scholar", (q) => q.eq("scholarId", uid)).collect());

  // scholarDocuments (+ access logs / proposals) + blobs
  const docs = await ctx.db.query("scholarDocuments").withIndex("by_scholar", (q) => q.eq("scholarId", uid)).collect();
  for (const d of docs) {
    await delBlob(ctx, counts, d.fileStorageId ?? null);
    await del(ctx, counts, "documentAccessLog", await ctx.db.query("documentAccessLog").withIndex("by_document", (q) => q.eq("documentId", d._id)).collect());
    await del(ctx, counts, "documentProposals", await ctx.db.query("documentProposals").withIndex("by_document", (q) => q.eq("documentId", d._id)).collect());
  }
  await del(ctx, counts, "scholarDocuments", docs);
  await del(ctx, counts, "documentAccessLog", await ctx.db.query("documentAccessLog").withIndex("by_scholar", (q) => q.eq("scholarId", uid)).collect());
  // NOTE: documentAccessLog.userId is an AUDIT field ("who accessed") — a
  // deleted staffer's accesses to OTHER (surviving) scholars' documents must
  // NOT be swept, so we deliberately do NOT delete by_user. Those rows keep a
  // dangling accessor id (accepted; the accessed document/scholar owns the row).
  await del(ctx, counts, "documentProposals", await ctx.db.query("documentProposals").withIndex("by_scholar", (q) => q.eq("scholarId", uid)).collect());

  // Health record layer (+ file blobs)
  await del(ctx, counts, "scholarHealthRecords", await ctx.db.query("scholarHealthRecords").withIndex("by_scholar", (q) => q.eq("scholarId", uid)).collect());
  await del(ctx, counts, "scholarHealthRecordDrafts", await ctx.db.query("scholarHealthRecordDrafts").withIndex("by_scholar", (q) => q.eq("scholarId", uid)).collect());
  const healthFiles = await ctx.db.query("healthRecordFiles").withIndex("by_scholar", (q) => q.eq("scholarId", uid)).collect();
  for (const f of healthFiles) await delBlob(ctx, counts, f.storageId ?? null);
  await del(ctx, counts, "healthRecordFiles", healthFiles);
  await del(ctx, counts, "medicalClearanceRequests", await ctx.db.query("medicalClearanceRequests").withIndex("by_scholar", (q) => q.eq("scholarId", uid)).collect());

  // Shared portfolio evidence survives while any attributed peer remains.
  const detached = await detachScholarFromPortfolio(ctx, uid);
  counts.portfolioAttributions =
    (counts.portfolioAttributions ?? 0) + detached.deletedAttributions;
  counts.captureStationCaptures =
    (counts.captureStationCaptures ?? 0) + detached.deletedCaptures;
  for (const p of detached.orphanedItems) {
    for (const storageId of [
      p.fileStorageId,
      p.thumbStorageId,
      p.magicStorageId,
      p.magicThumbStorageId,
    ]) {
      if (!storageId) continue;
      const messageReference = await ctx.db
        .query("parentMessageAttachments")
        .withIndex("by_storage", (q) => q.eq("storageId", storageId))
        .first();
      if (!messageReference) await delBlob(ctx, counts, storageId);
    }
    await ctx.db.delete(p._id);
    bump(counts, "portfolioItems", 1);
  }

  // deliverables + blob; scholarUnitBadges + blob (badges also handled per-unit)
  const deliverables = await ctx.db.query("deliverables").withIndex("by_scholar", (q) => q.eq("scholarId", uid)).collect();
  for (const d of deliverables) await delBlob(ctx, counts, d.fileStorageId ?? null);
  await del(ctx, counts, "deliverables", deliverables);

  const badges = await ctx.db.query("scholarUnitBadges").withIndex("by_scholar", (q) => q.eq("scholarId", uid)).collect();
  for (const b of badges) await delBlob(ctx, counts, b.imageStorageId ?? null);
  await del(ctx, counts, "scholarUnitBadges", badges);
}

async function delCurriculumMessages(ctx: MutationCtx, counts: Counts, uid: Id<"users">) {
  const teacherMsgs = await ctx.db.query("curriculumMessages").withIndex("by_teacher", (q) => q.eq("teacherId", uid)).collect();
  const scholarMsgs = await ctx.db.query("curriculumMessages").withIndex("by_scholar_and_creation", (q) => q.eq("scholarId", uid)).collect();
  for (const m of [...teacherMsgs, ...scholarMsgs]) {
    for (const att of m.attachments ?? []) await delBlob(ctx, counts, att.storageId ?? null);
  }
  await del(ctx, counts, "curriculumMessages", teacherMsgs);
  await del(ctx, counts, "curriculumMessages", scholarMsgs);
}

async function deleteParentAttachments(
  ctx: MutationCtx,
  counts: Counts,
  attachments: Doc<"parentMessageAttachments">[],
) {
  const unique = new Map(attachments.map((attachment) => [attachment._id, attachment]));
  for (const attachment of unique.values()) {
    await ctx.db.delete(attachment._id);
    bump(counts, "parentMessageAttachments", 1);
    const remainingReference = await ctx.db
      .query("parentMessageAttachments")
      .withIndex("by_storage", (q) => q.eq("storageId", attachment.storageId))
      .first();
    if (remainingReference) continue;
    const portfolioItem = attachment.portfolioItemId
      ? await ctx.db.get(attachment.portfolioItemId)
      : null;
    if (portfolioItem?.fileStorageId === attachment.storageId) continue;
    await delBlob(ctx, counts, attachment.storageId);
  }
}

async function purgeParentSide(
  ctx: MutationCtx,
  counts: Counts,
  uid: Id<"users">,
  targetId: Id<"institutions">,
) {
  // Capture the parents that guard THIS user BEFORE removing the links, so we
  // can orphan-check them afterward.
  const asChild = await ctx.db.query("guardianships").withIndex("by_scholar", (q) => q.eq("scholarUserId", uid)).collect();
  const parentIds = [...new Set(asChild.map((l) => l.parentUserId))];

  await del(ctx, counts, "guardianships", asChild);
  await del(ctx, counts, "guardianships", await ctx.db.query("guardianships").withIndex("by_parent", (q) => q.eq("parentUserId", uid)).collect());
  await del(ctx, counts, "parentChatMessages", await ctx.db.query("parentChatMessages").withIndex("by_parent", (q) => q.eq("parentUserId", uid)).collect());
  await del(ctx, counts, "notificationPrefs", await ctx.db.query("notificationPrefs").withIndex("by_user", (q) => q.eq("userId", uid)).collect());
  await del(ctx, counts, "parentChannelIdentities", await ctx.db.query("parentChannelIdentities").withIndex("by_parent", (q) => q.eq("parentUserId", uid)).collect());
  await deleteParentAttachments(
    ctx,
    counts,
    await ctx.db
      .query("parentMessageAttachments")
      .withIndex("by_uploader", (q) => q.eq("uploaderId", uid))
      .filter((q) =>
        q.and(
          q.eq(q.field("messageId"), undefined),
          q.eq(q.field("threadId"), undefined),
        ),
      )
      .collect(),
  );

  const threads = await ctx.db.query("parentThreads").withIndex("by_parent", (q) => q.eq("parentUserId", uid)).collect();
  for (const t of threads) {
    const msgs = await ctx.db.query("parentMessages").withIndex("by_thread", (q) => q.eq("threadId", t._id)).collect();
    const threadAttachments = await ctx.db
      .query("parentMessageAttachments")
      .withIndex("by_thread", (q) => q.eq("threadId", t._id))
      .collect();
    const messageAttachments = (
      await Promise.all(
        msgs.map((message) =>
          ctx.db
            .query("parentMessageAttachments")
            .withIndex("by_message", (q) => q.eq("messageId", message._id))
            .collect(),
        ),
      )
    ).flat();
    await deleteParentAttachments(ctx, counts, [
      ...threadAttachments,
      ...messageAttachments,
    ]);
    await del(
      ctx,
      counts,
      "parentThreadParticipants",
      await ctx.db
        .query("parentThreadParticipants")
        .withIndex("by_thread", (q) => q.eq("threadId", t._id))
        .collect(),
    );
    for (const m of msgs) {
      await del(ctx, counts, "messageDeliveries", await ctx.db.query("messageDeliveries").withIndex("by_message", (q) => q.eq("messageId", m._id)).collect());
    }
    await del(ctx, counts, "parentMessages", msgs);
    await del(ctx, counts, "parentSlackThreads", await ctx.db.query("parentSlackThreads").withIndex("by_parent_thread", (q) => q.eq("parentThreadId", t._id)).collect());
  }
  await del(ctx, counts, "parentThreads", threads);

  // Orphan-check each parent whose link to this (deleted) child we just removed:
  // a parent whose LAST remaining child has now gone, with no other institution
  // tie, is scoped solely to the deleted school and is purged too. Multi-child
  // parents keep their other links, so this only fires on the last child.
  for (const pid of parentIds) {
    if (pid !== uid) await maybePurgeOrphanedParent(ctx, counts, pid, targetId);
  }
}

/**
 * Purge a parent that has been orphaned by deleting their children: they hold
 * NO surviving membership (see hasSurvivingMembership) and now guard NO
 * remaining scholar. A parent who still guards any child (at any school) or
 * holds another institution / global-role membership is left untouched. An
 * orphaned parent has only parent data (no sessions), so a single purge call
 * always completes.
 */
async function maybePurgeOrphanedParent(
  ctx: MutationCtx,
  counts: Counts,
  parentId: Id<"users">,
  targetId: Id<"institutions">,
) {
  const parent = await ctx.db.get(parentId);
  if (!parent) return;
  if (isGloballyPrivilegedRole(parent.role)) return;
  // An explicit non-target home institution keeps the parent too.
  if (parent.institutionId !== undefined && parent.institutionId !== targetId) return;

  const memberships = await ctx.db.query("memberships").withIndex("by_user", (q) => q.eq("userId", parentId)).collect();
  if (hasSurvivingMembership(memberships, targetId)) return;

  const remainingChildren = await ctx.db.query("guardianships").withIndex("by_parent", (q) => q.eq("parentUserId", parentId)).collect();
  if (remainingChildren.length > 0) return; // still guards a scholar → keep

  await purgeUserInner(ctx, counts, parentId, targetId);
}

async function purgeAuthAndTokens(ctx: MutationCtx, counts: Counts, uid: Id<"users">) {
  await del(ctx, counts, "passkeys", await ctx.db.query("passkeys").withIndex("by_user", (q) => q.eq("userId", uid)).collect());
  await del(ctx, counts, "webauthnChallenges", await ctx.db.query("webauthnChallenges").withIndex("by_user", (q) => q.eq("userId", uid)).collect());
  await del(ctx, counts, "enrollmentTokens", await ctx.db.query("enrollmentTokens").withIndex("by_user", (q) => q.eq("userId", uid)).collect());
  await del(ctx, counts, "embedSessionTokens", await ctx.db.query("embedSessionTokens").withIndex("by_user", (q) => q.eq("userId", uid)).collect());
  await del(ctx, counts, "googleAccounts", await ctx.db.query("googleAccounts").withIndex("by_user", (q) => q.eq("userId", uid)).collect());
  await del(ctx, counts, "mcpSessions", await ctx.db.query("mcpSessions").withIndex("by_user", (q) => q.eq("userId", uid)).collect());
  await del(ctx, counts, "mcpOauthConsents", await ctx.db.query("mcpOauthConsents").withIndex("by_user_client", (q) => q.eq("userId", uid)).collect());
  await del(ctx, counts, "mcpOauthCodes", await ctx.db.query("mcpOauthCodes").withIndex("by_user", (q) => q.eq("userId", uid)).collect());

  // Impersonation overlays where THIS user is the admin (their sessions vanish).
  // Overlays TARGETING this user are left (targetUserId dangles; low harm).
  await del(ctx, counts, "impersonationOverlays", await ctx.db.query("impersonationOverlays").withIndex("by_admin", (q) => q.eq("adminUserId", uid)).collect());

  // @convex-dev/auth tables — use the component's own indexes (userId on
  // sessions, userIdAndProvider on accounts, sessionId on refresh tokens,
  // accountId on verification codes) rather than full-table filter scans.
  const authSessions = await ctx.db.query("authSessions").withIndex("userId", (q) => q.eq("userId", uid)).collect();
  for (const s of authSessions) {
    await del(ctx, counts, "authRefreshTokens", await ctx.db.query("authRefreshTokens").withIndex("sessionId", (q) => q.eq("sessionId", s._id)).collect());
  }
  await del(ctx, counts, "authSessions", authSessions);
  const accounts = await ctx.db.query("authAccounts").withIndex("userIdAndProvider", (q) => q.eq("userId", uid)).collect();
  for (const a of accounts) {
    await del(ctx, counts, "authVerificationCodes", await ctx.db.query("authVerificationCodes").withIndex("accountId", (q) => q.eq("accountId", a._id)).collect());
  }
  await del(ctx, counts, "authAccounts", accounts);
  // authVerifiers (transient PKCE rows, keyed only by `signature`) are left to
  // self-expire rather than full-scan per session — harmless dangling.
}

// ─── Keep-vs-delete classification ────────────────────────────────────

/**
 * Would this user be DELETED if `targetId` is deleted — considering ONLY their
 * own institution ties (memberships + home institution), NOT guardianship?
 * A user survives if they hold a membership at another institution or a
 * platform-admin (global) membership. Pure per-user; used both directly and to
 * evaluate a parent's children.
 */
export function wouldDeleteUser(
  user: Doc<"users">,
  memberships: Doc<"memberships">[],
  targetId: Id<"institutions">,
): boolean {
  // An authoritative global role (users.role) is never swept, even if the
  // matching membership drifted away — a platform admin / curriculum designer /
  // lifelong learner is not an institution's to delete.
  if (isGloballyPrivilegedRole(user.role)) return false;
  if (hasSurvivingMembership(memberships, targetId)) return false;
  // A surviving HOME school (users.institutionId) keeps the user even if they
  // hold a stray target membership: an EXPLICIT home at another institution, or
  // — for a scholar — an undefined home (treated as PRIMARY by convention, and
  // the primary is never the deletion target). Staff carry no meaningful home,
  // so an undefined home does not save them.
  if (user.institutionId !== undefined && user.institutionId !== targetId) return false;
  if (user.institutionId === undefined && user.role === ROLES.SCHOLAR) return false;
  // Remaining: home === target, or staff tied only via a target membership.
  const tiedToTarget =
    user.institutionId === targetId ||
    memberships.some((m) => m.institutionId === targetId);
  return tiedToTarget;
}

export type UserDecision =
  | { kind: "delete" }
  | { kind: "keep"; repointInstitutionId: Id<"institutions"> | undefined };

/**
 * The full decision for a candidate user, including the guardianship override:
 * a parent who guards at least one SURVIVING scholar is kept (their link to any
 * deleted child is removed when that child is purged).
 */
export async function decideUser(
  ctx: QueryCtx | MutationCtx,
  user: Doc<"users">,
  targetId: Id<"institutions">,
): Promise<UserDecision> {
  const memberships = await ctx.db
    .query("memberships")
    .withIndex("by_user", (q) => q.eq("userId", user._id))
    .collect();

  if (!wouldDeleteUser(user, memberships, targetId)) {
    return keepDecision(memberships, targetId, user.institutionId);
  }

  // Guardian-of-survivor override.
  const links = await ctx.db
    .query("guardianships")
    .withIndex("by_parent", (q) => q.eq("parentUserId", user._id))
    .collect();
  for (const link of links) {
    const child = await ctx.db.get(link.scholarUserId);
    if (!child) continue;
    const childMemberships = await ctx.db
      .query("memberships")
      .withIndex("by_user", (q) => q.eq("userId", child._id))
      .collect();
    if (!wouldDeleteUser(child, childMemberships, targetId)) {
      return keepDecision(memberships, targetId, user.institutionId);
    }
  }
  return { kind: "delete" };
}

function keepDecision(
  memberships: Doc<"memberships">[],
  targetId: Id<"institutions">,
  currentHome: Id<"institutions"> | undefined,
): UserDecision {
  return { kind: "keep", repointInstitutionId: pickRepoint(memberships, targetId, currentHome) };
}

/**
 * For a KEPT user whose home `institutionId` points at the target, choose a new
 * home from their remaining (non-target) institution-scoped memberships, or
 * `undefined` (→ treated as primary) when they have none. Users whose home
 * isn't the target keep their home unchanged.
 */
function pickRepoint(
  memberships: Doc<"memberships">[],
  targetId: Id<"institutions">,
  currentHome: Id<"institutions"> | undefined,
): Id<"institutions"> | undefined {
  if (currentHome !== targetId) return currentHome;
  const other = memberships.find(
    (m) => m.institutionId !== undefined && m.institutionId !== targetId,
  );
  return other?.institutionId;
}

/** Strip a KEPT user's ties to the target institution (idempotent). */
export async function keepStripUser(
  ctx: MutationCtx,
  counts: Counts,
  user: Doc<"users">,
  targetId: Id<"institutions">,
  repointInstitutionId: Id<"institutions"> | undefined,
) {
  const memberships = await ctx.db
    .query("memberships")
    .withIndex("by_user", (q) => q.eq("userId", user._id))
    .collect();
  const atTarget = memberships.filter((m) => m.institutionId === targetId);
  await del(ctx, counts, "memberships", atTarget);
  if (user.institutionId === targetId) {
    await ctx.db.patch(user._id, { institutionId: repointInstitutionId });
    bump(counts, "usersRepointed", 1);
    // A kept scholar's institution just changed (repointed elsewhere, or
    // stripped entirely) — same class of event as a direct institution
    // transfer. The reconciler's own freshOwner check already makes this
    // correct within one tick regardless (a scholar/claim institution
    // mismatch always locks), but nudge it now so a managed device doesn't
    // wait out the full interval after its owner's institution disappears.
    await scheduleClaimDecommissionLocksForScholar(ctx, user._id);
  }
}

// ─── Candidate discovery + helpers ────────────────────────────────────

/**
 * Distinct users tied to the target institution — via their home
 * `users.institutionId` OR a `memberships` row at the target. Bounded by
 * `limit`. Used by the preview (to classify) and by each deletion step (to
 * process a bounded slice; processing removes a user's tie, so successive steps
 * naturally paginate without a cursor).
 */
export async function collectCandidateUsers(
  ctx: QueryCtx | MutationCtx,
  targetId: Id<"institutions">,
  limit: number,
): Promise<Doc<"users">[]> {
  const seen = new Set<Id<"users">>();
  const out: Doc<"users">[] = [];
  const byHome = await ctx.db
    .query("users")
    .withIndex("by_institution", (q) => q.eq("institutionId", targetId))
    .take(limit);
  for (const u of byHome) {
    if (!seen.has(u._id)) {
      seen.add(u._id);
      out.push(u);
    }
  }
  if (out.length < limit) {
    const mems = await ctx.db
      .query("memberships")
      .withIndex("by_institution", (q) => q.eq("institutionId", targetId))
      .take(limit);
    for (const m of mems) {
      if (out.length >= limit) break;
      if (seen.has(m.userId)) continue;
      seen.add(m.userId);
      const u = await ctx.db.get(m.userId);
      if (u) out.push(u);
      // A membership whose user is already gone is a stray — swept by the
      // memberships phase, not here.
    }
  }
  return out;
}

export function totalCount(counts: Counts): number {
  let n = 0;
  for (const v of Object.values(counts)) n += v;
  return n;
}

/** Delete a bounded batch of memberships still pointing at the target. */
export async function deleteStrayMembershipsBatch(
  ctx: MutationCtx,
  counts: Counts,
  targetId: Id<"institutions">,
  budget: number,
): Promise<number> {
  const rows = await ctx.db
    .query("memberships")
    .withIndex("by_institution", (q) => q.eq("institutionId", targetId))
    .take(budget);
  await del(ctx, counts, "memberships", rows);
  return rows.length;
}

// ─── Institution-scoped row deletion ──────────────────────────────────
// Rows carrying `institutionId === target` that are NOT swept by a per-user
// purge (they belong to the institution itself, not a person). Bounded per
// call by `budget`; returns how many rows were deleted this call so the caller
// can loop until zero.

export async function deleteInstitutionScopedBatch(
  ctx: MutationCtx,
  counts: Counts,
  targetId: Id<"institutions">,
  budget: number,
): Promise<number> {
  let deleted = 0;
  const room = () => budget - deleted;

  // Indexed institution-scoped tables (by_institution), each with optional blobs.
  if (room() > 0) {
    const rows = await ctx.db.query("spaces").withIndex("by_institution", (q) => q.eq("institutionId", targetId)).take(room());
    await del(ctx, counts, "spaces", rows); deleted += rows.length;
  }
  if (room() > 0) {
    const rows = await ctx.db.query("equipment").withIndex("by_institution", (q) => q.eq("institutionId", targetId)).take(room());
    for (const r of rows) await delBlob(ctx, counts, r.photoStorageId ?? null);
    await del(ctx, counts, "equipment", rows); deleted += rows.length;
  }
  if (room() > 0) {
    const rows = await ctx.db
      .query("flairArt")
      .withIndex("by_institution_key", (q) =>
        q.eq("institutionId", targetId),
      )
      .take(room());
    for (const row of rows) {
      await delBlob(ctx, counts, row.imageStorageId ?? null);
    }
    await del(ctx, counts, "flairArt", rows);
    deleted += rows.length;
  }
  if (room() > 0) {
    const rows = await ctx.db.query("alertChannel").withIndex("by_institution", (q) => q.eq("institutionId", targetId)).take(room());
    await del(ctx, counts, "alertChannel", rows); deleted += rows.length;
  }
  if (room() > 0) {
    const rows = await ctx.db.query("institutionGoogleAccounts").withIndex("by_institution", (q) => q.eq("institutionId", targetId)).take(room());
    await del(ctx, counts, "institutionGoogleAccounts", rows); deleted += rows.length;
  }
  while (room() > 0) {
    const station = await ctx.db
      .query("captureStations")
      .withIndex("by_institution", (q) => q.eq("institutionId", targetId))
      .first();
    if (!station) break;
    if (station.enabled || !station.revokedAt) {
      await ctx.db.patch(station._id, {
        enabled: false,
        revokedAt: Date.now(),
      });
    }
    const captures = await ctx.db
      .query("captureStationCaptures")
      .withIndex("by_station", (q) => q.eq("captureStationId", station._id))
      .take(room());
    for (const capture of captures) {
      if (!(await ctx.db.get(capture.portfolioItemId))) {
        await delBlob(ctx, counts, capture.storageId);
      }
    }
    await del(ctx, counts, "captureStationCaptures", captures);
    deleted += captures.length;
    if (room() > 0) {
      const reservations = await ctx.db
        .query("captureStationUploadReservations")
        .withIndex("by_station", (q) =>
          q.eq("captureStationId", station._id),
        )
        .take(room());
      for (const reservation of reservations) {
        if (reservation.status !== "finalized" && reservation.storageId) {
          await delBlob(ctx, counts, reservation.storageId);
        }
      }
      await del(ctx, counts, "captureStationUploadReservations", reservations);
      deleted += reservations.length;
    }
    if (room() > 0) {
      const sessions = await ctx.db
        .query("captureStationSessions")
        .withIndex("by_station", (q) => q.eq("captureStationId", station._id))
        .take(room());
      await del(ctx, counts, "captureStationSessions", sessions);
      deleted += sessions.length;
    }
    if (room() > 0) {
      const [remainingCapture, remainingReservation, remainingSession] =
        await Promise.all([
          ctx.db
            .query("captureStationCaptures")
            .withIndex("by_station", (q) =>
              q.eq("captureStationId", station._id),
            )
            .first(),
          ctx.db
            .query("captureStationUploadReservations")
            .withIndex("by_station", (q) =>
              q.eq("captureStationId", station._id),
            )
            .first(),
          ctx.db
            .query("captureStationSessions")
            .withIndex("by_station", (q) =>
              q.eq("captureStationId", station._id),
            )
            .first(),
        ]);
      if (!remainingCapture && !remainingReservation && !remainingSession) {
        await ctx.db.delete(station._id);
        bump(counts, "captureStations", 1);
        deleted += 1;
      }
    }
  }
  while (room() > 0) {
    const item = await ctx.db
      .query("portfolioItems")
      .withIndex("by_institution", (q) => q.eq("institutionId", targetId))
      .first();
    if (!item) break;
    const attributions = await ctx.db
      .query("portfolioAttributions")
      .withIndex("by_item", (q) => q.eq("portfolioItemId", item._id))
      .take(room());
    await del(ctx, counts, "portfolioAttributions", attributions);
    deleted += attributions.length;
    if (room() > 0) {
      const captures = await ctx.db
        .query("captureStationCaptures")
        .withIndex("by_portfolio_item", (q) =>
          q.eq("portfolioItemId", item._id),
        )
        .take(room());
      await del(ctx, counts, "captureStationCaptures", captures);
      deleted += captures.length;
    }
    if (room() > 0) {
      const [remainingAttribution, remainingCapture] = await Promise.all([
        ctx.db
          .query("portfolioAttributions")
          .withIndex("by_item", (q) => q.eq("portfolioItemId", item._id))
          .first(),
        ctx.db
          .query("captureStationCaptures")
          .withIndex("by_portfolio_item", (q) =>
            q.eq("portfolioItemId", item._id),
          )
          .first(),
      ]);
      if (!remainingAttribution && !remainingCapture) {
        await delBlob(ctx, counts, item.fileStorageId ?? null);
        await delBlob(ctx, counts, item.thumbStorageId ?? null);
        await delBlob(ctx, counts, item.magicStorageId ?? null);
        await delBlob(ctx, counts, item.magicThumbStorageId ?? null);
        await ctx.db.delete(item._id);
        bump(counts, "portfolioItems", 1);
        deleted += 1;
      }
    }
  }
  if (room() > 0) {
    const rows = await ctx.db.query("driveSyncState").withIndex("by_institution", (q) => q.eq("institutionId", targetId)).take(room());
    await del(ctx, counts, "driveSyncState", rows); deleted += rows.length;
  }
  if (room() > 0) {
    const rows = await ctx.db.query("schoolClosures").withIndex("by_institution", (q) => q.eq("institutionId", targetId)).take(room());
    await del(ctx, counts, "schoolClosures", rows); deleted += rows.length;
  }
  if (room() > 0) {
    const rows = await ctx.db.query("roomCues").withIndex("by_institution", (q) => q.eq("institutionId", targetId)).take(room());
    await del(ctx, counts, "roomCues", rows); deleted += rows.length;
  }
  if (room() > 0) {
    const rows = await ctx.db.query("institutionInvites").withIndex("by_institution", (q) => q.eq("institutionId", targetId)).take(room());
    await del(ctx, counts, "institutionInvites", rows); deleted += rows.length;
  }
  if (room() > 0) {
    // Delete grants before their groups: capability audit remains useful only
    // while its institution and scoped resource still exist.
    const rows = await ctx.db
      .query("staffCapabilityGrants")
      .withIndex("by_institution_capability", (q) =>
        q.eq("institutionId", targetId),
      )
      .take(room());
    await del(ctx, counts, "staffCapabilityGrants", rows);
    deleted += rows.length;
  }

  // Non-indexed institution-scoped tables (now all have by_institution).
  if (room() > 0) {
    const rows = await ctx.db.query("scholarGroups").withIndex("by_institution", (q) => q.eq("institutionId", targetId)).take(room());
    // A group's own row is its authorization boundary — deleting it can strip
    // a SURVIVING scholar's sole route to a managed-native tile (Phase 1 above
    // already purged/stripped every tied user, so any scholarIds still listed
    // here belong to scholars who kept their account via another tie). Reuse
    // scholarGroups.ts's own recheck so this bulk path can't leave a stale
    // device unlock open past the group's deletion.
    for (const g of rows) {
      if (g.scholarIds.length > 0) {
        await recheckUnlocksForRemovedMembers(ctx, g._id, g.scholarIds);
      }
    }
    await del(ctx, counts, "scholarGroups", rows); deleted += rows.length;
  }
  if (room() > 0) {
    const rows = await ctx.db.query("usageEvents").withIndex("by_institution", (q) => q.eq("institutionId", targetId)).take(room());
    await del(ctx, counts, "usageEvents", rows); deleted += rows.length;
  }
  if (room() > 0) {
    const rows = await ctx.db.query("medicalClearanceRequests").withIndex("by_institution", (q) => q.eq("institutionId", targetId)).take(room());
    await del(ctx, counts, "medicalClearanceRequests", rows); deleted += rows.length;
  }
  if (room() > 0) {
    const rows = await ctx.db.query("scholarReviewEntries").withIndex("by_institution", (q) => q.eq("institutionId", targetId)).take(room());
    await del(ctx, counts, "scholarReviewEntries", rows); deleted += rows.length;
  }
  if (room() > 0) {
    const rows = await ctx.db.query("scholarReviewMeetings").withIndex("by_institution_period_weekKey", (q) => q.eq("institutionId", targetId)).take(room());
    await del(ctx, counts, "scholarReviewMeetings", rows); deleted += rows.length;
  }
  if (room() > 0) {
    const rows = await ctx.db.query("selSyntheses").withIndex("by_institution_week", (q) => q.eq("institutionId", targetId)).take(room());
    await del(ctx, counts, "selSyntheses", rows); deleted += rows.length;
  }
  if (room() > 0) {
    const rows = await ctx.db.query("sweepFindings").withIndex("by_institution_lastSeenAt", (q) => q.eq("institutionId", targetId)).take(room());
    await del(ctx, counts, "sweepFindings", rows); deleted += rows.length;
  }
  if (room() > 0) {
    const rows = await ctx.db.query("improvementTraces").withIndex("by_institution_createdAt", (q) => q.eq("institutionId", targetId)).take(room());
    await del(ctx, counts, "improvementTraces", rows); deleted += rows.length;
  }
  if (room() > 0) {
    const rows = await ctx.db.query("coherenceScanStates").withIndex("by_institution", (q) => q.eq("institutionId", targetId)).take(room());
    await del(ctx, counts, "coherenceScanStates", rows); deleted += rows.length;
  }

  // reportingPeriods (+ their schedule blocks/placements).
  if (room() > 0) {
    const periods = await ctx.db.query("reportingPeriods").withIndex("by_institution", (q) => q.eq("institutionId", targetId)).take(room());
    for (const p of periods) {
      const placements = await ctx.db.query("schedulePlacements").withIndex("by_period", (q) => q.eq("periodId", p._id)).collect();
      // A period-wide bulk delete is NOT scoped to activity-linked rows, so
      // it can include a standing-assignment app placement — settle its
      // push before the row disappears (masterSchedule.settlePlacementAppPush),
      // same as every other schedulePlacements deletion path.
      for (const placement of placements) {
        await settlePlacementAppPush(ctx, placement);
      }
      await del(ctx, counts, "schedulePlacements", placements);
      await del(ctx, counts, "scheduleBlocks", await ctx.db.query("scheduleBlocks").withIndex("by_period", (q) => q.eq("periodId", p._id)).collect());
    }
    await del(ctx, counts, "reportingPeriods", periods); deleted += periods.length;
  }

  return deleted;
}

/**
 * Delete a bounded batch of curriculum units owned by the institution
 * (units.institutionId === target), each with its full lesson/activity tree.
 * Returns how many unit trees were deleted this call.
 */
export async function deleteInstitutionUnitsBatch(
  ctx: MutationCtx,
  counts: Counts,
  targetId: Id<"institutions">,
  maxUnits: number,
): Promise<number> {
  const units = await ctx.db
    .query("units")
    .withIndex("by_institution", (q) => q.eq("institutionId", targetId))
    .take(maxUnits);
  for (const u of units) await deleteUnitTree(ctx, counts, u._id);
  return units.length;
}
