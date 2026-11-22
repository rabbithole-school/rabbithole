import { describe, expect, test } from "vitest";
import {
  normalizeUnitGrade,
  parseUnitGrade,
  unitFitsGradeFilter,
  unitGradeDisplay,
  unitGradeFilterOptions,
  unitGradePickerState,
  withUnitGradeFrom,
  withUnitGradeTo,
} from "./unitGrade";

describe("normalizeUnitGrade", () => {
  // Every spelling the active teacher units in production used (2026-11-19).
  test.each([
    ["3-5", "3-5"],
    ["K-2", "K-2"],
    ["2", "2"],
    ["K-5", "K-5"],
    ["3", "3"],
    ["7", "7"],
    ["3-6", "3-6"],
    ["4", "4"],
    ["5", "5"],
    ["Grade 5 enrichment", "5"],
    ["4-6", "4-6"],
    ["2-3", "2-3"],
    ["4-5", "4-5"],
    ["4-8", "4-8"],
    ["2-5", "2-5"],
    ["6-8", "6-8"],
    ["K-6", "K-6"],
    ["K-3", "K-3"],
    ["1-3", "1-3"],
    ["1-5", "1-5"],
    ["1", "1"],
    ["1-4", "1-4"],
    ["3-8", "3-8"],
    ["2-4", "2-4"],
    ["3-4", "3-4"],
    ["k-1", "K-1"],
    ["4th", "4"],
    ["5th grade", "5"],
  ])("%s → %s", (raw, canonical) => {
    expect(normalizeUnitGrade(raw)).toBe(canonical);
  });

  test("blank is no grade, not a grade", () => {
    expect(normalizeUnitGrade("")).toBeNull();
    expect(normalizeUnitGrade("   ")).toBeNull();
    expect(normalizeUnitGrade(null)).toBeNull();
    expect(normalizeUnitGrade(undefined)).toBeNull();
  });

  test("reads the other common ways of writing a grade or a span", () => {
    expect(normalizeUnitGrade("3rd-5th")).toBe("3-5");
    expect(normalizeUnitGrade("Grades 3 to 5")).toBe("3-5");
    expect(normalizeUnitGrade("grade 4 through 6")).toBe("4-6");
    expect(normalizeUnitGrade("K–2")).toBe("K-2");
    expect(normalizeUnitGrade("Kindergarten")).toBe("K");
    expect(normalizeUnitGrade(" 1st grade ")).toBe("1");
    expect(normalizeUnitGrade("Gr. 2")).toBe("2");
    expect(normalizeUnitGrade("5-3")).toBe("3-5");
    expect(normalizeUnitGrade("4-4")).toBe("4");
    expect(normalizeUnitGrade("3-5 advanced")).toBe("3-5");
    expect(normalizeUnitGrade("Grade 4 extension only")).toBe("4");
  });

  test("can't read anything outside K–8, ages, or words it doesn't know after the grade", () => {
    expect(normalizeUnitGrade("9")).toBeNull();
    expect(normalizeUnitGrade("6-10")).toBeNull();
    expect(normalizeUnitGrade("PreK")).toBeNull();
    expect(normalizeUnitGrade("Pre-K")).toBeNull();
    expect(normalizeUnitGrade("5 and up")).toBeNull();
    expect(normalizeUnitGrade("Ages 6-9")).toBeNull();
    expect(normalizeUnitGrade("7-8 year olds")).toBeNull();
    expect(normalizeUnitGrade("5 years old")).toBeNull();
    expect(normalizeUnitGrade("6-8 yrs")).toBeNull();
    expect(normalizeUnitGrade("5 k")).toBeNull();
    expect(normalizeUnitGrade("k k")).toBeNull();
    expect(normalizeUnitGrade("Grade 5 math")).toBeNull();
    expect(normalizeUnitGrade("3-5, 7")).toBeNull();
    expect(normalizeUnitGrade("Middle school")).toBeNull();
    expect(normalizeUnitGrade("all")).toBeNull();
    expect(normalizeUnitGrade("3/4")).toBeNull();
  });
});

describe("parseUnitGrade", () => {
  test("gives ranks, low first", () => {
    expect(parseUnitGrade("K-2")).toEqual({ from: 0, to: 2 });
    expect(parseUnitGrade("8-6")).toEqual({ from: 6, to: 8 });
    expect(parseUnitGrade("5")).toEqual({ from: 5, to: 5 });
  });
});

describe("unitGradeDisplay", () => {
  test("uses the house grade labels, and shows unreadable text as-is", () => {
    expect(unitGradeDisplay("3-5")).toBe("Grade 3–5");
    expect(unitGradeDisplay("K-2")).toBe("Grade K–2");
    expect(unitGradeDisplay("5")).toBe("Grade 5");
    expect(unitGradeDisplay("K")).toBe("Kindergarten");
    expect(unitGradeDisplay("4th")).toBe("Grade 4");
    expect(unitGradeDisplay(" Middle school ")).toBe("Middle school");
    expect(unitGradeDisplay("")).toBeNull();
    expect(unitGradeDisplay(undefined)).toBeNull();
  });
});

describe("unitGradePickerState", () => {
  test("a readable grade shows as its span; anything else as-is", () => {
    expect(unitGradePickerState("3-5")).toEqual({ span: { from: 3, to: 5 }, unreadable: null });
    expect(unitGradePickerState("Grade 5 enrichment")).toEqual({
      span: { from: 5, to: 5 },
      unreadable: null,
    });
    expect(unitGradePickerState("Middle school")).toEqual({ span: null, unreadable: "Middle school" });
    expect(unitGradePickerState("  ")).toEqual({ span: null, unreadable: null });
  });
});

describe("picking a grade", () => {
  test("the first grade: a single grade stays single, a span keeps its end", () => {
    expect(withUnitGradeFrom(null, 3)).toBe("3");
    expect(withUnitGradeFrom({ from: 5, to: 5 }, 3)).toBe("3");
    expect(withUnitGradeFrom({ from: 3, to: 5 }, 0)).toBe("K-5");
    expect(withUnitGradeFrom({ from: 3, to: 5 }, 4)).toBe("4-5");
    expect(withUnitGradeFrom({ from: 3, to: 5 }, 5)).toBe("5");
    expect(withUnitGradeFrom({ from: 3, to: 5 }, 7)).toBe("7");
    expect(withUnitGradeFrom({ from: 3, to: 5 }, null)).toBeNull();
  });

  test("the last grade", () => {
    expect(withUnitGradeTo({ from: 3, to: 3 }, 5)).toBe("3-5");
    expect(withUnitGradeTo({ from: 3, to: 5 }, 3)).toBe("3");
    expect(withUnitGradeTo({ from: 0, to: 2 }, 8)).toBe("K-8");
  });
});

describe("the Grade filter", () => {
  test("offers every grade a readable unit covers, lowest first", () => {
    expect(
      unitGradeFilterOptions([
        { gradeLevel: "3-5" },
        { gradeLevel: "K" },
        { gradeLevel: "4" },
        { gradeLevel: "Middle school" },
        { gradeLevel: undefined },
      ]),
    ).toEqual(["K", "3", "4", "5"]);
    expect(unitGradeFilterOptions([])).toEqual([]);
  });

  test("a unit fits a grade its span covers", () => {
    expect(unitFitsGradeFilter("3-5", "4")).toBe(true);
    expect(unitFitsGradeFilter("3-5", "3")).toBe(true);
    expect(unitFitsGradeFilter("3-5", "6")).toBe(false);
    expect(unitFitsGradeFilter("K-2", "K")).toBe(true);
    expect(unitFitsGradeFilter("5", "5")).toBe(true);
    expect(unitFitsGradeFilter("Middle school", "6")).toBe(false);
    expect(unitFitsGradeFilter(undefined, "4")).toBe(false);
  });
});
