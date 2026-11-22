// The gives the teacher Master Schedule draws for one week (TRA-582).
//
// A give (`pushes` row) records its class + school-local day at write time
// (lib/classLink.ts). The grid reads that link; it never re-derives a class
// from the clock. Three places a give can land in a week:
//
//   class    → linked (`classId` + `dayKey`): that class's meeting cell
//              or, for work filed under its unit's subject's class but
//              scheduled into another class's meeting (TRA-725), that
//              meeting's cell, with the chip naming its own class
//   allDay   → no meeting cell, and its window covers the school day (it
//              shows up by the day's first class and lasts through its last)
//   other    → no meeting cell and anything else: the day's "Other times"
//              strip. A linked give whose class doesn't meet that day keeps
//              its class's name there.
//
// An open-until give (shared/openUntil.ts) whose window started in an earlier
// week and is still open is drawn again in each later week its window
// touches: once, on its closing day (or Friday if it closes in a still-later
// week), moved back to the last open day before it when that day is closed
// (TRA-724). It is class work, so it never goes to the Homework due row.
//
// Homework (`timing.kind === "homework"`) is drawn by the Homework due row,
// which reads the assignment schedule, so it is left out here. So are the
// pushes a class's own app opens each meeting (`schedulePlacementId`): the
// class cell already shows that app.

import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { meetingsOnDay } from "../../shared/classMeetings";
import {
  dayKeyForTimezone,
  dayStartForDayKey,
  instantForLocalMinutes,
  shiftDayKey,
  weekdayForDayKey,
} from "../../shared/institutionDay";
import { scheduleWeekdayDayKey } from "../../shared/scheduleWeek";
import { minuteOfDayFromLocalTime } from "../../shared/deviceActivityContext";
import { groupsContainingRoster } from "./classLink";
import { isOpenUntilKind } from "./pushes";
import { isClosedDay, type SchoolClosure } from "../../shared/schoolClosures";
import {
  openUntilClosesAt,
  openUntilDayKey,
  openUntilWeekdayPhrase,
} from "../../shared/openUntil";

export type GiveState = "planned" | "live" | "finished";
export type GivePlace = "class" | "allDay" | "other";

/** One give as the grid draws it, per group it reaches. Shaped to fit the
 *  grid's chip (components/MasterSchedule/PlacementChip.tsx). */
export type GridGive = {
  /** `${pushId}:${groupId}`: an all-school give is drawn once per group. */
  key: string;
  pushId: Id<"pushes">;
  groupId: Id<"scholarGroups">;
  place: GivePlace;
  /** 1–5 = Mon–Fri of the requested week. */
  weekday: number;
  dayKey: string;
  /** The class meeting's block, for `place === "class"`. */
  blockId: Id<"scheduleBlocks"> | null;
  classId: Id<"classes"> | null;
  /** Drawn in ANOTHER class's meeting: the class whose slot the teacher
   *  scheduled it into (TRA-725). `classId` stays the class it is filed
   *  under, and the chip names that class. Null in its own class's cell. */
  slotClassId: Id<"classes"> | null;
  subject: string;
  activityTitle: string;
  unitTitle: string | null;
  assignmentId: Id<"assignments"> | null;
  activityId: Id<"activities"> | null;
  teacherId: Id<"users"> | null;
  teacherName: string | null;
  teacherUsername: string | null;
  state: GiveState;
  /** The chip vocabulary: planned / live; a finished give is `closedLabel`. */
  linkState: "planned" | "live";
  closedLabel: string | null;
  mode: "classFocus";
  startsAt: number | null;
  /** When it ends. The grid's minute clock decides when a live give with a
   *  fading end has ended (T11): a give can stay open past its end until its
   *  clear job runs, and a same-day give is never cleared at all. */
  endsAt: number | null;
  afterEnd: "late" | "fade";
  /** "Open until Thu" for an open-until give (shared/openUntil.ts), else
   *  null. The chip's one sign of when it closes: open-until work is class
   *  work and stays out of the Homework due row (TRA-724). */
  openUntilLabel: string | null;
  /** Drawn in a later week its open-until window runs into, not the week it
   *  was given (TRA-724). Not "given that day": it never hides Up next. */
  carried: boolean;
  /** Whose give it is: only they can move it. */
  assignmentTeacherId: Id<"users"> | null;
  /** A planned unit give: the grid can drag it. Live and finished gives,
   *  and ad hoc ones (an app, a link), stay put. */
  movable: boolean;
};

/** Live = went live and still open; finished = closed after going live;
 *  planned = not live yet. Null for a row that never happened (a plan
 *  cancelled before it went live, or a row replaced by a newer one). */
export function giveState(
  push: Pick<Doc<"pushes">, "setAt" | "clearedAt" | "clearedReason">,
): GiveState | null {
  if (push.clearedReason === "superseded") return null;
  if (push.setAt === undefined) return push.clearedAt === undefined ? "planned" : null;
  return push.clearedAt === undefined ? "live" : "finished";
}

type DayBlock = Pick<Doc<"scheduleBlocks">, "startLocal" | "endLocal" | "weekdays">;

/**
 * Whether an unlinked give covers the school day: it shows up by the start of
 * the day's first class block and lasts (no end, or an end) through the end of
 * its last one. A day with no class blocks has no school day to cover.
 */
export function coversSchoolDay(
  give: { startsAt: number; endsAt: number | null },
  dayKey: string,
  classBlocks: readonly DayBlock[],
  timeZone: string,
): boolean {
  const weekday = weekdayForDayKey(dayKey) || 7;
  let first: number | null = null;
  let last: number | null = null;
  for (const block of classBlocks) {
    if (!block.weekdays.includes(weekday)) continue;
    const start = minuteOfDayFromLocalTime(block.startLocal);
    const end = block.endLocal.trim() === "24:00"
      ? 24 * 60
      : minuteOfDayFromLocalTime(block.endLocal);
    if (start == null || end == null || end <= start) continue;
    if (first == null || start < first) first = start;
    if (last == null || end > last) last = end;
  }
  if (first == null || last == null) return false;
  let dayStart: number;
  let dayEnd: number;
  try {
    dayStart = instantForLocalMinutes(dayKey, first, timeZone);
    dayEnd = last >= 24 * 60
      ? dayStartForDayKey(shiftDayKey(dayKey, 1), timeZone)
      : instantForLocalMinutes(dayKey, last, timeZone);
  } catch {
    // A wall time a DST change skips: no school day to cover.
    return false;
  }
  return give.startsAt <= dayStart && (give.endsAt == null || give.endsAt >= dayEnd);
}

type GroupLite = Pick<Doc<"scholarGroups">, "_id" | "scholarIds">;

/** The grid groups a give reaches. An all-school give reaches every group. */
export function groupsForAudience(
  audience: Doc<"pushes">["audience"],
  groups: readonly GroupLite[],
  assignmentRoster: readonly Id<"users">[] | null,
): Id<"scholarGroups">[] {
  switch (audience.kind) {
    case "group":
      return groups.some((g) => g._id === audience.groupId) ? [audience.groupId] : [];
    case "institution":
      return groups.map((g) => g._id);
    case "scholars":
      // An empty list is the whole assignment roster (a schedule row).
      return groupsContainingRoster(groups as Doc<"scholarGroups">[],
        audience.scholarIds.length > 0 ? audience.scholarIds : assignmentRoster ?? [])
        .map((g) => g._id);
    case "assignment":
      return groupsContainingRoster(groups as Doc<"scholarGroups">[], assignmentRoster ?? [])
        .map((g) => g._id);
  }
}

/** One class meeting in the requested week, with the class's "Up next": the
 *  next activity of the unit this class is on that this group hasn't been
 *  given yet. Derived on every read, never stored (TRA-582). */
export type GridClassMeeting = {
  classId: Id<"classes">;
  groupId: Id<"scholarGroups">;
  subject: string;
  teacherId: Id<"users"> | null;
  weekday: number;
  dayKey: string;
  blockId: Id<"scheduleBlocks">;
  startsAt: number;
  endsAt: number;
  upNext: UpNext | null;
};

export type UpNext = {
  unitId: Id<"units">;
  unitTitle: string;
  activityId: Id<"activities">;
  activityTitle: string;
};

/** A unit's live activities in teaching order: lessons by order, then each
 *  lesson's activities by order. */
export async function unitActivitiesInOrder(
  ctx: Pick<QueryCtx, "db">,
  unitId: Id<"units">,
): Promise<Doc<"activities">[]> {
  const lessons = await ctx.db.query("lessons")
    .withIndex("by_unit", (q) => q.eq("unitId", unitId))
    .collect();
  lessons.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  const perLesson = await Promise.all(
    lessons.map((l) =>
      ctx.db.query("activities")
        .withIndex("by_lesson", (q) => q.eq("lessonId", l._id))
        .collect(),
    ),
  );
  return perLesson.flatMap((acts) =>
    acts.filter((a) => !a.archivedAt).sort((a, b) => (a.order ?? 0) - (b.order ?? 0)),
  );
}

/** How many of a class's latest gives (by day) "Up next" looks through. */
const UP_NEXT_SCAN = 50;

type RosterCache = Map<string, Promise<readonly Id<"users">[]>>;

/**
 * Whether a give reaches any of `members`. Same rule as the aide's class plans
 * (lib/classPlans `reachesMembers`): an all-school give reaches everyone; a
 * scholar list, a group or an assignment roster reaches whoever is on it.
 */
async function reachesMembers(
  ctx: Pick<QueryCtx, "db">,
  push: Doc<"pushes">,
  members: ReadonlySet<string>,
  rosters: RosterCache,
  institutionId: Id<"institutions">,
): Promise<boolean> {
  // Another school's give never reaches this group, whatever its audience.
  if (push.institutionId !== institutionId) return false;
  const a = push.audience;
  const roster = (key: string, load: () => Promise<readonly Id<"users">[]>) => {
    if (!rosters.has(key)) rosters.set(key, load());
    return rosters.get(key)!;
  };
  if (a.kind === "institution") return true;
  let ids: readonly Id<"users">[];
  if (a.kind === "scholars" && a.scholarIds.length > 0) {
    ids = a.scholarIds;
  } else if (a.kind === "group") {
    ids = await roster(`g:${a.groupId}`, async () => (await ctx.db.get(a.groupId))?.scholarIds ?? []);
  } else {
    const assignmentId = a.kind === "assignment" ? a.assignmentId : push.assignmentId;
    if (!assignmentId) return false;
    ids = await roster(`a:${assignmentId}`, async () => (await ctx.db.get(assignmentId))?.scholarIds ?? []);
  }
  return ids.some((id) => members.has(String(id)));
}

/** Request-local caches for "Up next" across a grid's classes. */
export type UpNextCache = {
  rosters: RosterCache;
  /** `${activityId}|${groupId}` → whether that activity was given there. */
  given: Map<string, Promise<boolean>>;
  activities: Map<string, Promise<Doc<"activities">[]>>;
};

export function newUpNextCache(): UpNextCache {
  return { rosters: new Map(), given: new Map(), activities: new Map() };
}

/** Per activity, how many open gives and how many closed gives (newest
 *  first) "Up next" reads to learn whether this group got it. */
const GIVES_PER_ACTIVITY = 200;

/**
 * Whether any give of `activityId` reached anyone in `group`, on any
 * assignment (another teacher's, a shared Run-page one, one made for an
 * earlier roster), however long ago. A plan cancelled before it went live
 * doesn't count. One bounded index read per activity.
 */
async function givenToGroup(
  ctx: Pick<QueryCtx, "db">,
  activityId: Id<"activities">,
  group: Pick<Doc<"scholarGroups">, "_id" | "scholarIds">,
  institutionId: Id<"institutions">,
  cache: UpNextCache,
): Promise<boolean> {
  const members = new Set(group.scholarIds.map(String));
  const reaches = async (pushes: Doc<"pushes">[]) => {
    for (const push of pushes) {
      if (giveState(push) == null) continue;
      if (await reachesMembers(ctx, push, members, cache.rosters, institutionId)) return true;
    }
    return false;
  };
  // Open gives first, then closed ones newest first, so a give from
  // yesterday is never past the cap behind years of older ones.
  if (await reaches(await ctx.db.query("pushes")
    .withIndex("by_target_activity_cleared", (q) =>
      q.eq("target.activityId", activityId).eq("clearedAt", undefined))
    .take(GIVES_PER_ACTIVITY))) return true;
  return reaches(await ctx.db.query("pushes")
    .withIndex("by_target_activity_cleared", (q) =>
      q.eq("target.activityId", activityId).gte("clearedAt", 0))
    .order("desc")
    .take(GIVES_PER_ACTIVITY));
}

/**
 * The next activity a class should be given: the class's unit is the unit of
 * the unit give most recently made to it; the next activity is that unit's
 * first one nobody has given this group yet (planned, live or finished, on
 * any assignment). Null when the class has never been given
 * unit work or the unit is all given.
 */
export async function upNextForClass(
  ctx: Pick<QueryCtx, "db">,
  cls: Pick<Doc<"classes">, "_id" | "groupId" | "institutionId">,
  cache: UpNextCache = newUpNextCache(),
): Promise<UpNext | null> {
  const recent = (await ctx.db.query("pushes")
    .withIndex("by_class_day", (q) => q.eq("classId", cls._id))
    .order("desc")
    .take(UP_NEXT_SCAN))
    .filter((push) => push.assignmentId && giveState(push) != null)
    .sort((a, b) => b._creationTime - a._creationTime);
  let unitId: Id<"units"> | null = null;
  for (const push of recent) {
    const a = await ctx.db.get(push.assignmentId!);
    if (a?.unitId && !a.archivedAt) {
      unitId = a.unitId;
      break;
    }
  }
  if (!unitId) return null;
  const unit = await ctx.db.get(unitId);
  const group = await ctx.db.get(cls.groupId);
  if (!unit || !group) return null;
  if (!cache.activities.has(String(unitId))) {
    cache.activities.set(String(unitId), unitActivitiesInOrder(ctx, unitId));
  }
  // In teaching order, stop at the first activity nobody gave this group:
  // the reads stop there too.
  for (const activity of await cache.activities.get(String(unitId))!) {
    const key = `${activity._id}|${group._id}`;
    if (!cache.given.has(key)) {
      cache.given.set(key, givenToGroup(ctx, activity._id, group, cls.institutionId, cache));
    }
    if (!(await cache.given.get(key)!)) {
      return {
        unitId, unitTitle: unit.title, activityId: activity._id, activityTitle: activity.title,
      };
    }
  }
  return null;
}

/**
 * The meeting a give was scheduled into: one that holds its whole window. It
 * starts at or during the meeting and ends by the meeting's end ("in that
 * class" ends with it). Work that goes live and stays open past the meeting
 * (open until a day, until cleared, a "now" give with a later end) was not
 * scheduled into it. Shared with gridGiveActions, so a give to a class cell
 * is checked against where the grid will draw it.
 */
export function meetingHolding<M extends { startsAt: number; endsAt: number }>(
  give: Pick<Doc<"pushes">, "startsAt" | "setAt" | "endsAt" | "timing">,
  meetings: readonly M[],
): M | null {
  if (give.timing.kind === "homework") return null;
  const start = give.startsAt ?? give.setAt;
  const end = give.endsAt;
  if (start === undefined || end === undefined) return null;
  return meetings.find((m) => m.startsAt <= start && start < m.endsAt && end <= m.endsAt) ?? null;
}

/** The fields of a grid block row this module reads. */
type GridBlock = {
  _id: Id<"scheduleBlocks">;
  kind: string;
  startLocal: string;
  endLocal: string;
  weekdays: number[];
};

/**
 * Every give the grid draws for `week` (Monday 00:00 school-local), for the
 * given groups. Linked gives come from the class-day index, one range read per
 * class; unlinked ones from the school's gives that went live this week and
 * its open plans.
 */
export async function loadGridGives(
  ctx: Pick<QueryCtx, "db">,
  args: {
    institutionId: Id<"institutions"> | null;
    periodId: Id<"reportingPeriods">;
    week: number;
    timeZone: string;
    blocks: readonly GridBlock[];
    groups: readonly Doc<"scholarGroups">[];
    /** The school's closures, for the last open day of the week. */
    closures?: readonly SchoolClosure[];
    /** Derive each class's Up next (the teacher grid; not the program grid,
     *  whose staff give through their own dialog). */
    withUpNext: boolean;
  },
): Promise<{ gives: GridGive[]; meetings: GridClassMeeting[] }> {
  const { week, timeZone, blocks, groups } = args;
  const dayKeys = [1, 2, 3, 4, 5].map((n) => scheduleWeekdayDayKey(week, n, timeZone));
  const weekdayByDayKey = new Map(dayKeys.map((k, i) => [k, i + 1]));
  const groupIds = new Set(groups.map((g) => String(g._id)));
  const classBlocks = blocks.filter((b) => b.kind === "class");
  const blocksById = new Map(classBlocks.map((b) => [String(b._id), b]));

  // Request-local caches for the enrichment reads.
  const docCache = new Map<string, Promise<unknown>>();
  const get = <T>(id: string): Promise<T | null> => {
    let pending = docCache.get(id);
    if (!pending) {
      pending = ctx.db.get(id as Id<"users">);
      docCache.set(id, pending);
    }
    return pending as Promise<T | null>;
  };

  const out: GridGive[] = [];
  const meetingsOut: GridClassMeeting[] = [];
  const seen = new Set<string>();

  const describe = async (push: Doc<"pushes">) => {
    let activityTitle = "Untitled";
    let activityId: Id<"activities"> | null = null;
    switch (push.target.kind) {
      case "activity": {
        activityId = push.target.activityId;
        const act = await get<Doc<"activities">>(push.target.activityId);
        activityTitle = act?.title ?? "(deleted activity)";
        break;
      }
      case "app":
        activityTitle =
          (await get<Doc<"externalApps">>(push.target.externalAppId))?.name ?? "App";
        break;
      case "resource":
        activityTitle =
          (await get<Doc<"activityResources">>(push.target.resourceId))?.title ?? "Resource";
        break;
      case "link":
        activityTitle = push.target.title;
        break;
    }
    const assignment = push.assignmentId
      ? await get<Doc<"assignments">>(push.assignmentId)
      : null;
    const unit = assignment?.unitId ? await get<Doc<"units">>(assignment.unitId) : null;
    return {
      activityTitle,
      activityId,
      assignment,
      unitTitle: unit?.title ?? assignment?.title ?? null,
    };
  };

  const emit = async (
    push: Doc<"pushes">,
    state: GiveState,
    place: GivePlace,
    dayKey: string,
    targetGroups: readonly Id<"scholarGroups">[],
    cls: Doc<"classes"> | null,
    blockId: Id<"scheduleBlocks"> | null,
    opts: {
      /** Drawn in a later week its open-until window touches (TRA-724). */
      carried?: boolean;
      /** The class whose slot it was scheduled into (TRA-725). */
      slotClassId?: Id<"classes"> | null;
    } = {},
  ) => {
    const carried = opts.carried ?? false;
    const slotClassId = opts.slotClassId ?? null;
    const weekday = weekdayByDayKey.get(dayKey);
    if (weekday == null) return;
    const info = await describe(push);
    const teacherId = cls?.teacherId ?? push.pushedBy;
    const teacher = await get<Doc<"users">>(teacherId);
    for (const groupId of targetGroups) {
      if (!groupIds.has(String(groupId))) continue;
      const key = `${push._id}:${groupId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        key,
        pushId: push._id,
        groupId,
        place,
        weekday,
        dayKey,
        blockId,
        classId: cls?._id ?? null,
        slotClassId,
        subject: cls?.subject ?? info.unitTitle ?? "Given work",
        activityTitle: info.activityTitle,
        unitTitle: info.unitTitle,
        assignmentId: push.assignmentId ?? null,
        activityId: info.activityId,
        teacherId,
        teacherName: teacher?.name ?? null,
        teacherUsername: teacher?.username ?? null,
        state,
        linkState: state === "planned" ? "planned" : "live",
        closedLabel: state === "finished" ? "Ended" : null,
        mode: "classFocus",
        startsAt: push.startsAt ?? push.setAt ?? null,
        endsAt: push.endsAt ?? null,
        afterEnd: push.afterEnd,
        carried,
        openUntilLabel: (() => {
          const closesAt = openUntilClosesAt(
            {
              mode: "classFocus",
              setAt: push.setAt,
              startsAt: push.startsAt,
              endsAt: push.endsAt,
              openUntilKind: isOpenUntilKind(push),
            },
            timeZone,
          );
          return closesAt != null ? openUntilWeekdayPhrase(closesAt, timeZone) : null;
        })(),
        assignmentTeacherId: info.assignment?.teacherId ?? null,
        movable:
          !carried &&
          state === "planned" &&
          push.scheduleMirror === true &&
          info.activityId != null &&
          info.assignment != null,
      });
    }
  };

  const drawable = (push: Doc<"pushes">) =>
    push.timing.kind !== "homework" && push.schedulePlacementId === undefined;

  // ── Linked gives: one range read per class, in parallel ──
  const classes = (
    await Promise.all(
      groups.map((g) =>
        ctx.db.query("classes")
          .withIndex("by_period_group", (q) =>
            q.eq("periodId", args.periodId).eq("groupId", g._id))
          .collect(),
      ),
    )
  ).flat();
  const classPushes = await Promise.all(
    classes.map((cls) =>
      ctx.db.query("pushes")
        .withIndex("by_class_day", (q) =>
          q.eq("classId", cls._id).gte("dayKey", dayKeys[0]).lte("dayKey", dayKeys[4]))
        .collect(),
    ),
  );
  // This week's meetings of live classes, each with its class's Up next.
  const upNextCache = newUpNextCache();
  const upNexts = await Promise.all(
    classes.map((cls) =>
      args.withUpNext && cls.archivedAt === undefined
        ? upNextForClass(ctx, cls, upNextCache)
        : null),
  );
  for (const [i, cls] of classes.entries()) {
    if (cls.archivedAt !== undefined) continue;
    for (const [d, dayKey] of dayKeys.entries()) {
      const [meeting] = meetingsOnDay(cls, blocksById, dayKey, timeZone);
      if (!meeting) continue;
      meetingsOut.push({
        classId: cls._id,
        groupId: cls.groupId,
        subject: cls.subject,
        teacherId: cls.teacherId ?? null,
        weekday: d + 1,
        dayKey,
        blockId: meeting.blockId as Id<"scheduleBlocks">,
        startsAt: meeting.startsAt,
        endsAt: meeting.endsAt,
        upNext: upNexts[i],
      });
    }
  }
  // Every meeting of a live class, by group and day (a class meeting twice
  // that day contributes both), to find the slot a give was scheduled into.
  const meetingsByGroupDay = new Map<string, Array<{
    classId: Id<"classes">; blockId: Id<"scheduleBlocks">; startsAt: number; endsAt: number;
  }>>();
  for (const cls of classes) {
    if (cls.archivedAt !== undefined) continue;
    for (const dayKey of dayKeys) {
      for (const m of meetingsOnDay(cls, blocksById, dayKey, timeZone)) {
        const key = `${cls.groupId}|${dayKey}`;
        if (!meetingsByGroupDay.has(key)) meetingsByGroupDay.set(key, []);
        meetingsByGroupDay.get(key)!.push({
          classId: cls._id, blockId: m.blockId as Id<"scheduleBlocks">,
          startsAt: m.startsAt, endsAt: m.endsAt,
        });
      }
    }
  }
  const rosterCache = new Map<string, readonly Id<"users">[] | null>();
  /** The grid groups a give's audience reaches. */
  const audienceGroups = async (push: Doc<"pushes">) => {
    let roster: readonly Id<"users">[] | null = null;
    // An empty scholar list on a schedule row is the whole assignment roster.
    const rosterAssignmentId = push.audience.kind === "assignment"
      ? push.audience.assignmentId
      : push.audience.kind === "scholars" && push.audience.scholarIds.length === 0
        ? push.assignmentId : undefined;
    if (rosterAssignmentId) {
      const id = String(rosterAssignmentId);
      if (!rosterCache.has(id)) {
        rosterCache.set(id, (await get<Doc<"assignments">>(id))?.scholarIds ?? null);
      }
      roster = rosterCache.get(id) ?? null;
    }
    return groupsForAudience(push.audience, groups, roster);
  };
  const besideTheDay = (push: Doc<"pushes">, dayKey: string): GivePlace => {
    const at = push.startsAt ?? push.setAt;
    return at !== undefined && coversSchoolDay(
      { startsAt: at, endsAt: push.endsAt ?? null }, dayKey, classBlocks, timeZone,
    ) ? "allDay" : "other";
  };
  for (const [i, cls] of classes.entries()) {
    for (const push of classPushes[i]) {
      if (!drawable(push) || push.dayKey === undefined) continue;
      const state = giveState(push);
      if (!state) continue;
      const dayKey = push.dayKey;
      // Drawn on every group row its audience reaches, and always on its
      // class's group's.
      const targets = new Set((await audienceGroups(push)).map(String));
      targets.add(String(cls.groupId));
      // A class meets at most once a day; two meetings is bad data, and a
      // give can't say which one it meant, so it lands on the first.
      const [own] = cls.archivedAt === undefined
        ? meetingsOnDay(cls, blocksById, dayKey, timeZone)
        : [];
      for (const target of targets) {
        const groupId = target as Id<"scholarGroups">;
        // Scheduled into another class's meeting of this group: drawn in
        // that slot, under its own class's subject (TRA-725).
        const slot = meetingHolding(
          push,
          (meetingsByGroupDay.get(`${groupId}|${dayKey}`) ?? [])
            .filter((m) => m.classId !== cls._id),
        );
        if (slot) {
          await emit(push, state, "class", dayKey, [groupId], cls, slot.blockId,
            { slotClassId: slot.classId });
        } else if (own && groupId === cls.groupId) {
          await emit(push, state, "class", dayKey, [groupId], cls,
            own.blockId as Id<"scheduleBlocks">);
        } else {
          // No cell in this row (another group's row, its class doesn't meet
          // that day, a meeting that moved, or an archived class): beside the
          // day, keeping its class's name.
          await emit(push, state, besideTheDay(push, dayKey), dayKey, [groupId], cls, null);
        }
      }
    }
  }

  // ── Unlinked gives this week ──
  // Ones that went live this week, plus open plans (never the whole history
  // of cancelled ones). Cleared rows never return to open, so the open set is
  // what a school has planned or running now.
  if (!args.institutionId) return { gives: out, meetings: meetingsOut };
  const institutionId = args.institutionId;
  const weekEnd = dayStartForDayKey(shiftDayKey(dayKeys[0], 7), timeZone);
  const [started, open] = await Promise.all([
    ctx.db.query("pushes")
      .withIndex("by_institution_setAt", (q) =>
        q.eq("institutionId", institutionId).gte("setAt", week).lt("setAt", weekEnd))
      .collect(),
    ctx.db.query("pushes")
      .withIndex("by_institution_cleared", (q) =>
        q.eq("institutionId", institutionId).eq("clearedAt", undefined))
      .collect(),
  ]);
  const planned = open.filter((push) => push.setAt === undefined);
  for (const push of [...started, ...planned]) {
    if (push.classId !== undefined || !drawable(push)) continue;
    const state = giveState(push);
    if (!state) continue;
    const at = push.startsAt ?? push.setAt;
    if (at === undefined) continue;
    const dayKey = dayKeyForTimezone(at, timeZone);
    if (!weekdayByDayKey.has(dayKey)) continue;
    const targetGroups = await audienceGroups(push);
    if (targetGroups.length === 0) continue;
    await emit(push, state, besideTheDay(push, dayKey), dayKey, targetGroups, null, null);
  }

  // ── Open-until windows carried in from an earlier week (TRA-724) ──
  // Only gives still open (the `open` read above, no other read) are carried:
  // a cleared, withdrawn or closed give is drawn in its start week only.
  for (const push of open) {
    if (!drawable(push) || push.setAt === undefined) continue;
    const closesAt = openUntilClosesAt(
      {
        mode: "classFocus", setAt: push.setAt, startsAt: push.startsAt, endsAt: push.endsAt,
        openUntilKind: isOpenUntilKind(push),
      },
      timeZone,
    );
    if (closesAt == null) continue;
    // Started in an earlier week (that week drew it), by the same start
    // `isOpenUntil` reads, and still open on or after this Monday.
    if (dayKeyForTimezone(push.setAt, timeZone) >= dayKeys[0]) continue;
    const closeDay = openUntilDayKey(closesAt, timeZone);
    if (closeDay < dayKeys[0]) continue;
    const state = giveState(push);
    if (!state) continue;
    // Its closing day, or Friday when it closes on the weekend or later;
    // if that day is closed, the last open day before it in this week. A
    // closed day's cells are replaced by the closed-day cell, so a card there
    // would be invisible. With no open day up to then, it isn't drawn.
    const lastDay = weekdayByDayKey.has(closeDay) ? closeDay : dayKeys[4];
    const dayKey = [...dayKeys]
      .reverse()
      .find((k) => k <= lastDay && !isClosedDay(k, args.closures ?? []));
    if (dayKey === undefined) continue;
    // A class from another reporting period has no cell on this grid.
    const cls = push.classId !== undefined ? await get<Doc<"classes">>(push.classId) : null;
    const gridClass = cls && cls.periodId === args.periodId ? cls : null;
    const [meeting] = gridClass && gridClass.archivedAt === undefined
      ? meetingsOnDay(gridClass, blocksById, dayKey, timeZone)
      : [];
    // Every group row its audience reaches, as a start-week give, and its
    // class's group's. No slot containment: a carried window is days long,
    // and a give scheduled into another class's slot ends at that bell, so it
    // is never carried.
    const targets = new Set((await audienceGroups(push)).map(String));
    if (cls) targets.add(String(cls.groupId));
    for (const target of targets) {
      const groupId = target as Id<"scholarGroups">;
      if (meeting && gridClass && groupId === gridClass.groupId) {
        await emit(push, state, "class", dayKey, [groupId], gridClass,
          meeting.blockId as Id<"scheduleBlocks">, { carried: true });
      } else {
        await emit(push, state, besideTheDay(push, dayKey), dayKey, [groupId], gridClass, null,
          { carried: true });
      }
    }
  }
  return { gives: out, meetings: meetingsOut };
}

/** The parts of `masterSchedule.coreGrid`'s result the gives need. */
type GridForGives = {
  weekStartMs: number;
  closureTimeZone: string;
  blocks: readonly GridBlock[];
  groups: readonly { _id: Id<"scholarGroups"> }[];
  closures?: readonly SchoolClosure[];
  weekPlacements: readonly {
    groupId: Id<"scholarGroups">;
    weekday: number | null;
    assignmentId: Id<"assignments"> | null;
    activityId: Id<"activities"> | null;
  }[];
};

/**
 * The gives for a grid the caller already loaded (`masterSchedule.grid` and
 * `programGrid` only; the other `coreGrid` readers don't draw gives). The
 * grid's groups are already limited to what the caller may see. Where
 * activity cards still draw, a give a card stands for is drawn once, as the
 * card.
 */
export async function gridGivesFor(
  ctx: Pick<QueryCtx, "db">,
  periodId: Id<"reportingPeriods">,
  grid: GridForGives,
  opts: {
    withUpNext: boolean;
    /** Whether the surface still draws activity cards (the program grid's
     *  handouts). The teacher grid retired them (TRA-582), so every give
     *  draws there. */
    cardsDrawn?: boolean;
  },
): Promise<{ gives: GridGive[]; classMeetings: GridClassMeeting[] }> {
  const period = await ctx.db.get(periodId);
  const groups = (
    await Promise.all(grid.groups.map((g) => ctx.db.get(g._id)))
  ).filter((g): g is Doc<"scholarGroups"> => g != null);
  const { gives, meetings } = await loadGridGives(ctx, {
    institutionId: period?.institutionId ?? null,
    periodId,
    week: grid.weekStartMs,
    timeZone: grid.closureTimeZone,
    blocks: grid.blocks,
    closures: grid.closures,
    groups,
    withUpNext: opts.withUpNext,
  });
  const cardKeys = new Set(
    (opts.cardsDrawn ? grid.weekPlacements : [])
      .filter((p) => p.assignmentId && p.activityId && p.weekday != null)
      .map((p) => `${p.assignmentId}:${p.activityId}:${p.groupId}:${p.weekday}`),
  );
  return {
    gives: gives.filter(
      (give) =>
        !cardKeys.has(`${give.assignmentId}:${give.activityId}:${give.groupId}:${give.weekday}`),
    ),
    classMeetings: meetings,
  };
}
