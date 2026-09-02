// Pure meeting-slot generator for the class-anchored unit flow (Phase 2 of
// review/unit-flow-into-class-plan.html §5). Shared by the Convex cascade /
// re-flow (convex/masterSchedule.ts) and the web palette preview
// (components/MasterSchedule/MasterScheduleView.tsx) so the layout can never
// drift between "what the preview shows" and "what the backend writes" — the
// copy-paste drift the plan calls out. No Convex or DOM imports (only the pure
// closure helpers), so it's trivially unit-testable and importable from both
// runtimes, exactly like shared/schoolClosures.ts.
//
// The model: a class is a recurring set of weekly meetings (weekday × block).
// A unit's activities flow onto those meetings ONE PER MEETING (the only rhythm
// — resolved 2026-07-23, no pacing parameter), chronologically, starting at the
// clicked slot, skipping no-school days. The clicked slot's class supplies the
// meeting pattern; the rows the generator returns are the ground truth (there is
// no hidden recurrence rule).

import {
  dayKeyForWeekday,
  isClosedDay,
  type SchoolClosure,
} from "./schoolClosures";

const DAY_MS = 86_400_000;

/** One weekly meeting of a class: which weekday + which block it meets in.
 *  `blockId` is a plain string (the caller stringifies its branded id). */
export type MeetingPatternSlot = { weekday: number; blockId: string };

/** A concrete landing slot for one activity: the week (Monday 00:00 school-local
 *  epoch-ms), the weekday (1–5), and the block. */
export type MeetingSlot = {
  weekStartMs: number;
  weekday: number;
  blockId: string;
};

/** The minimal placement shape `deriveClassMeetingPattern` reads. Structurally a
 *  subset of both the Convex row and the grid query's enriched placement. */
export type RecurringPlacementInput = {
  weekStartMs?: number | null;
  weekday?: number | null;
  blockId?: string | null;
  groupId: string;
  subject: string;
  mode?: string | null;
};

/** Chronological order key within a week: (weekday, block order). */
function chronoKey(
  weekday: number,
  blockId: string,
  blockOrder: Map<string, number>,
): number {
  return weekday * 100_000 + (blockOrder.get(blockId) ?? 0);
}

/**
 * Derive a class's weekly meeting pattern from the schedule's recurring slots:
 * the placed, non-homework, recurring (no own week) rows for the SAME class —
 * matched by `(groupId, subject)` on a trimmed subject compare (so
 * "Humanities " and "Humanities" are one class; open decision #5). Returns the
 * unique `(weekday, blockId)` meetings, sorted chronologically within a week.
 */
export function deriveClassMeetingPattern(args: {
  placements: RecurringPlacementInput[];
  groupId: string;
  subject: string;
  blockOrder: Map<string, number>;
}): MeetingPatternSlot[] {
  const wantSubject = args.subject.trim().toLowerCase();
  const seen = new Set<string>();
  const pattern: MeetingPatternSlot[] = [];
  for (const p of args.placements) {
    if (p.weekStartMs != null) continue; // concrete instance, not the shell
    if (p.weekday == null || p.blockId == null) continue; // shelf
    if (p.mode === "homework") continue; // due rail, not a class meeting
    if (String(p.groupId) !== String(args.groupId)) continue;
    if (p.subject.trim().toLowerCase() !== wantSubject) continue;
    const key = `${p.weekday}|${p.blockId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    pattern.push({ weekday: p.weekday, blockId: p.blockId });
  }
  pattern.sort(
    (a, b) =>
      chronoKey(a.weekday, a.blockId, args.blockOrder) -
      chronoKey(b.weekday, b.blockId, args.blockOrder),
  );
  return pattern;
}

/** The effective pattern: the class's meetings, or — when a class has no
 *  recurring structure at the target — a single weekly meeting at the clicked
 *  slot (so an unstructured drop becomes "one chip per week", the fallback the
 *  plan specifies). */
function effectivePattern(
  pattern: MeetingPatternSlot[],
  startWeekday: number,
  startBlockId: string,
): MeetingPatternSlot[] {
  if (pattern.length > 0) return pattern;
  return [{ weekday: startWeekday, blockId: startBlockId }];
}

/** Index of the first meeting at or after the clicked slot, and whether it rolls
 *  into the next week. Uses chronological order so a Wednesday anchor on a
 *  Mon/Wed/Fri class starts at Wednesday, not Monday. */
function startPosition(
  pattern: MeetingPatternSlot[],
  startWeekday: number,
  startBlockId: string,
  blockOrder: Map<string, number>,
): { idx: number; weekOffset: number } {
  const startKey = chronoKey(startWeekday, startBlockId, blockOrder);
  for (let i = 0; i < pattern.length; i++) {
    const m = pattern[i];
    if (chronoKey(m.weekday, m.blockId, blockOrder) >= startKey) {
      return { idx: i, weekOffset: 0 };
    }
  }
  return { idx: 0, weekOffset: 1 };
}

/**
 * Lay `count` activities onto a class's meetings, one per meeting, chronological,
 * starting at (or at the first meeting after) the clicked slot, skipping
 * no-school days. Returns exactly `count` slots (it keeps advancing weeks so a
 * closed meeting is skipped without consuming an activity — chips never land on
 * a closed day). Pure + deterministic; the backend and the palette preview both
 * call it so they can't disagree.
 */
export function generateMeetingSlots(args: {
  pattern: MeetingPatternSlot[];
  blockOrder: Map<string, number>;
  startWeekStartMs: number;
  startWeekday: number;
  startBlockId: string;
  count: number;
  closures: readonly SchoolClosure[];
  timeZone: string;
}): MeetingSlot[] {
  const { blockOrder, startWeekStartMs, startWeekday, startBlockId, count } = args;
  if (count <= 0) return [];
  const pattern = effectivePattern(args.pattern, startWeekday, startBlockId);
  const start = startPosition(pattern, startWeekday, startBlockId, blockOrder);

  const slots: MeetingSlot[] = [];
  let idx = start.idx;
  let weekOffset = start.weekOffset;
  // Termination guard: closures are finite ranges, but never loop forever if a
  // pathological input closes every meeting. Generous bound (weeks of headroom).
  let guard = 0;
  const guardMax = (count + 1) * pattern.length + 10_000;
  while (slots.length < count && guard++ < guardMax) {
    const m = pattern[idx];
    const weekStartMs = startWeekStartMs + weekOffset * 7 * DAY_MS;
    const dayKey = dayKeyForWeekday(weekStartMs, m.weekday, args.timeZone);
    if (!isClosedDay(dayKey, args.closures)) {
      slots.push({ weekStartMs, weekday: m.weekday, blockId: m.blockId });
    }
    idx++;
    if (idx >= pattern.length) {
      idx = 0;
      weekOffset++;
    }
  }
  return slots;
}

/**
 * The meeting immediately AFTER a given slot in the pattern — the re-flow anchor
 * (§7 "push the rest"): the missed meeting's tail restarts here so every chip
 * shifts exactly one meeting later. Uses a strict `>` so an exact-match current
 * slot advances past itself. Falls back to the single-weekly-meeting pattern
 * when the class has no recurring structure.
 */
export function nextMeetingAfter(
  slot: { weekStartMs: number; weekday: number; blockId: string },
  pattern: MeetingPatternSlot[],
  blockOrder: Map<string, number>,
): MeetingSlot {
  const eff = effectivePattern(pattern, slot.weekday, slot.blockId);
  const slotKey = chronoKey(slot.weekday, slot.blockId, blockOrder);
  for (const m of eff) {
    if (chronoKey(m.weekday, m.blockId, blockOrder) > slotKey) {
      return { weekStartMs: slot.weekStartMs, weekday: m.weekday, blockId: m.blockId };
    }
  }
  // Nothing later this week → the first meeting of next week.
  return {
    weekStartMs: slot.weekStartMs + 7 * DAY_MS,
    weekday: eff[0].weekday,
    blockId: eff[0].blockId,
  };
}

/** The first pattern meeting on a DAY strictly after (`weekStartMs`, `weekday`) —
 *  day-granularity, so same-day meetings are excluded (you can't retroactively
 *  hold a meeting earlier today). Rolls into next week when none remain. */
function firstMeetingAfterDay(
  weekStartMs: number,
  weekday: number,
  pattern: MeetingPatternSlot[],
  blockOrder: Map<string, number>,
): MeetingSlot {
  const eff = effectivePattern(pattern, weekday, pattern[0]?.blockId ?? "");
  const sorted = [...eff].sort(
    (a, b) =>
      chronoKey(a.weekday, a.blockId, blockOrder) -
      chronoKey(b.weekday, b.blockId, blockOrder),
  );
  for (const m of sorted) {
    if (m.weekday > weekday) {
      return { weekStartMs, weekday: m.weekday, blockId: m.blockId };
    }
  }
  return { weekStartMs: weekStartMs + 7 * DAY_MS, weekday: sorted[0].weekday, blockId: sorted[0].blockId };
}

/** Chronologically later of two slots (by week, then within-week order). */
function laterSlot(
  a: MeetingSlot,
  b: MeetingSlot,
  blockOrder: Map<string, number>,
): MeetingSlot {
  if (a.weekStartMs !== b.weekStartMs) return a.weekStartMs > b.weekStartMs ? a : b;
  return chronoKey(a.weekday, a.blockId, blockOrder) >=
    chronoKey(b.weekday, b.blockId, blockOrder)
    ? a
    : b;
}

/**
 * The re-flow anchor, CLAMPED FORWARD so a behind class catches up in ONE click
 * (§7 fix). Returns the first pattern meeting strictly after BOTH the missed
 * chip's `slot` AND the current day (`nowWeekStartMs` + `nowWeekday`). Without the
 * clamp, a tail whose stored slots are weeks in the past would re-flow into
 * still-past weeks whose planned entries the current-week-only materializer just
 * drops — so the class never actually catches up.
 *
 * A same-week miss is unaffected: the missed slot is already at/after today, so
 * the clamp is a no-op and the anchor equals `nextMeetingAfter(slot)` exactly.
 * Closure-agnostic — the generator skips closed days from this anchor.
 */
export function clampSlotForward(
  slot: { weekStartMs: number; weekday: number; blockId: string },
  pattern: MeetingPatternSlot[],
  blockOrder: Map<string, number>,
  nowWeekStartMs: number,
  nowWeekday: number,
): MeetingSlot {
  const eff = effectivePattern(pattern, slot.weekday, slot.blockId);
  const afterMissed = nextMeetingAfter(slot, eff, blockOrder);
  const afterNow = firstMeetingAfterDay(nowWeekStartMs, nowWeekday, eff, blockOrder);
  return laterSlot(afterMissed, afterNow, blockOrder);
}
