/**
 * Admin-facing Slack linking helpers (the /admin "Slack" column).
 *
 * `autoLinkByEmail` resolves a user's Slack membership from their
 * (verified) workspace email via users.lookupByEmail and stores the
 * mapping — the one-click path. Manual id entry uses
 * users.adminSetSlackUserId directly.
 */
import { v } from "convex/values";
import { action } from "./_generated/server";
import { api, internal } from "./_generated/api";
import { getAuthUserId } from "@convex-dev/auth/server";
import { isPlatformAdminRole } from "./lib/roles";
import { lookupSlackUserByEmail } from "./lib/slackApi";

export const autoLinkByEmail = action({
  args: { userId: v.id("users") },
  handler: async (
    ctx,
    args,
  ): Promise<{ ok: boolean; message: string; slackUserId?: string }> => {
    // Admin gate (action-side: no ctx.db, so read the caller via query).
    const callerId = await getAuthUserId(ctx);
    if (!callerId) return { ok: false, message: "Not signed in" };
    const caller = await ctx.runQuery(internal.users.getByIdInternal, {
      id: callerId,
    });
    if (!caller || !isPlatformAdminRole(caller.role)) {
      return { ok: false, message: "Forbidden: admin role required" };
    }

    const token = process.env.SLACK_BOT_TOKEN;
    if (!token) {
      return {
        ok: false,
        message: "Slack isn't configured on this deployment (SLACK_BOT_TOKEN unset)",
      };
    }

    const target = await ctx.runQuery(internal.users.getByIdInternal, {
      id: args.userId,
    });
    if (!target) return { ok: false, message: "User not found" };
    if (!target.email) {
      return {
        ok: false,
        message: "Set the user's email first — auto-link matches by Slack workspace email",
      };
    }

    const found = await lookupSlackUserByEmail(token, target.email);
    if (!found) {
      return {
        ok: false,
        message: `No Slack member found with email ${target.email}`,
      };
    }

    // Runs with the admin's identity (runMutation preserves auth), so the
    // public mutation's gate + uniqueness check apply.
    await ctx.runMutation(api.users.adminSetSlackUserId, {
      userId: args.userId,
      slackUserId: found.slackUserId,
    });
    return {
      ok: true,
      slackUserId: found.slackUserId,
      message: `Linked to ${found.slackUserId}${found.name ? ` (${found.name})` : ""}`,
    };
  },
});
