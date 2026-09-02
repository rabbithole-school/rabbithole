/**
 * masteryLevelColor — THE one shared color scale for a mastery-grade-level
 * number (`masteryGradeLevel.ts`'s output), imported by both the matrix
 * column header aggregate and each per-domain cell so they can never draw
 * the same quantity in two different colors (product-taste rule T1).
 *
 * Colors the level RELATIVE to the scholar's own chronological (age-based)
 * grade rank (`chronologicalGrade.ts`) — Δ = level − chronoRank — reusing
 * the app's EXISTING green→teal mastery vocabulary rather than minting a
 * second palette: fluent green already means "mastered" and overlearned
 * teal already means "beyond fluent, durable," so above-grade mastery reads
 * in the same hue that already carries that meaning elsewhere in the app.
 *
 * BANDS (T6 — named, tested constants, not bare judgment calls):
 *   Δ < AT_GRADE_DELTA_FLOOR        → "below"    quiet slate
 *   AT_GRADE_DELTA_FLOOR ≤ Δ ≤ +0.75 → "at"       fluent green
 *   +0.75 < Δ ≤ ABOVE_DELTA_CEILING → "above"     overlearned teal
 *   Δ > ABOVE_DELTA_CEILING          → "wellAbove" deep teal
 * The "at grade" band is intentionally WIDENED DOWNWARD (floor at −0.75,
 * vs. the symmetric +0.75 ceiling on the "above" side) because
 * `masteryGradeLevel`'s frontier formula is a CONSERVATIVE floor (one gap
 * anywhere pins the whole readout low), so the real distribution sits
 * slightly negative — without the widened floor a healthy cohort would
 * paint mostly slate.
 *
 * below is deliberately NOT red: red is reserved for the `struggling` band
 * (an engaged-but-failing signal) elsewhere in the mastery vocabulary, and a
 * below-grade reading here is a learner↔concept "not yet," never a
 * learner↔learner deficit — see the pedagogy doctrine on "gap" framing.
 *
 * MISSING CHRONOLOGICAL ANCHOR (no DOB, so no chronoRank): falls back to a
 * small ABSOLUTE ramp on the raw level (documented inline below) since there
 * is nothing to compare against. `masteryLevelTone` still needs to answer
 * *something* in that mode (internally "at", so a caller wanting only a
 * color has one), but `masteryLevelToneLabel` returns null in that mode —
 * without an anchor this module makes no relative "ahead/behind" CLAIM, and
 * UI copy must use that null to omit any grade-relative wording.
 *
 * DEPRECATED — `masteryLevelColor` / `masteryLevelTone` colour the NUMBER
 * TEXT against an integer chronoRank. The v7 heatmap redesign
 * (review/math-skills-matrix-visual-language.html §4) moves colour to the
 * CELL BACKGROUND and anchors it on the continuous `gradeForAgeFromDob`
 * measure instead of the integer rank — see `masteryLevelTint` below, which
 * is the function new call sites should use. These two are kept (and still
 * tested) only because existing callers still colour the number text; they
 * are not being migrated by this change (a sibling lane owns call sites).
 */

import { MASTERY_DOT_COLOR } from "@/shared/masteryDialPalette";

export type MasteryLevelTone = "below" | "at" | "above" | "wellAbove";

/** Δ ≥ this → still "at grade" (widened downward: the frontier readout is a
 *  conservative floor, so real Δs skew slightly negative). */
export const AT_GRADE_DELTA_FLOOR = -0.75;
/** Δ ≤ this → still "at grade"; beyond this → "above". */
export const AT_GRADE_DELTA_CEILING = 0.75;
/** Δ ≤ this → "above"; beyond this → "wellAbove". */
export const ABOVE_DELTA_CEILING = 1.75;

// The two hues reused verbatim from the canonical mastery-dot palette so the
// two vocabularies can never drift apart.
const AT_GRADE_COLOR = MASTERY_DOT_COLOR.fluent; // "#3a9e6b"
const ABOVE_GRADE_COLOR = MASTERY_DOT_COLOR.overlearned; // "#0f766e"

// Two hexes new to THIS module, extending (not replacing) that palette for
// tones the dial vocabulary has no equivalent of.
const BELOW_GRADE_COLOR = "#64748b"; // quiet slate — "not yet," never deficit red
const WELL_ABOVE_GRADE_COLOR = "#0b5a54"; // deep teal — the celebrated reach

// Absolute fallback ramp used only when chronoRank is unknown (no DOB).
const FALLBACK_LOW = "#5aa87a";
const FALLBACK_MID = "#3f8f5f";
const FALLBACK_HIGH = "#166534";

export function masteryLevelTone(
  level: number,
  chronoRank: number | null,
): MasteryLevelTone {
  if (chronoRank === null) return "at";

  const delta = level - chronoRank;
  if (delta < AT_GRADE_DELTA_FLOOR) return "below";
  if (delta <= AT_GRADE_DELTA_CEILING) return "at";
  if (delta <= ABOVE_DELTA_CEILING) return "above";
  return "wellAbove";
}

export function masteryLevelColor(
  level: number,
  chronoRank: number | null,
): string {
  if (chronoRank === null) {
    if (level < 3) return FALLBACK_LOW;
    if (level < 5) return FALLBACK_MID;
    return FALLBACK_HIGH;
  }

  const tone = masteryLevelTone(level, chronoRank);
  switch (tone) {
    case "below":
      return BELOW_GRADE_COLOR;
    case "at":
      return AT_GRADE_COLOR;
    case "above":
      return ABOVE_GRADE_COLOR;
    case "wellAbove":
      return WELL_ABOVE_GRADE_COLOR;
  }
}

/**
 * The aria/tooltip word for a tone, e.g. "on pace for age". Returns null when
 * chronoRank was null (no relative claim without an anchor) — callers must
 * treat null as "omit any grade-relative wording", not fall back to "on
 * pace for age".
 */
export function masteryLevelToneLabel(
  level: number,
  chronoRank: number | null,
): string | null {
  if (chronoRank === null) return null;

  switch (masteryLevelTone(level, chronoRank)) {
    case "below":
      return "behind for age";
    case "at":
      return "on pace for age";
    case "above":
      return "ahead for age";
    case "wellAbove":
      return "far ahead for age";
  }
}

/**
 * masteryLevelTint — the v7 heatmap CELL BACKGROUND colour
 * (review/math-skills-matrix-visual-language.html §4). Two modes, picked by
 * the "Level coloring" legend toggle:
 *
 *   - **"ageRelative"** (default; shipped's Δ-colouring, moved to the
 *     background): four DIVERGING washes of the `masteryLevelTone` band
 *     hues, keyed on `Δ = level − gradeForAge` (the CONTINUOUS measure from
 *     `gradeForAgeFromDob`, not the integer `chronoRank` the text-colour
 *     functions above use — §4.1a sharpens Δ to an exact quantity). Same
 *     band edges as `masteryLevelTone`. When `gradeForAge` is `null` (no
 *     DOB on file), this mode returns **null** — a neutral/unwashed cell —
 *     rather than faking a relative claim we cannot make; §4 body
 *     deliberately retires the old pseudo-green fallback for this reason.
 *     Use "absolute" mode (or the empty-cell "no birthdate on file" hint)
 *     for a no-DOB scholar instead.
 *   - **"absolute"**: a five-band SEQUENTIAL ramp over the raw `level`
 *     itself, `gradeForAge` ignored (and may be `null`) — "equal numbers get
 *     equal colours" so a domain row is directly comparable and a colour
 *     block IS an instructional group (§4.3). Evolves the retired no-DOB
 *     three-hue seed ramp into five coarse, teachable K–8 bands.
 *
 * Callers pick the text colour to ride the tint separately (v7: always
 * neutral navy for the level, dark grey for the Δ — see §4.1a's contrast
 * table) — this function only ever returns the background.
 */
export type LevelColoringMode = "ageRelative" | "absolute";

// Age-relative background washes — same four bands as masteryLevelTone,
// lightened for a cell background instead of the number text.
const TINT_BEHIND = "#e6eaef"; // slate wash of BELOW_GRADE_COLOR
const TINT_ON_PACE = "#dcf3e6"; // green wash of AT_GRADE_COLOR
const TINT_AHEAD = "#cfece7"; // teal wash of ABOVE_GRADE_COLOR
const TINT_FAR_AHEAD = "#bfe6de"; // deep-teal wash of WELL_ABOVE_GRADE_COLOR

// Absolute mode — five sequential, no-anchor washes over the raw K–8 level.
const TINT_ABSOLUTE_K1 = "#edf6f2"; // level < 2
const TINT_ABSOLUTE_23 = "#d2eae0"; // 2 ≤ level < 4
const TINT_ABSOLUTE_45 = "#a9d8ca"; // 4 ≤ level < 6
const TINT_ABSOLUTE_67 = "#7cc0b4"; // 6 ≤ level < 8
const TINT_ABSOLUTE_8PLUS = "#57aca1"; // level ≥ 8

export function masteryLevelTint(
  level: number,
  gradeForAge: number | null,
  mode: LevelColoringMode,
): string | null {
  if (mode === "absolute") {
    if (level < 2) return TINT_ABSOLUTE_K1;
    if (level < 4) return TINT_ABSOLUTE_23;
    if (level < 6) return TINT_ABSOLUTE_45;
    if (level < 8) return TINT_ABSOLUTE_67;
    return TINT_ABSOLUTE_8PLUS;
  }

  // mode === "ageRelative"
  if (gradeForAge === null) return null; // no anchor — never fake a relative claim

  const delta = level - gradeForAge;
  if (delta < AT_GRADE_DELTA_FLOOR) return TINT_BEHIND;
  if (delta <= AT_GRADE_DELTA_CEILING) return TINT_ON_PACE;
  if (delta <= ABOVE_DELTA_CEILING) return TINT_AHEAD;
  return TINT_FAR_AHEAD;
}

