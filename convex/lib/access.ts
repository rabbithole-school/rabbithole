// The access chokepoint: "which scholars can this membership (context) see."
//
// One pure-ish resolver, FAIL-CLOSED: any role/shape we don't explicitly
// widen gets the empty set, so a forgotten case denies rather than leaks.
// Mirrors the parent role's existing `allowedScholarIds` scoping precedent
// (convex/lib/scholarReads.ts) — the goal is a single source of truth that
// every per-scholar read/write + the AI aide + MCP can lean on.
//
// IMPORTANT: this is the BOUNDARY ("whose data"), independent of field-level
// redaction ("which fields" — e.g. operations staff never see reading level). Keep
// the two layers separate.

import type { MutationCtx, QueryCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import {
  ROLES,
  isPlatformAdminRole,
  isTeacherRole,
  isGloballyPrivilegedMembership,
  isGloballyPrivilegedRole,
  isStaffRole,
  type Role,
} from "./roles";
import {
  hasActiveInstitutionCapability,
  hasActiveStaffMembershipAtInstitution,
  hasSchoolOperationsAccessAtInstitution,
  schoolOperationsInstitutionIds,
} from "./staffCapabilities";
import {
  allScholarIds,
  hasScholarMembership,
  scholarIdsForInstitution,
  scholarInstitutionId,
} from "./scholarEnrollment";
import { primaryInstitutionId } from "./primaryInstitution";

// The non-alarming message a suspended member sees. Kept here (the enforcement
// home) so the server throw and the client paused-screen use one string.
export const INSTITUTION_SUSPENDED_MESSAGE =
  "Your school's Rabbithole access is paused. Contact your school administrator.";

// The minimal shape of the active membership the resolver needs. Always
// derive these from the membership ROW (server-validated), never from a
// client-sent role/institution value.
export type ActiveMembership = Pick<
  Doc<"memberships">,
  "userId" | "role" | "institutionId"
>;

/**
 * Platform-admin standing comes from `users.role` alone (TRA-375). A
 * platform_admin MEMBERSHIP whose user no longer holds the role — a stale row
 * a role change didn't retire — confers nothing.
 */
async function holdsPlatformAdminRole(
  ctx: QueryCtx,
  membership: ActiveMembership,
): Promise<boolean> {
  const user = await ctx.db.get(membership.userId);
  return !!user && isPlatformAdminRole(user.role);
}

/**
 * The set of scholar user-ids the given membership may access.
 *
 *   platform_admin                         → every scholar (global)
 *   parent                                 → their guardianship children
 *   teacher|operations staff|school_admin @ X     → scholars whose institutionId === X
 *   curriculum_designer | scholar          → ∅ (no scholar-data access here)
 *   institution-scoped role with NO institution → ∅ (fail-closed)
 */
export async function accessibleScholarIds(
  ctx: QueryCtx,
  membership: ActiveMembership,
): Promise<Set<Id<"users">>> {
  if (isPlatformAdminRole(membership.role)) {
    return (await holdsPlatformAdminRole(ctx, membership))
      ? await allScholarIds(ctx)
      : new Set();
  }

  if (membership.role === ROLES.PARENT) {
    const links = await ctx.db
      .query("guardianships")
      .withIndex("by_parent", (q) => q.eq("parentUserId", membership.userId))
      .collect();
    return new Set(links.map((l) => l.scholarUserId));
  }

  if (membership.institutionId) {
    const institution = await ctx.db.get(membership.institutionId);
    if (!institution || institution.disabledAt !== undefined) return new Set();
  }

  if (
    (membership.role === ROLES.TEACHER ||
      membership.role === ROLES.SCHOOL_ADMIN) &&
    membership.institutionId
  ) {
    return await scholarIdsForInstitution(ctx, membership.institutionId);
  }

  if (
    membership.role === ROLES.STAFF &&
    membership.institutionId &&
    (await hasActiveInstitutionCapability(
      ctx,
      membership.userId,
      membership.institutionId,
      "school:operations",
    ))
  ) {
    return await scholarIdsForInstitution(ctx, membership.institutionId);
  }

  // curriculum_designer, scholar, or staff without an institution: deny.
  return new Set();
}

/**
 * Whether `membership` may access a specific scholar. Platform admin takes a
 * cheap single-row path (no need to materialize the whole roster). Other roles
 * go through `accessibleScholarIds`.
 */
export async function canAccessScholar(
  ctx: QueryCtx,
  membership: ActiveMembership,
  scholarId: Id<"users">,
): Promise<boolean> {
  if (isPlatformAdminRole(membership.role)) {
    if (!(await holdsPlatformAdminRole(ctx, membership))) return false;
    const s = await ctx.db.get(scholarId);
    return !!s && (await hasScholarMembership(ctx, scholarId));
  }

  const ids = await accessibleScholarIds(ctx, membership);
  return ids.has(scholarId);
}

/**
 * Target-bound scholar access across all of a user's institution contexts.
 * This is the safe bridge for capability-based Staff: authority is checked
 * against the scholar's actual institution, never a global boolean.
 */
export async function canUserAccessScholar(
  ctx: QueryCtx | MutationCtx,
  user: Pick<Doc<"users">, "_id" | "role">,
  scholarId: Id<"users">,
): Promise<boolean> {
  if (user._id === scholarId) return true;
  const scholar = await ctx.db.get(scholarId);
  if (!scholar || !(await hasScholarMembership(ctx, scholarId))) return false;
  if (isPlatformAdminRole(user.role)) return true;

  const institutionId = await scholarInstitutionId(ctx, scholarId);
  if (institutionId) {
    const institutionIds = await schoolOperationsInstitutionIds(ctx, user);
    if (
      institutionIds === "all" ||
      institutionIds.has(institutionId)
    ) {
      return true;
    }
  }

  return false;
}

/**
 * The learning-record form of `canUserAccessScholar`: the same target-bound
 * boundary MINUS the `school:operations` capability path. Use it for reads of
 * a scholar's WORK (portfolio, scored offline work, rubric feedback) that
 * teachers, school admins and platform admins may see but operations staff
 * may not — account and device admin is not a licence to browse a child's
 * work (Andy's ruling: portfolio browsing is "a bridge too far").
 *
 * Why not `canReadScholarAsTeacher`: that one resolves through
 * `accessibleScholarIds`, which only lists `scholar`-role members, so it
 * would silently drop a teacher's access to an adult learner that
 * `canUserAccessScholar` admits today. This keeps the teacher path identical
 * to the school-operations resolver's own teacher branch.
 */
export async function canUserReadScholarWork(
  ctx: QueryCtx | MutationCtx,
  user: Pick<Doc<"users">, "_id" | "role">,
  scholarId: Id<"users">,
): Promise<boolean> {
  if (user._id === scholarId) return true;
  if (!(await canUserAccessScholar(ctx, user, scholarId))) return false;
  if (isPlatformAdminRole(user.role)) return true;
  const institutionId = await scholarInstitutionId(ctx, scholarId);
  if (!institutionId) return false;
  const memberships = await ctx.db
    .query("memberships")
    .withIndex("by_user", (q) => q.eq("userId", user._id))
    .collect();
  return (
    memberships.some(
      (membership) =>
        membership.institutionId === institutionId &&
        (membership.role === ROLES.TEACHER ||
          membership.role === ROLES.SCHOOL_ADMIN),
    ) &&
    (await hasActiveStaffMembershipAtInstitution(ctx, user._id, institutionId))
  );
}

/** Throwing form of `canUserReadScholarWork`. */
export async function requireScholarWorkAccess(
  ctx: QueryCtx | MutationCtx,
  user: Pick<Doc<"users">, "_id" | "role">,
  scholarId: Id<"users">,
): Promise<void> {
  if (!(await canUserReadScholarWork(ctx, user, scholarId))) {
    throw new Error("Forbidden: teaching access required for scholar work");
  }
}

/**
 * Whether a STAFF user may read a specific scholar's sensitive per-scholar
 * signals (reading trend, tutor readability, feed metrics, node readings)
 * through one of their TEACHER-role memberships. The membership-loop core
 * shared by the teacher-facing portrait / feed / read-model queries, which
 * previously each inlined this same loop.
 *
 * Platform admins have global scope. Otherwise true iff at least one of the
 * user's teacher-role memberships can access the scholar (institution-scoped).
 *
 * Callers own the OUTER gate — self-access and the not-a-teacher case — and
 * their own denial shape. This helper is a pure boolean and never throws, so an
 * `authedQuery` can OMIT sensitive readings and a `teacherQuery` can return its
 * empty shape without tripping the route error boundary.
 */
export async function canReadScholarAsTeacher(
  ctx: QueryCtx,
  user: Pick<Doc<"users">, "_id" | "role">,
  scholarId: Id<"users">,
): Promise<boolean> {
  if (isPlatformAdminRole(user.role)) return true;
  const memberships = await ctx.db
    .query("memberships")
    .withIndex("by_user", (q) => q.eq("userId", user._id))
    .collect();
  for (const m of memberships) {
    if (!isTeacherRole(m.role)) continue;
    if (await canAccessScholar(ctx, m, scholarId)) return true;
  }
  return false;
}

/**
 * Throw unless `membership` may access `scholarId`. This is the per-scholar
 * gate used alongside resolved-owner checks for object-id-keyed handlers.
 */
export async function requireScholarAccess(
  ctx: QueryCtx,
  membership: ActiveMembership,
  scholarId: Id<"users">,
): Promise<void> {
  if (!(await canAccessScholar(ctx, membership, scholarId))) {
    throw new Error("Forbidden: scholar is not in your current context");
  }
}

// ── Active membership resolution ──────────────────────────────────────
//
// Resolve the membership (context) a request is acting in. Until the context
// switcher passes an explicit hint (?inst / membership id), we pick a stable
// DEFAULT: the user's single membership, or — for a multi-membership user —
// one matching their legacy `users.role`, preferring an institution-scoped
// one, falling back to the oldest. The switcher will later pass the chosen
// membership id, which MUST still be validated to belong to the user (M1).
export async function resolveActiveMembership(
  ctx: QueryCtx | MutationCtx,
  user: Doc<"users">,
): Promise<ActiveMembership | null> {
  const memberships = await ctx.db
    .query("memberships")
    .withIndex("by_user", (q) => q.eq("userId", user._id))
    .collect();
  if (memberships.length === 0) return null;
  if (memberships.length === 1) return memberships[0];

  const sameRole = memberships.filter((m) => m.role === user.role);
  const pool = sameRole.length > 0 ? sameRole : memberships;
  // Prefer an institution-scoped membership, then the oldest for determinism.
  const sorted = [...pool].sort((a, b) => {
    const ai = a.institutionId ? 0 : 1;
    const bi = b.institutionId ? 0 : 1;
    return ai - bi || a._creationTime - b._creationTime;
  });
  return sorted[0];
}

/**
 * Enforce per-scholar access for the request's ACTIVE context. A user with no
 * resolvable membership is denied.
 */
export async function requireActiveScholarAccess(
  ctx: QueryCtx,
  user: Doc<"users">,
  scholarId: Id<"users">,
): Promise<void> {
  // Self-access is never an institution-boundary concern: every upstream role
  // gate (requireTeacherOrSelf, session ownership) already allows a user to
  // touch their own records, and the boundary exists to stop STAFF from
  // crossing institutions. Without this, a teacher acting on their OWN
  // records (e.g. physical tasks on their own test-drive session) would be
  // wrongly denied — their id is never in the scholar roster that
  // accessibleScholarIds returns. sessions.ts encodes the same exemption
  // explicitly (`accessScholarId === ctx.user._id` early return).
  if (user._id === scholarId) return;
  if (!(await canUserAccessScholar(ctx, user, scholarId))) {
    throw new Error("Forbidden: scholar is not in your current context");
  }
}

/**
 * Throw unless every explicitly named scholar is accessible in the request's
 * active context. Unlike filtering helpers, a foreign id in a write payload is
 * always an authorization error.
 */
export async function requireScholarsAccessible(
  ctx: QueryCtx,
  user: Doc<"users">,
  scholarIds: Id<"users">[],
): Promise<void> {
  if (scholarIds.length === 0 || isPlatformAdminRole(user.role)) {
    return;
  }
  for (const scholarId of scholarIds) {
    if (await canUserAccessScholar(ctx, user, scholarId)) continue;
    throw new Error("Forbidden: scholar is not in your current context");
  }
}

/**
 * The FILTERING form of the boundary: the subset of `scholarIds` the user's
 * active context may access. For whole-class surfaces over rosters that can
 * legitimately span institutions (a mixed scholar group), silently narrowing
 * to "the ones in your context" is the usable-and-safe semantics — nothing
 * foreign is returned or written, and a wholly-foreign roster narrows to ∅.
 * Use `requireActiveScholarAccess` instead when the caller NAMED the scholars
 * (an explicit out-of-context id should fail loudly, not vanish).
 */
export async function filterToAccessibleScholars(
  ctx: QueryCtx,
  user: Doc<"users">,
  scholarIds: Id<"users">[],
): Promise<Id<"users">[]> {
  const filtered: Id<"users">[] = [];
  for (const scholarId of scholarIds) {
    if (await canUserAccessScholar(ctx, user, scholarId)) {
      filtered.push(scholarId);
    }
  }
  return filtered;
}

/**
 * The institution boundary for a GROUP-keyed staff surface (a scholarGroup id
 * with no owning assignment to gate on). Resolves the group and intersects its
 * roster with the caller's accessible set (filterToAccessibleScholars). Returns
 * the group + the accessible-scholar subset.
 *
 * All-or-nothing, matching the cohort/roster posture (activityCompletions
 * .rosterForAssignment): a group whose roster is non-empty but intersects the
 * caller's context to ∅ is a wholly-foreign group → `forbidden: true`. An empty
 * group (no scholars to leak) and a missing group are NOT forbidden — the caller
 * decides how to render those.
 */
export async function accessibleGroupScholars(
  ctx: QueryCtx,
  user: Doc<"users">,
  groupId: Id<"scholarGroups">,
): Promise<{
  group: Doc<"scholarGroups"> | null;
  scholarIds: Id<"users">[];
  forbidden: boolean;
}> {
  const group = await ctx.db.get(groupId);
  if (!group) return { group: null, scholarIds: [], forbidden: false };
  const roster = group.scholarIds ?? [];
  const accessible = await filterToAccessibleScholars(ctx, user, roster);
  const forbidden = roster.length > 0 && accessible.length === 0;
  return { group, scholarIds: accessible, forbidden };
}

/**
 * Throwing form of {@link accessibleGroupScholars} for read/generate paths that
 * should fail loudly on a wholly-foreign group (the class digest surfaces name
 * individual scholars, so it's all-or-nothing — never a partial filter). Throws
 * the standard Forbidden; returns the group otherwise (null when the group
 * doesn't exist — the caller renders an honest empty state).
 */
export async function requireGroupScholarAccess(
  ctx: QueryCtx,
  user: Doc<"users">,
  groupId: Id<"scholarGroups">,
): Promise<Doc<"scholarGroups"> | null> {
  const { group, forbidden } = await accessibleGroupScholars(ctx, user, groupId);
  if (forbidden) {
    throw new Error("Forbidden: group is not in your current context");
  }
  return group;
}

/**
 * The institution boundary for a resolved Master Schedule row. Placements and
 * group-specific blocks are checked against their own group, and every row is
 * also checked against its reporting period. Legacy unstamped periods belong
 * to the primary institution, matching the schedule aide boundary; missing
 * periods or deployments without a primary institution fail closed.
 * The period-keyed aide* internal mutations touched by TRA-260 use this scope.
 */
export async function requireScheduleScopeAccessible(
  ctx: QueryCtx,
  user: Doc<"users">,
  scope: {
    periodId: Id<"reportingPeriods">;
    groupId?: Id<"scholarGroups">;
  },
): Promise<void> {
  if (scope.groupId) {
    const group = await requireGroupScholarAccess(ctx, user, scope.groupId);
    if (group?.institutionId) {
      await assertCuratableInstitution(ctx, user, group.institutionId);
    }
  }
  const period = await ctx.db.get(scope.periodId);
  if (!period) throw new Error("Reporting period not found");
  const institutionId =
    period.institutionId ?? (await primaryInstitutionId(ctx));
  if (!institutionId) {
    throw new Error("Forbidden: reporting period is not in your current context");
  }
  await assertCuratableInstitution(ctx, user, institutionId);
}

/**
 * The STAFF-side twin of the scholar-roster boundary above. A group/planning
 * handler that also takes a client-supplied `teacherId` as a write key (e.g.
 * "reassign this block to teacher X") is a tenancy question exactly like a
 * scholarId is: the caller must not be able to name a staffer at a school
 * they have no standing in. Naming yourself is always fine (mirrors the
 * `user._id === scholarId` self-bypass on `canUserAccessScholar` above).
 * Otherwise throws unless `staffId` holds an active staff membership at some
 * institution the caller may act in (or the caller is platform_admin, which
 * acts everywhere). Composed from the `schoolOperationsInstitutionIds` /
 * `hasActiveStaffMembershipAtInstitution` primitives in staffCapabilities.ts —
 * no new policy, just the intersection.
 */
export async function requireStaffAccessible(
  ctx: QueryCtx,
  user: Doc<"users">,
  staffId: Id<"users">,
): Promise<void> {
  if (user._id === staffId) return;
  const scope = await schoolOperationsInstitutionIds(ctx, user);
  if (scope === "all") return;
  for (const institutionId of scope) {
    if (await hasActiveStaffMembershipAtInstitution(ctx, staffId, institutionId)) {
      return;
    }
  }
  throw new Error("Forbidden: staff member is not in your current context");
}

/**
 * Resolve every institution an assignment's group/unit/roster signals touch
 * — the traversal behind `requireAssignmentAccessible` below, kept as a Set
 * (not a single institution-or-null) because that guard needs to tell
 * "nothing resolves" apart from "resolves to more than one," which call for
 * opposite policies on the schedule-write boundary. Checked in priority
 * order: the immutable `scholarGroupId` provenance link (most authoritative
 * — set once at publish and never widened), then the unit's own
 * institution, then every distinct institution across the roster. Private
 * to this schedule-write boundary — `portfolio.ts`'s own, unrelated
 * `canManageAssignment` keeps its own simpler, stricter-by-default resolver
 * rather than share this one; don't widen this into a shared primitive
 * without re-auditing that caller too.
 */
async function resolvedAssignmentInstitutionIds(
  ctx: QueryCtx,
  assignment: Doc<"assignments">,
): Promise<Set<Id<"institutions">>> {
  if (assignment.scholarGroupId) {
    const group = await ctx.db.get(assignment.scholarGroupId);
    if (group?.institutionId) return new Set([group.institutionId]);
  }
  if (assignment.unitId) {
    const unit = await ctx.db.get(assignment.unitId);
    if (unit) {
      if (unit.authorScholarId) {
        // Independent Study units belong to their AUTHOR scholar, not a
        // stamped/primary catalog institution — mirrors the dedicated IS
        // branch in `requireUnitAccessForUser` (convex/lib/unitAccess.ts).
        // Falling through to the catalog rule below would wrongly hand a
        // scholar-owned unit to whichever school happens to be primary.
        const authorInstitutionId = await scholarInstitutionId(
          ctx,
          unit.authorScholarId,
        );
        if (authorInstitutionId) return new Set([authorInstitutionId]);
      } else {
        // Mirrors `requireUnitAccessForUser`'s catalog-unit rule: a stamped
        // unit belongs to its own institution, but a LEGACY UNSTAMPED unit
        // belongs to the PRIMARY institution — it is not institution-less.
        // Falling through to "no signal" here would let a non-primary
        // teacher cascade the primary school's legacy curriculum (see
        // "legacy unstamped units belong to the primary institution" in
        // convex/__tests__/unitPrivacy.test.ts). Only treat it as
        // unresolved when there's no primary institution row at all yet
        // (the pre-migration single-tenant world unitAccess.ts preserves).
        const unitInstitutionId =
          unit.institutionId ?? (await primaryInstitutionId(ctx)) ?? undefined;
        if (unitInstitutionId) return new Set([unitInstitutionId]);
      }
    }
  }
  // Uses the same widen-phase resolver as everywhere else a scholar's
  // institution is read (`scholarEnrollment.ts`'s `scholarInstitutionId`) —
  // NOT a bare `scholar.institutionId` field read. A scholar whose
  // institution is carried only by their `memberships` row (e.g. an adult
  // learner account, or a scholar mid-migration) has no `users.institutionId`
  // at all; reading the field directly would silently drop them out of the
  // roster resolution and misroute a real foreign-roster assignment into the
  // weaker owner-only fallback below.
  const institutionIds = await Promise.all(
    assignment.scholarIds.map((scholarId) => scholarInstitutionId(ctx, scholarId)),
  );
  return new Set(
    institutionIds.flatMap((institutionId) =>
      institutionId ? [institutionId] : [],
    ),
  );
}

/**
 * The institution boundary for an ASSIGNMENT-keyed schedule write: a
 * client-supplied `assignmentId` a teacher links onto a placement (or
 * cascades a unit from) via `masterSchedule.ts`. That surface deliberately
 * supports scheduling a COLLEAGUE's assignment (a group's roster and the
 * assignment's own teacher need not match), so this checks institution
 * standing — same as `requireStaffAccessible` — not ownership; do not
 * replace this with `assignments.ts`'s stricter `requireOwnedAssignment`,
 * which would break that legitimate case.
 *
 * A missing assignment resolves to null without throwing — the caller
 * already has (or the core it delegates to already throws) its own
 * "assignment not found" message, and duplicating that here would produce a
 * second, contradictory error.
 *
 * An assignment with NO resolvable institution signal from its group/unit/
 * roster (no `scholarGroupId`, no `unitId` — or a unit predating the
 * institution rollout — and no scholar with an `institutionId`) falls back
 * to the STAFF boundary on its own `teacherId` (`requireStaffAccessible`,
 * which self-bypasses when the caller names their own assignment). This is
 * NOT a no-op read: `reconcilePlacementById` → `applyScheduleActivity`
 * `ctx.db.patch`es the linked assignment's own `activitySchedule` as soon as
 * the placement materializes, even with an empty roster — so the ASSIGNMENT
 * itself, not just its roster, is the protected mutable resource, and its
 * `teacherId` is the remaining ownership signal once group/unit/roster are
 * silent. A roster that resolves to MORE than one institution (a genuine
 * anomaly: real scholars from different schools on one assignment) fails
 * closed instead, since real cross-tenant data is actually in play there.
 */
export async function requireAssignmentAccessible(
  ctx: QueryCtx,
  user: Doc<"users">,
  assignmentId: Id<"assignments">,
): Promise<Doc<"assignments"> | null> {
  const assignment = await ctx.db.get(assignmentId);
  if (!assignment) return null;
  if (isPlatformAdminRole(user.role)) return assignment;
  const institutionIds = await resolvedAssignmentInstitutionIds(ctx, assignment);
  if (institutionIds.size === 0) {
    await requireStaffAccessible(ctx, user, assignment.teacherId);
    return assignment;
  }
  if (
    institutionIds.size > 1 ||
    !(await hasSchoolOperationsAccessAtInstitution(
      ctx,
      user,
      [...institutionIds][0],
    ))
  ) {
    throw new Error("Forbidden: assignment is not in your current context");
  }
  return assignment;
}

// ── Institution curation scope (school-level resources) ───────────────
//
// "Which institutions may this staffer curate school-level resources for"
// (e.g. the physical-environment inventory). SEPARATE from the scholar-access
// boundary above (this is about the school's own config, not per-scholar data):
// a staffer editing another school's inventory is a plain authorization error.
//
//   platform_admin (by users.role only — TRA-375) → "all", suspended
//     schools included
//   curriculum_designer → every LIVE institution (a global role by
//     users.role, or an unscoped membership whose role is global AND staff —
//     never lifelong_learner, which is global for lifecycle only)
//   teacher / operations staff / school_admin     → their staff-membership institutions
//   (institution-scoped staffer with no membership yet → the primary school,
//    matching institutions.listForStaff + physicalEnvAide.resolveActorInstitution)
//   A suspended institution is never curatable except by a platform admin:
//   not in a scoped set (even for a staffer whose other school keeps them
//   working), and not in a curriculum designer's global set.

/** The set of institutions the staffer may curate, or "all" for a platform admin. */
export async function curatableInstitutionIds(
  ctx: QueryCtx,
  user: Doc<"users">,
): Promise<Set<Id<"institutions">> | "all"> {
  if (isPlatformAdminRole(user.role)) return "all";
  const memberships = await ctx.db
    .query("memberships")
    .withIndex("by_user", (q) => q.eq("userId", user._id))
    .collect();
  if (
    user.role === ROLES.CURRICULUM_DESIGNER ||
    // Global standing needs a role that is deployment-wide AND staff: an
    // unscoped lifelong_learner membership is global for lifecycle only, and
    // must not turn a teacher at one school into a curator of every school
    // (the same leak 90f1b8c closed in the staff directory).
    memberships.some(
      (m) =>
        isGloballyPrivilegedMembership(m) &&
        isStaffRole(m.role as Role) &&
        // platform_admin standing is users.role alone (TRA-375).
        !isPlatformAdminRole(m.role),
    )
  ) {
    // Every LIVE school. A suspended school's resources are frozen for
    // everyone but the operator, so a global curator skips it too.
    const live = (await ctx.db.query("institutions").collect()).filter(
      (i) => i.disabledAt === undefined,
    );
    return new Set(live.map((i) => i._id));
  }
  const ids = new Set<Id<"institutions">>();
  for (const m of memberships) {
    if (!m.institutionId) continue;
    if (
      m.role === ROLES.TEACHER ||
      m.role === ROLES.SCHOOL_ADMIN ||
      m.role === ROLES.STAFF
    ) {
      ids.add(m.institutionId);
    }
  }
  if (
    ids.size === 0 &&
    (user.role === ROLES.TEACHER ||
      user.role === ROLES.SCHOOL_ADMIN ||
      user.role === ROLES.STAFF)
  ) {
    const primary = (await ctx.db.query("institutions").collect()).find(
      (i) => i.isPrimary,
    );
    if (primary) ids.add(primary._id);
  }
  // A suspended school's members cannot use the app, so a staffer who also
  // belongs to an active school must not keep curating the paused one —
  // matching accessibleScholarIds, which drops suspended schools the same way.
  const suspended = await suspendedInstitutionIds(ctx);
  for (const id of suspended) ids.delete(id);
  return ids;
}

/** Throw unless `user` may curate `institutionId`. */
export async function assertCuratableInstitution(
  ctx: QueryCtx,
  user: Doc<"users">,
  institutionId: Id<"institutions">,
): Promise<void> {
  const scope = await curatableInstitutionIds(ctx, user);
  if (scope === "all") return;
  if (!scope.has(institutionId)) {
    throw new Error("Forbidden: that institution isn't in your context");
  }
}

// ── Institution suspension (temporary disable/enable) ─────────────────
//
// A reversible "paused" state on an institution (institutions.disabledAt — the
// timestamp IS the flag). "Suspended" MEANS: the school's members cannot use
// the app — every authed read/write is refused at the ONE chokepoint every
// authed path already flows through (`requireUser` → `assertInstitutionActive`)
// — while ALL their data is preserved untouched. Re-enabling restores access
// with no data change. This mirrors the delete feature's multi-institution edge
// (convex/lib/cascade.ts): a globally-privileged role (platform_admin so it can
// inspect + re-enable; curriculum_designer / lifelong_learner) is NEVER blocked,
// and a user who ALSO holds a membership at a still-active institution keeps
// working there. Distinct from the per-scholar access boundary above (that's
// "whose data can staff X see"); this is "may this member use the app at all".

/** The set of institution ids that are currently suspended (tiny table scan). */
export async function suspendedInstitutionIds(
  ctx: QueryCtx | MutationCtx,
): Promise<Set<Id<"institutions">>> {
  const all = await ctx.db.query("institutions").collect();
  return new Set(all.filter((i) => i.disabledAt !== undefined).map((i) => i._id));
}

/** Is a single institution currently suspended? For background jobs that act
 *  per-institution/per-group and must not fire for a paused school. */
export async function isInstitutionSuspended(
  ctx: QueryCtx | MutationCtx,
  institutionId: Id<"institutions"> | undefined | null,
): Promise<boolean> {
  if (!institutionId) return false;
  const inst = await ctx.db.get(institutionId);
  return !!inst && inst.disabledAt !== undefined;
}

/**
 * Pure decision: is this user blocked because every context they could act in
 * is suspended? Mirrors cascade.wouldDeleteUser's shape (a surviving non-target
 * membership keeps the user), generalized to a SET of suspended institutions.
 *
 *   • A globally-privileged role (platform_admin / curriculum_designer /
 *     lifelong_learner) is never blocked.
 *   • ANY membership at a non-suspended institution — OR a membership with no
 *     institution (parent: guardianship-scoped, never a "member" of a school) —
 *     keeps the user working (the multi-institution edge).
 *   • A home `institutionId` at a non-suspended school also keeps them.
 *   • Otherwise, blocked iff they are tied (home OR membership) to a suspended
 *     institution. A user with no institution ties at all is never blocked.
 */
export function isBlockedBySuspension(
  user: Pick<Doc<"users">, "role" | "institutionId">,
  memberships: Pick<Doc<"memberships">, "role" | "institutionId">[],
  suspendedIds: Set<Id<"institutions">>,
): boolean {
  if (suspendedIds.size === 0) return false;
  if (isGloballyPrivilegedRole(user.role)) return false;
  if (memberships.some(isGloballyPrivilegedMembership)) return false;

  // Any usable (non-suspended) context saves the user.
  const hasUsableMembership = memberships.some(
    (m) => m.institutionId === undefined || !suspendedIds.has(m.institutionId),
  );
  if (hasUsableMembership) return false;
  if (user.institutionId !== undefined && !suspendedIds.has(user.institutionId)) {
    return false;
  }

  // Tied only to suspended institution(s)?
  return (
    (user.institutionId !== undefined && suspendedIds.has(user.institutionId)) ||
    memberships.some(
      (m) => m.institutionId !== undefined && suspendedIds.has(m.institutionId),
    )
  );
}

/**
 * Evaluate a user's suspension status against the live set of suspended
 * institutions. The single source of truth shared by the server BLOCK
 * (`assertInstitutionActive`, which throws) and the client PAUSED-SCREEN
 * (`users.currentUser`, which surfaces `institutionSuspended` so the app shows
 * a legible message instead of crashing into the error boundary). Returns the
 * suspended school's name when blocked, for that message.
 */
export async function evaluateInstitutionSuspension(
  ctx: QueryCtx | MutationCtx,
  user: Pick<Doc<"users">, "_id" | "role" | "institutionId">,
): Promise<{ blocked: boolean; institutionName: string | null }> {
  // Global roles are institution-independent, so avoid the universal
  // institutions-table read on every guarded operation they perform.
  if (isGloballyPrivilegedRole(user.role)) {
    return { blocked: false, institutionName: null };
  }
  // Fast path: nothing suspended → nothing to evaluate (one tiny table scan).
  const all = await ctx.db.query("institutions").collect();
  const suspended = all.filter((i) => i.disabledAt !== undefined);
  if (suspended.length === 0) return { blocked: false, institutionName: null };
  const suspendedIds = new Set(suspended.map((i) => i._id));
  const memberships = await ctx.db
    .query("memberships")
    .withIndex("by_user", (q) => q.eq("userId", user._id))
    .collect();
  if (!isBlockedBySuspension(user, memberships, suspendedIds)) {
    return { blocked: false, institutionName: null };
  }
  // Name the school they're paused under (their home if it's suspended, else the
  // first suspended institution they're a member of) for the paused message.
  const homeSuspended =
    user.institutionId !== undefined && suspendedIds.has(user.institutionId)
      ? all.find((i) => i._id === user.institutionId)
      : undefined;
  const membershipSuspended = homeSuspended
    ? undefined
    : all.find(
        (i) =>
          suspendedIds.has(i._id) &&
          memberships.some((m) => m.institutionId === i._id),
      );
  const inst = homeSuspended ?? membershipSuspended ?? null;
  return { blocked: true, institutionName: inst?.name ?? null };
}

/**
 * The UNIVERSAL auth chokepoint for suspension: throw the non-alarming paused
 * message if `user` belongs only to suspended institution(s). Called by
 * `requireUser` (convex/lib/auth.ts), so EVERY authed query/mutation — and any
 * new gate/feature added tomorrow that goes through requireUser — inherits it,
 * with zero per-handler wiring. Platform admins pass (globally privileged) so
 * they retain full access to inspect and re-enable.
 */
export async function assertInstitutionActive(
  ctx: QueryCtx | MutationCtx,
  user: Doc<"users">,
): Promise<void> {
  const { blocked } = await evaluateInstitutionSuspension(ctx, user);
  if (blocked) throw new Error(INSTITUTION_SUSPENDED_MESSAGE);
}
