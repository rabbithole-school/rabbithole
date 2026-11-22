// Device activity (screen-time telemetry): the write path the iPad batches
// into, and the staff-only roll-up read on top of it.
//
// The table's shape, why each field is server-derived, and the tenancy posture
// live on `deviceActivityEvents` in convex/schema.ts. The two pure rules this
// file orchestrates live where they can be tested without a backend:
//   • shared/deviceActivityContext.ts — the core_day / extended_ed / homework /
//     unknown tag stamped on every row at write time.
//   • shared/deviceActivityRollup.ts  — measured-vs-estimated attribution,
//     including the founder's data-cleaning rule for an external launch that
//     never came back.
//
//   • shared/screenTime.ts            — interval arithmetic, day clipping, and
//     the "active near a turn" windows `dailyUsage` uses to say where the
//     foreground time went (the scholar's own app, web activities, the rest).
//
// PARENTS NEVER READ THIS. The read surfaces here are `dailyUsage`, gated by
// `scholarAdminQuery` (teacher / school_admin / platform_admin / operations
// staff) and scoped by the institution lens — the same pair the native-client
// rollout inventory uses — and `dailyUsageForAide`, the staff assistant's
// one-scholar twin, which runs the identical gate through
// `readDailyUsageForCaller`. There is deliberately no scholar-facing or
// parent-facing query in this file.

import { v } from "convex/values";
import { readSchedule } from "./lib/scheduleStore";
import { authedMutation, scholarAdminQuery } from "./lib/customFunctions";
import { internalQuery } from "./_generated/server";
import { requireScholarAdminFor } from "./lib/auth";
import type { SchoolOperationsPrincipal } from "./lib/staffCapabilities";
import {
  resolveInstitutionLens,
  scholarIdsInLens,
  scholarInLens,
  scholarInstitutionReadableInLens,
} from "./lib/institutionLens";
import { canReadScholarAsTeacher } from "./lib/access";
import { markScreenTimeDirty } from "./lib/screenTimeDirty";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import {
  DEFAULT_TIMEZONE,
  dayKeyForTimezone,
  dayStartForDayKey,
  instantForLocalMinutes,
  minuteOfDayForTimezone,
  shiftDayKey,
  weekdayForDayKey,
} from "../shared/institutionDay";
import { appPlayDurationMs } from "../shared/appPlaySession";
import {
  ACTIVE_TURN_CAP_MS,
  WEB_ACTIVITY_SESSION_CAP_MS,
  activeWindowsFromTurns,
  clipInterval,
  intersectIntervals,
  mergeIntervals,
  overlapMs,
  splitIntervalByDay,
  totalMs,
  webActivitySessionInterval,
  type Interval,
} from "../shared/screenTime";
import { isClosedDay } from "../shared/schoolClosures";
import {
  DEFAULT_SCHOOL_DAY_WINDOW,
  deriveDeviceActivityContext,
  schoolDayWindowFromBlocks,
  type DeviceActivityContext,
  type SchoolDayWindow,
} from "../shared/deviceActivityContext";
import {
  asamTransitionReasonValidator,
  deviceActivityKindValidator,
} from "./lib/deviceActivityValidators";
import {
  msToMinutes,
  rollupDeviceActivityDay,
  type RollupEvent,
} from "../shared/deviceActivityRollup";
import {
  PRACTICE_ATTEMPT_LEAD_CAP_MS,
  classifyDayStretches,
  kindMinutesAtBell,
  practiceWindowsFromAttempts,
  type DetailedInterval,
  type Stretch,
  type StretchKind,
} from "../shared/screenTimeStretches";
import {
  createScreenTimeLabeler,
  type ScreenTimeLabeler,
} from "./lib/screenTimeLabels";

/** One flush carries at most this many events; the client caps its own queue. */
export const MAX_EVENTS_PER_BATCH = 200;

/**
 * How far a client clock may disagree with the server before its event is
 * refused. A supervised iPad is NTP-synced, so a wilder timestamp is a broken
 * clock or a replay — and either would land minutes in the wrong day bucket.
 * Generous in the past (an offline queue draining after a long weekend is
 * legitimate), tight in the future (nothing legitimate happens there).
 */
export const MAX_CLIENT_CLOCK_PAST_MS = 7 * 24 * 60 * 60 * 1000;
export const MAX_CLIENT_CLOCK_FUTURE_MS = 60 * 60 * 1000;

/**
 * How recently a session must have seen activity to count as "the active
 * session" for the homework tag. A first cut, and deliberately a coarse one:
 * the batch is tagged from the scholar's most recent session rather than
 * per-event, so an event mid-batch is attributed to the work the scholar was
 * demonstrably doing around then.
 */
const ACTIVE_SESSION_RECENCY_MS = 2 * 60 * 60 * 1000;

function normalizedDeviceId(deviceId: string): string {
  const normalized = deviceId.trim();
  if (normalized.length < 6 || normalized.length > 200) {
    throw new Error("Invalid device id.");
  }
  return normalized;
}

/**
 * The tenant this device's activity belongs to. Mirrors
 * nativeClientHeartbeat.record: a paired-device binding wins (an adult whose
 * home role is elsewhere may still be bound to a school iPad), otherwise the
 * user's own institution. Never taken from the client.
 */
async function institutionForUserDevice(
  ctx: MutationCtx,
  userId: Id<"users">,
  user: Doc<"users">,
  deviceId: string,
): Promise<Id<"institutions"> | undefined> {
  const bindings = await ctx.db
    .query("pairedDevices")
    .withIndex("by_device_id", (q) => q.eq("deviceId", deviceId))
    .collect();
  const binding = bindings.find((b) => b.scholarId === userId) ?? null;
  return binding?.institutionId ?? user.institutionId;
}

/**
 * The school-day wall-clock window for one institution-local weekday, taken
 * from the bell schedule (`scheduleBlocks`) of whichever term covers the day.
 * Falls back to DEFAULT_SCHOOL_DAY_WINDOW when the school has not built a
 * Master Schedule — a documented default beats refusing to tag anything.
 */
async function schoolDayWindowFor(
  ctx: QueryCtx | MutationCtx,
  institutionId: Id<"institutions"> | undefined,
  atMs: number,
  weekday: number,
): Promise<SchoolDayWindow | null> {
  if (weekday < 1 || weekday > 5) return null;
  const periods = institutionId
    ? await ctx.db
        .query("reportingPeriods")
        .withIndex("by_institution", (q) => q.eq("institutionId", institutionId))
        .collect()
    : await ctx.db.query("reportingPeriods").collect();
  const period = periods.find((p) => p.startsAt <= atMs && atMs <= p.endsAt);
  if (!period) return DEFAULT_SCHOOL_DAY_WINDOW;
  const blocks = await ctx.db
    .query("scheduleBlocks")
    .withIndex("by_period", (q) => q.eq("periodId", period._id))
    .collect();
  return schoolDayWindowFromBlocks(blocks, weekday) ?? DEFAULT_SCHOOL_DAY_WINDOW;
}

/**
 * Institution-scoped closures PLUS the global ones (institutionId absent =
 * applies to every school; see the schoolClosures table comment).
 */
async function schoolClosuresFor(
  ctx: QueryCtx | MutationCtx,
  institutionId: Id<"institutions"> | undefined,
): Promise<Doc<"schoolClosures">[]> {
  return [
    ...(institutionId
      ? await ctx.db
          .query("schoolClosures")
          .withIndex("by_institution", (q) =>
            q.eq("institutionId", institutionId),
          )
          .collect()
      : []),
    ...(await ctx.db
      .query("schoolClosures")
      .withIndex("by_institution", (q) => q.eq("institutionId", undefined))
      .collect()),
  ];
}

/**
 * Whether the scholar's most recent session is working a homework-mode
 * activity. `null` = not known (no recent session, or no assignment placement
 * for it) — which the tag rule treats as "homework is off the table", never as
 * "known to be classwork".
 */
async function activeSessionIsHomework(
  ctx: MutationCtx,
  userId: Id<"users">,
  atMs: number,
): Promise<boolean | null> {
  const session = await ctx.db
    .query("sessions")
    .withIndex("by_user_last_message", (q) => q.eq("userId", userId))
    .order("desc")
    .first();
  if (!session || !session.assignmentId || !session.activityId) return null;
  const lastActiveAt = session.lastMessageAt ?? session._creationTime;
  if (Math.abs(atMs - lastActiveAt) > ACTIVE_SESSION_RECENCY_MS) return null;
  const assignment = await ctx.db.get(session.assignmentId);
  if (!assignment) return null;
  const placement = (await readSchedule(ctx, assignment)).find(
    (entry) => entry.activityId === session.activityId,
  );
  if (!placement) return null;
  return placement.mode === "homework";
}

/**
 * Batched, offline-tolerant ingest from an authenticated client.
 *
 * Never throws on a single bad event — a telemetry write must not be able to
 * break the app that emits it, and a client draining a stale queue should not
 * have the whole flush rejected over one row. Out-of-range timestamps and
 * over-cap batches are dropped and counted in the return value instead.
 */
export const record = authedMutation({
  args: {
    deviceId: v.string(),
    events: v.array(
      v.object({
        kind: deviceActivityKindValidator,
        externalAppId: v.optional(v.id("externalApps")),
        clientAt: v.number(),
        durationMs: v.optional(v.number()),
        reason: v.optional(asamTransitionReasonValidator),
        ok: v.optional(v.boolean()),
      }),
    ),
  },
  handler: async (ctx, args) => {
    const deviceId = normalizedDeviceId(args.deviceId);
    const now = Date.now();
    const accepted = args.events
      .slice(0, MAX_EVENTS_PER_BATCH)
      .filter(
        (event) =>
          Number.isFinite(event.clientAt) &&
          event.clientAt >= now - MAX_CLIENT_CLOCK_PAST_MS &&
          event.clientAt <= now + MAX_CLIENT_CLOCK_FUTURE_MS,
      );
    if (accepted.length === 0) {
      return { recorded: 0, dropped: args.events.length };
    }

    const institutionId = await institutionForUserDevice(
      ctx,
      ctx.user._id,
      ctx.user,
      deviceId,
    );
    const institution = institutionId ? await ctx.db.get(institutionId) : null;
    const timeZone = institution?.timeZone ?? DEFAULT_TIMEZONE;
    const closures = await schoolClosuresFor(ctx, institutionId);
    // One homework read per batch, not per event — see ACTIVE_SESSION_RECENCY_MS.
    const isHomeworkSession = await activeSessionIsHomework(
      ctx,
      ctx.user._id,
      accepted[accepted.length - 1].clientAt,
    );

    // Bell schedules are per weekday, and a batch rarely spans more than one
    // day, so resolve each distinct (dayKey, weekday) once.
    const windowByDayKey = new Map<string, SchoolDayWindow | null>();

    for (const event of accepted) {
      const dayKey = dayKeyForTimezone(event.clientAt, timeZone);
      const weekday = weekdayForDayKey(dayKey);
      // weekdayForDayKey is 0=Sun…6=Sat; scheduleBlocks.weekdays is 1=Mon…7=Sun.
      const scheduleWeekday = weekday === 0 ? 7 : weekday;
      if (!windowByDayKey.has(dayKey)) {
        windowByDayKey.set(
          dayKey,
          await schoolDayWindowFor(
            ctx,
            institutionId,
            event.clientAt,
            scheduleWeekday,
          ),
        );
      }
      const context: DeviceActivityContext = deriveDeviceActivityContext({
        enrollmentStanding: ctx.user.enrollmentStanding,
        isHomeworkSession,
        weekday: scheduleWeekday,
        isClosedDay: isClosedDay(dayKey, closures) !== null,
        minuteOfDay: minuteOfDayForTimezone(event.clientAt, timeZone),
        schoolDayWindow: windowByDayKey.get(dayKey) ?? null,
      });

      await ctx.db.insert("deviceActivityEvents", {
        userId: ctx.user._id,
        institutionId,
        deviceId,
        kind: event.kind,
        externalAppId: event.externalAppId,
        clientAt: event.clientAt,
        durationMs:
          event.durationMs !== undefined && Number.isFinite(event.durationMs)
            ? Math.max(0, event.durationMs)
            : undefined,
        reason: event.reason,
        ok: event.ok,
        receivedAt: now,
        dayKey,
        context,
      });
    }

    // The screen-time summary for each day this batch touched is now stale.
    for (const dayKey of windowByDayKey.keys()) {
      await markScreenTimeDirty(ctx, ctx.user._id, dayKey, institutionId);
    }

    return {
      recorded: accepted.length,
      dropped: args.events.length - accepted.length,
    };
  },
});

/** Hard ceiling on one read, so a wide range cannot become an unbounded scan. */
export const MAX_ROLLUP_DAYS = 31;
/**
 * A whole-school read is capped tighter than one scholar's. Each day of a
 * school of a dozen scholars is about 1,600 device events plus the builder
 * turns inside its play intervals; 14 days stays well inside Convex's
 * per-query document limit, and 31 would not. One scholar's read takes the
 * full MAX_ROLLUP_DAYS.
 */
export const MAX_SCHOOL_ROLLUP_DAYS = 14;
export const MAX_ROLLUP_ROWS = 20_000;

/**
 * How long before the first requested day an `appPlaySessions` row may have
 * started and still be read, so an app put on screen the evening before and
 * left there past midnight clips into the first day. A play row closes after a
 * few silent minutes (APP_PLAY_STALE_GAP_MS), so a row longer than this is a
 * host that heartbeated all night.
 */
export const APP_PLAY_LOOKBACK_MS = 12 * 60 * 60 * 1000;

export type ScholarDayUsage = {
  scholarId: Id<"users">;
  /** Resolved for the staff table; this surface is never parent-facing. */
  scholarName: string;
  dayKey: string;
  /** Rabbithole itself in the foreground. Always measured, never estimated. */
  foregroundMinutes: number;
  /** Per teacher-authorized app, measured and estimated kept apart. */
  apps: {
    externalAppId: string;
    appName: string;
    measuredMinutes: number;
    estimatedMinutes: number;
    estimatedIntervals: number;
  }[];
  unattributedBackgroundMinutes: number;
  measuredMinutes: number;
  estimatedMinutes: number;
  /** How many launch intervals were capped rather than measured. */
  estimatedIntervals: number;
  byContext: Record<
    string,
    { measuredMinutes: number; estimatedMinutes: number }
  >;
  eventCount: number;
  /** Minutes outside school hours by the CLOCK: not an open school day, or outside the bell-schedule window. Measured time is split at the bell; an estimate counts by the clock at its launch. Ignores the stored homework/extended_ed tag on purpose. `foregroundMinutes` is the part of `foregroundMinutes` (Rabbithole itself on screen) outside school, split at the bell the same way; `measuredMinutes` also counts measured time in launched apps. */
  outsideSchool: {
    measuredMinutes: number;
    estimatedMinutes: number;
    foregroundMinutes: number;
  };
  /** The scholar's own app on screen (appPlaySessions), clipped to this day. activeMinutes = the part near the scholar's own turns in that session (see helper). */
  builder: { onScreenMinutes: number; activeMinutes: number };
  /** webActivitySessions (launcher web activities like Epic), clipped to this day. */
  webActivityMinutes: number;
  /** Rabbithole foreground on the iPad that no builder interval or web activity overlaps. Builder or web time on a laptop overlaps none of it, so with laptop use the parts can sum past foregroundMinutes. */
  otherRabbitholeMinutes: number;
  /** An open school day for this scholar's school (a weekday with a bell schedule, not closed). */
  schoolDay: boolean;
  /**
   * Only on a one-day read asked for with `{ timeline: true }`: the day's
   * measured BunnyPad time split into typed stretches
   * (shared/screenTimeStretches.ts), and the school-hours window for shading.
   * Timings only; no message or answer content.
   */
  timeline?: DayTimeline;
};

export type DayTimeline = {
  stretches: Stretch[];
  /** Own app on screen with nothing measured (no touches): hatched, never counted. */
  leftOpen: Interval[];
  minutesByKind: Record<StretchKind, number>;
  totalMinutes: number;
  schoolHours: Interval[];
};

/** What the clock alone says about one institution-local day. */
type ClockDay = {
  timeZone: string;
  /** 1=Mon … 7=Sun, matching `scheduleBlocks.weekdays`. */
  weekday: number;
  isClosedDay: boolean;
  schoolDayWindow: SchoolDayWindow | null;
};

/** The non-device sources of one scholar-day, as raw intervals. */
type ScholarDaySources = {
  builderOnScreen: DetailedInterval[];
  builderActive: DetailedInterval[];
  web: DetailedInterval[];
  /** Read only for a timeline: windows around tutor turns and practice attempts. */
  chat: DetailedInterval[];
  practice: DetailedInterval[];
};

/** The most sessions one scholar's timeline reads for tutor turns. */
export const TIMELINE_SESSION_READ_CAP = 60;

export type ReadUsageOptions = {
  /**
   * Also classify each scholar-day into typed stretches. One day only: it
   * reads every tutor turn and practice attempt in range, which a whole-school
   * week would not fit in one query.
   */
  timeline?: boolean;
  /**
   * With `timeline`, also name what each stretch was (the app, the activity,
   * the skill). Default true. The screen-time summary needs only the kinds,
   * so it skips the title reads.
   */
  timelineDetails?: boolean;
};

/**
 * Staff-only schoolwide roll-up: one row per scholar per school day, with
 * measured and estimated minutes reported SEPARATELY at every level.
 *
 * `estimatedMinutes` is not a worse kind of measurement — it is the honest
 * label on an interval where the data is not available (an external app the
 * iPad never came back from). A surface built on this should show both numbers
 * and never add them into one figure that implies more certainty than exists.
 *
 * Each row also says where the time went, from three more sources:
 *   • outsideSchool — the device minutes the CLOCK puts outside school hours.
 *   • builder       — the scholar's own app on screen (`appPlaySessions`), and
 *                     the part of that near their own turns in its session.
 *   • webActivityMinutes — launcher web activities (`webActivitySessions`).
 * A scholar-day appears when any source has time, so a day spent only in a
 * web activity is still a row (with zero device minutes).
 */
export const dailyUsage = scholarAdminQuery({
  args: {
    institutionScope: v.optional(v.string()),
    startDayKey: v.string(),
    endDayKey: v.string(),
    /** Optional narrowing to one scholar; still institution-gated. */
    scholarId: v.optional(v.id("users")),
  },
  handler: async (ctx, args): Promise<ScholarDayUsage[]> =>
    await readDailyUsageForCaller(ctx, ctx.user, args),
});

/**
 * School › Screen time's day strip: every scholar's measured BunnyPad time on
 * ONE day, split into typed stretches (app building, playing their own app,
 * chat, math practice, web activity, another app, the rest of Rabbithole).
 * The same gate and scope as `dailyUsage`; a whole-school read is one day
 * because it also reads each scholar's tutor turns and practice attempts.
 * Timings only: no message or answer content leaves this query.
 */
export const dayTimeline = scholarAdminQuery({
  args: {
    institutionScope: v.optional(v.string()),
    dayKey: v.string(),
  },
  handler: async (ctx, args) => {
    const dayKey = args.dayKey.trim();
    const lens = await resolveInstitutionLens(
      ctx,
      ctx.user,
      args.institutionScope ?? "",
    );
    const clockInstitution = lens.institution ?? lens.primaryInstitution;
    const rows = await readDailyUsageForCaller(
      ctx,
      ctx.user,
      {
        institutionScope: args.institutionScope,
        startDayKey: dayKey,
        endDayKey: dayKey,
      },
      { timeline: true },
    );
    return {
      dayKey,
      timeZone: clockInstitution?.timeZone ?? DEFAULT_TIMEZONE,
      scholars: rows
        .map((row) => ({
          scholarId: row.scholarId,
          scholarName: row.scholarName,
          timeline: row.timeline ?? null,
        }))
        .sort((a, b) => a.scholarName.localeCompare(b.scholarName)),
    };
  },
});

/**
 * The staff screen-time read, for one authorized caller: `dailyUsage`'s whole
 * gate and scope. The staff page calls it through `dailyUsage`; the staff
 * assistant (Slack, in-app aide, MCP) calls it through `dailyUsageForAide`, one
 * scholar at a time. One function, so the two can never disagree about who may
 * see which minutes.
 */
export async function readDailyUsageForCaller(
  ctx: QueryCtx,
  caller: SchoolOperationsPrincipal,
  args: {
    institutionScope?: string;
    startDayKey: string;
    endDayKey: string;
    scholarId?: Id<"users">;
  },
  options: ReadUsageOptions = {},
): Promise<ScholarDayUsage[]> {
  const startDayKey = args.startDayKey.trim();
  const endDayKey = args.endDayKey.trim();
  assertDayRange(
    startDayKey,
    endDayKey,
    args.scholarId ? MAX_ROLLUP_DAYS : MAX_SCHOOL_ROLLUP_DAYS,
  );

  // Per-scholar narrowing is checked against the caller's TEACHER-role
  // memberships as well as the lens, so an operations staffer cannot widen
  // their reach by naming a scholar directly.
  const scholarId = args.scholarId;
  if (scholarId && !(await canReadScholarAsTeacher(ctx, caller, scholarId))) {
    return [];
  }

  const lens = await resolveInstitutionLens(
    ctx,
    caller,
    args.institutionScope ?? "",
  );
  const institutionIds = lensInstitutionIds(lens);
  return await readScholarDayUsage(
    ctx,
    {
      institutionIds,
      scholarIds: scholarId ? [scholarId] : null,
      roster: () =>
        scholarIdsInLens(ctx, lens, { includeProgramGuests: true }),
      scholarAllowed: (scholar) => scholarInLens(ctx, lens, scholar),
      playInstitutionAllowed: (institutionId) =>
        scholarInstitutionReadableInLens(lens, institutionId),
      primaryInstitutionId: lens.primaryInstitution?._id,
      fallbackInstitutionId: lens.primaryInstitution?._id,
    },
    startDayKey,
    endDayKey,
    options,
  );
}

/**
 * How many days the staff assistant reads when the asker names no range: the
 * two weeks ending today, institution-local.
 */
export const AIDE_DEFAULT_USAGE_DAYS = 14;

/**
 * One scholar's screen-time days for the staff assistant
 * (`get_scholar_screen_time`, lib/screenTimeTools.ts). The same gate as the
 * staff page: the caller must be a scholar admin (`requireScholarAdminFor`,
 * the agent twin of `scholarAdminQuery`), and `readDailyUsageForCaller`
 * re-checks teacher standing for the named scholar and the institution lens.
 * Parents and scholars never reach it. Always ONE scholar: a whole-school
 * read over two weeks can pass the per-query read limit, so the tool fans out
 * one query per scholar instead.
 */
export const dailyUsageForAide = internalQuery({
  args: {
    callerUserId: v.id("users"),
    scholarId: v.id("users"),
    /** The assistant's selected institution lens, as the staff page takes it. */
    institutionScope: v.optional(v.string()),
    startDayKey: v.optional(v.string()),
    endDayKey: v.optional(v.string()),
    /**
     * On a one-day read, also return the Day view's typed stretches
     * (`dayTimeline`'s classifier, with labels). Ignored for a longer range.
     */
    timeline: v.optional(v.boolean()),
  },
  handler: async (ctx, args): Promise<AideUsageRead> => {
    const caller = await ctx.db.get(args.callerUserId);
    if (!caller) throw new Error("Not authenticated");
    const principal = await requireScholarAdminFor(ctx, caller);
    const institutionScope = args.institutionScope ?? "";
    const lens = await resolveInstitutionLens(ctx, principal, institutionScope);
    const scholar = await ctx.db.get(args.scholarId);
    // The scholar's school clock decides "today", as it decides the rollup's
    // days: their own institution, else the primary school's (the rollup's
    // fallback), never the caller's account stamp.
    const clockInstitutionId =
      scholar?.institutionId ?? lens.primaryInstitution?._id;
    const clockInstitution = clockInstitutionId
      ? await ctx.db.get(clockInstitutionId)
      : null;
    const timeZone = clockInstitution?.timeZone ?? DEFAULT_TIMEZONE;
    // t11-ok: internal query called once per aide tool call from an action; never subscribed
    const today = dayKeyForTimezone(Date.now(), timeZone);
    const endDayKey = args.endDayKey?.trim() || today;
    const startDayKey =
      args.startDayKey?.trim() ||
      shiftDayKey(endDayKey, -(AIDE_DEFAULT_USAGE_DAYS - 1));
    // Say "not yours" apart from "no data": readDailyUsageForCaller answers
    // both with no rows, and the model must not report a stranger as idle.
    // Readable means exactly what that read would admit: teacher standing
    // for the scholar AND the scholar inside the selected lens.
    // A platform admin's all-schools lens admits any stamp, including a
    // suspended school's; `allowedInstitutionIds` holds only live schools,
    // so require it there (the device rows are filtered by it already, the
    // builder and web sessions are not).
    const liveForAdminLens =
      !(lens.scope === "all" && lens.isAdmin) ||
      (clockInstitutionId !== undefined &&
        lens.allowedInstitutionIds.has(clockInstitutionId));
    const readable =
      scholar !== null &&
      (await scholarInLens(ctx, lens, scholar)) &&
      liveForAdminLens &&
      (await canReadScholarAsTeacher(ctx, principal, args.scholarId));
    if (!readable) {
      return { readable: false as const, startDayKey, endDayKey, timeZone, days: [] };
    }
    const oneDayTimeline = args.timeline === true && startDayKey === endDayKey;
    const rows = await readDailyUsageForCaller(
      ctx,
      principal,
      { institutionScope, scholarId: args.scholarId, startDayKey, endDayKey },
      oneDayTimeline ? { timeline: true } : {},
    );
    // Minutes by activity type: from the day's own timeline when one was
    // read, else from the per-scholar-day summary rows (screenTimeDays.ts),
    // which the same classifier wrote. Only rows at a school this read
    // admits, mirroring `readDailyUsageForCaller`'s institution scope.
    const summaryKinds = new Map<string, DayKinds>();
    if (!oneDayTimeline && rows.length > 0) {
      const institutionIds = new Set<string>(lensInstitutionIds(lens));
      const summaries = await ctx.db
        .query("screenTimeDays")
        .withIndex("by_scholar_day", (q) =>
          q
            .eq("scholarId", args.scholarId)
            .gte("dayKey", startDayKey)
            .lte("dayKey", endDayKey),
        )
        .collect();
      for (const summary of summaries) {
        if (!institutionIds.has(summary.institutionId)) continue;
        const earlier = summaryKinds.get(summary.dayKey);
        summaryKinds.set(
          summary.dayKey,
          earlier ? addDayKinds(earlier, summary.kinds) : summary.kinds,
        );
      }
    }
    const days = rows.map((row) => {
      const kinds = row.timeline
        ? kindMinutesAtBell(row.timeline.stretches, row.timeline.schoolHours)
        : summaryKinds.get(row.dayKey);
      return kinds ? { ...row, kinds } : row;
    });
    return { readable: true as const, startDayKey, endDayKey, timeZone, days };
  },
});

/** Measured minutes by stretch kind, split at the bell (the summary's `kinds`). */
export type DayKinds = {
  inSchool: Record<StretchKind, number>;
  outside: Record<StretchKind, number>;
};

/** What `dailyUsageForAide` returns. */
export type AideUsageRead = {
  readable: boolean;
  startDayKey: string;
  endDayKey: string;
  timeZone: string;
  days: (ScholarDayUsage & { kinds?: DayKinds })[];
};

function addDayKinds(a: DayKinds, b: DayKinds): DayKinds {
  const add = (x: Record<StretchKind, number>, y: Record<StretchKind, number>) =>
    Object.fromEntries(
      Object.keys(x).map((kind) => [
        kind,
        Math.round(
          (x[kind as StretchKind] + (y[kind as StretchKind] ?? 0)) * 10,
        ) / 10,
      ]),
    ) as Record<StretchKind, number>;
  return { inSchool: add(a.inSchool, b.inSchool), outside: add(a.outside, b.outside) };
}

/** The schools a staff screen-time read covers under one lens. */
function lensInstitutionIds(
  lens: Awaited<ReturnType<typeof resolveInstitutionLens>>,
): Id<"institutions">[] {
  return lens.scope === "all"
    ? [...lens.allowedInstitutionIds]
    : lens.institution && lens.allowedInstitutionIds.has(lens.institution._id)
      ? [lens.institution._id]
      : [];
}

/**
 * Who a screen-time read may see. The staff query builds it from the caller's
 * institution lens; the Friday class recap builds it from one class at one
 * school. Every tenancy decision in `readScholarDayUsage` goes through it.
 */
export type ScholarUsageScope = {
  institutionIds: Id<"institutions">[];
  /** Read exactly these scholars, each from their own index. Null scans the institutions. */
  scholarIds: Id<"users">[] | null;
  /** On a scan, the scholars whose builder and web time to read (so a web-only day is a row). */
  roster: () => Promise<Iterable<Id<"users">>>;
  scholarAllowed: (scholar: Doc<"users">) => boolean | Promise<boolean>;
  playInstitutionAllowed: (institutionId: Id<"institutions">) => boolean;
  /**
   * The school an unstamped app play belongs to. A play inherits its
   * session's stamp, and an unstamped session is the primary school's
   * (`scholarInstitutionReadableInLens`), so an unstamped play is judged as
   * the primary school's — never waved through (TRA-637).
   */
  primaryInstitutionId: Id<"institutions"> | undefined;
  /** Time zone source for a scholar with no institution of their own. */
  fallbackInstitutionId: Id<"institutions"> | undefined;
};

/** Day keys checked, ordered, and within `maxDays`. */
export function assertDayRange(
  startDayKey: string,
  endDayKey: string,
  maxDays: number,
): void {
  const dayKeyPattern = /^\d{4}-\d{2}-\d{2}$/;
  if (!dayKeyPattern.test(startDayKey) || !dayKeyPattern.test(endDayKey)) {
    throw new Error("Day keys must be YYYY-MM-DD.");
  }
  if (startDayKey > endDayKey) {
    throw new Error("startDayKey must not be after endDayKey.");
  }
  const spanDays =
    Math.round(
      (Date.parse(`${endDayKey}T00:00:00Z`) -
        Date.parse(`${startDayKey}T00:00:00Z`)) /
        86_400_000,
    ) + 1;
  if (spanDays > maxDays) {
    throw new Error(`Range must be at most ${maxDays} days.`);
  }
}

/**
 * A labeler that names nothing: the stretch kinds come from the sources'
 * timings alone, so a read that needs only the kinds skips every title read.
 */
const UNNAMED_LABELER: ScreenTimeLabeler = {
  forSession: async () => "",
  forSessionId: async () => undefined,
  forWebActivity: async () => undefined,
  forPracticeNode: async () => "",
};

/**
 * The scholar-day rows `dailyUsage` returns, for any scope. Callers check the
 * range (`assertDayRange`) and build the scope; this reads and rolls up.
 */
export async function readScholarDayUsage(
  ctx: QueryCtx,
  scope: ScholarUsageScope,
  startDayKey: string,
  endDayKey: string,
  options: ReadUsageOptions = {},
): Promise<ScholarDayUsage[]> {
  const institutionIds = scope.institutionIds;
  if (options.timeline && startDayKey !== endDayKey) {
    throw new Error("A timeline is read one day at a time.");
  }
  if (institutionIds.length === 0) return [];
  const institutionIdSet = new Set<string>(institutionIds);

  // ── Device events ─────────────────────────────────────────────────────
  // A named set of scholars reads their own indexes rather than scanning
  // the school; a row still counts only when its institution is in scope.
  const namedScholarIds = scope.scholarIds;
  const rows = namedScholarIds
    ? (
        await Promise.all(
          namedScholarIds.map((namedId) =>
            ctx.db
              .query("deviceActivityEvents")
              .withIndex("by_user_day", (q) =>
                q
                  .eq("userId", namedId)
                  .gte("dayKey", startDayKey)
                  .lte("dayKey", endDayKey),
              )
              .take(MAX_ROLLUP_ROWS),
          ),
        )
      )
        .flat()
        .filter(
        (row) =>
          row.institutionId !== undefined &&
          institutionIdSet.has(row.institutionId),
      )
    : (
        await Promise.all(
          institutionIds.map((institutionId) =>
            ctx.db
              .query("deviceActivityEvents")
              .withIndex("by_institution_day", (q) =>
                q
                  .eq("institutionId", institutionId)
                  .gte("dayKey", startDayKey)
                  .lte("dayKey", endDayKey),
              )
              .take(MAX_ROLLUP_ROWS),
          ),
        )
      ).flat();

  const institutionDocs = new Map<string, Doc<"institutions"> | null>();
  const timeZoneOf = async (
    institutionId: Id<"institutions"> | undefined,
  ): Promise<string> => {
    if (!institutionId) return DEFAULT_TIMEZONE;
    if (!institutionDocs.has(institutionId)) {
      institutionDocs.set(institutionId, await ctx.db.get(institutionId));
    }
    return institutionDocs.get(institutionId)?.timeZone ?? DEFAULT_TIMEZONE;
  };

  // ── Outside school, by the clock ──────────────────────────────────────
  // A READ-TIME re-derivation, and deliberately so. The stored `context`
  // answers "which program was this minute part of?" and is never
  // re-derived (shared/deviceActivityContext.ts explains why). This answers
  // a different question, "school hours or not?", so it re-runs the same
  // rule with the program inputs held neutral (enrolled, no homework
  // session): only the calendar and the bell schedule decide. A homework
  // session worked at 10am on a school day is therefore IN school here. The
  // window and closures are resolved once per (institution, day), at local
  // noon, which is how the bell schedule's term is chosen.
  const closuresByInstitution = new Map<string, Doc<"schoolClosures">[]>();
  const clockDays = new Map<string, ClockDay>();
  for (const row of rows) {
    const institutionId = row.institutionId;
    if (!institutionId) continue;
    const key = `${institutionId}::${row.dayKey}`;
    if (clockDays.has(key)) continue;
    const timeZone = await timeZoneOf(institutionId);
    let closures = closuresByInstitution.get(institutionId);
    if (!closures) {
      closures = await schoolClosuresFor(ctx, institutionId);
      closuresByInstitution.set(institutionId, closures);
    }
    // weekdayForDayKey is 0=Sun…6=Sat; scheduleBlocks.weekdays is 1=Mon…7=Sun.
    const weekday = weekdayForDayKey(row.dayKey);
    const scheduleWeekday = weekday === 0 ? 7 : weekday;
    clockDays.set(key, {
      timeZone,
      weekday: scheduleWeekday,
      isClosedDay: isClosedDay(row.dayKey, closures) !== null,
      schoolDayWindow: await schoolDayWindowFor(
        ctx,
        institutionId,
        instantForLocalMinutes(row.dayKey, 12 * 60, timeZone),
        scheduleWeekday,
      ),
    });
  }
  const clockContext = (
    row: Doc<"deviceActivityEvents">,
  ): DeviceActivityContext => {
    const day = clockDays.get(`${row.institutionId}::${row.dayKey}`);
    if (!day) return "unknown";
    return deriveDeviceActivityContext({
      enrollmentStanding: "enrolled",
      isHomeworkSession: null,
      weekday: day.weekday,
      isClosedDay: day.isClosedDay,
      minuteOfDay: minuteOfDayForTimezone(row.clientAt, day.timeZone),
      schoolDayWindow: day.schoolDayWindow,
    });
  };

  // Each scholar-day's events twice: with the stored program tag (the
  // existing numbers) and with the clock tag (outsideSchool). The same
  // roll-up runs on both, so measured/estimated attribution is one rule.
  const byScholarDay = new Map<
    string,
    { stored: RollupEvent[]; clock: RollupEvent[] }
  >();
  const deviceInstitutionByScholar = new Map<string, Id<"institutions">>();
  const dayInstitution = new Map<string, Id<"institutions">>();
  for (const row of rows) {
    const key = `${row.userId}::${row.dayKey}`;
    let bucket = byScholarDay.get(key);
    if (!bucket) {
      bucket = { stored: [], clock: [] };
      byScholarDay.set(key, bucket);
    }
    const event = {
      kind: row.kind,
      clientAt: row.clientAt,
      externalAppId: row.externalAppId ?? null,
    };
    if (row.institutionId && !dayInstitution.has(key)) {
      dayInstitution.set(key, row.institutionId);
    }
    bucket.stored.push({ ...event, context: row.context });
    bucket.clock.push({ ...event, context: clockContext(row) });
    if (row.institutionId && !deviceInstitutionByScholar.has(row.userId)) {
      deviceInstitutionByScholar.set(row.userId, row.institutionId);
    }
  }

  // Resolve display names once for the whole page of rows.
  const scholarDocs = new Map<string, Doc<"users"> | null>();
  const scholarDoc = async (id: Id<"users">) => {
    if (!scholarDocs.has(id)) scholarDocs.set(id, await ctx.db.get(id));
    return scholarDocs.get(id) ?? null;
  };
  const appNames = new Map<string, string>();
  for (const row of rows) {
    await scholarDoc(row.userId);
    if (row.externalAppId && !appNames.has(row.externalAppId)) {
      const app = await ctx.db.get(row.externalAppId);
      appNames.set(row.externalAppId, app?.name ?? "Removed app");
    }
  }

  // ── The scholar's own app, and web activities ─────────────────────────
  // Both are read per scholar, and only for scholars the scope allows: the
  // device-event scholars, plus the named scholars or the scope's roster, so
  // a scholar with no device events at all (a web-only day) still gets a row.
  const candidateIds = new Set<Id<"users">>(rows.map((row) => row.userId));
  for (const id of namedScholarIds ?? (await scope.roster())) {
    candidateIds.add(id);
  }

  const sourcesByScholarDay = new Map<string, ScholarDaySources>();
  const labeler = !options.timeline
    ? null
    : options.timelineDetails === false
      ? UNNAMED_LABELER
      : createScreenTimeLabeler(ctx, (institutionId) => {
          const effective = institutionId ?? scope.primaryInstitutionId;
          return effective !== undefined && scope.playInstitutionAllowed(effective);
        });
  const sourcesFor = (userId: Id<"users">, dayKey: string) => {
    const key = `${userId}::${dayKey}`;
    let sources = sourcesByScholarDay.get(key);
    if (!sources) {
      sources = {
        builderOnScreen: [],
        builderActive: [],
        web: [],
        chat: [],
        practice: [],
      };
      sourcesByScholarDay.set(key, sources);
    }
    return sources;
  };

  for (const userId of candidateIds) {
    const scholar = await scholarDoc(userId);
    if (!scholar || !(await scope.scholarAllowed(scholar))) continue;
    const timeZone = await timeZoneOf(
      scholar.institutionId ??
        deviceInstitutionByScholar.get(userId) ??
        scope.fallbackInstitutionId,
    );
    const range: Interval = {
      start: dayStartForDayKey(startDayKey, timeZone),
      end: dayStartForDayKey(shiftDayKey(endDayKey, 1), timeZone),
    };

    // The scholar's own app on screen. Grouped by session so each run of
    // nearby intervals costs one transcript read.
    const plays = await ctx.db
      .query("appPlaySessions")
      .withIndex("by_user_startedAt", (q) =>
        q
          .eq("userId", userId)
          .gte("startedAt", range.start - APP_PLAY_LOOKBACK_MS)
          .lt("startedAt", range.end),
      )
      .collect();
    const onScreenBySession = new Map<Id<"sessions">, Interval[]>();
    const artifactBySession = new Map<Id<"sessions">, Id<"artifacts">>();
    for (const play of plays) {
      // The row carries its session's tenant; another school's session
      // stays out even when the scholar is in scope. An unstamped row is the
      // primary school's, so a scholar who transferred away from the primary
      // school does not bring those minutes to the new one (TRA-637).
      const playInstitutionId = play.institutionId ?? scope.primaryInstitutionId;
      if (
        playInstitutionId === undefined ||
        !scope.playInstitutionAllowed(playInstitutionId)
      ) {
        continue;
      }
      const onScreen = clipInterval(
        {
          start: play.startedAt,
          end: play.startedAt + appPlayDurationMs(play),
        },
        range,
      );
      if (!onScreen) continue;
      const list = onScreenBySession.get(play.sessionId) ?? [];
      list.push(onScreen);
      if (!artifactBySession.has(play.sessionId)) {
        artifactBySession.set(play.sessionId, play.artifactId);
      }
      onScreenBySession.set(play.sessionId, list);
    }
    for (const [sessionId, intervals] of onScreenBySession) {
      // The app's own title, then where its session came from.
      let appDetail: string | undefined;
      if (labeler) {
        const artifactId = artifactBySession.get(sessionId);
        const artifact = artifactId ? await ctx.db.get(artifactId) : null;
        appDetail = await labeler.forSessionId(sessionId, artifact?.title);
      }
      // A turn up to ACTIVE_TURN_CAP_MS outside an interval can still
      // vouch for part of it, so each read is padded by the cap and
      // intervals whose padded reads touch share one read.
      const groups: { read: Interval; intervals: Interval[] }[] = [];
      for (const interval of mergeIntervals(intervals)) {
        const read = {
          start: interval.start - ACTIVE_TURN_CAP_MS,
          end: interval.end + ACTIVE_TURN_CAP_MS,
        };
        const last = groups[groups.length - 1];
        if (last && read.start <= last.read.end) {
          last.read.end = Math.max(last.read.end, read.end);
          last.intervals.push(interval);
        } else {
          groups.push({ read, intervals: [interval] });
        }
      }
      for (const group of groups) {
        // Only the slice of the transcript around the interval, and only
        // the scholar's turns and the replies to them: tool and system rows
        // are skipped, which keeps a busy week well inside the read limits.
        // Timestamps and roles only; no message content enters the result.
        const turnsOf = (role: "user" | "assistant") =>
          ctx.db
            .query("messages")
            .withIndex("by_session_role", (q) =>
              q
                .eq("sessionId", sessionId)
                .eq("role", role)
                .gte("_creationTime", group.read.start)
                .lte("_creationTime", group.read.end),
            )
            .collect();
        const [userTurns, replies] = await Promise.all([
          turnsOf("user"),
          turnsOf("assistant"),
        ]);
        const windows = activeWindowsFromTurns(
          [
            // A turn a staff member typed in the scholar's session is not
            // the scholar's own (TRA-515).
            ...userTurns
              .filter((message) => !message.byStaff)
              .map((message) => ({
                role: message.role,
                createdAt: message._creationTime,
              })),
            // A reply row is created when streaming starts; it ends at its
            // last stream activity.
            ...replies.map((message) => ({
              role: message.role,
              createdAt: Math.max(
                message._creationTime,
                message.lastStreamActivityAt ?? 0,
              ),
            })),
          ].sort((a, b) => a.createdAt - b.createdAt),
        );
        for (const interval of group.intervals) {
          for (const piece of splitIntervalByDay(interval, timeZone)) {
            const sources = sourcesFor(userId, piece.dayKey);
            sources.builderOnScreen.push({ ...piece, detail: appDetail });
            sources.builderActive.push(
              ...intersectIntervals([piece], windows).map((active) => ({
                ...active,
                detail: appDetail,
              })),
            );
          }
        }
      }
    }

    // Launcher web activities.
    const webSessions = await ctx.db
      .query("webActivitySessions")
      .withIndex("by_scholar", (q) =>
        q
          .eq("scholarId", userId)
          .gte("startedAt", range.start - WEB_ACTIVITY_SESSION_CAP_MS)
          .lt("startedAt", range.end),
      )
      .collect();
    for (const session of webSessions) {
      const open = clipInterval(webActivitySessionInterval(session), range);
      if (!open) continue;
      const detail = labeler ? await labeler.forWebActivity(session) : undefined;
      for (const piece of splitIntervalByDay(open, timeZone)) {
        sourcesFor(userId, piece.dayKey).web.push({ ...piece, detail });
      }
    }

    // Chat and practice only label measured device time, so a scholar with
    // no device events in range needs neither read.
    if (labeler && byScholarDay.has(`${userId}::${startDayKey}`)) {
      // Tutor turns: every session the scholar wrote in since the day began
      // and that existed before it ended. Timestamps and roles only.
      const sessions = await ctx.db
        .query("sessions")
        .withIndex("by_user_last_message", (q) =>
          q.eq("userId", userId).gte("lastMessageAt", range.start),
        )
        // Ascending from the day's start, so a past day reads the sessions
        // touched soonest after it first; a busy scholar's later sessions
        // can't push one day's read past the limits.
        .take(TIMELINE_SESSION_READ_CAP);
      for (const session of sessions) {
        if (session._creationTime >= range.end) continue;
        const sessionInstitutionId =
          session.institutionId ?? scope.primaryInstitutionId;
        if (
          sessionInstitutionId === undefined ||
          !scope.playInstitutionAllowed(sessionInstitutionId)
        ) {
          continue;
        }
        const turnsOf = (role: "user" | "assistant") =>
          ctx.db
            .query("messages")
            .withIndex("by_session_role", (q) =>
              q
                .eq("sessionId", session._id)
                .eq("role", role)
                .gte("_creationTime", range.start - ACTIVE_TURN_CAP_MS)
                .lt("_creationTime", range.end),
            )
            .collect();
        const [userTurns, replies] = await Promise.all([
          turnsOf("user"),
          turnsOf("assistant"),
        ]);
        if (userTurns.length === 0) continue;
        const detail = await labeler.forSession(session);
        const windows = activeWindowsFromTurns([
          ...userTurns
            .filter((message) => !message.byStaff)
            .map((message) => ({
              role: message.role,
              createdAt: message._creationTime,
            })),
          ...replies.map((message) => ({
            role: message.role,
            createdAt: Math.max(
              message._creationTime,
              message.lastStreamActivityAt ?? 0,
            ),
          })),
        ]);
        for (const window of windows) {
          const clipped = clipInterval(window, range);
          if (!clipped) continue;
          for (const piece of splitIntervalByDay(clipped, timeZone)) {
            sourcesFor(userId, piece.dayKey).chat.push({ ...piece, detail });
          }
        }
      }

      // Math practice attempts. Each vouches for its time on the item.
      const attempts = await ctx.db
        .query("practiceAttempts")
        .withIndex("by_scholar_createdAt", (q) =>
          q
            .eq("scholarId", userId)
            .gte("createdAt", range.start)
            .lt("createdAt", range.end + PRACTICE_ATTEMPT_LEAD_CAP_MS),
        )
        .collect();
      const timedAttempts = [];
      for (const attempt of attempts) {
        if (attempt.createdAt === undefined) continue;
        timedAttempts.push({
          createdAt: attempt.createdAt,
          elapsedMs: attempt.elapsedMs,
          detail: await labeler.forPracticeNode(attempt.nodeKey),
        });
      }
      const practiceWindows = practiceWindowsFromAttempts(timedAttempts);
      for (const window of practiceWindows) {
        const clipped = clipInterval(window, range);
        if (!clipped) continue;
        for (const piece of splitIntervalByDay(clipped, timeZone)) {
          sourcesFor(userId, piece.dayKey).practice.push({
            ...piece,
            detail: window.detail,
          });
        }
      }
    }
  }

  // The open school day as an instant range, by the same clock rule as
  // `clockContext` (shared/deviceActivityContext.ts): none on a weekend, a
  // closed day, or a day with no bell schedule.
  const schoolHoursOf = (key: string, dayKey: string): Interval[] => {
    const institutionId = dayInstitution.get(key);
    const day = institutionId
      ? clockDays.get(`${institutionId}::${dayKey}`)
      : undefined;
    if (
      !day ||
      day.isClosedDay ||
      day.weekday < 1 ||
      day.weekday > 5 ||
      !day.schoolDayWindow
    ) {
      return [];
    }
    return [
      {
        start: instantForLocalMinutes(
          dayKey,
          day.schoolDayWindow.startMinute,
          day.timeZone,
        ),
        end: instantForLocalMinutes(
          dayKey,
          day.schoolDayWindow.endMinute,
          day.timeZone,
        ),
      },
    ];
  };

  const results: ScholarDayUsage[] = [];
  const keys = new Set([...byScholarDay.keys(), ...sourcesByScholarDay.keys()]);
  for (const key of keys) {
    const [userId, dayKey] = key.split("::");
    const events = byScholarDay.get(key);
    // The roll-up (shared/deviceActivityRollup.ts) decides what counts as a
    // minute on screen, including that a foreground with no heartbeat after
    // it is a relit screen, not a scholar. It runs here, on the server, so a
    // change to that file only reaches prod when this file deploys with it.
    const rollup = rollupDeviceActivityDay(events?.stored ?? []);
    const clockRollup = rollupDeviceActivityDay(events?.clock ?? []);
    const sources = sourcesByScholarDay.get(key);
    const builderOnScreenMs = totalMs(sources?.builderOnScreen ?? []);
    const builderActiveMs = totalMs(sources?.builderActive ?? []);
    const webMs = totalMs(sources?.web ?? []);
    // A day holding only diagnostic rows (e.g. a freeze that crossed
    // midnight) and no app or web time has no usage, so it is not a row.
    if (rollup.eventCount === 0 && builderOnScreenMs === 0 && webMs === 0) {
      continue;
    }
    const byContext: ScholarDayUsage["byContext"] = {};
    for (const [context, bucket] of Object.entries(rollup.byContext)) {
      byContext[context] = {
        measuredMinutes: msToMinutes(bucket.measuredMs),
        estimatedMinutes: msToMinutes(bucket.estimatedMs),
      };
    }
    // Measured time is split at the bell by its spans, so an app launched
    // at 14:50 and left at 17:00 books ten minutes in school and two hours
    // outside. An estimate has no real span, so it stays with the clock at
    // its launch (every clock bucket except core_day is outside school).
    const spans = rollup.measuredSpans;
    const outsideMeasuredMs =
      totalMs(spans) - overlapMs(spans, schoolHoursOf(key, dayKey));
    let outsideEstimatedMs = 0;
    for (const [context, bucket] of Object.entries(clockRollup.byContext)) {
      if (context === "core_day") continue;
      outsideEstimatedMs += bucket.estimatedMs;
    }
    // The rest of Rabbithole is iPad foreground that no builder interval or
    // web activity overlaps. Overlap, not subtraction: a laptop session or a
    // play that outlived the iPad's foreground takes nothing away from it.
    const foregroundSpans = spans.filter((span) => span.source === "foreground");
    const outsideForegroundMs =
      totalMs(foregroundSpans) -
      overlapMs(foregroundSpans, schoolHoursOf(key, dayKey));
    const otherMs =
      rollup.foregroundMs -
      overlapMs(foregroundSpans, [
        ...(sources?.builderOnScreen ?? []),
        ...(sources?.web ?? []),
      ]);
    const foregroundMinutes = msToMinutes(rollup.foregroundMs);
    const builderOnScreenMinutes = msToMinutes(builderOnScreenMs);
    const webActivityMinutes = msToMinutes(webMs);
    results.push({
      scholarId: userId as Id<"users">,
      scholarName:
        scholarDocs.get(userId)?.name ?? "Unknown scholar",
      dayKey,
      foregroundMinutes,
      apps: rollup.apps.map((app) => ({
        externalAppId: app.externalAppId,
        appName: appNames.get(app.externalAppId) ?? "Removed app",
        measuredMinutes: msToMinutes(app.measuredMs),
        estimatedMinutes: msToMinutes(app.estimatedMs),
        estimatedIntervals: app.estimatedIntervals,
      })),
      unattributedBackgroundMinutes: msToMinutes(
        rollup.unattributedBackgroundMs,
      ),
      measuredMinutes: msToMinutes(rollup.totals.measuredMs),
      estimatedMinutes: msToMinutes(rollup.totals.estimatedMs),
      estimatedIntervals: rollup.estimatedIntervals,
      byContext,
      eventCount: rollup.eventCount,
      outsideSchool: {
        measuredMinutes: msToMinutes(outsideMeasuredMs),
        estimatedMinutes: msToMinutes(outsideEstimatedMs),
        foregroundMinutes: msToMinutes(Math.max(0, outsideForegroundMs)),
      },
      builder: {
        onScreenMinutes: builderOnScreenMinutes,
        activeMinutes: msToMinutes(builderActiveMs),
      },
      webActivityMinutes,
      otherRabbitholeMinutes: msToMinutes(Math.max(0, otherMs)),
      schoolDay: schoolHoursOf(key, dayKey).length > 0,
      ...(options.timeline
        ? {
            timeline: {
              ...classifyDayStretches({
                foreground: foregroundSpans,
                launchedApps: spans
                  .filter((span) => span.source === "app")
                  .map((span) => ({
                    start: span.start,
                    end: span.end,
                    detail: span.externalAppId
                      ? (appNames.get(span.externalAppId) ?? "Removed app")
                      : "Another app",
                  })),
                web: sources?.web ?? [],
                builderOnScreen: sources?.builderOnScreen ?? [],
                builderActive: sources?.builderActive ?? [],
                practice: sources?.practice ?? [],
                chat: sources?.chat ?? [],
              }),
              schoolHours: schoolHoursOf(key, dayKey),
            },
          }
        : {}),
    });
  }

  return results.sort(
    (a, b) =>
      a.dayKey.localeCompare(b.dayKey) ||
      String(a.scholarId).localeCompare(String(b.scholarId)),
  );
}
