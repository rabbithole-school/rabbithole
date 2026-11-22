// Pure screen-time primitives: time intervals, the "active" windows around a
// person's own turns, and institution-local day clipping. No Convex or DOM
// imports (see shared/screenTime.test.ts).
//
// These are deliberately ORTHOGONAL TO THE TYPE OF USAGE. Nothing here knows
// about builder apps, web activities or the iPad: an interval is an interval,
// and a turn is a row with a role and a timestamp. The screen-time read model
// (convex/deviceActivity.ts → dailyUsage) composes them per source, so a new
// source reuses the same arithmetic instead of growing its own.

import {
  dayKeyForTimezone,
  dayStartForTimezone,
  shiftDayStartForTimezone,
} from "./institutionDay";

/** A span of time in epoch ms. `end` is exclusive; an empty span has end <= start. */
export type Interval = { start: number; end: number };

/** Length of one interval, never negative. */
export function intervalMs(interval: Interval): number {
  return Math.max(0, interval.end - interval.start);
}

/**
 * Sort and union a set of intervals into disjoint, ascending ones. Touching
 * intervals (one ends where the next starts) join into one; empty ones drop.
 */
export function mergeIntervals(intervals: readonly Interval[]): Interval[] {
  const sorted = intervals
    .filter((interval) => interval.end > interval.start)
    .map((interval) => ({ start: interval.start, end: interval.end }))
    .sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: Interval[] = [];
  for (const interval of sorted) {
    const last = merged[merged.length - 1];
    if (last && interval.start <= last.end) {
      last.end = Math.max(last.end, interval.end);
    } else {
      merged.push(interval);
    }
  }
  return merged;
}

/** Total time covered by a set of intervals, counting overlaps once. */
export function totalMs(intervals: readonly Interval[]): number {
  return mergeIntervals(intervals).reduce(
    (sum, interval) => sum + intervalMs(interval),
    0,
  );
}

/** The part of `interval` inside `bounds`, or null when they do not overlap. */
export function clipInterval(
  interval: Interval,
  bounds: Interval,
): Interval | null {
  const start = Math.max(interval.start, bounds.start);
  const end = Math.min(interval.end, bounds.end);
  return end > start ? { start, end } : null;
}

/**
 * The time covered by BOTH sets, as disjoint ascending intervals. Each set is
 * unioned first, so an overlap inside one set is never counted twice.
 */
export function intersectIntervals(
  intervals: readonly Interval[],
  windows: readonly Interval[],
): Interval[] {
  const a = mergeIntervals(intervals);
  const b = mergeIntervals(windows);
  const result: Interval[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    const piece = clipInterval(a[i], b[j]);
    if (piece) result.push(piece);
    // Advance whichever ends first; it cannot overlap anything later.
    if (a[i].end <= b[j].end) i += 1;
    else j += 1;
  }
  return result;
}

/** How many ms of `intervals` fall inside `windows` (each set unioned first). */
export function overlapMs(
  intervals: readonly Interval[],
  windows: readonly Interval[],
): number {
  return totalMs(intersectIntervals(intervals, windows));
}

/** One institution-local day's share of an interval. */
export type DayPiece = Interval & { dayKey: string };

/**
 * Cut an interval at institution-local midnights. An app opened at 23:50 and
 * closed at 00:20 is ten minutes on one day and twenty on the next. Day
 * boundaries come from shared/institutionDay.ts, so a 23- or 25-hour DST day
 * is cut where the wall clock says, not at a fixed 24 hours.
 */
export function splitIntervalByDay(
  interval: Interval,
  timeZone: string,
): DayPiece[] {
  if (interval.end <= interval.start) return [];
  const pieces: DayPiece[] = [];
  let dayStart = dayStartForTimezone(interval.start, timeZone);
  while (dayStart < interval.end) {
    const nextDayStart = shiftDayStartForTimezone(dayStart, 1, timeZone);
    const piece = clipInterval(interval, { start: dayStart, end: nextDayStart });
    if (piece) {
      pieces.push({ ...piece, dayKey: dayKeyForTimezone(dayStart, timeZone) });
    }
    dayStart = nextDayStart;
  }
  return pieces;
}

// ── Active time around a person's own turns ─────────────────────────────
//
// "On screen" says an app was showing and nothing more. The nearest honest
// evidence that someone was using it is their own turns: a request
// typed into a conversation is proof of attention at that moment, and so is
// reading the reply to it. Each turn therefore vouches for a short window
// around itself, and nothing else does.
//
// CALIBRATION (provisional, pending a teacher check on real sessions). On
// Nov 2-7 2026 prod builder data, the median gap between one scholar's
// consecutive builder requests was 2.2 min (p90 7.6 min), and the last reply
// row landed a median 24 s after its request (p90 89 s). Margins in this
// family (a minute either side, capped at five) put 36-48% of builder
// on-screen time near a request. The three constants are a first cut until a
// teacher checks them against what actually happened in the room.

/**
 * How long before a turn its window opens: the time spent typing (or
 * dictating) the request, which happens before the row is written.
 */
export const ACTIVE_TURN_LEAD_MS = 60_000;

/**
 * How long after the reply finishes the window stays open: reading the reply,
 * or trying the change it made. Provisional; see the calibration note above.
 */
export const ACTIVE_TURN_TRAIL_MS = 60_000;

/**
 * The most one turn may vouch for after it was sent, however slow the reply.
 * Provisional; see the calibration note above.
 */
export const ACTIVE_TURN_CAP_MS = 5 * 60_000;

/** The minimal row shape: who wrote it, and when. */
export type TurnRow = { role: string; createdAt: number };

export type ActiveWindowOptions = {
  leadMs?: number;
  trailMs?: number;
  capMs?: number;
};

/**
 * The windows in which a session's rows show the person was active.
 *
 * For each `role === "user"` row at time t the window is
 *
 *     [t - lead, min(replyDone + trail, t + cap, nextUserTurnAt)]
 *
 * where `replyDone` is the latest non-user row after t and before the next
 * user row (t itself when nothing answered). Windows are unioned, so a run of
 * quick turns reads as one stretch of activity.
 *
 * Rows should be one session's, in time order; they are sorted here anyway.
 * Only timestamps and roles are read.
 */
export function activeWindowsFromTurns(
  rows: readonly TurnRow[],
  opts: ActiveWindowOptions = {},
): Interval[] {
  const leadMs = opts.leadMs ?? ACTIVE_TURN_LEAD_MS;
  const trailMs = opts.trailMs ?? ACTIVE_TURN_TRAIL_MS;
  const capMs = opts.capMs ?? ACTIVE_TURN_CAP_MS;
  const ordered = [...rows].sort((a, b) => a.createdAt - b.createdAt);
  const windows: Interval[] = [];

  for (let index = 0; index < ordered.length; index += 1) {
    const turn = ordered[index];
    if (turn.role !== "user") continue;
    let replyDone = turn.createdAt;
    let nextUserTurnAt = Number.POSITIVE_INFINITY;
    for (let next = index + 1; next < ordered.length; next += 1) {
      const row = ordered[next];
      if (row.role === "user") {
        nextUserTurnAt = row.createdAt;
        break;
      }
      replyDone = Math.max(replyDone, row.createdAt);
    }
    windows.push({
      start: turn.createdAt - leadMs,
      end: Math.min(
        replyDone + trailMs,
        turn.createdAt + capMs,
        nextUserTurnAt,
      ),
    });
  }

  return mergeIntervals(windows);
}

// ── Web activity sessions ───────────────────────────────────────────────

/**
 * The most one `webActivitySessions` row may count for. No cap existed: every
 * reader took `(endedAt ?? lastHeartbeatAt ?? startedAt) - startedAt` as is
 * (convex/lib/scholarReads.ts → readScholarWebActivity). A webview left open
 * on a forgotten iPad keeps heartbeating, so screen time needs a ceiling.
 * Three hours, the same reasoning as EXTERNAL_RETURN_WINDOW_MS in
 * shared/deviceActivityRollup.ts: longer than any plausible single stretch in
 * one site during a school day.
 */
export const WEB_ACTIVITY_SESSION_CAP_MS = 180 * 60_000;

/**
 * The span one web activity session was open: start to its explicit end, else
 * its last heartbeat, else nothing. Never "now". Capped at
 * WEB_ACTIVITY_SESSION_CAP_MS.
 */
export function webActivitySessionInterval(row: {
  startedAt: number;
  endedAt?: number | null;
  lastHeartbeatAt?: number | null;
}): Interval {
  const lastObservedAt = row.endedAt ?? row.lastHeartbeatAt ?? row.startedAt;
  return {
    start: row.startedAt,
    end: Math.max(
      row.startedAt,
      Math.min(lastObservedAt, row.startedAt + WEB_ACTIVITY_SESSION_CAP_MS),
    ),
  };
}
