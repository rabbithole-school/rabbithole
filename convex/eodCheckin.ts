import { v } from "convex/values";
import {
  internalAction,
  internalMutation,
  internalQuery,
} from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import {
  hasAnyActivity,
  checkinDateLabel,
  checkinDayKey,
  checkinDayStartMs,
  isCheckinWeekend,
  parentMessageText,
  renderMechanicalFallback,
  renderThreadMessage,
  sanitizeEodSlackText,
  type EodChannelInput,
  type EodScheduledActivity,
  type EodScholarDay,
  rankEodSignals,
} from "./lib/eodCheckin";
import {
  scholarPath,
  scholarSlug,
  sessionPath,
  siteUrl,
  withBase,
} from "./lib/channels";
import { effectiveInstitutionTimeZone } from "./lib/institutionTime";
import {
  escapeSlackText,
  fetchConversationHistory,
  fetchConversationReplies,
  messageWithDeliveryMetadata,
  postMessage,
  type SlackMessageMetadata,
} from "./lib/slackApi";
import { suspendedInstitutionIds } from "./lib/access";
import { scholarInstitutionId as resolveScholarInstitutionId } from "./lib/scholarEnrollment";

const LIST_LIMIT = 20;
const READ_LIMIT = 100;
const SNIPPET_CHARS = 240;
// Andy's 2026-08-03 ruling: an unfinalized claim is reclaimable after 2 hours.
const CHECKIN_CLAIM_STALE_MS = 2 * 60 * 60 * 1000;
const RETRY_SWEEP_LIMIT = 20;
const MAX_RETRY_ATTEMPTS = 5;
const RETRY_BASE_MS = 5 * 60 * 1000;
const EOD_MESSAGE_EVENT_TYPE = "rabbithole_eod_checkin";

function deliveryId(checkinId: Id<"eodCheckins">, part: "parent" | "reply") {
  return `eod:${checkinId}:${part}`;
}

function deliveryMetadata(
  checkinId: Id<"eodCheckins">,
  part: "parent" | "reply",
): SlackMessageMetadata {
  return {
    event_type: EOD_MESSAGE_EVENT_TYPE,
    event_payload: { delivery_id: deliveryId(checkinId, part) },
  };
}

function retryDelayMs(attempt: number, retryAfterMs?: number): number {
  const backoff = Math.min(RETRY_BASE_MS * 2 ** Math.max(0, attempt - 1), 60 * 60 * 1000);
  return Math.max(backoff, retryAfterMs ?? 0);
}

function snippet(value: string): string {
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length <= SNIPPET_CHARS
    ? compact
    : `${compact.slice(0, SNIPPET_CHARS - 1)}…`;
}

function analysisNote(analysis: Doc<"analyses">): string | null {
  const parts: string[] = [];
  if (analysis.summary) parts.push(snippet(analysis.summary));
  if (analysis.learningIndicators?.length) {
    parts.push(`Learning: ${analysis.learningIndicators.join(", ")}`);
  }
  if (analysis.concernFlags?.length) {
    parts.push(`Concern flags: ${analysis.concernFlags.join(", ")}`);
  }
  if (analysis.suggestedIntervention) {
    parts.push(`Suggested next step: ${snippet(analysis.suggestedIntervention)}`);
  }
  return parts.length > 0 ? snippet(parts.join(" | ")) : null;
}

export const linkedGroups = internalQuery({
  args: {},
  handler: async (ctx) => {
    // Suspended institutions get NO autonomous EOD check-in post — this is the
    // one scheduled, school-facing job that enumerates a school's groups without
    // any scholar action to trigger it, so it needs an explicit skip. (Reactive
    // background work — observer runs, Slack notifications, digest generation —
    // is already suppressed because its originating user actions throw at the
    // requireUser suspension chokepoint; see convex/lib/access.ts.)
    const suspended = await suspendedInstitutionIds(ctx);
    const groups = await ctx.db.query("scholarGroups").collect();
    return groups.filter(
      (group): group is typeof group & { slackChannelId: string } =>
        Boolean(group.slackChannelId) &&
        !(group.institutionId !== undefined && suspended.has(group.institutionId)),
    );
  },
});

/**
 * The IANA timezone the end-of-day boundaries + date label should use for a
 * channel, resolved from its (single) institution. A missing/absent institution
 * → Pacific/Honolulu, so the primary channel's "today" window stays exactly
 * what the old fixed-HST math produced.
 */
export const institutionTimeZone = internalQuery({
  args: { institutionId: v.union(v.id("institutions"), v.null()) },
  handler: async (ctx, { institutionId }) => {
    const institution = institutionId ? await ctx.db.get(institutionId) : null;
    return effectiveInstitutionTimeZone(institution?.timeZone);
  },
});

export const collectChannelDay = internalQuery({
  args: {
    groupIds: v.array(v.id("scholarGroups")),
    dayStartMs: v.number(),
    nowMs: v.number(),
  },
  handler: async (
    ctx,
    args,
  ): Promise<Omit<EodChannelInput, "dateLabel">> => {
    const loadedGroups = (
      await Promise.all(args.groupIds.map((groupId) => ctx.db.get(groupId)))
    ).filter((group): group is Doc<"scholarGroups"> => group !== null);
    const groups = (
      await Promise.all(
        loadedGroups.map(async (group) => {
          if (!group.institutionId) return null;
          const institutions = await Promise.all(
            group.scholarIds.map((scholarId) =>
              resolveScholarInstitutionId(ctx, scholarId),
            ),
          );
          return institutions.every(
            (institutionId) => institutionId === group.institutionId,
          )
            ? group
            : null;
        }),
      )
    ).filter((group): group is Doc<"scholarGroups"> => group !== null);
    const institutionId = groups[0]?.institutionId;
    const tenantGroups = groups.filter(
      (group) => group.institutionId === institutionId,
    );
    const eligibleScholarIds = tenantGroups.flatMap((group) => group.scholarIds);
    const scholarIds = Array.from(
      new Map(
        eligibleScholarIds.map((scholarId) => [String(scholarId), scholarId]),
      ).values(),
    );

    const unitTitleCache = new Map<string, string | null>();
    const activityTitleCache = new Map<string, string>();
    const activityTitle = async (
      activityId: Id<"activities">,
    ): Promise<string> => {
      const key = String(activityId);
      const cached = activityTitleCache.get(key);
      if (cached !== undefined) return cached;
      const activity = await ctx.db.get(activityId);
      const title = activity?.title ?? "Untitled activity";
      activityTitleCache.set(key, title);
      return title;
    };

    const completionsByScholar = new Map<
      string,
      Array<Doc<"activityCompletions">>
    >();
    const scholarNameById = new Map<string, string>();
    const scholarUrlById = new Map<string, string>();
    const scholars: EodScholarDay[] = [];
    for (const scholarId of scholarIds) {
      const scholar = await ctx.db.get(scholarId);
      if (!scholar) continue;

      const sessions = await ctx.db
        .query("sessions")
        .withIndex("by_user_last_message", (q) =>
          q
            .eq("userId", scholarId)
            .gte("lastMessageAt", args.dayStartMs),
        )
        .order("desc")
        .take(LIST_LIMIT);
      const sessionRows: EodScholarDay["sessions"] = [];
      const analysesNotes: string[] = [];
      for (const session of sessions) {
        let unitTitle: string | null = null;
        if (session.unitId) {
          const key = String(session.unitId);
          if (unitTitleCache.has(key)) {
            unitTitle = unitTitleCache.get(key) ?? null;
          } else {
            const unit = await ctx.db.get(session.unitId);
            unitTitle = unit?.title ?? null;
            unitTitleCache.set(key, unitTitle);
          }
        }
        sessionRows.push({ title: session.title, unitTitle });

        if (analysesNotes.length < LIST_LIMIT) {
          const analyses = await ctx.db
            .query("analyses")
            .withIndex("by_session", (q) => q.eq("sessionId", session._id))
            .order("desc")
            .take(READ_LIMIT);
          for (const analysis of analyses) {
            if (
              analysis._creationTime < args.dayStartMs ||
              analysis._creationTime > args.nowMs
            ) {
              continue;
            }
            const note = analysisNote(analysis);
            if (note) analysesNotes.push(note);
            if (analysesNotes.length === LIST_LIMIT) break;
          }
        }
      }

      // by_scholar_completedAt exists for exactly this daily-recap read —
      // range-scan the day instead of hoping today's rows are among the
      // newest-by-creation.
      const completionRows = (
        await ctx.db
          .query("activityCompletions")
          .withIndex("by_scholar_completedAt", (q) =>
            q.eq("scholarId", scholarId).gte("completedAt", args.dayStartMs),
          )
          .order("desc")
          .take(READ_LIMIT)
      )
        .filter((row) => row.completedAt <= args.nowMs)
        .slice(0, LIST_LIMIT);
      completionsByScholar.set(String(scholarId), completionRows);
      const completions = await Promise.all(
        completionRows.map(async (row) => ({
          activityTitle: await activityTitle(row.activityId),
        })),
      );

      const deliverables = (
        await ctx.db
          .query("deliverables")
          .withIndex("by_scholar", (q) => q.eq("scholarId", scholarId))
          .order("desc")
          .take(READ_LIMIT)
      )
        .filter(
          (row) =>
            row.submittedAt >= args.dayStartMs &&
            row.submittedAt <= args.nowMs,
        )
        .slice(0, LIST_LIMIT);

      const practice = (
        await ctx.db
          .query("practiceAttempts")
          .withIndex("by_scholar", (q) => q.eq("scholarId", scholarId))
          // Exclude retry rows in the query, BEFORE the bounded `.take`: they are
          // the newest rows on this index, so a JS-side exclusion after `.take`
          // would let a heavy-retry day evict that day's genuine graded attempts
          // from the fetched page and UNDER-count. Only the day-window predicate
          // stays in JS below.
          .filter((q) => q.neq(q.field("retry"), true))
          .order("desc")
          .take(READ_LIMIT)
      )
        .filter(
          (row) =>
            row.createdAt != null &&
            row.createdAt >= args.dayStartMs &&
            row.createdAt <= args.nowMs,
        )
        .slice(0, LIST_LIMIT);

      const observations = (
        await ctx.db
          .query("observations")
          .withIndex("by_scholar", (q) => q.eq("scholarId", scholarId))
          .order("desc")
          .take(READ_LIMIT)
      )
        .filter(
          (row) =>
            row._creationTime >= args.dayStartMs &&
            row._creationTime <= args.nowMs &&
            row.category === undefined &&
            row.type !== "note",
        )
        .slice(0, LIST_LIMIT)
        .map((row) => ({ kind: row.type, text: snippet(row.note) }));

      const signalCandidates = (
        await ctx.db
          .query("sessionSignals")
          .withIndex("by_scholar", (q) => q.eq("scholarId", scholarId))
          .order("desc")
          .take(READ_LIMIT)
      )
        .filter(
          (signal) =>
            signal._creationTime >= args.dayStartMs &&
            signal._creationTime <= args.nowMs,
        )
        .map(async (signal) => {
          const session = await ctx.db.get(signal.sessionId);
          if (!session || String(session.userId) !== String(scholarId)) {
            return null;
          }
          return {
            signalType: signal.signalType,
            description: snippet(signal.description),
            intensity: signal.intensity,
            pcmDimension: signal.pcmDimension,
            sessionUrl: withBase(
              siteUrl(),
              sessionPath(session._id, scholarId),
            ),
            createdAt: signal._creationTime,
          };
        });
      const signals = rankEodSignals(
        (await Promise.all(signalCandidates)).filter(
          (candidate): candidate is NonNullable<typeof candidate> =>
            candidate !== null,
        ),
      );

      const name = scholar.name?.trim() || scholar.username || "Scholar";
      const scholarUrl = withBase(
        siteUrl(),
        scholarPath(scholarSlug(scholar.username, scholar._id)),
      );
      scholarNameById.set(String(scholarId), name);
      scholarUrlById.set(String(scholarId), scholarUrl);
      scholars.push({
        name,
        scholarUrl,
        sessions: sessionRows,
        completions,
        deliverables: deliverables.length,
        practiceAttempts: practice.length,
        practiceDistinctSkills: new Set(practice.map((row) => row.nodeKey))
          .size,
        observations,
        analysesNotes: analysesNotes.slice(0, LIST_LIMIT),
        signals,
      });
    }

    const scholarIdSet = new Set(scholarIds.map(String));
    const scheduled: EodScheduledActivity[] = [];
    const assignments = (await ctx.db.query("assignments").collect()).filter(
      (assignment) => assignment.archivedAt == null,
    );
    const keyMoments: EodChannelInput["keyMoments"] = [];
    const seenMomentKeys = new Set<string>();
    const momentSessionCache = new Map<string, Doc<"sessions"> | null>();
    for (const assignment of assignments) {
      if (
        !assignment.scholarIds.some((scholarId) =>
          scholarIdSet.has(String(scholarId)),
        )
      ) {
        continue;
      }
      const digest = await ctx.db
        .query("classDigests")
        .withIndex("by_assignment_scope", (q) =>
          q.eq("assignmentId", assignment._id).eq("scope", "cohort"),
        )
        .order("desc")
        .first();
      if (
        !digest ||
        (digest.status !== "ready" &&
          !(digest.status === "pending" && digest.moments?.length)) ||
        digest.generatedAt == null ||
        digest.generatedAt < args.dayStartMs ||
        digest.generatedAt > args.nowMs
      ) {
        continue;
      }
      for (const moment of digest.moments ?? []) {
        const scholarKey = String(moment.scholarId);
        if (!scholarIdSet.has(scholarKey) || !moment.sessionId) continue;

        const sessionKey = String(moment.sessionId);
        if (!momentSessionCache.has(sessionKey)) {
          momentSessionCache.set(
            sessionKey,
            await ctx.db.get(moment.sessionId),
          );
        }
        const session = momentSessionCache.get(sessionKey);
        if (!session || String(session.userId) !== scholarKey) continue;
        const lastActivityAt = session.lastMessageAt ?? session._creationTime;
        if (
          lastActivityAt < args.dayStartMs ||
          lastActivityAt > args.nowMs
        ) {
          continue;
        }
        const sessionUrl = withBase(
          siteUrl(),
          sessionPath(session._id, moment.scholarId),
        );

        const headline = snippet(moment.headline);
        const detail = snippet(moment.detail);
        const momentKey = `${scholarKey}\u0000${headline}\u0000${detail}`;
        if (seenMomentKeys.has(momentKey)) continue;
        const scholarName = scholarNameById.get(scholarKey);
        const scholarUrl = scholarUrlById.get(scholarKey);
        if (!scholarName || !scholarUrl) continue;

        seenMomentKeys.add(momentKey);
        keyMoments.push({
          kind: moment.kind,
          scholarName,
          scholarUrl,
          sessionUrl,
          headline,
          detail,
        });
        if (keyMoments.length === LIST_LIMIT) break;
      }
      if (keyMoments.length === LIST_LIMIT) break;
    }

    for (const assignment of assignments) {
      const assignmentScholars = assignment.scholarIds.filter((scholarId) =>
        scholarIdSet.has(String(scholarId)),
      );
      if (assignmentScholars.length === 0) continue;

      for (const entry of assignment.activitySchedule ?? []) {
        // `setAt` is when the entry actually went LIVE to scholars; a
        // planned-only entry (`startsAt` set, `setAt` absent) was never on
        // anyone's plate, so asking about its "missing completion" would be
        // asking about work that was never assigned.
        const liveAt = entry.setAt;
        if (
          liveAt == null ||
          liveAt < args.dayStartMs ||
          liveAt > args.nowMs
        ) {
          continue;
        }
        const targetedIds =
          entry.scholarIds && entry.scholarIds.length > 0
            ? new Set(entry.scholarIds.map(String))
            : null;
        const relevantScholars = assignmentScholars.filter(
          (scholarId) => !targetedIds || targetedIds.has(String(scholarId)),
        );
        if (relevantScholars.length === 0) continue;

        const doneScholarNames: string[] = [];
        const missingScholarNames: string[] = [];
        for (const scholarId of relevantScholars) {
          const name =
            scholarNameById.get(String(scholarId)) ?? "Unknown scholar";
          const done = (
            completionsByScholar.get(String(scholarId)) ?? []
          ).some(
            (completion) =>
              String(completion.activityId) === String(entry.activityId),
          );
          (done ? doneScholarNames : missingScholarNames).push(name);
        }
        const matchingGroupNames = tenantGroups
          .filter((group) =>
            group.scholarIds.some((scholarId) =>
              relevantScholars.some(
                (relevantId) => String(relevantId) === String(scholarId),
              ),
            ),
          )
          .map((group) => group.name);
        scheduled.push({
          activityTitle: await activityTitle(entry.activityId),
          scheduledForGroup:
            matchingGroupNames.join(", ") ||
            tenantGroups.map((g) => g.name).join(", "),
          doneScholarNames,
          missingScholarNames,
        });
        if (scheduled.length === LIST_LIMIT) break;
      }
      if (scheduled.length === LIST_LIMIT) break;
    }

    const groupIdSet = new Set(tenantGroups.map((group) => String(group._id)));
    const queuedDigestRows = (
      await ctx.db
        .query("slackNotificationQueue")
        .withIndex("by_sent", (q) => q.eq("sent", false))
        .collect()
    ).filter((row) => groupIdSet.has(String(row.groupId)));

    return {
      groupNames: tenantGroups.map((group) => group.name),
      scholars,
      keyMoments,
      scheduled,
      queuedDigestIds: queuedDigestRows.map((row) => row._id),
      queuedDigestLines: queuedDigestRows.map((row) => row.text),
    };
  },
});

export const claimCheckin = internalMutation({
  args: {
    channelId: v.string(),
    dateKey: v.string(),
    groupIds: v.array(v.id("scholarGroups")),
    dayStartMs: v.optional(v.number()),
    dateLabel: v.optional(v.string()),
    institutionId: v.optional(v.id("institutions")),
    force: v.optional(v.boolean()),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{
    claimed: boolean;
    checkinId?: Id<"eodCheckins">;
    existingThreadTs?: string;
  }> => {
    const now = Date.now();
    if (!args.force) {
      const existingClaims = await ctx.db
        .query("eodCheckins")
        .withIndex("by_channel_date", (q) =>
          q.eq("channelId", args.channelId).eq("dateKey", args.dateKey),
        )
        .collect();
      if (
        existingClaims.some((claim) => {
          // Before `lifecycle` was introduced, threadTs was written only by
          // finalization. Keep those legacy rows permanently finalized.
          const completed =
            claim.lifecycle === "completed" ||
            (claim.threadTs !== undefined && claim.lifecycle === undefined);
          return (
            completed ||
            claim.lifecycle === "failed" ||
            claim.postedAt >= now - CHECKIN_CLAIM_STALE_MS
          );
        })
      ) {
        return { claimed: false };
      }
      // Prefer a staged parent if unusual historical duplicate claims exist:
      // reusing it is the only choice that cannot make a duplicate parent post.
      const staleClaim =
        existingClaims.find(
          (claim) => claim.lifecycle === "parent_staged" && claim.threadTs,
        ) ?? existingClaims[0];
      if (staleClaim) {
        await ctx.db.patch(staleClaim._id, {
          postedAt: now,
          retryAt: now + CHECKIN_CLAIM_STALE_MS,
        });
        return {
          claimed: true,
          checkinId: staleClaim._id,
          ...(staleClaim.lifecycle === "parent_staged" && staleClaim.threadTs
            ? { existingThreadTs: staleClaim.threadTs }
            : {}),
        };
      }
    }
    const checkinId = await ctx.db.insert("eodCheckins", {
      channelId: args.channelId,
      dateKey: args.dateKey,
      groupIds: args.groupIds,
      postedAt: now,
      lifecycle: "parent_pending",
      retryAt: now + CHECKIN_CLAIM_STALE_MS,
      retryAttempts: 0,
      ...(args.dayStartMs === undefined ? {} : { dayStartMs: args.dayStartMs }),
      ...(args.dateLabel === undefined ? {} : { dateLabel: args.dateLabel }),
      ...(args.institutionId === undefined
        ? {}
        : { institutionId: args.institutionId }),
    });
    return { claimed: true, checkinId };
  },
});

export const stageParentCheckin = internalMutation({
  args: {
    checkinId: v.id("eodCheckins"),
    threadTs: v.string(),
  },
  handler: async (ctx, args) => {
    const checkin = await ctx.db.get(args.checkinId);
    if (!checkin) throw new Error("End-of-day check-in claim not found");
    await ctx.db.patch(args.checkinId, {
      threadTs: args.threadTs,
      lifecycle: "reply_pending",
      retryAt: Date.now() + CHECKIN_CLAIM_STALE_MS,
    });
  },
});

export const prepareReply = internalMutation({
  args: {
    checkinId: v.id("eodCheckins"),
    parentText: v.string(),
    replyText: v.string(),
    queuedDigestIds: v.array(v.id("slackNotificationQueue")),
  },
  handler: async (ctx, args) => {
    const checkin = await ctx.db.get(args.checkinId);
    if (!checkin) throw new Error("End-of-day check-in claim not found");
    if (checkin.replyText) {
      return {
        parentText: checkin.parentText ?? args.parentText,
        replyText: checkin.replyText,
      };
    }
    await ctx.db.patch(args.checkinId, {
      parentText: args.parentText,
      replyText: args.replyText,
      initialQueueIds: args.queuedDigestIds,
      lifecycle: "reply_pending",
    });
    return { parentText: args.parentText, replyText: args.replyText };
  },
});

export const scheduleRetry = internalMutation({
  args: {
    checkinId: v.id("eodCheckins"),
    error: v.string(),
    retryAfterMs: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const checkin = await ctx.db.get(args.checkinId);
    if (!checkin) throw new Error("End-of-day check-in claim not found");
    const retryAttempts = (checkin.retryAttempts ?? 0) + 1;
    if (retryAttempts >= MAX_RETRY_ATTEMPTS) {
      await ctx.db.patch(args.checkinId, {
        lifecycle: "failed",
        retryAttempts,
        retryAt: undefined,
        lastError: args.error,
      });
      console.error(
        `[EodCheckin] ${checkin.channelId}/${checkin.dateKey} exhausted retries: ${args.error}`,
      );
      return;
    }
    await ctx.db.patch(args.checkinId, {
      retryAttempts,
      retryAt: Date.now() + retryDelayMs(retryAttempts, args.retryAfterMs),
      lastError: args.error,
    });
  },
});

export const cancelCheckin = internalMutation({
  args: { checkinId: v.id("eodCheckins"), reason: v.string() },
  handler: async (ctx, args) => {
    const checkin = await ctx.db.get(args.checkinId);
    if (!checkin) throw new Error("End-of-day check-in claim not found");
    await ctx.db.patch(args.checkinId, {
      lifecycle: "failed",
      retryAt: undefined,
      lastError: args.reason,
    });
  },
});

export const getCheckin = internalQuery({
  args: { checkinId: v.id("eodCheckins") },
  handler: (ctx, args) => ctx.db.get(args.checkinId),
});

export const deliveryAllowed = internalQuery({
  args: { checkinId: v.id("eodCheckins") },
  handler: async (ctx, args) => {
    const checkin = await ctx.db.get(args.checkinId);
    if (
      !checkin ||
      checkin.lifecycle === "completed" ||
      checkin.lifecycle === "failed"
    ) {
      return false;
    }
    const groups = await Promise.all(
      checkin.groupIds.map((groupId) => ctx.db.get(groupId)),
    );
    let institutionId: Id<"institutions"> | undefined;
    for (const group of groups) {
      if (
        !group?.institutionId ||
        group.slackChannelId !== checkin.channelId
      ) {
        return false;
      }
      if (institutionId === undefined) institutionId = group.institutionId;
      if (group.institutionId !== institutionId) return false;
      const institutionIds = await Promise.all(
        group.scholarIds.map((scholarId) =>
          resolveScholarInstitutionId(ctx, scholarId),
        ),
      );
      if (
        institutionIds.some(
          (institutionId) => institutionId !== group.institutionId,
        )
      ) {
        return false;
      }
    }
    return true;
  },
});

export const claimDueRetries = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const due = await ctx.db
      .query("eodCheckins")
      // Undefined index values sort before timestamps. Bound at zero so
      // completed/failed rows cannot crowd due work out of the limited sweep.
      .withIndex("by_retryAt", (q) => q.gte("retryAt", 0).lte("retryAt", now))
      .take(RETRY_SWEEP_LIMIT);
    const retryable = due.filter(
      (checkin) =>
        checkin.lifecycle !== "completed" &&
        checkin.lifecycle !== "failed" &&
        checkin.retryAt !== undefined,
    );
    await Promise.all(
      retryable.map((checkin) =>
        ctx.db.patch(checkin._id, {
          // Lease this retry while the action does its Slack reconciliation.
          retryAt: now + CHECKIN_CLAIM_STALE_MS,
        }),
      ),
    );
    return retryable;
  },
});

export const finalizeCheckin = internalMutation({
  args: {
    checkinId: v.id("eodCheckins"),
    threadTs: v.string(),
    teacherId: v.id("users"),
    channelId: v.string(),
  },
  handler: async (ctx, args) => {
    const checkin = await ctx.db.get(args.checkinId);
    if (!checkin) throw new Error("End-of-day check-in claim not found");
    await ctx.db.patch(args.checkinId, {
      threadTs: args.threadTs,
      lifecycle: "completed",
      retryAt: undefined,
      lastError: undefined,
    });

    const existingThread = await ctx.db
      .query("slackThreads")
      .withIndex("by_channel_thread", (q) =>
        q.eq("channelId", args.channelId).eq("threadTs", args.threadTs),
      )
      .unique();
    if (existingThread) {
      await ctx.db.patch(existingThread._id, { lastActivityAt: Date.now() });
    } else {
      await ctx.db.insert("slackThreads", {
        channelId: args.channelId,
        threadTs: args.threadTs,
        startedByUserId: args.teacherId,
        lastActivityAt: Date.now(),
      });
    }

    if (checkin.initialQueueIds) {
      for (const id of checkin.initialQueueIds) {
        const row = await ctx.db.get(id);
        if (row && !row.sent) {
          await ctx.db.patch(id, { sent: true });
        }
      }
    } else {
      // Legacy retries predate the exact queue snapshot. Preserve their original
      // finalization behavior rather than leaving already-rendered rows pending.
      const groupIdSet = new Set(checkin.groupIds.map(String));
      const queued = await ctx.db
        .query("slackNotificationQueue")
        .withIndex("by_sent", (q) => q.eq("sent", false))
        .collect();
      for (const row of queued) {
        if (groupIdSet.has(String(row.groupId))) {
          await ctx.db.patch(row._id, { sent: true });
        }
      }
    }
  },
});

export const runDaily = internalAction({
  args: {
    force: v.optional(v.boolean()),
    sweepOnly: v.optional(v.boolean()),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{ postedChannels: number; skippedChannels: number }> => {
    const token = process.env.SLACK_BOT_TOKEN;
    if (!token) {
      console.log("[EodCheckin] no SLACK_BOT_TOKEN — skipping");
      return { postedChannels: 0, skippedChannels: 0 };
    }

    const groups = await ctx.runQuery(internal.eodCheckin.linkedGroups, {});
    const byChannel = new Map<string, typeof groups>();
    for (const group of groups) {
      const channelGroups = byChannel.get(group.slackChannelId) ?? [];
      channelGroups.push(group);
      byChannel.set(group.slackChannelId, channelGroups);
    }

    let postedChannels = 0;
    let skippedChannels = 0;

    const processCheckin = async (
      checkinId: Id<"eodCheckins">,
      channelGroups: typeof groups,
      options: {
        dateLabel?: string;
        dayStartMs?: number;
        input?: EodChannelInput;
        institutionId?: Id<"institutions">;
      },
    ): Promise<boolean> => {
      try {
        let checkin = await ctx.runQuery(internal.eodCheckin.getCheckin, {
          checkinId,
        });
        if (
          !checkin ||
          checkin.lifecycle === "completed" ||
          checkin.lifecycle === "failed"
        ) {
          return false;
        }
        const ensureDeliveryAllowed = async (): Promise<boolean> => {
          if (
            await ctx.runQuery(internal.eodCheckin.deliveryAllowed, {
              checkinId,
            })
          ) {
            return true;
          }
          await ctx.runMutation(internal.eodCheckin.cancelCheckin, {
            checkinId,
            reason: "Group enrollment changed before Slack delivery",
          });
          return false;
        };
        if (!(await ensureDeliveryAllowed())) return false;
        const dayStartMs = checkin.dayStartMs ?? options.dayStartMs;
        const dateLabel = checkin.dateLabel ?? options.dateLabel ?? checkin.dateKey;
        let input = options.input;
        if (!checkin.replyText) {
          if (!input && dayStartMs !== undefined) {
            const collected = await ctx.runQuery(
              internal.eodCheckin.collectChannelDay,
              {
                groupIds: checkin.groupIds,
                dayStartMs,
                nowMs: dayStartMs + 24 * 60 * 60 * 1000 - 1,
              },
            );
            input = { ...collected, dateLabel };
          }
          // Rows staged by the first lifecycle rollout predate the persisted
          // day snapshot. Their parent is already visible, so finish the thread
          // with the mechanical fallback rather than abandoning that legacy
          // check-in merely because its original day cannot be reconstructed.
          if (!input && checkin.threadTs) {
            input = {
              dateLabel,
              groupNames: channelGroups.map((group) => group.name),
              scholars: [],
              keyMoments: [],
              scheduled: [],
              queuedDigestIds: [],
              queuedDigestLines: [],
            };
          }
          if (!input || (!hasAnyActivity(input) && !checkin.threadTs)) {
            await ctx.runMutation(internal.eodCheckin.cancelCheckin, {
              checkinId,
              reason: "No check-in activity remained for the original day",
            });
            return false;
          }

          let narrative = renderMechanicalFallback(input);
          try {
            const generated = await ctx.runAction(
              internal.eodCheckinNarrative.generate,
              { input, institutionId: options.institutionId },
            );
            if (
              generated.ok &&
              generated.hook &&
              generated.wrapUp &&
              generated.questions?.length
            ) {
              narrative = {
                hook: generated.hook,
                wrapUp: generated.wrapUp,
                questions: generated.questions,
              };
            }
          } catch (error: unknown) {
            const message =
              error instanceof Error ? error.message : String(error);
            console.error(
              `[EodCheckin] narrative orchestration failed (mechanical fallback): ${message}`,
            );
          }
          const allowedBase = siteUrl();
          const prepared = await ctx.runMutation(
            internal.eodCheckin.prepareReply,
            {
              checkinId,
              parentText: parentMessageText(
                escapeSlackText(narrative.hook),
                dateLabel,
              ),
              replyText: renderThreadMessage(
                sanitizeEodSlackText(narrative.wrapUp, allowedBase),
                narrative.questions.map((question) =>
                  sanitizeEodSlackText(question, allowedBase),
                ),
              ),
              queuedDigestIds: input.queuedDigestIds,
            },
          );
          checkin = await ctx.runQuery(internal.eodCheckin.getCheckin, {
            checkinId,
          });
          if (!checkin) return false;
          // `prepareReply` returns the durable first render. This assignment
          // prevents a retry from changing either message while it is in flight.
          checkin = { ...checkin, ...prepared };
        }

        let threadTs = checkin.threadTs;
        if (!threadTs) {
          const history = await fetchConversationHistory(token, checkin.channelId, {
            // A parent accepted during a lost response can be older than the
            // channel's first history page. Scan from the durable claim time.
            oldest: String(checkin.postedAt / 1_000),
          });
          if (!history.ok) {
            await ctx.runMutation(internal.eodCheckin.scheduleRetry, {
              checkinId,
              error: `Slack parent reconciliation failed: ${history.error ?? "unknown error"}`,
              retryAfterMs: history.retryAfterMs,
            });
            return false;
          }
          const existingParent = messageWithDeliveryMetadata(
            history.messages,
            EOD_MESSAGE_EVENT_TYPE,
            deliveryId(checkinId, "parent"),
          );
          if (existingParent?.ts) {
            threadTs = existingParent.ts;
            await ctx.runMutation(internal.eodCheckin.stageParentCheckin, {
              checkinId,
              threadTs,
            });
          } else {
            if (!(await ensureDeliveryAllowed())) return false;
            const parent = await postMessage(token, {
              channel: checkin.channelId,
              text: checkin.parentText ?? parentMessageText("", dateLabel),
              markdown: true,
              metadata: deliveryMetadata(checkinId, "parent"),
            });
            if (!parent.ok || !parent.ts) {
              await ctx.runMutation(internal.eodCheckin.scheduleRetry, {
                checkinId,
                error: `Slack parent post failed: ${parent.error ?? "missing timestamp"}`,
                retryAfterMs: parent.retryAfterMs,
              });
              return false;
            }
            threadTs = parent.ts;
            await ctx.runMutation(internal.eodCheckin.stageParentCheckin, {
              checkinId,
              threadTs,
            });
          }
        }

        const replyText = checkin.replyText;
        if (!replyText) {
          throw new Error("End-of-day check-in reply was not prepared");
        }
        const replies = await fetchConversationReplies(
          token,
          checkin.channelId,
          threadTs,
        );
        if (!replies.ok) {
          await ctx.runMutation(internal.eodCheckin.scheduleRetry, {
            checkinId,
            error: `Slack reply reconciliation failed: ${replies.error ?? "unknown error"}`,
            retryAfterMs: replies.retryAfterMs,
          });
          return false;
        }
        if (
          !messageWithDeliveryMetadata(
            replies.messages,
            EOD_MESSAGE_EVENT_TYPE,
            deliveryId(checkinId, "reply"),
          )
        ) {
          if (!(await ensureDeliveryAllowed())) return false;
          const reply = await postMessage(token, {
            channel: checkin.channelId,
            threadTs,
            text: replyText,
            markdown: true,
            metadata: deliveryMetadata(checkinId, "reply"),
          });
          if (!reply.ok) {
            await ctx.runMutation(internal.eodCheckin.scheduleRetry, {
              checkinId,
              error: `Slack threaded reply failed: ${reply.error ?? "unknown error"}`,
              retryAfterMs: reply.retryAfterMs,
            });
            return false;
          }
        }

        await ctx.runMutation(internal.eodCheckin.finalizeCheckin, {
          checkinId,
          threadTs,
          teacherId: channelGroups[0].teacherId,
          channelId: checkin.channelId,
        });
        return true;
      } catch (error: unknown) {
        const message =
          error instanceof Error ? error.message : String(error);
        console.error(
          `[EodCheckin] check-in ${checkinId} failed (continuing): ${message}`,
        );
        await ctx.runMutation(internal.eodCheckin.scheduleRetry, {
          checkinId,
          error: `Check-in processing failed: ${message}`,
        });
        return false;
      }
    };

    // This path is deliberately independent of today's date key: a 429 or an
    // ambiguous response from Monday must still reconcile Monday's check-in.
    const dueRetries = await ctx.runMutation(
      internal.eodCheckin.claimDueRetries,
      {},
    );
    const retriedChannelDates = new Set(
      dueRetries.map((checkin) => `${checkin.channelId}:${checkin.dateKey}`),
    );
    const groupById = new Map(groups.map((group) => [String(group._id), group]));
    for (const checkin of dueRetries) {
      const channelGroups = checkin.groupIds
        .map((groupId) => groupById.get(String(groupId)))
        .filter(
          (group): group is (typeof groups)[number] =>
            group !== undefined && group.slackChannelId === checkin.channelId,
        );
      if (channelGroups.length === 0) {
        await ctx.runMutation(internal.eodCheckin.cancelCheckin, {
          checkinId: checkin._id,
          reason: "The original channel is no longer linked to an active group",
        });
        skippedChannels += 1;
        continue;
      }
      if (
        await processCheckin(checkin._id, channelGroups, {
          dayStartMs: checkin.dayStartMs,
          dateLabel: checkin.dateLabel,
          institutionId: checkin.institutionId,
        })
      ) {
        postedChannels += 1;
      } else {
        skippedChannels += 1;
      }
    }

    const now = Date.now();
    if (args.sweepOnly || (isCheckinWeekend(now) && !args.force)) {
      return { postedChannels, skippedChannels };
    }

    for (const [channelId, channelGroups] of byChannel) {
      try {
        const groupIds = channelGroups.map((group) => group._id);
        // Attribute the channel to a single institution when all its groups
        // agree; that institution drives BOTH the day window/label timezone and
        // the note's school identity. Mixed/absent → the primary (Honolulu).
        const institutionIds = new Set(
          channelGroups.map((group) => group.institutionId),
        );
        const institutionId =
          institutionIds.size === 1
            ? institutionIds.values().next().value
            : undefined;
        const timeZone = await ctx.runQuery(
          internal.eodCheckin.institutionTimeZone,
          { institutionId: institutionId ?? null },
        );
        const dateKey = checkinDayKey(now, timeZone);
        const dateLabel = checkinDateLabel(now, timeZone);
        const dayStartMs = checkinDayStartMs(now, timeZone);
        if (retriedChannelDates.has(`${channelId}:${dateKey}`)) {
          continue;
        }
        const claim = await ctx.runMutation(
          internal.eodCheckin.claimCheckin,
          {
            channelId,
            dateKey,
            groupIds,
            dayStartMs,
            dateLabel,
            institutionId,
            force: args.force,
          },
        );
        if (!claim.claimed || !claim.checkinId) {
          skippedChannels += 1;
          continue;
        }
        const collected = await ctx.runQuery(
          internal.eodCheckin.collectChannelDay,
          { groupIds, dayStartMs, nowMs: now },
        );
        if (
          await processCheckin(claim.checkinId, channelGroups, {
            input: { ...collected, dateLabel },
            dayStartMs,
            dateLabel,
            institutionId,
          })
        ) {
          postedChannels += 1;
        } else {
          skippedChannels += 1;
        }
      } catch (error: unknown) {
        skippedChannels += 1;
        const message =
          error instanceof Error ? error.message : String(error);
        console.error(
          `[EodCheckin] channel ${channelId} failed (continuing): ${message}`,
        );
      }
    }

    return { postedChannels, skippedChannels };
  },
});
