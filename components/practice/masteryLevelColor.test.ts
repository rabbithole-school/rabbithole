import { describe, expect, it } from "vitest";
import {
  ABOVE_DELTA_CEILING,
  levelDelta,
  AT_GRADE_DELTA_CEILING,
  AT_GRADE_DELTA_FLOOR,
  masteryLevelTint,
  masteryLevelTone,
  masteryLevelToneLabel,
} from "./masteryLevelColor";

describe("masteryLevelTone", () => {
  const ge = 4.4;

  it("bands exactly at the below/at boundary (Δ = -0.6 vs -0.5)", () => {
    expect(masteryLevelTone(ge - 0.6, ge)).toBe("below");
    expect(masteryLevelTone(ge + AT_GRADE_DELTA_FLOOR, ge)).toBe("at");
  });

  it("bands exactly at the at/above boundary (Δ = 0.5 vs 0.6)", () => {
    expect(masteryLevelTone(ge + AT_GRADE_DELTA_CEILING, ge)).toBe("at");
    expect(masteryLevelTone(ge + 0.6, ge)).toBe("above");
  });

  it("bands exactly at the above/wellAbove boundary (Δ = 1.5 vs 1.6)", () => {
    expect(masteryLevelTone(ge + ABOVE_DELTA_CEILING, ge)).toBe("above");
    expect(masteryLevelTone(ge + 1.6, ge)).toBe("wellAbove");
  });

  it("bands on the displayed one-decimal Δ, so the tint always matches the number shown", () => {
    // 4.54 − 4.0 displays as "+0.5" — it must read on pace, not ahead.
    expect(levelDelta(4.54, 4)).toBe(0.5);
    expect(masteryLevelTone(4.54, 4)).toBe("at");
    // 4.9 − 4.4 is 0.5000000000000009 in floating point; still on pace.
    expect(masteryLevelTone(4.9, 4.4)).toBe("at");
  });
});

describe("masteryLevelToneLabel", () => {
  it("names each band without an age qualifier", () => {
    expect(masteryLevelToneLabel(2, 4)).toBe("behind");
    expect(masteryLevelToneLabel(4, 4)).toBe("on pace");
    expect(masteryLevelToneLabel(5, 4)).toBe("ahead");
    expect(masteryLevelToneLabel(6, 4)).toBe("far ahead");
  });

  it("is null when there is no grade equivalent (no relative claim without an anchor)", () => {
    expect(masteryLevelToneLabel(3, null)).toBeNull();
  });
});

describe("masteryLevelTint", () => {
  describe("gradeRelative mode", () => {
    const ge = 4;

    it("bands exactly at each boundary", () => {
      expect(masteryLevelTint(ge - 0.6, ge, "gradeRelative")).toBe("#e6eaef");
      expect(masteryLevelTint(ge - 0.5, ge, "gradeRelative")).toBe("#dcf3e6");
      expect(masteryLevelTint(ge + 0.5, ge, "gradeRelative")).toBe("#dcf3e6");
      expect(masteryLevelTint(ge + 0.6, ge, "gradeRelative")).toBe("#cfece7");
      expect(masteryLevelTint(ge + 1.5, ge, "gradeRelative")).toBe("#cfece7");
      expect(masteryLevelTint(ge + 1.6, ge, "gradeRelative")).toBe("#bfe6de");
    });

    it("paints a scholar keeping pace with the school year on pace, all year", () => {
      // A third grader whose green share of grade 3 tracks the school month:
      // level 3.m against GE 3.m, Δ = 0, from August (.1) to April (.9).
      for (let tenth = 1; tenth <= 9; tenth++) {
        const pace = 3 + tenth / 10;
        expect(masteryLevelTint(pace, pace, "gradeRelative")).toBe("#dcf3e6");
      }
    });

    it("returns null (neutral, unwashed) when there's no grade equivalent", () => {
      expect(masteryLevelTint(5, null, "gradeRelative")).toBeNull();
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
