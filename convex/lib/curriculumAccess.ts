import type { Doc } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { resolveActiveMembership } from "./access";
import { isCurriculumRole } from "./roles";
import {
  authorizedInstitutionIds,
  hasActiveInstitutionCapability,
} from "./staffCapabilities";

export async function curriculumAccessInstitutionIds(
  ctx: QueryCtx | MutationCtx,
  user: Doc<"users">,
): Promise<Set<NonNullable<Doc<"memberships">["institutionId"]>> | "all"> {
  if (isCurriculumRole(user.role)) return "all";
  return authorizedInstitutionIds(ctx, user._id, "curriculum:edit");
}

/**
 * Whether this user may design curriculum in their active institution context.
 *
 * A primary curriculum role remains sufficient. Otherwise, a staff member needs
 * an active institution-scoped `curriculum:edit` capability, which intentionally
 * grants no teacher or scholar-data access.
 */
export async function hasCurriculumAccess(
  ctx: QueryCtx | MutationCtx,
  user: Doc<"users">,
): Promise<boolean> {
  const allowed = await curriculumAccessInstitutionIds(ctx, user);
  if (allowed === "all") return true;
  const activeMembership = await resolveActiveMembership(ctx, user);
  if (!activeMembership?.institutionId) return false;
  return hasActiveInstitutionCapability(
    ctx,
    user._id,
    activeMembership.institutionId,
    "curriculum:edit",
  );
}

/**
 * Whether the user's curriculum capability applies to one target institution.
 * Primary curriculum roles are global; scoped capability grants are not.
 */
export async function hasCurriculumAccessForInstitution(
  ctx: QueryCtx | MutationCtx,
  user: Doc<"users">,
  institutionId: Doc<"units">["institutionId"],
): Promise<boolean> {
  const allowed = await curriculumAccessInstitutionIds(ctx, user);
  if (allowed === "all") return true;
  if (!institutionId) return await hasCurriculumAccess(ctx, user);
  return hasActiveInstitutionCapability(
    ctx,
    user._id,
    institutionId,
    "curriculum:edit",
  );
}
