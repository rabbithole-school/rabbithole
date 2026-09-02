import { describe, expect, test } from "vitest";
import {
  parseFractions,
  parsePracticeText,
  scanFractions,
  hasFraction,
  hasPracticeMath,
  fractionsToSpeech,
} from "./fractions";
import {
  hasStaticRadical,
  rootIndexName,
  scanStaticRadicals,
  staticRadicalsToSpeech,
} from "./staticRadicals";

// The direct ASCII fraction parser — the single source of truth for what the
// stacked renderer (FractionText, web + native) will draw. These cases are the
// real shapes the practice generators (convex/lib/practice/templates.ts) and the
// tutor prompt produce, plus the false-positive guards that keep prose safe.

describe("hasFraction", () => {
  test("true for real fractions", () => {
    expect(hasFraction("3/4")).toBe(true);
    expect(hasFraction("9 4/9")).toBe(true);
    expect(hasFraction("?/9")).toBe(true);
    expect(hasFraction("How does 2/8 compare to 1/2?")).toBe(true);
  });

  test("false for non-fractions", () => {
    expect(hasFraction("7 apples")).toBe(false);
    expect(hasFraction("just words")).toBe(false);
    expect(hasFraction("= ?")).toBe(false);
  });

  test("is not left in a stale-lastIndex state (global regex)", () => {
    // Calling repeatedly must be stable (hasFraction resets lastIndex).
    expect(hasFraction("3/4")).toBe(true);
    expect(hasFraction("3/4")).toBe(true);
    expect(hasFraction("nope")).toBe(false);
    expect(hasFraction("3/4")).toBe(true);
  });
});

describe("parseFractions — render nodes", () => {
  test("a simple fraction", () => {
    expect(parseFractions("3/4")).toEqual([
      { type: "frac", num: { blank: false, value: "3" }, den: { blank: false, value: "4" } },
    ]);
  });

  describe("parsePracticeText — static radicals", () => {
    test("parses a square root in prose into static-engine LaTeX", () => {
      expect(parsePracticeText("Simplify √18.")).toEqual([
        { type: "text", value: "Simplify " },
        { type: "radical", latex: "\\sqrt{18}", speech: "the square root of 18", trailingPunctuation: "." },
      ]);
    });

    test("parses an integer coefficient with the root", () => {
      expect(parsePracticeText("Write 3√7 here")).toEqual([
        { type: "text", value: "Write " },
        { type: "radical", latex: "3\\sqrt{7}", speech: "3 times the square root of 7" },
        { type: "text", value: " here" },
      ]);
    });

    test("parses cube roots and preserves their spoken index", () => {
      expect(parsePracticeText("Simplify 2∛3.")).toEqual([
        { type: "text", value: "Simplify " },
        { type: "radical", latex: "2\\sqrt[3]{3}", speech: "2 times the cube root of 3", trailingPunctuation: "." },
      ]);
      expect(staticRadicalsToSpeech("∛8")).toBe("the cube root of 8");
    });

    test("parses bracketed integer-index roots for both static engines", () => {
      expect(parsePracticeText("Simplify 2√[4]3.")).toEqual([
        { type: "text", value: "Simplify " },
        {
          type: "radical",
          latex: "2\\sqrt[4]{3}",
          speech: "2 times the 4th root of 3",
          trailingPunctuation: ".",
        },
      ]);
      expect(staticRadicalsToSpeech("√[12]8")).toBe("the 12th root of 8");
      expect(staticRadicalsToSpeech("√[21]8")).toBe("the 21st root of 8");
    });

    test("uses the editor's canonical safe integer contract for static root indices", () => {
      for (const index of ["02", "03", "007", "12345678901234567"]) {
        expect(rootIndexName(index), `index=${index}`).toBeNull();
        expect(parsePracticeText(`√[${index}]8`)).toEqual([
          { type: "text", value: `√[${index}]8` },
        ]);
        expect(hasStaticRadical(`√[${index}]8`)).toBe(false);
      }
    });

    test("keeps the fraction parser byte-for-byte when no radical exists", () => {
      expect(parsePracticeText("Write 9 4/9 as ?/9")).toEqual(parseFractions("Write 9 4/9 as ?/9"));
    });

    test("leaves incomplete, symbolic, and unsupported radical forms as text", () => {
      for (const value of ["√", "√x", "x√18", "√18.5", "3√", "√[1]9"]) {
        expect(parsePracticeText(value)).toEqual([{ type: "text", value }]);
        expect(hasStaticRadical(value)).toBe(false);
      }
    });
  });

  describe("scanStaticRadicals — conservative prose segmentation", () => {
    test("keeps sentence punctuation outside math while associating it with the fragment", () => {
      expect(scanStaticRadicals("Try √18. Then 3√7!")).toEqual([
        { type: "text", value: "Try " },
        { type: "radical", latex: "\\sqrt{18}", speech: "the square root of 18", trailingPunctuation: "." },
        { type: "text", value: " Then " },
        { type: "radical", latex: "3\\sqrt{7}", speech: "3 times the square root of 7", trailingPunctuation: "!" },
      ]);
    });
  });

  test("a mixed number splits into a whole text node + a fraction node", () => {
    expect(parseFractions("9 4/9")).toEqual([
      { type: "text", value: "9" },
      { type: "frac", num: { blank: false, value: "4" }, den: { blank: false, value: "9" } },
    ]);
  });

  test("a blank numerator becomes a blank part", () => {
    expect(parseFractions("?/9")).toEqual([
      { type: "frac", num: { blank: true }, den: { blank: false, value: "9" } },
    ]);
  });

  test("a fraction embedded in a stem keeps the surrounding text", () => {
    expect(parseFractions("Write 9 4/9 as ?/9")).toEqual([
      { type: "text", value: "Write " },
      { type: "text", value: "9" },
      { type: "frac", num: { blank: false, value: "4" }, den: { blank: false, value: "9" } },
      { type: "text", value: " as " },
      { type: "frac", num: { blank: true }, den: { blank: false, value: "9" } },
    ]);
  });

  test("a standalone '?' (e.g. '= ?') stays literal text, not a blank", () => {
    const nodes = parseFractions("2/8 + 1/8 = ?");
    // trailing " = ?" is a text node; only the two a/b are fractions.
    expect(nodes.filter((n) => n.type === "frac")).toHaveLength(2);
    expect(nodes[nodes.length - 1]).toEqual({ type: "text", value: " = ?" });
  });

  test("an underscore-run blank ('___') becomes a blank node", () => {
    expect(parseFractions("754 = ___ + 50 + 4")).toEqual([
      { type: "text", value: "754 = " },
      { type: "blank" },
      { type: "text", value: " + 50 + 4" },
    ]);
  });

  test("a blank at the very end is captured", () => {
    expect(parseFractions("9 + 0 = ___")).toEqual([
      { type: "text", value: "9 + 0 = " },
      { type: "blank" },
    ]);
  });

  test("blanks coexist with fractions in one stem", () => {
    expect(parseFractions("1/2 + ___ = 1")).toEqual([
      { type: "frac", num: { blank: false, value: "1" }, den: { blank: false, value: "2" } },
      { type: "text", value: " + " },
      { type: "blank" },
      { type: "text", value: " = 1" },
    ]);
  });

  test("a single underscore is left as literal text (not a blank)", () => {
    expect(parseFractions("a_1 + b")).toEqual([{ type: "text", value: "a_1 + b" }]);
  });
});

describe("scanFractions — prose segmentation", () => {
  test("splits prose into text and fraction runs", () => {
    expect(scanFractions("So 2/8 is small.")).toEqual([
      { type: "text", value: "So " },
      { type: "frac", value: "2/8" },
      { type: "text", value: " is small." },
    ]);
  });

  test("no fraction → a single text segment", () => {
    expect(scanFractions("just words")).toEqual([{ type: "text", value: "just words" }]);
  });
});

describe("guards — things that must NOT render as fractions", () => {
  test("money amounts (no slash) are untouched", () => {
    expect(hasFraction("You have $5 and spend $3")).toBe(false);
  });

  test("a real decimal is not a fraction", () => {
    expect(hasFraction("1.2/3")).toBe(false);
    expect(hasFraction("3/4.5")).toBe(false);
  });

  test("word- and path-slashes are not fractions", () => {
    expect(hasFraction("and/or")).toBe(false);
    expect(hasFraction("TCP/IP")).toBe(false);
    expect(hasFraction("https://example.com")).toBe(false);
  });

  test("a sentence-ending period after a fraction is allowed", () => {
    expect(scanFractions("The answer is 3/4.")).toEqual([
      { type: "text", value: "The answer is " },
      { type: "frac", value: "3/4" },
      { type: "text", value: "." },
    ]);
  });

  test("a date slash IS matched (accepted false-positive, prompt-mitigated)", () => {
    expect(hasFraction("12/25")).toBe(true);
  });
});

describe("fractionsToSpeech — screen-reader reading", () => {
  test("reads a simple fraction as 'over'", () => {
    expect(fractionsToSpeech("3/4")).toBe("3 over 4");
  });

  test("reads a mixed number with 'and'", () => {
    expect(fractionsToSpeech("9 4/9")).toBe("9 and 4 over 9");
  });

  test("reads a blank slot as 'blank'", () => {
    expect(fractionsToSpeech("?/9")).toBe("blank over 9");
  });

  test("reads an underscore-run blank as 'blank'", () => {
    expect(fractionsToSpeech("754 = ___ + 50 + 4")).toBe("754 = blank + 50 + 4");
  });

  test("keeps surrounding words", () => {
    expect(fractionsToSpeech("Write 2/8 here")).toBe("Write 2 over 8 here");
  });

  test("reads roots as coherent math speech", () => {
    expect(fractionsToSpeech("Simplify √18.")).toBe("Simplify the square root of 18.");
    expect(staticRadicalsToSpeech("Use 3√7.")).toBe("Use 3 times the square root of 7.");
  });
});

describe("hasPracticeMath", () => {
  test("detects fractions and supported static radicals only", () => {
    expect(hasPracticeMath("3/4")).toBe(true);
    expect(hasPracticeMath("√18")).toBe(true);
    expect(hasPracticeMath("3√7")).toBe(true);
    expect(hasPracticeMath("√x")).toBe(false);
  });
});
