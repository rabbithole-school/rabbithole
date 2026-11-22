import { ConvexError, v } from "convex/values";
import { talkLevelOf } from "./lib/readingLevels";
import {
  audienceGroupIds, classFieldsForPush, classMeetingForGive, invalidateClassLinkClasses,
  loadClassLinkData, syncClassesForPlacements, unitSubjectForWork, type ClassLinkReadCache,
} from "./lib/classLink";
import { decidingEntryByActivity } from "./lib/homeOrigin";
import { publishUnitOnAssign } from "./lib/unitPublication";
import {
  NOTHING_TO_OPEN_REFUSAL,
  appActivityHasNothingToOpen,
} from "./lib/appActivity";
import { requireUnitAccessForUser } from "./lib/unitAccess";
import { internalMutation, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";
import {
  authedMutation,
  authedQuery,
  curriculumRunMutation,
  curriculumRunQuery,
  teacherMutation,
  teacherQuery,
} from "./lib/customFunctions";
import {
  canRunAssignments,
  curriculumRunInstitutionIds,
  requireCanRunOwnedAssignment,
  requireRunnableUnit,
  requireScholarsAtInstitution,
  runnerAssignableScholars,
} from "./lib/curriculumRun";
import { ROLES, isTeacherRole } from "./lib/roles";
import {
  assignmentAdminScope,
  mayActOnAssignment,
} from "./lib/assignmentAuthority";
import {
  firstClassIdByWork,
  scheduleWorkKey as giveWorkKey,
} from "./lib/homeworkSubject";
import {
  anyScheduleReferencesActivity,
  loadScheduleRows,
  readSchedule,
  writeSchedule,
  type ScheduleCache,
  type ScheduleReadCtx,
} from "./lib/scheduleStore";
import { resolveActivityWebTarget } from "./lib/webActivityTarget";
import {
  effectiveInstitutionTimeZone,
  institutionDayForRequest,
  timeZoneForInstitution,
  timeZoneForScholar,
  timeZoneForStaff,
} from "./lib/institutionTime";
import { closuresForInstitution, hasUsableDays } from "./academicCalendar";
import { closuresInWeekOf } from "../shared/homeworkWeek";
import { ONBOARDING_UNIT_SLUG } from "./onboardingData";
import {
  DEFAULT_TIMEZONE,
  dayKeyForTimezone,
  shiftDayKey,
  weekdayForDayKey,
} from "../shared/institutionDay";
import { isFocusShowing, isScheduleEntryActive } from "../shared/focusShowing";
import { subjectMatches, uniqueSubjects } from "../lib/subjects";
import { unitSubjectFitsClass } from "./lib/classResolver";
import { youtubeVideoId } from "../shared/activityResourceEmbed";
import { addUrlResource } from "./activityResources";
import { getGame } from "../lib/games/catalog";
import { isScholarHomeworkMark } from "./lib/activityCompletionCore";
import type { Id, Doc } from "./_generated/dataModel";
import type { QueryCtx, MutationCtx } from "./_generated/server";
import {
  requireActiveScholarAccess,
  requireScholarsAccessible,
  filterToAccessibleScholars,
  resolveActiveMembership,
} from "./lib/access";
import { questionRowForSeed } from "./lib/questionQueue";
import { liveQuestionHomework } from "./lib/questionHomework";
import {
  hasScholarMembership,
  requireActiveLearnerInstitution,
  scholarInstitutionId,
} from "./lib/scholarEnrollment";
import { PRACTICE_DOMAINS } from "./lib/practice/domains";
import { scheduleProblemSetItemGeneration } from "./practiceSkills";
import {
  requireUnitEditAccess,
} from "./lib/auth";
import { hasCurriculumAccessForInstitution } from "./lib/curriculumAccess";
import {
  publishableProgramGroups,
  requireProgramPublishAccess,
} from "./lib/programGroupAccess";
import {
  hasReadableOfflineHomeworkContent,
  resolveReachableActivityResources,
} from "./lib/activityResourceReachability";
import { extendedEducationTag } from "./lib/scholarParticipationTooling";
import {
  nextOpenSchoolDayEndAt,
  nextOpenSchoolDayKeys as findNextOpenSchoolDayKeys,
  schoolDayEndAt,
} from "./lib/schoolDays";
import {
  buildComingUpGroups,
  type ComingUpPlanned,
} from "../shared/comingUp";
import { effectiveActivityKind } from "../shared/appSurface";
import { isOpenUntil } from "../shared/openUntil";
import {
  GiveQuestionError,
  giveChoices as giveChoicesFor,
  finishIsHomework,
  giveFinishValidator,
  resolveGiveWindow,
  type GiveFinish,
  type GiveWindow,
} from "./lib/giveWindow";
import { MISSING_FINISH_QUESTION } from "./lib/giveQuestions";
import { matchByName } from "./lib/nameMatch";

/**
 * Assignments — execution instances of a Unit.
 *
 * An Assignment is one cohort × one Unit × one teacher. Every
 * execution-side row (projects, deliverables, completions, share-back
 * digests) stamps `assignmentId` so the same Unit can be run multiple
 * times without anyone's work blending across cohorts.
 *
 * Per-activity scheduling lives in `activitySchedule` — each entry is
 * a single activity being pushed as class focus (in the room right
 * now) or homework (on their plate to finish). Both modes can coexist
 * across activities within one Assignment (the unit might have lesson 1
 * in-class and lesson 2 as homework). An activity can only appear once
 * per assignment; flipping mode updates the existing entry.
 *
 * See review/design-vs-execution-split.md.
 */

// ─── Internal helpers ────────────────────────────────────────────────

export function targetsScholar(
  assignment: Doc<"assignments">,
  scholarId: Id<"users">,
): boolean {
  return assignment.scholarIds.some((id) => id === scholarId);
}

import type { ScheduleEntry } from "./lib/pushes";
import { assertProposedQuestRecipients } from "./lib/questStructure";

async function homeworkCalendarForRoster(
  ctx: QueryCtx,
  scholarIds: readonly Id<"users">[],
  institutionHint?: Id<"institutions">,
  classLinkCache?: ClassLinkReadCache,
): Promise<{
  institutionId: Id<"institutions"> | undefined;
  timeZone: string;
}> {
  if (institutionHint) {
    return {
      institutionId: institutionHint,
      timeZone: classLinkCache
        ? (await loadClassLinkData(ctx, institutionHint, classLinkCache)).timeZone
        : await timeZoneForInstitution(ctx, institutionHint),
    };
  }
  const scholars = await Promise.all(scholarIds.map((id) => ctx.db.get(id)));
  if (scholars.some((scholar) => !scholar)) {
    throw new Error("Homework roster includes an unknown scholar.");
  }
  const institutionKeys = new Set(
    scholars.map((scholar) => String(scholar!.institutionId ?? "legacy")),
  );
  if (institutionKeys.size > 1) {
    throw new Error("Homework rosters must belong to one institution.");
  }
  const institutionId = scholars[0]?.institutionId;
  return {
    institutionId,
    timeZone: classLinkCache
      ? (await loadClassLinkData(ctx, institutionId, classLinkCache)).timeZone
      : await timeZoneForInstitution(ctx, institutionId),
  };
}

async function homeworkDueDateOptionsForRoster(
  ctx: QueryCtx,
  scholarIds: readonly Id<"users">[],
  nowMs: number,
  institutionHint?: Id<"institutions">,
) {
  const { institutionId, timeZone } = await homeworkCalendarForRoster(
    ctx,
    scholarIds,
    institutionHint,
  );
  const todayKey = dayKeyForTimezone(nowMs, timeZone);
  const nextOpen = await nextOpenSchoolDayEndAt(
    ctx,
    institutionId,
    nowMs,
    timeZone,
  );
  const nextDayKey = shiftDayKey(todayKey, 1);
  const weekdayName = new Intl.DateTimeFormat("en-US", {
    weekday: "long",
    timeZone: "UTC",
  }).format(new Date(`${nextOpen.dayKey}T12:00:00.000Z`));
  const todayWeekday = weekdayForDayKey(todayKey);
  const daysUntilFriday =
    todayWeekday <= 5 ? 5 - todayWeekday : 12 - todayWeekday;
  const endOfWeekDayKey = shiftDayKey(todayKey, daysUntilFriday);

  return {
    timeZone,
    nextOpen: {
      ...nextOpen,
      label:
        nextOpen.dayKey === nextDayKey
          ? "Tomorrow — next open school day"
          : `${weekdayName} — next open school day`,
    },
    endOfWeek: {
      dayKey: endOfWeekDayKey,
      dueAt: schoolDayEndAt(endOfWeekDayKey, timeZone),
    },
  };
}

async function homeworkInstitutionForAssignment(
  ctx: QueryCtx,
  assignment: Doc<"assignments">,
): Promise<Id<"institutions"> | undefined> {
  if (assignment.scholarGroupId) {
    const group = await ctx.db.get(assignment.scholarGroupId);
    if (group?.institutionId) return group.institutionId;
  }
  if (assignment.unitId) {
    const unit = await ctx.db.get(assignment.unitId);
    if (unit?.institutionId) return unit.institutionId;
  }
  const teacher = await ctx.db.get(assignment.teacherId);
  return teacher
    ? (await resolveActiveMembership(ctx, teacher))?.institutionId
    : undefined;
}

/**
 * Live give counts for a teacher's chips, worded by finish (TRA-722): an
 * open-until give is stored as class focus but counted on its own, read with
 * the same `isOpenUntilEntry` rule every other surface uses. Reads no clock.
 */
async function liveGiveCounts(
  ctx: QueryCtx,
  assignment: Doc<"assignments">,
  entries: readonly Pick<ScheduleEntry, "mode" | "setAt" | "startsAt" | "endsAt" | "openUntilKind">[],
  classLinkCache: ClassLinkReadCache,
): Promise<{ classFocusCount: number; openUntilCount: number; homeworkCount: number }> {
  let classFocusCount = 0;
  let openUntilCount = 0;
  let homeworkCount = 0;
  for (const e of entries) {
    if (e.mode === "homework") homeworkCount++;
    else if (await isOpenUntilEntry(ctx, assignment, e, classLinkCache)) openUntilCount++;
    else classFocusCount++;
  }
  return { classFocusCount, openUntilCount, homeworkCount };
}

/**
 * Is this class focus "open until a date" (shared/openUntil.ts), read in the
 * assignment's own school time zone?
 */
async function isOpenUntilEntry(
  ctx: QueryCtx,
  assignment: Doc<"assignments">,
  entry: Pick<ScheduleEntry, "mode" | "setAt" | "startsAt" | "endsAt" | "openUntilKind">,
  classLinkCache?: ClassLinkReadCache,
): Promise<boolean> {
  if (entry.mode !== "classFocus" || entry.endsAt == null) return false;
  return isOpenUntil(
    entry,
    await timeZoneForAssignment(ctx, assignment, classLinkCache),
  );
}

/**
 * The give's own school time zone: where the teacher set its closing day.
 * The ONE zone every write path reads a give's open-until window in (giving
 * it, opening its offline page, marking it done).
 */
export async function timeZoneForAssignment(
  ctx: QueryCtx,
  assignment: Doc<"assignments">,
  classLinkCache?: ClassLinkReadCache,
): Promise<string> {
  const institutionId = await homeworkInstitutionForAssignment(ctx, assignment);
  return classLinkCache
    ? (await loadClassLinkData(ctx, institutionId, classLinkCache)).timeZone
    : await timeZoneForInstitution(ctx, institutionId);
}

/**
 * Queue the clear for a timed class focus at its `endsAt`, returning the job
 * (undefined when none is due). Open-until work is
 * never cleared: its entry outlives the close so the Run page can say
 * "Closed Sat · N of M finished" and the parent plan keeps it in its week.
 * Every reader closes it on `endsAt` at read time, so the scholar's list
 * still drops it on time. `autoClearActivity` re-checks, for jobs queued
 * before an entry became open-until.
 */
async function armFocusAutoClear(
  ctx: MutationCtx,
  assignment: Doc<"assignments">,
  activityId: Id<"activities">,
  entry: Pick<ScheduleEntry, "mode" | "setAt" | "startsAt" | "endsAt" | "openUntilKind">,
  classLinkCache?: ClassLinkReadCache,
): Promise<Id<"_scheduled_functions"> | undefined> {
  if (entry.mode !== "classFocus" || entry.endsAt == null) return undefined;
  if (entry.endsAt <= Date.now()) return undefined;
  if (await isOpenUntilEntry(ctx, assignment, entry, classLinkCache)) return undefined;
  // Armed for this live occurrence (its `setAt`); the caller stores the
  // handle on the row so clear, archive and a re-time can cancel it.
  return await ctx.scheduler.runAt(
    entry.endsAt,
    internal.assignments.autoClearActivity,
    { assignmentId: assignment._id, activityId, armedSetAt: entry.setAt },
  );
}

export function entryTargetsScholar(
  entry: ScheduleEntry,
  scholarId: Id<"users">,
): boolean {
  return (
    entry.scholarIds == null ||
    entry.scholarIds.length === 0 ||
    entry.scholarIds.some((id) => id === scholarId)
  );
}

function scheduleWorkKey(
  assignmentId: Id<"assignments">,
  activityId: Id<"activities">,
): string {
  return `${assignmentId}::${activityId}`;
}

export type ScholarTimetableContext = {
  periodId: Id<"reportingPeriods"> | null;
  groupIds: Id<"scholarGroups">[];
  placements: Doc<"schedulePlacements">[];
  subjectTabs: string[];
  subjectByWork: Map<string, string>;
};

/**
 * The scholar's current timetable vocabulary and placement join. Current-term
 * resolution is status-based so this reactive helper never makes a stale
 * wall-clock decision; term status changes re-arm every consumer.
 */
export async function scholarTimetableContext(
  ctx: QueryCtx,
  scholar: Doc<"users">,
): Promise<ScholarTimetableContext> {
  const allGroups = await ctx.db.query("scholarGroups").collect();
  const groups = allGroups.filter((group) =>
    group.scholarIds.includes(scholar._id),
  );
  const groupIds = groups.map((group) => group._id);
  if (groupIds.length === 0) {
    return {
      periodId: null,
      groupIds,
      placements: [],
      subjectTabs: [],
      subjectByWork: new Map(),
    };
  }

  const periods = await ctx.db.query("reportingPeriods").collect();
  const institutionId = await scholarInstitutionId(ctx, scholar._id);
  const pickForStatus = (status: Doc<"reportingPeriods">["status"]) =>
    periods.find(
      (period) =>
        period.status === status &&
        institutionId != null &&
        period.institutionId === institutionId,
    ) ??
    periods.find(
      (period) =>
        period.status === status && period.institutionId === undefined,
    );
  const period = pickForStatus("writing") ?? pickForStatus("open") ?? null;
  if (!period) {
    return {
      periodId: null,
      groupIds,
      placements: [],
      subjectTabs: [],
      subjectByWork: new Map(),
    };
  }

  const groupIdSet = new Set(groupIds.map(String));
  const placements = (
    await ctx.db
      .query("schedulePlacements")
      .withIndex("by_period", (q) => q.eq("periodId", period._id))
      .collect()
  ).filter((placement) => groupIdSet.has(String(placement.groupId)));
  const subjectTabs = uniqueSubjects(placements);
  const subjectByWork = new Map<string, string>();
  for (const placement of placements) {
    if (!placement.assignmentId || !placement.activityId) continue;
    const key = scheduleWorkKey(
      placement.assignmentId,
      placement.activityId,
    );
    if (!subjectByWork.has(key)) {
      subjectByWork.set(key, placement.subject.trim());
    }
  }

  return {
    periodId: period._id,
    groupIds,
    placements,
    subjectTabs,
    subjectByWork,
  };
}

export { workSubjectLabel } from "./lib/homeworkSubject";

export function resolveScholarWorkSubject(
  timetable: ScholarTimetableContext,
  assignmentId: Id<"assignments"> | null | undefined,
  activityId: Id<"activities"> | null | undefined,
  unitSubject: string | null | undefined,
  /** The subject of the class the give is filed under (`pushes.classId`). */
  classSubject?: string | null,
): string | null {
  // The give's filed class comes first (TRA-721), when the scholar's timetable
  // has a tab for it, so the tab agrees with the label.
  const matchingClassTab = classSubject?.trim()
    ? timetable.subjectTabs.find((subject) => subjectMatches(classSubject, subject))
    : undefined;
  if (matchingClassTab) return matchingClassTab;
  // Then the unit's subject, matched to a tab by meaning (TRA-723): a "Social
  // Studies" unit lands on "Humanities". An exact spelling wins; otherwise the
  // tab is used only when it is the ONE tab that fits. A unit that fits two
  // tabs ("Science & Art" beside Science and Art) is not guessed between: it
  // goes where it went before, the placement's subject or else Other.
  const unitSubjectText = unitSubject?.trim() ?? "";
  const fittingTabs = unitSubjectText
    ? timetable.subjectTabs.filter((subject) =>
        unitSubjectFitsClass(unitSubjectText, subject),
      )
    : [];
  const matchingTimetableSubject =
    timetable.subjectTabs.find((subject) => subjectMatches(unitSubject, subject)) ??
    (fittingTabs.length === 1 ? fittingTabs[0] : undefined);
  if (matchingTimetableSubject) return matchingTimetableSubject;
  // Last resort: the timetable placement's subject. A unit with no subject
  // (about a third of gives) has no other way to land on a tab.
  if (assignmentId && activityId) {
    const placementSubject = timetable.subjectByWork.get(
      scheduleWorkKey(assignmentId, activityId),
    );
    if (placementSubject) return placementSubject;
  }
  if (timetable.subjectTabs.length > 0) return null;
  return unitSubject?.trim() || null;
}

/**
 * Activity kinds a scholar can START or CONTINUE on their OWN — i.e. that
 * produce a scholar-launched session/surface on the plate: an AI-tutor chat
 * (`online`), a Simulator Workbench (`simulator`), a practice-engine set
 * (`problem_set`), an app-builder session (`vibecode`), or a dedicated shell
 * (`web`/`game`). The OTHER kinds — `offline` (a physical/scanned task) and
 * `shareBack` (a whole-class digest) — have NO scholar-launched surface
 * (matching scholarPlate.activeForMe, which never emits a start card for them),
 * so a scholar can't solo-complete them; a teacher-led card-sort done together
 * in class is an `offline` activity.
 *
 * This is the honest "can the scholar complete this focus solo?" signal. It
 * used to gate the read-only focus lock (a focus the scholar can't
 * self-complete must not padlock their other work — PR #707's root-cause
 * writeup); the lock is gone (shared/classFocus.ts), and it now decides which
 * live focus may be HEADLINED to the scholar as what the room is on. See
 * `soloStartableByMe` below.
 */
const SCHOLAR_SOLO_STARTABLE_KINDS: ReadonlySet<Doc<"activities">["kind"]> =
  new Set([
    "online",
    "web",
    "problem_set",
    "game",
    "simulator",
    "vibecode",
  ]);

/**
 * Is this entry LIVE to scholars? Live = it has actually been started
 * (`setAt` stamped) and hasn't auto-cleared (past `endsAt`). A planned
 * entry (`setAt` null, `startsAt` in the future or past) is NOT live —
 * it shows on the teacher's agenda but never reaches a scholar until
 * activation stamps `setAt`. This is the safety property that makes a
 * mis-typed past `startsAt` harmless. See review/calendar-view-plan.md.
 *
 * NOTE the split below. This predicate answers whether a schedule window is
 * open. `isEntryShowing` answers whether a class focus belongs on today's
 * screen. Homework callers keep this window rule unchanged.
 */
export function isLiveEntry(e: ScheduleEntry, now: number): boolean {
  return e.setAt != null && (!e.endsAt || e.endsAt > now);
}

/**
 * Is this entry still on the scholar's screen?
 *
 * A focus set today stays visible all day, including after its window closes.
 * On a later institution day it remains visible only when a teacher supplied
 * an explicit future `endsAt`.
 *
 * CLASS FOCUS ONLY. Both callers filter on `mode === "classFocus"` first, and
 * that is load-bearing: on a `homework` entry `endsAt` does not mean "the
 * window closed", it means a staff member ENDED the work early
 * (`endProgramActivity`). Applying this predicate to homework would put that
 * withdrawn work back in front of the scholar.
 */
export function isEntryShowing(
  e: ScheduleEntry,
  nowMs: number,
  todayDayKey: string,
  timeZone: string,
): boolean {
  return isFocusShowing(e, nowMs, todayDayKey, timeZone);
}

/**
 * May this entry hold the scholar inside its unit?
 *
 * The wall, unlike the label, closes on `endsAt` at READ time, and that is
 * what keeps the lock independent of the clear job. If `autoClearActivity`
 * is delayed or dropped, the wall still comes down on time.
 */
export function isEntryBlocking(e: ScheduleEntry, now: number): boolean {
  return e.setAt != null && (!e.endsAt || e.endsAt > now);
}

/**
 * Has this class focus's window closed? Only open-until work outlives its
 * close in the schedule (armFocusAutoClear), so in practice this is a closed
 * open-until give. Giving that activity again is a fresh give: it must not
 * inherit the old `setAt` and go live before its new start.
 */
export function isClosedFocusEntry(e: ScheduleEntry, now: number): boolean {
  return (
    e.mode === "classFocus" &&
    e.setAt != null &&
    e.endsAt != null &&
    e.endsAt <= now
  );
}

/** Teacher-visible live entries, with focus and homework clocks kept distinct. */
async function activeScheduleEntries(
  ctx: ScheduleReadCtx,
  assignment: Doc<"assignments">,
  nowMs: number,
  todayDayKey: string,
  timeZone: string,
) {
  const schedule = await readSchedule(ctx, assignment);
  return schedule.filter((entry) =>
    isScheduleEntryActive(entry, nowMs, todayDayKey, timeZone),
  );
}

/** Class-focus entries still showing on this institution day. */
async function showingScheduleEntries(
  ctx: ScheduleReadCtx,
  assignment: Doc<"assignments">,
  nowMs: number,
  todayDayKey: string,
  timeZone: string,
) {
  const schedule = await readSchedule(ctx, assignment);
  return schedule.filter((entry) =>
    isEntryShowing(entry, nowMs, todayDayKey, timeZone),
  );
}

/**
 * SHARED SEAM (consumed by the portfolio auto-filer).
 *
 * Given an assignment, a scholar, and a timestamp, return the activity
 * whose LIVE WINDOW contained that timestamp — i.e. the activity the
 * cohort was working on at that moment. This is what lets a scanned
 * artifact auto-file to the right activity: the scan's capture time
 * lands inside exactly one pushed activity's window.
 *
 * Window semantics (evaluated against `timestamp`, NOT `now`):
 *   - The entry must have gone live (`setAt` stamped) at or before the
 *     timestamp: `setAt <= timestamp`.
 *   - The timestamp must be before the entry ended: `endsAt == null ||
 *     timestamp < endsAt`. A homework / open-ended push (no `endsAt`)
 *     stays live indefinitely, so its window is `[setAt, ∞)`.
 *   - Planned entries (no `setAt`) never match — consistent with the
 *     "planned ≠ live" safety property everywhere else.
 * Tiebreak when multiple windows contain the timestamp: the one that
 * went live MOST RECENTLY (greatest `setAt`) wins — that's "what the
 * room most recently focused on" at that moment, so a bounded
 * classFocus push correctly shadows an older open-ended homework push.
 *
 * Returns null if the assignment is missing, the scholar isn't on its
 * roster, or no live window contains the timestamp. The signature is a
 * stable contract — keep it.
 */
export async function liveActivityAt(
  ctx: { db: QueryCtx["db"] },
  assignmentId: Id<"assignments">,
  scholarId: Id<"users">,
  timestamp: number,
): Promise<Id<"activities"> | null> {
  const a = await ctx.db.get(assignmentId);
  if (!a || a.archivedAt) return null;
  if (!targetsScholar(a, scholarId)) return null;
  let best: ScheduleEntry | null = null;
  for (const e of await readSchedule(ctx, a)) {
    if (!entryTargetsScholar(e, scholarId)) continue;
    if (e.setAt == null || e.setAt > timestamp) continue;
    if (e.endsAt != null && timestamp >= e.endsAt) continue;
    if (best == null || e.setAt > best.setAt!) best = e;
  }
  return best?.activityId ?? null;
}

/**
 * Has this scholar already completed the activity behind a class-focus
 * entry? Keyed on (scholarId, activityId) via the `by_scholar_activity`
 * index — matching the stamp `activityCompletions.markComplete` (and the
 * rubric-pass fast-forward) writes. A completion counts when it's scoped to
 * THIS assignment (the normal case), is un-scoped (a bare completion — e.g.
 * a non-assignment session of the same activity), OR was earned under a
 * LIVE sibling assignment on the same unit. That last arm exists because a
 * scholar can sit on several concurrent assignments for one unit (e.g.
 * `devPilot.addToAssignmentByUnitTitle` patches every live assignment on the
 * unit), and completion writers stamp the assignmentId of whichever surface
 * they were called from — the work is the same work, so it must lift the
 * lock no matter which sibling's surface recorded it. A completion from an
 * ARCHIVED assignment still does not bleed in: that's a previous run of the
 * unit, the cross-cohort case the schema documents on
 * `activityCompletions.assignmentId`.
 *
 * Used only in the scholar branch of `currentClassFocusForMe` to retire a
 * completed focus the moment the required work is done — back when that lifted
 * a read-only lock, and now so a finished focus stops being headlined. The
 * teacher-facing view is unaffected.
 */
async function scholarCompletedFocusActivity(
  ctx: { db: QueryCtx["db"] },
  scholarId: Id<"users">,
  activityId: Id<"activities">,
  assignment: Doc<"assignments">,
): Promise<boolean> {
  const rows = await ctx.db
    .query("activityCompletions")
    .withIndex("by_scholar_activity", (q) =>
      q.eq("scholarId", scholarId).eq("activityId", activityId),
    )
    .collect();
  if (
    rows.some(
      (r) => r.assignmentId === undefined || r.assignmentId === assignment._id,
    )
  ) {
    return true;
  }
  // Sibling-assignment arm. Guarded on unitId: an ad-hoc dispatch has none,
  // and undefined === undefined must not make unrelated dispatches bleed.
  if (!assignment.unitId) return false;
  const checked = new Set<string>();
  for (const r of rows) {
    if (!r.assignmentId || checked.has(String(r.assignmentId))) continue;
    checked.add(String(r.assignmentId));
    const sibling = await ctx.db.get(r.assignmentId);
    if (!sibling || sibling.archivedAt) continue;
    if (String(sibling.unitId ?? "") === String(assignment.unitId)) return true;
  }
  return false;
}

async function enrichScheduleEntryForScholar(
  ctx: QueryCtx,
  assignment: Doc<"assignments">,
  entry: ScheduleEntry,
  scholarId: Id<"users">,
  descriptionAudience: "scholar" | "teacher" = "scholar",
) {
  // Only ever called for entries in activitySchedule. A standing (unitId-less)
  // practice assignment never populates one, but an ad-hoc dispatch (kind
  // "adHocDispatch") DOES while also being unitId-less — so this guard is
  // load-bearing for dispatches, not merely defensive.
  const unit = assignment.unitId ? await ctx.db.get(assignment.unitId) : null;
  const activity = await ctx.db.get(entry.activityId);
  const lesson = activity?.lessonId ? await ctx.db.get(activity.lessonId) : null;
  const teacher = await ctx.db.get(assignment.teacherId);
  // kind="web": resolve the effective launch target from the referenced
  // catalog app (DRY) — app supplies allowlist + icon, activity overrides.
  const web =
    activity?.kind === "web"
      ? await resolveActivityWebTarget(ctx, activity)
      : null;
  // Has this scholar completed this activity under this Assignment?
  const completion = await ctx.db
    .query("activityCompletions")
    .withIndex("by_scholar_assignment", (q) =>
      q.eq("scholarId", scholarId).eq("assignmentId", assignment._id),
    )
    .filter((q) => q.eq(q.field("activityId"), entry.activityId))
    .first();
  return {
    assignmentId: assignment._id,
    activityId: entry.activityId,
    activityTitle: activity?.title ?? null,
    activityKind: activity?.kind ?? null,
    description:
      descriptionAudience === "teacher"
        ? activity?.description ?? null
        : activity?.scholarDescription ?? null,
    // A one-node problem set is the schedule adapter for a Math Skill. Carry its
    // canonical key so every scholar client can open the existing `?skill=`
    // targeted-practice route without inventing another serving mode.
    practiceSkillKey:
      activity?.kind === "problem_set" &&
      activity.problemSet?.targetSkillKeys.length === 1
        ? activity.problemSet.targetSkillKeys[0]
        : null,
    // kind="web" launch config — the scholar surfaces hand these to
    // the web-assignment launcher instead of creating a project.
    webUrl: web ? web.webUrl : (activity?.webUrl ?? null),
    webAllowedHosts: web ? web.webAllowedHosts : (activity?.webAllowedHosts ?? null),
    // Catalog app identity (when the activity references one) — lets the
    // assignment card show the same icon as the launcher tile.
    appIconUrl: web?.appIconUrl ?? null,
    appColor: web?.appColor ?? null,
    // kind="game" launch config. `gamePlatform` is the SAME declaration the
    // web capability notice reads (lib/games/catalog.ts) — one source, so a
    // teacher sees the device requirement at assign time, not a scholar at
    // discovery time (D-5).
    gameId: activity?.kind === "game" ? (activity.game?.gameId ?? null) : null,
    gameTitle:
      activity?.kind === "game"
        ? (getGame(activity.game?.gameId ?? "")?.title ?? null)
        : null,
    gamePlatform:
      activity?.kind === "game"
        ? (getGame(activity.game?.gameId ?? "")?.platform ?? null)
        : null,
    lessonId: activity?.lessonId ?? null,
    lessonTitle: lesson?.title ?? null,
    unitId: assignment.unitId,
    unitTitle: unit?.title ?? null,
    unitEmoji: unit?.emoji ?? null,
    teacherName: teacher?.name ?? null,
    teacherImage: teacher?.image ?? null,
    mode: entry.mode,
    // Enrich is only called on LIVE entries (setAt stamped); coerce for
    // the type checker, falling back to startsAt then 0.
    setAt: entry.setAt ?? entry.startsAt ?? 0,
    endsAt: entry.endsAt ?? null,
    dueAt: entry.dueAt ?? null,
    // The institution's IANA timezone — "the turn, not the bell" renders
    // `endsAt` as a soft local wall-clock instant (e.g. "10:25 AM"), never a
    // raw countdown, and it must be the SCHOOL's clock, not the device's.
    timeZone: await timeZoneForScholar(ctx, scholarId),
    completedByMe: !!completion,
    // Can THIS scholar start/continue the focus activity on their own? Only
    // scholar-launchable kinds can — an `offline`/`shareBack` focus (e.g. a
    // card-sort done together in class) has no solo surface, so it must NOT be
    // headlined as what the scholar is on (it used to be barred from driving
    // the read-only lock — PR #707). Applied in shared/classFocus.ts.
    //
    // Also false once the window has closed. A same-day overrun focus keeps
    // its label but stops being headlined as work that can hold the scholar
    // in. That split keeps a slipped clear job from becoming a lockout.
    soloStartableByMe: activity
      ? SCHOLAR_SOLO_STARTABLE_KINDS.has(effectiveActivityKind(activity)) &&
        isEntryBlocking(entry, Date.now())
      : false,
  };
}

export async function homeworkForScholarFromAssignments(
  ctx: QueryCtx,
  scholarId: Id<"users">,
  candidates: readonly Doc<"assignments">[],
  now = Date.now(),
  // Shared across a loop over many scholars, so each assignment's schedule
  // is read once per request rather than once per scholar.
  scheduleCache?: ScheduleCache,
) {
  const out: Array<
    Awaited<ReturnType<typeof enrichScheduleEntryForScholar>>
  > = [];
  for (const assignment of candidates) {
    if (assignment.archivedAt || !targetsScholar(assignment, scholarId)) continue;
    for (const entry of await readSchedule(ctx, assignment, scheduleCache)) {
      if (!isLiveEntry(entry, now)) continue;
      if (entry.mode !== "homework" || !entryTargetsScholar(entry, scholarId)) {
        continue;
      }
      const homework = await enrichScheduleEntryForScholar(
        ctx,
        assignment,
        entry,
        scholarId,
      );
      if (homework.activityKind === "offline" && !homework.description?.trim()) {
        const activity = await ctx.db.get(entry.activityId);
        if (!activity || !(await hasReadableOfflineHomeworkContent(ctx, activity))) {
          continue;
        }
      }
      out.push(homework);
    }
  }
  out.sort((a, b) => (a.dueAt ?? Infinity) - (b.dueAt ?? Infinity));
  return out;
}

export function homeworkAssignmentsByScholar(
  candidates: readonly Doc<"assignments">[],
  scholarIds: readonly Id<"users">[],
): Map<string, Doc<"assignments">[]> {
  const byScholar = new Map(
    scholarIds.map((scholarId) => [
      String(scholarId),
      [] as Doc<"assignments">[],
    ]),
  );
  for (const assignment of candidates) {
    if (assignment.archivedAt) continue;
    for (const scholarId of assignment.scholarIds) {
      byScholar.get(String(scholarId))?.push(assignment);
    }
  }
  return byScholar;
}

export async function homeworkForScholar(
  ctx: QueryCtx,
  scholarId: Id<"users">,
  now = Date.now(),
) {
  return await homeworkForScholarFromAssignments(
    ctx,
    scholarId,
    await ctx.db.query("assignments").collect(),
    now,
  );
}

// ─── Teacher writes ──────────────────────────────────────────────────

/** Narrow Schedule data for an explicitly assigned Extended education specialist. */
export const programScheduleOverview = authedQuery({
  args: { institutionScope: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const candidates = await publishableProgramGroups(
      ctx,
      ctx.user,
      args.institutionScope,
    );
    const groups = [];
    for (const group of candidates) {
      if (
        await hasCurriculumAccessForInstitution(
          ctx,
          ctx.user,
          group.institutionId,
        )
      ) {
        groups.push(group);
      }
    }
    const scheduled = await programScheduleRows(ctx, groups, Date.now());
    return {
      groups: groups.map((group) => ({
        groupId: group._id,
        groupName: group.name,
      })),
      scheduled,
    };
  },
});

/**
 * The live program-homework rows for these groups (the parity check reuses
 * it). `recipientCount` reads the entry's own `scholarIds` when present —
 * including an empty list — else the roster.
 */
export async function programScheduleRows(
  ctx: QueryCtx,
  groups: ReadonlyArray<Doc<"scholarGroups">>,
  now: number,
) {
  {
    const scheduled = [];
    for (const group of groups) {
      const assignments = await ctx.db
        .query("assignments")
        .withIndex("by_scholar_group", (q) =>
          q.eq("scholarGroupId", group._id),
        )
        .collect();
      for (const assignment of assignments) {
        if (assignment.archivedAt) continue;
        const unit = assignment.unitId
          ? await ctx.db.get(assignment.unitId)
          : null;
        for (const entry of await readSchedule(ctx, assignment)) {
          if (entry.mode !== "homework" || !isLiveEntry(entry, now)) continue;
          const activity = await ctx.db.get(entry.activityId);
          const resources = await resolveReachableActivityResources(
            ctx,
            entry.activityId,
          );
          scheduled.push({
            assignmentId: assignment._id,
            groupId: group._id,
            groupName: group.name,
            unitId: assignment.unitId ?? null,
            unitTitle: unit?.title ?? "Untitled unit",
            activityId: entry.activityId,
            activityTitle: activity?.title ?? "Untitled activity",
            sharedAt: entry.setAt ?? assignment.startedAt,
            recipientCount: (entry.scholarIds ?? assignment.scholarIds).length,
            materialCount: resources.all.length,
          });
        }
      }
    }
    scheduled.sort((a, b) => b.sharedAt - a.sharedAt);
    return scheduled;
  }
}

/**
 * Resolve the authorized program assignment for one activity without changing
 * its availability. Schedule placement callers use this before materializing a
 * concrete slot; direct publishing then adds the immediate homework push below.
 */
export async function ensureProgramAssignment(
  ctx: MutationCtx & { user: Doc<"users"> },
  { activityId, scholarGroupId }: {
    activityId: Id<"activities">;
    scholarGroupId: Id<"scholarGroups">;
  },
) {
    const { user, unit } = await requireUnitEditAccess(ctx, { activityId });
    const group = await requireProgramPublishAccess(
      ctx,
      user,
      await ctx.db.get(scholarGroupId),
    );
    if (!unit.institutionId || group.institutionId !== unit.institutionId) {
      throw new Error("Forbidden: program group and unit must belong to the same school.");
    }

    const scholarIds = Array.from(new Set(group.scholarIds.map(String)));
    if (scholarIds.length === 0) {
      throw new Error("Program group must include at least one scholar.");
    }
    const roster = [];
    for (const scholarId of scholarIds) {
      const scholar = await ctx.db.get(scholarId as Id<"users">);
      if (
        !scholar ||
        scholar.role !== "scholar" ||
        scholar.institutionId !== unit.institutionId
      ) {
        throw new Error("Program group contains an invalid scholar.");
      }
      roster.push(scholar._id);
    }
    // A proposed Quest goes to no program group (TRA-685).
    assertProposedQuestRecipients(unit, roster);
    // Assigning a unit publishes it (TRA-490).
    await publishUnitOnAssign(ctx, unit._id, user._id);

    const programAssignments = await ctx.db
      .query("assignments")
      .withIndex("by_scholar_group", (q) =>
        q.eq("scholarGroupId", group._id),
      )
      .collect();
    let assignment = programAssignments.find(
      (candidate) =>
        !candidate.archivedAt &&
        candidate.unitId === unit._id &&
        candidate.scholarGroupId === group._id,
    );
    const created = !assignment;
    if (!assignment) {
      const assignmentId = await ctx.db.insert("assignments", {
        teacherId: user._id,
        unitId: unit._id,
        scholarGroupId: group._id,
        scholarIds: roster,
        title: `${group.name} — ${unit.title}`,
        startedAt: Date.now(),
        selfPaced: true,
      });

      assignment = (await ctx.db.get(assignmentId))!;
    } else {
      const previousRoster = assignment.scholarIds;
      const previousRosterKeys = new Set(previousRoster.map(String));
      const nextRoster = [
        ...previousRoster,
        ...roster.filter((id) => !previousRosterKeys.has(String(id))),
      ];
      // An absent entry target means "everyone currently on the assignment."
      // Freeze those old entries before widening the assignment roster so a new
      // group member receives today's publish without inheriting prior work.
      const frozenSchedule = (await readSchedule(ctx, assignment)).map(
        (entry) =>
          entry.scholarIds === undefined
            ? { ...entry, scholarIds: previousRoster }
            : entry,
      );
      await ctx.db.patch(assignment._id, { scholarIds: nextRoster });
      assignment = { ...assignment, scholarIds: nextRoster };
      await writeSchedule(ctx, assignment, frozenSchedule);
    }

    return {
      assignment,
      created,
      group,
      roster,
      unit,
    };
}

/**
 * Publish one activity to a program group. The group is the authorization
 * boundary. Each publish snapshots the current group roster onto that activity;
 * callers never supply individual scholars or schedule controls.
 */
export const assignProgramActivity = authedMutation({
  args: {
    activityId: v.id("activities"),
    scholarGroupId: v.id("scholarGroups"),
  },
  handler: async (ctx, args) => {
    const { assignment, created, roster } = await ensureProgramAssignment(ctx, args);
    await applyPushActivity(ctx, assignment, {
      activityId: args.activityId,
      mode: "homework",
      scholarIds: roster,
    });
    return { assignmentId: assignment._id, created, shared: true };
  },
});

/** End one program activity's availability without discarding its schedule history. */
export const endProgramActivity = authedMutation({
  args: {
    assignmentId: v.id("assignments"),
    activityId: v.id("activities"),
  },
  handler: async (ctx, { assignmentId, activityId }) => {
    const assignment = await ctx.db.get(assignmentId);
    if (!assignment?.unitId || !assignment.scholarGroupId || assignment.archivedAt) {
      throw new Error("Program assignment not found.");
    }
    const { user, unit } = await requireUnitEditAccess(ctx, {
      unitId: assignment.unitId,
    });
    const group = await requireProgramPublishAccess(
      ctx,
      user,
      await ctx.db.get(assignment.scholarGroupId),
    );
    if (!unit.institutionId || group.institutionId !== unit.institutionId) {
      throw new Error(
        "Forbidden: program group and unit must belong to the same school.",
      );
    }
    const now = Date.now();
    let ended = false;
    const schedule = (await readSchedule(ctx, assignment)).map((entry) => {
      if (
        entry.activityId !== activityId ||
        entry.mode !== "homework" ||
        !isLiveEntry(entry, now)
      ) {
        return entry;
      }
      ended = true;
      return { ...entry, endsAt: now };
    });
    if (!ended) throw new Error("This activity is no longer available.");
    // Withdrawn homework (`endsAt` on a homework entry) is stored as a closed
    // row that still reads back as the entry (lib/pushes
    // isWithdrawnHomeworkEntry), so history survives.
    await writeSchedule(ctx, assignment, schedule, { activityId });
    return { ended: true };
  },
});

/**
 * Create a new Assignment: the cohort × unit row, with nothing on the schedule.
 * Nothing goes live until a teacher gives an activity and answers both
 * questions — when it shows up and when they should finish it (TRA-571). The
 * unit's activities no longer carry a mode of their own.
 */
export const create = curriculumRunMutation({
  args: {
    unitId: v.id("units"),
    scholarIds: v.array(v.id("users")),
    title: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    if (isTeacherRole(ctx.user.role)) {
      await requireScholarsAccessible(ctx, ctx.user, args.scholarIds);
    } else {
      // curriculum:run — a unit she can edit, scholars at that unit's school.
      const { institutionId } = await requireRunnableUnit(
        ctx,
        ctx.user,
        args.unitId,
      );
      await requireScholarsAtInstitution(ctx, args.scholarIds, institutionId);
    }
    const teacherId = ctx.user._id;
    // Assigning a unit publishes it (TRA-490).
    await publishUnitOnAssign(ctx, args.unitId, teacherId);
    return await ctx.db.insert("assignments", {
      teacherId,
      unitId: args.unitId,
      scholarIds: Array.from(new Set(args.scholarIds)),
      title: args.title?.trim() || undefined,
      startedAt: Date.now(),
    });
  },
});

/**
 * Assign work in ONE step: find-or-create the cohort × unit assignment
 * AND schedule something on it at a chosen time. This is what the
 * "Assign" dialog calls — an assignment is never born dateless/inert.
 *
 * `target` picks the granularity:
 *   - activity → schedule that single activity at `startsAt`.
 *   - lesson   → land that lesson's activities on `startsAt`.
 *   - unit     → same, across the whole unit's activities in order.
 * Every give answers "when should they finish it?" (`finish`, mapped by
 * lib/giveWindow.ts; TRA-571). A unit or lesson with no `finish` only makes
 * the assignment and plans nothing: nothing goes live, and nothing is given
 * a mode, until a teacher answers both questions for it. There's no authored
 * per-activity pacing: a unit/lesson given with a finish lands everything on
 * `startsAt` (planned, not auto-activated) and the teacher paces it live with
 * Start-now.
 *
 * Find-or-create dedupes the common "assign more of the same unit to the
 * same cohort" case onto one assignment row (instead of spawning a second
 * identical-looking cohort — the exact confusion the two-step flow bred).
 */
const assignWorkTargetValidator = v.union(
  v.object({ kind: v.literal("unit") }),
  v.object({ kind: v.literal("lesson"), lessonId: v.id("lessons") }),
  v.object({
    kind: v.literal("activity"),
    activityId: v.id("activities"),
    // An explicit mode is the legacy answer; prefer `finish` on the args.
    mode: v.optional(v.union(v.literal("classFocus"), v.literal("homework"))),
    endsAt: v.optional(v.number()),
    // "Open until" (true) or "in that class" (false) for a raw class-focus
    // end (TRA-726). Optional: absent, the dates decide, as before.
    openUntilKind: v.optional(v.boolean()),
    dueAt: v.optional(v.number()),
    // Optional per-scholar targeting (divide & conquer). Subset of
    // `scholarIds`; absent = the whole cohort.
    scholarIds: v.optional(v.array(v.id("users"))),
  }),
);

type AssignWorkTarget =
  | { kind: "unit" }
  | { kind: "lesson"; lessonId: Id<"lessons"> }
  | {
      kind: "activity";
      activityId: Id<"activities">;
      mode?: "classFocus" | "homework";
      endsAt?: number;
      openUntilKind?: boolean;
      dueAt?: number;
      scholarIds?: Id<"users">[];
    };

type AssignWorkCoreArgs = {
  teacherId: Id<"users">;
  unitId: Id<"units">;
  scholarIds: Id<"users">[];
  title?: string;
  startsAt: number;
  target: AssignWorkTarget;
  /** "When should they finish it?" — required for an activity give. */
  finish?: GiveFinish;
};

/** What a give said about finishing: the two-question answer, or (legacy
 *  callers such as Start-now on a planned entry) an explicit mode. */
type GiveAnswer = {
  finish?: GiveFinish;
  mode?: "classFocus" | "homework";
  endsAt?: number;
  /** With a raw class-focus `endsAt`: the teacher's finish (TRA-726). */
  openUntilKind?: boolean;
  dueAt?: number;
};


/**
 * The entry field that carries a timed class focus's finish (TRA-726). Only
 * a class focus with an end has one, so nothing else gains the key.
 */
function openUntilKindFor(
  mode: "classFocus" | "homework",
  endsAt: number | undefined,
  openUntilKind: boolean | undefined,
): { openUntilKind?: boolean } {
  return mode === "classFocus" && endsAt !== undefined && openUntilKind !== undefined
    ? { openUntilKind }
    : {};
}

/**
 * Turn a give's answer into stored fields. Never defaults: no finish is
 * refused with the question the teacher has to answer.
 *
 * A legacy `mode` (older clients, and controls that re-send an entry the
 * teacher already answered) still parses, but only counts as an answer where
 * it says everything: class focus with no end means "in that class" and gets
 * the bell-block end; an explicit end (Extend +10) or due date is kept; and
 * homework with no date is refused rather than given an invented one.
 */
async function windowForGive(
  ctx: QueryCtx,
  args: {
    roster: readonly Id<"users">[];
    institutionId: Id<"institutions"> | undefined;
    startsAt: number;
    answer: GiveAnswer;
    schedule?: ReadonlyArray<ScheduleEntry>;
    activityId?: Id<"activities">;
  },
  classLinkCache?: ClassLinkReadCache,
): Promise<GiveWindow> {
  const { answer } = args;
  if (answer.finish) {
    const { timeZone } = await homeworkCalendarForRoster(
      ctx,
      args.roster,
      args.institutionId,
      classLinkCache,
    );
    return resolveGiveWindow(ctx, {
      scholarIds: args.roster,
      timeZone,
      startsAt: args.startsAt,
      finish: answer.finish,
      schedule: args.schedule,
      activityId: args.activityId,
    }, classLinkCache);
  }
  if (answer.mode === "classFocus" && answer.endsAt !== undefined) {
    // The caller's finish when it says; absent, the store reads the dates.
    return { mode: "classFocus", endsAt: answer.endsAt, openUntilKind: answer.openUntilKind };
  }
  if (answer.mode === "classFocus") {
    return windowForGive(ctx, { ...args, answer: { finish: { kind: "inClass" } } }, classLinkCache);
  }
  if (answer.mode === "homework" && answer.dueAt !== undefined) {
    return { mode: "homework", dueAt: answer.dueAt };
  }
  throw new GiveQuestionError(MISSING_FINISH_QUESTION);
}

/** windowForGive for a give on an existing assignment. With
 *  `reuseLiveFinish` ("more time" for named scholars), an unanswered finish
 *  takes the activity's live entry as it stands, since the teacher already
 *  answered for it. */
async function windowForAssignmentGive(
  ctx: QueryCtx,
  a: Doc<"assignments">,
  args: {
    startsAt: number;
    answer: GiveAnswer;
    scholarIds?: Id<"users">[];
    activityId: Id<"activities">;
    reuseLiveFinish?: boolean;
    /** The give goes live now (`pushActivity`): a raw class focus with no
     *  end on a PLANNED open-until entry is the Run page's Start now. */
    startsNow?: boolean;
  },
): Promise<GiveWindow> {
  const schedule = await readSchedule(ctx, a);
  if (args.reuseLiveFinish && !args.answer.finish && !args.answer.mode) {
    const live = schedule.find(
      (entry) => entry.activityId === args.activityId && entry.setAt != null,
    );
    if (live) {
      return {
        mode: live.mode,
        endsAt: live.endsAt,
        dueAt: live.dueAt,
        openUntilKind: live.openUntilKind,
      };
    }
  }
  const sameGive = answeredByStoredFinish(schedule, args);
  if (sameGive) return sameGive;
  return windowForGive(ctx, {
    roster: args.scholarIds?.length ? args.scholarIds : a.scholarIds,
    institutionId: await homeworkInstitutionForAssignment(ctx, a),
    startsAt: args.startsAt,
    answer: args.answer,
    schedule,
    activityId: args.activityId,
  });
}

/** The refusal for Extend (+10) on open-until work (TRA-726). */
export const EXTEND_OPEN_UNTIL_REFUSAL =
  "This is open until the end of its day, so it can't be extended by minutes. To keep it open longer, give it again open until a later day.";

/**
 * A raw class-focus answer (no finish: Extend, Start now, an older client)
 * takes the teacher's finish from the activity's stored entry (TRA-726), so
 * the server needs no new argument from the client. Only from an entry that
 * still stands for this give:
 *
 *   - a raw end, against a LIVE entry (started, `endsAt` still ahead): it is
 *     "in that class" or "open until" as the entry was. Extend on live
 *     open-until work, which would push its close past midnight, is refused.
 *   - no end, against a PLANNED open-until entry whose close is still ahead,
 *     and only when the give goes live now (`startsNow`, the Run page's Start
 *     now, whose client dropped the end because the close is today): it keeps
 *     its closing day. A plan (`scheduleActivity`) with no end is a fresh
 *     in-class give, as before.
 *
 * A closed or ended entry answers nothing (open-until work is never cleared,
 * so `readSchedule` still returns it after its close): the request is a
 * fresh give, decided as before. Null whenever the caller should resolve the
 * answer itself.
 */
function answeredByStoredFinish(
  schedule: ReadonlyArray<ScheduleEntry>,
  args: {
    answer: GiveAnswer;
    activityId: Id<"activities">;
    startsNow?: boolean;
  },
): GiveWindow | null {
  const { answer } = args;
  if (answer.finish || answer.mode !== "classFocus") return null;
  const entry = schedule.find(
    (e) => e.activityId === args.activityId && e.mode === "classFocus",
  );
  if (!entry || entry.openUntilKind === undefined || entry.endsAt === undefined) return null;
  const now = Date.now();
  if (entry.endsAt <= now) return null;
  if (answer.endsAt !== undefined) {
    if (entry.setAt == null) return null;
    if (entry.openUntilKind && answer.endsAt !== entry.endsAt) {
      throw new ConvexError(EXTEND_OPEN_UNTIL_REFUSAL);
    }
    if (answer.openUntilKind !== undefined) return null;
    return { mode: "classFocus", endsAt: answer.endsAt, openUntilKind: entry.openUntilKind };
  }
  if (args.startsNow && entry.openUntilKind && entry.setAt == null) {
    return { mode: "classFocus", endsAt: entry.endsAt, openUntilKind: true };
  }
  return null;
}

/** How far in the past a "shows up" time may be and still mean "now": the
 *  give forms round now down to the minute. */
const GIVE_START_GRACE_MS = 5 * 60_000;

export const START_PASSED_QUESTION =
  "That time has already passed. Should it show up now, or at a later time?";

/**
 * Write an answered give (TRA-571). The finish is resolved AFTER the start is
 * settled (`resolve(start)`), so "in that class" reads the bell at the moment
 * the work really shows up:
 *
 *   - not yet live: a start that has clearly passed is refused with a
 *     question; one within the grace window (the forms round now down to the
 *     minute) means NOW and goes live immediately; a later one is planned with
 *     an activation job.
 *   - already live (an edit): the work stays live. A start at or before now
 *     re-reads the finish at now, so a focus is never stored already expired,
 *     and a new class end gets its own clear job (applyScheduleActivity). A
 *     later start re-times it in place.
 *
 * Every give detaches a Master Schedule cell linked to the same assignment +
 * activity: it keeps its subject and loses the link, so reconciliation can't
 * rewrite the teacher's newer answer.
 */
async function applyGive(
  ctx: MutationCtx,
  a: Doc<"assignments">,
  args: {
    activityId: Id<"activities">;
    startsAt: number;
    resolve: (startsAt: number) => Promise<GiveWindow>;
    scholarIds?: Id<"users">[];
  },
  classLinkCache?: ClassLinkReadCache,
): Promise<void> {
  // Every push, however it got here, reaches only a proposed Quest's own
  // proposer (TRA-685, as coreAssignWork).
  if (a.unitId) {
    assertProposedQuestRecipients(
      await ctx.db.get(a.unitId),
      args.scholarIds ?? a.scholarIds,
    );
  }
  const now = Date.now();
  const found = (await readSchedule(ctx, a)).find(
    (entry) => entry.activityId === args.activityId,
  );
  // A closed focus is history, not live work to re-time.
  const existing = found && !isClosedFocusEntry(found, now) ? found : undefined;
  await detachPlacementsForGive(ctx, a._id, args.activityId, classLinkCache);
  if (existing?.setAt != null) {
    const effectiveStart = Math.max(args.startsAt, now);
    const window = await args.resolve(effectiveStart);
    // Re-giving live work "in that class" is a new class occurrence (TRA-638).
    // Readers still date-guess a `focus` row from its `setAt` until TRA-726
    // step 3, so keeping yesterday's would read today's in-class give as
    // "Open until <today>". An "open until" re-give is stored as `openUntil`
    // and needs no new start; it keeps its own.
    const restartedAt =
      window.mode === "classFocus" &&
      window.endsAt !== undefined &&
      window.openUntilKind !== true &&
      (await isOpenUntilEntry(ctx, a, { ...window, openUntilKind: undefined, setAt: existing.setAt }, classLinkCache)) &&
      !(await isOpenUntilEntry(ctx, a, { ...window, openUntilKind: undefined, setAt: now }, classLinkCache))
        ? now
        : undefined;
    await applyScheduleActivity(ctx, a, {
      activityId: args.activityId,
      ...window,
      startsAt: args.startsAt,
      scholarIds: args.scholarIds,
      restartedAt,
    }, true, classLinkCache);
    return;
  }
  if (args.startsAt < now - GIVE_START_GRACE_MS) {
    throw new GiveQuestionError(START_PASSED_QUESTION);
  }
  if (args.startsAt <= now) {
    await applyPushActivity(ctx, a, {
      activityId: args.activityId,
      ...(await args.resolve(now)),
      scholarIds: args.scholarIds,
    }, classLinkCache);
    return;
  }
  await applyScheduleActivity(ctx, a, {
    activityId: args.activityId,
    ...(await args.resolve(args.startsAt)),
    startsAt: args.startsAt,
    scholarIds: args.scholarIds,
  }, true, classLinkCache);
}

/** A teacher moving work someone else gave (the grid's Homework due drag). */
export const NOT_YOUR_GIVE =
  "Only the teacher who gave this, or a school admin, can move it.";

/** Thrown when an older client asks to give a unit or lesson without a
 *  finish (deploy skew): never a silent, empty success. */
export const RELOAD_TO_GIVE =
  "Rabbithole was updated. Reload the page to give work.";

/** Unlink Master Schedule cells that materialize this assignment + activity
 *  (see applyGive). A class cell stays on the grid as a plain class meeting:
 *  its "homework" mode goes too, since that finish now belongs to the give
 *  and would otherwise pull the empty class into the Homework due row beside
 *  the give's own card. A row in the homework block has no class to fall
 *  back to (it existed only to carry this work), so it is removed. */
async function detachPlacementsForGive(
  ctx: MutationCtx,
  assignmentId: Id<"assignments">,
  activityId: Id<"activities">,
  classLinkCache?: ClassLinkReadCache,
): Promise<void> {
  const linked = await ctx.db
    .query("schedulePlacements")
    .withIndex("by_activity", (q) => q.eq("activityId", activityId))
    .collect();
  const changed: Doc<"schedulePlacements">[] = [];
  for (const placement of linked) {
    if (placement.assignmentId !== assignmentId) continue;
    const block = placement.blockId ? await ctx.db.get(placement.blockId) : null;
    if (block?.kind === "homework") {
      await ctx.db.delete(placement._id);
      changed.push(placement);
      continue;
    }
    await ctx.db.patch(placement._id, {
      assignmentId: undefined,
      activityId: undefined,
      mode: undefined,
    });
    changed.push({ ...placement, mode: undefined });
  }
  await syncClassesForPlacements(ctx, changed);
  if (changed.length > 0 && classLinkCache) {
    // Detaching can change class membership mid-batch; school/term data is
    // still valid, but subsequent gives must see the newly synchronized classes.
    await invalidateClassLinkClasses(classLinkCache);
  }
}

export type StoredGiveEntry = {
  mode: "classFocus" | "homework";
  setAt: number | null;
  startsAt: number | null;
  endsAt: number | null;
  dueAt: number | null;
  /** Stored as the `openUntil` timing kind (TRA-726); absent otherwise. */
  openUntilKind?: true;
};

/** The entry an assignment now stores for an activity, for honest replies. */
async function storedEntry(
  ctx: QueryCtx,
  assignmentId: Id<"assignments">,
  activityId: Id<"activities">,
): Promise<StoredGiveEntry | null> {
  const a = await ctx.db.get(assignmentId);
  const entry = (a ? await readSchedule(ctx, a) : []).find(
    (e) => e.activityId === activityId,
  );
  return entry
    ? {
        mode: entry.mode,
        setAt: entry.setAt ?? null,
        startsAt: entry.startsAt ?? null,
        endsAt: entry.endsAt ?? null,
        dueAt: entry.dueAt ?? null,
        ...(entry.openUntilKind ? { openUntilKind: true as const } : {}),
      }
    : null;
}

export async function coreAssignWork(
  ctx: MutationCtx,
  args: AssignWorkCoreArgs,
): Promise<{
  assignmentId: Id<"assignments">;
  created: boolean;
  // From the stored rows, not the request: a start inside the grace window
  // or a re-timed live entry is live even when asked for "later".
  live: boolean;
}> {
  const teacher = await ctx.db.get(args.teacherId);
  if (!teacher) throw new Error("Teacher not found");
  const classLinkCache: ClassLinkReadCache = new Map();
  let institutionId: Id<"institutions"> | undefined;
  if (isTeacherRole(teacher.role)) {
    // The unit must be one this teacher may reach — another school's unit (or
    // a Quest of a scholar they can't read) is refused, rather than assigned
    // and published into a foreign tenant. Covers the UI, the aide's
    // give tool (which accepts a raw unitId) and every other caller.
    const unit = await requireUnitAccessForUser(ctx, teacher, args.unitId);
    institutionId =
      unit.institutionId ??
      (await resolveActiveMembership(ctx, teacher))?.institutionId;
    await requireScholarsAccessible(ctx, teacher, args.scholarIds);
  } else {
    // curriculum:run (lib/curriculumRun.ts): a unit she can edit, at a school
    // where she holds the grant; every assignee at that school; and a
    // lesson/activity target that actually belongs to the unit.
    const runnable = await requireRunnableUnit(ctx, teacher, args.unitId);
    institutionId = runnable.institutionId;
    await requireScholarsAtInstitution(ctx, args.scholarIds, institutionId);
    if (args.target.kind === "lesson") {
      const lesson = await ctx.db.get(args.target.lessonId);
      if (!lesson || lesson.unitId !== args.unitId) {
        throw new Error("Lesson is not part of this unit");
      }
    } else if (args.target.kind === "activity") {
      await assertActivityInUnitStrict(ctx, args.unitId, args.target.activityId);
    }
  }
  const roster = Array.from(new Set(args.scholarIds));
  if (roster.length === 0) throw new Error("Pick at least one scholar.");
  // A proposed Quest is its proposer's alone: it is assigned to nobody else,
  // and a proposal not yet approved to nobody (TRA-685). A teacher who wants
  // a scholar's design for others copies it into their own curriculum.
  assertProposedQuestRecipients(await ctx.db.get(args.unitId), roster);
  // Assigning a unit publishes it (TRA-490) — on reuse too, so assigning
  // again after an unpublish makes the unit findable again.
  await publishUnitOnAssign(ctx, args.unitId, teacher._id);

  // Find-or-create: reuse an active assignment for the same unit + the
  // same exact roster; otherwise make one.
  const mine = await ctx.db
    .query("assignments")
    .withIndex("by_teacher", (q) => q.eq("teacherId", args.teacherId))
    .collect();
  const rosterSet = new Set(roster.map(String));
  let assignmentId =
    mine.find(
      (a) =>
        !a.archivedAt &&
        a.unitId === args.unitId &&
        a.scholarIds.length === roster.length &&
        a.scholarIds.every((id) => rosterSet.has(String(id))),
    )?._id ?? null;
  const created = assignmentId == null;
  if (!assignmentId) {
    assignmentId = await ctx.db.insert("assignments", {
      teacherId: args.teacherId,
      unitId: args.unitId,
      scholarIds: roster,
      title: args.title?.trim() || undefined,
      startedAt: Date.now(),
    });
  }

  if (args.target.kind === "activity") {
    const a = (await ctx.db.get(assignmentId))!;
    const target = args.target;
    const scheduleNow = await readSchedule(ctx, a);
    const resolve = (startsAt: number) =>
      windowForGive(ctx, {
        roster: target.scholarIds?.length ? target.scholarIds : roster,
        institutionId,
        startsAt,
        answer: { ...target, finish: args.finish },
        schedule: scheduleNow,
        activityId: target.activityId,
      }, classLinkCache);
    if (args.finish) {
      await applyGive(ctx, a, {
        activityId: target.activityId,
        startsAt: args.startsAt,
        resolve,
        scholarIds: target.scholarIds,
      }, classLinkCache);
    } else {
      // Deploy skew: an older client's legacy mode (lib above).
      await detachPlacementsForGive(ctx, a._id, target.activityId, classLinkCache);
      await applyScheduleActivity(ctx, a, {
        activityId: target.activityId,
        ...(await resolve(args.startsAt)),
        startsAt: args.startsAt,
        scholarIds: target.scholarIds,
      }, true, classLinkCache);
    }
    const stored = await storedEntry(ctx, assignmentId, target.activityId);
    return { assignmentId, created, live: stored?.setAt != null };
  }

  // A unit / lesson give always carries a finish from a current client; an
  // older one gets a reload message, never an empty success.
  if (!args.finish) throw new Error(RELOAD_TO_GIVE);

  // unit / lesson with a finish → every activity gets that window and shows
  // up when the teacher said: live now for "now", or planned with an
  // activation job for a later time (applyGive).
  const activities = await gatherUnitActivities(
    ctx,
    args.unitId,
    args.target.kind === "lesson" ? args.target.lessonId : null,
  );
  const startsAt = args.startsAt;
  const finish = args.finish;
  const scheduleBefore = await readSchedule(ctx, { _id: assignmentId });
  const resolve = (at: number) =>
    windowForGive(ctx, {
      roster,
      institutionId,
      startsAt: at,
      answer: { finish },
      schedule: scheduleBefore,
    }, classLinkCache);
  const givesHomework = finishIsHomework(finish);
  const given: Id<"activities">[] = [];
  for (let i = 0; i < activities.length; i++) {
    const act = activities[i];
    // A draft handout should not roll back an otherwise valid whole-unit or
    // lesson assignment. Single-activity publishing still rejects it below.
    if (
      givesHomework &&
      act.kind === "offline" &&
      !(await hasReadableOfflineHomeworkContent(ctx, act))
    ) {
      continue;
    }
    // Same for an app activity with no app that scholars can't build either:
    // it is left out rather than failing the whole give (give it once its
    // app exists).
    if (await appActivityHasNothingToOpen(ctx, act)) continue;
    // Re-fetch each iteration: applyScheduleActivity patches the doc, so
    // a cached copy would clobber prior entries.
    const a = (await ctx.db.get(assignmentId))!;
    await applyGive(ctx, a, { activityId: act._id, startsAt, resolve }, classLinkCache);
    given.push(act._id);
  }
  const after = await readSchedule(ctx, { _id: assignmentId });
  const live = after.some(
    (e) => e.setAt != null && given.some((id) => id === e.activityId),
  );
  return { assignmentId, created, live };
}

/**
 * True if ANY assignment references this activity through its
 * `activitySchedule` — planned OR live. Reuses the same "scan assignments,
 * `activitySchedule` cannot be indexed by activityId" read as
 * `removeScheduleStateForActivity` (lib/activityCascade.ts). Used by the
 * coached-activity hand-off to keep an already-scheduled activity from being
 * silently reused/rewritten as an "unbuilt draft".
 */
export const anyAssignmentReferencesActivityInternal = internalQuery({
  args: { activityId: v.id("activities") },
  handler: async (ctx, { activityId }) =>
    anyScheduleReferencesActivity(ctx, activityId),
});

export const assignWork = curriculumRunMutation({
  args: {
    unitId: v.id("units"),
    scholarIds: v.array(v.id("users")),
    title: v.optional(v.string()),
    startsAt: v.number(),
    target: assignWorkTargetValidator,
    finish: v.optional(giveFinishValidator),
  },
  handler: async (ctx, args) =>
    (await coreAssignWork(ctx, { ...args, teacherId: ctx.user._id })).assignmentId,
});

export const setScholars = teacherMutation({
  args: {
    assignmentId: v.id("assignments"),
    scholarIds: v.array(v.id("users")),
  },
  handler: async (ctx, { assignmentId, scholarIds }) => {
    const a = await requireOwnedAssignment(ctx, assignmentId);
    if (!a) return;
    await requireScholarsAccessible(ctx, ctx.user, scholarIds);
    await applySetScholars(ctx, a, scholarIds);
  },
});

export const addScholars = teacherMutation({
  args: {
    assignmentId: v.id("assignments"),
    scholarIds: v.array(v.id("users")),
  },
  handler: async (ctx, { assignmentId, scholarIds }) => {
    const a = await requireOwnedAssignment(ctx, assignmentId);
    if (!a) return;
    await requireScholarsAccessible(ctx, ctx.user, scholarIds);
    await applyAddScholars(ctx, a, scholarIds);
  },
});

/**
 * Push (or re-push) an activity within an Assignment. Mode can be
 * classFocus or homework. If the activity is already in the schedule,
 * its mode + timing get updated (idempotent — flipping in/out modes
 * works). endsAt is for classFocus auto-clear; dueAt is for homework.
 */
export const pushActivity = curriculumRunMutation({
  args: {
    assignmentId: v.id("assignments"),
    activityId: v.id("activities"),
    mode: v.optional(v.union(v.literal("classFocus"), v.literal("homework"))),
    finish: v.optional(giveFinishValidator),
    endsAt: v.optional(v.number()),
    // "Open until" (true) or "in that class" (false) for a raw class-focus
    // end (TRA-726). Optional: absent, the dates decide, as before.
    openUntilKind: v.optional(v.boolean()),
    dueAt: v.optional(v.number()),
    // Optional per-scholar targeting; subset of the roster, absent = all.
    scholarIds: v.optional(v.array(v.id("users"))),
    // Give the named scholars more time: add them to the live audience
    // rather than replacing it (see applyPushActivity).
    addToLiveAudience: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const a = await requireOwnedAssignment(ctx, args.assignmentId);
    if (!a) return;
    await requireRunnerScope(ctx, a, args.activityId);
    const { finish: _finish, ...rest } = args;
    await applyPushActivity(ctx, a, {
      ...rest,
      ...(await windowForAssignmentGive(ctx, a, {
        startsAt: Date.now(),
        answer: args,
        scholarIds: args.scholarIds,
        activityId: args.activityId,
        reuseLiveFinish: args.addToLiveAudience === true,
        startsNow: true,
      })),
    });
    // Start now, Extend and Give more time are answers too: a linked grid
    // cell must not reconcile them away.
    await detachPlacementsForGive(ctx, a._id, args.activityId);
  },
});

/**
 * PLAN a future push (calendar/agenda). Writes a *planned* entry —
 * `startsAt` set, `setAt` null — so it shows on the teacher's agenda
 * but is invisible to scholars until it goes live. If `startsAt` is in
 * the future, schedule an activation job (and store its id so we can
 * cancel/reschedule). If `startsAt` is in the PAST (e.g. a fat-finger),
 * we do NOT auto-activate — it sits planned until the teacher hits
 * "Start now". This is the safety property in review/calendar-view-plan.md.
 *
 * If the activity is ALREADY LIVE, re-scheduling re-times it but keeps it
 * live (`setAt` and any scholar-subset targeting preserved) — the same
 * postpone semantics as applyRescheduleActivity. Pulling live work back from
 * scholars is a separate, deliberate act (wrap/clear), never a side effect
 * of re-timing.
 */
export const scheduleActivity = curriculumRunMutation({
  args: {
    assignmentId: v.id("assignments"),
    activityId: v.id("activities"),
    mode: v.optional(v.union(v.literal("classFocus"), v.literal("homework"))),
    finish: v.optional(giveFinishValidator),
    startsAt: v.number(),
    endsAt: v.optional(v.number()),
    // "Open until" (true) or "in that class" (false) for a raw class-focus
    // end (TRA-726). Optional: absent, the dates decide, as before.
    openUntilKind: v.optional(v.boolean()),
    dueAt: v.optional(v.number()),
    // Optional per-scholar targeting; subset of the roster, absent = all.
    scholarIds: v.optional(v.array(v.id("users"))),
  },
  handler: (ctx, args) => coreScheduleActivity(ctx, args),
});

/** The scheduleActivity write, shared with the grid's give moves
 *  (gridGiveActions.moveGive) so a drag and the Run page behave alike. */
export async function coreScheduleActivity(
  ctx: MutationCtx & { user: Doc<"users"> },
  args: {
    assignmentId: Id<"assignments">;
    activityId: Id<"activities">;
    mode?: "classFocus" | "homework";
    finish?: GiveFinish;
    startsAt: number;
    endsAt?: number;
    openUntilKind?: boolean;
    dueAt?: number;
    scholarIds?: Id<"users">[];
  },
): Promise<void> {
  {
    // The grid drags a Homework due card through here, so a non-owner gets
    // the sentence (its toast), not a redacted "Server Error". Same owner rule
    // as requireOwnedAssignment below; it only changes the words.
    const owned = await ctx.db.get(args.assignmentId);
    if (owned && !(await mayActOnAssignment(ctx, ctx.user, owned))) {
      throw new ConvexError(NOT_YOUR_GIVE);
    }
    const a = await requireOwnedAssignment(ctx, args.assignmentId);
    if (!a) return;
    await requireRunnerScope(ctx, a, args.activityId);
    const resolve = (startsAt: number) =>
      windowForAssignmentGive(ctx, a, {
        startsAt,
        answer: args,
        scholarIds: args.scholarIds,
        activityId: args.activityId,
      });
    if (args.finish) {
      await applyGive(ctx, a, {
        activityId: args.activityId,
        startsAt: args.startsAt,
        resolve,
        scholarIds: args.scholarIds,
      });
      return;
    }
    await detachPlacementsForGive(ctx, a._id, args.activityId);
    const { finish: _finish, ...rest } = args;
    await applyScheduleActivity(ctx, a, {
      ...rest,
      ...(await resolve(args.startsAt)),
    });
  }
}

/**
 * Reschedule a planned entry to a new time. Cancels the old activation
 * job and (if the new time is in the future) schedules a fresh one.
 * No-op if there's no entry for this activity. If the entry is already
 * live (setAt stamped), this only moves its agenda position — it does
 * not un-push it.
 */
export const rescheduleActivity = curriculumRunMutation({
  args: {
    assignmentId: v.id("assignments"),
    activityId: v.id("activities"),
    startsAt: v.number(),
  },
  handler: async (ctx, args) => {
    const a = await requireOwnedAssignment(ctx, args.assignmentId);
    if (!a) return;
    await requireRunnerScope(ctx, a, args.activityId);
    await applyRescheduleActivity(ctx, a, args);
  },
});

/** Remove an activity from the schedule (clears both class focus and
 *  homework state for that activity within this Assignment). */
export const clearActivity = curriculumRunMutation({
  args: {
    assignmentId: v.id("assignments"),
    activityId: v.id("activities"),
  },
  handler: async (ctx, { assignmentId, activityId }) => {
    const a = await requireOwnedAssignment(ctx, assignmentId);
    if (!a) return;
    await requireRunnerScope(ctx, a, activityId);
    await applyClearActivity(ctx, a, activityId);
  },
});

export const archive = teacherMutation({
  args: { assignmentId: v.id("assignments") },
  handler: async (ctx, { assignmentId }) => {
    const a = await requireOwnedAssignment(ctx, assignmentId);
    if (!a) return;
    await applyArchive(ctx, a);
  },
});

export const unarchive = teacherMutation({
  args: { assignmentId: v.id("assignments") },
  handler: async (ctx, { assignmentId }) => {
    const a = await requireOwnedAssignment(ctx, assignmentId);
    if (!a) return;
    await ctx.db.patch(assignmentId, { archivedAt: undefined });
  },
});

// ─── Teacher reads ───────────────────────────────────────────────────

/**
 * List Assignments for the current teacher. Each row carries enough
 * for a list view: unit info, scholar count, project count, active
 * push counts (classFocus / homework).
 */
export const listForTeacher = curriculumRunQuery({
  args: { includeArchived: v.optional(v.boolean()) },
  handler: async (ctx, { includeArchived }) => {
    const now = Date.now();
    const timeZone = await timeZoneForStaff(ctx, ctx.user._id);
    const todayDayKey = dayKeyForTimezone(now, timeZone);
    const classLinkCache: ClassLinkReadCache = new Map();
    const rows = await runnableOwnedRows(
      ctx,
      ctx.user,
      await ctx.db
        .query("assignments")
        .withIndex("by_teacher", (q) => q.eq("teacherId", ctx.user._id))
        .collect(),
    );
    // This list view is unit-mode (unit info, activity push counts). Standing
    // (unitId-less) practice assignments have no unit/schedule to show here and
    // get their own surface, so they're filtered out. Ad-hoc dispatches
    // (kind "adHocDispatch") have no practiceMode, so they DEFAULT to "unit"
    // and stay in the list — teachers must see their dispatches — but they too
    // are unitId-less, so every unit read below must guard the optional unitId.
    const unitRows = rows.filter((r) => (r.practiceMode ?? "unit") === "unit");
    const active = includeArchived ? unitRows : unitRows.filter((r) => !r.archivedAt);
    active.sort((a, b) => b.startedAt - a.startedAt);
    return Promise.all(
      active.map(async (a) => {
        // Ad-hoc dispatches are unitId-less; guard the optional unitId.
        const unit = a.unitId ? await ctx.db.get(a.unitId) : null;
        const sessions = (await ctx.db
          .query("sessions")
          .withIndex("by_assignment", (q) => q.eq("assignmentId", a._id))
          .collect())
          // Offline projects are scanned-deliverable containers, not chat
          // sessions — exclude them from cohort rosters / counts / facepiles.
          .filter((p) => !p.isOffline);
        const schedule = await activeScheduleEntries(ctx, a, now, todayDayKey, timeZone);
        const { classFocusCount, openUntilCount, homeworkCount } =
          await liveGiveCounts(ctx, a, schedule, classLinkCache);
        // Tiny slice of scholar info for the facepile — first 5 + a
        // count so the UI can render "N more".
        const facepileLimit = 5;
        const facepile = await Promise.all(
          a.scholarIds.slice(0, facepileLimit).map(async (sid) => {
            const u = await ctx.db.get(sid);
            return {
              _id: sid,
              name: u?.name ?? u?.username ?? null,
              image: u?.image ?? null,
              username: u?.username ?? null,
            };
          }),
        );
        return {
          _id: a._id,
          // Ad-hoc dispatches have no unit; unitId is null for them.
          unitId: a.unitId ?? null,
          unitTitle: a.unitId
            ? (unit?.title ?? "(deleted unit)")
            : (a.title ?? "Ad-hoc dispatch"),
          unitEmoji: unit?.emoji ?? null,
          title: a.title ?? null,
          scholarCount: a.scholarIds.length,
          // Full roster — lets the schedule dialog auto-pick the
          // assignment matching the agenda's "View as" group/scholar.
          scholarIds: a.scholarIds,
          sessionCount: sessions.length,
          startedAt: a.startedAt,
          archivedAt: a.archivedAt ?? null,
          // Class focus not counting open-until gives (TRA-722).
          classFocusCount,
          openUntilCount,
          homeworkCount,
          facepile,
        };
      }),
    );
  },
});

/**
 * Assignments of a single Unit — active + archived (split by the
 * caller via `archivedAt`). Drives the "Assignments" section in the
 * Curriculum unit-preview pane: the Design surface lists the runs of a
 * unit (active above, past collapsed below) and offers an Assign CTA,
 * instead of conflating live class progress into the design view.
 *
 * Same per-row shape as `listForTeacher` so the row UI is shared.
 */
export const listForUnit = curriculumRunQuery({
  args: { unitId: v.id("units") },
  handler: async (ctx, { unitId }) => {
    const now = Date.now();
    const timeZone = await timeZoneForStaff(ctx, ctx.user._id);
    const todayDayKey = dayKeyForTimezone(now, timeZone);
    const classLinkCache: ClassLinkReadCache = new Map();
    const rows = await ctx.db
      .query("assignments")
      .withIndex("by_unit", (q) => q.eq("unitId", unitId))
      .collect();
    // Scope to the runs the caller may manage: their own, plus every run at
    // a school they administer (lib/assignmentAuthority.ts), so a Head of
    // School can reach another teacher's run from the unit page.
    const scope = await assignmentAdminScope(ctx, ctx.user);
    const manageable: Doc<"assignments">[] = [];
    for (const r of rows) {
      if (await mayActOnAssignment(ctx, ctx.user, r, scope)) manageable.push(r);
    }
    const mine = await runnableOwnedRows(ctx, ctx.user, manageable);
    // Active first (newest → oldest), then archived (newest → oldest).
    mine.sort((a, b) => {
      const aArch = a.archivedAt ? 1 : 0;
      const bArch = b.archivedAt ? 1 : 0;
      if (aArch !== bArch) return aArch - bArch;
      return b.startedAt - a.startedAt;
    });
    return Promise.all(
      mine.map(async (a) => {
        // Safe: queried via by_unit with a required unitId arg, so every
        // matched row has unitId defined.
        const unit = await ctx.db.get(a.unitId!);
        const sessions = (await ctx.db
          .query("sessions")
          .withIndex("by_assignment", (q) => q.eq("assignmentId", a._id))
          .collect())
          // Offline projects are scanned-deliverable containers, not chat
          // sessions — exclude them from cohort rosters / counts / facepiles.
          .filter((p) => !p.isOffline);
        const schedule = await activeScheduleEntries(ctx, a, now, todayDayKey, timeZone);
        const { classFocusCount, openUntilCount, homeworkCount } =
          await liveGiveCounts(ctx, a, schedule, classLinkCache);
        const facepileLimit = 5;
        const facepile = await Promise.all(
          a.scholarIds.slice(0, facepileLimit).map(async (sid) => {
            const u = await ctx.db.get(sid);
            return {
              _id: sid,
              name: u?.name ?? u?.username ?? null,
              image: u?.image ?? null,
              username: u?.username ?? null,
            };
          }),
        );
        return {
          _id: a._id,
          // Safe: queried via by_unit with a required unitId arg.
          unitId: a.unitId!,
          unitTitle: unit?.title ?? "(deleted unit)",
          unitEmoji: unit?.emoji ?? null,
          title: a.title ?? null,
          scholarCount: a.scholarIds.length,
          // Full roster — lets the schedule dialog auto-pick the
          // assignment matching the agenda's "View as" group/scholar.
          scholarIds: a.scholarIds,
          sessionCount: sessions.length,
          startedAt: a.startedAt,
          archivedAt: a.archivedAt ?? null,
          // Class focus not counting open-until gives (TRA-722).
          classFocusCount,
          openUntilCount,
          homeworkCount,
          facepile,
        };
      }),
    );
  },
});

/**
 * The assignee picker for a curriculum:run holder (lib/curriculumRun.ts):
 * identity only — name, username, avatar, enrolled vs Extended Education —
 * for scholars at the school that owns `unitId` (or every school where she
 * holds the grant, before a unit is picked). Teachers keep `users.listScholars`;
 * this returns [] for them so the two pickers never mix.
 */
export const assignableScholarsForRunner = curriculumRunQuery({
  args: { unitId: v.optional(v.id("units")) },
  handler: async (ctx, { unitId }) => {
    if (isTeacherRole(ctx.user.role)) return [];
    if (unitId) {
      const { institutionId } = await requireRunnableUnit(
        ctx,
        ctx.user,
        unitId,
      );
      return await runnerAssignableScholars(ctx, [institutionId]);
    }
    return await runnerAssignableScholars(
      ctx,
      await curriculumRunInstitutionIds(ctx, ctx.user._id),
    );
  },
});

/**
 * Active pushes across all the teacher's assignments — flattened to
 * one entry per (assignment, activity) push. Drives the Class
 * sub-tab's left panel (list of every push happening right now).
 */
export const activePushesForTeacher = teacherQuery({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const rows = await ctx.db
      .query("assignments")
      .withIndex("by_teacher", (q) => q.eq("teacherId", ctx.user._id))
      .collect();
    // Computed once — same teacher for every row in this list.
    const timeZone = await timeZoneForStaff(ctx, ctx.user._id);
    const todayDayKey = dayKeyForTimezone(now, timeZone);
    const out: Array<{
      assignmentId: Id<"assignments">;
      activityId: Id<"activities">;
      activityTitle: string;
      activityKind: string;
      lessonId: Id<"lessons"> | null;
      lessonTitle: string | null;
      unitId: Id<"units"> | null;
      unitTitle: string;
      unitEmoji: string | null;
      mode: "classFocus" | "homework";
      setAt: number;
      endsAt: number | null;
      dueAt: number | null;
      /** Stored as the `openUntil` timing kind (TRA-726), for `giveBadge`. */
      openUntilKind: boolean;
      scholarCount: number;
      timeZone: string;
    }> = [];
    for (const a of rows) {
      if (a.archivedAt) continue;
      // Standing (unitId-less) practice assignments never populate
      // activitySchedule, so `entries` is empty for them. Ad-hoc dispatches
      // (kind "adHocDispatch") DO populate a schedule yet are also unitId-less,
      // so guard the optional unitId and don't assume a unit exists.
      const unit = a.unitId ? await ctx.db.get(a.unitId) : null;
      const entries = await activeScheduleEntries(ctx, a, now, todayDayKey, timeZone);
      for (const e of entries) {
        const act = await ctx.db.get(e.activityId);
        const lesson = act?.lessonId ? await ctx.db.get(act.lessonId) : null;
        out.push({
          assignmentId: a._id,
          activityId: e.activityId,
          activityTitle: act?.title ?? "(deleted activity)",
          activityKind: act?.kind ?? "online",
          lessonId: act?.lessonId ?? null,
          lessonTitle: lesson?.title ?? null,
          // Null for ad-hoc dispatches (no unit).
          unitId: a.unitId ?? null,
          unitTitle: a.unitId
            ? (unit?.title ?? "Unknown")
            : (a.title ?? "Ad-hoc dispatch"),
          unitEmoji: unit?.emoji ?? null,
          mode: e.mode,
          // Live entries only (setAt stamped); coerce for the checker.
          setAt: e.setAt ?? e.startsAt ?? 0,
          endsAt: e.endsAt ?? null,
          dueAt: e.dueAt ?? null,
          openUntilKind: e.openUntilKind === true,
          scholarCount: a.scholarIds.length,
          timeZone,
        });
      }
    }
    out.sort((x, y) => y.setAt - x.setAt);
    return out;
  },
});

/** A scholar still visibly working when a class-focus push turned. Names
 *  only — no durations, no red — the teacher's quiet awareness, never a
 *  countdown or a nag. See lingeringScholarsForPush. */
const LINGERING_WINDOW_MS = 15 * 60 * 1000;

/**
 * "Still finishing their thought" — the lingering-awareness line for item 4
 * of "the turn, not the bell". Given an assignment + activity that WAS (or
 * still is) a class focus, returns the scholars whose session on that
 * activity is recent and unfinished — i.e. still open, not completed. This
 * composes the EXISTING `sessions` data (the `by_activity` index) rather than
 * tracking any new "who's live" state: no presence pings, just "did they
 * touch this activity's session in the last 15 minutes and not finish it."
 * The caller decides WHEN to show this (typically right after a push
 * disappears from `activePushesForTeacher` — "just turned").
 */
export const lingeringScholarsForPush = curriculumRunQuery({
  args: {
    assignmentId: v.id("assignments"),
    activityId: v.id("activities"),
  },
  handler: async (ctx, { assignmentId, activityId }) => {
    // Names of her own cohort still mid-activity — progress on an assignment
    // she owns, so a curriculum:run owner reads it too.
    const a = await requireOwnedAssignment(ctx, assignmentId);
    if (!a) return [];
    if (!(await ownedAssignmentForRead(ctx, assignmentId))) return [];
    const now = Date.now();
    const sessions = await ctx.db
      .query("sessions")
      .withIndex("by_activity", (q) => q.eq("activityId", activityId))
      .collect();
    const lingering = sessions.filter(
      (s) =>
        String(s.assignmentId ?? "") === String(assignmentId) &&
        !s.isArchived &&
        !s.isTestDrive &&
        !s.isOffline &&
        !s.activityCompletedAt &&
        s.lastMessageAt != null &&
        now - s.lastMessageAt <= LINGERING_WINDOW_MS,
    );
    const out: Array<{ scholarId: Id<"users">; name: string }> = [];
    for (const s of lingering) {
      const scholar = await ctx.db.get(s.userId);
      if (!scholar) continue;
      out.push({ scholarId: s.userId, name: scholar.name ?? "Scholar" });
    }
    return out;
  },
});

/**
 * Weekly-agenda feed: every live OR planned activity push across the
 * teacher's active assignments, flattened to one item per (assignment,
 * activity), optionally windowed to [from, to) by the time we'd place
 * it on the agenda (startsAt, falling back to setAt). Drives the
 * Calendar/Agenda view. Each item carries its completion roll-up and a
 * derived `state` (planned | live | done).
 */
export const scheduleForTeacher = teacherQuery({
  args: {
    from: v.optional(v.number()),
    to: v.optional(v.number()),
    // "View as" filter: when set, only include items whose assignment
    // roster intersects these scholars (a group's members, or a single
    // scholar). Omit / empty = everyone.
    scholarIds: v.optional(v.array(v.id("users"))),
  },
  handler: async (ctx, { from, to, scholarIds }) => {
    const now = Date.now();
    const timeZone = await timeZoneForStaff(ctx, ctx.user._id);
    const todayDayKey = dayKeyForTimezone(now, timeZone);
    const filterSet =
      scholarIds && scholarIds.length > 0
        ? new Set(scholarIds.map(String))
        : null;
    const rows = await ctx.db
      .query("assignments")
      .withIndex("by_teacher", (q) => q.eq("teacherId", ctx.user._id))
      .collect();
    const out: Array<{
      assignmentId: Id<"assignments">;
      activityId: Id<"activities">;
      activityTitle: string;
      activityKind: string;
      lessonId: Id<"lessons"> | null;
      lessonTitle: string | null;
      unitId: Id<"units"> | null;
      unitTitle: string;
      unitEmoji: string | null;
      assignmentTitle: string | null;
      mode: "classFocus" | "homework";
      // Agenda position: startsAt if planned/known, else setAt.
      agendaAt: number;
      startsAt: number | null;
      setAt: number | null;
      endsAt: number | null;
      dueAt: number | null;
      scholarCount: number;
      completedCount: number;
      state: "planned" | "live" | "done";
    }> = [];
    for (const a of rows) {
      if (a.archivedAt) continue;
      if (filterSet && !a.scholarIds.some((id) => filterSet.has(String(id))))
        continue;
      const entries = await readSchedule(ctx, a);
      if (entries.length === 0) continue;
      // Ad-hoc dispatches (kind "adHocDispatch") DO carry an activitySchedule
      // yet are unitId-less, so a populated schedule no longer implies a unit —
      // guard the optional unitId instead of asserting it.
      const unit = a.unitId ? await ctx.db.get(a.unitId) : null;
      // Completion roll-up for this assignment, keyed by activity.
      const completions = await ctx.db
        .query("activityCompletions")
        .withIndex("by_assignment", (q) => q.eq("assignmentId", a._id))
        .collect();
      const doneByActivity = new Map<string, Set<string>>();
      for (const c of completions) {
        const key = String(c.activityId);
        if (!doneByActivity.has(key)) doneByActivity.set(key, new Set());
        doneByActivity.get(key)!.add(String(c.scholarId));
      }
      const rosterSize = a.scholarIds.length;
      for (const e of entries) {
        const agendaAt = e.startsAt ?? e.setAt ?? a.startedAt;
        if (from != null && agendaAt < from) continue;
        if (to != null && agendaAt >= to) continue;
        const act = await ctx.db.get(e.activityId);
        const lesson = act?.lessonId ? await ctx.db.get(act.lessonId) : null;
        const completedCount = doneByActivity.get(String(e.activityId))?.size ?? 0;
        const allDone = rosterSize > 0 && completedCount >= rosterSize;
        const showing =
          e.mode === "classFocus"
            ? isEntryShowing(e, now, todayDayKey, timeZone)
            : isLiveEntry(e, now);
        const state: "planned" | "live" | "done" =
          e.setAt == null ? "planned" : allDone || !showing ? "done" : "live";
        out.push({
          assignmentId: a._id,
          activityId: e.activityId,
          activityTitle: act?.title ?? "(deleted activity)",
          activityKind: act?.kind ?? "online",
          lessonId: act?.lessonId ?? null,
          lessonTitle: lesson?.title ?? null,
          // Null for ad-hoc dispatches (no unit).
          unitId: a.unitId ?? null,
          unitTitle: a.unitId
            ? (unit?.title ?? "Unknown")
            : (a.title ?? "Ad-hoc dispatch"),
          unitEmoji: unit?.emoji ?? null,
          assignmentTitle: a.title ?? null,
          mode: e.mode,
          agendaAt,
          startsAt: e.startsAt ?? null,
          setAt: e.setAt ?? null,
          endsAt: e.endsAt ?? null,
          dueAt: e.dueAt ?? null,
          scholarCount: rosterSize,
          completedCount,
          state,
        });
      }
    }
    out.sort((x, y) => x.agendaAt - y.agendaAt);
    return out;
  },
});

/** Full read of an Assignment — roster + unit + scheduling state. */
export const get = curriculumRunQuery({
  args: { assignmentId: v.id("assignments") },
  handler: async (ctx, { assignmentId }) => {
    const now = Date.now();
    const focusTimeZone = await timeZoneForStaff(ctx, ctx.user._id);
    const todayDayKey = dayKeyForTimezone(now, focusTimeZone);
    const owned = await ownedAssignmentForRead(ctx, assignmentId);
    if (!owned) return null;
    const { a, isTeacher } = owned;
    // A standing (unitId-less) assignment has no unit to resolve.
    const unit = a.unitId ? await ctx.db.get(a.unitId) : null;
    const sessions = (await ctx.db
      .query("sessions")
      .withIndex("by_assignment", (q) => q.eq("assignmentId", a._id))
      .collect())
      // Offline projects (scanned-deliverable containers) have no chat — a
      // scholar may have both, so exclude offline ones or they'd shadow the
      // real chat project in this per-scholar map (blank last-message, etc.).
      .filter((p) => !p.isOffline);
    const sessionsByScholar = new Map(sessions.map((p) => [String(p.userId), p]));
    const scholars = await Promise.all(
      a.scholarIds.map((sid) => ctx.db.get(sid)),
    );
    const roster = await Promise.all(
      a.scholarIds.map(async (sid, index) => {
        const s = scholars[index];
        const session = sessionsByScholar.get(String(sid)) ?? null;
        const lastMsg = session
          ? await ctx.db
              .query("messages")
              .withIndex("by_session", (q) => q.eq("sessionId", session._id))
              .order("desc")
              .first()
          : null;
        const completions = await ctx.db
          .query("activityCompletions")
          .withIndex("by_scholar_assignment", (q) =>
            q.eq("scholarId", sid).eq("assignmentId", a._id),
          )
          .collect();
        return {
          scholarId: sid,
          name: s?.name ?? s?.username ?? "(unknown)",
          username: s?.username ?? null,
          image: s?.image ?? null,
          // Teacher-only: reading level is learning record, and the session
          // id + message preview open the transcript. A curriculum:run owner
          // gets progress (started / last active / completions), not those.
          readingLevel: isTeacher ? talkLevelOf(s?.readingLevel) : null,
          sessionId: isTeacher ? (session?._id ?? null) : null,
          sessionStartedAt: session?._creationTime ?? null,
          lastMessageAt: lastMsg?._creationTime ?? null,
          lastMessagePreview:
            isTeacher && lastMsg ? lastMsg.content.slice(0, 120) : null,
          completedActivityCount: completions.length,
        };
      }),
    );
    const schedule = await readSchedule(ctx, a);
    const active = await activeScheduleEntries(
      ctx,
      a,
      now,
      todayDayKey,
      focusTimeZone,
    );
    const scholarInstitutionIds = await Promise.all(
      scholars.map((scholar) =>
        scholar ? scholarInstitutionId(ctx, scholar._id) : undefined,
      ),
    );
    const institutionIds = new Set(
      scholarInstitutionIds.filter(
        (institutionId): institutionId is Id<"institutions"> =>
          institutionId !== undefined,
      ),
    );
    const assignmentInstitutionId =
      institutionIds.size === 1 &&
      scholarInstitutionIds.every((institutionId) => institutionId !== undefined)
        ? [...institutionIds][0]
        : null;
    const assignmentInstitution = assignmentInstitutionId
      ? await ctx.db.get(assignmentInstitutionId)
      : null;
    // Legacy rosters predate institutions and share the legacy default clock.
    // Empty, missing, or mixed rosters stay null so the UI omits date-derived
    // wording instead of borrowing another cohort's calendar.
    const legacyRoster =
      scholars.length > 0 &&
      scholarInstitutionIds.every((institutionId) => !institutionId);
    const timeZone = legacyRoster
      ? DEFAULT_TIMEZONE
      : assignmentInstitution
        ? effectiveInstitutionTimeZone(assignmentInstitution.timeZone)
        : null;
    return {
      _id: a._id,
      unitId: a.unitId,
      unitTitle: unit?.title ?? null,
      unitEmoji: unit?.emoji ?? null,
      unitDescription: unit?.description ?? null,
      title: a.title ?? null,
      scholarIds: a.scholarIds,
      startedAt: a.startedAt,
      archivedAt: a.archivedAt ?? null,
      schedule,
      // Old response key, derived from the rows (the schema field is gone).
      // Compatibility for long-lived tabs; remove after 2026-12-01.
      activitySchedule: schedule,
      // The chip and every other teacher "live" surface share the same
      // institution-day focus predicate as the scholar.
      // Counted by finish: class focus not counting open-until gives, which
      // have their own count (TRA-722).
      ...(await liveGiveCounts(ctx, a, active, new Map())),
      // The partition counts deliberately do not use the showing predicate. "Was
      // this sent, or is it still planned?" is one bit — `setAt` — and every
      // surface that answers it must read that same bit, or the header and
      // the outline start telling the teacher different stories about one
      // row. That was the original bug (header "nothing pushed yet" over
      // rows badged as sent), and using `active` here would have quietly
      // recreated it from the other side: an expired focus remains sent even
      // after it leaves the live count.
      //
      // INVARIANT, asserted in calendarScheduling.test.ts:
      //   sentCount + plannedCount === activitySchedule.length
      sentCount: schedule.filter((e) => e.setAt != null).length,
      plannedCount: schedule.filter((e) => e.setAt == null).length,
      timeZone,
      roster,
    };
  },
});

/** Institution-calendar due-date choices for the Run page and full editor. */
export const homeworkDueDateOptions = curriculumRunQuery({
  args: {
    assignmentId: v.id("assignments"),
    nowMs: v.number(),
  },
  handler: async (ctx, { assignmentId, nowMs }) => {
    const assignment = await requireOwnedAssignment(ctx, assignmentId);
    if (!assignment) return null;
    if (!(await ownedAssignmentForRead(ctx, assignmentId))) return null;
    return await homeworkDueDateOptionsForRoster(
      ctx,
      assignment.scholarIds,
      nowMs,
      await homeworkInstitutionForAssignment(ctx, assignment),
    );
  },
});

/** The active assignment a give would find-or-create onto (coreAssignWork's
 *  key: same teacher, same unit, same exact roster). */
export async function findReusableAssignment(
  ctx: QueryCtx,
  teacherId: Id<"users">,
  unitId: Id<"units">,
  roster: readonly Id<"users">[],
): Promise<Doc<"assignments"> | null> {
  const rosterSet = new Set(roster.map(String));
  const mine = await ctx.db
    .query("assignments")
    .withIndex("by_teacher", (q) => q.eq("teacherId", teacherId))
    .collect();
  return (
    mine.find(
      (a) =>
        !a.archivedAt &&
        a.unitId === unitId &&
        a.scholarIds.length === rosterSet.size &&
        a.scholarIds.every((id) => rosterSet.has(String(id))),
    ) ?? null
  );
}

/**
 * The choices the give form offers (TRA-571): upcoming bell blocks for "Shows
 * up", and for "Finish" when "in that class" ends, due-day suggestions, and
 * what "by the end of the unit" means. Pass `assignmentId` for a give on an
 * existing assignment, or `unitId` + `scholarIds` for one that may create it.
 * `nowMs` is the client's minute-rounded clock (T11).
 */
export const giveChoices = curriculumRunQuery({
  args: {
    assignmentId: v.optional(v.id("assignments")),
    unitId: v.optional(v.id("units")),
    scholarIds: v.optional(v.array(v.id("users"))),
    activityId: v.optional(v.id("activities")),
    nowMs: v.number(),
    startsAt: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    let assignment: Doc<"assignments"> | null = null;
    if (args.assignmentId) {
      const owned = await ownedAssignmentForRead(ctx, args.assignmentId);
      if (!owned) return null;
      assignment = owned.a;
    }
    const scope = await authorizeGiveRoster(ctx, ctx.user, {
      assignment,
      unitId: args.unitId,
      scholarIds: args.scholarIds,
    });
    if (!scope) return null;
    // A refusal is a state the give form shows, never a thrown query error
    // that would take the page down with it.
    if ("refused" in scope) return { refused: scope.refused };
    const choices = await giveChoicesFor(ctx, {
      ...scope,
      nowMs: args.nowMs,
      startsAt: args.startsAt,
      excludeActivityId: args.activityId,
    });
    const filed = await filedUnderFor(ctx, scope, args.startsAt ?? args.nowMs,
      { assignmentId: assignment?._id, unitId: args.unitId });
    return filed ? { ...choices, ...filed } : choices;
  },
});

/**
 * For classwork showing up at `at`: the class it is filed under, when that
 * isn't the class meeting then (its unit's subject's class, TRA-725), and the
 * class meeting then, if any, so the form can say where it shows and where it
 * is filed. Null when it is filed under the class meeting then, or under
 * nothing. Asks exactly what the writer asks (lib/scheduleStore:
 * `classFieldsForPush` with `unitSubjectForWork`, at the give's start), and
 * compares classes by id. Classwork only: the form leaves it off homework,
 * whose class can be chosen.
 */
async function filedUnderFor(
  ctx: QueryCtx,
  scope: { scholarIds: Id<"users">[]; institutionId: Id<"institutions"> | undefined; timeZone: string },
  at: number,
  work: { assignmentId?: Id<"assignments">; unitId?: Id<"units"> },
): Promise<{ filedUnder: string; filedShownIn: string | null } | null> {
  const institutionId = scope.institutionId;
  if (!institutionId) return null;
  const unitSubject = await unitSubjectForWork(ctx, work);
  if (!unitSubject) return null;
  const audience = { kind: "scholars" as const, scholarIds: scope.scholarIds };
  const cache: ClassLinkReadCache = new Map();
  const { classId } = await classFieldsForPush(ctx, {
    institutionId, audience, at, timeZone: scope.timeZone, timingKind: "focus", unitSubject,
  }, cache);
  if (!classId) return null;
  const meeting = await classMeetingForGive(ctx, {
    institutionId, at, timeZone: scope.timeZone,
    groupIds: await audienceGroupIds(ctx, { institutionId, audience }, cache),
  }, cache);
  if (meeting?.classId === classId) return null;
  const filed = await ctx.db.get(classId);
  const shownIn = meeting ? await ctx.db.get(meeting.classId) : null;
  return filed ? { filedUnder: filed.subject, filedShownIn: shownIn?.subject ?? null } : null;
}

/** The aide's twin of `giveChoices`, for the question a give tool asks when
 *  an answer is missing. Authorized exactly like the web query, for the
 *  verified caller. */
export const aideGiveChoices = internalQuery({
  args: {
    callerUserId: v.id("users"),
    assignmentId: v.optional(v.id("assignments")),
    scholarIds: v.optional(v.array(v.id("users"))),
    unitId: v.optional(v.id("units")),
    activityId: v.optional(v.id("activities")),
    startsAt: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const caller = await ctx.db.get(args.callerUserId);
    if (!caller) return null;
    let assignment: Doc<"assignments"> | null = null;
    if (args.assignmentId) {
      assignment = await requireOwnedAssignmentBy(
        ctx,
        args.assignmentId,
        args.callerUserId,
      );
      if (!assignment) return null;
    }
    const scope = await authorizeGiveRoster(ctx, caller, {
      assignment,
      unitId: args.unitId,
      scholarIds: args.scholarIds,
    });
    // A refused roster reads as "no choices"; the write that follows reports
    // the real refusal.
    if (!scope || "refused" in scope) return null;
    return await giveChoicesFor(ctx, {
      ...scope,
      // t11-ok: an internal query only aide actions call, once per tool call.
      nowMs: Date.now(),
      startsAt: args.startsAt,
      excludeActivityId: args.activityId,
    });
  },
});

/**
 * The roster a give's choices may describe, authorized for the caller BEFORE
 * anything about those scholars is read (their groups, bell schedule, school
 * calendar). It never throws: the give form renders from this.
 *
 *   - The assignment's own roster (no explicit scholars): narrowed to the
 *     scholars the caller can reach right now. A real roster can hold someone
 *     she can't (a transferred scholar, an Extended Education guest, a group
 *     shared with another teacher); the choices then describe only the ones
 *     she can, never more. Nobody reachable → refused.
 *   - Explicit scholars (a narrower roster, a unit give, a dispatch): every
 *     one must be on the assignment's roster (if any) and reachable now, or
 *     the whole request is refused — named scholars fail loudly, not vanish.
 *
 * A teacher's reach is `canUserAccessScholar`; a curriculum:run holder's is a
 * unit she can still run and scholars at its school.
 */
async function authorizeGiveRoster(
  ctx: QueryCtx,
  caller: Doc<"users">,
  args: {
    assignment: Doc<"assignments"> | null;
    unitId?: Id<"units">;
    scholarIds?: Id<"users">[];
  },
): Promise<
  | {
      scholarIds: Id<"users">[];
      institutionId: Id<"institutions"> | undefined;
      timeZone: string;
      schedule: ReadonlyArray<ScheduleEntry> | undefined;
    }
  | { refused: string }
  | null
> {
  const REFUSED = "You can't give work to those scholars from here.";
  const explicit = args.scholarIds?.length ? args.scholarIds : null;
  let assignment = args.assignment;
  if (!assignment && !explicit) return null;

  // Where the caller's reach is measured, and who is in it.
  let institutionId: Id<"institutions"> | undefined;
  let reachable: (ids: Id<"users">[]) => Promise<Id<"users">[]>;
  if (isTeacherRole(caller.role)) {
    reachable = (ids) => filterToAccessibleScholars(ctx, caller, ids);
    const unitId = assignment?.unitId ?? args.unitId;
    const unit = unitId ? await ctx.db.get(unitId) : null;
    institutionId = assignment
      ? await homeworkInstitutionForAssignment(ctx, assignment)
      : (unit?.institutionId ??
        (await resolveActiveMembership(ctx, caller))?.institutionId);
  } else {
    const unitId = assignment?.unitId ?? args.unitId;
    if (!unitId) return null;
    try {
      institutionId = (await requireRunnableUnit(ctx, caller, unitId))
        .institutionId;
    } catch {
      return { refused: REFUSED };
    }
    const runInstitution = institutionId;
    reachable = async (ids) => {
      const out: Id<"users">[] = [];
      for (const id of ids) {
        if ((await scholarInstitutionId(ctx, id)) === runInstitution) {
          out.push(id);
        }
      }
      return out;
    };
  }

  let roster: Id<"users">[];
  if (explicit) {
    if (assignment) {
      const onRoster = new Set(assignment.scholarIds.map(String));
      if (explicit.some((id) => !onRoster.has(String(id)))) {
        return { refused: "Those scholars aren't on this assignment's roster." };
      }
    }
    if ((await reachable(explicit)).length !== explicit.length) {
      return { refused: REFUSED };
    }
    roster = explicit;
  } else {
    roster = await reachable(assignment!.scholarIds);
    if (roster.length === 0) return { refused: REFUSED };
  }

  if (!args.assignment && args.unitId) {
    assignment = await findReusableAssignment(
      ctx,
      caller._id,
      args.unitId,
      roster,
    );
  }
  const { timeZone } = await homeworkCalendarForRoster(
    ctx,
    roster,
    institutionId,
  );
  return {
    scholarIds: roster,
    institutionId,
    timeZone,
    schedule: assignment ? await readSchedule(ctx, assignment) : undefined,
  };
}

/**
 * Per-activity progress for an Assignment — completion roll-up + the
 * current schedule entry (or null) for each activity. Drives the Run
 * page's outline with push/clear controls.
 */
export const activityProgress = curriculumRunQuery({
  args: { assignmentId: v.id("assignments") },
  handler: async (ctx, { assignmentId }) => {
    const owned = await ownedAssignmentForRead(ctx, assignmentId);
    if (!owned) return null;
    const { a } = owned;
    const schedule = await readSchedule(ctx, a);
    // One entry per activity, by the shared rule (never insertion order).
    const scheduleByActivity = decidingEntryByActivity(schedule, Date.now()); // t11-ok: picks which entry to show; a live entry turning expired re-renders on the next schedule write or reload
    const completions = await ctx.db
      .query("activityCompletions")
      .withIndex("by_assignment", (q) => q.eq("assignmentId", assignmentId))
      .collect();
    const doneByActivity = new Map<string, Set<string>>();
    // The scholars who marked it done THEMSELVES (TRA-458) — the Done line's
    // "marked it" chip. Same completion rows, so counts are unchanged.
    const selfMarkedByActivity = new Map<
      string,
      Array<{ scholarId: Id<"users">; completedAt: number }>
    >();
    for (const c of completions) {
      const key = String(c.activityId);
      if (!doneByActivity.has(key)) doneByActivity.set(key, new Set());
      doneByActivity.get(key)!.add(String(c.scholarId));
      if (isScholarHomeworkMark(c)) {
        const marks = selfMarkedByActivity.get(key) ?? [];
        marks.push({ scholarId: c.scholarId, completedAt: c.completedAt });
        selfMarkedByActivity.set(key, marks);
      }
    }
    if (!a.unitId) {
      // A standing (unitId-less) assignment has no lessons to roll up. An
      // ad-hoc dispatch has no lessons either, but its schedule IS its outline
      // — without it the teacher could never see (or undo) who finished a
      // one-scholar read-aloud or video link.
      const adHocActivities =
        a.kind === "adHocDispatch"
          ? (
              await Promise.all(
                schedule.map(async (entry) => {
                  const act = await ctx.db.get(entry.activityId);
                  if (!act) return null;
                  const done = doneByActivity.get(String(act._id)) ?? new Set();
                  return {
                    activityId: act._id,
                    title: act.title,
                    kind: act.kind,
                    completedScholarIds: Array.from(done),
                    selfMarked: selfMarkedByActivity.get(String(act._id)) ?? [],
                    doneCount: done.size,
                    inProgressCount: 0,
                    notStartedCount: Math.max(
                      0,
                      a.scholarIds.length - done.size,
                    ),
                    schedule: {
                      mode: entry.mode,
                      setAt: entry.setAt ?? null,
                      startsAt: entry.startsAt ?? null,
                      planned: entry.setAt == null,
                      endsAt: entry.endsAt ?? null,
                      dueAt: entry.dueAt ?? null,
                      // Same shape as a lesson row's schedule (TRA-726).
                      openUntilKind: entry.openUntilKind ?? null,
                      scholarIds: entry.scholarIds ?? null,
                    },
                  };
                }),
              )
            ).filter((row): row is NonNullable<typeof row> => row !== null)
          : [];
      return {
        rosterSize: a.scholarIds.length,
        lessons: [],
        adHocActivities,
      };
    }
    const lessons = await ctx.db
      .query("lessons")
      .withIndex("by_unit", (q) => q.eq("unitId", a.unitId!))
      .collect();
    lessons.sort((x, y) => x.order - y.order);
    // "Started" = the scholar has a (non-offline) project for this activity
    // in this assignment, whether or not they've finished. Lets the row show
    // a three-way read (done / in progress / not started) on existing data —
    // no AI, no observer. Completions can land without a project (manual
    // teacher mark), so we union the two sets below.
    const startedByActivity = new Map<string, Set<string>>();
    const assignmentSessions = (
      await ctx.db
        .query("sessions")
        .withIndex("by_assignment", (q) => q.eq("assignmentId", assignmentId))
        .collect()
    ).filter((p) => !p.isOffline && p.activityId);
    for (const p of assignmentSessions) {
      const key = String(p.activityId);
      if (!startedByActivity.has(key)) startedByActivity.set(key, new Set());
      startedByActivity.get(key)!.add(String(p.userId));
    }
    const out = await Promise.all(
      lessons.map(async (l) => {
        const acts = await ctx.db
          .query("activities")
          .withIndex("by_lesson", (q) => q.eq("lessonId", l._id))
          .collect();
        acts.sort((x, y) => x.order - y.order);
        return {
          lessonId: l._id,
          lessonTitle: l.title,
          activities: acts.map((act) => {
            const entry = scheduleByActivity.get(String(act._id)) ?? null;
            const done = doneByActivity.get(String(act._id)) ?? new Set();
            const startedOrDone = new Set([
              ...(startedByActivity.get(String(act._id)) ?? []),
              ...done,
            ]);
            const doneCount = done.size;
            const notStartedCount = Math.max(
              0,
              a.scholarIds.length - startedOrDone.size,
            );
            const inProgressCount = Math.max(
              0,
              startedOrDone.size - doneCount,
            );
            return {
              activityId: act._id,
              title: act.title,
              kind: act.kind,
              completedScholarIds: Array.from(done),
              selfMarked: selfMarkedByActivity.get(String(act._id)) ?? [],
              doneCount,
              inProgressCount,
              notStartedCount,
              schedule: entry
                ? {
                    mode: entry.mode,
                    // setAt null = planned (not yet live to scholars).
                    setAt: entry.setAt ?? null,
                    startsAt: entry.startsAt ?? null,
                    planned: entry.setAt == null,
                    endsAt: entry.endsAt ?? null,
                    dueAt: entry.dueAt ?? null,
                    // Stored as the `openUntil` kind (TRA-726), for
                    // `isOpenUntil` on the Run page.
                    openUntilKind: entry.openUntilKind ?? null,
                    // Who it's aimed at (absent = the whole roster). The Run
                    // page's "Start now" hands these straight back to
                    // pushActivity so releasing a planned entry keeps its
                    // audience instead of silently widening it to everyone.
                    scholarIds: entry.scholarIds ?? null,
                  }
                : null,
            };
          }),
        };
      }),
    );
    return { rosterSize: a.scholarIds.length, lessons: out, adHocActivities: [] };
  },
});

/** Compatibility shim for CompletedActivityDetail. */
export const getForReview = teacherQuery({
  args: { assignmentId: v.id("assignments") },
  handler: async (ctx, { assignmentId }) => {
    const a = await ctx.db.get(assignmentId);
    if (!a || !(await mayActOnAssignment(ctx, ctx.user, a))) return null;
    // A standing (unitId-less) assignment has no unit/process to resolve.
    const unit = a.unitId ? await ctx.db.get(a.unitId) : null;
    const processId = unit?.processId ?? null;
    const process = processId ? await ctx.db.get(processId) : null;
    const sessions = (await ctx.db
      .query("sessions")
      .withIndex("by_assignment", (q) => q.eq("assignmentId", assignmentId))
      .collect())
      // Exclude offline (scanned-deliverable) projects — no live session.
      .filter((p) => !p.isOffline);
    const scholars = await Promise.all(
      sessions.map(async (proj) => {
        const scholar = await ctx.db.get(proj.userId);
        const lastMsg = await ctx.db
          .query("messages")
          .withIndex("by_session", (q) => q.eq("sessionId", proj._id))
          .order("desc")
          .first();
        const procState = await ctx.db
          .query("processState")
          .withIndex("by_session", (q) => q.eq("sessionId", proj._id))
          .first();
        return {
          scholarId: proj.userId,
          sessionId: proj._id,
          sessionCreatedAt: proj._creationTime,
          name: scholar?.name ?? null,
          image: scholar?.image ?? null,
          readingLevel: talkLevelOf(scholar?.readingLevel),
          dateOfBirth: scholar?.dateOfBirth ?? null,
          pulseScore: proj.pulseScore ?? null,
          lastMessageAt: lastMsg?._creationTime ?? null,
          lastMessageContent: lastMsg?.content?.slice(0, 120) ?? null,
          lastMessageRole: lastMsg?.role ?? null,
          processStep: procState?.currentStep ?? null,
          sessionTitle: proj.title,
          analysisSummary: proj.analysisSummary ?? null,
          activityCompletedAt: proj.activityCompletedAt ?? null,
        };
      }),
    );
    return {
      _id: a._id,
      unitId: a.unitId,
      unitTitle: unit?.title ?? "Unknown",
      unitEmoji: unit?.emoji ?? null,
      unitDescription: unit?.description ?? null,
      startedAt: a.startedAt,
      completedAt: a.archivedAt ?? null,
      processId,
      process: process
        ? {
            title: process.title,
            emoji: process.emoji ?? null,
            steps: process.steps,
          }
        : null,
      scholars,
    };
  },
});

// ─── Scholar reads ───────────────────────────────────────────────────

/**
 * All active class-focus pushes that target the calling scholar (or
 * the teacher's own pushes, for dashboard views). One entry per
 * (assignment, activity) push.
 */
export const currentClassFocusForMe = authedQuery({
  args: {
    asLearner: v.optional(v.boolean()),
    // Minute-rounded client clock used only to re-arm the reactive query across
    // institution-local midnight. The server remains the authority for now.
    now: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    void args.now;
    const user = ctx.user;
    // Scholars: the "what the room is on" signal is driven off the
    // scholar-branch semantics, shared with the teacher-facing Home mirror
    // (scholarPlate.homeForScholar) so the two never drift.
    if (user.role === ROLES.SCHOLAR || args.asLearner === true) {
      if (args.asLearner === true) {
        await requireActiveLearnerInstitution(ctx, user._id);
      }
      return await scholarClassFocusEntries(ctx, user._id);
    }
    // Teacher branch: every live class-focus push on the teacher's OWN
    // assignments (no onboarding exclusion, no completed-skip — that
    // machinery is scholar-only).
    const now = Date.now();
    const timeZone = await timeZoneForStaff(ctx, user._id);
    const todayDayKey = dayKeyForTimezone(now, timeZone);
    const candidates = await ctx.db.query("assignments").collect();
    const out: Array<
      Awaited<ReturnType<typeof enrichScheduleEntryForScholar>>
    > = [];
    for (const a of candidates) {
      if (a.archivedAt) continue;
      if (a.teacherId !== user._id) continue;
      for (const e of await activeScheduleEntries(
        ctx,
        a,
        now,
        todayDayKey,
        timeZone,
      )) {
        if (e.mode !== "classFocus") continue;
        out.push(
          await enrichScheduleEntryForScholar(ctx, a, e, user._id, "teacher"),
        );
      }
    }
    out.sort((x, y) => y.setAt - x.setAt);
    return out;
  },
});

/**
 * The SCHOLAR-branch of the class-focus read, factored out so the scholar
 * surface (`currentClassFocusForMe`) and the teacher-facing Home mirror
 * (`scholarPlate.homeForScholar`) compute the identical set for a given
 * scholar. Onboarding ("Welcome to Rabbithole") is excluded (it owns its own
 * pin), and a class focus the scholar has already completed no longer appears
 * — a finished focus stops being surfaced the instant the work is done.
 * Entries are sorted most-recent-first, which `pickLiveFocus` relies on.
 */
export async function scholarClassFocusEntries(
  ctx: QueryCtx & ScheduleReadCtx,
  scholarId: Id<"users">,
): Promise<Array<Awaited<ReturnType<typeof enrichScheduleEntryForScholar>>>> {
  const now = Date.now();
  const timeZone = await timeZoneForScholar(ctx, scholarId);
  const todayDayKey = dayKeyForTimezone(now, timeZone);
  const onboardingUnit = await ctx.db
    .query("units")
    .withIndex("by_slug", (q) => q.eq("slug", ONBOARDING_UNIT_SLUG))
    .first();
  const onboardingUnitId = onboardingUnit?._id ?? null;
  const candidates = await ctx.db.query("assignments").collect();
  const out: Array<
    Awaited<ReturnType<typeof enrichScheduleEntryForScholar>>
  > = [];
  for (const a of candidates) {
    if (a.archivedAt) continue;
    if (!targetsScholar(a, scholarId)) continue;
    if (onboardingUnitId && String(a.unitId ?? "") === String(onboardingUnitId))
      continue;
    // Showing, not blocking: an overrun focus still belongs on today's ladder,
    // while `enrichScheduleEntryForScholar` independently drops its wall.
    for (const e of await showingScheduleEntries(
      ctx,
      a,
      now,
      todayDayKey,
      timeZone,
    )) {
      if (e.mode !== "classFocus") continue;
      // Open until a later day is Homework, not the class section
      // (shared/openUntil.ts), even though it is stored as class focus.
      if (isOpenUntil(e, timeZone)) continue;
      if (!entryTargetsScholar(e, scholarId)) continue;
      if (await scholarCompletedFocusActivity(ctx, scholarId, e.activityId, a))
        continue;
      out.push(await enrichScheduleEntryForScholar(ctx, a, e, scholarId));
    }
  }
  out.sort((x, y) => y.setAt - x.setAt);
  return out;
}

/** All homework pushes targeting the calling scholar. */
export const homeworkForMe = authedQuery({
  args: { asLearner: v.optional(v.boolean()) },
  handler: async (ctx, args) => {
    const user = ctx.user;
    if (user.role !== ROLES.SCHOLAR && args.asLearner !== true) return [];
    if (args.asLearner === true) {
      await requireActiveLearnerInstitution(ctx, user._id);
    }
    const rows = await homeworkForScholar(ctx, user._id);
    // Each row carries the closures of its own due week, so the session
    // header can apply the "this week" display rule (shared/homeworkWeek.ts)
    // without a second subscription. Usually an empty array.
    const institutionId = await scholarInstitutionId(ctx, user._id);
    const closures =
      institutionId && rows.some((row) => row.dueAt != null)
        ? (await closuresForInstitution(ctx, institutionId))
            .filter(hasUsableDays)
            .map(({ startDayKey, endDayKey, label }) => ({
              startDayKey,
              endDayKey,
              label,
            }))
        : [];
    return rows.map((row) => ({
      ...row,
      dueWeekClosures:
        row.dueAt != null
          ? closuresInWeekOf(dayKeyForTimezone(row.dueAt, row.timeZone), closures)
          : [],
    }));
  },
});

/**
 * Today's planned, not-yet-live work for the calling scholar, for the
 * institution-local `dayKey` the client sends (its `useInstitutionDay`, which
 * re-arms at institution midnight). Answering for the client's day keeps the
 * subscription off the server clock (T11). `institutionDayForRequest` honors a
 * neighbouring day only within minutes of midnight, so tomorrow's entries never
 * leave the server early; any other key gets the server's own day.
 */
export const todayScheduleForSelf = authedQuery({
  args: {
    dayKey: v.string(),
    includeWebActivities: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => todayScheduleForScholar(ctx, ctx.user, args),
});

/** todayScheduleForSelf for an already-resolved scholar (the parity check reuses it). */
export async function todayScheduleForScholar(
  ctx: QueryCtx,
  scholar: Doc<"users">,
  args: { dayKey: string; includeWebActivities?: boolean },
) {
  {
    const timeZone = await timeZoneForScholar(ctx, scholar._id);
    const { dayKey } = institutionDayForRequest(args.dayKey, timeZone);
    const institutionId = await scholarInstitutionId(ctx, scholar._id);
    if (!(await hasScholarMembership(ctx, scholar._id)) || !institutionId) {
      return { timeZone, dayKey, entries: [] };
    }

    const timetable = await scholarTimetableContext(ctx, scholar);
    const assignments = await ctx.db.query("assignments").collect();
    const entries: Array<{
      assignmentId: Id<"assignments">;
      activityId: Id<"activities">;
      activityTitle: string;
      activityKind: Doc<"activities">["kind"];
      unitId: Id<"units"> | null;
      unitTitle: string | null;
      unitEmoji: string | null;
      subject: string | null;
      mode: "classFocus" | "homework";
      startsAt: number;
      dueAt: number | null;
      completedByMe: boolean;
    }> = [];

    const classSubjects = new Map<Id<"classes">, string | null>();
    const filedClassSubject = async (
      classId: Id<"classes"> | undefined,
    ): Promise<string | null> => {
      if (!classId) return null;
      if (!classSubjects.has(classId)) {
        classSubjects.set(classId, (await ctx.db.get(classId))?.subject ?? null);
      }
      return classSubjects.get(classId) ?? null;
    };

    for (const assignment of assignments) {
      if (assignment.archivedAt || !targetsScholar(assignment, scholar._id)) {
        continue;
      }
      const unit = assignment.unitId
        ? await ctx.db.get(assignment.unitId)
        : null;
      const scheduleRows = await loadScheduleRows(ctx, assignment._id);
      const filedClasses = firstClassIdByWork(scheduleRows);
      for (const entry of await readSchedule(ctx, assignment, undefined, scheduleRows)) {
        if (
          entry.setAt != null ||
          entry.startsAt == null ||
          !entryTargetsScholar(entry, scholar._id) ||
          dayKeyForTimezone(entry.startsAt, timeZone) !== dayKey
        ) {
          continue;
        }
        const enriched = await enrichScheduleEntryForScholar(
          ctx,
          assignment,
          entry,
          scholar._id,
        );
        if (
          enriched.activityKind === "web" &&
          args.includeWebActivities !== true
        ) {
          continue;
        }
        const filedClassId = filedClasses.get(
          giveWorkKey(entry.activityId, entry.mode),
        );
        entries.push({
          assignmentId: assignment._id,
          activityId: entry.activityId,
          activityTitle: enriched.activityTitle ?? "(deleted activity)",
          activityKind: enriched.activityKind ?? "online",
          unitId: assignment.unitId ?? null,
          unitTitle: enriched.unitTitle,
          unitEmoji: enriched.unitEmoji,
          subject: resolveScholarWorkSubject(
            timetable,
            assignment._id,
            entry.activityId,
            unit?.subject,
            await filedClassSubject(filedClassId),
          ),
          mode: entry.mode,
          startsAt: entry.startsAt,
          dueAt: entry.dueAt ?? null,
          completedByMe: enriched.completedByMe,
        });
      }
    }

    entries.sort((a, b) => a.startsAt - b.startsAt);
    return { timeZone, dayKey, entries };
  }
}

/** How many open school days the scholar lookahead spans (see comingUpForSelf). */
const COMING_UP_HORIZON_OPEN_DAYS = 5;


/**
 * The scholar "Coming up" lookahead — a week-scoped sibling of
 * `todayScheduleForSelf`. Read-only and non-actionable (T4): it is a forecast,
 * not a second work queue, so it carries no launch target and no completion.
 *
 * Over the NEXT 5 OPEN SCHOOL DAYS (weekends + calendar closures skipped, so
 * the window rolls into next week rather than collapsing on a Thursday/Friday)
 * it returns schedule-committed planned placements (setAt == null AND a real
 * `startsAt`) landing in the horizon, grouped by institution-local day.
 * Homework is not here: every live homework item is on the scholar's "Your
 * list" (shared/homeworkList.ts), whatever its due date.
 *
 * This DELIBERATELY WIDENS the planned-work visibility boundary. Today, future
 * planned work is teacher-only until activation; the sole scholar exception was
 * `todayScheduleForSelf`, which exposes only TODAY's planned entries. This
 * reveals schedule-committed placements for the next 5 open school days as
 * non-actionable previews. Scope is kept narrow on purpose — only committed
 * `startsAt` placements, never tentative/shelf work — and the live/planned
 * `setAt` boundary still governs whether a scholar can START anything, so these
 * previews stay unlaunchable. See review/homework-flow-plan.html §Move 3.
 *
 * The minute-rounded client timestamp (`now`) is an intentional reactive
 * dependency: Convex re-runs the query as wall-clock time passes — across the
 * institution-local midnight (rolling the horizon) — without the client having
 * to invent or know a day key. The server still derives and returns the
 * institution-authoritative day, and reads `now` only as its time source (the
 * client cannot spoof the timezone).
 */
export const comingUpForSelf = authedQuery({
  args: {
    now: v.number(),
    includeWebActivities: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => comingUpForScholar(ctx, ctx.user, args),
});

/** comingUpForSelf for an already-resolved scholar (the parity check reuses it). */
export async function comingUpForScholar(
  ctx: QueryCtx,
  scholar: Doc<"users">,
  args: { now: number; includeWebActivities?: boolean },
) {
  {
    const timeZone = await timeZoneForScholar(ctx, scholar._id);
    const now = args.now;
    const dayKey = dayKeyForTimezone(now, timeZone);
    const institutionId = await scholarInstitutionId(ctx, scholar._id);
    if (!(await hasScholarMembership(ctx, scholar._id)) || !institutionId) {
      return {
        timeZone,
        dayKey,
        nextOpenSchoolDayKey: null,
        horizonDayKeys: [] as string[],
        groups: [],
      };
    }

    const horizonDayKeys = await findNextOpenSchoolDayKeys(
      ctx,
      institutionId,
      dayKey,
      timeZone,
      COMING_UP_HORIZON_OPEN_DAYS,
    );
    const nextOpenSchoolDayKey = horizonDayKeys[0] ?? null;
    if (nextOpenSchoolDayKey == null) {
      return { timeZone, dayKey, nextOpenSchoolDayKey, horizonDayKeys, groups: [] };
    }
    const horizonSet = new Set(horizonDayKeys);

    const assignments = await ctx.db.query("assignments").collect();
    const planned: ComingUpPlanned[] = [];

    for (const assignment of assignments) {
      if (assignment.archivedAt || !targetsScholar(assignment, scholar._id)) {
        continue;
      }
      for (const entry of await readSchedule(ctx, assignment)) {
        if (!entryTargetsScholar(entry, scholar._id)) continue;

        const isCommittedPlanned =
          entry.setAt == null &&
          entry.startsAt != null &&
          horizonSet.has(dayKeyForTimezone(entry.startsAt, timeZone));
        if (!isCommittedPlanned) continue;

        const enriched = await enrichScheduleEntryForScholar(
          ctx,
          assignment,
          entry,
          scholar._id,
        );
        if (
          enriched.activityKind === "web" &&
          args.includeWebActivities !== true
        ) {
          continue;
        }
        planned.push({
          kind: "planned",
          assignmentId: String(assignment._id),
          activityId: String(entry.activityId),
          activityTitle: enriched.activityTitle ?? "(deleted activity)",
          unitTitle: enriched.unitTitle,
          unitEmoji: enriched.unitEmoji,
          teacherName: enriched.teacherName,
          startsAt: entry.startsAt!,
        });
      }
    }

    const groups = buildComingUpGroups({ planned, horizonDayKeys, timeZone });

    return { timeZone, dayKey, nextOpenSchoolDayKey, horizonDayKeys, groups };
  }
}

/** Recently archived for the teacher dashboard's "today" widget. */
export const recentlyArchivedForTeacher = teacherQuery({
  args: {},
  handler: async (ctx) => {
    const now = new Date();
    const todayStart = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate(),
    ).getTime();
    const owned = await ctx.db
      .query("assignments")
      .withIndex("by_teacher", (q) => q.eq("teacherId", ctx.user._id))
      .collect();
    const todayArchived = owned
      .filter((a) => a.archivedAt && a.archivedAt >= todayStart)
      // Unit-mode only — matches listForTeacher's treatment, so a standing
      // practice assignment archived today doesn't surface here without a unit.
      // Ad-hoc dispatches (no practiceMode ⇒ default "unit") DO stay, but are
      // unitId-less, so the unit read below must guard the optional unitId.
      .filter((a) => (a.practiceMode ?? "unit") === "unit")
      .sort((x, y) => (y.archivedAt ?? 0) - (x.archivedAt ?? 0));
    return Promise.all(
      todayArchived.map(async (a) => {
        // Ad-hoc dispatches are unitId-less; guard the optional unitId.
        const unit = a.unitId ? await ctx.db.get(a.unitId) : null;
        const sessions = (await ctx.db
          .query("sessions")
          .withIndex("by_assignment", (q) => q.eq("assignmentId", a._id))
          .collect())
          // Offline projects are scanned-deliverable containers, not chat
          // sessions — exclude them from cohort rosters / counts / facepiles.
          .filter((p) => !p.isOffline);
        return {
          _id: a._id,
          unitId: a.unitId ?? null,
          unitTitle: a.unitId
            ? (unit?.title ?? "Unknown")
            : (a.title ?? "Ad-hoc dispatch"),
          unitEmoji: unit?.emoji ?? null,
          startedAt: a.startedAt,
          archivedAt: a.archivedAt!,
          scholarCount: sessions.length,
        };
      }),
    );
  },
});

// ─── Internals ───────────────────────────────────────────────────────

/** The assignment, when the caller owns it or is an admin over its school
 *  (lib/assignmentAuthority.ts); throws "Not your assignment" otherwise. */
async function requireOwnedAssignment(
  ctx: (QueryCtx | MutationCtx) & { user: Pick<Doc<"users">, "_id" | "role"> },
  assignmentId: Id<"assignments">,
) {
  const a = await ctx.db.get(assignmentId);
  if (!a) return null;
  if (!(await mayActOnAssignment(ctx, ctx.user, a))) {
    throw new Error("Not your assignment");
  }
  return a;
}

/**
 * The curriculum:run half of an owned-assignment write. A teacher passes
 * untouched (teachers are unchanged); anyone else must still be able to run
 * the assignment's unit, and the activity must be one of that unit's own
 * lesson activities. Call AFTER the ownership check, never instead of it.
 */
async function requireRunnerScope(
  ctx: QueryCtx & { user: Doc<"users"> },
  a: Doc<"assignments">,
  activityId: Id<"activities">,
) {
  if (isTeacherRole(ctx.user.role)) return;
  await requireCanRunOwnedAssignment(ctx, ctx.user, a);
  await assertActivityInUnitStrict(ctx, a.unitId!, activityId);
}

/** Like assertActivityInUnit, but a quest-only (lesson-less) activity fails. */
async function assertActivityInUnitStrict(
  ctx: { db: QueryCtx["db"] },
  unitId: Id<"units">,
  activityId: Id<"activities">,
) {
  const act = await ctx.db.get(activityId);
  const lesson = act?.lessonId ? await ctx.db.get(act.lessonId) : null;
  if (!lesson || lesson.unitId !== unitId) {
    throw new Error("Activity is not part of this assignment's unit");
  }
}

/**
 * The LIST form of the runner gate: a teacher's owned rows pass untouched; a
 * non-teacher keeps only the owned rows she can still run (unit runnable,
 * curriculum:run held at the unit's school). Ownership alone is not enough:
 * an ex-teacher, a revoked grant, or a row on a unit at a school she holds no
 * grant at must not keep listing those cohorts' names. Results per unit are
 * cached so a long list costs one check per unit.
 */
async function runnableOwnedRows(
  ctx: QueryCtx,
  user: Doc<"users">,
  rows: Doc<"assignments">[],
): Promise<Doc<"assignments">[]> {
  if (isTeacherRole(user.role)) return rows;
  const byUnit = new Map<string, boolean>();
  const out: Doc<"assignments">[] = [];
  for (const row of rows) {
    if (row.teacherId !== user._id || !row.unitId) continue;
    const key = String(row.unitId);
    let ok = byUnit.get(key);
    if (ok === undefined) {
      try {
        await requireCanRunOwnedAssignment(ctx, user, row);
        ok = true;
      } catch {
        ok = false;
      }
      byUnit.set(key, ok);
    }
    if (ok) out.push(row);
  }
  return out;
}

/**
 * Read gate for an assignment's own progress views: the assignment when the
 * caller OWNS it and (if not a teacher) may still run its unit; null
 * otherwise — the existing not-yours shape. `isTeacher` tells the caller
 * whether to include the teacher-only fields (reading level, transcript
 * previews, session links), which a curriculum:run holder never receives.
 */
async function ownedAssignmentForRead(
  ctx: QueryCtx & { user: Doc<"users"> },
  assignmentId: Id<"assignments">,
): Promise<{ a: Doc<"assignments">; isTeacher: boolean } | null> {
  const a = await ctx.db.get(assignmentId);
  if (!a || !(await mayActOnAssignment(ctx, ctx.user, a))) return null;
  const isTeacher = isTeacherRole(ctx.user.role);
  if (!isTeacher) {
    try {
      await requireCanRunOwnedAssignment(ctx, ctx.user, a);
    } catch {
      return null;
    }
  }
  return { a, isTeacher };
}

/**
 * Cancel a pending activation job for an entry (if any), so a planned
 * push that's being replaced / cleared / rescheduled doesn't fire.
 * Safe to call when there's no entry or no pending job.
 */
async function cancelPendingActivation(
  ctx: MutationCtx,
  assignment: Doc<"assignments">,
  activityId: Id<"activities">,
) {
  for (const entry of await readSchedule(ctx, assignment)) {
    if (entry.activityId === activityId && entry.scheduledFnId) {
      await ctx.scheduler.cancel(entry.scheduledFnId);
    }
  }
}

// ─── Shared scheduling core ──────────────────────────────────────────
// The teacher-UI mutations (scheduleActivity/rescheduleActivity/
// clearActivity) AND the aide's internal tool wrappers below both run
// through these, so a schedule edit behaves identically whether a
// teacher clicked it or asked the aide to do it. Each takes an
// already-fetched, ownership-checked assignment doc.

// Normalize an optional per-scholar targeting list against the roster.
//   - absent/empty              → undefined (cohort-wide, today's default)
//   - equals the whole roster   → undefined (collapse; "everyone" should
//                                 track roster growth, not freeze a list)
//   - a strict, non-empty subset → that subset (deduped, roster-filtered)
// Storing only real subsets keeps the "absent = everyone" invariant every
// reader relies on, and never lets targeting silently widen.
function normalizeTargeting(
  a: Doc<"assignments">,
  scholarIds: Id<"users">[] | undefined,
): Id<"users">[] | undefined {
  if (!scholarIds || scholarIds.length === 0) return undefined;
  const roster = new Set(a.scholarIds.map((id) => String(id)));
  const seen = new Set<string>();
  const kept: Id<"users">[] = [];
  for (const id of scholarIds) {
    const key = String(id);
    if (seen.has(key)) continue;
    seen.add(key);
    if (roster.has(key)) kept.push(id);
  }
  if (kept.length === 0 || kept.length === a.scholarIds.length) return undefined;
  return kept;
}

/**
 * Every schedule write goes through applySchedule/applyPush,
 * so this one guard keeps archived (and deleted) activities out of the live
 * push layer no matter which teacher surface initiated it. Bulk unit/lesson
 * assigns filter archived children earlier (gatherUnitActivities), and the
 * master-schedule reconciler clears archived placements before reaching here.
 */
async function assertSchedulableActivity(
  ctx: MutationCtx,
  a: Doc<"assignments">,
  activityId: Id<"activities">,
  // The give's window, enough to tell "Open until a date" from "In that
  // class" (shared/openUntil.ts).
  window: Pick<ScheduleEntry, "mode" | "setAt" | "startsAt" | "endsAt" | "openUntilKind">,
  // The activity is already live on this assignment (an extend, a re-time,
  // more scholars): scholars already have it, so the go-live check below
  // does not apply.
  opts: { alreadyLive?: boolean; classLinkCache?: ClassLinkReadCache } = {},
): Promise<void> {
  const mode = window.mode;
  const act = await ctx.db.get(activityId);
  if (!act) throw new ConvexError("Can't schedule: this activity was deleted.");
  if (act.archivedAt) {
    throw new ConvexError(
      "Can't schedule an archived activity — unarchive it first.",
    );
  }
  if (
    mode === "homework" &&
    act.kind === "offline" &&
    !(await hasReadableOfflineHomeworkContent(ctx, act))
  ) {
    throw new ConvexError(
      "Add instructions or materials first, then give it as homework.",
    );
  }
  // Offline work given "Open until a date" reaches scholars the way offline
  // homework does, as a page they open and read on their own (scholarPlate.ts
  // `unstartedAssignedRowSurface`), so it needs something to read too.
  // Offline work given "In that class" is led by the teacher and needs none.
  if (
    mode === "classFocus" &&
    act.kind === "offline" &&
    (await isOpenUntilEntry(ctx, a, window, opts.classLinkCache)) &&
    !(await hasReadableOfflineHomeworkContent(ctx, act))
  ) {
    throw new ConvexError("Add instructions or materials first, then give it.");
  }
  if (!opts.alreadyLive && (await appActivityHasNothingToOpen(ctx, act))) {
    throw new ConvexError(NOTHING_TO_OPEN_REFUSAL);
  }
}

/** The activity already has a live entry on this assignment. */
async function isLiveOnAssignment(
  ctx: MutationCtx,
  a: Doc<"assignments">,
  activityId: Id<"activities">,
): Promise<boolean> {
  return (await readSchedule(ctx, a)).some(
    (e) => e.activityId === activityId && e.setAt != null,
  );
}

export async function applyScheduleActivity(
  ctx: MutationCtx,
  a: Doc<"assignments">,
  args: {
    activityId: Id<"activities">;
    mode: "classFocus" | "homework";
    startsAt: number;
    endsAt?: number;
    /** A timed class focus: the teacher's finish (`ScheduleEntry.openUntilKind`). */
    openUntilKind?: boolean;
    dueAt?: number;
    scholarIds?: Id<"users">[];
    /** Homework given for a named class (TRA-581). */
    homeworkClassId?: Id<"classes">;
    /** A live entry re-given as a new class occurrence: its new `setAt`
     *  (applyGive, TRA-638). */
    restartedAt?: number;
  },
  // When false, the entry is planned but gets NO activation job — it
  // sits on the agenda at `startsAt` and only goes live on an explicit
  // Start now. Used for un-paced bulk assigns, so a whole unit dropped on
  // one date doesn't flip every activity live at the same instant.
  autoActivate = true,
  classLinkCache?: ClassLinkReadCache,
) {
  // A proposed Quest reaches only its proposer (TRA-685, as coreAssignWork).
  if (a.unitId) {
    assertProposedQuestRecipients(
      await ctx.db.get(a.unitId),
      args.scholarIds ?? a.scholarIds,
    );
  }
  const now = Date.now();
  const current = await readSchedule(ctx, a);
  const found = current.find((e) => e.activityId === args.activityId);
  // A closed focus (open-until work past its close) is replaced by a fresh
  // plan: it keeps neither its old `setAt` nor its old audience.
  const existing = found && !isClosedFocusEntry(found, now) ? found : undefined;
  const setAt =
    existing?.setAt != null ? (args.restartedAt ?? existing.setAt) : undefined;
  // Judge the entry this call will store (a closed one's old `setAt` is
  // dropped above), so re-planning old open-until work "In that class" is
  // never read as open-until.
  await assertSchedulableActivity(
    ctx,
    a,
    args.activityId,
    {
      mode: args.mode,
      setAt,
      startsAt: args.startsAt,
      endsAt: args.endsAt,
      openUntilKind: args.openUntilKind,
    },
    {
      alreadyLive: await isLiveOnAssignment(ctx, a, args.activityId),
      classLinkCache,
    },
  );
  // A live class focus re-applied with the SAME end keeps its auto-clear job
  // (the recurring re-materialization re-applies this path every tick and
  // must stay idempotent). A restarted one is a new occurrence and re-arms.
  const keepsAutoClear =
    existing?.setAt != null &&
    setAt === existing.setAt &&
    existing.mode === "classFocus" &&
    args.mode === "classFocus" &&
    args.endsAt === existing.endsAt &&
    (args.openUntilKind ?? existing.openUntilKind) === existing.openUntilKind;
  // Otherwise the entry's job (activation, or a live focus's auto-clear) is
  // replaced: cancel it.
  if (!keepsAutoClear) await cancelPendingActivation(ctx, a, args.activityId);
  const base = current.filter((e) => e.activityId !== args.activityId);
  let scheduledFnId: Id<"_scheduled_functions"> | undefined;
  if (existing?.setAt == null) {
    // Only schedule activation for a FUTURE start. Past starts stay
    // planned (no auto-push) until an explicit Start now.
    if (autoActivate && args.startsAt > now) {
      scheduledFnId = await ctx.scheduler.runAt(
        args.startsAt,
        internal.assignments.activateScheduledActivity,
        { assignmentId: a._id, activityId: args.activityId },
      );
    }
  } else if (keepsAutoClear) {
    scheduledFnId = existing.scheduledFnId;
  } else if (
    args.mode === "classFocus" &&
    args.endsAt !== undefined &&
    args.endsAt > now
  ) {
    // A live class focus re-timed to a NEW end gets a clear job at that end,
    // stored on the row so clear, archive and the next re-time can cancel it
    // (none for open-until work, which keeps its row past the close).
    scheduledFnId = await armFocusAutoClear(ctx, a, args.activityId, {
      mode: args.mode,
      setAt,
      startsAt: args.startsAt,
      endsAt: args.endsAt,
      openUntilKind: args.openUntilKind,
    }, classLinkCache);
  }
  base.push({
    activityId: args.activityId,
    mode: args.mode,
    // Re-timing an already-live entry must not demote it back to planned.
    setAt,
    startsAt: args.startsAt,
    scheduledFnId,
    endsAt: args.mode === "classFocus" ? args.endsAt : undefined,
    ...openUntilKindFor(args.mode, args.endsAt, args.openUntilKind),
    dueAt: args.mode === "homework" ? args.dueAt : undefined,
    homeworkClassId: args.mode === "homework" ? args.homeworkClassId : undefined,
    // A live entry's targeting must not widen as a side effect of a re-time:
    // absent args.scholarIds means "everyone" for a fresh plan, but for an
    // already-live entry it means "leave the audience alone".
    scholarIds:
      args.scholarIds === undefined && existing?.setAt != null
        ? existing.scholarIds
        : normalizeTargeting(a, args.scholarIds),
  });
  await writeSchedule(ctx, a, base, { activityId: args.activityId, classLinkCache });
}

/** Returns false if there was no entry for this activity (caller can
 *  surface a "nothing to reschedule" message). */
async function applyRescheduleActivity(
  ctx: MutationCtx,
  a: Doc<"assignments">,
  args: { activityId: Id<"activities">; startsAt: number },
): Promise<boolean> {
  const now = Date.now();
  const schedule = await readSchedule(ctx, a);
  const existingIdx = schedule.findIndex(
    (e) => e.activityId === args.activityId,
  );
  if (existingIdx === -1) return false;
  // A moved give is the teacher's newest answer (see applyGive).
  await detachPlacementsForGive(ctx, a._id, args.activityId);
  const planned = schedule[existingIdx];
  if (planned.setAt == null && args.startsAt <= now) {
    // Moved to now: it shows up now. A time that has clearly passed is a
    // question, never a plan that silently never activates.
    if (args.startsAt < now - GIVE_START_GRACE_MS) {
      throw new GiveQuestionError(START_PASSED_QUESTION);
    }
    const roster = planned.scholarIds?.length ? planned.scholarIds : a.scholarIds;
    // Open-until work keeps its closing day (the teacher's finish, TRA-726),
    // the same as Start now on the Run page; in-class work ends with the
    // class it now shows up in.
    const window: GiveWindow =
      planned.mode !== "classFocus"
        ? { mode: "homework", dueAt: planned.dueAt }
        : planned.openUntilKind === true && planned.endsAt != null && planned.endsAt > now
          ? { mode: "classFocus", endsAt: planned.endsAt, openUntilKind: true }
          : await windowForGive(ctx, {
              roster,
              institutionId: await homeworkInstitutionForAssignment(ctx, a),
              startsAt: now,
              answer: { finish: { kind: "inClass" } },
            });
    await applyPushActivity(ctx, a, {
      activityId: args.activityId,
      ...window,
      scholarIds: planned.scholarIds,
    });
    return true;
  }
  const idx = existingIdx;
  const entry = schedule[idx];
  // A live entry keeps its setAt and its auto-clear job; we just move
  // startsAt. A planned entry's activation job is replaced.
  let scheduledFnId: Id<"_scheduled_functions"> | undefined =
    entry.setAt != null ? entry.scheduledFnId : undefined;
  if (entry.setAt == null) await cancelPendingActivation(ctx, a, args.activityId);
  if (entry.setAt == null && args.startsAt > now) {
    scheduledFnId = await ctx.scheduler.runAt(
      args.startsAt,
      internal.assignments.activateScheduledActivity,
      { assignmentId: a._id, activityId: args.activityId },
    );
  }
  // Moving a give keeps the teacher's finish answer, re-read at the new
  // time (TRA-571): a planned in-class give ends with the bell block it now
  // shows up in (or that school day); homework keeps its due date, and a move
  // past that date is refused rather than starting already late.
  let endsAt = entry.endsAt;
  let openUntilKind = entry.openUntilKind;
  // Open-until work keeps its closing day through a move (TRA-726), as a
  // grid drag does; a start past it is refused like homework past its due.
  if (entry.setAt == null && entry.mode === "classFocus" && entry.openUntilKind === true) {
    if (entry.endsAt != null && args.startsAt >= entry.endsAt) {
      // The grid's drag says the same (gridGiveActions.ts `openUntilMoveRefusal`).
      throw new GiveQuestionError(
        "That's after it closes. Move it to its closing day or earlier, or give it again open until a later day.",
      );
    }
  } else if (entry.setAt == null && entry.mode === "classFocus") {
    openUntilKind = false;
    const roster = entry.scholarIds?.length ? entry.scholarIds : a.scholarIds;
    const { timeZone } = await homeworkCalendarForRoster(
      ctx,
      roster,
      await homeworkInstitutionForAssignment(ctx, a),
    );
    endsAt = (
      await resolveGiveWindow(ctx, {
        scholarIds: roster,
        timeZone,
        startsAt: args.startsAt,
        finish: { kind: "inClass" },
      })
    ).endsAt;
  }
  if (
    entry.mode === "homework" &&
    entry.dueAt != null &&
    args.startsAt > entry.dueAt
  ) {
    throw new GiveQuestionError(
      "That's after it's due. Should the due date move too?",
    );
  }
  schedule[idx] = {
    ...entry,
    startsAt: args.startsAt,
    scheduledFnId,
    endsAt,
    ...(entry.mode === "classFocus" && endsAt !== undefined ? { openUntilKind } : {}),
  };
  await writeSchedule(ctx, a, schedule, { activityId: args.activityId });
  return true;
}

/** Returns false if there was no entry to remove. */
async function applyClearActivity(
  ctx: MutationCtx,
  a: Doc<"assignments">,
  activityId: Id<"activities">,
): Promise<boolean> {
  // Cancel a pending activation job so a cleared-while-planned entry
  // never goes live later.
  await cancelPendingActivation(ctx, a, activityId);
  const before = await readSchedule(ctx, a);
  const schedule = before.filter((e) => e.activityId !== activityId);
  await writeSchedule(ctx, a, schedule, { activityId });
  return schedule.length !== before.length;
}

/**
 * Un-materialize: drop a still-PLANNED (setAt == null) schedule entry for an
 * activity and cancel its pending activation job. This is the auto-materialize
 * inverse the Master Schedule calls when a placement that seeded the entry is
 * removed / sent to the shelf / unlinked. A LIVE entry (setAt set) is left
 * untouched on purpose — scholars have already seen it, so pulling it back is a
 * separate, deliberate action, never a side effect of a grid edit. Returns
 * true iff it actually cleared a planned entry.
 */
export async function unmaterializePlannedActivity(
  ctx: MutationCtx,
  assignmentId: Id<"assignments">,
  activityId: Id<"activities">,
): Promise<boolean> {
  const a = await ctx.db.get(assignmentId);
  if (!a) return false;
  const schedule = await readSchedule(ctx, a);
  const entry = schedule.find((e) => e.activityId === activityId);
  if (!entry || entry.setAt != null) return false; // gone, or already live
  await cancelPendingActivation(ctx, a, activityId);
  await writeSchedule(
    ctx,
    a,
    schedule.filter((e) => e.activityId !== activityId),
    { activityId },
  );
  return true;
}

/**
 * Merge an add-to-live push into the activity's current entry. Only the
 * audience grows: a live entry keeps its mode and lifetime (homework may only
 * move its due date later), so the push never takes anything from a scholar
 * who already has it. Refuses, with the remedy, when merging would have to
 * change something for someone else: a planned entry (pushing would cancel
 * the plan), a live whole-cohort entry, or a live entry in the other mode.
 * Off-roster scholars are refused by name rather than silently dropped.
 */
async function mergeIntoLiveAudience(
  ctx: MutationCtx,
  a: Doc<"assignments">,
  args: {
    activityId: Id<"activities">;
    mode: "classFocus" | "homework";
    endsAt?: number;
    openUntilKind?: boolean;
    dueAt?: number;
    scholarIds?: Id<"users">[];
  },
  now: number,
): Promise<{
  scholarIds: Id<"users">[];
  endsAt?: number;
  openUntilKind?: boolean;
  dueAt?: number;
  keepsLifetime: boolean;
}> {
  const named = args.scholarIds ?? [];
  if (named.length === 0) {
    throw new Error("Name at least one scholar on this assignment's roster.");
  }
  const roster = new Set(a.scholarIds.map(String));
  const offRoster = named.filter((id) => !roster.has(String(id)));
  if (offRoster.length > 0) {
    const names = await Promise.all(
      offRoster.map(async (id) => (await ctx.db.get(id))?.name ?? "a scholar"),
    );
    throw new Error(
      `Not on this assignment's roster: ${names.join(", ")}. Nothing pushed — add them to the roster first.`,
    );
  }
  const existing = (await readSchedule(ctx, a)).find(
    (e) => e.activityId === args.activityId,
  );
  if (existing && existing.setAt == null) {
    throw new Error(
      "This activity is planned for the cohort, and pushing it now would cancel that plan. Start or clear the planned push first.",
    );
  }
  const timeZone = await timeZoneForInstitution(
    ctx,
    await homeworkInstitutionForAssignment(ctx, a),
  );
  const live =
    existing != null &&
    isScheduleEntryActive(existing, now, dayKeyForTimezone(now, timeZone), timeZone);
  if (!existing || !live) {
    return {
      scholarIds: named,
      endsAt: args.endsAt,
      openUntilKind: args.openUntilKind,
      dueAt: args.dueAt,
      keepsLifetime: false,
    };
  }
  const label = existing.mode === "classFocus" ? "in-class work" : "homework";
  if (!existing.scholarIds?.length) {
    throw new Error(
      existing.mode === "classFocus"
        ? "This activity is live in class for the whole cohort right now, so those scholars already have it. To give them longer, wrap it first, then give them more time."
        : "This activity is already live as homework for the whole cohort, so those scholars already have it. Change its due date instead.",
    );
  }
  if (existing.mode !== args.mode) {
    throw new Error(
      `This activity is live as ${label} for ${existing.scholarIds.length} scholar(s); switching it would change it for them too. Give more time as ${label}, or wrap it first.`,
    );
  }
  return {
    // applyPushActivity normalizes the union (dedupe; whole roster → everyone).
    scholarIds: [...existing.scholarIds, ...named],
    endsAt: existing.endsAt,
    // The live entry's finish, with its lifetime (TRA-726).
    openUntilKind: existing.openUntilKind,
    dueAt:
      existing.dueAt != null && args.dueAt != null
        ? Math.max(existing.dueAt, args.dueAt)
        : (existing.dueAt ?? args.dueAt),
    keepsLifetime: true,
  };
}

/**
 * Push-now (set focus): make an activity LIVE immediately for the whole
 * roster. Unlike applyScheduleActivity (which writes a *planned* entry,
 * setAt null), this stamps setAt=now so scholars see it at once. Shared
 * by the teacher-UI `pushActivity` and the aide `aidePushActivityNow`.
 *
 * `addToLiveAudience` is "give these scholars more time": the named
 * scholars are ADDED to whoever already has the activity live, so the push
 * can never take it away from anyone (see mergeIntoLiveAudience). An activity is one entry per
 * assignment, so without it a one-scholar push replaces a live cohort entry
 * and pulls the work off everyone else's screen. Each scholar lands back in
 * their existing session, which is keyed by assignment + activity.
 */
export async function applyPushActivity(
  ctx: MutationCtx,
  a: Doc<"assignments">,
  args: {
    activityId: Id<"activities">;
    mode: "classFocus" | "homework";
    endsAt?: number;
    /** A timed class focus: the teacher's finish (`ScheduleEntry.openUntilKind`). */
    openUntilKind?: boolean;
    dueAt?: number;
    scholarIds?: Id<"users">[];
    addToLiveAudience?: boolean;
    /** Homework given for a named class (TRA-581). */
    homeworkClassId?: Id<"classes">;
  },
  classLinkCache?: ClassLinkReadCache,
) {
  // A proposed Quest reaches only its proposer (TRA-685, as coreAssignWork).
  if (a.unitId) {
    assertProposedQuestRecipients(
      await ctx.db.get(a.unitId),
      args.scholarIds ?? a.scholarIds,
    );
  }
  await assertSchedulableActivity(
    ctx,
    a,
    args.activityId,
    // Push-now goes live at once, so the window starts now.
    { mode: args.mode, setAt: Date.now(), endsAt: args.endsAt, openUntilKind: args.openUntilKind },
    {
      alreadyLive: await isLiveOnAssignment(ctx, a, args.activityId),
      classLinkCache,
    },
  );
  const now = Date.now();
  const merged = args.addToLiveAudience
    ? await mergeIntoLiveAudience(ctx, a, args, now)
    : null;
  const scholarIds = merged ? merged.scholarIds : args.scholarIds;
  const endsAt = merged ? merged.endsAt : args.endsAt;
  const openUntilKind = merged ? merged.openUntilKind : args.openUntilKind;
  const dueAt = merged ? merged.dueAt : args.dueAt;
  if (
    args.mode === "classFocus" &&
    endsAt !== undefined &&
    endsAt <= now &&
    !merged?.keepsLifetime
  ) {
    throw new ConvexError(
      `Can't give it in class: its end time ${new Date(endsAt).toISOString()} is in the past.`,
    );
  }
  const current = await readSchedule(ctx, a);
  const existing = current.find((e) => e.activityId === args.activityId);
  let scheduledFnId: Id<"_scheduled_functions"> | undefined;
  if (merged?.keepsLifetime) {
    // A merged entry kept its lifetime, and its auto-clear job with it.
    scheduledFnId = existing?.scheduledFnId;
  } else {
    // Replacing the entry: cancel its job (a planned push's activation, or a
    // live focus's auto-clear) so it can't fire later.
    await cancelPendingActivation(ctx, a, args.activityId);
    // None for open-until work, which keeps its row past the close.
    scheduledFnId = await armFocusAutoClear(ctx, a, args.activityId, {
      mode: args.mode,
      setAt: now,
      startsAt: now,
      endsAt,
      openUntilKind,
    }, classLinkCache);
  }
  const schedule = current.filter((e) => e.activityId !== args.activityId);
  schedule.push({
    activityId: args.activityId,
    mode: args.mode,
    // Push-now: live immediately. startsAt mirrors now for agenda position.
    setAt: now,
    startsAt: now,
    // The auto-clear job, stored so clear, archive and a re-time cancel it.
    scheduledFnId,
    endsAt: args.mode === "classFocus" ? endsAt : undefined,
    ...openUntilKindFor(args.mode, endsAt, openUntilKind),
    dueAt: args.mode === "homework" ? dueAt : undefined,
    homeworkClassId: args.mode === "homework" ? args.homeworkClassId : undefined,
    scholarIds: normalizeTargeting(a, scholarIds),
  });
  await writeSchedule(ctx, a, schedule, { activityId: args.activityId, classLinkCache });
}

/** Replace the roster outright (everyone not listed leaves the cohort). */
async function applySetScholars(
  ctx: MutationCtx,
  a: Doc<"assignments">,
  scholarIds: Id<"users">[],
) {
  // A proposed Quest's assignment holds only its proposer (TRA-685).
  if (a.unitId) assertProposedQuestRecipients(await ctx.db.get(a.unitId), scholarIds);
  const nextRoster = Array.from(new Set(scholarIds.map((id) => String(id))));
  const rosterSet = new Set(nextRoster);
  // Keep per-scholar activity targeting in sync with the roster. For each
  // entry that targets specific scholars, intersect with the new roster:
  //   - non-empty intersection → keep the narrowed list;
  //   - EMPTY intersection     → drop the entry entirely. We must NOT let
  //     it fall back to `scholarIds: undefined`, because absent = everyone
  //     — pruning a targeted activity to zero scholars must never silently
  //     re-broadcast it to the whole cohort.
  const schedule = await readSchedule(ctx, a);
  const nextSchedule: typeof schedule = [];
  for (const entry of schedule) {
    if (entry.scholarIds == null || entry.scholarIds.length === 0) {
      nextSchedule.push(entry);
      continue;
    }
    const kept = entry.scholarIds.filter((id) => rosterSet.has(String(id)));
    if (kept.length === 0) {
      // Drop this entry — cancel any pending activation so it can't fire.
      await cancelPendingActivation(ctx, a, entry.activityId);
      continue;
    }
    if (kept.length !== entry.scholarIds.length) {
      nextSchedule.push({ ...entry, scholarIds: kept });
    } else {
      nextSchedule.push(entry);
    }
  }
  await ctx.db.patch(a._id, {
    scholarIds: scholarIds.filter(
      (id, i) => scholarIds.findIndex((o) => String(o) === String(id)) === i,
    ),
  });
  // A cohort-wide entry needs no rewrite: its audience is the assignment
  // itself and follows the roster live.
  await writeSchedule(ctx, a, nextSchedule);
}

// ── Ad-hoc dispatch (Q1 — "give this ONE scholar something to do right now") ──
//
// A dispatch is an ordinary assignment with a one-scholar roster and
// kind:"adHocDispatch" (the provenance discriminator the schedule surfaces read
// — see review/scheduling-model-sketches.html §3). No new table: it reuses the
// whole execution machinery (completion, deliverables, homework, progress). The
// ONLY thing that makes it "right now" vs "add to their queue" is live-vs-planned
// — `live` (the default) pushes it live immediately (setAt=now, applyPushActivity),
// so the scholar sees it at once; `live:false` plans it for `startsAt` like any
// other future push. The activity is created ad-hoc (no lesson/unit) as a tutor
// chat, web assignment, practice set, or offline handout.

async function coreDispatchActivity(
  ctx: MutationCtx,
  args: {
    teacherId: Id<"users">;
    scholarId: Id<"users">;
    title: string;
    activityKind?: "online" | "offline" | "web" | "problem_set";
    systemPrompt?: string;
    description?: string;
    webUrl?: string;
    targetSkillKeys?: string[];
    itemCount?: number;
    mode?: "classFocus" | "homework";
    finish?: GiveFinish;
    live?: boolean;
    startsAt?: number;
    endsAt?: number;
    openUntilKind?: boolean;
    dueAt?: number;
    /** The scholar's own question this dispatch carries (Prep "Assign…"). */
    seedId?: Id<"seeds">;
  },
): Promise<{
  assignmentId: Id<"assignments">;
  activityId: Id<"activities">;
  activityKind: "online" | "offline" | "web" | "problem_set";
  attachedVideoResource: boolean;
}> {
  const teacher = await ctx.db.get(args.teacherId);
  if (!teacher) throw new Error("Teacher not found");
  await requireScholarsAccessible(ctx, teacher, [args.scholarId]);
  const now = Date.now();
  const title = args.title.trim();
  if (!title) throw new Error("Dispatch needs a title");
  let activityKind = args.activityKind ?? "online";
  // No default mode: the give must say when it should be finished (TRA-571).
  // The answer is checked after the content is validated, so a bad URL or a
  // missing handout is reported first.
  const startsAt = args.live === false ? (args.startsAt ?? now) : now;
  const answeredMode: "classFocus" | "homework" | undefined = args.finish
    ? finishIsHomework(args.finish)
      ? "homework"
      : "classFocus"
    : args.mode;
  const description = args.description?.trim() || undefined;
  if (activityKind === "offline" && !description) {
    throw new Error("An offline dispatch needs complete instructions in description");
  }
  if (activityKind === "offline" && answeredMode === "classFocus") {
    throw new Error(
      "Offline work needs a due date: it can't be finished \"in that class\" or left \"open until\" a day.",
    );
  }

  let webUrl: string | undefined;
  // A YouTube web dispatch host-locks the WebView to all of youtube.com and can
  // never be completed (every completion writer needs an online, lesson-anchored
  // activity). Rewrite it to an online tutor activity with the video attached as
  // a sandboxed youtube-nocookie resource — a video's canonical home (TRA-280).
  let videoResourceUrl: string | undefined;
  let problemSet: Doc<"activities">["problemSet"];
  if (activityKind === "web") {
    const raw = args.webUrl?.trim();
    if (!raw) throw new Error("A web dispatch needs a URL");
    let parsed: URL;
    try {
      parsed = new URL(raw);
    } catch {
      throw new Error("A web dispatch needs a valid URL");
    }
    if (parsed.protocol !== "https:") {
      throw new Error("A web dispatch URL must use HTTPS");
    }
    if (youtubeVideoId(raw)) {
      activityKind = "online";
      videoResourceUrl = raw;
    } else {
      webUrl = raw;
    }
  } else if (activityKind === "problem_set") {
    const targetSkillKeys = Array.from(
      new Set((args.targetSkillKeys ?? []).map((key) => key.trim()).filter(Boolean)),
    );
    if (targetSkillKeys.length !== 1) {
      throw new Error("A practice dispatch needs exactly one target skill key");
    }
    const nodes = await Promise.all(
      targetSkillKeys.map((nodeKey) =>
        ctx.db
          .query("knowledgeNodes")
          .withIndex("by_nodeKey", (q) => q.eq("nodeKey", nodeKey))
          .first(),
      ),
    );
    const missing = targetSkillKeys.filter((_, index) => !nodes[index]);
    if (missing.length > 0) {
      throw new Error(`Unknown practice skill key${missing.length === 1 ? "" : "s"}: ${missing.join(", ")}`);
    }
    const domain = nodes[0]!.domain;
    if (!PRACTICE_DOMAINS.some((entry) => entry.domain === domain)) {
      throw new Error("Those skills do not have targeted practice");
    }
    const itemCount = args.itemCount ?? 10;
    if (!Number.isInteger(itemCount) || itemCount < 1 || itemCount > 30) {
      throw new Error("Practice item count must be a whole number from 1 to 30");
    }
    problemSet = { domain, targetSkillKeys, itemCount };
  }

  // A rewritten YouTube video is the STARTING point, so its tutor prompt must
  // tell the tutor to open with it — the standing "never dump resources at the
  // start" guidance would otherwise keep the video from ever surfacing. If the
  // teacher gave their own prompt, append the instruction rather than replace it.
  const videoFirstLine =
    "The teacher sent this video as the starting point — share it first with share_resource, then ask one Socratic question about what the scholar noticed.";
  let onlineSystemPrompt: string | undefined;
  if (activityKind === "online") {
    const teacherPrompt = args.systemPrompt?.trim();
    if (videoResourceUrl) {
      onlineSystemPrompt = teacherPrompt
        ? `${teacherPrompt}\n\n${videoFirstLine}`
        : `Ad-hoc exploration dispatched by a teacher: ${title}. ${videoFirstLine}`;
    } else {
      onlineSystemPrompt =
        teacherPrompt ||
        `Ad-hoc exploration dispatched by a teacher: ${title}. Guide the scholar Socratically — ask, don't tell.`;
    }
  }

  if (!answeredMode) throw new GiveQuestionError(MISSING_FINISH_QUESTION);
  const window: GiveWindow = await windowForGive(ctx, {
    roster: [args.scholarId],
    institutionId: undefined,
    startsAt,
    answer: args.finish
      ? { finish: args.finish }
      : { mode: args.mode, endsAt: args.endsAt, openUntilKind: args.openUntilKind, dueAt: args.dueAt },
  });
  const activityId = await ctx.db.insert("activities", {
    title,
    kind: activityKind,
    // The dispatch `description` arg is scholar-facing by contract ("complete
    // scholar-facing instructions… preserved verbatim"), so it lands in the
    // scholar-visible field — teacher-facing design intent has no author here.
    scholarDescription: description,
    systemPrompt: onlineSystemPrompt,
    webUrl,
    problemSet,
    order: 0,
    ...(args.seedId ? { seedId: args.seedId } : {}),
  });
  if (activityKind === "problem_set") {
    await scheduleProblemSetItemGeneration(ctx, activityId);
  }
  if (videoResourceUrl) {
    // Attach the video the SAME way the resource UI does (addUrlResource), so a
    // video resource is created exactly one way. Access is already gated above
    // by requireScholarsAccessible + the fresh activity is the teacher's own.
    await addUrlResource(ctx, teacher, {
      activityId,
      title,
      url: videoResourceUrl,
      kind: "video",
    });
  }

  const assignmentId = await ctx.db.insert("assignments", {
    teacherId: args.teacherId,
    scholarIds: [args.scholarId],
    title,
    kind: "adHocDispatch",
    startedAt: now,
  });
  if (args.seedId) {
    // Lets `liveQuestionHomework` go activity → its dispatch by id, never by
    // scanning assignments.
    await ctx.db.patch(activityId, { dispatchAssignmentId: assignmentId });
  }
  const a = (await ctx.db.get(assignmentId))!;
  if (args.finish) {
    // An answered give: the same start rules as every other give (a start
    // that passed during the aide turn goes live now, or is refused).
    const finish = args.finish;
    await applyGive(ctx, a, {
      activityId,
      startsAt: args.live === false ? startsAt : Date.now(),
      resolve: (at) =>
        windowForGive(ctx, {
          roster: [args.scholarId],
          institutionId: undefined,
          startsAt: at,
          answer: { finish },
        }),
    });
  } else if (args.live === false) {
    // Add to their queue — planned for a future time (or now, agenda-only).
    await applyScheduleActivity(ctx, a, {
      activityId,
      ...window,
      startsAt,
    });
  } else {
    // Right now — live immediately for the one scholar.
    await applyPushActivity(ctx, a, {
      activityId,
      ...window,
    });
  }
  return {
    assignmentId,
    activityId,
    activityKind,
    attachedVideoResource: videoResourceUrl !== undefined,
  };
}

export const dispatchActivity = teacherMutation({
  args: {
    scholarId: v.id("users"),
    title: v.string(),
    activityKind: v.optional(
      v.union(
        v.literal("online"),
        v.literal("offline"),
        v.literal("web"),
        v.literal("problem_set"),
      ),
    ),
    systemPrompt: v.optional(v.string()),
    description: v.optional(v.string()),
    webUrl: v.optional(v.string()),
    targetSkillKeys: v.optional(v.array(v.string())),
    itemCount: v.optional(v.number()),
    mode: v.optional(v.union(v.literal("classFocus"), v.literal("homework"))),
    finish: v.optional(giveFinishValidator),
    live: v.optional(v.boolean()),
    startsAt: v.optional(v.number()),
    endsAt: v.optional(v.number()),
    // "Open until" (true) or "in that class" (false) for a raw class-focus
    // end (TRA-726). Optional: absent, the dates decide, as before.
    openUntilKind: v.optional(v.boolean()),
    dueAt: v.optional(v.number()),
  },
  handler: (ctx, args) =>
    coreDispatchActivity(ctx, { ...args, teacherId: ctx.user._id }),
});

// ── Scholar's Prep "Assign…" — one of the scholar's own questions as homework ──
//
// A question is not an activity, and homework is an `activitySchedule` entry, so
// the question rides the SAME one-scholar ad-hoc dispatch as "Dispatch now"
// (kind:"adHocDispatch", mode "homework", live, dated): it shows under the
// scholar's Prep → Due with its date, completes through the dispatch completion
// path, and closes out in "Done today?" like any homework. The dispatch activity
// carries `seedId`, which `sessions.create` stamps onto the session so starting
// it opens that seed's thread (the same seed session the question opens from
// Quests), and which `lib/questionHomework.liveQuestionHomework` reads (via the
// activity's `dispatchAssignmentId`) so the queue drops the question from the
// backlog while it is LIVE homework — archived or un-rostered, it returns. No suggestion round-trip: this is an
// obligation with a due date.

export const assignQuestionAsHomework = teacherMutation({
  args: {
    scholarId: v.id("users"),
    seedId: v.id("seeds"),
    /** Institution-local `YYYY-MM-DD` of the open school day it is due. */
    dueDayKey: v.string(),
  },
  handler: async (ctx, args) => {
    await requireActiveScholarAccess(ctx, ctx.user, args.scholarId);
    const scholar = await ctx.db.get(args.scholarId);
    if (!scholar || scholar.role !== ROLES.SCHOLAR) {
      throw new Error("Scholar not found");
    }
    const institutionId = await requireActiveLearnerInstitution(ctx, args.scholarId);
    if (!institutionId) throw new Error("This scholar has no school yet");
    const timeZone = await timeZoneForInstitution(ctx, institutionId);

    // A future OPEN school day for the scholar's institution: after today,
    // a weekday, not inside a calendar closure.
    if (!/^\d{4}-\d{2}-\d{2}$/.test(args.dueDayKey)) {
      throw new ConvexError("Pick a school day");
    }
    const todayKey = dayKeyForTimezone(Date.now(), timeZone);
    if (args.dueDayKey <= todayKey) {
      throw new ConvexError("Pick a school day after today");
    }
    const [openDay] = await findNextOpenSchoolDayKeys(
      ctx,
      institutionId,
      shiftDayKey(args.dueDayKey, -1),
      timeZone,
      1,
    );
    if (openDay !== args.dueDayKey) {
      throw new ConvexError("That day isn't a school day");
    }
    const dueAt = schoolDayEndAt(args.dueDayKey, timeZone);

    // Cheap ownership check first: the seed must be this scholar's.
    const seed = await ctx.db.get(args.seedId);
    if (!seed || seed.scholarId !== args.scholarId) {
      throw new ConvexError("That question isn't open for this scholar");
    }

    // Idempotent per (scholar, seed, day); one live homework per question.
    const existing = await liveQuestionHomework(ctx, args.scholarId, args.seedId);
    if (existing) {
      const existingDay =
        existing.dueAt == null ? null : dayKeyForTimezone(existing.dueAt, timeZone);
      if (existingDay === args.dueDayKey) {
        return {
          assignmentId: existing.assignmentId,
          activityId: existing.activityId,
          dueAt: existing.dueAt ?? dueAt,
          created: false,
        };
      }
      throw new ConvexError("That question is already homework");
    }

    // The question must be one of this scholar's OPEN questions — the same
    // per-seed evaluation their Quests list / Prep "Keep going" rows come from
    // (active, not yet started, not settled, not answered correctly).
    const row = await questionRowForSeed(ctx, args.scholarId, seed);
    if (!row) {
      throw new ConvexError("That question isn't open for this scholar");
    }

    const prompt = row.question.prompt;
    const dispatched = await coreDispatchActivity(ctx, {
      teacherId: ctx.user._id,
      scholarId: args.scholarId,
      title: prompt,
      activityKind: "online",
      systemPrompt: `Homework from the scholar's teacher: pick up the scholar's own open question — «${prompt}». The notes below say what it is about. Open from that question and let the scholar reason toward it; keep it open rather than explaining it — ask, don't tell.`,
      mode: "homework",
      live: true,
      dueAt,
      seedId: args.seedId,
    });
    return {
      assignmentId: dispatched.assignmentId,
      activityId: dispatched.activityId,
      dueAt,
      created: true,
    };
  },
});

/** Aide/MCP core: same as coreDispatchActivity but role-gated on the verified
 *  caller (there's no assignment to owner-check yet — it's being created). */
export async function coreAideDispatchActivity(
  ctx: MutationCtx,
  callerUserId: Id<"users">,
  args: {
    scholarId: Id<"users">;
    title: string;
    activityKind?: "online" | "offline" | "web" | "problem_set";
    systemPrompt?: string;
    description?: string;
    webUrl?: string;
    targetSkillKeys?: string[];
    itemCount?: number;
    mode?: "classFocus" | "homework";
    finish?: GiveFinish;
    live?: boolean;
    startsAt?: number;
    endsAt?: number;
    openUntilKind?: boolean;
    dueAt?: number;
  },
): Promise<{
  assignmentId: Id<"assignments">;
  activityId: Id<"activities">;
  activityKind: "online" | "offline" | "web" | "problem_set";
  attachedVideoResource: boolean;
  // From the stored row, not the request.
  live: boolean;
}> {
  const u = await ctx.db.get(callerUserId);
  if (!u || !isTeacherRole(u.role as never)) {
    throw new Error("Dispatch is teacher/admin only");
  }
  const res = await coreDispatchActivity(ctx, { ...args, teacherId: callerUserId });
  const stored = await storedEntry(ctx, res.assignmentId, res.activityId);
  return { ...res, live: stored?.setAt != null };
}

/** Aide/MCP core: same as assignWork but role-gated on the verified caller
 *  (there's no assignment to owner-check yet — it may be created here). */
export async function coreAideAssignWork(
  ctx: MutationCtx,
  callerUserId: Id<"users">,
  args: {
    unitId: Id<"units">;
    scholarIds: Id<"users">[];
    title?: string;
    startsAt: number;
    target: AssignWorkTarget;
    finish?: GiveFinish;
  },
): Promise<{ assignmentId: Id<"assignments">; created: boolean; live: boolean }> {
  const u = await ctx.db.get(callerUserId);
  // Teacher/admin, or a curriculum:run holder — coreAssignWork then enforces
  // the runner's unit + same-school-assignee boundary itself.
  if (!u || !(await canRunAssignments(ctx, u))) {
    throw new Error("Assign is teacher/admin only");
  }
  return coreAssignWork(ctx, { ...args, teacherId: callerUserId });
}


/** Add scholars to the roster, keeping the existing members. */
async function applyAddScholars(
  ctx: MutationCtx,
  a: Doc<"assignments">,
  scholarIds: Id<"users">[],
) {
  // A proposed Quest's assignment holds only its proposer (TRA-685).
  if (a.unitId) assertProposedQuestRecipients(await ctx.db.get(a.unitId), scholarIds);
  await ctx.db.patch(a._id, {
    scholarIds: Array.from(new Set([...a.scholarIds, ...scholarIds])),
  });
}

/** Archive (end) an assignment — also clears its schedule so nothing
 *  stays live or fires later. */
async function applyArchive(ctx: MutationCtx, a: Doc<"assignments">) {
  for (const entry of await readSchedule(ctx, a)) {
    if (entry.scheduledFnId) {
      await ctx.scheduler.cancel(entry.scheduledFnId);
    }
  }
  // Schedule placements are execution chips, not the recurring class shell.
  // Remove only rows linked to this assignment so a later reconciliation cannot
  // repopulate an archived assignment while the bare timetable remains intact.
  const placements = await ctx.db
    .query("schedulePlacements")
    .withIndex("by_assignment", (q) => q.eq("assignmentId", a._id))
    .collect();
  for (const placement of placements) {
    await ctx.db.delete(placement._id);
  }
  await syncClassesForPlacements(ctx, placements);
  await ctx.db.patch(a._id, { archivedAt: Date.now() });
  await writeSchedule(ctx, a, []);
}

/**
 * Defense-in-depth: an activity targeted by a schedule edit must belong
 * to the assignment's unit. The aide gets activityIds from
 * aideGetAssignment, but we never trust ids the model echoes back —
 * scheduling an arbitrary activity onto a cohort would be a privacy /
 * correctness hole. Throws if the activity is missing or off-unit.
 */
async function assertActivityInUnit(
  ctx: { db: QueryCtx["db"] },
  a: Doc<"assignments">,
  activityId: Id<"activities">,
) {
  const act = await ctx.db.get(activityId);
  if (!act) throw new Error("Activity not found");
  if (act.lessonId) {
    const lesson = await ctx.db.get(act.lessonId);
    if (!lesson || lesson.unitId !== a.unitId) {
      throw new Error("Activity is not part of this assignment's unit");
    }
  }
}

/**
 * Activities of a unit (or one lesson), in teaching order — drives the
 * cadence layout in `assignWork`. Lessons and activities are sorted by
 * their `order` field (the FK indexes don't return ordered).
 */
export async function gatherUnitActivities(
  ctx: { db: QueryCtx["db"] },
  unitId: Id<"units">,
  lessonId: Id<"lessons"> | null,
): Promise<Doc<"activities">[]> {
  const lessons = lessonId
    ? [await ctx.db.get(lessonId)].filter((l): l is Doc<"lessons"> => !!l)
    : (
        await ctx.db
          .query("lessons")
          .withIndex("by_unit", (q) => q.eq("unitId", unitId))
          .collect()
      ).sort((a, b) => a.order - b.order);
  const out: Doc<"activities">[] = [];
  for (const l of lessons) {
    const acts = (
      await ctx.db
        .query("activities")
        .withIndex("by_lesson", (q) => q.eq("lessonId", l._id))
        .collect()
    )
      // Archived activities are retired from the active curriculum — a bulk
      // unit/lesson assign skips them (assign them individually via unarchive).
      .filter((a) => !a.archivedAt)
      .sort((a, b) => a.order - b.order);
    out.push(...acts);
  }
  return out;
}

// ─── Aide tool wrappers (internal) ───────────────────────────────────
// The teacher Aide runs in an HTTP action with a VERIFIED callerUserId
// but no `ctx.user`, so it can't use the teacherMutation/teacherQuery
// gate. These internal fns re-do the ownership check explicitly against
// callerUserId (the owner, or an admin over the assignment's school; see
// lib/assignmentAuthority.ts), then share the exact reads/writes the
// teacher-UI uses. Tool gating to teacher/admin happens in lib/aideTools.

async function requireOwnedAssignmentBy(
  ctx: QueryCtx,
  assignmentId: Id<"assignments">,
  callerUserId: Id<"users">,
  activityId?: Id<"activities">,
): Promise<Doc<"assignments"> | null> {
  const a = await ctx.db.get(assignmentId);
  if (!a) return null;
  const caller = await ctx.db.get(callerUserId);
  if (!caller || !(await mayActOnAssignment(ctx, caller, a))) {
    throw new Error("Not your assignment");
  }
  // A non-teacher owner is a curriculum:run holder (the aide only offers her
  // the run tools): she must still be able to run the unit, and any named
  // activity must be one of its lesson activities. Teachers are unchanged.
  if (!isTeacherRole(caller.role)) {
    await requireCanRunOwnedAssignment(ctx, caller, a);
    if (activityId) await assertActivityInUnitStrict(ctx, a.unitId!, activityId);
  }
  return a;
}

/** The aide's form of mayActOnAssignment: it holds a caller id, not a doc. */
async function aideMayActOn(
  ctx: QueryCtx,
  callerUserId: Id<"users">,
  a: Doc<"assignments">,
): Promise<boolean> {
  if (a.teacherId === callerUserId) return true;
  const caller = await ctx.db.get(callerUserId);
  return !!caller && (await mayActOnAssignment(ctx, caller, a));
}

/**
 * Which view of an OWNED assignment an aide read may return: "teacher" (the
 * full view), "runner" (a curriculum:run holder who can still run the unit —
 * no transcript links), or null (refuse, the existing not-yours shape).
 */
async function aideAssignmentReadRole(
  ctx: QueryCtx,
  callerUserId: Id<"users">,
  a: Doc<"assignments">,
): Promise<"teacher" | "runner" | null> {
  const caller = await ctx.db.get(callerUserId);
  if (!caller) return null;
  if (isTeacherRole(caller.role)) return "teacher";
  try {
    await requireCanRunOwnedAssignment(ctx, caller, a);
    return "runner";
  } catch {
    return null;
  }
}

// ── Aide cores (the single implementation) ──────────────────────────────
// Each owner-checked aide op is a plain exported async function. TWO
// callers share them:
//   - the internal Convex fns below — the AIDE/Slack path runs in an HTTP
//     ACTION (no ctx.db), so it MUST go through registered functions, which
//     just delegate here; and
//   - convex/mcp.ts — the MCP path runs in query/mutation context (it HAS
//     ctx.db), so it calls these cores DIRECTLY. That's also what keeps
//     mcp.ts from importing `internal`/`api` (which, since mcp.ts is itself
//     in the api graph, would trigger circular type inference and poison
//     `internal`'s types repo-wide).
// Reads take a QueryCtx; writes take a MutationCtx (scheduler access).

type AideScheduleArgs = {
  assignmentId: Id<"assignments">;
  activityId: Id<"activities">;
  mode?: "classFocus" | "homework";
  finish?: GiveFinish;
  startsAt: number;
  endsAt?: number;
  openUntilKind?: boolean;
  dueAt?: number;
};
type AidePushArgs = {
  assignmentId: Id<"assignments">;
  activityId: Id<"activities">;
  mode?: "classFocus" | "homework";
  finish?: GiveFinish;
  endsAt?: number;
  openUntilKind?: boolean;
  dueAt?: number;
  // Named scholars are always added to the live audience, never swapped in.
  scholarIds?: Id<"users">[];
};

/** Discovery: the caller's active assignments with roster + a count of
 *  scheduled activities. Lets the aide map a cohort description to an
 *  assignmentId (and tell same-unit cohorts apart by roster). */
export async function coreAideListAssignments(
  ctx: QueryCtx,
  callerUserId: Id<"users">,
) {
  const caller = await ctx.db.get(callerUserId);
  if (!caller) return [];
  const rows = (
    await runnableOwnedRows(
      ctx,
      caller,
      await ctx.db
        .query("assignments")
        .withIndex("by_teacher", (q) => q.eq("teacherId", callerUserId))
        .collect(),
    )
  )
    .filter((r) => !r.archivedAt)
    // Unit-mode only — the aide maps cohorts to units/activities here;
    // standing (unitId-less) practice assignments have neither and get no aide
    // discovery surface yet. Ad-hoc dispatches (no practiceMode ⇒ default
    // "unit") stay so the aide can see/act on them, but are unitId-less, so the
    // unit read below guards the optional unitId.
    .filter((r) => (r.practiceMode ?? "unit") === "unit");
  rows.sort((a, b) => b.startedAt - a.startedAt);
  return Promise.all(
    rows.map(async (a) => {
      // Ad-hoc dispatches are unitId-less; guard the optional unitId.
      const unit = a.unitId ? await ctx.db.get(a.unitId) : null;
      const roster = await Promise.all(
        a.scholarIds.map(async (sid) => {
          const u = await ctx.db.get(sid);
          // Rosters are factual membership — never filtered; Extended
          // Education members are annotated (lib/scholarParticipationTooling).
          return {
            id: sid,
            name: u?.name ?? u?.username ?? "Unknown",
            ...extendedEducationTag(u ?? {}),
          };
        }),
      );
      return {
        assignmentId: a._id,
        title: a.title ?? null,
        unitId: a.unitId ?? null,
        unitTitle: a.unitId
          ? (unit?.title ?? "(deleted unit)")
          : (a.title ?? "Ad-hoc dispatch"),
        roster,
        scheduledCount: (await readSchedule(ctx, a)).length,
        startedAt: a.startedAt,
      };
    }),
  );
}

/** Flattened agenda feed across the caller's active assignments —
 *  one item per (assignment, activity) push, optionally windowed to
 *  [from, to) by agenda position. The primary read for bulk reschedules
 *  ("everything in the week of X"). Times are epoch-ms; the tool layer
 *  attaches human school-local labels. */
export async function coreAideSchedule(
  ctx: QueryCtx,
  callerUserId: Id<"users">,
  from?: number,
  to?: number,
) {
  const now = Date.now();
  const caller = await ctx.db.get(callerUserId);
  if (!caller) return [];
  const rows = await runnableOwnedRows(
    ctx,
    caller,
    await ctx.db
      .query("assignments")
      .withIndex("by_teacher", (q) => q.eq("teacherId", callerUserId))
      .collect(),
  );
  const out: Array<{
    assignmentId: Id<"assignments">;
    assignmentTitle: string | null;
    unitTitle: string;
    activityId: Id<"activities">;
    activityTitle: string;
    lessonTitle: string | null;
    mode: "classFocus" | "homework";
    agendaAt: number;
    startsAt: number | null;
    setAt: number | null;
    endsAt: number | null;
    dueAt: number | null;
    state: "planned" | "live" | "done";
    // Completion roll-up so "how many are done with X?" is answerable
    // straight from the schedule feed (no extra drill-in). For the full
    // per-scholar + submission breakdown use coreAideProgress.
    scholarCount: number;
    completedCount: number;
  }> = [];
  for (const a of rows) {
    if (a.archivedAt) continue;
    const entries = await readSchedule(ctx, a);
    if (entries.length === 0) continue;
    // Ad-hoc dispatches (kind "adHocDispatch") DO carry an activitySchedule yet
    // are unitId-less, so a populated schedule no longer implies a unit —
    // guard the optional unitId instead of asserting it.
    const unit = a.unitId ? await ctx.db.get(a.unitId) : null;
    const completions = await ctx.db
      .query("activityCompletions")
      .withIndex("by_assignment", (q) => q.eq("assignmentId", a._id))
      .collect();
    const doneByActivity = new Map<string, Set<string>>();
    for (const c of completions) {
      const key = String(c.activityId);
      if (!doneByActivity.has(key)) doneByActivity.set(key, new Set());
      doneByActivity.get(key)!.add(String(c.scholarId));
    }
    const rosterSize = a.scholarIds.length;
    for (const e of entries) {
      const agendaAt = e.startsAt ?? e.setAt ?? a.startedAt;
      if (from != null && agendaAt < from) continue;
      if (to != null && agendaAt >= to) continue;
      const act = await ctx.db.get(e.activityId);
      const lesson = act?.lessonId ? await ctx.db.get(act.lessonId) : null;
      const completedCount =
        doneByActivity.get(String(e.activityId))?.size ?? 0;
      const allDone = rosterSize > 0 && completedCount >= rosterSize;
      const ended = !!e.endsAt && e.endsAt <= now;
      const state: "planned" | "live" | "done" =
        e.setAt == null ? "planned" : allDone || ended ? "done" : "live";
      out.push({
        assignmentId: a._id,
        assignmentTitle: a.title ?? null,
        unitTitle: a.unitId
          ? (unit?.title ?? "Unknown")
          : (a.title ?? "Ad-hoc dispatch"),
        activityId: e.activityId,
        activityTitle: act?.title ?? "(deleted activity)",
        lessonTitle: lesson?.title ?? null,
        mode: e.mode,
        agendaAt,
        startsAt: e.startsAt ?? null,
        setAt: e.setAt ?? null,
        endsAt: e.endsAt ?? null,
        dueAt: e.dueAt ?? null,
        state,
        scholarCount: rosterSize,
        completedCount,
      });
    }
  }
  out.sort((x, y) => x.agendaAt - y.agendaAt);
  return out;
}

/** One assignment's roster + current schedule + the unit's available
 *  activities (so the aide can schedule a not-yet-scheduled activity by
 *  id). Owner-only (returns null otherwise). */
export async function coreAideGetAssignment(
  ctx: QueryCtx,
  callerUserId: Id<"users">,
  assignmentId: Id<"assignments">,
) {
  const a = await ctx.db.get(assignmentId);
  if (!a || !(await aideMayActOn(ctx, callerUserId, a))) return null;
  if ((await aideAssignmentReadRole(ctx, callerUserId, a)) === null) return null;
  // A standing (unitId-less) assignment has no unit to resolve.
  const unit = a.unitId ? await ctx.db.get(a.unitId) : null;
  const roster = await Promise.all(
    a.scholarIds.map(async (sid) => {
      const u = await ctx.db.get(sid);
      // Rosters are factual membership — never filtered; Extended Education
      // members are annotated (lib/scholarParticipationTooling.ts).
      return {
        id: sid,
        name: u?.name ?? u?.username ?? "Unknown",
        ...extendedEducationTag(u ?? {}),
      };
    }),
  );
  const aideSchedule = await readSchedule(ctx, a);
  const scheduledIds = new Set(
    aideSchedule.map((e) => String(e.activityId)),
  );
  const schedule = await Promise.all(
    aideSchedule.map(async (e) => {
      const act = await ctx.db.get(e.activityId);
      return {
        activityId: e.activityId,
        activityTitle: act?.title ?? "(deleted activity)",
        mode: e.mode,
        startsAt: e.startsAt ?? null,
        setAt: e.setAt ?? null,
        dueAt: e.dueAt ?? null,
        endsAt: e.endsAt ?? null,
        state: e.setAt == null ? ("planned" as const) : ("live" as const),
      };
    }),
  );
  // Available activities in the unit (for scheduling a new one). A
  // standing assignment has no unit, so no activities to offer here.
  const lessons = a.unitId
    ? await ctx.db
        .query("lessons")
        .withIndex("by_unit", (q) => q.eq("unitId", a.unitId!))
        .collect()
    : [];
  const available: Array<{
    activityId: Id<"activities">;
    title: string;
    lessonTitle: string;
    alreadyScheduled: boolean;
  }> = [];
  for (const l of lessons) {
    const acts = await ctx.db
      .query("activities")
      .withIndex("by_lesson", (q) => q.eq("lessonId", l._id))
      .collect();
    for (const act of acts) {
      available.push({
        activityId: act._id,
        title: act.title,
        lessonTitle: l.title,
        alreadyScheduled: scheduledIds.has(String(act._id)),
      });
    }
  }
  return {
    assignmentId: a._id,
    title: a.title ?? null,
    unitId: a.unitId,
    unitTitle: unit?.title ?? "(deleted unit)",
    roster,
    schedule,
    availableActivities: available,
  };
}

/**
 * The "how's this assignment going" insight read. One owner-only call
 * answers all three classroom-bot questions the schedule tools couldn't:
 *
 *   - "who hasn't started yet?"  → roster[].started (a project exists),
 *     surfaced as notStartedScholarNames.
 *   - "how many submissions are in for X?" → per-activity submissionCount
 *     (deliverables for this cohort) + verdict breakdown + completedCount.
 *   - "open Kai's project"       → roster[].projectId (the tool layer
 *     stamps a deep link).
 *
 * Activities are scoped to the unit but trimmed to those that are
 * scheduled OR have any completion/submission — so a since-cleared
 * activity still answers "how many submissions for X". Names (not just
 * ids) are resolved here so the model can speak them without arithmetic.
 */
export async function coreAideProgress(
  ctx: QueryCtx,
  callerUserId: Id<"users">,
  assignmentId: Id<"assignments">,
) {
  const a = await ctx.db.get(assignmentId);
  if (!a || !(await aideMayActOn(ctx, callerUserId, a))) return null;
  const readRole = await aideAssignmentReadRole(ctx, callerUserId, a);
  if (readRole === null) return null;
  const now = Date.now();
  // A standing (unitId-less) assignment has no unit to resolve.
  const unit = a.unitId ? await ctx.db.get(a.unitId) : null;

  // One entry per activity, by the shared rule (never insertion order).
  const scheduleByActivity = decidingEntryByActivity(
    await readSchedule(ctx, a),
    now,
  );

  // Projects for this cohort (exclude offline scanned-deliverable shells).
  const sessions = (
    await ctx.db
      .query("sessions")
      .withIndex("by_assignment", (q) => q.eq("assignmentId", a._id))
      .collect()
  ).filter((p) => !p.isOffline);
  const sessionByScholar = new Map(sessions.map((p) => [String(p.userId), p]));

  // Completion roll-up keyed by activity + per-scholar tally.
  const completions = await ctx.db
    .query("activityCompletions")
    .withIndex("by_assignment", (q) => q.eq("assignmentId", a._id))
    .collect();
  const doneByActivity = new Map<string, Set<string>>();
  const completedCountByScholar = new Map<string, number>();
  for (const c of completions) {
    const ak = String(c.activityId);
    if (!doneByActivity.has(ak)) doneByActivity.set(ak, new Set());
    doneByActivity.get(ak)!.add(String(c.scholarId));
    const sk = String(c.scholarId);
    completedCountByScholar.set(sk, (completedCountByScholar.get(sk) ?? 0) + 1);
  }

  const roster = await Promise.all(
    a.scholarIds.map(async (sid) => {
      const s = await ctx.db.get(sid);
      const session = sessionByScholar.get(String(sid)) ?? null;
      const lastMsg = session
        ? await ctx.db
            .query("messages")
            .withIndex("by_session", (q) => q.eq("sessionId", session._id))
            .order("desc")
            .first()
        : null;
      // Rosters are factual membership — never filtered; Extended Education
      // members are annotated (lib/scholarParticipationTooling.ts).
      return {
        scholarId: sid,
        name: s?.name ?? s?.username ?? "(unknown)",
        // The session id is the transcript deep link — teacher-only. A
        // curriculum:run owner gets started/last-active, not the transcript.
        sessionId: readRole === "teacher" ? (session?._id ?? null) : null,
        started: !!session,
        lastMessageAt: lastMsg?._creationTime ?? null,
        completedActivityCount: completedCountByScholar.get(String(sid)) ?? 0,
        ...extendedEducationTag(s ?? {}),
      };
    }),
  );
  const rosterSize = a.scholarIds.length;
  const notStartedScholarNames = roster
    .filter((r) => !r.started)
    .map((r) => r.name);

  // A standing (unitId-less) assignment has no lessons/activities to
  // roll up — skip and return an empty activities list below.
  const lessons = a.unitId
    ? (
        await ctx.db
          .query("lessons")
          .withIndex("by_unit", (q) => q.eq("unitId", a.unitId!))
          .collect()
      ).sort((x, y) => x.order - y.order)
    : [];

  const activities: Array<{
    activityId: Id<"activities">;
    title: string;
    lessonTitle: string;
    kind: string;
    mode: "classFocus" | "homework" | null;
    state: "planned" | "live" | "done" | null;
    completedCount: number;
    completedScholarNames: string[];
    notCompletedScholarNames: string[];
    submissionCount: number;
    verdicts: { full: number; half: number; not: number };
  }> = [];
  for (const l of lessons) {
    const acts = (
      await ctx.db
        .query("activities")
        .withIndex("by_lesson", (q) => q.eq("lessonId", l._id))
        .collect()
    ).sort((x, y) => x.order - y.order);
    for (const act of acts) {
      const entry = scheduleByActivity.get(String(act._id)) ?? null;
      const completedIds = doneByActivity.get(String(act._id)) ?? new Set();
      const deliverables = await ctx.db
        .query("deliverables")
        .withIndex("by_assignment_activity", (q) =>
          q.eq("assignmentId", a._id).eq("activityId", act._id),
        )
        .collect();
      // Trim to activities that matter to "how's it going": scheduled,
      // or with any history (a since-cleared push can still have work).
      if (
        entry == null &&
        completedIds.size === 0 &&
        deliverables.length === 0
      ) {
        continue;
      }
      const completedCount = completedIds.size;
      const allDone = rosterSize > 0 && completedCount >= rosterSize;
      const ended = !!entry?.endsAt && entry.endsAt <= now;
      const state: "planned" | "live" | "done" | null =
        entry == null
          ? null
          : entry.setAt == null
            ? "planned"
            : allDone || ended
              ? "done"
              : "live";
      const verdicts = { full: 0, half: 0, not: 0 };
      for (const d of deliverables) {
        if (d.overall === "full") verdicts.full++;
        else if (d.overall === "half") verdicts.half++;
        else if (d.overall === "not") verdicts.not++;
      }
      const completedScholarNames = roster
        .filter((r) => completedIds.has(String(r.scholarId)))
        .map((r) => r.name);
      const notCompletedScholarNames = roster
        .filter((r) => !completedIds.has(String(r.scholarId)))
        .map((r) => r.name);
      activities.push({
        activityId: act._id,
        title: act.title,
        lessonTitle: l.title,
        kind: act.kind,
        mode: entry?.mode ?? null,
        state,
        completedCount,
        completedScholarNames,
        notCompletedScholarNames,
        submissionCount: deliverables.length,
        verdicts,
      });
    }
  }

  return {
    assignmentId: a._id,
    assignmentTitle: a.title ?? null,
    unitId: a.unitId,
    unitTitle: unit?.title ?? "(deleted unit)",
    rosterSize,
    notStartedScholarNames,
    roster,
    activities,
  };
}

// ── Write cores (owner-checked) ─────────────────────────────────────────

export async function coreAideScheduleActivity(
  ctx: MutationCtx,
  callerUserId: Id<"users">,
  args: AideScheduleArgs,
): Promise<{ ok: true; stored: StoredGiveEntry | null }> {
  const a = await requireOwnedAssignmentBy(ctx, args.assignmentId, callerUserId, args.activityId);
  if (!a) throw new Error("Assignment not found");
  if (a.archivedAt) throw new Error("Assignment is archived");
  await assertActivityInUnit(ctx, a, args.activityId);
  const resolve = (startsAt: number) =>
    windowForAssignmentGive(ctx, a, {
      startsAt,
      answer: args,
      activityId: args.activityId,
    });
  if (args.finish) {
    await applyGive(ctx, a, {
      activityId: args.activityId,
      startsAt: args.startsAt,
      resolve,
    });
  } else {
    await detachPlacementsForGive(ctx, a._id, args.activityId);
    const { finish: _finish, ...rest } = args;
    await applyScheduleActivity(ctx, a, {
      ...rest,
      ...(await resolve(args.startsAt)),
    });
  }
  return {
    ok: true,
    stored: await storedEntry(ctx, a._id, args.activityId),
  };
}

export async function coreAideRescheduleActivity(
  ctx: MutationCtx,
  callerUserId: Id<"users">,
  args: { assignmentId: Id<"assignments">; activityId: Id<"activities">; startsAt: number },
): Promise<{ ok: boolean; found: boolean }> {
  const a = await requireOwnedAssignmentBy(ctx, args.assignmentId, callerUserId, args.activityId);
  if (!a) throw new Error("Assignment not found");
  // No archived-assignment reject here (unlike schedule/push/set/add scholars):
  // archiving empties `activitySchedule`, so reschedule/clear are harmless no-ops
  // on a dead cohort (found/removed come back false). The asymmetry is intentional.
  const found = await applyRescheduleActivity(ctx, a, args);
  return { ok: found, found };
}

export async function coreAideClearActivity(
  ctx: MutationCtx,
  callerUserId: Id<"users">,
  args: { assignmentId: Id<"assignments">; activityId: Id<"activities"> },
): Promise<{ ok: boolean; removed: boolean }> {
  const a = await requireOwnedAssignmentBy(ctx, args.assignmentId, callerUserId, args.activityId);
  if (!a) throw new Error("Assignment not found");
  // No archived-assignment reject here — see the note on coreAideRescheduleActivity.
  const removed = await applyClearActivity(ctx, a, args.activityId);
  return { ok: removed, removed };
}

/** Push-now / set focus: make an activity LIVE immediately for the whole
 *  roster (vs coreAideScheduleActivity, which plans a future push).
 *  Owner-only + the activity must belong to the assignment's unit. */
export async function coreAidePushActivityNow(
  ctx: MutationCtx,
  callerUserId: Id<"users">,
  args: AidePushArgs,
): Promise<{ ok: true; stored: StoredGiveEntry | null }> {
  const a = await requireOwnedAssignmentBy(ctx, args.assignmentId, callerUserId, args.activityId);
  if (!a) throw new Error("Assignment not found");
  if (a.archivedAt) throw new Error("Assignment is archived");
  await assertActivityInUnit(ctx, a, args.activityId);
  // Named scholars must be ones the caller can reach now, not merely names on
  // an old roster (a transferred scholar stays on it). Same rule as the give
  // choices: named scholars fail loudly.
  if (args.scholarIds?.length) {
    const caller = await ctx.db.get(callerUserId);
    if (!caller) throw new Error("Caller not found");
    if (isTeacherRole(caller.role)) {
      await requireScholarsAccessible(ctx, caller, args.scholarIds);
    } else if (a.unitId) {
      const { institutionId } = await requireRunnableUnit(ctx, caller, a.unitId);
      await requireScholarsAtInstitution(ctx, args.scholarIds, institutionId);
    } else {
      throw new Error("You can't give work to those scholars from here.");
    }
  }
  const { finish: _finish, ...rest } = args;
  await applyPushActivity(ctx, a, {
    ...rest,
    ...(await windowForAssignmentGive(ctx, a, {
      startsAt: Date.now(),
      answer: args,
      scholarIds: args.scholarIds,
      activityId: args.activityId,
      reuseLiveFinish: args.scholarIds !== undefined,
    })),
    addToLiveAudience: args.scholarIds !== undefined,
  });
  await detachPlacementsForGive(ctx, a._id, args.activityId);
  // What's stored, not what was asked: "more time" keeps a live focus's end
  // and takes the later due date (mergeIntoLiveAudience).
  return {
    ok: true,
    stored: await storedEntry(ctx, a._id, args.activityId),
  };
}

export async function coreAideSetScholars(
  ctx: MutationCtx,
  callerUserId: Id<"users">,
  assignmentId: Id<"assignments">,
  scholarIds: Id<"users">[],
): Promise<{ ok: true; rosterSize: number }> {
  const a = await requireOwnedAssignmentBy(ctx, assignmentId, callerUserId);
  if (!a) throw new Error("Assignment not found");
  if (a.archivedAt) throw new Error("Assignment is archived");
  const caller = await ctx.db.get(callerUserId);
  // Roster edits stay a teacher act; a curriculum:run owner is refused.
  if (!caller || !isTeacherRole(caller.role)) {
    throw new Error("Roster edits are teacher/admin only");
  }
  await requireScholarsAccessible(ctx, caller, scholarIds);
  await applySetScholars(ctx, a, scholarIds);
  return { ok: true, rosterSize: new Set(scholarIds).size };
}

export async function coreAideAddScholars(
  ctx: MutationCtx,
  callerUserId: Id<"users">,
  assignmentId: Id<"assignments">,
  scholarIds: Id<"users">[],
): Promise<{ ok: true; rosterSize: number }> {
  const a = await requireOwnedAssignmentBy(ctx, assignmentId, callerUserId);
  if (!a) throw new Error("Assignment not found");
  if (a.archivedAt) throw new Error("Assignment is archived");
  const caller = await ctx.db.get(callerUserId);
  // Roster edits stay a teacher act; a curriculum:run owner is refused.
  if (!caller || !isTeacherRole(caller.role)) {
    throw new Error("Roster edits are teacher/admin only");
  }
  await requireScholarsAccessible(ctx, caller, scholarIds);
  await applyAddScholars(ctx, a, scholarIds);
  return {
    ok: true,
    rosterSize: new Set([...a.scholarIds, ...scholarIds]).size,
  };
}

export async function coreAideArchive(
  ctx: MutationCtx,
  callerUserId: Id<"users">,
  assignmentId: Id<"assignments">,
): Promise<{ ok: true; alreadyArchived: boolean }> {
  // Archive stays a teacher act (the run tools don't offer it); owning the
  // assignment as a curriculum:run holder is not enough.
  const caller = await ctx.db.get(callerUserId);
  if (!caller || !isTeacherRole(caller.role)) {
    throw new Error("Archive is teacher/admin only");
  }
  const a = await requireOwnedAssignmentBy(ctx, assignmentId, callerUserId);
  if (!a) throw new Error("Assignment not found");
  if (a.archivedAt) return { ok: true, alreadyArchived: true };
  await applyArchive(ctx, a);
  return { ok: true, alreadyArchived: false };
}

// ── Internal Convex fns (the aide/Slack ACTION path) ────────────────────
// Thin delegators to the cores above — the HTTP-action aide has no ctx.db,
// so it reaches these registered functions via ctx.runQuery/runMutation.
// (The MCP path calls the cores directly; see convex/mcp.ts.)

/**
 * The aide's curriculum:run scope for a NON-teacher caller: null when she
 * holds no usable grant (no run tools), else the scholar ids she may name as
 * assignees — scholars at the schools where she holds curriculum:run +
 * curriculum:edit. This is the assignee lens only; it opens no record read.
 */
export const aideCurriculumRunScope = internalQuery({
  args: { callerUserId: v.id("users") },
  handler: async (ctx, { callerUserId }) => {
    const caller = await ctx.db.get(callerUserId);
    if (!caller || isTeacherRole(caller.role)) return null;
    const institutionIds = await curriculumRunInstitutionIds(ctx, callerUserId);
    if (institutionIds.size === 0) return null;
    const scholars = await runnerAssignableScholars(ctx, institutionIds);
    return { scholarIds: scholars.map((scholar) => scholar.id) };
  },
});

export const aideListAssignments = internalQuery({
  args: { callerUserId: v.id("users") },
  handler: (ctx, { callerUserId }) => coreAideListAssignments(ctx, callerUserId),
});

export const aideScheduleForTeacher = internalQuery({
  args: {
    callerUserId: v.id("users"),
    from: v.optional(v.number()),
    to: v.optional(v.number()),
  },
  handler: (ctx, { callerUserId, from, to }) =>
    coreAideSchedule(ctx, callerUserId, from, to),
});

export const aideGetAssignment = internalQuery({
  args: { callerUserId: v.id("users"), assignmentId: v.id("assignments") },
  handler: (ctx, { callerUserId, assignmentId }) =>
    coreAideGetAssignment(ctx, callerUserId, assignmentId),
});

export const aideAssignmentProgress = internalQuery({
  args: { callerUserId: v.id("users"), assignmentId: v.id("assignments") },
  handler: (ctx, { callerUserId, assignmentId }) =>
    coreAideProgress(ctx, callerUserId, assignmentId),
});

export const aideAssignWork = internalMutation({
  args: {
    callerUserId: v.id("users"),
    unitId: v.id("units"),
    scholarIds: v.array(v.id("users")),
    title: v.optional(v.string()),
    startsAt: v.number(),
    target: assignWorkTargetValidator,
    finish: v.optional(giveFinishValidator),
  },
  handler: (ctx, { callerUserId, ...args }) =>
    coreAideAssignWork(ctx, callerUserId, args),
});

export const aideScheduleActivity = internalMutation({
  args: {
    callerUserId: v.id("users"),
    assignmentId: v.id("assignments"),
    activityId: v.id("activities"),
    mode: v.optional(v.union(v.literal("classFocus"), v.literal("homework"))),
    finish: v.optional(giveFinishValidator),
    startsAt: v.number(),
    endsAt: v.optional(v.number()),
    // "Open until" (true) or "in that class" (false) for a raw class-focus
    // end (TRA-726). Optional: absent, the dates decide, as before.
    openUntilKind: v.optional(v.boolean()),
    dueAt: v.optional(v.number()),
  },
  handler: (ctx, { callerUserId, ...args }) =>
    coreAideScheduleActivity(ctx, callerUserId, args),
});

export const aideRescheduleActivity = internalMutation({
  args: {
    callerUserId: v.id("users"),
    assignmentId: v.id("assignments"),
    activityId: v.id("activities"),
    startsAt: v.number(),
  },
  handler: (ctx, { callerUserId, ...args }) =>
    coreAideRescheduleActivity(ctx, callerUserId, args),
});

export const aideClearActivity = internalMutation({
  args: {
    callerUserId: v.id("users"),
    assignmentId: v.id("assignments"),
    activityId: v.id("activities"),
  },
  handler: (ctx, { callerUserId, ...args }) =>
    coreAideClearActivity(ctx, callerUserId, args),
});

export const aidePushActivityNow = internalMutation({
  args: {
    callerUserId: v.id("users"),
    assignmentId: v.id("assignments"),
    activityId: v.id("activities"),
    mode: v.optional(v.union(v.literal("classFocus"), v.literal("homework"))),
    finish: v.optional(giveFinishValidator),
    endsAt: v.optional(v.number()),
    // "Open until" (true) or "in that class" (false) for a raw class-focus
    // end (TRA-726). Optional: absent, the dates decide, as before.
    openUntilKind: v.optional(v.boolean()),
    dueAt: v.optional(v.number()),
    scholarIds: v.optional(v.array(v.id("users"))),
  },
  handler: (ctx, { callerUserId, ...args }) =>
    coreAidePushActivityNow(ctx, callerUserId, args),
});

export const aideDispatchActivity = internalMutation({
  args: {
    callerUserId: v.id("users"),
    scholarId: v.id("users"),
    title: v.string(),
    activityKind: v.optional(
      v.union(
        v.literal("online"),
        v.literal("offline"),
        v.literal("web"),
        v.literal("problem_set"),
      ),
    ),
    systemPrompt: v.optional(v.string()),
    description: v.optional(v.string()),
    webUrl: v.optional(v.string()),
    targetSkillKeys: v.optional(v.array(v.string())),
    itemCount: v.optional(v.number()),
    mode: v.optional(v.union(v.literal("classFocus"), v.literal("homework"))),
    finish: v.optional(giveFinishValidator),
    live: v.optional(v.boolean()),
    startsAt: v.optional(v.number()),
    endsAt: v.optional(v.number()),
    // "Open until" (true) or "in that class" (false) for a raw class-focus
    // end (TRA-726). Optional: absent, the dates decide, as before.
    openUntilKind: v.optional(v.boolean()),
    dueAt: v.optional(v.number()),
  },
  handler: (ctx, { callerUserId, ...args }) =>
    coreAideDispatchActivity(ctx, callerUserId, args),
});

export const aideSetScholars = internalMutation({
  args: {
    callerUserId: v.id("users"),
    assignmentId: v.id("assignments"),
    scholarIds: v.array(v.id("users")),
  },
  handler: (ctx, { callerUserId, assignmentId, scholarIds }) =>
    coreAideSetScholars(ctx, callerUserId, assignmentId, scholarIds),
});

export const aideAddScholars = internalMutation({
  args: {
    callerUserId: v.id("users"),
    assignmentId: v.id("assignments"),
    scholarIds: v.array(v.id("users")),
  },
  handler: (ctx, { callerUserId, assignmentId, scholarIds }) =>
    coreAideAddScholars(ctx, callerUserId, assignmentId, scholarIds),
});

/**
 * REMOVE named scholars from an OWNED assignment's roster, keeping everyone
 * else — the safe single-child edit that set_assignment_scholars (replace
 * the whole roster) made error-prone. Names are matched against the
 * assignment's OWN roster, not the caller's visible scholars, so a child who
 * has since moved to another school can still be taken off. Removal grants
 * nothing, and the owner already sees this roster, so it needs no access
 * check on the removed scholars. Goes through applySetScholars, so targeted
 * schedule entries are pruned exactly as a roster replace prunes them.
 */
export async function coreAideRemoveScholars(
  ctx: MutationCtx,
  callerUserId: Id<"users">,
  assignmentId: Id<"assignments">,
  scholarNames: string[],
): Promise<
  | { ok: true; removed: string[]; rosterSize: number }
  | { ok: false; message: string }
> {
  const a = await requireOwnedAssignmentBy(ctx, assignmentId, callerUserId);
  if (!a) throw new Error("Assignment not found");
  if (a.archivedAt) throw new Error("Assignment is archived");
  const caller = await ctx.db.get(callerUserId);
  // Roster edits stay a teacher act; a curriculum:run owner is refused.
  if (!caller || !isTeacherRole(caller.role)) {
    throw new Error("Roster edits are teacher/admin only");
  }
  // The same label get_assignment shows (name, else username), plus the
  // username so two children with one name can be told apart.
  const roster: Array<{ id: Id<"users">; name: string; username: string | null }> = [];
  for (const id of a.scholarIds) {
    const u = await ctx.db.get(id);
    roster.push({
      id,
      name: u?.name ?? u?.username ?? "",
      username: u?.username ?? null,
    });
  }
  const label = (r: (typeof roster)[number]) =>
    r.username && r.username !== r.name ? `${r.name} (${r.username})` : r.name;
  const remove = new Set<Id<"users">>();
  const removed: string[] = [];
  const problems: string[] = [];
  for (const query of scholarNames) {
    // Exact matches on EITHER the name or the username are weighed together,
    // so one child's username can never silently win over another child whose
    // display name is exactly the query; two different children → ambiguous.
    // Only with no exact match does the partial name match apply.
    const q = query.trim().toLowerCase();
    const exact = roster.filter(
      (r) => r.name.trim().toLowerCase() === q || r.username?.toLowerCase() === q,
    );
    const m =
      exact.length === 1
        ? ({ kind: "match", scholar: exact[0] } as const)
        : exact.length > 1
          ? ({ kind: "ambiguous", candidates: exact } as const)
          : matchByName(query, roster);
    if (m.kind === "match") {
      if (!remove.has(m.scholar.id)) removed.push(m.scholar.name);
      remove.add(m.scholar.id);
    } else if (m.kind === "ambiguous") {
      problems.push(
        `"${query}" matches ${m.candidates.map(label).join(", ")}; name one by username`,
      );
    } else {
      problems.push(`"${query}" isn't on this roster`);
    }
  }
  if (problems.length > 0) {
    return { ok: false, message: `${problems.join("; ")}. No change made.` };
  }
  if (remove.size === 0) return { ok: false, message: "No scholars given to remove." };
  const next = a.scholarIds.filter((id) => !remove.has(id));
  if (next.length === 0) {
    return {
      ok: false,
      message:
        "That would empty the roster. Archive the assignment instead (archive_assignment). No change made.",
    };
  }
  await applySetScholars(ctx, a, next);
  return { ok: true, removed, rosterSize: next.length };
}

export const aideRemoveScholars = internalMutation({
  args: {
    callerUserId: v.id("users"),
    assignmentId: v.id("assignments"),
    scholarNames: v.array(v.string()),
  },
  handler: (ctx, { callerUserId, assignmentId, scholarNames }) =>
    coreAideRemoveScholars(ctx, callerUserId, assignmentId, scholarNames),
});

export const aideArchiveAssignment = internalMutation({
  args: { callerUserId: v.id("users"), assignmentId: v.id("assignments") },
  handler: (ctx, { callerUserId, assignmentId }) =>
    coreAideArchive(ctx, callerUserId, assignmentId),
});

/**
 * Go-live flip for a planned entry — fires at its `startsAt`. Stamps
 * `setAt` (making it visible to scholars) and, for a classFocus entry
 * with an `endsAt`, schedules the auto-clear. Re-validated: only acts
 * if the entry still exists, is still planned (no setAt), and its
 * startsAt hasn't been moved past now since the job was scheduled.
 */
export const activateScheduledActivity = internalMutation({
  args: {
    assignmentId: v.id("assignments"),
    activityId: v.id("activities"),
  },
  handler: async (ctx, { assignmentId, activityId }) => {
    const a = await ctx.db.get(assignmentId);
    if (!a || a.archivedAt) return;
    const now = Date.now();
    const schedule = await readSchedule(ctx, a);
    const idx = schedule.findIndex((e) => e.activityId === activityId);
    if (idx === -1) return;
    const entry = schedule[idx];
    const without = schedule.filter((e) => e.activityId !== activityId);
    const act = await ctx.db.get(activityId);
    if (!act) {
      await writeSchedule(ctx, a, without, { activityId });
      return;
    }
    // Already live, or rescheduled to the future — don't activate.
    if (entry.setAt != null) return;
    // An app activity with no app that scholars can't build either (planned
    // before the give-time check, or changed since): it stays planned rather
    // than going live with nothing in it.
    if (await appActivityHasNothingToOpen(ctx, act)) {
      console.warn(
        `[activateScheduledActivity] ${activityId} has no app and scholars can't build one; left planned`,
      );
      return;
    }
    if (entry.startsAt != null && entry.startsAt > now) return;
    if (
      entry.mode === "classFocus" &&
      entry.endsAt !== undefined &&
      entry.endsAt <= now
    ) {
      await writeSchedule(ctx, a, without, {
        activityId,
        clearedReason: "expired",
      });
      return;
    }
    // Live now: the row holds the auto-clear job in place of this one (none
    // for open-until work, which keeps its row past the close).
    // Goes live with the teacher's finish as planned (TRA-726): open-until
    // work stays open until its day even when that day is today.
    const live = { ...entry, setAt: now };
    const autoClearId = await armFocusAutoClear(ctx, a, activityId, live);
    schedule[idx] = { ...live, scheduledFnId: autoClearId };
    await writeSchedule(ctx, a, schedule, { activityId });
  },
});

/**
 * End a live class focus at its `endsAt`. It acts only on the LIVE occurrence
 * it was armed for: `armedSetAt` is that occurrence's `setAt` (absent on a job
 * queued before the write switch, which then accepts only a live focus). A
 * planned entry, or a newer occurrence of the same activity, is never touched,
 * and a `scheduledFnId` owned by another pending job is never overwritten.
 */
export const autoClearActivity = internalMutation({
  args: {
    assignmentId: v.id("assignments"),
    activityId: v.id("activities"),
    armedSetAt: v.optional(v.number()),
  },
  handler: async (ctx, { assignmentId, activityId, armedSetAt }) => {
    const a = await ctx.db.get(assignmentId);
    if (!a) return;
    const schedule = await readSchedule(ctx, a);
    const entry = schedule.find(
      (e) => e.activityId === activityId && e.mode === "classFocus",
    );
    // Planned (not live), or gone: not the occurrence this was armed for.
    if (!entry || entry.setAt == null || !entry.endsAt) return;
    // A different live occurrence of the same activity.
    if (armedSetAt !== undefined && entry.setAt !== armedSetAt) return;
    // Open-until work keeps its row past the close (armFocusAutoClear).
    // This covers a job queued before the entry became open-until.
    if (await isOpenUntilEntry(ctx, a, entry)) return;
    if (entry.endsAt > Date.now()) {
      // The focus now ends later. When the row already holds a job, that job
      // owns the new end (every re-time schedules its own); leave it alone.
      if (entry.scheduledFnId !== undefined) return;
      // Untracked (a focus from before the write switch, re-timed by a path
      // that kept no handle): follow the new end so the focus still clears,
      // and keep the handle on the row so it can be cancelled.
      const rearmed = await ctx.scheduler.runAt(
        entry.endsAt,
        internal.assignments.autoClearActivity,
        { assignmentId, activityId, armedSetAt: entry.setAt },
      );
      await writeSchedule(
        ctx,
        a,
        schedule.map((e) =>
          e === entry ? { ...e, scheduledFnId: rearmed } : e,
        ),
        { activityId },
      );
      return;
    }
    // The row closes rather than disappearing — `expired` is the whole
    // reason the table keeps the row instead of deleting it.
    await writeSchedule(
      ctx,
      a,
      schedule.filter((e) => e.activityId !== activityId),
      { activityId, clearedReason: "expired" },
    );

  },
});
