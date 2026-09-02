import { describe, expect, test } from "vitest";
import { evalArithmetic } from "../practice/evalExpr";
import { verifyCandidate, verifyBatch, type Candidate } from "../practice/verify";

describe("evalArithmetic — safe restricted evaluator", () => {
  test("basic arithmetic + precedence + parens", () => {
    expect(evalArithmetic("2 + 3")).toBe(5);
    expect(evalArithmetic("2 + 3 * 4")).toBe(14);
    expect(evalArithmetic("(2 + 3) * 4")).toBe(20);
    expect(evalArithmetic("20 - 4 - 3")).toBe(13);
    expect(evalArithmetic("100 / 4")).toBe(25);
  });
  test("unicode × ÷ and fraction-as-division", () => {
    expect(evalArithmetic("6 × 7")).toBe(42);
    expect(evalArithmetic("20 ÷ 5")).toBe(4);
    expect(evalArithmetic("3/4")).toBeCloseTo(0.75, 9);
    expect(evalArithmetic("4.50 * 3")).toBeCloseTo(13.5, 9);
  });
  test("negatives and nested parens", () => {
    expect(evalArithmetic("-5 + 8")).toBe(3);
    expect(evalArithmetic("((1 + 2) * (3 + 4))")).toBe(21);
  });
  test("division by zero → null", () => {
    expect(evalArithmetic("5 / 0")).toBeNull();
  });
  test("rejects anything outside the grammar (no code execution)", () => {
    expect(evalArithmetic("a + b")).toBeNull();
    expect(evalArithmetic("alert(1)")).toBeNull();
    expect(evalArithmetic("1; 2")).toBeNull();
    expect(evalArithmetic("2 ** 3")).toBeNull(); // only single * supported
    expect(evalArithmetic("process.exit(1)")).toBeNull();
    expect(evalArithmetic("")).toBeNull();
    expect(evalArithmetic("2 +")).toBeNull();
    expect(evalArithmetic("2 2")).toBeNull();
  });
});

describe("verifyCandidate — the generation ship-gate", () => {
  const good: Candidate = {
    stem: "A box of candy costs $4.50. You buy 3 boxes. How much do they cost in total?",
    answer: "13.50",
    answerType: "decimal",
    solutionExpression: "4.50 * 3",
  };

  test("accepts a candidate whose solution computes its stated answer", () => {
    const r = verifyCandidate(good);
    expect(r.ok).toBe(true);
  });
  test("rejects when the stated answer disagrees with the solution", () => {
    const r = verifyCandidate({ ...good, answer: "12.00" });
    expect(r.ok).toBe(false);
  });
  test("rejects an unevaluable / unsafe solution expression", () => {
    const r = verifyCandidate({ ...good, solutionExpression: "price * 3" });
    expect(r.ok).toBe(false);
  });
  test("rejects a non-numeric answer type", () => {
    const r = verifyCandidate({ ...good, answerType: "multipleChoice" });
    expect(r.ok).toBe(false);
  });
  test("rejects a non-integer value claimed as integer", () => {
    const r = verifyCandidate({ stem: "Half of seven?", answer: "3", answerType: "integer", solutionExpression: "7/2" });
    expect(r.ok).toBe(false);
  });
  test("accepts a verified integer word problem", () => {
    const r = verifyCandidate({
      stem: "There are 24 cookies shared equally among 6 friends. How many does each get?",
      answer: "4",
      answerType: "integer",
      solutionExpression: "24 / 6",
    });
    expect(r.ok).toBe(true);
  });
  test("rejects Markdown formatting in plain-text stems", () => {
    const r = verifyCandidate({
      ...good,
      stem: "A box holds **3 groups** of 4 candies. How many candies are there?",
      answer: "12",
      solutionExpression: "3 * 4",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/plain text|markdown/i);
  });

  // ── Answer-FORMAT contract (the fraction-as-division bug) ──────────────────
  test("rejects an 'express as a fraction' stem typed integer (pad has no '/')", () => {
    const r = verifyCandidate({
      stem: "Maya has 8 granola bars to share equally among 4 friends. How much does each get? Express your answer as a fraction.",
      answer: "2",
      answerType: "integer",
      solutionExpression: "8 / 4",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/fraction/i);
  });
  test("rejects a fraction answer that resolves to a whole number", () => {
    const r = verifyCandidate({
      stem: "Share 8 apples among 4 kids. Express your answer as a fraction.",
      answer: "8/4",
      answerType: "fraction",
      solutionExpression: "8 / 4",
    });
    expect(r.ok).toBe(false);
  });
  test("accepts a genuine fraction-as-division item", () => {
    const r = verifyCandidate({
      stem: "3 granola bars are shared equally among 4 friends. How much does each get? Express your answer as a fraction.",
      answer: "3/4",
      answerType: "fraction",
      solutionExpression: "3 / 4",
    });
    expect(r.ok).toBe(true);
  });
  test("a whole-number share problem is fine when it does NOT ask for a fraction", () => {
    const r = verifyCandidate({
      stem: "8 stickers are shared equally among 4 kids. How many does each get?",
      answer: "2",
      answerType: "integer",
      solutionExpression: "8 / 4",
    });
    expect(r.ok).toBe(true);
  });
  test("catches fraction-instruction synonyms typed integer (broadened matcher)", () => {
    const synonyms = [
      "Share 7 among 2. Express your answer as a simplified fraction.",
      "Split 5 among 3. Write your answer as an improper fraction.",
      "Divide 5 by 4 and give the result as a reduced fraction.",
      "Share 3 among 2. Write your answer in simplest form.",
      "Share 5 among 4. Give your answer in lowest terms.",
      "Divide 3 by 4 and write the answer in fraction form.",
    ];
    for (const stem of synonyms) {
      const r = verifyCandidate({ stem, answer: "3", answerType: "integer", solutionExpression: "6 / 2" });
      expect(r.ok, stem).toBe(false);
    }
  });
  test("does NOT false-positive on 'as a whole number, not a fraction'", () => {
    const r = verifyCandidate({
      stem: "There are 8 apples for 4 kids. Give your answer as a whole number, not a fraction.",
      answer: "2",
      answerType: "integer",
      solutionExpression: "8 / 4",
    });
    expect(r.ok).toBe(true);
  });

  test("verifyBatch splits passed from rejected", () => {
    const { passed, rejected } = verifyBatch([
      good,
      { ...good, answer: "999" }, // wrong
      { ...good, solutionExpression: "nope()" }, // unsafe
    ]);
    expect(passed).toHaveLength(1);
    expect(rejected).toHaveLength(2);
    expect(rejected[0].reason).toBeTruthy();
  });
});
