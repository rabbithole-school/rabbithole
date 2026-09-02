import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";
import {
  authedMutation,
  authedQuery,
  teacherMutation,
  teacherQuery,
} from "./lib/customFunctions";
import { ROLES, isTeacherRole } from "./lib/roles";
import {
  syncScheduleMirror,
  syncScheduleMirrorAll,
} from "./lib/scheduleMirror";
import { resolveActivityWebTarget } from "./lib/webActivityTarget";
import {
  effectiveInstitutionTimeZone,
  timeZoneForInstitution,
  timeZoneForScholar,
  timeZoneForStaff,
} from "./lib/institutionTime";
import { ONBOARDING_UNIT_SLUG } from "./onboardingData";
import {
  DEFAULT_TIMEZONE,
  dayKeyForTimezone,
  shiftDayKey,
  weekdayForDayKey,
} from "../shared/institutionDay";
import { subjectMatches, uniqueSubjects } from "../lib/subjects";
import { getGame } from "../lib/games/catalog";
import type { Id, Doc } from "./_generated/dataModel";
import type { QueryCtx, MutationCtx } from "./_generated/server";
import {
  requireScholarsAccessible,
  resolveActiveMembership,
} from "./lib/access";
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
  nextOpenSchoolDayKey as findNextOpenSchoolDayKey,
  nextOpenSchoolDayKeys as findNextOpenSchoolDayKeys,
  schoolDayEndAt,
} from "./lib/schoolDays";
import {
  buildComingUpGroups,
  type ComingUpHomework,
  type ComingUpPlanned,
} from "../shared/comingUp";

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

type ScheduleEntry = NonNullable<Doc<"assignments">["activitySchedule"]>[number];

async function homeworkCalendarForRoster(
  ctx: QueryCtx,
  scholarIds: readonly Id<"users">[],
  institutionHint?: Id<"institutions">,
): Promise<{
  institutionId: Id<"institutions"> | undefined;
  timeZone: string;
}> {
  if (institutionHint) {
    return {
      institutionId: institutionHint,
      timeZone: await timeZoneForInstitution(ctx, institutionHint),
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
    timeZone: await timeZoneForInstitution(ctx, institutionId),
  };
}

async function defaultHomeworkDueAt(
  ctx: QueryCtx,
  scholarIds: readonly Id<"users">[],
  fromMs = Date.now(),
  institutionHint?: Id<"institutions">,
): Promise<number> {
  const { institutionId, timeZone } = await homeworkCalendarForRoster(
    ctx,
    scholarIds,
    institutionHint,
  );
  return (
    await nextOpenSchoolDayEndAt(ctx, institutionId, fromMs, timeZone)
  ).dueAt;
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

export type ScholarTimetableContext = {
  periodId: Id<"reportingPeriods"> | null;
  groupIds: Id<"scholarGroups">[];
  placements: Doc<"schedulePlacements">[];
  subjectTabs: string[];
  subjectByWork: Map<string, string>;
};

function scheduleWorkKey(
  assignmentId: Id<"assignments">,
  activityId: Id<"activities">,
): string {
  return `${assignmentId}::${activityId}`;
}

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

export function resolveScholarWorkSubject(
  timetable: ScholarTimetableContext,
  assignmentId: Id<"assignments"> | null | undefined,
  activityId: Id<"activities"> | null | undefined,
  unitSubject: string | null | undefined,
): string | null {
  if (assignmentId && activityId) {
    const placementSubject = timetable.subjectByWork.get(
      scheduleWorkKey(assignmentId, activityId),
    );
    if (placementSubject) return placementSubject;
  }

  const matchingTimetableSubject = timetable.subjectTabs.find((subject) =>
    subjectMatches(unitSubject, subject),
  );
  if (matchingTimetableSubject) return matchingTimetableSubject;
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
 * This is the honest "can the scholar complete this focus solo?" signal used to
 * gate the read-only focus lock: a class focus the scholar can't self-complete
 * must not padlock their other work. See `soloStartableByMe` below +
 * lib/focusLock.ts + PR #707's root-cause writeup.
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
 * NOTE the split below. This predicate answers "may it hold the scholar
 * in?"; `isEntryShowing` answers "is it still on their screen?". They
 * differ only for an overrun-but-unwrapped focus, which keeps its label
 * and loses its wall.
 */
export function isLiveEntry(e: ScheduleEntry, now: number): boolean {
  return e.setAt != null && (!e.endsAt || e.endsAt > now);
}

/**
 * Is this entry still on the scholar's screen?
 *
 * Started, and not yet wrapped. Deliberately NOT gated on `endsAt`: a focus
 * whose window has closed but that nobody has ended is still the thing the
 * class is on — that is exactly what the teacher's own surface calls
 * "running long", where it offers Extend / Wrap rather than pretending the
 * focus vanished. When the scholar's surfaces disagreed with that, the Now
 * ladder declared the day empty (and printed its "Open work" fallback) while
 * the plate directly below was still printing "Class focus" for the same
 * work.
 *
 * CLASS FOCUS ONLY. Both callers filter on `mode === "classFocus"` first, and
 * that is load-bearing: on a `homework` entry `endsAt` does not mean "the
 * window closed", it means a staff member ENDED the work early
 * (`endProgramActivity`). Applying this predicate to homework would put that
 * withdrawn work back in front of the scholar.
 */
export function isEntryShowing(e: ScheduleEntry): boolean {
  return e.setAt != null;
}

/**
 * May this entry hold the scholar inside its unit?
 *
 * The wall, unlike the label, closes on `endsAt` at READ time, and that is
 * what keeps the lock independent of the clear job. If `autoClearActivity`
 * is delayed or dropped, the wall still comes down on time.
 */
export function isEntryBlocking(e: ScheduleEntry, now: number): boolean {
  return isEntryShowing(e) && (!e.endsAt || e.endsAt > now);
}

/** Live entries: started (setAt stamped) and not past endsAt. */
function activeScheduleEntries(
  assignment: Doc<"assignments">,
  now = Date.now(),
) {
  const schedule = assignment.activitySchedule ?? [];
  return schedule.filter((e) => isLiveEntry(e, now));
}

/** Entries still on a scholar's screen: started, and not yet wrapped. */
function showingScheduleEntries(assignment: Doc<"assignments">) {
  const schedule = assignment.activitySchedule ?? [];
  return schedule.filter(isEntryShowing);
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
  for (const e of a.activitySchedule ?? []) {
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
 * Used only in the scholar branch of `currentClassFocusForMe` to lift the
 * read-only focus lock the moment the required work is done (see failure (a)
 * in components/SessionInterface.tsx). The teacher-facing view is unaffected.
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
  entry: NonNullable<Doc<"assignments">["activitySchedule"]>[number],
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
    // card-sort done together in class) has no solo surface, so it must NOT
    // drive the hard read-only focus lock. Gated in lib/focusLock.ts. See
    // PR #707's root-cause writeup + Andy's approval.
    //
    // Also false once the window has closed. An overrun focus keeps its
    // LABEL — it is "running long", the teacher hasn't wrapped it, and it is
    // still what the class is on — but it stops driving the wall. That split
    // is what makes a slipped clear job cost a stale line on a screen rather
    // than a scholar locked out of their own app with nobody to release them.
    soloStartableByMe: activity
      ? SCHOLAR_SOLO_STARTABLE_KINDS.has(activity.kind) &&
        isEntryBlocking(entry, Date.now())
      : false,
  };
}

export async function homeworkForScholarFromAssignments(
  ctx: QueryCtx,
  scholarId: Id<"users">,
  candidates: readonly Doc<"assignments">[],
  now = Date.now(),
) {
  const out: Array<
    Awaited<ReturnType<typeof enrichScheduleEntryForScholar>>
  > = [];
  for (const assignment of candidates) {
    if (assignment.archivedAt || !targetsScholar(assignment, scholarId)) continue;
    for (const entry of activeScheduleEntries(assignment, now)) {
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
    const now = Date.now();
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
        for (const entry of assignment.activitySchedule ?? []) {
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
        activitySchedule: [],
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
      const frozenSchedule = (assignment.activitySchedule ?? []).map((entry) =>
        entry.scholarIds === undefined
          ? { ...entry, scholarIds: previousRoster }
          : entry,
      );
      await ctx.db.patch(assignment._id, {
        scholarIds: nextRoster,
        activitySchedule: frozenSchedule,
      });
      assignment = {
        ...assignment,
        scholarIds: nextRoster,
        activitySchedule: frozenSchedule,
      };
      await syncScheduleMirrorAll(ctx, assignment, frozenSchedule);
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
    const activitySchedule = (assignment.activitySchedule ?? []).map((entry) => {
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
    await ctx.db.patch(assignment._id, { activitySchedule });
    // Clear the mirror rather than restamping it. On a homework entry `endsAt`
    // records an early WITHDRAWAL, and the push shape has no field for that —
    // its homework timing carries only `dueAt`, so a restamp would leave an
    // open push until the original due date and hand the work back the moment
    // reads switch over.
    await syncScheduleMirror(
      ctx,
      { ...assignment, activitySchedule },
      activityId,
      null,
      "teacher",
    );
    return { ended: true };
  },
});

/**
 * Create a new Assignment. Walks the unit's activities and
 * auto-populates activitySchedule with every defaultMode="homework"
 * activity (immediate homework push for the cohort). classFocus-default
 * activities stay dormant — the teacher pushes them from the Run page
 * when ready.
 */
export const create = teacherMutation({
  args: {
    unitId: v.id("units"),
    scholarIds: v.array(v.id("users")),
    title: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireScholarsAccessible(ctx, ctx.user, args.scholarIds);
    const teacherId = ctx.user._id;
    const now = Date.now();
    const unit = await ctx.db.get(args.unitId);
    const institutionId =
      unit?.institutionId ??
      (await resolveActiveMembership(ctx, ctx.user))?.institutionId;
    let homeworkDueAt: number | null = null;

    // Auto-fill schedule from activities' defaultMode.
    const lessons = await ctx.db
      .query("lessons")
      .withIndex("by_unit", (q) => q.eq("unitId", args.unitId))
      .collect();
    const autoEntries: Array<{
      activityId: Id<"activities">;
      mode: "classFocus" | "homework";
      setAt: number;
      dueAt?: number;
    }> = [];
    for (const l of lessons) {
      const acts = await ctx.db
        .query("activities")
        .withIndex("by_lesson", (q) => q.eq("lessonId", l._id))
        .collect();
      for (const a of acts) {
        if (a.defaultMode === "homework") {
          homeworkDueAt ??= await defaultHomeworkDueAt(
            ctx,
            args.scholarIds,
            now,
            institutionId,
          );
          autoEntries.push({
            activityId: a._id,
            mode: "homework",
            setAt: now,
            dueAt: homeworkDueAt,
          });
        }
      }
    }

    const newAssignmentId = await ctx.db.insert("assignments", {
      teacherId,
      unitId: args.unitId,
      scholarIds: Array.from(new Set(args.scholarIds)),
      title: args.title?.trim() || undefined,
      startedAt: now,
      activitySchedule: autoEntries,
    });
    await syncScheduleMirrorAll(
      ctx,
      (await ctx.db.get(newAssignmentId))!,
      autoEntries,
    );
    return newAssignmentId;
  },
});

/**
 * Assign work in ONE step: find-or-create the cohort × unit assignment
 * AND schedule something on it at a chosen time. This is what the
 * "Assign" dialog calls — an assignment is never born dateless/inert.
 *
 * `target` picks the granularity:
 *   - activity → schedule that single activity at `startsAt` in `mode`.
 *   - lesson   → land that lesson's activities on `startsAt`.
 *   - unit     → same, across the whole unit's activities in order.
 * Multi-activity (unit/lesson) entries use each activity's own
 * `defaultMode` (classFocus unless the curriculum marks it homework).
 * There's no authored per-activity pacing: a unit/lesson lands everything
 * on `startsAt` (planned, not auto-activated) and the teacher paces it
 * live with Start-now.
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
    mode: v.union(v.literal("classFocus"), v.literal("homework")),
    endsAt: v.optional(v.number()),
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
      mode: "classFocus" | "homework";
      endsAt?: number;
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
};

async function coreAssignWork(
  ctx: MutationCtx,
  args: AssignWorkCoreArgs,
): Promise<{ assignmentId: Id<"assignments">; created: boolean }> {
  const teacher = await ctx.db.get(args.teacherId);
  if (!teacher) throw new Error("Teacher not found");
  const unit = await ctx.db.get(args.unitId);
  const institutionId =
    unit?.institutionId ??
    (await resolveActiveMembership(ctx, teacher))?.institutionId;
  await requireScholarsAccessible(ctx, teacher, args.scholarIds);
  const roster = Array.from(new Set(args.scholarIds));
  if (roster.length === 0) throw new Error("Pick at least one scholar.");

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
      activitySchedule: [],
    });
  }

  if (args.target.kind === "activity") {
    const a = (await ctx.db.get(assignmentId))!;
    const dueAt =
      args.target.mode === "homework"
        ? (args.target.dueAt ??
          (await defaultHomeworkDueAt(
            ctx,
            roster,
            args.startsAt,
            institutionId,
          )))
        : undefined;
    await applyScheduleActivity(ctx, a, {
      activityId: args.target.activityId,
      mode: args.target.mode,
      startsAt: args.startsAt,
      endsAt: args.target.endsAt,
      dueAt,
      scholarIds: args.target.scholarIds,
    });
    return { assignmentId, created };
  }

  // unit / lesson → land every activity on the start date. There's no
  // authored per-activity pacing: everything is planned (setAt null) on
  // `startsAt` and NOT auto-activated, so a whole unit doesn't flip live
  // all at once — the teacher paces it live with "Start now" (set focus)
  // as they reach each piece.
  const activities = await gatherUnitActivities(
    ctx,
    args.unitId,
    args.target.kind === "lesson" ? args.target.lessonId : null,
  );
  const startsAt = args.startsAt;
  const homeworkDueAt = activities.some(
    (activity) => activity.defaultMode === "homework",
  )
    ? await defaultHomeworkDueAt(
        ctx,
        roster,
        startsAt,
        institutionId,
      )
    : undefined;
  for (let i = 0; i < activities.length; i++) {
    const act = activities[i];
    const mode: "classFocus" | "homework" =
      act.defaultMode === "homework" ? "homework" : "classFocus";
    // A draft handout should not roll back an otherwise valid whole-unit or
    // lesson assignment. Single-activity publishing still rejects it below.
    if (
      mode === "homework" &&
      act.kind === "offline" &&
      !(await hasReadableOfflineHomeworkContent(ctx, act))
    ) {
      continue;
    }
    // Re-fetch each iteration: applyScheduleActivity patches the doc, so
    // a cached copy would clobber prior entries.
    const a = (await ctx.db.get(assignmentId))!;
    await applyScheduleActivity(
      ctx,
      a,
      {
        activityId: act._id,
        mode,
        startsAt,
        endsAt: mode === "classFocus" ? startsAt + 3_600_000 : undefined,
        dueAt: mode === "homework" ? homeworkDueAt : undefined,
      },
      false,
    );
  }
  return { assignmentId, created };
}

export const assignWork = teacherMutation({
  args: {
    unitId: v.id("units"),
    scholarIds: v.array(v.id("users")),
    title: v.optional(v.string()),
    startsAt: v.number(),
    target: assignWorkTargetValidator,
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
export const pushActivity = teacherMutation({
  args: {
    assignmentId: v.id("assignments"),
    activityId: v.id("activities"),
    mode: v.union(v.literal("classFocus"), v.literal("homework")),
    endsAt: v.optional(v.number()),
    dueAt: v.optional(v.number()),
    // Optional per-scholar targeting; subset of the roster, absent = all.
    scholarIds: v.optional(v.array(v.id("users"))),
  },
  handler: async (ctx, args) => {
    const a = await requireOwnedAssignment(ctx, args.assignmentId);
    if (!a) return;
    await applyPushActivity(ctx, a, {
      ...args,
      dueAt:
        args.mode === "homework"
          ? (args.dueAt ??
            (await defaultHomeworkDueAt(
              ctx,
              a.scholarIds,
              Date.now(),
              await homeworkInstitutionForAssignment(ctx, a),
            )))
          : undefined,
    });
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
export const scheduleActivity = teacherMutation({
  args: {
    assignmentId: v.id("assignments"),
    activityId: v.id("activities"),
    mode: v.union(v.literal("classFocus"), v.literal("homework")),
    startsAt: v.number(),
    endsAt: v.optional(v.number()),
    dueAt: v.optional(v.number()),
    // Optional per-scholar targeting; subset of the roster, absent = all.
    scholarIds: v.optional(v.array(v.id("users"))),
  },
  handler: async (ctx, args) => {
    const a = await requireOwnedAssignment(ctx, args.assignmentId);
    if (!a) return;
    await applyScheduleActivity(ctx, a, args);
  },
});

/**
 * Reschedule a planned entry to a new time. Cancels the old activation
 * job and (if the new time is in the future) schedules a fresh one.
 * No-op if there's no entry for this activity. If the entry is already
 * live (setAt stamped), this only moves its agenda position — it does
 * not un-push it.
 */
export const rescheduleActivity = teacherMutation({
  args: {
    assignmentId: v.id("assignments"),
    activityId: v.id("activities"),
    startsAt: v.number(),
  },
  handler: async (ctx, args) => {
    const a = await requireOwnedAssignment(ctx, args.assignmentId);
    if (!a) return;
    await applyRescheduleActivity(ctx, a, args);
  },
});

/** Remove an activity from the schedule (clears both class focus and
 *  homework state for that activity within this Assignment). */
export const clearActivity = teacherMutation({
  args: {
    assignmentId: v.id("assignments"),
    activityId: v.id("activities"),
  },
  handler: async (ctx, { assignmentId, activityId }) => {
    const a = await requireOwnedAssignment(ctx, assignmentId);
    if (!a) return;
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
export const listForTeacher = teacherQuery({
  args: { includeArchived: v.optional(v.boolean()) },
  handler: async (ctx, { includeArchived }) => {
    const rows = await ctx.db
      .query("assignments")
      .withIndex("by_teacher", (q) => q.eq("teacherId", ctx.user._id))
      .collect();
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
        const schedule = activeScheduleEntries(a);
        const classFocusCount = schedule.filter((e) => e.mode === "classFocus").length;
        const homeworkCount = schedule.filter((e) => e.mode === "homework").length;
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
          classFocusCount,
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
export const listForUnit = teacherQuery({
  args: { unitId: v.id("units") },
  handler: async (ctx, { unitId }) => {
    const rows = await ctx.db
      .query("assignments")
      .withIndex("by_unit", (q) => q.eq("unitId", unitId))
      .collect();
    // Scope to the calling teacher — assignments are per-teacher, same
    // as listForTeacher. (Role-based model: a teacher only manages
    // their own runs.)
    const mine = rows.filter((r) => r.teacherId === ctx.user._id);
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
        const schedule = activeScheduleEntries(a);
        const classFocusCount = schedule.filter((e) => e.mode === "classFocus").length;
        const homeworkCount = schedule.filter((e) => e.mode === "homework").length;
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
          classFocusCount,
          homeworkCount,
          facepile,
        };
      }),
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
    const rows = await ctx.db
      .query("assignments")
      .withIndex("by_teacher", (q) => q.eq("teacherId", ctx.user._id))
      .collect();
    // Computed once — same teacher for every row in this list.
    const timeZone = await timeZoneForStaff(ctx, ctx.user._id);
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
      const entries = activeScheduleEntries(a);
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
export const lingeringScholarsForPush = teacherQuery({
  args: {
    assignmentId: v.id("assignments"),
    activityId: v.id("activities"),
  },
  handler: async (ctx, { assignmentId, activityId }) => {
    const a = await requireOwnedAssignment(ctx, assignmentId);
    if (!a) return [];
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
      const entries = a.activitySchedule ?? [];
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
        const ended = !!e.endsAt && e.endsAt <= now;
        const state: "planned" | "live" | "done" =
          e.setAt == null ? "planned" : allDone || ended ? "done" : "live";
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
export const get = teacherQuery({
  args: { assignmentId: v.id("assignments") },
  handler: async (ctx, { assignmentId }) => {
    const a = await ctx.db.get(assignmentId);
    if (!a || a.teacherId !== ctx.user._id) return null;
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
          readingLevel: s?.readingLevel ?? null,
          sessionId: session?._id ?? null,
          sessionStartedAt: session?._creationTime ?? null,
          lastMessageAt: lastMsg?._creationTime ?? null,
          lastMessagePreview: lastMsg ? lastMsg.content.slice(0, 120) : null,
          completedActivityCount: completions.length,
        };
      }),
    );
    const schedule = a.activitySchedule ?? [];
    const active = activeScheduleEntries(a);
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
      activitySchedule: schedule,
      classFocusCount: active.filter((e) => e.mode === "classFocus").length,
      homeworkCount: active.filter((e) => e.mode === "homework").length,
      timeZone,
      roster,
    };
  },
});

/** Institution-calendar due-date choices for the Run page and full editor. */
export const homeworkDueDateOptions = teacherQuery({
  args: {
    assignmentId: v.id("assignments"),
    nowMs: v.number(),
  },
  handler: async (ctx, { assignmentId, nowMs }) => {
    const assignment = await requireOwnedAssignment(ctx, assignmentId);
    if (!assignment) return null;
    return await homeworkDueDateOptionsForRoster(
      ctx,
      assignment.scholarIds,
      nowMs,
      await homeworkInstitutionForAssignment(ctx, assignment),
    );
  },
});

/**
 * Per-activity progress for an Assignment — completion roll-up + the
 * current schedule entry (or null) for each activity. Drives the Run
 * page's outline with push/clear controls.
 */
export const activityProgress = teacherQuery({
  args: { assignmentId: v.id("assignments") },
  handler: async (ctx, { assignmentId }) => {
    const a = await ctx.db.get(assignmentId);
    if (!a || a.teacherId !== ctx.user._id) return null;
    // A standing (unitId-less) assignment has no lessons to roll up.
    if (!a.unitId) return { rosterSize: a.scholarIds.length, lessons: [] };
    const schedule = a.activitySchedule ?? [];
    const scheduleByActivity = new Map(
      schedule.map((e) => [String(e.activityId), e]),
    );
    const lessons = await ctx.db
      .query("lessons")
      .withIndex("by_unit", (q) => q.eq("unitId", a.unitId!))
      .collect();
    lessons.sort((x, y) => x.order - y.order);
    const completions = await ctx.db
      .query("activityCompletions")
      .withIndex("by_assignment", (q) => q.eq("assignmentId", assignmentId))
      .collect();
    const doneByActivity = new Map<string, Set<string>>();
    for (const c of completions) {
      const key = String(c.activityId);
      if (!doneByActivity.has(key)) doneByActivity.set(key, new Set());
      doneByActivity.get(key)!.add(String(c.scholarId));
    }
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
              defaultMode: act.defaultMode ?? "either",
              completedScholarIds: Array.from(done),
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
                  }
                : null,
            };
          }),
        };
      }),
    );
    return { rosterSize: a.scholarIds.length, lessons: out };
  },
});

/** Compatibility shim for CompletedActivityDetail. */
export const getForReview = teacherQuery({
  args: { assignmentId: v.id("assignments") },
  handler: async (ctx, { assignmentId }) => {
    const a = await ctx.db.get(assignmentId);
    if (!a || a.teacherId !== ctx.user._id) return null;
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
          readingLevel: scholar?.readingLevel ?? null,
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
  args: { asLearner: v.optional(v.boolean()) },
  handler: async (ctx, args) => {
    const user = ctx.user;
    // Scholars: the read-only "finish class focus first" wall is driven off the
    // scholar-branch semantics, now shared with the teacher-facing Home mirror
    // (scholarPlate.homeForScholar) so the two never drift.
    if (user.role === ROLES.SCHOLAR || args.asLearner === true) {
      if (args.asLearner === true) {
        await requireActiveLearnerInstitution(ctx, user._id);
      }
      return await scholarClassFocusEntries(ctx, user._id);
    }
    // Teacher branch: every live class-focus push on the teacher's OWN
    // assignments (no onboarding exclusion, no completed-skip — that lock
    // machinery is scholar-only).
    const candidates = await ctx.db.query("assignments").collect();
    const filtered = candidates.filter((a) => {
      if (a.archivedAt) return false;
      if (a.teacherId !== user._id) return false;
      return activeScheduleEntries(a).some((e) => e.mode === "classFocus");
    });
    const out: Array<
      Awaited<ReturnType<typeof enrichScheduleEntryForScholar>>
    > = [];
    for (const a of filtered) {
      for (const e of activeScheduleEntries(a)) {
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
 * The SCHOLAR-branch of the class-focus read, factored out so the read-only
 * focus-lock surface (`currentClassFocusForMe`) and the teacher-facing Home
 * mirror (`scholarPlate.homeForScholar`) compute the identical set for a given
 * scholar. Onboarding ("Welcome to Rabbithole") is excluded (it owns a
 * never-locking pin), and a class focus the scholar has already completed no
 * longer appears — matching how the lock lifts the instant the work is done.
 * Entries are sorted most-recent-first, which `pickLockingFocus` relies on.
 */
export async function scholarClassFocusEntries(
  ctx: QueryCtx,
  scholarId: Id<"users">,
): Promise<Array<Awaited<ReturnType<typeof enrichScheduleEntryForScholar>>>> {
  const onboardingUnit = await ctx.db
    .query("units")
    .withIndex("by_slug", (q) => q.eq("slug", ONBOARDING_UNIT_SLUG))
    .first();
  const onboardingUnitId = onboardingUnit?._id ?? null;
  const candidates = await ctx.db.query("assignments").collect();
  const filtered = candidates.filter((a) => {
    if (a.archivedAt) return false;
    if (!targetsScholar(a, scholarId)) return false;
    if (onboardingUnitId && String(a.unitId ?? "") === String(onboardingUnitId))
      return false;
    return showingScheduleEntries(a).some((e) => e.mode === "classFocus");
  });
  const out: Array<
    Awaited<ReturnType<typeof enrichScheduleEntryForScholar>>
  > = [];
  for (const a of filtered) {
    // Showing, not blocking: an overrun focus the teacher hasn't wrapped is
    // still what the class is on, so it belongs on the scholar's Now ladder.
    // `enrichScheduleEntryForScholar` drops its `soloStartableByMe` once the
    // window closes, so it arrives here without the power to wall anyone in.
    for (const e of showingScheduleEntries(a)) {
      if (e.mode !== "classFocus") continue;
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
    return await homeworkForScholar(ctx, user._id);
  },
});

/**
 * Today's planned, not-yet-live work for the calling scholar. `dayKey` only
 * re-arms the reactive query at local midnight; the server always derives and
 * returns the institution-authoritative day.
 */
export const todayScheduleForSelf = authedQuery({
  args: {
    dayKey: v.string(),
    includeWebActivities: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const scholar = ctx.user;
    const timeZone = await timeZoneForScholar(ctx, scholar._id);
    const dayKey = dayKeyForTimezone(Date.now(), timeZone);
    const institutionId = await scholarInstitutionId(ctx, scholar._id);
    // Read the caller value so the cache-buster remains an explicit part of the
    // contract; it never controls which day leaves the server.
    void args.dayKey;
    if (!(await hasScholarMembership(ctx, scholar._id)) || !institutionId) {
      return { timeZone, dayKey, nextOpenSchoolDayKey: null, entries: [] };
    }
    const nextOpenDayKey = await findNextOpenSchoolDayKey(
      ctx,
      institutionId,
      dayKey,
      timeZone,
    );

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

    for (const assignment of assignments) {
      if (assignment.archivedAt || !targetsScholar(assignment, scholar._id)) {
        continue;
      }
      const unit = assignment.unitId
        ? await ctx.db.get(assignment.unitId)
        : null;
      for (const entry of assignment.activitySchedule ?? []) {
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
          ),
          mode: entry.mode,
          startsAt: entry.startsAt,
          dueAt: entry.dueAt ?? null,
          completedByMe: enriched.completedByMe,
        });
      }
    }

    entries.sort((a, b) => a.startsAt - b.startsAt);
    return { timeZone, dayKey, nextOpenSchoolDayKey: nextOpenDayKey, entries };
  },
});

/** How many open school days the scholar lookahead spans (see comingUpForSelf). */
const COMING_UP_HORIZON_OPEN_DAYS = 5;

/**
 * The scholar "Coming up" lookahead — a week-scoped sibling of
 * `todayScheduleForSelf`. Read-only and non-actionable (T4): it is a forecast,
 * not a second work queue, so it carries no launch target and no completion.
 *
 * Over the NEXT 5 OPEN SCHOOL DAYS (weekends + calendar closures skipped, so
 * the window rolls into next week rather than collapsing on a Thursday/Friday)
 * it returns, grouped by institution-local day:
 *   (a) live homework whose `dueAt` falls AFTER the next open school day — the
 *       tonight card (`filterHomeworkForNow`) owns everything due on or before
 *       it, so Coming up begins exactly where tonight ends; and
 *   (b) schedule-committed planned placements (setAt == null AND a real
 *       `startsAt`) landing in the horizon.
 *
 * (b) DELIBERATELY WIDENS the planned-work visibility boundary. Today, future
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
 * institution-local midnight (rolling the horizon) and as a live entry's
 * `endsAt` elapses — without the client having to invent or know a day key. The
 * server still derives and returns the institution-authoritative day, and reads
 * `now` only as its time source (the client cannot spoof the timezone).
 */
export const comingUpForSelf = authedQuery({
  args: {
    now: v.number(),
    includeWebActivities: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const scholar = ctx.user;
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
    const homework: ComingUpHomework[] = [];
    const planned: ComingUpPlanned[] = [];

    for (const assignment of assignments) {
      if (assignment.archivedAt || !targetsScholar(assignment, scholar._id)) {
        continue;
      }
      for (const entry of assignment.activitySchedule ?? []) {
        if (!entryTargetsScholar(entry, scholar._id)) continue;

        const dueDayKey =
          entry.dueAt != null
            ? dayKeyForTimezone(entry.dueAt, timeZone)
            : null;
        const isLiveHomework =
          entry.mode === "homework" &&
          isLiveEntry(entry, now) &&
          entry.dueAt != null &&
          dueDayKey != null &&
          horizonSet.has(dueDayKey) &&
          dueDayKey > nextOpenSchoolDayKey;

        const isCommittedPlanned =
          entry.setAt == null &&
          entry.startsAt != null &&
          horizonSet.has(dayKeyForTimezone(entry.startsAt, timeZone));

        if (!isLiveHomework && !isCommittedPlanned) continue;

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
        const display = {
          assignmentId: String(assignment._id),
          activityId: String(entry.activityId),
          activityTitle: enriched.activityTitle ?? "(deleted activity)",
          unitTitle: enriched.unitTitle,
          unitEmoji: enriched.unitEmoji,
          teacherName: enriched.teacherName,
        };
        if (isLiveHomework) {
          // Mirror the homework list's offline-content guard so an empty
          // offline homework never surfaces here as a phantom deadline.
          if (
            enriched.activityKind === "offline" &&
            !enriched.description?.trim()
          ) {
            const activity = await ctx.db.get(entry.activityId);
            if (
              !activity ||
              !(await hasReadableOfflineHomeworkContent(ctx, activity))
            ) {
              continue;
            }
          }
          homework.push({ kind: "homework", ...display, dueAt: entry.dueAt! });
        } else {
          planned.push({
            kind: "planned",
            ...display,
            startsAt: entry.startsAt!,
          });
        }
      }
    }

    const groups = buildComingUpGroups({
      homework,
      planned,
      horizonDayKeys,
      nextOpenSchoolDayKey,
      timeZone,
    });

    return { timeZone, dayKey, nextOpenSchoolDayKey, horizonDayKeys, groups };
  },
});

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

async function requireOwnedAssignment(
  ctx: { db: QueryCtx["db"] } & { user: { _id: Id<"users"> } },
  assignmentId: Id<"assignments">,
) {
  const a = await ctx.db.get(assignmentId);
  if (!a) return null;
  if (a.teacherId !== ctx.user._id) throw new Error("Not your assignment");
  return a;
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
  const entry = (assignment.activitySchedule ?? []).find(
    (e) => e.activityId === activityId,
  );
  if (entry?.scheduledFnId) {
    await ctx.scheduler.cancel(entry.scheduledFnId);
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
 * Every write into `activitySchedule` goes through applySchedule/applyPush,
 * so this one guard keeps archived (and deleted) activities out of the live
 * push layer no matter which teacher surface initiated it. Bulk unit/lesson
 * assigns filter archived children earlier (gatherUnitActivities), and the
 * master-schedule reconciler clears archived placements before reaching here.
 */
async function assertSchedulableActivity(
  ctx: MutationCtx,
  activityId: Id<"activities">,
  mode: "classFocus" | "homework",
): Promise<void> {
  const act = await ctx.db.get(activityId);
  if (!act) throw new Error("Can't schedule: this activity was deleted.");
  if (act.archivedAt) {
    throw new Error(
      "Can't schedule an archived activity — unarchive it first.",
    );
  }
  if (
    mode === "homework" &&
    act.kind === "offline" &&
    !(await hasReadableOfflineHomeworkContent(ctx, act))
  ) {
    throw new Error(
      "Can't schedule empty offline homework — add instructions or materials first.",
    );
  }
}

export async function applyScheduleActivity(
  ctx: MutationCtx,
  a: Doc<"assignments">,
  args: {
    activityId: Id<"activities">;
    mode: "classFocus" | "homework";
    startsAt: number;
    endsAt?: number;
    dueAt?: number;
    scholarIds?: Id<"users">[];
  },
  // When false, the entry is planned but gets NO activation job — it
  // sits on the agenda at `startsAt` and only goes live on an explicit
  // Start now. Used for un-paced bulk assigns, so a whole unit dropped on
  // one date doesn't flip every activity live at the same instant.
  autoActivate = true,
) {
  await assertSchedulableActivity(ctx, args.activityId, args.mode);
  const now = Date.now();
  const existing = (a.activitySchedule ?? []).find(
    (e) => e.activityId === args.activityId,
  );
  // Replacing whatever's there for this activity — cancel its pending job.
  await cancelPendingActivation(ctx, a, args.activityId);
  const base = (a.activitySchedule ?? []).filter(
    (e) => e.activityId !== args.activityId,
  );
  // Only schedule activation for a FUTURE start. Past starts stay
  // planned (no auto-push) until an explicit Start now.
  let scheduledFnId: Id<"_scheduled_functions"> | undefined;
  if (existing?.setAt == null && autoActivate && args.startsAt > now) {
    scheduledFnId = await ctx.scheduler.runAt(
      args.startsAt,
      internal.assignments.activateScheduledActivity,
      { assignmentId: a._id, activityId: args.activityId },
    );
  }
  base.push({
    activityId: args.activityId,
    mode: args.mode,
    // Re-timing an already-live entry must not demote it back to planned.
    setAt: existing?.setAt,
    startsAt: args.startsAt,
    scheduledFnId,
    endsAt: args.mode === "classFocus" ? args.endsAt : undefined,
    dueAt: args.mode === "homework" ? args.dueAt : undefined,
    // A live entry's targeting must not widen as a side effect of a re-time:
    // absent args.scholarIds means "everyone" for a fresh plan, but for an
    // already-live entry it means "leave the audience alone".
    scholarIds:
      args.scholarIds === undefined && existing?.setAt != null
        ? existing.scholarIds
        : normalizeTargeting(a, args.scholarIds),
  });
  await ctx.db.patch(a._id, { activitySchedule: base });
  await syncScheduleMirror(ctx, a, args.activityId, base[base.length - 1]);
}

/** Returns false if there was no entry for this activity (caller can
 *  surface a "nothing to reschedule" message). */
async function applyRescheduleActivity(
  ctx: MutationCtx,
  a: Doc<"assignments">,
  args: { activityId: Id<"activities">; startsAt: number },
): Promise<boolean> {
  const now = Date.now();
  await cancelPendingActivation(ctx, a, args.activityId);
  const schedule = a.activitySchedule ?? [];
  const idx = schedule.findIndex((e) => e.activityId === args.activityId);
  if (idx === -1) return false;
  const entry = schedule[idx];
  let scheduledFnId: Id<"_scheduled_functions"> | undefined;
  // Only (re)schedule activation for a still-planned entry with a
  // future start. A live entry keeps its setAt; we just move startsAt.
  if (entry.setAt == null && args.startsAt > now) {
    scheduledFnId = await ctx.scheduler.runAt(
      args.startsAt,
      internal.assignments.activateScheduledActivity,
      { assignmentId: a._id, activityId: args.activityId },
    );
  }
  schedule[idx] = { ...entry, startsAt: args.startsAt, scheduledFnId };
  await ctx.db.patch(a._id, { activitySchedule: schedule });
  await syncScheduleMirror(ctx, a, args.activityId, schedule[idx]);
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
  const before = a.activitySchedule ?? [];
  const schedule = before.filter((e) => e.activityId !== activityId);
  await ctx.db.patch(a._id, { activitySchedule: schedule });
  await syncScheduleMirror(ctx, a, activityId, null);
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
  const schedule = a.activitySchedule ?? [];
  const entry = schedule.find((e) => e.activityId === activityId);
  if (!entry || entry.setAt != null) return false; // gone, or already live
  await cancelPendingActivation(ctx, a, activityId);
  await ctx.db.patch(a._id, {
    activitySchedule: schedule.filter((e) => e.activityId !== activityId),
  });
  await syncScheduleMirror(ctx, a, activityId, null);
  return true;
}

/**
 * Push-now (set focus): make an activity LIVE immediately for the whole
 * roster. Unlike applyScheduleActivity (which writes a *planned* entry,
 * setAt null), this stamps setAt=now so scholars see it at once. Shared
 * by the teacher-UI `pushActivity` and the aide `aidePushActivityNow`.
 */
export async function applyPushActivity(
  ctx: MutationCtx,
  a: Doc<"assignments">,
  args: {
    activityId: Id<"activities">;
    mode: "classFocus" | "homework";
    endsAt?: number;
    dueAt?: number;
    scholarIds?: Id<"users">[];
  },
) {
  await assertSchedulableActivity(ctx, args.activityId, args.mode);
  const now = Date.now();
  // Replacing the entry — cancel any pending activation job on it so a
  // previously-planned push for this activity doesn't fire later.
  await cancelPendingActivation(ctx, a, args.activityId);
  const schedule = (a.activitySchedule ?? []).filter(
    (e) => e.activityId !== args.activityId,
  );
  schedule.push({
    activityId: args.activityId,
    mode: args.mode,
    // Push-now: live immediately. startsAt mirrors now for agenda position.
    setAt: now,
    startsAt: now,
    endsAt: args.mode === "classFocus" ? args.endsAt : undefined,
    dueAt: args.mode === "homework" ? args.dueAt : undefined,
    scholarIds: normalizeTargeting(a, args.scholarIds),
  });
  await ctx.db.patch(a._id, { activitySchedule: schedule });
  await syncScheduleMirror(ctx, a, args.activityId, schedule[schedule.length - 1]);
  if (args.mode === "classFocus" && args.endsAt) {
    const delay = args.endsAt - now;
    if (delay > 0) {
      await ctx.scheduler.runAfter(delay, internal.assignments.autoClearActivity, {
        assignmentId: a._id,
        activityId: args.activityId,
      });
    }
  }
}

/** Replace the roster outright (everyone not listed leaves the cohort). */
async function applySetScholars(
  ctx: MutationCtx,
  a: Doc<"assignments">,
  scholarIds: Id<"users">[],
) {
  const nextRoster = Array.from(new Set(scholarIds.map((id) => String(id))));
  const rosterSet = new Set(nextRoster);
  // Keep per-scholar activity targeting in sync with the roster. For each
  // entry that targets specific scholars, intersect with the new roster:
  //   - non-empty intersection → keep the narrowed list;
  //   - EMPTY intersection     → drop the entry entirely. We must NOT let
  //     it fall back to `scholarIds: undefined`, because absent = everyone
  //     — pruning a targeted activity to zero scholars must never silently
  //     re-broadcast it to the whole cohort.
  const schedule = a.activitySchedule ?? [];
  const nextSchedule: typeof schedule = [];
  let scheduleChanged = false;
  for (const entry of schedule) {
    if (entry.scholarIds == null || entry.scholarIds.length === 0) {
      nextSchedule.push(entry);
      continue;
    }
    const kept = entry.scholarIds.filter((id) => rosterSet.has(String(id)));
    if (kept.length === 0) {
      // Drop this entry — cancel any pending activation so it can't fire.
      await cancelPendingActivation(ctx, a, entry.activityId);
      scheduleChanged = true;
      continue;
    }
    if (kept.length !== entry.scholarIds.length) {
      nextSchedule.push({ ...entry, scholarIds: kept });
      scheduleChanged = true;
    } else {
      nextSchedule.push(entry);
    }
  }
  await ctx.db.patch(a._id, {
    scholarIds: scholarIds.filter(
      (id, i) => scholarIds.findIndex((o) => String(o) === String(id)) === i,
    ),
    ...(scheduleChanged ? { activitySchedule: nextSchedule } : {}),
  });
  // Re-sync unconditionally rather than only when the array changed. A
  // narrowed entry pruned to nothing is dropped here, and its mirror has to
  // be cleared with it; a cohort-wide entry needs no rewrite at all, since
  // its audience is the assignment itself and follows the roster live.
  await syncScheduleMirrorAll(ctx, a, nextSchedule);
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
    live?: boolean;
    startsAt?: number;
    dueAt?: number;
  },
): Promise<{ assignmentId: Id<"assignments">; activityId: Id<"activities"> }> {
  const teacher = await ctx.db.get(args.teacherId);
  if (!teacher) throw new Error("Teacher not found");
  await requireScholarsAccessible(ctx, teacher, [args.scholarId]);
  const now = Date.now();
  const title = args.title.trim();
  if (!title) throw new Error("Dispatch needs a title");
  const activityKind = args.activityKind ?? "online";
  const mode = args.mode ?? "classFocus";
  const description = args.description?.trim() || undefined;
  if (activityKind === "offline" && !description) {
    throw new Error("An offline dispatch needs complete instructions in description");
  }
  if (activityKind === "offline" && mode !== "homework") {
    throw new Error("An offline dispatch must use homework mode");
  }

  let webUrl: string | undefined;
  let problemSet: Doc<"activities">["problemSet"];
  if (activityKind === "web") {
    webUrl = args.webUrl?.trim();
    if (!webUrl) throw new Error("A web dispatch needs a URL");
    let parsed: URL;
    try {
      parsed = new URL(webUrl);
    } catch {
      throw new Error("A web dispatch needs a valid URL");
    }
    if (parsed.protocol !== "https:") {
      throw new Error("A web dispatch URL must use HTTPS");
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

  const activityId = await ctx.db.insert("activities", {
    title,
    kind: activityKind,
    // The dispatch `description` arg is scholar-facing by contract ("complete
    // scholar-facing instructions… preserved verbatim"), so it lands in the
    // scholar-visible field — teacher-facing design intent has no author here.
    scholarDescription: description,
    systemPrompt:
      activityKind === "online"
        ? args.systemPrompt?.trim() ||
          `Ad-hoc exploration dispatched by a teacher: ${title}. Guide the scholar Socratically — ask, don't tell.`
        : undefined,
    webUrl,
    problemSet,
    order: 0,
  });
  if (activityKind === "problem_set") {
    await scheduleProblemSetItemGeneration(ctx, activityId);
  }

  const assignmentId = await ctx.db.insert("assignments", {
    teacherId: args.teacherId,
    scholarIds: [args.scholarId],
    title,
    kind: "adHocDispatch",
    startedAt: now,
    activitySchedule: [],
  });
  const a = (await ctx.db.get(assignmentId))!;
  if (args.live === false) {
    // Add to their queue — planned for a future time (or now, agenda-only).
    await applyScheduleActivity(ctx, a, {
      activityId,
      mode,
      startsAt: args.startsAt ?? now,
      dueAt: args.dueAt,
    });
  } else {
    // Right now — live immediately for the one scholar.
    await applyPushActivity(ctx, a, { activityId, mode, dueAt: args.dueAt });
  }
  return { assignmentId, activityId };
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
    live: v.optional(v.boolean()),
    startsAt: v.optional(v.number()),
    dueAt: v.optional(v.number()),
  },
  handler: (ctx, args) =>
    coreDispatchActivity(ctx, { ...args, teacherId: ctx.user._id }),
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
    live?: boolean;
    startsAt?: number;
    dueAt?: number;
  },
): Promise<{ assignmentId: Id<"assignments">; activityId: Id<"activities"> }> {
  const u = await ctx.db.get(callerUserId);
  if (!u || !isTeacherRole(u.role as never)) {
    throw new Error("Dispatch is teacher/admin only");
  }
  return coreDispatchActivity(ctx, { ...args, teacherId: callerUserId });
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
  },
): Promise<{ assignmentId: Id<"assignments">; created: boolean }> {
  const u = await ctx.db.get(callerUserId);
  if (!u || !isTeacherRole(u.role as never)) {
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
  await ctx.db.patch(a._id, {
    scholarIds: Array.from(new Set([...a.scholarIds, ...scholarIds])),
  });
}

/** Archive (end) an assignment — also clears its schedule so nothing
 *  stays live or fires later. */
async function applyArchive(ctx: MutationCtx, a: Doc<"assignments">) {
  for (const entry of a.activitySchedule ?? []) {
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
  await ctx.db.patch(a._id, { archivedAt: Date.now(), activitySchedule: [] });
  await syncScheduleMirrorAll(ctx, a, []);
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
async function gatherUnitActivities(
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
// gate. These internal fns re-do the owner-only ownership check
// explicitly against callerUserId, then share the exact reads/writes the
// teacher-UI uses. Tool gating to teacher/admin happens in lib/aideTools.

async function requireOwnedAssignmentBy(
  ctx: { db: QueryCtx["db"] },
  assignmentId: Id<"assignments">,
  callerUserId: Id<"users">,
): Promise<Doc<"assignments"> | null> {
  const a = await ctx.db.get(assignmentId);
  if (!a) return null;
  if (a.teacherId !== callerUserId) throw new Error("Not your assignment");
  return a;
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
  mode: "classFocus" | "homework";
  startsAt: number;
  endsAt?: number;
  dueAt?: number;
};
type AidePushArgs = {
  assignmentId: Id<"assignments">;
  activityId: Id<"activities">;
  mode: "classFocus" | "homework";
  endsAt?: number;
  dueAt?: number;
};

/** Discovery: the caller's active assignments with roster + a count of
 *  scheduled activities. Lets the aide map a cohort description to an
 *  assignmentId (and tell same-unit cohorts apart by roster). */
export async function coreAideListAssignments(
  ctx: QueryCtx,
  callerUserId: Id<"users">,
) {
  const rows = (
    await ctx.db
      .query("assignments")
      .withIndex("by_teacher", (q) => q.eq("teacherId", callerUserId))
      .collect()
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
        scheduledCount: (a.activitySchedule ?? []).length,
        startedAt: a.startedAt,
      };
    }),
  );
}

/** Flattened agenda feed across the caller's active assignments —
 *  one item per (assignment, activity) push, optionally windowed to
 *  [from, to) by agenda position. The primary read for bulk reschedules
 *  ("everything in the week of X"). Times are epoch-ms; the tool layer
 *  attaches human HST labels. */
export async function coreAideSchedule(
  ctx: QueryCtx,
  callerUserId: Id<"users">,
  from?: number,
  to?: number,
) {
  const now = Date.now();
  const rows = await ctx.db
    .query("assignments")
    .withIndex("by_teacher", (q) => q.eq("teacherId", callerUserId))
    .collect();
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
    const entries = a.activitySchedule ?? [];
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
  if (!a || a.teacherId !== callerUserId) return null;
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
  const scheduledIds = new Set(
    (a.activitySchedule ?? []).map((e) => String(e.activityId)),
  );
  const schedule = await Promise.all(
    (a.activitySchedule ?? []).map(async (e) => {
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
    defaultMode: string | null;
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
        defaultMode: act.defaultMode ?? null,
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
  if (!a || a.teacherId !== callerUserId) return null;
  const now = Date.now();
  // A standing (unitId-less) assignment has no unit to resolve.
  const unit = a.unitId ? await ctx.db.get(a.unitId) : null;

  const scheduleByActivity = new Map(
    (a.activitySchedule ?? []).map((e) => [String(e.activityId), e]),
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
        sessionId: session?._id ?? null,
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
): Promise<{ ok: true }> {
  const a = await requireOwnedAssignmentBy(ctx, args.assignmentId, callerUserId);
  if (!a) throw new Error("Assignment not found");
  if (a.archivedAt) throw new Error("Assignment is archived");
  await assertActivityInUnit(ctx, a, args.activityId);
  await applyScheduleActivity(ctx, a, args);
  return { ok: true };
}

export async function coreAideRescheduleActivity(
  ctx: MutationCtx,
  callerUserId: Id<"users">,
  args: { assignmentId: Id<"assignments">; activityId: Id<"activities">; startsAt: number },
): Promise<{ ok: boolean; found: boolean }> {
  const a = await requireOwnedAssignmentBy(ctx, args.assignmentId, callerUserId);
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
  const a = await requireOwnedAssignmentBy(ctx, args.assignmentId, callerUserId);
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
): Promise<{ ok: true }> {
  const a = await requireOwnedAssignmentBy(ctx, args.assignmentId, callerUserId);
  if (!a) throw new Error("Assignment not found");
  if (a.archivedAt) throw new Error("Assignment is archived");
  await assertActivityInUnit(ctx, a, args.activityId);
  await applyPushActivity(ctx, a, args);
  return { ok: true };
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
  if (!caller) throw new Error("Teacher not found");
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
  if (!caller) throw new Error("Teacher not found");
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
  },
  handler: (ctx, { callerUserId, ...args }) =>
    coreAideAssignWork(ctx, callerUserId, args),
});

export const aideScheduleActivity = internalMutation({
  args: {
    callerUserId: v.id("users"),
    assignmentId: v.id("assignments"),
    activityId: v.id("activities"),
    mode: v.union(v.literal("classFocus"), v.literal("homework")),
    startsAt: v.number(),
    endsAt: v.optional(v.number()),
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
    mode: v.union(v.literal("classFocus"), v.literal("homework")),
    endsAt: v.optional(v.number()),
    dueAt: v.optional(v.number()),
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
    live: v.optional(v.boolean()),
    startsAt: v.optional(v.number()),
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
    const schedule = a.activitySchedule ?? [];
    const idx = schedule.findIndex((e) => e.activityId === activityId);
    if (idx === -1) return;
    const entry = schedule[idx];
    if (!(await ctx.db.get(activityId))) {
      await ctx.db.patch(assignmentId, {
        activitySchedule: schedule.filter((e) => e.activityId !== activityId),
      });
      await syncScheduleMirror(ctx, a, activityId, null);
      return;
    }
    // Already live, or rescheduled to the future — don't activate.
    if (entry.setAt != null) return;
    if (entry.startsAt != null && entry.startsAt > now) return;
    schedule[idx] = { ...entry, setAt: now, scheduledFnId: undefined };
    await ctx.db.patch(assignmentId, { activitySchedule: schedule });
    await syncScheduleMirror(ctx, a, activityId, schedule[idx]);
    if (entry.mode === "classFocus" && entry.endsAt) {
      const delay = entry.endsAt - now;
      if (delay > 0) {
        await ctx.scheduler.runAfter(
          delay,
          internal.assignments.autoClearActivity,
          { assignmentId, activityId },
        );
      }
    }
  },
});

export const autoClearActivity = internalMutation({
  args: {
    assignmentId: v.id("assignments"),
    activityId: v.id("activities"),
  },
  handler: async (ctx, { assignmentId, activityId }) => {
    const a = await ctx.db.get(assignmentId);
    if (!a) return;
    const schedule = a.activitySchedule ?? [];
    const entry = schedule.find((e) => e.activityId === activityId);
    if (!entry || entry.mode !== "classFocus") return;
    if (!entry.endsAt || entry.endsAt > Date.now()) return;
    await ctx.db.patch(assignmentId, {
      activitySchedule: schedule.filter((e) => e.activityId !== activityId),
    });
    // The mirror closes rather than disappearing — `expired` is the whole
    // reason the new table keeps the row instead of deleting it.
    await syncScheduleMirror(ctx, a, activityId, null, "expired");
  },
});
