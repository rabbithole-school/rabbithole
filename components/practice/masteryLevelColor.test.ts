import { describe, expect, it } from "vitest";
import { MASTERY_DOT_COLOR } from "@/shared/masteryDialPalette";
import {
  ABOVE_DELTA_CEILING,
  AT_GRADE_DELTA_FLOOR,
  masteryLevelColor,
  masteryLevelTint,
  masteryLevelTone,
  masteryLevelToneLabel,
} from "./masteryLevelColor";

describe("masteryLevelColor / masteryLevelTone", () => {
  const chronoRank = 5;

  it("bands exactly at the below/at boundary (Δ = -0.76 vs -0.75)", () => {
    expect(masteryLevelTone(chronoRank - 0.76, chronoRank)).toBe("below");
    expect(masteryLevelTone(chronoRank + AT_GRADE_DELTA_FLOOR, chronoRank)).toBe("at");
  });

  it("bands exactly at the at/above boundary (Δ = 0.75 vs 0.76)", () => {
    expect(masteryLevelTone(chronoRank + 0.75, chronoRank)).toBe("at");
    expect(masteryLevelTone(chronoRank + 0.76, chronoRank)).toBe("above");
  });

  it("bands exactly at the above/wellAbove boundary (Δ = 1.75 vs 1.76)", () => {
    expect(masteryLevelTone(chronoRank + ABOVE_DELTA_CEILING, chronoRank)).toBe("above");
    expect(masteryLevelTone(chronoRank + 1.76, chronoRank)).toBe("wellAbove");
  });

  it("colors each tone from the shared mastery vocabulary", () => {
    expect(masteryLevelColor(chronoRank - 1, chronoRank)).toBe("#64748b");
    expect(masteryLevelColor(chronoRank, chronoRank)).toBe(MASTERY_DOT_COLOR.fluent);
    expect(masteryLevelColor(chronoRank + 1, chronoRank)).toBe(MASTERY_DOT_COLOR.overlearned);
    expect(masteryLevelColor(chronoRank + 2, chronoRank)).toBe("#0b5a54");
  });

  it("the at/above hexes strictly equal the imported palette constants", () => {
    expect(masteryLevelColor(chronoRank, chronoRank)).toBe(MASTERY_DOT_COLOR.fluent);
    expect(MASTERY_DOT_COLOR.fluent).toBe("#3a9e6b");
    expect(masteryLevelColor(chronoRank + 1, chronoRank)).toBe(MASTERY_DOT_COLOR.overlearned);
    expect(MASTERY_DOT_COLOR.overlearned).toBe("#0f766e");
  });

  it("falls back to the absolute ramp when chronoRank is null, at each boundary", () => {
    expect(masteryLevelColor(2.9, null)).toBe("#5aa87a");
    expect(masteryLevelColor(3.0, null)).toBe("#3f8f5f");
    expect(masteryLevelColor(4.9, null)).toBe("#3f8f5f");
    expect(masteryLevelColor(5.0, null)).toBe("#166534");
  });

  it("tone is always 'at' in fallback (null chronoRank) mode", () => {
    expect(masteryLevelTone(0, null)).toBe("at");
    expect(masteryLevelTone(8, null)).toBe("at");
  });

  it("toneLabel returns the grade-relative phrase for each band", () => {
    expect(masteryLevelToneLabel(chronoRank - 1, chronoRank)).toBe("behind for age");
    expect(masteryLevelToneLabel(chronoRank, chronoRank)).toBe("on pace for age");
    expect(masteryLevelToneLabel(chronoRank + 1, chronoRank)).toBe("ahead for age");
    expect(masteryLevelToneLabel(chronoRank + 2, chronoRank)).toBe("far ahead for age");
  });

  it("toneLabel is null when chronoRank is null (no relative claim without an anchor)", () => {
    expect(masteryLevelToneLabel(3, null)).toBeNull();
  });

  it("toneLabel works with a float (continuous grade-for-age) anchor", () => {
    // 4.9 at grade-for-age 4.1: Δ = 0.8, just over the +0.75 "on pace" ceiling.
    expect(masteryLevelToneLabel(4.9, 4.1)).toBe("ahead for age");
    // 4.8 at grade-for-age 4.1: Δ = 0.7, still "on pace".
    expect(masteryLevelToneLabel(4.8, 4.1)).toBe("on pace for age");
  });
});

describe("masteryLevelTint", () => {
  describe("ageRelative mode", () => {
    const gradeForAge = 4;

    it("bands exactly at the below/at boundary (Δ = -0.76 vs -0.75)", () => {
      expect(masteryLevelTint(gradeForAge - 0.76, gradeForAge, "ageRelative")).toBe("#e6eaef");
      expect(
        masteryLevelTint(gradeForAge + AT_GRADE_DELTA_FLOOR, gradeForAge, "ageRelative"),
      ).toBe("#dcf3e6");
    });

    it("bands exactly at the at/above boundary (Δ = 0.75 vs 0.76)", () => {
      expect(masteryLevelTint(gradeForAge + 0.75, gradeForAge, "ageRelative")).toBe("#dcf3e6");
      expect(masteryLevelTint(gradeForAge + 0.76, gradeForAge, "ageRelative")).toBe("#cfece7");
    });

    it("bands exactly at the above/far-ahead boundary (Δ = 1.75 vs 1.76)", () => {
      expect(
        masteryLevelTint(gradeForAge + ABOVE_DELTA_CEILING, gradeForAge, "ageRelative"),
      ).toBe("#cfece7");
      expect(masteryLevelTint(gradeForAge + 1.76, gradeForAge, "ageRelative")).toBe("#bfe6de");
    });

    it("works against a continuous (non-integer) grade-for-age anchor", () => {
      // level 4.9 at grade-for-age 4.1: Δ = 0.8 → ahead.
      expect(masteryLevelTint(4.9, 4.1, "ageRelative")).toBe("#cfece7");
      // level 4.8 at grade-for-age 4.1: Δ = 0.7 → on pace.
      expect(masteryLevelTint(4.8, 4.1, "ageRelative")).toBe("#dcf3e6");
    });

    it("returns null (neutral, unwashed) when there's no age anchor", () => {
      expect(masteryLevelTint(5, null, "ageRelative")).toBeNull();
    });
  });

  describe("absolute mode", () => {
    it("bands exactly at each K–8 boundary", () => {
      expect(masteryLevelTint(1.99, null, "absolute")).toBe("#edf6f2");
      expect(masteryLevelTint(2, null, "absolute")).toBe("#d2eae0");
      expect(masteryLevelTint(3.99, null, "absolute")).toBe("#d2eae0");
      expect(masteryLevelTint(4, null, "absolute")).toBe("#a9d8ca");
      expect(masteryLevelTint(5.99, null, "absolute")).toBe("#a9d8ca");
      expect(masteryLevelTint(6, null, "absolute")).toBe("#7cc0b4");
      expect(masteryLevelTint(7.99, null, "absolute")).toBe("#7cc0b4");
      expect(masteryLevelTint(8, null, "absolute")).toBe("#57aca1");
      expect(masteryLevelTint(9, null, "absolute")).toBe("#57aca1");
    });

    it("ignores the anchor entirely — a non-null one changes nothing", () => {
      expect(masteryLevelTint(4.5, 4.5, "absolute")).toBe(masteryLevelTint(4.5, null, "absolute"));
    });
  });
});
