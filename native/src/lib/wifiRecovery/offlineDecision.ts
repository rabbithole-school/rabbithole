// Pure offline-decision logic — NO React or React-Native imports, so it unit
// tests as a plain function. Given a stream of connectivity probe results (each
// an { ok, at } pair), it decides whether the recovery overlay should be shown.
//
// The two rules that keep the overlay from flickering on a brief network blip:
//   1. Show only after CONSECUTIVE_FAILURES_TO_SHOW failed probes in a row.
//   2. AND only once MIN_OFFLINE_MS has elapsed since the first failure of the
//      current streak — a slow, deliberate confirmation that we're really out.
// A single successful probe dismisses immediately and resets the streak.

/** Consecutive failed probes required before the overlay may appear. */
export const CONSECUTIVE_FAILURES_TO_SHOW = 3;

/** Minimum elapsed time since the streak's first failure before showing (ms). */
export const MIN_OFFLINE_MS = 12000;

/** A single connectivity probe outcome. `at` is a Date.now()-style timestamp. */
export type ProbeResult = { ok: boolean; at: number };

/** Folded state of the decision machine. */
export type OfflineState = {
  /** Whether the recovery overlay should currently be shown. */
  isOffline: boolean;
  /** How many probes have failed in a row (0 once any probe succeeds). */
  consecutiveFailures: number;
  /** Timestamp of the first failure in the current streak, or null if none. */
  streakStartedAt: number | null;
};

export const INITIAL_OFFLINE_STATE: OfflineState = {
  isOffline: false,
  consecutiveFailures: 0,
  streakStartedAt: null,
};

/**
 * Fold one probe result into the decision state. Pure: same inputs → same
 * output, no side effects. A success resets everything (and dismisses); a
 * failure extends the streak and latches `isOffline` on once both thresholds
 * are met.
 */
export function reduceProbe(
  state: OfflineState,
  probe: ProbeResult,
): OfflineState {
  if (probe.ok) {
    // Back online: dismiss immediately and reset the streak.
    return INITIAL_OFFLINE_STATE;
  }

  const streakStartedAt = state.streakStartedAt ?? probe.at;
  const consecutiveFailures = state.consecutiveFailures + 1;
  const elapsed = probe.at - streakStartedAt;
  const thresholdsMet =
    consecutiveFailures >= CONSECUTIVE_FAILURES_TO_SHOW &&
    elapsed >= MIN_OFFLINE_MS;

  return {
    // Latch on: once shown, stay shown until a probe succeeds. (Within a failing
    // streak both counters only grow, so this equals a direct recompute — the
    // OR just makes the "stays shown" intent explicit.)
    isOffline: state.isOffline || thresholdsMet,
    consecutiveFailures,
    streakStartedAt,
  };
}

/**
 * Convenience for tests / one-shot evaluation: fold a whole history of probes
 * from the initial state and report the final decision.
 */
export function decideOffline(history: ProbeResult[]): boolean {
  return history.reduce(reduceProbe, INITIAL_OFFLINE_STATE).isOffline;
}
