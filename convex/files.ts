import { mutation } from "./_generated/server";
import { authedQuery } from "./lib/customFunctions";
import { v } from "convex/values";
import { internalQuery } from "./_generated/server";
import { getAuthUserId } from "@convex-dev/auth/server";

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
  return await ctx.storage.generateUploadUrl();
});

/**
 * Get a serving URL for a stored file.
 *
 * AUTHED, for the same reason as `getUrls` below: a plain public query here is
 * an unauthenticated URL-minting endpoint over the shared `_storage` namespace,
 * and every real caller (web + native chat, deliverable panels, slide export)
 * runs as a signed-in user. Public HTTP surfaces resolve their own URLs
 * server-side and must not route through this.
 */
export const getUrl = authedQuery({
  args: { storageId: v.id("_storage") },
  handler: async (ctx, args) => {
    return await ctx.storage.getUrl(args.storageId);
  },
});

/**
 * Internal query to get a file URL (for the HTTP action).
 */
export const getUrlInternal = internalQuery({
  args: { storageId: v.id("_storage") },
  handler: async (ctx, args) => {
    return await ctx.storage.getUrl(args.storageId);
  },
});

/**
 * Serving URLs for many stored files at once, returned as an
 * `[storageId, url]` pair list (a Record is not a valid Convex return value
 * with `Id` keys).
 *
 * Exists because a slide deck can hold several images and React hooks cannot be
 * called in a loop — one `getUrl` per image is not expressible in the renderer.
 * A missing or deleted file yields a null url rather than failing the batch, so
 * one broken image cannot blank a whole deck.
 *
 * AUTHED. It shipped as a plain public `query`, which meant anyone holding (or
 * guessing) a storage id could mint a serving URL for any blob in the shared
 * `_storage` namespace — scanned health documents and portfolio images included.
 * Authentication is the floor, not the ceiling: a storage id is still not proof
 * of ownership, which is why an image element's `assetId` is separately bound to
 * its uploader (see `slideAssets` in convex/artifacts.ts).
 */
export const getUrls = authedQuery({
  args: { storageIds: v.array(v.id("_storage")) },
  handler: async (ctx, args) => {
    // Deduplicate: the same image may appear on several slides.
    const unique = Array.from(new Set(args.storageIds));
    return await Promise.all(
      unique.map(async (storageId) => ({
        storageId,
        url: await ctx.storage.getUrl(storageId),
      })),
    );
  },
});
