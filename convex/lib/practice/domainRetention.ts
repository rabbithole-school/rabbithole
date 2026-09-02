/**
 * DOMAIN RETENTION SUMMARY — the one per-domain freshness/inactivity aggregate
 * behind Tier 1 (matrix cell hover) and Tier 2 (the scholar × domain detail
 * panel) of the Math Skills matrix (review/math-skills-matrix-visual-language.html
 * §9–10.2, Signal #2 — "fluent-and-fresh vs fluent-and-decaying"). Founder
 * ruling: freshness never touches the cell itself (number/colour/Δ) — it is a
 * drill-in fact, not a scan fact, so it lives here, one tier down.
 *
 * A domain's GREEN skills (fluent/overlearned — the same `proficiencyFromReps`
 * family the matrix's own level/Δ already treat as "mastered", never a second
 * vocabulary) can be quietly decaying without the number changing: a green
 * "4.2" reads identically whether every skill behind it was drilled yesterday
 * or three months ago. This aggregate is that one honest question —
 * `dueCount` of `greenCount` skills are due for a tune-up, plus the single
 * most-overdue skill's honest recency — reused UNCHANGED by both
 * `crossDomainMasteryForScholars` (the all-domains matrix's per-domain cells,
 * Tier 1) and `masteryForScholars` (the single-domain drill panel, Tier 2), so
 * there is exactly one retention vocabulary rather than two derivations that
 * could drift apart.
 *
 * Pure over structural inputs (no Convex `Doc`), so it unit-tests standalone —
 * `convex/cohortPractice.ts` owns the one ctx loader that feeds it.
 */

import { isDue, retention as retentionRatio, proficiencyFromReps, type SkillState } from "./scheduler";

/** One mastery row's retention-relevant fields — a structural subset of
 *  `practiceMastery`, not the `Doc` itself, so this stays pure. */
export type DomainRetentionInput = {
  repetition: number;
  halfLifeDays: number;
  // The spaced-repetition CLOCK (isDue/retention math only — see scheduler.ts).
  lastPracticedAt?: number;
  // The HONEST "did the scholar actually drill this" clock — display-only,
  // deliberately unset by placement/reprobe/seed rows. Never substituted with
  // `lastPracticedAt` for the "last drilled" text (schema.ts's own rule).
  lastAttemptAt?: number;
};

export type DomainRetentionSummary = {
  /** Green (fluent/overlearned) skills in this domain currently due for a
   *  tune-up — never rendered on the cell itself (§9/§10.2). */
  dueCount: number;
  /** Total green skills classified for this domain — the denominator "N of
   *  M" reads against. Zero means the domain has nothing to be fresh or stale
   *  about yet (a calm, not an alarming, state). */
  greenCount: number;
  /** The single most-overdue green skill (lowest retention ratio), for the
   *  terse "last drilled ~N days ago" clause. Undefined when `dueCount` is 0.
   *  `lastAttemptAt` is `null` when every rep behind this skill was inferred
   *  (placement/reprobe) and the scholar never actually attempted it — the
   *  honest "not yet drilled" case (schema.ts's `lastAttemptAt` comment; the
   *  spec's Signal #3), never backfilled from `lastPracticedAt`. */
  mostOverdue?: { lastAttemptAt: number | null; halfLifeDays: number };
};

const EMPTY_SUMMARY: DomainRetentionSummary = { dueCount: 0, greenCount: 0 };

/**
 * Summarize one domain's green-skill retention from its mastery rows. Rows
 * for skills below "fluent" (not_started/practicing) are counted toward
 * neither `greenCount` nor `dueCount` — a still-practicing skill isn't yet a
 * "green number that might be decaying", it's the ordinary practicing state
 * the cell/panel already render.
 */
export function summarizeDomainRetention(
  rows: readonly DomainRetentionInput[],
  now: number,
): DomainRetentionSummary {
  let dueCount = 0;
  let greenCount = 0;
  let mostOverdueRatio = Infinity;
  let mostOverdue: DomainRetentionSummary["mostOverdue"];

  for (const row of rows) {
    const proficiency = proficiencyFromReps(row.repetition);
    if (proficiency !== "fluent" && proficiency !== "overlearned") continue;
    greenCount += 1;

    const state: SkillState = {
      repetition: row.repetition,
      halfLifeDays: row.halfLifeDays,
      lastPracticedAt: row.lastPracticedAt,
    };
    if (!isDue(state, now)) continue;
    dueCount += 1;

    const ratio = retentionRatio(state, now);
    if (ratio < mostOverdueRatio) {
      mostOverdueRatio = ratio;
      mostOverdue = {
        lastAttemptAt: row.lastAttemptAt ?? null,
        halfLifeDays: row.halfLifeDays,
      };
    }
  }

  if (greenCount === 0) return EMPTY_SUMMARY;
  return { dueCount, greenCount, mostOverdue };
}
