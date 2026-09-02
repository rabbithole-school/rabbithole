// Signal 2 · Sessions — the field record (violet). See PR #1072 §6/§7/§8.
//
// A scholar's runthrough of an assigned activity IS a "session" (the `sessions`
// domain object). The field record is therefore literally a COUNT of real
// sessions — never a synthetic "Proven" tier — decomposed by state:
//
//   active   = real (non-test-drive, assigned) sessions still in flight
//   complete = real sessions the scholar finished (activityCompletedAt set)
//   mean     = mean judged fitness over `groundedSessionVerdicts.fitness`
//
// This module is PURE (no ctx, no Convex) so the roll-up rule is unit-tested
// and importable client-side. `convex/activitySessions.ts` assembles the raw
// per-activity numbers from real data and rolls them up with `rollupSessions`.

export interface SessionsSignal {
  /** Real sessions in flight (no completion yet). */
  activeCount: number;
  /** Real sessions the scholar has finished. */
  completeCount: number;
  /**
   * Mean judged fitness (1–5) over the sessions that carry a verdict, or null
   * when nothing has been judged yet — we never fake a score from zero data.
   */
  meanFitness: number | null;
  /** How many judged verdicts back `meanFitness` (the n / confidence, and the
   *  weight used when rolling means up the tree). */
  fitnessN: number;
  /** The raw judged real scores (1–5) — one violet dot each in the sim-vs-real
   *  distribution. Concatenated (not averaged) on roll-up so the viz stays honest. */
  fitnesses: number[];
  /** What the SIMS predicted for this node (best rehearsal fitness), for the
   *  calibration overlay (the dashed amber "sim said" line). Null if never
   *  rehearsed. n-weighted (by real `fitnessN`) on roll-up so it's directly
   *  comparable to the real mean band. */
  simMean: number | null;
  /** How many scholar-bot rehearsal sessions backed `simMean` — the sim-side
   *  volume that pairs with it (the rehearsal step reads "N simulated sessions ·
   *  predicted mean X.X", mirroring the real "N sessions · mean X.X"). Sourced
   *  from the best variant's `aggregateScores.n`; SUMS on roll-up, and unlike
   *  `simMean` is NOT gated on real sessions, so the count shows pre-assignment. */
  simSessionCount: number;
}

export const EMPTY_SESSIONS: SessionsSignal = {
  activeCount: 0,
  completeCount: 0,
  meanFitness: null,
  fitnessN: 0,
  fitnesses: [],
  simMean: null,
  simSessionCount: 0,
};

/** A weak mean tints the Sessions readout amber (PR #1072 §7). Coarse on
 *  purpose; tune alongside REHEARSE_PASS_FITNESS. Only meaningful with data. */
export const SESSIONS_WEAK_MEAN = 3.0;

export function sessionsMeanIsWeak(s: SessionsSignal): boolean {
  return s.meanFitness !== null && s.meanFitness < SESSIONS_WEAK_MEAN;
}

/** Total real sessions (active + complete) — the headline count. */
export function totalSessions(s: SessionsSignal): number {
  return s.activeCount + s.completeCount;
}

/** Build one activity's signal from its raw real-session numbers. `fitnesses`
 *  is the list of judged fitness scores (1–5) for the activity's real sessions;
 *  `simMean` is what the sims predicted (best rehearsal fitness), for the
 *  calibration overlay. */
export function activitySessions(input: {
  activeCount: number;
  completeCount: number;
  fitnesses: number[];
  simMean?: number | null;
  simSessionCount?: number;
}): SessionsSignal {
  const fitnessN = input.fitnesses.length;
  const meanFitness =
    fitnessN > 0 ? input.fitnesses.reduce((a, b) => a + b, 0) / fitnessN : null;
  return {
    activeCount: input.activeCount,
    completeCount: input.completeCount,
    meanFitness,
    fitnessN,
    fitnesses: input.fitnesses,
    simMean: input.simMean ?? null,
    simSessionCount: input.simSessionCount ?? 0,
  };
}

/**
 * Roll several children up the tree (activity → lesson → unit). Counts SUM;
 * the mean is n-WEIGHTED across the children that have a mean, so a parent's
 * mean can't be gamed by one activity with a single lucky session (PR #1072 §7).
 * Raw `fitnesses` concatenate (honest distribution); `simMean` is n-weighted by
 * real `fitnessN` so the calibration overlay lines up with the real mean band.
 */
export function rollupSessions(children: SessionsSignal[]): SessionsSignal {
  let activeCount = 0;
  let completeCount = 0;
  let fitnessN = 0;
  let weightedSum = 0;
  let simWeightedSum = 0;
  let simWeight = 0;
  let simSessionCount = 0;
  const fitnesses: number[] = [];
  for (const c of children) {
    activeCount += c.activeCount;
    completeCount += c.completeCount;
    simSessionCount += c.simSessionCount;
    for (const f of c.fitnesses) fitnesses.push(f);
    if (c.meanFitness !== null && c.fitnessN > 0) {
      weightedSum += c.meanFitness * c.fitnessN;
      fitnessN += c.fitnessN;
      if (c.simMean !== null) {
        simWeightedSum += c.simMean * c.fitnessN;
        simWeight += c.fitnessN;
      }
    }
  }
  return {
    activeCount,
    completeCount,
    meanFitness: fitnessN > 0 ? weightedSum / fitnessN : null,
    fitnessN,
    fitnesses,
    simMean: simWeight > 0 ? simWeightedSum / simWeight : null,
    simSessionCount,
  };
}
