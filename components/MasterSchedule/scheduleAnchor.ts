/**
 * Pure anchor-date helpers for the Assignments/Schedule view. Extracted from
 * MasterScheduleView so they can be unit-tested (the sibling
 * scheduleLoadingState.ts was extracted for the same reason).
 *
 * The distinction that matters here:
 * - `initialAnchorMs` — the FIRST-LOAD anchor. When today falls between terms
 *   it deliberately lands on the current/next term's first week, so the view
 *   opens on real content instead of an empty between-terms week.
 * - `todayAnchorMs` — what the explicit "Today" button uses. It is literal:
 *   always today (advanced to Monday on weekends), never term-snapped, matching
 *   the prev/next arrows which move ±7 days freely across term boundaries.
 */

type ReportingPeriodBounds = {
  startsAt: number;
  endsAt: number;
};

export function clampToWeekday(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  const dow = d.getDay();
  if (dow === 6) d.setDate(d.getDate() + 2);
  else if (dow === 0) d.setDate(d.getDate() + 1);
  return d.getTime();
}

/** The explicit "Today" target: literally today, advanced to Monday on weekends. */
export function todayAnchorMs(): number {
  return clampToWeekday(Date.now());
}

export function initialAnchorMs(
  terms: ReportingPeriodBounds[] | undefined,
  currentTerm: ReportingPeriodBounds | null | undefined,
): number {
  const today = Date.now();
  if (terms?.some((term) => today >= term.startsAt && today <= term.endsAt)) {
    return clampToWeekday(today);
  }
  return clampToWeekday((currentTerm ?? terms?.[0])?.startsAt ?? today);
}
