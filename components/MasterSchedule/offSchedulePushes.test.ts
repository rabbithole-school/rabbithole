import { describe, expect, test } from "vitest";
import {
  offSchedulePushes,
  pushPlacementKey,
  scheduledPlacementKeys,
  type PlacementKeyed,
  type PushKeyed,
} from "./offSchedulePushes";

describe("pushPlacementKey", () => {
  test("composes assignment + activity into a stable key", () => {
    expect(pushPlacementKey("a1", "act1")).toBe("a1|act1");
  });

  test("does not collide across the delimiter", () => {
    // "a|b" + "c" must not equal "a" + "b|c".
    expect(pushPlacementKey("a", "b_c")).not.toBe(pushPlacementKey("a_b", "c"));
  });
});

describe("scheduledPlacementKeys", () => {
  test("keeps only placements that link BOTH an assignment and an activity", () => {
    const placements: PlacementKeyed[] = [
      { assignmentId: "a1", activityId: "act1" },
      { assignmentId: "a2", activityId: null }, // awaiting activity — no match
      { assignmentId: null, activityId: "act3" }, // bare structural cell
      { assignmentId: null, activityId: null }, // empty cell
    ];
    const keys = scheduledPlacementKeys(placements);
    expect(keys.has("a1|act1")).toBe(true);
    expect(keys.size).toBe(1);
  });

  test("dedupes repeated (assignment, activity) placements", () => {
    const placements: PlacementKeyed[] = [
      { assignmentId: "a1", activityId: "act1" },
      { assignmentId: "a1", activityId: "act1" }, // same cell placed twice in week
    ];
    expect(scheduledPlacementKeys(placements).size).toBe(1);
  });
});

describe("offSchedulePushes", () => {
  const pushes: PushKeyed[] = [
    { assignmentId: "a1", activityId: "act1" }, // placed → on schedule
    { assignmentId: "a1", activityId: "act2" }, // direct push, same assignment
    { assignmentId: "a2", activityId: "act9" }, // direct push, different assignment
  ];
  const placements: PlacementKeyed[] = [
    { assignmentId: "a1", activityId: "act1" },
    { assignmentId: "a3", activityId: "act1" }, // unrelated placement
  ];

  test("returns pushes with no matching placement", () => {
    const result = offSchedulePushes(pushes, placements);
    expect(result.map((p) => p.activityId)).toEqual(["act2", "act9"]);
  });

  test("matches on assignmentId AND activityId, not either alone", () => {
    // Same activity id under a different assignment must still be off-schedule.
    const result = offSchedulePushes(
      [{ assignmentId: "a2", activityId: "act1" }],
      [{ assignmentId: "a1", activityId: "act1" }],
    );
    expect(result).toHaveLength(1);
  });

  test("empty grid → every live push is off-schedule", () => {
    expect(offSchedulePushes(pushes, [])).toEqual(pushes);
  });

  test("all placed → nothing off-schedule", () => {
    const allPlaced: PlacementKeyed[] = pushes.map((p) => ({
      assignmentId: p.assignmentId,
      activityId: p.activityId,
    }));
    expect(offSchedulePushes(pushes, allPlaced)).toEqual([]);
  });

  test("preserves input order and carries the full push object", () => {
    const rich = [
      { assignmentId: "a2", activityId: "act9", title: "Second" },
      { assignmentId: "a1", activityId: "act2", title: "First" },
    ];
    const result = offSchedulePushes(rich, []);
    expect(result).toEqual(rich);
    expect(result[0].title).toBe("Second");
  });

  test("ignores placements missing an activity id when matching", () => {
    // An assignment placed with no activity yet does not shadow its direct push.
    const result = offSchedulePushes(
      [{ assignmentId: "a1", activityId: "act1" }],
      [{ assignmentId: "a1", activityId: null }],
    );
    expect(result).toHaveLength(1);
  });
});
