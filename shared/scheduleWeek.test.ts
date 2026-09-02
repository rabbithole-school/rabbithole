import { describe, expect, test } from "vitest";
import {
  scheduleWeekStartMs,
  scheduleWeekdayDayKey,
  scheduleWeekdayTimeMs,
  shiftScheduleWeekStartMs,
} from "./scheduleWeek";

const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
const HST_OFFSET = 10 * HOUR;
const NEW_YORK = "America/New_York";

function legacyHstWeekStart(nowMs: number): number {
  const hst = new Date(nowMs - HST_OFFSET);
  const daysSinceMonday = (hst.getUTCDay() + 6) % 7;
  return (
    Date.UTC(hst.getUTCFullYear(), hst.getUTCMonth(), hst.getUTCDate()) -
    daysSinceMonday * DAY +
    HST_OFFSET
  );
}

describe("scheduleWeekStartMs", () => {
  test("the default exactly preserves legacy Honolulu week anchors", () => {
    const instants = [
      Date.parse("2025-01-01T00:00:00.000Z"),
      Date.parse("2026-03-08T09:59:59.999Z"),
      Date.parse("2026-03-08T10:00:00.000Z"),
      Date.parse("2026-07-15T23:42:00.000Z"),
      Date.parse("2026-11-01T10:00:00.000Z"),
    ];
    for (const instant of instants) {
      expect(scheduleWeekStartMs(instant)).toBe(legacyHstWeekStart(instant));
      expect(scheduleWeekStartMs(instant, "Pacific/Honolulu")).toBe(
        legacyHstWeekStart(instant),
      );
    }
  });

  test("New York anchors stay at Monday midnight across spring-forward", () => {
    const before = scheduleWeekStartMs(
      Date.parse("2026-03-08T16:00:00.000Z"),
      NEW_YORK,
    );
    const after = scheduleWeekStartMs(
      Date.parse("2026-03-09T16:00:00.000Z"),
      NEW_YORK,
    );
    expect(before).toBe(Date.parse("2026-03-02T05:00:00.000Z"));
    expect(after).toBe(Date.parse("2026-03-09T04:00:00.000Z"));
    expect(after - before).toBe(167 * HOUR);
    expect(shiftScheduleWeekStartMs(before, 1, NEW_YORK)).toBe(after);
  });

  test("New York anchors stay at Monday midnight across fall-back", () => {
    const before = scheduleWeekStartMs(
      Date.parse("2026-11-01T17:00:00.000Z"),
      NEW_YORK,
    );
    const after = scheduleWeekStartMs(
      Date.parse("2026-11-02T17:00:00.000Z"),
      NEW_YORK,
    );
    expect(before).toBe(Date.parse("2026-10-26T04:00:00.000Z"));
    expect(after).toBe(Date.parse("2026-11-02T05:00:00.000Z"));
    expect(after - before).toBe(169 * HOUR);
    expect(shiftScheduleWeekStartMs(before, 1, NEW_YORK)).toBe(after);
  });

  test("weekday wall-clock times use the institution offset", () => {
    const springWeek = scheduleWeekStartMs(
      Date.parse("2026-03-09T16:00:00.000Z"),
      NEW_YORK,
    );
    expect(scheduleWeekdayTimeMs(springWeek, 1, 8 * 60, NEW_YORK)).toBe(
      Date.parse("2026-03-09T12:00:00.000Z"),
    );

    const fallWeek = scheduleWeekStartMs(
      Date.parse("2026-11-02T17:00:00.000Z"),
      NEW_YORK,
    );
    expect(scheduleWeekdayTimeMs(fallWeek, 1, 8 * 60, NEW_YORK)).toBe(
      Date.parse("2026-11-02T13:00:00.000Z"),
    );
  });
});

describe("scheduleWeekdayDayKey", () => {
  const weekStart = Date.parse("2026-03-02T05:00:00.000Z");

  test("accepts the inclusive Monday-through-Sunday range", () => {
    expect(scheduleWeekdayDayKey(weekStart, 1, NEW_YORK)).toBe("2026-03-02");
    expect(scheduleWeekdayDayKey(weekStart, 7, NEW_YORK)).toBe("2026-03-08");
  });

  test.each([0, 8, NaN, 1.5])("rejects invalid weekday %s", (weekday) => {
    expect(() => scheduleWeekdayDayKey(weekStart, weekday, NEW_YORK)).toThrow(
      new RangeError(`Invalid weekday: ${weekday}`),
    );
  });
});
