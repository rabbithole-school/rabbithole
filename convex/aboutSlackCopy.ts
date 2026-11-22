// What a scholar writes in a wonder or Quest conversation also goes to that
// conversation's Slack thread (TRA-693; review/quests-rebuilt-proposal.html,
// "Conversations live in Messages"): "Kai wrote in Rabbithole: …", as a reply
// under the Slack root the conversation is mapped to (aboutSlackThreads, 4a),
// so a teacher answering in Slack sees what the kid said.
//
// A scholar's own message goes, @-mentioning the teachers it concerns, and so
// does one staff wrote in the app ("Ms Lani wrote to Kai in Rabbithole: …"),
// so the Slack thread holds the whole conversation. What the Slack relay
// brings in is marked `source: "slack"` and is never sent back, and a line a
// staff action writes on its own (a Quest's answer) has its own post. Our own
// copy carries our bot's id, which the relay ignores (slackBot `event.bot_id`),
// so it never returns.
// A later edit or retraction does not change the Slack copy.
//
// The same rules as a proposal's post (questProposalSlack.ts), checked right
// before each write: the channel is bound to the scholar's school alone
// (dayWonders.channelSchool), the scholar is still enrolled there, and Slack
// says the channel isn't shared with another organization (unknown counts as
// no). Transient Slack failures retry with backoff; a retry first looks in
// the thread for the copy an earlier attempt may have made, so a post Slack
// took but whose answer was lost isn't posted twice.

import { v } from "convex/values";
import { internalAction, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { ROLES } from "./lib/roles";
import { aboutThreadInstitutionId } from "./lib/scholarThreadAccess";
import { scholarCopyText, staffCopyText } from "./lib/aboutSlackCopy";
import { relevantTeacherSlackIds } from "./lib/slackTeacherMentions";
import { slackMention } from "./lib/slackText";
import { userDisplayName } from "./parentMessages";
import { aboutSlackRootsFor, scholarMessageForSlackCopy } from "./scholarMessages";
import { channelSchool } from "./dayWonders";
import {
  MAX_ATTEMPTS,
  channelIsOurs,
  isTransient,
  labelInChannel,
  retryDelayMs,
} from "./questProposalSlack";
import {
  fetchConversationReplies,
  messageWithDeliveryMetadata,
  postMessage,
} from "./lib/slackApi";

const LOG = "[AboutSlackCopy]";
const EVENT_TYPE = "rabbithole_scholar_message";

function deliveryId(messageId: Id<"parentMessages">, ts: string): string {
  return `about-copy:${messageId}:${ts}`;
}

/**
 * Where the message goes and what it says, or why it goes nowhere: a
 * scholar's own, live message in an `about` thread, copied under each root
 * mapped to that Quest or wonder in a channel bound to their school alone.
 */
export const copyPlan = internalQuery({
  args: { messageId: v.id("parentMessages") },
  handler: async (
    ctx,
    { messageId },
  ): Promise<
    | {
        ok: true;
        roots: { channelId: string; ts: string; text: string }[];
        skipped: number;
      }
    | { ok: false; reason: string }
  > => {
    const message = await scholarMessageForSlackCopy(ctx, messageId);
    if (!message.ok) return message;
    const scholar = await ctx.db.get(message.scholarId);
    if (!scholar || scholar.role !== ROLES.SCHOLAR) return { ok: false, reason: "no scholar" };
    const schoolId = await aboutThreadInstitutionId(ctx, scholar);
    const school = schoolId ? await ctx.db.get(schoolId) : null;
    if (!schoolId || !school || school.disabledAt !== undefined) {
      return { ok: false, reason: "the scholar has no live school" };
    }
    if (message.institutionId !== schoolId) {
      return { ok: false, reason: "the thread belongs to another school" };
    }
    const roots = await aboutSlackRootsFor(ctx, scholar._id, message.about);
    if (roots.length === 0) return { ok: false, reason: "no Slack thread is mapped to it" };
    // A staff message is labelled with its author; a scholar's @-mentions
    // the teachers it concerns (lib/slackTeacherMentions.ts).
    const staffName = message.staffAuthorId
      ? userDisplayName(await ctx.db.get(message.staffAuthorId), "A teacher")
      : null;
    const mentions = staffName
      ? []
      : await relevantTeacherSlackIds(ctx, {
          institutionId: schoolId,
          scholarIds: [scholar._id],
          staffWriterIds: message.staffWriterIds,
          authorUserId: scholar._id,
        });
    const planned: { channelId: string; ts: string; text: string }[] = [];
    let skipped = 0;
    for (const root of roots) {
      if ((await channelSchool(ctx, root.channelId)) !== schoolId) {
        skipped += 1;
        continue;
      }
      const label = await labelInChannel(ctx, scholar, root.channelId);
      const text = staffName
        ? staffCopyText(staffName, label, message.body, message.attachment)
        : scholarCopyText(label, message.body, message.attachment);
      planned.push({
        channelId: root.channelId,
        ts: root.threadTs,
        text: mentions.length > 0 ? `${mentions.map(slackMention).join(" ")}\n${text}` : text,
      });
    }
    return { ok: true, roots: planned, skipped };
  },
});

/** Asked right before the write, after the slow calls. */
export const bindingHolds = internalQuery({
  args: { messageId: v.id("parentMessages"), channelId: v.string() },
  handler: async (ctx, { messageId, channelId }): Promise<boolean> => {
    const message = await scholarMessageForSlackCopy(ctx, messageId);
    if (!message.ok) return false;
    const scholar = await ctx.db.get(message.scholarId);
    if (!scholar) return false;
    const schoolId = await aboutThreadInstitutionId(ctx, scholar);
    const school = schoolId ? await ctx.db.get(schoolId) : null;
    if (!schoolId || !school || school.disabledAt !== undefined) return false;
    return (await channelSchool(ctx, channelId)) === schoolId;
  },
});

/**
 * Post the scholar's message under each mapped Slack root. `done` names the
 * roots (`channel:ts`) already carried, so a retry sends only the rest.
 */
export const copyToSlack = internalAction({
  args: {
    messageId: v.id("parentMessages"),
    attempt: v.optional(v.number()),
    done: v.optional(v.array(v.string())),
  },
  handler: async (ctx, { messageId, attempt = 0, done = [] }): Promise<void> => {
    const token = process.env.SLACK_BOT_TOKEN;
    if (!token) return;
    const plan = await ctx.runQuery(internal.aboutSlackCopy.copyPlan, { messageId });
    if (!plan.ok) {
      console.log(`${LOG} ${messageId} not copied: ${plan.reason}`);
      return;
    }
    if (plan.skipped > 0) {
      console.warn(
        `${LOG} ${messageId}: ${plan.skipped} thread(s) skipped; the channel is no longer the scholar's school's alone`,
      );
    }
    const carried = new Set(done);
    let transient: { why: string; retryAfterMs?: number } | null = null;
    for (const root of plan.roots) {
      const key = `${root.channelId}:${root.ts}`;
      if (carried.has(key)) continue;
      const id = deliveryId(messageId, root.ts);
      if (attempt > 0) {
        // An earlier attempt's post may have landed with its answer lost.
        const replies = await fetchConversationReplies(token, root.channelId, root.ts);
        if (!replies.ok) {
          transient = {
            why: `replies: ${replies.error ?? "unknown"}`,
            retryAfterMs: replies.retryAfterMs,
          };
          continue;
        }
        if (messageWithDeliveryMetadata(replies.messages, EVENT_TYPE, id)) {
          carried.add(key);
          continue;
        }
      }
      const ours = await channelIsOurs(token, root.channelId);
      if (ours === null) {
        transient = { why: "couldn't read the channel's sharing" };
        continue;
      }
      if (!ours) {
        console.log(`${LOG} ${messageId} not copied: the channel is shared with another organization`);
        carried.add(key);
        continue;
      }
      const holds = await ctx.runQuery(internal.aboutSlackCopy.bindingHolds, {
        messageId,
        channelId: root.channelId,
      });
      if (!holds) {
        console.log(`${LOG} ${messageId} not copied: the channel or the scholar changed while it waited`);
        carried.add(key);
        continue;
      }
      const sent = await postMessage(token, {
        channel: root.channelId,
        threadTs: root.ts,
        text: root.text,
        metadata: { event_type: EVENT_TYPE, event_payload: { delivery_id: id } },
      });
      if (sent.ok) {
        carried.add(key);
      } else if (isTransient(sent)) {
        transient = { why: sent.error ?? "unknown", retryAfterMs: sent.retryAfterMs };
      } else {
        console.error(`${LOG} ${messageId}: not copied: ${sent.error ?? "unknown"}`);
        carried.add(key);
      }
    }
    if (!transient) return;
    if (attempt + 1 >= MAX_ATTEMPTS) {
      console.error(
        `${LOG} ${messageId}: not copied, gave up after ${attempt + 1} attempts (${transient.why})`,
      );
      return;
    }
    console.warn(`${LOG} ${messageId} copy will retry: ${transient.why}`);
    await ctx.scheduler.runAfter(
      retryDelayMs(attempt, transient.retryAfterMs),
      internal.aboutSlackCopy.copyToSlack,
      { messageId, attempt: attempt + 1, done: [...carried] },
    );
  },
});
