/**
 * Practice-image ownership boundary. Storage IDs are accepted by a model-facing
 * surface only when the server recorded that this scholar uploaded the bytes for
 * this exact item, or the ID is already attached to this scholar's attempt.
 */

import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";
import { requireTeacherOrSelf } from "./lib/auth";
import { requireActiveScholarAccess } from "./lib/access";

export const authorizeUpload = internalQuery({
  args: {
    callerId: v.id("users"),
    scholarId: v.id("users"),
  },
  handler: async (ctx, args) => {
    const caller = await ctx.db.get(args.callerId);
    if (!caller) throw new Error("Not authenticated");
    const isTeacher = requireTeacherOrSelf(caller, args.scholarId);
    if (isTeacher) {
      await requireActiveScholarAccess(ctx, caller, args.scholarId);
    }
    return { authorized: true as const };
  },
});

export const recordOwnedImage = internalMutation({
  args: {
    scholarId: v.id("users"),
    itemId: v.string(),
    storageId: v.id("_storage"),
    source: v.union(
      v.literal("hint"),
      v.literal("miss"),
      v.literal("handoff"),
      v.literal("dialogue"),
    ),
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert("practiceWorkImages", {
      ...args,
      createdAt: Date.now(),
    });
  },
});

export const ownedImage = internalQuery({
  args: {
    callerId: v.id("users"),
    scholarId: v.id("users"),
    itemId: v.string(),
    storageId: v.id("_storage"),
  },
  handler: async (ctx, args) => {
    const caller = await ctx.db.get(args.callerId);
    if (!caller) throw new Error("Not authenticated");
    const isTeacher = requireTeacherOrSelf(caller, args.scholarId);
    if (isTeacher) {
      await requireActiveScholarAccess(ctx, caller, args.scholarId);
    }

    const owned = await ctx.db
      .query("practiceWorkImages")
      .withIndex("by_storage", (q) => q.eq("storageId", args.storageId))
      .filter((q) =>
        q.and(
          q.eq(q.field("scholarId"), args.scholarId),
          q.eq(q.field("itemId"), args.itemId),
        ),
      )
      .first();
    if (owned) return { owned: true as const, source: owned.source };

    const attempts = await ctx.db
      .query("practiceAttempts")
      .withIndex("by_scholar_item_createdAt", (q) =>
        q.eq("scholarId", args.scholarId).eq("itemId", args.itemId),
      )
      .collect();
    const attempt = attempts.find((row) => row.workImageId === args.storageId);
    return attempt
      ? { owned: true as const, source: "miss" as const }
      : { owned: false as const };
  },
});
