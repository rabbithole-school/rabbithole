import { describe, expect, test } from "vitest";
import {
  fieldTripDetail,
  tripOverlaps,
  tripTimesProblem,
  weekTripNote,
} from "./fieldTrips";
import { buildHomeworkMonth } from "./homeworkPlanWeeks";

const TZ = "Pacific/Honolulu";
const hst = (dayKey: string, hhmm: string) => Date.parse(`${dayKey}T${hhmm}:00.000-10:00`);
const kualoa = { dayKey: "2026-11-17", startLocal: "09:00", endLocal: "12:00", destination: "Kualoa Ranch" };

describe("field trip helpers", () => {
  test("a class overlapping the window at all is covered; one that ends as it leaves is not", () => {
    expect(tripOverlaps(kualoa, TZ, hst("2026-11-17", "11:30"), hst("2026-11-17", "12:30"))).toBe(true);
    expect(tripOverlaps(kualoa, TZ, hst("2026-11-17", "08:00"), hst("2026-11-17", "09:00"))).toBe(false);
    expect(tripOverlaps(kualoa, TZ, hst("2026-11-18", "09:00"), hst("2026-11-18", "10:00"))).toBe(false);
  });

  test("times are checked", () => {
    expect(tripTimesProblem(kualoa)).toBeNull();
    expect(tripTimesProblem({ ...kualoa, endLocal: "09:00" })).toMatch("end after");
    expect(tripTimesProblem({ ...kualoa, startLocal: "9am" })).toMatch("09:00");
    expect(tripTimesProblem({ ...kualoa, dayKey: "2026-13-01" })).toMatch("day of the trip");
  });

  test("scholar and family wording", () => {
    expect(fieldTripDetail({ ...kualoa, startLocal: "13:30", endLocal: "14:30" })).toBe(
      "Kualoa Ranch · 1:30–2:30",
    );
    expect(weekTripNote("2026-11-16", [kualoa])).toBe("Field trip Tuesday 9:00–12:00 (Kualoa Ranch)");
    expect(weekTripNote("2026-11-23", [kualoa])).toBeNull();
  });

  test("the parent month puts the trip line in its week and moves no due phrase", () => {
    const month = buildHomeworkMonth([], [], {
      monthKey: "2026-11",
      nowMs: hst("2026-11-09", "08:00"),
      timeZone: TZ,
      trips: [kualoa],
    });
    const week = month.weeks.find((w) => w.mondayKey === "2026-11-16")!;
    expect(week.tripNote).toBe("Field trip Tuesday 9:00–12:00 (Kualoa Ranch)");
    expect(week.closedNote).toBeNull();
    expect(month.weeks.filter((w) => w.tripNote).map((w) => w.mondayKey)).toEqual(["2026-11-16"]);
  });
});
