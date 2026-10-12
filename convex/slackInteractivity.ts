// Slack interactivity worker (button clicks, modal submits). The HTTP route
// `/slack/interactivity` verifies the signature, acks an empty 200, and
// schedules `handleInteraction` here. Pure logic lives in
// convex/lib/slackInteractivity.ts.
import { v } from "convex/values";
import { internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { updateBlocks, postBlocks, respondEphemeral } from "./lib/slackApi";
import {
  demoAckBlocks,
  planBlockAction,
  type SlackBlockActionsPayload,
  type SlackInteractivityPayload,
} from "./lib/slackInteractivity";

/** Demo only: post a message carrying a `demo:ack` button.
 *  `npx convex run slackInteractivity:postDemoMessage '{"channel":"C…"}'` */
export const postDemoMessage = internalAction({
  args: { channel: v.string() },
  handler: async (_ctx, args) => {
    const token = process.env.SLACK_BOT_TOKEN;
    if (!token) throw new Error("SLACK_BOT_TOKEN not set");
    const text = "Demo: click to acknowledge.";
    return await postBlocks(token, {
      channel: args.channel,
      text,
      blocks: demoAckBlocks(text),
    });
  },
});

export const handleInteraction = internalAction({
  args: { payload: v.any() },
  handler: async (ctx, args) => {
    const payload = args.payload as SlackInteractivityPayload;
    if (payload.type !== "block_actions" && payload.type !== "view_submission") {
      return; // view_closed, shortcuts: nothing to do yet
    }

    // Fail closed: only Slack users linked to an RH user may act.
    const user = await ctx.runQuery(internal.users.getBySlackIdInternal, {
      slackUserId: payload.user!.id,
    });
    if (!user) {
      console.warn("Slack interactivity from unlinked user", payload.user!.id);
      if (payload.type === "block_actions") {
        await respondEphemeral(
          payload.response_url,
          "Your Slack account isn't linked to a Rabbithole user, so I can't act on that.",
        );
      }
      return;
    }

    if (payload.type === "view_submission") {
      // Modal registry, keyed by callback_id.
      return;
    }

    const p = payload as SlackBlockActionsPayload;
    const token = process.env.SLACK_BOT_TOKEN;
    if (!token) return;
    for (const action of p.actions) {
      // Async handlers by action_id prefix. They authorize on their own.
      // Slack retries / double-clicks: claim (message, action) first. The
      // pure planner ALSO no-ops once the button is gone from the message,
      // which covers clicks after the dedupe row is swept.
      const key = `act:${p.channel?.id ?? p.container?.channel_id}:${p.message?.ts ?? p.container?.message_ts}:${action.action_id}`;
      const plan = planBlockAction({
        payload: p,
        action,
        userName: user.name ?? user.username ?? "someone",
        nowMs: Date.now(),
      });
      if (plan.kind === "noop") continue;
      const { fresh } = await ctx.runMutation(internal.slackBot.claimEvent, { eventId: key });
      if (!fresh) continue;
      const res = await updateBlocks(token, plan);
      if (!res.ok) console.error("interactivity chat.update failed:", res.error);
    }
  },
});
