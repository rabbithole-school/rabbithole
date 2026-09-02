/**
 * Persistence for verified pad-grounded hint output. The action owns generation;
 * this file owns the transactional store + assisted marker.
 */

import { v } from "convex/values";
import { internalMutation } from "./_generated/server";

const answerType = v.union(
  v.literal("integer"),
  v.literal("decimal"),
  v.literal("fraction"),
  v.literal("expression"),
);

export const storeVerified = internalMutation({
  args: {
    scholarId: v.id("users"),
    itemId: v.string(),
    imageId: v.id("_storage"),
    nudge: v.string(),
    workedSteps: v.optional(
      v.array(
        v.object({
          text: v.string(),
          blankText: v.optional(v.string()),
          expected: v.optional(v.string()),
          answerType: v.optional(answerType),
        }),
      ),
    ),
    model: v.string(),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const hintId = await ctx.db.insert("practicePadHints", {
      ...args,
      createdAt: now,
    });
    await ctx.db.insert("practiceHintReveals", {
      scholarId: args.scholarId,
      itemId: args.itemId,
      // The nudge is rung 0. A later serveHintStep request may open step 0.
      maxStepServed: -1,
      createdAt: now,
    });
    return hintId;
  },
});
