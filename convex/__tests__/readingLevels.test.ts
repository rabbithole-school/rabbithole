import { describe, expect, test } from "vitest";
import {
  VALID_READING_LEVELS,
  isValidReadingLevel,
  normalizeReadingLevel,
  PRE_READER_LEVEL,
  legacyPreReaderSplit,
  readLevelOf,
  resolveEffectiveLevels,
  talkLevelLabel,
  talkLevelOf,
  talkLevelToNumber,
  writeModeOf,
  describeLevelsForPrompt,
} from "../lib/readingLevels";

describe("describeLevelsForPrompt — one phrase for every model-facing consumer", () => {
  test("a default reader-writer is the bare talk level (prompts unchanged)", () => {
    expect(describeLevelsForPrompt({ readingLevel: "3" })).toBe("3");
    expect(describeLevelsForPrompt({})).toBeNull();
  });

  test("a non-default read or write names all three, so 'K' never hides 'can't read yet'", () => {
    const migrated = describeLevelsForPrompt({ readingLevel: "K", readLevel: "listener" });
    const legacy = describeLevelsForPrompt({ readingLevel: PRE_READER_LEVEL });
    expect(legacy).toBe(migrated);
    expect(migrated).not.toBe("K");
    expect(migrated).toMatch(/^talk K; /);
    expect(describeLevelsForPrompt({ readingLevel: "7", writeMode: "voice" })).toMatch(
      /^talk 7; /,
    );
  });
});

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

describe("legacy pre-reader value (TRA-503)", () => {
  test("is no longer assignable as a talk level, nor a grade band", () => {
    // A scholar who can't read yet is talk K (or higher) + read listener.
    expect(isValidReadingLevel(PRE_READER_LEVEL)).toBe(false);
    expect(VALID_READING_LEVELS).not.toContain(PRE_READER_LEVEL);
  });

  test("the AI estimator never emits it (it normalizes to grades)", () => {
    expect(normalizeReadingLevel("pre-reader")).toBeNull();
  });

  test("dual-read: it means talk K + read listener", () => {
    expect(talkLevelOf(PRE_READER_LEVEL)).toBe("K");
    expect(readLevelOf({ readingLevel: PRE_READER_LEVEL })).toBe("listener");
    // An explicit read level wins over the inference.
    expect(
      readLevelOf({ readingLevel: PRE_READER_LEVEL, readLevel: "beginner" }),
    ).toBe("beginner");
  });

  test("legacyPreReaderSplit splits only the legacy value", () => {
    expect(legacyPreReaderSplit({ readingLevel: PRE_READER_LEVEL })).toEqual({
      readingLevel: "K",
      readLevel: "listener",
    });
    expect(
      legacyPreReaderSplit({ readingLevel: PRE_READER_LEVEL, readLevel: "beginner" }),
    ).toEqual({ readingLevel: "K", readLevel: "beginner" });
    expect(legacyPreReaderSplit({ readingLevel: "K" })).toBeNull();
    expect(legacyPreReaderSplit({ readingLevel: undefined })).toBeNull();
  });
});

describe("talk, read, write helpers (TRA-503)", () => {
  test("defaults: unset read is reader, unset write is own", () => {
    expect(readLevelOf({ readingLevel: "3" })).toBe("reader");
    expect(readLevelOf(null)).toBe("reader");
    expect(readLevelOf({ readLevel: "listener" })).toBe("listener");
    expect(writeModeOf({})).toBe("own");
    expect(writeModeOf(undefined)).toBe("own");
    expect(writeModeOf({ writeMode: "voice" })).toBe("voice");
  });

  test("talk labels and plot positions never say 'pre-reader' or NaN", () => {
    expect(talkLevelLabel("3.4")).toBe("Grade 3.4");
    expect(talkLevelLabel("K")).toBe("K");
    expect(talkLevelLabel("college")).toBe("College");
    expect(talkLevelLabel(PRE_READER_LEVEL)).toBe("K");
    expect(talkLevelLabel(null)).toBeNull();
    expect(talkLevelToNumber("3.4")).toBe(3.4);
    expect(talkLevelToNumber("K")).toBe(0.5);
    expect(talkLevelToNumber("college")).toBe(13);
    expect(talkLevelToNumber(PRE_READER_LEVEL)).toBe(0.5);
    expect(talkLevelToNumber("not a level")).toBeNull();
  });

  describe("resolveEffectiveLevels", () => {
    const scholar = { readingLevel: "4", readLevel: "beginner" as const, writeMode: "voice" as const };

    test("the scholar's own levels with no override", () => {
      expect(
        resolveEffectiveLevels({ isSyntheticView: false, session: {}, scholar }),
      ).toEqual({ talk: "4", read: "beginner", write: "voice" });
    });

    test("each override changes only its own dimension", () => {
      expect(
        resolveEffectiveLevels({
          isSyntheticView: false,
          session: { readingLevelOverride: "2" },
          scholar,
        }),
      ).toEqual({ talk: "2", read: "beginner", write: "voice" });
      expect(
        resolveEffectiveLevels({
          isSyntheticView: false,
          session: { readLevelOverride: "listener" },
          scholar,
        }),
      ).toEqual({ talk: "4", read: "listener", write: "voice" });
    });

    test("a synthetic view ignores the real scholar (reader, own unless overridden)", () => {
      expect(
        resolveEffectiveLevels({
          isSyntheticView: true,
          session: { testDriveSyntheticReadingLevel: "5" },
          scholar,
        }),
      ).toEqual({ talk: "5", read: "reader", write: "own" });
      expect(
        resolveEffectiveLevels({
          isSyntheticView: true,
          session: { testDriveSyntheticReadingLevel: PRE_READER_LEVEL },
          scholar,
        }),
      ).toEqual({ talk: "K", read: "listener", write: "own" });
      expect(
        resolveEffectiveLevels({
          isSyntheticView: true,
          session: { readingLevelOverride: "3", testDriveSyntheticReadingLevel: "5" },
          scholar: null,
        }),
      ).toEqual({ talk: "3", read: "reader", write: "own" });
    });

    test("nothing set anywhere → no talk level, reader, own", () => {
      expect(
        resolveEffectiveLevels({ isSyntheticView: false, session: {}, scholar: {} }),
      ).toEqual({ talk: null, read: "reader", write: "own" });
      expect(
        resolveEffectiveLevels({ isSyntheticView: true, session: {}, scholar }),
      ).toEqual({ talk: null, read: "reader", write: "own" });
    });
  });
});
