import { describe, expect, test } from "vitest";
import {
  buildEarlyReaderSection,
  buildPreReaderSection,
  buildYoungReaderTurnRules,
} from "../prompts";
import { buildSystemPrompt, buildSystemPromptParts } from "../sessionHelpers";
import {
  PRE_READER_LEVEL,
  VALID_READING_LEVELS,
  isEarlyReader,
  needsYoungReaderTurnRules,
} from "../lib/readingLevels";

// Selection logic for the early-reader register (reading levels K–2.9). These
// tests pin WHICH levels get the register and that it only fills the one
// reading-level slot. They deliberately do not assert the register's wording
// (that is judged by eval, not by string match): the builder is the oracle.

describe("isEarlyReader — the K–2.9 band", () => {
  test.each(["K", "1", "1.1", "1.9", "2", "2.5", "2.9"])("%s is an early reader", (level) => {
    expect(isEarlyReader(level)).toBe(true);
  });

  test.each(["3", "3.1", "5", "12.9", "college"])("%s is not", (level) => {
    expect(isEarlyReader(level)).toBe(false);
  });

  test("pre-reader, unset, and non-canonical values are not early readers", () => {
    expect(isEarlyReader(PRE_READER_LEVEL)).toBe(false);
    expect(isEarlyReader(null)).toBe(false);
    expect(isEarlyReader(undefined)).toBe(false);
    expect(isEarlyReader("")).toBe(false);
    expect(isEarlyReader("2.0")).toBe(false); // not canonical ("2" is)
    expect(isEarlyReader("kindergarten")).toBe(false);
  });

  test("exactly the first 21 canonical levels (K, 1–1.9, 2–2.9) qualify", () => {
    const early = VALID_READING_LEVELS.filter((l) => isEarlyReader(l));
    expect(early).toEqual(VALID_READING_LEVELS.slice(0, 21));
    expect(early.at(-1)).toBe("2.9");
  });
});

describe("buildSystemPrompt — reading-level slot selection", () => {
  const build = (readingLevel: string | null) =>
    buildSystemPrompt(null, readingLevel, "Kai", null, null, null);

  test.each(["K", "1.4", "2.9"])("%s renders the early-reader register", (level) => {
    expect(build(level)).toContain(buildEarlyReaderSection(level));
  });

  test.each(["3", "5", "college"])("%s does not", (level) => {
    expect(build(level)).not.toContain(buildEarlyReaderSection(level));
  });

  test("pre-reader keeps its own register, not the early-reader one", () => {
    const prompt = build(PRE_READER_LEVEL);
    expect(prompt).toContain(buildPreReaderSection());
    expect(prompt).not.toContain(buildEarlyReaderSection(PRE_READER_LEVEL));
  });

  test("only the one slot differs: removing it gives the unset-level prompt", () => {
    // An unset level gets no reading-level section at all, so stripping an
    // early reader's register (and the young-reader turn rules that ride in
    // the same slot) must leave exactly that prompt.
    const strip = (level: string) =>
      build(level)
        .replace(buildEarlyReaderSection(level), "")
        .replace(buildYoungReaderTurnRules(), "");
    expect(strip("2")).toBe(build(null));
    expect(strip("K")).toBe(build(null));
  });

  test("the register sits in the cached stable prefix", () => {
    const { stable, dynamic } = buildSystemPromptParts(null, "1", "Kai", null, null, null);
    expect(stable).toContain(buildEarlyReaderSection("1"));
    expect(dynamic).not.toContain(buildEarlyReaderSection("1"));
  });
});

// The young-reader turn rules (TRA-501): WHO gets them is one helper, so the
// talk/read/write split (TRA-503) can re-point it without touching callers.
describe("needsYoungReaderTurnRules — the one seam", () => {
  test.each(["pre-reader", "K", "1", "2.9"])("%s gets the turn rules", (level) => {
    expect(needsYoungReaderTurnRules(level)).toBe(true);
  });

  test.each(["3", "5", "college", "", null, undefined])("%s does not", (level) => {
    expect(needsYoungReaderTurnRules(level)).toBe(false);
  });

  test("the prompt carries the turn rules exactly when the helper says so", () => {
    const build = (readingLevel: string | null) =>
      buildSystemPrompt(null, readingLevel, "Kai", null, null, null);
    for (const level of [PRE_READER_LEVEL, ...VALID_READING_LEVELS, null]) {
      expect(build(level).includes(buildYoungReaderTurnRules())).toBe(
        needsYoungReaderTurnRules(level),
      );
    }
  });

  test("the turn rules follow the register in the cached stable prefix", () => {
    for (const level of [PRE_READER_LEVEL, "1"]) {
      const { stable, dynamic } = buildSystemPromptParts(null, level, "Kai", null, null, null);
      const register =
        level === PRE_READER_LEVEL
          ? buildPreReaderSection()
          : buildEarlyReaderSection(level);
      expect(stable).toContain(register + buildYoungReaderTurnRules());
      expect(dynamic).not.toContain(buildYoungReaderTurnRules());
    }
  });
});
