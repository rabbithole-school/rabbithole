// A scholar's Quest proposal in Slack (TRA-688; review/quests-rebuilt-proposal.html,
// figure 5, "What a teacher can do", "Rules for the messages").
//
// When a scholar proposes (questProposals.proposeQuestAs), `postProposal`
// posts it to their class's Slack channel: their words, the mission, what it
// will be, and Approve / Not this one (lib/questProposalSlack.ts). The class
// is one the scholar is on at their school whose channel is linked to it
// (`link_channel_to_group`) and bound to that school's classes alone (the day's
// wonders rule, dayWonders.channelSchool), their main class first. No such
// channel: nothing posts, and the log says why. Never another school's channel,
// and never a channel Slack says is shared with another organization.
//
// The post's thread is mapped to the Quest's thread in Messages
// (scholarMessages.recordAboutSlackThread, a single-scholar root), so a
// teacher's plain reply there lands in that thread through 4a's relay. One
// Slack thread is one conversation.
//
// A tap on a button (`handleQuestProposalButton`, from /slack/interactivity,
// which verifies Slack's signature) answers through
// questProposals.answerProposalForUser as the tapping teacher's linked
// Rabbithole user, at the revision the button carries. That mutation, like an
// edit, schedules `syncProposalPosts`, which rewrites the post from the
// proposal as it now stands: the new wording and revision while it waits, or
// the answer in place of the buttons; it converges on the latest state and
// retries Slack's transient failures. Anything refused (an unlinked Slack
// user, a teacher who can't answer, an older revision) is said privately to
// the teacher who tapped, and nothing changes.

import { ConvexError, v } from "convex/values";
import {
  internalAction,
  internalQuery,
  type ActionCtx,
  type QueryCtx,
} from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { ROLES } from "./lib/roles";
import { aboutThreadInstitutionId } from "./lib/scholarThreadAccess";
import { QUEST_PROPOSAL_KIND_LINE, isUnlockedQuest } from "./lib/questApproval";
import { aboutSlackRootsFor } from "./scholarMessages";
import { channelSchool } from "./dayWonders";
import {
  QUEST_PROPOSAL_APPROVE,
  QUEST_PROPOSAL_DECLINE,
  parseProposalButtonValue,
  proposalPost,
  proposalStamp,
  type ProposalPostAnswer,
  type ProposalPostView,
} from "./lib/questProposalSlack";
import {
  fetchConversationHistory,
  fetchConversationShape,
  messageWithDeliveryMetadata,
  postMessage,
  respondEphemeral,
  updateBlocks,
} from "./lib/slackApi";
import {
  messageLocation,
  type SlackBlockAction,
  type SlackBlockActionsPayload,
} from "./lib/slackInteractivity";

const LOG = "[QuestProposalSlack]";

/** A person as a message names them: their name, else their login. */
function personName(user: Doc<"users"> | null, fallback: string): string {
  return user?.name?.trim() || user?.username?.trim() || fallback;
}

function firstName(name: string): string {
  return name.split(/\s+/)[0] ?? name;
}

/**
 * The scholar as this class's channel knows them: their first name, or their
 * full name when a classmate in a class bound to the channel shares it.
 */
export async function labelInChannel(
  ctx: QueryCtx,
  scholar: Doc<"users">,
  channelId: string,
): Promise<string> {
  const full = personName(scholar, "A scholar");
  const first = firstName(full).toLowerCase();
  const groups = await ctx.db
    .query("scholarGroups")
    .withIndex("by_slack_channel", (q) => q.eq("slackChannelId", channelId))
    .collect();
  const classmates = new Set(
    groups
      .filter((group) => group.scholarIds.some((id) => id === scholar._id))
      .flatMap((group) => group.scholarIds)
      .filter((id) => id !== scholar._id),
  );
  for (const id of classmates) {
    const classmate = await ctx.db.get(id);
    const name = classmate?.name?.trim();
    if (name && firstName(name).toLowerCase() === first) return full;
  }
  return firstName(full);
}

/** The scholar's class channel at their school, or why there is none. */
export async function classChannelFor(
  ctx: QueryCtx,
  scholar: Doc<"users">,
  schoolId: Id<"institutions">,
): Promise<{ channelId: string } | { reason: string }> {
  const classes = (
    await ctx.db
      .query("scholarGroups")
      .withIndex("by_institution", (q) => q.eq("institutionId", schoolId))
      .collect()
  )
    .filter(
      (group): group is Doc<"scholarGroups"> & { slackChannelId: string } =>
        Boolean(group.slackChannelId) &&
        group.scholarIds.some((id) => id === scholar._id),
    )
    // The main (age-based) class first, then the oldest class.
    .sort((a, b) => {
      const main = (g: Doc<"scholarGroups">) =>
        g.type === undefined || g.type === "primary" ? 0 : 1;
      return main(a) - main(b) || a._creationTime - b._creationTime;
    });
  if (classes.length === 0) {
    return { reason: "no class of the scholar's has a Slack channel linked" };
  }
  for (const group of classes) {
    if ((await channelSchool(ctx, group.slackChannelId)) === schoolId) {
      return { channelId: group.slackChannelId };
    }
  }
  return { reason: "the scholar's class channel is shared with another school's class" };
}

type Proposal = {
  unit: Doc<"units"> & { questApproval: NonNullable<Doc<"units">["questApproval"]> };
  scholar: Doc<"users">;
  schoolId: Id<"institutions">;
};

/** The proposal and its scholar at their live school, or why not. */
async function loadProposal(
  ctx: QueryCtx,
  unitId: Id<"units">,
): Promise<Proposal | { reason: string }> {
  const unit = await ctx.db.get(unitId);
  const approval = unit?.questApproval;
  if (!unit || !approval || !unit.authorScholarId) {
    return { reason: "no such proposal" };
  }
  // A teacher's offer has no Slack post of its own to keep in step (TRA-696).
  if (approval.state === "offered" || approval.offeredBy) {
    return { reason: "a teacher's offer is not a proposal" };
  }
  // Nor has a Quest the scholar started from an unlocked "Code it" mission.
  if (isUnlockedQuest(approval)) {
    return { reason: "an unlocked Quest is not a proposal" };
  }
  const scholar = await ctx.db.get(unit.authorScholarId);
  if (!scholar || scholar.role !== ROLES.SCHOLAR) return { reason: "no scholar" };
  const schoolId = await aboutThreadInstitutionId(ctx, scholar);
  const school = schoolId ? await ctx.db.get(schoolId) : null;
  if (!schoolId || !school || school.disabledAt !== undefined) {
    return { reason: "the scholar has no live school" };
  }
  if (unit.institutionId !== undefined && unit.institutionId !== schoolId) {
    return { reason: "the proposal belongs to another school" };
  }
  return { unit: { ...unit, questApproval: approval }, scholar, schoolId };
}

async function answerFor(
  ctx: QueryCtx,
  approval: Proposal["unit"]["questApproval"],
): Promise<ProposalPostAnswer> {
  if (approval.state !== "approved" && approval.state !== "declined") {
    return { state: "waiting" };
  }
  const by = personName(
    approval.answeredBy ? await ctx.db.get(approval.answeredBy) : null,
    "A teacher",
  );
  return { state: approval.state, by };
}

async function viewIn(
  ctx: QueryCtx,
  proposal: Proposal,
  channelId: string,
): Promise<ProposalPostView> {
  const { unit, scholar } = proposal;
  const approval = unit.questApproval;
  return {
    unitId: unit._id,
    revision: approval.revision,
    scholarLabel: await labelInChannel(ctx, scholar, channelId),
    scholarWords: approval.scholarWords ?? "",
    mission: unit.mission?.text ?? "",
    kindLine: QUEST_PROPOSAL_KIND_LINE[approval.kind],
    answer: await answerFor(ctx, approval),
  };
}

/** Where a new proposal posts and what it says, or why it doesn't post. */
export const postPlan = internalQuery({
  args: { unitId: v.id("units") },
  handler: async (
    ctx,
    { unitId },
  ): Promise<
    | {
        ok: true;
        scholarId: Id<"users">;
        channelId: string;
        proposedAt: number;
        stamp: string;
        view: ProposalPostView;
      }
    | { ok: false; reason: string; scholarId?: Id<"users">; proposedAt?: number }
  > => {
    const proposal = await loadProposal(ctx, unitId);
    if ("reason" in proposal) return { ok: false, reason: proposal.reason };
    const approval = proposal.unit.questApproval;
    // Past this point the proposal is real, so a retry that must still find
    // an earlier attempt's post has what it needs to map it.
    const who = { scholarId: proposal.scholar._id, proposedAt: approval.proposedAt ?? 0 };
    if (approval.state !== "waiting") {
      return { ok: false, reason: "a teacher answered it before it posted", ...who };
    }
    if (!proposal.unit.isActive) return { ok: false, reason: "the scholar withdrew it", ...who };
    const channel = await classChannelFor(ctx, proposal.scholar, proposal.schoolId);
    if ("reason" in channel) return { ok: false, reason: channel.reason, ...who };
    return {
      ok: true,
      scholarId: proposal.scholar._id,
      channelId: channel.channelId,
      proposedAt: approval.proposedAt ?? 0,
      stamp: proposalStamp(approval),
      view: await viewIn(ctx, proposal, channel.channelId),
    };
  },
});

/**
 * The proposal's posts as they should read now, one per mapped root, and the
 * stamp they show. A root in a channel that is no longer bound to the
 * scholar's school alone is left as it is (`skipped`): the proposal's words
 * go nowhere new.
 */
export const postedViews = internalQuery({
  args: { unitId: v.id("units") },
  handler: async (
    ctx,
    { unitId },
  ): Promise<{
    stamp: string | null;
    posts: { channelId: string; ts: string; view: ProposalPostView }[];
    skipped: number;
  }> => {
    const proposal = await loadProposal(ctx, unitId);
    if ("reason" in proposal) return { stamp: null, posts: [], skipped: 0 };
    // A withdrawn proposal that never got an answer is not shown anywhere.
    if (proposal.unit.questApproval.state === "waiting" && !proposal.unit.isActive) {
      return { stamp: null, posts: [], skipped: 0 };
    }
    const roots = await aboutSlackRootsFor(ctx, proposal.scholar._id, {
      type: "quest",
      unitId,
    });
    const posts: { channelId: string; ts: string; view: ProposalPostView }[] = [];
    let skipped = 0;
    // The Quest's "ready to show" message is mapped as a root of its own when
    // its proposal never posted (questShowingSlack.ts): it is never a proposal.
    const ready = proposal.unit.questApproval.readySlackPost;
    for (const root of roots) {
      if (
        ready &&
        ready.threadTs === undefined &&
        ready.channelId === root.channelId &&
        ready.ts === root.threadTs
      ) {
        continue;
      }
      if ((await channelSchool(ctx, root.channelId)) !== proposal.schoolId) {
        skipped += 1;
        continue;
      }
      posts.push({
        channelId: root.channelId,
        ts: root.threadTs,
        view: await viewIn(ctx, proposal, root.channelId),
      });
    }
    return { stamp: proposalStamp(proposal.unit.questApproval), posts, skipped };
  },
});

/**
 * Asked right before a write to Slack, after the slow calls: the channel is
 * still bound to the scholar's school alone, the scholar is still there, and,
 * for a new post, the proposal is still waiting and not withdrawn.
 */
export const bindingHolds = internalQuery({
  args: { unitId: v.id("units"), channelId: v.string(), newPost: v.boolean() },
  handler: async (ctx, { unitId, channelId, newPost }): Promise<boolean> => {
    const proposal = await loadProposal(ctx, unitId);
    if ("reason" in proposal) return false;
    if (newPost && (proposal.unit.questApproval.state !== "waiting" || !proposal.unit.isActive)) {
      return false;
    }
    return (await channelSchool(ctx, channelId)) === proposal.schoolId;
  },
});

/** The proposal's stamp now (lib/questProposalSlack.ts proposalStamp). */
export const currentStamp = internalQuery({
  args: { unitId: v.id("units") },
  handler: async (ctx, { unitId }): Promise<string | null> => {
    const approval = (await ctx.db.get(unitId))?.questApproval;
    return approval ? proposalStamp(approval) : null;
  },
});

/**
 * Which proposal a tapped message is: the unit, when the message is a root
 * mapped to that very proposal's Quest. Null for anything else, so a button
 * counts only on the proposal's own post.
 */
export const proposalForPost = internalQuery({
  args: { channelId: v.string(), ts: v.string(), unitId: v.string() },
  handler: async (ctx, args): Promise<Id<"units"> | null> => {
    const unitId = ctx.db.normalizeId("units", args.unitId);
    if (!unitId) return null;
    const unit = await ctx.db.get(unitId);
    if (!unit?.questApproval || !unit.authorScholarId) return null;
    const roots = await aboutSlackRootsFor(ctx, unit.authorScholarId, {
      type: "quest",
      unitId,
    });
    return roots.some((root) => root.channelId === args.channelId && root.threadTs === args.ts)
      ? unitId
      : null;
  },
});

/** Slack posts and updates try this many times in all. */
export const MAX_ATTEMPTS = 4;
const RETRY_BASE_MS = 30_000;
const POST_EVENT_TYPE = "rabbithole_quest_proposal";

function deliveryId(unitId: Id<"units">): string {
  return `quest-proposal:${unitId}`;
}

/** A Slack failure another try may get past: a rate limit, Slack's own
 *  trouble, or a lost response. */
export function isTransient(res: {
  error?: string;
  status?: number;
  ambiguous?: boolean;
}): boolean {
  const error = res.error ?? "";
  return (
    res.ambiguous === true ||
    (res.status ?? 0) >= 500 ||
    error === "ratelimited" ||
    error === "internal_error" ||
    error === "fatal_error" ||
    error === "service_unavailable" ||
    error === "request_timeout" ||
    error.startsWith("request_failed:")
  );
}

export function retryDelayMs(attempt: number, retryAfterMs?: number): number {
  return Math.max(retryAfterMs ?? 0, RETRY_BASE_MS * 2 ** attempt);
}

/**
 * Whether this channel may carry a scholar's name and words: not shared, or
 * being shared, with another organization (Slack Connect). Null when Slack
 * can't say, which callers treat as not yet.
 */
export async function channelIsOurs(token: string, channelId: string): Promise<boolean | null> {
  const shape = await fetchConversationShape(token, channelId);
  return shape?.sharingKnown ? !shape.externallyShared : null;
}

/**
 * Post a new proposal to the scholar's class channel and map its thread to
 * the Quest's thread in Messages. Scheduled by the proposal itself, then by
 * its own retries. A retry first looks in the channel for the post an earlier
 * attempt may have made (its delivery metadata), so a post Slack took but
 * whose answer was lost isn't posted twice. Already posted: it hands over to
 * the sync.
 */
export const postProposal = internalAction({
  args: {
    unitId: v.id("units"),
    attempt: v.optional(v.number()),
    /** The channel an earlier attempt posted to, where its post may be. */
    channelId: v.optional(v.string()),
  },
  handler: async (ctx, { unitId, attempt = 0, channelId: carried }): Promise<void> => {
    const token = process.env.SLACK_BOT_TOKEN;
    if (!token) {
      console.log(`${LOG} ${unitId} not posted: Slack isn't configured here`);
      return;
    }
    let posting = carried;
    const retry = async (why: string, retryAfterMs?: number) => {
      if (attempt + 1 >= MAX_ATTEMPTS) {
        console.error(`${LOG} ${unitId} not posted: gave up after ${attempt + 1} attempts (${why})`);
        return;
      }
      console.warn(`${LOG} ${unitId} post will retry: ${why}`);
      await ctx.scheduler.runAfter(
        retryDelayMs(attempt, retryAfterMs),
        internal.questProposalSlack.postProposal,
        { unitId, attempt: attempt + 1, ...(posting ? { channelId: posting } : {}) },
      );
    };
    const plan = await ctx.runQuery(internal.questProposalSlack.postPlan, { unitId });
    const posted = await ctx.runQuery(internal.questProposalSlack.postedViews, { unitId });
    if (posted.posts.length > 0 && posted.stamp) {
      await ctx.scheduler.runAfter(0, internal.questProposalSlack.syncProposalPosts, {
        unitId,
        stamp: posted.stamp,
      });
      return;
    }
    // An earlier attempt's post is still looked for when the proposal has
    // since been answered; it is mapped and brought up to date, never added to.
    const searchIn = carried ?? (plan.ok ? plan.channelId : undefined);
    const canRecover = attempt > 0 && searchIn !== undefined && plan.scholarId !== undefined;
    if (!plan.ok && !canRecover) {
      console.log(`${LOG} ${unitId} not posted: ${plan.reason}`);
      return;
    }
    let ts: string | undefined;
    let channelId = searchIn;
    let recovered = false;
    if (canRecover) {
      const history = await fetchConversationHistory(token, searchIn, {
        oldest: String(Math.floor((plan.proposedAt ?? 0) / 1000) - 60),
      });
      if (!history.ok) return await retry(`history: ${history.error ?? "unknown"}`, history.retryAfterMs);
      ts = messageWithDeliveryMetadata(history.messages, POST_EVENT_TYPE, deliveryId(unitId))?.ts;
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
        console.log(`${LOG} ${unitId} not posted: the class channel is shared with another organization`);
        return;
      }
      const holds = await ctx.runQuery(internal.questProposalSlack.bindingHolds, {
        unitId,
        channelId: plan.channelId,
        newPost: true,
      });
      if (!holds) {
        console.log(`${LOG} ${unitId} not posted: the channel or the proposal changed while it waited`);
        return;
      }
      posting = plan.channelId;
      const sent = await postMessage(token, {
        channel: plan.channelId,
        ...proposalPost(plan.view),
        metadata: { event_type: POST_EVENT_TYPE, event_payload: { delivery_id: deliveryId(unitId) } },
      });
      if (!sent.ok || !sent.ts) {
        const why = sent.error ?? "no ts";
        if (isTransient(sent)) return await retry(why, sent.retryAfterMs);
        console.error(`${LOG} ${unitId} not posted: ${why}`);
        return;
      }
      ts = sent.ts;
      channelId = sent.channel ?? plan.channelId;
    }
    const mapped = await ctx.runMutation(internal.scholarMessages.recordAboutSlackThread, {
      channelId: channelId!,
      threadTs: ts,
      scholarId: plan.scholarId!,
      about: { type: "quest", unitId },
    });
    if (!mapped) {
      console.error(`${LOG} ${unitId}: posted at ${ts} but its thread could not be mapped`);
      return;
    }
    // A fresh post shows the proposal as this attempt read it; an edit or an
    // answer since then found no post to update, so it is handed to the sync.
    // A recovered post says whatever the first attempt wrote, so it always is.
    const now = await ctx.runQuery(internal.questProposalSlack.currentStamp, { unitId });
    if (now && (recovered || (plan.ok && now !== plan.stamp))) {
      await ctx.scheduler.runAfter(0, internal.questProposalSlack.syncProposalPosts, {
        unitId,
        stamp: now,
      });
    }
  },
});

/**
 * Rewrite the proposal's posts to read as it stands: the wording and
 * revision while it waits, or the answer in place of the buttons. Every
 * change to the proposal (an edit, an answer) schedules one, carrying its
 * stamp. A sync whose stamp is no longer current does nothing, because the
 * newer change scheduled its own: that is what folds a burst of edits into
 * one write. After writing, a sync re-reads the stamp; if the proposal changed
 * while the write was in flight, its write may have landed after the newer
 * one, so it schedules one more for the newer stamp. Slack's transient
 * failures are retried with backoff, a few times.
 */
export const syncProposalPosts = internalAction({
  args: { unitId: v.id("units"), stamp: v.string(), attempt: v.optional(v.number()) },
  handler: async (ctx, { unitId, stamp: asked, attempt = 0 }): Promise<void> => {
    const token = process.env.SLACK_BOT_TOKEN;
    if (!token) return;
    const { stamp: current, posts, skipped } = await ctx.runQuery(
      internal.questProposalSlack.postedViews,
      { unitId },
    );
    // A first try with an old stamp does nothing: the newer change scheduled
    // its own. A retry with one writes the latest state, so the last write
    // that lands is always the newest even if an earlier one landed late.
    if (current === null || (current !== asked && attempt === 0)) return;
    const stamp = current;
    if (skipped > 0) {
      console.warn(
        `${LOG} ${unitId}: ${skipped} post(s) left as they were; the channel is no longer the scholar's school's alone`,
      );
    }
    let transient: { why: string; retryAfterMs?: number } | null = null;
    const sharing = new Map<string, boolean | null>();
    for (const post of posts) {
      if (!sharing.has(post.channelId)) {
        sharing.set(post.channelId, await channelIsOurs(token, post.channelId));
      }
      const ours = sharing.get(post.channelId);
      if (ours === null) {
        transient = { why: "couldn't read the channel's sharing" };
        continue;
      }
      if (!ours) {
        console.warn(`${LOG} ${unitId}: post left as it was; its channel is shared with another organization`);
        continue;
      }
      const holds = await ctx.runQuery(internal.questProposalSlack.bindingHolds, {
        unitId,
        channelId: post.channelId,
        newPost: false,
      });
      if (!holds) {
        console.warn(`${LOG} ${unitId}: post left as it was; its channel changed while it waited`);
        continue;
      }
      const res = await updateBlocks(token, {
        channel: post.channelId,
        ts: post.ts,
        ...proposalPost(post.view),
      });
      if (res.ok) continue;
      if (isTransient(res)) {
        transient = { why: res.error ?? "unknown", retryAfterMs: res.retryAfterMs };
      } else {
        console.error(`${LOG} ${unitId}: chat.update failed: ${res.error ?? "unknown"}`);
      }
    }
    if (transient) {
      if (attempt + 1 >= MAX_ATTEMPTS) {
        console.error(
          `${LOG} ${unitId}: post not brought up to date, gave up after ${attempt + 1} attempts (${transient.why})`,
        );
      } else {
        await ctx.scheduler.runAfter(
          retryDelayMs(attempt, transient.retryAfterMs),
          internal.questProposalSlack.syncProposalPosts,
          { unitId, stamp, attempt: attempt + 1 },
        );
      }
      return;
    }
    const after = await ctx.runQuery(internal.questProposalSlack.currentStamp, { unitId });
    if (after && after !== stamp) {
      await ctx.scheduler.runAfter(0, internal.questProposalSlack.syncProposalPosts, {
        unitId,
        stamp: after,
      });
    }
  },
});

const REFUSED_FORBIDDEN =
  "Only a teacher at this scholar's school can answer their proposal, so nothing changed.";
const REFUSED_GONE = "This proposal isn't waiting for an answer anymore, so nothing changed.";
const REFUSED_UNKNOWN = "That didn't go through, so nothing changed. Try again in a moment.";

/**
 * Approve or Not this one, tapped by `clicker` (the Slack user's linked
 * Rabbithole user; slackInteractivity refuses an unlinked one before this).
 * The answer is the mutation's: who may answer, the revision and first answer
 * wins are all checked there. A refusal is said to the teacher alone.
 */
export async function handleQuestProposalButton(
  ctx: ActionCtx,
  p: SlackBlockActionsPayload,
  action: SlackBlockAction,
  clicker: { userId: Id<"users"> },
): Promise<void> {
  const say = (text: string) => respondEphemeral(p.response_url, text);
  const answer =
    action.action_id === QUEST_PROPOSAL_APPROVE
      ? "approve"
      : action.action_id === QUEST_PROPOSAL_DECLINE
        ? "decline"
        : null;
  const loc = messageLocation(p);
  const button = parseProposalButtonValue(action.value);
  if (!answer || !loc || !button) return;
  // Slack retries a click it didn't hear back about: one answer per click.
  const { fresh } = await ctx.runMutation(internal.slackBot.claimEvent, {
    eventId: `qprop:${p.trigger_id ?? action.action_ts ?? ""}:${action.action_id}`,
  });
  if (!fresh) return;
  const unitId = await ctx.runQuery(internal.questProposalSlack.proposalForPost, {
    channelId: loc.channel,
    ts: loc.ts,
    unitId: button.unitId,
  });
  if (!unitId) {
    await say("I can't find that proposal, so nothing changed.");
    return;
  }
  let outcome: { state: string; changed: boolean };
  try {
    outcome = await ctx.runMutation(internal.questProposals.answerProposalForUser, {
      unitId,
      answer,
      approverId: clicker.userId,
      expectedRevision: button.revision,
    });
  } catch (error: unknown) {
    if (error instanceof ConvexError && typeof error.data === "string") {
      // Written to be read: "The proposal changed after you saw it. …"
      await say(error.data);
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("Forbidden")) await say(REFUSED_FORBIDDEN);
    else if (message.includes("not found")) await say(REFUSED_GONE);
    else {
      console.error(`${LOG} ${unitId}: answer failed:`, message);
      await say(REFUSED_UNKNOWN);
    }
    return;
  }
  // The mutation scheduled the post's update. A second tap changes nothing.
  if (!outcome.changed) {
    await say(
      outcome.state === "approved"
        ? "This proposal was already approved, so nothing changed."
        : "A teacher already answered this proposal, so nothing changed.",
    );
  }
}
