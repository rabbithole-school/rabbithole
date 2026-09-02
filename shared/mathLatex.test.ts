import { describe, expect, test } from "vitest";
import {
  asciiToLatex,
  BLANK,
  fracLatex,
  hasFraction,
  hasInlineMath,
  latexToSpeech,
  looksLikeMath,
  mixedLatex,
  parseMath,
  splitMathSegments,
  type MathNode,
} from "./mathLatex";

// ── Tiny serializer: render the AST back to a readable shape so assertions read
// like the thing a human sees. frac → "num/den", blank → "▢", text verbatim.
function show(nodes: MathNode[]): string {
  return nodes
    .map((n) => {
      if (n.type === "text") return n.value;
      if (n.type === "blank") return "▢";
      return `(${show(n.num)}÷${show(n.den)})`;
    })
    .join("");
}

describe("parseMath — simple fractions", () => {
  test("a bare fraction", () => {
    const ast = parseMath(fracLatex(3, 4));
    expect(ast).toEqual([
      { type: "frac", num: [{ type: "text", value: "3" }], den: [{ type: "text", value: "4" }] },
    ]);
  });

  test("multi-digit / long fractions", () => {
    expect(show(parseMath("\\frac{123}{456}"))).toBe("(123÷456)");
    expect(show(parseMath("\\frac{1000}{9999}"))).toBe("(1000÷9999)");
    expect(show(parseMath("\\frac{7}{100000}"))).toBe("(7÷100000)");
  });

  test("\\dfrac and \\tfrac alias to frac", () => {
    expect(show(parseMath("\\dfrac{1}{2}"))).toBe("(1÷2)");
    expect(show(parseMath("\\tfrac{1}{2}"))).toBe("(1÷2)");
  });
});

describe("parseMath — mixed numbers (juxtaposition)", () => {
  test("whole number immediately before a fraction", () => {
    // The screenshot case: "9 4/9".
    const ast = parseMath(mixedLatex(9, 4, 9));
    expect(show(ast)).toBe("9(4÷9)");
    expect(ast[0]).toEqual({ type: "text", value: "9" });
    expect(ast[1].type).toBe("frac");
  });

  test("multi-digit whole with fraction", () => {
    expect(show(parseMath(mixedLatex(12, 3, 8)))).toBe("12(3÷8)");
  });
});

describe("parseMath — variables", () => {
  test("single-letter variables in numerator and denominator", () => {
    expect(show(parseMath("\\frac{x}{y}"))).toBe("(x÷y)");
  });

  test("expression numerator with a variable", () => {
    expect(show(parseMath("\\frac{n+1}{2}"))).toBe("(n+1÷2)");
  });

  test("variable mixed with a coefficient", () => {
    expect(show(parseMath("2\\frac{a}{b}"))).toBe("2(a÷b)");
  });
});

describe("parseMath — blanks (?, \\square) in every slot", () => {
  test("? in the numerator", () => {
    const ast = parseMath("\\frac{?}{9}");
    expect(ast[0]).toEqual({ type: "frac", num: [{ type: "blank" }], den: [{ type: "text", value: "9" }] });
    expect(show(ast)).toBe("(▢÷9)");
  });

  test("? in the denominator", () => {
    expect(show(parseMath("\\frac{9}{?}"))).toBe("(9÷▢)");
  });

  test("? in BOTH slots", () => {
    expect(show(parseMath("\\frac{?}{?}"))).toBe("(▢÷▢)");
  });

  test("\\square as the blank sentinel", () => {
    expect(show(parseMath(fracLatex(BLANK, 9)))).toBe("(▢÷9)");
    expect(show(parseMath(fracLatex("?", 9)))).toBe("(▢÷9)"); // fracLatex passes ? through
  });

  test("standalone \\square (not inside a frac)", () => {
    expect(show(parseMath("x = \\square"))).toBe("x = ▢");
  });
});

describe("parseMath — negatives & operators", () => {
  test("negative fraction keeps a leading minus", () => {
    const ast = parseMath("-\\frac{3}{4}");
    // The lone leading "-" becomes a true minus glyph in the text run.
    expect(ast[0]).toEqual({ type: "text", value: "−" });
    expect(show(ast)).toBe("−(3÷4)");
  });

  test("\\times / \\div prettify to × ÷", () => {
    expect(show(parseMath("\\frac{1}{2}\\times\\frac{3}{4}"))).toBe("(1÷2)×(3÷4)");
    expect(show(parseMath("6\\div 2"))).toBe("6÷2");
  });

  test("hyphen inside a word is NOT turned into a minus", () => {
    expect(show(parseMath("ten-thousands"))).toBe("ten-thousands");
  });
});

describe("parseMath — fractions inside a sentence (the practice stem)", () => {
  test("the screenshot stem: mixed number + blank fraction in prose", () => {
    // "Write 9 4/9 as ?/9" once generated as LaTeX.
    const latex = `Write ${mixedLatex(9, 4, 9)} as ${fracLatex("?", 9)}`;
    const ast = parseMath(latex);
    expect(show(ast)).toBe("Write 9(4÷9) as (▢÷9)");
    // Structure: text, frac, text, frac.
    expect(ast.map((n) => n.type)).toEqual(["text", "frac", "text", "frac"]);
  });

  test("two comparison fractions with a relation between them", () => {
    expect(show(parseMath("\\frac{2}{3} > \\frac{1}{2}"))).toBe("(2÷3) > (1÷2)");
  });
});

describe("parseMath — nested fractions", () => {
  test("a fraction inside a numerator", () => {
    expect(show(parseMath("\\frac{\\frac{1}{2}}{3}"))).toBe("((1÷2)÷3)");
  });

  test("complex fraction both slots", () => {
    expect(show(parseMath("\\frac{\\frac{1}{2}}{\\frac{3}{4}}"))).toBe("((1÷2)÷(3÷4))");
  });
});

describe("parseMath — graceful degradation (never throws)", () => {
  test("malformed \\frac with a missing brace stays literal-ish", () => {
    expect(() => parseMath("\\frac{1}")).not.toThrow();
    expect(() => parseMath("\\frac")).not.toThrow();
    expect(() => parseMath("\\frac{1}{2")).not.toThrow();
  });

  test("plain text with no math is one text node", () => {
    expect(parseMath("How many tens are in 340?")).toEqual([
      { type: "text", value: "How many tens are in 340?" },
    ]);
  });

  test("whitespace between \\frac and its braces is tolerated", () => {
    expect(show(parseMath("\\frac {1}{2}"))).toBe("(1÷2)");
  });

  test("$-delimiters and \\left/\\right wrappers are stripped", () => {
    expect(show(parseMath("$\\frac{1}{2}$"))).toBe("(1÷2)");
    expect(show(parseMath("\\left(\\frac{1}{2}\\right)"))).toBe("((1÷2))");
  });

  test("empty string → no nodes", () => {
    expect(parseMath("")).toEqual([]);
  });
});

describe("asciiToLatex — migration bridge for existing stems", () => {
  test("mixed number", () => {
    expect(asciiToLatex("9 4/9")).toBe("9\\frac{4}{9}");
  });

  test("simple fraction", () => {
    expect(asciiToLatex("3/4")).toBe("\\frac{3}{4}");
  });

  test("blanks in either slot", () => {
    expect(asciiToLatex("?/9")).toBe("\\frac{\\square}{9}");
    expect(asciiToLatex("9/?")).toBe("\\frac{9}{\\square}");
  });

  test("the full screenshot stem round-trips through parseMath", () => {
    const latex = asciiToLatex("Write 9 4/9 as ?/9");
    expect(latex).toBe("Write 9\\frac{4}{9} as \\frac{\\square}{9}");
    expect(show(parseMath(latex))).toBe("Write 9(4÷9) as (▢÷9)");
  });

  test("does NOT mangle non-fraction slashes", () => {
    // Dates and ratios that happen to contain a slash are left alone by the
    // conservative rule (guards keep it from firing mid-token).
    expect(asciiToLatex("and/or")).toBe("and/or");
    expect(asciiToLatex("TCP/IP")).toBe("TCP/IP");
  });

  test("multiple fractions in one stem", () => {
    expect(asciiToLatex("1/2 + 3/4")).toBe("\\frac{1}{2} + \\frac{3}{4}");
  });

  test("a fraction at the end of a sentence still converts", () => {
    // The trailing guard must allow sentence punctuation (a period that is NOT
    // a decimal point) — otherwise "…= 3/4." would render as raw ASCII.
    expect(asciiToLatex("The answer is 3/4.")).toBe("The answer is \\frac{3}{4}.");
    expect(asciiToLatex("It equals 9 4/9.")).toBe("It equals 9\\frac{4}{9}.");
  });

  test("a real decimal denominator is NOT split into a fraction", () => {
    expect(asciiToLatex("3/4.5")).toBe("3/4.5");
    expect(asciiToLatex("3.5/4")).toBe("3.5/4");
  });

  test("a slash-chained date is left alone", () => {
    expect(asciiToLatex("12/25/2024")).toBe("12/25/2024");
  });
});

describe("looksLikeMath — the currency guard", () => {
  test("a LaTeX macro is math", () => {
    expect(looksLikeMath("\\frac{3}{4}")).toBe(true);
    expect(looksLikeMath("x \\times 2")).toBe(true);
  });

  test("a bare fraction / mixed number is math", () => {
    expect(looksLikeMath("3/4")).toBe(true);
    expect(looksLikeMath("9 4/9")).toBe(true);
    expect(looksLikeMath("?/9")).toBe(true);
  });

  test("money and plain numbers are NOT math", () => {
    expect(looksLikeMath("5")).toBe(false);
    expect(looksLikeMath("5 and spend ")).toBe(false);
    expect(looksLikeMath("3.50")).toBe(false);
  });

  test("bare exponents / equations are math even without a macro", () => {
    expect(looksLikeMath("10^{3} = 1000")).toBe(true);
    expect(looksLikeMath("2^{n}")).toBe(true);
    expect(looksLikeMath("10^{-3}")).toBe(true);
    expect(looksLikeMath("x_1")).toBe(true);
  });
});

describe("splitMathSegments — prose ↔ math", () => {
  test("no math → a single text segment", () => {
    expect(splitMathSegments("just plain words")).toEqual([
      { type: "text", value: "just plain words" },
    ]);
  });

  test("inline $..$ fraction, bridged from ASCII", () => {
    expect(splitMathSegments("it is $3/4$ done")).toEqual([
      { type: "text", value: "it is " },
      { type: "math", latex: "\\frac{3}{4}", display: false },
      { type: "text", value: " done" },
    ]);
  });

  test("a LaTeX macro passes through untouched", () => {
    expect(splitMathSegments("half is $\\frac{1}{2}$")).toEqual([
      { type: "text", value: "half is " },
      { type: "math", latex: "\\frac{1}{2}", display: false },
    ]);
  });

  test("display $$..$$ is flagged display", () => {
    const segs = splitMathSegments("$$\\frac{1}{2} + \\frac{1}{4} = \\square$$");
    expect(segs).toHaveLength(1);
    expect(segs[0]).toMatchObject({ type: "math", display: true });
  });

  test("currency stays literal text — no false math", () => {
    expect(splitMathSegments("I have $5 and spend $3 today")).toEqual([
      { type: "text", value: "I have $5 and spend $3 today" },
    ]);
  });

  test("bare-exponent span renders as math (no backslash needed)", () => {
    expect(splitMathSegments("write it as $10^{3} = 1000$ today")).toEqual([
      { type: "text", value: "write it as " },
      { type: "math", latex: "10^{3} = 1000", display: false },
      { type: "text", value: " today" },
    ]);
  });

  test("mixed prose, money, and a real fraction together", () => {
    const segs = splitMathSegments("A $2 slice is $1/8$ of the pie");
    expect(segs).toEqual([
      { type: "text", value: "A $2 slice is " },
      { type: "math", latex: "\\frac{1}{8}", display: false },
      { type: "text", value: " of the pie" },
    ]);
  });
});

describe("hasInlineMath", () => {
  test("true only when a renderable math span exists", () => {
    expect(hasInlineMath("what is $\\frac{1}{2}$?")).toBe(true);
    expect(hasInlineMath("that costs $5 dollars")).toBe(false);
    expect(hasInlineMath("no math here")).toBe(false);
  });
});

describe("hasFraction — bare-label guard for stems / choices", () => {
  test("detects ASCII and LaTeX fractions", () => {
    expect(hasFraction("3/4")).toBe(true);
    expect(hasFraction("9 4/9")).toBe(true);
    expect(hasFraction("\\frac{1}{2}")).toBe(true);
  });

  test("false for plain choices and operators", () => {
    expect(hasFraction("42")).toBe(false);
    expect(hasFraction("<")).toBe(false);
    expect(hasFraction("greater than")).toBe(false);
  });
});

describe("latexToSpeech — screen-reader reading", () => {
  test("a bare fraction reads 'over'", () => {
    expect(latexToSpeech("\\frac{3}{4}")).toBe("3 over 4");
  });

  test("a mixed number inserts 'and'", () => {
    expect(latexToSpeech("9\\frac{4}{9}")).toBe("9 and 4 over 9");
  });

  test("a blank reads 'blank'", () => {
    expect(latexToSpeech("\\frac{\\square}{9}")).toBe("blank over 9");
  });

  test("prose around a fraction is preserved", () => {
    expect(latexToSpeech("Write 9\\frac{4}{9} as \\frac{\\square}{9}")).toBe(
      "Write 9 and 4 over 9 as blank over 9",
    );
  });
});
