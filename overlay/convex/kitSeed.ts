// KIT OVERLAY (not part of the public snapshot).
// The public seed functions create users + institutions but no `memberships`
// rows, and the snapshot omits the module that backfills them. Staff scoping
// reads the active membership, so without this a seeded teacher sees zero
// scholars. Same rule as the original backfill: scholar -> their
// institution; teacher -> the primary institution; other roles -> global.
import { internalMutation } from "./_generated/server";
import { ensureMembership } from "./memberships";
import { ROLES } from "./lib/roles";
import type { Id } from "./_generated/dataModel";

export const backfillMemberships = internalMutation({
  args: {},
  handler: async (ctx) => {
    const institutions = await ctx.db.query("institutions").collect();
    const primary = institutions.find((i) => i.isPrimary);
    let created = 0;
    const skipped: string[] = [];
    for (const u of await ctx.db.query("users").collect()) {
      const role = u.role;
      if (!role) continue;
      let institutionId: Id<"institutions"> | undefined;
      if (role === ROLES.SCHOLAR) {
        institutionId = u.institutionId;
        if (!institutionId) {
          skipped.push(u.username ?? u._id);
          continue;
        }
      } else if (role === ROLES.TEACHER) {
        institutionId = primary?._id;
      }
      const existing = await ctx.db
        .query("memberships")
        .withIndex("by_user_role", (q) => q.eq("userId", u._id).eq("role", role))
        .collect();
      if (existing.some((m) => m.institutionId === institutionId)) continue;
      await ensureMembership(ctx, { userId: u._id, role, institutionId });
      created++;
    }
    return { created, skipped: skipped.length, primary: primary?.slug ?? null };
  },
});
