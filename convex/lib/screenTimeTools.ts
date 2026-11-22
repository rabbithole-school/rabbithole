// get_scholar_screen_time — the staff assistant's read of how long scholars
// had Rabbithole on screen, per day, in and outside school hours.
//
// Why this exists: asked how much one scholar used Rabbithole over two weeks,
// the Slack bot had no screen-time read, rebuilt usage from tutor-chat and
// web-activity timestamps (about 2 hours), and missed the device telemetry
// (about 13 hours in school). The numbers already exist: the staff Screen
// time page and the Friday recap read `deviceActivity.readScholarDayUsage`.
// This tool reads the same rollup through `dailyUsageForAide`, which runs the
// staff page's own gate (`readDailyUsageForCaller`), so it adds no second
// rollup and no second notion of who may see what.
//
// "A breakdown of <scholar>'s screen time on <date>" is the same tool with
// startDate = endDate: a one-day read of a named scholar also carries the Day
// view's stretches (`timeline`), read through the same query and gate with
// `timeline: true`, which runs the classifier `dayTimeline` uses. Each day's
// minutes by activity type come from that timeline, or for longer ranges
// from the `screenTimeDays` summary rows the same classifier wrote.
//
// One scholar per query: a whole school over two weeks can pass Convex's
// per-query read limit, so a group is fanned out here, one query per member.
//
// Built in assembleCurriculumTools, so the in-app aide, the Slack bot and
// both MCP endpoints (the read-only one admits it by its `get_` name) share
// this single code path. Teacher-class roles only; parents and scholars never.

import type { Id } from "../_generated/dataModel";
import { internal } from "../_generated/api";
import type { ActionCtx } from "../_generated/server";
import type { DayKinds, ScholarDayUsage } from "../deviceActivity";
import {
  STRETCH_KINDS,
  STRETCH_KIND_LABELS,
  type StretchKind,
} from "../../shared/screenTimeStretches";
import {
  DEFAULT_TIMEZONE,
  dayKeyForTimezone,
  minuteOfDayForTimezone,
} from "../../shared/institutionDay";
import type { AideEmit } from "./aideStream";
import { isTeacherRole, type Role } from "./roles";
import { resolveScholarByName } from "./scholarReadTools";

export const SCREEN_TIME_TOOL_NAME = "get_scholar_screen_time";

/** A group read past this many scholars is refused rather than truncated. */
export const MAX_SCREEN_TIME_SCHOLARS = 40;

/** Printed on every result so the model reads the numbers the same way. */
export const SCREEN_TIME_GUIDE =
  "foregroundMinutes = Rabbithole was the app on the BunnyPad's screen, from the iPad's own lifecycle events. It is time on screen, NOT proof the scholar was engaged or working; never say they 'worked' or 'learned' for that long. inSchoolForegroundMinutes / outsideSchoolForegroundMinutes split it at the bell schedule (weekends, closed days and time outside the school-day window are outside school). webActivityMinutes is how long launcher web activities (e.g. Epic) were OPEN; a web span can stay open for hours after the scholar stopped, so treat it as an upper bound and don't add it to foreground minutes (it overlaps them). builder.onScreenMinutes is the scholar's own app on screen; builder.activeMinutes is the part near their own turns. apps lists launched apps with measured and estimated minutes kept apart: an estimate is a capped 10-minute guess for a launch with no return to Rabbithole inside the measurement window (the iPad locked, or came back hours later), so report the two separately and never add them into one figure. byContext is the program tag stored at the time (core_day, extended_ed, homework, unknown). A day missing from `days` had no recorded activity. When comparing a scholar with a group average, say how many scholars the average covers, and if group.namedScholarsInAverage lists that scholar, say the average includes them (or exclude them with excludeScholarNames and read again). A group member with no rows had no recorded activity; that can mean the iPad was not reporting, not that the scholar never used it. minutesByActivityType splits a day's MEASURED BunnyPad minutes (Rabbithole plus launched apps the iPad came back from) by what was on screen, in school and outside school; it comes from the day's timeline or the nightly summary, so a day without it has not been summarized yet (today's can lag a few minutes). timeline (one named scholar, one day) is the Day view's strip: each stretch is a span of measured on-screen time with its activity type and label (the activity or session, its class and teacher, the app, the web activity, the skill practised), in school-local HH:MM. Stretches are what was ON SCREEN, inferred by overlapping device time with app plays, web activities, tutor turns and practice attempts; they are not proof of engagement. Gaps between stretches are not screen time (the iPad was idle, locked or elsewhere); never count them. ownAppLeftOpen is the scholar's own app showing with no touches: not counted anywhere.";

type Totals = {
  foregroundMinutes: number;
  inSchoolForegroundMinutes: number;
  outsideSchoolForegroundMinutes: number;
  webActivityMinutes: number;
  builderOnScreenMinutes: number;
  builderActiveMinutes: number;
  appMeasuredMinutes: number;
  appEstimatedMinutes: number;
  daysWithActivity: number;
};

function emptyTotals(): Totals {
  return {
    foregroundMinutes: 0,
    inSchoolForegroundMinutes: 0,
    outsideSchoolForegroundMinutes: 0,
    webActivityMinutes: 0,
    builderOnScreenMinutes: 0,
    builderActiveMinutes: 0,
    appMeasuredMinutes: 0,
    appEstimatedMinutes: 0,
    daysWithActivity: 0,
  };
}

/** The most stretches one day's timeline returns; the rest are summarized. */
export const MAX_TIMELINE_STRETCHES = 150;

type AideDay = ScholarDayUsage & { kinds?: DayKinds };

/** Nonzero minutes per activity type, by its human label, in kind order. */
function byActivityLabel(minutes: Record<StretchKind, number>) {
  return Object.fromEntries(
    STRETCH_KINDS.filter((kind) => (minutes[kind] ?? 0) > 0).map((kind) => [
      STRETCH_KIND_LABELS[kind],
      minutes[kind],
    ]),
  );
}

/**
 * School-local wall clock, "HH:MM". Pass `startedAt` for an interval's end, so
 * an end on the next midnight reads "24:00" rather than "00:00".
 */
function clock(at: number, timeZone: string, startedAt?: number): string {
  const minute = minuteOfDayForTimezone(at, timeZone);
  const shown =
    startedAt !== undefined &&
    // A different local day, not a smaller minute: a fall-back DST hour
    // can end a stretch at an earlier wall-clock minute on the same day.
    dayKeyForTimezone(at, timeZone) !== dayKeyForTimezone(startedAt, timeZone)
      ? 24 * 60
      : minute;
  return `${String(Math.floor(shown / 60)).padStart(2, "0")}:${String(shown % 60).padStart(2, "0")}`;
}

const minutesBetween = (start: number, end: number) =>
  Math.round(((end - start) / 60_000) * 10) / 10;

/** A day's Day-view strip as the model reads it. */
export function screenTimeTimeline(
  timeline: NonNullable<ScholarDayUsage["timeline"]>,
  timeZone: string,
) {
  const span = (interval: { start: number; end: number }) => ({
    start: clock(interval.start, timeZone),
    end: clock(interval.end, timeZone, interval.start),
    minutes: minutesBetween(interval.start, interval.end),
  });
  const shown = timeline.stretches.slice(0, MAX_TIMELINE_STRETCHES);
  return {
    totalMinutes: timeline.totalMinutes,
    schoolHours: timeline.schoolHours.map(
      (hours) => `${clock(hours.start, timeZone)}–${clock(hours.end, timeZone, hours.start)}`,
    ),
    stretches: shown.map((stretch) => ({
      ...span(stretch),
      activityType: STRETCH_KIND_LABELS[stretch.kind],
      ...(stretch.detail ? { label: stretch.detail } : {}),
    })),
    ...(timeline.stretches.length > shown.length
      ? {
          moreStretches: timeline.stretches.length - shown.length,
          moreStretchesNote: `Only the first ${MAX_TIMELINE_STRETCHES} stretches are listed; minutesByActivityType still covers the whole day.`,
        }
      : {}),
    ...(timeline.leftOpen.length > 0
      ? { ownAppLeftOpen: timeline.leftOpen.map(span) }
      : {}),
  };
}

/** One day as the model reads it: the rollup's fields, with the bell split made explicit. */
export function screenTimeDay(day: AideDay, timeZone = DEFAULT_TIMEZONE) {
  const outsideForeground = Math.min(
    day.outsideSchool.foregroundMinutes,
    day.foregroundMinutes,
  );
  return {
    date: day.dayKey,
    foregroundMinutes: day.foregroundMinutes,
    inSchoolForegroundMinutes: day.foregroundMinutes - outsideForeground,
    outsideSchoolForegroundMinutes: outsideForeground,
    webActivityMinutes: day.webActivityMinutes,
    builder: day.builder,
    apps: day.apps.map((app) => ({
      name: app.appName,
      measuredMinutes: app.measuredMinutes,
      estimatedMinutes: app.estimatedMinutes,
    })),
    byContext: day.byContext,
    ...(day.kinds
      ? {
          minutesByActivityType: {
            inSchool: byActivityLabel(day.kinds.inSchool),
            outsideSchool: byActivityLabel(day.kinds.outside),
          },
        }
      : {}),
    ...(day.timeline
      ? { timeline: screenTimeTimeline(day.timeline, timeZone) }
      : {}),
  };
}

export function screenTimeTotals(days: ScholarDayUsage[]): Totals {
  const totals = emptyTotals();
  for (const day of days) {
    const shaped = screenTimeDay(day);
    totals.foregroundMinutes += shaped.foregroundMinutes;
    totals.inSchoolForegroundMinutes += shaped.inSchoolForegroundMinutes;
    totals.outsideSchoolForegroundMinutes += shaped.outsideSchoolForegroundMinutes;
    totals.webActivityMinutes += day.webActivityMinutes;
    totals.builderOnScreenMinutes += day.builder.onScreenMinutes;
    totals.builderActiveMinutes += day.builder.activeMinutes;
    for (const app of day.apps) {
      totals.appMeasuredMinutes += app.measuredMinutes;
      totals.appEstimatedMinutes += app.estimatedMinutes;
    }
    totals.daysWithActivity += 1;
  }
  return totals;
}

/**
 * Per-scholar mean of each total, to one decimal so small splits still add up.
 * Null when no member could be read: there is no average to report.
 */
export function averageTotals(all: Totals[]): Totals | null {
  if (all.length === 0) return null;
  const sum = emptyTotals();
  for (const totals of all) {
    for (const key of Object.keys(sum) as (keyof Totals)[]) {
      sum[key] += totals[key];
    }
  }
  const round = (n: number) => Math.round(n * 10) / 10;
  for (const key of Object.keys(sum) as (keyof Totals)[]) {
    sum[key] = round(sum[key] / all.length);
  }
  // The in-school part is the rest of the rounded total, so the two parts
  // always add up to it.
  sum.inSchoolForegroundMinutes = round(
    sum.foregroundMinutes - sum.outsideSchoolForegroundMinutes,
  );
  return sum;
}

const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/;

export async function makeScreenTimeTools(
  ctx: ActionCtx,
  emit: AideEmit,
  opts: {
    role: Role | null | undefined;
    callerUserId: Id<"users">;
    allowedScholarIds?: Set<Id<"users">>;
    /** The transport's selected institution lens; "" or absent = home. */
    institutionScope?: string;
  },
) {
  // The backing query re-checks scholar-admin standing and per-scholar
  // teacher standing; operations staff could never read a named scholar, so
  // the tool is not offered to them at all.
  if (!isTeacherRole(opts.role)) return [];

  const { betaTool } = await import(
    "@anthropic-ai/sdk/helpers/beta/json-schema"
  );
  return [
    betaTool({
      name: SCREEN_TIME_TOOL_NAME,
      description:
        "Get scholars' daily BunnyPad screen time from Rabbithole's device telemetry: per day, minutes Rabbithole was on screen split in school hours vs outside school (by the bell schedule), launcher web-activity minutes, the scholar's own app (builder) minutes, per-app minutes for launched apps (measured and estimated kept apart), and the stored program-context split. Use it for any question about how much a scholar uses Rabbithole or their BunnyPad, screen time, usage in vs after school, or comparisons with a group; do NOT rebuild usage from session or web-activity timestamps. Pass scholarNames, a groupName (e.g. \"Seals\") or both; a group also returns the group's per-scholar average. excludeScholarNames drops scholars (e.g. a test account) from the group and its average. Dates are YYYY-MM-DD, school-local; with none it reads the 14 days ending today; at most 31 days. Days carry minutesByActivityType (app building, playing own app, chat session, math practice, web activity, other app, rest of Rabbithole) in and outside school when summarized. For a breakdown of a scholar's DAY (what was on screen, stretch by stretch: the activity or session, class, teacher, app or web activity, with times), name the scholar and pass startDate = endDate = that day: each named scholar's day then carries a `timeline`, the same strip as School › Screen time's Day view. Foreground minutes mean the app was on screen, NOT that the scholar was engaged; web-activity spans can stay open for hours, so they are an upper bound. Follow the `howToRead` block it returns. Staff-only.",
      inputSchema: {
        type: "object" as const,
        properties: {
          scholarNames: {
            type: "array" as const,
            items: { type: "string" as const },
            description:
              "Scholar names (case-insensitive partial match), one entry per scholar.",
          },
          groupName: {
            type: "string" as const,
            description:
              "A scholar group name, as list_scholar_groups shows it. Adds every member and a group average.",
          },
          excludeScholarNames: {
            type: "array" as const,
            items: { type: "string" as const },
            description:
              "Scholar names to leave out of the group and its average (e.g. a test account).",
          },
          includeExtendedEducation: {
            type: "boolean" as const,
            description:
              "Include a group's Extended Education (program-guest) members. Default false.",
          },
          startDate: {
            type: "string" as const,
            description: "First day, YYYY-MM-DD. Defaults to 13 days before endDate.",
          },
          endDate: {
            type: "string" as const,
            description: "Last day, YYYY-MM-DD. Defaults to today.",
          },
          includeDays: {
            type: "boolean" as const,
            description:
              "Return each scholar's per-day rows as well as totals. Default true for named scholars, false for group members.",
          },
        },
        required: [] as const,
      },
      run: async (input) => {
        const startDate = input.startDate?.trim() || undefined;
        const endDate = input.endDate?.trim() || undefined;
        for (const date of [startDate, endDate]) {
          if (date && !DAY_KEY.test(date)) {
            return `Dates must be YYYY-MM-DD; got "${date}".`;
          }
        }
        const named = (input.scholarNames ?? []).filter((n) => n.trim());
        const groupName = input.groupName?.trim();
        if (named.length === 0 && !groupName) {
          return "Name at least one scholar (scholarNames) or a group (groupName).";
        }

        const notFound: string[] = [];
        const targets: { id: Id<"users">; name: string; named: boolean }[] = [];
        const seen = new Set<string>();
        for (const name of named) {
          const scholar = await resolveScholarByName(
            ctx,
            name,
            opts.allowedScholarIds,
          );
          if (!scholar) {
            notFound.push(name);
            continue;
          }
          if (seen.has(scholar.id)) continue;
          seen.add(scholar.id);
          targets.push({
            id: scholar.id as Id<"users">,
            name: scholar.name,
            named: true,
          });
        }

        let group:
          | { name: string; memberIds: Id<"users">[]; excluded: string[] }
          | null = null;
        if (groupName) {
          const groups = await ctx.runQuery(
            internal.curriculumAssistant.listScholarGroupsInternal,
            {
              includeProgramGuests: input.includeExtendedEducation === true,
              ...(opts.allowedScholarIds
                ? { allowedScholarIds: [...opts.allowedScholarIds] }
                : {}),
            },
          );
          const lower = groupName.toLowerCase();
          const match =
            groups.find((g) => g.name.toLowerCase() === lower) ??
            groups.find((g) => g.name.toLowerCase().includes(lower));
          if (!match) {
            return `No scholar group matches "${groupName}". Groups: ${groups.map((g) => g.name).join(", ") || "none"}.`;
          }
          const excludes = (input.excludeScholarNames ?? [])
            .map((n) => n.trim().toLowerCase())
            .filter(Boolean);
          const excluded: string[] = [];
          const memberIds: Id<"users">[] = [];
          for (const member of match.members) {
            const lowerName = member.name.toLowerCase();
            if (excludes.some((x) => lowerName.includes(x))) {
              excluded.push(member.name);
              continue;
            }
            memberIds.push(member.id);
            if (!seen.has(member.id)) {
              seen.add(member.id);
              targets.push({ id: member.id, name: member.name, named: false });
            }
          }
          group = { name: match.name, memberIds, excluded };
        }

        if (targets.length > MAX_SCREEN_TIME_SCHOLARS) {
          return `That is ${targets.length} scholars; this tool reads at most ${MAX_SCREEN_TIME_SCHOLARS} at a time. Ask about a smaller group.`;
        }

        // One query per scholar, so each stays inside its own read limits.
        // Every scholar is read over the SAME dates: when the asker named
        // none, the first read settles the default window (its school's
        // today) and the rest use it, so a comparison never mixes periods.
        const failures: { scholar: string; error: string }[] = [];
        const oneDay = !!startDate && startDate === endDate;
        const readOne = async (
          target: (typeof targets)[number],
          window: { startDayKey?: string; endDayKey?: string },
        ) => {
          try {
            const result = await ctx.runQuery(
              internal.deviceActivity.dailyUsageForAide,
              {
                callerUserId: opts.callerUserId,
                scholarId: target.id,
                ...(opts.institutionScope
                  ? { institutionScope: opts.institutionScope }
                  : {}),
                ...(window.startDayKey ? { startDayKey: window.startDayKey } : {}),
                ...(window.endDayKey ? { endDayKey: window.endDayKey } : {}),
                // A one-day read of a named scholar is a "breakdown of their
                // day": also read the Day view's stretches. Group members
                // stay totals-only, so a group read stays cheap.
                ...(oneDay && target.named ? { timeline: true } : {}),
              },
            );
            return { target, result };
          } catch (error) {
            failures.push({
              scholar: target.name,
              error: error instanceof Error ? error.message : String(error),
            });
            return { target, result: null };
          }
        };
        const reads: Awaited<ReturnType<typeof readOne>>[] = [];
        let window: { startDayKey?: string; endDayKey?: string } = {
          startDayKey: startDate,
          endDayKey: endDate,
        };
        let rest = targets;
        while (rest.length > 0 && (!window.startDayKey || !window.endDayKey)) {
          const first = await readOne(rest[0], window);
          reads.push(first);
          rest = rest.slice(1);
          if (first.result) {
            window = {
              startDayKey: first.result.startDayKey,
              endDayKey: first.result.endDayKey,
            };
          }
        }
        reads.push(
          ...(await Promise.all(rest.map((target) => readOne(target, window)))),
        );
        if (failures.length > 0 && failures.length === reads.length) {
          return `Could not read screen time: ${failures[0].error}`;
        }
        const range =
          window.startDayKey && window.endDayKey
            ? { startDate: window.startDayKey, endDate: window.endDayKey }
            : null;

        const totalsById = new Map<string, Totals>();
        const notReadable: string[] = [];
        const scholars = reads.flatMap(({ target, result }) => {
          if (!result) return [];
          if (!result.readable) {
            notReadable.push(target.name);
            return [];
          }
          const totals = screenTimeTotals(result.days);
          totalsById.set(target.id, totals);
          if (!target.named && input.includeDays !== true) return [];
          return [
            {
              scholar: target.name,
              totals,
              ...(input.includeDays === false
                ? {}
                : {
                    days: result.days.map((day) =>
                      screenTimeDay(day, result.timeZone),
                    ),
                  }),
            },
          ];
        });

        const resolvedGroup = group;
        const groupSummary = resolvedGroup
          ? (() => {
              const memberTotals = resolvedGroup.memberIds.flatMap((id) => {
                const totals = totalsById.get(id);
                return totals ? [totals] : [];
              });
              return {
                name: resolvedGroup.name,
                scholarsInAverage: memberTotals.length,
                // A named scholar who is also a member is in the average
                // they are compared against; say so instead of hiding it.
                namedScholarsInAverage: targets
                  .filter(
                    (t) =>
                      t.named &&
                      resolvedGroup.memberIds.includes(t.id) &&
                      totalsById.has(t.id),
                  )
                  .map((t) => t.name),
                excluded: resolvedGroup.excluded,
                averagePerScholar: averageTotals(memberTotals),
                ...(memberTotals.length === 0
                  ? {
                      averageNote:
                        "No member of this group could be read, so there is no average.",
                    }
                  : {}),
                members: resolvedGroup.memberIds.flatMap((id) => {
                  const target = targets.find((t) => t.id === id);
                  const totals = totalsById.get(id);
                  return target && totals ? [{ scholar: target.name, totals }] : [];
                }),
              };
            })()
          : null;

        emit({
          toolComplete: {
            name: SCREEN_TIME_TOOL_NAME,
            result: `Loaded screen time for ${totalsById.size} scholar${totalsById.size === 1 ? "" : "s"}`,
          },
        });
        return JSON.stringify({
          howToRead: SCREEN_TIME_GUIDE,
          range,
          scholars,
          ...(groupSummary ? { group: groupSummary } : {}),
          ...(notFound.length ? { notFound } : {}),
          ...(failures.length ? { failedReads: failures } : {}),
          ...(notReadable.length
            ? {
                notReadable,
                notReadableNote:
                  "Their screen time is not readable to you: you don't teach them, they're outside the school you're viewing, or their school is suspended. Say they're not readable; never report them as zero.",
              }
            : {}),
        });
      },
    }),
  ];
}
