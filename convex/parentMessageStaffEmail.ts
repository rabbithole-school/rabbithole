// The TEACHER side of the family email bridge. Every guardian or staff
// message in a family conversation is copied by email to the conversation's
// teachers (`familyThreadTeachers`: the staff who wrote in it and the owners
// of its scholars' classes, at the thread's own school), minus its author.
// Reply-To is the thread's reply address plus a token only that teacher was
// sent (lib/staffReplyToken.ts), so a teacher's reply comes back through
// /parent-message-inbound → parentMessages.ingestStaffEmailReply and reaches
// the family like any staff reply — and a forged From can't.
//
// One `email` delivery row per teacher records the outcome. Rows are written
// AFTER the send (never `queued`), so parentMessageSend.dispatch — which
// routes a message's queued off-portal rows to the family — never sees them.
// A row that already exists means that teacher was handled; a retried or
// duplicate run skips them, and the per-teacher idempotency key covers the
// gap between a send and its row.

import { v } from "convex/values";
import { internalAction, internalMutation, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import {
  familyThreadTeachers,
  isRetractedMessage,
  userDisplayName,
} from "./parentMessages";
import {
  fromHeader,
  renderStaffFamilyMessage,
  replyAddressForThread,
  sendParentEmail,
} from "./lib/parentMessageEmail";
import { teacherThreadUrl } from "./parentMessageSlack";
import { staffReplyToken } from "./lib/staffReplyToken";

type StaffEmailInfo = {
  threadId: Id<"parentThreads">;
  from: string;
  subject: string;
  html: string;
  text: string;
  attachments: {
    path: string;
    filename: string;
    contentType: string;
    sizeBytes: number;
  }[];
  recipients: { userId: Id<"users">; email: string }[];
} | null;

export const getStaffEmailInfo = internalQuery({
  args: { messageId: v.id("parentMessages") },
  handler: async (ctx, { messageId }): Promise<StaffEmailInfo> => {
    const message = await ctx.db.get(messageId);
    if (
      !message ||
      (message.authorType !== "parent" && message.authorType !== "teacher") ||
      isRetractedMessage(message)
    ) {
      return null;
    }
    const thread = await ctx.db.get(message.threadId);
    if (!thread) return null;
    const { institutionId, teachers } = await familyThreadTeachers(
      ctx,
      thread,
      message.authorUserId,
    );
    if (!institutionId) return null;

    const handled = new Set(
      (
        await ctx.db
          .query("messageDeliveries")
          .withIndex("by_message", (q) => q.eq("messageId", messageId))
          .collect()
      )
        .filter((delivery) => delivery.channel === "email")
        .map((delivery) => delivery.parentUserId),
    );
    const recipients: { userId: Id<"users">; email: string }[] = [];
    for (const teacher of teachers) {
      if (!teacher.email || handled.has(teacher._id)) continue;
      const prefs = await ctx.db
        .query("notificationPrefs")
        .withIndex("by_user", (q) => q.eq("userId", teacher._id))
        .unique();
      if (prefs?.emailEnabled === false) continue;
      recipients.push({ userId: teacher._id, email: teacher.email });
    }
    if (recipients.length === 0) return null;

    const author = message.authorUserId
      ? await ctx.db.get(message.authorUserId)
      : null;
    const authorName = userDisplayName(
      author,
      message.authorType === "parent" ? "Parent" : "Teacher",
    );
    const scholar = thread.scholarId ? await ctx.db.get(thread.scholarId) : null;
    const scholarFirstName = scholar?.name?.trim().split(/\s+/)[0] ?? null;
    // The subject names the conversation by its opening message, skipping
    // one its author withdrew: a withdrawn message must not reach an inbox.
    // An opener with no text (attachments only) is named for ITS author, so
    // every copy of the conversation carries one subject and stays one
    // thread in the teacher's mail client.
    const opener =
      (
        await ctx.db
          .query("parentMessages")
          .withIndex("by_thread", (q) => q.eq("threadId", thread._id))
          .collect()
      ).find(
        (candidate) =>
          candidate.authorType !== "bot" && !isRetractedMessage(candidate),
      ) ?? message;
    const openerAuthor =
      opener._id === message._id
        ? author
        : opener.authorUserId
          ? await ctx.db.get(opener.authorUserId)
          : null;
    const openerAuthorName = userDisplayName(
      openerAuthor,
      opener.authorType === "parent" ? "Parent" : "Teacher",
    );
    const attachmentRows = (
      await ctx.db
        .query("parentMessageAttachments")
        .withIndex("by_message", (q) => q.eq("messageId", messageId))
        .collect()
    ).filter((attachment) => attachment.retractedAt === undefined);
    const attachments = (
      await Promise.all(
        attachmentRows.map(async (attachment) => {
          const path = await ctx.storage.getUrl(attachment.storageId);
          return path
            ? {
                path,
                filename: attachment.fileName,
                contentType: attachment.mimeType,
                sizeBytes: attachment.sizeBytes,
              }
            : null;
        }),
      )
    ).filter((attachment): attachment is NonNullable<typeof attachment> =>
      attachment !== null,
    );

    const institution = await ctx.db.get(institutionId);
    // Each recipient's Reply-To carries their own token (built in `send`);
    // both halves must be configured for a reply to come back.
    const canReplyByEmail =
      !!replyAddressForThread(thread._id) &&
      !!process.env.RESEND_WEBHOOK_SECRET?.trim();
    const { subject, html, text } = renderStaffFamilyMessage({
      authorName,
      scholarFirstName,
      threadSubjectBody: opener.body,
      threadOpenerName: openerAuthorName,
      body: message.body,
      attachmentNames: attachmentRows.map((attachment) => attachment.fileName),
      portalUrl: teacherThreadUrl(thread._id, institution?.slug ?? null),
      canReplyByEmail,
    });
    return {
      threadId: thread._id,
      from: fromHeader(authorName),
      subject,
      html,
      text,
      attachments,
      recipients,
    };
  },
});

export const recordStaffEmailDelivery = internalMutation({
  args: {
    messageId: v.id("parentMessages"),
    userId: v.id("users"),
    status: v.union(v.literal("sent"), v.literal("failed"), v.literal("skipped")),
    providerId: v.optional(v.string()),
    error: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("messageDeliveries")
      .withIndex("by_message_parent_channel", (q) =>
        q
          .eq("messageId", args.messageId)
          .eq("parentUserId", args.userId)
          .eq("channel", "email"),
      )
      .first();
    if (existing) return;
    await ctx.db.insert("messageDeliveries", {
      messageId: args.messageId,
      parentUserId: args.userId,
      channel: "email",
      status: args.status,
      providerId: args.providerId,
      error: args.error,
    });
  },
});

export const send = internalAction({
  args: { messageId: v.id("parentMessages") },
  handler: async (ctx, { messageId }) => {
    const info: StaffEmailInfo = await ctx.runQuery(
      internal.parentMessageStaffEmail.getStaffEmailInfo,
      { messageId },
    );
    if (!info) return;
    for (const recipient of info.recipients) {
      const token = await staffReplyToken(info.threadId, recipient.userId);
      const replyTo = token
        ? (replyAddressForThread(info.threadId, token) ?? undefined)
        : undefined;
      let providerId: string | null;
      try {
        providerId = await sendParentEmail({
          to: [recipient.email],
          from: info.from,
          replyTo,
          subject: info.subject,
          html: info.html,
          text: info.text,
          attachments: info.attachments,
          idempotencyKey: `staff-email/${messageId}/${recipient.userId}`,
        });
      } catch (error) {
        await ctx.runMutation(
          internal.parentMessageStaffEmail.recordStaffEmailDelivery,
          {
            messageId,
            userId: recipient.userId,
            status: "failed",
            error: error instanceof Error ? error.message : String(error),
          },
        );
        continue;
      }
      await ctx.runMutation(
        internal.parentMessageStaffEmail.recordStaffEmailDelivery,
        {
          messageId,
          userId: recipient.userId,
          status: providerId ? "sent" : "skipped",
          ...(providerId ? { providerId } : { error: "Email is not configured" }),
        },
      );
    }
  },
});
