import { describe, it, expect } from "vitest";

import {
  CONSECUTIVE_FAILURES_TO_SHOW,
  INITIAL_OFFLINE_STATE,
  MIN_OFFLINE_MS,
  decideOffline,
  reduceProbe,
  type ProbeResult,
} from "../offlineDecision";

// Base timestamp; individual probes offset from it. MIN_OFFLINE_MS is 12000
// and CONSECUTIVE_FAILURES_TO_SHOW is 3 at time of writing — the tests assert
// against the exported constants so they track any future tuning.
const T0 = 1_000_000;

/** A run of `n` failures spaced `stepMs` apart starting at `startAt`. */
function failures(n: number, stepMs: number, startAt = T0): ProbeResult[] {
  return Array.from({ length: n }, (_, i) => ({
    ok: false,
    at: startAt + i * stepMs,
  }));
}

describe("offlineDecision.reduceProbe", () => {
  it("does not show after a single failure", () => {
    expect(decideOffline([{ ok: false, at: T0 }])).toBe(false);
  });

  it("does not show when the failure streak is long enough in COUNT but too SOON", () => {
    // CONSECUTIVE_FAILURES_TO_SHOW failures, but all within a 1s window (< MIN_OFFLINE_MS).
    const history = failures(CONSECUTIVE_FAILURES_TO_SHOW, 100);
    const elapsed = history[history.length - 1].at - history[0].at;
    expect(elapsed).toBeLessThan(MIN_OFFLINE_MS); // guard: this scenario is "too soon"
    expect(decideOffline(history)).toBe(false);
  });

  it("does not show when enough TIME has passed but too FEW failures", () => {
    // Two failures spanning well over MIN_OFFLINE_MS, but below the count threshold.
    const history: ProbeResult[] = [
      { ok: false, at: T0 },
      { ok: false, at: T0 + MIN_OFFLINE_MS + 5000 },
    ];
    expect(history.length).toBeLessThan(CONSECUTIVE_FAILURES_TO_SHOW); // guard
    expect(decideOffline(history)).toBe(false);
  });

  it("shows once BOTH the count and the elapsed-time thresholds are met", () => {
    // Spread the required failures across a span >= MIN_OFFLINE_MS.
    const step = Math.ceil(MIN_OFFLINE_MS / (CONSECUTIVE_FAILURES_TO_SHOW - 1)) + 1;
    const history = failures(CONSECUTIVE_FAILURES_TO_SHOW, step);
    const elapsed = history[history.length - 1].at - history[0].at;
    expect(elapsed).toBeGreaterThanOrEqual(MIN_OFFLINE_MS); // guard
    expect(decideOffline(history)).toBe(true);
  });

  it("dismisses immediately on the first success after being offline", () => {
    const step = Math.ceil(MIN_OFFLINE_MS / (CONSECUTIVE_FAILURES_TO_SHOW - 1)) + 1;
    let state = INITIAL_OFFLINE_STATE;
    for (const probe of failures(CONSECUTIVE_FAILURES_TO_SHOW, step)) {
      state = reduceProbe(state, probe);
    }
    expect(state.isOffline).toBe(true);

    const afterSuccess = reduceProbe(state, {
      ok: true,
      at: T0 + 100_000,
    });
    expect(afterSuccess.isOffline).toBe(false);
    expect(afterSuccess).toEqual(INITIAL_OFFLINE_STATE);
  });

  it("resets the streak after a success, so the clock/count start over", () => {
    let state = INITIAL_OFFLINE_STATE;
    // Two failures, then a success — streak resets.
    state = reduceProbe(state, { ok: false, at: T0 });
    state = reduceProbe(state, { ok: false, at: T0 + 6000 });
    state = reduceProbe(state, { ok: true, at: T0 + 7000 });
    expect(state).toEqual(INITIAL_OFFLINE_STATE);

    // A single failure well after the original streak must NOT immediately show:
    // the elapsed clock restarts from this new failure.
    state = reduceProbe(state, { ok: false, at: T0 + 100_000 });
    expect(state.consecutiveFailures).toBe(1);
    expect(state.streakStartedAt).toBe(T0 + 100_000);
    expect(state.isOffline).toBe(false);
  });

  it("stays shown across further failures until a success arrives (latches)", () => {
    const step = Math.ceil(MIN_OFFLINE_MS / (CONSECUTIVE_FAILURES_TO_SHOW - 1)) + 1;
    let state = INITIAL_OFFLINE_STATE;
    for (const probe of failures(CONSECUTIVE_FAILURES_TO_SHOW, step)) {
      state = reduceProbe(state, probe);
    }
    expect(state.isOffline).toBe(true);

    // More failures keep it shown.
    state = reduceProbe(state, { ok: false, at: T0 + 500_000 });
    expect(state.isOffline).toBe(true);
    expect(state.consecutiveFailures).toBe(CONSECUTIVE_FAILURES_TO_SHOW + 1);
  });
});
