import type { Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { hasGuardianships } from "./auth";
import { primaryInstitutionId } from "./primaryInstitution";
import { ROLES } from "./roles";

/**
 * Is `userId` an applicant-only parent: a family that has applied to the
 * primary institution but has no enrolled child linked yet?
 *
 * All three must hold:
 *   1. the user's role is `parent`;
 *   2. the user has NO guardianship (no linked child);
 *   3. the user holds a `parent`-role membership stamped with the primary
 *      institution (the stamp the application flow writes).
 *
 * The parent portal uses this to render its applicant-only mode, and the
 * guardian-only surfaces refuse these accounts. A guardianship always wins:
 * once a child is linked the family is an ordinary parent, whatever else is
 * true. Pure read (no auth check); callers authenticate.
 */
export async function isApplicantOnlyParent(
  ctx: QueryCtx | MutationCtx,
  userId: Id<"users">,
): Promise<boolean> {
  const user = await ctx.db.get(userId);
  if (!user || user.role !== ROLES.PARENT) return false;
  if (await hasGuardianships(ctx, userId)) return false;

  const primaryId = await primaryInstitutionId(ctx);
  if (!primaryId) return false;

  const parentMemberships = await ctx.db
    .query("memberships")
    .withIndex("by_user_role", (q) =>
      q.eq("userId", userId).eq("role", ROLES.PARENT),
    )
    .collect();
  return parentMemberships.some(
    (membership) => membership.institutionId === primaryId,
  );
}
