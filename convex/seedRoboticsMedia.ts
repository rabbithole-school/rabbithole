"use node";

import { internal } from "./_generated/api";
import { internalAction } from "./_generated/server";
import { roboticsPortfolioItems } from "./seed/rich/robotics";

export const attach = internalAction({
  args: {},
  handler: async (ctx): Promise<{ attached: number; skipped: number }> => {
    let attached = 0;
    let skipped = 0;

    for (const item of roboticsPortfolioItems) {
      const existing = await ctx.runQuery(
        internal.seedRichCohort.findRoboticsPortfolioItem,
        { title: item.title },
      );
      if (!existing) {
        skipped += 1;
        continue;
      }

      const fileSizeBytes = new TextEncoder().encode(item.svg).byteLength;
      const fileStorageId =
        existing.fileStorageId ??
        (await ctx.storage.store(
          new Blob([item.svg], { type: "image/svg+xml" }),
        ));
      await ctx.runMutation(
        internal.seedRichCohort.attachRoboticsPortfolioMedia,
        {
          portfolioItemId: existing._id,
          fileStorageId,
          fileSizeBytes,
        },
      );
      if (existing.fileStorageId) skipped += 1;
      else attached += 1;
    }

    return { attached, skipped };
  },
});
