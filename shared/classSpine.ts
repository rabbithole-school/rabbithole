// Pure read-side helpers for the class drawer (the queue made visible —
// review/unit-flow-into-class-plan.html §7 "the class drawer"). The twin of
// shared/meetingSlots.ts: where that GENERATES a class's meeting slots (the
// write side — cascade / re-flow), this ASSEMBLES the already-written concrete
// chips of a (groupId, subject) class into one chronological spine (past /
// upcoming) and finds the class's first free upcoming meeting (the "flow another
// unit" anchor). No Convex or DOM imports so it's trivially unit-testable and
// importable from either runtime, exactly like meetingSlots.ts.
//
// Everything here derives from the grid query's existing placements (coreGrid
// returns ALL of a term's rows across weeks — the single-week filter is a client
// concern), so the drawer needs NO new query: it's the second consumer of the
// implicit (groupId, subject) entity.

import {
  clampSlotForward,
  generateMeetingSlots,
  type MeetingPatternSlot,
  type MeetingSlot,
} from "./meetingSlots";
import type { SchoolClosure } from "./schoolClosures";

/** One concrete queued meeting of a class: a materialized/planned activity chip
 *  with its resolved dates. `dayMs` is the meeting's date (school-local midnight
 *  of the day); `endMs` is the absolute end-of-meeting instant used to split
 *  past vs upcoming (a meeting counts as past only once its block has ended). */
export type SpineChip = {
  placementId: string;
  weekStartMs: number;
  weekday: number;
  blockId: string;
  dayMs: number;
  endMs: number;
  sequenceIndex: number | null;
  sequenceRank?: number | null;
  sequenceLength: number | null;
  activityTitle: string | null;
  unitTitle: string | null;
  linkState: "live" | "planned" | "none";
};

export type ClassSpine = {
  /** The most-recent `pastCap` past meetings, chronological ascending. */
  past: SpineChip[];
  /** How many past meetings there are in all (so the drawer can say "last 5 of N"). */
  pastTotal: number;
  /** Every upcoming meeting, chronological ascending — the queue projection. */
  upcoming: SpineChip[];
  /** The date the whole queue lands its last activity ("finishes …"), or null. */
  finishesMs: number | null;
};

/**
 * Split a class's concrete chips into the drawer's chronological spine: past
 * (capped to the most recent `pastCap`) + upcoming, plus the "finishes" date of
 * the whole queue. A chip is PAST only once its meeting has ended (`endMs`), so
 * the meeting a class is in right now reads as upcoming until its block closes.
 */
export function assembleClassSpine(args: {
  chips: SpineChip[];
  nowMs: number;
  pastCap: number;
}): ClassSpine {
  const sorted = [...args.chips].sort((a, b) => a.endMs - b.endMs);
  const past = sorted.filter((c) => c.endMs < args.nowMs);
  const upcoming = sorted.filter((c) => c.endMs >= args.nowMs);
  const finishesMs = sorted.length > 0 ? sorted[sorted.length - 1].dayMs : null;
  const cap = Math.max(0, args.pastCap);
  return {
    past: past.slice(Math.max(0, past.length - cap)),
    pastTotal: past.length,
    upcoming,
    finishesMs,
  };
}

type Slot = { weekStartMs: number; weekday: number; blockId: string };
const DAY_MS = 86_400_000;

/** Chronologically later of two slots (by week, then within-week order). */
function laterOf(a: Slot, b: Slot, blockOrder: Map<string, number>): Slot {
  if (a.weekStartMs !== b.weekStartMs) return a.weekStartMs > b.weekStartMs ? a : b;
  const key = (s: Slot) => s.weekday * 100_000 + (blockOrder.get(s.blockId) ?? 0);
  return key(a) >= key(b) ? a : b;
}

/**
 * The class's first FREE upcoming meeting — the anchor for "flow another unit"
 * (§7): the first pattern meeting strictly after BOTH the last queued chip AND
 * today, so a new unit lands end-to-end after the current queue rather than
 * colliding with it, and a class whose whole queue is in the past still catches
 * up to a real upcoming meeting (reusing meetingSlots.clampSlotForward — the same
 * forward-clamp the re-flow anchor uses). With nothing queued, it's simply the
 * first meeting after today. The clamped anchor is then routed through the SAME
 * generateMeetingSlots the cascade uses (count 1, with closures) so it can never
 * land on a no-school day the cascade would skip — otherwise the grid would jump
 * to a closed day and the flowed unit's first activity would start off-screen.
 * Null when the class has no recurring meeting pattern (no structure to lay a
 * unit onto).
 */
export function firstFreeMeeting(args: {
  queuedSlots: Slot[];
  pattern: MeetingPatternSlot[];
  blockOrder: Map<string, number>;
  nowWeekStartMs: number;
  nowWeekday: number;
  closures: readonly SchoolClosure[];
  timeZone: string;
}): MeetingSlot | null {
  if (args.pattern.length === 0) return null;
  const anchor =
    args.queuedSlots.length > 0
      ? args.queuedSlots.reduce((max, s) => laterOf(max, s, args.blockOrder))
      : // Nothing queued → a synthetic anchor a FULL WEEK before now, so the
        // forward clamp always falls through to the first meeting strictly after
        // today. (A once-weekly pattern rolls the synthetic anchor forward a whole
        // week; anchoring only one day back would overshoot to next week and skip
        // this week's still-upcoming meeting.)
        {
          weekStartMs: args.nowWeekStartMs - 7 * DAY_MS,
          weekday: args.pattern[0].weekday,
          blockId: args.pattern[0].blockId,
        };
  const clamped = clampSlotForward(
    anchor,
    args.pattern,
    args.blockOrder,
    args.nowWeekStartMs,
    args.nowWeekday,
  );
  // Roll the clamped anchor off any closed day via the cascade's own generator
  // (the write side and this read side then agree on where the unit starts).
  const [open] = generateMeetingSlots({
    pattern: args.pattern,
    blockOrder: args.blockOrder,
    startWeekStartMs: clamped.weekStartMs,
    startWeekday: clamped.weekday,
    startBlockId: clamped.blockId,
    count: 1,
    closures: args.closures,
    timeZone: args.timeZone,
  });
  return open ?? null;
}
