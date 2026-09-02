/**
 * offSchedulePushes — the pure matching logic behind HappeningNow's
 * "Live now — not on the schedule" rail.
 *
 * The Master Schedule bridges timetable cells into assignment pushes one way:
 * a `schedulePlacement` carrying both an `assignmentId` and an `activityId`
 * materializes a live `activitySchedule` entry when its block starts. So a live
 * push that has NO matching placement (same assignment + same activity) came
 * from a direct Run-page push, not the timetable — and would otherwise be
 * invisible on the Now cross-section, which only reads placed grid cells.
 *
 * These helpers take the flattened live pushes
 * (`api.assignments.activePushesForTeacher`) and the enriched grid placements
 * (`api.masterSchedule.grid`) and return the pushes with no placement match.
 * Kept framework-free (plain strings) so the matching is unit-tested without
 * Convex or React.
 */

/** Minimal shape of a live push (from `activePushesForTeacher`). */
export interface PushKeyed {
  assignmentId: string;
  activityId: string;
}

/** Minimal shape of a grid placement (from `masterSchedule.grid`). Both ids are
 *  nullable — a bare structural cell links neither. */
export interface PlacementKeyed {
  assignmentId: string | null;
  activityId: string | null;
}

/** Composite key identifying one (assignment, activity) push. */
export function pushPlacementKey(
  assignmentId: string,
  activityId: string,
): string {
  return `${assignmentId}|${activityId}`;
}

/**
 * The set of (assignment, activity) pairs that ARE materialized as timetable
 * placements in the grid. Only placements linking BOTH an assignment and an
 * activity can match a push — bare structural cells (missing either id) are
 * skipped.
 */
export function scheduledPlacementKeys(
  placements: readonly PlacementKeyed[],
): Set<string> {
  const keys = new Set<string>();
  for (const p of placements) {
    if (p.assignmentId && p.activityId) {
      keys.add(pushPlacementKey(String(p.assignmentId), String(p.activityId)));
    }
  }
  return keys;
}

/**
 * Live pushes that did NOT come from a timetable placement — a live
 * `activitySchedule` entry with no matching `schedulePlacement` in the grid.
 * Match is on `assignmentId` + `activityId`. Input order is preserved.
 */
export function offSchedulePushes<T extends PushKeyed>(
  pushes: readonly T[],
  placements: readonly PlacementKeyed[],
): T[] {
  const placed = scheduledPlacementKeys(placements);
  return pushes.filter(
    (p) =>
      !placed.has(pushPlacementKey(String(p.assignmentId), String(p.activityId))),
  );
}
