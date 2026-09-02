import { describe, expect, it } from "vitest";
import {
  growthLineForBand,
  strongestSignalHeadline,
  summarizeByConfidenceLevel,
  WELL_CALIBRATED_LINE,
  type ConfidenceLevelBreakdown,
} from "./calibration";

/** Build n pairs at one confidence + correctness. */
function pairs(
  n: number,
  confidence: number,
  correct: boolean,
): { confidence: number; correct: boolean }[] {
  return Array.from({ length: n }, () => ({ confidence, correct }));
}

describe("summarizeByConfidenceLevel — parallel view of the same pairs", () => {
  it("always returns all three levels in chip order, zero-filled where empty", () => {
    const rows = summarizeByConfidenceLevel([]);
    expect(rows.map((r) => r.level)).toEqual(["sure", "think_so", "not_sure"]);
    for (const r of rows) {
      expect(r.correct).toBe(0);
      expect(r.total).toBe(0);
    }
  });

  it("buckets by the exact confidence value each level maps to", () => {
    const rows = summarizeByConfidenceLevel([
      ...pairs(9, 0.9, true), // sure, 9/9 right (1 wrong to make it interesting below)
      ...pairs(3, 0.65, true), // think_so, all right
      ...pairs(2, 0.35, false), // not_sure, all wrong
    ]);
    const sure = rows.find((r) => r.level === "sure")!;
    const thinkSo = rows.find((r) => r.level === "think_so")!;
    const notSure = rows.find((r) => r.level === "not_sure")!;
    expect(sure).toEqual({ level: "sure", label: "Sure", correct: 9, total: 9 });
    expect(thinkSo).toEqual({ level: "think_so", label: "I think so", correct: 3, total: 3 });
    expect(notSure).toEqual({ level: "not_sure", label: "Not sure", correct: 0, total: 2 });
  });

  it("totals reconcile with the input length", () => {
    const input = [...pairs(4, 0.9, true), ...pairs(4, 0.9, false), ...pairs(2, 0.35, true)];
    const rows = summarizeByConfidenceLevel(input);
    const total = rows.reduce((sum, r) => sum + r.total, 0);
    expect(total).toBe(input.length);
  });
});

describe("growthLineForBand — a sentence key, never a number", () => {
  it("maps well_calibrated to the existing WELL_CALIBRATED_LINE (reused, not forked)", () => {
    expect(growthLineForBand("well_calibrated")).toBe(WELL_CALIBRATED_LINE);
  });

  it("gives a warm, non-numeric line for each directional band", () => {
    const over = growthLineForBand("overconfident");
    const under = growthLineForBand("underconfident");
    expect(over).not.toBeNull();
    expect(under).not.toBeNull();
    expect(over).not.toMatch(/\d/);
    expect(under).not.toMatch(/\d/);
    expect(over).not.toBe(under);
  });

  it("insufficient_data maps to null — no line, no nag", () => {
    expect(growthLineForBand("insufficient_data")).toBeNull();
  });
});

describe("strongestSignalHeadline — the one concrete number the mirror shows", () => {
  it("names the level with the MOST data and its right/total", () => {
    const byLevel: ConfidenceLevelBreakdown[] = [
      { level: "sure", label: "Sure", correct: 9, total: 10 },
      { level: "think_so", label: "I think so", correct: 2, total: 3 },
      { level: "not_sure", label: "Not sure", correct: 0, total: 0 },
    ];
    expect(strongestSignalHeadline(byLevel)).toBe(
      'When you said "Sure", you were right 9 out of 10.',
    );
  });

  it("breaks ties toward the most-confident level (chip order)", () => {
    const byLevel: ConfidenceLevelBreakdown[] = [
      { level: "sure", label: "Sure", correct: 4, total: 5 },
      { level: "think_so", label: "I think so", correct: 4, total: 5 },
      { level: "not_sure", label: "Not sure", correct: 0, total: 0 },
    ];
    expect(strongestSignalHeadline(byLevel)).toBe(
      'When you said "Sure", you were right 4 out of 5.',
    );
  });

  it("returns null when every level is empty", () => {
    const byLevel: ConfidenceLevelBreakdown[] = [
      { level: "sure", label: "Sure", correct: 0, total: 0 },
      { level: "think_so", label: "I think so", correct: 0, total: 0 },
      { level: "not_sure", label: "Not sure", correct: 0, total: 0 },
    ];
    expect(strongestSignalHeadline(byLevel)).toBeNull();
  });
});
