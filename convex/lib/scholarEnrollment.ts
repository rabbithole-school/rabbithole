import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { ROLES, isPlatformAdminRole, isStaffRole } from "./roles";
import { recheckUnlocksForRemovedMembers } from "./scholarGroupUnlocks";

type EnrollmentCtx = Pick<QueryCtx | MutationCtx, "db">;
// Needs "scheduler" too: a real transfer that scrubs stale cross-institution
// group memberships also has to schedule a device-unlock revocation recheck
// for any scholar it just dropped (recheckUnlocksForRemovedMembers below).
type EnrollmentMutationCtx = Pick<MutationCtx, "db" | "scheduler">;

/**
 * Widen-phase enrollment read: the legacy user field wins while it exists,
 * otherwise the single scholar membership is authoritative.
 */
export async function scholarInstitutionId(
  ctx: EnrollmentCtx,
  scholarId: Id<"users">,
): Promise<Id<"institutions"> | undefined> {
  // The legacy field remains authoritative for primary scholar accounts during
  // the widen phase. Adult learner accounts have no scholar projection, so
  // their institution comes exclusively from the membership below.
  const scholar = await ctx.db.get(scholarId);
  if (scholar?.role === ROLES.SCHOLAR && scholar.institutionId) {
    return scholar.institutionId;
  }

  const memberships = await ctx.db
    .query("memberships")
    .withIndex("by_user_role", (q) =>
      q.eq("userId", scholarId).eq("role", ROLES.SCHOLAR),
    )
    .collect();
  if (memberships.length === 1) return memberships[0]?.institutionId;

  const lifelongMembership = await ctx.db
    .query("memberships")
    .withIndex("by_user_role", (q) =>
      q.eq("userId", scholarId).eq("role", ROLES.LIFELONG_LEARNER),
    )
    .first();
  if (scholar?.role === ROLES.LIFELONG_LEARNER || lifelongMembership) {
    return (
      await ctx.db
        .query("institutions")
        .withIndex("by_slug", (q) => q.eq("slug", "albatross-society"))
        .unique()
    )?._id;
  }
  return undefined;
}

export async function hasScholarMembership(
  ctx: EnrollmentCtx,
  userId: Id<"users">,
): Promise<boolean> {
  const user = await ctx.db.get(userId);
  if (!user) return false;
  if (
    user.role === ROLES.SCHOLAR ||
    user.role === ROLES.LIFELONG_LEARNER
  ) {
    return true;
  }
  const membership = await ctx.db
    .query("memberships")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .filter((q) =>
      q.or(
        q.eq(q.field("role"), ROLES.SCHOLAR),
        q.eq(q.field("role"), ROLES.LIFELONG_LEARNER),
      ),
    )
    .first();
  return membership !== null;
}

export async function requireActiveLearnerInstitution(
  ctx: EnrollmentCtx,
  userId: Id<"users">,
): Promise<Id<"institutions"> | undefined> {
  const institutionId = await scholarInstitutionId(ctx, userId);
  if (!institutionId) {
    const user = await ctx.db.get(userId);
    // Preserve unresolved legacy scholar accounts without guessing them into
    // the primary school. Migration audit rows make this state explicit.
    if (user?.role === ROLES.SCHOLAR) return undefined;
  }
  if (!institutionId) {
    throw new Error("A learner membership is required");
  }
  const institution = await ctx.db.get(institutionId);
  if (!institution) throw new Error("Learner institution not found");
  if (institution.disabledAt !== undefined) {
    throw new Error(
      "Your learning community's Rabbithole access is paused. Contact an administrator.",
    );
  }
  return institutionId;
}

/**
 * Enforce the institution attached to a self-owned session while preserving
 * staff rehearsals and other staff-owned sessions that are not learner work.
 */
export async function requireActiveSessionOwnerInstitution(
  ctx: EnrollmentCtx,
  user: Doc<"users">,
  session: Doc<"sessions">,
): Promise<void> {
  if (session.isTestDrive || session.userId !== user._id) return;

  const learnerInstitutionId = await scholarInstitutionId(ctx, session.userId);
  if (
    session.institutionId &&
    learnerInstitutionId !== session.institutionId
  ) {
    const memberships = await ctx.db
      .query("memberships")
      .withIndex("by_user", (q) => q.eq("userId", user._id))
      .collect();
    const hasStaffAccess =
      isPlatformAdminRole(user.role) ||
      memberships.some(
        (membership) =>
          membership.institutionId === session.institutionId &&
          isStaffRole(membership.role),
      );
    if (!hasStaffAccess) {
      await requireActiveLearnerInstitution(ctx, session.userId);
      throw new Error("Session is not in your learning community");
    }
  } else if (
    learnerInstitutionId ||
    (await hasScholarMembership(ctx, session.userId)) ||
    !isStaffRole(user.role)
  ) {
    await requireActiveLearnerInstitution(ctx, session.userId);
  }

  if (session.institutionId) {
    const sessionInstitution = await ctx.db.get(session.institutionId);
    if (
      sessionInstitution?.disabledAt !== undefined &&
      !isPlatformAdminRole(user.role)
    ) {
      throw new Error(
        "Your learning community's Rabbithole access is paused. Contact an administrator.",
      );
    }
  }
}

/**
 * Require a unit to belong to the learner's active institution.
 *
 * Legacy scholar-authored units may be unstamped, so their owner can continue
 * them after the adult-learning migration. Other unstamped units belong to the
 * primary institution, matching the catalog read boundary.
 */
export async function requireUnitInLearnerInstitution(
  ctx: EnrollmentCtx,
  userId: Id<"users">,
  learnerInstitutionId: Id<"institutions"> | undefined,
  unit: Doc<"units">,
): Promise<void> {
  if (unit.authorScholarId === userId) return;

  if (unit.institutionId) {
    if (unit.institutionId !== learnerInstitutionId) {
      throw new Error("Unit is not in your learning community");
    }
    return;
  }

  const primary = (await ctx.db.query("institutions").collect()).find(
    (institution) => institution.isPrimary,
  );
  if (primary && primary._id !== learnerInstitutionId) {
    throw new Error("Unit is not in your learning community");
  }
}

export async function scholarIdsForInstitution(
  ctx: EnrollmentCtx,
  institutionId: Id<"institutions">,
): Promise<Set<Id<"users">>> {
  const ids = new Set<Id<"users">>();
  const memberships = await ctx.db
    .query("memberships")
    .withIndex("by_institution_role", (q) =>
      q.eq("institutionId", institutionId).eq("role", ROLES.SCHOLAR),
    )
    .collect();
  for (const membership of memberships) ids.add(membership.userId);

  // Dual-read legacy school enrollments until users.institutionId is removed.
  const projected = await ctx.db
    .query("users")
    .withIndex("by_institution", (q) => q.eq("institutionId", institutionId))
    .collect();
  for (const user of projected) {
    if (user.role === ROLES.SCHOLAR) ids.add(user._id);
  }
  return ids;
}

export async function allScholarIds(
  ctx: EnrollmentCtx,
): Promise<Set<Id<"users">>> {
  const ids = new Set<Id<"users">>();
  const memberships = await ctx.db
    .query("memberships")
    .withIndex("by_role", (q) => q.eq("role", ROLES.SCHOLAR))
    .collect();
  for (const membership of memberships) ids.add(membership.userId);
  const projected = await ctx.db
    .query("users")
    .withIndex("by_role", (q) => q.eq("role", ROLES.SCHOLAR))
    .collect();
  for (const user of projected) ids.add(user._id);
  return ids;
}

export async function invalidatePendingGroupWork(
  ctx: EnrollmentMutationCtx,
  groupIds: Set<Id<"scholarGroups">>,
): Promise<void> {
  if (groupIds.size === 0) return;
  const queued = await ctx.db
    .query("slackNotificationQueue")
    .withIndex("by_sent", (q) => q.eq("sent", false))
    .collect();
  for (const row of queued) {
    if (groupIds.has(row.groupId)) {
      // Queue rows contain preformatted scholar names but no scholar id, so a
      // roster change invalidates every pending line for that group.
      await ctx.db.patch(row._id, { sent: true });
    }
  }
  const checkins = await ctx.db.query("eodCheckins").collect();
  for (const checkin of checkins) {
    if (
      checkin.lifecycle !== "completed" &&
      checkin.lifecycle !== "failed" &&
      checkin.groupIds.some((id) => groupIds.has(id))
    ) {
      await ctx.db.patch(checkin._id, {
        lifecycle: "failed",
        retryAt: undefined,
        lastError: "Cancelled after scholar enrollment changed",
      });
    }
  }
}

/**
 * Make one institution the scholar's only active enrollment. This is the
 * transition write chokepoint: it retains invite provenance when a prior
 * enrollment supplied it, mirrors the legacy field, and removes stale
 * cross-institution group memberships.
 */
export async function reconcileScholarEnrollment(
  ctx: EnrollmentMutationCtx,
  args: {
    scholarId: Id<"users">;
    institutionId: Id<"institutions">;
    createdBy?: Id<"users">;
    inviteId?: Id<"institutionInvites">;
    scrubGroups?: boolean;
  },
): Promise<void> {
  const scholar = await ctx.db.get(args.scholarId);
  if (!scholar) throw new Error("User not found");
  if (!(await ctx.db.get(args.institutionId))) {
    throw new Error("Institution not found");
  }

  const memberships = await ctx.db
    .query("memberships")
    .withIndex("by_user_role", (q) =>
      q.eq("userId", args.scholarId).eq("role", ROLES.SCHOLAR),
    )
    .collect();
  const matching = memberships.filter((m) => m.institutionId === args.institutionId);
  const keeper = matching[0];
  const projectedInstitutionId =
    scholar.role === ROLES.SCHOLAR ? scholar.institutionId : undefined;
  const enrollmentChanged =
    projectedInstitutionId !== args.institutionId ||
    memberships.length !== 1 ||
    matching.length !== 1;
  const hadDifferentEnrollment =
    projectedInstitutionId !== undefined &&
    projectedInstitutionId !== args.institutionId ||
    memberships.some((membership) => membership.institutionId !== args.institutionId);
  const previousInstitutionIds = new Set(
    [
      projectedInstitutionId,
      ...memberships.map((membership) => membership.institutionId),
    ].filter((id): id is Id<"institutions"> => id !== undefined),
  );
  // An invite proves how the scholar joined one specific institution. Never
  // carry an old school's invite onto a transfer to a different school.
  const provenance = args.inviteId ?? keeper?.inviteId;

  for (const membership of memberships) {
    if (membership._id !== keeper?._id) await ctx.db.delete(membership._id);
  }
  if (!keeper) {
    await ctx.db.insert("memberships", {
      userId: args.scholarId,
      role: ROLES.SCHOLAR,
      institutionId: args.institutionId,
      createdBy: args.createdBy,
      ...(provenance ? { inviteId: provenance } : {}),
    });
  } else if (args.inviteId && keeper.inviteId !== args.inviteId) {
    await ctx.db.patch(keeper._id, { inviteId: args.inviteId });
  }

  // Deliberate dual write until the users field is narrowed away.
  if (
    scholar.role === ROLES.SCHOLAR &&
    scholar.institutionId !== args.institutionId
  ) {
    await ctx.db.patch(args.scholarId, { institutionId: args.institutionId });
  }

  if (hadDifferentEnrollment && previousInstitutionIds.size > 0) {
    const sessions = await ctx.db
      .query("sessions")
      .withIndex("by_user", (q) => q.eq("userId", args.scholarId))
      .collect();
    for (const session of sessions) {
      if (
        session.isTestDrive ||
        session.title.startsWith("[Preflight] ") ||
        (session.institutionId &&
          !previousInstitutionIds.has(session.institutionId))
      ) {
        continue;
      }
      await ctx.db.patch(session._id, { institutionId: args.institutionId });
    }
  }

  const migrationIssue = await ctx.db
    .query("scholarEnrollmentMigrationIssues")
    .withIndex("by_scholar", (q) => q.eq("scholarId", args.scholarId))
    .unique();
  if (migrationIssue) await ctx.db.delete(migrationIssue._id);

  if (enrollmentChanged || args.scrubGroups) {
    const groups = await ctx.db.query("scholarGroups").collect();
    const scrubbedGroupIds = new Set<Id<"scholarGroups">>();
    for (const group of groups) {
      if (
        group.scholarIds.includes(args.scholarId) &&
        (group.institutionId
          ? group.institutionId !== args.institutionId
          : hadDifferentEnrollment)
      ) {
        // An unstamped legacy group cannot prove it belongs to the destination.
        // On a real transfer, remove the scholar rather than leak them through
        // an old roster; ordinary idempotent reconciliation leaves it alone.
        await ctx.db.patch(group._id, {
          scholarIds: group.scholarIds.filter((id) => id !== args.scholarId),
        });
        scrubbedGroupIds.add(group._id);
        // The scrubbed group may have been this scholar's sole route to a
        // managed-native tile's authorization (via an appAudiences group
        // grant) — reuse the same force-close path scholarGroups.ts itself
        // uses on setScholars/removeScholar/remove, so a real institution
        // transfer can't leave a stale device unlock open up to 8h.
        await recheckUnlocksForRemovedMembers(ctx, group._id, [
          args.scholarId,
        ]);
      }
    }
    await invalidatePendingGroupWork(ctx, scrubbedGroupIds);
  }
}
