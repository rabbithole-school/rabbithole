import { v } from "convex/values";
import { internalMutation } from "./_generated/server";

const SUCCESS_TTL_MS = 60 * 60 * 1000;
const FAILURE_TTL_MS = 5 * 60 * 1000;
const PENDING_TTL_MS = 10 * 1000;
const RATE_WINDOW_MS = 60 * 1000;
const RATE_LIMIT = 6;

export const claim = internalMutation({
  args: {
    url: v.string(),
    viewerId: v.id("users"),
    claimId: v.string(),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const expired = await ctx.db
      .query("messageLinkPreviewCache")
      .withIndex("by_expires_at", (q) => q.lt("expiresAt", now))
      .take(25);
    await Promise.all(expired.map((row) => ctx.db.delete(row._id)));

    const existing = await ctx.db
      .query("messageLinkPreviewCache")
      .withIndex("by_url", (q) => q.eq("url", args.url))
      .unique();
    if (existing && existing.expiresAt > now) {
      if (existing.state === "ready" && existing.title) {
        return {
          kind: "ready" as const,
          preview: {
            url: existing.url,
            hostname: existing.hostname,
            title: existing.title,
            description: existing.description ?? null,
          },
        };
      }
      if (existing.state === "pending") {
        return {
          kind: "pending" as const,
          retryAfterMs: Math.min(PENDING_TTL_MS, existing.expiresAt - now),
        };
      }
      return { kind: "unavailable" as const };
    }
    if (existing) await ctx.db.delete(existing._id);

    const bucket = await ctx.db
      .query("messageLinkPreviewRateLimits")
      .withIndex("by_viewer", (q) => q.eq("viewerId", args.viewerId))
      .unique();
    if (bucket && bucket.windowEndsAt > now && bucket.count >= RATE_LIMIT) {
      return { kind: "unavailable" as const };
    }
    if (bucket && bucket.windowEndsAt > now) {
      await ctx.db.patch(bucket._id, { count: bucket.count + 1 });
    } else if (bucket) {
      await ctx.db.patch(bucket._id, {
        count: 1,
        windowEndsAt: now + RATE_WINDOW_MS,
      });
    } else {
      await ctx.db.insert("messageLinkPreviewRateLimits", {
        viewerId: args.viewerId,
        count: 1,
        windowEndsAt: now + RATE_WINDOW_MS,
      });
    }

    await ctx.db.insert("messageLinkPreviewCache", {
      url: args.url,
      hostname: new URL(args.url).hostname,
      state: "pending",
      claimId: args.claimId,
      expiresAt: now + PENDING_TTL_MS,
    });
    return { kind: "fetch" as const };
  },
});

export const store = internalMutation({
  args: {
    url: v.string(),
    claimId: v.string(),
    preview: v.optional(
      v.object({
        url: v.string(),
        hostname: v.string(),
        title: v.string(),
        description: v.union(v.string(), v.null()),
      }),
    ),
  },
  handler: async (ctx, args) => {
    const cache = await ctx.db
      .query("messageLinkPreviewCache")
      .withIndex("by_url", (q) => q.eq("url", args.url))
      .unique();
    if (!cache || cache.state !== "pending" || cache.claimId !== args.claimId) return;

    const now = Date.now();
    if (args.preview) {
      await ctx.db.patch(cache._id, {
        state: "ready",
        hostname: args.preview.hostname,
        title: args.preview.title,
        description: args.preview.description ?? undefined,
        expiresAt: now + SUCCESS_TTL_MS,
      });
    } else {
      await ctx.db.patch(cache._id, {
        state: "failed",
        expiresAt: now + FAILURE_TTL_MS,
      });
    }
  },
});
