import { describe, expect, test } from "vitest";
import { classifyError } from "../practice/errorPatterns";

describe("classifyError — Ashlock arithmetic error patterns", () => {
  test("detects SMALLER_FROM_LARGER subtraction borrow bugs", () => {
    expect(
      classifyError({
        skillKey: "subtract_2digit_regroup",
        stem: "52 − 38 = ?",
        learnerAnswer: "26",
        correctAnswer: "14",
      }),
    ).toBe("SMALLER_FROM_LARGER");
    expect(
      classifyError({
        skillKey: "subtract_3digit_regroup",
        stem: "402 - 178 = ?",
        learnerAnswer: "376",
        correctAnswer: "224",
      }),
    ).toBe("SMALLER_FROM_LARGER");
  });

  test("detects DROPPED_CARRY addition bugs", () => {
    expect(
      classifyError({
        skillKey: "add_2digit_regroup",
        stem: "47 + 25 = ?",
        learnerAnswer: "62",
        correctAnswer: "72",
      }),
    ).toBe("DROPPED_CARRY");
    expect(
      classifyError({
        skillKey: "add_3digit_regroup",
        stem: "999 + 1 = ?",
        learnerAnswer: "990",
        correctAnswer: "1000",
      }),
    ).toBe("DROPPED_CARRY");
  });

  test("detects PLACE_MISALIGNMENT when different-width operands are left-aligned", () => {
    expect(
      classifyError({
        skillKey: "add_multidigit",
        stem: "123 + 45 = ?",
        learnerAnswer: "573",
        correctAnswer: "168",
      }),
    ).toBe("PLACE_MISALIGNMENT");
    expect(
      classifyError({
        skillKey: "subtract_multidigit",
        stem: "71 - 4 = ?",
        learnerAnswer: "31",
        correctAnswer: "67",
      }),
    ).toBe("PLACE_MISALIGNMENT");
  });

  test("detects REMAINDER_IGNORED division bugs only when a real remainder exists", () => {
    expect(
      classifyError({
        skillKey: "divide_with_remainders",
        stem: "17 ÷ 5 = ?",
        learnerAnswer: "3",
        correctAnswer: "3.4",
      }),
    ).toBe("REMAINDER_IGNORED");
    expect(
      classifyError({
        skillKey: "divide_with_remainders",
        stem: "22 / 6 = ?",
        learnerAnswer: "3",
        correctAnswer: "3 r4",
      }),
    ).toBe("REMAINDER_IGNORED");
  });

  test("detects REVERSED_OPERANDS for subtraction and division", () => {
    expect(
      classifyError({
        skillKey: "subtract_with_integers",
        stem: "38 − 52 = ?",
        learnerAnswer: "14",
        correctAnswer: "-14",
      }),
    ).toBe("REVERSED_OPERANDS");
    expect(
      classifyError({
        skillKey: "divide_facts",
        stem: "2 ÷ 10 = ?",
        learnerAnswer: "5",
        correctAnswer: "0.2",
      }),
    ).toBe("REVERSED_OPERANDS");
  });

  test("detects OFF_BY_ONE_SKIP for skip-counting skills", () => {
    expect(
      classifyError({
        skillKey: "skip_count_by_5",
        stem: "Count by 5s: 5, 10, 15, 20, ?",
        learnerAnswer: "30",
        correctAnswer: "25",
      }),
    ).toBe("OFF_BY_ONE_SKIP");
    expect(
      classifyError({
        skillKey: "counting_sequence",
        stem: "What number comes after 48?",
        learnerAnswer: "50",
        correctAnswer: "49",
      }),
    ).toBe("OFF_BY_ONE_SKIP");
  });

  test("returns null for correct answers", () => {
    expect(
      classifyError({
        skillKey: "subtract_2digit_regroup",
        stem: "52 − 38 = ?",
        learnerAnswer: "14.0",
        correctAnswer: "14",
      }),
    ).toBeNull();
    expect(
      classifyError({
        skillKey: "skip_count_by_5",
        stem: "Count by 5s: 5, 10, 15, 20, ?",
        learnerAnswer: "25",
        correctAnswer: "25",
      }),
    ).toBeNull();
  });

  test("returns null for random wrong answers that fit no known pattern", () => {
    expect(
      classifyError({
        skillKey: "subtract_2digit_regroup",
        stem: "52 − 38 = ?",
        learnerAnswer: "99",
        correctAnswer: "14",
      }),
    ).toBeNull();
    expect(
      classifyError({
        skillKey: "divide_with_remainders",
        stem: "17 ÷ 5 = ?",
        learnerAnswer: "99",
        correctAnswer: "3.4",
      }),
    ).toBeNull();
  });

  test("uses deterministic priority when more than one pattern matches", () => {
    expect(
      classifyError({
        skillKey: "subtract_mixed_width",
        stem: "2 - 11 = ?",
        learnerAnswer: "9",
        correctAnswer: "-9",
      }),
    ).toBe("REVERSED_OPERANDS");
  });

  test("keeps guards conservative for nearby non-pattern cases", () => {
    expect(
      classifyError({
        skillKey: "divide_facts",
        stem: "18 ÷ 6 = ?",
        learnerAnswer: "3",
        correctAnswer: "3",
      }),
    ).toBeNull();
    expect(
      classifyError({
        skillKey: "add_2digit_no_regroup",
        stem: "24 + 13 = ?",
        learnerAnswer: "7",
        correctAnswer: "37",
      }),
    ).toBeNull();
  });
});
