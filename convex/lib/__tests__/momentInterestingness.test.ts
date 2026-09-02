import { describe, expect, test } from "vitest";
import {
  scoreMastery,
  scoreSignal,
  scoreConnection,
} from "../momentInterestingness";

describe("scoreMastery", () => {
  test("a flagged misconception is a high-interest 'misconception'", () => {
    const r = scoreMastery({
      masteryLevel: 1,
      confidenceScore: 0.9,
      evidenceType: "misconception_signal",
      studentInitiated: false,
    });
    expect(r.kind).toBe("misconception");
    expect(r.score).toBeGreaterThan(0.6);
  });

  test("deep, student-initiated mastery is a 'breakthrough' and beats shallow mastery", () => {
    const deep = scoreMastery({
      masteryLevel: 5,
      confidenceScore: 0.9,
      evidenceType: "direct_demonstration",
      studentInitiated: true,
    });
    const shallow = scoreMastery({
      masteryLevel: 2,
      confidenceScore: 0.9,
      evidenceType: "direct_demonstration",
      studentInitiated: false,
    });
    expect(deep.kind).toBe("breakthrough");
    expect(shallow.kind).toBe("mastery");
    expect(deep.score).toBeGreaterThan(shallow.score);
  });

  test("low confidence drags the score down", () => {
    const hi = scoreMastery({ masteryLevel: 5, confidenceScore: 1, evidenceType: "direct_demonstration", studentInitiated: true });
    const lo = scoreMastery({ masteryLevel: 5, confidenceScore: 0, evidenceType: "direct_demonstration", studentInitiated: true });
    expect(hi.score).toBeGreaterThan(lo.score);
  });

  test("scores stay within [0,1]", () => {
    const r = scoreMastery({ masteryLevel: 5, confidenceScore: 1, evidenceType: "misconception_signal", studentInitiated: true });
    expect(r.score).toBeLessThanOrEqual(1);
    expect(r.score).toBeGreaterThanOrEqual(0);
  });
});

describe("scoreSignal", () => {
  test("high-intensity rich signal beats low-intensity plain one", () => {
    const rich = scoreSignal({ signalType: "creative_approach", intensity: "high" });
    const plain = scoreSignal({ signalType: "task_commitment", intensity: "low" });
    expect(rich.kind).toBe("signal");
    expect(rich.score).toBeGreaterThan(plain.score);
    expect(rich.score).toBeLessThanOrEqual(1);
  });
});

describe("scoreConnection", () => {
  test("student-initiated, multi-domain connection scores high", () => {
    const r = scoreConnection({ domains: ["math", "art", "music"], studentInitiated: true });
    expect(r.kind).toBe("insight");
    expect(r.score).toBeGreaterThan(0.6);
    expect(r.score).toBeLessThanOrEqual(1);
  });
});
