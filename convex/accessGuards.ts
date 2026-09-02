import { v } from "convex/values";
import { internalQuery } from "./_generated/server";
import { requireActiveScholarAccess } from "./lib/access";
import { requireActiveSessionOwnerInstitution } from "./lib/scholarEnrollment";

/**
 * Action/HTTP bridge for the flag-gated scholar boundary. Query/mutation
 * handlers call requireActiveScholarAccess directly; actions must hop through
 * an internal query because they don't have ctx.db.
 */
export const requireActiveScholarAccessByUserId = internalQuery({
  args: {
    userId: v.id("users"),
    scholarId: v.id("users"),
  },
  handler: async (ctx, args) => {
    const user = await ctx.db.get(args.userId);
    if (!user) throw new Error("User not found");
    await requireActiveScholarAccess(ctx, user, args.scholarId);
    return true;
  },
});

/** Action/HTTP bridge for an owner acting inside a learner session. */
export const requireActiveLearnerSessionByUserId = internalQuery({
  args: {
    userId: v.id("users"),
    sessionId: v.id("sessions"),
  },
  handler: async (ctx, args) => {
    const session = await ctx.db.get(args.sessionId);
    if (!session || session.userId !== args.userId || session.isTestDrive) {
      return true;
    }
    const user = await ctx.db.get(args.userId);
    if (!user) throw new Error("User not found");
    await requireActiveSessionOwnerInstitution(ctx, user, session);
    return true;
  },
});
