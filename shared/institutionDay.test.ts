import { describe, expect, test } from "vitest";
import {
  DEFAULT_TIMEZONE,
  dayKeysShareCalendarWeek,
  dayKeyForTimezone,
  dayStartForDayKey,
  dayStartForTimezone,
  dueStatus,
  instantForLocalMinutes,
  minuteOfDayForTimezone,
  mondayDayKeyForTimezone,
  shiftDayStartForTimezone,
  weekdayForTimezone,
} from "./institutionDay";

// Pacific/Honolulu is a stable UTC-10 calendar with no DST, so a local day
// boundary is exactly 10:00 UTC. That makes the institution-midnight edge
// cases below deterministic without wrestling a DST transition.
const TZ = "Pacific/Honolulu";
/** First millisecond of a Honolulu-local calendar day. */
const localMidnight = (y: number, m: number, d: number) =>
  Date.UTC(y, m - 1, d, 10, 0, 0);
/** Roughly local noon on a Honolulu day (a stable mid-day instant). */
const localNoon = (y: number, m: number, d: number) =>
  Date.UTC(y, m - 1, d, 22, 0, 0);

// Anchor "now": Monday, 2026-06-15, local noon.
const NOW = localNoon(2026, 6, 15);

describe("dayKeysShareCalendarWeek", () => {
  test("keeps adjacent school days in the same week", () => {
    expect(dayKeysShareCalendarWeek("2026-08-20", "2026-08-21")).toBe(true);
  });

  test("crosses the weekend from Friday to Monday", () => {
    expect(dayKeysShareCalendarWeek("2026-08-21", "2026-08-24")).toBe(false);
  });

  test("crosses the week boundary after a closure", () => {
    expect(dayKeysShareCalendarWeek("2026-08-20", "2026-08-24")).toBe(false);
  });
});

describe("dueStatus — status by institution day-key", () => {
  test("null / undefined dueAt returns null (no deadline)", () => {
    expect(dueStatus(null, NOW, TZ)).toBeNull();
    expect(dueStatus(undefined, NOW, TZ)).toBeNull();
  });

  test("earlier institution day is overdue", () => {
    expect(dueStatus(localNoon(2026, 6, 14), NOW, TZ)?.status).toBe("overdue");
  });

  test("same institution day is dueToday across the whole day", () => {
    expect(dueStatus(localNoon(2026, 6, 15), NOW, TZ)?.status).toBe("dueToday");
    // Even the first instant of today is still dueToday, not overdue.
    expect(dueStatus(localMidnight(2026, 6, 15), NOW, TZ)?.status).toBe(
      "dueToday",
    );
  });

  test("future institution day is upcoming", () => {
    expect(dueStatus(localNoon(2026, 6, 16), NOW, TZ)?.status).toBe("upcoming");
  });
});

describe("dueStatus — today", () => {
  test("same institution day reads 'due today'", () => {
    expect(dueStatus(localNoon(2026, 6, 15), NOW, TZ)).toEqual({
      status: "dueToday",
      phrase: "due today",
    });
    expect(dueStatus(localMidnight(2026, 6, 15), NOW, TZ)).toEqual({
      status: "dueToday",
      phrase: "due today",
    });
  });
});

describe("dueStatus — future phrases", () => {
  test("tomorrow", () => {
    expect(dueStatus(localNoon(2026, 6, 16), NOW, TZ)).toEqual({
      status: "upcoming",
      phrase: "due tomorrow",
    });
  });

  test("2–6 days out names the weekday", () => {
    // +3 days → Thursday, +4 days → Friday.
    expect(dueStatus(localNoon(2026, 6, 18), NOW, TZ)).toEqual({
      status: "upcoming",
      phrase: "due Thursday",
    });
    expect(dueStatus(localNoon(2026, 6, 19), NOW, TZ)).toEqual({
      status: "upcoming",
      phrase: "due Friday",
    });
  });

  test("further out, same year → 'due Mon D'", () => {
    expect(dueStatus(localNoon(2026, 9, 1), NOW, TZ)).toEqual({
      status: "upcoming",
      phrase: "due Sep 1",
    });
  });

  test("further out, different year → 'due Mon D, YYYY'", () => {
    expect(dueStatus(localNoon(2027, 1, 5), NOW, TZ)).toEqual({
      status: "upcoming",
      phrase: "due Jan 5, 2027",
    });
  });
});

describe("dueStatus — past phrases", () => {
  test("yesterday", () => {
    expect(dueStatus(localNoon(2026, 6, 14), NOW, TZ)).toEqual({
      status: "overdue",
      phrase: "was due yesterday",
    });
  });

  test("2–6 days ago names the weekday", () => {
    // -5 days → Wednesday.
    expect(dueStatus(localNoon(2026, 6, 10), NOW, TZ)).toEqual({
      status: "overdue",
      phrase: "was due Wednesday",
    });
  });

  test("further back, same year → 'was due Mon D'", () => {
    expect(dueStatus(localNoon(2026, 3, 14), NOW, TZ)).toEqual({
      status: "overdue",
      phrase: "was due Mar 14",
    });
  });

  test("further back, different year → 'was due Mon D, YYYY'", () => {
    expect(dueStatus(localNoon(2025, 11, 20), NOW, TZ)).toEqual({
      status: "overdue",
      phrase: "was due Nov 20, 2025",
    });
  });
});

describe("today ↔ overdue boundary at institution midnight", () => {
  // A deadline stamped on 2026-06-15. Cross the 2026-06-16 local midnight.
  const dueAt = localNoon(2026, 6, 15);
  const justBeforeMidnight = localMidnight(2026, 6, 16) - 1_000;
  const justAfterMidnight = localMidnight(2026, 6, 16) + 1_000;

  test("one second before midnight it is still due today", () => {
    expect(dueStatus(dueAt, justBeforeMidnight, TZ)).toEqual({
      status: "dueToday",
      phrase: "due today",
    });
  });

  test("one second after midnight it flips to overdue (was due yesterday)", () => {
    expect(dueStatus(dueAt, justAfterMidnight, TZ)).toEqual({
      status: "overdue",
      phrase: "was due yesterday",
    });
  });
});

const HOUR = 60 * 60 * 1000;
const LEGACY_HST_OFFSET = 10 * HOUR;
const NEW_YORK = "America/New_York";

function legacyHstDayStart(nowMs: number): number {
  const hst = new Date(nowMs - LEGACY_HST_OFFSET);
  return (
    Date.UTC(hst.getUTCFullYear(), hst.getUTCMonth(), hst.getUTCDate()) +
    LEGACY_HST_OFFSET
  );
}

function legacyHstDayKey(nowMs: number): string {
  return new Date(nowMs - LEGACY_HST_OFFSET).toISOString().slice(0, 10);
}

describe("institution-local day math", () => {
  test("weekday and minute come from the requested timezone, not the browser calendar", () => {
    // 2026-01-01 05:30 UTC is Wednesday 19:30 in Honolulu and Thursday 00:30
    // in New York: the local calendar date and clock both differ.
    const instant = Date.parse("2026-01-01T05:30:00.000Z");

    expect(weekdayForTimezone(instant, "Pacific/Honolulu")).toBe(3);
    expect(minuteOfDayForTimezone(instant, "Pacific/Honolulu")).toBe(
      19 * 60 + 30,
    );
    expect(weekdayForTimezone(instant, NEW_YORK)).toBe(4);
    expect(minuteOfDayForTimezone(instant, NEW_YORK)).toBe(30);
  });

  test("the Honolulu default is identical to the legacy fixed-offset math", () => {
    const instants = [
      Date.parse("2025-01-01T00:00:00.000Z"),
      Date.parse("2026-03-08T09:59:59.999Z"),
      Date.parse("2026-03-08T10:00:00.000Z"),
      Date.parse("2026-07-15T23:42:00.000Z"),
      Date.parse("2026-11-01T10:00:00.000Z"),
      Date.parse("2030-12-31T23:59:59.999Z"),
    ];

    for (const instant of instants) {
      expect(dayKeyForTimezone(instant)).toBe(legacyHstDayKey(instant));
      expect(dayKeyForTimezone(instant, DEFAULT_TIMEZONE)).toBe(
        legacyHstDayKey(instant),
      );
      expect(dayStartForTimezone(instant)).toBe(legacyHstDayStart(instant));
      expect(dayStartForTimezone(instant, DEFAULT_TIMEZONE)).toBe(
        legacyHstDayStart(instant),
      );
    }
  });

  test("New York local midnights track spring-forward and fall-back offsets", () => {
    expect(dayStartForDayKey("2026-03-08", NEW_YORK)).toBe(
      Date.parse("2026-03-08T05:00:00.000Z"),
    );
    expect(dayStartForDayKey("2026-03-09", NEW_YORK)).toBe(
      Date.parse("2026-03-09T04:00:00.000Z"),
    );
    expect(dayStartForDayKey("2026-11-01", NEW_YORK)).toBe(
      Date.parse("2026-11-01T04:00:00.000Z"),
    );
    expect(dayStartForDayKey("2026-11-02", NEW_YORK)).toBe(
      Date.parse("2026-11-02T05:00:00.000Z"),
    );
  });

  test("calendar-day shifts and local school times remain wall-clock stable", () => {
    const springSunday = dayStartForDayKey("2026-03-08", NEW_YORK);
    const springMonday = shiftDayStartForTimezone(
      springSunday,
      1,
      NEW_YORK,
    );
    expect(springMonday - springSunday).toBe(23 * HOUR);
    expect(instantForLocalMinutes("2026-03-08", 8 * 60, NEW_YORK)).toBe(
      Date.parse("2026-03-08T12:00:00.000Z"),
    );

    const fallSunday = dayStartForDayKey("2026-11-01", NEW_YORK);
    const fallMonday = shiftDayStartForTimezone(fallSunday, 1, NEW_YORK);
    expect(fallMonday - fallSunday).toBe(25 * HOUR);
    expect(instantForLocalMinutes("2026-11-01", 15 * 60, NEW_YORK)).toBe(
      Date.parse("2026-11-01T20:00:00.000Z"),
    );
  });

  test("Monday day keys use local calendar dates across DST", () => {
    expect(
      mondayDayKeyForTimezone(
        Date.parse("2026-03-08T16:00:00.000Z"),
        0,
        NEW_YORK,
      ),
    ).toBe("2026-03-02");
    expect(
      mondayDayKeyForTimezone(
        Date.parse("2026-03-09T16:00:00.000Z"),
        0,
        NEW_YORK,
      ),
    ).toBe("2026-03-09");
    expect(
      mondayDayKeyForTimezone(
        Date.parse("2026-11-01T17:00:00.000Z"),
        1,
        NEW_YORK,
      ),
    ).toBe("2026-11-02");
  });
});
