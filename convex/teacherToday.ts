import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import type { QueryCtx } from "./_generated/server";
import { activityCounts, digestWatermarkTrails } from "./classDigests";
import { coreGrid, closureForInstitutionOnDay, currentWeekStartMs } from "./masterSchedule";
import { currentReportingPeriod } from "./reportingPeriods";
import {
  ROSTER_PULSE_WINDOW_DAYS,
  rosterPulseForScholarIds,
} from "./scholars";
import { teacherQuery } from "./lib/customFunctions";
import {
  resolveInstitutionLens,
  scholarIdsInLens,
  institutionIdInLens,
} from "./lib/institutionLens";
import { todaysBirthdayEntries } from "./birthdays";
import {
  homeworkForScholarFromAssignments,
  homeworkAssignmentsByScholar,
} from "./assignments";
import { prevOpenSchoolDayKey } from "./lib/schoolDays";
import { PREP_TIME_KEY, type DailyBlock } from "./lib/metaBlocks";
import { canonicalPrepWindow } from "./lib/prepBlock";
import {
  isStalledQuest,
  QUEST_STALLED_MS,
  questsForScholar,
} from "./lib/questLifecycle";
import {
  ERROR_FLAG_MIN_COUNT,
  ERROR_FLAG_WINDOW_MS,
  openErrorPatterns,
} from "./lib/practice/errorFlags";
import { STRUGGLING_MISS_THRESHOLD } from "./lib/practice/scheduler";
import type { ScholarPulse } from "./lib/rosterPulse";
import { scholarSlug } from "./lib/channels";
import { effectiveInstitutionTimeZone } from "./lib/institutionTime";
import {
  dayKeyForTimezone,
  dayStartForTimezone,
  instantForLocalMinutes,
  shiftDayStartForTimezone,
  weekdayForTimezone,
} from "../shared/institutionDay";
import { STRUGGLING_TITLE_LABEL } from "../shared/masteryLexicon";

const DAY_MS = 24 * 60 * 60 * 1000;
const OVERNIGHT_MS = 20 * 60 * 60 * 1000; // legacy fallback window (see overnightAnchor)
// "just now" threshold for the recency phrase.
const RECENT_MS = 20 * 60 * 1000;
// TODO: Source these institution-local bounds from institution schedule config.
const SCHOOL_START_LOCAL_MINUTES = 8 * 60; // 08:00 — first bell
const DISMISSAL_LOCAL_MINUTES = 15 * 60; // 15:00 — dismissal

type ScopedScholar = Pick<
  Doc<"users">,
  "_id" | "name" | "username" | "dateOfBirth" | "institutionId"
>;

function scholarName(scholar: ScopedScholar): string {
  return scholar.name ?? scholar.username ?? "Scholar";
}

function scholarHref(scholar: ScopedScholar, tab?: string): string {
  const slug = scholarSlug(scholar.username, scholar._id);
  return `/teacher/scholars/${slug}${tab ? `/${tab}` : ""}`;
}

async function scopedScholars(
  ctx: QueryCtx,
  user: Doc<"users">,
  institutionScope: string | undefined,
): Promise<ScopedScholar[]> {
  const lens = await resolveInstitutionLens(
    ctx,
    user,
    institutionScope ?? "",
  );
  const institutionIds = await scholarIdsInLens(ctx, lens);
  const affinity = await ctx.db
    .query("teacherAffinities")
    .withIndex("by_teacher", (q) => q.eq("teacherId", user._id))
    .first();

  const affinityIds = new Set<string>();
  if (
    affinity &&
    (affinity.scholarIds.length > 0 || affinity.groupIds.length > 0)
  ) {
    for (const scholarId of affinity.scholarIds) {
      affinityIds.add(String(scholarId));
    }
    for (const groupId of affinity.groupIds) {
      const group = await ctx.db.get(groupId);
      for (const scholarId of group?.scholarIds ?? []) {
        affinityIds.add(String(scholarId));
      }
    }
  }

  const scholars = await Promise.all(
    [...institutionIds].map((id) => ctx.db.get(id)),
  );
  return scholars
    .filter((scholar): scholar is Doc<"users"> => scholar != null)
    .map(({ _id, name, username, dateOfBirth, institutionId }) => ({
      _id,
      name,
      username,
      dateOfBirth,
      institutionId,
    }))
    .sort(
      (a, b) =>
        Number(affinityIds.has(String(b._id))) -
          Number(affinityIds.has(String(a._id))) ||
        scholarName(a).localeCompare(scholarName(b)),
    );
}

// The observer's summary is a present-tense snapshot of one moment in a
// session ("Session just opened…; no substantive engagement yet"). Rendered
// verbatim weeks later it reads as a live claim about a scholar who may simply
// not have worked since. Past this age, drop the narrative and fall back to
// the tag/trend clauses — the same drop-don't-hedge policy as
// digestWatermarkTrails ("better to drop it than surface a stale claim").
// Anchored to this lane's existing idle clock: once a session is old enough to
// be "gone quiet", its analysis is too old to narrate the present.
const STALE_NARRATIVE_MS = QUEST_STALLED_MS;

function attentionReason(pulse: ScholarPulse, now: number): string {
  // Age the summary by its OWN timestamp, not lastAnalysisAt — the newest
  // analysis can carry an empty summary, leaving latestSummary on an older row.
  const narrativeIsFresh =
    pulse.latestSummaryAt != null &&
    now - pulse.latestSummaryAt <= STALE_NARRATIVE_MS;
  if (narrativeIsFresh && pulse.latestSummary) return pulse.latestSummary;
  if (pulse.concernFlags.length > 0) {
    return pulse.concernFlags.join("; ");
  }
  if (pulse.trend === "down") {
    return "Recent engagement has been trending down.";
  }
  return "Recent engagement needs a look.";
}

/**
 * How many of a scholar's skills are currently "struggling" (red) — the
 * consecutive-miss streak at or past STRUGGLING_MISS_THRESHOLD, i.e. two-plus
 * recent wrong answers not yet superseded by a correct one. Teacher-facing (this
 * whole file is a teacherQuery), so unlike the scholar's own map it is NOT
 * redacted. O(struggling rows) via by_scholar_miss_streak; never scans either a
 * scholar's complete mastery record or the unbounded practiceAttempts log —
 * missStreak is resident state (see recordAttemptCore).
 */
export async function strugglingSkillCount(
  ctx: QueryCtx,
  scholarId: Id<"users">,
): Promise<number> {
  const rows = await ctx.db
    .query("practiceMastery")
    .withIndex("by_scholar_miss_streak", (q) =>
      q
        .eq("scholarId", scholarId)
        .gte("missStreak", STRUGGLING_MISS_THRESHOLD),
    )
    .collect();
  return rows.length;
}

/** Sentence-cased struggle clause, e.g. "Needs review on 2 skills." */
function struggleReasonText(count: number): string {
  return `${STRUGGLING_TITLE_LABEL} on ${count} skill${count === 1 ? "" : "s"}.`;
}

async function needsALookRows(
  ctx: QueryCtx,
  scholars: ScopedScholar[],
  now: number,
) {
  const pulses = await rosterPulseForScholarIds(
    ctx,
    scholars.map((scholar) => scholar._id),
    now - ROSTER_PULSE_WINDOW_DAYS * DAY_MS,
  );
  const pulseByScholar = new Map(
    pulses.map((pulse) => [pulse.scholarId, pulse]),
  );

  const rows: Array<{
    scholarId: Id<"users">;
    name: string;
    reason: string;
    sessionId?: Id<"sessions">;
    attentionScore: number;
  }> = [];

  for (const scholar of scholars) {
    const pulse = pulseByScholar.get(String(scholar._id));
    const quests = await questsForScholar(ctx, scholar._id);
    const stalledQuest = quests.find((quest) => isStalledQuest(quest, now));
    const struggleCount = await strugglingSkillCount(ctx, scholar._id);
    if (
      (!pulse || pulse.attentionLevel === "ok") &&
      !stalledQuest &&
      struggleCount === 0
    )
      continue;

    let sessionId: Id<"sessions"> | undefined;
    if (stalledQuest) {
      const sessions = await ctx.db
        .query("sessions")
        .withIndex("by_user", (q) => q.eq("userId", scholar._id))
        .collect();
      const latest = sessions
        .filter(
          (session) =>
            !session.isArchived &&
            !session.isTestDrive &&
            !session.isOffline &&
            session.unitId === stalledQuest.unitId,
        )
        .sort(
          (a, b) =>
            (b.lastMessageAt ?? b._creationTime) -
            (a.lastMessageAt ?? a._creationTime),
        )[0];
      sessionId = latest?._id;
    }

    const pulseReason =
      pulse && pulse.attentionLevel !== "ok"
        ? attentionReason(pulse, now)
        : null;
    // Compose the reason from whichever signals fired, preserving the existing
    // pulse/stalled phrasing exactly and appending the struggle clause.
    const clauses: string[] = [];
    if (pulseReason) clauses.push(pulseReason);
    if (stalledQuest) {
      clauses.push(
        pulseReason
          ? "An active session has also gone quiet."
          : "An active session has gone quiet.",
      );
    }
    if (struggleCount > 0) clauses.push(struggleReasonText(struggleCount));
    const reason = clauses.join(" ");

    rows.push({
      scholarId: scholar._id,
      name: scholarName(scholar),
      reason,
      ...(sessionId ? { sessionId } : {}),
      // A struggle nudges the sort like an observer concern flag (~1.5 each,
      // capped) so a "needs review" scholar isn't buried under engagement dips.
      attentionScore:
        (pulse?.attentionScore ?? 0) + Math.min(struggleCount, 3) * 1.5,
    });
  }

  rows.sort(
    (a, b) =>
      b.attentionScore - a.attentionScore ||
      a.name.localeCompare(b.name),
  );
  return rows.map(({ attentionScore: _attentionScore, ...row }) => row);
}

async function waitingOnYouRows(
  ctx: QueryCtx,
  user: Doc<"users">,
  scholars: ScopedScholar[],
  now: number,
) {
  const scopedIds = new Set(scholars.map((scholar) => String(scholar._id)));
  const rows: Array<{
    kind: "seeds" | "deliverables" | "digest";
    label: string;
    count?: number;
    href: string;
    verb: string;
  }> = [];

  for (const scholar of scholars) {
    const pending = await ctx.db
      .query("seeds")
      .withIndex("by_scholar_status", (q) =>
        q.eq("scholarId", scholar._id).eq("status", "pending"),
      )
      .collect();
    const count = pending.filter(
      (seed) =>
        seed.origin === "ai" || seed.origin === "ai-constellation",
    ).length;
    if (count > 0) {
      rows.push({
        kind: "seeds",
        label: `${scholarName(scholar)} has ${count} suggested ${
          count === 1 ? "seed" : "seeds"
        } to review.`,
        count,
        href: scholarHref(scholar, "guidance"),
        verb: "Review",
      });
    }
  }

  const assignmentCache = new Map<
    string,
    Doc<"assignments"> | null
  >();
  const teacherAssignments = await ctx.db
    .query("assignments")
    .withIndex("by_teacher", (q) => q.eq("teacherId", user._id))
    .collect();
  for (const assignment of teacherAssignments) {
    assignmentCache.set(String(assignment._id), assignment);
  }
  const unitCache = new Map<string, Doc<"units"> | null>();
  const assignmentFor = async (id: Id<"assignments">) => {
    const key = String(id);
    if (!assignmentCache.has(key)) {
      assignmentCache.set(key, await ctx.db.get(id));
    }
    return assignmentCache.get(key) ?? null;
  };
  const assignmentLabel = async (assignment: Doc<"assignments">) => {
    if (assignment.title) return assignment.title;
    if (!assignment.unitId) return "an assignment";
    const key = String(assignment.unitId);
    if (!unitCache.has(key)) {
      unitCache.set(key, await ctx.db.get(assignment.unitId));
    }
    return unitCache.get(key)?.title ?? "an assignment";
  };

  const ungradedByAssignment = new Map<
    string,
    { assignment: Doc<"assignments">; count: number }
  >();
  for (const scholar of scholars) {
    const deliverables = await ctx.db
      .query("deliverables")
      .withIndex("by_scholar", (q) => q.eq("scholarId", scholar._id))
      .collect();
    for (const deliverable of deliverables) {
      if (
        !deliverable.assignmentId ||
        deliverable.rubricCheckedAt != null ||
        deliverable.rubricPassed != null ||
        deliverable.overall != null
      ) {
        continue;
      }
      const assignment = await assignmentFor(deliverable.assignmentId);
      if (!assignment || assignment.teacherId !== user._id) continue;
      const key = String(assignment._id);
      const current = ungradedByAssignment.get(key);
      if (current) current.count += 1;
      else ungradedByAssignment.set(key, { assignment, count: 1 });
    }
  }
  for (const { assignment, count } of ungradedByAssignment.values()) {
    rows.push({
      kind: "deliverables",
      label: `${count} ${
        count === 1 ? "submission is" : "submissions are"
      } waiting in ${await assignmentLabel(assignment)}.`,
      count,
      href: `/teacher/schedule/${assignment._id}`,
      verb: "Grade",
    });
  }

  const recentDigests: Doc<"classDigests">[] = [];
  for (const assignment of teacherAssignments) {
    if (!assignment.scholarIds.some((id) => scopedIds.has(String(id)))) {
      continue;
    }
    const digests = await ctx.db
      .query("classDigests")
      .withIndex("by_assignment_scope", (q) =>
        q.eq("assignmentId", assignment._id),
      )
      .collect();
    recentDigests.push(
      ...digests.filter(
        (digest) =>
          // Class-scope digests are keyed by (group, subject, period) and only
          // carry a REPRESENTATIVE assignmentId; they aren't assignment-inbox
          // items and have no activity/cohort digest route.
          digest.scope !== "class" &&
          digest.status === "ready" &&
          digest.generatedAt != null &&
          digest.generatedAt >= now - DAY_MS,
      ),
    );
  }
  recentDigests.sort(
    (a, b) => (b.generatedAt ?? 0) - (a.generatedAt ?? 0),
  );
  for (const digest of recentDigests) {
    if (digest.scope === "activity" && !digest.activityId) continue;
    const assignment = await assignmentFor(digest.assignmentId);
    if (
      !assignment ||
      assignment.teacherId !== user._id ||
      !assignment.scholarIds.some((id) => scopedIds.has(String(id)))
    ) {
      continue;
    }
    // Suppress a ready digest whose source watermark trails current source: a
    // later analysis / message has landed since it was generated, so its
    // headline may already be contradicted (the "cut off" beside "resolved"
    // case). Better to drop it than surface a stale claim; it returns once
    // regenerated. Legacy digests (no watermark) are unaffected.
    if (await digestWatermarkTrails(ctx, digest)) continue;
    const label =
      digest.headline ??
      `A class digest is ready for ${await assignmentLabel(assignment)}.`;
    const href =
      digest.scope === "cohort"
        ? `/teacher/digest?assignment=${assignment._id}&scope=cohort`
        : `/teacher/digest?assignment=${assignment._id}&activity=${digest.activityId}`;
    rows.push({
      kind: "digest",
      label,
      href,
      verb: "Read",
    });
  }

  return rows;
}

async function todaysPlanRows(
  ctx: QueryCtx,
  user: Doc<"users">,
  scholars: ScopedScholar[],
  institutionScope: string | undefined,
  timeZone: string,
) {
  const period = await currentReportingPeriod(
    ctx,
    user,
    institutionScope ?? "",
  );
  if (!period) return [];

  const grid = await coreGrid(ctx, period._id);
  const weekday = weekdayForTimezone(Date.now(), timeZone);
  if (weekday < 1 || weekday > 5) return [];
  // "Today" is the current week: a concrete chip (own weekStartMs) counts only in
  // its week; a recurring shell (null) every week. Without this a concrete chip
  // from another week reads as happening today (same rule as coreGrid/the grid).
  const currentWeek = currentWeekStartMs(Date.now(), timeZone);

  const scopedIds = new Set(scholars.map((scholar) => String(scholar._id)));
  const blockById = new Map(
    grid.blocks.map((block) => [String(block._id), block]),
  );
  const seen = new Set<string>();
  const rows: Array<{
    blockId: Id<"scheduleBlocks">;
    assignmentId: Id<"assignments">;
    activityId: Id<"activities">;
    label: string;
    startedCount: number;
    totalCount: number;
    href: string;
    verb: string;
    order: number;
  }> = [];

  for (const placement of grid.placements) {
    if (
      placement.onShelf ||
      placement.weekday !== weekday ||
      (placement.weekStartMs != null && placement.weekStartMs !== currentWeek) ||
      placement.mode === "homework" ||
      !placement.blockId ||
      !placement.assignmentId ||
      !placement.activityId
    ) {
      continue;
    }
    const key = `${placement.blockId}:${placement.assignmentId}:${placement.activityId}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const assignment = await ctx.db.get(placement.assignmentId);
    if (
      !assignment ||
      assignment.teacherId !== user._id ||
      !assignment.scholarIds.some((id) => scopedIds.has(String(id)))
    ) {
      continue;
    }
    const block = blockById.get(String(placement.blockId));
    if (!block) continue;
    const counts = await activityCounts(
      ctx,
      assignment._id,
      placement.activityId,
    );
    const scheduleEntry = (assignment.activitySchedule ?? []).find(
      (entry) => entry.activityId === placement.activityId,
    );
    const totalCount =
      scheduleEntry?.scholarIds && scheduleEntry.scholarIds.length > 0
        ? scheduleEntry.scholarIds.length
        : assignment.scholarIds.length;

    rows.push({
      blockId: placement.blockId,
      assignmentId: assignment._id,
      activityId: placement.activityId,
      label: `${block.label} · ${
        placement.activityTitle ?? placement.subject
      }`,
      startedCount: counts.startedCount,
      totalCount,
      href: `/teacher/schedule/${assignment._id}`,
      verb: "Open",
      order: block.order,
    });
  }

  rows.sort((a, b) => a.order - b.order || a.label.localeCompare(b.label));
  return rows.map(({ order: _order, ...row }) => row);
}

// ── The "Overnight" rail: a meaningful, stateless window ──────────────────
// The rail's real subject is "what piled up while the class was apart." A fixed
// clock ("overnight" / "since yesterday") is only true at the morning check-in,
// so it both over-claims (same-day work called "overnight") and under-shows
// (weekend work older than the window silently vanishes). Instead we anchor the
// window to the school's own rhythm and DERIVE the label, so it can never lie —
// with no stored "last seen," no schema, and no read-triggered write.
// Design: review/overnight-rail-plan.html (P2).

/** Epoch-ms of institution-local midnight for the day containing `now`. */
export function hstDayStart(now: number, timeZone?: string): number {
  return dayStartForTimezone(now, timeZone);
}

/** 0=Sun … 6=Sat for the institution-local day containing `dayStartMs`. */
export function hstWeekday(dayStartMs: number, timeZone?: string): number {
  return weekdayForTimezone(dayStartMs, timeZone);
}

/**
 * A true, self-derived phrase for how long ago the newest event in a row was —
 * never asserted from a clock the code didn't measure. This is the piece that
 * would have caught F1.
 */
export function recencyPhrase(
  latestAt: number,
  now: number,
  timeZone?: string,
): string {
  if (now - latestAt < RECENT_MS) return "just now";
  const today = hstDayStart(now, timeZone);
  if (latestAt >= today) return "earlier today";
  const yesterday = shiftDayStartForTimezone(today, -1, timeZone);
  if (latestAt >= yesterday) return "yesterday";
  // Looking back on a Sunday/Monday over a day or two → the gap is the weekend.
  const weekday = hstWeekday(today, timeZone);
  const threeDaysAgo = shiftDayStartForTimezone(today, -3, timeZone);
  if ((weekday === 0 || weekday === 1) && latestAt >= threeDaysAgo) {
    return "over the weekend";
  }
  return "in the last few days";
}

/** The honest lane title for a morning look-back of `gapDays`. */
export function overnightTitleForGap(gapDays: number, sawHoliday: boolean): string {
  if (sawHoliday) return "While you were out";
  return gapDays <= 1 ? "Overnight" : "Over the weekend";
}

/**
 * The rail's window start + honest lane title, derived from the school's own
 * rhythm rather than a fixed clock. Before today's first bell it reaches back to
 * the previous meeting day's dismissal (walking over weekends + closures); during
 * or after the day the window is simply "so far today." Stateless: a pure
 * function of `now` plus the schedule/closures already in the DB — no write.
 */
async function overnightAnchor(
  ctx: QueryCtx,
  institutionId: Id<"institutions"> | undefined,
  now: number,
  timeZone: string,
): Promise<{ since: number; title: string }> {
  const todayStart = hstDayStart(now, timeZone);
  const todayKey = dayKeyForTimezone(todayStart, timeZone);
  const firstBell = instantForLocalMinutes(
    todayKey,
    SCHOOL_START_LOCAL_MINUTES,
    timeZone,
  );

  // During or after the school day: the window is just "so far today."
  if (now >= firstBell) {
    return { since: todayStart, title: "So far today" };
  }

  // Early morning: walk back to the last day the class actually met — a weekday
  // (Mon–Fri) that isn't a closure — and anchor at its dismissal.
  let dayStart = shiftDayStartForTimezone(todayStart, -1, timeZone);
  let gapDays = 1;
  let sawHoliday = false;
  let found = false;
  for (let i = 0; i < 8; i += 1) {
    const weekday = hstWeekday(dayStart, timeZone);
    const isWeekend = weekday === 0 || weekday === 6;
    if (!isWeekend) {
      const dayKey = dayKeyForTimezone(dayStart, timeZone);
      const closed = await closureForInstitutionOnDay(
        ctx,
        institutionId,
        instantForLocalMinutes(dayKey, 12 * 60, timeZone),
      );
      if (!closed) {
        found = true;
        break; // this is the last meeting day
      }
      sawHoliday = true;
    }
    dayStart = shiftDayStartForTimezone(dayStart, -1, timeZone);
    gapDays += 1;
  }

  // Nothing met in the last week (e.g. a long break): fall back to the legacy
  // rolling window rather than reaching arbitrarily far back.
  if (!found) {
    return { since: now - OVERNIGHT_MS, title: "While you were out" };
  }

  const since = instantForLocalMinutes(
    dayKeyForTimezone(dayStart, timeZone),
    DISMISSAL_LOCAL_MINUTES,
    timeZone,
  );
  return { since, title: overnightTitleForGap(gapDays, sawHoliday) };
}

async function overnightRows(
  ctx: QueryCtx,
  institutionId: Id<"institutions"> | undefined,
  scholars: ScopedScholar[],
  now: number,
  timeZone: string,
): Promise<{
  title: string;
  rows: Array<{
    kind: "practice" | "frontier" | "misconceptions";
    label: string;
    href: string;
    verb: string;
  }>;
}> {
  const { since, title } = await overnightAnchor(
    ctx,
    institutionId,
    now,
    timeZone,
  );
  const scholarById = new Map(
    scholars.map((scholar) => [String(scholar._id), scholar]),
  );
  const rows: Array<{
    kind: "practice" | "frontier" | "misconceptions";
    label: string;
    href: string;
    verb: string;
  }> = [];

  const practiceScholarIds = new Set<string>();
  let practiceLatestAt = 0;
  for (const scholar of scholars) {
    const attempts = await ctx.db
      .query("practiceAttempts")
      .withIndex("by_scholar", (q) => q.eq("scholarId", scholar._id))
      .collect();
    let scholarHas = false;
    for (const attempt of attempts) {
      const at = attempt.createdAt ?? attempt._creationTime;
      if (at >= since) {
        scholarHas = true;
        practiceLatestAt = Math.max(practiceLatestAt, at);
      }
    }
    if (scholarHas) practiceScholarIds.add(String(scholar._id));
  }
  if (practiceScholarIds.size > 0) {
    rows.push({
      kind: "practice",
      label: `${practiceScholarIds.size} ${
        practiceScholarIds.size === 1 ? "scholar completed" : "scholars completed"
      } practice ${recencyPhrase(practiceLatestAt, now, timeZone)}.`,
      href: "/teacher/math-skills",
      verb: "See skills",
    });
  }

  let frontierMoves = 0;
  let frontierLatestAt = 0;
  const frontierScholarIds = new Set<string>();
  for (const scholar of scholars) {
    const mastery = await ctx.db
      .query("practiceMastery")
      .withIndex("by_scholar", (q) => q.eq("scholarId", scholar._id))
      .collect();
    for (const row of mastery) {
      if ((row.frontierAdvancedAt ?? 0) < since) continue;
      frontierMoves += 1;
      frontierScholarIds.add(String(scholar._id));
      frontierLatestAt = Math.max(frontierLatestAt, row.frontierAdvancedAt ?? 0);
    }
  }
  if (frontierMoves > 0) {
    rows.push({
      kind: "frontier",
      label: `${frontierMoves} frontier ${
        frontierMoves === 1 ? "move" : "moves"
      } landed across ${frontierScholarIds.size} ${
        frontierScholarIds.size === 1 ? "scholar" : "scholars"
      } ${recencyPhrase(frontierLatestAt, now, timeZone)}.`,
      href: "/teacher/math-skills",
      verb: "See skills",
    });
  }

  let newlyOpened = 0;
  let misconceptionLatestAt = 0;
  const flagScholarIds = new Set<string>();
  for (const scholar of scholars) {
    const errors = await ctx.db
      .query("practiceErrorEvents")
      .withIndex("by_scholar", (q) => q.eq("scholarId", scholar._id))
      .collect();
    const recent = errors.filter(
      (event) => event.createdAt >= now - ERROR_FLAG_WINDOW_MS,
    );
    const byNode = new Map<string, typeof recent>();
    for (const event of recent) {
      const list = byNode.get(event.nodeKey);
      if (list) list.push(event);
      else byNode.set(event.nodeKey, [event]);
    }
    for (const events of byNode.values()) {
      for (const open of openErrorPatterns(events, now)) {
        const matching = events
          .filter((event) => event.pattern === open.pattern)
          .sort((a, b) => a.createdAt - b.createdAt);
        if (
          matching.length >= ERROR_FLAG_MIN_COUNT &&
          matching[ERROR_FLAG_MIN_COUNT - 1].createdAt >= since
        ) {
          newlyOpened += 1;
          flagScholarIds.add(String(scholar._id));
          misconceptionLatestAt = Math.max(
            misconceptionLatestAt,
            matching[ERROR_FLAG_MIN_COUNT - 1].createdAt,
          );
        }
      }
    }
  }
  if (newlyOpened > 0) {
    const onlyScholar =
      flagScholarIds.size === 1
        ? scholarById.get([...flagScholarIds][0])
        : null;
    rows.push({
      kind: "misconceptions",
      label: `${newlyOpened} recurring misconception ${
        newlyOpened === 1 ? "signal opened" : "signals opened"
      } ${recencyPhrase(misconceptionLatestAt, now, timeZone)}.`,
      href: onlyScholar
        ? scholarHref(onlyScholar, "map")
        : "/teacher/math-skills",
      verb: onlyScholar ? "Open map" : "See skills",
    });
  }

  return { title, rows };
}

/** "Koa", "Koa and Lani", or "Koa, Lani, and Sam" — a natural name list. */
function joinNames(names: string[]): string {
  if (names.length === 0) return "";
  if (names.length === 1) return names[0];
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(", ")}, and ${names[names.length - 1]}`;
}

/**
 * Named outcomes for homework that was due by this morning — the homework whose
 * `dueAt` fell on the PRIOR open school day, joined per activity to the
 * canonical completion record (`homeworkForScholar`'s `completedByMe`). One row
 * per homework activity across the scope, naming who didn't finish (T10 — never
 * a bare count). The claim stays narrow (T7): "due yesterday," not a
 * reconstruction of last night's exact tonight list.
 */
async function homeworkOutcomeRows(
  ctx: QueryCtx,
  institutionId: Id<"institutions"> | undefined,
  scholars: ScopedScholar[],
  now: number,
  timeZone: string,
): Promise<
  Array<{ kind: "homework"; label: string; href: string; verb: string }>
> {
  if (!institutionId) return [];
  const todayKey = dayKeyForTimezone(now, timeZone);
  const prevKey = await prevOpenSchoolDayKey(
    ctx,
    institutionId,
    todayKey,
    timeZone,
  );
  if (!prevKey) return [];

  const byActivity = new Map<
    string,
    {
      assignmentId: Id<"assignments">;
      title: string;
      done: string[];
      notDone: string[];
    }
  >();
  // Collect assignments ONCE and partition per scholar, so each scholar's
  // homework is enriched exactly once rather than via a per-scholar full scan.
  const allAssignments = await ctx.db.query("assignments").collect();
  const byScholar = homeworkAssignmentsByScholar(
    allAssignments,
    scholars.map((s) => s._id),
  );
  for (const scholar of scholars) {
    const homework = await homeworkForScholarFromAssignments(
      ctx,
      scholar._id,
      byScholar.get(String(scholar._id)) ?? [],
      now,
    );
    for (const item of homework) {
      if (
        item.dueAt == null ||
        dayKeyForTimezone(item.dueAt, timeZone) !== prevKey
      ) {
        continue;
      }
      const key = `${item.assignmentId}:${item.activityId}`;
      let agg = byActivity.get(key);
      if (!agg) {
        agg = {
          assignmentId: item.assignmentId,
          title: item.activityTitle ?? "the homework",
          done: [],
          notDone: [],
        };
        byActivity.set(key, agg);
      }
      (item.completedByMe ? agg.done : agg.notDone).push(scholarName(scholar));
    }
  }

  const rows: Array<{
    kind: "homework";
    label: string;
    href: string;
    verb: string;
  }> = [];
  for (const agg of byActivity.values()) {
    const total = agg.done.length + agg.notDone.length;
    if (total === 0) continue;
    const base = `${agg.done.length} of ${total} finished last night's ${agg.title}`;
    const label =
      agg.notDone.length === 0
        ? `${base}.`
        : `${base}; ${joinNames(agg.notDone)} didn't.`;
    rows.push({
      kind: "homework",
      label,
      href: `/teacher/schedule/${agg.assignmentId}`,
      verb: "Open",
    });
  }
  return rows;
}

/**
 * Groups the teacher can see (in the active lens) that run Scholar's Prep — i.e.
 * carry a `prepTime` participation entry — paired with the institution's
 * canonical bell-schedule window. Move 5: the group entry is participation only;
 * WHEN comes from the schedule (convex/lib/prepBlock.ts), so the Today prep row
 * reads the same clock the scholar pin and RosterBoard do. The CLIENT still owns
 * the window math (isWithinPrepWindow on a timer — no cron), so this just hands
 * back the window config for the row to appear only during the window.
 */
async function prepWindowGroups(
  ctx: QueryCtx,
  user: Doc<"users">,
  institutionScope: string | undefined,
): Promise<
  Array<{
    groupId: Id<"scholarGroups">;
    name: string;
    startLocal: string;
    endLocal: string;
    days: number[];
    timezone: string;
  }>
> {
  const lens = await resolveInstitutionLens(ctx, user, institutionScope ?? "");
  const groups = (await ctx.db.query("scholarGroups").collect()).filter((g) =>
    institutionIdInLens(lens, g.institutionId),
  );
  const out: Array<{
    groupId: Id<"scholarGroups">;
    name: string;
    startLocal: string;
    endLocal: string;
    days: number[];
    timezone: string;
  }> = [];
  // One canonical window per institution — cache so N pods in a school resolve it
  // once.
  const windowCache = new Map<string, DailyBlock | null>();
  for (const g of groups) {
    const participates = (g.dailyBlocks ?? []).some(
      (b) => b.key === PREP_TIME_KEY,
    );
    if (!participates || !g.institutionId) continue;
    const key = String(g.institutionId);
    let win = windowCache.get(key);
    if (win === undefined) {
      win = await canonicalPrepWindow(ctx, g.institutionId);
      windowCache.set(key, win);
    }
    if (!win) continue;
    out.push({
      groupId: g._id,
      name: g.name,
      startLocal: win.startLocal,
      endLocal: win.endLocal,
      days: win.days,
      timezone: win.timezone,
    });
  }
  return out;
}
export const todayForTeacher = teacherQuery({
  args: {
    institutionScope: v.optional(v.string()),
    // A minute-rounded client clock — the reactive dependency that re-runs the
    // query across an institution-local midnight (so the morning-after homework
    // outcome and every other time-derived lane can't go stale; T11). Optional
    // for back-compat; falls back to server time when omitted.
    now: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const now = args.now ?? Date.now();
    // No-school day? Suppress the schedule-derived "Today's plan" rail and hand
    // the client a closure so it can show a "No School — <label>" banner. The
    // other rails (needs-a-look, waiting-on-you, overnight) reflect scholar work
    // states that stand independent of today's bell schedule, so they stay.
    const lens = await resolveInstitutionLens(ctx, ctx.user, args.institutionScope ?? "");
    const institution = lens.institution ?? lens.primaryInstitution;
    const institutionId = institution?._id;
    const timeZone = effectiveInstitutionTimeZone(institution?.timeZone);
    const closure = await closureForInstitutionOnDay(ctx, institutionId, now);
    const scholars = await scopedScholars(
      ctx,
      ctx.user,
      args.institutionScope,
    );

    const [needsALook, waitingOnYou, todaysPlan, overnight, birthdays, homeworkOutcome, prepGroups] =
      await Promise.all([
        needsALookRows(ctx, scholars, now),
        waitingOnYouRows(ctx, ctx.user, scholars, now),
        closure
          ? Promise.resolve([] as Awaited<ReturnType<typeof todaysPlanRows>>)
          : todaysPlanRows(
              ctx,
              ctx.user,
              scholars,
              args.institutionScope,
              timeZone,
            ),
        overnightRows(ctx, institutionId, scholars, now, timeZone),
        todaysBirthdayEntries(ctx, scholars, now),
        homeworkOutcomeRows(ctx, institutionId, scholars, now, timeZone),
        prepWindowGroups(ctx, ctx.user, args.institutionScope),
      ]);

    return {
      needsALook,
      waitingOnYou,
      todaysPlan,
      // Homework outcomes lead the overnight lane — the most concrete "what
      // happened with the assigned work" read (T7/T10, named).
      overnight: [...homeworkOutcome, ...overnight.rows],
      overnightTitle: overnight.title,
      closure,
      birthdays,
      // The prep-window link row. Move 5: the group entry decides which pods run
      // the ritual; the WINDOW is the institution's bell-schedule prep block
      // (convex/lib/prepBlock.ts). The client owns the window math.
      prepGroups,
    };
  },
});
