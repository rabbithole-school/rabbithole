import { describe, expect, it } from "vitest";

import {
  applyKey,
  choiceSubmitValue,
  isPadAnswerType,
  padGridKeys,
  padOpKey,
  padShowFraction,
  padShowRemainder,
  padShowSign,
  sanitizePadInput,
} from "../practicePad";

describe("practicePad", () => {
  it("classifies pad answer types", () => {
    expect(isPadAnswerType("integer")).toBe(true);
    expect(isPadAnswerType("decimal")).toBe(true);
    expect(isPadAnswerType("fraction")).toBe(true);
    expect(isPadAnswerType("expression")).toBe(true);
    expect(isPadAnswerType("multipleChoice")).toBe(false);
    expect(isPadAnswerType("manipulative")).toBe(false);
  });

  it("puts the right operator in the bottom-left slot", () => {
    expect(padOpKey("integer")).toBe("");
    expect(padOpKey("decimal")).toBe(".");
    expect(padOpKey("fraction")).toBe("/");
    expect(padOpKey("expression")).toBe("/");
  });

  it("only shows the remainder key for expressions", () => {
    expect(padShowRemainder("expression")).toBe(true);
    expect(padShowRemainder("integer")).toBe(false);
    expect(padShowRemainder("fraction")).toBe(false);
    expect(padShowRemainder("decimal")).toBe(false);
  });

  it("shows the wide fraction key only for decimal (grader accepts 105/16 for 6.5625)", () => {
    expect(padShowFraction("decimal")).toBe(true);
    expect(padShowFraction("integer")).toBe(false);
    expect(padShowFraction("fraction")).toBe(false);
    expect(padShowFraction("expression")).toBe(false);
  });

  it("hardware input accepts / for decimal answers, matching the wide key", () => {
    expect(sanitizePadInput("decimal", "105/16")).toBe("105/16");
    expect(sanitizePadInput("decimal", "6.5625")).toBe("6.5625");
    expect(sanitizePadInput("integer", "105/16")).toBe("10516");
    expect(sanitizePadInput("fraction", "3/4")).toBe("3/4");
    expect(sanitizePadInput("expression", "(1/x)^2 + y")).toBe("(1/x)^2 + y");
  });

  it("shows the sign-toggle key for every numeric type except expression", () => {
    expect(padShowSign("integer")).toBe(true);
    expect(padShowSign("decimal")).toBe(true);
    expect(padShowSign("fraction")).toBe(true);
    expect(padShowSign("expression")).toBe(false);
  });

  it("lays out a 12-key grid mirroring the web pad", () => {
    // Web integer/decimal pad: 7 8 9 / 4 5 6 / 1 2 3 / [op] 0 ⌫
    expect(padGridKeys("integer")).toEqual([
      "7", "8", "9", "4", "5", "6", "1", "2", "3", "", "0", "⌫",
    ]);
    expect(padGridKeys("fraction")[9]).toBe("/");
    expect(padGridKeys("decimal")[9]).toBe(".");
    expect(padGridKeys("integer")).toHaveLength(12);
  });

  it("applies a key like the web onKey reducer", () => {
    expect(applyKey("", "7")).toBe("7");
    expect(applyKey("7", "8")).toBe("78");
    expect(applyKey("78", "⌫")).toBe("7");
    expect(applyKey("", "⌫")).toBe("");
    expect(applyKey("3", "/")).toBe("3/");
    expect(applyKey("3/4", ".")).toBe("3/4.");
    expect(applyKey("7", "R")).toBe("7 R ");
  });

  it("toggles a leading minus sign with ±, never mid-number", () => {
    expect(applyKey("", "±")).toBe("-");
    expect(applyKey(applyKey("", "±"), "7")).toBe("-7");
    expect(applyKey("-7", "±")).toBe("7");
    expect(applyKey("7", "±")).toBe("-7");
  });

  it("submits a multiple-choice option as its index string", () => {
    expect(choiceSubmitValue(0)).toBe("0");
    expect(choiceSubmitValue(3)).toBe("3");
  });
});
