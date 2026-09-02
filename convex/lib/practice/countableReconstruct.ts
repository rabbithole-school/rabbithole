/**
 * Countables prompt-visual reconstruction — the single source of truth shared by
 * the serve-time guard (`buildStoredServable` in servable.ts) and the backfill
 * migration (`migrateLegacyCountablePromptVisuals` in convex/migrations.ts).
 *
 * A stored counting-family row ("How many dots?") must never ship without its
 * dots visual: the stem is meaningless on its own, and the accessible label that
 * exposes the count rides on the visual. A rare class of stored/generated rows
 * lost (or never had) a `promptVisual` — this rebuilds it deterministically from
 * the row's own count, or reports it un-reconstructable so the caller can EXCLUDE
 * the row rather than serve a bare, unanswerable stem.
 *
 * Pure: no Convex ctx. `reconstructCountablesPromptVisual` takes the minimal row
 * shape both callers already hold.
 */

import {
  makeCountablesPromptVisual,
  type CountablesLayout,
  type CountablesPromptVisual,
} from "../../../shared/practicePromptVisual";

/**
 * The counting-family skills whose canonical prompt is "How many dots?", with
 * the layout each renders in and the largest valid count. A reconstructed count
 * outside `1..max` is not trusted (the row is corrupt) and yields no visual.
 */
export const COUNTABLE_SKILL_LAYOUTS: Record<string, { layout: CountablesLayout; max: number }> = {
  cardinality_within_10: { layout: "tenframe", max: 10 },
  count_objects_within_10: { layout: "scatter", max: 10 },
  count_objects_within_20: { layout: "tenframe", max: 20 },
};

/** Whether a skillKey belongs to the "How many dots?" counting family. */
export function isCountableSkill(skillKey: string): boolean {
  return skillKey in COUNTABLE_SKILL_LAYOUTS;
}

/**
 * Whether a row is the counting-family "How many dots?" prompt (bare, or the
 * legacy glyph form) — the class that is meaningless without its dots visual and
 * must therefore be reconstructed or excluded on serve. A counting-family word
 * problem with a self-sufficient text stem is deliberately NOT flagged (its text
 * stands on its own and needs no visual).
 */
export function isBareDotsPrompt(skillKey: string, stem: string): boolean {
  return (
    isCountableSkill(skillKey) &&
    (stem === "How many dots?" || parseLegacyDotCount(stem) !== null)
  );
}

/** Deterministic FNV-1a hash → the visual's dot-jitter seed (stable per row). */
export function stableVisualSeed(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** The count baked into a legacy glyph stem ("How many dots? ●●●"), else null. */
export function parseLegacyDotCount(stem: string): number | null {
  const match = stem.match(/^How many dots\? (●+)$/u);
  return match ? [...match[1]].length : null;
}

/** A non-negative decimal string → its integer value, else null. */
export function parseCanonicalInteger(value: string): number | null {
  if (!/^\d+$/.test(value)) return null;
  const n = Number(value);
  return Number.isSafeInteger(n) ? n : null;
}

/** The minimal `practiceItems` shape reconstruction reads. A full
 *  `Doc<"practiceItems">` and the resolver's `StoredPracticeItem` are both
 *  structurally assignable. */
export type CountableRow = {
  _id: string;
  skillKey: string;
  stem: string;
  answerCanonical: string;
  verifiedAt?: number;
};

/**
 * Reconstruct the countables `promptVisual` for a stored counting-family row
 * that has none — the serve-time twin of `migrateLegacyCountablePromptVisuals`.
 * Returns null (→ EXCLUDE the row) when it is not a trustworthy dots prompt:
 * a non-counting skill, a stem that isn't the "How many dots?" prompt (bare or
 * legacy-glyph), a non-integer / out-of-range count, or a count that disagrees
 * with the stored answer. Never fabricates a visual for an ambiguous row.
 */
export function reconstructCountablesPromptVisual(row: CountableRow): CountablesPromptVisual | null {
  const config = COUNTABLE_SKILL_LAYOUTS[row.skillKey];
  if (!config) return null;

  const legacyCount = parseLegacyDotCount(row.stem);
  const isBareDotsPrompt = row.stem === "How many dots?";
  if (legacyCount === null && !isBareDotsPrompt) return null;

  const canonical = parseCanonicalInteger(row.answerCanonical);
  const n = legacyCount ?? canonical;
  if (n === null || n < 1 || n > config.max) return null;
  // The reconstructed item must stay GRADEABLE: grading parses answerCanonical
  // back to an integer, so a row whose answerCanonical isn't a clean integer
  // (canonical === null) — or disagrees with the prompt count — must be
  // rejected, not reconstructed into an ungradeable item. This matches the
  // original migration's unconditional `canonical !== n` reject.
  if (canonical === null || canonical !== n) return null;

  return makeCountablesPromptVisual({
    n,
    motif: "dot",
    layout: config.layout,
    seed: stableVisualSeed(`${String(row._id)}:${String(row.verifiedAt)}:${n}`),
  });
}
