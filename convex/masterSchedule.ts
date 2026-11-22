// Master Schedule (review/master-schedule-plan.html) — the term-scoped,
// recurring weekly TIMETABLE a small school runs its week from.
//
// Two light template tables (schema.ts): `scheduleBlocks` (the bell-schedule
// rows) and `schedulePlacements` (the class cells: group × weekday × block).
// This module is the whole backend surface:
//   - reads:  `grid` (blocks + enriched placements + classes with no day yet
//             + derived coverage, plus the week's gives: lib/gridGives.ts)
//   - writes: block CRUD, placement create/update/move/remove, the bulk
//             `reassignTeacher` ("Lehua's out sick"), and the `shiftPlacement`
//             teleport. There is NO manual publish step: a placed cell that
//             links an assignment + activity is auto-materialized into the
//             shipped assignments.activitySchedule (planned≠live) at write time
//             and by a short-horizon cron (autoMaterializeTick).
//
// EVERY direct-manipulation affordance here also has a matching bot tool
// (lib/masterScheduleTools.ts) built on the same `core*` helpers, so the aide
// can drive the schedule end-to-end ("we've a field trip Wed, help me shuffle")
// — that parity is the point (review §6/§16). The public teacher* wrappers and
// the internal aide* wrappers both call one core, so a teacher click and a bot
// tool-call behave identically.
//
// Gating: teacher/admin (a planning surface that shows teacher + roster names).
// Reads are teacherQuery; writes are teacherMutation; the aide wrappers re-check
// the caller is a teacher role explicitly (they have no ctx.user).

import { openUntilClosesAt, openUntilWeekdayPhrase } from "../shared/openUntil";
import { ConvexError, v } from "convex/values";
import { publishUnitOnAssign } from "./lib/unitPublication";
import { appActivityHasNothingToOpen } from "./lib/appActivity";
import { internalQuery, internalMutation } from "./_generated/server";
import type { QueryCtx, MutationCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import { primaryInstitutionId } from "./lib/primaryInstitution";
import { gridGivesFor } from "./lib/gridGives";
import {
  classFieldsForPush,
  classLinkInputsChanged,
  endFieldsForPush,
  invalidateClassLinkClasses,
  loadClassLinkData,
  syncClassesForPlacements,
  upsertClassForPlacement,
  type ClassLinkReadCache,
} from "./lib/classLink";
import {
  curatableInstitutionIds,
  requireGroupScholarAccess,
  requireScheduleScopeAccessible,
  requireStaffAccessible,
  usesLegacyPrimaryStaffing,
} from "./lib/access";
import {
  authedQuery,
  authedMutation,
  staffQuery,
  teacherQuery,
  teacherMutation,
} from "./lib/customFunctions";
import { isPlatformAdminRole, isTeacherRole, ROLES } from "./lib/roles";
import {
  programCurriculumAccessStatus,
  programSchedulableUnits,
  publishableProgramGroups,
  requireProgramPublishAccess,
} from "./lib/programGroupAccess";
import type { ProgramCurriculumAccessStatus } from "./lib/programGroupAccess";
import {
  applyScheduleActivity,
  applyPushActivity,
  ensureProgramAssignment,
  scholarTimetableContext,
  unmaterializePlannedActivity,
} from "./assignments";
import {
  hasReadableOfflineHomeworkContent,
  resolveReachableActivityResources,
} from "./lib/activityResourceReachability";
import {
  isProgramHandoutActivity,
  requireProgramHandoutAccess,
} from "./lib/programHandoutAccess";
import { deleteResourcesForActivity } from "./activityResources";
import {
  effectiveInstitutionTimeZone,
  institutionDayForRequest,
  timeZoneForScholar,
} from "./lib/institutionTime";
import {
  dayStartForDayKey,
  DEFAULT_TIMEZONE,
  dayKeyForTimezone,
  shiftDayKey,
  institutionDayAt,
  weekdayForTimezone,
} from "../shared/institutionDay";
import {
  dayKeyForWeekday,
  isClosedDay,
  type SchoolClosure,
  type SchoolClosureKind,
} from "../shared/schoolClosures";
import {
  scheduleWeekStartMs,
  scheduleWeekdayDayKey,
  scheduleWeekdayTimeMs,
  shiftScheduleWeekStartMs,
} from "../shared/scheduleWeek";
import { isSkillAdapterActivity } from "./lib/skillPractice";
import { tripsForScholar } from "./fieldTrips";
import { tripOverlaps } from "../shared/fieldTrips";
import { instantForLocalMinutes } from "../shared/institutionDay";
import {
  barePlacementWeekOverrideKey,
  normalizedSchedulePlacementSubject,
  normalizedSchedulePlacementText,
} from "./lib/schedulePlacementIdentity";
import { schedulePushProjectionRefresh } from "./lib/deviceAppUnlockScheduling";
import { assertPushAllowed, explicitFocusEnd } from "./lib/pushes";
import {
  firstClassIdByWork,
  homeworkSubjectLabel,
  scheduleWorkKey,
} from "./lib/homeworkSubject";
import {
  closeScheduleForAssignment,
  loadScheduleRows,
  readSchedule,
  writeSchedule,
} from "./lib/scheduleStore";

const DAY = 86_400_000;
const MINUTE = 60_000;

// Andy, 2026-09-15: class-app tiles stay open ten minutes past the bell so
// scholars can save/export. This belongs here because it is specifically the
// master-schedule app-placement window, not a general push lifetime.
export const APP_PLACEMENT_GRACE_MS = 10 * MINUTE;

// Andy, 2026-09-21: and BEFORE it too, so the tile is already there while the
// room is being set up. The trailing grace above shipped alone, which made
// the window asymmetric — open ten minutes past the bell, zero before it —
// and a teacher who opens the app during setup is then guaranteed to find
// nothing. That is not hypothetical: Robotics reported "they're not seeing
// the scratch tile" at 15:01:56 for a 15:05 block, the diagnosis chased a
// grant that was not broken, and the fix undid a deliberate block-scoping.
// A standing grant has no edge at all, so moving an always-on app onto a
// block is precisely when someone meets this one.
//
// Widened from five minutes to fifteen the same day (Andy, 2026-09-21): for
// a 15:05 block the app should surface at 14:50, so a teacher setting up for
// class "won't freak out because the apps aren't there yet." This applies to
// EVERY app surface driven by this schedule-placement push, not just one —
// each of the following derives its liveness from THIS row's own
// startsAt/setAt/endsAt (via isPushShowing/isFocusShowing) rather than
// recomputing the block window itself, so widening the lead here is the
// whole fix: the launcher tile (scholarApps.listForLauncher via
// lib/deviceAppProjection.ts's livePushedAppIdsForScholar), the FocusStrip
// "Right now" card (pushes.livePushesForMe), the MDM allowlist projection
// (lib/deviceAppProjection.ts's projectedBundleIdsForClaim), and the launch
// gates (the native tap, the web launch and the autofill, via
// lib/deviceAppProjection.ts's scholarAppAccess).
//
// Known consequence, accepted rather than fixed here: a longer lead reaches
// further into whatever precedes the block. For Block E (15:05) the lead now
// starts at 14:50 — ten minutes into the preceding 14:30-15:00 "Scholar
// Practice Lab" block. A block with a zero-minute gap to its predecessor
// (e.g. Block A 08:30-09:40 -> Block B 09:40-10:50) would put a later
// block's app tile live inside the earlier block's class time. No app
// placement lands on those blocks today, so there is no live impact, but a
// future placement on a tightly-packed block will need this re-examined.
//
// Deliberately its OWN constant, not a reuse of the grace above: the two
// numbers answer different questions (finish your work vs. be ready before the
// bell) and must be tunable apart. (15 > 10 now, so the lead is no longer the
// smaller of the two — that was never an invariant, just how the numbers
// happened to fall the first time either shipped.)
export const APP_PLACEMENT_LEAD_MS = 15 * MINUTE;

/**
 * Epoch-ms of Monday 00:00 institution-local for the week containing `now`.
 * This is the `weekStartMs` the auto-materializer stamps against, so the live
 * push layer lands at the same absolute times the grid renders. Delegates to the
 * shared `scheduleWeekStartMs` so the grid's on-screen anchor week (client-side)
 * is computed by the exact same arithmetic and can never drift for a non-HST
 * viewer (see shared/scheduleWeek.ts).
 */
export function currentWeekStartMs(
  now: number,
  timeZone = DEFAULT_TIMEZONE,
): number {
  return scheduleWeekStartMs(now, timeZone);
}

// ── Pure helpers (exported for tests + the tool layer) ────────────────────

/** "08:30" → minutes since local midnight (510). Null on a malformed value. */
export function parseHHMM(hhmm: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h < 0 || h > 23 || min < 0 || min > 59) return null;
  return h * 60 + min;
}

/**
 * Absolute epoch-ms a (weekday, block-start) lands at for a given week.
 * `weekStartMs` is the epoch-ms of that week's Monday 00:00 (school-local);
 * weekday 1–7 = Mon–Sun.
 */
export function placementStartMs(
  weekStartMs: number,
  weekday: number,
  startLocal: string,
  timeZone = DEFAULT_TIMEZONE,
): number | null {
  const mins = parseHHMM(startLocal);
  if (mins == null) return null;
  // Preserve the legacy helper's exact arithmetic for every numeric Honolulu
  // anchor, including synthetic anchors used by callers and tests.
  if (timeZone === DEFAULT_TIMEZONE) {
    return weekStartMs + (weekday - 1) * DAY + mins * MINUTE;
  }
  const dayKey = scheduleWeekdayDayKey(weekStartMs, weekday, timeZone);
  try {
    return scheduleWeekdayTimeMs(weekStartMs, weekday, mins, timeZone);
  } catch (error) {
    const hour = Math.floor(mins / 60);
    const minute = mins % 60;
    const nonexistentTimeMessage =
      `${dayKey} ${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}` +
      ` does not exist in ${timeZone}`;
    if (error instanceof RangeError && error.message === nonexistentTimeMessage) {
      return null;
    }
    throw error;
  }
}

/** Default coverage need for a block (recess/lunch want 2 adults, else 1). */
export function blockStaffNeed(block: Pick<Doc<"scheduleBlocks">, "staffNeed" | "kind">): number {
  if (block.staffNeed != null) return block.staffNeed;
  return block.kind === "recess" || block.kind === "lunch" ? 2 : 1;
}

export type CoverageCell = {
  blockId: Id<"scheduleBlocks">;
  weekday: number;
  have: number; // distinct adults committed across all groups
  need: number;
  ok: boolean;
  teacherIds: Id<"users">[];
};

export type Conflict = {
  teacherId: Id<"users">;
  weekday: number;
  blockId: Id<"scheduleBlocks">;
  // The ≥2 placements that put this teacher in the same slot twice.
  placementIds: Id<"schedulePlacements">[];
};

/**
 * Derive the staffing rail + double-booking conflicts from the raw rows, for the
 * week anchored at `weekStartMs`. Coverage is school-wide (across all groups) by
 * design — staffing is the one deliberate cross-group view (§10).
 *
 * Week semantics mirror `deriveFlags`: a recurring row (no own `weekStartMs`)
 * applies to every week, while a concrete row (stamped `weekStartMs`) applies
 * only to its own week. So a chip counts toward THIS week's coverage/conflicts
 * only when it's recurring or stamped for exactly this week (week-1 and week-2
 * chips in one slot are not simultaneous). A teacher is double-booked only when
 * ≥2 DISTINCT CLASSES ((groupId, subject)) of theirs land in the same effective
 * slot-week — NOT when one class occupies the cell as multiple rows (its
 * recurring structure row + its own cascaded concrete chip, kept side-by-side
 * since 1.3), which would be the class conflicting with itself. Pure so it's
 * unit-testable in isolation.
 */
export function deriveCoverage(
  blocks: Doc<"scheduleBlocks">[],
  placements: Doc<"schedulePlacements">[],
  weekStartMs: number,
): { coverage: CoverageCell[]; conflicts: Conflict[] } {
  const blockById = new Map(blocks.map((b) => [String(b._id), b]));
  // key = `${blockId}|${weekday}` → { teacherId → { placementIds, classKeys } }.
  // We track BOTH the placement ids (so an emitted conflict carries every
  // involved row, keeping the drawer + badge keying working) AND the distinct
  // CLASS keys a teacher's rows fall under — because a single class legitimately
  // occupies a cell as ≥2 rows since 1.3 (its recurring structure row + its own
  // cascaded concrete chip share groupId + subject + teacher). A teacher is
  // double-booked only when ≥2 DISTINCT classes collide, not when one class
  // shows up as two rows (the false-conflict this fixes).
  const slots = new Map<
    string,
    Map<string, { placementIds: Id<"schedulePlacements">[]; classKeys: Set<string> }>
  >();
  for (const p of placements) {
    if (p.blockId == null || p.weekday == null || p.teacherId == null) continue;
    // Concrete rows only count in their own week; recurring rows count always.
    if (p.weekStartMs != null && p.weekStartMs !== weekStartMs) continue;
    const key = `${p.blockId}|${p.weekday}`;
    if (!slots.has(key)) slots.set(key, new Map());
    const byTeacher = slots.get(key)!;
    const t = String(p.teacherId);
    let entry = byTeacher.get(t);
    if (!entry) {
      entry = { placementIds: [], classKeys: new Set() };
      byTeacher.set(t, entry);
    }
    entry.placementIds.push(p._id);
    // The standard class key — (groupId, subject) trim/case-folded, matching
    // shared/meetingSlots.deriveClassMeetingPattern.
    entry.classKeys.add(`${String(p.groupId)}|${p.subject.trim().toLowerCase()}`);
  }
  const coverage: CoverageCell[] = [];
  const conflicts: Conflict[] = [];
  for (const [key, byTeacher] of slots) {
    const [blockIdStr, weekdayStr] = key.split("|");
    const block = blockById.get(blockIdStr);
    if (!block) continue;
    const weekday = Number(weekdayStr);
    // Coverage `have` counts distinct ADULTS in the slot — one per teacher,
    // independent of how many classes/rows each brings. Unchanged.
    const teacherIds = [...byTeacher.keys()] as unknown as Id<"users">[];
    const need = blockStaffNeed(block);
    coverage.push({
      blockId: block._id,
      weekday,
      have: teacherIds.length,
      need,
      ok: teacherIds.length >= need,
      teacherIds,
    });
    for (const [t, entry] of byTeacher) {
      // Double-booked ⟺ this teacher owns ≥2 DISTINCT classes in the slot-week.
      // A single class appearing as multiple rows (structure + its concrete
      // chip) is one class key → not a conflict.
      if (entry.classKeys.size > 1) {
        conflicts.push({
          teacherId: t as unknown as Id<"users">,
          weekday,
          blockId: block._id,
          // Carry ALL involved rows so the badge (id-set keying) and the
          // drawer's conflict section still resolve every colliding chip.
          placementIds: entry.placementIds,
        });
      }
    }
  }
  return { coverage, conflicts };
}

// ── Slot flags (visible, dismissible, chat-resolvable) ────────────────────
//
// overloaded: ≥2 CONTENT placements share one (group, weekday, block) slot (a
// "too much work in this block" signal). DISMISSIBLE: silenced once any of its
// placements carries its flagId in `dismissedFlags`. Pure so it's
// unit-testable in isolation. (The unit-flow out-of-order flag retired with
// unit flow, TRA-582.)

export type OverloadedSlot = {
  groupId: Id<"scholarGroups">;
  weekday: number;
  blockId: Id<"scheduleBlocks">;
  placementIds: Id<"schedulePlacements">[];
  flagId: string;
};

export function deriveFlags(
  blocks: Pick<Doc<"scheduleBlocks">, "_id" | "order">[],
  effectiveWeekPlacements: Doc<"schedulePlacements">[],
  weekStartMs: number,
): { overloaded: OverloadedSlot[] } {

  // ── Overloaded slots ──────────────────────────────────────────────────
  // A slot only truly overloads when ≥2 content chips land in it in the SAME
  // week — and specifically the week the caller is asking about (`weekStartMs`),
  // so the tag follows week navigation like coverage/conflicts do. Recurring
  // chips (no own week) show every week; concrete chips (weekStartMs set) only in
  // their week. So this week's slot is overloaded when
  // recurringCount + (concrete chips stamped for THIS week) ≥ 2.
  const bySlot = new Map<string, Doc<"schedulePlacements">[]>();
  for (const p of effectiveWeekPlacements) {
    if (p.weekday == null || p.blockId == null) continue; // shelf
    if (!p.assignmentId || !p.activityId) continue; // bare structure can't overload
    if (p.mode === "homework") continue; // due rail holds many; not room overload
    const key = `${p.groupId}|${p.weekday}|${p.blockId}`;
    if (!bySlot.has(key)) bySlot.set(key, []);
    bySlot.get(key)!.push(p);
  }
  const overloaded: OverloadedSlot[] = [];
  for (const [key, rows] of bySlot) {
    const recurring = rows.filter((r) => r.weekStartMs == null);
    const concreteByWeek = new Map<number, Doc<"schedulePlacements">[]>();
    for (const r of rows) {
      if (r.weekStartMs == null) continue;
      if (!concreteByWeek.has(r.weekStartMs)) concreteByWeek.set(r.weekStartMs, []);
      concreteByWeek.get(r.weekStartMs)!.push(r);
    }
    // Only the concrete chips of the week being asked about count toward THIS
    // week's overload (recurring chips apply to every week).
    const thisWeek = concreteByWeek.get(weekStartMs) ?? [];
    if (recurring.length + thisWeek.length < 2) continue;
    const involved = [...recurring, ...thisWeek];
    const [groupId, weekday, blockId] = key.split("|");
    const flagId = `slot:${blockId}:${weekday}:${groupId}`;
    if (involved.some((r) => (r.dismissedFlags ?? []).includes(flagId))) continue;
    overloaded.push({
      groupId: groupId as unknown as Id<"scholarGroups">,
      weekday: Number(weekday),
      blockId: blockId as unknown as Id<"scheduleBlocks">,
      placementIds: involved.map((r) => r._id),
      flagId,
    });
  }

  return { overloaded };
}

/** Live state of a placement's linked activity, if any. */
type LinkState = "none" | "planned" | "live" | "done";
type HomeworkDueProjection = {
  key: string;
  assignmentId: Id<"assignments">;
  activityId: Id<"activities">;
  activityTitle: string;
  unitTitle: string | null;
  subject: string;
  teacherId: Id<"users">;
  teacherName: string | null;
  teacherUsername: string | null;
  groupId: Id<"scholarGroups">;
  dueAt: number;
  /** When the give showed up. Moving its finish re-gives it from here, so a
   *  drag to another day changes only the finish. */
  startsAt: number;
  weekday: number;
  mode: "homework";
  linkState: "live";
};

/**
 * Which weekday's "Homework due" row holds a grid chip in `week`, or null when
 * the chip stays in its class cell. The chip follows its give's actual finish:
 * a linked activity's live or planned schedule entry when there is one, else
 * the cell's own `mode` (a cell that hasn't materialized yet). A dated finish
 * lands on its due day when that day is a weekday of this week, else on the
 * cell's own day; an in-class finish stays in the cell.
 */
export function homeworkRailWeekday(args: {
  weekday: number | null;
  inHomeworkBlock: boolean;
  finishMode: "classFocus" | "homework";
  dueAt: number | null;
  week: number;
  timeZone: string;
}): number | null {
  if (args.weekday == null) return null;
  if (args.inHomeworkBlock) return args.weekday;
  if (args.finishMode !== "homework") return null;
  if (
    args.dueAt != null &&
    scheduleWeekStartMs(args.dueAt, args.timeZone) === args.week
  ) {
    const dueWeekday = weekdayForDayKey(
      dayKeyForTimezone(args.dueAt, args.timeZone),
    );
    if (dueWeekday >= 1 && dueWeekday <= 5) return dueWeekday;
  }
  return args.weekday;
}

export async function coreGrid(
  ctx: QueryCtx,
  periodId: Id<"reportingPeriods">,
  weekStartMs?: number,
  allowedGroupIds?: ReadonlySet<Id<"scholarGroups">>,
) {
  const period = await ctx.db.get(periodId);
  const allBlocks = await ctx.db
    .query("scheduleBlocks")
    .withIndex("by_period", (q) => q.eq("periodId", periodId))
    .collect();
  // Program publishers receive only their explicitly authorized groups. Apply
  // this before any people/activity enrichment or derived schedule analysis.
  // Shared blocks are schedule structure, while per-group overrides belong only
  // to their owning group.
  const blocks = allowedGroupIds
    ? allBlocks.filter(
        (block) => block.groupId == null || allowedGroupIds.has(block.groupId),
      )
    : allBlocks;
  blocks.sort((a, b) => a.order - b.order);
  // Normalize the requested anchor against the institution time zone before
  // selecting placements. The grid, its derived state, and its returned rows
  // must all describe this same effective week.
  const { closures, timeZone: closureTimeZone } = await closuresForPeriod(
    ctx,
    periodId,
  );
  const week = currentWeekStartMs(
    weekStartMs ?? Date.now(),
    closureTimeZone,
  );
  const periodPlacements = await ctx.db
    .query("schedulePlacements")
    .withIndex("by_period", (q) => q.eq("periodId", periodId))
    .collect();
  const allPlacements = allowedGroupIds
    ? periodPlacements.filter((placement) => allowedGroupIds.has(placement.groupId))
    : periodPlacements;

  // ── Defensive orphan filter ───────────────────────────────────────────────
  // Pre-load every activity that's referenced by a placement so we can filter
  // out orphans (placements whose activityId points to a deleted activity)
  // before they reach the grid as phantom bare chips. This is the catch-all for
  // pre-existing orphans from before the write-time cleanup was added; the
  // normal path is that delete mutations now call removeSchedulePlacementsForActivity.
  // We also cache the activity docs here and reuse them in the enrichment loop.
  const referencedActIds = [
    ...new Set(
      allPlacements
        .map((p) => p.activityId)
        .filter((id): id is Id<"activities"> => id != null),
    ),
  ];
  const actDocs = await Promise.all(referencedActIds.map((id) => ctx.db.get(id)));
  const activityById = new Map<string, Doc<"activities">>(
    referencedActIds
      .map((id, i) => [String(id), actDocs[i]] as [string, Doc<"activities"> | null])
      .filter((entry): entry is [string, Doc<"activities">] => entry[1] != null),
  );
  // Same pre-load for the "standing assignment" app target — minimal grid
  // read-side support (see review/app-access-unification-plan.html §robotics):
  // enough for the detail drawer to show which app a cell grants, without
  // plumbing a second chip-rendering path through PlacementChip yet.
  const referencedAppIds = [
    ...new Set(
      allPlacements
        .map((p) => p.externalAppId)
        .filter((id): id is Id<"externalApps"> => id != null),
    ),
  ];
  const appDocs = await Promise.all(referencedAppIds.map((id) => ctx.db.get(id)));
  const externalAppById = new Map<string, Doc<"externalApps">>(
    referencedAppIds
      .map((id, i) => [String(id), appDocs[i]] as [string, Doc<"externalApps"> | null])
      .filter((entry): entry is [string, Doc<"externalApps">] => entry[1] != null),
  );
  // Keep only placements that are either structure-only (no activityId) or
  // reference an activity that still exists.
  const placementsWithValidActivities = allPlacements.filter(
    (p) => !p.activityId || activityById.has(String(p.activityId)),
  );
  // A concrete bare row overrides its matching recurring shell for this week.
  // Keep source rows untouched: this is effective-week layering, not cleanup.
  const weekSourcePlacements = effectivePlacementsForWeek(
    placementsWithValidActivities,
    week,
  );
  // ─────────────────────────────────────────────────────────────────────────

  // Resolve the people + groups referenced, for avatar rendering.
  const teacherIds = new Set<string>();
  const groupIds = new Set<string>();
  for (const p of placementsWithValidActivities) {
    if (p.teacherId) teacherIds.add(String(p.teacherId));
    groupIds.add(String(p.groupId));
  }
  for (const b of blocks) if (b.groupId) groupIds.add(String(b.groupId));

  const teacherRows = await Promise.all(
    [...teacherIds].map((id) => ctx.db.get(id as Id<"users">)),
  );
  const teachers = teacherRows
    .filter((u): u is Doc<"users"> => u != null)
    .map((u) => ({
      _id: u._id,
      name: u.name ?? "Unknown",
      username: u.username ?? null,
    }));
  const teacherById = new Map(teachers.map((t) => [String(t._id), t]));

  const groupRows = await Promise.all(
    [...groupIds].map((id) => ctx.db.get(id as Id<"scholarGroups">)),
  );
  const validGroupRows = groupRows.filter(
    (g): g is Doc<"scholarGroups"> => g != null,
  );
  const groups = validGroupRows
    .map((g) => ({ _id: g._id, name: g.name, emoji: g.emoji ?? null }));

  const homeworkBlockIds = new Set(
    blocks.filter((b) => b.kind === "homework").map((b) => String(b._id)),
  );

  // Enrich the complete source feed. `placements` remains term-wide because
  // class identity and drawers need recurring and future rows.
  // One schedule read per assignment, however many placements link to it:
  // a term's worth of placements can share one assignment.
  const scheduleByAssignment = new Map<
    string,
    Promise<Awaited<ReturnType<typeof readSchedule>>>
  >();
  const scheduleFor = (a: Doc<"assignments">) => {
    let pending = scheduleByAssignment.get(String(a._id));
    if (!pending) {
      pending = readSchedule(ctx, a);
      scheduleByAssignment.set(String(a._id), pending);
    }
    return pending;
  };
  const enriched = await Promise.all(
    placementsWithValidActivities.map(async (p) => {
      let linkState: LinkState = "none";
      let assignmentTitle: string | null = null;
      let activityTitle: string | null = null;
      let assignmentTeacherId: Id<"users"> | null = null;
      let unitId: Id<"units"> | null = null;
      let unitTitle: string | null = null;
      let isProgramHandout = false;
      let linkedEntry:
        | Awaited<ReturnType<typeof readSchedule>>[number]
        | undefined;
      if (p.assignmentId) {
        const a = await ctx.db.get(p.assignmentId);
        if (a) {
          assignmentTeacherId = a.teacherId;
          unitId = a.unitId ?? null;
          const unit = a.unitId ? await ctx.db.get(a.unitId) : null;
          unitTitle = unit?.title ?? null;
          assignmentTitle = a.title ?? unit?.title ?? "Assignment";
          if (p.activityId) {
            // Use the pre-loaded activity doc from the orphan-filter pass.
            const act = activityById.get(String(p.activityId));
            activityTitle = act?.title ?? null;
            isProgramHandout =
              isProgramHandoutActivity(act, a) &&
              a.scholarGroupId === p.groupId;
            const entry = (await scheduleFor(a)).find(
              (e) => e.activityId === p.activityId,
            );
            linkedEntry = entry;
            if (entry) linkState = entry.setAt == null ? "planned" : "live";
          }
        }
      }
      // The "standing assignment" app target's link state lives in `pushes`
      // (materialized by reconcilePlacement), not `activitySchedule` — same
      // planned/live vocabulary, different table.
      let externalAppName: string | null = null;
      if (p.externalAppId) {
        externalAppName = externalAppById.get(String(p.externalAppId))?.name ?? null;
        const push = await openAppPushForDisplay(ctx, p._id);
        if (push) linkState = push.setAt == null ? "planned" : "live";
      }
      const t = p.teacherId ? teacherById.get(String(p.teacherId)) : null;
      // The give's actual finish: its schedule entry once materialized, else
      // the cell's own mode.
      const finishMode = linkedEntry?.mode ?? p.mode ?? "classFocus";
      // Open until a later day (shared/openUntil.ts) is class work, not
      // homework (TRA-724): it stays in its class cell, whose chip says
      // "Open until Thu", and never rails to the Homework due row.
      const openUntil = linkedEntry
        ? openUntilClosesAt(linkedEntry, closureTimeZone)
        : null;
      const railWeekday = homeworkRailWeekday({
        weekday: p.weekday ?? null,
        inHomeworkBlock:
          p.blockId != null && homeworkBlockIds.has(String(p.blockId)),
        finishMode,
        dueAt:
          linkedEntry?.mode === "homework" ? (linkedEntry.dueAt ?? null) : null,
        week,
        timeZone: closureTimeZone,
      });
      return {
        _id: p._id,
        groupId: p.groupId,
        weekday: p.weekday ?? null,
        blockId: p.blockId ?? null,
        subject: p.subject,
        teacherId: p.teacherId ?? null,
        teacherName: t?.name ?? null,
        teacherUsername: t?.username ?? null,
        assignmentId: p.assignmentId ?? null,
        assignmentTitle,
        activityId: p.activityId ?? null,
        activityTitle,
        externalAppId: p.externalAppId ?? null,
        externalAppName,
        assignmentTeacherId,
        // The linked assignment's unit (null for a bare/ad-hoc placement).
        // Drives the detail drawer's activity body + "Open in Curriculum" link.
        unitId,
        // Unit title for the chip's secondary line ("<unit> · n of N").
        unitTitle,
        isProgramHandout,
        // A skill practice pair (lib/skillPractice.ts, a lesson-less one-skill problem set): no
        // curriculum owns it, so removing its LAST placement retires it and
        // clears its live schedule (retireSkillAdapterIfOrphaned).
        isSkillSlot: (() => {
          const act = p.activityId ? activityById.get(String(p.activityId)) : undefined;
          return act ? isSkillAdapterActivity(act) : false;
        })(),
        mode: p.mode ?? null,
        finishMode,
        // When an open-until give's window closes, else null.
        openUntil,
        // "Open until Thu" on the chip: the grid's one sign of when it closes.
        openUntilLabel:
          openUntil != null ? openUntilWeekdayPhrase(openUntil, closureTimeZone) : null,
        // Set when this chip renders in the Homework due row (that weekday)
        // rather than its class cell. Relative to the requested week.
        railWeekday,
        spanBlocks: p.spanBlocks ?? null,
        note: p.note ?? null,
        onShelf: p.weekday == null || p.blockId == null,
        linkState,
        weekStartMs: p.weekStartMs ?? null,
      };
    }),
  );
  const weekPlacementIds = new Set(
    weekSourcePlacements.map((placement) => String(placement._id)),
  );
  // The grid-rendering feed for the requested week. Its rows have the same
  // enriched shape as `placements`, after concrete-bare-over-recurring layering.
  let weekPlacements = enriched.filter((placement) =>
    weekPlacementIds.has(String(placement._id)),
  );

  // The due rail is a projection of the canonical assignment schedule. A rail
  // placement can create or edit homework, but its stamped weekday is never the
  // read source: the live entry's institution-local dueAt decides the column.
  const assignmentCandidates = new Map<string, Doc<"assignments">>();
  const addAssignment = (assignment: Doc<"assignments"> | null) => {
    if (assignment && !assignment.archivedAt) {
      assignmentCandidates.set(String(assignment._id), assignment);
    }
  };
  const relevantTeacherIds = new Set<Id<"users">>();
  for (const group of validGroupRows) {
    relevantTeacherIds.add(group.teacherId);
    if (group.ownerId) relevantTeacherIds.add(group.ownerId);
    const groupAssignments = await ctx.db
      .query("assignments")
      .withIndex("by_scholar_group", (q) =>
        q.eq("scholarGroupId", group._id),
      )
      .collect();
    groupAssignments.forEach(addAssignment);
  }
  for (const placement of placementsWithValidActivities) {
    if (placement.teacherId) relevantTeacherIds.add(placement.teacherId);
    if (placement.assignmentId) {
      addAssignment(await ctx.db.get(placement.assignmentId));
    }
  }
  if (period?.institutionId) {
    const institutionMemberships = await ctx.db
      .query("memberships")
      .withIndex("by_institution", (q) =>
        q.eq("institutionId", period.institutionId),
      )
      .collect();
    for (const membership of institutionMemberships) {
      if (isTeacherRole(membership.role) || membership.role === "staff") {
        relevantTeacherIds.add(membership.userId);
      }
    }
  }
  for (const teacherId of relevantTeacherIds) {
    const teacherAssignments = await ctx.db
      .query("assignments")
      .withIndex("by_teacher", (q) => q.eq("teacherId", teacherId))
      .collect();
    teacherAssignments.forEach(addAssignment);
  }
  const assignmentRows = [...assignmentCandidates.values()];
  const homeworkDue: HomeworkDueProjection[] = [];
  const dueActivityCache = new Map<string, Doc<"activities"> | null>();
  const dueUnitCache = new Map<string, Doc<"units"> | null>();
  const dueTeacherCache = new Map<string, Doc<"users"> | null>();
  for (const assignment of assignmentRows) {
    const scheduleRows = await loadScheduleRows(ctx, assignment._id);
    const filedClasses = firstClassIdByWork(scheduleRows);
    for (const entry of await readSchedule(ctx, assignment, undefined, scheduleRows)) {
      // A due date lands in the Homework due row of that day. Open-until work
      // is class work, not homework (TRA-724), so it never does.
      const closesAt = entry.mode === "homework" ? entry.dueAt : undefined;
      if (
        entry.setAt == null ||
        closesAt == null ||
        scheduleWeekStartMs(closesAt, closureTimeZone) !== week
      ) {
        continue;
      }
      const targetIds =
        entry.scholarIds && entry.scholarIds.length > 0
          ? entry.scholarIds
          : assignment.scholarIds;
      const targetSet = new Set(targetIds.map(String));
      const linkedPlacements = placementsWithValidActivities.filter(
        (placement) =>
          placement.assignmentId === assignment._id &&
          placement.activityId === entry.activityId,
      );
      const linkedGroupIds = new Set(
        linkedPlacements.map((placement) => String(placement.groupId)),
      );
      const exactGroups = validGroupRows.filter((group) => {
        const groupSet = new Set(group.scholarIds.map(String));
        return (
          groupSet.size === targetSet.size &&
          [...targetSet].every((id) => groupSet.has(id))
        );
      });
      const intersectingGroups = validGroupRows.filter((group) =>
        group.scholarIds.some((id) => targetSet.has(String(id))),
      );
      const matchedGroups =
        linkedGroupIds.size > 0
          ? validGroupRows.filter((group) =>
              linkedGroupIds.has(String(group._id)),
            )
          : exactGroups.length > 0
            ? exactGroups
            : intersectingGroups;
      if (matchedGroups.length === 0) continue;

      const activityKey = String(entry.activityId);
      if (!dueActivityCache.has(activityKey)) {
        dueActivityCache.set(activityKey, await ctx.db.get(entry.activityId));
      }
      const activity = dueActivityCache.get(activityKey) ?? null;
      const unitKey = assignment.unitId ? String(assignment.unitId) : null;
      if (unitKey && !dueUnitCache.has(unitKey)) {
        dueUnitCache.set(unitKey, await ctx.db.get(assignment.unitId!));
      }
      const unit = unitKey ? (dueUnitCache.get(unitKey) ?? null) : null;
      const teacherKey = String(assignment.teacherId);
      if (!dueTeacherCache.has(teacherKey)) {
        dueTeacherCache.set(
          teacherKey,
          await ctx.db.get(assignment.teacherId),
        );
      }
      const teacher = dueTeacherCache.get(teacherKey) ?? null;
      const dueDayKey = dayKeyForTimezone(closesAt, closureTimeZone);
      const weekday = weekdayForDayKey(dueDayKey);
      if (weekday < 1 || weekday > 5) continue;

      // The label is the same for every group, so it is read once per entry.
      const workSubject = await homeworkSubjectLabel(ctx, {
        classId: filedClasses.get(scheduleWorkKey(entry.activityId, entry.mode)),
        ...(assignment.unitId
          ? { unitId: assignment.unitId }
          : { activityId: entry.activityId }),
      });
      for (const group of matchedGroups) {
        homeworkDue.push({
          key: `${assignment._id}:${entry.activityId}:${group._id}`,
          assignmentId: assignment._id,
          activityId: entry.activityId,
          activityTitle: activity?.title ?? "(deleted activity)",
          unitTitle: unit?.title ?? assignment.title ?? null,
          subject:
            workSubject ??
            assignment.title ??
            "Homework",
          teacherId: assignment.teacherId,
          teacherName: teacher?.name ?? null,
          teacherUsername: teacher?.username ?? null,
          groupId: group._id,
          dueAt: closesAt,
          startsAt: entry.startsAt ?? entry.setAt,
          weekday,
          mode: "homework" as const,
          linkState: "live" as const,
        });
      }
    }
  }
  const projectedHomeworkKeys = new Set(
    homeworkDue.map(
      (item) => `${item.assignmentId}:${item.activityId}:${item.groupId}`,
    ),
  );
  // The projection replaces a homework-block card. A card railed out of a
  // CLASS cell stays: the client draws its class's block title in that cell
  // (the class still met) and skips it in the Homework due row, where the
  // projection already shows it.
  weekPlacements = weekPlacements.filter(
    (placement) =>
      !(
        placement.finishMode === "homework" &&
        (placement.blockId == null ||
          homeworkBlockIds.has(String(placement.blockId))) &&
        placement.assignmentId &&
        placement.activityId &&
        projectedHomeworkKeys.has(
          `${placement.assignmentId}:${placement.activityId}:${placement.groupId}`,
        )
      ),
  );

  // Flags/coverage/overload derive from the same effective rows returned for
  // the institution-local week anchored above.
  const { coverage, conflicts } = allowedGroupIds
    ? { coverage: [], conflicts: [] }
    : deriveCoverage(blocks, weekSourcePlacements, week);
  const { overloaded } = allowedGroupIds
    ? { overloaded: [] }
    : deriveFlags(blocks, weekSourcePlacements, week);

  return {
    period: period
      ? { _id: period._id, label: period.label, startsAt: period.startsAt, endsAt: period.endsAt }
      : null,
    blocks: blocks.map((b) => ({
      _id: b._id,
      groupId: b.groupId ?? null,
      key: b.key,
      label: b.label,
      startLocal: b.startLocal,
      endLocal: b.endLocal,
      weekdays: b.weekdays,
      order: b.order,
      staffNeed: blockStaffNeed(b),
      kind: b.kind ?? "class",
    })),
    placements: enriched,
    weekPlacements,
    homeworkDue,
    // Classes waiting for a day. Work never waits here (TRA-582); a legacy
    // shelved work row stays hidden.
    shelf: enriched.filter((p) => p.onShelf && !p.activityId && !p.assignmentId),
    coverage,
    conflicts,
    overloaded,
    teachers,
    groups,
    closureTimeZone,
    // The institution-local Monday this grid describes.
    weekStartMs: week,
    closures: closures.map((c) => ({
      startDayKey: c.startDayKey,
      endDayKey: c.endDayKey,
      label: c.label,
      kind: c.kind,
    })),
  };
}

export const grid = teacherQuery({
  args: {
    periodId: v.id("reportingPeriods"),
    // The week the grid is anchored to (Monday 00:00 institution-local, via the shared
    // scheduleWeekStartMs). Optional — omitted means the wall-clock current week.
    weekStartMs: v.optional(v.number()),
    // Readers that never draw gives (the Now view, Classes & times) skip them,
    // so they neither pay for them nor re-run on every push write.
    skipGives: v.optional(v.boolean()),
  },
  handler: async (ctx, { periodId, weekStartMs, skipGives }) => {
    // The term's school must be one the caller may see: the same boundary the
    // placement and block mutations enforce, so a foreign periodId is refused
    // instead of answering with another school's timetable.
    await requireScheduleScopeAccessible(ctx, ctx.user, { periodId });
    const grid = await coreGrid(ctx, periodId, weekStartMs);
    // The work given this week, and each class meeting with its Up next
    // (TRA-582).
    return {
      ...grid,
      ...(skipGives
        ? { gives: [], classMeetings: [] }
        : await gridGivesFor(ctx, periodId, grid, { withUpNext: true })),
    };
  },
});

/** Reporting periods for the institutions represented by the caller's grants. */
export const programPeriods = staffQuery({
  args: { institutionScope: v.optional(v.string()) },
  handler: async (ctx, { institutionScope }) => {
    const allowedGroups = await publishableProgramGroups(
      ctx,
      ctx.user,
      institutionScope,
    );
    const institutionIds = new Set(
      allowedGroups.map((group) => group.institutionId),
    );
    const periods = (
      await ctx.db.query("reportingPeriods").order("desc").collect()
    ).filter(
      (period) =>
        period.institutionId != null &&
        institutionIds.has(period.institutionId),
    );
    return {
      periods,
      current:
        periods.find((period) => period.status === "writing") ??
        periods.find((period) => period.status === "open") ??
        null,
    };
  },
});

/**
 * Read-only schedule lens for staff publishing an explicitly assigned program.
 * Unlike the teacher planning grid, it intentionally omits cross-group staffing
 * analysis and contains only groups the caller may publish for this period's
 * institution.
 */
export const programGrid = staffQuery({
  args: {
    periodId: v.id("reportingPeriods"),
    weekStartMs: v.optional(v.number()),
    institutionScope: v.optional(v.string()),
  },
  handler: async (ctx, { periodId, weekStartMs, institutionScope }) => {
    const period = await ctx.db.get(periodId);
    // Periods predating institution scoping cannot be safely associated with a
    // program grant, so expose no schedule data.
    if (!period?.institutionId) return null;

    const allowedGroups = await publishableProgramGroups(
      ctx,
      ctx.user,
      institutionScope,
    );
    const periodGroups = allowedGroups.filter(
      (group) => group.institutionId === period.institutionId,
    );
    const allowedGroupIds = new Set(periodGroups.map((group) => group._id));
    if (allowedGroupIds.size === 0) return null;

    const scopedGrid = await coreGrid(
      ctx,
      periodId,
      weekStartMs,
      allowedGroupIds,
    );
    const groups = periodGroups.map((group) => ({
      _id: group._id,
      name: group.name,
      emoji: group.emoji ?? null,
    }));
    return {
      ...scopedGrid,
      // A granted program remains selectable before its first timetable
      // placement; schedule rows must not be the authorization inventory.
      groups,
      // Gives and class meetings of the granted groups only (TRA-582).
      ...(await gridGivesFor(ctx, periodId, { ...scopedGrid, groups }, {
        withUpNext: false,
        cardsDrawn: true,
      })),
    };
  },
});

type ProgramCurriculumSearchResult =
  | {
      kind: "unit";
      unitId: Id<"units">;
      unitTitle: string;
    }
  | {
      kind: "lesson";
      unitId: Id<"units">;
      unitTitle: string;
      lessonId: Id<"lessons">;
      lessonTitle: string;
    }
  | {
      kind: "activity";
      unitId: Id<"units">;
      unitTitle: string;
      lessonId: Id<"lessons">;
      lessonTitle: string;
      activityId: Id<"activities">;
      activityTitle: string;
      activityKind: Doc<"activities">["kind"];
      materialCount: number;
    };

/**
 * Flat autocomplete for the existing Unit → Lesson → Activity picker. Results
 * stay scoped to the units this program group can actually schedule
 * (`programSchedulableUnits` — the same set `units.list({ programGroupId })`
 * feeds the unit column); this does not confer curriculum-wide browsing
 * authority. Returns `[]` both for "no matches" and for "no curriculum
 * access at this group's school" — `programGroupCurriculumAccess` is the
 * single source callers use to tell the two apart and name the reason
 * (TRA-327); this query deliberately does not carry a second copy of that
 * signal.
 */
export const searchProgramCurriculum = authedQuery({
  args: {
    groupId: v.id("scholarGroups"),
    query: v.string(),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<ProgramCurriculumSearchResult[]> => {
    const group = await requireProgramPublishAccess(
      ctx,
      ctx.user,
      await ctx.db.get(args.groupId),
    );
    const query = args.query.trim().toLocaleLowerCase();
    if (query.length < 2) {
      throw new Error("Enter at least 2 characters to search curriculum.");
    }
    const limit = Math.min(Math.max(Math.floor(args.limit ?? 25), 1), 50);
    const units = (
      await programSchedulableUnits(ctx, ctx.user, group)
    ).sort((a, b) => a.title.localeCompare(b.title));
    const results: ProgramCurriculumSearchResult[] = [];

    for (const unit of units) {
      if (unit.title.toLocaleLowerCase().includes(query)) {
        results.push({
          kind: "unit",
          unitId: unit._id,
          unitTitle: unit.title,
        });
      }
      const lessons = await ctx.db
        .query("lessons")
        .withIndex("by_unit", (q) => q.eq("unitId", unit._id))
        .collect();
      lessons.sort((a, b) => a.title.localeCompare(b.title));
      for (const lesson of lessons) {
        if (lesson.title.toLocaleLowerCase().includes(query)) {
          results.push({
            kind: "lesson",
            unitId: unit._id,
            unitTitle: unit.title,
            lessonId: lesson._id,
            lessonTitle: lesson.title,
          });
        }
        const activities = await ctx.db
          .query("activities")
          .withIndex("by_lesson", (q) => q.eq("lessonId", lesson._id))
          .collect();
        activities.sort((a, b) => a.title.localeCompare(b.title));
        for (const activity of activities) {
          if (
            activity.archivedAt ||
            !activity.title.toLocaleLowerCase().includes(query)
          ) {
            continue;
          }
          results.push({
            kind: "activity",
            unitId: unit._id,
            unitTitle: unit.title,
            lessonId: lesson._id,
            lessonTitle: lesson.title,
            activityId: activity._id,
            activityTitle: activity.title,
            activityKind: activity.kind,
            materialCount: (
              await resolveReachableActivityResources(ctx, activity._id)
            ).all.length,
          });
        }
      }
    }

    return results
      .sort((a, b) => {
        const aTitle =
          a.kind === "unit"
            ? a.unitTitle
            : a.kind === "lesson"
              ? a.lessonTitle
              : a.activityTitle;
        const bTitle =
          b.kind === "unit"
            ? b.unitTitle
            : b.kind === "lesson"
              ? b.lessonTitle
              : b.activityTitle;
        return aTitle.localeCompare(bTitle);
      })
      .slice(0, limit);
  },
});

/**
 * Whether the caller has curriculum access for this program group's school —
 * checked independently of any search string, so the Add work dialog's unit
 * column can show the same "you don't have curriculum access" explanation
 * the curriculum search shows, instead of rendering an empty units list with
 * no reason (TRA-327).
 */
export const programGroupCurriculumAccess = authedQuery({
  args: { groupId: v.id("scholarGroups") },
  handler: async (ctx, args): Promise<ProgramCurriculumAccessStatus> => {
    const group = await requireProgramPublishAccess(
      ctx,
      ctx.user,
      await ctx.db.get(args.groupId),
    );
    return await programCurriculumAccessStatus(ctx, ctx.user, group);
  },
});

export const aideGrid = internalQuery({
  args: { callerUserId: v.id("users"), periodId: v.id("reportingPeriods") },
  handler: async (ctx, { callerUserId, periodId }) => {
    const caller = await requireTeacherCaller(ctx, callerUserId);
    // termId is the model's string, so it gets the same school check as grid.
    await requireScheduleScopeAccessible(ctx, caller, { periodId });
    return coreGrid(ctx, periodId);
  },
});

/**
 * The zone a term's dates live in: its institution's, the same zone the grid
 * and the placement mutations anchor `weekStartMs` to. The aide tools parse a
 * YYYY-MM-DD date with it, so a caller whose own school differs from the
 * term's (a lensed platform admin) still stores the term's Monday midnight.
 * Takes the term directly or via a placement. Ids are the model's raw
 * strings: an unknown one falls back to the default zone, and the mutation
 * that follows reports the real error.
 */
export const aideTermTimeZone = internalQuery({
  args: {
    periodId: v.optional(v.string()),
    placementId: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<string> => {
    let periodId = args.periodId
      ? ctx.db.normalizeId("reportingPeriods", args.periodId)
      : null;
    if (!periodId && args.placementId) {
      const placementId = ctx.db.normalizeId("schedulePlacements", args.placementId);
      periodId = placementId ? ((await ctx.db.get(placementId))?.periodId ?? null) : null;
    }
    const period = periodId ? await ctx.db.get(periodId) : null;
    const institution = period?.institutionId
      ? await ctx.db.get(period.institutionId)
      : null;
    return effectiveInstitutionTimeZone(institution?.timeZone);
  },
});

/** Institution-local clock context for a period-scoped schedule subscription. */
export const periodClock = teacherQuery({
  args: { periodId: v.id("reportingPeriods") },
  handler: async (ctx, args) => {
    await requireScheduleScopeAccessible(ctx, ctx.user, args);
    const { timeZone } = await closuresForPeriod(ctx, args.periodId);
    // t11-ok: only the time zone is load-bearing. Its one caller passes this to
    // useInstitutionDay, which swaps in the device clock's day right after mount.
    return institutionDayAt(Date.now(), timeZone);
  },
});

function weekdayForDayKey(dayKey: string): number {
  const [year, month, day] = dayKey.split("-").map(Number);
  const sundayBased = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  return sundayBased === 0 ? 7 : sundayBased;
}

/**
 * Today's bell-schedule structure for the calling scholar. The response is
 * intentionally limited to classroom-wall facts; linked work ids never cross
 * this boundary.
 *
 * Answers for the institution-local `dayKey` the client sends (its
 * `useInstitutionDay`), so the subscription never depends on when the server
 * last ran it (T11). A key `institutionDayForRequest` refuses (a neighbouring
 * day away from midnight, or anything further) gets the server's own day.
 */
export const currentBlockForSelf = authedQuery({
  args: { dayKey: v.string() },
  handler: async (ctx, args) => {
    const scholar = ctx.user;
    const timeZone = await timeZoneForScholar(ctx, scholar._id);
    const { dayKey } = institutionDayForRequest(
      args.dayKey,
      timeZone,
    );
    const weekday = weekdayForDayKey(dayKey);

    // No-school day? Short-circuit to a closed state so the scholar's "Right
    // now" strip shows "No School — <label>" instead of an empty bell schedule.
    // Both holiday + staffOnly mean no classes for the scholar.
    const closures = await loadInstitutionClosures(ctx, scholar.institutionId);
    const closure = isClosedDay(dayKey, closures);
    if (closure) {
      return {
        timeZone,
        blocks: [],
        closure: { label: closure.label, kind: closure.kind },
        trip: null,
      };
    }

    // A field trip today for one of the scholar's groups (TRA-601): Home names
    // it, and the blocks it covers drop out of the strip because the scholar
    // is away for them. Only the first trip of the day is named.
    const { trips } = await tripsForScholar(ctx, scholar._id, dayKey, dayKey);
    const todayTrip = [...trips].sort((a, b) => a.startLocal.localeCompare(b.startLocal))[0];
    const trip = todayTrip
      ? {
          destination: todayTrip.destination,
          startLocal: todayTrip.startLocal,
          endLocal: todayTrip.endLocal,
        }
      : null;
    const awayForBlock = (startLocal: string, endLocal: string) => {
      const start = parseHHMM(startLocal);
      const end = parseHHMM(endLocal);
      if (start == null || end == null || trips.length === 0) return false;
      let startsAt: number;
      let endsAt: number;
      try {
        startsAt = instantForLocalMinutes(dayKey, start, timeZone);
        endsAt = instantForLocalMinutes(dayKey, end, timeZone);
      } catch {
        return false; // a DST gap: no block meets there
      }
      return trips.some((t) => tripOverlaps(t, timeZone, startsAt, endsAt));
    };

    const timetable = await scholarTimetableContext(ctx, scholar);
    if (!timetable.periodId || timetable.groupIds.length === 0) {
      return { timeZone, blocks: [], closure: null, trip };
    }

    const allBlocks = await ctx.db
      .query("scheduleBlocks")
      .withIndex("by_period", (q) => q.eq("periodId", timetable.periodId!))
      .collect();
    const sharedBlocks = allBlocks.filter((block) => block.groupId == null);
    const currentWeek = currentWeekStartMs(
      dayStartForDayKey(dayKey, timeZone),
      timeZone,
    );
    const placements = timetable.placements.filter(
      (placement) =>
        placement.weekday === weekday &&
        placement.blockId != null &&
        (placement.weekStartMs == null ||
          placement.weekStartMs === currentWeek),
    );
    const teacherIds = new Set(
      placements
        .map((placement) => placement.teacherId)
        .filter((teacherId): teacherId is Id<"users"> => teacherId != null),
    );
    const teachers = await Promise.all(
      [...teacherIds].map((teacherId) => ctx.db.get(teacherId)),
    );
    const teacherNameById = new Map(
      teachers
        .filter((teacher): teacher is Doc<"users"> => teacher != null)
        .map((teacher) => [String(teacher._id), teacher.name ?? null]),
    );
    const blocks: Array<{
      key: string;
      label: string;
      startLocal: string;
      endLocal: string;
      kind: "class" | "recess" | "lunch" | "prep" | "homework";
      subject: string | null;
      teacherName: string | null;
    }> = [];

    // A scholar can belong to more than one scholarGroup at once, and not every
    // group carries schedulePlacements/override blocks. Build the effective bell
    // schedule ONCE across all of the scholar's groups and dedupe by block key,
    // so a shared block is never emitted twice (once with the real
    // subject/teacher and once as a null-attribution phantom from a group that
    // owns no placements).
    const myGroupIdSet = new Set(timetable.groupIds.map(String));

    // Fix G: only treat a group-override block as "masking" the shared block
    // with the same key when the override actually applies to TODAY's weekday.
    // Previously, overrideKeys was built from ALL override blocks regardless
    // of their weekdays, so a Friday-only override for "block-a" would suppress
    // the shared "block-a" on Monday–Thursday too (then the weekday filter would
    // drop the override, causing the block to vanish entirely Mon–Thu).
    const overrideBlocksToday = allBlocks.filter(
      (block) =>
        block.groupId != null &&
        myGroupIdSet.has(String(block.groupId)) &&
        block.weekdays.includes(weekday),
    );
    const overrideKeysForToday = new Set(
      overrideBlocksToday.map((block) => block.key),
    );

    const effectiveByKey = new Map<string, Doc<"scheduleBlocks">>();
    for (const block of sharedBlocks) {
      if (overrideKeysForToday.has(block.key)) continue;
      if (block.weekdays.includes(weekday)) effectiveByKey.set(block.key, block);
    }
    for (const block of overrideBlocksToday) {
      effectiveByKey.set(block.key, block);
    }

    // Sort effective blocks by start time so spanBlocks index lookup is stable.
    const sortedEffective = [...effectiveByKey.values()].sort(
      (a, b) =>
        (parseHHMM(a.startLocal) ?? Infinity) -
        (parseHHMM(b.startLocal) ?? Infinity),
    );

    for (let blockIdx = 0; blockIdx < sortedEffective.length; blockIdx++) {
      const block = sortedEffective[blockIdx];
      // Best placement for this block across ALL of the scholar's groups (a
      // group without placements contributes none; a scheduled group supplies
      // subject + teacher).
      const candidates = placements.filter(
        (placement) => placement.blockId === block._id,
      );
      const placement =
        candidates.find((candidate) => candidate.weekStartMs === currentWeek) ??
        candidates.find((candidate) => candidate.weekStartMs == null) ??
        null;

      // Fix H: if the placement spans multiple blocks (spanBlocks > 1),
      // extend endLocal to the end of the last spanned block in sorted order.
      let endLocal = block.endLocal;
      const span = placement?.spanBlocks ?? 1;
      if (span > 1) {
        const lastIdx = Math.min(blockIdx + span - 1, sortedEffective.length - 1);
        endLocal = sortedEffective[lastIdx].endLocal;
      }

      blocks.push({
        key: block.key,
        label: block.label,
        startLocal: block.startLocal,
        endLocal,
        kind: block.kind ?? "class",
        subject: placement?.subject.trim() || null,
        teacherName: placement?.teacherId
          ? teacherNameById.get(String(placement.teacherId)) ?? null
          : null,
      });
    }

    blocks.sort(
      (a, b) =>
        (parseHHMM(a.startLocal) ?? Infinity) -
          (parseHHMM(b.startLocal) ?? Infinity) ||
        a.key.localeCompare(b.key) ||
        (a.subject ?? "").localeCompare(b.subject ?? ""),
    );
    return {
      timeZone,
      blocks: blocks.filter((block) => !awayForBlock(block.startLocal, block.endLocal)),
      closure: null,
      trip,
    };
  },
});

// ── Block CRUD ────────────────────────────────────────────────────────────

const blockKindValidator = v.union(
  v.literal("class"),
  v.literal("recess"),
  v.literal("lunch"),
  v.literal("prep"),
  v.literal("homework"),
);

async function coreCreateBlock(
  ctx: MutationCtx,
  args: {
    periodId: Id<"reportingPeriods">;
    groupId?: Id<"scholarGroups">;
    label: string;
    startLocal: string;
    endLocal: string;
    weekdays?: number[];
    key?: string;
    order?: number;
    staffNeed?: number;
    kind?: "class" | "recess" | "lunch" | "prep" | "homework";
  },
): Promise<Id<"scheduleBlocks">> {
  const label = args.label.trim();
  if (!label) throw new Error("Block needs a label");
  if (parseHHMM(args.startLocal) == null) throw new Error(`Bad start time "${args.startLocal}" (use HH:MM)`);
  if (parseHHMM(args.endLocal) == null) throw new Error(`Bad end time "${args.endLocal}" (use HH:MM)`);
  // QB ruling (round 4): no real school block spans midnight, and
  // speculative overnight support fails the necessity bar — reject end<=
  // start outright rather than silently materializing a negative-duration
  // (or wildly-wrong-duration) window. Same-day arithmetic only, on
  // purpose: this is a wall-clock label comparison, not a DST-aware one.
  if (parseHHMM(args.endLocal)! <= parseHHMM(args.startLocal)!) {
    throw new Error("Block end must be after its start.");
  }
  const existing = await ctx.db
    .query("scheduleBlocks")
    .withIndex("by_period", (q) => q.eq("periodId", args.periodId))
    .collect();
  const order = args.order ?? existing.length;
  const key = (args.key ?? label).trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || `block-${order}`;
  return ctx.db.insert("scheduleBlocks", {
    periodId: args.periodId,
    groupId: args.groupId,
    key,
    label,
    startLocal: args.startLocal,
    endLocal: args.endLocal,
    weekdays: args.weekdays && args.weekdays.length > 0 ? args.weekdays : [1, 2, 3, 4, 5],
    order,
    staffNeed: args.staffNeed,
    kind: args.kind,
  });
}

/** The refusal a teacher sees for a bell-schedule edit (Andy, 2026-11-08). */
export const BELL_SCHEDULE_ADMIN_ONLY = "Only a school admin can change the bell schedule.";

/**
 * The bell schedule is school-wide, so only the school's leaders change it
 * (Andy, 2026-11-08): a `school_admin` of the term's school, or a platform
 * admin. Teachers keep editing their own groups' weekly classes through the
 * placement mutations. The term's school must also be reachable by the caller
 * (requireScheduleScopeAccessible), which closes the cross-tenant gap on a
 * `createBlock` with no group (TRA-604). Standing comes from the caller's
 * school_admin MEMBERSHIP at that school, not `users.role` alone, so a leader
 * of one school who teaches at another can't reshape the other's day.
 */
/**
 * Whether `user` leads the term's school: a `school_admin` membership there, a
 * legacy school admin of the primary school (the shared
 * `usesLegacyPrimaryStaffing` rule), or a platform admin. The bell-schedule
 * gate below and the page's `canEditBellSchedule` both read this, so the page
 * offers editing exactly when the server allows it.
 */
async function leadsTermSchool(
  ctx: QueryCtx,
  user: Doc<"users">,
  periodId: Id<"reportingPeriods">,
): Promise<boolean> {
  if (isPlatformAdminRole(user.role)) return true;
  const period = await ctx.db.get(periodId);
  const institutionId =
    period?.institutionId ?? (await primaryInstitutionId(ctx));
  if (institutionId == null) return false;
  const memberships = await ctx.db
    .query("memberships")
    .withIndex("by_user", (q) => q.eq("userId", user._id))
    .collect();
  if (
    memberships.some(
      (m) => m.role === ROLES.SCHOOL_ADMIN && m.institutionId === institutionId,
    )
  ) {
    return true;
  }
  return (
    user.role === ROLES.SCHOOL_ADMIN &&
    usesLegacyPrimaryStaffing(user, memberships) &&
    institutionId === (await primaryInstitutionId(ctx))
  );
}

async function requireBellScheduleAdmin(
  ctx: QueryCtx,
  user: Doc<"users">,
  periodId: Id<"reportingPeriods">,
): Promise<void> {
  await requireScheduleScopeAccessible(ctx, user, { periodId });
  if (!(await leadsTermSchool(ctx, user, periodId))) {
    throw new ConvexError(BELL_SCHEDULE_ADMIN_ONLY);
  }
}

/**
 * The school boundary for a write keyed by a term and a group: both must be in
 * the caller's schools (requireScheduleScopeAccessible), and any block or
 * placement the client names must belong to that same term, so a local term
 * can't carry a write onto another term's row.
 */
async function requireTermWriteScope(
  ctx: QueryCtx,
  user: Doc<"users">,
  args: {
    periodId: Id<"reportingPeriods">;
    groupId: Id<"scholarGroups">;
    blockIds?: (Id<"scheduleBlocks"> | undefined)[];
    placementIds?: (Id<"schedulePlacements"> | undefined)[];
  },
): Promise<void> {
  await requireScheduleScopeAccessible(ctx, user, {
    periodId: args.periodId,
    groupId: args.groupId,
  });
  for (const blockId of args.blockIds ?? []) {
    if (!blockId) continue;
    const block = await ctx.db.get(blockId);
    if (block && block.periodId !== args.periodId) {
      throw new Error("Forbidden: that block belongs to a different term");
    }
  }
  for (const placementId of args.placementIds ?? []) {
    if (!placementId) continue;
    const placement = await ctx.db.get(placementId);
    if (placement && placement.periodId !== args.periodId) {
      throw new Error("Forbidden: that placement belongs to a different term");
    }
  }
}

/** Whether the caller may change this term's bell schedule: the same rule the
 *  block mutations enforce. False (never a throw) for a term the caller can't
 *  reach, so the page simply shows the schedule read-only. */
export const canEditBellSchedule = teacherQuery({
  args: { periodId: v.id("reportingPeriods") },
  handler: async (ctx, { periodId }) => {
    try {
      await requireScheduleScopeAccessible(ctx, ctx.user, { periodId });
    } catch {
      return false;
    }
    return leadsTermSchool(ctx, ctx.user, periodId);
  },
});

export const createBlock = teacherMutation({
  args: {
    periodId: v.id("reportingPeriods"),
    groupId: v.optional(v.id("scholarGroups")),
    label: v.string(),
    startLocal: v.string(),
    endLocal: v.string(),
    weekdays: v.optional(v.array(v.number())),
    key: v.optional(v.string()),
    order: v.optional(v.number()),
    staffNeed: v.optional(v.number()),
    kind: v.optional(blockKindValidator),
  },
  handler: async (ctx, args) => {
    // A group-only block must also name a group the caller can reach; the
    // tenancy refusal comes before the admin-only one.
    if (args.groupId) {
      await requireGroupScholarAccess(ctx, ctx.user, args.groupId);
    }
    await requireBellScheduleAdmin(ctx, ctx.user, args.periodId);
    return coreCreateBlock(ctx, args);
  },
});

// ── Homework (Q3) ─────────────────────────────────────────────────────────
//
// Homework is a scholar obligation with a due day, NOT a room reservation. A
// term gets ONE virtual `kind:"homework"` block, the grid's top-of-day
// Homework due row. On the teacher grid that row draws homework GIVES
// (gridGiveActions.giveHomework writes them). Only program handouts still pin
// a homework chip to the block (corePlaceHomework, from placeProgramHandout,
// placeProgramHomework and placeProgramHomeworkOnDate); there is no public
// homework-card writer. Its startLocal ("08:00") is a chip's release time; reconcile sets dueAt = end of the due day. See
// scheduling-model-sketches.html §5.

const HOMEWORK_BLOCK_KEY = "homework-due";

/** Find-or-create the term's single virtual homework-due block. Shared across
 *  groups (groupId undefined); ordered last so it never interleaves the bell
 *  schedule; staffNeed 0 so it never trips the coverage rail. */
async function ensureHomeworkBlock(
  ctx: MutationCtx,
  periodId: Id<"reportingPeriods">,
): Promise<Id<"scheduleBlocks">> {
  const blocks = await ctx.db
    .query("scheduleBlocks")
    .withIndex("by_period", (q) => q.eq("periodId", periodId))
    .collect();
  const existing = blocks.find((b) => b.kind === "homework" && b.groupId == null);
  if (existing) return existing._id;
  return ctx.db.insert("scheduleBlocks", {
    periodId,
    key: HOMEWORK_BLOCK_KEY,
    label: "Homework due",
    startLocal: "08:00",
    endLocal: "08:00",
    weekdays: [1, 2, 3, 4, 5, 6, 7],
    order: 9999,
    staffNeed: 0,
    kind: "homework",
  });
}

/** Place a homework chip on its due weekday. Resolves the virtual homework
 *  block so the caller only picks the DUE weekday. Work needs that day: with
 *  none, corePlaceClass refuses it (WORK_NEEDS_A_DAY), as the shelf retired
 *  for work (TRA-582). */
// Exported for program handouts' own callers and for tests that seed a card
// placed before TRA-582; the teacher grid gives work instead.
export async function corePlaceHomework(
  ctx: MutationCtx,
  args: {
    periodId: Id<"reportingPeriods">;
    groupId: Id<"scholarGroups">;
    subject: string;
    teacherId?: Id<"users">;
    assignmentId?: Id<"assignments">;
    activityId?: Id<"activities">;
    dueWeekday?: number;
    weekStartMs?: number;
    note?: string;
  },
): Promise<Id<"schedulePlacements">> {
  const placed = args.dueWeekday != null;
  const blockId = placed ? await ensureHomeworkBlock(ctx, args.periodId) : undefined;
  return corePlaceClass(ctx, {
    periodId: args.periodId,
    groupId: args.groupId,
    subject: args.subject,
    teacherId: args.teacherId,
    assignmentId: args.assignmentId,
    activityId: args.activityId,
    mode: "homework",
    weekday: args.dueWeekday,
    blockId,
    weekStartMs: args.weekStartMs,
    note: args.note,
  });
}

/** Idempotently provision a term's virtual homework-due block so the top-of-day
 *  DUE RAIL is discoverable even before any homework exists. Without this the rail
 *  only appears after the first homework placement (chicken-and-egg): no block →
 *  the frontend's `homeworkBlockId` is null → the rail — and its "add homework"
 *  affordance — never render. Find-or-create, so calling it repeatedly is safe. */
export const ensureHomeworkRail = teacherMutation({
  args: { periodId: v.id("reportingPeriods") },
  handler: async (ctx, { periodId }) => {
    await requireScheduleScopeAccessible(ctx, ctx.user, { periodId });
    return ensureHomeworkBlock(ctx, periodId);
  },
});

async function coreUpdateBlock(
  ctx: MutationCtx,
  args: {
    blockId: Id<"scheduleBlocks">;
    label?: string;
    startLocal?: string;
    endLocal?: string;
    weekdays?: number[];
    order?: number;
    staffNeed?: number;
    kind?: "class" | "recess" | "lunch" | "prep" | "homework";
  },
): Promise<void> {
  const block = await ctx.db.get(args.blockId);
  if (!block) throw new Error("Block not found");
  const patch: Partial<Doc<"scheduleBlocks">> = {};
  if (args.label !== undefined) {
    const l = args.label.trim();
    if (!l) throw new Error("Block needs a label");
    patch.label = l;
  }
  if (args.startLocal !== undefined) {
    if (parseHHMM(args.startLocal) == null) throw new Error(`Bad start time "${args.startLocal}"`);
    patch.startLocal = args.startLocal;
  }
  if (args.endLocal !== undefined) {
    if (parseHHMM(args.endLocal) == null) throw new Error(`Bad end time "${args.endLocal}"`);
    patch.endLocal = args.endLocal;
  }
  if (args.startLocal !== undefined || args.endLocal !== undefined) {
    // QB ruling (round 4): reject end<=start at the write boundary — same
    // as coreCreateBlock. Compares the EFFECTIVE pair (whichever of the two
    // is being patched here, falling back to the block's existing value for
    // the one that isn't), so editing only one side still catches a bad
    // combination with the other.
    const effectiveStartMin = parseHHMM(patch.startLocal ?? block.startLocal)!;
    const effectiveEndMin = parseHHMM(patch.endLocal ?? block.endLocal)!;
    if (effectiveEndMin <= effectiveStartMin) {
      throw new Error("Block end must be after its start.");
    }
  }
  if (args.weekdays !== undefined) patch.weekdays = args.weekdays;
  if (args.order !== undefined) patch.order = args.order;
  if (args.staffNeed !== undefined) patch.staffNeed = args.staffNeed;
  if (args.kind !== undefined) patch.kind = args.kind;
  await ctx.db.patch(args.blockId, patch);
  // A start/end edit changes the local time EVERY placement pinned to this
  // block reads on its next reconcile — without reconciling here, that
  // change is invisible until an unrelated write-time edit on the placement
  // itself or the next 15-minute cron tick. For an app-target placement this
  // is the retiming case the window-identity design exists to support:
  // WITHIN the same occurrence (same calendar date) a start/end edit legally
  // retimes an already-open push in place (reconcileAppPlacement), while a
  // teacher-cleared occurrence stays terminal through it regardless.
  if (args.startLocal !== undefined || args.endLocal !== undefined ||
      args.weekdays !== undefined || args.kind !== undefined) {
    const onBlock = await ctx.db
      .query("schedulePlacements")
      .withIndex("by_block", (q) => q.eq("blockId", args.blockId))
      .collect();
    if (args.startLocal !== undefined || args.endLocal !== undefined) {
      await reconcilePlacementsById(ctx, onBlock.map((p) => ({ id: p._id })));
    } else {
      await syncClassesForPlacements(ctx, onBlock);
    }
  }
}

export const updateBlock = teacherMutation({
  args: {
    blockId: v.id("scheduleBlocks"),
    label: v.optional(v.string()),
    startLocal: v.optional(v.string()),
    endLocal: v.optional(v.string()),
    weekdays: v.optional(v.array(v.number())),
    order: v.optional(v.number()),
    staffNeed: v.optional(v.number()),
    kind: v.optional(blockKindValidator),
  },
  handler: async (ctx, args) => {
    const block = await ctx.db.get(args.blockId);
    if (block) {
      await requireScheduleScopeAccessible(ctx, ctx.user, block);
      await requireBellScheduleAdmin(ctx, ctx.user, block.periodId);
    }
    return coreUpdateBlock(ctx, args);
  },
});

/** Work can't wait on the shelf (TRA-582): it is given to a class meeting. */
export const WORK_NEEDS_A_DAY =
  "Only a class can wait without a day. Work is given to a class meeting: pick a day and block.";

/**
 * Remove a bell block. Its classes move to "not yet scheduled" (Classes &
 * times shows them); placements carrying work are deleted, leaving the work
 * as the gives it already made (a placement's give outlives its card, as on
 * the teacher grid). Returns how many classes moved.
 */
async function coreRemoveBlock(ctx: MutationCtx, blockId: Id<"scheduleBlocks">): Promise<number> {
  const block = await ctx.db.get(blockId);
  if (!block) return 0;
  const onBlock = await ctx.db
    .query("schedulePlacements")
    .withIndex("by_block", (q) => q.eq("blockId", blockId))
    .collect();
  const work = onBlock.filter((p) => p.activityId != null || p.assignmentId != null);
  const classes = onBlock.filter((p) => p.activityId == null && p.assignmentId == null);
  for (const p of classes) {
    await ctx.db.patch(p._id, { blockId: undefined, weekday: undefined });
  }
  for (const p of work) await ctx.db.delete(p._id);
  await ctx.db.delete(blockId);
  // Shelved classes have no live window: settle their app pushes. Deleted
  // work rows keep their gives; their class records re-sync.
  await reconcilePlacementsById(ctx, classes.map((p) => ({ id: p._id })), classes);
  await syncClassesForPlacements(ctx, work);
  return classes.length;
}

export const removeBlock = teacherMutation({
  args: { blockId: v.id("scheduleBlocks") },
  handler: async (ctx, { blockId }) => {
    const block = await ctx.db.get(blockId);
    if (block) {
      await requireScheduleScopeAccessible(ctx, ctx.user, block);
      await requireBellScheduleAdmin(ctx, ctx.user, block.periodId);
    }
    return coreRemoveBlock(ctx, blockId);
  },
});

// ── Placement create / update / move / remove ─────────────────────────────

const modeValidator = v.union(v.literal("classFocus"), v.literal("homework"));

/** Resolve the unit a single activity belongs to (activity → lesson → unit).
 *  Returns null for an unparented activity (no lesson) — then we can't ensure
 *  an assignment and the placement stays display-only. */
async function unitIdForActivity(
  ctx: MutationCtx,
  activityId: Id<"activities">,
): Promise<Id<"units"> | null> {
  const act = await ctx.db.get(activityId);
  if (!act || !act.lessonId) return null;
  const lesson = await ctx.db.get(act.lessonId);
  return lesson?.unitId ?? null;
}

/**
 * Find-or-create the (cohort × unit) assignment a schedule placement pushes
 * through — the missing link that makes the grid actually assign to scholars.
 * A placement only goes live via `reconcilePlacement`, which bails without an
 * `assignmentId`; so a bare `activityId` displays a chip but assigns nothing.
 *
 * The cohort is the group's CURRENT roster (`scholarGroups.scholarIds`).
 * Find-or-create dedupes onto an existing active assignment for the same unit
 * + exact roster — the SAME key as `assignments.assignWork` — so filling a
 * slot and using the Assign dialog converge on ONE assignment row, not two.
 */
async function ensureAssignmentForGroupUnit(
  ctx: MutationCtx,
  args: {
    groupId: Id<"scholarGroups">;
    unitId: Id<"units">;
    teacherId: Id<"users">;
  },
): Promise<Id<"assignments">> {
  const group = await ctx.db.get(args.groupId);
  const roster = Array.from(new Set(group?.scholarIds ?? []));
  const rosterSet = new Set(roster.map(String));
  // Placing a unit on a group's schedule assigns it, which publishes it
  // (TRA-490).
  await publishUnitOnAssign(ctx, args.unitId, args.teacherId);
  const mine = await ctx.db
    .query("assignments")
    .withIndex("by_teacher", (q) => q.eq("teacherId", args.teacherId))
    .collect();
  const existing = mine.find(
    (a) =>
      !a.archivedAt &&
      a.unitId === args.unitId &&
      a.scholarIds.length === roster.length &&
      a.scholarIds.every((id) => rosterSet.has(String(id))),
  );
  if (existing) return existing._id;
  return await ctx.db.insert("assignments", {
    teacherId: args.teacherId,
    unitId: args.unitId,
    scholarIds: roster,
    startedAt: Date.now(),
  });
}

/**
 * Only a class block takes a class's work or an app. Recess, lunch and prep
 * rows are not class time: they keep only BARE rows (a subject and a teacher,
 * nothing pushed to scholars), which is how supervision is staffed
 * (`blockStaffNeed` counts the adults placed there). The homework row takes
 * only homework chips, which `corePlaceHomework` pins there with mode
 * "homework". Before this check an activity or app could land in any row, and
 * an app "all day" for a group became a copy in every row of the day, recess
 * and lunch included (2026-10-30). Exported for tests.
 */
export function assertBlockTakesPlacement(
  block: Pick<Doc<"scheduleBlocks">, "kind" | "label">,
  placement: {
    mode?: "classFocus" | "homework";
    activityId?: Id<"activities">;
    assignmentId?: Id<"assignments">;
    externalAppId?: Id<"externalApps">;
  },
): void {
  const kind = block.kind ?? "class";
  if (kind === "class") return;
  if (kind === "homework") {
    if (placement.mode === "homework") return;
    throw new ConvexError(
      "The homework row holds homework only. Give the work a due date instead, or put the class in a class block.",
    );
  }
  if (!placement.activityId && !placement.assignmentId && !placement.externalAppId) {
    return;
  }
  throw new ConvexError(
    `${block.label} is a ${kind} block, so it can't hold an activity or an app. Put it in a class block.`,
  );
}

// Exported for tests that seed a card placed before TRA-582. The public
// placeClass takes no work; program handouts call it in-file.
export async function corePlaceClass(
  ctx: MutationCtx,
  args: {
    periodId: Id<"reportingPeriods">;
    groupId: Id<"scholarGroups">;
    subject: string;
    teacherId?: Id<"users">;
    assignmentId?: Id<"assignments">;
    activityId?: Id<"activities">;
    // The "standing assignment" app target — mutually exclusive with
    // activityId (see the schema comment on schedulePlacements.externalAppId).
    externalAppId?: Id<"externalApps">;
    mode?: "classFocus" | "homework";
    weekday?: number;
    blockId?: Id<"scheduleBlocks">;
    spanBlocks?: number;
    note?: string;
    weekStartMs?: number;
    // Signed-in teacher — owns an assignment auto-ensured for a slot-fill.
    actorId?: Id<"users">;
    // Internal callers that already resolved the term avoid a duplicate lookup.
    timeZone?: string;
  },
): Promise<Id<"schedulePlacements">> {
  const subject = args.subject.trim();
  if (!subject) throw new Error("A class needs a subject label");
  if (args.activityId && args.externalAppId) {
    throw new Error(
      "A class slot can link a curriculum activity or a catalog app, not both.",
    );
  }
  if (args.activityId) {
    const act = await ctx.db.get(args.activityId);
    if (!act) throw new Error("Can't place: this activity was deleted.");
    if (act.archivedAt) {
      throw new Error("Can't place an archived activity — unarchive it first.");
    }
  }
  if (args.externalAppId) {
    const app = await ctx.db.get(args.externalAppId);
    if (!app) throw new Error("Can't place: that app isn't in the catalog.");
    if (app.archived) {
      throw new Error(`"${app.name}" is archived — unarchive it first.`);
    }
  }
  // Both-or-neither: a placed cell has weekday AND block; a shelf item has
  // neither. Reject a half-placed row (it would render nowhere).
  const placed = args.weekday != null && args.blockId != null;
  const shelved = args.weekday == null && args.blockId == null;
  if (!placed && !shelved) {
    throw new Error("A placement needs BOTH weekday and blockId (to place it) or NEITHER (to shelf it)");
  }
  // The shelf retired for work (TRA-582): only a class can wait without a day.
  if (shelved && (args.activityId || args.assignmentId)) {
    throw new ConvexError(WORK_NEEDS_A_DAY);
  }
  if (placed) {
    const block = await ctx.db.get(args.blockId!);
    if (!block) throw new Error("That block no longer exists.");
    assertBlockTakesPlacement(block, args);
  }
  const weekStartMs =
    args.weekStartMs == null
      ? undefined
      : currentWeekStartMs(
          args.weekStartMs,
          args.timeZone ??
            (await closuresForPeriod(ctx, args.periodId)).timeZone,
        );
  // Dropping a concrete activity without an explicit assignment link would be
  // inert (reconcile can't push it). Ensure the (group × unit) assignment so
  // the grid genuinely assigns. Cascade passes assignmentId itself → no-op here.
  let assignmentId = args.assignmentId;
  const owner = args.teacherId ?? args.actorId;
  if (!assignmentId && args.activityId && owner) {
    const unitId = await unitIdForActivity(ctx, args.activityId);
    if (unitId) {
      assignmentId = await ensureAssignmentForGroupUnit(ctx, {
        groupId: args.groupId,
        unitId,
        teacherId: owner,
      });
    }
  }
  // Exact duplicates render as identical stacked chips and trip neither the
  // conflict nor overload flag, so the write path is the uniqueness boundary.
  if (placed) {
    const existing = await findIdenticalPlacement(ctx, {
      periodId: args.periodId,
      groupId: args.groupId,
      weekday: args.weekday!,
      blockId: args.blockId!,
      weekStartMs,
      subject,
      activityId: args.activityId,
      assignmentId,
      externalAppId: args.externalAppId,
      mode: args.mode,
      teacherId: args.teacherId,
      spanBlocks: args.spanBlocks,
      note: args.note,
    });
    if (existing) {
      const patch: Partial<Doc<"schedulePlacements">> = {};
      // A recurrence requested after a matching dated bare placement must keep
      // the date's identity but become the recurring shell. The converse already
      // returns the recurring row, so both write orders converge on one row.
      if (
        weekStartMs == null &&
        existing.weekStartMs != null &&
        existing.assignmentId == null &&
        existing.activityId == null &&
        existing.externalAppId == null
      ) {
        patch.weekStartMs = undefined;
      }
      if (args.teacherId !== undefined && existing.teacherId !== args.teacherId) {
        patch.teacherId = args.teacherId;
      }
      if (args.spanBlocks !== undefined && existing.spanBlocks !== args.spanBlocks) {
        patch.spanBlocks = args.spanBlocks;
      }
      if (args.note !== undefined) {
        const note = args.note.trim() || undefined;
        if (existing.note !== note) patch.note = note;
      }
      if (Object.keys(patch).length > 0) {
        await ctx.db.patch(existing._id, patch);
      }
      await upsertClassForPlacement(ctx, { ...existing, ...patch });
      return existing._id;
    }
  }
  const placementId = await ctx.db.insert("schedulePlacements", {
    periodId: args.periodId,
    groupId: args.groupId,
    subject,
    teacherId: args.teacherId,
    assignmentId,
    activityId: args.activityId,
    externalAppId: args.externalAppId,
    mode: args.mode,
    weekday: placed ? args.weekday : undefined,
    blockId: placed ? args.blockId : undefined,
    spanBlocks: args.spanBlocks,
    note: args.note?.trim() || undefined,
    weekStartMs,
  });
  // Auto-materialize into the live push layer (no manual Publish step).
  await reconcilePlacementById(ctx, placementId, weekStartMs);
  return placementId;
}

async function findIdenticalPlacement(
  ctx: MutationCtx,
  args: {
    periodId: Id<"reportingPeriods">;
    groupId: Id<"scholarGroups">;
    weekday: number;
    blockId: Id<"scheduleBlocks">;
    weekStartMs?: number;
    subject: string;
    activityId?: Id<"activities">;
    assignmentId?: Id<"assignments">;
    externalAppId?: Id<"externalApps">;
    mode?: "classFocus" | "homework";
    teacherId?: Id<"users">;
    spanBlocks?: number;
    note?: string;
    sequenceId?: string;
    sequenceIndex?: number;
    createdFromStrategy?: "contiguous" | "daily" | "unitPacing" | "classMeetings" | "sameDay" | "chat";
    excludePlacementId?: Id<"schedulePlacements">;
  },
): Promise<Doc<"schedulePlacements"> | undefined> {
  const rows = await ctx.db
    .query("schedulePlacements")
    .withIndex("by_period_group", (q) =>
      q.eq("periodId", args.periodId).eq("groupId", args.groupId),
    )
    .collect();
  const resolvedMode = args.mode ?? "classFocus";
  return rows.find(
    (row) => {
      const sameWeek = row.weekStartMs === args.weekStartMs;
      const bareRecurringMatch =
        args.activityId == null &&
        args.assignmentId == null &&
        args.externalAppId == null &&
        row.activityId == null &&
        row.assignmentId == null &&
        row.externalAppId == null &&
        (row.weekStartMs == null) !== (args.weekStartMs == null) &&
        sameBarePlacementMetadata(row, args);
      return (
        row._id !== args.excludePlacementId &&
        row.weekday === args.weekday &&
        row.blockId === args.blockId &&
        (sameWeek || bareRecurringMatch) &&
        normalizedSchedulePlacementSubject(row.subject) ===
          normalizedSchedulePlacementSubject(args.subject) &&
        row.activityId === args.activityId &&
        row.assignmentId === args.assignmentId &&
        row.externalAppId === args.externalAppId &&
        (row.mode ?? "classFocus") === resolvedMode
      );
    },
  );
}

function sameBarePlacementMetadata(
  row: Doc<"schedulePlacements">,
  args: {
    teacherId?: Id<"users">;
    mode?: "classFocus" | "homework";
    spanBlocks?: number;
    note?: string;
    sequenceId?: string;
    sequenceIndex?: number;
    createdFromStrategy?: "contiguous" | "daily" | "unitPacing" | "classMeetings" | "sameDay" | "chat";
  },
) {
  return (
    row.teacherId === args.teacherId &&
    (row.mode ?? "classFocus") === (args.mode ?? "classFocus") &&
    row.spanBlocks === args.spanBlocks &&
    normalizedSchedulePlacementText(row.note) ===
      normalizedSchedulePlacementText(args.note) &&
    row.sequenceId === args.sequenceId &&
    row.sequenceIndex === args.sequenceIndex &&
    row.createdFromStrategy === args.createdFromStrategy &&
    !row.orderOverride &&
    (row.dismissedFlags?.length ?? 0) === 0
  );
}

function effectivePlacementsForWeek(
  placements: Doc<"schedulePlacements">[],
  weekStartMs: number,
): Doc<"schedulePlacements">[] {
  const rowsForWeek = placements.filter(
    (placement) =>
      placement.weekStartMs == null || placement.weekStartMs === weekStartMs,
  );
  const concreteClassKeys = new Set(
    rowsForWeek
      .filter((placement) => placement.weekStartMs === weekStartMs)
      .map(barePlacementWeekOverrideKey)
      .filter((key): key is string => key != null),
  );
  return rowsForWeek.filter(
    (placement) =>
      placement.weekStartMs != null ||
      !concreteClassKeys.has(barePlacementWeekOverrideKey(placement) ?? ""),
  );
}

export const placeClass = teacherMutation({
  args: {
    periodId: v.id("reportingPeriods"),
    groupId: v.id("scholarGroups"),
    subject: v.string(),
    teacherId: v.optional(v.id("users")),
    externalAppId: v.optional(v.id("externalApps")),
    mode: v.optional(modeValidator),
    weekday: v.optional(v.number()),
    blockId: v.optional(v.id("scheduleBlocks")),
    spanBlocks: v.optional(v.number()),
    note: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    // Work is a give to a class (gridGiveActions), never a new card.
    // Institution boundary: the named group is the write key for this
    // placement and teacherId (when supplied) is a second one. The term and
    // the block are checked too.
    await requireTermWriteScope(ctx, ctx.user, {
      periodId: args.periodId,
      groupId: args.groupId,
      blockIds: [args.blockId],
    });
    if (args.teacherId) {
      await requireStaffAccessible(ctx, ctx.user, args.teacherId);
    }
    return corePlaceClass(ctx, { ...args, actorId: ctx.user._id });
  },
});

// ── Program handouts: activity cards on purpose ─────────────────────────
//
// The teacher grid gives work to a class (TRA-582: gridGiveActions), but the
// program writers below still create activity CARDS, deliberately. The program
// grid draws those cards, a handout's draft is a day-less card that anchors
// editing it (createProgramHandoutDraft), and removing one returns it to that
// draft (removeProgramHandoutPlacement). Program staff may also lack the
// teacher or curriculum:run standing the give writers require. Moving program
// handouts to gives would change how program staff publish, so it is out of
// scope for the gives model until Andy decides otherwise.

const programHandoutTargetValidator = v.union(
  v.object({
    mode: v.literal("classFocus"),
    blockId: v.id("scheduleBlocks"),
    weekday: v.number(),
    weekStartMs: v.number(),
  }),
  v.object({
    mode: v.literal("homework"),
    dueDateMs: v.number(),
  }),
);

async function resolveProgramClassAnchor(
  ctx: MutationCtx,
  args: {
    periodId: Id<"reportingPeriods">;
    groupId: Id<"scholarGroups">;
    blockId: Id<"scheduleBlocks">;
    weekday: number;
    weekStartMs: number;
  },
): Promise<Doc<"schedulePlacements">> {
  const matches = (
    await ctx.db
      .query("schedulePlacements")
      .withIndex("by_period_group", (q) =>
        q.eq("periodId", args.periodId).eq("groupId", args.groupId),
      )
      .collect()
  ).filter(
    (placement) =>
      placement.blockId === args.blockId && placement.weekday === args.weekday,
  );
  const recurring = matches.find((placement) => placement.weekStartMs == null);
  const concreteBare = matches.find(
    (placement) =>
      placement.weekStartMs === args.weekStartMs &&
      !placement.activityId &&
      !placement.assignmentId,
  );
  const anchor = recurring ?? concreteBare ?? matches[0];
  if (!anchor) throw new Error("Program class placement not found.");
  return anchor;
}

async function requireProgramHandoutPeriod(
  ctx: MutationCtx & { user: Doc<"users"> },
  periodId: Id<"reportingPeriods">,
  groupId: Id<"scholarGroups">,
) {
  const group = await requireProgramPublishAccess(
    ctx,
    ctx.user,
    await ctx.db.get(groupId),
  );
  const period = await ctx.db.get(periodId);
  if (!period?.institutionId || period.institutionId !== group.institutionId) {
    throw new Error("Forbidden: program group and term must belong to the same school.");
  }
  return { group, period };
}

/**
 * Creates a lesson-less activity + ad-hoc assignment, the same shape as a
 * skill practice pair (lib/skillPractice.ts). The dormant schedule entry is the authorization anchor for
 * resource editing; it is not live and has no timing until placement.
 */
export const createProgramHandoutDraft = authedMutation({
  args: {
    periodId: v.id("reportingPeriods"),
    groupId: v.id("scholarGroups"),
    title: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { group } = await requireProgramHandoutPeriod(
      ctx,
      args.periodId,
      args.groupId,
    );
    const title = args.title?.trim() || "Handout";
    const existingAssignments = await ctx.db
      .query("assignments")
      .withIndex("by_scholar_group", (q) => q.eq("scholarGroupId", group._id))
      .collect();
    for (const assignment of existingAssignments) {
      if (
        assignment.archivedAt ||
        assignment.kind !== "adHocDispatch" ||
        assignment.unitId
      ) {
        continue;
      }
      const draftSchedule = await readSchedule(ctx, assignment);
      if (draftSchedule.length !== 1) continue;
      const entry = draftSchedule[0];
      const activity = await ctx.db.get(entry.activityId);
      if (
        activity &&
        !activity.archivedAt &&
        !activity.lessonId &&
        activity.kind === "offline" &&
        activity.title === title
      ) {
        const placements = await ctx.db
          .query("schedulePlacements")
          .withIndex("by_activity", (q) => q.eq("activityId", activity._id))
          .collect();
        if (
          placements.some(
            (placement) =>
              placement.periodId === args.periodId &&
              placement.groupId === group._id &&
              placement.assignmentId === assignment._id,
          )
        ) {
          return { activityId: activity._id, assignmentId: assignment._id };
        }
      }
    }

    const activityId = await ctx.db.insert("activities", {
      title,
      kind: "offline",
      order: 0,
    });
    const assignmentId = await ctx.db.insert("assignments", {
      teacherId: ctx.user._id,
      scholarGroupId: group._id,
      // A draft is deliberately audience-less. Placement takes the roster
      // snapshot: a scholar who joins while the author is preparing materials
      // receives the published handout, while later roster changes do not
      // retroactively widen it.
      scholarIds: [],
      title,
      kind: "adHocDispatch",
      startedAt: Date.now(),
    });
    await writeSchedule(ctx, assignmentId, [
      { activityId, mode: "classFocus" },
    ]);
    // A shelved placement carries the period + group before the staff member
    // chooses class time or a calendar due date. It never materializes because
    // it has neither a block nor weekday.
    await ctx.db.insert("schedulePlacements", {
      periodId: args.periodId,
      groupId: group._id,
      subject: title,
      teacherId: ctx.user._id,
      assignmentId,
      activityId,
      mode: "classFocus",
    });
    return { activityId, assignmentId };
  },
});

async function programGroupRoster(
  ctx: MutationCtx,
  group: Doc<"scholarGroups">,
): Promise<Id<"users">[]> {
  const seen = new Set<string>();
  const scholarIds: Id<"users">[] = [];
  for (const scholarId of group.scholarIds) {
    if (seen.has(String(scholarId))) continue;
    seen.add(String(scholarId));
    const scholar = await ctx.db.get(scholarId);
    if (
      !scholar ||
      scholar.role !== "scholar" ||
      scholar.institutionId !== group.institutionId
    ) {
      throw new Error("Program group contains an invalid scholar.");
    }
    scholarIds.push(scholar._id);
  }
  if (scholarIds.length === 0) {
    throw new Error("Program group must include at least one scholar.");
  }
  return scholarIds;
}

/**
 * Places one program-created Handout. This is intentionally separate from the
 * legacy unit-backed `placeProgramActivity`: a Handout author needs only the
 * group-scoped program capability, while curriculum activities retain their
 * existing curriculum authorization.
 */
export const placeProgramHandout = authedMutation({
  args: {
    periodId: v.id("reportingPeriods"),
    groupId: v.id("scholarGroups"),
    activityId: v.id("activities"),
    assignmentId: v.id("assignments"),
    target: programHandoutTargetValidator,
  },
  handler: async (ctx, args) => {
    const { group } = await requireProgramHandoutPeriod(
      ctx,
      args.periodId,
      args.groupId,
    );
    const handout = await requireProgramHandoutAccess(ctx, {
      activityId: args.activityId,
      assignmentId: args.assignmentId,
    });
    if (handout.group._id !== group._id) {
      throw new Error("Forbidden: handout assignment belongs to a different program group.");
    }
    const draftEntry = (await readSchedule(ctx, handout.assignment)).find(
      (entry) => entry.activityId === args.activityId,
    );
    const isUnplacedDraft =
      draftEntry != null &&
      draftEntry.startsAt == null &&
      draftEntry.dueAt == null &&
      draftEntry.setAt == null &&
      handout.assignment.scholarIds.length === 0;
    // The audience is a placement-time snapshot, not a draft-time one. Once
    // placed it stays frozen; an idempotent retry must not silently widen a
    // published handout to members who joined later.
    const scholarIds = isUnplacedDraft
      ? await programGroupRoster(ctx, group)
      : handout.assignment.scholarIds;
    if (isUnplacedDraft) {
      await ctx.db.patch(args.assignmentId, { scholarIds });
    }
    const closureCtx = await closuresForPeriod(ctx, args.periodId);
    const target = args.target;

    if (target.mode === "classFocus") {
      if (target.weekday < 1 || target.weekday > 7) {
        throw new Error("A class placement needs a valid weekday.");
      }
      const weekStartMs = currentWeekStartMs(
        target.weekStartMs,
        closureCtx.timeZone,
      );
      const closed = isClosedDay(
        scheduleWeekdayDayKey(
          weekStartMs,
          target.weekday,
          closureCtx.timeZone,
        ),
        closureCtx.closures,
      );
      if (closed) {
        throw new Error(`Can't schedule a handout on ${closed.label}; school is closed.`);
      }
      const block = await ctx.db.get(target.blockId);
      if (
        !block ||
        block.periodId !== args.periodId ||
        (block.groupId != null && block.groupId !== group._id) ||
        !block.weekdays.includes(target.weekday) ||
        block.kind === "homework"
      ) {
        throw new Error("Program class placement not found.");
      }
      const anchor = await resolveProgramClassAnchor(ctx, {
        periodId: args.periodId,
        groupId: group._id,
        blockId: block._id,
        weekday: target.weekday,
        weekStartMs,
      });
      const shelf = (
        await ctx.db
          .query("schedulePlacements")
          .withIndex("by_activity", (q) => q.eq("activityId", args.activityId))
          .collect()
      ).find(
        (candidate) =>
          candidate.periodId === args.periodId &&
          candidate.groupId === group._id &&
          candidate.assignmentId === args.assignmentId &&
          candidate.weekday == null &&
          candidate.blockId == null,
      );
      if (!shelf) {
        const existing = (
          await ctx.db
            .query("schedulePlacements")
            .withIndex("by_activity", (q) => q.eq("activityId", args.activityId))
            .collect()
        ).find(
          (candidate) =>
            candidate.periodId === args.periodId &&
            candidate.groupId === group._id &&
            candidate.assignmentId === args.assignmentId &&
            candidate.blockId === block._id &&
            candidate.weekday === target.weekday &&
            candidate.weekStartMs === weekStartMs &&
            (candidate.mode ?? "classFocus") === "classFocus",
        );
        if (!existing) {
          throw new Error("Program handout draft placement not found.");
        }
        await reconcilePlacementById(ctx, existing._id, weekStartMs);
        return {
          placementId: existing._id,
          assignmentId: args.assignmentId,
          activityId: args.activityId,
          weekStartMs,
          mode: "classFocus" as const,
        };
      }
      const placementId = await corePlaceClass(ctx, {
        periodId: args.periodId,
        groupId: group._id,
        subject: anchor.subject,
        ...(anchor.teacherId ? { teacherId: anchor.teacherId } : {}),
        assignmentId: args.assignmentId,
        activityId: args.activityId,
        mode: "classFocus",
        weekday: target.weekday,
        blockId: block._id,
        weekStartMs,
        timeZone: closureCtx.timeZone,
      });
      await ctx.db.delete(shelf._id);
      await reconcilePlacementById(ctx, placementId, weekStartMs);
      return {
        placementId,
        assignmentId: args.assignmentId,
        activityId: args.activityId,
        weekStartMs,
        mode: "classFocus" as const,
      };
    }

    const dueDayKey = dayKeyForTimezone(target.dueDateMs, closureCtx.timeZone);
    const closed = isClosedDay(dueDayKey, closureCtx.closures);
    if (closed) {
      throw new Error(`Can't schedule a handout on ${closed.label}; school is closed.`);
    }
    const weekStartMs = currentWeekStartMs(
      target.dueDateMs,
      closureCtx.timeZone,
    );
    const sundayWeekday = weekdayForTimezone(target.dueDateMs, closureCtx.timeZone);
    const dueWeekday = sundayWeekday === 0 ? 7 : sundayWeekday;
    const dueAt =
      dayStartForDayKey(shiftDayKey(dueDayKey, 1), closureCtx.timeZone) - 1;
    const startsAt = placementStartMs(
      weekStartMs,
      dueWeekday,
      "08:00",
      closureCtx.timeZone,
    );
    const placementId = await corePlaceHomework(ctx, {
      periodId: args.periodId,
      groupId: group._id,
      subject: handout.activity.title,
      assignmentId: args.assignmentId,
      activityId: args.activityId,
      dueWeekday,
      weekStartMs,
    });
    const shelf = (
      await ctx.db
        .query("schedulePlacements")
        .withIndex("by_activity", (q) => q.eq("activityId", args.activityId))
        .collect()
    ).find(
      (candidate) =>
        candidate._id !== placementId &&
        candidate.periodId === args.periodId &&
        candidate.groupId === group._id &&
        candidate.assignmentId === args.assignmentId &&
        candidate.weekday == null &&
        candidate.blockId == null,
    );
    if (shelf) await ctx.db.delete(shelf._id);
    const todayIsDueDay =
      dayKeyForTimezone(Date.now(), closureCtx.timeZone) === dueDayKey;
    const liveNow = startsAt != null && startsAt <= Date.now() && todayIsDueDay;
    if (liveNow) {
      const assignment = await ctx.db.get(args.assignmentId);
      if (assignment) {
        await applyPushActivity(ctx, assignment, {
          activityId: args.activityId,
          mode: "homework",
          dueAt,
          scholarIds,
        });
      }
    }
    return {
      placementId,
      assignmentId: args.assignmentId,
      activityId: args.activityId,
      weekStartMs,
      dueAt,
      mode: "homework" as const,
      liveNow,
    };
  },
});

/**
 * Return one program Handout from a concrete schedule cell to its shelf. This
 * deliberately targets only the named placement, so a stacked neighbor and the
 * recurring class shell remain intact. The group-scoped publish capability is
 * sufficient; it never grants the broad teacher placement CRUD surface.
 */
export const removeProgramHandoutPlacement = authedMutation({
  args: {
    placementId: v.id("schedulePlacements"),
    activityId: v.id("activities"),
    assignmentId: v.id("assignments"),
  },
  handler: async (ctx, args) => {
    const handout = await requireProgramHandoutAccess(ctx, args);
    const placement = await ctx.db.get(args.placementId);
    if (
      !placement ||
      placement.activityId !== args.activityId ||
      placement.assignmentId !== args.assignmentId ||
      placement.groupId !== handout.group._id ||
      placement.weekday == null ||
      placement.blockId == null
    ) {
      throw new Error("Program handout placement not found.");
    }

    await coreRemovePlacement(ctx, placement._id);
    const assignment = await ctx.db.get(args.assignmentId);
    // A planned entry was removed with the placement. Restore the dormant
    // ownership anchor and shelf row so the author can adjust and re-place the
    // same handout. A live entry intentionally remains live (the normal
    // remove-placement lifecycle never retracts scholar-visible work).
    const current = assignment ? await readSchedule(ctx, assignment) : [];
    if (
      assignment &&
      !current.some((entry) => entry.activityId === args.activityId)
    ) {
      await writeSchedule(
        ctx,
        assignment,
        [...current, { activityId: args.activityId, mode: "classFocus" }],
        { activityId: args.activityId },
      );
    }
    await ctx.db.insert("schedulePlacements", {
      periodId: placement.periodId,
      groupId: placement.groupId,
      subject: placement.subject,
      teacherId: placement.teacherId,
      assignmentId: args.assignmentId,
      activityId: args.activityId,
      mode: "classFocus",
    });
    return { removed: true };
  },
});

/** Delete only an untouched, unit-less program Handout draft. */
export const discardProgramHandoutDraft = authedMutation({
  args: {
    activityId: v.id("activities"),
    assignmentId: v.id("assignments"),
  },
  handler: async (ctx, args) => {
    const handout = await requireProgramHandoutAccess(ctx, args);
    const placements = await ctx.db
      .query("schedulePlacements")
      .withIndex("by_activity", (q) => q.eq("activityId", args.activityId))
      .collect();
    const entries = await readSchedule(ctx, handout.assignment);
    const entry = entries.find((candidate) => candidate.activityId === args.activityId);
    const shelf = placements.find(
      (placement) =>
        placement.assignmentId === args.assignmentId &&
        placement.groupId === handout.group._id &&
        placement.weekday == null &&
        placement.blockId == null,
    );
    if (
      placements.length !== 1 ||
      !shelf ||
      entries.length !== 1 ||
      !entry ||
      entry.setAt != null ||
      entry.startsAt != null ||
      entry.dueAt != null ||
      entry.scheduledFnId != null
    ) {
      throw new Error("Only an unscheduled program handout draft can be discarded.");
    }
    await deleteResourcesForActivity(ctx, args.activityId);
    // Retire through the placement primitive so the draft's planned schedule
    // entry and any scheduled activation are removed with this exact shelf row.
    // The precondition above guarantees this cannot touch a recurring shell,
    // a sibling placement, or another week's handout.
    await coreRemovePlacement(ctx, shelf._id);
    await ctx.db.delete(args.activityId);
    await closeScheduleForAssignment(ctx, args.assignmentId);
    await ctx.db.delete(args.assignmentId);
    return { discarded: true };
  },
});

/** Rename a lesson-less program Handout without granting curriculum edit access. */
export const updateProgramHandout = authedMutation({
  args: {
    activityId: v.id("activities"),
    assignmentId: v.id("assignments"),
    title: v.string(),
  },
  handler: async (ctx, args) => {
    const title = args.title.trim();
    if (!title) {
      throw new Error("Program handout title is required.");
    }
    const handout = await requireProgramHandoutAccess(ctx, args);
    const placements = await ctx.db
      .query("schedulePlacements")
      .withIndex("by_activity", (q) => q.eq("activityId", args.activityId))
      .collect();
    const previousTitles = new Set(
      [handout.activity.title, handout.assignment.title].filter(
        (candidate): candidate is string => Boolean(candidate),
      ),
    );
    await ctx.db.patch(args.activityId, { title });
    await ctx.db.patch(args.assignmentId, { title });
    const renamed = placements.filter(
      (placement) =>
        placement.assignmentId === args.assignmentId &&
        placement.groupId === handout.group._id &&
        previousTitles.has(placement.subject),
    );
    await Promise.all(renamed.map((placement) =>
      ctx.db.patch(placement._id, { subject: title })));
    await syncClassesForPlacements(ctx, renamed);
    return { activityId: args.activityId, assignmentId: args.assignmentId, title };
  },
});

/**
 * Put one program activity on the concrete homework due rail. This is
 * deliberately narrower than teacher placement CRUD: program staff may publish
 * only to their granted group and may not alter blocks, other groups, or
 * staffing.
 */
export async function placeProgramHomework(
  ctx: MutationCtx,
  args: {
    assignmentId: Id<"assignments">;
    activityId: Id<"activities">;
    groupId: Id<"scholarGroups">;
    institutionId: Id<"institutions"> | undefined;
    periodId: Id<"reportingPeriods">;
    dueWeekday: number;
    weekStartMs: number;
    subject?: string;
    roster: Id<"users">[];
  },
) {
  const period = await ctx.db.get(args.periodId);
  if (!period?.institutionId || period.institutionId !== args.institutionId) {
    throw new Error("Forbidden: program group and term must belong to the same school.");
  }

  if (args.dueWeekday < 1 || args.dueWeekday > 5) {
    throw new Error("A program handout due day must be Monday through Friday.");
  }
  const activity = await ctx.db.get(args.activityId);
  if (!activity || activity.archivedAt) {
    throw new Error("Can't place an unavailable activity.");
  }
  if (
    activity.kind === "offline" &&
    !(await hasReadableOfflineHomeworkContent(ctx, activity))
  ) {
    throw new Error("Can't schedule an empty handout — add instructions or materials first.");
  }
  const closureCtx = await closuresForPeriod(ctx, args.periodId);
  const weekStartMs = currentWeekStartMs(args.weekStartMs, closureCtx.timeZone);
  const dueDayKey = scheduleWeekdayDayKey(
    weekStartMs,
    args.dueWeekday,
    closureCtx.timeZone,
  );
  const closure = isClosedDay(dueDayKey, closureCtx.closures);
  if (closure) {
    throw new Error(`Can't schedule a handout on ${closure.label}; school is closed.`);
  }
  const dueAt =
    dayStartForDayKey(shiftDayKey(dueDayKey, 1), closureCtx.timeZone) - 1;
  const startsAt = placementStartMs(
    weekStartMs,
    args.dueWeekday,
    "08:00",
    closureCtx.timeZone,
  );
  const todayIsDueDay =
    dayKeyForTimezone(Date.now(), closureCtx.timeZone) === dueDayKey;
  const liveNow = startsAt != null && startsAt <= Date.now() && todayIsDueDay;
  const placementId = await corePlaceHomework(ctx, {
    periodId: args.periodId,
    groupId: args.groupId,
    subject: args.subject?.trim() || activity.title,
    assignmentId: args.assignmentId,
    activityId: args.activityId,
    dueWeekday: args.dueWeekday,
    weekStartMs,
  });
  if (liveNow) {
    const assignment = await ctx.db.get(args.assignmentId);
    if (assignment) {
      await applyPushActivity(ctx, assignment, {
        activityId: args.activityId,
        mode: "homework",
        dueAt,
        scholarIds: args.roster,
      });
    }
  }
  return {
    placementId,
    weekStartMs,
    dueAt,
    liveNow,
  };
}

async function placeProgramActivityClassFocus(
  ctx: MutationCtx,
  args: {
    assignmentId: Id<"assignments">;
    activityId: Id<"activities">;
    groupId: Id<"scholarGroups">;
    institutionId: Id<"institutions"> | undefined;
    periodId: Id<"reportingPeriods">;
    blockId: Id<"scheduleBlocks">;
    weekday: number;
    weekStartMs: number;
    subject?: string;
  },
) {
  const period = await ctx.db.get(args.periodId);
  if (!period?.institutionId || period.institutionId !== args.institutionId) {
    throw new Error("Forbidden: program group and term must belong to the same school.");
  }
  const activity = await ctx.db.get(args.activityId);
  if (!activity || activity.archivedAt) {
    throw new Error("Can't place an unavailable activity.");
  }
  if (
    activity.kind === "offline" &&
    !(await hasReadableOfflineHomeworkContent(ctx, activity))
  ) {
    throw new Error("Can't schedule an empty handout — add instructions or materials first.");
  }
  if (args.weekday < 1 || args.weekday > 7) {
    throw new Error("A class placement needs a valid weekday.");
  }
  const closureCtx = await closuresForPeriod(ctx, args.periodId);
  const weekStartMs = currentWeekStartMs(args.weekStartMs, closureCtx.timeZone);
  const closure = isClosedDay(
    scheduleWeekdayDayKey(weekStartMs, args.weekday, closureCtx.timeZone),
    closureCtx.closures,
  );
  if (closure) {
    throw new Error(`Can't schedule a handout on ${closure.label}; school is closed.`);
  }
  const block = await ctx.db.get(args.blockId);
  if (
    !block ||
    block.periodId !== args.periodId ||
    (block.groupId != null && block.groupId !== args.groupId) ||
    !block.weekdays.includes(args.weekday) ||
    block.kind === "homework"
  ) {
    throw new Error("Program class placement not found.");
  }
  const anchor = await resolveProgramClassAnchor(ctx, {
    periodId: args.periodId,
    groupId: args.groupId,
    blockId: block._id,
    weekday: args.weekday,
    weekStartMs,
  });
  const placementId = await corePlaceClass(ctx, {
    periodId: args.periodId,
    groupId: args.groupId,
    subject: anchor.subject,
    ...(anchor.teacherId ? { teacherId: anchor.teacherId } : {}),
    assignmentId: args.assignmentId,
    activityId: args.activityId,
    mode: "classFocus",
    weekday: args.weekday,
    blockId: block._id,
    weekStartMs,
    timeZone: closureCtx.timeZone,
  });
  await reconcilePlacementById(ctx, placementId, weekStartMs);
  return {
    placementId,
    weekStartMs,
    dueAt: undefined,
    liveNow: false,
    mode: "classFocus" as const,
  };
}

async function placeProgramHomeworkOnDate(
  ctx: MutationCtx,
  args: {
    assignmentId: Id<"assignments">;
    activityId: Id<"activities">;
    groupId: Id<"scholarGroups">;
    institutionId: Id<"institutions"> | undefined;
    periodId: Id<"reportingPeriods">;
    dueDateMs: number;
    subject?: string;
    roster: Id<"users">[];
  },
) {
  const period = await ctx.db.get(args.periodId);
  if (!period?.institutionId || period.institutionId !== args.institutionId) {
    throw new Error("Forbidden: program group and term must belong to the same school.");
  }
  const activity = await ctx.db.get(args.activityId);
  if (!activity || activity.archivedAt) {
    throw new Error("Can't place an unavailable activity.");
  }
  if (
    activity.kind === "offline" &&
    !(await hasReadableOfflineHomeworkContent(ctx, activity))
  ) {
    throw new Error("Can't schedule an empty handout — add instructions or materials first.");
  }
  const closureCtx = await closuresForPeriod(ctx, args.periodId);
  const dueDayKey = dayKeyForTimezone(args.dueDateMs, closureCtx.timeZone);
  const closure = isClosedDay(dueDayKey, closureCtx.closures);
  if (closure) {
    throw new Error(`Can't schedule a handout on ${closure.label}; school is closed.`);
  }
  const weekStartMs = currentWeekStartMs(args.dueDateMs, closureCtx.timeZone);
  const sundayWeekday = weekdayForTimezone(args.dueDateMs, closureCtx.timeZone);
  const dueWeekday = sundayWeekday === 0 ? 7 : sundayWeekday;
  const dueAt =
    dayStartForDayKey(shiftDayKey(dueDayKey, 1), closureCtx.timeZone) - 1;
  const startsAt = placementStartMs(
    weekStartMs,
    dueWeekday,
    "08:00",
    closureCtx.timeZone,
  );
  const placementId = await corePlaceHomework(ctx, {
    periodId: args.periodId,
    groupId: args.groupId,
    subject: args.subject?.trim() || activity.title,
    assignmentId: args.assignmentId,
    activityId: args.activityId,
    dueWeekday,
    weekStartMs,
  });
  const liveNow =
    startsAt != null &&
    startsAt <= Date.now() &&
    dayKeyForTimezone(Date.now(), closureCtx.timeZone) === dueDayKey;
  if (liveNow) {
    const assignment = await ctx.db.get(args.assignmentId);
    if (assignment) {
      await applyPushActivity(ctx, assignment, {
        activityId: args.activityId,
        mode: "homework",
        dueAt,
        scholarIds: args.roster,
      });
    }
  }
  return {
    placementId,
    weekStartMs,
    dueAt,
    liveNow,
    mode: "homework" as const,
  };
}

/** Place curriculum-backed program work in an exact class slot or on homework.
 * Legacy weekday/week arguments remain supported for existing callers. */
export const placeProgramActivity = authedMutation({
  args: {
    periodId: v.id("reportingPeriods"),
    groupId: v.id("scholarGroups"),
    activityId: v.id("activities"),
    target: v.optional(programHandoutTargetValidator),
    dueWeekday: v.optional(v.number()),
    weekStartMs: v.optional(v.number()),
    subject: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { assignment, created, roster, unit } = await ensureProgramAssignment(ctx, {
      activityId: args.activityId,
      scholarGroupId: args.groupId,
    });
    const placement = args.target
      ? args.target.mode === "classFocus"
        ? await placeProgramActivityClassFocus(ctx, {
            assignmentId: assignment._id,
            activityId: args.activityId,
            groupId: args.groupId,
            institutionId: unit.institutionId,
            periodId: args.periodId,
            blockId: args.target.blockId,
            weekday: args.target.weekday,
            weekStartMs: args.target.weekStartMs,
            subject: args.subject,
          })
        : await placeProgramHomeworkOnDate(ctx, {
            assignmentId: assignment._id,
            activityId: args.activityId,
            groupId: args.groupId,
            institutionId: unit.institutionId,
            periodId: args.periodId,
            dueDateMs: args.target.dueDateMs,
            subject: args.subject,
            roster,
          })
      : args.dueWeekday != null && args.weekStartMs != null
        ? await placeProgramHomework(ctx, {
            assignmentId: assignment._id,
            activityId: args.activityId,
            groupId: args.groupId,
            institutionId: unit.institutionId,
            periodId: args.periodId,
            dueWeekday: args.dueWeekday,
            weekStartMs: args.weekStartMs,
            subject: args.subject,
            roster,
          })
        : (() => {
            throw new Error("A program activity placement target is required.");
          })();
    return {
      assignmentId: assignment._id,
      created,
      placementId: placement.placementId,
      activityId: args.activityId,
      weekStartMs: placement.weekStartMs,
      dueAt: placement.dueAt,
      liveNow: placement.liveNow,
      mode: args.target?.mode ?? "homework",
    };
  },
});

// Exported for tests that relink a card placed before TRA-582. The public
// updatePlacement only unlinks work (null).
export async function coreUpdatePlacement(
  ctx: MutationCtx,
  args: {
    placementId: Id<"schedulePlacements">;
    subject?: string;
    teacherId?: Id<"users"> | null;
    assignmentId?: Id<"assignments"> | null;
    activityId?: Id<"activities"> | null;
    externalAppId?: Id<"externalApps"> | null;
    mode?: "classFocus" | "homework";
    spanBlocks?: number | null;
    note?: string | null;
    // Signed-in teacher — owns an assignment auto-ensured for a slot-fill.
    actorId?: Id<"users">;
  },
): Promise<void> {
  const p = await ctx.db.get(args.placementId);
  if (!p) throw new Error("Placement not found");
  const prevAssignmentId = p.assignmentId;
  const prevActivityId = p.activityId;
  const prevExternalAppId = p.externalAppId;
  const patch: Partial<Doc<"schedulePlacements">> = {};
  if (args.subject !== undefined) {
    const s = args.subject.trim();
    if (!s) throw new Error("A class needs a subject label");
    patch.subject = s;
  }
  if (args.teacherId !== undefined) patch.teacherId = args.teacherId ?? undefined;
  if (args.assignmentId !== undefined) patch.assignmentId = args.assignmentId ?? undefined;
  if (args.activityId !== undefined) patch.activityId = args.activityId ?? undefined;
  if (args.externalAppId !== undefined) patch.externalAppId = args.externalAppId ?? undefined;
  if (args.activityId && args.externalAppId) {
    throw new Error(
      "A class slot can link a curriculum activity or a catalog app, not both.",
    );
  }
  if (args.activityId) {
    const act = await ctx.db.get(args.activityId);
    if (!act) throw new Error("Can't place: this activity was deleted.");
    if (act.archivedAt) {
      throw new Error("Can't place an archived activity — unarchive it first.");
    }
    // Mutually exclusive with an app target — auto-clear the sibling field so
    // the smallest picker (write whichever kind was chosen) never also has to
    // remember to null out the other one.
    patch.externalAppId = undefined;
  }
  if (args.externalAppId) {
    const app = await ctx.db.get(args.externalAppId);
    if (!app) throw new Error("Can't place: that app isn't in the catalog.");
    if (app.archived) {
      throw new Error(`"${app.name}" is archived — unarchive it first.`);
    }
    patch.activityId = undefined;
    patch.assignmentId = undefined;
  }
  // Work waits on no shelf (TRA-582): a class with no day can't carry it.
  if ((args.activityId || args.assignmentId) && (p.weekday == null || p.blockId == null)) {
    throw new ConvexError(WORK_NEEDS_A_DAY);
  }
  if (args.mode !== undefined) patch.mode = args.mode;
  if (args.spanBlocks !== undefined) patch.spanBlocks = args.spanBlocks ?? undefined;
  if (args.note !== undefined) patch.note = args.note?.trim() || undefined;
  // Filling a bare row that sits in a recess, lunch or prep row would put an
  // activity or app there, which placing it directly refuses.
  if (p.blockId && (args.activityId || args.externalAppId || args.assignmentId || args.mode)) {
    const block = await ctx.db.get(p.blockId);
    if (block) assertBlockTakesPlacement(block, { ...p, ...patch });
  }
  // Filling a slot with a concrete activity that has no assignment link would
  // be inert (reconcile can't push it). Auto-ensure the (group × unit)
  // assignment so a slot-fill genuinely assigns — mirror of corePlaceClass.
  const nextActivityId = "activityId" in patch ? patch.activityId : p.activityId;
  const nextAssignmentId =
    "assignmentId" in patch ? patch.assignmentId : p.assignmentId;
  const owner = args.teacherId ?? p.teacherId ?? args.actorId;
  if (nextActivityId && !nextAssignmentId && owner) {
    const unitId = await unitIdForActivity(ctx, nextActivityId);
    if (unitId) {
      patch.assignmentId = await ensureAssignmentForGroupUnit(ctx, {
        groupId: p.groupId,
        unitId,
        teacherId: owner,
      });
    }
  }
  await ctx.db.patch(args.placementId, patch);
  // If the assignment/activity link changed — including a forced clear from
  // setting an app target — drop the old link's planned entry before
  // reconciling the new one (an unlink or relink shouldn't strand it).
  // Checked against the PATCH (not raw args) so the forced-clear case above
  // is caught even though the caller never passed activityId itself.
  const linkChanged =
    ("assignmentId" in patch && patch.assignmentId !== prevAssignmentId) ||
    ("activityId" in patch && patch.activityId !== prevActivityId);
  if (linkChanged && prevAssignmentId && prevActivityId) {
    await unmaterializePlannedActivity(ctx, prevAssignmentId, prevActivityId);
    // Relinking away is this placement's "unschedule" of the old pair — a
    // skill-adapter pair left with no placements must retire here too (e.g.
    // switching a slot from skill A to skill B), or A's live entry keeps
    // serving. Same guard coreRemovePlacement uses; a no-op for curriculum
    // activities.
    await retireSkillAdapterIfOrphaned(ctx, prevAssignmentId, prevActivityId);
  }
  // Same idea for an app target LEFT (cleared, or replaced by an activity) —
  // a pure app→app retarget is deliberately left alone: reconcilePlacementById
  // below finds the still-open push by placement id and retargets it in
  // place, no gap in access. Only leaving the app-target state entirely
  // needs an explicit clear, because the reconcile below then takes the
  // activity/bare-cell branch and never touches that push again.
  const nextExternalAppId =
    "externalAppId" in patch ? patch.externalAppId : p.externalAppId;
  if (prevExternalAppId && !nextExternalAppId) {
    await clearPlacementAppPush(ctx, p._id, "teacher");
  }
  await reconcilePlacementById(ctx, args.placementId, undefined, p);
}

export const updatePlacement = teacherMutation({
  args: {
    placementId: v.id("schedulePlacements"),
    subject: v.optional(v.string()),
    teacherId: v.optional(v.union(v.id("users"), v.null())),
    // Only null, which unlinks a card placed before TRA-582 (the detail
    // drawer's Remove). Linking work is a give (gridGiveActions).
    assignmentId: v.optional(v.null()),
    activityId: v.optional(v.null()),
    externalAppId: v.optional(v.union(v.id("externalApps"), v.null())),
    mode: v.optional(modeValidator),
    spanBlocks: v.optional(v.union(v.number(), v.null())),
    note: v.optional(v.union(v.string(), v.null())),
  },
  handler: async (ctx, args) => {
    const placement = await ctx.db.get(args.placementId);
    if (placement) {
      await requireScheduleScopeAccessible(ctx, ctx.user, placement);
      if (args.teacherId) {
        await requireStaffAccessible(ctx, ctx.user, args.teacherId);
      }
    }
    return coreUpdatePlacement(ctx, { ...args, actorId: ctx.user._id });
  },
});

/**
 * Move a placement to a new (weekday, block) — the drag-drop primitive. Pass
 * BOTH to place it, or NEITHER (both null) to take a CLASS off its day; work
 * never loses its day (WORK_NEEDS_A_DAY, TRA-582). A concrete placement
 * follows the displayed target week; recurring rows stay recurring.
 */
async function coreMovePlacement(
  ctx: MutationCtx,
  args: {
    placementId: Id<"schedulePlacements">;
    weekday: number | null;
    blockId: Id<"scheduleBlocks"> | null;
    weekStartMs?: number;
    mode?: "classFocus" | "homework";
  },
): Promise<void> {
  const p = await ctx.db.get(args.placementId);
  if (!p) throw new Error("Placement not found");
  const placed = args.weekday != null && args.blockId != null;
  const shelved = args.weekday == null && args.blockId == null;
  if (!placed && !shelved) {
    throw new Error("Move needs BOTH weekday and blockId, or NEITHER (to shelf)");
  }
  if (shelved && (p.activityId || p.assignmentId)) {
    throw new ConvexError(WORK_NEEDS_A_DAY);
  }
  if (placed && args.blockId !== p.blockId) {
    const block = await ctx.db.get(args.blockId!);
    if (!block) throw new Error("That block no longer exists.");
    assertBlockTakesPlacement(block, { ...p, mode: args.mode ?? p.mode });
  }
  const timeZone =
    p.weekStartMs != null && args.weekStartMs != null
      ? (await closuresForPeriod(ctx, p.periodId)).timeZone
      : undefined;
  const nextWeekStartMs =
    placed && p.weekStartMs != null && args.weekStartMs != null
      ? currentWeekStartMs(args.weekStartMs, timeZone)
      : p.weekStartMs;
  if (
    placed &&
    await findIdenticalPlacement(ctx, {
      periodId: p.periodId,
      groupId: p.groupId,
      weekday: args.weekday!,
      blockId: args.blockId!,
      weekStartMs: nextWeekStartMs,
      subject: p.subject,
      activityId: p.activityId,
      assignmentId: p.assignmentId,
      externalAppId: p.externalAppId,
      mode: args.mode ?? p.mode,
      teacherId: p.teacherId,
      spanBlocks: p.spanBlocks,
      note: p.note,
      sequenceId: p.sequenceId,
      sequenceIndex: p.sequenceIndex,
      createdFromStrategy: p.createdFromStrategy,
      excludePlacementId: p._id,
    })
  ) {
    throw new Error("An identical class already sits in that cell.");
  }
  await ctx.db.patch(args.placementId, {
    weekday: placed ? args.weekday! : undefined,
    blockId: placed ? args.blockId! : undefined,
    ...(args.mode !== undefined ? { mode: args.mode } : {}),
    // Only a PLACED concrete row adopts the viewed week — a shelve keeps the
    // row's own week (it isn't materialized anyway), and a recurring row stays
    // a pattern.
    ...(placed && p.weekStartMs != null && args.weekStartMs != null
      ? { weekStartMs: nextWeekStartMs }
      : {}),
  });
  // Placed → new slot re-materializes at the new time; → shelf drops the
  // planned entry. reconcile handles both. A CONCRETE row reconciles against
  // the viewed week it now belongs to; a recurring row is a pattern that
  // applies to every week, so its push-layer entry stays timed against the
  // CURRENT week (the default), never a merely-viewed future week.
  await reconcilePlacementById(
    ctx,
    args.placementId,
    p.weekStartMs != null ? nextWeekStartMs : undefined,
    p,
  );
}

export const movePlacement = teacherMutation({
  args: {
    placementId: v.id("schedulePlacements"),
    weekday: v.union(v.number(), v.null()),
    blockId: v.union(v.id("scheduleBlocks"), v.null()),
    weekStartMs: v.optional(v.number()),
    mode: v.optional(modeValidator),
  },
  handler: async (ctx, args) => {
    const placement = await ctx.db.get(args.placementId);
    if (placement) {
      await requireScheduleScopeAccessible(ctx, ctx.user, placement);
    }
    if (args.blockId) {
      const block = await ctx.db.get(args.blockId);
      if (block) {
        await requireScheduleScopeAccessible(ctx, ctx.user, block);
      }
    }
    return coreMovePlacement(ctx, args);
  },
});

/**
 * Teleport: shift a placed class by ±N calendar days, rolling weekends in the
 * direction of travel. A shelved placement can't shift — returns false.
 */
async function coreShiftPlacement(
  ctx: MutationCtx,
  args: { placementId: Id<"schedulePlacements">; deltaDays: number },
): Promise<{ ok: boolean; weekday: number | null }> {
  const p = await ctx.db.get(args.placementId);
  if (!p) throw new Error("Placement not found");
  if (p.weekday == null || p.blockId == null) return { ok: false, weekday: null };
  const total = p.weekday - 1 + args.deltaDays;
  let weekOffset = Math.floor(total / 7);
  let dayInWeek = ((total % 7) + 7) % 7;
  if (dayInWeek === 5 || dayInWeek === 6) {
    if (args.deltaDays >= 0) {
      dayInWeek = 0;
      weekOffset += 1;
    } else {
      dayInWeek = 4;
    }
  }
  const next = dayInWeek + 1;
  const timeZone = (await closuresForPeriod(ctx, p.periodId)).timeZone;
  const nextWeekStartMs =
    p.weekStartMs == null
      ? undefined
      : shiftScheduleWeekStartMs(p.weekStartMs, weekOffset, timeZone);
  if (
    await findIdenticalPlacement(ctx, {
      periodId: p.periodId,
      groupId: p.groupId,
      weekday: next,
      blockId: p.blockId,
      weekStartMs: nextWeekStartMs,
      subject: p.subject,
      activityId: p.activityId,
      assignmentId: p.assignmentId,
      externalAppId: p.externalAppId,
      mode: p.mode,
      teacherId: p.teacherId,
      spanBlocks: p.spanBlocks,
      note: p.note,
      sequenceId: p.sequenceId,
      sequenceIndex: p.sequenceIndex,
      createdFromStrategy: p.createdFromStrategy,
      excludePlacementId: p._id,
    })
  ) {
    throw new Error("An identical class already sits in that cell.");
  }
  await ctx.db.patch(args.placementId, {
    weekday: next,
    ...(p.weekStartMs != null ? { weekStartMs: nextWeekStartMs } : {}),
  });
  await reconcilePlacementById(ctx, args.placementId);
  return { ok: true, weekday: next };
}

export const shiftPlacement = teacherMutation({
  args: { placementId: v.id("schedulePlacements"), deltaDays: v.number() },
  handler: async (ctx, args) => {
    const placement = await ctx.db.get(args.placementId);
    if (placement) {
      await requireScheduleScopeAccessible(ctx, ctx.user, placement);
    }
    return coreShiftPlacement(ctx, args);
  },
});

/**
 * Retire a skill practice pair (lib/skillPractice.ts) an old grid card
 * scheduled, once its LAST placement is gone. The pair exists only as a
 * schedule adapter — no curriculum surface owns it — so unscheduling must
 * actually stop it serving: without this, a live (`setAt != null`) entry keeps
 * the skill on every scholar's plate forever, and the pair leaks. Retirement
 * follows the PR #1255 lifecycle — ARCHIVE, never delete (mirroring
 * `activities.setArchived`: clear schedule state including a live entry,
 * cancel its pending activation, then stamp `archivedAt`) — so any scholar
 * work against the pair stays resolvable. Curriculum (lesson-owned) activities
 * and non-dispatch assignments are never touched: removing their placement
 * keeps today's leave-live-entries-alone doctrine. Returns true iff it
 * retired the pair.
 */
async function retireSkillAdapterIfOrphaned(
  ctx: MutationCtx,
  assignmentId: Id<"assignments">,
  activityId: Id<"activities">,
): Promise<boolean> {
  const act = await ctx.db.get(activityId);
  if (!act || act.archivedAt || !isSkillAdapterActivity(act)) return false;
  const a = await ctx.db.get(assignmentId);
  if (!a || a.kind !== "adHocDispatch") return false;
  // Another placement (a dedupe sibling) still schedules this pair → serving
  // is still intended; leave it alone.
  const stillReferenced = await ctx.db
    .query("schedulePlacements")
    .withIndex("by_activity", (q) => q.eq("activityId", activityId))
    .first();
  if (stillReferenced) return false;
  // Clear the pair's schedule entries — planned AND live — and cancel any
  // pending activation. (Inline rather than removeScheduleStateForActivity:
  // lib/activityCascade imports this module, and the pair's entries only ever
  // live on its own assignment.)
  const entries = await readSchedule(ctx, a);
  for (const entry of entries) {
    if (entry.activityId === activityId && entry.scheduledFnId) {
      await ctx.scheduler.cancel(entry.scheduledFnId);
    }
  }
  if (entries.some((entry) => entry.activityId === activityId)) {
    await writeSchedule(
      ctx,
      a,
      entries.filter((entry) => entry.activityId !== activityId),
      { activityId },
    );
  }

  await ctx.db.patch(activityId, { archivedAt: Date.now() });
  if (!a.archivedAt) {
    await ctx.db.patch(assignmentId, { archivedAt: Date.now() });
  }
  return true;
}

async function coreRemovePlacement(ctx: MutationCtx, placementId: Id<"schedulePlacements">): Promise<boolean> {
  const p = await ctx.db.get(placementId);
  if (!p) return false;
  await coreRemovePlacements(ctx, [p]);
  return true;
}

async function coreRemovePlacements(
  ctx: MutationCtx,
  placements: readonly Doc<"schedulePlacements">[],
  removedPlacements?: Doc<"schedulePlacements">[],
): Promise<void> {
  for (const p of placements) await ctx.db.delete(p._id);
  // Archive against the complete pre-cascade pattern, never an intermediate
  // pattern with only the last row left to delete.
  if (removedPlacements) removedPlacements.push(...placements);
  else await syncClassesForPlacements(ctx, placements);
  for (const p of placements) {
    // App pushes always close on removal; live curriculum work stays intact.
    await settlePlacementAppPush(ctx, p);
    if (p.assignmentId && p.activityId) {
      await unmaterializePlannedActivity(ctx, p.assignmentId, p.activityId);
      const retired = await retireSkillAdapterIfOrphaned(ctx, p.assignmentId, p.activityId);
      if (!retired) {
        // A surviving sibling owns the same planned entry; rebuild it after
        // the whole deletion batch, never against a row about to disappear.
        const sibling = await ctx.db
          .query("schedulePlacements")
          .withIndex("by_activity", (q) => q.eq("activityId", p.activityId))
          .filter((q) => q.eq(q.field("assignmentId"), p.assignmentId))
          .first();
        if (sibling) await reconcilePlacementById(ctx, sibling._id);
      }
    }
  }
}

export const removePlacement = teacherMutation({
  args: { placementId: v.id("schedulePlacements") },
  handler: async (ctx, { placementId }) => {
    const placement = await ctx.db.get(placementId);
    if (placement) {
      await requireScheduleScopeAccessible(ctx, ctx.user, placement);
    }
    return coreRemovePlacement(ctx, placementId);
  },
});

/**
 * Remove all schedule placements that reference a specific activity.
 * Call this whenever an activity is deleted so its cascaded chips are cleaned
 * up immediately rather than left as phantom orphans on the grid.
 *
 * Recurring class STRUCTURE slots (weekday/blockId set, activityId absent) are
 * NOT touched — only placements whose activityId matches the deleted activity.
 *
 */
export async function removeSchedulePlacementsForActivity(
  ctx: MutationCtx,
  activityId: Id<"activities">,
  removedPlacements?: Doc<"schedulePlacements">[],
): Promise<void> {
  const placements = await ctx.db
    .query("schedulePlacements")
    .withIndex("by_activity", (q) => q.eq("activityId", activityId))
    .collect();
  await coreRemovePlacements(ctx, placements, removedPlacements);
}

// ── Bulk reassign ("Lehua is out sick, help me shuffle") ──────────────────

/**
 * Reassign every placement taught by `fromTeacherId` (optionally narrowed to
 * one weekday and/or one group) to `toTeacherId` — or to nobody (`null`,
 * leaving the slots unstaffed so the coverage rail flags them). Returns the
 * affected placement ids so the caller can report + offer an undo.
 */
async function coreReassignTeacher(
  ctx: MutationCtx,
  args: {
    periodId: Id<"reportingPeriods">;
    fromTeacherId: Id<"users">;
    toTeacherId: Id<"users"> | null;
    weekday?: number;
    groupId?: Id<"scholarGroups">;
  },
): Promise<{ count: number; placementIds: Id<"schedulePlacements">[] }> {
  const rows = await ctx.db
    .query("schedulePlacements")
    .withIndex("by_period", (q) => q.eq("periodId", args.periodId))
    .collect();
  const affected: Id<"schedulePlacements">[] = [];
  const changed: Doc<"schedulePlacements">[] = [];
  for (const p of rows) {
    if (p.teacherId !== args.fromTeacherId) continue;
    if (args.weekday != null && p.weekday !== args.weekday) continue;
    if (args.groupId != null && p.groupId !== args.groupId) continue;
    await ctx.db.patch(p._id, { teacherId: args.toTeacherId ?? undefined });
    changed.push(p);
    affected.push(p._id);
  }
  await syncClassesForPlacements(ctx, changed);
  return { count: affected.length, placementIds: affected };
}

export const reassignTeacher = teacherMutation({
  args: {
    periodId: v.id("reportingPeriods"),
    fromTeacherId: v.id("users"),
    toTeacherId: v.union(v.id("users"), v.null()),
    weekday: v.optional(v.number()),
    groupId: v.optional(v.id("scholarGroups")),
  },
  handler: async (ctx, args) => {
    await requireScheduleScopeAccessible(ctx, ctx.user, {
      periodId: args.periodId,
      groupId: args.groupId,
    });
    await requireStaffAccessible(ctx, ctx.user, args.fromTeacherId);
    if (args.toTeacherId) {
      await requireStaffAccessible(ctx, ctx.user, args.toTeacherId);
    }
    return coreReassignTeacher(ctx, args);
  },
});

// ── Flag edits (dismiss) ──────────────────────────────────────────────────

/** Silence a slot/order flag: append its flagId to every listed placement's
 *  dismissedFlags (the acknowledge/× action — not a data move). */
async function coreDismissFlag(
  ctx: MutationCtx,
  args: { placementIds: Id<"schedulePlacements">[]; flagId: string },
): Promise<number> {
  let n = 0;
  for (const id of args.placementIds) {
    const p = await ctx.db.get(id);
    if (!p) continue;
    const flags = new Set(p.dismissedFlags ?? []);
    if (!flags.has(args.flagId)) {
      flags.add(args.flagId);
      await ctx.db.patch(id, { dismissedFlags: [...flags] });
      n++;
    }
  }
  return n;
}

export const dismissFlag = teacherMutation({
  args: { placementIds: v.array(v.id("schedulePlacements")), flagId: v.string() },
  handler: async (ctx, args) => {
    for (const placementId of args.placementIds) {
      const placement = await ctx.db.get(placementId);
      if (
        placement &&
        !(placement.dismissedFlags ?? []).includes(args.flagId)
      ) {
        await requireScheduleScopeAccessible(ctx, ctx.user, placement);
      }
    }
    return coreDismissFlag(ctx, args);
  },
});

// ── Auto-materialize into the live push layer (Layer 3 bridge) ────────────
//
// There is no manual "Publish"/"Stamp week" step. A placed grid cell that links
// an assignment + activity is auto-materialized into that assignment's
// activitySchedule as a PLANNED entry (setAt null) — invisible to scholars — and
// the shipped activation job flips it live at its block start time. So a class
// simply goes live when its time arrives; nothing to remember to push.
//
// Two triggers keep the push layer consistent with the grid:
//   1. Write-time reconcile — every placement edit (place/move/shift/update/
//      remove) reconciles that one placement immediately.
//   2. A short-horizon cron (autoMaterializeTick) that rolls the CURRENT week
//      forward and self-heals, since wall-clock crossing into a new week can't
//      be caught at write time.
// Automated reconciliation targets the current week. A direct move can supply
// the viewed week so its concrete placement and push-layer timing stay aligned.

/** Does this term's span cover `nowMs`? The one rule for whether a term's
 *  placements may materialize now: the cron (`autoMaterializeTick`) sweeps only
 *  such terms, and write-time reconcile of an app placement applies the same
 *  test, so editing an ended (or not-yet-started) term's class can't open its
 *  app this week (TRA-449). */
export function termCoversNow(
  term: Pick<Doc<"reportingPeriods">, "startsAt" | "endsAt"> | null,
  nowMs: number,
): boolean {
  return !!term && nowMs >= term.startsAt && nowMs <= term.endsAt;
}

/** Does this placement belong to `weekStartMs`'s materialization horizon?
 *  Recurring placements (no own weekStartMs) apply every week; a concrete
 *  instance only in its own week. Must be PLACED and link either
 *  assignment+activity (curriculum content) or an externalAppId (the
 *  standing-assignment app target) — either counts as "linked content" for
 *  materialization; a placement with neither is bare structure. */
function placementInWeek(
  p: Doc<"schedulePlacements">,
  weekStartMs: number,
): boolean {
  if (p.weekday == null || p.blockId == null) return false; // shelf
  const hasLinkedContent =
    (p.assignmentId != null && p.activityId != null) || p.externalAppId != null;
  if (!hasLinkedContent) return false; // bare class
  if (p.weekStartMs != null && p.weekStartMs !== weekStartMs) return false;
  return true;
}

// Closure context for a materialization pass: the term institution's no-school
// days + the timezone their day-keys resolve in. Loaded once per pass and
// threaded through so a closed day never gets a live class (schema.ts
// `schoolClosures`).
type ClosureContext = { closures: SchoolClosure[]; timeZone: string };

/** Load the closures that apply to a term (its institution's, plus any
 *  institution-agnostic ones) and the timezone their day-keys resolve in. */
async function closuresForPeriod(
  ctx: QueryCtx,
  periodId: Id<"reportingPeriods">,
  classLinkCache?: ClassLinkReadCache,
): Promise<ClosureContext> {
  const period = await ctx.db.get(periodId);
  const institutionId = period?.institutionId;
  if (classLinkCache) {
    const { closures, timeZone } = await loadClassLinkData(ctx, institutionId, classLinkCache);
    return { closures, timeZone };
  }
  const institution = institutionId ? await ctx.db.get(institutionId) : null;
  const timeZone = effectiveInstitutionTimeZone(institution?.timeZone);
  return { closures: await loadInstitutionClosures(ctx, institutionId), timeZone };
}

/** Closures scoped to an institution, plus any institution-agnostic ones. */
export async function loadInstitutionClosures(
  ctx: Pick<QueryCtx, "db">,
  institutionId: Id<"institutions"> | undefined,
): Promise<SchoolClosure[]> {
  const scoped = institutionId
    ? await ctx.db
        .query("schoolClosures")
        .withIndex("by_institution", (q) => q.eq("institutionId", institutionId))
        .collect()
    : [];
  const global = await ctx.db
    .query("schoolClosures")
    .withIndex("by_institution", (q) => q.eq("institutionId", undefined))
    .collect();
  return [...scoped, ...global];
}

/**
 * The closure covering `atMs` (institution-local) for an institution, or null.
 * Shared read-surface helper: the scholar "Right now" strip and the teacher
 * "today" view both use it to render a "No School — <label>" state.
 */
export async function closureForInstitutionOnDay(
  ctx: QueryCtx,
  institutionId: Id<"institutions"> | undefined,
  atMs: number,
): Promise<{ label: string; kind: SchoolClosureKind } | null> {
  const institution = institutionId ? await ctx.db.get(institutionId) : null;
  const timeZone = effectiveInstitutionTimeZone(institution?.timeZone);
  const dayKey = dayKeyForTimezone(atMs, timeZone);
  const closure = isClosedDay(dayKey, await loadInstitutionClosures(ctx, institutionId));
  return closure ? { label: closure.label, kind: closure.kind } : null;
}

/** True when a placement's (weekStartMs, weekday) lands on a no-school day. */
function placementOnClosedDay(
  p: Doc<"schedulePlacements">,
  weekStartMs: number,
  closureCtx: ClosureContext,
): boolean {
  if (p.weekday == null) return false;
  const dayKey = dayKeyForWeekday(weekStartMs, p.weekday, closureCtx.timeZone);
  return isClosedDay(dayKey, closureCtx.closures) != null;
}

/**
 * Layer 3 is keyed by activity while Layer 2 can contain a recurring shell and
 * concrete week rows for that same activity. Clear the planned entry only when
 * no non-closed placement still owns it in this horizon.
 *
 * An app-target placement's window identity is (this PLACEMENT's id, its
 * occurrence's calendar date) — see `findPushForOccurrence` — never shared
 * with a sibling row the way an activity's (assignmentId, activityId) pair
 * can be, so it never needs the "still placed by another row" check below —
 * clearing every OPEN push THIS placement owns is always correct.
 */
async function unmaterializeIfNoPlacementInWeek(
  ctx: MutationCtx,
  p: Doc<"schedulePlacements">,
  weekStartMs: number,
  closureCtx: ClosureContext,
): Promise<boolean> {
  if (p.externalAppId) {
    return await clearPlacementAppPush(ctx, p._id, "expired");
  }
  if (!p.assignmentId || !p.activityId) return false;
  const stillPlaced = (
    await ctx.db
      .query("schedulePlacements")
      .withIndex("by_activity", (q) => q.eq("activityId", p.activityId))
      .collect()
  ).some(
    (candidate) =>
      candidate.assignmentId === p.assignmentId &&
      placementInWeek(candidate, weekStartMs) &&
      !placementOnClosedDay(candidate, weekStartMs, closureCtx),
  );
  return !stillPlaced
    ? await unmaterializePlannedActivity(ctx, p.assignmentId, p.activityId)
    : false;
}

// ── App-target placements ("standing assignment") ─────────────────────────
//
// The counterpart to applyScheduleActivity/writeSchedule for a
// schedulePlacements row that carries `externalAppId` instead of
// assignmentId+activityId. Materializes into `pushes` rows keyed by WINDOW
// IDENTITY — see the schema comment on `pushes.occurrenceDate` and
// review/app-access-unification-plan.html §robotics.
//
// WINDOW IDENTITY (QB ruling, round 3): one OPEN push per (schedulePlacementId,
// occurrenceDate) — occurrenceDate is the OCCURRENCE'S CALENDAR DATE, in the
// institution's local timezone, NOT startsAt. Rationale: a teacher editing a
// block's start/end mid-week means "this same occurrence, a different time" —
// identity must survive that edit. Consequence, implemented below: retiming
// WITHIN a window (same placement, same calendar date) is legal and
// REQUIRED — an open push follows the block's edited start/end, retargeting
// its timing and rescheduling its lifecycle jobs. Retiming ACROSS windows (a
// different calendar date — next week, or moved to another day) stays
// banned: the old row is cleared and the new occurrence gets a genuinely
// fresh row, never a retimed reuse of an old one.
//
// TEACHER-INTENT SUPREMACY WITH PROVENANCE (QB ruling, round 4): a push's
// (schedulePlacementId, occurrenceDate) pair is a key for LOOKUP, not a
// uniqueness constraint — more than one row can exist for the same
// occurrence over time. Only a row cleared with clearedReason "teacher" is
// TERMINAL for that occurrence: a person's own Wrap-up is never undone by a
// later reconcile pass, however many times it runs, and however many times
// the block's own start/end is subsequently edited (identity is the
// calendar date, not the clock). A row cleared with clearedReason "expired"
// — the SYSTEM's own stale-window sweep, an out-of-horizon settle, or the
// DST/end<=start guards below — is SUPERSEDED, not terminal: reconcile may
// insert a genuinely fresh row for that same occurrence later. This is what
// makes a drag Monday→Tuesday→Monday undo work: moving the placement to
// Tuesday stale-sweeps (system-clears) Monday's row; moving it back must
// find that "expired" clear replaceable, not treat it like a teacher's own
// decision about Monday. Every lookup resolves the LATEST row for a key
// (findPushForOccurrence) and branches on clearedReason, never on clearedAt
// alone. Getting the TERMINALITY rule wrong once meant a teacher's manual
// "Wrap up" got silently undone by the next cron tick; getting the KEY wrong
// a second time (keying on startsAt instead of the calendar date) meant a
// routine block-time edit had the exact same effect; conflating SYSTEM and
// TEACHER clears a third time meant an ordinary drag-and-undo could
// permanently kill an occurrence nobody actually cancelled. Every function
// below is written to make all three impossible by construction.

/** Bounded scan cap for `recentPushesForPlacement` — see its doc comment for
 *  why a constant-cost bound is correct (not merely convenient), and for the
 *  outage-window reasoning behind THIS specific value. */
const RECENT_PUSH_SCAN_LIMIT = 30;

/**
 * The LATEST row for THIS EXACT occurrence, if one exists — open OR
 * cleared. (schedulePlacementId, occurrenceDate) is NOT a unique key: a
 * SYSTEM-cleared row (clearedReason "expired" — a stale-window sweep, an
 * out-of-horizon settle, a DST/end<=start guard) is superseded, not
 * terminal, so reconcile may insert a genuinely fresh row for the same
 * occurrence later the same day (a drag-to-Tuesday-then-back-to-Monday
 * undo is the worked example — see the section header's PROVENANCE note).
 * Only a TEACHER-cleared row is a true terminal answer. Every caller must
 * check BOTH `clearedAt` and `clearedReason` — a hit alone is not license
 * to treat the occurrence as either "still open" or "permanently done".
 * O(1): `.order("desc")` on the compound index returns the newest row
 * first without scanning the placement's history (Convex indexes append
 * `_creationTime` as an implicit final sort key). */
async function findPushForOccurrence(
  ctx: QueryCtx,
  placementId: Id<"schedulePlacements">,
  occurrenceDate: string,
): Promise<Doc<"pushes"> | null> {
  return await ctx.db
    .query("pushes")
    .withIndex("by_schedule_placement_occurrence", (q) =>
      q.eq("schedulePlacementId", placementId).eq("occurrenceDate", occurrenceDate),
    )
    .order("desc")
    .first();
}

/**
 * The placement's most recent pushes, newest occurrence first — BOUNDED to
 * `RECENT_PUSH_SCAN_LIMIT` rows rather than the placement's entire permanent
 * history. A push is never deleted (only soft-cleared), so a long-lived
 * recurring placement (Robotics' Block E has run for a school year by now)
 * accumulates one row per occurrence forever; `autoMaterializeTick` calls
 * into this for every app placement on every 15-minute tick, so an unbounded
 * `.collect()` here is exactly the "unbounded growth toward transaction
 * limits" failure mode. The only thing any caller actually needs from this
 * is "is there a stale OPEN push from a recent prior occurrence whose clear
 * job didn't fire" — which in steady state is 0 or 1 rows back, so the
 * bound only has to be generous, not tight.
 *
 * OUTAGE-WINDOW REASONING for the value 30: `isPushShowing` now hides a focus
 * after its institution day unless its explicit `endsAt` remains in the future,
 * but this scan still owns lifecycle cleanup — stamping `clearedAt`, cancelling
 * stale jobs, and keeping the permanent event history honest. If the scheduler
 * (or this whole reconcile path) were down for a PROLONGED outage, unswept
 * occurrences would pile up one per meeting day; 30 rows
 * covers several weeks for any real class cadence (~15 weeks for a 2x/week
 * placement like Robotics' Block E, ~6 weeks even for a 5x/week daily one) —
 * comfortably past any outage this system is expected to recover from without
 * a human noticing first. Still a constant-cost bound: the read stays O(1)
 * regardless of how many YEARS of history exist, only the (generous, fixed)
 * worst-case outage width changed. Ordered by occurrenceDate descending — a
 * day-key string ("YYYY-MM-DD"), which sorts lexicographically the same as
 * chronologically, so index order IS chronological order.
 */
async function recentPushesForPlacement(
  ctx: QueryCtx,
  placementId: Id<"schedulePlacements">,
): Promise<Doc<"pushes">[]> {
  return await ctx.db
    .query("pushes")
    .withIndex("by_schedule_placement_occurrence", (q) =>
      q.eq("schedulePlacementId", placementId),
    )
    .order("desc")
    .take(RECENT_PUSH_SCAN_LIMIT);
}

/** Every OPEN (not cleared) push among a placement's `RECENT_PUSH_SCAN_LIMIT`
 *  most recent pushes. In steady state there is at most one; more than one
 *  is a transient inconsistency — typically a prior occurrence's clear job
 *  hasn't fired yet as a new occurrence starts materializing — that
 *  reconcileAppPlacement cleans up before creating a row for the new one. */
async function openPushesForPlacement(
  ctx: QueryCtx,
  placementId: Id<"schedulePlacements">,
): Promise<Doc<"pushes">[]> {
  return (await recentPushesForPlacement(ctx, placementId)).filter(
    (p) => p.clearedAt === undefined,
  );
}

/** The single open push a placement currently owns, for a DISPLAY-ONLY read
 *  (coreGrid's linkState) that doesn't need window-boundary correctness —
 *  there is at most one in steady state, and a stray extra is cosmetic here
 *  (reconcileAppPlacement is what actually enforces the invariant on write). */
async function openAppPushForDisplay(
  ctx: QueryCtx,
  placementId: Id<"schedulePlacements">,
): Promise<Doc<"pushes"> | null> {
  return (await openPushesForPlacement(ctx, placementId))[0] ?? null;
}

/** Soft-clear every OPEN push a placement currently owns (normally at most
 *  one, bounded — see openPushesForPlacement). Used whenever the placement
 *  should have NO live occurrence right now: closed day, out of horizon,
 *  its app archived/deleted, or the placement shelved/deleted. Mirrors
 *  clearMirrorsForActivity's shape (lib/scheduleStore.ts): stamped, never
 *  deleted, and cancels the pending job rather than leaving it to fire
 *  against an already-closed row. */
async function clearPlacementAppPush(
  ctx: MutationCtx,
  placementId: Id<"schedulePlacements">,
  clearedReason: "teacher" | "expired",
): Promise<boolean> {
  const open = await openPushesForPlacement(ctx, placementId);
  for (const push of open) {
    if (push.scheduledFnId) await ctx.scheduler.cancel(push.scheduledFnId);
    await ctx.db.patch(push._id, {
      clearedAt: Date.now(),
      clearedReason,
      scheduledFnId: undefined,
    });
    await schedulePushProjectionRefresh(ctx, push._id);
  }
  return open.length > 0;
}

/**
 * Settle whatever app push a schedulePlacements row about to be PERMANENTLY
 * REMOVED might own. Exported so every deletion path — not just the ones in
 * this module — settles the push before the row disappears: a row can
 * vanish via the ordinary teacher UI (removePlacement, a sequence-collision
 * merge) or via one-off admin/ops tooling (adminTermTools, group deletion,
 * the institution cascade-delete) that bypasses corePlaceClass entirely.
 * Call this with the row AS IT EXISTED just before the delete — only `_id`
 * and `externalAppId` are read.
 *
 * A merge/collision delete's SURVIVOR keeps its own materialization
 * untouched (its push is keyed to ITS OWN placement id, never the row being
 * deleted's), so this only ever needs to clear the row being deleted's own
 * push. clearedReason is always "teacher": every caller here is an
 * explicit, deliberate removal, never a schedule-driven expiry.
 */
export async function settlePlacementAppPush(
  ctx: MutationCtx,
  p: Pick<Doc<"schedulePlacements">, "_id" | "externalAppId">,
): Promise<void> {
  if (p.externalAppId) {
    await clearPlacementAppPush(ctx, p._id, "teacher");
  }
}

/**
 * Resolve the institution a placement's push should be stamped with, from its
 * group — the same "legacy unstamped ⇒ primary school" convention
 * `institutionForAssignment` (lib/scheduleStore.ts) uses for an assignment's
 * roster. Returns null (and the caller skips, loudly) when even that fails,
 * which cannot happen on a real deployment but must never throw inside a
 * cron reconciliation pass.
 */
async function institutionIdForPlacementGroup(
  ctx: MutationCtx,
  group: Doc<"scholarGroups">,
): Promise<Id<"institutions"> | null> {
  return group.institutionId ?? (await primaryInstitutionId(ctx));
}

/**
 * Bring THIS placement's app push in line with the block's local window for
 * `occurrenceDate` (startsAt/endsAt already resolved by the caller from the
 * block's CURRENT start/end local times). Governed by WINDOW IDENTITY +
 * TEACHER-INTENT SUPREMACY — see the section header:
 *
 *   1. A window that has ALREADY fully closed by the time this runs is
 *      never (re)materialized (the `endsAt <= now` guard) — the equivalent
 *      of applyScheduleActivity leaving a past start un-activated, adapted
 *      for a target with no manual "push now" to fall back on. This also
 *      covers a teacher SHORTENING a live block's end into the past:
 *      access follows the block, so the push closes immediately.
 *   2. If the LATEST row for THIS EXACT occurrence already exists and is
 *      CLEARED, its PROVENANCE decides what happens next — a TEACHER's own
 *      "Wrap up" is TERMINAL (never undone by a later reconcile pass,
 *      however many times it runs, or however many times the BLOCK's own
 *      start/end is subsequently edited — identity is the calendar date,
 *      not the clock); a SYSTEM clear ("expired" — a stale-window sweep, an
 *      out-of-horizon settle, a DST/end<=start guard) is SUPERSEDED, not
 *      terminal, so a fresh row may be inserted for this same occurrence
 *      below (this is what makes a drag-then-undo back to the same day
 *      work correctly).
 *   3. Any OTHER open push this placement owns belongs to a DIFFERENT
 *      occurrence (typically a prior day's, whose clear job hasn't fired
 *      yet) — a push belongs to exactly one occurrence, so it is cleared
 *      here rather than ever being retimed across the boundary into this
 *      one.
 *   4. Only then is the row for THIS occurrence created, or — if it's
 *      already open — updated in place. Retiming WITHIN the occurrence
 *      (a block start/end edit) is legal and required: startsAt/endsAt on
 *      an already-open row are refreshed unconditionally, its lifecycle
 *      jobs (activation or auto-clear) are cancelled and rescheduled to
 *      match, and `setAt` is never re-derived away from live on a pure
 *      retime — an in-progress occurrence stays in progress.
 */
async function reconcileAppPlacement(
  ctx: MutationCtx,
  p: Doc<"schedulePlacements">,
  occurrenceDate: string,
  startsAt: number,
  endsAt: number | undefined,
  timeZone: string,
  classLinkCache: ClassLinkReadCache,
): Promise<void> {
  if (endsAt == null || endsAt <= startsAt) {
    // Defense in depth: reconcilePlacement's caller already screens both of
    // these (an unresolvable DST end time, and a midnight-spanning
    // end<=start block), so this should be unreachable — but "silently do
    // nothing" is exactly the failure mode that stranded stale access
    // before, so if it's ever reached anyway, settle rather than no-op.
    await clearPlacementAppPush(ctx, p._id, "expired");
    return;
  }
  const group = await ctx.db.get(p.groupId);
  if (!group) return;
  const now = Date.now();
  if (endsAt <= now) {
    await clearPlacementAppPush(ctx, p._id, "expired");
    return;
  }

  // Window identity: does THIS exact occurrence already have a row? (The
  // LATEST one, if more than one — see findPushForOccurrence's doc comment.)
  const latestForOccurrence = await findPushForOccurrence(ctx, p._id, occurrenceDate);
  if (latestForOccurrence !== null && latestForOccurrence.clearedAt !== undefined) {
    if (latestForOccurrence.clearedReason === "teacher") {
      // TRUE terminal — teacher-intent supremacy: never resurrected by a
      // later write-time edit (including a block-time edit — see the
      // section header) or cron pass, however many times either runs.
      return;
    }
    // SYSTEM-cleared (reason "expired") is SUPERSEDED, not terminal: a
    // stale-window sweep, an out-of-horizon settle, or a DST/end<=start
    // guard clearing this row is not a person's decision about this
    // occurrence — it's the mechanism catching up. Fall through and treat
    // it exactly like "no row yet": a fresh row may be inserted for this
    // SAME occurrence below. Concretely, this is what makes a drag Monday→
    // Tuesday→Monday undo work — the stale sweep (below) cleared Monday's
    // row as "expired" when the placement first moved to Tuesday, and
    // moving it back must not find that "expired" clear and refuse to
    // recreate it the way a genuine teacher Wrap-up would.
  }
  const windowPush =
    latestForOccurrence !== null && latestForOccurrence.clearedAt === undefined
      ? latestForOccurrence
      : null;

  // No OPEN row for this occurrence yet (never existed, or superseded above)
  // — any OTHER open push belongs to a stale, different occurrence (never
  // this one, by construction: window identity is scoped to THIS
  // occurrenceDate). Clear it before creating this occurrence's row, rather
  // than ever retiming it across the boundary. This is also what settles a
  // drag-and-undo's now-stale Tuesday row once Monday reconciles again.
  if (windowPush === null) {
    for (const stale of await openPushesForPlacement(ctx, p._id)) {
      if (stale.scheduledFnId) await ctx.scheduler.cancel(stale.scheduledFnId);
      await ctx.db.patch(stale._id, {
        clearedAt: Date.now(),
        clearedReason: "expired",
        scheduledFnId: undefined,
      });
    }
  }

  const wasLive = windowPush?.setAt != null;
  const goesLiveNow = wasLive || startsAt <= now;
  // Reschedule whenever anything about THIS occurrence's timing/liveness
  // actually changed — including a pure retime (start and/or end edited)
  // that leaves liveness itself unchanged, since a stale job still pointed
  // at the OLD instant would otherwise never get corrected. Re-running this
  // every 15 minutes against a genuinely unchanged, already-live push must
  // still not pile up a fresh autoClearPush job on every cron tick, which is
  // exactly what comparing both startsAt and endsAt (not just endsAt) buys.
  const timingChanged =
    windowPush === null ||
    windowPush.startsAt !== startsAt ||
    explicitFocusEnd(windowPush) !== endsAt;
  const needsReschedule = timingChanged || (!wasLive && goesLiveNow);
  const institutionId = windowPush?.institutionId ?? await institutionIdForPlacementGroup(ctx, group);
  if (!institutionId) {
    console.warn(
      `[placementAppPush] skipped placement ${p._id}: no resolvable institution.`,
    );
    return;
  }
  // The kind alone; the end lives in `endsAt` + `afterEnd` (TRA-580).
  const timing = { kind: "focus" as const };
  const setAt = wasLive ? windowPush?.setAt : goesLiveNow ? now : undefined;
  const audience = { kind: "group" as const, groupId: p.groupId };
  const classFields = !windowPush ||
    classLinkInputsChanged(windowPush, { startsAt, setAt, audience })
    ? await classFieldsForPush(ctx, {
      institutionId,
      audience,
      // Deliberate: the class meeting starts at the bell, not at the early
      // push's start (which can fall in the preceding class).
      at: startsAt + APP_PLACEMENT_LEAD_MS,
      timeZone,
      timingKind: "focus",
    }, classLinkCache) : {};
  const endFields = endFieldsForPush("focus", endsAt, setAt, startsAt, timeZone);
  // The write boundary every push writer shares: an app give must end
  // (TRA-336). A placement's end is its block's end plus grace, so this never
  // refuses a real class; it pins the invariant at the second app writer.
  assertPushAllowed({
    target: { kind: "app", externalAppId: p.externalAppId! },
    timing,
    blocking: false,
    endsAt: endFields.endsAt,
  });

  let pushId: Id<"pushes">;
  if (windowPush !== null) {
    pushId = windowPush._id;
    if (needsReschedule && windowPush.scheduledFnId) {
      await ctx.scheduler.cancel(windowPush.scheduledFnId);
    }
    await ctx.db.patch(windowPush._id, {
      target: { kind: "app", externalAppId: p.externalAppId! },
      audience,
      timing,
      ...endFields,
      ...classFields,
      startsAt,
      // Never demote an already-live push back to planned on a re-time —
      // "access follows the block," never a fresh start stamp.
      setAt,
    });
  } else {
    pushId = await ctx.db.insert("pushes", {
      institutionId,
      target: { kind: "app", externalAppId: p.externalAppId! },
      audience,
      timing,
      ...endFields,
      ...classFields,
      blocking: false,
      setAt,
      startsAt,
      // A label only, never a permission: a class with no teacher still
      // opens its app, credited to whoever created its group.
      pushedBy: p.teacherId ?? group.teacherId,
      schedulePlacementId: p._id,
      occurrenceDate,
    });
  }

  if (!wasLive && goesLiveNow) {
    await schedulePushProjectionRefresh(ctx, pushId);
  }
  if (needsReschedule) {
    await scheduleAppPushLifecycle(ctx, p._id, pushId, startsAt, endsAt, goesLiveNow);
  }
}

/**
 * Schedule the ONE next job a placement's push needs: a live push only needs
 * its auto-clear (`pushes.autoClearPush`, reused verbatim); a still-planned
 * one needs its activation (`activatePlacementAppPush`) — activation itself
 * schedules the clear once it fires. Either way the scheduled job's id is
 * stored on `scheduledFnId` so a later re-time or an early clear
 * (`clearPlacementAppPush`) can cancel it precisely — never two dangling jobs
 * racing to act on the same row. The activation job is scheduled with the
 * EXACT pushId it owns (not just the placementId) so it can precisely clear
 * its own scheduledFnId stamp before delegating — see
 * activatePlacementAppPush's doc comment for why that precision matters.
 */
async function scheduleAppPushLifecycle(
  ctx: MutationCtx,
  placementId: Id<"schedulePlacements">,
  pushId: Id<"pushes">,
  startsAt: number,
  endsAt: number,
  goesLiveNow: boolean,
): Promise<void> {
  const now = Date.now();
  if (goesLiveNow) {
    const clearFnId =
      endsAt > now
        ? await ctx.scheduler.runAt(endsAt, internal.pushes.autoClearPush, { pushId })
        : undefined;
    await ctx.db.patch(pushId, { scheduledFnId: clearFnId });
    return;
  }
  const activationFnId = await ctx.scheduler.runAt(
    startsAt,
    internal.masterSchedule.activatePlacementAppPush,
    { placementId, pushId },
  );
  await ctx.db.patch(pushId, { scheduledFnId: activationFnId });
}

/**
 * The scheduled "wake up at startsAt" job for a planned app push. Re-checks
 * from scratch rather than trusting the state at schedule time — the same
 * re-check-before-acting discipline deviceLock's rearmAtMidnight/rearmTimed
 * use (re-verify the row is still in the expected state, not just that a
 * job fired on schedule).
 *
 * Deliberately does NOT duplicate reconcileAppPlacement's own target/
 * audience/timing/liveness logic — that duplication is exactly what let a
 * stale job flip a since-shelved/moved/retargeted placement's OLD push live
 * with no re-verification at all. Instead this just re-runs the placement's
 * normal reconcile pass, which recomputes its CURRENT window from scratch
 * (it may have moved to a different slot, been shelved, been archived, lost
 * its app, or already been settled by a write-time edit since this job was
 * scheduled) and flips the matching occurrence's push live via the SAME
 * `startsAt <= now` test every other reconcile pass uses. This job's only
 * distinct value is firing exactly on time instead of waiting for the next
 * 15-minute cron tick — it is never itself the authority on what should
 * happen.
 *
 * SELF-CANCEL GUARD: `pushId` is the row THIS invocation was scheduled to
 * activate — `scheduleAppPushLifecycle` stamped this job's own id onto
 * `pushId.scheduledFnId` at schedule time. If we delegated to reconcile
 * without clearing that stamp first, reconcile's own "cancel the pending
 * job before rescheduling" step (needsReschedule, in reconcileAppPlacement)
 * would call `ctx.scheduler.cancel()` on THIS invocation's OWN id — Convex
 * treats cancelling a currently-EXECUTING scheduled function as an atomic
 * cancel-or-fail, not a safe no-op, and an invocation cannot legally cancel
 * itself mid-flight. So this clears the stamp FIRST: by the time reconcile
 * runs, `scheduledFnId` reads as already-empty for this row, and reconcile's
 * cancel-before-reschedule step has nothing of ours left to touch — it can
 * only ever cancel a genuinely still-pending OTHER job.
 */
export const activatePlacementAppPush = internalMutation({
  args: { placementId: v.id("schedulePlacements"), pushId: v.id("pushes") },
  handler: async (ctx, { placementId, pushId }) => {
    const push = await ctx.db.get(pushId);
    if (push?.scheduledFnId) {
      await ctx.db.patch(pushId, { scheduledFnId: undefined });
    }
    await reconcilePlacementById(ctx, placementId);
  },
});

/** Prune before the batch sync, so neither archived history nor subsequent
 * gives see a partially deleted class pattern. Preserve reconciliation's
 * existing scope: missing assignments self-heal only in a usable live slot. */
async function pruneInvalidPlacement(
  ctx: MutationCtx,
  p: Doc<"schedulePlacements">,
  weekStartMs: number,
  closureCtx: ClosureContext,
): Promise<boolean> {
  if (p.activityId) {
    const act = await ctx.db.get(p.activityId);
    if (!act || act.archivedAt) {
      if (p.assignmentId) {
        await unmaterializePlannedActivity(ctx, p.assignmentId, p.activityId);
      }
      await ctx.db.delete(p._id);
      return true;
    }
    if (await appActivityHasNothingToOpen(ctx, act)) return false;
  }
  if (p.externalAppId) {
    const app = await ctx.db.get(p.externalAppId);
    if (!app || app.archived) {
      await clearPlacementAppPush(ctx, p._id, "expired");
      await ctx.db.delete(p._id);
      return true;
    }
    return false;
  }
  if (placementInWeek(p, weekStartMs) && !placementOnClosedDay(p, weekStartMs, closureCtx)) {
    const block = await ctx.db.get(p.blockId!);
    if (block && placementStartMs(
      weekStartMs, p.weekday!, block.startLocal, closureCtx.timeZone,
    ) != null) {
      const assignment = await ctx.db.get(p.assignmentId!);
      if (!assignment || assignment.archivedAt) {
        await ctx.db.delete(p._id);
        return true;
      }
    }
  }
  return false;
}

/**
 * Materialize a surviving placement, or settle an out-of-horizon/closed-day
 * window. The caller prunes invalid targets and syncs classes for the whole
 * batch first. Live curriculum entries are never retracted by a grid edit.
 */
async function reconcilePlacement(
  ctx: MutationCtx,
  p: Doc<"schedulePlacements">,
  weekStartMs: number,
  closureCtx: ClosureContext,
  classLinkCache: ClassLinkReadCache,
): Promise<void> {
  if (p.activityId) {
    const act = await ctx.db.get(p.activityId);
    if (act && await appActivityHasNothingToOpen(ctx, act)) return;
  }
  if (p.externalAppId) {
    // A term that doesn't cover today never opens its app — the same rule the
    // cron sweeps by, so a write-time edit can't schedule what the cron
    // wouldn't (TRA-449). Settle anything already open.
    if (!termCoversNow(await ctx.db.get(p.periodId), Date.now())) {
      await clearPlacementAppPush(ctx, p._id, "expired");
      return;
    }
  }
  if (
    !placementInWeek(p, weekStartMs) ||
    placementOnClosedDay(p, weekStartMs, closureCtx)
  ) {
    await unmaterializeIfNoPlacementInWeek(ctx, p, weekStartMs, closureCtx);
    return;
  }
  const block = await ctx.db.get(p.blockId!);
  if (!block) return;
  const startsAt = placementStartMs(
    weekStartMs,
    p.weekday!,
    block.startLocal,
    closureCtx.timeZone,
  );
  if (startsAt == null) {
    // A nonexistent local start time (the DST spring-forward gap — no real
    // school day starts there, but a block's local HH:MM is read fresh
    // every reconcile, so a placement that was PREVIOUSLY fine can land
    // here on the one day a year this applies) must never silently strand
    // an existing push open. Settle rather than exit quietly — the
    // activity branch below has no equivalent app-push state to strand, so
    // this is scoped to the app target.
    if (p.externalAppId) await clearPlacementAppPush(ctx, p._id, "expired");
    return;
  }
  if (p.externalAppId) {
    // An app target has no assignment layer underneath it — it's a group
    // grant for the block's window, always a closing focus (never homework,
    // never the dated-future-override race below, which exists only to
    // protect the ONE shared activitySchedule entry an assignment+activity
    // pair can have; an app placement's push is keyed to THIS placement id,
    // so a future dated override simply materializes its own separate push).
    //
    // Reuses placementStartMs (not a direct scheduleWeekdayTimeMs call) for
    // the SAME reason it's used for startsAt above: it already resolves a
    // nonexistent local time to null instead of throwing, so a bad END time
    // can't crash reconcile — including the CRON's per-placement loop,
    // where an uncaught throw here would previously have taken down
    // materialization for every OTHER placement in the same tick.
    const blockEndsAt = placementStartMs(
      weekStartMs,
      p.weekday!,
      block.endLocal,
      closureCtx.timeZone,
    );
    const endsAt =
      blockEndsAt == null ? undefined : blockEndsAt + APP_PLACEMENT_GRACE_MS;
    // The app window opens BEFORE the bell (see APP_PLACEMENT_LEAD_MS).
    // Scoped to this branch on purpose: `startsAt` is shared with the activity
    // branch below, where go-live is the bell exactly — an activity appearing
    // early would be work landing on a scholar's plate mid-previous-class,
    // which is a different question from a tile being ready.
    const appStartsAt = startsAt - APP_PLACEMENT_LEAD_MS;
    // Window identity (QB ruling): the OCCURRENCE's calendar date, not
    // startsAt — survives a same-day block start/end edit so a teacher's
    // clear stays terminal through it. Same day-key helper the homework
    // due-date branch below already uses for exactly this weekday+week+tz.
    const occurrenceDate = scheduleWeekdayDayKey(weekStartMs, p.weekday!, closureCtx.timeZone);
    if (endsAt == null || endsAt <= appStartsAt) {
      // Unresolvable window: a DST-nonexistent end time, or (defensively,
      // for data written before the write-boundary validation existed) a
      // midnight-spanning end<=start block. No real school block spans
      // midnight (QB ruling) — never materialize a negative/zero-duration
      // window; settle whatever was open instead.
      await clearPlacementAppPush(ctx, p._id, "expired");
      return;
    }
    await reconcileAppPlacement(
      ctx, p, occurrenceDate, appStartsAt, endsAt, closureCtx.timeZone, classLinkCache,
    );
    return;
  }
  const a = (await ctx.db.get(p.assignmentId!))!;
  // A dated future override can be authored while this week's recurring class
  // is already planned. Do not let the one-entry assignment layer retime that
  // current plan to the future override; the cron will materialize the concrete
  // row when its own week becomes current.
  const currentWeek = currentWeekStartMs(Date.now(), closureCtx.timeZone);
  if (p.weekStartMs != null && p.weekStartMs !== currentWeek) {
    const currentPlacementExists = (
      await ctx.db
        .query("schedulePlacements")
        .withIndex("by_activity", (q) => q.eq("activityId", p.activityId!))
        .collect()
    ).some(
      (candidate) =>
        candidate._id !== p._id &&
        candidate.assignmentId === p.assignmentId &&
        placementInWeek(candidate, currentWeek),
    );
    if (currentPlacementExists) return;
  }
  const mode = p.mode ?? "classFocus";
  // Homework is due at end of its day; class time ends at the block's end.
  const endMins = parseHHMM(block.endLocal);
  const dayEnd =
    dayStartForDayKey(
      shiftDayKey(
        scheduleWeekdayDayKey(weekStartMs, p.weekday!, closureCtx.timeZone),
        1,
      ),
      closureCtx.timeZone,
    ) - 1;
  const endsAt =
    endMins != null
      ? scheduleWeekdayTimeMs(
          weekStartMs,
          p.weekday!,
          endMins,
          closureCtx.timeZone,
        )
      : undefined;
  await applyScheduleActivity(
    ctx,
    a,
    {
      activityId: p.activityId!,
      mode,
      startsAt,
      endsAt: mode === "classFocus" ? endsAt : undefined,
      // A class cell runs for its block: "in that class", never open until a
      // later day (a placement has no such finish; TRA-726).
      openUntilKind: mode === "classFocus" ? false : undefined,
      dueAt: mode === "homework" ? dayEnd : undefined,
    },
    true,
    classLinkCache,
  );
}

/** Reconcile a placement by id after an edit (place/move/shift/update). Skips
 *  cleanly if the row is gone. Exported for the rich-cohort seed inserter,
 *  which writes schedulePlacements rows directly (bypassing corePlaceClass)
 *  and needs the same write-time materialization a teacher's edit gets, so a
 *  seeded app-target placement (LEGO SPIKE / Robotics Block E) is demoable
 *  immediately rather than waiting on the 15-minute cron backstop. */
export async function reconcilePlacementById(
  ctx: MutationCtx,
  placementId: Id<"schedulePlacements">,
  weekStartMs?: number,
  previousPlacement?: Doc<"schedulePlacements">,
): Promise<void> {
  await reconcilePlacementsById(
    ctx, [{ id: placementId, weekStartMs }],
    previousPlacement ? [previousPlacement] : [],
  );
}

/** Finish plan edits before syncing, so each group's new pattern is read once
 * and every materialized give sees the complete pattern, not a partial edit. */
export async function reconcilePlacementsById(
  ctx: MutationCtx,
  entries: { id: Id<"schedulePlacements">; weekStartMs?: number }[],
  previous: Doc<"schedulePlacements">[] = [],
): Promise<void> {
  const rows = await Promise.all(entries.map(async (entry) => ({
    ...entry, placement: await ctx.db.get(entry.id),
  })));
  const classLinkCache: ClassLinkReadCache = new Map();
  const surviving: {
    placement: Doc<"schedulePlacements">; weekStartMs: number; closureCtx: ClosureContext;
  }[] = [];
  for (const { placement: p, weekStartMs } of rows) {
    if (!p) continue;
    const closureCtx = await closuresForPeriod(ctx, p.periodId, classLinkCache);
    const week = weekStartMs ?? currentWeekStartMs(Date.now(), closureCtx.timeZone);
    if (!(await pruneInvalidPlacement(ctx, p, week, closureCtx))) {
      surviving.push({ placement: p, weekStartMs: week, closureCtx });
    }
  }
  await syncClassesForPlacements(ctx, [
    ...previous, ...rows.flatMap((row) => row.placement ? [row.placement] : []),
  ]);
  for (const { placement, weekStartMs, closureCtx } of surviving) {
    await reconcilePlacement(ctx, placement, weekStartMs, closureCtx, classLinkCache);
  }
}

/** Reconcile every placement in a term against `weekStartMs`. The cron path —
 *  no owner check (the system materializes the whole timetable). */
async function coreReconcileWeek(
  ctx: MutationCtx,
  periodId: Id<"reportingPeriods">,
  weekStartMs: number,
  providedClosureCtx?: ClosureContext,
  classLinkCache: ClassLinkReadCache = new Map(),
): Promise<{ materialized: number; cleared: number }> {
  const closureCtx =
    providedClosureCtx ?? (await closuresForPeriod(ctx, periodId, classLinkCache));
  const rows = await ctx.db
    .query("schedulePlacements")
    .withIndex("by_period", (q) => q.eq("periodId", periodId))
    .collect();
  let materialized = 0;
  let cleared = 0;
  const surviving: Doc<"schedulePlacements">[] = [];
  const removed: Doc<"schedulePlacements">[] = [];
  for (const p of rows) {
    try {
      if (placementInWeek(p, weekStartMs) &&
          await pruneInvalidPlacement(ctx, p, weekStartMs, closureCtx)) {
        removed.push(p);
        if (placementOnClosedDay(p, weekStartMs, closureCtx)) cleared++;
        else materialized++;
      } else {
        surviving.push(p);
      }
    } catch (error) {
      console.error(
        `[coreReconcileWeek] skipped placement ${p._id}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  await syncClassesForPlacements(ctx, removed);
  if (removed.length > 0) await invalidateClassLinkClasses(classLinkCache);
  for (const p of surviving) {
    // The cron sweeps EVERY placement in the term in one mutation — a
    // throw from any single row's reconcile (a still-unforeseen edge case,
    // not just the DST/end<=start ones already screened upstream) would
    // otherwise roll back the WHOLE transaction, silently un-materializing
    // every OTHER placement's already-correct state for the entire tick
    // ("one bad block causes a fleet-wide materializer outage"). Log and
    // move on instead — the write-time path (reconcilePlacementById, called
    // directly from a teacher's own edit) deliberately does NOT get this
    // same swallow: a teacher editing a placement should see a real error
    // if their own edit produced something reconcile can't resolve, not a
    // silently-ignored no-op.
    try {
      if (placementInWeek(p, weekStartMs)) {
        // reconcilePlacement clears (not materializes) a closed-day placement —
        // count it honestly so cron logs reflect what happened.
        const closed = placementOnClosedDay(p, weekStartMs, closureCtx);
        await reconcilePlacement(ctx, p, weekStartMs, closureCtx, classLinkCache);
        if (closed) cleared++;
        else materialized++;
      } else if (p.assignmentId && p.activityId) {
        const did = await unmaterializeIfNoPlacementInWeek(
          ctx,
          p,
          weekStartMs,
          closureCtx,
        );
        if (did) cleared++;
      } else if (p.externalAppId) {
        // A DATED (weekStartMs-pinned) app placement whose own week is no
        // longer `weekStartMs` falls here — `placementInWeek` only reads TRUE
        // for a recurring row (no weekStartMs) or a matching dated one, so a
        // one-off app placement from a past week never re-enters the `if`
        // branch above once its week has passed. Without this, a prior
        // occurrence's push with a delayed/failed autoClearPush job otherwise
        // remains an uncleared event even after `isPushShowing` hides it by
        // institution day / `endsAt`. Settle it the same way
        // removal/shelving/closed-day does.
        const did = await clearPlacementAppPush(ctx, p._id, "expired");
        if (did) cleared++;
      }
    } catch (error) {
      console.error(
        `[coreReconcileWeek] skipped placement ${p._id}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return { materialized, cleared };
}

/**
 * The short-horizon auto-materializer. Runs on a cron: for every term that
 * covers today, reconcile the CURRENT week into the live push layer. Idempotent
 * and safe to run often — it's the safety net that catches the wall-clock
 * rolling into a new week (write-time reconcile can't).
 */
export const autoMaterializeTick = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const terms = await ctx.db.query("reportingPeriods").collect();
    const classLinkCache: ClassLinkReadCache = new Map();
    let materialized = 0;
    let cleared = 0;
    let scanned = 0;
    for (const t of terms) {
      // Only terms whose span covers today — skip archived/future terms.
      if (!termCoversNow(t, now)) continue;
      scanned++;
      const closureCtx = await closuresForPeriod(ctx, t._id, classLinkCache);
      const termWeekStartMs = currentWeekStartMs(now, closureCtx.timeZone);
      const r = await coreReconcileWeek(
        ctx,
        t._id,
        termWeekStartMs,
        closureCtx,
        classLinkCache,
      );
      materialized += r.materialized;
      cleared += r.cleared;
    }
    return {
      terms: scanned,
      materialized,
      cleared,
      // Retained for callers that inspect the legacy single-school result.
      weekStartMs: currentWeekStartMs(now),
    };
  },
});

// ── Internal aide wrappers (verified callerUserId, no ctx.user) ───────────

async function requireTeacherCaller(ctx: QueryCtx, callerUserId: Id<"users">): Promise<Doc<"users">> {
  const u = await ctx.db.get(callerUserId);
  if (!u || !isTeacherRole(u.role as never)) {
    throw new Error("Master-schedule tools are teacher/admin only");
  }
  return u;
}

export const aideCreateBlock = internalMutation({
  args: {
    callerUserId: v.id("users"),
    periodId: v.id("reportingPeriods"),
    groupId: v.optional(v.id("scholarGroups")),
    label: v.string(),
    startLocal: v.string(),
    endLocal: v.string(),
    weekdays: v.optional(v.array(v.number())),
    staffNeed: v.optional(v.number()),
    kind: v.optional(blockKindValidator),
  },
  handler: async (ctx, { callerUserId, ...args }) => {
    const caller = await requireTeacherCaller(ctx, callerUserId);
    await requireScheduleScopeAccessible(ctx, caller, {
      periodId: args.periodId,
    });
    if (args.groupId) {
      await requireGroupScholarAccess(ctx, caller, args.groupId);
    }
    await requireBellScheduleAdmin(ctx, caller, args.periodId);
    return coreCreateBlock(ctx, args);
  },
});

export const aidePlaceClass = internalMutation({
  args: {
    callerUserId: v.id("users"),
    periodId: v.id("reportingPeriods"),
    groupId: v.id("scholarGroups"),
    subject: v.string(),
    teacherId: v.optional(v.id("users")),
    // Work for the class goes through gridGiveActions.aideGiveToClass: it is a
    // give to the class that day, never a card (TRA-582).
    // A catalog app placed on a block grants a managed app for that block
    // (live for the block + APP_PLACEMENT_GRACE_MS, then cleared): the
    // 2026-09-15 Stop Motion incident was a standing `appAudiences` grant with
    // no clock. A whole day for a group is enable_app_for_group's one-day
    // grant, not one placement per block (2026-10-30).
    externalAppId: v.optional(v.id("externalApps")),
    mode: v.optional(modeValidator),
    weekday: v.optional(v.number()),
    blockId: v.optional(v.id("scheduleBlocks")),
    note: v.optional(v.string()),
    weekStartMs: v.optional(v.number()),
  },
  handler: async (ctx, { callerUserId, ...args }) => {
    const caller = await requireTeacherCaller(ctx, callerUserId);
    await requireTermWriteScope(ctx, caller, {
      periodId: args.periodId,
      groupId: args.groupId,
      blockIds: [args.blockId],
    });
    if (args.teacherId) {
      await requireStaffAccessible(ctx, caller, args.teacherId);
    }
    return corePlaceClass(ctx, args);
  },
});

// TRA-246: guard placementId/blockId ownership with the shared follow-up primitive.
export const aideMovePlacement = internalMutation({
  args: {
    callerUserId: v.id("users"),
    placementId: v.id("schedulePlacements"),
    weekday: v.union(v.number(), v.null()),
    blockId: v.union(v.id("scheduleBlocks"), v.null()),
    // Retarget a CONCRETE (dated) row to another week; recurring rows ignore it
    // (they're patterns). Without this the bot could never move a dated cell
    // across weeks — the gap that stranded a cascade on the wrong week.
    weekStartMs: v.optional(v.number()),
  },
  handler: async (ctx, { callerUserId, ...args }) => {
    const caller = await requireTeacherCaller(ctx, callerUserId);
    const placement = await ctx.db.get(args.placementId);
    if (placement) {
      await requireScheduleScopeAccessible(ctx, caller, placement);
    }
    if (args.blockId) {
      const block = await ctx.db.get(args.blockId);
      if (block) {
        await requireScheduleScopeAccessible(ctx, caller, block);
      }
    }
    return coreMovePlacement(ctx, args);
  },
});

// TRA-246: guard placementId ownership with the shared follow-up primitive.
export const aideShiftPlacement = internalMutation({
  args: {
    callerUserId: v.id("users"),
    placementId: v.id("schedulePlacements"),
    deltaDays: v.number(),
  },
  handler: async (ctx, { callerUserId, ...args }) => {
    const caller = await requireTeacherCaller(ctx, callerUserId);
    const placement = await ctx.db.get(args.placementId);
    if (placement) {
      await requireScheduleScopeAccessible(ctx, caller, placement);
    }
    return coreShiftPlacement(ctx, args);
  },
});

export const aideUpdatePlacement = internalMutation({
  args: {
    callerUserId: v.id("users"),
    placementId: v.id("schedulePlacements"),
    subject: v.optional(v.string()),
    teacherId: v.optional(v.union(v.id("users"), v.null())),
    // Null clears the app target, so attaching one is not a one-way door.
    externalAppId: v.optional(v.union(v.id("externalApps"), v.null())),
    mode: v.optional(modeValidator),
    note: v.optional(v.union(v.string(), v.null())),
  },
  handler: async (ctx, { callerUserId, ...args }) => {
    const caller = await requireTeacherCaller(ctx, callerUserId);
    const placement = await ctx.db.get(args.placementId);
    if (placement) {
      await requireScheduleScopeAccessible(ctx, caller, placement);
    }
    if (args.teacherId) {
      await requireStaffAccessible(ctx, caller, args.teacherId);
    }
    return coreUpdatePlacement(ctx, args);
  },
});

// TRA-246: guard placementId ownership with the shared follow-up primitive.
export const aideRemovePlacement = internalMutation({
  args: { callerUserId: v.id("users"), placementId: v.id("schedulePlacements") },
  handler: async (ctx, { callerUserId, placementId }) => {
    const caller = await requireTeacherCaller(ctx, callerUserId);
    const placement = await ctx.db.get(placementId);
    if (placement) {
      await requireScheduleScopeAccessible(ctx, caller, placement);
    }
    return coreRemovePlacement(ctx, placementId);
  },
});

export const aideReassignTeacher = internalMutation({
  args: {
    callerUserId: v.id("users"),
    periodId: v.id("reportingPeriods"),
    fromTeacherId: v.id("users"),
    toTeacherId: v.union(v.id("users"), v.null()),
    weekday: v.optional(v.number()),
    groupId: v.optional(v.id("scholarGroups")),
  },
  handler: async (ctx, { callerUserId, ...args }) => {
    const caller = await requireTeacherCaller(ctx, callerUserId);
    await requireScheduleScopeAccessible(ctx, caller, {
      periodId: args.periodId,
    });
    await requireStaffAccessible(ctx, caller, args.fromTeacherId);
    if (args.toTeacherId) {
      await requireStaffAccessible(ctx, caller, args.toTeacherId);
    }
    if (args.groupId) {
      await requireGroupScholarAccess(ctx, caller, args.groupId);
    }
    return coreReassignTeacher(ctx, args);
  },
});

// TRA-246: guard placementIds ownership with the shared follow-up primitive.
export const aideDismissFlag = internalMutation({
  args: {
    callerUserId: v.id("users"),
    placementIds: v.array(v.id("schedulePlacements")),
    flagId: v.string(),
  },
  handler: async (ctx, { callerUserId, ...args }) => {
    const caller = await requireTeacherCaller(ctx, callerUserId);
    for (const placementId of args.placementIds) {
      const placement = await ctx.db.get(placementId);
      if (
        placement &&
        !(placement.dismissedFlags ?? []).includes(args.flagId)
      ) {
        await requireScheduleScopeAccessible(ctx, caller, placement);
      }
    }
    return coreDismissFlag(ctx, args);
  },
});

/** List the terms (reporting periods) so the bot can pick a periodId. */
export const aideListTerms = internalQuery({
  args: { callerUserId: v.id("users") },
  handler: async (ctx, { callerUserId }) => {
    const caller = await requireTeacherCaller(ctx, callerUserId);
    // Only terms the caller could open with get_master_schedule: the same
    // school rule as requireScheduleScopeAccessible, where an unstamped legacy
    // term belongs to the primary school.
    const scope = await curatableInstitutionIds(ctx, caller);
    const primaryId = await primaryInstitutionId(ctx);
    const rows = (
      await ctx.db.query("reportingPeriods").order("desc").collect()
    ).filter((p) => {
      const institutionId = p.institutionId ?? primaryId;
      if (!institutionId) return false;
      return scope === "all" || scope.has(institutionId);
    });
    return rows.map((p) => ({
      _id: p._id,
      label: p.label,
      status: p.status,
      startsAt: p.startsAt,
      endsAt: p.endsAt,
    }));
  },
});

// TRA-246: guard blockId ownership with the shared follow-up primitive.
export const aideUpdateBlock = internalMutation({
  args: {
    callerUserId: v.id("users"),
    blockId: v.id("scheduleBlocks"),
    label: v.optional(v.string()),
    startLocal: v.optional(v.string()),
    endLocal: v.optional(v.string()),
    weekdays: v.optional(v.array(v.number())),
    order: v.optional(v.number()),
    staffNeed: v.optional(v.number()),
    kind: v.optional(blockKindValidator),
  },
  handler: async (ctx, { callerUserId, ...args }) => {
    const caller = await requireTeacherCaller(ctx, callerUserId);
    const block = await ctx.db.get(args.blockId);
    if (block) {
      await requireScheduleScopeAccessible(ctx, caller, block);
      await requireBellScheduleAdmin(ctx, caller, block.periodId);
    }
    return coreUpdateBlock(ctx, args);
  },
});

// TRA-246: guard blockId ownership with the shared follow-up primitive.
export const aideRemoveBlock = internalMutation({
  args: { callerUserId: v.id("users"), blockId: v.id("scheduleBlocks") },
  handler: async (ctx, { callerUserId, blockId }) => {
    const caller = await requireTeacherCaller(ctx, callerUserId);
    const block = await ctx.db.get(blockId);
    if (block) {
      await requireScheduleScopeAccessible(ctx, caller, block);
      await requireBellScheduleAdmin(ctx, caller, block.periodId);
    }
    return coreRemoveBlock(ctx, blockId);
  },
});
