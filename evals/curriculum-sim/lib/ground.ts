/**
 * Phase 4 — ground the simulation in reality. The whole loop rests on a bet:
 * that the Scholar Simulator's transcripts (and the judge's scores on them)
 * track what REAL kids experience. This module checks that bet.
 *
 * It judges REAL prod transcripts with the SAME curriculum judge, aggregates
 * them, and calibrates against the simulated baseline. If the simulator runs far
 * more optimistic (or pessimistic) than reality, the sim scores aren't a
 * trustworthy basis for promoting an activity edit — the loop should defer to a
 * human until the gap closes. calibrate() is pure → tested.
 */
import type { Aggregate } from "./score";
import { FITNESS_DIMS, PROTECTED_DIMS } from "./score";
import type { ScholarProfile, SessionResult, SimTurn } from "./types";

const ALL_NUMERIC = [...FITNESS_DIMS, ...PROTECTED_DIMS] as const;
type NumericDim = (typeof ALL_NUMERIC)[number];

/** Map a real transcript (user/assistant turns) into the harness's session shape. */
export function realTranscriptToSession(args: {
  scholarName: string | null;
  readingLevel: string | null;
  turns: { role: "user" | "assistant"; content: string }[];
}): SessionResult {
  const profile: ScholarProfile = {
    name: args.scholarName ?? "(real scholar)",
    readingLevel: args.readingLevel ?? "(unset)",
    dossier: "(real prod scholar — dossier not fetched)",
    traits: [],
  };
  const turns: SimTurn[] = args.turns.map((t) => ({
    role: t.role === "assistant" ? "tutor" : "scholar",
    content: t.content,
  }));
  // Real transcripts have no goal/stuck sentinel; we don't infer one.
  return { profile, turns, stopReason: "maxTurns" };
}

export interface Calibration {
  perDim: Record<NumericDim, { sim: number; real: number; delta: number }>;
  /** sim.fitness − real.fitness. Positive = simulator is OPTIMISTIC vs reality. */
  fitnessDelta: number;
  threshold: number;
  /** Is the sim close enough to reality to trust its scores for promotion? */
  trustworthy: boolean;
  note: string;
  /**
   * sim.goalAttainment − real.goalAttainment. Positive = the sim kid reaches
   * (or declares) understanding real kids on this activity don't — the
   * `[[DONE]]` sentinel firing too easily. Broken out from `fitnessDelta`
   * because a rosy overall fit can hide a specifically hot goalAttainment.
   */
  goalAttainmentDelta: number;
  /** Max goalAttainment gap tolerated before flagging the sim as over-optimistic. */
  goalAttainmentThreshold: number;
  /** True when the sim OVER-scores goalAttainment vs real beyond the threshold. */
  goalAttainmentOptimistic: boolean;
  /** Specific hygiene note when goalAttainment runs hot (null otherwise). */
  goalAttainmentNote: string | null;
}

/**
 * Compare simulated aggregate vs aggregate over real transcripts. `threshold`
 * is the max |fitness gap| we'll tolerate before flagging the sim as an
 * untrustworthy proxy. `goalAttainmentThreshold` is the separate max the
 * goalAttainment dim may run OPTIMISTIC (sim − real) before we flag a
 * grounding-hygiene problem — a too-eager `[[DONE]]`.
 */
export function calibrate(
  sim: Aggregate,
  real: Aggregate,
  threshold = 0.75,
  goalAttainmentThreshold = threshold,
): Calibration {
  const perDim = {} as Calibration["perDim"];
  for (const d of ALL_NUMERIC) {
    perDim[d] = { sim: sim.dims[d], real: real.dims[d], delta: sim.dims[d] - real.dims[d] };
  }
  const fitnessDelta = sim.fitness - real.fitness;
  const trustworthy = Math.abs(fitnessDelta) <= threshold;
  const dir = fitnessDelta > 0 ? "optimistic" : "pessimistic";
  const note = trustworthy
    ? `Simulator within ${threshold} of reality (Δfitness ${fitnessDelta.toFixed(2)}) — sim scores usable as a directional proxy.`
    : `Simulator runs ${dir} by ${Math.abs(fitnessDelta).toFixed(2)} (> ${threshold}) — DO NOT promote off sim scores alone; validate with a human or more real data.`;

  // Grounding hygiene on goalAttainment specifically — only the OPTIMISTIC
  // direction (sim "gets it" faster than real kids) traces to a `[[DONE]]`
  // sentinel firing before genuine, own-words understanding.
  const goalAttainmentDelta = perDim.goalAttainment.delta;
  const goalAttainmentOptimistic = goalAttainmentDelta > goalAttainmentThreshold;
  const goalAttainmentNote = goalAttainmentOptimistic
    ? `goalAttainment runs optimistic by Δ${goalAttainmentDelta.toFixed(2)} vs real (> ${goalAttainmentThreshold}) — the sim kid declares understanding it can't demonstrate; tighten [[DONE]] so it only fires after the kid explains the goal in its own words.`
    : null;

  return {
    perDim,
    fitnessDelta,
    threshold,
    trustworthy,
    note,
    goalAttainmentDelta,
    goalAttainmentThreshold,
    goalAttainmentOptimistic,
    goalAttainmentNote,
  };
}
