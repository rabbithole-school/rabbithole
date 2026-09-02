import type { MasteryState } from "@/shared/treeMapLayout";
import { STRUGGLING_TITLE_LABEL } from "@/shared/masteryLexicon";

/**
 * The mastery filter is now a PURE mastery-band axis. "Not yet serving" used to
 * be a sixth key here, but serving is a separate ACCESS axis — surfaced by the
 * matrix header faces (dimmed when not served) and the "Show scholars: All |
 * Served this domain" toggle — and a not-serving scholar can still carry real
 * mastery (they pre-tested out). So access no longer lives in this filter; the
 * filter only decides which mastery bands are shown.
 */
export type MasteryFilterKey = MasteryState;

/**
 * The ONE canonical mastery-band order, shared by the Filter menu, every band
 * distribution list, and (minus `locked`) the header meter — so the bands read
 * identically everywhere (one canonical rendering per signal).
 *
 * This is STRAND-PROGRESSION order: the sequence you meet skills when you scan a
 * strand from its first (most foundational) skill to its last —
 *   placed (tested out of the foundations) → overlearned (rock solid) →
 *   fluent (mastered) → frontier (practicing now) → locked (not reached yet).
 * `placed` leads because credit-by-placement is earned on the earliest,
 * most-foundational skills. This is deliberately NOT raw mastery-magnitude order
 * (which would lead with `overlearned`); do not "fix" it back.
 */
export const MASTERY_FILTER_ORDER: readonly MasteryFilterKey[] = [
  "placed",
  "overlearned",
  "fluent",
  "frontier",
  // Teacher/parent-facing red state — an engaged-but-recently-failing skill.
  // Sits just before `locked` (the only lower state); redacted from scholars.
  "struggling",
  "locked",
];

export const MASTERY_FILTER_LABEL: Record<MasteryFilterKey, string> = {
  locked: "Not started",
  struggling: STRUGGLING_TITLE_LABEL,
  frontier: "Practicing",
  placed: "Placed",
  fluent: "Fluent",
  overlearned: "Rock solid",
};

export function allMasteryFilters(): Set<MasteryFilterKey> {
  return new Set(MASTERY_FILTER_ORDER);
}

/**
 * The default view shows every mastery band. This is the set the URL represents
 * when the `statuses` param is absent.
 */
export const DEFAULT_MASTERY_FILTERS: readonly MasteryFilterKey[] =
  MASTERY_FILTER_ORDER;

export function defaultMasteryFilters(): Set<MasteryFilterKey> {
  return new Set(DEFAULT_MASTERY_FILTERS);
}

function isDefaultFilterSet(filters: ReadonlySet<MasteryFilterKey>): boolean {
  return (
    filters.size === DEFAULT_MASTERY_FILTERS.length &&
    DEFAULT_MASTERY_FILTERS.every((key) => filters.has(key))
  );
}

export function parseMasteryFilters(value: string | null): Set<MasteryFilterKey> {
  if (value === null) return defaultMasteryFilters();
  const allowed = new Set<string>(MASTERY_FILTER_ORDER);
  return new Set(
    value
      .split(",")
      .filter((candidate): candidate is MasteryFilterKey => allowed.has(candidate)),
  );
}

export function serializeMasteryFilters(
  filters: ReadonlySet<MasteryFilterKey>,
): string | null {
  // Omit the param when every band is shown (the default); any narrower set is
  // an explicit, serialized choice.
  if (isDefaultFilterSet(filters)) return null;
  return MASTERY_FILTER_ORDER.filter((key) => filters.has(key)).join(",");
}

export function masteryFilterKey(reading: {
  mastery: MasteryState;
}): MasteryFilterKey {
  return reading.mastery;
}

export type BandCounts = Record<MasteryFilterKey, number>;

/**
 * One scholar's band spread across a domain's skills — the single source of the
 * per-scholar band counts the header meter (D1), the scholar × domain detail,
 * and the full report (D2) all read, so those surfaces never disagree.
 *
 * A skill with no reading buckets as `locked` ("Not started"), so `total`
 * always equals the domain's skill count. `engaged` = total − locked (the
 * skills the scholar has actually touched), which is the denominator the meter
 * uses: it visualises the earned mix (yellow vs green) among engaged skills,
 * not domain coverage. Crucially this reads each reading's OWN `mastery` band
 * via `masteryFilterKey`, so the hollow-ring `placed` state is preserved rather
 * than collapsed into a plain band (the correctness gate for reusing readings).
 */
export function bandCountsForScholar(
  readingByKey: Map<string, { mastery: MasteryState }>,
  domainNodeKeys: readonly string[],
): { counts: BandCounts; total: number; engaged: number } {
  const counts: BandCounts = {
    locked: 0,
    struggling: 0,
    frontier: 0,
    placed: 0,
    fluent: 0,
    overlearned: 0,
  };
  for (const nodeKey of domainNodeKeys) {
    const reading = readingByKey.get(nodeKey);
    const band: MasteryFilterKey = reading ? masteryFilterKey(reading) : "locked";
    counts[band] += 1;
  }
  const total = domainNodeKeys.length;
  return { counts, total, engaged: total - counts.locked };
}

/** The earned/engaged bands (the meter drops `locked` — not-started coverage
 *  lives in the caption), in the same canonical order as MASTERY_FILTER_ORDER
 *  minus `locked`: placed → rock solid → fluent → practicing → needs review.
 *  `struggling` IS engaged (it's a touched skill), so it's shown here even
 *  though it renders red. */
export const ENGAGED_BAND_ORDER: readonly MasteryFilterKey[] = [
  "placed",
  "overlearned",
  "fluent",
  "frontier",
  "struggling",
];

export function readingMatchesMasteryFilters(
  reading: { mastery: MasteryState },
  filters: ReadonlySet<MasteryFilterKey>,
): boolean {
  return filters.has(masteryFilterKey(reading));
}
