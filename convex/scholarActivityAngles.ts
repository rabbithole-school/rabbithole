// Per-scholar angles on activities (Phase F of the kill-quests
// refactor). Each row: { scholarId, activityId, title, description }.

import { v } from "convex/values";
import { authedQuery } from "./lib/customFunctions";

/** Read the calling scholar's angle on a specific activity, if any. */
export const getMyAngleForActivity = authedQuery({
  args: { activityId: v.id("activities") },
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("scholarActivityAngles")
      .withIndex("by_scholar_activity", (q) =>
        q.eq("scholarId", ctx.user._id).eq("activityId", args.activityId),
      )
      .first();
    return row ?? null;
  },
});

/** Teacher-facing: every scholar's angle on this activity. Used by
 *  the activity detail panel in the Curriculum > Units browser. */
export const listAnglesForActivity = authedQuery({
  args: { activityId: v.id("activities") },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("scholarActivityAngles")
      .withIndex("by_activity", (q) => q.eq("activityId", args.activityId))
      .collect();
    return Promise.all(
      rows.map(async (r) => {
        const scholar = await ctx.db.get(r.scholarId);
        return {
          _id: r._id,
          scholarId: r.scholarId,
          scholarName: scholar?.name ?? scholar?.username ?? "(unknown)",
          title: r.title,
          description: r.description,
          setAt: r.setAt,
          setBy: r.setBy,
        };
      }),
    );
  },
});
