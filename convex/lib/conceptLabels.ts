/**
 * Concept-label similarity — the ONE place "are these two mastery-observation
 * labels the same concept?" is decided, shared by:
 *   - the observer write-path dedup net (`masteryObservations.record`), and
 *   - the eval gate (`evals/observer/rigor-check.ts`),
 * so the guard and the enforcement can never drift.
 *
 * This is a LEXICAL backstop, deliberately conservative. It catches the
 * near-twin labels the observer piles up at scale ("Systematic bug isolation and
 * reproduction" ≈ "Systematic bug isolation and reporting"). It does NOT catch
 * semantically-equal-but-lexically-different labels ("Value-based pricing" vs
 * "Multi-attribute utility pricing") — that judgment stays the model's job, via
 * the consolidation rules in OBSERVER_SYSTEM_PROMPT. Net = floor, prompt = brain.
 */

// Content words only — drop punctuation and connective stopwords so word order
// and small phrasings don't matter.
const STOP = new Set([
  "and", "the", "of", "in", "a", "an", "to", "as", "for", "through", "with",
  "on", "is", "are", "or", "by", "via", "using", "based",
]);

export function conceptLabelWords(label: string): Set<string> {
  return new Set(
    label
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w && !STOP.has(w)),
  );
}

/**
 * True when the two labels are near-duplicates: the SMALLER content-word set is
 * mostly contained in the larger (|intersection| / |smaller| >= threshold).
 *
 * Guards against over-merging: labels with fewer than 2 content words never
 * match (a one-word label would otherwise be "contained" in any superset, e.g.
 * "Fractions" swallowing "Fractions and decimals").
 *
 * Threshold is the caller's policy, because the two uses want different risk:
 *   - DETECTION (the eval gate flagging pile-ons) uses the loose default (0.7) —
 *     a false positive just nudges the model to consolidate.
 *   - ENFORCEMENT (the write-path net + the backfill migration auto-superseding
 *     real teacher data) uses AUTO_MERGE_THRESHOLD (0.85, effectively
 *     subset-only): it collapses exact duplicates and qualifier/suffix variants
 *     but keeps labels that each carry a distinguishing word apart ("Addition of
 *     fractions…" vs "Subtraction of fractions…" → 0.75, NOT merged). A lexical
 *     heuristic can't tell a same-concept twin ("…reproduction" vs "…reporting")
 *     from a different-concept twin at one threshold, so enforcement stays
 *     conservative and leaves semantic consolidation to the observer prompt.
 */
export function conceptLabelsNearDuplicate(a: string, b: string, threshold = 0.7): boolean {
  const wa = conceptLabelWords(a);
  const wb = conceptLabelWords(b);
  const min = Math.min(wa.size, wb.size);
  if (min < 2) return false; // too short to auto-merge safely
  let inter = 0;
  for (const w of wa) if (wb.has(w)) inter++;
  return inter / min >= threshold;
}

/**
 * Threshold for ENFORCEMENT (auto-supersession of real records). Conservative —
 * effectively "the shorter label's words are a subset of the longer's", so it
 * only collapses exact duplicates + qualifier/suffix variants, never two labels
 * that each carry a distinguishing word. Validated against a read-only shadow
 * run over all 914 current prod observations (collapses 41%, all exact dups /
 * subsets; no cross-concept false merges). See evals/observer/FINDINGS-rigor.md.
 */
export const AUTO_MERGE_THRESHOLD = 0.85;
