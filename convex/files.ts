import { mutation } from "./_generated/server";
import { v } from "convex/values";
import { internalQuery } from "./_generated/server";
import { getAuthUserId } from "@convex-dev/auth/server";
import { assertCanWrite } from "./lib/auth";

/**
 * Generate a short-lived upload URL for file storage.
 * Called by the client before uploading an image.
 *
 * Authenticated-only: every caller (scholar/teacher/parent app surfaces and
 * the native chat image hook) runs as a signed-in user, so an anonymous caller
 * has no legitimate use for an upload URL.
 */
export const generateUploadUrl = mutation(async (ctx) => {
  const userId = await getAuthUserId(ctx);
  if (!userId) throw new Error("Not authenticated");
  await assertCanWrite(ctx);
  return await ctx.storage.generateUploadUrl();
});

/**
 * Internal query to get a file URL, for server-side callers (HTTP actions,
 * the observer).
 *
 * There is deliberately no public counterpart. A storage id is not proof of
 * ownership, and `_storage` is one namespace shared by every feature, so a
 * client gets a serving URL from the query that authorizes the row holding
 * the id, never from a generic resolver (TRA-389).
 */
export const getUrlInternal = internalQuery({
  args: { storageId: v.id("_storage") },
  handler: async (ctx, args) => {
    return await ctx.storage.getUrl(args.storageId);
  },
});
