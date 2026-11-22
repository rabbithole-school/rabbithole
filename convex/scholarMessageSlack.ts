// Slack copy of scholar ↔ teacher conversations (the Scholars tab of
// /teacher/messages: `mentor` threads, scholarMessages.ts).
//
// Every message in one of those conversations, from the scholar or from staff,
// is posted to ONE private staff channel (`SLACK_SCHOLAR_MESSAGES_CHANNEL_ID`),
// one Slack thread per conversation — the same transport the parent-message
// channel uses (parentMessageSlack.postInConversationSlackThread), so the
// conversation's root is recorded in `parentSlackThreads`.
//
// The relevant teachers are @-mentioned when the conversation first appears in
// the channel and on every message from the scholar (that is what someone has
// to answer): the teacher who opened it, staff who have written in it, and the
// owners of the scholar's classes — each only while they teach at the
// scholar's school and have a linked Slack id. The author is never mentioned.
//
// Two-way, like the parent-message channel: a plain reply in the Slack thread
// is posted to the scholar as the replier's message
// (parentMessages.ingestInboundSlackReply → scholarMessages.recordScholarSlackReply,
// under the same rule as an in-app reply). First-party only (TRA-402), like
// the parent-message channel: only a conversation at the live primary school.
// Unset channel or bot token → no-op. A later edit or withdrawal does not
// change the Slack copy (the message is stamped `copiedToSlackAt`, so the app
// says so).

import { v } from "convex/values";
import { internalAction, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";
import { userDisplayName } from "./parentMessages";
import { mentorMessageForSlackCopy } from "./scholarMessages";
import {
  postInConversationSlackThread,
  quoteForSlack,
  teacherThreadUrl,
} from "./parentMessageSlack";
import { relevantTeacherSlackIds } from "./lib/slackTeacherMentions";
import { greyLineMessage, type SlackPart } from "./lib/slackGreyLine";
import { escapeSlackText } from "./lib/slackText";

/** The Slack copy of one message (Slack mrkdwn). */
export function scholarConversationSlackParts(args: {
  scholarName: string;
  /** The staff author's name; null when the scholar wrote it. */
  staffAuthorName: string | null;
  body: string;
  attachmentCount: number;
  threadUrl: string;
}): SlackPart[] {
  const scholar = escapeSlackText(args.scholarName);
  const heading =
    args.staffAuthorName === null
      ? `*${scholar}* wrote in Rabbithole:`
      : `*${escapeSlackText(args.staffAuthorName)}* wrote to *${scholar}* in Rabbithole:`;
  return [
    `${heading}\n${quoteForSlack(args.body)}`,
    ...(args.attachmentCount > 0
      ? [
          {
            grey: `${args.attachmentCount === 1 ? "1 attachment" : `${args.attachmentCount} attachments`}: open it in Rabbithole.`,
          },
        ]
      : []),
    {
      grey: `Reply in this thread to answer ${scholar} in Rabbithole. <${args.threadUrl}|Open Messages>`,
    },
  ];
}

/** Where a message goes and what it says, or null when it isn't copied. */
export const slackCopyContext = internalQuery({
  args: { messageId: v.id("parentMessages") },
  handler: async (ctx, { messageId }) => {
    const channelId = process.env.SLACK_SCHOLAR_MESSAGES_CHANNEL_ID?.trim();
    if (!channelId) return null;
    const copy = await mentorMessageForSlackCopy(ctx, messageId, channelId);
    if (!copy) return null;
    // scholarForThread (inside the helper) already holds the thread's school
    // live and the scholar's own; the channel is the primary school's.
    const institution = copy.thread.institutionId
      ? await ctx.db.get(copy.thread.institutionId)
      : null;
    if (!institution?.isPrimary) return null;

    const fromScholar = copy.authorType === "scholar";
    const mentions =
      copy.opensSlackThread || fromScholar
        ? await relevantTeacherSlackIds(ctx, {
            scholarIds: [copy.scholar._id],
            institutionId: institution._id,
            staffWriterIds: copy.staffWriterIds,
            authorUserId: copy.authorUserId,
          })
        : [];
    const author = copy.authorUserId ? await ctx.db.get(copy.authorUserId) : null;
    return {
      threadId: copy.thread._id,
      channelId,
      mentions,
      parts: scholarConversationSlackParts({
        scholarName: userDisplayName(copy.scholar, "A scholar"),
        staffAuthorName: fromScholar ? null : userDisplayName(author, "A teacher"),
        body: copy.body,
        attachmentCount: copy.attachmentCount,
        threadUrl: teacherThreadUrl(copy.thread._id, institution.slug ?? null, "scholars"),
      }),
    };
  },
});

/** Copy one message of a scholar ↔ teacher conversation to the staff channel. */
export const copyToSlack = internalAction({
  args: { messageId: v.id("parentMessages") },
  handler: async (ctx, { messageId }): Promise<void> => {
    const token = process.env.SLACK_BOT_TOKEN;
    if (!token) return;
    const context = await ctx.runQuery(internal.scholarMessageSlack.slackCopyContext, {
      messageId,
    });
    if (!context) return;
    await postInConversationSlackThread(ctx, token, {
      threadId: context.threadId,
      channelId: context.channelId,
      messageId,
      mentions: context.mentions,
      post: greyLineMessage(context.parts, { markdown: false }),
    });
  },
});
