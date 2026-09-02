/**
 * DOMAIN RETENTION COPY — the one sentence-vocabulary Tier 1 (matrix cell
 * hover) and Tier 2 (the scholar × domain detail panel) both read from, so a
 * teacher never sees two different phrasings for the same
 * `DomainRetentionSummary` (review/math-skills-matrix-visual-language.html
 * §9–10.2). Pure string formatting only — no React, no Convex — so it unit-
 * tests standalone and is shared by `MathSkillsMasteryView`'s cell tooltip and
 * `DomainRetentionStrip`.
 *
 * The founder ruling stays enforced by omission: nothing here ever renders on
 * a matrix cell. Every export below only ever backs `title`/`aria-label`
 * strings or the Tier 2 strip's sentence.
 */

import type { DomainRetentionSummary } from "@/convex/lib/practice/domainRetention";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The honest "last drilled" clause. `lastAttemptAt` is `null` exactly when
 * every rep behind the most-overdue skill was inferred (placement/reprobe)
 * and the scholar never actually attempted it — that reads as "not yet
 * drilled", never a fabricated date, and never `lastPracticedAt` (the SR
 * clock placement resets; schema.ts's own rule, spec's Signal #3).
 */
export function lastDrilledClause(
  lastAttemptAt: number | null,
  now: number,
): string {
  if (lastAttemptAt == null) return "not yet drilled (placement only)";
  const days = Math.max(0, Math.round((now - lastAttemptAt) / DAY_MS));
  if (days === 0) return "last drilled today";
  if (days === 1) return "last drilled 1 day ago";
  return `last drilled ${days} days ago`;
}

/**
 * Tier 1 — the terse tooltip clause appended to a domain cell's existing
 * readout when it has something due. Undefined (nothing appended, calm cell)
 * whenever `dueCount` is 0 — a fresh or empty domain says nothing extra.
 */
export function retentionHoverClause(
  retention: DomainRetentionSummary | undefined,
  now: number,
): string | undefined {
  if (!retention || retention.dueCount === 0 || !retention.mostOverdue) {
    return undefined;
  }
  const skillWord = retention.dueCount === 1 ? "skill" : "skills";
  return `${retention.dueCount} of ${retention.greenCount} fluent ${skillWord} due — ${lastDrilledClause(
    retention.mostOverdue.lastAttemptAt,
    now,
  )}`;
}

/**
 * Tier 2 — the fuller detail-panel sentence, same vocabulary plus the
 * half-life that makes "due" legible as decay rather than an arbitrary flag.
 * Undefined under the same conditions as `retentionHoverClause` — the panel
 * strip renders nothing when there is nothing to act on.
 */
export function retentionStripSentence(
  retention: DomainRetentionSummary | undefined,
  now: number,
): string | undefined {
  if (!retention || retention.dueCount === 0 || !retention.mostOverdue) {
    return undefined;
  }
  const skillWord = retention.dueCount === 1 ? "skill" : "skills";
  const halfLife = Math.round(retention.mostOverdue.halfLifeDays);
  return `${retention.dueCount} of ${retention.greenCount} fluent ${skillWord} decayed past due — ${lastDrilledClause(
    retention.mostOverdue.lastAttemptAt,
    now,
  )}, half-life ~${halfLife}d.`;
}
