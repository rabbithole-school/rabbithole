import { describe, expect, it } from "vitest";
import {
  ABOVE_DELTA_CEILING,
  AT_GRADE_DELTA_CEILING,
  AT_GRADE_DELTA_FLOOR,
  enrolledGradeRank,
  gradeEquivalentFromRank,
  gradeEquivalentFromTag,
  gradeRelativeBand,
  levelDelta,
  schoolYearTenths,
} from "./gradeEquivalent";

// Local-time constructors, matching the module's Date.getMonth() read.
const on = (year: number, month: number, day = 15) =>
  new Date(year, month - 1, day);

describe("schoolYearTenths", () => {
  it("counts school months from August in tenths", () => {
    expect(schoolYearTenths(on(2026, 8, 1))).toBe(0.1);
    expect(schoolYearTenths(on(2026, 9))).toBe(0.2);
    expect(schoolYearTenths(on(2026, 11))).toBe(0.4);
    expect(schoolYearTenths(on(2026, 12, 31))).toBe(0.5);
    expect(schoolYearTenths(on(2027, 1, 1))).toBe(0.6);
    expect(schoolYearTenths(on(2027, 4, 30))).toBe(0.9);
  });

  it("holds May and the summer at the top of the scale", () => {
    expect(schoolYearTenths(on(2027, 5, 31))).toBe(0.9);
    expect(schoolYearTenths(on(2027, 6))).toBe(0.9);
    expect(schoolYearTenths(on(2027, 7, 31))).toBe(0.9);
  });
});

describe("enrolledGradeRank", () => {
  it("reads K as 0 and numbered grades as themselves, in any tag spelling", () => {
    expect(enrolledGradeRank("K")).toBe(0);
    expect(enrolledGradeRank("k")).toBe(0);
    expect(enrolledGradeRank("3")).toBe(3);
    expect(enrolledGradeRank("Grade 4")).toBe(4);
    expect(enrolledGradeRank("g2")).toBe(2);
  });

  it("is null for a missing or unrecognisable tag", () => {
    expect(enrolledGradeRank(null)).toBeNull();
    expect(enrolledGradeRank(undefined)).toBeNull();
    expect(enrolledGradeRank("")).toBeNull();
    expect(enrolledGradeRank("Kindergarten")).toBeNull();
    expect(enrolledGradeRank("2nd")).toBeNull();
  });
});

describe("gradeEquivalentFromTag", () => {
  it("adds the school month to the enrolled grade", () => {
    expect(gradeEquivalentFromTag("3", on(2026, 8))).toBeCloseTo(3.1);
    expect(gradeEquivalentFromTag("3", on(2026, 11))).toBeCloseTo(3.4);
    expect(gradeEquivalentFromTag("3", on(2027, 5))).toBeCloseTo(3.9);
    expect(gradeEquivalentFromTag("K", on(2026, 10))).toBeCloseTo(0.3);
  });

  it("is null without a recognisable enrolled grade", () => {
    expect(gradeEquivalentFromTag(null, on(2026, 11))).toBeNull();
    expect(gradeEquivalentFromTag("Kindergarten", on(2026, 11))).toBeNull();
  });
});

describe("gradeEquivalentFromRank", () => {
  it("matches the tag form for the same grade", () => {
    expect(gradeEquivalentFromRank(3, on(2026, 11))).toBeCloseTo(3.4);
    expect(gradeEquivalentFromRank(0, on(2026, 10))).toBeCloseTo(0.3);
  });

  it("is null for pre-K or no grade", () => {
    expect(gradeEquivalentFromRank(-1, on(2026, 11))).toBeNull();
    expect(gradeEquivalentFromRank(null, on(2026, 11))).toBeNull();
  });
});

describe("gradeRelativeBand", () => {
  it("bands a delta with the matrix's cut-offs, edges included in the lower band", () => {
    expect(gradeRelativeBand(-0.6)).toBe("behind");
    expect(gradeRelativeBand(AT_GRADE_DELTA_FLOOR)).toBe("onPace");
    expect(gradeRelativeBand(0)).toBe("onPace");
    expect(gradeRelativeBand(AT_GRADE_DELTA_CEILING)).toBe("onPace");
    expect(gradeRelativeBand(0.6)).toBe("ahead");
    expect(gradeRelativeBand(ABOVE_DELTA_CEILING)).toBe("ahead");
    expect(gradeRelativeBand(1.6)).toBe("farAhead");
  });

  it("reads the rounded delta, so a level a float residue past an edge stays in the band it displays", () => {
    // A third grader at 4.6 in November: GE 3.4, delta 1.2, ahead.
    expect(gradeRelativeBand(levelDelta(4.6, gradeEquivalentFromRank(3, on(2026, 11))!))).toBe("ahead");
    expect(gradeRelativeBand(levelDelta(4.54, 4))).toBe("onPace");
  });
});
