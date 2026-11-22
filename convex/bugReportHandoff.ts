/**
 * Hand triaged bug reports to Claude Tag (Claude in Slack) to fix, with no
 * person relaying them.
 *
 * Runs as the last step of the bug-report pipeline (bugReports.processReport),
 * after the triage note is in the report's thread in the private triage
 * channel. It posts through claudeDispatch.dispatchToClaude, so the brief goes
 * through the same redaction guard and the same reserve-before-post ledger
 * (`claudeDispatches`) as every other automatic Claude request.
 *
 * Which reports go:
 *   - Automatic iPad reports (js_crash / unclean_exit / stall) are keyed by a
 *     crash signature (lib/bugReportSignature.ts). A signature dispatches once
 *     CRASH_DISPATCH_THRESHOLD different first-party accounts have reported
 *     it, and then at most once
 *     while that dispatch is open (REDISPATCH_AFTER_MS). A later report with
 *     the signature only gets a line in its own triage thread pointing at the
 *     open request. Never during a flood of its trigger (the same cap
 *     bugReports.submit uses to stop filing).
 *   - Staff reports (a teacher or staff member used the report gesture)
 *     dispatch once each, after triage. Scholar and parent reports don't:
 *     their words stay with staff.
 *
 * Closing the loop reuses the existing merged note (lib/claudePrThreadNote.ts):
 * Claude Tag's PR links the thread it was asked in, which is the dispatch
 * message, so the "merged" note lands there; the triage thread links to that
 * message.
 *
 * The brief carries no client-supplied free text (lib/bugReportSignature.ts
 * buildBugReportBrief): a server-defined symptom category, a route template,
 * strictly shaped device fields, a count and the triage-thread link. The
 * error message, the triage note and the reporter's words stay in the
 * private triage thread.
 *
 * Only reports marked pending get here: bugReports.commitTriaged writes
 * `claudeHandoff: { outcome: "pending" }` with the triage commit, and only
 * while the flag is on, so nothing triaged before enablement is handed over.
 * Durable: its own 15-minute cron re-drives a small batch of pending
 * handoffs whose last attempt is stale (sweepPendingHandoffs below).
 *
 * Kill switch: BUG_REPORT_CLAUDE_HANDOFF_ENABLED must be "true". Off, nothing
 * here reads, writes or posts, and submit stores no signature.
 *
 * First-party only: Claude Tag lives in the primary institution's one Slack
 * workspace, so a report is handed over only when it belongs to the primary
 * institution.
 */
import { v } from "convex/values";
import {
  internalAction,
  internalMutation,
  internalQuery,
  type QueryCtx,
} from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { isPlatformAdminRole, isStaffRole, type Role } from "./lib/roles";
import { primaryInstitutionId } from "./lib/primaryInstitution";
import { hasActiveStaffMembershipAtInstitution } from "./lib/staffCapabilities";
import { sha256Hex } from "./lib/oauthCrypto";
import { getMessagePermalink, postMessage } from "./lib/slackApi";
import { greyLineMessage, type SlackPart } from "./lib/slackGreyLine";
import {
  buildBugReportBrief,
  bugReportHandoffEnabled,
  crashDeliveryGeneration,
  crashDeliveryId,
  crashDispatchPlan,
  CRASH_DELIVERY_PREFIX,
  HANDOFF_RETRY_DELAYS_MS,
  HANDOFF_SWEEP_AFTER_MS,
  HANDOFF_SWEEP_BATCH,
  HANDOFF_SWEEP_MAX_AGE_MS,
  meetsThreshold,
  OCCURRENCE_LOOKBACK_MS,
  type LatestSignatureDispatch,
} from "./lib/bugReportSignature";
import { AUTO_REPORT_FLEET_CAP, AUTO_REPORT_WINDOW_MS } from "./bugReports";
import type { ClaudeDispatchResult } from "./claudeDispatch";

/** Ledger `source` values in claudeDispatches. */
export const BUG_REPORT_SOURCES = {
  crash: "bug-report:crash",
  staff: "bug-report:staff",
} as const;

/**
 * Reports read, newest first, to count one signature's distinct first-party
 * reporters. Counting stops as soon as the threshold is met; hitting this cap
 * first leaves the count undecided (never "below threshold").
 */
export const MAX_OCCURRENCE_SCAN = 200;

type Handoff = NonNullable<Doc<"bugReports">["claudeHandoff"]>;

type HandoffContext = {
  report: Doc<"bugReports">;
  firstParty: boolean;
  staffReporter: boolean;
  flood: boolean;
  /** Automatic reports with a signature only. */
  crash: null | (
    | { kind: "already_with_claude"; slackChannelId: string; messageTs: string }
    | {
        kind: "count";
        generation: number;
        /** First-party reports counted (a lower bound: counting stops early). */
        occurrences: number;
        distinctReporters: number;
        /** False when the scan cap was hit before the threshold was met. */
        decided: boolean;
      }
  );
};

/**
 * Does a report belong to the primary institution? The scholar's school when
 * the report has one; else the school of the scholar being viewed (view-as or
 * inspect), so a platform admin looking at another school's scholar is not
 * first-party; else the reporter's own standing (a primary staff membership,
 * or a platform operator reporting on their own view).
 */
async function reportIsFirstParty(
  ctx: QueryCtx,
  report: Doc<"bugReports">,
  primaryId: Id<"institutions">,
): Promise<boolean> {
  if (report.institutionId) return report.institutionId === primaryId;
  if (report.viewedUserId) {
    const viewed = await ctx.db.get(report.viewedUserId);
    return viewed?.institutionId === primaryId;
  }
  const actor = await ctx.db.get(report.actorUserId);
  if (!actor) return false;
  return (
    isPlatformAdminRole(actor.role as Role | undefined) ||
    (await hasActiveStaffMembershipAtInstitution(ctx, actor._id, primaryId))
  );
}

async function latestSignatureDispatch(
  ctx: Pick<QueryCtx, "db">,
  signature: string,
): Promise<LatestSignatureDispatch | null> {
  const prefix = `${CRASH_DELIVERY_PREFIX}${signature}:`;
  const rows = await ctx.db
    .query("claudeDispatches")
    .withIndex("by_deliveryId", (q) =>
      q.gte("deliveryId", prefix).lt("deliveryId", `${prefix}\uffff`),
    )
    .collect();
  let latest: LatestSignatureDispatch | null = null;
  for (const row of rows) {
    const generation = crashDeliveryGeneration(row.deliveryId);
    if (generation === null) continue;
    if (!latest || generation > latest.generation) {
      latest = {
        generation,
        state: row.state,
        postedAt: row.postedAt,
        messageTs: row.messageTs,
        slackChannelId: row.slackChannelId,
      };
    }
  }
  return latest;
}

/** Everything the handoff decides on, read in one transaction. `now` is an
 * argument (not Date.now()) so this internal query stays clock-free. */
export const handoffContext = internalQuery({
  args: { reportId: v.id("bugReports"), now: v.number() },
  handler: async (ctx, args): Promise<HandoffContext | null> => {
    const report = await ctx.db.get(args.reportId);
    if (!report) return null;
    const primaryId = await primaryInstitutionId(ctx);
    const firstParty = primaryId
      ? await reportIsFirstParty(ctx, report, primaryId)
      : false;

    let flood = false;
    let crash: HandoffContext["crash"] = null;
    if (report.trigger) {
      const trigger = report.trigger;
      const fleet = await ctx.db
        .query("bugReports")
        .withIndex("by_trigger", (q) =>
          q.eq("trigger", trigger).gt("_creationTime", args.now - AUTO_REPORT_WINDOW_MS),
        )
        .filter((q) => q.neq(q.field("status"), "resolved"))
        .take(AUTO_REPORT_FLEET_CAP);
      flood = fleet.length >= AUTO_REPORT_FLEET_CAP;

      if (report.signature && primaryId) {
        const signature = report.signature;
        const plan = crashDispatchPlan(
          await latestSignatureDispatch(ctx, signature),
          args.now,
        );
        if (plan.kind === "already_with_claude") {
          crash = plan;
        } else {
          // Newest first within the counting window (since the last dispatch
          // for this signature, else the lookback), stopping as soon as
          // enough DIFFERENT first-party accounts have reported it. Only
          // first-party reports count, and one client resubmitting is one
          // reporter. A scan that hits its cap first decides nothing.
          const windowStart = plan.countSince ?? args.now - OCCURRENCE_LOOKBACK_MS;
          const reporters = new Set<string>();
          const firstPartyBy = new Map<string, boolean>();
          let occurrences = 0;
          let scanned = 0;
          let decided = true;
          for await (const row of ctx.db
            .query("bugReports")
            .withIndex("by_signature", (q) =>
              q.eq("signature", signature).gt("_creationTime", windowStart),
            )
            .order("desc")) {
            scanned += 1;
            const key = row.institutionId
              ? `i:${row.institutionId}`
              : row.viewedUserId
                ? `v:${row.viewedUserId}`
                : `a:${row.actorUserId}`;
            let eligible = firstPartyBy.get(key);
            if (eligible === undefined) {
              eligible = await reportIsFirstParty(ctx, row, primaryId);
              firstPartyBy.set(key, eligible);
            }
            if (eligible) {
              occurrences += 1;
              reporters.add(row.actorUserId);
              if (meetsThreshold(reporters.size)) break;
            }
            if (scanned >= MAX_OCCURRENCE_SCAN) {
              decided = false;
              break;
            }
          }
          crash = {
            kind: "count",
            generation: plan.generation,
            occurrences,
            distinctReporters: reporters.size,
            decided,
          };
        }
      }
    }

    return {
      report,
      firstParty,
      staffReporter:
        !report.trigger && isStaffRole(report.actorRole as Role | undefined),
      flood,
      crash,
    };
  },
});

/** Is this report's Claude handoff pending? The pipeline's one handoff read. */
export const isHandoffPending = internalQuery({
  args: { reportId: v.id("bugReports") },
  handler: async (ctx, args): Promise<boolean> => {
    const report = await ctx.db.get(args.reportId);
    return report?.claudeHandoff?.outcome === "pending";
  },
});

/**
 * Re-drive pending handoffs whose last attempt is older than the whole retry
 * chain (the action died, or never reached the handoff). Its own cron and
 * transaction, separate from bugReports.sweepStuckReports, so it can never
 * roll that sweep back. Bounded: one indexed read of at most
 * HANDOFF_SWEEP_BATCH rows, oldest attempt first; each is scheduled (never
 * run inline) on a fresh retry chain and its attempt time re-stamped so the
 * next run waits again. One pending past HANDOFF_SWEEP_MAX_AGE_MS is marked
 * for a person. A no-op while the flag is off.
 */
export const sweepPendingHandoffs = internalMutation({
  args: {},
  handler: async (ctx): Promise<{ redriven: number; expired: number }> => {
    if (!bugReportHandoffEnabled()) return { redriven: 0, expired: 0 };
    const now = Date.now();
    const due = await ctx.db
      .query("bugReports")
      .withIndex("by_claude_handoff", (q) =>
        q
          .eq("claudeHandoff.outcome", "pending")
          .lt("claudeHandoff.at", now - HANDOFF_SWEEP_AFTER_MS),
      )
      .take(HANDOFF_SWEEP_BATCH);
    let redriven = 0;
    let expired = 0;
    for (const report of due) {
      const handoff = report.claudeHandoff!;
      const since = handoff.since ?? handoff.at;
      if (now - since > HANDOFF_SWEEP_MAX_AGE_MS) {
        await ctx.db.patch(report._id, {
          claudeHandoff: { outcome: "needs_person", at: now, detail: "expired" },
        });
        expired += 1;
        continue;
      }
      await ctx.db.patch(report._id, { claudeHandoff: { ...handoff, at: now } });
      await ctx.scheduler.runAfter(0, internal.bugReportHandoff.handOffToClaude, {
        reportId: report._id,
      });
      redriven += 1;
    }
    return { redriven, expired };
  },
});

export const dispatchChannel = internalQuery({
  args: { deliveryId: v.string() },
  handler: async (ctx, args): Promise<string | null> => {
    const row = await ctx.db
      .query("claudeDispatches")
      .withIndex("by_deliveryId", (q) => q.eq("deliveryId", args.deliveryId))
      .first();
    return row?.slackChannelId ?? null;
  },
});

/** Resolve a pending handoff to its outcome, once. Returns false when it is
 * not pending (never marked, or another run resolved it), so only the winner
 * posts the thread line. */
export const recordHandoff = internalMutation({
  args: {
    reportId: v.id("bugReports"),
    outcome: v.union(
      v.literal("dispatched"),
      v.literal("already_with_claude"),
      v.literal("needs_person"),
      v.literal("skipped"),
    ),
    deliveryId: v.optional(v.string()),
    detail: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<boolean> => {
    const report = await ctx.db.get(args.reportId);
    if (!report || report.claudeHandoff?.outcome !== "pending") return false;
    const handoff: Handoff = {
      outcome: args.outcome,
      at: Date.now(),
      ...(args.deliveryId ? { deliveryId: args.deliveryId } : {}),
      ...(args.detail ? { detail: args.detail } : {}),
    };
    await ctx.db.patch(args.reportId, { claudeHandoff: handoff });
    return true;
  },
});

export type HandoffResult =
  | {
      outcome:
        | "disabled"
        | "missing"
        | "not_pending"
        | "already_recorded"
        | "not_triaged"
        | "retrying"
        | "lost_race";
    }
  | { outcome: Handoff["outcome"]; detail?: string };

function link(url: string | null, label: string): string {
  return url ? `[${label}](${url})` : label;
}

/** The triage-thread pointer when the crash is already Claude's: the receipt goes grey. */
function alreadyWithClaudeLine(requestLink: string | null): SlackPart[] {
  return [
    `🤖 Already with Claude: ${link(requestLink, "the open request")} covers this crash.`,
    { grey: "No new request was sent." },
  ];
}

/**
 * Hand one triaged report to Claude, or note why not. Idempotent: the outcome
 * is written once, and the Claude post is keyed by a stable delivery id.
 */
export const handOffToClaude = internalAction({
  args: { reportId: v.id("bugReports"), attempt: v.optional(v.number()) },
  handler: async (ctx, args): Promise<HandoffResult> => {
    if (!bugReportHandoffEnabled()) return { outcome: "disabled" };
    const context: HandoffContext | null = await ctx.runQuery(
      internal.bugReportHandoff.handoffContext,
      { reportId: args.reportId, now: Date.now() },
    );
    if (!context) return { outcome: "missing" };
    const { report } = context;
    // Only a report marked pending with its triage commit while the flag was
    // on is ever handed over: one triaged before enablement never is.
    if (!report.claudeHandoff) return { outcome: "not_pending" };
    if (report.claudeHandoff.outcome !== "pending") {
      return { outcome: "already_recorded" };
    }
    if (!report.triagedAt || !report.slackChannelId || !report.slackThreadTs) {
      return { outcome: "not_triaged" };
    }
    const triageChannel = report.slackChannelId;
    const triageThreadTs = report.slackThreadTs;
    const token = process.env.SLACK_BOT_TOKEN;

    const record = async (
      outcome: Exclude<Handoff["outcome"], "pending">,
      // A line in parts carries an aside for Slack's grey context line.
      extra: { deliveryId?: string; detail?: string; threadLine?: string | SlackPart[] } = {},
    ): Promise<HandoffResult> => {
      const won: boolean = await ctx.runMutation(
        internal.bugReportHandoff.recordHandoff,
        {
          reportId: args.reportId,
          outcome,
          deliveryId: extra.deliveryId,
          detail: extra.detail,
        },
      );
      if (!won) return { outcome: "lost_race" };
      if (extra.threadLine && token) {
        const posted = await postMessage(token, {
          channel: triageChannel,
          threadTs: triageThreadTs,
          ...(typeof extra.threadLine === "string"
            ? { text: extra.threadLine, markdown: true }
            : greyLineMessage(extra.threadLine, { markdown: true })),
        });
        if (!posted.ok) {
          console.error(
            `[bugReportHandoff] report ${args.reportId}: the ${outcome} line didn't post to its triage thread (${posted.error ?? "unknown error"}).`,
          );
        }
      }
      return { outcome, detail: extra.detail };
    };

    if (!context.firstParty) {
      return await record("skipped", { detail: "not_primary_institution" });
    }

    let deliveryId: string;
    let source: string;
    let sourceLabel: string;
    let occurrences: number | undefined;
    if (report.trigger) {
      if (!report.signature || !context.crash) {
        return await record("skipped", { detail: "no_signature" });
      }
      // Never during a flood: the flood alert already has a person's
      // attention, and one regression must not fan out into requests.
      if (context.flood) return await record("skipped", { detail: "flood" });
      const crash = context.crash;
      if (crash.kind === "already_with_claude") {
        const requestLink = token
          ? await getMessagePermalink(token, crash.slackChannelId, crash.messageTs)
          : null;
        return await record("already_with_claude", {
          threadLine: alreadyWithClaudeLine(requestLink),
        });
      }
      if (!crash.decided) {
        console.warn(
          `[bugReportHandoff] report ${args.reportId}: counting its signature's reporters hit the scan cap before deciding. It needs a person.`,
        );
        return await record("needs_person", {
          detail: "count_undecided",
          threadLine:
            "🙋 Not handed to Claude: couldn't confirm how many accounts have reported this crash. This one needs a person.",
        });
      }
      if (!meetsThreshold(crash.distinctReporters)) {
        return await record("skipped", { detail: "below_threshold" });
      }
      deliveryId = crashDeliveryId(report.signature, crash.generation);
      source = BUG_REPORT_SOURCES.crash;
      sourceLabel = "repeated iPad crash report";
      occurrences = crash.occurrences;
    } else if (context.staffReporter) {
      deliveryId = `bug-report:${await sha256Hex(String(report._id))}`;
      source = BUG_REPORT_SOURCES.staff;
      sourceLabel = "staff bug report";
    } else {
      return await record("skipped", { detail: "not_staff_report" });
    }
    const triageThreadLink = token
      ? await getMessagePermalink(token, triageChannel, triageThreadTs)
      : null;
    const brief = buildBugReportBrief({
      trigger: report.trigger,
      surface: report.surface,
      url: report.url,
      description: report.description,
      deviceModel: report.deviceModel,
      osVersion: report.osVersion,
      appVersion: report.appVersion,
      appBuild: report.appBuild,
      occurrences,
      triageThreadLink,
    });

    const result: ClaudeDispatchResult = await ctx.runAction(
      internal.claudeDispatch.dispatchToClaude,
      { deliveryId, source, sourceLabel, brief },
    );

    if (result.posted) {
      const channel = await ctx.runQuery(internal.bugReportHandoff.dispatchChannel, {
        deliveryId,
      });
      const requestLink =
        token && channel
          ? await getMessagePermalink(token, channel, result.messageTs)
          : null;
      // A replay means another report's run posted this signature's request.
      if (result.replayed && report.trigger) {
        return await record("already_with_claude", {
          deliveryId,
          threadLine: alreadyWithClaudeLine(requestLink),
        });
      }
      return await record("dispatched", {
        deliveryId,
        threadLine: [
          `🤖 Handed to Claude to fix: ${link(requestLink, "the request")}.`,
          { grey: "Claude replies there with a draft PR, and a note follows there when it merges." },
        ],
      });
    }

    switch (result.reason) {
      case "brief_needs_redaction":
        // The guard already logged why (never the match itself).
        console.error(
          `[bugReportHandoff] report ${args.reportId} was not handed to Claude: its brief failed the privacy check. It needs a person.`,
        );
        return await record("needs_person", {
          deliveryId,
          detail: "brief_needs_redaction",
          threadLine:
            "🙋 Not handed to Claude: the brief failed the privacy check (it may name a person, or carry a record id or a count of students). This one needs a person.",
        });
      case "in_flight":
      case "slack_error": {
        const attempt = args.attempt ?? 0;
        if (attempt < HANDOFF_RETRY_DELAYS_MS.length) {
          await ctx.scheduler.runAfter(
            HANDOFF_RETRY_DELAYS_MS[attempt],
            internal.bugReportHandoff.handOffToClaude,
            { reportId: args.reportId, attempt: attempt + 1 },
          );
          return { outcome: "retrying" };
        }
        console.error(
          `[bugReportHandoff] report ${args.reportId} was not handed to Claude after ${attempt + 1} tries (${result.reason}). It needs a person.`,
        );
        return await record("needs_person", {
          deliveryId,
          detail: result.reason,
          threadLine:
            "🙋 Not handed to Claude: Slack didn't take the request after several tries. This one needs a person.",
        });
      }
      default:
        // Unbound Claude channel, no Slack token, bad link: configuration,
        // already logged loudly by dispatchToClaude.
        return await record("skipped", { deliveryId, detail: result.reason });
    }
  },
});
