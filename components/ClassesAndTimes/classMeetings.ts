// Pure helpers for School › Classes & times: which grid rows are a group's
// class meetings, the one-meeting-per-day rule the page enforces, and bell
// ordering for new or re-timed blocks.
//
// "Weekly meeting" is the canonical definition in shared/meetingSlots.ts
// (`isRecurringClassMeeting`, the same predicate `deriveClassMeetingPattern`
// uses), and a class is keyed by `classSubjectKey`, so this page and the
// schedule's class resolver can never disagree about what counts. A meeting
// that carries a linked activity or app is still the class's meeting and is
// listed (and editable) like a bare one.

import { isRecurringClassMeeting } from "@/shared/meetingSlots";
import { classSubjectKey } from "@/convex/lib/classResolver";

export type MeetingBlock = {
  _id: string;
  groupId: string | null;
  label: string;
  startLocal: string;
  endLocal: string;
  weekdays?: number[] | null;
  order: number;
  kind: string;
};

export type MeetingPlacement = {
  _id: string;
  groupId: string;
  weekday: number | null;
  blockId: string | null;
  subject: string;
  teacherId: string | null;
  teacherName: string | null;
  assignmentId: string | null;
  activityId: string | null;
  activityTitle: string | null;
  externalAppId: string | null;
  externalAppName: string | null;
  mode: string | null;
  weekStartMs: number | null;
  /** "live" once the linked activity or app has been released to scholars. */
  linkState?: string | null;
  /** A scheduleSkill adapter slot (grid.placements[].isSkillSlot). */
  isSkillSlot?: boolean;
  /** Who owns the linked assignment (its Run page). */
  assignmentTeacherId?: string | null;
};

export type ClassMeeting = MeetingPlacement & { weekday: number; blockId: string };

/** The bell blocks a group can meet in: class/recess/lunch/prep rows shared by
 *  the term or owned by this group. The virtual homework row is not a time. */
export function blocksForGroup<B extends MeetingBlock>(blocks: B[], groupId: string): B[] {
  return blocks
    .filter((b) => b.kind !== "homework" && (b.groupId == null || b.groupId === groupId))
    .sort((a, b) => a.order - b.order || a.startLocal.localeCompare(b.startLocal));
}

/** Whether a block runs on a weekday. A block with no weekday list runs every
 *  school day. */
export function blockRunsOn(block: Pick<MeetingBlock, "weekdays">, weekday: number): boolean {
  return !block.weekdays || block.weekdays.length === 0 || block.weekdays.includes(weekday);
}

function inBellOrder(blocks: MeetingBlock[]) {
  const blockById = new Map(blocks.map((b) => [b._id, b]));
  return (a: ClassMeeting, b: ClassMeeting) => {
    if (a.weekday !== b.weekday) return a.weekday - b.weekday;
    const ba = blockById.get(a.blockId);
    const bb = blockById.get(b.blockId);
    return (
      (ba?.order ?? 0) - (bb?.order ?? 0) ||
      (ba?.startLocal ?? "").localeCompare(bb?.startLocal ?? "")
    );
  };
}

/** A group's weekly class meetings (every recurring placed row, linked or
 *  bare), ordered by weekday then bell order. */
export function weeklyClassMeetings<P extends MeetingPlacement>(
  placements: P[],
  blocks: MeetingBlock[],
  groupId: string,
): (P & ClassMeeting)[] {
  return placements
    .filter((p): p is P & ClassMeeting => p.groupId === groupId && isRecurringClassMeeting(p))
    .sort(inBellOrder(blocks));
}

function isBare(p: MeetingPlacement): boolean {
  return !p.assignmentId && !p.activityId && !p.externalAppId;
}

/** A group's classes with no day yet, e.g. the classes a removed block left
 *  behind (an app class included). Work never waits without a day (TRA-582). */
export function shelfClasses<P extends MeetingPlacement>(placements: P[], groupId: string): P[] {
  return placements
    .filter(
      (p) =>
        p.groupId === groupId &&
        (p.weekday == null || p.blockId == null) &&
        p.mode !== "homework" &&
        !p.assignmentId &&
        !p.activityId,
    )
    .sort((a, b) => a.subject.localeCompare(b.subject));
}

/** A group's one-week bare classes (a placed row stamped to one week), grouped
 *  by week in date order. */
export function oneWeekClasses<P extends MeetingPlacement>(
  placements: P[],
  blocks: MeetingBlock[],
  groupId: string,
): { weekStartMs: number; classes: (P & ClassMeeting)[] }[] {
  const byWeek = new Map<number, (P & ClassMeeting)[]>();
  for (const p of placements) {
    if (
      p.groupId !== groupId ||
      p.weekStartMs == null ||
      p.weekday == null ||
      p.blockId == null ||
      p.mode === "homework" ||
      !isBare(p)
    ) {
      continue;
    }
    const rows = byWeek.get(p.weekStartMs) ?? [];
    rows.push(p as P & ClassMeeting);
    byWeek.set(p.weekStartMs, rows);
  }
  return [...byWeek.entries()]
    .sort(([a], [b]) => a - b)
    .map(([weekStartMs, classes]) => ({ weekStartMs, classes: classes.sort(inBellOrder(blocks)) }));
}

/** What a meeting carries besides the class itself, for a quiet note. */
export function linkedLabel(p: MeetingPlacement): string | null {
  if (p.externalAppId) return p.externalAppName ? `App: ${p.externalAppName}` : "An app";
  if (p.activityId || p.assignmentId) {
    return p.activityTitle ? `Activity: ${p.activityTitle}` : "An activity";
  }
  return null;
}

/**
 * A class meets at most once a day (TRA-582): a give names its class and day,
 * and the class's meeting that day supplies the times, so two meetings of one
 * class on one day would make that ambiguous. Checks ALL of the group's weekly
 * meetings, linked or bare. Returns the conflicting meeting when `candidate`
 * would break the rule, else null. `excludeId` is the meeting being edited,
 * which never conflicts with itself.
 */
export function sameDayMeeting<M extends ClassMeeting>(
  meetings: M[],
  candidate: { subject: string; weekday: number },
  excludeId?: string,
): M | null {
  const key = classSubjectKey(candidate.subject);
  return (
    meetings.find(
      (m) =>
        m._id !== excludeId &&
        m.weekday === candidate.weekday &&
        classSubjectKey(m.subject) === key,
    ) ?? null
  );
}

/**
 * The `order` that slots a block into the bell schedule by start time. Blocks
 * render by `order`, and a new block would otherwise land after every existing
 * one (the backend defaults to the block count). Returns a value between the
 * neighbours, so no other block has to be renumbered. `excludeId` is the block
 * being re-timed.
 */
export function orderForStart(
  blocks: Pick<MeetingBlock, "_id" | "startLocal" | "order" | "kind">[],
  startLocal: string,
  excludeId?: string,
): number {
  const bell = blocks
    .filter((b) => b._id !== excludeId && b.kind !== "homework")
    .sort((a, b) => a.order - b.order);
  const before = bell.filter((b) => b.startLocal <= startLocal);
  const after = bell.filter((b) => b.startLocal > startLocal);
  const lo = before.length > 0 ? Math.max(...before.map((b) => b.order)) : null;
  const hi = after.length > 0 ? Math.min(...after.map((b) => b.order)) : null;
  if (lo == null && hi == null) return 0;
  if (lo == null) return hi! - 1;
  if (hi == null || hi <= lo) return lo + 1;
  return (lo + hi) / 2;
}

/**
 * What removing a meeting does to scholars, so the confirm copy can say it
 * (masterSchedule.coreRemovePlacement is the source of truth):
 *   app          an app slot: its push is cleared, so access ends now, even
 *                mid-session.
 *   skillLast    the last slot of a skill adapter: the pair is retired and its
 *                live schedule cleared, so the skill leaves scholars' plates.
 *   skillShared  a skill slot with a sibling slot: the skill keeps serving
 *                through the other slot.
 *   liveActivity curriculum work already released: it keeps running; only its
 *                Run page wraps it up.
 *   planned      linked work not yet released: it comes off the schedule.
 *   bare         nothing linked.
 */
export type RemovalEffect =
  | "app"
  | "skillLast"
  | "skillShared"
  | "liveActivity"
  | "planned"
  | "bare";

export function removalEffect(
  meeting: MeetingPlacement,
  allPlacements: Pick<MeetingPlacement, "_id" | "activityId">[],
): RemovalEffect {
  if (meeting.externalAppId) return "app";
  if (!meeting.activityId && !meeting.assignmentId) return "bare";
  if (meeting.isSkillSlot && meeting.activityId) {
    const sibling = allPlacements.some(
      (p) => p._id !== meeting._id && p.activityId === meeting.activityId,
    );
    return sibling ? "skillShared" : "skillLast";
  }
  return meeting.linkState === "live" ? "liveActivity" : "planned";
}

/**
 * What a field's draft becomes when a save it started settles (success or
 * failure): cleared only if the draft is still exactly what was submitted. If
 * the person kept typing while the save was in flight, their newer draft
 * stays; it is theirs to save on the next blur. Use as a functional setState:
 * `setDraft((current) => settleDraft(current, submitted))`.
 */
export function settleDraft(current: string | null, submitted: string): string | null {
  return current === submitted ? null : current;
}

