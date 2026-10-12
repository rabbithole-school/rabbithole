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
// PARENTS NEVER READ THIS. The only read surface here is `dailyUsage`, gated by
// `scholarAdminQuery` (teacher / school_admin / platform_admin / operations
// staff) and scoped by the institution lens — the same pair the native-client
// rollout inventory uses. There is deliberately no scholar-facing or
// parent-facing query in this file.

import { v } from "convex/values";
import { authedMutation, scholarAdminQuery } from "./lib/customFunctions";
import { resolveInstitutionLens } from "./lib/institutionLens";
import { canReadScholarAsTeacher } from "./lib/access";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import {
  DEFAULT_TIMEZONE,
  dayKeyForTimezone,
  minuteOfDayForTimezone,
  weekdayForDayKey,
} from "../shared/institutionDay";
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
  const placement = (assignment.activitySchedule ?? []).find(
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
    // Institution-scoped closures PLUS the global ones (institutionId absent =
    // applies to every school; see the schoolClosures table comment).
    const closures = [
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

    return {
      recorded: accepted.length,
      dropped: args.events.length - accepted.length,
    };
  },
});

/** Hard ceiling on one read, so a wide range cannot become an unbounded scan. */
export const MAX_ROLLUP_DAYS = 31;
export const MAX_ROLLUP_ROWS = 20_000;

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
};

/**
 * Staff-only schoolwide roll-up: one row per scholar per school day, with
 * measured and estimated minutes reported SEPARATELY at every level.
 *
 * `estimatedMinutes` is not a worse kind of measurement — it is the honest
 * label on an interval where the data is not available (an external app the
 * iPad never came back from). A surface built on this should show both numbers
 * and never add them into one figure that implies more certainty than exists.
 */
export const dailyUsage = scholarAdminQuery({
  args: {
    institutionScope: v.optional(v.string()),
    startDayKey: v.string(),
    endDayKey: v.string(),
    /** Optional narrowing to one scholar; still institution-gated. */
    scholarId: v.optional(v.id("users")),
  },
  handler: async (ctx, args): Promise<ScholarDayUsage[]> => {
    const startDayKey = args.startDayKey.trim();
    const endDayKey = args.endDayKey.trim();
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
    if (spanDays > MAX_ROLLUP_DAYS) {
      throw new Error(`Range must be at most ${MAX_ROLLUP_DAYS} days.`);
    }

    // Per-scholar narrowing is checked against the caller's TEACHER-role
    // memberships as well as the lens, so an operations staffer cannot widen
    // their reach by naming a scholar directly.
    if (
      args.scholarId &&
      !(await canReadScholarAsTeacher(ctx, ctx.user, args.scholarId))
    ) {
      return [];
    }

    const lens = await resolveInstitutionLens(
      ctx,
      ctx.user,
      args.institutionScope ?? "",
    );
    const institutionIds =
      lens.scope === "all"
        ? [...lens.allowedInstitutionIds]
        : lens.institution && lens.allowedInstitutionIds.has(lens.institution._id)
          ? [lens.institution._id]
          : [];
    if (institutionIds.length === 0) return [];

    const rows = (
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

    const byScholarDay = new Map<string, RollupEvent[]>();
    for (const row of rows) {
      if (args.scholarId && row.userId !== args.scholarId) continue;
      const key = `${row.userId}::${row.dayKey}`;
      let bucket = byScholarDay.get(key);
      if (!bucket) {
        bucket = [];
        byScholarDay.set(key, bucket);
      }
      bucket.push({
        kind: row.kind,
        clientAt: row.clientAt,
        externalAppId: row.externalAppId ?? null,
        context: row.context,
      });
    }

    // Resolve display names once for the whole page of rows.
    const scholarNames = new Map<string, string>();
    const appNames = new Map<string, string>();
    for (const row of rows) {
      if (!scholarNames.has(row.userId)) {
        const scholar = await ctx.db.get(row.userId);
        scholarNames.set(row.userId, scholar?.name ?? "Unknown scholar");
      }
      if (row.externalAppId && !appNames.has(row.externalAppId)) {
        const app = await ctx.db.get(row.externalAppId);
        appNames.set(row.externalAppId, app?.name ?? "Removed app");
      }
    }

    const results: ScholarDayUsage[] = [];
    for (const [key, events] of byScholarDay) {
      const [scholarId, dayKey] = key.split("::");
      const rollup = rollupDeviceActivityDay(events);
      // A day holding only diagnostic rows (e.g. a freeze that crossed
      // midnight) has no usage, so it is not a usage row.
      if (rollup.eventCount === 0) continue;
      const byContext: ScholarDayUsage["byContext"] = {};
      for (const [context, bucket] of Object.entries(rollup.byContext)) {
        byContext[context] = {
          measuredMinutes: msToMinutes(bucket.measuredMs),
          estimatedMinutes: msToMinutes(bucket.estimatedMs),
        };
      }
      results.push({
        scholarId: scholarId as Id<"users">,
        scholarName: scholarNames.get(scholarId) ?? "Unknown scholar",
        dayKey,
        foregroundMinutes: msToMinutes(rollup.foregroundMs),
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
      });
    }

    return results.sort(
      (a, b) =>
        a.dayKey.localeCompare(b.dayKey) ||
        String(a.scholarId).localeCompare(String(b.scholarId)),
    );
  },
});
