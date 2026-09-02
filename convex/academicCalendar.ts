// The public academic-calendar feed's read model: one school's no-school days,
// resolved by slug so the feed is PER-INSTITUTION, not "whatever school happens
// to be primary". This deployment hosts more than one school (CLAUDE.md →
// Multi-tenancy), and the feed URL is unauthenticated — a single global feed
// would hand every other school's families the primary school's calendar, which
// looks authoritative and is wrong.
//
// Scope is deliberately narrow: `schoolClosures` only. Closures are real,
// seeded, already school-wide, and already public knowledge. Cohort, scholar,
// and staff-private schedule data is NOT exported here and must not be — an
// unauthenticated reader gets exactly what a printed school-year calendar says.

import { v } from "convex/values";
import { internalQuery, type QueryCtx } from "./_generated/server";
import { authedQuery } from "./lib/customFunctions";
import { requireGuardianOf } from "./lib/auth";
import { isProgramGuest } from "./lib/enrollmentStanding";
import { EXTENDED_EDUCATION_LABEL } from "../shared/scholarGroupRouting";
import type { Id } from "./_generated/dataModel";
import type { AcademicCalendarIcsEvent } from "../shared/academicCalendarIcs";
import { effectiveInstitutionTimeZone } from "./lib/institutionTime";
import { dayKeyForTimezone } from "../shared/institutionDay";

export type PublicAcademicCalendar = {
  calendarName: string;
  timeZone: string;
  events: AcademicCalendarIcsEvent[];
};

const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/;

/** A REAL Gregorian day, not merely a well-shaped string. The regex alone
 *  passes "2026-02-31" (JS rolls it to Mar 3) and "2026-13-01" (NaN), either of
 *  which yields a bogus DTSTART. Round-tripping through Date is what proves the
 *  day exists. */
function isRealDayKey(dayKey: string): boolean {
  if (!DAY_KEY.test(dayKey)) return false;
  const parsed = new Date(`${dayKey}T00:00:00Z`);
  return (
    !Number.isNaN(parsed.getTime()) &&
    parsed.toISOString().slice(0, 10) === dayKey
  );
}

/** One malformed row must not take the whole feed down. `startDayKey` /
 *  `endDayKey` are plain `v.string()` in the schema, and a strict calendar
 *  client rejects the ENTIRE subscription on a single bad DTSTART — so a row
 *  that can't produce a valid date is skipped rather than serialized. */
function hasUsableDays(closure: {
  startDayKey: string;
  endDayKey: string;
}): boolean {
  return (
    isRealDayKey(closure.startDayKey) &&
    isRealDayKey(closure.endDayKey) &&
    closure.endDayKey >= closure.startDayKey
  );
}

/**
 * The feed's event title. A closure lands in a parent's OWN calendar app,
 * stripped of every bit of context this app supplies — no "No school coming
 * up" heading, no closure styling — so a bare label like "Fall Break" reads as
 * an event, not as a day their child stays home. Leading with "No School"
 * makes the row self-explanatory in a month grid (operations staff review).
 *
 * A label that already says so keeps its own wording rather than becoming
 * "No School — No School Day".
 */
export function noSchoolSummary(label: string): string {
  const trimmed = label.trim();
  if (!trimmed) return "No School";
  if (/^no[-\s]?school\b/i.test(trimmed)) return trimmed;
  return `No School — ${trimmed}`;
}

/** Closures scoped to one institution, plus the institution-agnostic ones. */
async function closuresForInstitution(
  ctx: QueryCtx,
  institutionId: Id<"institutions">,
) {
  const [scoped, global] = await Promise.all([
    ctx.db
      .query("schoolClosures")
      .withIndex("by_institution", (q) => q.eq("institutionId", institutionId))
      .collect(),
    ctx.db
      .query("schoolClosures")
      .withIndex("by_institution", (q) => q.eq("institutionId", undefined))
      .collect(),
  ]);
  return [...scoped, ...global];
}

/**
 * The public calendar for ONE school.
 *
 * `slug` selects the school; omitted means the primary institution, so the bare
 * `/calendar.ics` URL keeps working for the home school. Returns `null` when
 * the slug matches nothing or the school is suspended — the HTTP route turns
 * that into a 404 rather than silently serving another school's calendar.
 */
export const publicCalendarEvents = internalQuery({
  args: { slug: v.optional(v.string()) },
  handler: async (ctx, args): Promise<PublicAcademicCalendar | null> => {
    const slug = args.slug;
    const institution = slug
      ? await ctx.db
          .query("institutions")
          .withIndex("by_slug", (q) => q.eq("slug", slug))
          .unique()
      : ((await ctx.db.query("institutions").collect()).find(
          (candidate) => candidate.isPrimary === true,
        ) ?? null);

    // Unknown school, or one that has been suspended: no feed. Never fall back
    // to a different school's calendar.
    if (!institution || institution.disabledAt !== undefined) return null;

    const events: AcademicCalendarIcsEvent[] = (
      await closuresForInstitution(ctx, institution._id)
    )
      .filter(hasUsableDays)
      .map((closure) => ({
        uid: `school-closure-${closure._id}@calendar.rabbithole`,
        startDayKey: closure.startDayKey,
        endDayKey: closure.endDayKey,
        summary: noSchoolSummary(closure.label),
        description:
          closure.kind === "staffOnly"
            ? "No school for scholars; faculty in-service."
            : "School closed.",
        category: "School closure",
        // schoolClosures has no updatedAt; rows are seed-authored and never
        // edited in place, so creation time is a stable LAST-MODIFIED. When an
        // editing UI lands, give the table an updatedAt and read it here.
        updatedAt: closure._creationTime,
      }));

    return {
      calendarName: `${institution.name} calendar`,
      timeZone: effectiveInstitutionTimeZone(institution.timeZone),
      events: events.sort(
        (left, right) =>
          left.startDayKey.localeCompare(right.startDayKey) ||
          left.endDayKey.localeCompare(right.endDayKey) ||
          left.summary.localeCompare(right.summary) ||
          left.uid.localeCompare(right.uid),
      ),
    };
  },
});

export type ScholarSchoolCalendar = {
  schoolName: string;
  schoolSlug: string;
  timeZone: string;
  today: string;
  upcoming: Array<{
    id: Id<"schoolClosures">;
    startDayKey: string;
    endDayKey: string;
    label: string;
    kind: "holiday" | "staffOnly";
  }>;
};

async function upcomingForScholarInner(
  ctx: QueryCtx,
  scholarId: Id<"users">,
): Promise<ScholarSchoolCalendar | null> {
  const scholar = await ctx.db.get(scholarId);
  if (!scholar?.institutionId) return null;
  return await upcomingForInstitutionInner(ctx, scholar.institutionId);
}

async function upcomingForInstitutionInner(
  ctx: QueryCtx,
  institutionId: Id<"institutions">,
): Promise<ScholarSchoolCalendar | null> {
  const institution = await ctx.db.get(institutionId);
  if (!institution || institution.disabledAt !== undefined) return null;

  const timeZone = effectiveInstitutionTimeZone(institution.timeZone);
  const today = dayKeyForTimezone(Date.now(), timeZone);

  const upcoming = (await closuresForInstitution(ctx, institution._id))
    .filter(hasUsableDays)
    // A multi-day break is still "upcoming" while you are inside it.
    .filter((closure) => closure.endDayKey >= today)
    .sort((left, right) => left.startDayKey.localeCompare(right.startDayKey))
    .map((closure) => ({
      id: closure._id,
      startDayKey: closure.startDayKey,
      endDayKey: closure.endDayKey,
      label: closure.label,
      kind: closure.kind,
    }));

  return {
    schoolName: institution.name,
    schoolSlug: institution.slug,
    timeZone,
    today,
    upcoming,
  };
}

/**
 * The parent portal's Calendar tab: this CHILD'S school's upcoming no-school
 * days, plus the slug that addresses that school's subscription feed.
 *
 * The slug is the whole point of returning it. A parent's calendar is their
 * child's school's calendar, so the subscribe link the UI builds must be
 * `?school=<this slug>` — never the bare `/calendar.ics`, which resolves to the
 * primary institution and would hand a second school's family the home
 * school's year. Returns `null` when the child has no institution: with no
 * school to name we cannot address a feed, and guessing is the failure this
 * whole file exists to avoid.
 */
export const upcomingForScholar = authedQuery({
  args: { scholarId: v.id("users") },
  handler: async (ctx, args): Promise<ScholarSchoolCalendar | null> => {
    await requireGuardianOf(ctx, args.scholarId);
    const scholar = await ctx.db.get(args.scholarId);
    if (scholar && isProgramGuest(scholar)) {
      throw new Error(
        `The school calendar isn't available for ${EXTENDED_EDUCATION_LABEL} scholars.`,
      );
    }
    return await upcomingForScholarInner(ctx, args.scholarId);
  },
});

/**
 * The aide tool layer's read (parent aide, staff aide, Slack). Authorization
 * happens one level up: `makeScholarReadTools` resolves a name only within the
 * caller's `allowedScholarIds` — a parent's guardianship set, a staffer's
 * institution lens — so this query is never reachable for a scholar the caller
 * cannot already see.
 */
export const getScholarCalendar = internalQuery({
  args: { scholarId: v.id("users") },
  handler: async (ctx, args): Promise<ScholarSchoolCalendar | null> =>
    await upcomingForScholarInner(ctx, args.scholarId),
});

/**
 * Shared-comment surfaces already have an institution from their monitored
 * resource. They must not invent a scholar merely to recover that same scope.
 */
export const getInstitutionCalendar = internalQuery({
  args: { institutionId: v.id("institutions") },
  handler: async (ctx, args): Promise<ScholarSchoolCalendar | null> =>
    await upcomingForInstitutionInner(ctx, args.institutionId),
});
