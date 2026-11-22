import { v } from "convex/values";
import {
  internalAction,
  internalMutation,
  internalQuery,
  type QueryCtx,
} from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import {
  deliveryId,
  deliveryMetadata,
  EOD_MESSAGE_EVENT_TYPE,
  hasAnyActivity,
  checkinDateLabel,
  checkinDayKey,
  checkinDayStartMs,
  compareOverdueHomework,
  isCheckinWeekend,
  mergeCheckinQuestions,
  parentMessageText,
  renderMechanicalFallback,
  renderWeekScreenTime,
  withLastWeek,
  renderThreadMessage,
  sanitizeEodSlackText,
  threadMessageParts,
  buildSnapshotBlocks,
  renderBuildSnapshotPost,
  type EodBuildSnapshot,
  type EodBuildSnapshotPost,
  type EodChannelInput,
  type EodOverdueHomework,
  type EodScheduledActivity,
  type EodScholarDay,
  type EodWeekScreenTime,
  rankEodSignals,
} from "./lib/eodCheckin";
import {
  assignmentPath,
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
  uploadFileToSlack,
  type SlackMessage,
} from "./lib/slackApi";
import { greyLineMessage } from "./lib/slackGreyLine";
import { suspendedInstitutionIds } from "./lib/access";
import { scholarInstitutionId as resolveScholarInstitutionId } from "./lib/scholarEnrollment";
import { teacherCanMarkCompleteForGroup } from "./lib/activityCompletionCore";
import { readSchedule } from "./lib/scheduleStore";
import { ONBOARDING_UNIT_SLUG } from "./onboardingData";
import { unstartedAssignedRowSurface } from "./scholarPlate";
import {
  dayKeyForTimezone,
  dueStatus,
  shiftDayKey,
  weekdayForDayKey,
} from "../shared/institutionDay";
import { readScholarDayUsage, type ScholarUsageScope } from "./deviceActivity";
import { primaryInstitutionId } from "./lib/primaryInstitution";
import { sniffImageMime } from "./lib/imageBytes";
import { sumScholarWeeks } from "../shared/screenTimeWeek";
import { nextOpenSchoolDayKeys } from "./lib/schoolDays";
import { isTestAccount } from "./lib/testAccounts";

const LIST_LIMIT = 20;
const READ_LIMIT = 100;
const SNIPPET_CHARS = 240;
// Andy's 2026-08-03 ruling: an unfinalized claim is reclaimable after 2 hours.
const CHECKIN_CLAIM_STALE_MS = 2 * 60 * 60 * 1000;
const RETRY_SWEEP_LIMIT = 20;
const MAX_RETRY_ATTEMPTS = 5;
const RETRY_BASE_MS = 5 * 60 * 1000;
// Slack processes an upload for about two seconds before an image block may
// name it; a post sooner fails `invalid_blocks` (live probe, 2026-11-09). Each
// try waits that long first, and five tries cover ten seconds.
const BUILD_POST_ATTEMPTS = 5;
const BUILD_POST_WAIT_MS = 2_000;
// The whole pictures step gets this long before the summary goes without it,
// so a stalled upload can't hold up the check-in.
const BUILD_DELIVERY_BUDGET_MS = 45_000;

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

// The Workshop screenshots an app after every build change, for the builder
// model's own render check (`messages.renderCheck`). The newest of those taken
// today is what a scholar's app looked like when they last changed it, so the
// check-in posts it. A builder turn spans several assistant rows and play
// replies add more, so each session is read back a long way, under one budget
// for the channel. A build followed by more than 80 assistant rows in the
// same session goes unpictured; that costs a picture, never the summary. A
// turn that began just before midnight still counts when its screenshot was
// taken after.
const BUILD_SNAPSHOT_SESSION_SCAN_LIMIT = 80;
const BUILD_SNAPSHOT_CHANNEL_SCAN_BUDGET = 2_000;
const BUILD_TURN_LEAD_MS = 15 * 60 * 1000;
// One image per scholar, and a hard cap for a channel shared by several groups.
const MAX_BUILD_SNAPSHOTS = 10;

async function latestBuildSnapshot(
  ctx: QueryCtx,
  sessionId: Id<"sessions">,
  dayStartMs: number,
  nowMs: number,
  budget: { rows: number },
): Promise<{ storageId: Id<"_storage">; answeredAt: number } | null> {
  let scanned = 0;
  for await (const message of ctx.db
    .query("messages")
    .withIndex("by_session_role", (q) =>
      q
        .eq("sessionId", sessionId)
        .eq("role", "assistant")
        .gte("_creationTime", dayStartMs - BUILD_TURN_LEAD_MS),
    )
    .order("desc")) {
    if (scanned >= BUILD_SNAPSHOT_SESSION_SCAN_LIMIT || budget.rows <= 0) {
      return null;
    }
    scanned += 1;
    budget.rows -= 1;
    const check = message.renderCheck;
    if (
      check?.snapshotStorageId &&
      check.answeredAt !== undefined &&
      check.answeredAt >= dayStartMs &&
      check.answeredAt <= nowMs
    ) {
      return { storageId: check.snapshotStorageId, answeredAt: check.answeredAt };
    }
  }
  return null;
}

/**
 * Whether a session's picture may go to this school's channel. A teacher
 * archived it for a reason; a rehearsal is a teacher's, never a scholar's
 * build; and a session stamped to another school stays there. The day's
 * wonders note applies the same rule to a wonder's chat (dayWonders.ts).
 */
export function buildSessionPostable(
  session: Doc<"sessions">,
  institutionId: Id<"institutions">,
): boolean {
  return (
    session.teacherArchivedAt === undefined &&
    session.isTestDrive !== true &&
    (session.institutionId === undefined ||
      session.institutionId === institutionId)
  );
}

/**
 * Each scholar's newest build screenshot of the day, read apart from
 * `collectChannelDay` so a day heavy enough to hit a read limit here costs
 * only the pictures, never the check-in.
 */
export const collectBuildSnapshots = internalQuery({
  args: {
    groupIds: v.array(v.id("scholarGroups")),
    dayStartMs: v.number(),
    nowMs: v.number(),
  },
  handler: async (ctx, args): Promise<EodBuildSnapshot[]> => {
    const { institutionId, scholarIds } = await channelRoster(
      ctx,
      args.groupIds,
    );
    if (!institutionId) return [];
    const budget = { rows: BUILD_SNAPSHOT_CHANNEL_SCAN_BUDGET };
    const snapshots: EodBuildSnapshot[] = [];
    for (const scholarId of scholarIds) {
      if (snapshots.length >= MAX_BUILD_SNAPSHOTS || budget.rows <= 0) break;
      const scholar = await ctx.db.get(scholarId);
      if (!scholar) continue;
      const sessions = await ctx.db
        .query("sessions")
        .withIndex("by_user_last_message", (q) =>
          q.eq("userId", scholarId).gte("lastMessageAt", args.dayStartMs),
        )
        .order("desc")
        .take(LIST_LIMIT);
      let newest: {
        session: Doc<"sessions">;
        storageId: Id<"_storage">;
        answeredAt: number;
      } | null = null;
      for (const session of sessions) {
        if (!buildSessionPostable(session, institutionId)) continue;
        const snapshot = await latestBuildSnapshot(
          ctx,
          session._id,
          args.dayStartMs,
          args.nowMs,
          budget,
        );
        if (snapshot && (!newest || snapshot.answeredAt > newest.answeredAt)) {
          newest = { session, ...snapshot };
        }
      }
      if (!newest) continue;
      snapshots.push({
        scholarId,
        sessionId: newest.session._id,
        scholarName: scholar.name?.trim() || scholar.username || "Scholar",
        sessionTitle: newest.session.title,
        sessionUrl: withBase(siteUrl(), sessionPath(newest.session._id, scholarId)),
        storageId: newest.storageId,
      });
    }
    return snapshots;
  },
});

/**
 * The saved pictures that may still go out when the thread is delivered,
 * which can be hours after they were chosen: the scholar must still be on the
 * channel's roster and the session must still be postable.
 */
export const postableBuildSnapshots = internalQuery({
  args: { checkinId: v.id("eodCheckins") },
  handler: async (ctx, args): Promise<EodBuildSnapshotPost[]> => {
    const checkin = await ctx.db.get(args.checkinId);
    if (!checkin?.buildSnapshots?.length) return [];
    const { institutionId, scholarIds } = await channelRoster(
      ctx,
      checkin.groupIds,
    );
    if (!institutionId) return [];
    const roster = new Set(scholarIds.map(String));
    const postable: EodBuildSnapshotPost[] = [];
    for (const snapshot of checkin.buildSnapshots) {
      if (!roster.has(String(snapshot.scholarId))) continue;
      const session = await ctx.db.get(snapshot.sessionId);
      if (
        !session ||
        String(session.userId) !== String(snapshot.scholarId) ||
        !buildSessionPostable(session, institutionId)
      ) {
        continue;
      }
      postable.push(snapshot);
    }
    return postable;
  },
});

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

/**
 * One Saturday-through-Friday week of a class's BunnyPad time (TRA-589), from
 * the same read model and the same weekly sum as School › Screen time, so the
 * post and the page agree. `weeksBack` 0 is the week ending on the check-in's
 * Friday, 1 the week before. Test accounts are left out. Null unless the
 * check-in day is a Friday.
 *
 * Its own query, apart from `collectChannelDay`: a week of heartbeats is tens
 * of thousands of rows, and the check-in itself must never fail on them.
 */
export const collectWeekScreenTime = internalQuery({
  args: {
    groupIds: v.array(v.id("scholarGroups")),
    dayStartMs: v.number(),
    weeksBack: v.union(v.literal(0), v.literal(1)),
  },
  handler: async (
    ctx,
    { groupIds, dayStartMs, weeksBack },
  ): Promise<EodWeekScreenTime | null> => {
    const { institutionId, scholarIds: roster } = await channelRoster(
      ctx,
      groupIds,
    );
    if (!institutionId) return null;
    const institution = await ctx.db.get(institutionId);
    const timeZone = effectiveInstitutionTimeZone(institution?.timeZone);
    const fridayKey = dayKeyForTimezone(dayStartMs, timeZone);
    // weekdayForDayKey is 0=Sun…6=Sat.
    if (weekdayForDayKey(fridayKey) !== 5) return null;
    const endDayKey = shiftDayKey(fridayKey, -7 * weeksBack);
    const startDayKey = shiftDayKey(endDayKey, -6);
    const scholarIds = roster.filter((scholarId) => !isTestAccount(scholarId));
    const rows = await readScholarDayUsage(
      ctx,
      await cohortUsageScope(ctx, institutionId, scholarIds),
      startDayKey,
      endDayKey,
    );
    // Monday through Friday after Saturday, minus the school's closures.
    const schoolDays = (
      await nextOpenSchoolDayKeys(ctx, institutionId, startDayKey, timeZone, 5, {
        maxCalendarDays: 6,
      })
    ).filter((key) => key <= endDayKey).length;
    const totalsById = new Map(
      sumScholarWeeks(rows).map((week) => [week.scholarId, week.totals]),
    );
    const scholars = [];
    for (const scholarId of scholarIds) {
      const scholar = await ctx.db.get(scholarId);
      if (!scholar) continue;
      const totals = totalsById.get(scholarId);
      const outsideSchoolMinutes = totals?.outsideSchool.measuredMinutes ?? 0;
      const builderMinutes = totals?.builder.onScreenMinutes ?? 0;
      const buildingMinutes = Math.min(
        totals?.builder.activeMinutes ?? 0,
        builderMinutes,
      );
      scholars.push({
        scholarId,
        name: scholar.name?.trim() || scholar.username || "Scholar",
        url: withBase(
          siteUrl(),
          `/school/screen-time?scholar=${scholarId}&end=${endDayKey}`,
        ),
        inSchoolMinutes: Math.max(
          0,
          (totals?.measuredMinutes ?? 0) - outsideSchoolMinutes,
        ),
        outsideSchoolMinutes,
        buildingMinutes,
        playingMinutes: builderMinutes - buildingMinutes,
      });
    }
    scholars.sort((a, b) => a.name.localeCompare(b.name));
    return { startDayKey, endDayKey, schoolDays, scholars };
  },
});

/**
 * The screen-time read scope for one class. Callers pass the roster from
 * `channelRoster`, which keeps only groups whose every scholar resolves to
 * this institution, so the roster is already in tenant.
 */
async function cohortUsageScope(
  ctx: QueryCtx,
  institutionId: Id<"institutions">,
  scholarIds: Id<"users">[],
): Promise<ScholarUsageScope> {
  return {
    institutionIds: [institutionId],
    scholarIds,
    roster: async () => scholarIds,
    scholarAllowed: () => true,
    playInstitutionAllowed: (id) => id === institutionId,
    primaryInstitutionId: (await primaryInstitutionId(ctx)) ?? undefined,
    fallbackInstitutionId: institutionId,
  };
}

/** A Friday check-in's class, for its screen-time charts; null otherwise. */
async function chartCohort(ctx: QueryCtx, checkinId: Id<"eodCheckins">) {
  const checkin = await ctx.db.get(checkinId);
  if (!checkin || checkin.dayStartMs === undefined) return null;
  const { tenantGroups, institutionId, scholarIds } = await channelRoster(
    ctx,
    checkin.groupIds,
  );
  if (!institutionId) return null;
  const institution = await ctx.db.get(institutionId);
  const timeZone = effectiveInstitutionTimeZone(institution?.timeZone);
  const endDayKey = dayKeyForTimezone(checkin.dayStartMs, timeZone);
  if (weekdayForDayKey(endDayKey) !== 5) return null;
  return {
    institutionId,
    timeZone,
    endDayKey,
    tenantGroups,
    scholarIds: scholarIds.filter((scholarId) => !isTestAccount(scholarId)),
  };
}

/**
 * The week behind a Friday roundup's charts: the seven days and each
 * scholar's class (the first of the channel's groups they are in). Test
 * accounts are left out.
 */
export const screenTimeChartWeek = internalQuery({
  args: { checkinId: v.id("eodCheckins") },
  handler: async (ctx, { checkinId }) => {
    const cohort = await chartCohort(ctx, checkinId);
    if (!cohort) return null;
    const classes: { scholarId: string; scholarName: string; className: string }[] = [];
    for (const scholarId of cohort.scholarIds) {
      const scholar = await ctx.db.get(scholarId);
      const group = cohort.tenantGroups.find((candidate) =>
        candidate.scholarIds.some((id) => id === scholarId),
      );
      if (!scholar || !group) continue;
      classes.push({
        scholarId,
        scholarName: scholar.name?.trim() || scholar.username || "Scholar",
        className: group.name,
      });
    }
    return {
      timeZone: cohort.timeZone,
      allDays: Array.from({ length: 7 }, (_, index) =>
        shiftDayKey(cohort.endDayKey, index - 6),
      ),
      classes,
    };
  },
});

/**
 * One day of the class's BunnyPad time with its minute-by-minute stretches.
 * A day per call: a timeline reads every tutor turn and practice attempt.
 */
export const screenTimeChartDay = internalQuery({
  args: { checkinId: v.id("eodCheckins"), dayKey: v.string() },
  handler: async (ctx, { checkinId, dayKey }) => {
    const cohort = await chartCohort(ctx, checkinId);
    if (!cohort) return [];
    // Only the roundup's own week.
    if (dayKey > cohort.endDayKey || dayKey < shiftDayKey(cohort.endDayKey, -6)) {
      return [];
    }
    const rows = await readScholarDayUsage(
      ctx,
      await cohortUsageScope(ctx, cohort.institutionId, cohort.scholarIds),
      dayKey,
      dayKey,
      { timeline: true },
    );
    return rows.map((row) => ({
      scholarId: String(row.scholarId),
      scholarName: row.scholarName,
      dayKey: row.dayKey,
      measuredMinutes: row.measuredMinutes,
      outsideSchool: { measuredMinutes: row.outsideSchool.measuredMinutes },
      schoolDay: row.schoolDay,
      timeline: row.timeline ?? null,
    }));
  },
});

/**
 * The scholars a channel's check-in may talk about: the groups whose every
 * scholar belongs to the group's school, all from one school, deduplicated.
 */
async function channelRoster(
  ctx: QueryCtx,
  groupIds: Id<"scholarGroups">[],
): Promise<{
  tenantGroups: Doc<"scholarGroups">[];
  institutionId: Id<"institutions"> | undefined;
  scholarIds: Id<"users">[];
}> {
  const loadedGroups = (
    await Promise.all(groupIds.map((groupId) => ctx.db.get(groupId)))
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
  const scholarIds = Array.from(
    new Map(
      tenantGroups
        .flatMap((group) => group.scholarIds)
        .map((scholarId) => [String(scholarId), scholarId]),
    ).values(),
  );
  return { tenantGroups, institutionId, scholarIds };
}

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
    const { tenantGroups, institutionId, scholarIds } = await channelRoster(
      ctx,
      args.groupIds,
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
    const scholarPronounsById = new Map<string, string | null>();
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

      // `practiceAttempts` / `practiceDistinctSkills` are COUNTS the teacher
      // reads as facts, not a display list, so they have to span the whole day
      // window. Paging `by_scholar` newest-first and then truncating to
      // LIST_LIMIT reported exactly "20 attempts" for every scholar who did
      // more, and derived the distinct-skill spread from only those newest 20
      // (2026-09-01: six scholars whose real counts were 24-116 all rendered as
      // 20, which also inverted which scholar had ranged across the most
      // skills). Range-scan the day on `by_scholar_createdAt` instead — the same
      // bounded read `practiceDigest.ts` uses — so the window, not a page size,
      // decides what is counted. Rows without `createdAt` fall outside the
      // range, exactly as the old null check intended.
      const practice = (
        await ctx.db
          .query("practiceAttempts")
          .withIndex("by_scholar_createdAt", (q) =>
            q
              .eq("scholarId", scholarId)
              .gte("createdAt", args.dayStartMs)
              .lte("createdAt", args.nowMs),
          )
          .collect()
      ).filter((row) => row.retry !== true);

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
      const pronouns = scholar.pronouns ?? null;
      scholarNameById.set(String(scholarId), name);
      scholarPronounsById.set(String(scholarId), pronouns);
      scholarUrlById.set(String(scholarId), scholarUrl);
      scholars.push({
        name,
        pronouns,
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
          pronouns: scholarPronounsById.get(scholarKey) ?? null,
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

      for (const entry of await readSchedule(ctx, assignment)) {
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

    // ── Past-due homework still open on scholars' Home ────────────────────
    // Asks only about rows the scholar's Home actually shows, using the
    // plate's own definitions: pushed live (`setAt`), aimed at this scholar
    // (`entry.scholarIds`), not ended (`endsAt`), not onboarding, a surface
    // the plate renders (`unstartedAssignedRowSurface` — no shareBack, no
    // unreadable offline homework), and overdue by the same `dueStatus` the
    // Home's due chip reads. The teacher's own `dueAt` is the only line — no
    // invented staleness threshold — so undated homework (open-ended by
    // design) never appears. Completion is assignment-scoped, as the plate
    // reads it. And it only asks what the write side can act on
    // (`teacherCanMarkCompleteForGroup`).
    const institution = institutionId ? await ctx.db.get(institutionId) : null;
    const timeZone = effectiveInstitutionTimeZone(institution?.timeZone);
    const onboardingUnitId = (
      await ctx.db
        .query("units")
        .withIndex("by_slug", (q) => q.eq("slug", ONBOARDING_UNIT_SLUG))
        .first()
    )?._id;
    const teacherNameCache = new Map<string, string | null>();
    const overdueByKey = new Map<string, EodOverdueHomework>();
    for (const assignment of assignments) {
      if (
        onboardingUnitId !== undefined &&
        String(assignment.unitId ?? "") === String(onboardingUnitId)
      ) {
        continue;
      }
      const assignmentScholars = assignment.scholarIds.filter((scholarId) =>
        scholarNameById.has(String(scholarId)),
      );
      if (assignmentScholars.length === 0) continue;
      const schedule = await readSchedule(ctx, assignment);
      for (const entry of schedule) {
        const due =
          entry.mode === "homework"
            ? dueStatus(entry.dueAt, args.nowMs, timeZone)
            : null;
        if (
          due?.status !== "overdue" ||
          entry.dueAt == null ||
          entry.setAt == null ||
          (entry.endsAt != null && entry.endsAt <= args.nowMs) ||
          // Went live today → already asked about under "Scheduled activities".
          (entry.setAt >= args.dayStartMs && entry.setAt <= args.nowMs)
        ) {
          continue;
        }
        const activity = await ctx.db.get(entry.activityId);
        if (
          !activity ||
          !teacherCanMarkCompleteForGroup(assignment, activity, schedule) ||
          // The iPad Home (web + game rows on) is the scholar's Home.
          !(await unstartedAssignedRowSurface(ctx, activity, entry.mode, true))
        ) {
          continue;
        }
        const targetedIds =
          entry.scholarIds && entry.scholarIds.length > 0
            ? new Set(entry.scholarIds.map(String))
            : null;
        const incomplete: EodOverdueHomework["incompleteScholars"] = [];
        for (const scholarId of assignmentScholars) {
          if (targetedIds && !targetedIds.has(String(scholarId))) continue;
          const done = await ctx.db
            .query("activityCompletions")
            .withIndex("by_scholar_assignment", (q) =>
              q.eq("scholarId", scholarId).eq("assignmentId", assignment._id),
            )
            .filter((q) => q.eq(q.field("activityId"), entry.activityId))
            .first();
          if (done) continue;
          incomplete.push({
            name: scholarNameById.get(String(scholarId)) ?? "Scholar",
            assignmentUrl: withBase(siteUrl(), assignmentPath(assignment._id)),
          });
        }
        if (incomplete.length === 0) continue;
        const teacherKey = String(assignment.teacherId);
        if (!teacherNameCache.has(teacherKey)) {
          const teacher = await ctx.db.get(assignment.teacherId);
          teacherNameCache.set(teacherKey, teacher?.name ?? null);
        }
        const key = `${teacherKey}\u0000${activity.title.trim()}`;
        const existing = overdueByKey.get(key);
        if (existing) {
          if (entry.dueAt < existing.earliestDueAt) {
            existing.earliestDueAt = entry.dueAt;
            existing.duePhrase = due.phrase;
          }
          existing.incompleteScholars.push(...incomplete);
        } else {
          overdueByKey.set(key, {
            activityTitle: activity.title,
            teacherName: teacherNameCache.get(teacherKey) ?? null,
            earliestDueAt: entry.dueAt,
            duePhrase: due.phrase,
            incompleteScholars: incomplete,
          });
        }
      }
    }
    const overdueHomework = [...overdueByKey.values()]
      .sort(compareOverdueHomework)
      .slice(0, LIST_LIMIT);

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
      overdueHomework,
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

const buildSnapshotPostValidator = v.object({
  scholarId: v.id("users"),
  sessionId: v.id("sessions"),
  storageId: v.id("_storage"),
  title: v.string(),
  caption: v.string(),
});

export const prepareReply = internalMutation({
  args: {
    checkinId: v.id("eodCheckins"),
    parentText: v.string(),
    replyText: v.string(),
    buildSnapshots: v.optional(v.array(buildSnapshotPostValidator)),
    weekScreenTimeText: v.optional(v.string()),
    queuedDigestIds: v.array(v.id("slackNotificationQueue")),
  },
  handler: async (ctx, args) => {
    const checkin = await ctx.db.get(args.checkinId);
    if (!checkin) throw new Error("End-of-day check-in claim not found");
    if (checkin.replyText) {
      return {
        parentText: checkin.parentText ?? args.parentText,
        replyText: checkin.replyText,
        buildSnapshots: checkin.buildSnapshots,
        weekScreenTimeText: checkin.weekScreenTimeText,
      };
    }
    const buildSnapshots =
      args.buildSnapshots && args.buildSnapshots.length > 0
        ? args.buildSnapshots
        : undefined;
    await ctx.db.patch(args.checkinId, {
      parentText: args.parentText,
      replyText: args.replyText,
      buildSnapshots,
      weekScreenTimeText: args.weekScreenTimeText,
      initialQueueIds: args.queuedDigestIds,
      lifecycle: "reply_pending",
    });
    return {
      parentText: args.parentText,
      replyText: args.replyText,
      buildSnapshots,
      weekScreenTimeText: args.weekScreenTimeText,
    };
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

    // The day's build screenshots, chosen once when the reply is prepared.
    // Best-effort: a failure here costs the pictures, never the check-in.
    const chooseBuildSnapshots = async (
      groupIds: Id<"scholarGroups">[],
      dayStartMs: number | undefined,
    ): Promise<EodBuildSnapshotPost[]> => {
      if (dayStartMs === undefined) return [];
      try {
        const snapshots = await ctx.runQuery(
          internal.eodCheckin.collectBuildSnapshots,
          {
            groupIds,
            dayStartMs,
            nowMs: Math.min(dayStartMs + 24 * 60 * 60 * 1000 - 1, Date.now()),
          },
        );
        return snapshots.map(renderBuildSnapshotPost);
      } catch (error: unknown) {
        console.warn(
          `[EodCheckin] build screenshots unavailable (the check-in posts without them): ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        return [];
      }
    };

    // Best-effort: the summary is the check-in, so builds that fail to post
    // are logged and the summary still goes out. The screenshots go up as
    // private files and post as ONE message of image blocks, which lands in
    // order above the summary; shared files post whenever Slack gets to them,
    // which was after the summary in a live probe (2026-11-09).
    const postBuildSnapshots = async (
      checkinId: Id<"eodCheckins">,
      channel: string,
      threadTs: string,
      threadMessages: SlackMessage[],
      deadline: number,
    ): Promise<void> => {
      try {
        if (
          messageWithDeliveryMetadata(
            threadMessages,
            EOD_MESSAGE_EVENT_TYPE,
            deliveryId(checkinId, "builds"),
          )
        ) {
          return;
        }
        // Re-checked now, since delivery can come hours after the choice.
        const snapshots = await ctx.runQuery(
          internal.eodCheckin.postableBuildSnapshots,
          { checkinId },
        );
        const uploads = (
          await Promise.all(
            snapshots.map(async (post, index) => {
              try {
                const blob = await ctx.storage.get(post.storageId);
                const bytes = blob ? new Uint8Array(await blob.arrayBuffer()) : null;
                const mimeType = bytes ? sniffImageMime(bytes) : null;
                if (
                  !bytes ||
                  (mimeType !== "image/png" && mimeType !== "image/jpeg")
                ) {
                  console.warn(
                    `[EodCheckin] build image ${index} for ${checkinId} is missing or not a PNG/JPEG; skipping it`,
                  );
                  return null;
                }
                const uploaded = await uploadFileToSlack(token, {
                  bytes,
                  filename: `rabbithole-build-${index}.${mimeType === "image/png" ? "png" : "jpg"}`,
                  mimeType,
                  title: post.title,
                });
                if (uploaded.ok && uploaded.fileId) {
                  return { fileId: uploaded.fileId, post };
                }
                console.warn(
                  `[EodCheckin] build image ${index} for ${checkinId} did not upload; skipping it`,
                );
              } catch (error: unknown) {
                console.warn(
                  `[EodCheckin] build image ${index} for ${checkinId} failed: ${
                    error instanceof Error ? error.message : String(error)
                  }`,
                );
              }
              return null;
            }),
          )
        ).filter((upload) => upload !== null);
        if (uploads.length === 0) return;
        let error: string | undefined;
        for (let attempt = 1; attempt <= BUILD_POST_ATTEMPTS; attempt += 1) {
          await new Promise((resolve) => setTimeout(resolve, BUILD_POST_WAIT_MS));
          // Past the deadline the summary has gone (or is going) without the
          // pictures, and they must not land under it.
          if (Date.now() >= deadline) return;
          const posted = await postMessage(token, {
            channel,
            threadTs,
            text: "Today's builds",
            blocks: buildSnapshotBlocks(uploads),
            metadata: deliveryMetadata(checkinId, "builds"),
          });
          if (posted.ok) return;
          error = posted.error;
          if (error !== "invalid_blocks") break;
        }
        console.warn(
          `[EodCheckin] builds for ${checkinId} did not post (${error ?? "unknown error"}); the summary posts without them`,
        );
      } catch (error: unknown) {
        console.warn(
          `[EodCheckin] builds for ${checkinId} failed; the summary posts without them: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    };

    const postBuildSnapshotsInTime = async (
      checkinId: Id<"eodCheckins">,
      channel: string,
      threadTs: string,
      threadMessages: SlackMessage[],
    ): Promise<void> => {
      const deadline = Date.now() + BUILD_DELIVERY_BUDGET_MS;
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        postBuildSnapshots(checkinId, channel, threadTs, threadMessages, deadline),
        new Promise<void>((resolve) => {
          timer = setTimeout(() => {
            console.warn(
              `[EodCheckin] builds for ${checkinId} ran out of time; the summary posts without them`,
            );
            resolve();
          }, BUILD_DELIVERY_BUDGET_MS);
        }),
      ]);
      clearTimeout(timer);
    };

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
                // A same-day retry must not count homework due later today
                // as past due; an older day's retry keeps its day end.
                nowMs: Math.min(
                  dayStartMs + 24 * 60 * 60 * 1000 - 1,
                  Date.now(),
                ),
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
              overdueHomework: [],
              queuedDigestIds: [],
              queuedDigestLines: [],
            };
          }
          // Fridays: the class's screen-time week, read apart from the day
          // so a read that fails or runs long costs only the roundup (or,
          // for last week, only the comparison), never the check-in.
          if (input && dayStartMs !== undefined && !input.weekScreenTime) {
            try {
              const thisWeek = await ctx.runQuery(
                internal.eodCheckin.collectWeekScreenTime,
                { groupIds: checkin.groupIds, dayStartMs, weeksBack: 0 },
              );
              if (thisWeek) {
                let lastWeek: EodWeekScreenTime | null = null;
                try {
                  lastWeek = await ctx.runQuery(
                    internal.eodCheckin.collectWeekScreenTime,
                    { groupIds: checkin.groupIds, dayStartMs, weeksBack: 1 },
                  );
                } catch (error: unknown) {
                  console.warn(
                    `[EodCheckin] last week's screen time for ${checkinId} unavailable (no comparison): ${
                      error instanceof Error ? error.message : String(error)
                    }`,
                  );
                }
                input = {
                  ...input,
                  weekScreenTime: withLastWeek(thisWeek, lastWeek),
                };
              }
            } catch (error: unknown) {
              console.warn(
                `[EodCheckin] screen time for ${checkinId} unavailable (no roundup): ${
                  error instanceof Error ? error.message : String(error)
                }`,
              );
            }
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
            // The Friday screen-time roundup is its own message, rendered
            // verbatim; the model never sees it, so it can't restate the
            // numbers.
            const { weekScreenTime: _week, ...narrativeInput } = input;
            const generated = await ctx.runAction(
              internal.eodCheckinNarrative.generate,
              { input: narrativeInput, institutionId: options.institutionId },
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
                questions: mergeCheckinQuestions(input, generated.questions),
              };
            }
          } catch (error: unknown) {
            const message =
              error instanceof Error ? error.message : String(error);
            console.error(
              `[EodCheckin] narrative orchestration failed (mechanical fallback): ${message}`,
            );
          }
          const weekScreenTimeBlock = renderWeekScreenTime(input.weekScreenTime);
          const buildSnapshots = await chooseBuildSnapshots(
            checkin.groupIds,
            dayStartMs,
          );
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
              buildSnapshots,
              ...(weekScreenTimeBlock
                ? {
                    weekScreenTimeText: sanitizeEodSlackText(
                      weekScreenTimeBlock,
                      allowedBase,
                    ),
                  }
                : {}),
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
          // Pictures first, so the thread reads image → summary → questions,
          // with the questions beside the reply box.
          await postBuildSnapshotsInTime(
            checkinId,
            checkin.channelId,
            threadTs,
            replies.messages,
          );
          // The stored text is posted as written; only its closing hint moves
          // into the grey line.
          const reply = await postMessage(token, {
            channel: checkin.channelId,
            threadTs,
            metadata: deliveryMetadata(checkinId, "reply"),
            ...greyLineMessage(threadMessageParts(replyText), { markdown: true }),
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

        // Fridays: the screen-time roundup goes to the channel as its own
        // message, after the check-in, so teachers can talk it over in its
        // own thread.
        const weekScreenTimeText = checkin.weekScreenTimeText;
        if (weekScreenTimeText) {
          // Scan from the parent, which is always older than the roundup.
          // Not `postedAt`: a stale reclaim moves it forward, past a roundup
          // that already landed.
          const history = await fetchConversationHistory(token, checkin.channelId, {
            oldest: threadTs,
          });
          if (!history.ok) {
            await ctx.runMutation(internal.eodCheckin.scheduleRetry, {
              checkinId,
              error: `Slack screen-time reconciliation failed: ${history.error ?? "unknown error"}`,
              retryAfterMs: history.retryAfterMs,
            });
            return false;
          }
          let roundupTs = messageWithDeliveryMetadata(
            history.messages,
            EOD_MESSAGE_EVENT_TYPE,
            deliveryId(checkinId, "screenTime"),
          )?.ts;
          if (!roundupTs) {
            if (!(await ensureDeliveryAllowed())) return false;
            const roundup = await postMessage(token, {
              channel: checkin.channelId,
              text: weekScreenTimeText,
              markdown: true,
              metadata: deliveryMetadata(checkinId, "screenTime"),
            });
            if (!roundup.ok) {
              await ctx.runMutation(internal.eodCheckin.scheduleRetry, {
                checkinId,
                error: `Slack screen-time post failed: ${roundup.error ?? "unknown error"}`,
                retryAfterMs: roundup.retryAfterMs,
              });
              return false;
            }
            roundupTs = roundup.ts;
          }
          // The charts follow in the roundup's thread, in their own action:
          // drawing them needs Node, and a failure there costs only the
          // pictures. It checks the thread first, so a rerun never doubles them.
          if (roundupTs) {
            await ctx.scheduler.runAfter(
              0,
              internal.eodScreenTimeCharts.postCharts,
              { checkinId, channelId: checkin.channelId, roundupTs },
            );
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

    // The day's wonders ride on this run, after the check-ins so they land
    // below them, in their own action so neither can hold up the other.
    await ctx.scheduler.runAfter(0, internal.dayWonders.postForDay, {});

    return { postedChannels, skippedChannels };
  },
});
