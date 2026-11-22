// Ported from Rabbithole: native/src/lib/__tests__/practicePad.test.ts and the
// pad cases of shared/practiceLoop.test.ts ("answer normalization"). Dropped:
// multiple-choice, unit/form nudge copy, and two assertions that called the
// app's server-side grader (splitUnitSuffix / hasUnitToken).
import { describe, expect, it } from "vitest";

import {
  applyKey,
  applyKeyToInputBuffer,
  applyUnitKey,
  isPadAnswerType,
  padAcceptsFraction,
  padGridKeys,
  padOpKey,
  padShowFraction,
  padShowRemainder,
  padShowSign,
  sanitizePadInput,
  superscriptExponents,
  unitKeyFamily,
  type InputBuffer,
} from "../model/flatPad";

describe("solution sets typed flat", () => {
  it("keeps the algebra characters and the comma between answers", () => {
    expect(sanitizePadInput("solutionSet", "x = 3, -2 ± √5 | none")).toBe("x  3, -2 ± √5 | none");
    expect(padAcceptsFraction("solutionSet")).toBe(true);
  });
});

describe("pad layout", () => {
  it("classifies pad answer types", () => {
    expect(isPadAnswerType("integer")).toBe(true);
    expect(isPadAnswerType("decimal")).toBe(true);
    expect(isPadAnswerType("fraction")).toBe(true);
    expect(isPadAnswerType("expression")).toBe(true);
    expect(isPadAnswerType("solutionSet")).toBe(true);
    expect(isPadAnswerType("multipleChoice")).toBe(false);
    expect(isPadAnswerType("nonsense")).toBe(false);
  });

  it("puts the right operator in the bottom-left slot", () => {
    expect(padOpKey("integer")).toBe("");
    expect(padOpKey("decimal")).toBe(".");
    expect(padOpKey("fraction")).toBe("/");
    expect(padOpKey("expression")).toBe("/");
  });

  it("lays out a 12-key calculator-order grid", () => {
    expect(padGridKeys("integer")).toEqual([
      "7", "8", "9", "4", "5", "6", "1", "2", "3", "", "0", "⌫",
    ]);
    expect(padGridKeys("fraction")[9]).toBe("/");
    expect(padGridKeys("decimal")[9]).toBe(".");
    expect(padGridKeys("integer")).toHaveLength(12);
  });

  it("only shows the remainder key for expressions", () => {
    expect(padShowRemainder("expression")).toBe(true);
    expect(padShowRemainder("integer")).toBe(false);
    expect(padShowRemainder("fraction")).toBe(false);
    expect(padShowRemainder("decimal")).toBe(false);
  });

  it("shows the sign-toggle key for every numeric type except expression", () => {
    expect(padShowSign("integer")).toBe(true);
    expect(padShowSign("decimal")).toBe(true);
    expect(padShowSign("fraction")).toBe(true);
    expect(padShowSign("expression")).toBe(false);
  });

  it("shows the wide fraction key only for decimal items", () => {
    expect(padShowFraction("decimal")).toBe(true);
    expect(padShowFraction("integer")).toBe(false);
    expect(padShowFraction("fraction")).toBe(false); // `/` already in the grid
    expect(padShowFraction("expression")).toBe(false);
  });

  it("accepts a `/` for every flat type except integer", () => {
    expect(padAcceptsFraction("decimal")).toBe(true);
    expect(padAcceptsFraction("fraction")).toBe(true);
    expect(padAcceptsFraction("expression")).toBe(true);
    expect(padAcceptsFraction("integer")).toBe(false);
  });
});

describe("applyKey", () => {
  it("appends, trims, and inserts operators", () => {
    expect(applyKey("", "7")).toBe("7");
    expect(applyKey("7", "8")).toBe("78");
    expect(applyKey("78", "⌫")).toBe("7");
    expect(applyKey("", "⌫")).toBe("");
    expect(applyKey("3", "/")).toBe("3/");
    expect(applyKey("3/4", ".")).toBe("3/4.");
  });

  it("toggles a LEADING minus sign with ± (or a hardware -), never mid-number", () => {
    expect(applyKey("", "±")).toBe("-");
    expect(applyKey("", "-")).toBe("-");
    expect(applyKey(applyKey("", "±"), "5")).toBe("-5");
    expect(applyKey("-5", "3")).toBe("-53");
    expect(applyKey("-53", "±")).toBe("53");
    expect(applyKey("53", "-")).toBe("-53");
    expect(applyKey("-53", "⌫")).toBe("-5");
    expect(applyKey(applyKey("-5", "⌫"), "⌫")).toBe("");
  });

  it("inserts a spaced remainder token for the R key (the '7 R 2' form)", () => {
    expect(applyKey("7", "R")).toBe("7 R ");
    expect(applyKey(applyKey("7", "R"), "2")).toBe("7 R 2");
  });

  it("composes a burst through the synchronous input buffer", () => {
    const buffer: InputBuffer = { current: "" };
    for (const key of ["1", "2", "/", "5"]) applyKeyToInputBuffer(buffer, key);
    expect(buffer.current).toBe("12/5");
  });
});

describe("sanitizePadInput (hardware keyboard)", () => {
  it("filters typed input to each pad type's charset", () => {
    expect(sanitizePadInput("integer", "42")).toBe("42");
    expect(sanitizePadInput("integer", "4a2!")).toBe("42");
    expect(sanitizePadInput("decimal", "3.5")).toBe("3.5");
    expect(sanitizePadInput("integer", "3.5")).toBe("35");
    expect(sanitizePadInput("fraction", "3/4")).toBe("3/4");
    expect(sanitizePadInput("expression", "12/4")).toBe("12/4");
    expect(sanitizePadInput("decimal", "105/16")).toBe("105/16");
    expect(sanitizePadInput("integer", "3/4")).toBe("34");
    expect(sanitizePadInput("expression", "7 r 2")).toBe("7 R 2");
    expect(sanitizePadInput("expression", "7 R 2")).toBe("7 R 2");
    expect(sanitizePadInput("expression", "(1/x)^2 + y")).toBe("(1/x)^2 + y");
    expect(sanitizePadInput("integer", "-5")).toBe("-5");
    expect(sanitizePadInput("integer", "5-3")).toBe("53");
    expect(sanitizePadInput("decimal", "1.5-2")).toBe("1.52");
  });

  it("widens the charset for a unit-bearing answer only when allowUnit is set", () => {
    expect(sanitizePadInput("integer", "112 cm")).toBe("112");
    expect(sanitizePadInput("integer", "112 cm", { allowUnit: true })).toBe("112 cm");
    expect(sanitizePadInput("integer", "112 cm^3", { allowUnit: true })).toBe("112 cm^3");
    expect(sanitizePadInput("integer", "112 cm³", { allowUnit: true })).toBe("112 cm³");
    expect(sanitizePadInput("integer", "24 sq cm", { allowUnit: true })).toBe("24 sq cm");
    expect(sanitizePadInput("integer", "112! cm", { allowUnit: true })).toBe("112 cm");
  });
});

describe("unit keys", () => {
  it("derives a unit key family from the display unit", () => {
    expect(unitKeyFamily("cm³")).toEqual(["cm", "cm²", "cm³"]);
    expect(unitKeyFamily("cm²")).toEqual(["cm", "cm²", "cm³"]);
    expect(unitKeyFamily("cm")).toEqual(["cm", "cm²", "cm³"]);
    expect(unitKeyFamily("m³")).toEqual(["m", "m²", "m³"]);
    expect(unitKeyFamily("")).toEqual([]);
    expect(unitKeyFamily("°")).toEqual(["°"]);
  });

  it("applies a tapped unit key by replacing any trailing unit token", () => {
    expect(applyUnitKey("112", "cm³")).toBe("112 cm³");
    expect(applyUnitKey("112 cm²", "cm³")).toBe("112 cm³");
    expect(applyUnitKey("112 cm^2", "cm³")).toBe("112 cm³");
    expect(applyUnitKey("112 cm^", "cm³")).toBe("112 cm³");
    expect(applyUnitKey("", "cm³")).toBe("cm³");
    expect(applyUnitKey("65", "°")).toBe("65°");
    expect(applyUnitKey("65°", "°")).toBe("65°");
    expect(applyUnitKey("65 °", "°")).toBe("65°");
    expect(applyUnitKey("", "°")).toBe("°");
  });

  it("typed ° and tapped ° produce the same string", () => {
    const tapped = applyUnitKey("65", "°");
    let typed = "";
    for (const ch of "65°") {
      typed = applyKey(typed, sanitizePadInput("integer", ch, { allowUnit: true }));
    }
    expect(typed).toBe("65°");
    expect(typed).toBe(tapped);
  });

  it("a hardware-typed caret exponent converges on the unit-key tap", () => {
    const typeUnit = (raw: string) => {
      let buf = "";
      for (const ch of raw) {
        const next = applyKey(buf, sanitizePadInput("integer", ch, { allowUnit: true }));
        buf = superscriptExponents(next);
      }
      return buf;
    };
    expect(typeUnit("112 cm^3")).toBe("112 cm³");
    expect(typeUnit("112 cm^3")).toBe(applyUnitKey("112", "cm³"));
    expect(typeUnit("24 m^2")).toBe(applyUnitKey("24", "m²"));
  });
});
