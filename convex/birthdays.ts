// Teacher-facing birthday surfacing. A birthday is a per-institution
// calendar-day fact derived from `users.dateOfBirth` (the low-sensitivity
// profile birthday — NOT the gated health-record `childDob`) via the one
// canonical helper in `shared/birthday.ts`. Two read surfaces:
//
//   • birthdaysForWeek — the Master Schedule day-column chip (any displayed
//     week; each column is a fixed calendar date, so no per-scholar timezone
//     is needed — the teacher is looking at "Jul 21", not "is it midnight").
//   • todaysBirthdayEntries — folded into todayForTeacher for the Today front
//     door, resolved against each scholar's OWN institution timezone so a
//     mixed-institution roster is correct at each school's midnight.
//
// Both are staff-only (teacherQuery) and scoped by the same institution lens
// as the rest of the teacher surfaces — a teacher only sees birthdays for
// scholars in their scope, data they already have.

import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import type { QueryCtx } from "./_generated/server";
import { teacherQuery } from "./lib/customFunctions";
import {
  resolveInstitutionLens,
  scholarIdsInLens,
} from "./lib/institutionLens";
import { effectiveInstitutionTimeZone } from "./lib/institutionTime";
import { dayKeyForTimezone } from "../shared/institutionDay";
import {
  addDaysToDayKey,
  isBirthdayOnDayKey,
  nthBirthdayLabel,
  nthBirthdayOnDayKey,
} from "../shared/birthday";

/** The minimal scholar shape the birthday derivations need. */
type BirthdayScholar = Pick<
  Doc<"users">,
  "_id" | "name" | "username" | "dateOfBirth" | "institutionId"
>;

type BirthdayEntry = {
  scholarId: Id<"users">;
  name: string;
  username: string | null;
  /** The age turning that day, or null when unknown / malformed. */
  nth: number | null;
  /** "11th Birthday" style label, or null when unknown. */
  nthLabel: string | null;
};

function scholarDisplayName(scholar: BirthdayScholar): string {
  return scholar.name ?? scholar.username ?? "Scholar";
}

/** Full scholar docs in the teacher's institution lens (birthday needs DOB). */
async function scopedScholarDocs(
  ctx: QueryCtx,
  user: Doc<"users">,
  institutionScope: string | undefined,
): Promise<Doc<"users">[]> {
  const lens = await resolveInstitutionLens(ctx, user, institutionScope ?? "");
  const ids = await scholarIdsInLens(ctx, lens);
  const docs = await Promise.all([...ids].map((id) => ctx.db.get(id)));
  return docs.filter((doc): doc is Doc<"users"> => doc != null);
}

/** Resolve a scholar's institution timezone, memoized by institution. */
async function timeZoneForScholarDoc(
  ctx: QueryCtx,
  scholar: BirthdayScholar,
  cache: Map<string, string>,
): Promise<string> {
  const institutionId = scholar.institutionId;
  if (!institutionId) return effectiveInstitutionTimeZone(undefined);
  const key = String(institutionId);
  const cached = cache.get(key);
  if (cached) return cached;
  const institution = await ctx.db.get(institutionId);
  const tz = effectiveInstitutionTimeZone(institution?.timeZone);
  cache.set(key, tz);
  return tz;
}

/**
 * Scholars whose birthday is TODAY, each evaluated against their own
 * institution's day-key. Used by the Today front door (folded into
 * todayForTeacher). Pure projection — writes nothing.
 */
export async function todaysBirthdayEntries(
  ctx: QueryCtx,
  scholars: BirthdayScholar[],
  now: number,
): Promise<BirthdayEntry[]> {
  const tzCache = new Map<string, string>();
  const entries: BirthdayEntry[] = [];
  for (const scholar of scholars) {
    if (!scholar.dateOfBirth) continue;
    const tz = await timeZoneForScholarDoc(ctx, scholar, tzCache);
    const dayKey = dayKeyForTimezone(now, tz);
    if (!isBirthdayOnDayKey(scholar.dateOfBirth, dayKey)) continue;
    entries.push({
      scholarId: scholar._id,
      name: scholarDisplayName(scholar),
      username: scholar.username ?? null,
      nth: nthBirthdayOnDayKey(scholar.dateOfBirth, dayKey),
      nthLabel: nthBirthdayLabel(scholar.dateOfBirth, dayKey),
    });
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  return entries;
}

type WeekBirthdayRow = BirthdayEntry & { weekday: number };

/**
 * Birthdays across a displayed Mon–Fri week, keyed to the weekday column whose
 * date matches. `mondayKey` is the "YYYY-MM-DD" of the week's Monday (the
 * client derives it from the schedule's anchor). Each column is a fixed
 * calendar date, so this compares month/day directly — no timezone step.
 */
export const birthdaysForWeek = teacherQuery({
  args: {
    mondayKey: v.string(),
    institutionScope: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<WeekBirthdayRow[]> => {
    const scholars = await scopedScholarDocs(
      ctx,
      ctx.user,
      args.institutionScope,
    );
    const rows: WeekBirthdayRow[] = [];
    for (let weekday = 1; weekday <= 5; weekday++) {
      const columnKey = addDaysToDayKey(args.mondayKey, weekday - 1);
      for (const scholar of scholars) {
        if (!scholar.dateOfBirth) continue;
        if (!isBirthdayOnDayKey(scholar.dateOfBirth, columnKey)) continue;
        rows.push({
          weekday,
          scholarId: scholar._id,
          name: scholarDisplayName(scholar),
          username: scholar.username ?? null,
          nth: nthBirthdayOnDayKey(scholar.dateOfBirth, columnKey),
          nthLabel: nthBirthdayLabel(scholar.dateOfBirth, columnKey),
        });
      }
    }
    rows.sort(
      (a, b) => a.weekday - b.weekday || a.name.localeCompare(b.name),
    );
    return rows;
  },
});
