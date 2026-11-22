// The teacher Master Schedule's actions are give actions (TRA-582).
//
//   giveToClass → give an activity or a math skill to a class on a day: its
//                 meeting that day supplies the start, and the work finishes
//                 in that class. "Up next", adding from a class cell, and the
//                 aide's place_class with work all land here.
//   giveHomework → homework for a class, due on a day: the Homework due row.
//   moveGive    → drag a planned give to another meeting of the same group's
//                 classes, to the All day row, or to the Homework due row.
//
// Both write through the same give path as the Run page and the aide
// (assignments.coreAssignWork / coreScheduleActivity), so the class link is
// stamped the usual way (lib/classLink.ts, from the start time): moving a give
// to Thursday's Science re-times it to that meeting, and that relinks it.

import { ConvexError, v, type Infer } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { internalMutation, type MutationCtx } from "./_generated/server";
import { teacherMutation } from "./lib/customFunctions";
import { requireScheduleScopeAccessible, requireScholarsAccessible } from "./lib/access";
import { coreAssignWork, coreScheduleActivity } from "./assignments";
import { meetingsOnDay, type ClassMeeting } from "../shared/classMeetings";
import {
  dayEndForDayKey,
  dayKeyForTimezone,
  dayStartForDayKey,
  weekdayForDayKey,
} from "../shared/institutionDay";
import { isTeacherRole } from "./lib/roles";
import { isClosedDay } from "../shared/schoolClosures";
import { loadClassLinkData, groupsContainingRoster } from "./lib/classLink";
import { GiveQuestionError, type GiveFinish } from "./lib/giveWindow";
import { ensureSkillPractice } from "./lib/skillPractice";
import { homeworkWeekWindow, schoolWeekMondayForDayKey } from "../shared/homeworkWeek";
import { openUntilClosesAt, openUntilDateLabel, openUntilDayKey } from "../shared/openUntil";
import { meetingHolding } from "./lib/gridGives";
import { isOpenUntilKind } from "./lib/pushes";

const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/;

export const CLASS_ALREADY_MET =
  "That class has already met. Pick a later class.";
export const ONLY_PLANNED_MOVES =
  "Only planned work moves on the grid. Live and finished work stays where it happened.";
export const NOT_THIS_GROUP =
  "That class belongs to a different group. Work moves only between this group's classes.";
export const NO_SCHOOL_THAT_DAY = "There's no school that day.";
export const NO_MEETING_THAT_DAY = "That class doesn't meet that day.";
export const OUTSIDE_TERM = "That day is outside this class's term.";
export const OPEN_UNTIL_OTHER_CLASS =
  "Open-until work shows in its own class, so it can't go in that one. Move it to one of its own class's meetings or the All day row.";

/** A move that would start an open-until give on or after its closing day. */
export function openUntilMoveRefusal(closesAt: number, timeZone: string): string {
  const label = openUntilDateLabel(closesAt, timeZone).replace(/^Open/, "open");
  return `This is ${label}, so it can't start after that. Move it to that day or earlier, or change the closing day from the Run page.`;
}

export const LINK_MISMATCH =
  "These scholars have another class at that time too, so Rabbithole can't tell which class this belongs to. Nothing changed. Give it from the unit's Run page instead.";

/** Turn a give's own question into a toast sentence, never "Server Error". */
async function asQuestion<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof GiveQuestionError) throw new ConvexError(error.message);
    throw error;
  }
}

/** The class, its meeting on `dayKey`, and the school's time zone. Refuses a
 *  class the caller can't reach, a closed day, and a day it doesn't meet. */
async function classMeetingOn(
  ctx: MutationCtx,
  user: Doc<"users">,
  classId: Id<"classes">,
  dayKey: string,
): Promise<{ cls: Doc<"classes">; meeting: ClassMeeting; timeZone: string }> {
  if (!DAY_KEY.test(dayKey)) throw new ConvexError(`"${dayKey}" isn't a date.`);
  const cls = await ctx.db.get(classId);
  if (!cls || cls.archivedAt !== undefined) {
    throw new ConvexError("That class no longer exists.");
  }
  await requireScheduleScopeAccessible(ctx, user, {
    periodId: cls.periodId,
    groupId: cls.groupId,
  });
  const data = await loadClassLinkData(ctx, cls.institutionId);
  if (isClosedDay(dayKey, data.closures)) throw new ConvexError(NO_SCHOOL_THAT_DAY);
  // A week that straddles the term's end still draws the class's meetings;
  // a give there would link to no class (lib/classLink.ts reads the term
  // that covers the give's time).
  const period = await ctx.db.get(cls.periodId);
  const dayStart = dayStartForDayKey(dayKey, data.timeZone);
  if (!period || dayStart < dayStartForDayKey(dayKeyForTimezone(period.startsAt, data.timeZone), data.timeZone) ||
      dayStart >= period.endsAt) {
    throw new ConvexError(OUTSIDE_TERM);
  }
  const blocks = await ctx.db.query("scheduleBlocks")
    .withIndex("by_period", (q) => q.eq("periodId", cls.periodId))
    .collect();
  const blocksById = new Map(
    blocks
      .filter((b) => (b.kind ?? "class") === "class")
      .map((b) => [String(b._id), b]),
  );
  const [meeting] = meetingsOnDay(cls, blocksById, dayKey, data.timeZone);
  if (!meeting) throw new ConvexError(NO_MEETING_THAT_DAY);
  return { cls, meeting, timeZone: data.timeZone };
}

/**
 * After a give to a class, the stored give must be linked to that class (and,
 * for work done in class, that day; homework links a class, never a day).
 * The link is derived from the give's time and audience (lib/classLink.ts),
 * which refuses to guess when two classes of these scholars meet then; a give
 * that landed elsewhere throws, so the write rolls back instead of reporting
 * a give that didn't happen.
 */
async function assertLinkedTo(
  ctx: MutationCtx,
  assignmentId: Id<"assignments">,
  activityId: Id<"activities">,
  classId: Id<"classes">,
  dayKey: string | undefined,
  /** The meeting given into. Work of another subject is filed under its own
   *  subject's class but drawn in this meeting (TRA-725): that counts. */
  meeting?: ClassMeeting,
): Promise<void> {
  const open = await ctx.db.query("pushes")
    .withIndex("by_assignment_cleared", (q) =>
      q.eq("assignmentId", assignmentId).eq("clearedAt", undefined))
    .collect();
  const linked = open.some((push) =>
    push.scheduleMirror === true &&
    push.target.kind === "activity" &&
    push.target.activityId === activityId &&
    push.dayKey === dayKey &&
    (push.classId === classId ||
      (meeting !== undefined && push.classId !== undefined &&
        meetingHolding(push, [meeting]) !== null)));
  if (!linked) throw new ConvexError(LINK_MISMATCH);
}

/** When work given to a meeting shows up: its start, or now if the class is
 *  already under way. Refuses a meeting that has ended. */
function showsUpFor(meeting: ClassMeeting, now: number): number {
  if (now >= meeting.endsAt) throw new ConvexError(CLASS_ALREADY_MET);
  return Math.max(meeting.startsAt, now);
}

/** What the grid and the aide give: a unit's activity, or one math skill. */
const workValidator = v.union(
  v.object({ kind: v.literal("activity"), activityId: v.id("activities") }),
  v.object({ kind: v.literal("skill"), nodeKey: v.string() }),
);
type GridWork = Infer<typeof workValidator>;

/**
 * Give `work` to `roster` from `startsAt` with `finish`, as `actor`, through
 * the Run page's own writers. A unit activity goes through coreAssignWork
 * (find-or-create the cohort × unit assignment). A math skill goes through
 * coreScheduleActivity on its practice pair (lib/skillPractice.ts), the
 * lesson-less one-skill problem set that serves the skill's targeted practice.
 */
async function giveWork(
  ctx: MutationCtx,
  actor: Doc<"users">,
  args: {
    work: GridWork;
    roster: Id<"users">[];
    startsAt: number;
    finish: GiveFinish;
  },
): Promise<{ assignmentId: Id<"assignments">; activityId: Id<"activities"> }> {
  if (args.work.kind === "activity") {
    const activityId = args.work.activityId;
    const activity = await ctx.db.get(activityId);
    const lesson = activity?.lessonId ? await ctx.db.get(activity.lessonId) : null;
    if (!activity || !lesson) {
      throw new ConvexError("Only an activity from a unit can be given from the grid.");
    }
    const result = await asQuestion(() =>
      coreAssignWork(ctx, {
        teacherId: actor._id,
        unitId: lesson.unitId,
        scholarIds: args.roster,
        startsAt: args.startsAt,
        target: { kind: "activity", activityId },
        finish: args.finish,
      }),
    );
    return { assignmentId: result.assignmentId, activityId };
  }
  await requireScholarsAccessible(ctx, actor, args.roster);
  const pair = await ensureSkillPractice(ctx, {
    teacherId: actor._id,
    roster: args.roster,
    nodeKey: args.work.nodeKey,
  });
  const work = { ...pair, startsAt: args.startsAt, finish: args.finish };
  await asQuestion(() => coreScheduleActivity({ ...ctx, user: actor }, work));
  return pair;
}

/**
 * Give work to a class on a day: its meeting that day supplies the start.
 * "inClass" finishes when the class ends; "endOfDay" is due at the end of
 * that day, so it is homework for that class. Shared by the grid
 * (giveToClass) and the aide's place_class (aideGiveToClass).
 */
export async function coreGiveToClass(
  ctx: MutationCtx,
  actor: Doc<"users">,
  args: {
    classId: Id<"classes">;
    dayKey: string;
    work: GridWork;
    finish?: "inClass" | "endOfDay";
  },
): Promise<{ assignmentId: Id<"assignments">; activityId: Id<"activities"> }> {
  const { cls, meeting } = await classMeetingOn(ctx, actor, args.classId, args.dayKey);
  const group = await ctx.db.get(cls.groupId);
  if (!group || group.scholarIds.length === 0) {
    throw new ConvexError("That class's group has no scholars yet.");
  }
  const homework = args.finish === "endOfDay";
  const given = await giveWork(ctx, actor, {
    work: args.work,
    roster: group.scholarIds,
    startsAt: showsUpFor(meeting, Date.now()),
    finish: homework
      ? { kind: "by", dayKey: args.dayKey, classId: cls._id }
      : { kind: "inClass" },
  });
  await assertLinkedTo(
    ctx,
    given.assignmentId,
    given.activityId,
    cls._id,
    homework ? undefined : args.dayKey,
    homework ? undefined : meeting,
  );
  return given;
}

export const giveToClass = teacherMutation({
  args: {
    classId: v.id("classes"),
    dayKey: v.string(),
    work: workValidator,
  },
  handler: async (ctx, { classId, dayKey, work }) => {
    const { assignmentId } = await coreGiveToClass(ctx, ctx.user, {
      classId,
      dayKey,
      work,
    });
    return assignmentId;
  },
});

/**
 * Give homework for a class, due at the end of `dueDayKey` (the grid's
 * Homework due row). It shows up now when that day is in this school week,
 * else at the start of its week's first school day, as next week's homework
 * does (TRA-581). Homework links its class but no meeting.
 */
export const giveHomework = teacherMutation({
  args: {
    classId: v.id("classes"),
    dueDayKey: v.string(),
    work: workValidator,
  },
  handler: async (ctx, args) => {
    if (!DAY_KEY.test(args.dueDayKey)) {
      throw new ConvexError(`"${args.dueDayKey}" isn't a date.`);
    }
    const cls = await ctx.db.get(args.classId);
    if (!cls || cls.archivedAt !== undefined) {
      throw new ConvexError("That class no longer exists.");
    }
    await requireScheduleScopeAccessible(ctx, ctx.user, {
      periodId: cls.periodId,
      groupId: cls.groupId,
    });
    const group = await ctx.db.get(cls.groupId);
    if (!group || group.scholarIds.length === 0) {
      throw new ConvexError("That class's group has no scholars yet.");
    }
    const { timeZone, closures } = await loadClassLinkData(ctx, cls.institutionId);
    if (isClosedDay(args.dueDayKey, closures)) throw new ConvexError(NO_SCHOOL_THAT_DAY);
    const now = Date.now();
    if (dayEndForDayKey(args.dueDayKey, timeZone) < now) {
      throw new ConvexError("That day has passed. Pick today or a later day.");
    }
    const week = homeworkWeekWindow(schoolWeekMondayForDayKey(args.dueDayKey), closures);
    const showsUp = week ? dayStartForDayKey(week.showsUpDayKey, timeZone) : now;
    const given = await giveWork(ctx, ctx.user, {
      work: args.work,
      roster: group.scholarIds,
      startsAt: Math.max(now, Math.min(showsUp, dayStartForDayKey(args.dueDayKey, timeZone))),
      finish: { kind: "by", dayKey: args.dueDayKey, classId: cls._id },
    });
    await assertLinkedTo(ctx, given.assignmentId, given.activityId, cls._id, undefined);
    return given.assignmentId;
  },
});

const moveTargetValidator = v.union(
  v.object({ kind: v.literal("class"), classId: v.id("classes"), dayKey: v.string() }),
  v.object({ kind: v.literal("allDay"), dayKey: v.string() }),
  v.object({ kind: v.literal("homework"), dayKey: v.string() }),
);

export const moveGive = teacherMutation({
  args: { pushId: v.id("pushes"), to: moveTargetValidator },
  handler: async (ctx, { pushId, to }) => {
    const push = await ctx.db.get(pushId);
    if (
      !push ||
      push.setAt !== undefined ||
      push.clearedAt !== undefined ||
      push.scheduleMirror !== true ||
      !push.assignmentId ||
      push.target.kind !== "activity"
    ) {
      throw new ConvexError(ONLY_PLANNED_MOVES);
    }
    const assignment = await ctx.db.get(push.assignmentId);
    if (!assignment) throw new ConvexError(ONLY_PLANNED_MOVES);
    const roster =
      push.audience.kind === "scholars" && push.audience.scholarIds.length > 0
        ? push.audience.scholarIds
        : assignment.scholarIds;
    const scholarIds =
      push.audience.kind === "scholars" && push.audience.scholarIds.length > 0
        ? push.audience.scholarIds
        : undefined;
    const base = {
      assignmentId: assignment._id,
      activityId: push.target.activityId,
      scholarIds,
    };
    const now = Date.now();
    const data = await loadClassLinkData(ctx, push.institutionId);
    const { timeZone } = data;
    // An open-until give keeps its closing day when dragged: the Run page and
    // the give drawer change that, never a move. A move changes only when it
    // starts (and so its class link). It may start on its closing day: the
    // stored kind keeps it open until then (TRA-726), the same rule as the
    // Run page's reschedule. Only a start after it closes is refused.
    const closesAt = openUntilClosesAt(
      {
        mode: "classFocus", setAt: push.setAt, startsAt: push.startsAt, endsAt: push.endsAt,
        openUntilKind: isOpenUntilKind(push),
      },
      timeZone,
    );
    const closingDay = closesAt == null ? null : openUntilDayKey(closesAt, timeZone);
    // The window a move gives: "in that class", or for open-until work the
    // stored end exactly as it was (an older or aide-made row may close before
    // the end of its day).
    const windowFor = (
      startsAt: number,
    ): { finish: GiveFinish } | { mode: "classFocus"; endsAt: number; openUntilKind: true } => {
      if (closesAt == null || closingDay == null) return { finish: { kind: "inClass" } };
      if (dayKeyForTimezone(startsAt, timeZone) > closingDay || startsAt >= closesAt) {
        throw new ConvexError(openUntilMoveRefusal(closesAt, timeZone));
      }
      return { mode: "classFocus", endsAt: closesAt, openUntilKind: true };
    };

    if (to.kind === "class") {
      const { cls, meeting } = await classMeetingOn(ctx, ctx.user, to.classId, to.dayKey);
      // Only the give's own group's classes take it.
      const group = await ctx.db.get(cls.groupId);
      if (!group || groupsContainingRoster([group], roster).length === 0) {
        throw new ConvexError(NOT_THIS_GROUP);
      }
      const startsAt = showsUpFor(meeting, now);
      await asQuestion(() =>
        coreScheduleActivity(ctx, { ...base, startsAt, ...windowFor(startsAt) }),
      );
      try {
        await assertLinkedTo(ctx, assignment._id, base.activityId, cls._id, to.dayKey, meeting);
      } catch (error) {
        // Open-until work filed under ONE other class (its subject's) is drawn
        // in that class, so it can't sit in this one (TRA-725). Any other
        // refusal (no single class: two fitting classes, a double period,
        // classes at once, a field trip) keeps its own message.
        if (closesAt != null && error instanceof ConvexError && error.data === LINK_MISMATCH) {
          const moved = (await ctx.db.query("pushes")
            .withIndex("by_assignment_cleared", (q) =>
              q.eq("assignmentId", assignment._id).eq("clearedAt", undefined))
            .collect())
            .find((p) => p.scheduleMirror === true && p.target.kind === "activity" &&
              p.target.activityId === base.activityId);
          if (moved?.classId !== undefined && moved.classId !== cls._id) {
            throw new ConvexError(OPEN_UNTIL_OTHER_CLASS);
          }
        }
        throw error;
      }
      return;
    }

    if (!DAY_KEY.test(to.dayKey)) throw new ConvexError(`"${to.dayKey}" isn't a date.`);
    if (isClosedDay(to.dayKey, data.closures)) throw new ConvexError(NO_SCHOOL_THAT_DAY);

    if (to.kind === "allDay") {
      // From the start of the day, so it links to no class and covers the
      // school day; it finishes at the day's end ("in that class" outside any
      // class means the end of the school day).
      const dayStart = dayStartForDayKey(to.dayKey, timeZone);
      if (dayStart < now) {
        throw new ConvexError("All day work can be planned from tomorrow on.");
      }
      await asQuestion(() =>
        coreScheduleActivity(ctx, { ...base, startsAt: dayStart, ...windowFor(dayStart) }),
      );
      return;
    }

    // Homework due that day. It still shows up when it was going to, unless
    // that's after the new due day; then it shows up at the start of that day.
    if (dayEndForDayKey(to.dayKey, timeZone) < now) {
      throw new ConvexError("That day has passed. Pick today or a later day.");
    }
    // A plan whose start has already passed (it never activated) shows up now.
    const planned = Math.max(push.startsAt ?? now, now);
    const startsAt =
      dayKeyForTimezone(planned, timeZone) <= to.dayKey
        ? planned
        : Math.max(now, dayStartForDayKey(to.dayKey, timeZone));
    await asQuestion(() =>
      coreScheduleActivity(ctx, {
        ...base,
        startsAt,
        finish: { kind: "by", dayKey: to.dayKey },
      }),
    );
  },
});

/**
 * The aide's place_class with work (TRA-582): work placed on a group's cell
 * on a date is a give to the class meeting there, never a card. The class is
 * the group's one that meets in `blockId` that weekday; a cell with no class
 * (or a closed day, an ended class) gets the same sentence the grid shows.
 */
export const aideGiveToClass = internalMutation({
  args: {
    callerUserId: v.id("users"),
    periodId: v.id("reportingPeriods"),
    groupId: v.id("scholarGroups"),
    blockId: v.id("scheduleBlocks"),
    dayKey: v.string(),
    activityId: v.id("activities"),
    finish: v.union(v.literal("inClass"), v.literal("endOfDay")),
  },
  handler: async (ctx, args) => {
    const caller = await ctx.db.get(args.callerUserId);
    if (!caller || !isTeacherRole(caller.role)) {
      throw new Error("Master-schedule tools are teacher/admin only");
    }
    await requireScheduleScopeAccessible(ctx, caller, {
      periodId: args.periodId,
      groupId: args.groupId,
    });
    if (!DAY_KEY.test(args.dayKey)) throw new ConvexError(`"${args.dayKey}" isn't a date.`);
    const weekday = weekdayForDayKey(args.dayKey) || 7;
    const classes = await ctx.db.query("classes")
      .withIndex("by_period_group", (q) =>
        q.eq("periodId", args.periodId).eq("groupId", args.groupId))
      .collect();
    const cls = classes.find((c) =>
      c.archivedAt === undefined &&
      c.meetings.some((m) => m.weekday === weekday && m.blockId === args.blockId));
    if (!cls) throw new ConvexError(NO_MEETING_THAT_DAY);
    return coreGiveToClass(ctx, caller, {
      classId: cls._id,
      dayKey: args.dayKey,
      work: { kind: "activity", activityId: args.activityId },
      finish: args.finish,
    });
  },
});
