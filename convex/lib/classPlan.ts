// Planning a unit across a class's days (TRA-582): the pure part.
//
// A teacher asks the aide to "put the rest of Mapping Our Islands on
// Humanities through next week, one a day, skipping Wednesday". That needs a
// class's meetings on real days: the class record's weekly meetings
// (`classes.meetings`), each block's times on that day
// (shared/classMeetings.meetingsOnDay), the term the class belongs to, and
// the school's closures. This file turns those into a list of meeting days and
// answers "which meeting is N meetings after this one", with no database.
// convex/classPlans.ts does the reads and the writes.

import {
  meetingsOnDay,
  type ClassMeetingsInput,
  type MeetingBlockInput,
} from "../../shared/classMeetings";
import { shiftDayKey } from "../../shared/institutionDay";
import { isClosedDay, type SchoolClosure } from "../../shared/schoolClosures";

/** Prefix of every refusal from a class plan's confirmation check
 *  (convex/classPlans.ts), so the aide's tools can say it in words. */
export const PLAN_CONFIRMATION_REFUSED = "Confirmation refused:";

/** The longest range a teacher's request covers. */
export const MAX_PLAN_DAYS = 120;

/** The most days one scan walks (a request plus the meetings around it that a
 *  move may land on), so a typo'd year can't loop for long. */
const SCAN_LIMIT_DAYS = 366;

/** One term's record for the class: the class row and its term's bounds. */
export type PlanClassTerm<ClassId extends string = string> = {
  classId: ClassId;
  cls: ClassMeetingsInput;
  periodStartsAt: number;
  periodEndsAt: number;
  blocksById: ReadonlyMap<string, MeetingBlockInput & { label: string }>;
};

export type PlanMeeting<ClassId extends string = string> = {
  classId: ClassId;
  dayKey: string;
  startsAt: number;
  endsAt: number;
  blockLabel: string;
};

export type PlanClosedMeeting = { dayKey: string; label: string };

/**
 * The class's meetings from `fromDayKey` through `throughDayKey` (inclusive),
 * in order, and the days it would have met but the school is closed. A day
 * counts for the term whose bounds contain the meeting's start, so a range
 * that crosses a term change follows each term's own class record.
 */
export function classMeetingDays<ClassId extends string>(args: {
  terms: ReadonlyArray<PlanClassTerm<ClassId>>;
  closures: readonly SchoolClosure[];
  fromDayKey: string;
  throughDayKey: string;
  timeZone: string;
}): { meetings: PlanMeeting<ClassId>[]; closed: PlanClosedMeeting[] } {
  const meetings: PlanMeeting<ClassId>[] = [];
  const closed: PlanClosedMeeting[] = [];
  let dayKey = args.fromDayKey;
  for (let i = 0; i < SCAN_LIMIT_DAYS && dayKey <= args.throughDayKey; i++) {
    for (const term of args.terms) {
      const onDay = meetingsOnDay(
        term.cls,
        term.blocksById,
        dayKey,
        args.timeZone,
      ).filter(
        (m) => term.periodStartsAt <= m.startsAt && m.startsAt < term.periodEndsAt,
      );
      if (onDay.length === 0) continue;
      const closure = isClosedDay(dayKey, args.closures);
      if (closure) {
        closed.push({ dayKey, label: closure.label });
        continue;
      }
      for (const m of onDay) {
        meetings.push({
          classId: term.classId,
          dayKey,
          startsAt: m.startsAt,
          endsAt: m.endsAt,
          blockLabel: term.blocksById.get(m.blockId)?.label ?? "",
        });
      }
    }
    dayKey = shiftDayKey(dayKey, 1);
  }
  meetings.sort((a, b) => a.startsAt - b.startsAt);
  closed.sort((a, b) => a.dayKey.localeCompare(b.dayKey));
  return { meetings, closed };
}

/**
 * The meeting `by` meetings after (or, negative, before) the anchor, or null
 * when the list doesn't reach that far. The anchor is a give's own meeting,
 * found by its start time, so a day with two meetings (a double period) counts
 * each one. A give that isn't on a meeting (homework given at another time, or
 * a day the class no longer meets) counts from where its day would sit.
 */
export function shiftMeeting<ClassId extends string>(
  meetings: ReadonlyArray<PlanMeeting<ClassId>>,
  anchor: { dayKey: string; startsAt?: number },
  by: number,
): PlanMeeting<ClassId> | null {
  const at = meetings.findIndex((m) => m.startsAt === anchor.startsAt);
  let index: number;
  if (at !== -1) {
    index = at + by;
  } else {
    // Insertion point: the first meeting after the anchor stands one step ahead.
    const after = meetings.findIndex((m) =>
      anchor.startsAt !== undefined ? m.startsAt > anchor.startsAt : m.dayKey > anchor.dayKey,
    );
    const base = after === -1 ? meetings.length : after;
    index = by > 0 ? base + by - 1 : base + by;
  }
  return index >= 0 && index < meetings.length ? meetings[index] : null;
}

/** Key-sorted JSON with undefined dropped, so the same plan reads the same
 *  whenever it is written down (the stored confirmation compares these). */
export function canonicalJson(value: unknown): string {
  const norm = (x: unknown): unknown => {
    if (Array.isArray(x)) return x.map(norm);
    if (x && typeof x === "object") {
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(x).sort()) {
        const val = (x as Record<string, unknown>)[key];
        if (val !== undefined) out[key] = norm(val);
      }
      return out;
    }
    return x;
  };
  return JSON.stringify(norm(value) ?? null);
}
