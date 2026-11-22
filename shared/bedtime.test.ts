import { describe, expect, it } from "vitest";
import {
  bedtimeStateAt,
  bedtimeSubline,
  bedtimeWarningText,
  bedtimeWindowText,
  familyBedtimeProblem,
  isSchoolBedtime,
  SCHOOL_BEDTIME,
} from "./bedtime";

const HST = "Pacific/Honolulu"; // UTC-10, no DST
const NY = "America/New_York";
// 2026-10-25 local wall-clock in HST → epoch ms.
const hst = (hh: number, mm: number, day = 25) =>
  Date.UTC(2026, 9, day, hh + 10, mm);

describe("bedtimeStateAt", () => {
  it("is awake during the day and flips to the warning 5 minutes before 8 pm", () => {
    expect(bedtimeStateAt(hst(15, 0), HST)).toEqual({
      phase: "awake",
      changesAt: hst(19, 55),
    });
    expect(bedtimeStateAt(hst(19, 54) + 59_999, HST).phase).toBe("awake");
  });

  it("warns from 7:55 pm until 8 pm", () => {
    expect(bedtimeStateAt(hst(19, 55), HST)).toEqual({
      phase: "warning",
      sleepsAt: hst(20, 0),
      changesAt: hst(20, 0),
    });
    expect(bedtimeStateAt(hst(20, 0) - 1, HST).phase).toBe("warning");
  });

  it("sleeps from 8 pm through midnight until 6 am the next morning", () => {
    const wakesAt = hst(6, 0, 26);
    expect(bedtimeStateAt(hst(20, 0), HST)).toEqual({
      phase: "asleep",
      wakesAt,
      changesAt: wakesAt,
    });
    expect(bedtimeStateAt(hst(23, 59), HST).phase).toBe("asleep");
    expect(bedtimeStateAt(hst(0, 0, 26), HST)).toMatchObject({
      phase: "asleep",
      wakesAt,
    });
    expect(bedtimeStateAt(hst(6, 0, 26) - 1, HST).phase).toBe("asleep");
  });

  it("wakes at exactly 6 am", () => {
    expect(bedtimeStateAt(hst(6, 0), HST)).toEqual({
      phase: "awake",
      changesAt: hst(19, 55),
    });
  });

  it("uses the school's wall clock across a DST change", () => {
    // 2026-11-01 is the US fall-back night: 8 pm Oct 31 EDT → 6 am Nov 1 EST
    // is an 11-hour night, and both ends stay on the local clock.
    const sleeps = Date.UTC(2026, 9, 31, 24, 0); // 20:00 EDT = 00:00Z Nov 1
    const state = bedtimeStateAt(sleeps, NY);
    expect(state).toEqual({
      phase: "asleep",
      wakesAt: Date.UTC(2026, 10, 1, 11, 0), // 06:00 EST
      changesAt: Date.UTC(2026, 10, 1, 11, 0),
    });
  });
});

describe("bedtime copy", () => {
  it("names the time in the school's zone", () => {
    expect(bedtimeWarningText(hst(20, 0), HST)).toContain("at 8:00 pm");
    expect(bedtimeSubline(hst(6, 0, 26), HST)).toContain("See you at 6:00 am!");
  });

  it("states the nightly window for parent-facing copy", () => {
    expect(bedtimeWindowText()).toBe("8pm to 6am");
  });
});

describe("a family's bedtime", () => {
  const family = { startMinutes: 19 * 60 + 30, endMinutes: 6 * 60 + 45 };

  it("sleeps at the family's start and wakes at the family's end", () => {
    expect(bedtimeStateAt(hst(19, 25), HST, family)).toEqual({
      phase: "warning",
      sleepsAt: hst(19, 30),
      changesAt: hst(19, 30),
    });
    expect(bedtimeStateAt(hst(19, 30), HST, family)).toEqual({
      phase: "asleep",
      wakesAt: hst(6, 45, 26),
      changesAt: hst(6, 45, 26),
    });
    expect(bedtimeStateAt(hst(6, 30, 26), HST, family).phase).toBe("asleep");
    expect(bedtimeStateAt(hst(6, 45, 26), HST, family).phase).toBe("awake");
  });

  it("says the family's window in words", () => {
    expect(bedtimeWindowText(family)).toBe("7:30pm to 6:45am");
  });

  it("accepts only a window stricter than the school's, in five-minute steps", () => {
    expect(familyBedtimeProblem(family)).toBeNull();
    expect(familyBedtimeProblem(SCHOOL_BEDTIME)).toBeNull();
    expect(familyBedtimeProblem({ startMinutes: 18 * 60, endMinutes: 7 * 60 })).toBeNull();
    // A parent asked for 7:50am (2026-11-18).
    expect(familyBedtimeProblem({ startMinutes: 19 * 60, endMinutes: 7 * 60 + 50 })).toBeNull();
    expect(familyBedtimeProblem({ startMinutes: 19 * 60 + 55, endMinutes: 8 * 60 })).toBeNull();
    // Looser than the school's, either end.
    expect(familyBedtimeProblem({ startMinutes: 20 * 60 + 15, endMinutes: 6 * 60 })).toMatch(/Bedtime/);
    expect(familyBedtimeProblem({ startMinutes: 20 * 60, endMinutes: 5 * 60 + 45 })).toMatch(/Wake-up/);
    // Outside the range a parent can choose.
    expect(familyBedtimeProblem({ startMinutes: 17 * 60 + 45, endMinutes: 6 * 60 })).toMatch(/6pm and 8pm/);
    expect(familyBedtimeProblem({ startMinutes: 20 * 60, endMinutes: 8 * 60 + 5 })).toMatch(/6am and 8am/);
    expect(familyBedtimeProblem({ startMinutes: 19 * 60 + 12, endMinutes: 6 * 60 })).toMatch(/5 minutes/);
    expect(isSchoolBedtime(SCHOOL_BEDTIME)).toBe(true);
    expect(isSchoolBedtime(family)).toBe(false);
  });
});
