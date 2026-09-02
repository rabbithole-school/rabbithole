/**
 * Tune-up sampler (raise-the-ceiling / parity plan §4B, "B").
 *
 * The tune-up is an offer-based, untimed, UNSCORED mixed-topic retention check.
 * Its whole job is to re-expose fluent skills the scholar hasn't touched in a
 * while — weighting INFERRED credit (placement / acceleration valve / re-probe,
 * i.e. any `source` outside `DEMONSTRATED_SOURCES`) that was trusted upward but
 * never independently demonstrated. A miss just lapses the half-life and the
 * skill resurfaces as an ordinary due review — that IS the follow-up; nothing
 * else is built here.
 *
 * PURE (no Convex imports — mirrors scheduler.ts / implicitCredit.ts): the
 * eligibility predicate + the deterministic top-N sampler, so the trigger logic
 * is unit-testable without a deployment. The serving/grading path is the
 * EXISTING `practiceSession` / `submitAnswer` — this file never touches it.
 */

import { FLUENT_REPS, isDemonstratedSource } from "./scheduler";

/** Minimum eligible-skill pool before a tune-up is even offered. */
export const TUNEUP_MIN_POOL = 6;
/** Don't re-offer a tune-up within this many days of the last one STARTED. */
export const TUNEUP_INTERVAL_DAYS = 7;
/** A skill practiced (or implicitly refreshed) within this many days is "fresh" — skip it. */
export const TUNEUP_RECENT_DAYS = 2;
/** How many skills a single tune-up serves. */
export const TUNEUP_SIZE = 6;
/** Inferred credit (never demonstrated) is sampled at this multiple of its age. */
export const TUNEUP_INFERRED_WEIGHT = 2;

const DAY = 86_400_000;

/** The mastery-row fields the sampler reads (a structural subset of `practiceMastery`). */
export type TuneupCandidate = {
  skillKey: string;
  repetition: number;
  source: string;
  lastPracticedAt?: number;
  lastImplicitAt?: number;
};

/**
 * Eligible for a tune-up = demonstrated fluent (`repetition ≥ FLUENT_REPS`),
 * with a real `lastPracticedAt` that is NOT recent (older than
 * `TUNEUP_RECENT_DAYS`), and NOT recently refreshed implicitly (FIRe §4A —
 * `lastImplicitAt` absent or older than `TUNEUP_RECENT_DAYS`). A fresh skill
 * needs no audit; a just-refreshed one would double-count.
 */
export function eligibleForTuneup(c: TuneupCandidate, now: number): boolean {
  if (c.repetition < FLUENT_REPS) return false;
  if (c.lastPracticedAt === undefined) return false;
  const recentMs = TUNEUP_RECENT_DAYS * DAY;
  if (now - c.lastPracticedAt < recentMs) return false;
  if (c.lastImplicitAt !== undefined && now - c.lastImplicitAt < recentMs) return false;
  return true;
}

/**
 * A candidate's sampling score: days since last practice, doubled for inferred
 * credit (`source ∉ DEMONSTRATED_SOURCES` — placement / accelerated / reprobe),
 * so undemonstrated skills float to the top of the audit at equal age.
 */
export function tuneupScore(c: TuneupCandidate, now: number): number {
  const days = (now - (c.lastPracticedAt ?? now)) / DAY;
  const weight = isDemonstratedSource(c.source) ? 1 : TUNEUP_INFERRED_WEIGHT;
  return days * weight;
}

/**
 * The eligible skills, highest-score first, capped at `size`. Ties break by
 * `skillKey` ascending so the pick is fully deterministic (same inputs → same
 * sample), which keeps the offer stable across re-renders and testable.
 */
export function pickTuneupSample(
  candidates: TuneupCandidate[],
  now: number,
  size: number = TUNEUP_SIZE,
): string[] {
  return candidates
    .filter((c) => eligibleForTuneup(c, now))
    .map((c) => ({ skillKey: c.skillKey, score: tuneupScore(c, now) }))
    .sort((a, b) => (b.score !== a.score ? b.score - a.score : a.skillKey < b.skillKey ? -1 : 1))
    .slice(0, size)
    .map((s) => s.skillKey);
}

/** How many eligible skills exist — the pool the `TUNEUP_MIN_POOL` gate checks. */
export function countEligibleForTuneup(candidates: TuneupCandidate[], now: number): number {
  return candidates.reduce((n, c) => n + (eligibleForTuneup(c, now) ? 1 : 0), 0);
}
