"use node";

import { v } from "convex/values";
import { action } from "./_generated/server";
import { api, internal } from "./_generated/api";
import {
  fetchMessageLinkPreview,
  type MessageLinkPreview,
} from "./lib/messageLinkPreview";

export const previewForMessage = action({
  args: {
    messageId: v.id("parentMessages"),
    url: v.string(),
    as: v.optional(v.union(v.literal("parent"), v.literal("staff"))),
  },
  handler: async (
    ctx,
    args,
  ): Promise<MessageLinkPreview | { status: "pending"; retryAfterMs: number } | null> => {
    if (!(await ctx.auth.getUserIdentity())) {
      throw new Error("Not authenticated");
    }
    // The public query performs the same thread authorization as rendering and
    // returns null unless this exact URL is the message's single eligible link.
    const request = await ctx.runQuery(
      api.parentMessages.getMessageLinkPreviewRequest,
      args,
    );
    if (!request) return null;

    const claimId = crypto.randomUUID();
    const claim = await ctx.runMutation(internal.messageLinkPreviewCache.claim, {
      url: request.url,
      viewerId: request.viewerId,
      claimId,
    });
    if (claim.kind === "ready") return claim.preview;
    if (claim.kind === "pending") {
      return { status: "pending", retryAfterMs: claim.retryAfterMs };
    }
    if (claim.kind !== "fetch") return null;

    try {
      const preview = await fetchMessageLinkPreview(request.url);
      await ctx.runMutation(internal.messageLinkPreviewCache.store, {
        url: request.url,
        claimId,
        preview: preview ?? undefined,
      });
      return preview;
    } catch {
      await ctx.runMutation(internal.messageLinkPreviewCache.store, {
        url: request.url,
        claimId,
      });
      return null;
    }
  },
});
