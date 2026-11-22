// School › Screen time's per-scholar-day summary: one small `screenTimeDays`
// row per scholar per school-local day, read by the Week and Month views.
//
// WHY. Week and Month used to re-roll the whole school's raw device events
// (plus app plays, web sessions, tutor turns and practice attempts) on every
// read, and every BunnyPad heartbeat batch (about one a minute per iPad)
// invalidated the subscription covering today. During school hours each open
// tab reread 10–15k events every few seconds. A month is now ~1,000 small
// rows, and a subscription updates only when a summary row is written.
//
// ONE READ MODEL. A row is exactly what `readScholarDayUsage` returns for
// that scholar-day (with the day strip's classifier for the kinds), so the
// table, the day strip and the summary cannot disagree. There is no second
// roll-up or classifier here.
//
// FRESHNESS, the Convex way:
//   • `deviceActivity.record` marks the scholar-day dirty
//     (lib/screenTimeDirty.ts). Only the mark that INSERTS the dirty row
//     schedules a recompute, RECOMPUTE_DELAY_MS out, so a busy iPad costs at
//     most one recompute every couple of minutes, and only for scholars who
//     are actually on a BunnyPad.
//   • App plays, web sessions, practice attempts and tutor turns do not mark
//     anything. On a BunnyPad they happen alongside device events, which
//     already schedule a recompute that reads them; anything else (a laptop
//     session, a web-only day) is picked up by the nightly pass.
//   • The nightly pass (`finalizeYesterday`, hourly cron) recomputes each
//     school's previous local day for every scholar once, then records the day
//     as covered.
//   • `backfill` walks history a day at a time with the same per-day pass.
//
// COVERAGE. A Week or Month is served from summary rows only when every past
// day in it is covered for every school in the lens (`periodUsage.complete`);
// otherwise the page falls back to the live read, so nothing goes blank before
// the backfill has run.
//
// Staff-only, like the page: timing and titles of launched apps only, no
// transcript content.

import { v } from "convex/values";
import { internalMutation, type MutationCtx, type QueryCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { scholarAdminQuery } from "./lib/customFunctions";
import {
  lensInstitutionForScholar,
  resolveInstitutionLens,
} from "./lib/institutionLens";
import { primaryInstitutionId } from "./lib/primaryInstitution";
import {
  MAX_ROLLUP_DAYS,
  assertDayRange,
  readScholarDayUsage,
  type DayKinds,
  type ScholarDayUsage,
  type ScholarUsageScope,
} from "./deviceActivity";
import { kindMinutesAtBell } from "../shared/screenTimeStretches";
import { SCREEN_TIME_FIRST_DAY_KEY } from "../shared/screenTimeWeek";
import {
  DEFAULT_TIMEZONE,
  dayKeyForTimezone,
  shiftDayKey,
} from "../shared/institutionDay";

/** Spacing between the runs of one school-day pass. */
export const SUMMARY_STAGGER_MS = 1_000;
/** How long `backfill` waits before the next day, so passes never overlap. */
export const BACKFILL_DAY_GAP_MS = 2 * 60_000;

/** The summary's per-kind minutes, at school and outside school. */
export type { DayKinds };

/** A summary row as the page reads it: a `dailyUsage` row plus its kinds. */
export type ScholarDaySummary = ScholarDayUsage & { kinds: DayKinds };

/** One scholar's own read scope at one school (the roundup's cohort scope). */
async function scholarScope(
  ctx: QueryCtx,
  institutionId: Id<"institutions">,
  scholarId: Id<"users">,
): Promise<ScholarUsageScope> {
  return {
    institutionIds: [institutionId],
    scholarIds: [scholarId],
    roster: async () => [scholarId],
    scholarAllowed: () => true,
    playInstitutionAllowed: (id) => id === institutionId,
    primaryInstitutionId: (await primaryInstitutionId(ctx)) ?? undefined,
    fallbackInstitutionId: institutionId,
  };
}

/** The school a scholar's screen time belongs to, or null when unresolved. */
async function institutionForScholar(
  ctx: QueryCtx,
  scholar: Doc<"users">,
): Promise<Id<"institutions"> | null> {
  const placement = await lensInstitutionForScholar(ctx, scholar);
  if (!placement.resolved) return null;
  return placement.institutionId ?? (await primaryInstitutionId(ctx));
}

/**
 * Recompute one scholar-day at one school from the live read model and
 * upsert its row (or delete it when that school saw no usage). A row is per
 * scholar, school and day: a scholar placed at one school who uses an iPad
 * paired to another has a row at each, exactly as each school's live read
 * sees them, so neither school's pass can erase the other's minutes.
 */
export async function recomputeScholarDay(
  ctx: MutationCtx,
  scholarId: Id<"users">,
  dayKey: string,
  institutionId: Id<"institutions">,
): Promise<"written" | "deleted" | "unchanged"> {
  const existing = (
    await ctx.db
      .query("screenTimeDays")
      .withIndex("by_scholar_day", (q) => q.eq("scholarId", scholarId).eq("dayKey", dayKey))
      .collect()
  ).filter((row) => row.institutionId === institutionId);
  const rows = await readScholarDayUsage(
    ctx,
    await scholarScope(ctx, institutionId, scholarId),
    dayKey,
    dayKey,
    { timeline: true, timelineDetails: false },
  );
  const row = rows.find((candidate) => candidate.scholarId === scholarId);
  if (!row) {
    for (const stale of existing) await ctx.db.delete(stale._id);
    return existing.length > 0 ? "deleted" : "unchanged";
  }
  // Strip the fields the row stores elsewhere or resolves at read time.
  const {
    scholarId: _scholarId,
    scholarName: _scholarName,
    dayKey: _dayKey,
    timeline,
    ...usage
  } = row;
  const fields = {
    scholarId,
    institutionId,
    dayKey,
    usage,
    kinds: kindMinutesAtBell(timeline?.stretches ?? [], timeline?.schoolHours ?? []),
    computedAt: Date.now(),
  };
  const [keep, ...duplicates] = existing;
  for (const duplicate of duplicates) await ctx.db.delete(duplicate._id);
  if (keep) await ctx.db.replace(keep._id, fields);
  else await ctx.db.insert("screenTimeDays", fields);
  return "written";
}

/** The debounced recompute `lib/screenTimeDirty.ts` schedules. */
export const recompute = internalMutation({
  args: {
    scholarId: v.id("users"),
    dayKey: v.string(),
    institutionId: v.id("institutions"),
  },
  handler: async (ctx, { scholarId, dayKey, institutionId }) => {
    // Clear the mark first: activity after this point marks the day again
    // and schedules the next recompute. (If this run throws, the delete rolls
    // back too, and markScreenTimeDirty reschedules once the mark is stale.)
    const marks = await ctx.db
      .query("screenTimeDirty")
      .withIndex("by_scholar_day", (q) => q.eq("scholarId", scholarId).eq("dayKey", dayKey))
      .collect();
    for (const mark of marks) {
      if (mark.institutionId === institutionId) await ctx.db.delete(mark._id);
    }
    return await recomputeScholarDay(ctx, scholarId, dayKey, institutionId);
  },
});

/** Every scholar whose screen time belongs to `institutionId`. */
async function scholarsOfInstitution(
  ctx: QueryCtx,
  institutionId: Id<"institutions">,
): Promise<Id<"users">[]> {
  const ids = new Set<Id<"users">>();
  const stamped = await ctx.db
    .query("users")
    .withIndex("by_institution_role", (q) =>
      q.eq("institutionId", institutionId).eq("role", "scholar"),
    )
    .collect();
  for (const scholar of stamped) ids.add(scholar._id);
  // A scholar with no `institutionId` is placed by membership, or rides the
  // primary school (lensInstitutionForScholar).
  const unstamped = await ctx.db
    .query("users")
    .withIndex("by_institution_role", (q) =>
      q.eq("institutionId", undefined).eq("role", "scholar"),
    )
    .collect();
  for (const scholar of unstamped) {
    if ((await institutionForScholar(ctx, scholar)) === institutionId) {
      ids.add(scholar._id);
    }
  }
  return [...ids];
}

/** Scholars recomputed per `summarizeChunk` run, well inside the read limits. */
export const SUMMARY_CHUNK = 2;

/**
 * Summarize one school-day for everyone: every scholar of the school, every
 * scholar paired to one of its iPads, and anyone who already has a row there
 * that day (a guest, a staff test). The work runs in `summarizeChunk`, a few
 * scholars per run, and only the last run records the day as covered, so a
 * day is never served from the summary while its rows are still being
 * written, and a run that fails leaves the day uncovered for the next pass.
 */
export async function summarizeInstitutionDay(
  ctx: MutationCtx,
  institutionId: Id<"institutions">,
  dayKey: string,
): Promise<number> {
  const ids = new Set(await scholarsOfInstitution(ctx, institutionId));
  const paired = await ctx.db
    .query("pairedDevices")
    .withIndex("by_institution", (q) => q.eq("institutionId", institutionId))
    .collect();
  for (const device of paired) {
    if (device.scholarId) ids.add(device.scholarId);
  }
  const existing = await ctx.db
    .query("screenTimeDays")
    .withIndex("by_institution_day", (q) =>
      q.eq("institutionId", institutionId).eq("dayKey", dayKey),
    )
    .collect();
  for (const row of existing) ids.add(row.scholarId);
  await ctx.scheduler.runAfter(0, internal.screenTimeDays.summarizeChunk, {
    institutionId,
    dayKey,
    scholarIds: [...ids],
  });
  return ids.size;
}

/** A few scholars of one school-day's pass; the last run covers the day. */
export const summarizeChunk = internalMutation({
  args: {
    institutionId: v.id("institutions"),
    dayKey: v.string(),
    scholarIds: v.array(v.id("users")),
  },
  handler: async (ctx, { institutionId, dayKey, scholarIds }) => {
    for (const scholarId of scholarIds.slice(0, SUMMARY_CHUNK)) {
      await recomputeScholarDay(ctx, scholarId, dayKey, institutionId);
    }
    const rest = scholarIds.slice(SUMMARY_CHUNK);
    if (rest.length > 0) {
      await ctx.scheduler.runAfter(SUMMARY_STAGGER_MS, internal.screenTimeDays.summarizeChunk, {
        institutionId,
        dayKey,
        scholarIds: rest,
      });
      return { remaining: rest.length };
    }
    const coverage = await ctx.db
      .query("screenTimeDayCoverage")
      .withIndex("by_institution_day", (q) =>
        q.eq("institutionId", institutionId).eq("dayKey", dayKey),
      )
      .unique();
    if (coverage) await ctx.db.patch(coverage._id, { summarizedAt: Date.now() });
    else {
      await ctx.db.insert("screenTimeDayCoverage", {
        institutionId,
        dayKey,
        summarizedAt: Date.now(),
      });
    }
    return { remaining: 0 };
  },
});

/**
 * The nightly pass, run hourly so each school's previous local day is
 * summarized soon after its own midnight, whatever its time zone. A day
 * already covered is skipped, so each day runs once.
 */
export const finalizeYesterday = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const summarized: { institutionId: Id<"institutions">; dayKey: string; scholars: number }[] = [];
    for (const institution of await ctx.db.query("institutions").collect()) {
      if (institution.disabledAt !== undefined) continue;
      const timeZone = institution.timeZone ?? DEFAULT_TIMEZONE;
      const dayKey = shiftDayKey(dayKeyForTimezone(now, timeZone), -1);
      if (dayKey < SCREEN_TIME_FIRST_DAY_KEY) continue;
      const covered = await ctx.db
        .query("screenTimeDayCoverage")
        .withIndex("by_institution_day", (q) =>
          q.eq("institutionId", institution._id).eq("dayKey", dayKey),
        )
        .unique();
      if (covered) continue;
      summarized.push({
        institutionId: institution._id,
        dayKey,
        scholars: await summarizeInstitutionDay(ctx, institution._id, dayKey),
      });
    }
    return summarized;
  },
});

/**
 * Summarize history, one school-day per run: this run summarizes `fromDayKey`
 * and schedules the next day BACKFILL_DAY_GAP_MS later, through `toDayKey`
 * (default: the school's yesterday). With no `institutionId` it starts one
 * walk per live school. Days already covered are skipped unless `force`.
 * Idempotent, so it can be rerun from any day; a day whose pass failed stays
 * uncovered and is picked up by a rerun.
 *
 * Prod: run once after the deploy, with approval (see the PR):
 *   npx convex run screenTimeDays:backfill '{}' --prod
 */
export const backfill = internalMutation({
  args: {
    institutionId: v.optional(v.id("institutions")),
    fromDayKey: v.optional(v.string()),
    toDayKey: v.optional(v.string()),
    /**
     * Redo covered days too: after a closure or bell-schedule change that
     * moves past minutes across the bell, since a covered day is otherwise
     * never recomputed.
     */
    force: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    if (!args.institutionId) {
      const started: Id<"institutions">[] = [];
      for (const institution of await ctx.db.query("institutions").collect()) {
        if (institution.disabledAt !== undefined) continue;
        await ctx.scheduler.runAfter(0, internal.screenTimeDays.backfill, {
          institutionId: institution._id,
          fromDayKey: args.fromDayKey,
          toDayKey: args.toDayKey,
          force: args.force,
        });
        started.push(institution._id);
      }
      return { started };
    }
    const institution = await ctx.db.get(args.institutionId);
    if (!institution) return { done: true };
    const timeZone = institution.timeZone ?? DEFAULT_TIMEZONE;
    const toDayKey = args.toDayKey ?? shiftDayKey(dayKeyForTimezone(now, timeZone), -1);
    let dayKey = args.fromDayKey ?? SCREEN_TIME_FIRST_DAY_KEY;
    if (dayKey < SCREEN_TIME_FIRST_DAY_KEY) dayKey = SCREEN_TIME_FIRST_DAY_KEY;
    // Skip covered days without spending a run on each.
    while (!args.force && dayKey <= toDayKey) {
      const covered = await ctx.db
        .query("screenTimeDayCoverage")
        .withIndex("by_institution_day", (q) =>
          q.eq("institutionId", institution._id).eq("dayKey", dayKey),
        )
        .unique();
      if (!covered) break;
      dayKey = shiftDayKey(dayKey, 1);
    }
    if (dayKey > toDayKey) return { done: true };
    const scholars = await summarizeInstitutionDay(ctx, institution._id, dayKey);
    const next = shiftDayKey(dayKey, 1);
    if (next <= toDayKey) {
      await ctx.scheduler.runAfter(BACKFILL_DAY_GAP_MS, internal.screenTimeDays.backfill, {
        institutionId: institution._id,
        fromDayKey: next,
        toDayKey,
        force: args.force,
      });
    }
    return { done: next > toDayKey, dayKey, scholars };
  },
});

/**
 * Week and Month's read: every summary row in the range for the caller's
 * lens, with `complete` saying whether every day before `todayDayKey` is
 * covered for every school in it. The gate and scope are `dailyUsage`'s:
 * a row is the caller's to read when its school is in the lens, the same rule
 * the live whole-school read applies to device events.
 *
 * `todayDayKey` comes from the page (school-local), so this query never reads
 * the clock (T11): today's rows are always partial, and need no coverage.
 */
export const periodUsage = scholarAdminQuery({
  args: {
    institutionScope: v.optional(v.string()),
    startDayKey: v.string(),
    endDayKey: v.string(),
    todayDayKey: v.string(),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{ complete: boolean; rows: ScholarDaySummary[] }> => {
    const startDayKey = args.startDayKey.trim();
    const endDayKey = args.endDayKey.trim();
    assertDayRange(startDayKey, endDayKey, MAX_ROLLUP_DAYS);
    const lens = await resolveInstitutionLens(ctx, ctx.user, args.institutionScope ?? "");
    const institutionIds =
      lens.scope === "all"
        ? [...lens.allowedInstitutionIds]
        : lens.institution && lens.allowedInstitutionIds.has(lens.institution._id)
          ? [lens.institution._id]
          : [];

    const lastPastDay =
      endDayKey < args.todayDayKey ? endDayKey : shiftDayKey(args.todayDayKey, -1);

    let complete = true;
    const docs: Doc<"screenTimeDays">[] = [];
    for (const institutionId of institutionIds) {
      // Days before reporting began, or before this school existed, have
      // nothing to summarize and need no coverage.
      const institution = await ctx.db.get(institutionId);
      const createdDayKey = institution
        ? dayKeyForTimezone(institution._creationTime, institution.timeZone ?? DEFAULT_TIMEZONE)
        : SCREEN_TIME_FIRST_DAY_KEY;
      const firstNeeded = [startDayKey, SCREEN_TIME_FIRST_DAY_KEY, createdDayKey].sort()[2];
      if (firstNeeded <= lastPastDay) {
        const covered = await ctx.db
          .query("screenTimeDayCoverage")
          .withIndex("by_institution_day", (q) =>
            q
              .eq("institutionId", institutionId)
              .gte("dayKey", firstNeeded)
              .lte("dayKey", lastPastDay),
          )
          .collect();
        const coveredDays = new Set(covered.map((row) => row.dayKey));
        for (let day = firstNeeded; day <= lastPastDay; day = shiftDayKey(day, 1)) {
          if (!coveredDays.has(day)) complete = false;
        }
      }
      docs.push(
        ...(await ctx.db
          .query("screenTimeDays")
          .withIndex("by_institution_day", (q) =>
            q
              .eq("institutionId", institutionId)
              .gte("dayKey", startDayKey)
              .lte("dayKey", endDayKey),
          )
          .collect()),
      );
    }

    const names = new Map<Id<"users">, string>();
    // A scholar seen at two schools in one lens on one day (an iPad paired to
    // another school) is one row on the page, as in the live read.
    const byScholarDay = new Map<string, ScholarDaySummary>();
    for (const doc of docs) {
      if (!names.has(doc.scholarId)) {
        names.set(doc.scholarId, (await ctx.db.get(doc.scholarId))?.name ?? "Unknown scholar");
      }
      const row: ScholarDaySummary = {
        ...doc.usage,
        scholarId: doc.scholarId,
        scholarName: names.get(doc.scholarId) ?? "Unknown scholar",
        dayKey: doc.dayKey,
        kinds: doc.kinds,
      };
      const key = `${doc.scholarId}::${doc.dayKey}`;
      const earlier = byScholarDay.get(key);
      byScholarDay.set(key, earlier ? mergeSummaries(earlier, row) : row);
    }
    const rows = [...byScholarDay.values()];
    rows.sort(
      (a, b) =>
        a.dayKey.localeCompare(b.dayKey) ||
        String(a.scholarId).localeCompare(String(b.scholarId)),
    );
    return { complete, rows };
  },
});

/** Sum every number in two same-shaped objects; keep the first's other values. */
function sumNumbers<T>(a: T, b: T): T {
  if (typeof a === "number" && typeof b === "number") return (a + b) as T;
  if (a && b && typeof a === "object" && typeof b === "object" && !Array.isArray(a)) {
    const out: Record<string, unknown> = { ...(a as Record<string, unknown>) };
    for (const [key, value] of Object.entries(b as Record<string, unknown>)) {
      out[key] = key in out ? sumNumbers(out[key], value) : value;
    }
    return out as T;
  }
  return a;
}

/** One scholar-day from two schools' rows. */
function mergeSummaries(a: ScholarDaySummary, b: ScholarDaySummary): ScholarDaySummary {
  const { scholarId, scholarName, dayKey, apps: appsA, schoolDay: schoolDayA, ...numbersA } = a;
  const { apps: appsB, schoolDay: schoolDayB, scholarId: _s, scholarName: _n, dayKey: _d, ...numbersB } = b;
  return {
    ...sumNumbers(numbersA, numbersB),
    scholarId,
    scholarName,
    dayKey,
    apps: [...appsA, ...appsB],
    schoolDay: schoolDayA || schoolDayB,
  };
}
