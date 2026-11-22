/**
 * Hand automatic work to Claude Tag (Claude in Slack) when no person is in
 * the conversation.
 *
 * Staff code requests already go to Claude by a handoff the requester tags
 * themselves (lib/introspectionTools.ts). Work with no requester waiting in
 * the conversation gets ONE top-level message in a dedicated private channel
 * that mentions Claude directly. Claude Tag answers top-level bot mentions (a
 * live test got a reply within seconds), scopes the work, and opens a draft
 * PR. This replaced GitHub Copilot for:
 *   - the daily Coherence proposal (improvementLoopNotifications.ts), and
 *   - an approved Coherence/Dieter proposal (`dispatch_implementation`), which
 *     used to queue Copilot CLI work on Mini through rh-sessiond.
 * It also carries triaged bug reports and repeated iPad crashes
 * (bugReportHandoff.ts), behind BUG_REPORT_CLAUDE_HANDOFF_ENABLED.
 *
 * The channel is bound with the existing alertChannel mechanism under the
 * "claude-dispatch" role (alerts.claudeDispatchChannelId), never hard-coded.
 * Unbound → a loud console error and a `posted: false` result; nothing posts
 * and nothing falls back to Copilot.
 *
 * Every brief goes through the same redaction guard the Copilot path used
 * (checkBriefRedaction), plus a check against the names of real scholars,
 * because automatic proposals can be built from production data.
 *
 * Idempotency: `claudeDispatches` is reserved in a mutation BEFORE the post,
 * so concurrent runs can't both post. A reservation left unresolved (the
 * action died after Slack accepted the post, or Slack's answer was lost) is
 * reconciled on the next run by reading the channel from the reservation time
 * onward (the immutable `firstAttemptAt`) for our own message metadata.
 *
 * First-party only: Claude Tag lives in the primary institution's one Slack
 * workspace, so this only ever acts for the primary institution.
 */
import { v } from "convex/values";
import {
  internalAction,
  internalMutation,
  internalQuery,
  type ActionCtx,
} from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { ROLES, isStaffRole } from "./lib/roles";
import { checkBriefRedaction } from "./lib/introspectionGuard";
import { sha256Hex } from "./lib/oauthCrypto";
import { primaryInstitutionId } from "./lib/primaryInstitution";
import { CLAUDE_DISPATCH_TARGET } from "./lib/claudeDispatchTarget";
import {
  fetchConversationHistory,
  messageWithDeliveryMetadata,
  postMessage,
  type SlackMessageMetadata,
} from "./lib/slackApi";

/** Claude Tag's Slack member id in the primary institution's workspace. */
export const CLAUDE_TAG_SLACK_USER_ID = "U09V0K5HUF8";

const CLAUDE_DISPATCH_EVENT_TYPE = "rabbithole_claude_dispatch";

/** How long a fresh reservation blocks a concurrent run. A post takes
 * seconds; past this, the reservation is treated as unresolved and the next
 * run reconciles it against the channel. */
export const RESERVATION_LEASE_MS = 5 * 60_000;

/** Slack `ts` values and our clock can disagree a little; read history from
 * slightly before the reservation so our own post is never just outside. */
const RECONCILE_CLOCK_SLACK_MS = 60_000;

export type ClaudeDispatchResult =
  | { posted: true; replayed: boolean; messageTs: string }
  | {
      posted: false;
      reason:
        | "brief_needs_redaction"
        | "invalid_link"
        | "no_claude_dispatch_channel"
        | "slack_not_configured"
        | "in_flight"
        | "slack_error";
      detail?: string;
    };

export function claudeDispatchMetadata(deliveryId: string): SlackMessageMetadata {
  return {
    event_type: CLAUDE_DISPATCH_EVENT_TYPE,
    event_payload: { delivery_id: deliveryId },
  };
}

/** Only our own unguessable proposal render links may ride along. The token
 * would trip the id redaction guard, so the link is checked by shape here
 * instead of going through the brief. */
const PROPOSAL_LINK = /^https?:\/\/[^\s<>|]+\/proposal\/[a-f0-9]{32,}$/;

/**
 * The one message Claude receives. Plain language: who sent it (an automatic
 * Rabbithole job, so there is nobody to ask in the thread), the brief, an
 * optional proposal link, and what we'd like back.
 */
export function buildClaudeDispatchMessage(args: {
  sourceLabel: string;
  brief: string;
  proposalUrl?: string;
}): string {
  return [
    `<@${CLAUDE_TAG_SLACK_USER_ID}> Automatic request from Rabbithole (${args.sourceLabel}). No person is waiting in this thread.`,
    "",
    args.brief.trim(),
    ...(args.proposalUrl ? ["", `Proposal: ${args.proposalUrl}`] : []),
    "",
    `Please scope it in ${CLAUDE_DISPATCH_TARGET.repo} and, if a change is warranted, open a draft PR against master and reply here with the link. If no change is warranted, reply here saying why. ${CLAUDE_DISPATCH_TARGET.reviewer} reviews before anything merges. This brief carries no learner data; don't go looking for any.`,
  ].join("\n");
}

/** Display names of every scholar, for the redaction name check. */
export const scholarNamesForRedaction = internalQuery({
  args: {},
  handler: async (ctx): Promise<string[]> => {
    const scholars = await ctx.db
      .query("users")
      .withIndex("by_role", (q) => q.eq("role", ROLES.SCHOLAR))
      .collect();
    return scholars
      .map((s) => s.name?.trim() ?? "")
      .filter((name) => name.length > 0);
  },
});

type Reservation =
  | { kind: "posted"; messageTs: string }
  | { kind: "in_flight" }
  | { kind: "reserved"; channelId: string; reconcileFrom: number | null };

/**
 * Atomically claim `deliveryId` before posting. A brand-new id is reserved
 * for this run. A fresh reservation held by another run is `in_flight`. An
 * expired one is re-claimed, and the caller must first look in the channel
 * from `reconcileFrom` (the first attempt, never the renewed lease) for a
 * post an earlier attempt may already have made.
 */
export const reserve = internalMutation({
  args: {
    deliveryId: v.string(),
    source: v.string(),
    slackChannelId: v.string(),
  },
  handler: async (ctx, args): Promise<Reservation> => {
    const now = Date.now();
    const row = await ctx.db
      .query("claudeDispatches")
      .withIndex("by_deliveryId", (q) => q.eq("deliveryId", args.deliveryId))
      .first();
    if (!row) {
      await ctx.db.insert("claudeDispatches", {
        deliveryId: args.deliveryId,
        source: args.source,
        slackChannelId: args.slackChannelId,
        state: "reserved",
        firstAttemptAt: now,
        reservedAt: now,
        attempts: 1,
      });
      return { kind: "reserved", channelId: args.slackChannelId, reconcileFrom: null };
    }
    if (row.state === "posted" && row.messageTs) {
      return { kind: "posted", messageTs: row.messageTs };
    }
    if (now - row.reservedAt < RESERVATION_LEASE_MS) return { kind: "in_flight" };
    // Renew the lease only. The search always starts at the FIRST attempt:
    // any earlier attempt may have posted, and a failed reconcile must not
    // move the start forward past it.
    await ctx.db.patch(row._id, { reservedAt: now, attempts: row.attempts + 1 });
    return {
      kind: "reserved",
      channelId: row.slackChannelId,
      reconcileFrom: row.firstAttemptAt,
    };
  },
});

export const markPosted = internalMutation({
  args: { deliveryId: v.string(), messageTs: v.string() },
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("claudeDispatches")
      .withIndex("by_deliveryId", (q) => q.eq("deliveryId", args.deliveryId))
      .first();
    if (!row) throw new Error("claude dispatch reservation is missing");
    if (row.state === "posted") return;
    await ctx.db.patch(row._id, {
      state: "posted",
      messageTs: args.messageTs,
      postedAt: Date.now(),
    });
  },
});

/** Drop a reservation whose post definitely did not land, so the next run
 * posts straight away instead of waiting out the lease. */
export const release = internalMutation({
  args: { deliveryId: v.string() },
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("claudeDispatches")
      .withIndex("by_deliveryId", (q) => q.eq("deliveryId", args.deliveryId))
      .first();
    if (row && row.state === "reserved") await ctx.db.delete(row._id);
  },
});

type DispatchArgs = {
  deliveryId: string;
  source: string;
  sourceLabel: string;
  brief: string;
  proposalUrl?: string;
};

async function runClaudeDispatch(
  ctx: Pick<ActionCtx, "runQuery" | "runMutation">,
  args: DispatchArgs,
): Promise<ClaudeDispatchResult> {
  const knownNames = await ctx.runQuery(
    internal.claudeDispatch.scholarNamesForRedaction,
    {},
  );
  const guard = checkBriefRedaction(args.brief, { knownNames });
  if (!guard.ok) {
    // Don't log the match itself: it may be a real scholar's name.
    console.error(
      `[claudeDispatch] refused ${args.source} dispatch ${args.deliveryId}: brief ${guard.reason}. Nothing was posted.`,
    );
    return { posted: false, reason: "brief_needs_redaction", detail: guard.reason };
  }
  if (args.proposalUrl !== undefined && !PROPOSAL_LINK.test(args.proposalUrl)) {
    console.error(
      `[claudeDispatch] refused ${args.source} dispatch ${args.deliveryId}: the proposal link is not a Rabbithole render link. Nothing was posted.`,
    );
    return { posted: false, reason: "invalid_link" };
  }

  const boundChannel = await ctx.runQuery(
    internal.alerts.claudeDispatchChannelId,
    {},
  );
  if (!boundChannel) {
    console.error(
      `[claudeDispatch] NOT DISPATCHED: no Slack channel is bound to the "claude-dispatch" role, so ${args.source} work ${args.deliveryId} was not handed to Claude. A platform admin binds one by running link_alerts_channel with role "claude-dispatch" in the private Claude channel. There is no Copilot fallback.`,
    );
    return { posted: false, reason: "no_claude_dispatch_channel" };
  }

  const token = process.env.SLACK_BOT_TOKEN;
  if (!token) {
    console.error(
      `[claudeDispatch] NOT DISPATCHED: SLACK_BOT_TOKEN is unset, so ${args.source} work ${args.deliveryId} was not handed to Claude.`,
    );
    return { posted: false, reason: "slack_not_configured" };
  }

  const reservation: Reservation = await ctx.runMutation(
    internal.claudeDispatch.reserve,
    {
      deliveryId: args.deliveryId,
      source: args.source,
      slackChannelId: boundChannel,
    },
  );
  if (reservation.kind === "posted") {
    return { posted: true, replayed: true, messageTs: reservation.messageTs };
  }
  if (reservation.kind === "in_flight") {
    return { posted: false, reason: "in_flight" };
  }

  if (reservation.reconcileFrom !== null) {
    // An earlier attempt reserved this id and never recorded a post. It may
    // have posted anyway; look from the reservation onward, however long ago.
    const oldestMs = reservation.reconcileFrom - RECONCILE_CLOCK_SLACK_MS;
    const history = await fetchConversationHistory(token, reservation.channelId, {
      oldest: String(Math.floor(oldestMs / 1000)),
    });
    if (!history.ok) {
      console.error(
        `[claudeDispatch] NOT DISPATCHED: could not read the claude-dispatch channel to resolve an earlier attempt (${history.error ?? "unknown error"}). It will be retried.`,
      );
      return { posted: false, reason: "slack_error", detail: history.error };
    }
    const prior = messageWithDeliveryMetadata(
      history.messages,
      CLAUDE_DISPATCH_EVENT_TYPE,
      args.deliveryId,
    );
    if (prior?.ts) {
      await ctx.runMutation(internal.claudeDispatch.markPosted, {
        deliveryId: args.deliveryId,
        messageTs: prior.ts,
      });
      return { posted: true, replayed: true, messageTs: prior.ts };
    }
  }

  // Plain `text`, not markdown_text: the `<@U…>` mention is Slack mrkdwn
  // syntax and must reach Slack as a real mention.
  const posted = await postMessage(token, {
    channel: reservation.channelId,
    text: buildClaudeDispatchMessage(args),
    metadata: claudeDispatchMetadata(args.deliveryId),
  });
  if (!posted.ok || !posted.ts) {
    if (!posted.ambiguous) {
      await ctx.runMutation(internal.claudeDispatch.release, {
        deliveryId: args.deliveryId,
      });
    }
    console.error(
      `[claudeDispatch] NOT DISPATCHED: Slack refused the post (${posted.error ?? "no ts returned"})${posted.ambiguous ? "; it may have landed, so the next run reconciles before posting" : ""}.`,
    );
    return { posted: false, reason: "slack_error", detail: posted.error };
  }
  await ctx.runMutation(internal.claudeDispatch.markPosted, {
    deliveryId: args.deliveryId,
    messageTs: posted.ts,
  });
  return { posted: true, replayed: false, messageTs: posted.ts };
}

/**
 * Post one top-level `@Claude` message for an automatic job, at most once per
 * `deliveryId`. Never throws for an expected refusal; the result says why
 * nothing posted, and the refusal is logged with console.error so it shows in
 * the Convex logs.
 */
export const dispatchToClaude = internalAction({
  args: {
    /** Stable, opaque id for this piece of work; the idempotency key. */
    deliveryId: v.string(),
    /** Producer name for the ledger, e.g. "coherence". */
    source: v.string(),
    /** A few words naming the producer in the message. */
    sourceLabel: v.string(),
    /** Plain-language brief. Must carry no learner data. */
    brief: v.string(),
    /** Optional Rabbithole proposal render link. */
    proposalUrl: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<ClaudeDispatchResult> =>
    await runClaudeDispatch(ctx, args),
});

// ── Approved improvement-loop proposals ─────────────────────────────────────

/** Ledger `source` for an approval handoff, distinct from the daily scan's
 * "coherence" so the dispatch cap can count approvals alone. */
export const APPROVAL_SOURCES = ["approval:coherence", "approval:dieter"] as const;
function approvalSource(policy: "coherence" | "dieter") {
  return policy === "dieter" ? APPROVAL_SOURCES[1] : APPROVAL_SOURCES[0];
}

/** Approval handoffs first attempted since `since`, for the shared rolling
 * dispatch cap (lib/introspectionTools.ts preflightIntrospectionDispatch).
 * A reservation counts as soon as it is made, posted or not. */
export const countApprovalHandoffsSince = internalQuery({
  args: { since: v.number() },
  handler: async (ctx, args): Promise<number> => {
    let total = 0;
    for (const source of APPROVAL_SOURCES) {
      const rows = await ctx.db
        .query("claudeDispatches")
        .withIndex("by_source_firstAttemptAt", (q) =>
          q.eq("source", source).gte("firstAttemptAt", args.since),
        )
        .collect();
      total += rows.length;
    }
    return total;
  },
});

export type ApprovedHandoffResult =
  | {
      handedOff: true;
      replayed: boolean;
      messageTs: string;
    }
  | { handedOff: false; reason: string; message: string };

type ApprovalContext =
  | {
      ok: true;
      policy: "coherence" | "dieter";
      summary: string;
    }
  | { ok: false; reason: string; message: string };

/** Re-check, from the database, everything that makes an approval valid:
 * a staff approver, a Coherence/Dieter trace in the PRIMARY institution (the
 * Claude channel belongs to the primary institution), the delivered proposal that trace
 * owns, a trace still open, and no execution already owned by another
 * provider. */
export const approvalContext = internalQuery({
  args: {
    traceId: v.id("improvementTraces"),
    proposalId: v.id("featureProposals"),
    approverUserId: v.id("users"),
  },
  handler: async (ctx, args): Promise<ApprovalContext> => {
    const [trace, proposal, approver, primaryId] = await Promise.all([
      ctx.db.get(args.traceId),
      ctx.db.get(args.proposalId),
      ctx.db.get(args.approverUserId),
      primaryInstitutionId(ctx),
    ]);
    if (!trace || !proposal || !approver) {
      return { ok: false, reason: "not_found", message: "The proposal or its trace no longer exists." };
    }
    if (!isStaffRole(approver.role)) {
      return { ok: false, reason: "not_staff", message: "Only staff can approve an improvement-loop proposal." };
    }
    if (trace.policy !== "coherence" && trace.policy !== "dieter") {
      return { ok: false, reason: "wrong_policy", message: "Only Coherence or Dieter proposals are approved here." };
    }
    if (!primaryId || trace.institutionId !== primaryId) {
      return {
        ok: false,
        reason: "not_primary_institution",
        message: "This proposal belongs to another school, and approved work only goes to Claude for the home school. Nothing was sent.",
      };
    }
    if (proposal.improvementTraceId !== args.traceId) {
      return { ok: false, reason: "trace_mismatch", message: "That proposal doesn't belong to this trace. Nothing was sent." };
    }
    if (proposal.stage !== "proposal" || proposal.status !== "delivered") {
      return { ok: false, reason: "not_delivered", message: "That proposal isn't a delivered proposal yet. Nothing was sent." };
    }
    if (["declined", "executing", "completed"].includes(trace.lifecycle)) {
      return { ok: false, reason: "trace_closed", message: "That proposal is no longer open for approval. Nothing was sent." };
    }
    if (trace.execution && trace.execution.provider !== "claude-tag") {
      return {
        ok: false,
        reason: "other_provider",
        message: "That proposal was already queued through another path (Mini or GitHub). It was not sent again.",
      };
    }
    const summary = proposal.resultSlackSummary?.trim();
    if (!summary) {
      return { ok: false, reason: "missing_summary", message: "That proposal has no result summary to hand over. Nothing was sent." };
    }
    return { ok: true, policy: trace.policy, summary };
  },
});

/** Stamp the trace approved and owned by Claude Tag, once the message is
 * posted (or already was). Idempotent for the same delivery id. */
export const markTraceHandedToClaude = internalMutation({
  args: { traceId: v.id("improvementTraces"), deliveryId: v.string() },
  handler: async (ctx, args) => {
    const trace = await ctx.db.get(args.traceId);
    if (!trace) throw new Error("Improvement trace not found");
    if (trace.execution) {
      if (
        trace.execution.provider !== "claude-tag" ||
        trace.execution.executionId !== args.deliveryId
      ) {
        throw new Error("Execution correlation is immutable once recorded");
      }
      return;
    }
    await ctx.db.patch(args.traceId, {
      lifecycle: "approved",
      execution: { provider: "claude-tag", executionId: args.deliveryId },
      updatedAt: Date.now(),
    });
  },
});

/** The stable delivery id for an approved proposal: one per proposal row,
 * opaque in Slack metadata. */
export async function approvedProposalDeliveryId(
  proposalId: Id<"featureProposals">,
): Promise<string> {
  return `improvement-approval:${await sha256Hex(String(proposalId))}`;
}

export function approvedProposalBrief(
  policy: "coherence" | "dieter",
  summary: string,
): string {
  const label = policy === "dieter" ? "Dieter" : "Coherence";
  return [
    `A staff member approved this ${label} proposal in Rabbithole's improvement-loop thread. Implement what the proposal describes as a draft PR, following its gate (the inventory, verdict and primitive budget it records).`,
    `Summary: ${summary}`,
  ].join("\n\n");
}

/**
 * Hand an approved Coherence/Dieter proposal to Claude. The staff member's
 * explicit `dispatch_implementation` call in the proposal thread is the
 * approval; this re-checks it against the database, posts once, and records
 * Claude Tag as the trace's execution.
 */
export const handOffApprovedProposal = internalAction({
  args: {
    traceId: v.id("improvementTraces"),
    proposalId: v.id("featureProposals"),
    approverUserId: v.id("users"),
    proposalUrl: v.string(),
  },
  handler: async (ctx, args): Promise<ApprovedHandoffResult> => {
    const context: ApprovalContext = await ctx.runQuery(
      internal.claudeDispatch.approvalContext,
      {
        traceId: args.traceId,
        proposalId: args.proposalId,
        approverUserId: args.approverUserId,
      },
    );
    if (!context.ok) {
      return { handedOff: false, reason: context.reason, message: context.message };
    }
    const deliveryId = await approvedProposalDeliveryId(args.proposalId);
    const result = await runClaudeDispatch(ctx, {
      deliveryId,
      source: approvalSource(context.policy),
      sourceLabel: `approved ${context.policy === "dieter" ? "Dieter" : "Coherence"} proposal`,
      brief: approvedProposalBrief(context.policy, context.summary),
      proposalUrl: args.proposalUrl,
    });
    if (!result.posted) {
      const message =
        result.reason === "no_claude_dispatch_channel"
          ? "Approved, but nothing was sent: no Claude channel is bound yet. A platform admin needs to bind one (link_alerts_channel with role claude-dispatch); approve again after that."
          : result.reason === "in_flight"
            ? "Another approval of this proposal is being handed to Claude right now."
            : result.reason === "brief_needs_redaction"
              ? "Nothing was sent: the proposal summary failed the privacy check."
              : result.reason === "invalid_link"
                ? "Nothing was sent: the proposal link isn't a Rabbithole proposal link."
              : "Nothing was sent: Slack didn't accept the message. Try approving again in a few minutes.";
      return { handedOff: false, reason: result.reason, message };
    }
    await ctx.runMutation(internal.claudeDispatch.markTraceHandedToClaude, {
      traceId: args.traceId,
      deliveryId,
    });
    return { handedOff: true, replayed: result.replayed, messageTs: result.messageTs };
  },
});
