import { describe, expect, it } from "vitest";
import { isGradableManipulative } from "../authoring";
import { goalText, leastCommonMultiple, multipleTrackLandings, numberLineSolved } from "../logic";
import type { ManipulativeSpec, NumberLineSpec } from "../types";

const line = (goal: NumberLineSpec["goal"]): NumberLineSpec => ({
  kind: "numberline",
  id: "numberline-goal",
  concept: "Number sense",
  prompt: "Place the marker.",
  min: 0,
  max: 10,
  tickStep: 1,
  start: 0,
  goal,
});

describe("NumberLineGoal consumers", () => {
  it.each([
    [{ type: "placeAt", value: 7 }, 7, "7"],
    [{ type: "placeFraction", num: 3, den: 4 }, 0.75, "3/4"],
  ] as const)("handles %s consistently", (goal, solvedValue, goalLabel) => {
    const spec = line(goal);

    expect(numberLineSolved(spec, { value: solvedValue })).toBe(true);
    expect(isGradableManipulative(spec)).toBe(true);
    expect(goalText(spec)).toContain(goalLabel);
  });

  it("safely rejects a missing-track first-common-multiple goal in grading consumers", () => {
    const spec = line({ type: "placeAt", value: 7 });
    const forged = { ...spec, goal: { type: "firstCommonMultiple", tracks: [3, 5] } } as unknown as ManipulativeSpec;

    expect(numberLineSolved(forged as NumberLineSpec, { value: 7 })).toBe(false);
    expect(isGradableManipulative(forged)).toBe(false);
    expect(goalText(forged)).toBe("Reveal both skip-count tracks and stop at their first shared landing.");
  });

  it("derives and grades the first common multiple without accepting a later one", () => {
    const spec = {
      ...line({ type: "firstCommonMultiple", tolerance: 0.5 }),
      max: 30,
      multipleTracks: [3, 5] as [number, number],
    };

    expect(leastCommonMultiple(3, 5)).toBe(15);
    expect(leastCommonMultiple(8, 12)).toBe(24);
    expect(leastCommonMultiple(7, 9)).toBe(63);
    expect(leastCommonMultiple(5, 3)).toBe(15);
    expect(leastCommonMultiple(0, 3)).toBeNull();
    expect(leastCommonMultiple(-3, 5)).toBeNull();
    expect(leastCommonMultiple(2.5, 5)).toBeNull();
    expect(leastCommonMultiple(Infinity, 5)).toBeNull();
    expect(numberLineSolved(spec, { value: 15 })).toBe(true);
    expect(numberLineSolved(spec, { value: 30 })).toBe(false);
    expect(numberLineSolved({ ...spec, multipleTracks: undefined }, { value: 15 })).toBe(false);
    expect(goalText(spec)).not.toContain("15");
  });

  it("reveals only reached positive landings and neutral shared positions", () => {
    expect(multipleTrackLandings([3, 5], 16, 30)).toEqual({
      tracks: [[3, 6, 9, 12, 15], [5, 10, 15]],
      common: [15],
    });
    expect(multipleTrackLandings([8, 12], 24, 30).common).toEqual([24]);
    expect(multipleTrackLandings([7, 9], 62, 70).common).toEqual([]);
    expect(multipleTrackLandings([0, 5], 30, 30)).toEqual({
      tracks: [[], [5, 10, 15, 20, 25, 30]],
      common: [],
    });
  });
});
