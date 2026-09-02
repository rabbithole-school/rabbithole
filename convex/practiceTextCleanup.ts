/**
 * One-time, batched cleanup for practice text persisted before the plain-text
 * contract was enforced. Writes require an explicit deployment env gate and
 * confirmation token; this helper is intentionally not run by deploys or seeds.
 */
import { v } from "convex/values";
import { internalMutation } from "./_generated/server";
import { stripMarkdownFormatting } from "./lib/practice/plainText";

const BATCH_SIZE = 100;

export const cleanupMarkdownFormatting = internalMutation({
  args: {
    phase: v.union(v.literal("items"), v.literal("placements")),
    cursor: v.optional(v.string()),
    dryRun: v.optional(v.boolean()),
    confirm: v.literal("practice-plain-text-v1"),
  },
  handler: async (ctx, args) => {
    const dryRun = args.dryRun ?? true;
    if (!dryRun && process.env.PRACTICE_TEXT_CLEANUP_ENABLED !== "true") {
      throw new Error("Set PRACTICE_TEXT_CLEANUP_ENABLED=true to allow cleanup writes");
    }

    if (args.phase === "items") {
      const page = await ctx.db.query("practiceItems").paginate({
        cursor: args.cursor ?? null,
        numItems: BATCH_SIZE,
      });
      let changed = 0;
      for (const item of page.page) {
        const stem = stripMarkdownFormatting(item.stem);
        if (stem === item.stem) continue;
        changed++;
        if (!dryRun) await ctx.db.patch(item._id, { stem });
      }
      return {
        phase: args.phase,
        dryRun,
        scanned: page.page.length,
        changed,
        done: page.isDone,
        cursor: page.isDone ? null : page.continueCursor,
      };
    }

    const page = await ctx.db.query("practicePlacements").paginate({
      cursor: args.cursor ?? null,
      numItems: BATCH_SIZE,
    });
    let changed = 0;
    for (const placement of page.page) {
      let rowChanged = false;
      const probeLog = placement.probeLog?.map((entry) => {
        if (!entry.explanation) return entry;
        const explanation = stripMarkdownFormatting(entry.explanation);
        if (explanation === entry.explanation) return entry;
        rowChanged = true;
        return { ...entry, explanation };
      });
      if (!rowChanged || !probeLog) continue;
      changed++;
      if (!dryRun) await ctx.db.patch(placement._id, { probeLog });
    }
    return {
      phase: args.phase,
      dryRun,
      scanned: page.page.length,
      changed,
      done: page.isDone,
      cursor: page.isDone ? null : page.continueCursor,
    };
  },
});
