import { describe, expect, test } from "vitest";
import {
  hstDayStart,
  hstWeekday,
  overnightTitleForGap,
  recencyPhrase,
} from "../teacherToday";

// Anchors used across the cases. The school is fixed HST (UTC−10, no DST), so
// these UTC instants map to clean HST wall-clock times.
const MON_10AM_HST = Date.parse("2026-07-13T20:00:00.000Z"); // Monday 10:00 HST
const WED_10AM_HST = Date.parse("2026-07-15T20:00:00.000Z"); // Wednesday 10:00 HST
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

describe("hstDayStart / hstWeekday", () => {
  test("hstDayStart returns HST-local midnight of the containing day", () => {
    // Monday 10:00 HST → Monday 00:00 HST = 2026-07-13T10:00:00Z
    expect(hstDayStart(MON_10AM_HST)).toBe(
      Date.parse("2026-07-13T10:00:00.000Z"),
    );
  });

  test("hstWeekday reads the school-local weekday (Mon=1 … Sat=6, Sun=0)", () => {
    expect(hstWeekday(hstDayStart(MON_10AM_HST))).toBe(1); // Monday
    const saturday = hstDayStart(Date.parse("2026-07-11T20:00:00.000Z"));
    expect(hstWeekday(saturday)).toBe(6); // Saturday
    const sunday = hstDayStart(Date.parse("2026-07-12T20:00:00.000Z"));
    expect(hstWeekday(sunday)).toBe(0); // Sunday
  });

  test("accepts an institution timezone across both DST transitions", () => {
    expect(
      hstDayStart(
        Date.parse("2026-03-08T16:00:00.000Z"),
        "America/New_York",
      ),
    ).toBe(Date.parse("2026-03-08T05:00:00.000Z"));
    expect(
      hstDayStart(
        Date.parse("2026-11-02T17:00:00.000Z"),
        "America/New_York",
      ),
    ).toBe(Date.parse("2026-11-02T05:00:00.000Z"));
  });
});

describe("recencyPhrase — labels derived from real age, never asserted", () => {
  test("just now (< 20 min old)", () => {
    expect(recencyPhrase(MON_10AM_HST - 5 * 60 * 1000, MON_10AM_HST)).toBe(
      "just now",
    );
  });

  test("earlier today (same HST day, but not just now)", () => {
    const earlyMonday = hstDayStart(MON_10AM_HST) + 2 * HOUR; // Mon 02:00 HST
    expect(recencyPhrase(earlyMonday, MON_10AM_HST)).toBe("earlier today");
  });

  test("yesterday (previous HST day)", () => {
    const sundayNight = hstDayStart(MON_10AM_HST) - 2 * HOUR; // Sun 22:00 HST
    expect(recencyPhrase(sundayNight, MON_10AM_HST)).toBe("yesterday");
  });

  test("over the weekend (Monday look-back onto Saturday)", () => {
    const saturday = Date.parse("2026-07-11T20:00:00.000Z"); // Sat 10:00 HST
    expect(recencyPhrase(saturday, MON_10AM_HST)).toBe("over the weekend");
  });

  test("in the last few days (mid-week, no weekend framing)", () => {
    const fourDaysBack = WED_10AM_HST - 4 * DAY;
    expect(recencyPhrase(fourDaysBack, WED_10AM_HST)).toBe(
      "in the last few days",
    );
  });
});

describe("overnightTitleForGap — the honest lane title", () => {
  test("a normal overnight gap", () => {
    expect(overnightTitleForGap(1, false)).toBe("Overnight");
  });

  test("a weekend gap", () => {
    expect(overnightTitleForGap(3, false)).toBe("Over the weekend");
    expect(overnightTitleForGap(2, false)).toBe("Over the weekend");
  });

  test("a holiday / break gap", () => {
    expect(overnightTitleForGap(3, true)).toBe("While you were out");
    expect(overnightTitleForGap(1, true)).toBe("While you were out");
  });
});
