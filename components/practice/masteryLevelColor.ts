/**
 * masteryLevelColor — THE one shared color scale for a mastery-grade-level
 * number (`mathLevel`, the portrait's grade), imported by both the matrix
 * column header aggregate and each per-domain cell so they can never draw
 * the same quantity in two different colors (product-taste rule T1).
 *
 * Colors the level RELATIVE to the scholar's Grade Equivalent
 * (`shared/gradeEquivalent.ts`: enrolled grade + school month, e.g. 3.4 for a third
 * grader in November) — Δ = level − GE — reusing the app's EXISTING
 * green→teal mastery vocabulary rather than minting a second palette: fluent
 * green already means "mastered" and overlearned teal already means "beyond
 * fluent, durable," so above-grade mastery reads in the same hue that already
 * carries that meaning elsewhere in the app.
 *
 * BANDS (T6 — calibrated against the two definitions, TRA-143):
 *   Δ < AT_GRADE_DELTA_FLOOR (−0.5)          → "below"     quiet slate
 *   −0.5 ≤ Δ ≤ AT_GRADE_DELTA_CEILING (+0.5) → "at"        fluent green
 *   +0.5 < Δ ≤ ABOVE_DELTA_CEILING (+1.5)    → "above"     overlearned teal
 *   Δ > +1.5                                 → "wellAbove" deep teal
 *
 * WHY ON PACE IS CENTRED ON ZERO. Both sides of Δ share a zero:
 *   - the mastery level is F + f for a child who has covered every grade
 *     below F and fraction f of grade F (`mathLevel`: grades up to 3 covered
 *     plus 60% of grade 4 is 4.6);
 *   - the GE is G + m for a child enrolled in grade G, m school months in
 *     (`shared/gradeEquivalent.ts`: Aug .1 … Apr .9).
 * So a child whose mastery keeps pace with the school year reads Δ ≈ 0. The
 * "at" band keeps the one-grade width the earlier birthday-anchored bands
 * were calibrated to (−2 … −1, centred on the −1.5 offset between that
 * anchor's zero and the level's), now centred where both zeros meet: ±0.5 is
 * five school months either side. "above" is up to one more grade of reach;
 * "wellAbove" is more than a grade and a half past the enrolled grade.
 *
 * below is deliberately NOT red: red is reserved for the `struggling` band
 * (an engaged-but-failing signal) elsewhere in the mastery vocabulary, and a
 * below-grade reading here is a learner↔concept "not yet," never a
 * learner↔learner deficit — see the pedagogy doctrine on "gap" framing.
 *
 * MISSING ANCHOR (no recognisable enrolled grade, so no GE): the
 * grade-relative tint is null (a neutral cell) and `masteryLevelToneLabel`
 * returns null — without an anchor this module makes no relative
 * "ahead/behind" CLAIM, and UI copy must use that null to omit any
 * grade-relative wording. "absolute" mode still colours the raw level.
 */

import {
  ABOVE_DELTA_CEILING,
  AT_GRADE_DELTA_CEILING,
  AT_GRADE_DELTA_FLOOR,
  GRADE_RELATIVE_BAND_WORDS,
  gradeRelativeBand,
  levelDelta,
  type GradeRelativeBand,
} from "@/shared/gradeEquivalent";

// The cut-offs and the classifier live in `shared/gradeEquivalent.ts`, so the
// portrait's overall level, the staff aide and the parent report band a level
// exactly as this tint does.
export { ABOVE_DELTA_CEILING, AT_GRADE_DELTA_CEILING, AT_GRADE_DELTA_FLOOR, levelDelta };

export type MasteryLevelTone = "below" | "at" | "above" | "wellAbove";

const TONE_OF_BAND: Record<GradeRelativeBand, MasteryLevelTone> = {
  behind: "below",
  onPace: "at",
  ahead: "above",
  farAhead: "wellAbove",
};

export function masteryLevelTone(
  level: number,
  gradeEquivalent: number,
): MasteryLevelTone {
  return TONE_OF_BAND[gradeRelativeBand(levelDelta(level, gradeEquivalent))];
}

/**
 * The aria/tooltip word for a tone, e.g. "on pace". Returns null when the
 * grade equivalent is null (no relative claim without an anchor) — callers
 * must treat null as "omit any grade-relative wording", not fall back to
 * "on pace".
 */
export function masteryLevelToneLabel(
  level: number,
  gradeEquivalent: number | null,
): string | null {
  if (gradeEquivalent === null) return null;

  return GRADE_RELATIVE_BAND_WORDS[gradeRelativeBand(levelDelta(level, gradeEquivalent))];
}

/**
 * masteryLevelTint — the heatmap CELL BACKGROUND colour
 * (review/math-skills-matrix-visual-language.html §4). Two modes, picked by
 * the "Level coloring" legend toggle:
 *
 *   - **"gradeRelative"** (default): four DIVERGING washes of the
 *     `masteryLevelTone` bands, keyed on Δ = level − GE. When the GE is
 *     `null` (no enrolled grade on file), this mode returns **null** — a
 *     neutral/unwashed cell — rather than faking a relative claim we cannot
 *     make. Use "absolute" mode for such a scholar instead.
 *   - **"absolute"**: a five-band SEQUENTIAL ramp over the raw `level`
 *     itself, the GE ignored (and may be `null`) — "equal numbers get equal
 *     colours" so a domain row is directly comparable and a colour block IS
 *     an instructional group (§4.3). Level 2.x means working in grade 2, so
 *     the K–1 / 2–3 / 4–5 / 6–7 / 8+ bands name the grades being worked in.
 *
 * Callers pick the text colour to ride the tint separately (always neutral
 * navy for the level, dark grey for the Δ — see §4.1a's contrast table) —
 * this function only ever returns the background.
 */
export type LevelColoringMode = "gradeRelative" | "absolute";

// Grade-relative background washes, one per tone: slate (not-yet, never
// deficit red), fluent green, overlearned teal, deep teal.
const TINT_BEHIND = "#e6eaef";
const TINT_ON_PACE = "#dcf3e6";
const TINT_AHEAD = "#cfece7";
const TINT_FAR_AHEAD = "#bfe6de";

// Absolute mode — five sequential, no-anchor washes over the raw K–8 level.
const TINT_ABSOLUTE_K1 = "#edf6f2"; // level < 2
const TINT_ABSOLUTE_23 = "#d2eae0"; // 2 ≤ level < 4
const TINT_ABSOLUTE_45 = "#a9d8ca"; // 4 ≤ level < 6
const TINT_ABSOLUTE_67 = "#7cc0b4"; // 6 ≤ level < 8
const TINT_ABSOLUTE_8PLUS = "#57aca1"; // level ≥ 8

export function masteryLevelTint(
  level: number,
  gradeEquivalent: number | null,
  mode: LevelColoringMode,
): string | null {
  if (mode === "absolute") {
    if (level < 2) return TINT_ABSOLUTE_K1;
    if (level < 4) return TINT_ABSOLUTE_23;
    if (level < 6) return TINT_ABSOLUTE_45;
    if (level < 8) return TINT_ABSOLUTE_67;
    return TINT_ABSOLUTE_8PLUS;
  }

  if (gradeEquivalent === null) return null; // no anchor — never fake a relative claim

  switch (masteryLevelTone(level, gradeEquivalent)) {
    case "below":
      return TINT_BEHIND;
    case "at":
      return TINT_ON_PACE;
    case "above":
      return TINT_AHEAD;
    case "wellAbove":
      return TINT_FAR_AHEAD;
  }
}
