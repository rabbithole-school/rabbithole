/**
 * PURE helper for the scholar-facing daily map-movement receipt.
 *
 * The Convex query (convex/dailyRecap.ts) hands this module plain rows it has
 * already read + redacted (practiceMastery transition stamps, nodeReveals
 * events, and a nodeKey→label map). This module does no reads, no writes, and
 * no model calls.
 * Pure = trivially unit-testable.
 *
 * Guardrails (portrait, not report card — see review/anti-parasocial-design.md
 * and convex/lib/practiceDigest.ts): this is SCHOLAR-facing, so it names only
 * what genuinely moved and never quantifies it into a scorecard. No scores, no
 * correct/wrong counts, no streaks, no goals, no learner-vs-learner comparison,
 * no empty praise. When nothing moved today, `hasAny` is false and the card
 * renders nothing (never a guilt zero-state). The delta is self-vs-self only.
 *
 * Receipt semantics:
 *   • yoursNow  — a skill the scholar DEMONSTRATED fluent today:
 *     `becameFluentAt >= dayStart` AND the row is CURRENTLY fluent (`fluentNow`,
 *     the composite green claim the query computes via isFluent(row, {now})).
 *     Placement / accelerated / reprobe credit opens access but is never claimed
 *     as proven (isFluent's source leg drops it), and a skill that has already
 *     decayed since this morning's crossing (isFluent's retention leg) is a due
 *     review, not a green claim — so neither surfaces here.
 *   • newOnMap  — access advanced through practice today:
 *     `frontierAdvancedAt >= dayStart`.
 *   • revealed  — a node entered the one-hop thoughtful-reveal horizon today.
 *
 * `practiced`, `practicedCount`, and `finished` remain in the response shape
 * for released native clients, but are intentionally always empty. Practice
 * attempts and completed activities do not mean that the durable map changed.
 *
 * A fluent crossing can be stamped by the SAME attempt that moves the frontier
 * (see convex/practiceSkills.ts recordAttemptCore). The receipt gives that node
 * one row — green Fluent wins over the duplicate yellow frontier event.
 */

// Label lists are capped so the receipt stays a glance, not a ledger.
const MAX_LABELS = 4;

export interface DailyRecapMasteryRow {
  skillKey: string;
  // Engine-neutral source discriminator; only "practice" earns "yours now".
  // Retained for documentation/tests — the yoursNow filter now leans on
  // `fluentNow`, which already subsumes the demonstrated-source check.
  source: string;
  // The composite GREEN claim (raise-the-ceiling §1), computed by the query via
  // isFluent(row, {now}): access-proven AND demonstrated-source AND currently
  // retained (not decayed). Only a row that is BOTH freshly crossed today AND
  // fluentNow earns "yours now".
  fluentNow: boolean;
  // Transition stamps written once by recordAttemptCore (see schema). Unset on
  // historical rows / rows that never crossed the bar.
  // Retained as a compatibility input so tests can prove an attempt alone is
  // ignored by the receipt.
  lastAttemptAt?: number | null;
  becameFluentAt?: number | null;
  frontierAdvancedAt?: number | null;
}

export interface DailyRecapCompletion {
  // Compatibility input used to prove that completions remain ignored.
  title: string;
  completedAt: number;
}

export interface DailyRecapRevealRow {
  nodeKey: string;
  revealedAt: number;
}

export interface DailyRecapInput {
  masteryRows: DailyRecapMasteryRow[];
  revealedRows?: DailyRecapRevealRow[];
  // nodeKey → human label. A missing key falls back to a de-slugged skillKey.
  labelByKey: Map<string, string>;
  // Retained for compatibility tests; never contributes to the receipt.
  completions: DailyRecapCompletion[];
  // Client-local midnight (ms). Rows are counted only if their stamp is >= this.
  dayStart: number;
}

export interface DailyRecap {
  // Compatibility fields for released clients; always empty/zero.
  practiced: string[];
  practicedCount: number;
  // Skills demonstrated fluent today (capped labels).
  yoursNow: string[];
  // Skills whose access advanced today (capped labels).
  newOnMap: string[];
  // Skills added to the thoughtful-reveal horizon today (capped labels).
  revealed: string[];
  // Compatibility field for released clients; always empty.
  finished: string[];
  // True only when a durable map-movement bucket has content.
  hasAny: boolean;
}

function labelFor(key: string, labelByKey: Map<string, string>): string {
  return labelByKey.get(key) ?? key.replace(/[-_]+/g, " ");
}

function crossed(stamp: number | null | undefined, dayStart: number): stamp is number {
  return typeof stamp === "number" && stamp >= dayStart;
}

/**
 * Bucket a scholar's day of movement into the recap card's lines. Deterministic
 * and side-effect-free: same inputs → same output, in stable (most-recent-first)
 * order within each bucket.
 */
export function buildDailyRecap({
  masteryRows,
  revealedRows = [],
  labelByKey,
  dayStart,
}: DailyRecapInput): DailyRecap {
  const yoursNowRows = masteryRows
    .filter((r) => crossed(r.becameFluentAt, dayStart) && r.fluentNow)
    .sort((a, b) => (b.becameFluentAt ?? 0) - (a.becameFluentAt ?? 0));
  const yoursNowKeys = dedupeKeys(yoursNowRows.map((r) => r.skillKey));
  const yoursNowKeySet = new Set(yoursNowKeys);

  const newOnMapRows = masteryRows
    .filter((r) => crossed(r.frontierAdvancedAt, dayStart))
    .sort((a, b) => (b.frontierAdvancedAt ?? 0) - (a.frontierAdvancedAt ?? 0));
  const newOnMapKeys = dedupeKeys(newOnMapRows.map((r) => r.skillKey)).filter(
    (skillKey) => !yoursNowKeySet.has(skillKey),
  );
  const newOnMapKeySet = new Set(newOnMapKeys);
  const revealedKeys = dedupeKeys(
    revealedRows
      .filter((row) => row.revealedAt >= dayStart)
      .sort((a, b) => b.revealedAt - a.revealedAt)
      .map((row) => row.nodeKey),
  ).filter(
    (nodeKey) => !yoursNowKeySet.has(nodeKey) && !newOnMapKeySet.has(nodeKey),
  );

  const usedLabels = new Set<string>();
  const labelsFor = (keys: string[]): string[] => {
    const labels: string[] = [];
    for (const key of keys) {
      const label = labelFor(key, labelByKey);
      if (usedLabels.has(label)) continue;
      usedLabels.add(label);
      labels.push(label);
      if (labels.length === MAX_LABELS) break;
    }
    return labels;
  };
  const yoursNow = labelsFor(yoursNowKeys);
  const newOnMap = labelsFor(newOnMapKeys);
  const revealed = labelsFor(revealedKeys);

  return {
    practiced: [],
    practicedCount: 0,
    yoursNow,
    newOnMap,
    revealed,
    finished: [],
    hasAny:
      yoursNow.length > 0 || newOnMap.length > 0 || revealed.length > 0,
  };
}

// Preserve first-seen order while removing duplicate skillKeys (a skill has one
// mastery row per scholar, but dedupe defensively so a label never doubles).
function dedupeKeys(keys: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const k of keys) {
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(k);
  }
  return out;
}
