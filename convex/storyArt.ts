// V8-runtime database helpers for the one-off story-art attachment action.
// The Node action in storyArtAssets.ts owns byte decoding + storage; these
// helpers keep database reads and writes in mutation/query transactions.

import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";

export const attachmentForNode = internalQuery({
  args: { nodeKey: v.string() },
  handler: async (ctx, { nodeKey }) => {
    const node = await ctx.db
      .query("knowledgeNodes")
      .withIndex("by_nodeKey", (q) => q.eq("nodeKey", nodeKey))
      .unique();
    if (!node) return null;
    return {
      nodeId: node._id,
      artStorageId: node.artStorageId,
      artContentHash: node.artContentHash,
      artStatus: node.artStatus,
    };
  },
});

export const setAttachment = internalMutation({
  args: {
    nodeId: v.id("knowledgeNodes"),
    artStorageId: v.id("_storage"),
    artContentHash: v.string(),
  },
  handler: async (ctx, args) => {
    const node = await ctx.db.get(args.nodeId);
    if (!node) throw new Error("Story-art knowledge node not found");
    await ctx.db.patch(args.nodeId, {
      artStorageId: args.artStorageId,
      artContentHash: args.artContentHash,
      artStatus: "ready",
    });
    return { previousArtStorageId: node.artStorageId ?? null };
  },
});
