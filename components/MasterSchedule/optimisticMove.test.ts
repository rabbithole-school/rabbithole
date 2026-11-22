import { describe, expect, test } from "vitest";
import {
  applyOptimisticDueMove,
  applyOptimisticMove,
  linkedPlacementIdForProjection,
} from "./optimisticMove";

const WEEK = 1_000_000;
const NEXT_WEEK = WEEK + 7 * 86_400_000;

type P = {
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
  activityTitle: string;
};

const card = (over: Partial<P> = {}): P => ({
  _id: "p1",
  groupId: "g1",
  weekday: 1,
  blockId: "blockA",
  assignmentId: "a1",
  activityId: "act1",
  mode: "classFocus",
  finishMode: "classFocus",
  railWeekday: null,
  onShelf: false,
  weekStartMs: WEEK,
  activityTitle: "Tide pools",
  ...over,
});

const gridOf = (placements: P[], extra: Partial<{ homeworkDue: { assignmentId: string; activityId: string; groupId: string }[] }> = {}) => ({
  blocks: [
    { _id: "blockA", kind: "class" },
    { _id: "blockB", kind: "class" },
    { _id: "hw", kind: "homework" },
  ],
  placements,
  weekPlacements: placements.filter(
    (p) => !p.onShelf && (p.weekStartMs == null || p.weekStartMs === WEEK),
  ),
  homeworkDue: extra.homeworkDue ?? [],
  coverage: ["kept as is"],
});

describe("applyOptimisticMove", () => {
  test("class cell to class cell: the card is in its new cell, other fields kept", () => {
    const grid = gridOf([card(), card({ _id: "p2", weekday: 2 })]);
    const next = applyOptimisticMove(
      grid,
      { placementId: "p1", weekday: 3, blockId: "blockB", weekStartMs: WEEK, mode: "classFocus" },
      WEEK,
    );
    const moved = next.weekPlacements.find((p) => p._id === "p1")!;
    expect(moved).toMatchObject({ weekday: 3, blockId: "blockB", activityTitle: "Tide pools", railWeekday: null });
    // Same position in the week feed, so neighbours don't reshuffle.
    expect(next.weekPlacements.map((p) => p._id)).toEqual(["p1", "p2"]);
    expect(next.placements.find((p) => p._id === "p1")!.weekday).toBe(3);
    expect(next.coverage).toBe(grid.coverage);
    // The cached value is not mutated.
    expect(grid.placements[0].weekday).toBe(1);
  });

  test("into the homework row: due that day, and its projection steps aside", () => {
    const grid = gridOf([card()], {
      homeworkDue: [
        { assignmentId: "a1", activityId: "act1", groupId: "g1" },
        { assignmentId: "a2", activityId: "act9", groupId: "g1" },
      ],
    });
    const next = applyOptimisticMove(
      grid,
      { placementId: "p1", weekday: 4, blockId: "hw", weekStartMs: WEEK, mode: "homework" },
      WEEK,
    );
    expect(next.weekPlacements[0]).toMatchObject({
      blockId: "hw",
      weekday: 4,
      mode: "homework",
      finishMode: "homework",
      railWeekday: 4,
    });
    expect(next.homeworkDue).toEqual([{ assignmentId: "a2", activityId: "act9", groupId: "g1" }]);
  });

  test("out of the homework row into a class: back in the cell, off the rail", () => {
    const hw = card({ blockId: "hw", weekday: 2, mode: "homework", finishMode: "homework", railWeekday: 2 });
    // The server leaves a projected homework card out of the week feed.
    const grid = { ...gridOf([hw]), weekPlacements: [] as P[] };
    const next = applyOptimisticMove(
      grid,
      { placementId: "p1", weekday: 1, blockId: "blockA", weekStartMs: WEEK, mode: "classFocus" },
      WEEK,
    );
    expect(next.weekPlacements).toHaveLength(1);
    expect(next.weekPlacements[0]).toMatchObject({ blockId: "blockA", mode: "classFocus", railWeekday: null });
  });

  test("a recurring row stays recurring; a concrete row from another week joins this one", () => {
    const recurring = card({ _id: "r", weekStartMs: null });
    const later = card({ _id: "c", weekStartMs: NEXT_WEEK });
    const grid = gridOf([recurring, later]);
    const r = applyOptimisticMove(grid, { placementId: "r", weekday: 2, blockId: "blockA", weekStartMs: WEEK }, WEEK);
    expect(r.placements.find((p) => p._id === "r")!.weekStartMs).toBeNull();
    const c = applyOptimisticMove(grid, { placementId: "c", weekday: 2, blockId: "blockA", weekStartMs: WEEK }, WEEK);
    expect(c.weekPlacements.find((p) => p._id === "c")!.weekStartMs).toBe(WEEK);
  });

  test("an unknown placement leaves the grid untouched", () => {
    const grid = gridOf([card()]);
    expect(applyOptimisticMove(grid, { placementId: "nope", weekday: 1, blockId: "blockA" }, WEEK)).toBe(grid);
  });
});

describe("linkedPlacementIdForProjection", () => {
  const projection = { assignmentId: "a1", activityId: "act1", groupId: "g1" };
  test("prefers this week's row, then a recurring one; skips other groups and the shelf", () => {
    const placements = [
      card({ _id: "other-group", groupId: "g2" }),
      card({ _id: "shelved", onShelf: true, weekday: null, blockId: null }),
      card({ _id: "recurring", weekStartMs: null }),
      card({ _id: "this-week" }),
    ];
    expect(linkedPlacementIdForProjection(placements, projection, WEEK)).toBe("this-week");
    expect(linkedPlacementIdForProjection(placements.slice(0, 3), projection, WEEK)).toBe("recurring");
  });
  test("work given from its assignment page has no card to drag", () => {
    expect(linkedPlacementIdForProjection([card({ assignmentId: "a9" })], projection, WEEK)).toBeNull();
  });
});

describe("applyOptimisticDueMove", () => {
  const week = ["2026-11-09", "2026-11-10", "2026-11-11", "2026-11-12", "2026-11-13"];
  const due = (over: Partial<{ assignmentId: string; activityId: string; groupId: string; weekday: number; dueAt: number }> = {}) => ({
    assignmentId: "a1",
    activityId: "act1",
    groupId: "g1",
    weekday: 4,
    dueAt: 1,
    ...over,
  });
  test("every group's card for that give moves to the new weekday", () => {
    const grid = { homeworkDue: [due(), due({ groupId: "g2" }), due({ activityId: "other" })], coverage: [] };
    const next = applyOptimisticDueMove(
      grid,
      { assignmentId: "a1", activityId: "act1", dayKey: "2026-11-10" },
      week,
      99,
    );
    expect(next.homeworkDue.map((i) => i.weekday)).toEqual([2, 2, 4]);
    expect(next.homeworkDue[0].dueAt).toBe(99);
    expect(grid.homeworkDue[0].weekday).toBe(4);
  });
  test("a day outside the viewed week takes the card out of this week", () => {
    const grid = { homeworkDue: [due(), due({ activityId: "other" })] };
    const next = applyOptimisticDueMove(
      grid,
      { assignmentId: "a1", activityId: "act1", dayKey: "2026-11-17" },
      week,
      0,
    );
    expect(next.homeworkDue.map((i) => i.activityId)).toEqual(["other"]);
  });
  test("a give with no card in this week leaves the grid untouched", () => {
    const grid = { homeworkDue: [due()] };
    expect(
      applyOptimisticDueMove(grid, { assignmentId: "a9", activityId: "act1", dayKey: "2026-11-10" }, week, 0),
    ).toBe(grid);
  });
});
