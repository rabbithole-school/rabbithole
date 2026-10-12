import { describe, expect, test } from "vitest";
import { dayKeyForTimezone } from "./institutionDay";
import { isFocusShowing } from "./focusShowing";

const timeZone = "Pacific/Honolulu";
const todayNow = Date.parse("2026-09-09T22:00:00.000Z");
const todayDayKey = dayKeyForTimezone(todayNow, timeZone);
const yesterday = Date.parse("2026-09-08T22:00:00.000Z");
const tomorrow = Date.parse("2026-09-10T22:00:00.000Z");

describe("isFocusShowing", () => {
  test("shows a focus set today with no endsAt for the full day", () => {
    expect(
      isFocusShowing({ setAt: todayNow - 60_000 }, todayNow, todayDayKey, timeZone),
    ).toBe(true);
  });

  test("hides a focus set yesterday with no explicit longer lifetime", () => {
    expect(
      isFocusShowing({ setAt: yesterday }, todayNow, todayDayKey, timeZone),
    ).toBe(false);
  });

  test("shows a focus set yesterday when endsAt is still in the future", () => {
    expect(
      isFocusShowing(
        { setAt: yesterday, endsAt: tomorrow },
        todayNow,
        todayDayKey,
        timeZone,
      ),
    ).toBe(true);
  });

  test("keeps a same-day overrun visible, then drops it the next day", () => {
    const entry = { setAt: todayNow - 60_000, endsAt: todayNow - 1 };
    expect(isFocusShowing(entry, todayNow, todayDayKey, timeZone)).toBe(true);

    const tomorrowDayKey = dayKeyForTimezone(tomorrow, timeZone);
    expect(
      isFocusShowing(entry, tomorrow, tomorrowDayKey, timeZone),
    ).toBe(false);
  });

  test("never shows a planned focus", () => {
    expect(
      isFocusShowing({ setAt: null, endsAt: tomorrow }, todayNow, todayDayKey, timeZone),
    ).toBe(false);
  });
});
