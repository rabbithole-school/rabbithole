// Planning a unit across a class's days with the aide (TRA-582).
//
// Unit flow on the grid is retired; a teacher plans by asking the aide ("put
// the rest of Mapping Our Islands on Humanities through next week, one a
// day"). Three operations back the aide's tools (lib/classPlanTools.ts):
//
//   - read a class's meetings over a range, with closures, and what a group
//     already has of a unit (aideClassDays);
//   - give several activities to several meetings (planClassGivesWrite stores
//     the plan the teacher is shown; commitClassGives writes exactly it);
//   - move a run of the class's planned gives N meetings later or earlier
//     (planClassMoveWrite / commitClassMove).
//
// No new give path: every give goes through coreAssignWork (the `give` tool's
// own writer), every move through coreAideRescheduleActivity (the
// reschedule_activity tool's). A give starts at its meeting's start, and the
// schedule store links it to that class and day (lib/classLink
// classFieldsForPush); the writes read the link back so the reply reports
// what was stored, not what was asked.
//
// Confirmation is enforced here, not in the prompt (the admissions pattern,
// convex/admissionsAgent.ts): a plan is stored in classPlanConfirmations, and
// a commit writes that stored plan only for the same person in the same place,
// from a later turn, unexpired and once. It recomputes the plan and refuses
// when anything changed since the teacher saw it, and writes all of it or
// none. The MCP connector has no turns, so it never gets these writes.

import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { isTeacherRole } from "./lib/roles";
import {
  requireGroupScholarAccess,
  requireScholarsAccessible,
} from "./lib/access";
import { requireUnitAccessForUser } from "./lib/unitAccess";
import { loadClassLinkData } from "./lib/classLink";
import { meetingHolding } from "./lib/gridGives";
import { classSubjectKey } from "./lib/classResolver";
import { isOpenUntilKind, isScheduleRow, pushLane } from "./lib/pushes";
import {
  finishIsHomework,
  giveFinishValidator,
  type GiveFinish,
} from "./lib/giveWindow";
import {
  coreAideRescheduleActivity,
  coreAssignWork,
  findReusableAssignment,
  gatherUnitActivities,
} from "./assignments";
import {
  MAX_PLAN_DAYS,
  PLAN_CONFIRMATION_REFUSED,
  canonicalJson,
  classMeetingDays,
  shiftMeeting,
  type PlanClassTerm,
  type PlanClosedMeeting,
  type PlanMeeting,
} from "./lib/classPlan";
import { dayKeyForTimezone, shiftDayKey } from "../shared/institutionDay";
import { openUntilClosesAt, openUntilDayKey } from "../shared/openUntil";

type ReadCtx = Pick<QueryCtx, "db">;
const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/;

// ───────────────────────────── the class ─────────────────────────────

type ClassContext = {
  group: Doc<"scholarGroups">;
  subject: string;
  timeZone: string;
  todayDayKey: string;
  closures: Awaited<ReturnType<typeof loadClassLinkData>>["closures"];
  terms: PlanClassTerm<Id<"classes">>[];
};

type ClassLookup =
  | { ok: true; cls: ClassContext }
  | { ok: false; message: string };

/** The caller, refused unless a teacher who can reach the group. */
async function requireTeacherForGroup(
  ctx: ReadCtx,
  callerUserId: Id<"users">,
  groupId: Id<"scholarGroups">,
): Promise<{ caller: Doc<"users">; group: Doc<"scholarGroups"> }> {
  const caller = await ctx.db.get(callerUserId);
  if (!caller || !isTeacherRole(caller.role)) {
    throw new Error("Planning a class is for teachers.");
  }
  // Tenancy: a group outside the caller's school (or lens) is Forbidden.
  const group = await requireGroupScholarAccess(
    ctx as QueryCtx,
    caller,
    groupId,
  );
  if (!group) throw new Error("Group not found");
  return { caller, group };
}

/** A group's class for a subject, every term of it, with the school's
 *  closures and time zone. Refuses with the group's subjects when no class
 *  matches. */
async function loadClass(
  ctx: ReadCtx,
  group: Doc<"scholarGroups">,
  subject: string,
  now: number,
): Promise<ClassLookup> {
  const all = (
    await ctx.db
      .query("classes")
      .withIndex("by_group_subject_period", (q) => q.eq("groupId", group._id))
      .collect()
  ).filter((c) => c.archivedAt === undefined);
  const key = classSubjectKey(subject);
  const rows = all.filter((c) => c.subjectKey === key);
  if (rows.length === 0) {
    const subjects = [...new Set(all.map((c) => c.subject.trim()))].sort();
    return {
      ok: false,
      message: subjects.length
        ? `${group.name} has no ${subject.trim()} class. Its classes: ${subjects.join(", ")}.`
        : `${group.name} has no classes on the schedule yet.`,
    };
  }
  const institutionId = rows[0].institutionId;
  const data = await loadClassLinkData(ctx, institutionId);
  const terms: PlanClassTerm<Id<"classes">>[] = [];
  for (const cls of rows) {
    if (cls.institutionId !== institutionId) continue;
    const period = await ctx.db.get(cls.periodId);
    if (!period) continue;
    const blocks = await ctx.db
      .query("scheduleBlocks")
      .withIndex("by_period", (q) => q.eq("periodId", cls.periodId))
      .collect();
    terms.push({
      classId: cls._id,
      cls,
      periodStartsAt: period.startsAt,
      periodEndsAt: period.endsAt,
      blocksById: new Map(
        blocks
          .filter(
            (b) =>
              (b.kind ?? "class") === "class" &&
              (!b.groupId || b.groupId === group._id),
          )
          .map((b) => [String(b._id), b]),
      ),
    });
  }
  return {
    ok: true,
    cls: {
      group,
      subject: rows[0].subject.trim(),
      timeZone: data.timeZone,
      todayDayKey: dayKeyForTimezone(now, data.timeZone),
      closures: data.closures,
      terms,
    },
  };
}

function meetingRange(
  cls: ClassContext,
  fromDayKey: string,
  throughDayKey: string,
): { meetings: PlanMeeting<Id<"classes">>[]; closed: PlanClosedMeeting[] } {
  return classMeetingDays({
    terms: cls.terms,
    closures: cls.closures,
    fromDayKey,
    throughDayKey,
    timeZone: cls.timeZone,
  });
}

function checkRange(fromDayKey: string, throughDayKey: string): string | null {
  if (!DAY_KEY.test(fromDayKey) || !DAY_KEY.test(throughDayKey)) {
    return "Days are YYYY-MM-DD.";
  }
  if (throughDayKey < fromDayKey) return "The range ends before it starts.";
  if (throughDayKey > shiftDayKey(fromDayKey, MAX_PLAN_DAYS - 1)) {
    return `Ask for at most ${MAX_PLAN_DAYS} days at a time.`;
  }
  return null;
}

/** The day a give belongs to: its class day, else the day it starts. */
function pushDayKey(push: Doc<"pushes">, timeZone: string): string {
  return push.dayKey ?? dayKeyForTimezone(push.setAt ?? push.startsAt ?? push._creationTime, timeZone);
}

// ───────────────────────── what the group has ─────────────────────────

type GivenState = "planned" | "live" | "ended";

export type GivenTo = {
  state: GivenState;
  dayKey: string | null;
  /** True when it is on the assignment a plan for this group gives into, so
   *  giving it again moves that give rather than adding a second one. */
  sameAssignment: boolean;
};

export type UnitActivityRow = {
  activityId: Id<"activities">;
  title: string;
  lessonTitle: string;
  /** The latest give of it that reaches this group, or null. */
  given: GivenTo | null;
};

/** A give from the unit that this group can see, still open: it holds its
 *  meeting, so a plan doesn't stack a second activity on it unasked. */
type HeldMeeting = {
  activityId: Id<"activities">;
  title: string;
  dayKey: string;
  startsAt: number | null;
};

/**
 * Whether a give reaches any of `members`. Its audience decides: named
 * scholars, the assignment's cohort, a group, or the whole school. A give to
 * another group on a shared assignment does not count for this one.
 */
async function reachesMembers(
  ctx: ReadCtx,
  push: Doc<"pushes">,
  members: ReadonlySet<string>,
  rosters: Map<string, Promise<readonly Id<"users">[]>>,
): Promise<boolean> {
  const a = push.audience;
  const roster = (key: string, load: () => Promise<readonly Id<"users">[]>) => {
    if (!rosters.has(key)) rosters.set(key, load());
    return rosters.get(key)!;
  };
  let ids: readonly Id<"users">[];
  if (a.kind === "institution") return true;
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

/**
 * A unit's activities in teaching order, each with the latest give of it that
 * reaches this group, plus the meetings those gives still hold.
 *
 * A plan gives only into the assignment `give` would use for exactly this
 * roster (findReusableAssignment), else a new one: the schedule keeps one
 * entry per (assignment, activity), so giving into an assignment shared with
 * another group would overwrite that group's give. When the unit is running
 * for this group only on a shared assignment, `sharedRunning` says how many
 * other scholars are on it (a count; never who), so the aide can say why the
 * plan makes its own assignment.
 */
async function unitActivitiesForRoster(
  ctx: ReadCtx,
  caller: Doc<"users">,
  unitId: Id<"units">,
  scholarIds: readonly Id<"users">[],
  classIds: readonly Id<"classes">[],
  timeZone: string,
): Promise<{
  unitTitle: string;
  /** The assignment a plan's gives go to, or null for a new one. */
  assignmentId: Id<"assignments"> | null;
  sharedRunning: { otherScholars: number } | null;
  activities: UnitActivityRow[];
  held: HeldMeeting[];
}> {
  const unit = await requireUnitAccessForUser(ctx as QueryCtx, caller, unitId);
  const activities = await gatherUnitActivities(ctx, unitId, null);
  const titleOf = new Map(activities.map((a) => [String(a._id), a.title]));
  const members = new Set(scholarIds.map(String));
  const exact = await findReusableAssignment(ctx as QueryCtx, caller._id, unitId, scholarIds);
  const running = (
    await ctx.db
      .query("assignments")
      .withIndex("by_teacher", (q) => q.eq("teacherId", caller._id))
      .collect()
  ).filter(
    (a) => !a.archivedAt && a.unitId === unitId && a.scholarIds.some((id) => members.has(String(id))),
  );
  let sharedRunning: { otherScholars: number } | null = null;
  if (!exact && running.length > 0) {
    const others = (a: Doc<"assignments">) =>
      a.scholarIds.filter((id) => !members.has(String(id))).length;
    const closest = [...running].sort((a, b) => others(a) - others(b))[0];
    sharedRunning = { otherScholars: others(closest) };
  }

  const pushes = new Map<string, Doc<"pushes">>();
  for (const a of running) {
    for (const p of await ctx.db
      .query("pushes")
      .withIndex("by_assignment", (q) => q.eq("assignmentId", a._id))
      .collect()) pushes.set(String(p._id), p);
  }
  for (const classId of classIds) {
    for (const p of await ctx.db
      .query("pushes")
      .withIndex("by_class_day", (q) => q.eq("classId", classId))
      .collect()) pushes.set(String(p._id), p);
  }
  const rosters = new Map<string, Promise<readonly Id<"users">[]>>();
  const latest = new Map<string, Doc<"pushes">>();
  const held: HeldMeeting[] = [];
  const at = (r: Doc<"pushes">) => r.setAt ?? r.startsAt ?? r._creationTime;
  for (const row of pushes.values()) {
    if (!isScheduleRow(row) || row.target.kind !== "activity") continue;
    const key = String(row.target.activityId);
    if (!titleOf.has(key)) continue;
    // A plan cleared before it went live never reached scholars.
    if (row.clearedAt !== undefined && row.setAt === undefined) continue;
    if (row.scheduleWithdrawn) continue;
    if (!(await reachesMembers(ctx, row, members, rosters))) continue;
    const prev = latest.get(key);
    if (!prev || at(row) > at(prev)) latest.set(key, row);
    if (row.clearedAt === undefined) {
      held.push({
        activityId: row.target.activityId,
        title: titleOf.get(key)!,
        dayKey: pushDayKey(row, timeZone),
        startsAt: row.startsAt ?? row.setAt ?? null,
      });
    }
  }
  const lessonTitles = new Map<string, string>();
  for (const act of activities) {
    if (act.lessonId && !lessonTitles.has(String(act.lessonId))) {
      const lesson = await ctx.db.get(act.lessonId);
      lessonTitles.set(String(act.lessonId), lesson?.title ?? "");
    }
  }
  return {
    unitTitle: unit.title,
    assignmentId: exact?._id ?? null,
    sharedRunning,
    held,
    activities: activities.map((act) => {
      const row = latest.get(String(act._id));
      return {
        activityId: act._id,
        title: act.title,
        lessonTitle: act.lessonId ? lessonTitles.get(String(act.lessonId)) ?? "" : "",
        given: row
          ? {
              state:
                row.clearedAt !== undefined
                  ? "ended"
                  : row.setAt !== undefined
                    ? "live"
                    : "planned",
              dayKey: pushDayKey(row, timeZone),
              sameAssignment: exact !== null && row.assignmentId === exact._id,
            }
          : null,
      };
    }),
  };
}

// ─────────────────────────────── read ───────────────────────────────

export const aideClassDays = internalQuery({
  args: {
    callerUserId: v.id("users"),
    groupId: v.id("scholarGroups"),
    subject: v.string(),
    fromDayKey: v.optional(v.string()),
    throughDayKey: v.optional(v.string()),
    unitId: v.optional(v.id("units")),
    /** The group's members as the aide resolved them (the give cohort). */
    scholarIds: v.array(v.id("users")),
    now: v.number(),
  },
  handler: async (ctx, args) => {
    const { caller, group } = await requireTeacherForGroup(
      ctx,
      args.callerUserId,
      args.groupId,
    );
    await requireScholarsAccessible(ctx, caller, args.scholarIds);
    const found = await loadClass(ctx, group, args.subject, args.now);
    if (!found.ok) return found;
    const { cls } = found;
    const fromDayKey = args.fromDayKey ?? cls.todayDayKey;
    const throughDayKey = args.throughDayKey ?? shiftDayKey(fromDayKey, 13);
    const bad = checkRange(fromDayKey, throughDayKey);
    if (bad) return { ok: false as const, message: bad };
    const { meetings, closed } = meetingRange(cls, fromDayKey, throughDayKey);
    const unit = args.unitId
      ? await unitActivitiesForRoster(
          ctx,
          caller,
          args.unitId,
          args.scholarIds,
          cls.terms.map((term) => term.classId),
          cls.timeZone,
        )
      : null;
    return {
      ok: true as const,
      groupName: group.name,
      subject: cls.subject,
      timeZone: cls.timeZone,
      todayDayKey: cls.todayDayKey,
      fromDayKey,
      throughDayKey,
      meetings: meetings.map((m) => ({
        dayKey: m.dayKey,
        startsAt: m.startsAt,
        endsAt: m.endsAt,
        blockLabel: m.blockLabel,
        started: m.startsAt <= args.now,
      })),
      closed,
      unit: unit
        ? {
            unitTitle: unit.unitTitle,
            assignmentId: unit.assignmentId,
            sharedRunning: unit.sharedRunning,
            activities: unit.activities,
          }
        : null,
    };
  },
});

// ─────────────────────── confirmation (two-phase) ───────────────────────

/** How long a plan can be confirmed. */
export const CLASS_PLAN_TTL_MS = 15 * 60 * 1000;

type PlanTool = "give_class_days" | "move_class_days";

/**
 * Who is asking, where, and in which turn. Set by the surface (the in-app
 * aide: its request time; Slack: the triggering message and its thread),
 * never by the model.
 */
const planScopeValidator = v.object({
  callerUserId: v.id("users"),
  surface: v.union(v.literal("app"), v.literal("slack")),
  slackChannelId: v.optional(v.string()),
  slackThreadTs: v.optional(v.string()),
  turn: v.number(),
});
type PlanScope = {
  callerUserId: Id<"users">;
  surface: "app" | "slack";
  slackChannelId?: string;
  slackThreadTs?: string;
  turn: number;
};

function refuse(reason: string): never {
  throw new Error(`${PLAN_CONFIRMATION_REFUSED} ${reason}`);
}

/** The caller's unused plans for `tool` in this place. */
async function pendingHere(
  ctx: MutationCtx,
  scope: PlanScope,
  tool: PlanTool,
): Promise<Doc<"classPlanConfirmations">[]> {
  const rows = await ctx.db
    .query("classPlanConfirmations")
    .withIndex("by_user_tool", (q) => q.eq("userId", scope.callerUserId).eq("tool", tool))
    .collect();
  return rows.filter(
    (row) =>
      row.usedAt === undefined &&
      row.surface === scope.surface &&
      (scope.surface !== "slack" ||
        (row.slackChannelId === scope.slackChannelId && row.slackThreadTs === scope.slackThreadTs)),
  );
}

/** Store a plan; it replaces an unused one for the same tool in this place.
 *  Also drops this person's used or expired plans for the tool. */
async function storePlan(
  ctx: MutationCtx,
  scope: PlanScope,
  tool: PlanTool,
  args: unknown,
  fingerprint: string,
): Promise<Id<"classPlanConfirmations">> {
  const now = Date.now();
  const mine = await ctx.db
    .query("classPlanConfirmations")
    .withIndex("by_user_tool", (q) => q.eq("userId", scope.callerUserId).eq("tool", tool))
    .collect();
  const here = new Set((await pendingHere(ctx, scope, tool)).map((r) => String(r._id)));
  for (const row of mine) {
    if (here.has(String(row._id)) || row.usedAt !== undefined || row.expiresAt <= now) {
      await ctx.db.delete(row._id);
    }
  }
  return await ctx.db.insert("classPlanConfirmations", {
    userId: scope.callerUserId,
    surface: scope.surface,
    ...(scope.surface === "slack"
      ? { slackChannelId: scope.slackChannelId, slackThreadTs: scope.slackThreadTs }
      : {}),
    tool,
    args: canonicalJson(args),
    fingerprint,
    planTurn: scope.turn,
    createdAt: now,
    expiresAt: now + CLASS_PLAN_TTL_MS,
  });
}

/**
 * The stored plan a commit may write: by its id, or the single unused plan
 * for this tool by this person in this place (Slack rebuilds a thread from
 * its messages, so the id from the plan's tool result is gone by the reply).
 * Refuses unless it is this person's, from this place, unused, unexpired, and
 * planned in an EARLIER turn; with `args`, unless they are the stored ones.
 */
async function claimPlan(
  ctx: MutationCtx,
  scope: PlanScope,
  tool: PlanTool,
  confirmationId: string | undefined,
  args: unknown | undefined,
): Promise<Doc<"classPlanConfirmations">> {
  let row: Doc<"classPlanConfirmations"> | null;
  if (confirmationId) {
    const id = ctx.db.normalizeId("classPlanConfirmations", confirmationId);
    row = id ? await ctx.db.get(id) : null;
    if (!row) refuse("That confirmationId is not one I issued. Plan it again.");
  } else {
    const live = (await pendingHere(ctx, scope, tool)).filter((r) => r.expiresAt > Date.now());
    if (live.length === 0) refuse("Nothing is planned here to confirm. Plan it, show the teacher, and wait for their reply.");
    if (live.length > 1) refuse("More than one plan is waiting here. Plan the one the teacher wants again.");
    row = live[0];
  }
  if (row.userId !== scope.callerUserId || row.surface !== scope.surface) {
    refuse("That plan was made by someone else. Only the teacher who asked for it can confirm it.");
  }
  if (
    scope.surface === "slack" &&
    (row.slackChannelId !== scope.slackChannelId || row.slackThreadTs !== scope.slackThreadTs)
  ) {
    refuse("That plan was made in a different channel or thread. Plan it again here.");
  }
  if (row.tool !== tool) refuse(`That confirmation is for ${row.tool}, not ${tool}.`);
  if (row.usedAt !== undefined) refuse("That plan was already carried out. A confirmation works once.");
  if (row.expiresAt <= Date.now()) refuse("That plan expired. Plan it again and show the teacher.");
  if (scope.turn <= row.planTurn) {
    refuse("The teacher hasn't replied since this plan was made. Show them the plan and wait for their reply.");
  }
  if (args !== undefined && canonicalJson(args) !== row.args) {
    refuse("These aren't the gives that were planned. Plan the new ones and show the teacher before confirming.");
  }
  return row;
}

// ─────────────────────────── give: the plan ───────────────────────────

const giveItemValidator = v.object({
  activityId: v.id("activities"),
  dayKey: v.string(),
  /** Which meeting, by its bell block, on a day the class meets more than once. */
  block: v.optional(v.string()),
  finish: giveFinishValidator,
  /** The teacher asked for this to share a meeting with other work. */
  stack: v.optional(v.boolean()),
});
type GiveItem = {
  activityId: Id<"activities">;
  dayKey: string;
  block?: string;
  finish: GiveFinish;
  stack?: boolean;
};

const givePayloadValidator = v.object({
  groupId: v.id("scholarGroups"),
  subject: v.string(),
  unitId: v.id("units"),
  scholarIds: v.array(v.id("users")),
  items: v.array(giveItemValidator),
});
type GivePayload = {
  groupId: Id<"scholarGroups">;
  subject: string;
  unitId: Id<"units">;
  scholarIds: Id<"users">[];
  items: GiveItem[];
};

export type ClassGiveRow = {
  activityId: Id<"activities">;
  title: string;
  dayKey: string;
  meeting: {
    classId: Id<"classes">;
    startsAt: number;
    endsAt: number;
    blockLabel: string;
  } | null;
  finish: GiveFinish;
  stack: boolean;
  /** Why this row can't be given as asked. Any problem blocks the whole plan. */
  problem: string | null;
  /** This activity already reaches the group; see GivenTo.sameAssignment. */
  alreadyGiven: GivenTo | null;
};

type GivePlan =
  | { ok: false; message: string }
  | {
      ok: true;
      groupName: string;
      subject: string;
      unitTitle: string;
      assignmentId: Id<"assignments"> | null;
      sharedRunning: { otherScholars: number } | null;
      timeZone: string;
      todayDayKey: string;
      rows: ClassGiveRow[];
    };

async function planClassGives(
  ctx: ReadCtx,
  callerUserId: Id<"users">,
  args: GivePayload,
  now: number,
): Promise<GivePlan> {
  const { caller, group } = await requireTeacherForGroup(ctx, callerUserId, args.groupId);
  await requireScholarsAccessible(ctx as QueryCtx, caller, args.scholarIds);
  if (args.items.length === 0) return { ok: false, message: "Nothing to give." };
  const found = await loadClass(ctx, group, args.subject, now);
  if (!found.ok) return found;
  const { cls } = found;
  const days = args.items.map((item) => item.dayKey);
  if (days.some((d) => !DAY_KEY.test(d))) {
    return { ok: false, message: "Days are YYYY-MM-DD." };
  }
  const first = days.reduce((a, b) => (a < b ? a : b));
  const last = days.reduce((a, b) => (a > b ? a : b));
  const bad = checkRange(first, last);
  if (bad) return { ok: false, message: bad };
  const { meetings, closed } = meetingRange(cls, first, last);
  const unit = await unitActivitiesForRoster(
    ctx,
    caller,
    args.unitId,
    args.scholarIds,
    cls.terms.map((term) => term.classId),
    cls.timeZone,
  );
  const byActivity = new Map(unit.activities.map((a) => [String(a.activityId), a]));
  // Re-giving an activity moves its give, so its old meeting isn't held.
  const regiven = new Set(args.items.map((item) => String(item.activityId)));
  const held = unit.held.filter((h) => !regiven.has(String(h.activityId)));
  const seen = new Set<string>();
  const taken = new Map<number, string>();
  const rows: ClassGiveRow[] = args.items.map((item) => {
    const act = byActivity.get(String(item.activityId));
    const onDay = meetings.filter((m) => m.dayKey === item.dayKey);
    const block = item.block?.trim().toLowerCase();
    const meeting =
      (block ? onDay.find((m) => m.blockLabel.toLowerCase() === block) : onDay.length === 1 ? onDay[0] : null) ?? null;
    const closure = closed.find((c) => c.dayKey === item.dayKey);
    const heldHere = meeting
      ? held.find(
          (h) =>
            h.startsAt === meeting.startsAt ||
            (h.dayKey === meeting.dayKey && !meetings.some((m) => m.startsAt === h.startsAt)),
        )
      : undefined;
    let problem: string | null = null;
    if (!act) {
      problem = `Not an activity of ${unit.unitTitle}.`;
    } else if (seen.has(String(item.activityId))) {
      problem = "This activity is in the plan twice; give it on one day.";
    } else if (closure) {
      problem = `No school that day (${closure.label}).`;
    } else if (onDay.length === 0) {
      problem = `${cls.subject} doesn't meet that day.`;
    } else if (!meeting) {
      problem = block
        ? `${cls.subject} has no ${item.block} meeting that day (${onDay.map((m) => m.blockLabel).join(", ")}).`
        : `${cls.subject} meets ${onDay.length} times that day (${onDay.map((m) => m.blockLabel).join(", ")}); say which block.`;
    } else if (meeting.startsAt <= now) {
      problem = "That class has already started; use give for now, or pick a later meeting.";
    } else if (
      (item.finish.kind === "by" || item.finish.kind === "openUntil") &&
      item.finish.dayKey < item.dayKey
    ) {
      problem = `It would finish (${item.finish.dayKey}) before it shows up.`;
    } else if (item.finish.kind === "endOfUnit") {
      // Each give of the plan would read "the end of the unit" before the
      // later ones exist, so the plan names the day instead.
      problem = "Name the day it's due (finish 'YYYY-MM-DD'); end of unit isn't settled until the whole plan is given.";
    } else if (item.finish.kind === "openUntil" && item.finish.dayKey === item.dayKey) {
      problem = "Open-until must be after the day it shows up; use in class instead.";
    } else if (!item.stack && taken.has(meeting.startsAt)) {
      problem = `That meeting already has ${taken.get(meeting.startsAt)} in this plan. Pick another meeting, or ask the teacher whether both go in it (stack).`;
    } else if (!item.stack && heldHere) {
      problem = `That meeting already holds ${heldHere.title} from this unit. Pick another meeting, or ask the teacher whether both go in it (stack).`;
    }
    seen.add(String(item.activityId));
    if (meeting && !taken.has(meeting.startsAt)) taken.set(meeting.startsAt, act?.title ?? "another activity");
    return {
      activityId: item.activityId,
      title: act?.title ?? "(not in this unit)",
      dayKey: item.dayKey,
      meeting: meeting
        ? {
            classId: meeting.classId,
            startsAt: meeting.startsAt,
            endsAt: meeting.endsAt,
            blockLabel: meeting.blockLabel,
          }
        : null,
      finish: item.finish,
      stack: item.stack === true,
      problem,
      alreadyGiven: act?.given ?? null,
    };
  });
  return {
    ok: true,
    groupName: group.name,
    subject: cls.subject,
    unitTitle: unit.unitTitle,
    assignmentId: unit.assignmentId,
    sharedRunning: unit.sharedRunning,
    timeZone: cls.timeZone,
    todayDayKey: cls.todayDayKey,
    rows,
  };
}

/** What a give plan commits to: each row's activity, meeting and finish, and
 *  the assignment it goes to. A commit refuses if this changed. */
function giveFingerprint(plan: Extract<GivePlan, { ok: true }>): string {
  return canonicalJson({
    assignmentId: plan.assignmentId,
    rows: plan.rows.map((r) => ({
      activityId: r.activityId,
      startsAt: r.meeting?.startsAt ?? null,
      classId: r.meeting?.classId ?? null,
      finish: r.finish,
      stack: r.stack,
    })),
  });
}

function problemsMessage(rows: Array<{ title: string; dayKey: string; problem: string | null }>): string {
  return rows
    .filter((r) => r.problem)
    .map((r) => `${r.title} on ${r.dayKey}: ${r.problem}`)
    .join(" · ");
}

/**
 * Phase one: compute the plan, and when it has no problem, store it for the
 * teacher to confirm. Writes no give.
 */
export const planClassGivesWrite = internalMutation({
  args: { scope: planScopeValidator, payload: givePayloadValidator },
  handler: async (ctx, { scope, payload }) => {
    const plan = await planClassGives(ctx, scope.callerUserId, payload, Date.now());
    if (!plan.ok) return { plan, confirmationId: null };
    const blocked = plan.rows.some((r) => r.problem);
    const confirmationId = blocked
      ? null
      : await storePlan(ctx, scope, "give_class_days", payload, giveFingerprint(plan));
    return { plan, confirmationId };
  },
});

/** The class link and window a write left on a give, read back. */
async function storedLink(
  ctx: MutationCtx,
  assignmentId: Id<"assignments">,
  activityId: Id<"activities">,
  timeZone: string,
): Promise<{
  classId: Id<"classes"> | null;
  dayKey: string | null;
  live: boolean;
  startsAt: number | null;
  endsAt: number | null;
  openUntilDayKey: string | null;
} | null> {
  const rows = await ctx.db
    .query("pushes")
    .withIndex("by_assignment_cleared", (q) =>
      q.eq("assignmentId", assignmentId).eq("clearedAt", undefined),
    )
    .collect();
  const row = rows.find(
    (r) =>
      isScheduleRow(r) &&
      r.target.kind === "activity" &&
      r.target.activityId === activityId,
  );
  if (!row) return null;
  const closesAt = openUntilClosesAt(
    { ...row, mode: pushLane(row), openUntilKind: isOpenUntilKind(row) },
    timeZone,
  );
  return {
    classId: row.classId ?? null,
    dayKey: row.dayKey ?? null,
    live: row.setAt !== undefined,
    startsAt: row.startsAt ?? null,
    endsAt: row.endsAt ?? null,
    openUntilDayKey: closesAt != null ? openUntilDayKey(closesAt, timeZone) : null,
  };
}

/**
 * Phase two: give exactly the stored plan, one coreAssignWork per row, in
 * this one transaction, so it lands whole or not at all. Refuses (writes
 * nothing) on a failed confirmation check, or when the plan recomputed now
 * has a problem or differs from the one the teacher saw.
 */
export const commitClassGives = internalMutation({
  args: {
    scope: planScopeValidator,
    confirmationId: v.optional(v.string()),
    /** The gives the model sent with its confirmation, if any: refused unless
     *  they are the stored ones. */
    payload: v.optional(givePayloadValidator),
  },
  handler: async (ctx, { scope, confirmationId, payload }) => {
    const stored = await claimPlan(ctx, scope, "give_class_days", confirmationId, payload);
    const args = JSON.parse(stored.args) as GivePayload;
    const plan = await planClassGives(ctx, scope.callerUserId, args, Date.now());
    if (!plan.ok) throw new Error(`Nothing given. ${plan.message}`);
    const blocked = problemsMessage(plan.rows);
    if (blocked) throw new Error(`Nothing given. ${blocked}`);
    if (giveFingerprint(plan) !== stored.fingerprint) {
      refuse("The class's schedule changed since this plan was shown. Plan it again and show the teacher.");
    }
    await ctx.db.patch(stored._id, { usedAt: Date.now() });
    let assignmentId: Id<"assignments"> | null = null;
    let created = false;
    for (const row of plan.rows) {
      const res = await coreAssignWork(ctx, {
        teacherId: scope.callerUserId,
        unitId: args.unitId,
        scholarIds: args.scholarIds,
        startsAt: row.meeting!.startsAt,
        target: { kind: "activity", activityId: row.activityId },
        finish: row.finish,
      });
      assignmentId = res.assignmentId;
      created ||= res.created;
    }
    const given = [];
    for (const row of plan.rows) {
      const link = await storedLink(ctx, assignmentId!, row.activityId, plan.timeZone);
      given.push({
        activityId: row.activityId,
        title: row.title,
        dayKey: row.dayKey,
        blockLabel: row.meeting!.blockLabel,
        startsAt: row.meeting!.startsAt,
        finish: row.finish,
        live: link?.live ?? false,
        endsAt: link?.endsAt ?? null,
        openUntilDayKey: link?.openUntilDayKey ?? null,
        // The class link the schedule store derived from the start time.
        linkedToClass:
          link?.classId != null &&
          link.classId === row.meeting!.classId &&
          link.dayKey === (finishIsHomework(row.finish) ? null : row.dayKey),
      });
    }
    return {
      assignmentId: assignmentId!,
      created,
      sharedRunning: plan.sharedRunning,
      groupName: plan.groupName,
      subject: plan.subject,
      unitTitle: plan.unitTitle,
      timeZone: plan.timeZone,
      todayDayKey: plan.todayDayKey,
      given,
    };
  },
});

// ─────────────────────────── move: the plan ───────────────────────────

export type ClassMoveRow = {
  pushId: Id<"pushes">;
  assignmentId: Id<"assignments">;
  activityId: Id<"activities">;
  title: string;
  fromDayKey: string;
  homework: boolean;
  to: { dayKey: string; startsAt: number; blockLabel: string } | null;
  problem: string | null;
};

type MovePlan =
  | { ok: false; message: string }
  | {
      ok: true;
      groupName: string;
      subject: string;
      timeZone: string;
      todayDayKey: string;
      rows: ClassMoveRow[];
      /** Gives in the range that stay put, and why. */
      leftAlone: Array<{ title: string; dayKey: string; reason: string }>;
    };

const movePayloadValidator = v.object({
  groupId: v.id("scholarGroups"),
  subject: v.string(),
  fromDayKey: v.string(),
  throughDayKey: v.string(),
  byMeetings: v.number(),
  /** The teacher asked for moved work to share a meeting with other work. */
  stack: v.optional(v.boolean()),
});
type MovePayload = {
  groupId: Id<"scholarGroups">;
  subject: string;
  fromDayKey: string;
  throughDayKey: string;
  byMeetings: number;
  stack?: boolean;
};

/** How far past the range a move may look for its new meetings. */
const MOVE_LOOKAROUND_DAYS = 42;

/** The class's open schedule gives from `from` through `through`: those on a
 *  class day, and homework (linked to the class, no day) starting in range.
 *  Work of another subject drawn in this class's slot is filed under its own
 *  class: `slotGivesForClass` finds it. */
async function classGives(
  ctx: ReadCtx,
  classIds: readonly Id<"classes">[],
  from: string,
  through: string,
  timeZone: string,
): Promise<Doc<"pushes">[]> {
  const out: Doc<"pushes">[] = [];
  for (const classId of classIds) {
    out.push(
      ...(await ctx.db
        .query("pushes")
        .withIndex("by_class_day", (q) => q.eq("classId", classId).gte("dayKey", from).lte("dayKey", through))
        .collect()),
    );
    const homework = await ctx.db
      .query("pushes")
      .withIndex("by_class_day", (q) => q.eq("classId", classId).eq("dayKey", undefined))
      .collect();
    out.push(
      ...homework.filter((p) => {
        const day = pushDayKey(p, timeZone);
        return day >= from && day <= through;
      }),
    );
  }
  return out.filter(
    (p) => p.clearedAt === undefined && isScheduleRow(p) && p.target.kind === "activity" && p.assignmentId,
  );
}

/**
 * This teacher's open schedule gives that reach the group but carry no class
 * link, starting from `from` through `through`. The schedule store leaves a
 * give unlinked when it can't name one class meeting: a day the class meets
 * twice (lib/classLink classMeetingForGive), or homework given outside a
 * meeting. A move can't place them by class meeting, so it lists them and
 * treats their meetings as taken.
 */
async function unlinkedGivesForGroup(
  ctx: ReadCtx,
  callerUserId: Id<"users">,
  group: Doc<"scholarGroups">,
  from: string,
  through: string,
  timeZone: string,
): Promise<Doc<"pushes">[]> {
  const members = new Set(group.scholarIds.map(String));
  const assignments = (
    await ctx.db
      .query("assignments")
      .withIndex("by_teacher", (q) => q.eq("teacherId", callerUserId))
      .collect()
  ).filter((a) => !a.archivedAt && a.scholarIds.some((id) => members.has(String(id))));
  const rosters = new Map<string, Promise<readonly Id<"users">[]>>();
  const out: Doc<"pushes">[] = [];
  for (const a of assignments) {
    const open = await ctx.db
      .query("pushes")
      .withIndex("by_assignment_cleared", (q) => q.eq("assignmentId", a._id).eq("clearedAt", undefined))
      .collect();
    for (const p of open) {
      if (p.classId !== undefined || !isScheduleRow(p) || p.target.kind !== "activity") continue;
      const day = pushDayKey(p, timeZone);
      if (day < from || day > through) continue;
      if (await reachesMembers(ctx, p, members, rosters)) out.push(p);
    }
  }
  return out;
}

/**
 * Open schedule gives filed under ANOTHER class but drawn in one of this
 * class's meetings: work of another subject a teacher scheduled into this
 * class's slot (TRA-725; lib/gridGives `meetingHolding`). Each with the start
 * of the meeting it sits in, so a move treats that meeting as taken.
 */
async function slotGivesForClass(
  ctx: ReadCtx,
  classIds: readonly Id<"classes">[],
  group: Doc<"scholarGroups">,
  meetings: ReadonlyArray<{ dayKey: string; startsAt: number; endsAt: number }>,
  from: string,
  through: string,
): Promise<Map<string, { push: Doc<"pushes">; meetingStartsAt: number }>> {
  const out = new Map<string, { push: Doc<"pushes">; meetingStartsAt: number }>();
  const ownClasses = (await Promise.all(classIds.map((id) => ctx.db.get(id))))
    .filter((c): c is Doc<"classes"> => c !== null);
  if (ownClasses.length === 0) return out;
  const own = new Set(classIds.map(String));
  const periods = new Set(ownClasses.map((c) => String(c.periodId)));
  const members = new Set(group.scholarIds.map(String));
  const rosters = new Map<string, Promise<readonly Id<"users">[]>>();
  // The school's other classes in these terms (a few dozen), and each one's
  // gives on the days being planned: one class-day index range per class.
  const others = (await ctx.db
    .query("classes")
    .withIndex("by_institution", (q) => q.eq("institutionId", ownClasses[0].institutionId))
    .collect())
    .filter((c) => !own.has(String(c._id)) && periods.has(String(c.periodId)));
  const gives = (await Promise.all(others.map((c) =>
    ctx.db
      .query("pushes")
      .withIndex("by_class_day", (q) =>
        q.eq("classId", c._id).gte("dayKey", from).lte("dayKey", through))
      .collect()))).flat();
  for (const p of gives) {
    if (p.clearedAt !== undefined || !isScheduleRow(p) || p.target.kind !== "activity" ||
      p.dayKey === undefined) continue;
    const day = p.dayKey;
    const slot = meetingHolding(p, meetings.filter((m) => m.dayKey === day));
    if (!slot || !(await reachesMembers(ctx, p, members, rosters))) continue;
    out.set(String(p._id), { push: p, meetingStartsAt: slot.startsAt });
  }
  return out;
}

async function planClassMove(
  ctx: ReadCtx,
  callerUserId: Id<"users">,
  args: MovePayload,
  now: number,
): Promise<MovePlan> {
  const { group } = await requireTeacherForGroup(ctx, callerUserId, args.groupId);
  if (!Number.isInteger(args.byMeetings) || args.byMeetings === 0) {
    return { ok: false, message: "byMeetings is a whole number of class meetings, not 0." };
  }
  const bad = checkRange(args.fromDayKey, args.throughDayKey);
  if (bad) return { ok: false, message: bad };
  const found = await loadClass(ctx, group, args.subject, now);
  if (!found.ok) return found;
  const { cls } = found;
  const classIds = cls.terms.map((t) => t.classId);
  // The meetings around the range, so a give can land outside it.
  const windowFrom = shiftDayKey(args.fromDayKey, -MOVE_LOOKAROUND_DAYS);
  const windowThrough = shiftDayKey(args.throughDayKey, MOVE_LOOKAROUND_DAYS);
  const { meetings } = classMeetingDays({
    terms: cls.terms,
    closures: cls.closures,
    fromDayKey: windowFrom,
    throughDayKey: windowThrough,
    timeZone: cls.timeZone,
  });
  const rows: ClassMoveRow[] = [];
  const leftAlone: Array<{ title: string; dayKey: string; reason: string }> = [];
  const titles = new Map<string, string>();
  const titleOf = async (id: Id<"activities">) => {
    if (!titles.has(String(id))) {
      titles.set(String(id), (await ctx.db.get(id))?.title ?? "(deleted activity)");
    }
    return titles.get(String(id))!;
  };
  for (const push of await classGives(ctx, classIds, args.fromDayKey, args.throughDayKey, cls.timeZone)) {
    const activityId = (push.target as { activityId: Id<"activities"> }).activityId;
    const title = await titleOf(activityId);
    const dayKey = pushDayKey(push, cls.timeZone);
    const homework = push.timing.kind === "homework";
    const assignment = await ctx.db.get(push.assignmentId!);
    if (!assignment || assignment.teacherId !== callerUserId) {
      leftAlone.push({ title, dayKey, reason: "another teacher gave it" });
      continue;
    }
    if (push.setAt !== undefined) {
      leftAlone.push({ title, dayKey, reason: "already live" });
      continue;
    }
    const old = meetings.find((m) => m.startsAt === push.startsAt);
    // A planned in-class give ends with its new meeting when it moves
    // (applyRescheduleActivity re-reads the bell). One whose end is not its
    // own meeting's end (open until a day) would lose that answer.
    if (!homework && !old) {
      // Filed under the class by its subject, given outside its meetings
      // (TRA-725): no meeting to step from.
      leftAlone.push({ title, dayKey, reason: "not tied to one class meeting; move it on its own" });
      continue;
    }
    if (!homework && old && push.endsAt !== old.endsAt) {
      leftAlone.push({ title, dayKey, reason: "its finish isn't the end of that class; move it with give" });
      continue;
    }
    const to = shiftMeeting(meetings, { dayKey, startsAt: push.startsAt }, args.byMeetings);
    let problem: string | null = null;
    if (!to) problem = "no class meeting that far out on the schedule";
    else if (to.startsAt <= now) problem = "that meeting has already started";
    else if (homework && push.endsAt != null && to.startsAt > push.endsAt) {
      problem = "it would show up after it's due; change the due date with give";
    }
    rows.push({
      pushId: push._id,
      assignmentId: push.assignmentId!,
      activityId,
      title,
      fromDayKey: dayKey,
      homework,
      to: to ? { dayKey: to.dayKey, startsAt: to.startsAt, blockLabel: to.blockLabel } : null,
      problem,
    });
  }
  // Gives that reach the group with no class link stay put (a move can't
  // place them by meeting), and are listed so the teacher knows.
  const unlinked = await unlinkedGivesForGroup(
    ctx, callerUserId, group, windowFrom, windowThrough, cls.timeZone,
  );
  for (const p of unlinked) {
    const dayKey = pushDayKey(p, cls.timeZone);
    if (dayKey < args.fromDayKey || dayKey > args.throughDayKey) continue;
    leftAlone.push({
      title: await titleOf((p.target as { activityId: Id<"activities"> }).activityId),
      dayKey,
      reason: "not tied to one class meeting; move it on its own",
    });
  }
  // A target meeting must be free of work that isn't moving with the run,
  // linked to the class or not, including another subject's work drawn in
  // its slot.
  if (!args.stack) {
    const moving = new Set(rows.map((r) => String(r.pushId)));
    const slotted = await slotGivesForClass(
      ctx, classIds, group, meetings, windowFrom, windowThrough,
    );
    const staying = [
      ...(await classGives(ctx, classIds, windowFrom, windowThrough, cls.timeZone)),
      ...unlinked,
      ...[...slotted.values()].map((s) => s.push),
    ].filter((p) => !moving.has(String(p._id)));
    for (const row of rows) {
      if (row.problem || !row.to) continue;
      const there = staying.find(
        (p) =>
          p.startsAt === row.to!.startsAt ||
          slotted.get(String(p._id))?.meetingStartsAt === row.to!.startsAt ||
          (p.setAt !== undefined && pushDayKey(p, cls.timeZone) === row.to!.dayKey),
      );
      if (there) {
        row.problem = `${row.to.dayKey} already has ${await titleOf((there.target as { activityId: Id<"activities"> }).activityId)}; ask the teacher whether both go in that meeting (stack)`;
      }
    }
  }
  rows.sort((a, b) => a.fromDayKey.localeCompare(b.fromDayKey));
  return {
    ok: true,
    groupName: group.name,
    subject: cls.subject,
    timeZone: cls.timeZone,
    todayDayKey: cls.todayDayKey,
    rows,
    leftAlone,
  };
}

function moveFingerprint(plan: Extract<MovePlan, { ok: true }>): string {
  return canonicalJson(plan.rows.map((r) => ({ pushId: r.pushId, to: r.to?.startsAt ?? null })));
}

/** Phase one of a move: compute it, and when it can be made, store it for
 *  the teacher to confirm. Moves nothing. */
export const planClassMoveWrite = internalMutation({
  args: { scope: planScopeValidator, payload: movePayloadValidator },
  handler: async (ctx, { scope, payload }) => {
    const plan = await planClassMove(ctx, scope.callerUserId, payload, Date.now());
    if (!plan.ok) return { plan, confirmationId: null };
    const blocked = plan.rows.length === 0 || plan.rows.some((r) => r.problem);
    const confirmationId = blocked
      ? null
      : await storePlan(ctx, scope, "move_class_days", payload, moveFingerprint(plan));
    return { plan, confirmationId };
  },
});

/** Phase two: move exactly the stored plan, one coreAideRescheduleActivity
 *  per row, in this one transaction; all or nothing. */
export const commitClassMove = internalMutation({
  args: {
    scope: planScopeValidator,
    confirmationId: v.optional(v.string()),
    payload: v.optional(movePayloadValidator),
  },
  handler: async (ctx, { scope, confirmationId, payload }) => {
    const stored = await claimPlan(ctx, scope, "move_class_days", confirmationId, payload);
    const args = JSON.parse(stored.args) as MovePayload;
    const plan = await planClassMove(ctx, scope.callerUserId, args, Date.now());
    if (!plan.ok) throw new Error(`Nothing moved. ${plan.message}`);
    const blocked = problemsMessage(
      plan.rows.map((r) => ({ title: r.title, dayKey: r.fromDayKey, problem: r.problem })),
    );
    if (blocked) throw new Error(`Nothing moved. ${blocked}`);
    if (moveFingerprint(plan) !== stored.fingerprint) {
      refuse("The class's schedule changed since this move was shown. Plan it again and show the teacher.");
    }
    await ctx.db.patch(stored._id, { usedAt: Date.now() });
    for (const row of plan.rows) {
      const res = await coreAideRescheduleActivity(ctx, scope.callerUserId, {
        assignmentId: row.assignmentId,
        activityId: row.activityId,
        startsAt: row.to!.startsAt,
      });
      // A miss means the give changed under us; throwing undoes every move.
      if (!res.found) throw new Error(`Nothing moved. ${row.title} is no longer planned there.`);
    }
    const moved = [];
    for (const row of plan.rows) {
      const link = await storedLink(ctx, row.assignmentId, row.activityId, plan.timeZone);
      moved.push({
        title: row.title,
        fromDayKey: row.fromDayKey,
        toDayKey: row.to!.dayKey,
        blockLabel: row.to!.blockLabel,
        homework: row.homework,
        endsAt: link?.endsAt ?? null,
        // Homework links to the class but not a day; in-class work to both.
        linked: row.homework ? link?.startsAt === row.to!.startsAt : link?.dayKey === row.to!.dayKey,
      });
    }
    return { ...plan, moved };
  },
});
