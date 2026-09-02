/**
 * Internal V8 helpers for practiceAtlas.ts (the "use node" build action).
 * Separated into this file because Convex's V8 runtime handles queries and
 * mutations; the node runtime (practiceAtlas.ts) handles the heavy I/O (the
 * OpenAI embedding call) and orchestrates them via ctx.runQuery / ctx.runMutation.
 */

import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";

/** Load all knowledgeNodes rows for a domain. */
export const _nodesForDomain = internalQuery({
  args: { domain: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("knowledgeNodes")
      .withIndex("by_domain", (q) => q.eq("domain", args.domain))
      .collect();
  },
});

/** Load all kind:"buildsOn" edges for a domain. */
export const _buildsOnEdgesForDomain = internalQuery({
  args: { domain: v.string() },
  handler: async (ctx, args) => {
    const all = await ctx.db
      .query("knowledgeNodeEdges")
      .withIndex("by_domain", (q) => q.eq("domain", args.domain))
      .collect();
    return all.filter((e) => e.kind === "buildsOn").map((e) => ({
      fromKey: e.fromKey,
      toKey: e.toKey,
    }));
  },
});

/** Patch treeX / treeY / treeY2 on a batch of knowledgeNodes rows. */
export const _patchAtlasPositions = internalMutation({
  args: {
    rows: v.array(
      v.object({
        id: v.id("knowledgeNodes"),
        treeX: v.number(),
        treeY: v.number(),
        treeY2: v.number(),
      }),
    ),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    for (const row of args.rows) {
      await ctx.db.patch(row.id, {
        treeX: row.treeX,
        treeY: row.treeY,
        treeY2: row.treeY2,
        projectedAt: now,
      });
    }
  },
});
