import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { textNamesUnit } from "../../../vendor/practice/answers";

const repoRoot = path.resolve(__dirname, "../../../..");

describe("vendored practice answers", () => {
  it("is byte-identical to the Convex source", () => {
    const source = readFileSync(
      path.join(repoRoot, "convex/lib/practice/answers.ts"),
      "utf8",
    );
    const vendored = readFileSync(
      path.join(repoRoot, "native/vendor/practice/answers.ts"),
      "utf8",
    );
    expect(vendored).toBe(source);
  });

  it("uses the same asymmetric unit-alias boundaries on native", () => {
    expect(textNamesUnit("The angle measures 65°.", "deg")).toBe(true);
    expect(textNamesUnit("The ribbon is 8m long.", "m")).toBe(true);
    expect(textNamesUnit("The elevation change is -3m.", "m")).toBe(true);
    expect(textNamesUnit("The recipe needs 8 grams of yeast.", "m")).toBe(false);
    expect(textNamesUnit("The sample code is 8m4.", "m")).toBe(false);
    expect(textNamesUnit("The sample code is x8m.", "m")).toBe(false);
    expect(textNamesUnit("The sample code is x_8m.", "m")).toBe(false);
    expect(textNamesUnit("The value is 1e3m.", "m")).toBe(false);
    expect(textNamesUnit("The value is 1e-3m.", "m")).toBe(false);
    expect(textNamesUnit("The value is 1e+3m.", "m")).toBe(false);
  });
});
