/**
 * "Which scholarGroups is this scholar in?" — one home for a rule that is
 * easy to get subtly wrong and now has two consumers.
 *
 * `scholarGroups` has no by-scholar index, so membership is matched in JS.
 * The part worth centralizing is WHICH groups are even scanned: the
 * scholar's own school, plus (for a primary-school scholar only) legacy
 * groups that were never stamped with an institution. That mirrors
 * `institutionIdInLens` — an unstamped row belongs to the primary school —
 * and a deployment-wide scan would instead grow with every school that
 * joins rather than with this scholar's own school.
 *
 * Extracted verbatim from `convex/pushes.ts`'s private `groupIdsForScholar`
 * when the managed-app allowlist projector needed the same answer to resolve
 * a live `pushes` audience (convex/lib/deviceAppProjection.ts). Both call
 * this; neither re-derives it.
 */
import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";

export async function groupIdsForScholar(
  ctx: QueryCtx,
  scholar: Doc<"users">,
): Promise<Id<"scholarGroups">[]> {
  const scoped = scholar.institutionId
    ? await ctx.db
        .query("scholarGroups")
        .withIndex("by_institution", (q) =>
          q.eq("institutionId", scholar.institutionId),
        )
        .collect()
    : [];
  const institution = scholar.institutionId
    ? await ctx.db.get(scholar.institutionId)
    : null;
  const legacy = institution?.isPrimary
    ? await ctx.db
        .query("scholarGroups")
        .withIndex("by_institution", (q) => q.eq("institutionId", undefined))
        .collect()
    : [];
  return [...scoped, ...legacy]
    .filter((g) => g.scholarIds.includes(scholar._id))
    .map((g) => g._id);
}
