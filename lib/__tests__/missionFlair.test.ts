import { describe, expect, test } from "vitest";

import {
  hasMissionLines,
  isMissionCriterionId,
  missionCriterionId,
  missionLines,
} from "@/shared/missionFlair";

describe("missionLines", () => {
  test("keeps only nonblank mission labels in snapshot order, never private descriptions", () => {
    const criteria = [
      { id: "mission-2", label: " Your cart's journey ", description: "Private rule" },
      { id: "maker-explanation", label: "Your explanation" },
      { id: "mission-1", label: "Your cart's weight", description: "Private answer" },
      { id: "mission-3", label: " \n " },
      { id: "mission-01", label: "Not a mission line" },
    ];

    expect(missionLines(criteria)).toEqual([
      "Your cart's journey",
      "Your cart's weight",
    ]);
  });

  test("has nothing to show before setup or for a non-mission rubric", () => {
    for (const criteria of [
      undefined,
      null,
      [],
      [{ id: "maker-explanation", label: "Your explanation" }],
    ]) {
      expect(missionLines(criteria)).toEqual([]);
    }
  });
});

test("mission identities are positive one-based source positions, not loose prefixes", () => {
  expect([0, 1, 9].map(missionCriterionId)).toEqual([
    "mission-1",
    "mission-2",
    "mission-10",
  ]);
  for (const id of ["mission-1", "mission-10", "mission-123"]) {
    expect(isMissionCriterionId(id)).toBe(true);
  }
  for (const id of [
    "mission-0", "mission-01", "mission--1", "mission-1.5",
    "mission-1-extra", "mission-", " mission-1", "Mission-1",
  ]) {
    expect(isMissionCriterionId(id)).toBe(false);
  }
});

test("only nonblank invariant lines make a mission", () => {
  for (const invariants of [undefined, null, [], ["", " \n\t "]]) {
    expect(hasMissionLines(invariants)).toBe(false);
  }
  expect(hasMissionLines([" ", "Your app explores motion", ""])).toBe(true);
});
