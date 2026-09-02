/** The two-axis model tracks automaticity with these proficiency bands while conceptual depth remains a separate measure. */
export const MASTERY_LABELS = {
  not_started: "not started",
  practicing: "practicing",
  // PROVISIONAL render word (not a rep band): an access-proven but INFERRED
  // credit (placement / accelerated / re-probe) — on the map at this level, not
  // yet a demonstrated fluency claim. Deliberately NOT the bare word "fluent".
  placed: "placed",
  fluent: "fluent",
  overlearned: "rock solid",
} as const;

/** Canonical teacher/parent-facing word for the "struggling" (red) mastery state
 *  — a skill with ≥2 recent misses not yet superseded by a correct answer. NOT a
 *  rep band (it's keyed off missStreak, orthogonal to MASTERY_LABELS' reps), so
 *  it lives on its own. Deliberately non-deficit, review-oriented wording (never
 *  a scholar sees it: this state is redacted from a scholar's own map). Reference
 *  this const at every label site so the word can't fork. */
export const STRUGGLING_LABEL = "needs review";

/** Title-case variant for chip/filter/tooltip copy ("Needs review"), derived
 *  from STRUGGLING_LABEL by the same rule as `fluencyTitleLabel` so the two
 *  casings can't drift. */
export const STRUGGLING_TITLE_LABEL =
  STRUGGLING_LABEL.charAt(0).toUpperCase() + STRUGGLING_LABEL.slice(1);

/** Automaticity (fluency) ladder — the orthogonal "how effortless" axis
 *  (1=effortful, 2=fluent, 3=automatic). Lowercase like MASTERY_LABELS; prose
 *  surfaces use these verbatim. */
const FLUENCY_LABELS: Record<number, string> = {
  1: "effortful",
  2: "fluent",
  3: "automatic",
};

/** The teacher-facing word for an observer fluency reading (1-3), or null for
 *  an unset/unknown level (most observations carry no fluency signal). */
export function fluencyLabel(level: number | null | undefined): string | null {
  if (level === null || level === undefined) return null;
  return FLUENCY_LABELS[level] ?? null;
}

/** Title-case variant for chip/tooltip copy ("Effortful"), derived from the
 *  same words so the two casings can't drift. */
export function fluencyTitleLabel(level: number | null | undefined): string | null {
  const label = fluencyLabel(level);
  return label ? label.charAt(0).toUpperCase() + label.slice(1) : null;
}

/**
 * The per-fact AUTOMATICITY ladder (weakest → strongest) — the ONE vocabulary
 * the fact-fluency classifier (`convex/lib/practice/factFluency.ts`) and the
 * teacher heatmap (`components/practice/FactHeatmap.tsx`) share. It EXTENDS the
 * 1–3 observer fluency ladder above with the two rungs a per-fact read needs
 * that a single observer number can't carry: `unseen` (never attempted) and
 * `practicing` (reliably correct but not yet demonstrably fast).
 *
 * This is the "how automatic" axis and is deliberately SEPARATE from
 * `MasteryState` (locked/frontier/placed/fluent/overlearned), which answers the
 * orthogonal access/green question — do not merge the two.
 */
export type AutomaticityState =
  | "unseen"
  | "effortful"
  | "practicing"
  | "fluent"
  | "automatic";

/** Weakest → strongest, so every surface orders/compares the rungs the same way
 *  (the heatmap legend, the sprint pulling from the weak end). `unseen` is 0. */
const AUTOMATICITY_ORDER: readonly AutomaticityState[] = [
  "unseen",
  "effortful",
  "practicing",
  "fluent",
  "automatic",
];

/** The teacher-facing word for each rung. The three it shares with the observer
 *  ladder (`effortful`/`fluent`/`automatic`) are sourced from `FLUENCY_LABELS`
 *  so the two owners can't drift; `unseen`/`practicing` are per-fact-only. */
export const AUTOMATICITY_LABELS: Record<AutomaticityState, string> = {
  unseen: "not yet seen",
  effortful: FLUENCY_LABELS[1],
  practicing: "practicing",
  fluent: FLUENCY_LABELS[2],
  automatic: FLUENCY_LABELS[3],
};

/** The teacher-facing word for an automaticity rung. */
export function automaticityLabel(state: AutomaticityState): string {
  return AUTOMATICITY_LABELS[state];
}

/** The rung's position on the weakest(0) → strongest(4) ladder. */
export function automaticityRank(state: AutomaticityState): number {
  return AUTOMATICITY_ORDER.indexOf(state);
}
