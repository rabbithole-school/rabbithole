import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { ROLES, isPlatformAdminRole } from "./roles";
import { isEnrolledScholar } from "./enrollmentStanding";
import {
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
  allowedInstitutionIds: Set<Id<"institutions">>;
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
  const isAdmin =
    isPlatformAdminRole(user.role) ||
    memberships.some((m) => isPlatformAdminRole(m.role));
  const explicitCapabilityIds = await staffCapabilityInstitutionIds(
    ctx,
    user._id,
  );
  const operationsScope =
    "schoolOperationsInstitutionIds" in user
      ? user.schoolOperationsInstitutionIds
      : undefined;
  const staffMemberships = memberships
    .filter(
      (membership) =>
        isInstitutionStaffMembership(membership) &&
        (membership.role !== ROLES.STAFF ||
          (!!membership.institutionId &&
            explicitCapabilityIds.has(membership.institutionId))) &&
        (operationsScope === undefined ||
          operationsScope === "all" ||
          (!!membership.institutionId &&
            operationsScope.has(membership.institutionId))),
    )
    .sort((a, b) => a._creationTime - b._creationTime);

  const membershipInstitutionIds = new Set(
    staffMemberships.map((m) => m.institutionId!),
  );
  const allowedInstitutionIds = isAdmin
    ? new Set(institutions.map((i) => i._id))
    : new Set(membershipInstitutionIds);

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
 */
export function scholarInLens(
  lens: ResolvedInstitutionLens,
  scholar: Doc<"users">,
): boolean {
  if (lens.scope === "all") {
    if (lens.isAdmin) return true;
    if (scholar.institutionId === undefined) {
      const primaryId = lens.primaryInstitution?._id;
      return !!primaryId && lens.allowedInstitutionIds.has(primaryId);
    }
    return lens.allowedInstitutionIds.has(scholar.institutionId);
  }
  const activeInstitution = lens.institution;
  if (!activeInstitution) return false;
  if (scholar.institutionId === activeInstitution._id) return true;
  return scholar.institutionId === undefined && !!activeInstitution.isPrimary;
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

  const institutionIds =
    lens.scope === "institution"
      ? lens.institution
        ? [lens.institution._id]
        : []
      : [...lens.allowedInstitutionIds];
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

  if (institutionIdInLens(lens, undefined)) {
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
