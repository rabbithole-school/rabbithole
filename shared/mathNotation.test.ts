import { describe, it, expect } from "vitest";
import { superscriptExponents } from "./mathNotation";

describe("superscriptExponents", () => {
  it("converts a simple integer exponent", () => {
    expect(superscriptExponents("5^2 = ?")).toBe("5² = ?");
  });

  it("handles multi-digit exponents", () => {
    expect(superscriptExponents("10^12")).toBe("10¹²");
    expect(superscriptExponents("2^10")).toBe("2¹⁰");
  });

  it("converts every caret in a prime factorization", () => {
    expect(
      superscriptExponents("The prime factorization of 90 is 2 · 3^2 · 5"),
    ).toBe("The prime factorization of 90 is 2 · 3² · 5");
    expect(superscriptExponents("2^4 · 3^2 · 5")).toBe("2⁴ · 3² · 5");
  });

  it("treats a letter as a valid base (variable^digits)", () => {
    expect(superscriptExponents("Simplify x^2 + 1")).toBe("Simplify x² + 1");
    expect(superscriptExponents("x^2y^3")).toBe("x²y³");
  });

  it("handles a closing bracket / paren as the base", () => {
    expect(superscriptExponents("(a+b)^2")).toBe("(a+b)²");
    expect(superscriptExponents("[3]^2")).toBe("[3]²");
  });

  it("does NOT mangle non-numeric exponents like a^b", () => {
    expect(superscriptExponents("a^b")).toBe("a^b");
    expect(superscriptExponents("x^n + y^m")).toBe("x^n + y^m");
  });

  it("leaves negative / stray carets untouched (only integer exponents convert)", () => {
    expect(superscriptExponents("10^-3")).toBe("10^-3");
    expect(superscriptExponents("^2")).toBe("^2"); // no base token before the caret
    expect(superscriptExponents(" ^ 2")).toBe(" ^ 2");
  });

  it("is a no-op when there is no caret", () => {
    expect(superscriptExponents("What is 5 squared?")).toBe("What is 5 squared?");
    expect(superscriptExponents("GCF(12, 18) = ?")).toBe("GCF(12, 18) = ?");
    expect(superscriptExponents("")).toBe("");
  });

  it("does not mangle ordinary prose without exponents", () => {
    const s = "Touch each dot once as you count.";
    expect(superscriptExponents(s)).toBe(s);
  });

  it("passes null / undefined through unchanged", () => {
    expect(superscriptExponents(undefined)).toBeUndefined();
    expect(superscriptExponents(null)).toBeNull();
  });

  it("converts a full exponent stem end to end", () => {
    expect(superscriptExponents("3^4 = ?")).toBe("3⁴ = ?");
    expect(
      superscriptExponents("The prime factorization of 720 is 2^4 · 3^2 · 5. What is the exponent of 2?"),
    ).toBe("The prime factorization of 720 is 2⁴ · 3² · 5. What is the exponent of 2?");
  });

  // A unit-bearing answer's hardware-typed caret ("cm^3") must read as the same
  // real superscript a tapped unit key already produces ("cm³") — the practice
  // surfaces call this SAME function on the answer buffer as a scholar types
  // (see PracticeSession.tsx/Placement.tsx/ReprobeOffer.tsx/ChatPracticeItem.tsx
  // `onKey`/`onChange` and native's `PracticePadAnswer` `onChangeText`). The
  // base letter ("m", "c") is not itself a caret target, so only the unit's
  // trailing `^<digit>` converts.
  it("converts a unit's caret exponent (volume/area answer suffix)", () => {
    expect(superscriptExponents("112 cm^3")).toBe("112 cm³");
    expect(superscriptExponents("24 m^2")).toBe("24 m²");
    expect(superscriptExponents("6.5 cm^3")).toBe("6.5 cm³");
  });

  it("is idempotent on an already-converted unit suffix (re-running is a no-op)", () => {
    expect(superscriptExponents("112 cm³")).toBe("112 cm³");
    expect(superscriptExponents(superscriptExponents("112 cm^3"))).toBe("112 cm³");
  });

  it("leaves an in-progress caret with no digit yet untouched", () => {
    // The scholar has typed "112 cm^" but not the exponent digit — nothing to
    // convert yet; this must not throw or drop the caret.
    expect(superscriptExponents("112 cm^")).toBe("112 cm^");
  });
});
