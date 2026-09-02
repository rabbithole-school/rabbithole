import { describe, expect, test } from "vitest";
import {
  countSyllables,
  fleschKincaidGrade,
  fleschReadingEase,
  readabilityStats,
  segmentSentences,
  tokenizeWords,
} from "../readability";

describe("readability helpers", () => {
  test("segments sentence boundaries without splitting decimals or common abbreviations", () => {
    expect(segmentSentences("Dr. Rivera paused. The value is 3.14. Why?"))
      .toEqual(["Dr. Rivera paused.", "The value is 3.14.", "Why?"]);
  });

  test("treats line breaks as sentence boundaries for tutor-style lists", () => {
    expect(segmentSentences("First, sketch the pond\nThen label the pump"))
      .toEqual(["First, sketch the pond", "Then label the pump"]);
  });

  test("tokenizes words while preserving contractions and splitting hyphenated terms", () => {
    expect(tokenizeWords("Kai's student-led idea isn't finished."))
      .toEqual(["Kai's", "student", "led", "idea", "isn't", "finished"]);
  });

  test("counts syllables with silent-e, -le, -es, and -ed heuristics", () => {
    expect(countSyllables("cat")).toBe(1);
    expect(countSyllables("make")).toBe(1);
    expect(countSyllables("table")).toBe(2);
    expect(countSyllables("syllable")).toBe(3);
    expect(countSyllables("cakes")).toBe(1);
    expect(countSyllables("boxes")).toBe(2);
    expect(countSyllables("baked")).toBe(1);
    expect(countSyllables("wanted")).toBe(2);
    expect(countSyllables("reading")).toBe(2);
    expect(countSyllables("queue")).toBe(1);
    expect(countSyllables("people")).toBe(2);
  });
});

describe("Flesch-Kincaid formulas", () => {
  test("matches a simple reference sentence", () => {
    const text = "The quick brown fox jumps over the lazy dog.";

    expect(fleschKincaidGrade(text)).toBeCloseTo(2.34, 2);
    expect(fleschReadingEase(text)).toBeCloseTo(94.3, 2);
  });

  test("matches a published harder reference sentence", () => {
    const text = "The Australian platypus is seemingly a hybrid of a mammal and reptilian creature.";

    expect(fleschKincaidGrade(text)).toBeCloseTo(11.26, 2);
    expect(fleschReadingEase(text)).toBeCloseTo(37.46, 2);
  });

  test("uses multiple sentences in average sentence length", () => {
    const text = "This is a simple sentence. It has easy words.";

    expect(readabilityStats(text)).toMatchObject({
      sentenceCount: 2,
      wordCount: 9,
      syllableCount: 12,
      fleschKincaidGrade: 1.9,
      fleschReadingEase: 89.47,
    });
  });

  test("clamps very easy text to useful public ranges", () => {
    expect(fleschKincaidGrade("The cat sat on the mat.")).toBe(0);
    expect(fleschReadingEase("The cat sat on the mat.")).toBe(100);
  });

  test("handles empty and non-word input without NaN", () => {
    for (const text of ["", "   ", "...?!", "12345"]) {
      expect(fleschKincaidGrade(text)).toBe(0);
      expect(fleschReadingEase(text)).toBe(0);
      expect(readabilityStats(text)).toMatchObject({
        sentenceCount: 0,
        wordCount: 0,
        syllableCount: 0,
      });
    }
  });

  test("handles fragments without terminal punctuation", () => {
    const stats = readabilityStats("Sketch one clear aquaponics diagram");

    expect(stats.sentenceCount).toBe(1);
    expect(stats.wordCount).toBe(5);
    expect(Number.isFinite(stats.fleschKincaidGrade)).toBe(true);
    expect(Number.isFinite(stats.fleschReadingEase)).toBe(true);
  });
});
