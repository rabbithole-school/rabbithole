// Pure helpers for the class record (TRA-582) and a give's one end time
// (TRA-580). Step 1 of 5: nothing calls these yet. Step 2's writers use
// `endFromFinish` and the meeting lookups, step 3's backfill uses
// `endFromRequestedWindow` and `classMeetingAt`.
//
// A give stores `classId` + `dayKey`, plus ONE optional `endsAt` and what
// happens after it (`afterEnd`: "late" stays on the list marked late; "fade"
// leaves screens, closed as expired). A class meets at most once per weekday,
// so (class, day) names one meeting and the meeting's block supplies the
// times.
//
// Time zones and day ends come from shared/institutionDay.ts; nothing here
// does its own offset math. Imports only shared code: no Convex runtime or
// DOM.

import {
  dayEndForDayKey,
  dayKeyForTimezone,
  dayStartForDayKey,
  instantForLocalMinutes,
  shiftDayKey,
  weekdayForDayKey,
} from "./institutionDay";
import { minuteOfDayFromLocalTime } from "./deviceActivityContext";

export type AfterEnd = "late" | "fade";

/** A give's ending. `endsAt` absent = no end (open until done or ended). */
export type GiveEnd = { endsAt?: number; afterEnd: AfterEnd };

/**
 * The teacher's "When should they finish it?" answer, with end of unit already
 * resolved to a day by the caller (convex/lib/giveWindow.ts finds the latest
 * scheduled day of the assignment; this file reads no data).
 */
export type ClassFinish =
  | { kind: "inClass" }
  | { kind: "by"; dayKey: string }
  | { kind: "openUntil"; dayKey: string }
  | { kind: "endOfUnit"; dayKey: string };

/**
 * One end time from a finish answer:
 *
 *   in that class → end of the meeting (end of `dayKey` when the work shows
 *                   up outside any meeting), fade
 *   by a date     → end of that school day, late
 *   open until    → end of that day, fade
 *   end of unit   → end of the given day, late
 */
export function endFromFinish(
  finish: ClassFinish,
  ctx: {
    /** School-local day the work shows up on. */
    dayKey: string;
    /** End of the class meeting the work shows up in, if any. */
    meetingEndsAt?: number | null;
    timeZone: string;
  },
): GiveEnd {
  switch (finish.kind) {
    case "inClass":
      return {
        endsAt: ctx.meetingEndsAt ?? dayEndForDayKey(ctx.dayKey, ctx.timeZone),
        afterEnd: "fade",
      };
    case "by":
      return {
        endsAt: dayEndForDayKey(finish.dayKey, ctx.timeZone),
        afterEnd: "late",
      };
    case "openUntil":
      return {
        endsAt: dayEndForDayKey(finish.dayKey, ctx.timeZone),
        afterEnd: "fade",
      };
    case "endOfUnit":
      return {
        endsAt: dayEndForDayKey(finish.dayKey, ctx.timeZone),
        afterEnd: "late",
      };
  }
}

/**
 * A requested give window: its kind plus the explicit end (focus) or due date
 * (homework). Once the shape of the stored `pushes.timing`; since TRA-580 step
 * 5 the store keeps only the kind, and writers pass the number alongside it.
 */
export type RequestedWindow =
  | { kind: "focus"; endsAt: number }
  | { kind: "untilCleared" }
  | { kind: "homework"; dueAt?: number };

/**
 * The mapping from a requested window to one end time (the step-3 backfill
 * rule, and what every writer stamps):
 *
 *   focus        → its endsAt, fade. An "open until" give is stored as a
 *                  focus ending on a later day (shared/openUntil.ts
 *                  `isOpenUntil`), and it fades too, so it needs no arm of
 *                  its own.
 *   untilCleared → end of the school-local day of `setAt`, fade. This is
 *                  what the showing predicate already does, so kids see no
 *                  change.
 *   homework     → its dueAt, late; undated homework keeps no end.
 *
 * `setAt` is when the give went live; for planned rows pass `startsAt`.
 */
export function endFromRequestedWindow(
  timing: RequestedWindow,
  setAt: number,
  timeZone: string,
): GiveEnd {
  switch (timing.kind) {
    case "focus":
      return { endsAt: timing.endsAt, afterEnd: "fade" };
    case "untilCleared":
      return {
        endsAt: dayEndForDayKey(dayKeyForTimezone(setAt, timeZone), timeZone),
        afterEnd: "fade",
      };
    case "homework":
      return { endsAt: timing.dueAt, afterEnd: "late" };
  }
}

/** The fields of a `classes` row these helpers read. */
export type ClassMeetingsInput = {
  meetings: ReadonlyArray<{ weekday: number; blockId: string }>;
};

/** The fields of a `scheduleBlocks` row these helpers read. */
export type MeetingBlockInput = {
  startLocal: string;
  endLocal: string;
  /** 1–5 = Mon–Fri, 7 = Sun. */
  weekdays: ReadonlyArray<number>;
};

export type ClassMeeting = {
  dayKey: string;
  /** 1–5 = Mon–Fri, 7 = Sun (the scheduleBlocks convention). */
  weekday: number;
  blockId: string;
  startsAt: number;
  endsAt: number;
};

/** 1 = Mon … 7 = Sun for a day key (scheduleBlocks.weekdays convention). */
function scheduleWeekday(dayKey: string): number {
  const d = weekdayForDayKey(dayKey);
  return d === 0 ? 7 : d;
}

/** Epoch-ms for a block's wall time on a day. "24:00" means the next midnight. */
function instantForLocalTime(
  dayKey: string,
  local: string,
  timeZone: string,
): number | null {
  if (local.trim() === "24:00") {
    return dayStartForDayKey(shiftDayKey(dayKey, 1), timeZone);
  }
  const minutes = minuteOfDayFromLocalTime(local);
  if (minutes == null) return null;
  try {
    return instantForLocalMinutes(dayKey, minutes, timeZone);
  } catch (error) {
    // A wall time skipped by a spring-forward change (02:30 in New York on
    // the second Sunday of March) has no instant: that occurrence is no
    // meeting. Any other error propagates. Same distinction as
    // convex/masterSchedule.ts placementStartMs.
    const hhmm = `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
    if (
      error instanceof RangeError &&
      error.message === `${dayKey} ${hhmm} does not exist in ${timeZone}`
    ) {
      return null;
    }
    throw error;
  }
}

/**
 * A class's meetings on one school-local day, with their times. A meeting
 * counts only when its block runs that weekday (`scheduleBlocks.weekdays`)
 * and its times parse and exist that day (a DST gap is no meeting). A class meets at most once per weekday, so this is
 * normally zero or one; it returns every match rather than hide bad data.
 */
export function meetingsOnDay(
  cls: ClassMeetingsInput,
  blocksById: ReadonlyMap<string, MeetingBlockInput>,
  dayKey: string,
  timeZone: string,
): ClassMeeting[] {
  const weekday = scheduleWeekday(dayKey);
  const out: ClassMeeting[] = [];
  for (const m of cls.meetings) {
    if (m.weekday !== weekday) continue;
    const block = blocksById.get(String(m.blockId));
    if (!block || !block.weekdays.includes(weekday)) continue;
    const startsAt = instantForLocalTime(dayKey, block.startLocal, timeZone);
    const endsAt = instantForLocalTime(dayKey, block.endLocal, timeZone);
    if (startsAt == null || endsAt == null || endsAt <= startsAt) continue;
    out.push({ dayKey, weekday, blockId: String(m.blockId), startsAt, endsAt });
  }
  return out.sort((a, b) => a.startsAt - b.startsAt);
}

/**
 * The meeting of a class containing an instant (start ≤ at < end), or null.
 * The backfill uses it to link a give to the meeting at its start time.
 */
export function classMeetingAt(
  cls: ClassMeetingsInput,
  blocksById: ReadonlyMap<string, MeetingBlockInput>,
  at: number,
  timeZone: string,
): ClassMeeting | null {
  const dayKey = dayKeyForTimezone(at, timeZone);
  return (
    meetingsOnDay(cls, blocksById, dayKey, timeZone).find(
      (m) => m.startsAt <= at && at < m.endsAt,
    ) ?? null
  );
}
