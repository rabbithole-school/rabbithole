import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { canAccessScholar, resolveActiveMembership } from "./access";
import { ROLES, isPlatformAdminRole, isStaffRole } from "./roles";
import { scholarInstitutionId } from "./scholarEnrollment";

type AuthedQueryCtx = QueryCtx & { user: Doc<"users"> };

async function primaryInstitution(
  ctx: QueryCtx | MutationCtx,
): Promise<Doc<"institutions"> | null> {
  const institutions = await ctx.db.query("institutions").collect();
  return institutions.find((institution) => institution.isPrimary) ?? null;
}

/**
 * Resolve the institution stamped on a newly-created unit.
 *
 * Scholars carry their institution on the user row. Staff units follow the
 * caller's active membership, with the primary institution as the transition
 * fallback for legacy staff who have not been backfilled into memberships.
 */
export async function institutionIdForUnitAuthor(
  ctx: MutationCtx,
  userId: Id<"users">,
  options: { asScholar?: boolean } = {},
): Promise<Id<"institutions"> | undefined> {
  const user = await ctx.db.get(userId);
  if (!user) throw new Error("Unit author not found");
  if (options.asScholar) {
    return (await scholarInstitutionId(ctx, userId)) ??
      (await primaryInstitution(ctx))?._id;
  }
  if (user.institutionId) return user.institutionId;

  const activeMembership = await resolveActiveMembership(ctx, user);
  if (activeMembership?.institutionId) return activeMembership.institutionId;

  return (await primaryInstitution(ctx))?._id;
}

/**
 * Require read access to a unit.
 *
 * Platform admins are global. Independent Study units belong to their scholar:
 * the scholar, their guardians, and staff in that scholar's institution may
 * read them. Catalog units belong to their stamped institution; legacy
 * unstamped units belong to the primary institution.
 */
export async function requireUnitAccessForUser(
  ctx: QueryCtx | MutationCtx,
  user: Doc<"users">,
  unitId: Id<"units">,
): Promise<Doc<"units">> {
  const unit = await ctx.db.get(unitId);
  if (!unit) throw new Error("Unit not found");

  const memberships = await ctx.db
    .query("memberships")
    .withIndex("by_user", (q) => q.eq("userId", user._id))
    .collect();
  if (
    isPlatformAdminRole(user.role) ||
    memberships.some((membership) => isPlatformAdminRole(membership.role))
  ) {
    return unit;
  }

  const primary = await primaryInstitution(ctx);

  if (unit.authorScholarId) {
    if (unit.authorScholarId === user._id) return unit;

    const guardianship = await ctx.db
      .query("guardianships")
      .withIndex("by_pair", (q) =>
        q
          .eq("parentUserId", user._id)
          .eq("scholarUserId", unit.authorScholarId!),
      )
      .first();
    if (guardianship) return unit;

    for (const membership of memberships) {
      if (await canAccessScholar(ctx, membership, unit.authorScholarId)) {
        return unit;
      }
    }
    throw new Error("Forbidden: unit is not in your institution");
  }

  const unitInstitutionId = unit.institutionId ?? primary?._id;
  // A deployment with no institution rows is still the legacy single-tenant
  // world. Preserve its pre-migration behavior until a primary row exists.
  if (!unitInstitutionId && unit.institutionId === undefined) return unit;

  const callerInstitutionIds = new Set(
    memberships
      .map((membership) => membership.institutionId)
      .filter(
        (institutionId): institutionId is Id<"institutions"> =>
          institutionId !== undefined,
      ),
  );
  if (user.institutionId) {
    callerInstitutionIds.add(user.institutionId);
  } else if (user.role === ROLES.SCHOLAR && primary) {
    // Mirrors scholarInLens: an unstamped legacy scholar belongs to primary.
    callerInstitutionIds.add(primary._id);
  } else if (
    isStaffRole(user.role) &&
    callerInstitutionIds.size === 0 &&
    primary
  ) {
    // Transition safety mirrors other institution-scoped staff surfaces:
    // pre-membership staff remain members of the legacy primary catalog.
    callerInstitutionIds.add(primary._id);
  }
  if (unitInstitutionId && callerInstitutionIds.has(unitInstitutionId)) {
    return unit;
  }

  throw new Error("Forbidden: unit is not in your institution");
}

export async function requireUnitAccess(
  ctx: AuthedQueryCtx,
  unitId: Id<"units">,
): Promise<Doc<"units">> {
  return await requireUnitAccessForUser(ctx, ctx.user, unitId);
}
