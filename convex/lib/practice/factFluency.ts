/**
 * FACT FLUENCY — the pure logic behind the per-fact automaticity substrate
 * (the FastMath analog). Kept import-light and free of any Convex `ctx` so it
 * is unit-testable in isolation; the ONE stateful caller
 * (`recordAttemptCore` in convex/practiceSkills.ts) does the `ctx.db`
 * read/write and delegates every decision here.
 *
 * See `shared/factKey.ts` for the canonical fact identity, and the
 * `factFluency` table in `convex/schema.ts` for the row shape these helpers
 * produce and read.
 *
 * DOCTRINE (load-bearing): every verdict here is SELF-RELATIVE — "fast for THIS
 * scholar", derived from their own latency baseline — never a cross-scholar
 * norm and never an absolute clock. Nothing here is ever shown to a scholar as
 * a number; it only refines the green/automaticity claim and selects sprint
 * facts.
 */

import {
  type FactKey,
  factKeyOp,
} from "../../../shared/factKey";
import { type AutomaticityState } from "../../../shared/masteryLexicon";
import { nextLatencyStats } from "./latencyStats";
import { LATENCY_FLUENT_TOLERANCE } from "./scheduler";

/** How many correct latency samples a fact needs before its median earns a
 *  SPEED verdict. Below this we know it's being answered correctly but can't yet
 *  say whether retrieval is fast — so the ladder caps at "practicing". */
export const FACT_MIN_LATENCY_SAMPLES = 3;

// Accuracy gates on the fact's lifetime correct rate. Deliberately forgiving at
// the bottom (one stray slip shouldn't erase "practicing") and strict at the
// top (an "automatic" claim has to be nearly perfect).
const FACT_RELIABLE_ACCURACY = 0.67;
const FACT_FLUENT_ACCURACY = 0.8;
const FACT_AUTOMATIC_ACCURACY = 0.9;

/**
 * The per-fact automaticity ladder. Ordered weakest → strongest; the teacher
 * heatmap paints each rung from the canonical mastery palette + a colour-blind
 * knockout mark, and the sprint selector pulls its drill facts from the weak end
 * (effortful/practicing).
 *
 *   • "unseen"     — never attempted.
 *   • "effortful"  — attempted but not yet reliably correct (the scholar is
 *                    still computing it, and sometimes missing).
 *   • "practicing" — reliably correct, but not (yet) demonstrably fast — either
 *                    too few timed samples or a median slower than the fluent
 *                    latency band. Access is fine; automaticity is not claimed.
 *   • "fluent"     — reliably correct AND fast-for-this-scholar.
 *   • "automatic"  — near-perfect AND instant (median at/under their baseline).
 *
 * The state UNION + its teacher-facing words live in `shared/masteryLexicon.ts`
 * (`AutomaticityState` / `automaticityLabel`) so the classifier, the web
 * heatmap, and any future surface stay compiler-coupled to one vocabulary.
 * `FactFluencyState` is kept as the historical name at this grain.
 */
export type FactFluencyState = AutomaticityState;

/** The subset of a `factFluency` row the classifier reads. */
export type FactFluencyStats = {
  seenCount: number;
  correctCount: number;
  latencySamplesMs?: number[];
  latencyMedianMs?: number;
};

export type FactSpeedRead = {
  baselineMs: number;
  medianMs: number;
};

/** Whether this fact has enough timed evidence to compare its median with the
 * scholar's baseline. A known scholar baseline alone is not fact-level speed
 * evidence. */
export function factSpeedRead(
  stats: FactFluencyStats | null | undefined,
  baseline: number | undefined,
): FactSpeedRead | null {
  if (
    baseline === undefined ||
    stats?.latencyMedianMs === undefined ||
    (stats.latencySamplesMs?.length ?? 0) < FACT_MIN_LATENCY_SAMPLES
  ) {
    return null;
  }
  return { baselineMs: baseline, medianMs: stats.latencyMedianMs };
}

/**
 * Classify a fact's automaticity from its tallies + latency, relative to the
 * scholar's own baseline (median of their per-skill latency medians, from
 * `scholarLatencyBaseline`). `baseline === undefined` (a scholar we don't yet
 * have a speed read on) caps the verdict at "practicing" — we never claim
 * "fast" before we know their normal speed (doctrine §5).
 */
export function classifyFactState(
  stats: FactFluencyStats | null | undefined,
  baseline: number | undefined,
): FactFluencyState {
  if (!stats || stats.seenCount <= 0) return "unseen";
  const accuracy = stats.correctCount / stats.seenCount;
  if (accuracy < FACT_RELIABLE_ACCURACY) return "effortful";

  const speedRead = factSpeedRead(stats, baseline);
  if (!speedRead) return "practicing";
  const { baselineMs, medianMs } = speedRead;
  const fast = medianMs <= baselineMs * LATENCY_FLUENT_TOLERANCE;
  if (!fast) return "practicing";
  if (accuracy >= FACT_AUTOMATIC_ACCURACY && medianMs <= baselineMs) return "automatic";
  if (accuracy >= FACT_FLUENT_ACCURACY) return "fluent";
  return "practicing";
}

/** The cumulative field bag written to a `factFluency` row for one attempt —
 *  the shape produced by `nextFactFluencyFields`, consumed by both the insert
 *  and the patch in `recordAttemptCore`. */
export type FactFluencyFields = {
  skillKey: string;
  domain: string;
  seenCount: number;
  correctCount: number;
  latencySamplesMs?: number[];
  latencyMedianMs?: number;
  lastSeenAt: number;
  lastCorrectAt?: number;
};

/** An existing `factFluency` row's mutable counters, as read before an update. */
export type FactFluencyExisting = {
  seenCount: number;
  correctCount: number;
  latencySamplesMs?: number[];
  lastCorrectAt?: number;
};

/**
 * Fold one attempt into a fact's cumulative row fields — pure, so the write path
 * only does the index read + patch/insert. Latency (correct-only) advances the
 * ring buffer exactly like mastery's; a miss leaves the buffer/`lastCorrectAt`
 * untouched.
 */
export function nextFactFluencyFields(
  existing: FactFluencyExisting | null | undefined,
  attempt: {
    factKey: FactKey;
    skillKey: string;
    domain: string;
    correct: boolean;
    latencyMs: number | undefined;
    now: number;
  },
): FactFluencyFields | null {
  if (factKeyOp(attempt.factKey) === null) return null;
  const latencyUpdate =
    attempt.correct && attempt.latencyMs !== undefined
      ? nextLatencyStats(existing?.latencySamplesMs, attempt.latencyMs)
      : undefined;
  return {
    skillKey: attempt.skillKey,
    domain: attempt.domain,
    seenCount: (existing?.seenCount ?? 0) + 1,
    correctCount: (existing?.correctCount ?? 0) + (attempt.correct ? 1 : 0),
    ...(latencyUpdate
      ? {
          latencySamplesMs: latencyUpdate.latencySamplesMs,
          latencyMedianMs: latencyUpdate.latencyMedianMs,
        }
      : {}),
    lastSeenAt: attempt.now,
    ...(attempt.correct ? { lastCorrectAt: attempt.now } : {}),
  };
}
