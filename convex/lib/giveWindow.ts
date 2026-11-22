// Giving work asks two questions: "When does it show up?" and "When should they
// finish it?" (review: homework proposal v3, Layers 1–2; TRA-571).
//
// This module turns the teacher's two answers into today's storage fields —
// an `activitySchedule` entry's mode / startsAt / endsAt / dueAt — so every
// give path (the aide tools, the Run page, the assign dialog, the Master
// Schedule drawer) maps them the same way and nothing falls back to class
// focus on its own:
//
//   finish "in that class" → classFocus, endsAt = end of the bell block the
//     work shows up in, or the end of that school day when there is no block
//     (no bell schedule for the group, or an off-schedule time).
//   finish "by <day>"      → homework, dueAt = end of that day.
//   finish "end of unit"   → homework, dueAt = end of the latest day already
//     scheduled in the assignment; with nothing scheduled the give is refused
//     with a question, never guessed.
//   finish "open until <day>" → classFocus, endsAt = end of that day, which
//     must be later than the day it shows up. Available until then, then it
//     leaves the list whether or not they finished; never late. The window
//     says which finish it is (`openUntilKind`), and the store keeps it as the
//     `openUntil` or `focus` timing kind (TRA-726), so a give that later goes
//     live on its last day is still open until then.
//
// "Shows up" is a time: now, a time the teacher named, or the start of a bell
// block offered by `upcomingBellBlocks`. A block start is just a time, so the
// in-class end is found by looking the time up, never trusted from a client.
//
// The bell schedule is read through `scholarTimetableContext` — the same
// placement join the scholar's Now strip uses — so this module adds no second
// schedule reader.

import { v, type Infer } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import type { ScheduleEntry } from "./pushes";
import { scholarInstitutionId } from "./scholarEnrollment";
import { GiveQuestionError } from "./giveQuestionError";
import {
  groupsContainingRoster, loadClassLinkData, loadPeriodBlocks,
  type ClassLinkReadCache,
} from "./classLink";
import { primaryInstitutionId } from "./primaryInstitution";
import {
  currentWeekStartMs,
  loadInstitutionClosures,
  parseHHMM,
} from "../masterSchedule";
import type { SchoolClosure } from "../../shared/schoolClosures";
import { schoolDayEndAt, nextOpenSchoolDayKeys } from "./schoolDays";
import { loadInstitutionTrips, tripsForGroups } from "../fieldTrips";
import { tripContains, tripOverlaps } from "../../shared/fieldTrips";
import {
  dayKeyForTimezone,
  dayStartForDayKey,
  instantForLocalMinutes,
  shiftDayKey,
  weekdayForDayKey,
} from "../../shared/institutionDay";
import {
  lastSchoolDayOfWeek,
  thisSchoolWeekMonday,
  weekEndDueDayFor,
  weekMondayKey,
} from "../../shared/homeworkWeek";

export const giveFinishValidator = v.union(
  v.object({ kind: v.literal("inClass") }),
  // `dayKey` is the institution-local day ("2026-11-06"); due at its end.
  // `classId`: the class this homework is for, when the teacher (or the
  // aide's "next week's homework") named it (TRA-581).
  v.object({
    kind: v.literal("by"),
    dayKey: v.string(),
    classId: v.optional(v.id("classes")),
  }),
  v.object({ kind: v.literal("endOfUnit") }),
  // Available until the end of `dayKey`, then gone; never late.
  v.object({ kind: v.literal("openUntil"), dayKey: v.string() }),
);

export type GiveFinish = Infer<typeof giveFinishValidator>;

/** Whether a finish is stored as homework (a due date that goes late). "In
 *  that class" and "open until" are class focus with an end. */
export function finishIsHomework(finish: GiveFinish): boolean {
  return finish.kind === "by" || finish.kind === "endOfUnit";
}

export type GiveWindow = {
  mode: "classFocus" | "homework";
  endsAt?: number;
  /** A class focus: the teacher's finish. `true` = "open until" a later day,
   *  `false` = "in that class" (stored as the `openUntil` or `focus` timing
   *  kind, TRA-726). Absent on homework, and on a raw window from a caller
   *  that didn't say (an older client), where the store reads the dates. */
  openUntilKind?: boolean;
  dueAt?: number;
  /** Homework given for a named class (a "by" finish's `classId`). */
  homeworkClassId?: Id<"classes">;
};

export type BellBlock = {
  dayKey: string;
  subject: string;
  startsAt: number;
  endsAt: number;
  /** "Tomorrow · Humanities (9:45)" */
  label: string;
};

export { GiveQuestionError };

const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/;

/** The scheduleGroup weekday convention: 1–5 Mon–Fri, 7 Sun. */
function placementWeekday(dayKey: string): number {
  const weekday = weekdayForDayKey(dayKey);
  return weekday === 0 ? 7 : weekday;
}

function clockLabel(minutes: number): string {
  const hour24 = Math.floor(minutes / 60);
  const minute = minutes % 60;
  const hour12 = hour24 % 12 === 0 ? 12 : hour24 % 12;
  return `${hour12}:${String(minute).padStart(2, "0")}`;
}

/** "Today", "Tomorrow", or "Thu, Nov 6" relative to `todayKey`. */
export function relativeDayLabel(dayKey: string, todayKey: string): string {
  if (dayKey === todayKey) return "Today";
  if (dayKey === shiftDayKey(todayKey, 1)) return "Tomorrow";
  return new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${dayKey}T12:00:00.000Z`));
}

/**
 * A due-day suggestion's label. The week's last school day reads "This week
 * (Fri, Nov 13)" or "Next week (…)" (TRA-581's display rule: day-precise
 * underneath), except today and tomorrow, which say so.
 */
function dueDayLabel(
  dayKey: string,
  todayKey: string,
  nowMs: number,
  timeZone: string,
  closures: ReadonlyArray<{ startDayKey: string; endDayKey: string; label: string }>,
): string {
  const label = relativeDayLabel(dayKey, todayKey);
  if (dayKey === todayKey || dayKey === shiftDayKey(todayKey, 1)) return label;
  const monday = weekMondayKey(dayKey);
  if (lastSchoolDayOfWeek(monday, closures) !== dayKey) return label;
  const thisMonday = thisSchoolWeekMonday(nowMs, timeZone);
  if (monday === thisMonday) return `This week (${label})`;
  if (monday === shiftDayKey(thisMonday, 7)) return `Next week (${label})`;
  return label;
}

type RosterTimetable = {
  institutionId: Id<"institutions"> | undefined;
  /** The groups holding the whole roster (a trip of any of them takes it). */
  groupIds: Id<"scholarGroups">[];
  placements: Doc<"schedulePlacements">[];
  /** Every row of the period's grid, for working out where a double period ends. */
  blocks: Doc<"scheduleBlocks">[];
};

/**
 * The bell schedule shared by every scholar on the roster on the day `at`
 * falls in: class placements of the groups that hold the whole roster, in the
 * reporting period that COVERS `at` (so a January give reads the spring
 * timetable, not whichever term is still open). With no period covering
 * `at` there is no bell schedule. A mixed roster (no group holds all of
 * them) has no shared bell schedule, so it gets none.
 */
async function rosterTimetable(
  ctx: QueryCtx,
  scholarIds: readonly Id<"users">[],
  at: number,
  cache?: ClassLinkReadCache,
): Promise<RosterTimetable> {
  if (scholarIds.length === 0) {
    return { institutionId: undefined, groupIds: [], placements: [], blocks: [] };
  }
  const institutionId = await scholarInstitutionId(ctx, scholarIds[0]) ??
    await primaryInstitutionId(ctx) ?? undefined;
  // Intentional isolation fix: exclude foreign-stamped groups and, outside
  // the primary school, legacy institution-less periods.
  const data = await loadClassLinkData(ctx, institutionId, cache);
  const groups = groupsContainingRoster(data.groups, scholarIds);
  const groupIds = groups.map((group) => group._id);
  const empty = { institutionId, groupIds, placements: [], blocks: [] };
  if (groups.length === 0) return empty;
  const periods = data.periods;
  // Prefer the institution's own period over a legacy institution-less one.
  const rank = (period: Doc<"reportingPeriods">) =>
    period.institutionId === undefined ? 1 : 0;
  const covering = periods
    .filter((period) => period.startsAt <= at && at < period.endsAt)
    .sort((a, b) => rank(a) - rank(b))[0];
  // No period covers the date → no bell schedule that day (the give ends with
  // the school day), never another term's timetable.
  const period = covering;
  if (!period) return empty;
  const groupIdSet = new Set(groups.map((group) => String(group._id)));
  const placements = (
    await ctx.db
      .query("schedulePlacements")
      .withIndex("by_period", (q) => q.eq("periodId", period._id))
      .collect()
  ).filter(
    (placement) =>
      groupIdSet.has(String(placement.groupId)) &&
      placement.weekday != null &&
      placement.blockId != null,
  );
  const blocks = await loadPeriodBlocks(ctx, period._id, data.blocks);
  return { institutionId, groupIds, placements, blocks };
}

/** The local end of a placement, honoring a double period (`spanBlocks`). */
function placementEndLocal(
  placement: Doc<"schedulePlacements">,
  block: Doc<"scheduleBlocks">,
  blocks: Doc<"scheduleBlocks">[],
  weekday: number,
): string {
  const span = placement.spanBlocks ?? 1;
  if (span <= 1) return block.endLocal;
  // The group's effective grid for that weekday: a group override replaces
  // the shared row with the same key (as the scholar's Now strip does).
  const overrides = blocks.filter(
    (row) => row.groupId === placement.groupId && row.weekdays.includes(weekday),
  );
  const overriddenKeys = new Set(overrides.map((row) => row.key));
  const rows = [
    ...blocks.filter(
      (row) =>
        row.groupId == null &&
        row.weekdays.includes(weekday) &&
        !overriddenKeys.has(row.key),
    ),
    ...overrides,
  ].sort((a, b) => a.order - b.order);
  const index = rows.findIndex((row) => row._id === block._id);
  if (index < 0) return block.endLocal;
  return rows[Math.min(index + span - 1, rows.length - 1)].endLocal;
}

/** The roster's class blocks on one day, in start order, and the roster's
 *  field trips that day (TRA-601). The blocks include ones a trip cancels. */
async function rosterDay(
  ctx: QueryCtx,
  scholarIds: readonly Id<"users">[],
  dayKey: string,
  todayKey: string,
  timeZone: string,
  cache?: ClassLinkReadCache,
): Promise<{ blocks: BellBlock[]; trips: Doc<"fieldTrips">[] }> {
  const { institutionId, groupIds, placements, blocks } = await rosterTimetable(
    ctx,
    scholarIds,
    dayStartForDayKey(dayKey, timeZone) + 12 * 3_600_000,
    cache,
  );
  const trips = institutionId && groupIds.length > 0
    ? tripsForGroups(await loadInstitutionTrips(ctx, institutionId, dayKey, dayKey), groupIds)
    : [];
  if (placements.length === 0) return { blocks: [], trips };
  const weekday = placementWeekday(dayKey);
  const weekStart = currentWeekStartMs(
    dayStartForDayKey(dayKey, timeZone) + 12 * 3_600_000,
    timeZone,
  );
  const onDay = placements.filter(
    (placement) =>
      placement.weekday === weekday &&
      (placement.weekStartMs == null || placement.weekStartMs === weekStart),
  );
  // A concrete week's placement replaces the recurring one in the same block.
  const concreteBlocks = new Set(
    onDay
      .filter((placement) => placement.weekStartMs === weekStart)
      .map((placement) => String(placement.blockId)),
  );
  const blockById = new Map(blocks.map((block) => [String(block._id), block]));
  const out = new Map<string, BellBlock>();
  for (const placement of onDay) {
    if (
      placement.weekStartMs == null &&
      concreteBlocks.has(String(placement.blockId))
    ) {
      continue;
    }
    const block = blockById.get(String(placement.blockId));
    if (!block || (block.kind ?? "class") !== "class") continue;
    const startMin = parseHHMM(block.startLocal);
    const endMin = parseHHMM(placementEndLocal(placement, block, blocks, weekday));
    if (startMin == null || endMin == null || endMin <= startMin) continue;
    let startsAt: number;
    let endsAt: number;
    try {
      startsAt = instantForLocalMinutes(dayKey, startMin, timeZone);
      endsAt = instantForLocalMinutes(dayKey, endMin, timeZone);
    } catch {
      continue; // a DST gap: no class starts there
    }
    const subject = placement.subject.trim() || block.label;
    const key = `${startsAt}`;
    if (out.has(key)) continue;
    out.set(key, {
      dayKey,
      subject,
      startsAt,
      endsAt,
      label: `${relativeDayLabel(dayKey, todayKey)} · ${subject} (${clockLabel(startMin)})`,
    });
  }
  return { blocks: [...out.values()].sort((a, b) => a.startsAt - b.startsAt), trips };
}

/** The roster's class blocks on one day that actually meet: a block a field
 *  trip of the roster overlaps doesn't (TRA-601). */
async function bellBlocksOnDay(
  ctx: QueryCtx,
  scholarIds: readonly Id<"users">[],
  dayKey: string,
  todayKey: string,
  timeZone: string,
  cache?: ClassLinkReadCache,
): Promise<BellBlock[]> {
  const { blocks, trips } = await rosterDay(ctx, scholarIds, dayKey, todayKey, timeZone, cache);
  return blocks.filter((block) =>
    !trips.some((trip) => tripOverlaps(trip, timeZone, block.startsAt, block.endsAt)));
}

/** The roster's field trip at `at`: one whose window holds `at`, or one that
 *  cancels the class block holding `at`. Null when the roster is in school. */
async function rosterTripAt(
  ctx: QueryCtx,
  scholarIds: readonly Id<"users">[],
  at: number,
  timeZone: string,
  cache?: ClassLinkReadCache,
): Promise<Doc<"fieldTrips"> | null> {
  const dayKey = dayKeyForTimezone(at, timeZone);
  const { blocks, trips } = await rosterDay(ctx, scholarIds, dayKey, dayKey, timeZone, cache);
  const block = blocks.find((b) => b.startsAt <= at && at < b.endsAt);
  return trips.find((trip) =>
    tripContains(trip, timeZone, at) ||
    (block && tripOverlaps(trip, timeZone, block.startsAt, block.endsAt))) ?? null;
}

/** The bell block that contains `at` for this roster, if any. */
export async function bellBlockAt(
  ctx: QueryCtx,
  scholarIds: readonly Id<"users">[],
  at: number,
  timeZone: string,
  cache?: ClassLinkReadCache,
): Promise<BellBlock | null> {
  const dayKey = dayKeyForTimezone(at, timeZone);
  const blocks = await bellBlocksOnDay(
    ctx,
    scholarIds,
    dayKey,
    dayKeyForTimezone(at, timeZone),
    timeZone,
    cache,
  );
  return blocks.find((block) => block.startsAt <= at && at < block.endsAt) ?? null;
}

/**
 * The last bell on `dayKey`: when the last class block of the day ends. For a
 * roster, its own bell schedule (the blocks its groups have classes in); for
 * the whole school (an empty roster), the school's shared grid in the period
 * covering that day. Null when there is no class block that day. Closures are
 * the caller's to check.
 */
export async function lastBellAt(
  ctx: QueryCtx,
  args: {
    rosterIds: readonly Id<"users">[];
    institutionId: Id<"institutions">;
    dayKey: string;
    timeZone: string;
  },
): Promise<number | null> {
  const { rosterIds, dayKey, timeZone } = args;
  if (rosterIds.length > 0) {
    const blocks = await bellBlocksOnDay(ctx, rosterIds, dayKey, dayKey, timeZone);
    return blocks.length > 0 ? Math.max(...blocks.map((b) => b.endsAt)) : null;
  }
  const midday = dayStartForDayKey(dayKey, timeZone) + 12 * 3_600_000;
  const data = await loadClassLinkData(ctx, args.institutionId);
  const rank = (period: Doc<"reportingPeriods">) =>
    period.institutionId === undefined ? 1 : 0;
  const period = data.periods
    .filter((p) => p.startsAt <= midday && midday < p.endsAt)
    .sort((a, b) => rank(a) - rank(b))[0];
  if (!period) return null;
  const weekday = placementWeekday(dayKey);
  let lastMin: number | null = null;
  for (const block of await loadPeriodBlocks(ctx, period._id, data.blocks)) {
    if (block.groupId != null || (block.kind ?? "class") !== "class") continue;
    if (!block.weekdays.includes(weekday)) continue;
    const end = parseHHMM(block.endLocal);
    if (end != null && (lastMin == null || end > lastMin)) lastMin = end;
  }
  if (lastMin == null) return null;
  try {
    return instantForLocalMinutes(dayKey, lastMin, timeZone);
  } catch {
    return null; // a DST gap
  }
}

/**
 * The roster's upcoming class blocks — today's and the next few open school
 * days' — for the "Shows up" choices. Only blocks that haven't STARTED are
 * offered: a block already under way is "Now, in this class" (the
 * `currentBlock` of `giveChoices`), never a start time in the past. Empty when
 * the group has no bell schedule.
 */
export async function upcomingBellBlocks(
  ctx: QueryCtx,
  args: {
    scholarIds: readonly Id<"users">[];
    institutionId: Id<"institutions"> | undefined;
    timeZone: string;
    nowMs: number;
    days?: number;
  },
): Promise<BellBlock[]> {
  const todayKey = dayKeyForTimezone(args.nowMs, args.timeZone);
  const dayKeys = [
    todayKey,
    ...(await nextOpenSchoolDayKeys(
      ctx,
      args.institutionId,
      todayKey,
      args.timeZone,
      args.days ?? 4,
    )),
  ];
  const out: BellBlock[] = [];
  for (const dayKey of dayKeys) {
    for (const block of await bellBlocksOnDay(
      ctx,
      args.scholarIds,
      dayKey,
      todayKey,
      args.timeZone,
    )) {
      if (block.startsAt > args.nowMs) out.push(block);
    }
  }
  return out;
}

/** The latest day any entry in this schedule is planned, live, or due. */
export function latestScheduledDayKey(
  schedule: ReadonlyArray<ScheduleEntry> | undefined,
  timeZone: string,
  excludeActivityId?: Id<"activities">,
): string | null {
  let latest: number | null = null;
  for (const entry of schedule ?? []) {
    if (excludeActivityId && entry.activityId === excludeActivityId) continue;
    for (const at of [entry.startsAt, entry.dueAt, entry.endsAt, entry.setAt]) {
      if (at != null && (latest == null || at > latest)) latest = at;
    }
  }
  return latest == null ? null : dayKeyForTimezone(latest, timeZone);
}

export type GiveChoices = {
  timeZone: string;
  todayDayKey: string;
  /** Class blocks that haven't started yet, for "Shows up" (empty without a
   *  bell schedule). */
  blocks: BellBlock[];
  /** The class under way right now, if any: "Now, in this class". */
  currentBlock: BellBlock | null;
  /** The class unit work showing up at the chosen start is filed under,
   *  when that isn't the class meeting then (its unit's subject's class,
   *  TRA-725), and the class meeting then, if any. Set only by
   *  `assignments.giveChoices`. */
  filedUnder?: string;
  filedShownIn?: string | null;
  /** When "in that class" would end for work showing up at `startsAt`.
   *  An app, a file or a link given with no class meeting ends at the last
   *  bell (`lastBell`), or can't be given "in that class" at all
   *  (`unavailable`, the reason; convex/pushes.ts `focusGiveChoices`). */
  inClass: {
    endsAt: number;
    blockLabel: string | null;
    lastBell?: boolean;
    unavailable?: string;
  };
  /** Due-day suggestions for "By <date>": the next open day and the week's
   *  last school day (`isWeekEnd`, the "this week" default; TRA-581). */
  dueDays: { dayKey: string; label: string; isWeekEnd: boolean }[];
  /** The day "by the end of the unit" means, or null when nothing is scheduled. */
  endOfUnit: { dayKey: string; label: string } | null;
  /** The institution's closures from today on, so a "by" date that isn't a
   *  school day can be pointed out (shared/schoolClosures.ts nonSchoolDayNote).
   *  A warning only: such a date is still accepted. */
  closures: SchoolClosure[];
};

/** Everything the give form and the aide's question need to offer choices. */
export async function giveChoices(
  ctx: QueryCtx,
  args: {
    scholarIds: readonly Id<"users">[];
    institutionId: Id<"institutions"> | undefined;
    timeZone: string;
    nowMs: number;
    startsAt?: number;
    schedule?: ReadonlyArray<ScheduleEntry> | undefined;
    excludeActivityId?: Id<"activities">;
  },
): Promise<GiveChoices> {
  const { timeZone, nowMs } = args;
  const todayDayKey = dayKeyForTimezone(nowMs, timeZone);
  const startsAt = args.startsAt ?? nowMs;
  const startDayKey = dayKeyForTimezone(startsAt, timeZone);
  const blocks = await upcomingBellBlocks(ctx, {
    scholarIds: args.scholarIds,
    institutionId: args.institutionId,
    timeZone,
    nowMs,
  });
  const block = await bellBlockAt(ctx, args.scholarIds, startsAt, timeZone);
  const currentBlock =
    startsAt === nowMs
      ? block
      : await bellBlockAt(ctx, args.scholarIds, nowMs, timeZone);
  const label = (dayKey: string) => relativeDayLabel(dayKey, todayDayKey);
  const [nextOpen] = await nextOpenSchoolDayKeys(
    ctx,
    args.institutionId,
    startDayKey,
    timeZone,
    1,
  );
  const closures = (await loadInstitutionClosures(ctx, args.institutionId))
    .filter(
      (c) =>
        (c.startDayKey > c.endDayKey ? c.startDayKey : c.endDayKey) >=
        todayDayKey,
    )
    .map(({ startDayKey, endDayKey, label, kind }) => ({
      startDayKey,
      endDayKey,
      label,
      kind,
    }));
  // "This week" (TRA-581): the last school day of the week the work shows up
  // in, so a holiday Friday makes it Thursday. Showing up on a weekend, or
  // after that day, means the following week's.
  const weekEnd = weekEndDueDayFor(startDayKey, closures);
  const dueDays = [...new Set([nextOpen, weekEnd].filter((d): d is string => !!d))]
    .sort()
    .map((dayKey) => ({
      dayKey,
      label: dueDayLabel(dayKey, todayDayKey, nowMs, timeZone, closures),
      isWeekEnd: dayKey === weekEnd,
    }));
  const lastDay = latestScheduledDayKey(
    args.schedule,
    timeZone,
    args.excludeActivityId,
  );
  return {
    timeZone,
    todayDayKey,
    blocks,
    currentBlock,
    inClass: {
      endsAt: block?.endsAt ?? schoolDayEndAt(startDayKey, timeZone),
      blockLabel: block?.subject ?? null,
    },
    dueDays,
    endOfUnit:
      lastDay && lastDay >= startDayKey
        ? { dayKey: lastDay, label: label(lastDay) }
        : null,
    closures,
  };
}

/**
 * Map the teacher's two answers onto today's fields. `startsAt` is when the
 * work shows up (now, a named time, or a bell-block start).
 */
export async function resolveGiveWindow(
  ctx: QueryCtx,
  args: {
    scholarIds: readonly Id<"users">[];
    timeZone: string;
    startsAt: number;
    finish: GiveFinish;
    /** For "end of unit": the assignment whose schedule defines the end. */
    schedule?: ReadonlyArray<ScheduleEntry> | undefined;
    activityId?: Id<"activities">;
  },
  cache?: ClassLinkReadCache,
): Promise<GiveWindow> {
  const startDayKey = dayKeyForTimezone(args.startsAt, args.timeZone);
  switch (args.finish.kind) {
    case "inClass": {
      // "In that class" during a field trip has no class to end with, so the
      // teacher picks the finish instead of a guessed one (TRA-601).
      const trip = await rosterTripAt(
        ctx,
        args.scholarIds,
        args.startsAt,
        args.timeZone,
        cache,
      );
      if (trip) {
        throw new GiveQuestionError(
          `They're on the field trip to ${trip.destination} then, so that class isn't meeting. When should they finish it?`,
        );
      }
      const block = await bellBlockAt(
        ctx,
        args.scholarIds,
        args.startsAt,
        args.timeZone,
        cache,
      );
      return {
        mode: "classFocus",
        endsAt: block?.endsAt ?? schoolDayEndAt(startDayKey, args.timeZone),
        openUntilKind: false,
      };
    }
    case "by": {
      const dayKey = args.finish.dayKey.trim();
      if (!DAY_KEY.test(dayKey)) {
        throw new GiveQuestionError(
          `"${dayKey}" isn't a date. Which day should they finish it by?`,
        );
      }
      if (dayKey < startDayKey) {
        throw new GiveQuestionError(
          "That finish date is before the work shows up. Which day should they finish it by?",
        );
      }
      return {
        mode: "homework",
        dueAt: schoolDayEndAt(dayKey, args.timeZone),
        ...(args.finish.classId ? { homeworkClassId: args.finish.classId } : {}),
      };
    }
    case "openUntil": {
      const dayKey = args.finish.dayKey.trim();
      if (!DAY_KEY.test(dayKey)) {
        throw new GiveQuestionError(
          `"${dayKey}" isn't a date. Which day should it stay open until?`,
        );
      }
      if (dayKey <= startDayKey) {
        throw new GiveQuestionError(
          "Open until has to be a later day than the one it shows up on (for the same day, that's \"in that class\"). Which day should it stay open until?",
        );
      }
      return {
        mode: "classFocus",
        endsAt: schoolDayEndAt(dayKey, args.timeZone),
        openUntilKind: true,
      };
    }
    case "endOfUnit": {
      const lastDay = latestScheduledDayKey(
        args.schedule,
        args.timeZone,
        args.activityId,
      );
      if (!lastDay || lastDay < startDayKey) {
        throw new GiveQuestionError(
          "Nothing else in this unit is scheduled yet, so there's no end of unit to finish by. Which day should they finish it by?",
        );
      }
      return { mode: "homework", dueAt: schoolDayEndAt(lastDay, args.timeZone) };
    }
  }
}
