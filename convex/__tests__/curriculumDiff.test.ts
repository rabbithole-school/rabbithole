/**
 * Pure line-diff used by the variant-review UI (convex/lib/curriculumDiff.ts).
 * Twin of evals/curriculum-sim/__tests__/diff.test.ts.
 */
import { describe, expect, test } from "vitest";
import { hasChange, lineDiff } from "../lib/curriculumDiff";

describe("lineDiff", () => {
  test("identical text is all context lines", () => {
    const d = lineDiff("a\nb\nc", "a\nb\nc");
    expect(d.every((l) => l.sign === " ")).toBe(true);
    expect(hasChange("a\nb\nc", "a\nb\nc")).toBe(false);
  });

  test("a changed middle line shows as -/+ around kept context", () => {
    const d = lineDiff("a\nb\nc", "a\nB\nc");
    expect(d.map((l) => l.sign + l.text)).toEqual([" a", "-b", "+B", " c"]);
    expect(hasChange("a\nb\nc", "a\nB\nc")).toBe(true);
  });

  test("appended line shows as a single +", () => {
    const d = lineDiff("a\nb", "a\nb\nc");
    expect(d.filter((l) => l.sign === "+").map((l) => l.text)).toEqual(["c"]);
    expect(d.filter((l) => l.sign === "-")).toHaveLength(0);
  });

  test("removed line shows as a single -", () => {
    const d = lineDiff("a\nb\nc", "a\nc");
    expect(d.filter((l) => l.sign === "-").map((l) => l.text)).toEqual(["b"]);
  });
});
