import { describe, it, expect } from "vitest";

import { isWithinPrepTime, type PrepTimeBlock } from "../prepTime";

// A weekday afternoon Prep Time block in Hawaii (school tz). 2026-07-01 is a
// Wednesday; 2026-07-04 is a Saturday.
const HST: PrepTimeBlock = {
  key: "prepTime",
  label: "Prep Time",
  startLocal: "14:30",
  endLocal: "15:00",
  days: [1, 2, 3, 4, 5], // Mon–Fri
  timezone: "Pacific/Honolulu",
};

// A UTC instant that maps to a given Honolulu wall-clock time (HST = UTC-10, no DST).
function hstInstant(isoDate: string, hhmm: string): number {
  const [y, mo, d] = isoDate.split("-").map(Number);
  const [h, m] = hhmm.split(":").map(Number);
  // Honolulu is UTC-10 → the UTC instant is the local time + 10h.
  return Date.UTC(y, mo - 1, d, h, m) + 10 * 60 * 60 * 1000;
}

describe("isWithinPrepTime", () => {
  it("is true inside the window on a scheduled weekday", () => {
    expect(isWithinPrepTime(HST, hstInstant("2026-07-01", "14:45"))).toBe(true);
  });

  it("is true exactly at the start (inclusive)", () => {
    expect(isWithinPrepTime(HST, hstInstant("2026-07-01", "14:30"))).toBe(true);
  });

  it("is false exactly at the end (half-open — pin clears at end)", () => {
    expect(isWithinPrepTime(HST, hstInstant("2026-07-01", "15:00"))).toBe(false);
  });

  it("is false before the window", () => {
    expect(isWithinPrepTime(HST, hstInstant("2026-07-01", "14:29"))).toBe(false);
  });

  it("is false after the window", () => {
    expect(isWithinPrepTime(HST, hstInstant("2026-07-01", "15:01"))).toBe(false);
  });

  it("is false on a weekend even inside the clock window (day filter)", () => {
    // 2026-07-04 is a Saturday (ISO 6), not in Mon–Fri.
    expect(isWithinPrepTime(HST, hstInstant("2026-07-04", "14:45"))).toBe(false);
  });

  it("returns false for a null/undefined block", () => {
    expect(isWithinPrepTime(null, Date.now())).toBe(false);
    expect(isWithinPrepTime(undefined, Date.now())).toBe(false);
  });

  it("returns false for a malformed time config", () => {
    const bad = { ...HST, startLocal: "2:30pm" };
    expect(isWithinPrepTime(bad, hstInstant("2026-07-01", "14:45"))).toBe(false);
  });

  it("returns false for an invalid timezone", () => {
    const bad = { ...HST, timezone: "Not/AZone" };
    expect(isWithinPrepTime(bad, hstInstant("2026-07-01", "14:45"))).toBe(false);
  });

  it("respects the timezone — same instant differs by zone", () => {
    // 00:45 UTC on 2026-07-02 = 14:45 HST (Wed, in-window) but is already
    // 20:45 in New York (Wed, out of window). The block's own tz wins.
    const instant = Date.parse("2026-07-02T00:45:00Z");
    expect(isWithinPrepTime(HST, instant)).toBe(true);
    const ny = { ...HST, timezone: "America/New_York" };
    expect(isWithinPrepTime(ny, instant)).toBe(false);
  });
});
