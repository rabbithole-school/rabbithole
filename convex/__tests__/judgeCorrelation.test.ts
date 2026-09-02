/**
 * Judge ↔ teacher correlation math (convex/lib/judgeCorrelation.ts) — pure, no
 * model calls, no Convex. Hand-built fixtures with a known answer so the
 * agreement rate + Pearson r behind sim-realism adoptable #2 can't silently
 * drift.
 */
import { describe, expect, test } from "vitest";
import {
  computeCorrelation,
  judgeSign,
  teacherScore,
  type PairObservation,
} from "../lib/judgeCorrelation";

describe("teacherScore / judgeSign", () => {
  test("teacher choice maps A=+1, B=-1, tie=0", () => {
    expect(teacherScore("A")).toBe(1);
    expect(teacherScore("B")).toBe(-1);
    expect(teacherScore("tie")).toBe(0);
  });

  test("judge sign uses an epsilon so ~0 margins are ties", () => {
    expect(judgeSign(0.5)).toBe(1);
    expect(judgeSign(-0.5)).toBe(-1);
    expect(judgeSign(0)).toBe(0);
    expect(judgeSign(1e-12)).toBe(0);
  });
});

describe("computeCorrelation", () => {
  test("perfect agreement: judge and teacher always pick the same side", () => {
    // Judge margin sign always matches the teacher's pick, magnitudes vary.
    const obs: PairObservation[] = [
      { judgeMargin: 1.0, teacherChoice: "A" },
      { judgeMargin: 2.0, teacherChoice: "A" },
      { judgeMargin: -1.5, teacherChoice: "B" },
      { judgeMargin: -0.5, teacherChoice: "B" },
    ];
    const r = computeCorrelation(obs);
    expect(r.n).toBe(4);
    expect(r.nDecisive).toBe(4);
    expect(r.agreements).toBe(4);
    expect(r.agreement).toBe(1);
    // Positive, strong linear correlation (margins line up with +1/-1 codes).
    expect(r.r).not.toBeNull();
    expect(r.r!).toBeGreaterThan(0.9);
    expect(r.ties).toEqual({ teacher: 0, judge: 0 });
  });

  test("perfect DISagreement: judge picks the opposite side every time", () => {
    const obs: PairObservation[] = [
      { judgeMargin: 1.0, teacherChoice: "B" },
      { judgeMargin: 2.0, teacherChoice: "B" },
      { judgeMargin: -1.0, teacherChoice: "A" },
      { judgeMargin: -2.0, teacherChoice: "A" },
    ];
    const r = computeCorrelation(obs);
    expect(r.nDecisive).toBe(4);
    expect(r.agreements).toBe(0);
    expect(r.agreement).toBe(0);
    expect(r.r!).toBeLessThan(-0.9);
  });

  test("half agreement with an exact known r", () => {
    // Two agree (margin +2 → A ; margin -2 → B), two disagree
    // (margin +2 → B ; margin -2 → A). By symmetry the teacher codes are
    // +1,-1,-1,+1 against margins +2,-2,+2,-2 → covariance 0 → r = 0.
    const obs: PairObservation[] = [
      { judgeMargin: 2, teacherChoice: "A" }, // agree
      { judgeMargin: -2, teacherChoice: "B" }, // agree
      { judgeMargin: 2, teacherChoice: "B" }, // disagree
      { judgeMargin: -2, teacherChoice: "A" }, // disagree
    ];
    const r = computeCorrelation(obs);
    expect(r.nDecisive).toBe(4);
    expect(r.agreements).toBe(2);
    expect(r.agreement).toBe(0.5);
    expect(r.r).toBeCloseTo(0, 6);
  });

  test("ties: teacher-ties and judge-ties are excluded from decisive count", () => {
    const obs: PairObservation[] = [
      { judgeMargin: 1.0, teacherChoice: "A" }, // decisive, agree
      { judgeMargin: 0, teacherChoice: "A" }, // judge tie → not decisive
      { judgeMargin: 1.0, teacherChoice: "tie" }, // teacher tie → not decisive
      { judgeMargin: -1.0, teacherChoice: "B" }, // decisive, agree
    ];
    const r = computeCorrelation(obs);
    expect(r.n).toBe(4);
    expect(r.nDecisive).toBe(2);
    expect(r.agreements).toBe(2);
    expect(r.agreement).toBe(1);
    expect(r.ties).toEqual({ teacher: 1, judge: 1 });
  });

  test("no decisive pairs ⇒ agreement is null (not a divide-by-zero)", () => {
    const obs: PairObservation[] = [
      { judgeMargin: 0, teacherChoice: "A" },
      { judgeMargin: 1, teacherChoice: "tie" },
    ];
    const r = computeCorrelation(obs);
    expect(r.nDecisive).toBe(0);
    expect(r.agreement).toBeNull();
  });

  test("empty input ⇒ zeros and null r", () => {
    const r = computeCorrelation([]);
    expect(r.n).toBe(0);
    expect(r.agreement).toBeNull();
    expect(r.r).toBeNull();
  });

  test("no variance in judge margins ⇒ r is null (undefined correlation)", () => {
    const obs: PairObservation[] = [
      { judgeMargin: 1, teacherChoice: "A" },
      { judgeMargin: 1, teacherChoice: "B" },
    ];
    // teacher codes vary but every judge margin is identical → sxx=0 → r null.
    expect(computeCorrelation(obs).r).toBeNull();
  });
});
