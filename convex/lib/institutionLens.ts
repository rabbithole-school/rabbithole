import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { ROLES, isPlatformAdminRole } from "./roles";
import { isEnrolledScholar } from "./enrollmentStanding";
import {
  authorizedInstitutionIds,
  staffCapabilityInstitutionIds,
  type SchoolOperationsPrincipal,
} from "./staffCapabilities";
import {
  allScholarIds,
  scholarIdsForInstitution,
} from "./scholarEnrollment";

export type InstitutionLensScope = "institution" | "all";

export type ResolvedInstitutionLens = {
  scope: InstitutionLensScope;
  requestedScope: string;
  honored: boolean;
  isAdmin: boolean;
  institution: Doc<"institutions"> | null;
  homeInstitution: Doc<"institutions"> | null;
  primaryInstitution: Doc<"institutions"> | null;
  /**
   * Every institution the caller may SCOPE to: curriculum, programs, health,
   * devices, config. Wider than scholar reads — a scoped curriculum designer,
   * or a `staff` member holding only curriculum:edit / health:manage / a
   * group-scoped grant, has lens standing here.
   */
  allowedInstitutionIds: Set<Id<"institutions">>;
  /**
   * The subset of `allowedInstitutionIds` where the caller may READ SCHOLARS
   * (identities + learning record) — the canonical scholar-read basis of
   * `canUserAccessScholar` / `accessibleScholarIds`: a teacher or school_admin
   * membership, or a `staff` membership with an institution-wide
   * school:operations grant. `scholarInLens` / `scholarIdsInLens` consult this,
   * never `allowedInstitutionIds` alone, so a lens honored for curriculum or
   * program scoping never doubles as a scholar roster (TRA-374).
   * Platform admins: every institution.
   */
  scholarReadInstitutionIds: Set<Id<"institutions">>;
  /** Staff standing at any school, suspended ones included (see resolver). */
  hasStaffMembership: boolean;
};

function isInstitutionStaffMembership(m: Doc<"memberships">): boolean {
  return (
    (m.role === ROLES.TEACHER ||
      m.role === ROLES.STAFF ||
      m.role === ROLES.CURRICULUM_DESIGNER ||
      m.role === ROLES.SCHOOL_ADMIN) &&
    !!m.institutionId
  );
}

function sortInstitutions(institutions: Doc<"institutions">[]) {
  return [...institutions].sort((a, b) => {
    const ar = a.isPrimary ? 0 : a.kind === "school" ? 1 : 2;
    const br = b.isPrimary ? 0 : b.kind === "school" ? 1 : 2;
    return ar - br || a.name.localeCompare(b.name);
  });
}

/**
 * Resolve the active institution lens from a shareable URL value.
 *
 * The caller may ask for "all", "", "primary", a pretty institution slug, or
 * a legacy institution id.
 * We only honor an institution when the caller is an admin or has a staff
 * membership for that institution. Invalid/non-member slugs fall back to the
 * user's home membership. A membership-less staffer has no institution lens.
 */
export async function resolveInstitutionLens(
  ctx: QueryCtx,
  user: Doc<"users"> | SchoolOperationsPrincipal,
  requestedScope?: string | null,
): Promise<ResolvedInstitutionLens> {
  const requested = (requestedScope ?? "").trim();
  const institutions = sortInstitutions(
    (await ctx.db.query("institutions").collect()).filter(
      (institution) => !institution.disabledAt,
    ),
  );
  const institutionById = new Map(institutions.map((i) => [i._id, i]));
  const primaryInstitution = institutions.find((i) => i.isPrimary) ?? institutions[0] ?? null;

  const memberships = await ctx.db
    .query("memberships")
    .withIndex("by_user", (q) => q.eq("userId", user._id))
    .collect();
  // Platform admins get the cross-institution lens.
  // School admins are institution-scoped — they fall through to the
  // membership-based scoping below, like teacher/operations staff.
  // Platform-admin standing comes from users.role alone (TRA-375).
  const isAdmin = isPlatformAdminRole(user.role);
  const explicitCapabilityIds = await staffCapabilityInstitutionIds(
    ctx,
    user._id,
  );
  const operationsScope =
    "schoolOperationsInstitutionIds" in user
      ? user.schoolOperationsInstitutionIds
      : undefined;
  const hasStaffStanding = (membership: Doc<"memberships">) =>
    isInstitutionStaffMembership(membership) &&
    (membership.role !== ROLES.STAFF ||
      (!!membership.institutionId &&
        explicitCapabilityIds.has(membership.institutionId))) &&
    (operationsScope === undefined ||
      operationsScope === "all" ||
      (!!membership.institutionId &&
        operationsScope.has(membership.institutionId)));
  // A suspended school's members cannot use the app there, so its membership
  // gives no lens — `institutions` holds live schools only.
  const staffMemberships = memberships
    .filter(
      (membership) =>
        hasStaffStanding(membership) &&
        institutionById.has(membership.institutionId!),
    )
    .sort((a, b) => a._creationTime - b._creationTime);
  // Whether the user holds staff standing anywhere, suspended schools
  // included. An empty lens because the user's school is suspended must not
  // read as "a membership-less staffer" (who falls back to the primary
  // school, e.g. units.ts curriculumUnitsInLens). A staff membership at a
  // school that is not live counts on its own: its capability grants and
  // operations scope are already filtered to live schools, so
  // `hasStaffStanding` would drop it and re-open that fallback.
  const hasStaffMembership = memberships.some(
    (membership) =>
      hasStaffStanding(membership) ||
      (isInstitutionStaffMembership(membership) &&
        !!membership.institutionId &&
        !institutionById.has(membership.institutionId)),
  );

  const membershipInstitutionIds = new Set(
    staffMemberships.map((m) => m.institutionId!),
  );
  const allowedInstitutionIds = isAdmin
    ? new Set(institutions.map((i) => i._id))
    : new Set(membershipInstitutionIds);
  // Scholar-read standing is narrower than lens standing. Institution-wide
  // grants only: a group-scoped grant (program:publish / captures:review)
  // never confers school-wide scholar reads, and neither do curriculum:edit,
  // health:manage, or a curriculum_designer membership.
  const operationsGrantIds = isAdmin
    ? new Set<Id<"institutions">>()
    : await authorizedInstitutionIds(ctx, user._id, "school:operations");
  const scholarReadInstitutionIds = isAdmin
    ? allowedInstitutionIds
    : new Set(
        staffMemberships
          .filter(
            (m) =>
              m.role === ROLES.TEACHER ||
              m.role === ROLES.SCHOOL_ADMIN ||
              (m.role === ROLES.STAFF &&
                operationsGrantIds.has(m.institutionId!)),
          )
          .map((m) => m.institutionId!),
      );

  const primaryMembership = staffMemberships.find((m) => {
    const inst = m.institutionId ? institutionById.get(m.institutionId) : null;
    return !!inst?.isPrimary;
  });
  const homeMembership = primaryMembership ?? staffMemberships[0] ?? null;
  const homeInstitution =
    (isAdmin ? primaryInstitution : null) ??
    (homeMembership?.institutionId
      ? institutionById.get(homeMembership.institutionId)
      : null) ??
    null;

  const fallback = (honored: boolean): ResolvedInstitutionLens => ({
    scope: "institution",
    requestedScope: requested,
    honored,
    isAdmin,
    institution: homeInstitution,
    homeInstitution,
    primaryInstitution,
    allowedInstitutionIds,
    scholarReadInstitutionIds,
    hasStaffMembership,
  });

  if (requested === "all") {
    return {
      scope: "all",
      requestedScope: requested,
      honored: true,
      isAdmin,
      institution: null,
      homeInstitution,
      primaryInstitution,
      allowedInstitutionIds,
      scholarReadInstitutionIds,
      hasStaffMembership,
    };
  }

  if (!requested || requested === "primary") {
    return fallback(true);
  }

  const requestedInstitution =
    institutions.find((i) => i.slug === requested || i._id === requested) ?? null;
  if (
    requestedInstitution &&
    (isAdmin || allowedInstitutionIds.has(requestedInstitution._id))
  ) {
    return {
      scope: "institution",
      requestedScope: requested,
      honored: true,
      isAdmin,
      institution: requestedInstitution,
      homeInstitution,
      primaryInstitution,
      allowedInstitutionIds,
      scholarReadInstitutionIds,
      hasStaffMembership,
    };
  }

  return fallback(false);
}

export function institutionLensClientPayload(lens: ResolvedInstitutionLens) {
  const homeId = lens.homeInstitution?._id ?? null;
  const institutionId = lens.institution?._id ?? null;
  const isHome =
    lens.scope === "institution" && !!homeId && !!institutionId && homeId === institutionId;
  return {
    scope: lens.scope,
    requestedScope: lens.requestedScope || null,
    honored: lens.honored,
    isAdmin: lens.isAdmin,
    institutionId,
    institutionSlug: lens.institution?.slug ?? null,
    institutionName: lens.institution?.name ?? null,
    institutionEmoji: lens.institution?.emoji ?? null,
    institutionIsPrimary: lens.institution?.isPrimary ?? false,
    homeInstitutionId: homeId,
    homeInstitutionSlug: lens.homeInstitution?.slug ?? null,
    isHome,
    scopeParam:
      lens.scope === "all"
        ? "all"
        : isHome
          ? ""
          : lens.institution?.slug ?? "",
  };
}

/**
 * Does a scholar fall within the active institution lens? This is the single
 * source of truth for "is this scholar visible under ?inst=", shared by the
 * Scholars roster (users.listScholars) and every other surface that scopes its
 * scholar set by institution (the aide, Messages, Quests, the class lenses).
 *
 * Rules (mirrors the roster): an "all" lens shows every allowed institution (a
 * platform admin: all); an "institution" lens shows that one school, and
 * unassigned scholars (institutionId === undefined) ride the PRIMARY school's
 * lens during the pre-backfill window so they never vanish.
 *
 * Beyond the lens, a non-admin must hold scholar-read standing at the school
 * (`scholarReadInstitutionIds`): an honored ?inst= for a school where the
 * caller only designs curriculum or holds a non-operations grant scopes that
 * caller's curriculum/program surfaces but yields no scholars (TRA-374).
 */
export function scholarInLens(
  lens: ResolvedInstitutionLens,
  scholar: Doc<"users">,
): boolean {
  return scholarInstitutionReadableInLens(lens, scholar.institutionId);
}

/**
 * Is `institutionId` inside the lens AND a school where the caller may read
 * scholars? The gate for anything that reads or writes a school's scholar
 * set by its stamped institution — scholar groups, their rosters and
 * audiences — as opposed to `institutionIdInLens`, which also admits
 * curriculum/program-only standing (TRA-386, following TRA-374). An
 * unstamped id counts as the primary school.
 */
export function scholarInstitutionReadableInLens(
  lens: ResolvedInstitutionLens,
  institutionId: Id<"institutions"> | undefined,
): boolean {
  if (!institutionIdInLens(lens, institutionId)) return false;
  if (lens.isAdmin) return true;
  // An unstamped scholar belongs to the primary school (same rule as above).
  const effectiveId = institutionId ?? lens.primaryInstitution?._id;
  return !!effectiveId && lens.scholarReadInstitutionIds.has(effectiveId);
}

/**
 * Does a parent account belong to the active institution lens?
 *
 * A parent's scope comes from `guardianships`. An institution-stamped STAFF
 * membership also counts for multi-role adults. A `parent`-role membership
 * never does, even when stamped: an admissions applicant's parent carries one
 * at the school they applied to, and treating it as standing would hand every
 * scholar-admin there the claim-invite, enroll-link and Slack lookup tools for
 * a family that has no enrolled child. Platform admins remain global.
 */
export async function parentInLens(
  ctx: QueryCtx,
  lens: ResolvedInstitutionLens,
  parentId: Id<"users">,
): Promise<boolean> {
  if (lens.isAdmin) return true;

  const memberships = await ctx.db
    .query("memberships")
    .withIndex("by_user", (q) => q.eq("userId", parentId))
    .collect();
  if (
    memberships.some(
      (membership) =>
        membership.role !== ROLES.PARENT &&
        !!membership.institutionId &&
        institutionIdInLens(lens, membership.institutionId),
    )
  ) {
    return true;
  }

  const guardianships = await ctx.db
    .query("guardianships")
    .withIndex("by_parent", (q) => q.eq("parentUserId", parentId))
    .collect();
  for (const guardianship of guardianships) {
    const scholar = await ctx.db.get(guardianship.scholarUserId);
    if (
      scholar?.role === ROLES.SCHOLAR &&
      institutionIdInLens(lens, scholar.institutionId)
    ) {
      return true;
    }
  }
  return false;
}

/**
 * The set of scholar userIds visible under the lens.
 *
 * Institution-scoped lenses read only the matching institution rows. The
 * platform-admin "all" lens intentionally retains the global scholar index.
 */
export async function scholarIdsInLens(
  ctx: QueryCtx,
  lens: ResolvedInstitutionLens,
  { includeProgramGuests = false }: { includeProgramGuests?: boolean } = {},
): Promise<Set<Id<"users">>> {
  if (lens.scope === "all" && lens.isAdmin) {
    const ids = await allScholarIds(ctx);
    if (includeProgramGuests) return ids;
    const enrolled = new Set<Id<"users">>();
    for (const id of ids) {
      const scholar = await ctx.db.get(id);
      if (scholar && isEnrolledScholar(scholar)) enrolled.add(id);
    }
    return enrolled;
  }

  const institutionIds = (
    lens.scope === "institution"
      ? lens.institution
        ? [lens.institution._id]
        : []
      : [...lens.allowedInstitutionIds]
  ).filter((id) => scholarInstitutionReadableInLens(lens, id));
  const scholarIds = new Set<Id<"users">>();
  for (const institutionId of institutionIds) {
    const ids = await scholarIdsForInstitution(ctx, institutionId);
    for (const id of ids) {
      const scholar = await ctx.db.get(id);
      if (scholar && (includeProgramGuests || isEnrolledScholar(scholar))) {
        scholarIds.add(id);
      }
    }
  }

  if (scholarInstitutionReadableInLens(lens, undefined)) {
    const unassignedUsers = await ctx.db
      .query("users")
      .withIndex("by_institution", (q) => q.eq("institutionId", undefined))
      .collect();
    for (const user of unassignedUsers) {
      if (
        user.role === ROLES.SCHOLAR &&
        (includeProgramGuests || isEnrolledScholar(user))
      ) {
        scholarIds.add(user._id);
      }
    }
  }

  return scholarIds;
}

/**
 * Does a row stamped with `institutionId` fall within the active lens? The
 * institution-agnostic sibling of `scholarInLens`, used to scope any tenant
 * data that carries an optional `institutionId` (e.g. the scanner inbox's
 * portfolioItems). Same rules: an "all" lens shows every allowed institution;
 * an "institution" lens shows that one school, and rows with no institutionId
 * ride the PRIMARY school's lens during the pre-backfill window.
 */
export function institutionIdInLens(
  lens: ResolvedInstitutionLens,
  institutionId: Id<"institutions"> | undefined,
): boolean {
  if (lens.scope === "all") {
    if (lens.isAdmin) return true;
    if (institutionId === undefined) {
      const primaryId = lens.primaryInstitution?._id;
      return !!primaryId && lens.allowedInstitutionIds.has(primaryId);
    }
    return lens.allowedInstitutionIds.has(institutionId);
  }
  const activeInstitution = lens.institution;
  if (!activeInstitution) return false;
  if (institutionId === activeInstitution._id) return true;
  return institutionId === undefined && !!activeInstitution.isPrimary;
}
