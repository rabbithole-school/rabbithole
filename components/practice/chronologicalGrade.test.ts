import { describe, expect, it } from "vitest";
import {
  chronologicalGradeFromDob,
  gradeForAgeDisagreesWithTagged,
  gradeForAgeFromDob,
} from "./chronologicalGrade";

const MS_PER_YEAR = 365.2425 * 24 * 60 * 60 * 1000;

/** DOB (ISO) such that `now - dob` is exactly `ageYears` years, per the
 *  same 365.2425-day-year measure `gradeForAgeFromDob` uses. */
function dobForAge(now: Date, ageYears: number): string {
  const dob = new Date(now.getTime() - ageYears * MS_PER_YEAR);
  return dob.toISOString().slice(0, 10);
}

describe("chronologicalGradeFromDob", () => {
  it("matches the schema's own worked example (2018-03-15, now Aug 2026)", () => {
    const result = chronologicalGradeFromDob("2018-03-15", new Date("2026-08-18"));
    expect(result).toEqual({ rank: 3, label: "3" });
  });

  it("a birthday just after the cutoff shifts K-entry a year later", () => {
    const result = chronologicalGradeFromDob("2018-09-02", new Date("2026-08-18"));
    expect(result).toEqual({ rank: 2, label: "2" });
  });

  it("the exact Jul 31 cutoff boundary: born on the 31st vs the next day", () => {
    const onCutoff = chronologicalGradeFromDob("2021-07-31", new Date("2026-08-18"));
    const dayAfter = chronologicalGradeFromDob("2021-08-01", new Date("2026-08-18"));
    expect(onCutoff).toEqual({ rank: 0, label: "K" });
    // One day later misses the cutoff, entering K a year later, so this
    // scholar's chronological grade this AY clamps below K.
    expect(dayAfter).toEqual({ rank: 0, label: "pre-K" });
  });

  it("the academic-year rollover: Jul vs Aug of the same calendar year", () => {
    const dob = "2018-03-15";
    const beforeRollover = chronologicalGradeFromDob(dob, new Date("2026-07-15"));
    const afterRollover = chronologicalGradeFromDob(dob, new Date("2026-08-15"));
    expect(beforeRollover).toEqual({ rank: 2, label: "2" });
    expect(afterRollover).toEqual({ rank: 3, label: "3" });
  });

  it("clamps a raw-negative rank to pre-K", () => {
    // Born a year before the "now" window would even see K-entry.
    const result = chronologicalGradeFromDob("2025-01-01", new Date("2026-08-18"));
    expect(result?.rank).toBe(0);
    expect(result?.label).toBe("pre-K");
  });

  it("clamps a raw rank above 8 to 8+", () => {
    const result = chronologicalGradeFromDob("2000-01-01", new Date("2026-08-18"));
    expect(result?.rank).toBe(8);
    expect(result?.label).toBe("8+");
  });

  it("returns null for missing, empty, or unparseable DOB", () => {
    const now = new Date("2026-08-18");
    expect(chronologicalGradeFromDob(null, now)).toBeNull();
    expect(chronologicalGradeFromDob(undefined, now)).toBeNull();
    expect(chronologicalGradeFromDob("", now)).toBeNull();
    expect(chronologicalGradeFromDob("not-a-date", now)).toBeNull();
    expect(chronologicalGradeFromDob("2018/03/15", now)).toBeNull();
    expect(chronologicalGradeFromDob("2018-13-01", now)).toBeNull();
    // Range-checks fine but isn't a real calendar date (would roll to Mar 3).
    expect(chronologicalGradeFromDob("2018-02-31", now)).toBeNull();
  });
});

describe("gradeForAgeFromDob", () => {
  const now = new Date("2026-08-18T00:00:00.000Z");

  it("matches the spec's own worked examples (§4.1a)", () => {
    expect(gradeForAgeFromDob(dobForAge(now, 9.1), now)).toBeCloseTo(4.1, 1);
    expect(gradeForAgeFromDob(dobForAge(now, 11.0), now)).toBeCloseTo(6.0, 1);
    expect(gradeForAgeFromDob(dobForAge(now, 6.8), now)).toBeCloseTo(1.8, 1);
    expect(gradeForAgeFromDob(dobForAge(now, 5.3), now)).toBeCloseTo(0.3, 1);
  });

  it("floors at 0 rather than going negative for a younger-than-K-age child", () => {
    // 4.5 years old: raw would be -0.5, but a pre-K-age child reads 0.
    expect(gradeForAgeFromDob(dobForAge(now, 4.5), now)).toBe(0);
  });

  it("has no upper clamp — a much older child keeps climbing", () => {
    const result = gradeForAgeFromDob(dobForAge(now, 15), now);
    expect(result).toBeCloseTo(10, 1);
  });

  it("returns null for missing, empty, or unparseable DOB", () => {
    expect(gradeForAgeFromDob(null, now)).toBeNull();
    expect(gradeForAgeFromDob(undefined, now)).toBeNull();
    expect(gradeForAgeFromDob("", now)).toBeNull();
    expect(gradeForAgeFromDob("not-a-date", now)).toBeNull();
    expect(gradeForAgeFromDob("2018/03/15", now)).toBeNull();
    expect(gradeForAgeFromDob("2018-02-31", now)).toBeNull();
  });
});

describe("gradeForAgeDisagreesWithTagged", () => {
  it("false when the ages agree (within tolerance)", () => {
    expect(gradeForAgeDisagreesWithTagged(4.1, "4")).toBe(false);
    expect(gradeForAgeDisagreesWithTagged(4.49, "4")).toBe(false); // rounds to 4
  });

  it("true when the rounded age is a whole grade or more off", () => {
    expect(gradeForAgeDisagreesWithTagged(6.0, "4")).toBe(true); // accelerated
    expect(gradeForAgeDisagreesWithTagged(2.0, "4")).toBe(true); // held back
  });

  it("is a >= 1 tolerance band, not a hair-trigger", () => {
    // round(4.5) = 5 (banker's-unaffected JS rounding), so |5 - 4| = 1 → true;
    // just under that boundary should read false either side of 4.
    expect(gradeForAgeDisagreesWithTagged(4.5, "4")).toBe(true);
    expect(gradeForAgeDisagreesWithTagged(3.51, "4")).toBe(false); // rounds to 4
  });

  it("normalizes legacy tagged-grade shapes (Grade 2 / g2 / K)", () => {
    expect(gradeForAgeDisagreesWithTagged(2.0, "Grade 2")).toBe(false);
    expect(gradeForAgeDisagreesWithTagged(2.0, "g2")).toBe(false);
    expect(gradeForAgeDisagreesWithTagged(0.0, "K")).toBe(false);
    expect(gradeForAgeDisagreesWithTagged(1.0, "K")).toBe(true);
  });

  it("false when either side is unknown", () => {
    expect(gradeForAgeDisagreesWithTagged(null, "4")).toBe(false);
    expect(gradeForAgeDisagreesWithTagged(4.0, null)).toBe(false);
    expect(gradeForAgeDisagreesWithTagged(4.0, undefined)).toBe(false);
    expect(gradeForAgeDisagreesWithTagged(4.0, "")).toBe(false);
    expect(gradeForAgeDisagreesWithTagged(4.0, "Kindergarten")).toBe(false);
  });
});
