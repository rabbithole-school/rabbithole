import { describe, expect, it } from "vitest";
import {
  CALIBRATION_BIAS_THRESHOLD,
  CALIBRATION_MIN_N,
  CONFIDENCE_LEVELS,
  CONFIDENCE_VALUES,
  confidenceValue,
  mismatchReveal,
  summarizeCalibration,
  WELL_CALIBRATED_LINE,
  type ConfidenceLevel,
} from "./calibration";

/** Build n pairs at one confidence + correctness. */
function pairs(
  n: number,
  confidence: number,
  correct: boolean,
): { confidence: number; correct: boolean }[] {
  return Array.from({ length: n }, () => ({ confidence, correct }));
}

describe("confidence level mapping", () => {
  it("maps the three picks to the fixed probabilities", () => {
    expect(CONFIDENCE_VALUES).toEqual({ sure: 0.9, think_so: 0.65, not_sure: 0.35 });
    expect(confidenceValue("sure")).toBe(0.9);
    expect(confidenceValue("think_so")).toBe(0.65);
    expect(confidenceValue("not_sure")).toBe(0.35);
  });

  it("exposes an ordered chip list most → least confident, labelled", () => {
    expect(CONFIDENCE_LEVELS.map((c) => c.level)).toEqual([
      "sure",
      "think_so",
      "not_sure",
    ]);
    expect(CONFIDENCE_LEVELS.map((c) => c.label)).toEqual([
      "Sure",
      "I think so",
      "Not sure",
    ]);
    // value column agrees with the map
    for (const c of CONFIDENCE_LEVELS) {
      expect(c.value).toBe(CONFIDENCE_VALUES[c.level as ConfidenceLevel]);
    }
  });
});

describe("summarizeCalibration — empty + insufficient data", () => {
  it("returns insufficient_data with zeroed stats on empty input", () => {
    expect(summarizeCalibration([])).toEqual({
      n: 0,
      meanAbsGap: 0,
      bias: 0,
      band: "insufficient_data",
    });
  });

  it("stays insufficient_data below the minimum n, even with a huge bias", () => {
    // 7 confident misses = maximal overconfidence, but n < CALIBRATION_MIN_N.
    const s = summarizeCalibration(pairs(CALIBRATION_MIN_N - 1, 0.9, false));
    expect(s.n).toBe(CALIBRATION_MIN_N - 1);
    expect(s.band).toBe("insufficient_data");
    expect(s.bias).toBeCloseTo(0.9, 10);
  });
});

describe("summarizeCalibration — gap + bias math", () => {
  it("computes signed bias and mean absolute gap", () => {
    // 4 sure-and-correct (gap = -0.1) + 4 not_sure-and-wrong (gap = +0.35).
    const s = summarizeCalibration([
      ...pairs(4, 0.9, true),
      ...pairs(4, 0.35, false),
    ]);
    expect(s.n).toBe(8);
    // signed: (4 * -0.1 + 4 * 0.35) / 8 = (−0.4 + 1.4) / 8 = 0.125
    expect(s.bias).toBeCloseTo(0.125, 10);
    // abs: (4 * 0.1 + 4 * 0.35) / 8 = (0.4 + 1.4) / 8 = 0.225
    expect(s.meanAbsGap).toBeCloseTo(0.225, 10);
    // |bias| = 0.125 ≤ 0.18 → well_calibrated
    expect(s.band).toBe("well_calibrated");
  });

  it("a perfect predictor has zero gap and is well_calibrated", () => {
    const s = summarizeCalibration([
      ...pairs(8, 1, true),
      ...pairs(8, 0, false),
    ]);
    expect(s.meanAbsGap).toBeCloseTo(0, 10);
    expect(s.bias).toBeCloseTo(0, 10);
    expect(s.band).toBe("well_calibrated");
  });
});

describe("summarizeCalibration — band thresholds", () => {
  it("flags overconfident when confident predictions run ahead of results", () => {
    // 8 "sure" (0.9) but only half correct → bias = 0.9 − 0.5 = 0.4 > 0.18
    const s = summarizeCalibration([
      ...pairs(4, 0.9, true),
      ...pairs(4, 0.9, false),
    ]);
    expect(s.band).toBe("overconfident");
    expect(s.bias).toBeGreaterThan(CALIBRATION_BIAS_THRESHOLD);
  });

  it("flags underconfident when results run ahead of predictions", () => {
    // 8 "not_sure" (0.35) but mostly correct → negative bias below −0.18
    const s = summarizeCalibration([
      ...pairs(7, 0.35, true),
      ...pairs(1, 0.35, false),
    ]);
    expect(s.band).toBe("underconfident");
    expect(s.bias).toBeLessThan(-CALIBRATION_BIAS_THRESHOLD);
  });

  it("is well_calibrated exactly AT the threshold (strict comparison)", () => {
    // Construct bias exactly +0.18: confidence 0.18 above outcome on every item.
    // 10 items all correct, confidence 1.18 is out of range; instead use
    // outcome 0 with confidence 0.18 → gap 0.18 each → bias 0.18 (not > 0.18).
    const s = summarizeCalibration(pairs(10, 0.18, false));
    expect(s.bias).toBeCloseTo(CALIBRATION_BIAS_THRESHOLD, 10);
    expect(s.band).toBe("well_calibrated");
  });
});

describe("mismatchReveal — only on disagreement, never shaming", () => {
  it("praises an under-confident hit (not sure, but correct)", () => {
    expect(mismatchReveal(CONFIDENCE_VALUES.not_sure, true)).toBe(
      "You weren't sure — but you had it. 👍",
    );
  });

  it("gently flags a 'sure' miss with the 'felt sure' copy", () => {
    expect(mismatchReveal(CONFIDENCE_VALUES.sure, false)).toBe(
      "You felt sure on this one — worth another look.",
    );
  });

  it("gently flags a 'think so' miss WITHOUT overstating the pick", () => {
    expect(mismatchReveal(CONFIDENCE_VALUES.think_so, false)).toBe(
      "You thought you had this one — worth another look.",
    );
  });

  it("returns null on agreement (no reveal, no noise)", () => {
    expect(mismatchReveal(CONFIDENCE_VALUES.sure, true)).toBeNull();
    expect(mismatchReveal(CONFIDENCE_VALUES.think_so, true)).toBeNull();
    expect(mismatchReveal(CONFIDENCE_VALUES.not_sure, false)).toBeNull();
  });
});

describe("well-calibrated line", () => {
  it("names the meta-skill, no score", () => {
    expect(WELL_CALIBRATED_LINE).toMatch(/know/i);
    expect(WELL_CALIBRATED_LINE).not.toMatch(/\d/);
  });
});
