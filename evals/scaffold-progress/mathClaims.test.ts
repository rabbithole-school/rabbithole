/**
 * The arithmetic READER's own tests.
 *
 * Everything the tightened sweep concludes rests on this module reading a
 * step's prose correctly, so the cases here pin the parts that are easy to get
 * subtly wrong: exactness (no float epsilon), the fraction bar's precedence,
 * and the promise that a span the grammar cannot read is REPORTED rather than
 * dropped.
 */
import { describe, expect, it } from "vitest";
import {
  claimsIn,
  isPowerOfTen,
  isPowerOfTenMultiple,
  parseExpression,
  ratAdd,
  ratEq,
  ratFromLiteral,
  ratToString,
} from "./mathClaims";

const value = (text: string): string => {
  const e = parseExpression(text);
  if (!e) throw new Error(`unparsed: ${text}`);
  return ratToString(e.value);
};

describe("exact rationals", () => {
  it("adds decimals without floating-point drift", () => {
    const a = ratFromLiteral("0.1");
    const b = ratFromLiteral("0.2");
    const c = ratFromLiteral("0.3");
    expect(a && b && c && ratEq(ratAdd(a, b), c)).toBe(true);
    // The same comparison in binary floating point is false, which is exactly
    // why the audit does not use `number` anywhere.
    expect(0.1 + 0.2 === 0.3).toBe(false);
  });

  it("divides decimals exactly", () => {
    // 15.3 ÷ 9 is 1.7000000000000002 in float64.
    expect(value("15.3 ÷ 9")).toBe("17/10");
  });

  it("recognises a decimal-point move as the same digits", () => {
    const a = ratFromLiteral("557");
    const b = ratFromLiteral("5.57");
    expect(a && b && isPowerOfTenMultiple(a, b)).toBe(true);
    expect(a && b && isPowerOfTenMultiple(b, a)).toBe(true);
    const c = ratFromLiteral("5.58");
    expect(a && c && isPowerOfTenMultiple(a, c)).toBe(false);
  });

  it("is strict about what counts as a power of ten", () => {
    const ten = ratFromLiteral("10");
    const tenth = ratFromLiteral("0.1");
    const two = ratFromLiteral("2");
    expect(ten && isPowerOfTen(ten)).toBe(true);
    expect(tenth && isPowerOfTen(tenth)).toBe(true);
    expect(two && isPowerOfTen(two)).toBe(false);
  });
});

describe("the grammar", () => {
  it("applies × and ÷ before + and −", () => {
    expect(value("7 + 5 × 6")).toBe("37");
    expect(value("40 − 12 ÷ 4")).toBe("37");
  });

  it("honours parentheses", () => {
    expect(value("(7 + 5) × 6")).toBe("72");
  });

  it("binds a GLUED fraction bar tighter than ÷", () => {
    // Read left-associatively `2 ÷ 1/8` would be (2 ÷ 1) ÷ 8 = 1/4, but the
    // generators write division by a fraction exactly this way and mean
    // 2 ÷ (1/8) = 16. The fraction is one factor, not two operands.
    expect(value("2 ÷ 1/8")).toBe("16");
    expect(value("3/4 × 2/3")).toBe("1/2");
  });

  it("reads a chained equation as one claim over several sides", () => {
    const claims = claimsIn("Multiply across: 1/(7 × 5) = 1/35.");
    expect(claims).toHaveLength(1);
    expect(claims[0]?.kind).toBe("equation");
    if (claims[0]?.kind === "equation") {
      expect(claims[0].consistent).toBe(true);
      expect(claims[0].sides).toHaveLength(2);
    }
  });

  it("catches an equation whose sides disagree", () => {
    const claims = claimsIn("Multiply the tens: 60 × 2 = 130.");
    expect(claims[0]?.kind).toBe("equation");
    if (claims[0]?.kind === "equation") expect(claims[0].consistent).toBe(false);
  });

  it("collapses a run of bare numbers into a data set", () => {
    const claims = claimsIn("Put them in order: 7, 9, 10, 12, 14.");
    expect(claims).toHaveLength(1);
    expect(claims[0]?.kind).toBe("list");
    if (claims[0]?.kind === "list") expect(claims[0].values).toHaveLength(5);
  });

  it("keeps a parenthesised aside separate from the sentence beside it", () => {
    // ":" and letters break a math span, which is what keeps "(5)" from being
    // read as a factor of "50 ÷ 5".
    const claims = claimsIn("Divide by how many there are (5): 50 ÷ 5 = 10.");
    expect(claims.map((c) => c.kind)).toEqual(["value", "equation"]);
  });

  it("ignores prose with no arithmetic in it", () => {
    expect(claimsIn("Line up the decimal points.")).toEqual([]);
  });

  it("REPORTS a span it cannot read instead of dropping it", () => {
    const claims = claimsIn("Something odd: 4 + + 9.");
    expect(claims.map((c) => c.kind)).toContain("unparsed");
  });
});
