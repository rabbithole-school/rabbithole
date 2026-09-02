import { describe, expect, test } from "vitest";
import { analyzeMathFormat } from "./mathFormat";

// This suite is the deterministic half of the math-format quality gate: it does
// NOT call a model, but it proves the validator works AND that the exact
// examples the tutor prompt tells the model to emit render as real math through
// our shared parser. The live half (feeding fraction scenarios through the
// model and running analyzeMathFormat over the replies) is math-format-check.ts,
// which needs an ANTHROPIC_API_KEY.

describe("analyzeMathFormat — compliant tutor output", () => {
  test("the prompt's own inline example renders as real math", () => {
    // Straight from the math-format bullet in convex/prompts.ts.
    const r = analyzeMathFormat("Three-quarters is $\\frac{3}{4}$ of the whole.");
    expect(r.compliant).toBe(true);
    expect(r.mathSpans).toBe(1);
    expect(r.leakedFractions).toEqual([]);
  });

  test("the prompt's display example (with a blank) is well-formed", () => {
    const r = analyzeMathFormat("Try it: $$\\frac{1}{2} + \\frac{1}{4} = \\square$$");
    expect(r.compliant).toBe(true);
    expect(r.mathSpans).toBe(1);
    expect(r.displaySpans).toBe(1);
  });

  test("a bare-ASCII fraction inside $..$ is bridged and counts as math", () => {
    const r = analyzeMathFormat("So we get $3/4$ of a pizza.");
    expect(r.compliant).toBe(true);
    expect(r.mathSpans).toBe(1);
  });

  test("plain whole numbers and prices are left alone (not flagged)", () => {
    const r = analyzeMathFormat("You have 7 apples and it costs 3 dollars.");
    expect(r.compliant).toBe(true);
    expect(r.mathSpans).toBe(0);
    expect(r.leakedFractions).toEqual([]);
  });

  test("a mixed number wrapped as math is compliant", () => {
    const r = analyzeMathFormat("That's $9\\frac{4}{9}$ pizzas total.");
    expect(r.compliant).toBe(true);
    expect(r.mathSpans).toBe(1);
  });
});

describe("analyzeMathFormat — catches the failures we care about", () => {
  test("a LEAKED bare fraction in prose fails the check", () => {
    const r = analyzeMathFormat("Just add them: 3/4 plus 1/4 makes a whole.");
    expect(r.compliant).toBe(false);
    expect(r.leakedFractions.length).toBeGreaterThan(0);
  });

  test("a leaked mixed number fails the check", () => {
    const r = analyzeMathFormat("The answer is 9 4/9 pizzas.");
    expect(r.compliant).toBe(false);
    expect(r.leakedFractions.length).toBeGreaterThan(0);
  });

  test("a malformed span (empty denominator) is flagged", () => {
    const r = analyzeMathFormat("Broken: $\\frac{3}{}$");
    expect(r.compliant).toBe(false);
    expect(r.malformedSpans.length).toBeGreaterThan(0);
  });

  test("word-slash idioms are NOT mistaken for leaked fractions", () => {
    // The bridge is conservative about non-numeric slashes.
    const r = analyzeMathFormat("Use and/or here, and read the TCP/IP chapter.");
    expect(r.compliant).toBe(true);
    expect(r.leakedFractions).toEqual([]);
  });

  test("a bare NUMERIC slash IS treated as a fraction (intended sensitivity)", () => {
    // "12/25" reads as twelve twenty-fifths to the renderer, so a bare numeric
    // slash in prose is flagged — the tutor should wrap real fractions in $..$
    // and spell dates out in words.
    const r = analyzeMathFormat("It happens on 12/25 each year.");
    expect(r.compliant).toBe(false);
    expect(r.leakedFractions.length).toBeGreaterThan(0);
  });
});
