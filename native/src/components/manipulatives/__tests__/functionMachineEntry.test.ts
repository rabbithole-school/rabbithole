import { describe, expect, it } from "vitest";

import {
  parseFunctionMachineNumber,
  typeFunctionMachineKey,
} from "../functionMachineEntry";
import { functionMachineStateFromTypedAnswer } from "../../../../vendor/manipulative/logic";

function typeKeys(keys: string[], start = ""): string {
  return keys.reduce(typeFunctionMachineKey, start);
}

describe("function machine number boxes", () => {
  it("types a two-digit answer in two taps", () => {
    expect(typeKeys(["1", "6"])).toBe("16");
    expect(parseFunctionMachineNumber("16")).toBe(16);
  });

  it("makes a number negative with the ± key, before or after the digits", () => {
    expect(typeKeys(["±", "3"])).toBe("-3");
    expect(typeKeys(["3", "±"])).toBe("-3");
    expect(typeKeys(["3", "±", "±"])).toBe("3");
    expect(parseFunctionMachineNumber("-3")).toBe(-3);
  });

  it("replaces a lone leading zero instead of extending it", () => {
    expect(typeKeys(["0", "5"])).toBe("5");
    expect(typeKeys(["±", "0", "5"])).toBe("-5");
    expect(typeKeys(["5", "0"])).toBe("50");
  });

  it("caps a box at four digits", () => {
    expect(typeKeys(["1", "2", "3", "4", "5"])).toBe("1234");
    expect(typeKeys(["±", "1", "2", "3", "4", "5"])).toBe("-1234");
  });

  it("backspaces one character at a time", () => {
    expect(typeKeys(["1", "5", "0", "⌫"])).toBe("15");
    expect(typeKeys(["⌫"])).toBe("");
  });

  it("reads an empty box or a bare sign as no number", () => {
    expect(parseFunctionMachineNumber("")).toBeNull();
    expect(parseFunctionMachineNumber("-")).toBeNull();
  });

  it("reports no state for an empty prediction, so Done stays disabled", () => {
    // The frame keeps Done disabled while the reported state is null.
    expect(functionMachineStateFromTypedAnswer(typeKeys([]))).toBeNull();
    expect(functionMachineStateFromTypedAnswer(typeKeys(["±"]))).toBeNull();
    expect(functionMachineStateFromTypedAnswer(typeKeys(["1", "⌫"]))).toBeNull();
    expect(functionMachineStateFromTypedAnswer(typeKeys(["1", "6"]))).toEqual({ predicted: 16 });
    expect(functionMachineStateFromTypedAnswer(typeKeys(["±", "4"]))).toEqual({ predicted: -4 });
  });
});
