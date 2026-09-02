import { describe, expect, it } from "vitest";

import {
  addDaysToDayKey,
  ageOnDayKey,
  isBirthdayOnDayKey,
  nthBirthdayLabel,
  nthBirthdayOnDayKey,
  ordinal,
} from "./birthday";

describe("isBirthdayOnDayKey", () => {
  it("matches on month + day regardless of year", () => {
    expect(isBirthdayOnDayKey("2015-07-21", "2026-07-21")).toBe(true);
    expect(isBirthdayOnDayKey("2015-07-21", "2027-07-21")).toBe(true);
  });

  it("does not match a different day or month", () => {
    expect(isBirthdayOnDayKey("2015-07-21", "2026-07-22")).toBe(false);
    expect(isBirthdayOnDayKey("2015-07-21", "2026-08-21")).toBe(false);
  });

  it("tolerates a full ISO timestamp on either side", () => {
    expect(
      isBirthdayOnDayKey("2015-07-21T00:00:00.000Z", "2026-07-21"),
    ).toBe(true);
  });

  it("is a silent no-op for missing or malformed input", () => {
    expect(isBirthdayOnDayKey(null, "2026-07-21")).toBe(false);
    expect(isBirthdayOnDayKey(undefined, "2026-07-21")).toBe(false);
    expect(isBirthdayOnDayKey("", "2026-07-21")).toBe(false);
    expect(isBirthdayOnDayKey("nope", "2026-07-21")).toBe(false);
    expect(isBirthdayOnDayKey("2015-07-21", "")).toBe(false);
  });

  it("does not match a Feb-29 birthday in a common year (TODO(feb29))", () => {
    // Deliberate: no Feb-28/Mar-1 fallback. Simply does not fire.
    expect(isBirthdayOnDayKey("2016-02-29", "2026-02-28")).toBe(false);
    expect(isBirthdayOnDayKey("2016-02-29", "2026-03-01")).toBe(false);
    // Still fires on a real leap day.
    expect(isBirthdayOnDayKey("2016-02-29", "2028-02-29")).toBe(true);
  });
});

describe("nthBirthdayOnDayKey", () => {
  it("returns the integer age turning on the day", () => {
    expect(nthBirthdayOnDayKey("2015-07-21", "2026-07-21")).toBe(11);
    expect(nthBirthdayOnDayKey("2018-01-01", "2026-01-01")).toBe(8);
  });

  describe("ageOnDayKey", () => {
    it("derives age before, on, and after the birthday", () => {
      expect(ageOnDayKey("2017-07-17", "2026-07-16")).toBe(8);
      expect(ageOnDayKey("2017-07-17", "2026-07-17")).toBe(9);
      expect(ageOnDayKey("2017-07-17", "2026-08-10")).toBe(9);
    });

    it("returns null for missing, malformed, future, or implausible DOBs", () => {
      expect(ageOnDayKey(null, "2026-08-10")).toBeNull();
      expect(ageOnDayKey("bad", "2026-08-10")).toBeNull();
      expect(ageOnDayKey("2030-01-01", "2026-08-10")).toBeNull();
      expect(ageOnDayKey("1800-01-01", "2026-08-10")).toBeNull();
    });

    it("returns null for an impossible calendar date that still matches the regex", () => {
      expect(ageOnDayKey("2017-02-31", "2026-08-10")).toBeNull();
      expect(ageOnDayKey("2017-02-29", "2026-08-10")).toBeNull();
      expect(ageOnDayKey("2017-04-31", "2026-08-10")).toBeNull();
    });
  });

  it("returns null when it is not the birthday", () => {
    expect(nthBirthdayOnDayKey("2015-07-21", "2026-07-22")).toBeNull();
  });

  it("returns null for a non-positive age (future / same-year DOB)", () => {
    expect(nthBirthdayOnDayKey("2026-07-21", "2026-07-21")).toBeNull();
    expect(nthBirthdayOnDayKey("2030-07-21", "2026-07-21")).toBeNull();
  });

  it("returns null for malformed input", () => {
    expect(nthBirthdayOnDayKey(null, "2026-07-21")).toBeNull();
    expect(nthBirthdayOnDayKey("2015-07-21", "bad")).toBeNull();
  });
});

describe("ordinal", () => {
  it("handles ones-place suffixes", () => {
    expect(ordinal(1)).toBe("1st");
    expect(ordinal(2)).toBe("2nd");
    expect(ordinal(3)).toBe("3rd");
    expect(ordinal(4)).toBe("4th");
  });

  it("handles the 11/12/13 teens exception", () => {
    expect(ordinal(11)).toBe("11th");
    expect(ordinal(12)).toBe("12th");
    expect(ordinal(13)).toBe("13th");
  });

  it("handles higher numbers by trailing digit", () => {
    expect(ordinal(21)).toBe("21st");
    expect(ordinal(22)).toBe("22nd");
    expect(ordinal(23)).toBe("23rd");
    expect(ordinal(111)).toBe("111th");
    expect(ordinal(101)).toBe("101st");
  });
});

describe("nthBirthdayLabel", () => {
  it("formats an Nth Birthday label", () => {
    expect(nthBirthdayLabel("2015-07-21", "2026-07-21")).toBe("11th Birthday");
    expect(nthBirthdayLabel("2017-07-21", "2026-07-21")).toBe("9th Birthday");
  });

  it("returns null when it is not the birthday", () => {
    expect(nthBirthdayLabel("2015-07-21", "2026-07-22")).toBeNull();
  });
});

describe("addDaysToDayKey", () => {
  it("adds days within a month", () => {
    expect(addDaysToDayKey("2026-07-20", 0)).toBe("2026-07-20");
    expect(addDaysToDayKey("2026-07-20", 4)).toBe("2026-07-24");
  });

  it("rolls across a month boundary", () => {
    expect(addDaysToDayKey("2026-07-29", 4)).toBe("2026-08-02");
  });

  it("rolls across a year boundary", () => {
    expect(addDaysToDayKey("2026-12-30", 3)).toBe("2027-01-02");
  });

  it("returns the input unchanged when malformed", () => {
    expect(addDaysToDayKey("bad", 3)).toBe("bad");
  });
});
