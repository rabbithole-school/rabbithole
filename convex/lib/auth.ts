import { QueryCtx, MutationCtx } from "../_generated/server";
import type { Doc, Id, DataModel } from "../_generated/dataModel";
import type { GenericActionCtx } from "convex/server";
import { getAuthUserId, getAuthSessionId } from "@convex-dev/auth/server";
import { internal } from "../_generated/api";
import { isScholarAdminRole, isStaffRole, isTeacherRole, isPlatformAdminRole, isSchoolAdminRole } from "./roles";
import { isImpersonationEnabled, isOverlayExpired } from "./impersonationConfig";
import { assertInstitutionActive } from "./access";
import { canUserAccessScholar } from "./access";
import {
  hasAnySchoolOperationsAccess,
  schoolOperationsInstitutionIds,
  type SchoolOperationsPrincipal,
} from "./staffCapabilities";
import {
  hasCurriculumAccess,
  hasCurriculumAccessForInstitution,
} from "./curriculumAccess";
import { requireUnitAccessForUser } from "./unitAccess";

/**
 * Is `parentUserId` a linked guardian of `scholarId`? Pure membership
 * read against the `guardianships` table (no auth check — callers do that).
 * Used by `requireGuardianOf` and the parent-scoped Chat tool resolver.
 */
export async function isGuardianOf(
  ctx: QueryCtx | MutationCtx,
  parentUserId: Id<"users">,
  scholarId: Id<"users">,
): Promise<boolean> {
  const link = await ctx.db
    .query("guardianships")
    .withIndex("by_pair", (q) =>
      q.eq("parentUserId", parentUserId).eq("scholarUserId", scholarId),
    )
    .first();
  return !!link;
}

/**
 * Does this user have ANY guardianship — i.e. a "parent context"? Table-based
 * and ROLE-AGNOSTIC: a guardian may be a `parent`-role account OR a staff
 * member / admin who is also a guardian of their own child (e.g. a staffer who
 * is a parent at the school). The parent surfaces authorize on guardianship,
 * not on `users.role`, so a multi-role user can use the parent view for their
 * own children without their primary role changing.
 */
export async function hasGuardianships(
  ctx: QueryCtx | MutationCtx,
  userId: Id<"users">,
): Promise<boolean> {
  const link = await ctx.db
    .query("guardianships")
    .withIndex("by_parent", (q) => q.eq("parentUserId", userId))
    .first();
  return !!link;
}

/**
 * The impersonation overlay active on the CURRENT session, if any (and only
 * when the feature is enabled). Keyed to the admin's own session id — a
 * normal login has no overlay. Used by getCurrentUser (identity swap), the
 * read-only gate, and the banner query. Cheap + skipped entirely when the
 * feature flag is off, so zero hot-path cost on deployments without it.
 */
export async function getActiveOverlay(
  ctx: QueryCtx | MutationCtx,
): Promise<Doc<"impersonationOverlays"> | null> {
  if (!isImpersonationEnabled()) return null;
  const sessionId = await getAuthSessionId(ctx);
  if (!sessionId) return null;
  const overlay = await ctx.db
    .query("impersonationOverlays")
    .withIndex("by_admin_session", (q) =>
      q.eq("adminSessionId", sessionId as Id<"authSessions">).eq("active", true),
    )
    .first();
  // Past its TTL, an overlay is INERT — treat it as if it were already ended, so
  // every consumer (identity swap, read-only gate, banner) reverts to the real
  // owner without waiting for the hourly sweep to flip `active`.
  if (!overlay || isOverlayExpired(overlay)) return null;
  return overlay;
}

/**
 * The REAL session owner — the authenticated user, IGNORING any impersonation
 * overlay. Use this for anything that is about "me, the logged-in account"
 * rather than "the data I'm viewing": passkey status/enrollment, the exit
 * control, session management. getCurrentUser (below) returns the EFFECTIVE
 * user (the impersonation target) for everything else.
 */
export async function getSessionOwner(
  ctx: QueryCtx | MutationCtx,
): Promise<Doc<"users"> | null> {
  const userId = await getAuthUserId(ctx);
  if (userId) return await ctx.db.get(userId);
  return null;
}

/**
 * Get the currently authenticated user document.
 * Returns null if not authenticated.
 *
 * IMPERSONATION: when the current session has an active "view-as" overlay
 * (platform-admin only, feature-flagged), this returns the TARGET user — so
 * every gate + query + the app UI run as the target (read-only; writes are
 * blocked by assertNotImpersonating). The real session owner is reachable via
 * getSessionOwner. See review/admin-impersonation-redesign-plan.html §6.
 */
export async function getCurrentUser(
  ctx: QueryCtx | MutationCtx
): Promise<Doc<"users"> | null> {
  const userId = await getAuthUserId(ctx);
  if (!userId) return null;
  const overlay = await getActiveOverlay(ctx);
  if (overlay) {
    const target = await ctx.db.get(overlay.targetUserId);
    if (target) return target;
  }
  return await ctx.db.get(userId);
}

/**
 * Get the currently authenticated user, throwing if not authenticated.
 *
 * ALSO the universal INSTITUTION-SUSPENSION chokepoint: a member of a
 * temporarily-disabled institution (institutions.disabledAt set) is refused
 * here with a legible "access is paused" message, so every authed query/
 * mutation that flows through requireUser — and any new gate added later —
 * inherits the block without per-handler wiring. Platform admins and users who
 * also hold a membership at a still-active institution pass (see
 * convex/lib/access.ts → assertInstitutionActive). The non-throwing
 * `users.currentUser` bootstrap query stays readable (it uses getCurrentUser,
 * not requireUser) so the app can render a paused screen instead of crashing.
 */
export async function requireUser(
  ctx: QueryCtx | MutationCtx
): Promise<Doc<"users">> {
  const user = await getCurrentUser(ctx);
  if (!user) throw new Error("Not authenticated");
  await assertInstitutionActive(ctx, user);
  return user;
}

/**
 * Throw if the current request runs inside an active "view-as" overlay. A
 * no-op when the feature is off or the session isn't impersonating. Wired into
 * the user-facing mutation wrappers (convex/lib/customFunctions.ts) so an
 * impersonation session is READ-ONLY — a write would be mis-attributed to the
 * target and destroy audit integrity. (platformAdminMutation is not gated: the
 * effective user is the target, so requirePlatformAdmin already rejects it.)
 */
export async function assertNotImpersonating(
  ctx: MutationCtx,
): Promise<void> {
  const overlay = await getActiveOverlay(ctx);
  if (overlay) {
    throw new Error(
      "Read-only while viewing as another user — exit impersonation to act as yourself.",
    );
  }
}

/**
 * Require teacher-equivalent role: teacher, school_admin, or platform_admin.
 * The scholar/curriculum EXECUTION gate.
 */
export async function requireTeacher(
  ctx: QueryCtx | MutationCtx
): Promise<Doc<"users">> {
  const user = await requireUser(ctx);
  if (!isTeacherRole(user.role)) {
    throw new Error("Forbidden: teacher or admin role required");
  }
  return user;
}

/**
 * Require "scholar admin" access: teacher, admin, or operations staff. These
 * are the roles allowed to create/administer scholar accounts and manage
 * portfolios. Deliberately does NOT include curriculum_designer, and
 * does NOT grant access to sensitive scholar data (documents, mastery,
 * dossier, observations) — those stay on `requireTeacher`.
 */
export async function requireScholarAdmin(
  ctx: QueryCtx | MutationCtx
): Promise<SchoolOperationsPrincipal> {
  const user = await requireUser(ctx);
  if (
    !isScholarAdminRole(user.role) &&
    !(await hasAnySchoolOperationsAccess(ctx, user))
  ) {
    throw new Error("Forbidden: scholar-admin role required");
  }
  return {
    ...user,
    schoolOperationsInstitutionIds:
      await schoolOperationsInstitutionIds(ctx, user),
  };
}

/**
 * Per-scholar gate for NON-sensitive scholar-admin reads (profile,
 * parent-access tokens): passes if the caller is a scholar-admin
 * (teacher/admin/operations staff) OR is the scholar themselves. Returns
 * whether the caller is a scholar-admin so handlers can branch.
 *
 * This is the scholar-admin sibling of `requireTeacherOrSelf`. Use it
 * ONLY on non-sensitive surfaces — sensitive per-scholar reads
 * (dossier, mastery, seeds, observations, …) must keep using
 * `requireTeacherOrSelf`, which excludes operations staff.
 */
export async function requireScholarAdminOrSelf(
  ctx: QueryCtx | MutationCtx,
  user: Doc<"users">,
  scholarId: Id<"users">,
): Promise<boolean> {
  const isAdmin = await canUserAccessScholar(ctx, user, scholarId);
  if (!isAdmin && user._id !== scholarId) throw new Error("Forbidden");
  return isAdmin;
}

/**
 * Per-scholar gate for the PARENT surfaces: the caller must be a linked
 * guardian of `scholarId`. Authorizes on the `guardianships` table — NOT on
 * `users.role` — so a guardian reaches their own child's non-sensitive data
 * whether their primary role is `parent` or staff/admin. Only the
 * non-sensitive parent surfaces (summary/mastery/signals/seeds/portfolio)
 * call it; sensitive reads keep `requireTeacher` / `requireTeacherOrSelf`,
 * which never grant on guardianship, so a guardian can never reach a dossier,
 * document, observation, or raw transcript even for their own child.
 */
export async function requireGuardianOf(
  ctx: QueryCtx | MutationCtx,
  scholarId: Id<"users">,
): Promise<Doc<"users">> {
  const user = await requireUser(ctx);
  if (!(await isGuardianOf(ctx, user._id, scholarId))) {
    throw new Error("Forbidden: not a guardian of this scholar");
  }
  return user;
}

/**
 * Require any staff role (teacher, admin, curriculum_designer, operations staff).
 * Use for surfaces every staffer may touch regardless of their specialty —
 * e.g. their OWN AI-assistant chat threads. NOT for sensitive scholar data
 * or curriculum (those have narrower gates).
 */
export async function requireStaff(
  ctx: QueryCtx | MutationCtx
): Promise<Doc<"users">> {
  const user = await requireUser(ctx);
  if (!isStaffRole(user.role)) {
    throw new Error("Forbidden: staff role required");
  }
  return user;
}

/**
 * Require curriculum access: teacher, admin, or curriculum_designer.
 */
export async function requireCurriculumAccess(
  ctx: QueryCtx | MutationCtx
): Promise<Doc<"users">> {
  const user = await requireUser(ctx);
  if (!(await hasCurriculumAccess(ctx, user))) {
    throw new Error("Forbidden: curriculum access required");
  }
  return user;
}

/** Require a curriculum resource's author, or a global platform admin. */
export function requireAuthorOrPlatformAdmin(
  user: Pick<Doc<"users">, "_id" | "role">,
  resource: { teacherId?: Id<"users"> },
): void {
  if (
    resource.teacherId !== user._id &&
    !isPlatformAdminRole(user.role)
  ) {
    throw new Error(
      "Forbidden: only the author or a platform admin may modify this resource",
    );
  }
}

/**
 * "Act as yourself" curriculum gate: authorizes AND identifies the REAL session
 * owner, IGNORING any active impersonation overlay (unlike requireCurriculumAccess,
 * which resolves the effective/impersonated user via getCurrentUser). Use for
 * per-user "me, the logged-in account" resources whose WRITE path binds to the
 * real account — e.g. the Google account link, whose beginOAuth/callback bind by
 * getAuthUserId (the real owner). Reading such a row through the impersonated
 * identity mismatches the write and hides it: a platform-admin's own linked
 * Google account reads as "not connected" (or the query throws Forbidden, when
 * viewing-as a scholar who lacks curriculum access) whenever a view-as overlay
 * is active. See getSessionOwner.
 */
export async function requireCurriculumAccessSelf(
  ctx: QueryCtx | MutationCtx
): Promise<Doc<"users">> {
  const owner = await getSessionOwner(ctx);
  if (!owner) throw new Error("Not authenticated");
  await assertInstitutionActive(ctx, owner);
  if (!(await hasCurriculumAccess(ctx, owner))) {
    throw new Error("Forbidden: curriculum access required");
  }
  return owner;
}

/**
 * Staff counterpart to `requireCurriculumAccessSelf` — same "act as yourself"
 * semantics (resolves the REAL session owner, not the impersonated one), but
 * for capabilities that belong to being staff rather than to curriculum work.
 *
 * Used by the Google account link, whose WRITE path binds by `getAuthUserId`
 * and is gated on `requireStaffAction`. The read gate has to match the write
 * gate or the widget throws for exactly the roles the write path allows.
 */
export async function requireStaffSelf(
  ctx: QueryCtx | MutationCtx
): Promise<Doc<"users">> {
  const owner = await getSessionOwner(ctx);
  if (!owner) throw new Error("Not authenticated");
  if (!isStaffRole(owner.role)) {
    throw new Error("Forbidden: staff role required");
  }
  return owner;
}

/**
 * Per-unit edit access: passes if the user has curriculum role OR if
 * they're the scholar author of an Independent Study unit
 * (`authorScholarId === user._id`). Resolves the unit either by id
 * directly, by a lessonId (looks up unitId), or by an activityId
 * (looks up its lesson's unitId). Throws "Unit not found" if the
 * referenced row doesn't exist, "Not authenticated" if signed out,
 * "Forbidden: not allowed to edit this unit" otherwise.
 *
 * Used by the Unit Designer's queries/mutations so scholars can edit
 * their own IS Units without having global curriculum access.
 */
export async function requireUnitEditAccessForUser(
  ctx: QueryCtx | MutationCtx,
  user: Doc<"users">,
  ref:
    | { unitId: Id<"units"> }
    | { lessonId: Id<"lessons"> }
    | { activityId: Id<"activities"> },
): Promise<{ user: Doc<"users">; unit: Doc<"units"> }> {
  await assertInstitutionActive(ctx, user);
  let unitId: Id<"units"> | undefined;
  if ("unitId" in ref) {
    unitId = ref.unitId;
  } else if ("lessonId" in ref) {
    const lesson = await ctx.db.get(ref.lessonId);
    if (!lesson) throw new Error("Lesson not found");
    unitId = lesson.unitId;
  } else {
    const activity = await ctx.db.get(ref.activityId);
    if (!activity) throw new Error("Activity not found");
    if (!activity.lessonId) throw new Error("Activity has no lesson");
    const lesson = await ctx.db.get(activity.lessonId);
    if (!lesson) throw new Error("Lesson not found");
    unitId = lesson.unitId;
  }
  if (!unitId) throw new Error("Unit not found");

  const unit = await ctx.db.get(unitId);
  if (!unit) throw new Error("Unit not found");

  const author = unit.authorScholarId
    ? await ctx.db.get(unit.authorScholarId)
    : null;
  const canManageCurriculum = await hasCurriculumAccessForInstitution(
    ctx,
    user,
    unit.institutionId ?? author?.institutionId,
  );
  const isUnitAuthor =
    !!unit.authorScholarId && unit.authorScholarId === user._id;

  if (!canManageCurriculum && !isUnitAuthor) {
    throw new Error("Forbidden: not allowed to edit this unit");
  }
  await requireUnitAccessForUser(ctx, user, unitId);
  return { user, unit };
}

export async function requireUnitEditAccess(
  ctx: QueryCtx | MutationCtx,
  ref:
    | { unitId: Id<"units"> }
    | { lessonId: Id<"lessons"> }
    | { activityId: Id<"activities"> },
): Promise<{ user: Doc<"users">; unit: Doc<"units"> }> {
  const user = await requireUser(ctx);
  return await requireUnitEditAccessForUser(ctx, user, ref);
}

/**
 * Per-scholar gate: throws "Forbidden" unless the caller is a
 * teacher/admin OR is the scholar themselves. Returns whether the
 * caller is a teacher/admin so handlers that further branch ("for
 * scholars, hide inactive rows") can keep doing so without a second
 * role check.
 *
 * Centralizes the policy that was previously copy-pasted across ~17
 * per-scholar reads/writes (dossier, seeds, observations,
 * masteryObservations, teacherDirectives, …) so the rule lives in one
 * place and can't drift by accident.
 */
export function requireTeacherOrSelf(
  user: Doc<"users">,
  scholarId: Id<"users">,
): boolean {
  const isTeacher = isTeacherRole(user.role);
  if (!isTeacher && user._id !== scholarId) throw new Error("Forbidden");
  return isTeacher;
}

/**
 * Project-access policy for the streaming / observer HTTP endpoints
 * (`/project-stream`, `/analyze`): a caller may touch a project if they
 * OWN it (project.userId) or they're a teacher/admin (remote view-as,
 * test-drive, observer triggering). Pure so it's unit-testable without
 * convex-test; mirrors the gate in `projects.get` / `getWithMessages`.
 *
 * Registrars are intentionally excluded — they have no business reading
 * a tutor transcript or triggering observer analysis.
 */
export function canAccessSession(
  user: Pick<Doc<"users">, "_id" | "role">,
  ownerId: Id<"users">,
): boolean {
  const isTeacher = isTeacherRole(user.role);
  return isTeacher || user._id === ownerId;
}

/**
 * Require platform-admin role (the global Rabbithole operator). Gates
 * platform-wide power: user/role administration, integrations, platform
 * settings, cross-institution changes. School admins NEVER pass this gate.
 */
export async function requirePlatformAdmin(
  ctx: QueryCtx | MutationCtx
): Promise<Doc<"users">> {
  const user = await requireUser(ctx);
  if (!isPlatformAdminRole(user.role)) {
    throw new Error("Forbidden: platform-admin role required");
  }
  return user;
}


/**
 * Require school-admin-or-above for institution-scoped administration: a
 * `school_admin` (institution leader) OR a `platform_admin` (who can act in
 * any institution). The institution scope itself is enforced by the access
 * boundary (convex/lib/access.ts), not here.
 */
export async function requireSchoolAdmin(
  ctx: QueryCtx | MutationCtx
): Promise<Doc<"users">> {
  const user = await requireUser(ctx);
  if (!isSchoolAdminRole(user.role) && !isPlatformAdminRole(user.role)) {
    throw new Error("Forbidden: school-admin role required");
  }
  return user;
}

/**
 * Action-side counterpart to `requireCurriculumAccess`. Action ctx has
 * no `ctx.db`, so we go through an internal query to read the user
 * doc. Returns the userId (which is what most action handlers need
 * for downstream `ctx.runQuery` / `ctx.runMutation` calls); the full
 * user doc isn't returned to keep the contract narrow.
 *
 * Use from any `"use node"` or regular action that's gated to
 * teacher / admin / curriculum_designer.
 */
export async function requireCurriculumAccessAction(
  ctx: GenericActionCtx<DataModel>
): Promise<Id<"users">> {
  const userId = await getAuthUserId(ctx);
  if (!userId) throw new Error("Not signed in");
  const hasAccess = await ctx.runQuery(internal.users.hasCurriculumAccessInternal, {
    id: userId,
  });
  if (!hasAccess) {
    throw new Error("Forbidden: curriculum access required");
  }
  return userId;
}

/**
 * Action-side counterpart to the teacher/admin gate. Narrower than
 * `requireCurriculumAccessAction` — excludes curriculum_designer.
 * Use when the matching READ path is teacher-only (e.g. the scanner
 * inbox feeds), so a designer can't write into a queue they can't see.
 */
export async function requireTeacherOrAdminAction(
  ctx: GenericActionCtx<DataModel>
): Promise<Id<"users">> {
  const userId = await getAuthUserId(ctx);
  if (!userId) throw new Error("Not signed in");
  const user = await ctx.runQuery(internal.users.getByIdInternal, {
    id: userId,
  });
  if (!user || !isTeacherRole(user.role)) {
    throw new Error("Forbidden: teacher or admin role required");
  }
  return userId;
}

/**
 * Action-side scholar-admin gate (teacher / admin / operations staff). Use when
 * the matching READ path is `requireScholarAdmin` (the scanner inbox feeds), so
 * the roles allowed to write into the inbox match the roles allowed to read it.
 * Operations staff (base `staff` + a `school:operations` grant) triage the
 * inbox, so they may also feed it (uploads / Drive picks) — mirroring
 * `requireScholarAdmin`, which grants on the same capability.
 */
export async function requireScholarAdminAction(
  ctx: GenericActionCtx<DataModel>
): Promise<Id<"users">> {
  const userId = await getAuthUserId(ctx);
  if (!userId) throw new Error("Not signed in");
  const user = await ctx.runQuery(internal.users.getByIdInternal, {
    id: userId,
  });
  if (!user) throw new Error("Forbidden: scholar-admin role required");
  if (!isScholarAdminRole(user.role)) {
    const opsIds = await ctx.runQuery(
      internal.users.schoolOperationsInstitutionIdsInternal,
      { id: userId },
    );
    const hasOperations = opsIds === "all" || opsIds.length > 0;
    if (!hasOperations) {
      throw new Error("Forbidden: scholar-admin role required");
    }
  }
  return userId;
}

/**
 * Action-side staff gate — every role with elevated access, operations staff and
 * curriculum_designer included.
 *
 * Use for capabilities that belong to *being staff* rather than to any one
 * job: notably linking your own Google account. Reading your own Drive isn't
 * a curriculum power — Google already decides which files you can see, so the
 * narrower `requireCurriculumAccessAction` only ever excluded staff from
 * their own documents. Keep genuinely curriculum-shaped writes on that gate.
 */
export async function requireStaffAction(
  ctx: GenericActionCtx<DataModel>
): Promise<Id<"users">> {
  const userId = await getAuthUserId(ctx);
  if (!userId) throw new Error("Not signed in");
  const user = await ctx.runQuery(internal.users.getByIdInternal, {
    id: userId,
  });
  if (!user || !isStaffRole(user.role)) {
    throw new Error("Forbidden: staff role required");
  }
  return userId;
}

/**
 * Action-side counterpart to `requireSchoolAdmin`: a `school_admin`
 * (institution leader) OR a `platform_admin` (who can act in any institution).
 * Gates institution-scoped INFRA actions from an action ctx — e.g. connecting a
 * school's Drive-sync inbox / linking its institution-owned sync identity.
 *
 * The institution SCOPE itself (which school this write lands in) is resolved
 * separately against the caller's membership (see
 * `driveSync.resolveInstitutionForCaller`), mirroring the query-side
 * `resolveInstitutionLens` WRITE guard so a school_admin can only touch their
 * own institution while a platform_admin may act in any.
 */
export async function requireSchoolAdminAction(
  ctx: GenericActionCtx<DataModel>
): Promise<Id<"users">> {
  const userId = await getAuthUserId(ctx);
  if (!userId) throw new Error("Not signed in");
  const user = await ctx.runQuery(internal.users.getByIdInternal, {
    id: userId,
  });
  if (
    !user ||
    (!isSchoolAdminRole(user.role) && !isPlatformAdminRole(user.role))
  ) {
    throw new Error("Forbidden: school-admin role required");
  }
  return userId;
}
