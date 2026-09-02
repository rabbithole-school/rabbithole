import { describe, expect, it } from "vitest";
import {
  browserTimeZone,
  defaultTimeZone,
  formatTimeZoneLabel,
  listTimeZones,
  timeZoneCity,
  timeZoneOptions,
  tzOffsetLabel,
  tzOffsetMinutes,
} from "./timeZones";

describe("listTimeZones", () => {
  it("returns the full IANA list including well-known zones", () => {
    const zones = listTimeZones();
    // Whatever the runtime provides, it should be a broad, deduped list — far
    // more than the old 8-entry shortlist — and always include UTC.
    expect(zones.length).toBeGreaterThan(50);
    expect(zones).toContain("UTC");
    expect(zones).toContain("Pacific/Auckland");
    expect(zones).toContain("Europe/London");
    expect(new Set(zones).size).toBe(zones.length);
  });
});

describe("tzOffsetMinutes / tzOffsetLabel", () => {
  it("reports UTC as zero offset", () => {
    expect(tzOffsetMinutes("UTC", new Date("2026-01-15T00:00:00Z"))).toBe(0);
    expect(tzOffsetLabel("UTC", new Date("2026-01-15T00:00:00Z"))).toBe("UTC+0");
  });

  it("computes a whole-hour offset (no colon)", () => {
    // New York is UTC-5 in January (standard time), UTC-4 in July (DST).
    expect(tzOffsetLabel("America/New_York", new Date("2026-01-15T12:00:00Z"))).toBe(
      "UTC-5",
    );
    expect(tzOffsetLabel("America/New_York", new Date("2026-07-15T12:00:00Z"))).toBe(
      "UTC-4",
    );
  });

  it("formats a half-hour offset with a colon", () => {
    // India Standard Time is a fixed UTC+5:30 with no DST.
    expect(tzOffsetLabel("Asia/Kolkata", new Date("2026-01-15T12:00:00Z"))).toBe(
      "UTC+5:30",
    );
  });

  it("returns UTC for an unparseable zone", () => {
    expect(tzOffsetMinutes("Not/AZone")).toBeNull();
    expect(tzOffsetLabel("Not/AZone")).toBe("UTC");
  });
});

describe("timeZoneCity", () => {
  it("takes the last path segment and removes underscores", () => {
    expect(timeZoneCity("Pacific/Auckland")).toBe("Auckland");
    expect(timeZoneCity("America/Argentina/Buenos_Aires")).toBe("Buenos Aires");
    expect(timeZoneCity("UTC")).toBe("UTC");
  });
});

describe("formatTimeZoneLabel", () => {
  it("shows city, identifier, and offset", () => {
    const label = formatTimeZoneLabel(
      "Pacific/Auckland",
      new Date("2026-01-15T00:00:00Z"),
    );
    // NZ observes DST in January → UTC+13.
    expect(label).toBe("Auckland (Pacific/Auckland, UTC+13)");
  });

  it("drops the redundant identifier for single-segment zones", () => {
    expect(formatTimeZoneLabel("UTC", new Date("2026-01-15T00:00:00Z"))).toBe(
      "UTC (UTC+0)",
    );
  });
});

describe("timeZoneOptions", () => {
  it("maps every zone to {value, label} sorted by identifier", () => {
    const opts = timeZoneOptions();
    expect(opts.length).toBe(listTimeZones().length);
    const values = opts.map((o) => o.value);
    expect([...values].sort((a, b) => a.localeCompare(b))).toEqual(values);
    const auckland = opts.find((o) => o.value === "Pacific/Auckland");
    expect(auckland?.label).toContain("Auckland");
    expect(auckland?.label).toContain("Pacific/Auckland");
  });

  it("guarantees an already-stored exotic zone is present", () => {
    const opts = timeZoneOptions("Mars/Olympus_Mons");
    expect(opts.some((o) => o.value === "Mars/Olympus_Mons")).toBe(true);
  });
});

describe("defaultTimeZone", () => {
  it("returns an offerable zone", () => {
    expect(listTimeZones()).toContain(defaultTimeZone());
  });

  it("browserTimeZone resolves to a non-empty string", () => {
    expect(browserTimeZone().length).toBeGreaterThan(0);
  });
});
