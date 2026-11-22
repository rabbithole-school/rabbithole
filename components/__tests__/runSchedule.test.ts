import { describe, expect, test } from "vitest";
import { runSchedule } from "../runSchedule";

// Deploy skew (TRA-13): the web build and the Convex backend deploy
// separately, in either order. The Run page reads the schedule from whichever
// key the backend it is talking to sends.

const entry = { activityId: "a1", mode: "homework" as const };

describe("runSchedule", () => {
  test("a backend that sends only activitySchedule (before the switch)", () => {
    expect(runSchedule({ activitySchedule: [entry] })).toEqual([entry]);
  });
  test("a backend that sends only schedule (after the narrow)", () => {
    expect(runSchedule({ schedule: [entry] })).toEqual([entry]);
  });
  test("a backend that sends both reads schedule", () => {
    expect(
      runSchedule({ schedule: [entry], activitySchedule: [] }),
    ).toEqual([entry]);
  });
  test("neither key is an empty schedule, never a crash", () => {
    expect(runSchedule({})).toEqual([]);
  });
});
