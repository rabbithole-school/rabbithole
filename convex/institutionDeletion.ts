/**
 * INSTITUTION CASCADE-DELETE — the gated, batched, audited operation.
 *
 * The most destructive action in Rabbithole: deleting an entire institution and
 * everything scoped to it. The blast-radius logic lives in lib/cascade.ts; this
 * file is the safety envelope around it:
 *
 *   1. PRIMARY IS UNDELETABLE. The primary institution in production is
 *      refused server-side — a hard throw, never merely a hidden button.
 *   2. PREVIEW BEFORE DESTROY. `previewDeletion` returns EXACT counts of what
 *      will be deleted; the modal shows real numbers, not generic warning copy.
 *   3. TYPE-TO-CONFIRM. `requestDeletion` re-verifies the admin typed the
 *      institution's exact name before anything is deleted.
 *   4. AUTHORIZATION. A platform_admin may delete any non-primary institution;
 *      a school_admin may delete ONLY an institution where they hold a
 *      school_admin membership.
 *   5. BATCHED + RESUMABLE. An internal action drives idempotent, bounded
 *      internal-mutation steps, so thousands of documents delete without
 *      exceeding a single mutation's limits and a half-finished run re-runs
 *      safely.
 *   6. AUDITED. A durable `institutionDeletions` row (outside the tenant, so it
 *      survives) records who deleted what and when; an `auditLog` entry mirrors
 *      it into the global admin trail.
 *   7. MULTI-INSTITUTION USERS SURVIVE. A user with a membership at another
 *      institution, a platform-admin membership, or a surviving guarded scholar
 *      is KEPT — only their target-institution membership is removed.
 */
import { v } from "convex/values";
import {
  internalAction,
  internalMutation,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { schoolAdminQuery, schoolAdminMutation } from "./lib/customFunctions";
import { ROLES, isPlatformAdminRole, isStaffRole } from "./lib/roles";
import {
  type Counts,
  bump,
  totalCount,
  collectCandidateUsers,
  decideUser,
  purgeUserInner,
  keepStripUser,
  deleteInstitutionSessionsBatch,
  deleteInstitutionUnitsBatch,
  deleteInstitutionScopedBatch,
  deleteStrayMembershipsBatch,
} from "./lib/cascade";

// ─── Batching budgets ─────────────────────────────────────────────────
// Kept well under a single Convex mutation's write ceiling so each step is a
// small, atomic transaction. The internal action loops steps until done.
const USERS_PER_STEP = 20;
const DOC_BUDGET = 2000; // soft per-step document budget for user/scoped work
const UNITS_PER_STEP = 25;
const MAX_ACTION_ITERS = 500; // steps per action invocation before rescheduling

// Preview read budgets — a preview is a read-only query, so it must stay under
// the query read ceiling even for a large school. Counts hitting a cap are
// reported with `capped: true` (the modal shows "N+").
const CANDIDATE_CAP = 3000;
const FOOTPRINT_READ_BUDGET = 8000;

// ─── Authorization ────────────────────────────────────────────────────

/**
 * Whether `user` may delete `institution`, and why not. Platform admins may
 * delete any NON-PRIMARY institution; a school_admin may delete only an
 * institution where they hold a school_admin membership. The primary
 * institution is undeletable for everyone.
 */
async function deletionAuthorization(
  ctx: QueryCtx | MutationCtx,
  user: Doc<"users">,
  institution: Doc<"institutions">,
): Promise<{
  canDelete: boolean;
  reason: string | null;
  isPlatformAdmin: boolean;
  isSchoolAdminHere: boolean;
}> {
  const memberships = await ctx.db
    .query("memberships")
    .withIndex("by_user", (q) => q.eq("userId", user._id))
    .collect();
  const isPlatformAdmin =
    isPlatformAdminRole(user.role) || memberships.some((m) => isPlatformAdminRole(m.role));
  const isSchoolAdminHere = memberships.some(
    (m) => m.role === ROLES.SCHOOL_ADMIN && m.institutionId === institution._id,
  );

  if (institution.isPrimary) {
    return {
      canDelete: false,
      reason: "The primary institution cannot be deleted.",
      isPlatformAdmin,
      isSchoolAdminHere,
    };
  }
  if (isPlatformAdmin) return { canDelete: true, reason: null, isPlatformAdmin, isSchoolAdminHere };
  if (isSchoolAdminHere) return { canDelete: true, reason: null, isPlatformAdmin, isSchoolAdminHere };

  return {
    canDelete: false,
    reason: "You can only delete a school you administer.",
    isPlatformAdmin,
    isSchoolAdminHere,
  };
}

// ─── Preview (exact counts before destroy) ────────────────────────────

type Footprint = {
  scholars: number;
  staff: number;
  otherAccounts: number; // parents / lifelong learners tied solely to this school
  survivingAccounts: number; // multi-institution users kept (membership removed)
  sessions: number;
  messages: number;
  artifacts: number;
  assignments: number;
  units: number;
  guardianships: number;
  healthRecords: number;
  invites: number;
  usageEvents: number;
  portfolioItems: number;
  capped: boolean; // any count hit a read cap (real number is higher)
};

async function computeFootprint(
  ctx: QueryCtx,
  targetId: Id<"institutions">,
): Promise<Footprint> {
  const budget = { left: FOOTPRINT_READ_BUDGET };
  let capped = false;
  const spend = (n: number) => {
    budget.left -= n;
    if (budget.left <= 0) capped = true;
  };

  const candidates = await collectCandidateUsers(ctx, targetId, CANDIDATE_CAP);
  if (candidates.length >= CANDIDATE_CAP) capped = true;
  spend(candidates.length);

  const deleteScholars: Doc<"users">[] = [];
  const deleteUsers: Doc<"users">[] = [];
  let scholars = 0;
  let staff = 0;
  let otherAccounts = 0;
  let survivingAccounts = 0;
  for (const u of candidates) {
    const decision = await decideUser(ctx, u, targetId);
    spend(1);
    if (decision.kind === "keep") {
      survivingAccounts++;
      continue;
    }
    deleteUsers.push(u);
    if (u.role === ROLES.SCHOLAR) {
      scholars++;
      deleteScholars.push(u);
    } else if (isStaffRole(u.role)) {
      staff++;
    } else {
      otherAccounts++;
    }
  }

  let sessions = 0;
  let messages = 0;
  let artifacts = 0;
  const countedSessionIds = new Set<Id<"sessions">>();
  let assignments = 0;
  let guardianships = 0;
  let healthRecords = 0;

  // Sessions + their messages/artifacts, for every DELETED user (scholars are
  // the bulk, but staff can own sessions too via test-drive). Bounded by budget.
  for (const u of deleteUsers) {
    if (budget.left <= 0) break;
    const userSessions = await ctx.db
      .query("sessions")
      .withIndex("by_user", (q) => q.eq("userId", u._id))
      .take(budget.left);
    sessions += userSessions.length;
    spend(userSessions.length);
    for (const s of userSessions) {
      countedSessionIds.add(s._id);
      if (budget.left <= 0) break;
      const msgs = await ctx.db
        .query("messages")
        .withIndex("by_session", (q) => q.eq("sessionId", s._id))
        .take(budget.left);
      messages += msgs.length;
      spend(msgs.length);
      if (budget.left <= 0) break;
      const arts = await ctx.db
        .query("artifacts")
        .withIndex("by_session", (q) => q.eq("sessionId", s._id))
        .take(budget.left);
      artifacts += arts.length;
      spend(arts.length);
    }
  }

  // Tenant-stamped sessions can belong to an account that survives through a
  // separate parent/staff/global role. Include that institution-owned learning
  // record in the preview without double-counting sessions above.
  if (budget.left > 0) {
    const tenantSessions = await ctx.db
      .query("sessions")
      .withIndex("by_institution", (q) => q.eq("institutionId", targetId))
      .take(budget.left);
    spend(tenantSessions.length);
    for (const session of tenantSessions) {
      if (countedSessionIds.has(session._id) || budget.left <= 0) continue;
      countedSessionIds.add(session._id);
      sessions++;
      const msgs = await ctx.db
        .query("messages")
        .withIndex("by_session", (q) => q.eq("sessionId", session._id))
        .take(budget.left);
      messages += msgs.length;
      spend(msgs.length);
      if (budget.left <= 0) break;
      const arts = await ctx.db
        .query("artifacts")
        .withIndex("by_session", (q) => q.eq("sessionId", session._id))
        .take(budget.left);
      artifacts += arts.length;
      spend(arts.length);
    }
  }

  // Assignments authored by deleted staff.
  for (const u of deleteUsers) {
    if (budget.left <= 0) break;
    if (u.role === ROLES.SCHOLAR) continue;
    const rows = await ctx.db
      .query("assignments")
      .withIndex("by_teacher", (q) => q.eq("teacherId", u._id))
      .take(budget.left);
    assignments += rows.length;
    spend(rows.length);
  }

  // Guardianship links to deleted scholars.
  for (const s of deleteScholars) {
    if (budget.left <= 0) break;
    const links = await ctx.db
      .query("guardianships")
      .withIndex("by_scholar", (q) => q.eq("scholarUserId", s._id))
      .take(budget.left);
    guardianships += links.length;
    spend(links.length);
    const hr = await ctx.db
      .query("scholarHealthRecords")
      .withIndex("by_scholar", (q) => q.eq("scholarId", s._id))
      .take(budget.left);
    healthRecords += hr.length;
    spend(hr.length);
  }

  // Institution-scoped headline tables (all now have by_institution).
  const units = (
    await ctx.db
      .query("units")
      .withIndex("by_institution", (q) => q.eq("institutionId", targetId))
      .take(budget.left)
  ).length;
  spend(units);
  const invites = (
    await ctx.db
      .query("institutionInvites")
      .withIndex("by_institution", (q) => q.eq("institutionId", targetId))
      .take(budget.left)
  ).length;
  spend(invites);
  const usageEvents = (
    await ctx.db
      .query("usageEvents")
      .withIndex("by_institution", (q) => q.eq("institutionId", targetId))
      .take(budget.left)
  ).length;
  spend(usageEvents);
  const portfolioInst = (
    await ctx.db
      .query("portfolioItems")
      .withIndex("by_institution", (q) => q.eq("institutionId", targetId))
      .take(budget.left)
  ).length;
  spend(portfolioInst);

  if (budget.left <= 0) capped = true;

  return {
    scholars,
    staff,
    otherAccounts,
    survivingAccounts,
    sessions,
    messages,
    artifacts,
    assignments,
    units,
    guardianships,
    healthRecords,
    invites,
    usageEvents,
    portfolioItems: portfolioInst,
    capped,
  };
}

/**
 * Read-only preview of an institution deletion: the exact counts the modal
 * shows, plus whether the caller can delete it and whether deleting it would
 * delete the caller's OWN account (a school_admin deleting their own school).
 */
export const previewDeletion = schoolAdminQuery({
  args: { institutionId: v.id("institutions") },
  handler: async (ctx, args) => {
    const institution = await ctx.db.get(args.institutionId);
    if (!institution) throw new Error("Institution not found");

    const authz = await deletionAuthorization(ctx, ctx.user, institution);
    // A school_admin may only preview a school they administer; a platform admin
    // may preview any. This holds for the PRIMARY too (its own school_admin can
    // preview, but canDelete stays false) — so another school's admin can never
    // read the primary's footprint.
    if (!authz.isPlatformAdmin && !authz.isSchoolAdminHere) {
      throw new Error("Forbidden: not your institution");
    }

    const selfDecision = await decideUser(ctx, ctx.user, args.institutionId);

    return {
      institutionId: institution._id,
      name: institution.name,
      slug: institution.slug,
      isPrimary: institution.isPrimary ?? false,
      canDelete: authz.canDelete,
      reason: authz.reason,
      deletingSelf: selfDecision.kind === "delete",
      footprint: await computeFootprint(ctx, args.institutionId),
    };
  },
});

// ─── Request (gated, type-to-confirm) ─────────────────────────────────

export const requestDeletion = schoolAdminMutation({
  args: {
    institutionId: v.id("institutions"),
    typedName: v.string(),
  },
  handler: async (ctx, args) => {
    const institution = await ctx.db.get(args.institutionId);
    if (!institution) throw new Error("Institution not found");

    // 1. Authorization (platform_admin any non-primary; school_admin own only).
    const authz = await deletionAuthorization(ctx, ctx.user, institution);

    // 2. PRIMARY IS UNDELETABLE — hard refusal, server-side.
    if (institution.isPrimary) {
      throw new Error("The primary institution cannot be deleted.");
    }
    if (!authz.canDelete) {
      throw new Error(authz.reason ?? "Forbidden: cannot delete this institution");
    }

    // 3. TYPE-TO-CONFIRM — the typed name must match exactly (trimmed).
    if (args.typedName.trim() !== institution.name) {
      throw new Error("The typed name does not match the school's name.");
    }

    // Idempotency: if a delete for this institution is already running, return it
    // rather than starting a second driver.
    const existing = await ctx.db
      .query("institutionDeletions")
      .withIndex("by_institution", (q) => q.eq("institutionId", institution._id))
      .filter((q) => q.eq(q.field("status"), "running"))
      .first();
    if (existing) {
      const selfDecisionExisting = await decideUser(ctx, ctx.user, institution._id);
      return { jobId: existing._id, deletingSelf: selfDecisionExisting.kind === "delete" };
    }

    // Does deleting this school delete the requester's own account?
    const selfDecision = await decideUser(ctx, ctx.user, institution._id);
    const deletingSelf = selfDecision.kind === "delete";

    const now = Date.now();
    const jobId = await ctx.db.insert("institutionDeletions", {
      institutionId: institution._id,
      institutionName: institution.name,
      institutionSlug: institution.slug,
      requestedByUserId: ctx.user._id,
      requestedByName: ctx.user.name,
      requestedByUsername: ctx.user.username,
      requestedByRole: ctx.user.role,
      typedName: args.typedName.trim(),
      deletingSelf,
      status: "running",
      phase: "users",
      startedAt: now,
      counts: {},
    });

    // Mirror into the global admin audit trail (impersonation's convention).
    await ctx.db.insert("auditLog", {
      actorUserId: ctx.user._id,
      action: "institution.delete",
      at: now,
      detail: `Deleting institution "${institution.name}" (${institution.slug})`,
    });

    await ctx.scheduler.runAfter(0, internal.institutionDeletion.runDeletion, {
      jobId,
    });

    return { jobId, deletingSelf };
  },
});

// ─── Status (progress for the UI) ─────────────────────────────────────

export const deletionStatus = schoolAdminQuery({
  args: { jobId: v.id("institutionDeletions") },
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.jobId);
    if (!job) return null;
    // Only the requester or a platform admin may read the job.
    const isPlatformAdmin = isPlatformAdminRole(ctx.user.role);
    if (!isPlatformAdmin && job.requestedByUserId !== ctx.user._id) {
      throw new Error("Forbidden");
    }
    return {
      status: job.status,
      phase: job.phase,
      counts: job.counts ?? {},
      totalDeleted: totalCount(job.counts ?? {}),
      error: job.error ?? null,
      completedAt: job.completedAt ?? null,
      institutionName: job.institutionName,
    };
  },
});

// ─── Driver (internal action) ─────────────────────────────────────────

export const runDeletion = internalAction({
  args: { jobId: v.id("institutionDeletions") },
  handler: async (ctx, args) => {
    for (let i = 0; i < MAX_ACTION_ITERS; i++) {
      let done: boolean;
      try {
        const res = await ctx.runMutation(
          internal.institutionDeletion.deletionStep,
          { jobId: args.jobId },
        );
        done = res.done;
      } catch (e) {
        await ctx.runMutation(internal.institutionDeletion.markFailed, {
          jobId: args.jobId,
          error: e instanceof Error ? e.message : String(e),
        });
        return;
      }
      if (done) return;
    }
    // Not finished within this action's iteration budget — reschedule so the
    // job is fully resumable across action lifetimes.
    await ctx.scheduler.runAfter(0, internal.institutionDeletion.runDeletion, {
      jobId: args.jobId,
    });
  },
});

// ─── One bounded, idempotent step ─────────────────────────────────────

export const deletionStep = internalMutation({
  args: { jobId: v.id("institutionDeletions") },
  handler: async (ctx, args): Promise<{ done: boolean }> => {
    const job = await ctx.db.get(args.jobId);
    if (!job || job.status !== "running") return { done: true };
    const targetId = job.institutionId;
    const counts: Counts = { ...(job.counts ?? {}) };

    const save = async (phase: string) => {
      await ctx.db.patch(args.jobId, { counts, phase });
    };

    // Phase 1 — USERS: delete-or-strip a bounded slice of tied users.
    const processed = await processUsersBatch(ctx, targetId, counts);
    if (processed > 0) {
      await save("users");
      return { done: false };
    }

    // Phase 2 — TENANT-STAMPED SESSIONS whose account survives because it also
    // belongs to another institution or holds a separate global role.
    const sessions = await deleteInstitutionSessionsBatch(ctx, counts, targetId);
    if (sessions > 0) {
      await save("sessions");
      return { done: false };
    }

    // Phase 3 — INSTITUTION UNITS: curriculum owned by the institution but
    // authored by a KEPT teacher (a deleted teacher's units went with them).
    const units = await deleteInstitutionUnitsBatch(ctx, counts, targetId, UNITS_PER_STEP);
    if (units > 0) {
      await save("units");
      return { done: false };
    }

    // Phase 4 — INSTITUTION-SCOPED ROWS (spaces, equipment, groups, usage,
    // reporting periods, invites, portfolio, closures, …).
    const scoped = await deleteInstitutionScopedBatch(ctx, counts, targetId, DOC_BUDGET);
    if (scoped > 0) {
      await save("institutionScoped");
      return { done: false };
    }

    // Phase 5 — STRAY MEMBERSHIPS at the target (safety sweep).
    const strays = await deleteStrayMembershipsBatch(ctx, counts, targetId, DOC_BUDGET);
    if (strays > 0) {
      await save("memberships");
      return { done: false };
    }

    // Phase 6 — FINALIZE: the institution's own blob + row, then close the job.
    const institution = await ctx.db.get(targetId);
    if (institution) {
      if (institution.logoStorageId) {
        try {
          await ctx.storage.delete(institution.logoStorageId);
          bump(counts, "_storage", 1);
        } catch {
          // already gone
        }
      }
      await ctx.db.delete(targetId);
      bump(counts, "institutions", 1);
    }
    await ctx.db.patch(args.jobId, {
      counts,
      phase: "done",
      status: "completed",
      completedAt: Date.now(),
    });
    return { done: true };
  },
});

async function processUsersBatch(
  ctx: MutationCtx,
  targetId: Id<"institutions">,
  counts: Counts,
): Promise<number> {
  const candidates = await collectCandidateUsers(ctx, targetId, USERS_PER_STEP);
  if (candidates.length === 0) return 0;
  const before = totalCount(counts);
  let processed = 0;
  for (const user of candidates) {
    const decision = await decideUser(ctx, user, targetId);
    if (decision.kind === "delete") {
      await purgeUserInner(ctx, counts, user._id, targetId);
    } else {
      await keepStripUser(ctx, counts, user, targetId, decision.repointInstitutionId);
    }
    processed++;
    // Keep each step's transaction small; at least one user always makes progress.
    if (totalCount(counts) - before >= DOC_BUDGET) break;
  }
  return processed;
}

export const markFailed = internalMutation({
  args: { jobId: v.id("institutionDeletions"), error: v.string() },
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.jobId);
    if (!job || job.status !== "running") return;
    await ctx.db.patch(args.jobId, { status: "failed", error: args.error });
  },
});
