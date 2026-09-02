import { v } from "convex/values";

import { internal } from "./_generated/api";
import { internalMutation, internalQuery } from "./_generated/server";

export const getById = internalQuery({
  args: { id: v.id("flairArt") },
  handler: async (ctx, { id }) => {
    const row = await ctx.db.get(id);
    if (!row) return null;
    return {
      ...row,
      imageUrl: row.imageStorageId
        ? await ctx.storage.getUrl(row.imageStorageId)
        : null,
    };
  },
});

export const listPendingForGeneration = internalQuery({
  args: { limit: v.number() },
  handler: async (ctx, { limit }) =>
    await ctx.db
      .query("flairArt")
      .withIndex("by_status", (q) => q.eq("status", "pending"))
      .take(Math.max(1, Math.min(Math.floor(limit), 8))),
});

export const listFailedForRecovery = internalQuery({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db
      .query("flairArt")
      .withIndex("by_status", (q) => q.eq("status", "failed"))
      .take(500);
    return rows.map((row) => ({
      id: row._id,
      sourceLabel: row.sourceLabel,
      attemptCount: row.attemptCount,
      failedAt: row.failedAt,
    }));
  },
});

export const markReady = internalMutation({
  args: {
    id: v.id("flairArt"),
    imageStorageId: v.id("_storage"),
    prompt: v.string(),
    generationModel: v.string(),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db.get(args.id);
    if (!existing || existing.status !== "pending") return false;
    if (
      existing.imageStorageId &&
      existing.imageStorageId !== args.imageStorageId
    ) {
      await ctx.storage.delete(existing.imageStorageId);
    }
    await ctx.db.patch(args.id, {
      status: "ready",
      imageStorageId: args.imageStorageId,
      prompt: args.prompt,
      generationModel: args.generationModel,
      failedAt: undefined,
    });
    return true;
  },
});

export const markFailed = internalMutation({
  args: { id: v.id("flairArt") },
  handler: async (ctx, { id }) => {
    const existing = await ctx.db.get(id);
    if (!existing || existing.status !== "pending") return false;
    await ctx.db.patch(id, {
      status: "failed",
      failedAt: Date.now(),
    });
    return true;
  },
});

export const retryFailed = internalMutation({
  args: { id: v.id("flairArt") },
  handler: async (ctx, { id }) => {
    const existing = await ctx.db.get(id);
    if (!existing) throw new Error("Flair art not found");
    if (existing.status !== "failed") return false;
    const now = Date.now();
    await ctx.db.patch(id, {
      status: "pending",
      attemptCount: existing.attemptCount + 1,
      lastAttemptAt: now,
      failedAt: undefined,
    });
    await ctx.scheduler.runAfter(0, internal.flairArtActions.generateFlairArt, {
      id,
    });
    return true;
  },
});

export const prepareManualGeneration = internalMutation({
  args: { id: v.id("flairArt") },
  handler: async (ctx, { id }) => {
    const existing = await ctx.db.get(id);
    if (!existing || existing.status !== "failed") return false;
    await ctx.db.patch(id, {
      status: "pending",
      attemptCount: existing.attemptCount + 1,
      lastAttemptAt: Date.now(),
      failedAt: undefined,
    });
    return true;
  },
});
