// A Quest's "ready to show" message in Slack, and its "Award badge" button
// (TRA-684; review/quests-rebuilt-proposal.html, figure 8 "Showing a Quest",
// "Three kinds of message", "Rules for the messages").
//
// The first time a scholar says their Quest is ready to show
// (questShowing.markReadyToShow), `postReady` posts one message naming the
// Quest's advisor (a Slack mention when they are linked), with the scholar's
// own words and one button, "Award badge" (lib/questShowingSlack.ts). It goes in
// the Quest's Slack thread (the proposal's post, through the about-thread
// mapping) when there is one, else as its own post in the scholar's class
// channel, mapped to the Quest's thread in Messages so a teacher's reply
// lands there (4a's relay).
//
// The same gates as a proposal's post, checked when it is planned and again
// right before every write to Slack: the channel is bound to the scholar's
// school alone and a class of theirs there is linked to it, they are still
// enrolled there, they are not flagged (dayWonders.scholarIsFlagged), and
// Slack says the channel is not shared with another organization (unknown
// counts as shared). Anything refused writes nothing, and the log says why.
//
// The message is rebuilt from stored state by `syncReadyPost`, scheduled by
// every change with a stamp (an edit of the words, an award from anywhere:
// the web, this button, the aide's tool), so concurrent changes converge on
// the latest whatever order their writes land in.
//
// "Award badge" (`handleSeenItButton`, from /slack/interactivity, which verifies
// Slack's signature and refuses an unlinked Slack user) opens "Name the
// badge" for a teacher who may award (questProposals.mayActOnScholarQuest);
// anyone else is refused privately and nothing changes. Submitting it
// (`handleSeenItSubmission`) awards through questShowing.awardBadgeForUser,
// the core the web shares, which re-checks who may award. A second award
// returns the badge already there.

import { ConvexError, v } from "convex/values";
import {
  internalAction,
  internalMutation,
  internalQuery,
  type ActionCtx,
  type QueryCtx,
} from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import type { QuestApproval } from "./lib/questApproval";
import { ROLES } from "./lib/roles";
import { aboutThreadInstitutionId } from "./lib/scholarThreadAccess";
import { aboutSlackRootsFor } from "./scholarMessages";
import { channelSchool, scholarIsFlagged } from "./dayWonders";
import { mayActOnScholarQuest } from "./questProposals";
import {
  MAX_ATTEMPTS,
  channelIsOurs,
  classChannelFor,
  isTransient,
  labelInChannel,
  retryDelayMs,
} from "./questProposalSlack";
import {
  QUEST_SHOWING_SEEN,
  badgeNameFromValues,
  parseSeenItMetadata,
  readyPost,
  readyStamp,
  seenItModal,
  type ReadyPostView,
} from "./lib/questShowingSlack";
import {
  fetchConversationHistory,
  fetchConversationReplies,
  messageWithDeliveryMetadata,
  openView,
  postMessage,
  respondEphemeral,
  updateBlocks,
} from "./lib/slackApi";
import { escapeSlackText } from "./lib/slackText";
import {
  flattenViewValues,
  messageLocation,
  type SlackBlockAction,
  type SlackBlockActionsPayload,
  type SlackViewSubmissionPayload,
} from "./lib/slackInteractivity";

const LOG = "[QuestShowingSlack]";
const POST_EVENT_TYPE = "rabbithole_quest_ready";

function deliveryId(unitId: Id<"units">): string {
  return `quest-ready:${unitId}`;
}

/** A person as a message names them: their name, else their login. */
function personName(user: Doc<"users"> | null, fallback: string): string {
  return user?.name?.trim() || user?.username?.trim() || fallback;
}

/** A Slack member id we may put in a mention (slackMention allowlists the
 *  characters again). */
const SLACK_MEMBER_ID = /^[UW][A-Za-z0-9_-]+$/;

type ReadyQuest = {
  unit: Doc<"units"> & { questApproval: QuestApproval };
  scholar: Doc<"users">;
  schoolId: Id<"institutions">;
};

/**
 * The approved Quest its scholar said is ready to show, at their live school,
 * and the scholar not flagged as of `nowMs`. Or why not.
 */
async function loadReadyQuest(
  ctx: QueryCtx,
  unitId: Id<"units">,
  nowMs: number,
): Promise<ReadyQuest | { reason: string }> {
  const unit = await ctx.db.get(unitId);
  const approval = unit?.questApproval;
  if (!unit || !approval || !unit.authorScholarId) return { reason: "no such Quest" };
  if (approval.state !== "approved") return { reason: "not an approved Quest" };
  if (approval.readyToShowAt === undefined || approval.inMyWords === undefined) {
    return { reason: "the scholar hasn't said it is ready to show" };
  }
  const scholar = await ctx.db.get(unit.authorScholarId);
  if (!scholar || scholar.role !== ROLES.SCHOLAR) return { reason: "no scholar" };
  const schoolId = await aboutThreadInstitutionId(ctx, scholar);
  const school = schoolId ? await ctx.db.get(schoolId) : null;
  if (!schoolId || !school || school.disabledAt !== undefined) {
    return { reason: "the scholar has no live school" };
  }
  if (unit.institutionId !== undefined && unit.institutionId !== schoolId) {
    return { reason: "the Quest belongs to another school" };
  }
  if (await scholarIsFlagged(ctx, scholar._id, nowMs)) {
    return { reason: "the scholar is flagged" };
  }
  return { unit: { ...unit, questApproval: approval }, scholar, schoolId };
}

/**
 * Whether this channel may carry the scholar's name: it is bound to their
 * school's classes alone (dayWonders.channelSchool) and a class of theirs at
 * that school is linked to it.
 */
async function channelCarriesScholar(
  ctx: QueryCtx,
  scholarId: Id<"users">,
  schoolId: Id<"institutions">,
  channelId: string,
): Promise<boolean> {
  if ((await channelSchool(ctx, channelId)) !== schoolId) return false;
  const classes = await ctx.db
    .query("scholarGroups")
    .withIndex("by_slack_channel", (q) => q.eq("slackChannelId", channelId))
    .collect();
  return classes.some(
    (group) =>
      group.institutionId === schoolId && group.scholarIds.some((id) => id === scholarId),
  );
}

async function viewIn(
  ctx: QueryCtx,
  quest: ReadyQuest,
  channelId: string,
): Promise<ReadyPostView> {
  const { unit, scholar } = quest;
  const approval = unit.questApproval;
  const advisorUser = approval.advisorId ? await ctx.db.get(approval.advisorId) : null;
  const advisor = !advisorUser
    ? null
    : advisorUser.slackUserId && SLACK_MEMBER_ID.test(advisorUser.slackUserId)
      ? { slackUserId: advisorUser.slackUserId }
      : { name: personName(advisorUser, "Their advisor") };
  let seen: ReadyPostView["seen"] = null;
  if (approval.badgeId) {
    const badge = await ctx.db.get(approval.badgeId);
    const awarder = approval.awardedBy ? await ctx.db.get(approval.awardedBy) : null;
    seen = {
      by: approval.awardedBy ? personName(awarder, "A teacher") : null,
      badgeName: badge?.badgeSnapshot.title ?? "Badge awarded",
    };
  }
  return {
    unitId: unit._id,
    scholarLabel: await labelInChannel(ctx, scholar, channelId),
    title: unit.title,
    words: approval.inMyWords ?? "",
    advisor,
    seen,
  };
}

/** Where the first message goes and what it says, or why it doesn't post. */
export const readyPlan = internalQuery({
  args: { unitId: v.id("units"), nowMs: v.number() },
  handler: async (
    ctx,
    { unitId, nowMs },
  ): Promise<
    | {
        ok: true;
        channelId: string;
        /** Set when it is a reply in the Quest's Slack thread. */
        threadTs?: string;
        stamp: string;
        view: ReadyPostView;
      }
    | { ok: false; reason: string }
  > => {
    const quest = await loadReadyQuest(ctx, unitId, nowMs);
    if ("reason" in quest) return { ok: false, reason: quest.reason };
    const approval = quest.unit.questApproval;
    if (approval.readySlackPost) return { ok: false, reason: "already posted" };
    if (approval.shownAt !== undefined) {
      return { ok: false, reason: "a teacher awarded the badge before it posted" };
    }
    if (!quest.unit.isActive) return { ok: false, reason: "the Quest was put away" };
    // The Quest's own Slack thread, when it has one this scholar's name may
    // still go to; else the scholar's class channel, as a post of its own.
    const roots = await aboutSlackRootsFor(ctx, quest.scholar._id, { type: "quest", unitId });
    let target: { channelId: string; threadTs?: string } | null = null;
    for (const root of roots) {
      if (await channelCarriesScholar(ctx, quest.scholar._id, quest.schoolId, root.channelId)) {
        target = { channelId: root.channelId, threadTs: root.threadTs };
        break;
      }
    }
    if (!target) {
      const channel = await classChannelFor(ctx, quest.scholar, quest.schoolId);
      if ("reason" in channel) return { ok: false, reason: channel.reason };
      target = { channelId: channel.channelId };
    }
    return {
      ok: true,
      ...target,
      stamp: readyStamp(approval),
      view: await viewIn(ctx, quest, target.channelId),
    };
  },
});

/**
 * What a retry needs to find and record a message an earlier attempt already
 * posted, with NO gate: recording it writes nothing to Slack, and a message
 * Slack accepted must be on record whatever has changed since, so its button
 * works and later syncs can reach it once the gates allow a write. Null for
 * a unit that isn't a Quest its scholar said is ready to show.
 */
export const recoveryFacts = internalQuery({
  args: { unitId: v.id("units") },
  handler: async (
    ctx,
    { unitId },
  ): Promise<{ scholarId: Id<"users">; readyToShowAt: number; recorded: boolean } | null> => {
    const unit = await ctx.db.get(unitId);
    const approval = unit?.questApproval;
    if (!unit?.authorScholarId || approval?.readyToShowAt === undefined) return null;
    return {
      scholarId: unit.authorScholarId,
      readyToShowAt: approval.readyToShowAt,
      recorded: approval.readySlackPost !== undefined,
    };
  },
});

/**
 * The message as it should read now, where it is, and the stamp it shows.
 * Re-authorized exactly as a post is: null-like (`reason`) unless the Quest
 * is still approved and ready, the scholar is still at their live school and
 * unflagged, and the message's channel still carries their name.
 */
export const postedView = internalQuery({
  args: { unitId: v.id("units"), nowMs: v.number() },
  handler: async (
    ctx,
    { unitId, nowMs },
  ): Promise<
    | { ok: true; stamp: string; channelId: string; ts: string; view: ReadyPostView }
    | { ok: false; reason: string }
  > => {
    const post = (await ctx.db.get(unitId))?.questApproval?.readySlackPost;
    if (!post) return { ok: false, reason: "not posted" };
    const quest = await loadReadyQuest(ctx, unitId, nowMs);
    if ("reason" in quest) return { ok: false, reason: quest.reason };
    if (!(await channelCarriesScholar(ctx, quest.scholar._id, quest.schoolId, post.channelId))) {
      return { ok: false, reason: "its channel no longer carries the scholar's class at their school" };
    }
    return {
      ok: true,
      stamp: readyStamp(quest.unit.questApproval),
      channelId: post.channelId,
      ts: post.ts,
      view: await viewIn(ctx, quest, post.channelId),
    };
  },
});

/**
 * Asked right before a write to Slack, after the slow calls: everything
 * `postedView` checks still holds, for this channel, and, for a new post,
 * the Quest is still waiting to be seen and has no message yet.
 */
export const bindingHolds = internalQuery({
  args: {
    unitId: v.id("units"),
    channelId: v.string(),
    nowMs: v.number(),
    newPost: v.boolean(),
  },
  handler: async (ctx, { unitId, channelId, nowMs, newPost }): Promise<boolean> => {
    const quest = await loadReadyQuest(ctx, unitId, nowMs);
    if ("reason" in quest) return false;
    const approval = quest.unit.questApproval;
    if (newPost) {
      if (approval.readySlackPost || approval.shownAt !== undefined || !quest.unit.isActive) {
        return false;
      }
    } else if (approval.readySlackPost?.channelId !== channelId) {
      return false;
    }
    return await channelCarriesScholar(ctx, quest.scholar._id, quest.schoolId, channelId);
  },
});

/** The message's stamp now (lib/questShowingSlack.ts readyStamp). */
export const currentStamp = internalQuery({
  args: { unitId: v.id("units") },
  handler: async (ctx, { unitId }): Promise<string | null> => {
    const approval = (await ctx.db.get(unitId))?.questApproval;
    return approval ? readyStamp(approval) : null;
  },
});

/**
 * Remember the message, once. True when it is this one (now or already);
 * false when the Quest is gone or another message is already on record.
 */
export const recordReadyPost = internalMutation({
  args: {
    unitId: v.id("units"),
    channelId: v.string(),
    ts: v.string(),
    threadTs: v.optional(v.string()),
  },
  handler: async (ctx, { unitId, channelId, ts, threadTs }): Promise<boolean> => {
    const unit = await ctx.db.get(unitId);
    const approval = unit?.questApproval;
    if (!unit || !approval) return false;
    const existing = approval.readySlackPost;
    if (existing) return existing.channelId === channelId && existing.ts === ts;
    await ctx.db.patch(unitId, {
      questApproval: {
        ...approval,
        readySlackPost: { channelId, ts, ...(threadTs ? { threadTs } : {}) },
      },
    });
    return true;
  },
});

/**
 * Post the message, once. Scheduled by the first "ready to show", then by
 * its own retries. A retry first looks where an earlier attempt posted for
 * that attempt's message (its delivery metadata), so a post Slack took but
 * whose answer was lost isn't posted twice; one it finds is recorded even if
 * the gates now refuse, since recording writes nothing to Slack, and the sync
 * decides whether to rewrite it. Already on record: it hands over to the sync.
 */
export const postReady = internalAction({
  args: {
    unitId: v.id("units"),
    attempt: v.optional(v.number()),
    /** Where an earlier attempt posted, where its message may be. */
    channelId: v.optional(v.string()),
    threadTs: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<void> => {
    const { unitId, attempt = 0 } = args;
    const token = process.env.SLACK_BOT_TOKEN;
    if (!token) {
      console.log(`${LOG} ${unitId} not posted: Slack isn't configured here`);
      return;
    }
    let posting: { channelId: string; threadTs?: string } | undefined = args.channelId
      ? { channelId: args.channelId, ...(args.threadTs ? { threadTs: args.threadTs } : {}) }
      : undefined;
    const retry = async (why: string, retryAfterMs?: number) => {
      if (attempt + 1 >= MAX_ATTEMPTS) {
        console.error(`${LOG} ${unitId} not posted: gave up after ${attempt + 1} attempts (${why})`);
        return;
      }
      console.warn(`${LOG} ${unitId} post will retry: ${why}`);
      await ctx.scheduler.runAfter(
        retryDelayMs(attempt, retryAfterMs),
        internal.questShowingSlack.postReady,
        { unitId, attempt: attempt + 1, ...(posting ?? {}) },
      );
    };
    const facts = await ctx.runQuery(internal.questShowingSlack.recoveryFacts, { unitId });
    if (!facts) {
      console.log(`${LOG} ${unitId} not posted: not a Quest its scholar said is ready to show`);
      return;
    }
    if (facts.recorded) {
      // Already on record: the sync brings it up to date, past its gates.
      const stamp = await ctx.runQuery(internal.questShowingSlack.currentStamp, { unitId });
      if (stamp) {
        await ctx.scheduler.runAfter(0, internal.questShowingSlack.syncReadyPost, { unitId, stamp });
      }
      return;
    }
    // The gates decide whether anything new is posted.
    const plan = await ctx.runQuery(internal.questShowingSlack.readyPlan, {
      unitId,
      nowMs: Date.now(),
    });
    // An earlier attempt's message is looked for whatever the gates say now:
    // finding and recording it writes nothing to Slack, and once on record
    // it is brought up to date (by the sync, past the gates), never added to.
    const searchIn =
      posting ?? (plan.ok ? { channelId: plan.channelId, threadTs: plan.threadTs } : undefined);
    const canRecover = attempt > 0 && searchIn !== undefined;
    if (!plan.ok && !canRecover) {
      console.log(`${LOG} ${unitId} not posted: ${plan.reason}`);
      return;
    }
    let ts: string | undefined;
    let at = searchIn;
    let recovered = false;
    if (canRecover && searchIn) {
      const read = searchIn.threadTs
        ? await fetchConversationReplies(token, searchIn.channelId, searchIn.threadTs)
        : await fetchConversationHistory(token, searchIn.channelId, {
            oldest: String(Math.floor(facts.readyToShowAt / 1000) - 60),
          });
      if (!read.ok) return await retry(`history: ${read.error ?? "unknown"}`, read.retryAfterMs);
      ts = messageWithDeliveryMetadata(read.messages, POST_EVENT_TYPE, deliveryId(unitId))?.ts;
      recovered = ts !== undefined;
    }
    if (!ts) {
      if (!plan.ok) {
        console.log(`${LOG} ${unitId} not posted: ${plan.reason}`);
        return;
      }
      const ours = await channelIsOurs(token, plan.channelId);
      if (ours === null) return await retry("couldn't read the channel's sharing");
      if (!ours) {
        console.log(`${LOG} ${unitId} not posted: the channel is shared with another organization`);
        return;
      }
      const holds = await ctx.runQuery(internal.questShowingSlack.bindingHolds, {
        unitId,
        channelId: plan.channelId,
        nowMs: Date.now(),
        newPost: true,
      });
      if (!holds) {
        console.log(`${LOG} ${unitId} not posted: the channel or the Quest changed while it waited`);
        return;
      }
      posting = { channelId: plan.channelId, ...(plan.threadTs ? { threadTs: plan.threadTs } : {}) };
      const sent = await postMessage(token, {
        channel: plan.channelId,
        ...(plan.threadTs ? { threadTs: plan.threadTs } : {}),
        ...readyPost(plan.view),
        metadata: {
          event_type: POST_EVENT_TYPE,
          event_payload: { delivery_id: deliveryId(unitId) },
        },
      });
      if (!sent.ok || !sent.ts) {
        const why = sent.error ?? "no ts";
        if (isTransient(sent)) return await retry(why, sent.retryAfterMs);
        console.error(`${LOG} ${unitId} not posted: ${why}`);
        return;
      }
      ts = sent.ts;
      at = { channelId: sent.channel ?? plan.channelId, threadTs: plan.threadTs };
    }
    const where = at!;
    const recorded = await ctx.runMutation(internal.questShowingSlack.recordReadyPost, {
      unitId,
      channelId: where.channelId,
      ts,
      ...(where.threadTs ? { threadTs: where.threadTs } : {}),
    });
    if (!recorded) {
      console.error(`${LOG} ${unitId}: posted at ${ts} but it could not be recorded`);
      return;
    }
    // A post of its own is the Quest's thread in Slack from now on: a
    // teacher's reply under it lands in the Quest's thread in Messages.
    if (!where.threadTs) {
      const mapped = await ctx.runMutation(internal.scholarMessages.recordAboutSlackThread, {
        channelId: where.channelId,
        threadTs: ts,
        scholarId: facts.scholarId,
        about: { type: "quest", unitId },
      });
      if (!mapped) console.error(`${LOG} ${unitId}: posted at ${ts} but its thread could not be mapped`);
    }
    // A fresh post shows the Quest as this attempt read it; a change since
    // then found no message to update, so it is handed to the sync. A
    // recovered post says whatever the first attempt wrote, so it always is.
    const now = await ctx.runQuery(internal.questShowingSlack.currentStamp, { unitId });
    if (now && (recovered || (plan.ok && now !== plan.stamp))) {
      await ctx.scheduler.runAfter(0, internal.questShowingSlack.syncReadyPost, {
        unitId,
        stamp: now,
      });
    }
  },
});

/**
 * Rewrite the message to read as the Quest stands: the scholar's words as
 * they last sent them, and once the badge is awarded, who saw it and the
 * badge's name in place of the button. Every change schedules one carrying
 * its stamp; a first try whose stamp is no longer current does nothing,
 * because the newer change scheduled its own. After writing, a sync re-reads
 * the stamp and schedules one more if the Quest changed while it wrote.
 * Nothing is written unless every gate still holds; Slack's transient
 * failures are retried with backoff, a few times.
 */
export const syncReadyPost = internalAction({
  args: { unitId: v.id("units"), stamp: v.string(), attempt: v.optional(v.number()) },
  handler: async (ctx, { unitId, stamp: asked, attempt = 0 }): Promise<void> => {
    const token = process.env.SLACK_BOT_TOKEN;
    if (!token) return;
    const posted = await ctx.runQuery(internal.questShowingSlack.postedView, {
      unitId,
      nowMs: Date.now(),
    });
    if (!posted.ok) {
      if (posted.reason !== "not posted") {
        console.warn(`${LOG} ${unitId}: message left as it was; ${posted.reason}`);
      }
      return;
    }
    // A retry with an old stamp still writes: the latest state is what it
    // writes, so the last write that lands is always the newest.
    if (posted.stamp !== asked && attempt === 0) return;
    const stamp = posted.stamp;
    const retry = async (why: string, retryAfterMs?: number) => {
      if (attempt + 1 >= MAX_ATTEMPTS) {
        console.error(
          `${LOG} ${unitId}: message not brought up to date, gave up after ${attempt + 1} attempts (${why})`,
        );
        return;
      }
      await ctx.scheduler.runAfter(
        retryDelayMs(attempt, retryAfterMs),
        internal.questShowingSlack.syncReadyPost,
        { unitId, stamp, attempt: attempt + 1 },
      );
    };
    const ours = await channelIsOurs(token, posted.channelId);
    if (ours === null) return await retry("couldn't read the channel's sharing");
    if (!ours) {
      console.warn(`${LOG} ${unitId}: message left as it was; its channel is shared with another organization`);
      return;
    }
    const holds = await ctx.runQuery(internal.questShowingSlack.bindingHolds, {
      unitId,
      channelId: posted.channelId,
      nowMs: Date.now(),
      newPost: false,
    });
    if (!holds) {
      console.warn(`${LOG} ${unitId}: message left as it was; the channel or the Quest changed while it waited`);
      return;
    }
    const res = await updateBlocks(token, {
      channel: posted.channelId,
      ts: posted.ts,
      ...readyPost(posted.view),
    });
    if (!res.ok) {
      if (isTransient(res)) return await retry(res.error ?? "unknown", res.retryAfterMs);
      console.error(`${LOG} ${unitId}: chat.update failed: ${res.error ?? "unknown"}`);
      return;
    }
    const after = await ctx.runQuery(internal.questShowingSlack.currentStamp, { unitId });
    if (after && after !== stamp) {
      await ctx.scheduler.runAfter(0, internal.questShowingSlack.syncReadyPost, {
        unitId,
        stamp: after,
      });
    }
  },
});

// ── "Award badge" ─────────────────────────────────────────────────────────

/**
 * May this person award the badge of the Quest whose message this is? The
 * button counts only on the Quest's own message. Who may award is the
 * award's own rule (`mayActOnScholarQuest`), checked before anything else
 * about the Quest; the award re-checks it when the modal is submitted.
 */
export const seenItCheck = internalQuery({
  args: {
    unitId: v.string(),
    channelId: v.string(),
    ts: v.string(),
    userId: v.id("users"),
  },
  handler: async (
    ctx,
    args,
  ): Promise<
    | { status: "ok"; unitId: Id<"units">; scholarLabel: string; title: string }
    | { status: "awarded"; unitId: Id<"units">; badgeName: string }
    | { status: "forbidden" }
    | { status: "gone" }
  > => {
    const unitId = ctx.db.normalizeId("units", args.unitId);
    const unit = unitId ? await ctx.db.get(unitId) : null;
    const approval = unit?.questApproval;
    const post = approval?.readySlackPost;
    if (!unit || !approval || !unit.authorScholarId || !post) return { status: "gone" };
    if (post.channelId !== args.channelId || post.ts !== args.ts) return { status: "gone" };
    const scholar = await ctx.db.get(unit.authorScholarId);
    if (!scholar || scholar.role !== ROLES.SCHOLAR) return { status: "gone" };
    const user = await ctx.db.get(args.userId);
    if (!user || !(await mayActOnScholarQuest(ctx, user, scholar, unit.institutionId))) {
      return { status: "forbidden" };
    }
    if (approval.state !== "approved" || !unit.isActive) return { status: "gone" };
    const badge = await ctx.db
      .query("scholarUnitBadges")
      .withIndex("by_scholar_unit", (q) => q.eq("scholarId", scholar._id).eq("unitId", unit._id))
      .first();
    if (badge) {
      return { status: "awarded", unitId: unit._id, badgeName: badge.badgeSnapshot.title };
    }
    return {
      status: "ok",
      unitId: unit._id,
      scholarLabel: await labelInChannel(ctx, scholar, args.channelId),
      title: unit.title,
    };
  },
});

const REFUSED_FORBIDDEN =
  "Only a teacher at this scholar's school can award this Quest's badge, so nothing changed.";
const REFUSED_GONE = "I can't find that Quest, so nothing changed.";
const REFUSED_UNKNOWN = "That didn't go through, so nothing changed. Try again in a moment.";
const MODAL_FAILED = "The badge form didn't open in time. Tap Award badge again.";
/** A badge's name is a teacher's words: escaped, like everything else a
 *  person wrote that reaches Slack. */
const alreadyAwarded = (badgeName: string) =>
  `This Quest already has its badge, ${escapeSlackText(badgeName)}, so nothing changed.`;

/**
 * "Award badge", tapped by `clicker` (the Slack user's linked Rabbithole user;
 * slackInteractivity refuses an unlinked one before this). Opens "Name the
 * badge" for a teacher who may award; says anything else privately.
 */
export async function handleSeenItButton(
  ctx: ActionCtx,
  p: SlackBlockActionsPayload,
  action: SlackBlockAction,
  clicker: { userId: Id<"users"> },
): Promise<void> {
  if (action.action_id !== QUEST_SHOWING_SEEN) return;
  const say = (text: string) => respondEphemeral(p.response_url, text);
  const loc = messageLocation(p);
  const token = process.env.SLACK_BOT_TOKEN;
  if (!loc || !action.value || !token) return;
  // Slack retries a tap it didn't hear back about: one answer per tap.
  const { fresh } = await ctx.runMutation(internal.slackBot.claimEvent, {
    eventId: `qshow:${p.trigger_id ?? action.action_ts ?? ""}:${action.action_id}`,
  });
  if (!fresh) return;
  const check = await ctx.runQuery(internal.questShowingSlack.seenItCheck, {
    unitId: action.value,
    channelId: loc.channel,
    ts: loc.ts,
    userId: clicker.userId,
  });
  switch (check.status) {
    case "gone":
      await say(REFUSED_GONE);
      return;
    case "forbidden":
      await say(REFUSED_FORBIDDEN);
      return;
    case "awarded": {
      await say(alreadyAwarded(check.badgeName));
      // The message may not show it yet (an award from before it posted).
      const stamp = await ctx.runQuery(internal.questShowingSlack.currentStamp, {
        unitId: check.unitId,
      });
      if (stamp) {
        await ctx.scheduler.runAfter(0, internal.questShowingSlack.syncReadyPost, {
          unitId: check.unitId,
          stamp,
        });
      }
      return;
    }
    case "ok":
      break;
  }
  if (!p.trigger_id) return;
  const opened = await openView(token, {
    triggerId: p.trigger_id,
    view: seenItModal({
      metadata: {
        unitId: check.unitId,
        channelId: loc.channel,
        ts: loc.ts,
        ...(p.response_url ? { responseUrl: p.response_url } : {}),
      },
      scholarLabel: check.scholarLabel,
      title: check.title,
    }),
  });
  if (!opened.ok) {
    console.error(`${LOG} ${check.unitId}: views.open failed: ${opened.error ?? "unknown"}`);
    await say(MODAL_FAILED);
  }
}

/**
 * "Name the badge" submitted. The award is the core's
 * (questShowing.awardBadgeForUser): who may award, that the Quest is
 * approved, and one badge per Quest are all decided there. Anything refused
 * is said privately, where the button was tapped.
 */
export async function handleSeenItSubmission(
  ctx: ActionCtx,
  p: SlackViewSubmissionPayload,
  clicker: { userId: Id<"users"> },
): Promise<void> {
  const meta = parseSeenItMetadata(p.view.private_metadata);
  if (!meta) return;
  const say = (text: string) => respondEphemeral(meta.responseUrl, text);
  // Slack retries a submission it didn't hear back about: one award per form.
  const { fresh } = await ctx.runMutation(internal.slackBot.claimEvent, {
    eventId: `qshow:view:${p.view.id}`,
  });
  if (!fresh) return;
  // The form answers the message it was opened from, and only that one.
  const check = await ctx.runQuery(internal.questShowingSlack.seenItCheck, {
    unitId: meta.unitId,
    channelId: meta.channelId,
    ts: meta.ts,
    userId: clicker.userId,
  });
  if (check.status === "gone") return await say(REFUSED_GONE);
  if (check.status === "forbidden") return await say(REFUSED_FORBIDDEN);
  let outcome: { badgeName: string; alreadyAwarded: boolean };
  try {
    outcome = await ctx.runMutation(internal.questShowing.awardBadgeForUser, {
      unitId: check.unitId,
      badgeName: badgeNameFromValues(flattenViewValues(p.view)),
      awarderId: clicker.userId,
    });
  } catch (error: unknown) {
    if (error instanceof ConvexError && typeof error.data === "string") {
      // Written to be read: "A badge needs a name."
      await say(escapeSlackText(error.data));
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("Forbidden")) await say(REFUSED_FORBIDDEN);
    else if (message.includes("not found")) await say(REFUSED_GONE);
    else {
      console.error(`${LOG} ${check.unitId}: award failed:`, message);
      await say(REFUSED_UNKNOWN);
    }
    return;
  }
  // The award scheduled the message's update. A second award changes nothing.
  if (outcome.alreadyAwarded) await say(alreadyAwarded(outcome.badgeName));
}
