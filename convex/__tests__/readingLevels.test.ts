import { describe, expect, test } from "vitest";
import {
  VALID_READING_LEVELS,
  isValidReadingLevel,
  normalizeReadingLevel,
  isPreReader,
  PRE_READER_LEVEL,
} from "../lib/readingLevels";

describe("reading levels — granularity + normalization", () => {
  test("VALID_READING_LEVELS spans K → 0.1 grades → college", () => {
    expect(VALID_READING_LEVELS[0]).toBe("K");
    expect(VALID_READING_LEVELS.at(-1)).toBe("college");
    // The whole point of this feature: tenth-of-a-grade values are valid.
    expect(isValidReadingLevel("7")).toBe(true);
    expect(isValidReadingLevel("7.3")).toBe(true);
    expect(isValidReadingLevel("12.9")).toBe(true);
    // K=1, grades 1-12 each contribute 1 whole + 9 tenths, plus college.
    expect(VALID_READING_LEVELS.length).toBe(1 + 12 * 10 + 1);
    // No "7.0" canonical form — a whole grade is "7".
    expect(isValidReadingLevel("7.0")).toBe(false);
    expect(isValidReadingLevel("13")).toBe(false);
  });

  test("normalizeReadingLevel maps model answers to canonical levels", () => {
    // Granular answers pass through.
    expect(normalizeReadingLevel("7.3")).toBe("7.3");
    expect(normalizeReadingLevel("Grade 7.3")).toBe("7.3");
    expect(normalizeReadingLevel("  4.9  ")).toBe("4.9");
    // Whole grades and ".0" tenths collapse to the whole grade.
    expect(normalizeReadingLevel("7")).toBe("7");
    expect(normalizeReadingLevel("7.0")).toBe("7");
    expect(normalizeReadingLevel("grade 5")).toBe("5");
    // Only the first decimal digit is kept.
    expect(normalizeReadingLevel("7.35")).toBe("7.3");
    // K / college synonyms.
    expect(normalizeReadingLevel("K")).toBe("K");
    expect(normalizeReadingLevel("kindergarten")).toBe("K");
    expect(normalizeReadingLevel("college")).toBe("college");
    expect(normalizeReadingLevel("University level")).toBe("college");
    // Out-of-range clamps.
    expect(normalizeReadingLevel("0")).toBe("K");
    expect(normalizeReadingLevel("13")).toBe("college");
    expect(normalizeReadingLevel("15.4")).toBe("college");
    // Unmappable → null (so the AI estimator stores nothing).
    expect(normalizeReadingLevel("")).toBeNull();
    expect(normalizeReadingLevel("advanced")).toBeNull();
  });

  test("every normalized result is itself a valid level", () => {
    for (const raw of ["7.3", "7", "Grade 9.9", "kindergarten", "college", "13"]) {
      const norm = normalizeReadingLevel(raw);
      expect(norm).not.toBeNull();
      expect(isValidReadingLevel(norm as string)).toBe(true);
    }
  });
});

describe("pre-reader tier", () => {
  test("is a distinct tier, not a grade band", () => {
    // A teacher may assign it, but it is NOT part of the grade enumeration
    // (so grade dropdowns + the estimator's normalization stay grade-only).
    expect(isValidReadingLevel(PRE_READER_LEVEL)).toBe(true);
    expect(VALID_READING_LEVELS).not.toContain(PRE_READER_LEVEL);
  });

  test("isPreReader matches only the tier", () => {
    expect(isPreReader(PRE_READER_LEVEL)).toBe(true);
    expect(isPreReader("pre-reader")).toBe(true);
    expect(isPreReader("K")).toBe(false);
    expect(isPreReader("1")).toBe(false);
    expect(isPreReader(null)).toBe(false);
    expect(isPreReader(undefined)).toBe(false);
    expect(isPreReader("")).toBe(false);
  });

  test("the AI estimator never emits the tier (it normalizes to grades)", () => {
    expect(normalizeReadingLevel("pre-reader")).toBeNull();
  });
});
