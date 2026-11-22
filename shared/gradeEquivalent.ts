/**
 * gradeEquivalent — the standard Grade Equivalent (GE) for a scholar's
 * ENROLLED grade (`users.gradeLevel`) at a moment in the school year: the
 * grade number plus the school month in tenths. A third grader reads 3.1 in
 * August, 3.4 in November, 3.9 in spring — the convention teachers already
 * know from norm-referenced score reports.
 *
 * It is the anchor every grade-relative math reading uses: the skills
 * matrix tint (`components/practice/masteryLevelColor.ts`), the overall math
 * level on the Math Skills portrait, the staff aide's `mathLevel`, and the
 * parent report's overall math line. Δ = level − GE, where the level is on the
 * same scale (`mathLevel`: grades below 3 covered plus 40% of grade 3 reads
 * 3.4). So a scholar whose mastery keeps pace with their class reads Δ ≈ 0, and
 * `gradeRelativeBand` below is the one place Δ becomes behind / on pace /
 * ahead / far ahead.
 *
 * CALENDAR — a ten-month school year starting in August (the primary school's
 * calendar), one tenth per school month: Aug .1, Sep .2, Oct .3, … Apr .9.
 * The scale tops out at .9, so May and the summer (June, July) hold there —
 * the year is effectively done and the grade tag has not been advanced yet. Month tenths,
 * not a continuous day count, because that is what a GE means to a reader.
 *
 * `now` is always an explicit argument — this module never reads the clock, so
 * tests stay deterministic and one render shares a single moment.
 */

import { normalizeGradeTag } from "./grade";

/** Calendar month (1-indexed) the school year starts in. */
const SCHOOL_YEAR_START_MONTH = 8; // August
/** A GE's month digit tops out at .9. */
const MAX_TENTH = 9;

/** The numeric rank of an enrolled-grade tag (K = 0), or null when the tag is
 *  missing or not a recognisable grade. */
export function enrolledGradeRank(
  gradeLevel: string | null | undefined,
): number | null {
  const normalized = normalizeGradeTag(gradeLevel);
  if (normalized === undefined) return null;
  if (normalized === "K") return 0;
  if (!/^[0-9]{1,2}$/.test(normalized)) return null;
  return Number(normalized);
}

/** The school month in tenths for `now`: Aug 0.1 … Apr 0.9; May–Jul 0.9. */
export function schoolYearTenths(now: Date): number {
  const month = now.getMonth() + 1; // Date.getMonth() is 0-indexed
  const schoolMonth = ((month - SCHOOL_YEAR_START_MONTH + 12) % 12) + 1;
  return Math.min(schoolMonth, MAX_TENTH) / 10;
}

/**
 * The scholar's Grade Equivalent: enrolled grade + school month tenths.
 * `null` when there is no recognisable enrolled grade — callers then make no
 * relative claim.
 */
export function gradeEquivalentFromTag(
  gradeLevel: string | null | undefined,
  now: Date,
): number | null {
  return gradeEquivalentFromRank(enrolledGradeRank(gradeLevel), now);
}

/**
 * The same Grade Equivalent from an enrolled-grade RANK (K = 0), for callers
 * that already hold one. A pre-K or missing rank has no GE.
 */
export function gradeEquivalentFromRank(
  rank: number | null,
  now: Date,
): number | null {
  if (rank === null || rank < 0) return null;
  return rank + schoolYearTenths(now);
}

// ── Grade-relative bands ────────────────────────────────────────────────────
// Calibration and the reasoning behind each cut-off live in
// `components/practice/masteryLevelColor.ts`, the matrix tint built on these.

/** Δ ≥ this → still "on pace": up to five school months behind the GE. */
export const AT_GRADE_DELTA_FLOOR = -0.5;
/** Δ ≤ this → still "on pace": up to five school months ahead of the GE. */
export const AT_GRADE_DELTA_CEILING = 0.5;
/** Δ ≤ this → "ahead" (up to one more grade of reach); beyond → "far ahead". */
export const ABOVE_DELTA_CEILING = 1.5;

/**
 * Δ = level − GE, rounded to the one decimal the matrix cell displays. Bands
 * read this rounded value so a cell showing "+0.5" can never be tinted
 * "ahead" by a float residue the reader cannot see.
 */
export function levelDelta(level: number, gradeEquivalent: number): number {
  return Math.round((level - gradeEquivalent) * 10) / 10;
}

export type GradeRelativeBand = "behind" | "onPace" | "ahead" | "farAhead";

/** Where a Δ (from `levelDelta`) sits against the grade equivalent. */
export function gradeRelativeBand(delta: number): GradeRelativeBand {
  if (delta < AT_GRADE_DELTA_FLOOR) return "behind";
  if (delta <= AT_GRADE_DELTA_CEILING) return "onPace";
  if (delta <= ABOVE_DELTA_CEILING) return "ahead";
  return "farAhead";
}

/** The matrix legend's word for each band, lower case for mid-sentence use. */
export const GRADE_RELATIVE_BAND_WORDS: Record<GradeRelativeBand, string> = {
  behind: "behind",
  onPace: "on pace",
  ahead: "ahead",
  farAhead: "far ahead",
};
