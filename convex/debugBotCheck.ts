// Tiny helper for Playwright verifications — counts activities whose
// title starts with a given prefix. Not used by the app.

import { v } from "convex/values";
import { internalQuery } from "./_generated/server";

export const countActivitiesWithTitle = internalQuery({
  args: { prefix: v.string() },
  handler: async (ctx, args) => {
    const all = await ctx.db.query("activities").collect();
    return all.filter((a) => a.title.startsWith(args.prefix)).length;
  },
});
