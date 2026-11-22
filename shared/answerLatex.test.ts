import { describe, expect, it } from "vitest";

import { answerToLatex, isTypesetAnswer } from "./answerLatex";

describe("answerToLatex", () => {
  const cases: Array<[string, string]> = [
    ["(x+3)/(x-2)", "\\frac{x + 3}{x - 2}"],
    ["(x+3)/(x−2)", "\\frac{x + 3}{x - 2}"],
    ["log_2(8)", "\\log_{2} 8"],
    ["log₂ 8", "\\log_{2} 8"],
    ["log_2(x+1)", "\\log_{2}\\left(x + 1\\right)"],
    ["log(100)", "\\log 100"],
    ["ln(x)", "\\ln x"],
    ["x^(2/3)", "{x}^{\\frac{2}{3}}"],
    ["x^2+3x-4", "{x}^{2} + 3x - 4"],
    ["(x+1)^2", "{\\left(x + 1\\right)}^{2}"],
    ["2√3", "2\\sqrt{3}"],
    ["√(x+1)", "\\sqrt{x + 1}"],
    ["∛8", "\\sqrt[3]{8}"],
    ["√[4]x", "\\sqrt[4]{x}"],
    ["sqrt(2)", "\\sqrt{2}"],
    ["-1/2", "{-}\\frac{1}{2}"],
    ["3±2i", "3 \\pm 2i"],
    ["±3", "{\\pm}3"],
    ["3,-2", "3,\\; {-}2"],
    ["2*-3", "2 \\cdot {-}3"],
    ["x=-3", "x = {-}3"],
    ["(-1)^n", "{\\left({-}1\\right)}^{n}"],
    ["none", "\\text{no solution}"],
    ["abs(x-3)", "\\left|x - 3\\right|"],
    ["|x-3|", "\\left|x - 3\\right|"],
    ["2πr", "2\\pi r"],
    ["e^(2x)", "{e}^{2x}"],
    ["x²", "{x}^{2}"],
    ["2*3", "2 \\cdot 3"],
    ["y = 2x + 1", "y = 2x + 1"],
    ["x <= 3", "x \\le 3"],
    ["2 1/2", "2\\frac{1}{2}"],
    ["(x+3)(x-2)", "\\left(x + 3\\right)\\left(x - 2\\right)"],
  ];
  it.each(cases)("%s", (input, latex) => {
    expect(answerToLatex(input)).toBe(latex);
  });

  it.each(["Yes", "a triangle", "7 R 1", "x = 3 or x = -2", "", "2 +", "(x+1", "log_", "No solution", "is 5"])(
    "refuses %j",
    (input) => {
      expect(answerToLatex(input)).toBeNull();
    },
  );
});

/** A binary operator (+ − ± ∓ · ×) with no left operand — the shape that made
 *  SwiftMath assert on invalid inter-element spacing. Braced `{-}` is fine. */
function bareLeadingSign(latex: string): boolean {
  return /(^|[({[=,<>&]|\\\\|\\(?:le|ge|ne|pm|mp|cdot|times|left[({[|])(?![a-zA-Z]))\s*(-|\+|\\pm(?![a-z])|\\mp(?![a-z])|\\cdot|\\times)(?!\s*\})/.test(
    latex,
  );
}

describe("answerToLatex never emits a sign without a left operand", () => {
  it.each(["-1/2", "-x", "±3", "3,-2", "x=-3", "2*-3", "(-1)^n", "-3±√5", "3±-1", "-(x+1)", "|-x|", "x^-2", "log_2(-x)"])(
    "%s",
    (input) => {
      const latex = answerToLatex(input);
      expect(latex).not.toBeNull();
      expect(bareLeadingSign(latex!)).toBe(false);
    },
  );
});

describe("isTypesetAnswer", () => {
  it.each(["x+1", "2√3", "3±2i", "log_2(8)", "3,-2", "none", "y = 2x + 1", "i"])("typesets %s", (s) => {
    expect(isTypesetAnswer(s)).toBe(true);
  });

  it.each(["12", "3/4", "-5", "2 1/2", "7 + 5", "Yes", "a triangle", "7 R 1", "", null, undefined])(
    "leaves %j to the existing renderer",
    (s) => {
      expect(isTypesetAnswer(s)).toBe(false);
    },
  );
});
