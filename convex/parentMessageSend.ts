// The off-portal SEND path for parent messages. `sendMessage`/`replyInThread`
// create `queued` email deliveries and schedule `dispatch`, which renders each
// once and sends via Resend, then patches the delivery's status. Idempotent —
// it only ever touches `queued` rows, so a retried/duplicate schedule can't
// double-send (the messageDeliveries.by_message_parent_channel uniqueness +
// the status guard). Email is the only channel here; sms/whatsapp land in a
// later phase behind the same `deliver` seam.

import { v } from "convex/values";
import { internalAction, internalQuery, internalMutation } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import {
  renderParentMessage,
  sendParentEmail,
  fromHeader,
  replyAddressForThread,
} from "./lib/parentMessageEmail";
import {
  deliverOffPortal,
  renderOffPortalText,
  welcomeMessage,
  whatsAppWindowOpen,
  type OffPortalChannel,
} from "./lib/parentMessageChannels";
import { appBaseUrl } from "./lib/deploymentConfig";

type DispatchInfo = {
  threadId: Id<"parentThreads">;
  body: string;
  retracted: boolean;
  authorType: "teacher" | "parent" | "bot";
  teacherName: string;
  teacherReplyEmail: string | null;
  childName: string | null;
  threadSubjectBody: string;
  attachments: {
    path: string;
    filename: string;
    contentType: string;
    sizeBytes: number;
  }[];
  deliveries: {
    deliveryId: Id<"messageDeliveries">;
    channel: "email" | "sms" | "whatsapp";
    parentEmails: string[];
    channelIdentity: string | null; // opted-in sms/whatsapp number
    channelOptedIn: boolean;
    channelLastInboundAt: number | null; // opens WhatsApp's 24h window
  }[];
} | null;

/** Everything `dispatch` needs to render + route one message's queued off-portal deliveries. */
export const getDispatchInfo = internalQuery({
  args: { messageId: v.id("parentMessages") },
  handler: async (ctx, { messageId }): Promise<DispatchInfo> => {
    const message = await ctx.db.get(messageId);
    if (!message) return null;
    const queued = (
      await ctx.db
        .query("messageDeliveries")
        .withIndex("by_message", (q) => q.eq("messageId", messageId))
        .collect()
    ).filter((d) => d.channel !== "portal" && d.status === "queued");
    if (queued.length === 0) return null;

    const thread = await ctx.db.get(message.threadId);
    const teacher = thread?.teacherId ? await ctx.db.get(thread.teacherId) : null;
    const child = thread?.scholarId ? await ctx.db.get(thread.scholarId) : null;
    const teacherName = teacher?.name ?? "Your teacher";
    const threadMessages = thread
      ? await ctx.db
          .query("parentMessages")
          .withIndex("by_thread", (q) => q.eq("threadId", thread._id))
          .collect()
      : [];
    const firstHumanMessage = threadMessages.find(
      (candidate) => candidate.authorType !== "bot",
    );

    const participantRows = thread
      ? await ctx.db
          .query("parentThreadParticipants")
          .withIndex("by_thread", (q) => q.eq("threadId", thread._id))
          .collect()
      : [];
    const participantIds =
      participantRows.length > 0
        ? participantRows.map((row) => row.parentUserId)
        : thread
          ? [thread.parentUserId]
          : [];
    const parentEmails: string[] = [];
    for (const parentUserId of new Set(participantIds)) {
      const parent = await ctx.db.get(parentUserId);
      const prefs = await ctx.db
        .query("notificationPrefs")
        .withIndex("by_user", (q) => q.eq("userId", parentUserId))
        .unique();
      if (
        parent?.email && prefs?.emailEnabled !== false
      ) {
        parentEmails.push(parent.email);
      }
    }

    const deliveries = await Promise.all(
      queued.map(async (d) => {
        // Opted-in sms/whatsapp identity (if this is a phone channel).
        let channelIdentity: string | null = null;
        let channelOptedIn = false;
        let channelLastInboundAt: number | null = null;
        if (d.channel === "sms" || d.channel === "whatsapp") {
          const ids = await ctx.db
            .query("parentChannelIdentities")
            .withIndex("by_parent", (q) => q.eq("parentUserId", d.parentUserId))
            .collect();
          const row = ids.find(
            (r) => r.channel === d.channel && !!r.optInAt && r.stopState !== true,
          );
          channelIdentity = row?.identity ?? null;
          channelOptedIn = !!channelIdentity;
          channelLastInboundAt = row?.lastInboundAt ?? null;
        }
        return {
          deliveryId: d._id,
          channel: d.channel as "email" | "sms" | "whatsapp",
          parentEmails: d.channel === "email" ? parentEmails : [],
          channelIdentity,
          channelOptedIn,
          channelLastInboundAt,
        };
      }),
    );
    const attachments = (
      await Promise.all(
        (
          await ctx.db
            .query("parentMessageAttachments")
            .withIndex("by_message", (q) => q.eq("messageId", messageId))
            .collect()
        ).map(async (attachment) => {
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
      attachment !== null
    );

    return {
      threadId: message.threadId,
      body: message.body,
      retracted: message.retracted ?? false,
      authorType: message.authorType,
      teacherName,
      teacherReplyEmail: teacher?.email ?? null,
      childName: child?.name ?? null,
      threadSubjectBody: firstHumanMessage?.body ?? message.body,
      attachments,
      deliveries,
    };
  },
});

export const markDelivery = internalMutation({
  args: {
    deliveryId: v.id("messageDeliveries"),
    status: v.union(
      v.literal("sent"),
      v.literal("delivered"),
      v.literal("failed"),
      v.literal("skipped"),
    ),
    providerId: v.optional(v.string()),
    error: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.deliveryId, {
      status: args.status,
      providerId: args.providerId,
      error: args.error,
    });
  },
});

/** Webhook delivery receipt → advance a delivery's status by its provider id. */
export const updateDeliveryStatusByProvider = internalMutation({
  args: {
    providerId: v.string(),
    twilioStatus: v.string(), // provider status: sent|delivered|read|failed|undelivered
    errorCode: v.optional(v.string()),
  },
  handler: async (ctx, { providerId, twilioStatus, errorCode }) => {
    const row = await ctx.db
      .query("messageDeliveries")
      .withIndex("by_provider", (q) => q.eq("providerId", providerId))
      .first();
    if (!row) return;
    const s = twilioStatus.toLowerCase();
    if (s === "delivered" || s === "read") {
      await ctx.db.patch(row._id, { status: "delivered" });
    } else if (s === "failed" || s === "undelivered") {
      await ctx.db.patch(row._id, {
        status: "failed",
        error: errorCode ? `WhatsApp error ${errorCode}` : "Delivery failed",
      });
    }
    // queued/sending/sent/accepted: leave as-is (already "sent").
  },
});

export const dispatch = internalAction({
  args: { messageIds: v.array(v.id("parentMessages")) },
  handler: async (ctx, { messageIds }) => {
    const portalBase = appBaseUrl();
    for (const messageId of messageIds) {
      const info: DispatchInfo = await ctx.runQuery(
        internal.parentMessageSend.getDispatchInfo,
        { messageId },
      );
      if (!info || info.retracted) continue;
      const portalUrl = `${portalBase}/parent/messages?thread=${encodeURIComponent(info.threadId)}`;
      if (info.authorType === "bot") {
        for (const delivery of info.deliveries) {
          await ctx.runMutation(internal.parentMessageSend.markDelivery, {
            deliveryId: delivery.deliveryId,
            status: "skipped",
            error: "In-thread assistant removed",
          });
        }
        continue;
      }

      for (const d of info.deliveries) {
        if (d.channel === "email") {
          if (d.parentEmails.length === 0) {
            await ctx.runMutation(internal.parentMessageSend.markDelivery, {
              deliveryId: d.deliveryId,
              status: "skipped",
            });
            continue;
          }
          try {
            const replyTo =
              replyAddressForThread(info.threadId) ??
              info.teacherReplyEmail ??
              undefined;
            const { subject, html, text } = renderParentMessage({
              teacherName: info.teacherName,
              threadSubjectBody: info.threadSubjectBody,
              body: info.body,
              attachmentNames: info.attachments.map(
                (attachment) => attachment.filename,
              ),
              portalUrl,
              canReplyByEmail: !!replyTo,
            });
            const providerId = await sendParentEmail({
              to: d.parentEmails,
              from: fromHeader(info.teacherName),
              replyTo,
              subject,
              html,
              text,
              attachments: info.attachments,
              idempotencyKey: `parent-email/${d.deliveryId}`,
            });
            await ctx.runMutation(internal.parentMessageSend.markDelivery, {
              deliveryId: d.deliveryId,
              status: providerId ? "sent" : "skipped",
              providerId: providerId ?? undefined,
            });
          } catch (e) {
            await ctx.runMutation(internal.parentMessageSend.markDelivery, {
              deliveryId: d.deliveryId,
              status: "failed",
              error: e instanceof Error ? e.message : String(e),
            });
          }
          continue;
        }

        // ── WhatsApp / SMS (one adapter seam) ─────────────────────────────
        if (!d.channelOptedIn || !d.channelIdentity) {
          await ctx.runMutation(internal.parentMessageSend.markDelivery, {
            deliveryId: d.deliveryId,
            status: "skipped",
          });
          continue;
        }
        // WhatsApp: free-form is only allowed inside the 24h window; outside it
        // Meta requires a pre-approved template, else we skip with a clear
        // reason (never let a cold-start business message silently fail).
        let useTemplate = false;
        if (d.channel === "whatsapp" && !whatsAppWindowOpen(d.channelLastInboundAt)) {
          useTemplate = true;
          if (!process.env.WHATSAPP_TEMPLATE_NAME) {
            await ctx.runMutation(internal.parentMessageSend.markDelivery, {
              deliveryId: d.deliveryId,
              status: "skipped",
              error:
                "Outside WhatsApp's 24h window and no WHATSAPP_TEMPLATE_NAME configured",
            });
            continue;
          }
        }
        try {
          const text = renderOffPortalText({
            authorType: "teacher",
            authorName: info.teacherName,
            childName: info.childName,
            body: info.body,
            portalUrl,
            attachmentLinks: info.attachments.map((attachment) => ({
              fileName: attachment.filename,
              url: attachment.path,
            })),
          });
          const providerId = await deliverOffPortal({
            channel: d.channel as OffPortalChannel,
            to: d.channelIdentity,
            body: text,
            useTemplate,
          });
          await ctx.runMutation(internal.parentMessageSend.markDelivery, {
            deliveryId: d.deliveryId,
            status: providerId ? "sent" : "skipped",
            providerId: providerId ?? undefined,
          });
        } catch (e) {
          await ctx.runMutation(internal.parentMessageSend.markDelivery, {
            deliveryId: d.deliveryId,
            status: "failed",
            error: e instanceof Error ? e.message : String(e),
          });
        }
      }
    }
  },
});

/**
 * One-time orientation reply sent back over the parent's phone channel the
 * instant they opt in (scheduled from `ingestInboundPhone`). It tells them the
 * link worked and — crucially, since every message comes from the SAME number —
 * how to tell the teacher from the 🐰 automated assistant. The inbound just
 * re-opened the WhatsApp 24h window, so this free-form send is allowed.
 */
export const sendOptInWelcome = internalAction({
  args: {
    channel: v.union(v.literal("sms"), v.literal("whatsapp")),
    identity: v.string(),
    childNames: v.array(v.string()),
  },
  handler: async (ctx, { channel, identity, childNames }) => {
    const portalBase = appBaseUrl();
    const body = welcomeMessage(childNames, `${portalBase}/parent`);
    await deliverOffPortal({
      channel: channel as OffPortalChannel,
      to: identity,
      body,
    });
  },
});
