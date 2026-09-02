import { describe, expect, test } from "vitest";
import {
  hasMarkdownFormatting,
  stripMarkdownFormatting,
} from "../practice/plainText";

describe("practice plain-text contract", () => {
  test("unwraps Markdown bold in worked explanations", () => {
    expect(stripMarkdownFormatting("The area is **40 square units**.")).toBe(
      "The area is 40 square units.",
    );
    expect(stripMarkdownFormatting("**Area = base × height**\nThen multiply.")).toBe(
      "Area = base × height\nThen multiply.",
    );
  });

  test("unwraps other common Markdown formatting", () => {
    expect(
      stripMarkdownFormatting(
        "# Method\nUse *addition*, then `multiply`, or read [the diagram](https://example.com).",
      ),
    ).toBe("Method\nUse addition, then multiply, or read the diagram.");
  });

  test("does not corrupt unmatched mathematical double-star operators", () => {
    expect(stripMarkdownFormatting("2 ** 3 = 8")).toBe("2 ** 3 = 8");
    expect(stripMarkdownFormatting("2 **3 = 8")).toBe("2 **3 = 8");
    expect(stripMarkdownFormatting("2** 3 = 8")).toBe("2** 3 = 8");
    expect(
      stripMarkdownFormatting("Use 2 **3 = 8. Then **add 4**."),
    ).toBe("Use 2 **3 = 8. Then add 4.");
  });

  test("recognizes formatting but not an exponent operator", () => {
    expect(hasMarkdownFormatting("The answer is **12**.")).toBe(true);
    expect(hasMarkdownFormatting("Use *addition*.")).toBe(true);
    expect(hasMarkdownFormatting("2 ** 3 = 8")).toBe(false);
  });
});
