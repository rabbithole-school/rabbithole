import { describe, expect, test } from "vitest";
import { spokenToAnswer, spokenToUnitAnswer } from "../spokenMath";

describe("spokenToAnswer", () => {
  test("integers from digits (Whisper's usual output) + filler", () => {
    expect(spokenToAnswer("56", "integer")).toBe("56");
    expect(spokenToAnswer("the answer is 56", "integer")).toBe("56");
    expect(spokenToAnswer("um, it's 7", "integer")).toBe("7");
    expect(spokenToAnswer("0", "integer")).toBe("0");
  });

  test("integers from words, incl. hyphenated + hundreds/thousands", () => {
    expect(spokenToAnswer("fifty six", "integer")).toBe("56");
    expect(spokenToAnswer("fifty-six", "integer")).toBe("56");
    expect(spokenToAnswer("three hundred forty two", "integer")).toBe("342");
    expect(spokenToAnswer("three hundred and two", "integer")).toBe("302");
    expect(spokenToAnswer("one thousand five", "integer")).toBe("1005");
  });

  test("Whisper's comma-formatted large numbers are kept whole (regression)", () => {
    // Whisper renders spoken large numbers with thousands separators.
    expect(spokenToAnswer("1,000", "integer")).toBe("1000");
    expect(spokenToAnswer("30,000", "integer")).toBe("30000");
    expect(spokenToAnswer("1,000,000", "integer")).toBe("1000000");
    expect(spokenToAnswer("the answer is 12,345", "integer")).toBe("12345");
    // and the spelled-out forms still work
    expect(spokenToAnswer("one thousand", "integer")).toBe("1000");
    expect(spokenToAnswer("thirty thousand", "integer")).toBe("30000");
  });

  test("negatives (word or sign)", () => {
    expect(spokenToAnswer("negative five", "integer")).toBe("-5");
    expect(spokenToAnswer("minus 7", "integer")).toBe("-7");
    expect(spokenToAnswer("-8", "integer")).toBe("-8");
  });

  test("fractions: slash, over, out of, and denominator words", () => {
    expect(spokenToAnswer("3/4", "fraction")).toBe("3/4");
    expect(spokenToAnswer("three over four", "fraction")).toBe("3/4");
    expect(spokenToAnswer("3 out of 4", "fraction")).toBe("3/4");
    expect(spokenToAnswer("three fourths", "fraction")).toBe("3/4");
    expect(spokenToAnswer("three quarters", "fraction")).toBe("3/4");
    expect(spokenToAnswer("one half", "fraction")).toBe("1/2");
    expect(spokenToAnswer("two thirds", "fraction")).toBe("2/3");
  });

  test("decimals: digits or 'point'", () => {
    expect(spokenToAnswer("5.2", "decimal")).toBe("5.2");
    expect(spokenToAnswer("five point two", "decimal")).toBe("5.2");
    expect(spokenToAnswer("zero point two five", "decimal")).toBe("0.25");
  });

  test("division with remainder (expression answerType only)", () => {
    expect(spokenToAnswer("5 remainder 3", "expression")).toBe("5R3");
    expect(spokenToAnswer("five remainder three", "expression")).toBe("5R3");
    expect(spokenToAnswer("5 r 3", "expression")).toBe("5R3");
    // remainder phrasing is NOT applied to a plain integer answer type
    expect(spokenToAnswer("5 remainder 3", "integer")).toBe("5");
  });

  test("unparseable input and multiple-choice return null", () => {
    expect(spokenToAnswer("hello there", "integer")).toBeNull();
    expect(spokenToAnswer("", "integer")).toBeNull();
    expect(spokenToAnswer("4", "multipleChoice")).toBeNull();
  });
});

describe("spokenToUnitAnswer", () => {
  test("a unit-free item is the plain number parser, untouched", () => {
    expect(spokenToUnitAnswer("fifty six", "integer", undefined)).toBe("56");
    expect(spokenToUnitAnswer("112 cubic centimeters", "integer", undefined)).toBe("112");
  });

  test("a spoken unit survives, normalized to the display form", () => {
    expect(spokenToUnitAnswer("112 cubic centimeters", "integer", "cm³")).toBe("112 cm³");
    expect(spokenToUnitAnswer("112 cm3", "integer", "cm³")).toBe("112 cm³");
    // Whisper punctuates the end of an utterance.
    expect(spokenToUnitAnswer("112 cubic centimeters.", "integer", "cm³")).toBe("112 cm³");
    // A spelled-out number keeps its unit too.
    expect(spokenToUnitAnswer("one hundred twelve cubic centimeters", "integer", "cm³"))
      .toBe("112 cm³");
  });

  test("the WRONG unit is preserved, not silently corrected", () => {
    // Grading — not the client — decides the unit is wrong.
    expect(spokenToUnitAnswer("112 square centimeters", "integer", "cm³")).toBe("112 cm²");
  });

  test("a spelled-out number with no unit keeps every word of the number", () => {
    // The generic any-trailing-word split would read "twelve" as a unit and
    // return "100 twelve"; only recognized units are peeled off.
    expect(spokenToUnitAnswer("one hundred twelve", "integer", "cm³")).toBe("112");
    expect(spokenToUnitAnswer("112", "integer", "cm³")).toBe("112");
  });

  test("unparseable input still returns null", () => {
    expect(spokenToUnitAnswer("hello there", "integer", "cm³")).toBeNull();
    expect(spokenToUnitAnswer("cubic centimeters", "integer", "cm³")).toBeNull();
  });
});
