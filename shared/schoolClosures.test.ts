import { describe, expect, it } from "vitest";
import {
  closuresForWeek,
  dayKeyForWeekday,
  isClosedDay,
  type SchoolClosure,
} from "./schoolClosures";

const HST = "Pacific/Honolulu";

function day(start: string, end = start, over: Partial<SchoolClosure> = {}): SchoolClosure {
  return { startDayKey: start, endDayKey: end, label: "Test", kind: "holiday", ...over };
}

// Epoch-ms of a Monday 00:00 HST for a known week (Mon 2026-08-17).
const AUG17_MON = new Date("2026-08-17T00:00:00-10:00").getTime();

describe("isClosedDay", () => {
  it("matches a single-day closure exactly", () => {
    const closures = [day("2026-08-21")];
    expect(isClosedDay("2026-08-21", closures)?.label).toBe("Test");
    expect(isClosedDay("2026-08-20", closures)).toBeNull();
    expect(isClosedDay("2026-08-22", closures)).toBeNull();
  });

  it("matches inclusively across a multi-day break", () => {
    const closures = [day("2026-12-21", "2027-01-01", { label: "Winter Break" })];
    expect(isClosedDay("2026-12-21", closures)?.label).toBe("Winter Break"); // start
    expect(isClosedDay("2026-12-25", closures)?.label).toBe("Winter Break"); // middle
    expect(isClosedDay("2027-01-01", closures)?.label).toBe("Winter Break"); // end (crosses year)
    expect(isClosedDay("2026-12-20", closures)).toBeNull();
    expect(isClosedDay("2027-01-02", closures)).toBeNull();
  });

  it("returns null when nothing matches", () => {
    expect(isClosedDay("2026-09-01", [day("2026-08-21")])).toBeNull();
    expect(isClosedDay("2026-09-01", [])).toBeNull();
  });

  it("tolerates start/end stored out of order", () => {
    const closures = [day("2027-01-01", "2026-12-21")];
    expect(isClosedDay("2026-12-25", closures)).not.toBeNull();
  });

  it("preserves the closure kind", () => {
    const closures = [day("2026-11-27", "2026-11-27", { kind: "staffOnly" })];
    expect(isClosedDay("2026-11-27", closures)?.kind).toBe("staffOnly");
  });
});

describe("dayKeyForWeekday", () => {
  it("resolves Mon–Fri of a week to the right HST day keys", () => {
    expect(dayKeyForWeekday(AUG17_MON, 1, HST)).toBe("2026-08-17"); // Mon
    expect(dayKeyForWeekday(AUG17_MON, 5, HST)).toBe("2026-08-21"); // Fri
  });
});

describe("closuresForWeek", () => {
  it("maps only the closed weekday columns", () => {
    // Statehood Day is Fri 2026-08-21 (weekday 5).
    const map = closuresForWeek(AUG17_MON, HST, [day("2026-08-21", "2026-08-21", { label: "Statehood Day" })]);
    expect(map.size).toBe(1);
    expect(map.get(5)?.label).toBe("Statehood Day");
    expect(map.has(1)).toBe(false);
  });

  it("covers every weekday inside a full-week break", () => {
    // Spring Break week Mon 2027-03-15 → Fri 2027-03-19 all inside the range.
    const springMon = new Date("2027-03-15T00:00:00-10:00").getTime();
    const map = closuresForWeek(springMon, HST, [day("2027-03-15", "2027-03-29", { label: "Spring Break" })]);
    expect([...map.keys()].sort()).toEqual([1, 2, 3, 4, 5]);
  });

  it("is empty for an open week", () => {
    expect(closuresForWeek(AUG17_MON, HST, [day("2026-09-07")]).size).toBe(0);
  });
});
