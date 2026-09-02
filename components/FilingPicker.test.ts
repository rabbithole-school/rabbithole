import { describe, expect, test } from "vitest";
import { limitRecentAssignments } from "./FilingPicker";

describe("limitRecentAssignments", () => {
  const assignments = Array.from({ length: 7 }, (_, index) => ({
    id: `assignment-${index}`,
    createdAt: index,
  }));

  test("shows only the five newest assignments before searching", () => {
    expect(
      limitRecentAssignments(assignments, false, null).map(({ id }) => id),
    ).toEqual([
      "assignment-6",
      "assignment-5",
      "assignment-4",
      "assignment-3",
      "assignment-2",
    ]);
  });

  test("search can reach every assignment", () => {
    expect(limitRecentAssignments(assignments, true, null)).toHaveLength(7);
  });

  test("keeps an older current selection visible", () => {
    expect(
      limitRecentAssignments(assignments, false, "assignment-0").map(
        ({ id }) => id,
      ),
    ).toContain("assignment-0");
  });
});
