import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { ReportingPeriodOption } from "./DateTermPicker";
import { clampToWeekday, initialAnchorMs, todayAnchorMs } from "./scheduleAnchor";

function term(id: string, startsAt: number, endsAt: number): ReportingPeriodOption {
  return {
    _id: id as ReportingPeriodOption["_id"],
    label: id,
    status: "active",
    startsAt,
    endsAt,
  };
}

/** Local midnight for calendar (year, monthIndex, day). */
function localMidnight(year: number, monthIndex: number, day: number): number {
  return new Date(year, monthIndex, day, 0, 0, 0, 0).getTime();
}

describe("scheduleAnchor", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  describe("todayAnchorMs", () => {
    test("returns today when today is a weekday OUTSIDE every term (the bug)", () => {
      // 2026-07-27 is a Monday that falls between terms (Fall 2026 starts
      // Aug 10). "Today" must land on today regardless of term boundaries —
      // it must NOT snap forward to the nearest term start.
      vi.setSystemTime(new Date(2026, 6, 27, 9, 30));
      expect(todayAnchorMs()).toBe(localMidnight(2026, 6, 27));
    });

    test("Saturday clamps forward to Monday", () => {
      vi.setSystemTime(new Date(2026, 6, 25, 14, 0)); // Sat 2026-07-25
      expect(todayAnchorMs()).toBe(localMidnight(2026, 6, 27)); // Mon
    });

    test("Sunday clamps forward to Monday", () => {
      vi.setSystemTime(new Date(2026, 6, 26, 14, 0)); // Sun 2026-07-26
      expect(todayAnchorMs()).toBe(localMidnight(2026, 6, 27)); // Mon
    });
  });

  describe("initialAnchorMs", () => {
    test("today between terms → snaps to the term start (unchanged first-load behavior)", () => {
      vi.setSystemTime(new Date(2026, 6, 27, 9, 30)); // Mon 2026-07-27, between terms
      const fall = term("fall", localMidnight(2026, 7, 10), localMidnight(2026, 11, 18));
      expect(initialAnchorMs([fall], fall)).toBe(clampToWeekday(fall.startsAt));
    });

    test("today inside a term → returns today (clamped), not the term start", () => {
      vi.setSystemTime(new Date(2026, 6, 27, 9, 30)); // Mon 2026-07-27
      const summer = term("summer", localMidnight(2026, 5, 1), localMidnight(2026, 7, 31));
      expect(initialAnchorMs([summer], summer)).toBe(localMidnight(2026, 6, 27));
    });
  });
});
