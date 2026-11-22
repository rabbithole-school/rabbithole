// Slack transport for teacher↔parent messaging.
//
// Parent-facing behavior stays unchanged: Slack is only an additional
// teacher-side surface. Every message in a family conversation — a guardian's,
// or one staff wrote in the app — is mirrored into one shared private staff
// channel, one Slack thread per conversation, @-mentioning the relevant
// teachers on the first post and on every guardian message
// (lib/slackTeacherMentions.ts). Any trusted teacher/admin reply in that Slack
// thread is ingested by parentMessages.ingestInboundSlackReply as a normal
// teacher message (and, marked source "slack", is not mirrored back).

import { v } from "convex/values";
import { internalAction, internalMutation } from "./_generated/server";
import type { ActionCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import { siteUrl } from "./lib/channels";
import { isPlatformAdminRole } from "./lib/roles";
import { escapeSlackText, normalizeSlackMarkdown, postMessage } from "./lib/slackApi";
import {
  BLOCK_TEXT_FALLBACK_MAX,
  commonMarkToMrkdwn,
  greyLineMessage,
  type GreyLinePost,
  type SlackPart,
} from "./lib/slackGreyLine";
import { slackMention } from "./lib/slackText";
import { messagePlainText } from "../lib/messageLinks";

export function quoteForSlack(body: string): string {
  const escaped = escapeSlackText(messagePlainText(body).trim());
  if (!escaped) return "> (empty message)";
  return escaped
    .split("\n")
    .map((line) => `> ${line || " "}`)
    .join("\n");
}

/** The thread itself, not the inbox: the staff inbox opens on Mine, and this
 *  channel is shared, so a bare inbox link can land a staffer on a list
 *  without the message they were just alerted to. */
export function teacherThreadUrl(
  threadId: string,
  institutionSlug: string | null,
  kind: "families" | "scholars" = "families",
): string {
  const params = new URLSearchParams({ kind, thread: threadId });
  if (institutionSlug) params.set("inst", institutionSlug);
  return `${siteUrl()}/teacher/messages?${params.toString()}`;
}

function renderParentNotice(args: {
  threadId: string;
  institutionSlug: string | null;
  /** Who wrote it: the guardian, or (fromStaff) the staff member. */
  authorName: string;
  fromStaff: boolean;
  childName: string | null;
  body: string;
  attachments: { fileName: string; url: string | null }[];
}): SlackPart[] {
  const child = args.childName ?? "not specified";
  const notice = [
    args.fromStaff ? `**Teacher message in Rabbithole**` : `**Parent message in Rabbithole**`,
    `**From:** ${escapeSlackText(args.authorName)}`,
    `**About:** ${escapeSlackText(child)}`,
    "",
    quoteForSlack(args.body),
    ...(args.attachments.length > 0
      ? [
          "",
          "**Attachments:**",
          ...args.attachments.map((attachment) =>
            attachment.url
              ? `<${attachment.url}|${escapeSlackText(attachment.fileName)}>`
              : escapeSlackText(attachment.fileName),
          ),
        ]
      : []),
  ].join("\n");
  return [
    notice,
    {
      grey: `Reply in this Slack thread to send a normal teacher message back to the parent. <${teacherThreadUrl(args.threadId, args.institutionSlug)}|Open Messages>`,
    },
  ];
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

    const notice = greyLineMessage(
      renderParentNotice({
        threadId: data.threadId,
        institutionSlug: data.institutionSlug,
        authorName: data.authorName,
        fromStaff: data.fromStaff,
        childName: data.childName,
        body: data.body,
        attachments: data.attachments,
      }),
      { markdown: true },
    );

    await postInConversationSlackThread(ctx, token, {
      threadId: data.threadId,
      channelId: data.channelId,
      messageId,
      post: notice,
      mentions: data.mentions,
    });
  },
});

/** Tries per post when Slack answers with a rate limit. */
const MAX_POST_ATTEMPTS = 5;

/**
 * The post with a leading mrkdwn line of `<@U…>` mentions. A mrkdwn section
 * (not a `markdown` block or `markdown_text`) is where a mention surely
 * renders and notifies, so a CommonMark post becomes blocks; the fallback
 * text carries the mentions too.
 */
export function withMentions(post: GreyLinePost, slackIds: string[]): GreyLinePost {
  if (slackIds.length === 0) return post;
  const line = slackIds.map(slackMention).join(" ");
  const mentionBlock = { type: "section", text: { type: "mrkdwn", text: line } };
  if (!post.blocks && !post.markdown) return { text: `${line}\n${post.text}` };
  const blocks = post.blocks ?? [{ type: "markdown", text: normalizeSlackMarkdown(post.text) }];
  const body = post.blocks ? post.text : commonMarkToMrkdwn(post.text);
  const text = body ? `${line}\n${body}` : line;
  return {
    text: text.length <= BLOCK_TEXT_FALLBACK_MAX ? text : line,
    blocks: [mentionBlock, ...blocks],
  };
}

/**
 * Post one message's notice under its conversation's Slack root in
 * `channelId`, or open that root with it. A Rabbithole conversation keeps ONE
 * Slack thread per channel (`parentSlackThreads`), so a later message lands
 * under the first. Shared by the parent-message channel and the scholar
 * conversation channel (scholarMessageSlack.ts). A re-run for the message the
 * thread last carried is a no-op; a rate-limited post waits and retries, and
 * a post that still fails is logged and dropped.
 */
export async function postInConversationSlackThread(
  ctx: ActionCtx,
  token: string,
  args: {
    threadId: Id<"parentThreads">;
    channelId: string;
    messageId: Id<"parentMessages">;
    post: GreyLinePost;
    /** Slack member ids to @-mention, on a line of their own above the post. */
    mentions: string[];
  },
): Promise<void> {
  const existing = await ctx.runQuery(
    internal.parentMessages.getParentSlackThreadByParentThread,
    { parentThreadId: args.threadId, channelId: args.channelId },
  );
  if (existing?.lastParentMessageId === args.messageId) return;
  const post = () =>
    postMessage(token, {
      channel: args.channelId,
      ...(existing ? { threadTs: existing.threadTs } : {}),
      ...withMentions(args.post, args.mentions),
    });
  let posted = await post();
  // Slack allows about one post a second per channel, and a whole-class send
  // schedules one post per family or scholar at once: wait out a rate limit
  // (Retry-After, plus jitter so the waiting posts spread out) and try again.
  for (
    let attempt = 1;
    !posted.ok && posted.retryAfterMs !== undefined && attempt < MAX_POST_ATTEMPTS;
    attempt++
  ) {
    const wait = Math.min(posted.retryAfterMs, 30_000) + Math.random() * 1_000 * attempt;
    await new Promise((resolve) => setTimeout(resolve, wait));
    posted = await post();
  }
  const threadTs = existing?.threadTs ?? posted.ts;
  if (!posted.ok || !threadTs) {
    console.error(
      `Slack copy of message ${args.messageId} (thread ${args.threadId}) not posted to ${args.channelId}: ${posted.error ?? "no ts"}`,
    );
    return;
  }
  await ctx.runMutation(internal.parentMessages.recordParentSlackThreadNotification, {
    parentThreadId: args.threadId,
    channelId: args.channelId,
    threadTs,
    messageId: args.messageId,
  });
}

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
