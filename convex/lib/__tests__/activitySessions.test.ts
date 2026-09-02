import { describe, expect, test } from "vitest";
import {
  activitySessions,
  EMPTY_SESSIONS,
  rollupSessions,
  sessionsMeanIsWeak,
  totalSessions,
  type SessionsSignal,
} from "../activitySessions";

// ─── Signal 2 · Sessions (the violet field record, PR #1072 §7/§8) ─────────
describe("activitySessions — one activity's record from raw numbers", () => {
  test("no judged sessions ⇒ null mean (never faked from zero data)", () => {
    const s = activitySessions({ activeCount: 3, completeCount: 0, fitnesses: [] });
    expect(s.meanFitness).toBeNull();
    expect(s.fitnessN).toBe(0);
    expect(totalSessions(s)).toBe(3);
  });

  test("mean is the arithmetic mean of judged fitnesses; n is their count", () => {
    const s = activitySessions({
      activeCount: 1,
      completeCount: 2,
      fitnesses: [4, 5],
    });
    expect(s.meanFitness).toBeCloseTo(4.5);
    expect(s.fitnessN).toBe(2);
    expect(s.fitnesses).toEqual([4, 5]);
    expect(totalSessions(s)).toBe(3); // active + complete, independent of fitnessN
  });

  test("simMean carries the sims' prediction for the calibration overlay", () => {
    const s = activitySessions({
      activeCount: 0,
      completeCount: 1,
      fitnesses: [3],
      simMean: 4.2,
    });
    expect(s.simMean).toBeCloseTo(4.2);
  });

  test("simSessionCount carries the rehearsal sim volume (defaults to 0)", () => {
    expect(
      activitySessions({ activeCount: 0, completeCount: 0, fitnesses: [] })
        .simSessionCount,
    ).toBe(0);
    expect(
      activitySessions({
        activeCount: 0,
        completeCount: 0,
        fitnesses: [],
        simSessionCount: 4,
      }).simSessionCount,
    ).toBe(4);
  });
});

describe("sessionsMeanIsWeak — amber tint on a weak mean", () => {
  test("null mean is never weak (no data ≠ weak)", () => {
    expect(sessionsMeanIsWeak(EMPTY_SESSIONS)).toBe(false);
  });
  test("below 3.0 is weak; at/above is not", () => {
    expect(sessionsMeanIsWeak(activitySessions({ activeCount: 0, completeCount: 1, fitnesses: [2.5] }))).toBe(true);
    expect(sessionsMeanIsWeak(activitySessions({ activeCount: 0, completeCount: 1, fitnesses: [3] }))).toBe(false);
  });
});

describe("rollupSessions — activity → lesson → unit", () => {
  test("empty roll-up is the empty signal", () => {
    const r = rollupSessions([]);
    expect(r).toEqual(EMPTY_SESSIONS);
  });

  test("counts SUM across children", () => {
    const r = rollupSessions([
      activitySessions({ activeCount: 2, completeCount: 1, fitnesses: [4] }),
      activitySessions({ activeCount: 0, completeCount: 3, fitnesses: [3, 5] }),
    ]);
    expect(r.activeCount).toBe(2);
    expect(r.completeCount).toBe(4);
    expect(totalSessions(r)).toBe(6);
  });

  test("mean is n-WEIGHTED, not a mean-of-means", () => {
    // Child A: one session at 5. Child B: three sessions averaging 3.
    // Naive mean-of-means = (5+3)/2 = 4. n-weighted = (5*1 + 3*3)/4 = 3.5.
    const a = activitySessions({ activeCount: 0, completeCount: 1, fitnesses: [5] });
    const b = activitySessions({ activeCount: 0, completeCount: 3, fitnesses: [3, 3, 3] });
    const r = rollupSessions([a, b]);
    expect(r.fitnessN).toBe(4);
    expect(r.meanFitness).toBeCloseTo(3.5);
  });

  test("children without judged data don't drag the mean or n", () => {
    const judged = activitySessions({ activeCount: 0, completeCount: 2, fitnesses: [4, 4] });
    const unjudged = activitySessions({ activeCount: 5, completeCount: 0, fitnesses: [] });
    const r = rollupSessions([judged, unjudged]);
    expect(r.meanFitness).toBeCloseTo(4);
    expect(r.fitnessN).toBe(2);
    expect(r.activeCount).toBe(5); // counts still sum
  });

  test("raw fitnesses CONCATENATE (honest distribution, not averaged)", () => {
    const r = rollupSessions([
      activitySessions({ activeCount: 0, completeCount: 2, fitnesses: [2, 4] }),
      activitySessions({ activeCount: 0, completeCount: 1, fitnesses: [5] }),
    ]);
    expect(r.fitnesses.slice().sort()).toEqual([2, 4, 5]);
  });

  test("simMean is n-weighted by REAL fitnessN so it lines up with the real band", () => {
    // A: real n=1, sim said 5. B: real n=3, sim said 3. Weighted sim = (5*1+3*3)/4 = 3.5.
    const a = activitySessions({ activeCount: 0, completeCount: 1, fitnesses: [4], simMean: 5 });
    const b = activitySessions({ activeCount: 0, completeCount: 3, fitnesses: [3, 3, 3], simMean: 3 });
    const r = rollupSessions([a, b]);
    expect(r.simMean).toBeCloseTo(3.5);
  });

  test("simSessionCount SUMS and is NOT gated on real sessions (shows pre-assignment)", () => {
    // A rehearsed activity with sims but ZERO real sessions still contributes its
    // sim count — the readiness gate is a preflight signal, so it must count
    // before anything ships. simMean stays null (needs a real band to align to).
    const rehearsedOnly = activitySessions({
      activeCount: 0,
      completeCount: 0,
      fitnesses: [],
      simMean: 4.1,
      simSessionCount: 2,
    });
    const assigned = activitySessions({
      activeCount: 0,
      completeCount: 1,
      fitnesses: [4],
      simMean: 3.9,
      simSessionCount: 2,
    });
    const r = rollupSessions([rehearsedOnly, assigned]);
    expect(r.simSessionCount).toBe(4);
  });

  test("nested roll-up (activities → lesson → unit) matches a flat roll-up", () => {
    const acts: SessionsSignal[] = [
      activitySessions({ activeCount: 1, completeCount: 1, fitnesses: [4] }),
      activitySessions({ activeCount: 0, completeCount: 2, fitnesses: [2, 3] }),
      activitySessions({ activeCount: 2, completeCount: 0, fitnesses: [] }),
    ];
    const lessonA = rollupSessions([acts[0], acts[1]]);
    const lessonB = rollupSessions([acts[2]]);
    const unit = rollupSessions([lessonA, lessonB]);
    const flat = rollupSessions(acts);
    expect(unit.activeCount).toBe(flat.activeCount);
    expect(unit.completeCount).toBe(flat.completeCount);
    expect(unit.fitnessN).toBe(flat.fitnessN);
    expect(unit.meanFitness).toBeCloseTo(flat.meanFitness as number);
    expect(unit.fitnesses.slice().sort()).toEqual(flat.fitnesses.slice().sort());
  });
});
