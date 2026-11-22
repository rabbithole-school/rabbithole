/**
 * Delivery receipts for whispers a teacher queued from Slack (TRA-591).
 *
 * The bot's reply when a teacher asks for a whisper says "queued". A queued
 * whisper and a delivered one look the same unless someone says which, and the
 * scholar may have left the session. So when a turn reads a Slack-queued
 * whisper (the end-of-turn clear in `sessionHelpers.clearPendingWhisper`), we
 * post once in the thread the teacher asked in. In an alert channel or a 1:1
 * DM the post quotes the last paragraph of the AI's reply, where its question
 * to the scholar usually sits; anywhere else it just says "Delivered". Only
 * the AI's words are ever quoted, never the scholar's.
 *
 * A whisper the remote-mode box clears or edits before it is read never posts
 * "Delivered": its receipt is removed and the thread is told so.
 */
import { v } from "convex/values";
import {
  internalAction,
  internalQuery,
  type MutationCtx,
} from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { postMessage } from "./lib/slackApi";
import { greyLineMessage } from "./lib/slackGreyLine";
import { escapeSlackInline } from "./lib/slackText";
import { slotHasWhisper } from "./lib/teacherWhisper";

const REPLY_SNIPPET_CHARS = 240;
const MAX_POST_ATTEMPTS = 3;

/**
 * The thread post for a delivered whisper. Pure, so the shape is testable.
 * Quotes the reply's last paragraph: the opening of a first turn is the stock
 * AI intro, which says nothing about what the whisper changed (live probe,
 * 2026-11-08).
 */
export function deliveredReceiptText(
  scholarName: string,
  assistantReply: string | null,
  quoteReply: boolean,
): string {
  const name = escapeSlackInline(scholarName) || "the scholar";
  const head = `✓ Delivered when ${name} was next in the session.`;
  if (!quoteReply) return head;
  const paragraphs = (assistantReply ?? "")
    .split(/\n\s*\n/)
    .map((paragraph) => escapeSlackInline(paragraph))
    .filter(Boolean);
  const last = paragraphs.at(-1);
  if (!last) return head;
  const snippet =
    last.length <= REPLY_SNIPPET_CHARS
      ? last
      : `…${last.slice(-REPLY_SNIPPET_CHARS).replace(/^\S*\s+/, "")}`;
  return `${head} The AI replied: "${snippet}"`;
}

export const CLEARED_RECEIPT_TEXT =
  "✕ A teacher cleared or edited this whisper in Rabbithole before the AI read it, so it won't be delivered as sent.";

/**
 * Mark delivered every Slack receipt whose whisper this turn read, and schedule
 * its post. "Read" means the whole whisper was in the text the turn used
 * (`consumed`) and it was queued before the turn read the slot (`readAt`): a
 * copy queued mid-turn waits for the turn that actually reads it.
 */
export async function deliverReadReceipts(
  ctx: MutationCtx,
  args: {
    sessionId: Id<"sessions">;
    consumed: string;
    readAt?: number;
    turnFirstMessageId?: Id<"messages">;
  },
): Promise<void> {
  const waiting = await ctx.db
    .query("slackWhisperReceipts")
    .withIndex("by_session_delivered", (q) =>
      q.eq("sessionId", args.sessionId).eq("deliveredAt", undefined),
    )
    .collect();
  for (const receipt of waiting) {
    if (args.readAt !== undefined && receipt.queuedAt > args.readAt) continue;
    if (!slotHasWhisper(args.consumed, receipt.text)) continue;
    await ctx.db.patch(receipt._id, { deliveredAt: Date.now() });
    await ctx.scheduler.runAfter(0, internal.whisperReceipts.postDelivered, {
      receiptId: receipt._id,
      turnFirstMessageId: args.turnFirstMessageId,
    });
  }
}

/**
 * After the remote-mode box rewrites the slot, remove the receipt of every
 * Slack whisper that is no longer in it and tell its thread, so a later
 * whisper with the same words can never be reported as this one's delivery.
 */
export async function retireClearedReceipts(
  ctx: MutationCtx,
  sessionId: Id<"sessions">,
  slot: string | undefined,
): Promise<void> {
  const waiting = await ctx.db
    .query("slackWhisperReceipts")
    .withIndex("by_session_delivered", (q) =>
      q.eq("sessionId", sessionId).eq("deliveredAt", undefined),
    )
    .collect();
  for (const receipt of waiting) {
    if (slotHasWhisper(slot, receipt.text)) continue;
    await ctx.db.delete(receipt._id);
    await ctx.scheduler.runAfter(0, internal.whisperReceipts.postInThread, {
      channelId: receipt.slackChannelId,
      threadTs: receipt.slackThreadTs,
      text: CLEARED_RECEIPT_TEXT,
    });
  }
}

/**
 * Everything the delivered post needs. The reply is the turn's whole answer:
 * the AI's messages from the turn's first one on (a tool call splits a reply
 * into several), so the quote is never empty because the last piece was.
 */
export const deliveryFacts = internalQuery({
  args: {
    receiptId: v.id("slackWhisperReceipts"),
    turnFirstMessageId: v.optional(v.id("messages")),
  },
  handler: async (ctx, args) => {
    const receipt = await ctx.db.get(args.receiptId);
    if (!receipt) return null;
    const session = await ctx.db.get(receipt.sessionId);
    const scholar = session ? await ctx.db.get(session.userId) : null;
    const first = args.turnFirstMessageId
      ? await ctx.db.get(args.turnFirstMessageId)
      : null;
    let assistantReply: string | null = null;
    if (receipt.quoteReply && first && first.sessionId === receipt.sessionId) {
      const turn = await ctx.db
        .query("messages")
        .withIndex("by_session", (q) =>
          q
            .eq("sessionId", receipt.sessionId)
            .gte("_creationTime", first._creationTime),
        )
        .take(20);
      assistantReply =
        turn
          .filter(
            (message) =>
              message.role === "assistant" &&
              !message.toolAction &&
              message.content.trim(),
          )
          .map((message) => message.content)
          .join("\n\n") || null;
    }
    return {
      channelId: receipt.slackChannelId,
      threadTs: receipt.slackThreadTs,
      text: deliveredReceiptText(
        scholar?.name ?? scholar?.username ?? "the scholar",
        assistantReply,
        receipt.quoteReply,
      ),
    };
  },
});

export const postDelivered = internalAction({
  args: {
    receiptId: v.id("slackWhisperReceipts"),
    turnFirstMessageId: v.optional(v.id("messages")),
  },
  handler: async (ctx, args) => {
    const facts = await ctx.runQuery(internal.whisperReceipts.deliveryFacts, args);
    if (!facts) return;
    await ctx.runAction(internal.whisperReceipts.postInThread, {
      channelId: facts.channelId,
      threadTs: facts.threadTs,
      text: facts.text,
      grey: true,
    });
  },
});

/**
 * Post one receipt line in a thread. Retries only when Slack asked us to wait
 * (rate limit); an ambiguous failure may already have posted, so it is logged
 * rather than retried, keeping the post at most once.
 *
 * `grey` posts the whole line in Slack's small grey context style: the
 * delivered receipt is an aside nobody has to act on. The cleared notice says
 * the whisper won't arrive, so it stays full size.
 */
export const postInThread = internalAction({
  args: {
    channelId: v.string(),
    threadTs: v.string(),
    text: v.string(),
    grey: v.optional(v.boolean()),
    attempt: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const token = process.env.SLACK_BOT_TOKEN;
    if (!token) return;
    const result = await postMessage(token, {
      channel: args.channelId,
      threadTs: args.threadTs,
      ...(args.grey
        ? greyLineMessage([{ grey: args.text }], { markdown: true })
        : { text: args.text, markdown: true }),
    });
    if (result.ok) return;
    const attempt = args.attempt ?? 0;
    if (
      result.retryAfterMs !== undefined &&
      !result.ambiguous &&
      attempt + 1 < MAX_POST_ATTEMPTS
    ) {
      await ctx.scheduler.runAfter(
        result.retryAfterMs,
        internal.whisperReceipts.postInThread,
        { ...args, attempt: attempt + 1 },
      );
      return;
    }
    console.error(
      `Whisper receipt post failed in ${args.channelId}/${args.threadTs}: ${result.error ?? "unknown"}`,
    );
  },
});
