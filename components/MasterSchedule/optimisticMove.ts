/**
 * The grid's local guess at a drag-drop move, applied the moment the card is
 * dropped so it lands in its target cell instead of waiting a server round
 * trip. Convex replays it until `movePlacement` answers, then swaps in the
 * real grid (or rolls it back if the move failed).
 *
 * It patches only what the view lays out from: the placement's slot in the
 * term feed, the viewed week's feed, and the Homework due projection that
 * stands in for a railed card. A drop always lands in a cell: the grid has no
 * day-less shelf (TRA-582). The grid view still does the
 * placing (`cellPlacements`, `homeworkByDay`), so there is no second layout
 * here. Coverage, conflicts and flags wait for the server.
 */

type MovablePlacement = {
  _id: string;
  groupId: string;
  weekday: number | null;
  blockId: string | null;
  assignmentId: string | null;
  activityId: string | null;
  mode: "classFocus" | "homework" | null;
  finishMode?: "classFocus" | "homework";
  railWeekday?: number | null;
  onShelf: boolean;
  weekStartMs: number | null;
};

type MovableGrid<P extends MovablePlacement> = {
  blocks: { _id: string; kind: string }[];
  placements: P[];
  weekPlacements: P[];
  homeworkDue: {
    assignmentId: string;
    activityId: string;
    groupId: string;
  }[];
};

export type PlacementMove = {
  placementId: string;
  weekday: number;
  blockId: string;
  weekStartMs?: number;
  mode?: "classFocus" | "homework";
};

export function applyOptimisticMove<
  P extends MovablePlacement,
  G extends MovableGrid<P>,
>(grid: G, move: PlacementMove, viewedWeekStartMs: number): G {
  const id = String(move.placementId);
  const current = grid.placements.find((p) => String(p._id) === id);
  if (!current) return grid;

  const intoHomeworkBlock = grid.blocks.some(
      (b) => String(b._id) === String(move.blockId) && b.kind === "homework",
    );
  const mode = move.mode ?? current.mode;
  // Same rule as the server: a concrete row adopts the viewed week; a
  // recurring row stays a pattern.
  const weekStartMs =
    current.weekStartMs != null && move.weekStartMs != null
      ? move.weekStartMs
      : current.weekStartMs;
  const moved: P = {
    ...current,
    weekday: move.weekday,
    blockId: move.blockId,
    mode,
    onShelf: false,
    weekStartMs,
    // The homework block is "by that day"; a class cell is "in that class".
    finishMode: intoHomeworkBlock ? "homework" : (mode ?? "classFocus"),
    railWeekday: intoHomeworkBlock ? move.weekday : null,
  };

  const notMoved = (p: P) => String(p._id) !== id;
  const inViewedWeek = weekStartMs == null || weekStartMs === viewedWeekStartMs;
  const weekIndex = grid.weekPlacements.findIndex((p) => !notMoved(p));
  const weekPlacements = grid.weekPlacements.filter(notMoved);
  if (inViewedWeek) {
    weekPlacements.splice(
      weekIndex >= 0 ? weekIndex : weekPlacements.length,
      0,
      moved,
    );
  }

  // A railed card is drawn by its Homework due projection. Drop the
  // projection so the card itself shows where it was dropped; the server's
  // answer brings back whatever projection is still true.
  const projectionKey =
    current.assignmentId && current.activityId
      ? `${current.assignmentId}:${current.activityId}:${current.groupId}`
      : null;
  const homeworkDue = projectionKey
    ? grid.homeworkDue.filter(
        (item) =>
          `${item.assignmentId}:${item.activityId}:${item.groupId}` !==
          projectionKey,
      )
    : grid.homeworkDue;

  return {
    ...grid,
    placements: grid.placements.map((p) => (notMoved(p) ? p : moved)),
    weekPlacements,
    homeworkDue,
  };
}

/** The grid placement a Homework due projection stands in for, so the
 *  projection card can be dragged as that placement. Prefers a row in the
 *  viewed week, then a recurring row. Null when the work was given from its
 *  assignment page and has no grid card to move. */
export function linkedPlacementIdForProjection<P extends MovablePlacement>(
  placements: readonly P[],
  projection: { assignmentId: string; activityId: string; groupId: string },
  viewedWeekStartMs: number,
): string | null {
  const matches = placements.filter(
    (p) =>
      !p.onShelf &&
      String(p.assignmentId) === String(projection.assignmentId) &&
      String(p.activityId) === String(projection.activityId) &&
      String(p.groupId) === String(projection.groupId),
  );
  const pick =
    matches.find((p) => p.weekStartMs === viewedWeekStartMs) ??
    matches.find((p) => p.weekStartMs == null) ??
    matches[0];
  return pick ? String(pick._id) : null;
}

type DueItem = {
  assignmentId: string;
  activityId: string;
  weekday: number;
  dueAt: number;
};

/** The grid's local guess at moving a give's finish to another day: its
 *  Homework due card shows on that weekday of the viewed week, or leaves the
 *  week when the day is in another one. `weekDayKeys` are the viewed week's
 *  Mon–Fri day keys in the term's zone; `dueAt` is only a placeholder until
 *  the server's answer replaces it. */
export function applyOptimisticDueMove<
  I extends DueItem,
  G extends { homeworkDue: I[] },
>(
  grid: G,
  move: { assignmentId: string; activityId: string; dayKey: string },
  weekDayKeys: readonly string[],
  dueAtForDay: number,
): G {
  const matches = (item: I) =>
    String(item.assignmentId) === String(move.assignmentId) &&
    String(item.activityId) === String(move.activityId);
  if (!grid.homeworkDue.some(matches)) return grid;
  const index = weekDayKeys.indexOf(move.dayKey);
  return {
    ...grid,
    homeworkDue:
      index < 0
        ? grid.homeworkDue.filter((item) => !matches(item))
        : grid.homeworkDue.map((item) =>
            matches(item)
              ? { ...item, weekday: index + 1, dueAt: dueAtForDay }
              : item,
          ),
  };
}
