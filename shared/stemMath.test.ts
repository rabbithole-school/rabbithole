import { describe, expect, it } from "vitest";

import {
  braceUnarySigns,
  hasStemMath,
  latexToPlainSpeech,
  renderableMathLatex,
  splitStemMath,
  stemMathToSpeech,
} from "./stemMath";

/** A sign with no left operand that is not braced (see braceUnarySigns). */
function bareLeadingSign(latex: string): boolean {
  return /(^|[({[=,<>&]|\\\\|\\(?:le|ge|ne|pm|mp|cdot|times|left[({[|])(?![a-zA-Z]))\s*(-|\+|\\pm(?![a-z])|\\mp(?![a-z]))(?!\s*\})/.test(
    latex,
  );
}

describe("renderable span LaTeX", () => {
  it.each([
    ["-3", "{-}3"],
    ["x = -2", "x = {-}2"],
    ["(-1)^n", "({-}1)^n"],
    ["3, -2", "3, {-}2"],
    ["3 \\pm -1", "3 \\pm {-}1"],
    ["\\pm 3", "{\\pm} 3"],
    ["x^{-2}", "x^{{-}2}"],
    ["\\left(-x\\right)", "\\left({-}x\\right)"],
    ["\\begin{cases} -x & x < 0 \\\\ -2 & x \\ge 0 \\end{cases}", "\\begin{cases} {-}x & x < 0 \\\\ {-}2 & x \\ge 0 \\end{cases}"],
    ["x - 3", "x - 3"],
    ["a + b - c", "a + b - c"],
    ["\\pmod 5", "\\pmod 5"],
  ])("%s → %s", (latex, braced) => {
    expect(braceUnarySigns(latex)).toBe(braced);
    expect(bareLeadingSign(braceUnarySigns(latex))).toBe(false);
  });

  it("sets an inline span in display style so fractions read at full size; display spans unchanged", () => {
    expect(renderableMathLatex("\\frac{x+1}{x-2}", false)).toBe("\\displaystyle \\frac{x+1}{x-2}");
    expect(renderableMathLatex("\\sum_{k=1}^{n} k", true)).toBe("\\sum_{k=1}^{n} k");
    expect(renderableMathLatex("-\\frac{1}{2}", false)).toBe("\\displaystyle {-}\\frac{1}{2}");
  });

  it("the gallery's stems all render without a bare sign", () => {
    const stems = [
      "Factor \\(x^2 + x - 6\\).",
      "Simplify \\(\\frac{5 + 10i}{1 + 2i} + (3 - i)^2\\).",
      "Write as one logarithm: \\(\\log_{2} x + \\log_{2} (x + 1)\\).",
      "Find the nth term: \\(3, 6, 12, 24, \\ldots\\)",
      "Solve \\(x^2 + x - 6 = 0\\). Give every solution.",
      "Solve \\(x^2 - 4x + 13 = 0\\).",
      "Simplify \\(\\frac{x^2 - 9}{x^2 - x - 6}\\) and state the restriction.",
      "Evaluate \\(\\log_{2} 8 + \\ln e^{3}\\).",
      "Rewrite \\(x^{2/3}\\) as a radical: \\(\\sqrt[3]{x^2}\\).",
      "Find the sum. \\[\\sum_{k=1}^{10} (2k + 1)\\]",
      "For \\(f(x) = \\begin{cases} x^2 & x < 0 \\\\ 2x + 1 & x \\ge 0 \\end{cases}\\), find f(-3).",
      "Solve \\(-2x + 5 = -9\\).",
    ];
    for (const stem of stems) {
      for (const seg of splitStemMath(stem)) {
        if (seg.kind === "math") expect(bareLeadingSign(renderableMathLatex(seg.latex, seg.display))).toBe(false);
      }
    }
  });
});
import { fractionsToSpeech, hasPracticeMath } from "./fractions";
import { stemToSpeech } from "./practiceStemBlocks";

describe("splitStemMath", () => {
  it("leaves a plain stem as one text segment", () => {
    expect(splitStemMath("What is 3/4 of 12?")).toEqual([{ kind: "text", text: "What is 3/4 of 12?" }]);
    expect(hasStemMath("What is 3/4 of 12?")).toBe(false);
  });

  it("splits inline and display spans in order", () => {
    expect(splitStemMath("Simplify \\(\\frac{x^2-1}{x-1}\\). Then \\[\\sum_{k=1}^{n} k\\] done")).toEqual([
      { kind: "text", text: "Simplify " },
      { kind: "math", latex: "\\frac{x^2-1}{x-1}", display: false },
      { kind: "text", text: ". Then " },
      { kind: "math", latex: "\\sum_{k=1}^{n} k", display: true },
      { kind: "text", text: " done" },
    ]);
  });

  it("puts an inline cases block on its own line (display)", () => {
    expect(splitStemMath("For \\(f(x) = \\begin{cases} x & x < 0 \\\\ 1 & x \\ge 0 \\end{cases}\\), find f(2).")).toEqual([
      { kind: "text", text: "For " },
      { kind: "math", latex: "f(x) = \\begin{cases} x & x < 0 \\\\ 1 & x \\ge 0 \\end{cases}", display: true },
      { kind: "text", text: ", find f(2)." },
    ]);
  });

  it("keeps an unterminated span literal and drops an empty one", () => {
    expect(splitStemMath("cost \\( 5")).toEqual([{ kind: "text", text: "cost \\( 5" }]);
    expect(splitStemMath("a \\(  \\) b")).toEqual([
      { kind: "text", text: "a " },
      { kind: "text", text: " b" },
    ]);
    expect(hasStemMath("a \\(  \\) b")).toBe(false);
  });
});

describe("latexToPlainSpeech", () => {
  const cases: Array<[string, string]> = [
    ["\\frac{x+1}{x-2}", "x plus 1 over x minus 2"],
    ["\\log_{2} 8", "log base 2 of 8"],
    ["\\ln x", "the natural log of x"],
    ["x^{2}", "x squared"],
    ["x^3", "x cubed"],
    ["x^{\\frac{2}{3}}", "x to the 2 over 3"],
    ["\\sqrt{3}", "the square root of 3"],
    ["\\sqrt[3]{8}", "the cube root of 8"],
    ["\\sqrt[4]{x}", "the 4th root of x"],
    ["3 \\pm 2i", "3 plus or minus 2i"],
    ["x \\le 3", "x is less than or equal to 3"],
    ["x \\ne 0", "x is not equal to 0"],
    ["\\sum_{k=1}^{n} k", "the sum from k equals 1 to n of k"],
    ["\\left( x + 1 \\right)", "x plus 1"],
    ["\\lvert x - 3 \\rvert", "the absolute value of x minus 3"],
    ["-5", "negative 5"],
    ["2 \\cdot 3", "2 times 3"],
    ["\\pi r^2", "pi r squared"],
    ["\\infty", "infinity"],
    ["f(x) = \\begin{cases} x & x < 0 \\\\ 2x & x \\ge 0 \\end{cases}", "f x equals where x x is less than 0 ; 2x x is greater than or equal to 0"],
  ];
  it.each(cases)("%s", (latex, spoken) => {
    expect(latexToPlainSpeech(latex)).toBe(spoken);
  });

  it("never says a backslash or a brace", () => {
    for (const [latex] of cases) expect(latexToPlainSpeech(latex)).not.toMatch(/[\\{}]/);
  });
});

describe("read-aloud of a stem with typeset spans", () => {
  it("speaks prose as before and spans as words", () => {
    expect(stemMathToSpeech("Solve \\(\\log_{2} x = 3\\).", (t) => t)).toBe("Solve log base 2 of x equals 3 .");
  });

  it("flows through fractionsToSpeech and stemToSpeech", () => {
    const stem = "Write \\(\\frac{1}{2}\\) as a decimal, then add 3/4";
    expect(fractionsToSpeech(stem)).toBe("Write 1 over 2 as a decimal, then add 3 over 4");
    expect(stemToSpeech(stem)).toBe("Write 1 over 2 as a decimal, then add 3 over 4");
    expect(hasPracticeMath("solve \\(x^2 = 4\\)")).toBe(true);
  });

  it("leaves a plain stem's reading unchanged", () => {
    expect(fractionsToSpeech("Write 9 4/9 as ?/9")).toBe("Write 9 and 4 over 9 as blank over 9");
  });
});
