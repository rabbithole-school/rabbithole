import { describe, expect, test } from "vitest";
import {
  formatGradeRange,
  gradeLabelFromRank,
  gradeRangeLabel,
  gradeRank,
} from "./gradeRange";

describe("gradeRank", () => {
  test("maps K to 0 (case-insensitive) and numerics to their value", () => {
    expect(gradeRank("K")).toBe(0);
    expect(gradeRank("k")).toBe(0);
    expect(gradeRank("1")).toBe(1);
    expect(gradeRank("12")).toBe(12);
    expect(gradeRank(" 4 ")).toBe(4);
  });

  test("returns null for unknown / empty / nullish", () => {
    expect(gradeRank(null)).toBeNull();
    expect(gradeRank(undefined)).toBeNull();
    expect(gradeRank("")).toBeNull();
    expect(gradeRank("PK")).toBeNull();
  });
});

describe("gradeLabelFromRank", () => {
  test("0 (and below) renders as K, positives as their number", () => {
    expect(gradeLabelFromRank(0)).toBe("K");
    expect(gradeLabelFromRank(-1)).toBe("K");
    expect(gradeLabelFromRank(6)).toBe("6");
  });
});

describe("formatGradeRange", () => {
  test("collapses an equal span to a single grade", () => {
    expect(formatGradeRange(4, 4)).toBe("Grade 4");
    expect(formatGradeRange(0, 0)).toBe("Grade K");
  });

  test("renders a span with an en dash, low→high", () => {
    expect(formatGradeRange(0, 6)).toBe("Grade K\u20136");
    expect(formatGradeRange(4, 5)).toBe("Grade 4\u20135");
    expect(formatGradeRange(6, 0)).toBe("Grade K\u20136");
  });

  test("null when either bound is unknown", () => {
    expect(formatGradeRange(null, 6)).toBeNull();
    expect(formatGradeRange(4, null)).toBeNull();
    expect(formatGradeRange(undefined, undefined)).toBeNull();
  });
});

describe("gradeRangeLabel", () => {
  test("spans the known grades, ignoring unknown tokens", () => {
    expect(gradeRangeLabel(["K", "3", "6"])).toBe("Grade K\u20136");
    expect(gradeRangeLabel(["4", "5", "4"])).toBe("Grade 4\u20135");
    expect(gradeRangeLabel(["4", null, "4", undefined])).toBe("Grade 4");
  });

  test("null when no token carries a known grade", () => {
    expect(gradeRangeLabel([null, undefined, "", "PK"])).toBeNull();
    expect(gradeRangeLabel([])).toBeNull();
  });
});
