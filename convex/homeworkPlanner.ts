// Homework by the week, the teacher's side (TRA-581).
//
// The Schedule tab's "Homework" view: for each group that has classes this
// term, one row per school week with that week's homework by subject. It is a
// VIEW over gives (`pushes` with homework timing), never a second store: a
// give due in a week is that week's homework, wherever it was given from (the
// give form, the Run page, the aide, the Slack bot). Teachers coordinate the
// subject rotation themselves; an open week reads "No homework yet".
//
// Also the week context the aide's "next week's homework" needs
// (`aideNextWeekHomework`) and "due this week" (`aideThisWeekDueDay`).
//
// Week arithmetic lives in shared/homeworkWeek.ts, which the scholar and
// family week views already use, so "this week" means the same day on every
// surface. Subjects come from lib/homeworkSubject.ts, which the family
// Homework tab uses too.

import { v, type Infer } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { internalQuery, type QueryCtx } from "./_generated/server";
import { teacherQuery } from "./lib/customFunctions";
import { filterToAccessibleScholars, resolveActiveMembership } from "./lib/access";
import { timeZoneForInstitution } from "./lib/institutionTime";
import { loadInstitutionClosures } from "./masterSchedule";
import { groupsContainingRoster, loadClassLinkData, termCovering } from "./lib/classLink";
import { unitSubjectFitsClass } from "./lib/classResolver";
import { homeworkSubjectLabel } from "./lib/homeworkSubject";
import {
  dayKeyForTimezone,
  dayStartForDayKey,
  shiftDayKey,
} from "../shared/institutionDay";
import {
  homeworkWeekWindow,
  nextSchoolWeekMonday,
  schoolWeekMondayForDayKey,
  weekEndDueDayFor,
  weekMondayKey,
  type WeekClosure,
} from "../shared/homeworkWeek";

const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/;
const DEFAULT_WEEKS = 6;
const MAX_WEEKS = 12;

/** The caller's school, its time zone and its closures (as week closures). */
async function callerSchool(
  ctx: QueryCtx,
  user: Doc<"users">,
): Promise<{
  institutionId: Id<"institutions"> | undefined;
  timeZone: string;
  closures: WeekClosure[];
}> {
  const institutionId = (await resolveActiveMembership(ctx, user))?.institutionId;
  const timeZone = await timeZoneForInstitution(ctx, institutionId);
  const closures = (await loadInstitutionClosures(ctx, institutionId))
    .filter((c) => c.startDayKey <= c.endDayKey)
    .map(({ startDayKey, endDayKey, label }) => ({ startDayKey, endDayKey, label }));
  return { institutionId, timeZone, closures };
}

const plannerItem = v.object({
  /** The give (push) id. */
  key: v.string(),
  title: v.string(),
  /** lib/homeworkSubject.ts: class, unit subject, unit title. */
  subject: v.union(v.string(), v.null()),
  /** Who gave it: any teacher of the group can plan (TRA-581). */
  teacherName: v.union(v.string(), v.null()),
  dueDayKey: v.string(),
  /** False while it's planned (shows up later). */
  live: v.boolean(),
  /** Set when it reaches only part of the group: how many scholars. */
  partOfGroup: v.union(v.number(), v.null()),
});

/**
 * The planner: the caller's school's groups with classes this term, and each
 * one's homework for `weeks` school weeks from `fromMondayKey` (default this
 * school week). A group whose whole roster is outside the caller's context is
 * left out; any teacher of a group sees all of its homework, whoever gave it.
 *
 * A give is listed under its class's group; without a class, under its group
 * audience, or under every group its roster reaches (a give for Honu and Pueo
 * is in both rows, with how many scholars of each it reaches).
 */
export const weeks = teacherQuery({
  args: {
    // School-local "YYYY-MM-DD" (T11): places "this week" and changes once a
    // day, so the query doesn't re-run every minute.
    todayKey: v.string(),
    fromMondayKey: v.optional(v.string()),
    weeks: v.optional(v.number()),
  },
  returns: v.object({
    timeZone: v.string(),
    mondayKeys: v.array(v.string()),
    closures: v.array(
      v.object({ startDayKey: v.string(), endDayKey: v.string(), label: v.string() }),
    ),
    groups: v.array(
      v.object({
        groupId: v.id("scholarGroups"),
        name: v.string(),
        weeks: v.array(
          v.object({ mondayKey: v.string(), items: v.array(plannerItem) }),
        ),
      }),
    ),
  }),
  handler: async (ctx, args) => {
    if (!DAY_KEY.test(args.todayKey)) throw new Error("todayKey must be YYYY-MM-DD");
    const { institutionId, timeZone, closures } = await callerSchool(ctx, ctx.user);
    const count = Math.min(Math.max(Math.round(args.weeks ?? DEFAULT_WEEKS), 1), MAX_WEEKS);
    const firstMonday =
      args.fromMondayKey && DAY_KEY.test(args.fromMondayKey)
        ? weekMondayKey(args.fromMondayKey)
        : schoolWeekMondayForDayKey(args.todayKey);
    const mondayKeys = Array.from({ length: count }, (_, i) =>
      shiftDayKey(firstMonday, 7 * i),
    );
    const lastDay = shiftDayKey(mondayKeys[mondayKeys.length - 1], 6);
    const inWindow = closures.filter(
      (c) => c.endDayKey >= firstMonday && c.startDayKey <= lastDay,
    );
    const empty = { timeZone, mondayKeys, closures: inWindow, groups: [] };
    if (!institutionId) return empty;

    // The rows: groups with a live class in the term covering today, the
    // same term choice the class linker makes.
    const term = termCovering(
      (await loadClassLinkData(ctx, institutionId)).periods,
      institutionId,
      dayStartForDayKey(args.todayKey, timeZone),
    );
    if (!term) return empty;
    const classes = (
      await ctx.db
        .query("classes")
        .withIndex("by_institution", (q) => q.eq("institutionId", institutionId))
        .collect()
    ).filter((c) => c.archivedAt === undefined && c.periodId === term._id);
    const groups: Doc<"scholarGroups">[] = [];
    for (const groupId of new Set(classes.map((c) => c.groupId))) {
      const group = await ctx.db.get(groupId);
      if (!group || group.institutionId !== institutionId) continue;
      if (group.scholarIds.length === 0) continue;
      const reachable = await filterToAccessibleScholars(ctx, ctx.user, group.scholarIds);
      if (reachable.length === 0) continue;
      groups.push(group);
    }
    groups.sort((a, b) => a.name.localeCompare(b.name));
    const groupById = new Map(groups.map((g) => [g._id, g]));

    // The homework: open homework gives due in the window.
    const pushes = await ctx.db
      .query("pushes")
      .withIndex("by_institution_cleared", (q) =>
        q.eq("institutionId", institutionId).eq("clearedAt", undefined),
      )
      .collect();
    const names = new Map<Id<"users">, string | null>();
    const byGroupWeek = new Map<string, Array<Infer<typeof plannerItem>>>();
    for (const push of pushes) {
      if (push.timing.kind !== "homework" || push.endsAt == null) continue;
      const dueDayKey = dayKeyForTimezone(push.endsAt, timeZone);
      if (dueDayKey < firstMonday || dueDayKey > lastDay) continue;
      const roster = await audienceRoster(ctx, push);
      const cls = push.classId ? await ctx.db.get(push.classId) : null;
      // Its class's group; else its audience group when that is a row; else
      // every row its roster reaches (a school-wide give reaches them all).
      const audienceGroup =
        push.audience.kind === "group" && groupById.has(push.audience.groupId)
          ? push.audience.groupId
          : null;
      const targetGroups = cls
        ? [cls.groupId]
        : audienceGroup
          ? [audienceGroup]
          : push.audience.kind === "institution"
            ? groups.map((g) => g._id)
            : groups
                .filter((g) => roster.some((id) => g.scholarIds.includes(id)))
                .map((g) => g._id);
      const rows = targetGroups.filter((id) => groupById.has(id));
      if (rows.length === 0) continue;
      const title = await workTitle(ctx, push);
      if (title == null) continue;
      const activityId = push.target.kind === "activity" ? push.target.activityId : null;
      const assignment = push.assignmentId ? await ctx.db.get(push.assignmentId) : null;
      const subject = await homeworkSubjectLabel(ctx, {
        classId: push.classId,
        activityId,
        unitId: assignment?.unitId,
      });
      if (!names.has(push.pushedBy)) {
        names.set(push.pushedBy, (await ctx.db.get(push.pushedBy))?.name?.trim() || null);
      }
      for (const groupId of rows) {
        const group = groupById.get(groupId)!;
        const reached = roster.filter((id) => group.scholarIds.includes(id)).length;
        const key = `${groupId}|${weekMondayKey(dueDayKey)}`;
        const bucket = byGroupWeek.get(key) ?? [];
        bucket.push({
          key: push._id,
          title,
          subject,
          teacherName: names.get(push.pushedBy) ?? null,
          dueDayKey,
          live: push.setAt != null,
          partOfGroup:
            groupId === audienceGroup || push.audience.kind === "institution"
              ? null
              : reached < group.scholarIds.length
                ? reached
                : null,
        });
        byGroupWeek.set(key, bucket);
      }
    }

    return {
      timeZone,
      mondayKeys,
      closures: inWindow,
      groups: groups.map((group) => ({
        groupId: group._id,
        name: group.name,
        weeks: mondayKeys.map((mondayKey) => ({
          mondayKey,
          items: (byGroupWeek.get(`${group._id}|${mondayKey}`) ?? []).sort(
            (a, b) =>
              (a.subject ?? "~").localeCompare(b.subject ?? "~") ||
              a.dueDayKey.localeCompare(b.dueDayKey) ||
              a.title.localeCompare(b.title),
          ),
        })),
      })),
    };
  },
});

/** Who a give reaches right now (its audience resolved live, like readers do). */
async function audienceRoster(
  ctx: QueryCtx,
  push: Doc<"pushes">,
): Promise<Id<"users">[]> {
  switch (push.audience.kind) {
    case "scholars":
      return push.audience.scholarIds;
    case "group":
      return (await ctx.db.get(push.audience.groupId))?.scholarIds ?? [];
    case "assignment":
      return (await ctx.db.get(push.audience.assignmentId))?.scholarIds ?? [];
    case "institution":
      return [];
  }
}

/** The give's title, or null when its target is gone. */
async function workTitle(ctx: QueryCtx, push: Doc<"pushes">): Promise<string | null> {
  const target = push.target;
  switch (target.kind) {
    case "activity":
      return (await ctx.db.get(target.activityId))?.title ?? null;
    case "link":
      return target.title;
    case "app":
      return (await ctx.db.get(target.externalAppId))?.name ?? null;
    case "resource":
      return (await ctx.db.get(target.resourceId))?.title ?? null;
  }
}

/** What the class pick found: one class, several to ask about, or none. */
type ClassPick =
  | { kind: "class"; classId: Id<"classes">; subject: string }
  | { kind: "ask"; choices: string[] }
  | { kind: "none" };

/**
 * The class this homework is for (Andy, TRA-581), among the classes this
 * term of the groups that hold the whole roster:
 *   - the ones whose subject is the unit's;
 *   - only when the unit has no subject, or no class matches it, the
 *     caller's own classes there.
 * One is the class; several are a question for the teacher, never a give
 * left unlinked; none is no class. A class the teacher named (`className`)
 * is looked up among all of those classes instead. The give stamps the class
 * through the write path's checks (lib/classLink.ts `homeworkClassFields`).
 */
async function pickHomeworkClass(
  ctx: QueryCtx,
  args: {
    institutionId: Id<"institutions">;
    callerId: Id<"users">;
    /** When the homework shows up: picks the term, as the linker does. */
    at: number;
    roster: readonly Id<"users">[];
    unitId: Id<"units"> | undefined;
    className: string | undefined;
  },
): Promise<ClassPick> {
  const data = await loadClassLinkData(ctx, args.institutionId);
  const groups = groupsContainingRoster(data.groups, args.roster);
  if (groups.length === 0) return { kind: "none" };
  const term = termCovering(data.periods, args.institutionId, args.at);
  if (!term) return { kind: "none" };
  const classes: Doc<"classes">[] = [];
  for (const group of groups) {
    classes.push(
      ...(
        await ctx.db
          .query("classes")
          .withIndex("by_period_group", (q) =>
            q.eq("periodId", term._id).eq("groupId", group._id),
          )
          .collect()
      ).filter(
        (c) => c.archivedAt === undefined && c.institutionId === args.institutionId,
      ),
    );
  }
  // "Science", or "Science (Honu)" when two groups' classes share a subject.
  const label = (cls: Doc<"classes">) => {
    const twin = classes.some((c) => c !== cls && c.subjectKey === cls.subjectKey);
    const group = groups.find((g) => g._id === cls.groupId);
    return twin && group ? `${cls.subject.trim()} (${group.name})` : cls.subject.trim();
  };
  let candidates: Doc<"classes">[];
  const named = args.className?.trim().toLowerCase();
  if (named) {
    candidates = classes.filter(
      (c) => label(c).toLowerCase() === named || c.subjectKey === named,
    );
    if (candidates.length !== 1) {
      return { kind: "ask", choices: classes.map(label).sort() };
    }
  } else {
    const unit = args.unitId ? await ctx.db.get(args.unitId) : null;
    const unitSubject = unit?.subject?.trim();
    const bySubject = unitSubject
      ? classes.filter((c) => unitSubjectFitsClass(unitSubject, c.subject))
      : [];
    candidates = bySubject.length
      ? bySubject
      : classes.filter((c) => c.teacherId === args.callerId);
  }
  if (candidates.length === 0) return { kind: "none" };
  if (candidates.length > 1) {
    return { kind: "ask", choices: candidates.map(label).sort() };
  }
  return { kind: "class", classId: candidates[0]._id, subject: label(candidates[0]) };
}

/**
 * "Next week's homework" for the aide and the Slack bot (TRA-581): it shows
 * up at the start of next school week's first school day, so families see the
 * whole week's homework from then, and is due at the end of its last school
 * day (a holiday Friday makes it Thursday). Its class is picked directly
 * (`pickHomeworkClass`); `whichClass` is the question when more than one
 * could be it. `closed` names a week with no school.
 */
export const aideNextWeekHomework = internalQuery({
  args: {
    callerUserId: v.id("users"),
    now: v.number(),
    /** What it's for, when known, to find its class: an existing assignment
     *  (its unit and roster), or a unit and roster. */
    assignmentId: v.optional(v.id("assignments")),
    unitId: v.optional(v.id("units")),
    scholarIds: v.optional(v.array(v.id("users"))),
    /** The teacher's answer to "which class is this for?". */
    className: v.optional(v.string()),
  },
  returns: v.union(
    v.object({
      kind: v.literal("window"),
      mondayKey: v.string(),
      showsUpDayKey: v.string(),
      showsUpAt: v.number(),
      dueDayKey: v.string(),
      /** The class it's for, or null for none. */
      classId: v.union(v.id("classes"), v.null()),
      classSubject: v.union(v.string(), v.null()),
    }),
    v.object({ kind: v.literal("closed"), mondayKey: v.string() }),
    v.object({ kind: v.literal("whichClass"), choices: v.array(v.string()) }),
    v.null(),
  ),
  handler: async (ctx, args) => {
    const caller = await ctx.db.get(args.callerUserId);
    if (!caller) return null;
    const { institutionId, timeZone, closures } = await callerSchool(ctx, caller);
    const mondayKey = nextSchoolWeekMonday(args.now, timeZone);
    const window = homeworkWeekWindow(mondayKey, closures);
    if (!window) return { kind: "closed" as const, mondayKey };
    const showsUpAt = dayStartForDayKey(window.showsUpDayKey, timeZone);
    const assignment = args.assignmentId ? await ctx.db.get(args.assignmentId) : null;
    const pick: ClassPick = institutionId
      ? await pickHomeworkClass(ctx, {
          institutionId,
          callerId: caller._id,
          at: showsUpAt,
          roster: args.scholarIds ?? assignment?.scholarIds ?? [],
          unitId: args.unitId ?? assignment?.unitId,
          className: args.className,
        })
      : { kind: "none" };
    if (pick.kind === "ask") {
      return { kind: "whichClass" as const, choices: pick.choices };
    }
    return {
      kind: "window" as const,
      mondayKey,
      showsUpDayKey: window.showsUpDayKey,
      showsUpAt,
      dueDayKey: window.dueDayKey,
      classId: pick.kind === "class" ? pick.classId : null,
      classSubject: pick.kind === "class" ? pick.subject : null,
    };
  },
});

/**
 * "Due this week" for the aide (TRA-581): the last school day of the week the
 * work shows up in (`startsAt`, else now), with the school's closures, so a
 * holiday Friday makes it Thursday. The same day the give form offers as
 * "This week". Null when there's no school day to be due on.
 */
export const aideThisWeekDueDay = internalQuery({
  args: {
    callerUserId: v.id("users"),
    now: v.number(),
    startsAt: v.optional(v.number()),
  },
  returns: v.union(v.string(), v.null()),
  handler: async (ctx, args) => {
    const caller = await ctx.db.get(args.callerUserId);
    if (!caller) return null;
    const { timeZone, closures } = await callerSchool(ctx, caller);
    return weekEndDueDayFor(
      dayKeyForTimezone(args.startsAt ?? args.now, timeZone),
      closures,
    );
  },
});
