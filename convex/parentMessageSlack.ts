// Slack transport for teacher↔parent messaging.
//
// Parent-facing behavior stays unchanged: Slack is only an additional
// teacher-side surface. Parent messages addressed to the teacher get mirrored
// into one shared private staff channel, and any trusted teacher/admin reply in
// that Slack thread is ingested by parentMessages.ingestInboundSlackReply as a
// normal teacher message.

import { v } from "convex/values";
import { internalAction, internalMutation } from "./_generated/server";
import { internal } from "./_generated/api";
import { siteUrl } from "./lib/channels";
import { isPlatformAdminRole } from "./lib/roles";
import { escapeSlackText, postMessage } from "./lib/slackApi";

function quoteForSlack(body: string): string {
  const escaped = escapeSlackText(body.trim());
  if (!escaped) return "> (empty message)";
  return escaped
    .split("\n")
    .map((line) => `> ${line || " "}`)
    .join("\n");
}

function teacherMessagesUrl(): string {
  return `${siteUrl()}/teacher/messages`;
}

function renderParentNotice(args: {
  parentName: string;
  childName: string | null;
  body: string;
  attachments: { fileName: string; url: string | null }[];
}): string {
  const child = args.childName ?? "not specified";
  return [
    `*Parent message in Rabbithole*`,
    `*From:* ${escapeSlackText(args.parentName)}`,
    `*About:* ${escapeSlackText(child)}`,
    "",
    quoteForSlack(args.body),
    ...(args.attachments.length > 0
      ? [
          "",
          "*Attachments:*",
          ...args.attachments.map((attachment) =>
            attachment.url
              ? `<${attachment.url}|${escapeSlackText(attachment.fileName)}>`
              : escapeSlackText(attachment.fileName),
          ),
        ]
      : []),
    "",
    `Reply in this Slack thread to send a normal teacher message back to the parent. <${teacherMessagesUrl()}|Open Messages>`,
  ].join("\n");
}

export const notifyParentMessageChannel = internalAction({
  args: { messageId: v.id("parentMessages") },
  handler: async (ctx, { messageId }): Promise<void> => {
    const token = process.env.SLACK_BOT_TOKEN;
    if (!token) return; // env-gated: deployments without Slack configured no-op

    const data = await ctx.runQuery(
      internal.parentMessages.getSlackNotificationContext,
      { messageId },
    );
    if (!data) return;

    const text = renderParentNotice({
      parentName: data.parentName,
      childName: data.childName,
      body: data.body,
      attachments: data.attachments,
    });

    const existing = await ctx.runQuery(
      internal.parentMessages.getParentSlackThreadByParentThread,
      {
        parentThreadId: data.threadId,
        channelId: data.channelId,
      },
    );
    if (existing?.lastParentMessageId === messageId) return;

    if (existing) {
      const posted = await postMessage(token, {
        channel: existing.channelId,
        threadTs: existing.threadTs,
        text,
        markdown: true,
      });
      if (!posted.ok) return;
      await ctx.runMutation(
        internal.parentMessages.recordParentSlackThreadNotification,
        {
          parentThreadId: data.threadId,
          channelId: existing.channelId,
          threadTs: existing.threadTs,
          messageId,
        },
      );
      return;
    }

    const posted = await postMessage(token, {
      channel: data.channelId,
      text,
      markdown: true,
    });
    if (!posted.ok || !posted.ts) return;
    await ctx.runMutation(internal.parentMessages.recordParentSlackThreadNotification, {
      parentThreadId: data.threadId,
      channelId: data.channelId,
      threadTs: posted.ts,
      messageId,
    });
  },
});

/**
 * Admin-only: link (or unlink) THIS Slack channel as the single shared staff
 * inbox for teacher↔parent messages. Upsert — linking elsewhere moves it.
 */
export const linkParentMessageChannel = internalMutation({
  args: {
    callerUserId: v.id("users"),
    slackChannelId: v.string(),
    unlink: v.boolean(),
  },
  handler: async (ctx, args): Promise<{ ok: boolean; message: string }> => {
    const caller = await ctx.db.get(args.callerUserId);
    if (!caller || !isPlatformAdminRole(caller.role)) {
      return {
        ok: false,
        message: "Forbidden: admin role required to link the parent-message channel.",
      };
    }
    const existing = await ctx.db.query("parentMessageChannel").first();

    if (args.unlink) {
      if (!existing || existing.slackChannelId !== args.slackChannelId) {
        return {
          ok: false,
          message: "This channel isn't the linked parent-message channel.",
        };
      }
      await ctx.db.delete(existing._id);
      return {
        ok: true,
        message:
          "Unlinked — parent messages will no longer post here. Reminder: when you relink, use a PRIVATE staff channel because parent/child PII is visible there.",
      };
    }

    if (existing) {
      await ctx.db.patch(existing._id, {
        slackChannelId: args.slackChannelId,
        linkedBy: args.callerUserId,
        linkedAt: Date.now(),
      });
    } else {
      await ctx.db.insert("parentMessageChannel", {
        slackChannelId: args.slackChannelId,
        linkedBy: args.callerUserId,
        linkedAt: Date.now(),
      });
    }
    return {
      ok: true,
      message:
        "Linked this PRIVATE staff channel for Rabbithole parent messages. Parent/child PII is visible to channel members, so keep this channel private and staff-only. There's one parent-message channel school-wide — linking it here moves it from any previous channel.",
    };
  },
});
