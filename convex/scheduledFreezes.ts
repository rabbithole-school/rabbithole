/**
 * A family's planned BunnyPad freezes: "6 to 7pm tonight" or "6 to 7pm every
 * weeknight", plus the parent portal's freeze card, which also freezes now.
 *
 * A planned freeze is a row in `scheduledFreezes`. At its start, `fire` sets
 * the ordinary `pairedDevices.freezeUntil` through deviceLock's guardian
 * rules (a school freeze wins; a family freeze thaws by the next school day),
 * so the BunnyPad itself needs nothing new. Any guardian of the child may add
 * or remove one; the parent aide and the portal card share every check here.
 *
 * Times are school-local minutes past midnight, in the child's school's zone,
 * like bedtime (scholarBedtimes.ts). A window stays inside one day: it starts
 * and ends between midnight and midnight.
 */
import { ConvexError, v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import {
  internalMutation,
  internalQuery,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import { internal } from "./_generated/api";
import { authedMutation, authedQuery } from "./lib/customFunctions";
import {
  assertNotImpersonating,
  isGuardianOf,
  READ_ONLY_ACCOUNT_ERROR,
  requireGuardianOf,
} from "./lib/auth";
import { effectiveInstitutionTimeZone } from "./lib/institutionTime";
import { writeAuditLog } from "./lib/auditLog";
import {
  applyScheduledGuardianFreeze,
  FREEZE_MIN_MINUTES,
  freezeOwner,
  guardianSourceValidator,
  runGuardianFreeze,
} from "./deviceLock";
import {
  dayKeyForTimezone,
  instantForLocalMinutes,
  shiftDayKey,
  weekdayForDayKey,
} from "../shared/institutionDay";
import { bedtimeClockText } from "../shared/bedtime";

/** A planned freeze can be at most this long, the length a family freeze is
 *  always allowed (deviceLock.ts); longer ones are clamped at the next
 *  school day's start anyway. */
const SCHEDULED_FREEZE_MAX_MINUTES = 8 * 60;
/** How far ahead a one-off freeze can be planned. */
const SCHEDULED_FREEZE_MAX_DAYS_AHEAD = 60;
/** Planned freezes per child, so a runaway loop can't pile them up. */
const SCHEDULED_FREEZES_PER_CHILD = 20;

const WEEKDAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

/** "every weekday", "every day", "every Monday and Wednesday". */
export function repeatDaysText(weekdays: number[]): string {
  const set = new Set(weekdays);
  if (set.size === 7) return "every day";
  if (set.size === 5 && [1, 2, 3, 4, 5].every((d) => set.has(d))) {
    return "every weekday";
  }
  if (set.size === 2 && set.has(0) && set.has(6)) return "every Saturday and Sunday";
  // Monday first, Sunday last.
  const names = [1, 2, 3, 4, 5, 6, 0]
    .filter((d) => set.has(d))
    .map((d) => WEEKDAY_NAMES[d]);
  const list =
    names.length === 1
      ? names[0]
      : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  return `every ${list}`;
}

function dayLabel(ms: number, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    month: "short",
    day: "numeric",
  }).format(new Date(ms));
}

/** "6pm to 7pm" / "5:30pm to 5:33pm". */
function windowText(startMinutes: number, endMinutes: number): string {
  return `${bedtimeClockText(startMinutes)} to ${bedtimeClockText(endMinutes)}`;
}

/** The first weekly occurrence whose end is after `after` (one already under
 *  way counts), or null when none falls in the next week. */
export function nextWeeklyOccurrence(
  weekdays: number[],
  startMinutes: number,
  endMinutes: number,
  after: number,
  timeZone: string,
): { startAt: number; endAt: number } | null {
  const today = dayKeyForTimezone(after, timeZone);
  for (let offset = 0; offset <= 7; offset++) {
    const day = shiftDayKey(today, offset);
    if (!weekdays.includes(weekdayForDayKey(day))) continue;
    const endAt = instantForLocalMinutes(day, endMinutes, timeZone);
    if (endAt <= after) continue;
    return { startAt: instantForLocalMinutes(day, startMinutes, timeZone), endAt };
  }
  return null;
}

const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/;

/** "2026-11-18" yes; "2026-02-31" no (it would roll into March). */
function isRealDayKey(dayKey: string): boolean {
  if (!DAY_KEY.test(dayKey)) return false;
  const [y, m, d] = dayKey.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toISOString().slice(0, 10) === dayKey;
}

export type ScheduleRequest = {
  guardianUserId: Id<"users">;
  scholarId: Id<"users">;
  startMinutes: number;
  endMinutes: number;
  /** Weekly days (0 = Sunday … 6 = Saturday); absent or empty = once. */
  weekdays?: number[];
  /** For a one-off: the school-local date. Absent = the next time the window
   *  comes round (today if it hasn't ended yet, else tomorrow). */
  dayKey?: string;
};

type ScheduleCheck =
  | { ok: false; message: string }
  | {
      ok: true;
      childName: string;
      timeZone: string;
      repeat: "once" | "weekly";
      weekdays?: number[];
      nextStartAt: number;
      nextEndAt: number;
    };

async function childTimeZone(
  ctx: QueryCtx,
  scholar: Doc<"users">,
  rows: Doc<"pairedDevices">[],
): Promise<string> {
  const institutionId = rows[0]?.institutionId ?? scholar.institutionId;
  const institution = institutionId ? await ctx.db.get(institutionId) : null;
  return effectiveInstitutionTimeZone(institution?.timeZone);
}

/** Every refusal a planned freeze can meet, read-only, so the aide's staff
 *  preview says exactly what the real write would. */
async function checkSchedule(
  ctx: QueryCtx,
  args: ScheduleRequest,
  now: number,
): Promise<ScheduleCheck> {
  const guardian = await ctx.db.get(args.guardianUserId);
  if (guardian?.readOnly) return { ok: false, message: READ_ONLY_ACCOUNT_ERROR };
  if (!(await isGuardianOf(ctx, args.guardianUserId, args.scholarId))) {
    return { ok: false, message: "You can only freeze your own child's BunnyPad." };
  }
  const scholar = await ctx.db.get(args.scholarId);
  if (!scholar) {
    return { ok: false, message: "You can only freeze your own child's BunnyPad." };
  }
  const childName = scholar.name ?? "Your child";
  const rows = await ctx.db
    .query("pairedDevices")
    .withIndex("by_scholar", (q) => q.eq("scholarId", args.scholarId))
    .collect();
  if (rows.length === 0) {
    return { ok: false, message: `${childName} doesn't have a BunnyPad paired yet.` };
  }

  const { startMinutes, endMinutes } = args;
  const isClock = (m: number) => Number.isInteger(m) && m >= 0 && m < 24 * 60;
  if (!isClock(startMinutes) || !isClock(endMinutes)) {
    return { ok: false, message: "Give the start and end as times of day." };
  }
  if (endMinutes <= startMinutes) {
    return {
      ok: false,
      message: "A planned freeze has to end later the same day it starts, before midnight.",
    };
  }
  const length = endMinutes - startMinutes;
  if (length < FREEZE_MIN_MINUTES || length > SCHEDULED_FREEZE_MAX_MINUTES) {
    return {
      ok: false,
      message: `A planned freeze lasts between ${FREEZE_MIN_MINUTES} minutes and ${SCHEDULED_FREEZE_MAX_MINUTES / 60} hours.`,
    };
  }

  const existing = await ctx.db
    .query("scheduledFreezes")
    .withIndex("by_scholar", (q) => q.eq("scholarId", args.scholarId))
    .collect();
  if (existing.length >= SCHEDULED_FREEZES_PER_CHILD) {
    return {
      ok: false,
      message: `${childName} already has ${SCHEDULED_FREEZES_PER_CHILD} planned freezes. Remove one first.`,
    };
  }

  const timeZone = await childTimeZone(ctx, scholar, rows);
  const weekdays = [...new Set(args.weekdays ?? [])].sort((a, b) => a - b);
  if (weekdays.length > 0) {
    if (!weekdays.every((d) => Number.isInteger(d) && d >= 0 && d <= 6)) {
      return { ok: false, message: "Those aren't days of the week." };
    }
    if (args.dayKey !== undefined) {
      return { ok: false, message: "A repeating freeze takes days of the week, not a date." };
    }
    const next = nextWeeklyOccurrence(weekdays, startMinutes, endMinutes, now, timeZone)!;
    return {
      ok: true,
      childName,
      timeZone,
      repeat: "weekly",
      weekdays,
      nextStartAt: next.startAt,
      nextEndAt: next.endAt,
    };
  }

  const today = dayKeyForTimezone(now, timeZone);
  let day: string;
  if (args.dayKey !== undefined) {
    if (!isRealDayKey(args.dayKey)) {
      return { ok: false, message: "Give the date as a calendar date." };
    }
    day = args.dayKey;
    if (day > shiftDayKey(today, SCHEDULED_FREEZE_MAX_DAYS_AHEAD)) {
      return {
        ok: false,
        message: `A freeze can be planned up to ${SCHEDULED_FREEZE_MAX_DAYS_AHEAD} days ahead.`,
      };
    }
  } else {
    day =
      instantForLocalMinutes(today, endMinutes, timeZone) > now
        ? today
        : shiftDayKey(today, 1);
  }
  const nextStartAt = instantForLocalMinutes(day, startMinutes, timeZone);
  const nextEndAt = instantForLocalMinutes(day, endMinutes, timeZone);
  if (nextEndAt <= now) {
    return { ok: false, message: "That time has already passed." };
  }
  return { ok: true, childName, timeZone, repeat: "once", nextStartAt, nextEndAt };
}

function scheduleText(row: {
  repeat: "once" | "weekly";
  weekdays?: number[];
  startMinutes: number;
  endMinutes: number;
  nextStartAt: number;
}, timeZone: string): string {
  const window = windowText(row.startMinutes, row.endMinutes);
  return row.repeat === "weekly"
    ? `${window} ${repeatDaysText(row.weekdays ?? [])}`
    : `${window} on ${dayLabel(row.nextStartAt, timeZone)}`;
}

async function schedule(ctx: MutationCtx, row: Doc<"scheduledFreezes">) {
  const expectedStartAt = row.nextStartAt;
  if (expectedStartAt <= Date.now()) {
    await ctx.scheduler.runAfter(0, internal.scheduledFreezes.fire, {
      scheduledFreezeId: row._id,
      expectedStartAt,
    });
  } else {
    await ctx.scheduler.runAt(expectedStartAt, internal.scheduledFreezes.fire, {
      scheduledFreezeId: row._id,
      expectedStartAt,
    });
  }
}

/** Save a checked plan and return the line the parent is told. */
async function addSchedule(
  ctx: MutationCtx,
  args: ScheduleRequest,
  check: Extract<ScheduleCheck, { ok: true }>,
  source: "parent_app" | "parent_sms",
): Promise<{ id: Id<"scheduledFreezes">; message: string }> {
  const now = Date.now();
  const id = await ctx.db.insert("scheduledFreezes", {
    scholarId: args.scholarId,
    createdBy: args.guardianUserId,
    repeat: check.repeat,
    ...(check.weekdays ? { weekdays: check.weekdays } : {}),
    startMinutes: args.startMinutes,
    endMinutes: args.endMinutes,
    nextStartAt: check.nextStartAt,
    nextEndAt: check.nextEndAt,
    createdAt: now,
  });
  const row = (await ctx.db.get(id))!;
  await schedule(ctx, row);
  const text = scheduleText(row, check.timeZone);
  const scholar = await ctx.db.get(args.scholarId);
  await writeAuditLog(ctx, {
    institutionId: scholar?.institutionId ?? null,
    actorUserId: args.guardianUserId,
    action: "device.freeze.schedule",
    targetUserId: args.scholarId,
    at: now,
    detail: `planned ${text} via ${source}`,
  });
  const underWay = check.nextStartAt <= now;
  const lead = underWay
    ? `${check.childName}'s BunnyPad is being frozen now until ${bedtimeClockText(args.endMinutes)}`
    : `${check.childName}'s BunnyPad will be frozen`;
  const tail =
    check.repeat === "weekly"
      ? underWay
        ? `, and then ${text}.`
        : ` ${text}, starting ${dayLabel(check.nextStartAt, check.timeZone)}.`
      : underWay
        ? "."
        : ` ${text}.`;
  return {
    id,
    message: `${lead}${tail} Each freeze takes effect once the BunnyPad is connected. A planned freeze never runs during the school day: it is skipped then, and ends early if school starts first.`,
  };
}

/** Delete a plan the guardian may change; returns the line to say back. */
async function removeSchedule(
  ctx: MutationCtx,
  guardianUserId: Id<"users">,
  scheduledFreezeId: Id<"scheduledFreezes">,
  source: "parent_app" | "parent_sms",
): Promise<{ ok: boolean; message: string }> {
  const row = await ctx.db.get(scheduledFreezeId);
  if (!row || !(await isGuardianOf(ctx, guardianUserId, row.scholarId))) {
    return { ok: false, message: "That planned freeze isn't there any more." };
  }
  const scholar = await ctx.db.get(row.scholarId);
  const rows = await ctx.db
    .query("pairedDevices")
    .withIndex("by_scholar", (q) => q.eq("scholarId", row.scholarId))
    .collect();
  const timeZone = scholar ? await childTimeZone(ctx, scholar, rows) : "UTC";
  const text = scheduleText(row, timeZone);
  await ctx.db.delete(row._id);
  await writeAuditLog(ctx, {
    institutionId: scholar?.institutionId ?? null,
    actorUserId: guardianUserId,
    action: "device.freeze.unschedule",
    targetUserId: row.scholarId,
    at: Date.now(),
    detail: `removed ${text} via ${source}`,
  });
  // Removing a plan doesn't lift a freeze it already started.
  const now = Date.now();
  let stillFrozen = false;
  for (const device of rows) {
    if (
      device.freezeUntil !== undefined &&
      device.freezeUntil > now &&
      (await freezeOwner(ctx, device)) === "family"
    ) {
      stillFrozen = true;
    }
  }
  return {
    ok: true,
    message: `Removed the ${text} freeze.${stillFrozen ? " A freeze already running stays on until it ends; unfreeze it to lift it now." : ""}`,
  };
}

/** Every plan for one child, soonest first, for the card and the aide. */
async function plansFor(ctx: QueryCtx, scholarId: Id<"users">, timeZone: string) {
  const rows = await ctx.db
    .query("scheduledFreezes")
    .withIndex("by_scholar", (q) => q.eq("scholarId", scholarId))
    .collect();
  return rows
    .sort((a, b) => a.nextStartAt - b.nextStartAt)
    .map((row) => ({
      id: row._id,
      repeat: row.repeat,
      weekdays: row.weekdays ?? [],
      startMinutes: row.startMinutes,
      endMinutes: row.endMinutes,
      nextStartAt: row.nextStartAt,
      text: scheduleText(row, timeZone),
    }));
}

/**
 * A plan's start: freeze the child's BunnyPads until this occurrence's end,
 * then roll a weekly plan to its next day or drop a one-off. Revision-checked
 * on `nextStartAt`, so a removed or replaced plan never fires.
 */
export const fire = internalMutation({
  args: {
    scheduledFreezeId: v.id("scheduledFreezes"),
    expectedStartAt: v.number(),
  },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.scheduledFreezeId);
    if (!row || row.nextStartAt !== args.expectedStartAt) return { fired: false };
    // A guardian who has since been unlinked loses their plans.
    if (!(await isGuardianOf(ctx, row.createdBy, row.scholarId))) {
      await ctx.db.delete(row._id);
      return { fired: false };
    }
    const now = Date.now();
    const result =
      row.nextEndAt > now
        ? await applyScheduledGuardianFreeze(
            ctx,
            row.createdBy,
            row.scholarId,
            row.nextEndAt,
            now,
          )
        : { applied: false, reason: "window already over" };
    if (!result.applied) {
      const scholar = await ctx.db.get(row.scholarId);
      await writeAuditLog(ctx, {
        institutionId: scholar?.institutionId ?? null,
        actorUserId: row.createdBy,
        action: "device.freeze.schedule_skipped",
        targetUserId: row.scholarId,
        at: now,
        detail: result.reason ?? "skipped",
      });
    }

    if (row.repeat === "once") {
      await ctx.db.delete(row._id);
      return { fired: result.applied };
    }
    const scholar = await ctx.db.get(row.scholarId);
    const devices = await ctx.db
      .query("pairedDevices")
      .withIndex("by_scholar", (q) => q.eq("scholarId", row.scholarId))
      .collect();
    const timeZone = scholar ? await childTimeZone(ctx, scholar, devices) : "UTC";
    const next = nextWeeklyOccurrence(
      row.weekdays ?? [],
      row.startMinutes,
      row.endMinutes,
      Math.max(row.nextEndAt, now),
      timeZone,
    );
    if (!next) {
      await ctx.db.delete(row._id);
      return { fired: result.applied };
    }
    await ctx.db.patch(row._id, { nextStartAt: next.startAt, nextEndAt: next.endAt });
    await schedule(ctx, { ...row, nextStartAt: next.startAt, nextEndAt: next.endAt });
    return { fired: result.applied };
  },
});

// ─── Parent portal: the BunnyPad freeze card ────────────────────────────────

/**
 * The freeze card for one child: each BunnyPad's freeze (the boundary, T11;
 * the client compares it to its own clock), who set it, and the family's
 * planned freezes. Null when the child has no BunnyPad paired.
 */
export const forParentCard = authedQuery({
  args: { scholarId: v.id("users") },
  handler: async (ctx, { scholarId }) => {
    await requireGuardianOf(ctx, scholarId);
    const scholar = await ctx.db.get(scholarId);
    if (!scholar) return null;
    const rows = await ctx.db
      .query("pairedDevices")
      .withIndex("by_scholar", (q) => q.eq("scholarId", scholarId))
      .collect();
    if (rows.length === 0) return null;
    const timeZone = await childTimeZone(ctx, scholar, rows);
    const devices = [];
    for (const row of rows) {
      devices.push({
        frozenUntil: row.freezeUntil ?? null,
        frozenBy: await freezeOwner(ctx, row),
      });
    }
    return {
      timeZone,
      devices,
      plans: await plansFor(ctx, scholarId, timeZone),
    };
  },
});

/** The card's "Freeze now" / "Unfreeze": the same rules as asking the aide. */
export const freezeNowForScholar = authedMutation({
  args: {
    scholarId: v.id("users"),
    frozen: v.boolean(),
    minutes: v.optional(v.number()),
    untilClockMinutes: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    await requireGuardianOf(ctx, args.scholarId);
    const result = await runGuardianFreeze(
      ctx,
      { guardianUserId: ctx.user._id, ...args },
      "parent_app",
    );
    if (!result.ok) throw new ConvexError(result.message);
    return { message: result.message };
  },
});

/** The card's "Plan a freeze". */
export const addForScholar = authedMutation({
  args: {
    scholarId: v.id("users"),
    startMinutes: v.number(),
    endMinutes: v.number(),
    weekdays: v.optional(v.array(v.number())),
    dayKey: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireGuardianOf(ctx, args.scholarId);
    const request = { guardianUserId: ctx.user._id, ...args };
    const check = await checkSchedule(ctx, request, Date.now());
    if (!check.ok) throw new ConvexError(check.message);
    const { message } = await addSchedule(ctx, request, check, "parent_app");
    return { message };
  },
});

/** The card's "Remove" on a planned freeze. */
export const removeForScholar = authedMutation({
  args: { scheduledFreezeId: v.id("scheduledFreezes") },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.scheduledFreezeId);
    if (row) await requireGuardianOf(ctx, row.scholarId);
    const result = await removeSchedule(
      ctx,
      ctx.user._id,
      args.scheduledFreezeId,
      "parent_app",
    );
    if (!result.ok) throw new ConvexError(result.message);
    return { message: result.message };
  },
});

// ─── Parent aide ────────────────────────────────────────────────────────────

const scheduleArgs = {
  guardianUserId: v.id("users"),
  scholarId: v.id("users"),
  startMinutes: v.number(),
  endMinutes: v.number(),
  weekdays: v.optional(v.array(v.number())),
  dayKey: v.optional(v.string()),
};

/** The aide's write: plan a freeze for the guardian the turn was prepared
 *  for. Every refusal comes back as a message the aide says back. */
export const scheduleFromGuardian = internalMutation({
  args: { ...scheduleArgs, source: guardianSourceValidator },
  handler: async (ctx, args) => {
    try {
      await assertNotImpersonating(ctx);
    } catch (error) {
      return { ok: false as const, message: (error as Error).message };
    }
    const { source, ...request } = args;
    const check = await checkSchedule(ctx, request, Date.now());
    if (!check.ok) return check;
    const { message } = await addSchedule(ctx, request, check, source);
    return { ok: true as const, message };
  },
});

/** The staff preview's twin of scheduleFromGuardian: nothing written. */
export const previewScheduleFromGuardian = internalQuery({
  args: scheduleArgs,
  handler: async (ctx, args): Promise<{ ok: boolean; message?: string }> => {
    // t11-ok: internal query only the aide's dry run calls, once per turn.
    const check = await checkSchedule(ctx, args, Date.now());
    return check.ok ? { ok: true } : check;
  },
});

/** The aide's removal, by the id `listForGuardian` handed it. */
export const cancelFromGuardian = internalMutation({
  args: {
    guardianUserId: v.id("users"),
    scheduledFreezeId: v.string(),
    source: guardianSourceValidator,
  },
  handler: async (ctx, args) => {
    try {
      await assertNotImpersonating(ctx);
    } catch (error) {
      return { ok: false, message: (error as Error).message };
    }
    const guardian = await ctx.db.get(args.guardianUserId);
    if (guardian?.readOnly) return { ok: false, message: READ_ONLY_ACCOUNT_ERROR };
    const id = ctx.db.normalizeId("scheduledFreezes", args.scheduledFreezeId);
    if (!id) return { ok: false, message: "That planned freeze isn't there any more." };
    return await removeSchedule(ctx, args.guardianUserId, id, args.source);
  },
});

/** Every planned freeze for each of a guardian's children, for the aide's
 *  freeze status. Scoped by the guardian's own `guardianships` rows. */
export const listForGuardian = internalQuery({
  args: { guardianUserId: v.id("users") },
  handler: async (ctx, args) => {
    const links = await ctx.db
      .query("guardianships")
      .withIndex("by_parent", (q) => q.eq("parentUserId", args.guardianUserId))
      .collect();
    const out = [];
    for (const link of links) {
      const scholar = await ctx.db.get(link.scholarUserId);
      if (!scholar) continue;
      const rows = await ctx.db
        .query("pairedDevices")
        .withIndex("by_scholar", (q) => q.eq("scholarId", scholar._id))
        .collect();
      const timeZone = await childTimeZone(ctx, scholar, rows);
      out.push({
        scholarId: scholar._id,
        plans: await plansFor(ctx, scholar._id, timeZone),
      });
    }
    return out;
  },
});
