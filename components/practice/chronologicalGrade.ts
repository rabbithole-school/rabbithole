/**
 * chronologicalGrade — a scholar's AGE-based ("chronological") K–8 grade
 * from their date of birth, independent of whatever grade a teacher has
 * tagged them at (`users.gradeLevel`). Used to anchor `masteryLevelColor`'s
 * below/at/above bands: "is this mastery level ahead of or behind where a
 * child this age would typically sit," not "ahead of their own label."
 *
 * KINDERGARTEN-ENTRY CUTOFF — Hawaii DOE rule: a child must be 5 years old
 * on or before July 31 to enter kindergarten that fall. The primary school is
 * in Hawaii, so this is a real, intentional first-party coupling (see
 * the first-party-first doctrine), not a generic default — kept as ONE
 * overridable constant below so a future non-Hawaii institution can swap it.
 *
 * FORMULA:
 *   - Born Jan 1 – Jul 31 of year Y turns 5 on/before the Jul 31 cutoff of
 *     year Y+5, so K-entry fall is Y+5.
 *   - Born Aug 1 – Dec 31 of year Y turns 5 AFTER that cutoff, so K-entry
 *     fall is Y+6.
 *   - The CURRENT academic year (AY) is the calendar year the school year
 *     started in: Aug–Dec ⇒ `now`'s year; Jan–Jul ⇒ `now`'s year − 1 (still
 *     "living in" the school year that began the previous August).
 *   - Raw rank = AY − kEntryYear (K = 0). Clamp to [0, 8] for display,
 *     since there is no rung on the K–8 axis outside that range.
 *
 * `now` is always an explicit argument — this module NEVER reads the clock
 * itself, so tests stay deterministic across the Jul 31 boundary and the
 * academic-year rollover.
 *
 * `chronologicalGradeFromDob` (the cutoff-snapped integer rank above) STAYS
 * exported and untouched — it remains for the ENROLLED-grade semantics
 * ("what class is this child in", cutoff-based). The math skills matrix now
 * anchors its heatmap on `gradeForAgeFromDob` instead (spec §4.1a): a
 * continuous, cutoff-IGNORING age measure ("how old are they, in grade
 * units"). Keeping the two separate is what makes a disagreement between
 * them informative (accelerated, held-back, or a stale profile) — see
 * `gradeForAgeDisagreesWithTagged` below and
 * review/math-skills-matrix-visual-language.html §4.1a.
 */

import { normalizeGradeTag } from "@/shared/grade";

/** Month (1-indexed) and day of the Hawaii DOE kindergarten-entry cutoff. */
const K_ENTRY_CUTOFF_MONTH = 7; // July
const K_ENTRY_CUTOFF_DAY = 31;

const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

export type ChronologicalGrade = {
  /** Clamped numeric rank on the K–8 axis: K = 0 … 8. Raw values below 0
   *  clamp to 0, above 8 clamp to 8. */
  rank: number;
  /** "pre-K" (raw < 0), "K", "1"…"8", or "8+" (raw > 8). */
  label: string;
};

function labelForRawRank(raw: number): string {
  if (raw < 0) return "pre-K";
  if (raw === 0) return "K";
  if (raw > 8) return "8+";
  return String(raw);
}

/**
 * Strict ISO (`YYYY-MM-DD`) date-of-birth parse, shared by both grade
 * primitives below. Returns `null` for anything missing, malformed, or not a
 * real calendar date (round-tripped through `Date.UTC` so "2018-02-31" —
 * which range-checks fine but rolls over to March 3 — is rejected).
 */
function parseIsoDob(dateOfBirth: string | null | undefined): Date | null {
  if (!dateOfBirth) return null;
  const match = ISO_DATE_RE.exec(dateOfBirth);
  if (!match) return null;

  const birthYear = Number(match[1]);
  const birthMonth = Number(match[2]);
  const birthDay = Number(match[3]);
  const roundTrip = new Date(Date.UTC(birthYear, birthMonth - 1, birthDay));
  if (
    !Number.isInteger(birthYear) ||
    roundTrip.getUTCFullYear() !== birthYear ||
    roundTrip.getUTCMonth() !== birthMonth - 1 ||
    roundTrip.getUTCDate() !== birthDay
  ) {
    return null;
  }
  return roundTrip;
}

export function chronologicalGradeFromDob(
  dateOfBirth: string | null | undefined,
  now: Date,
): ChronologicalGrade | null {
  const dob = parseIsoDob(dateOfBirth);
  if (dob === null) return null;
  const birthMonth = dob.getUTCMonth() + 1;
  const birthDay = dob.getUTCDate();
  const birthYear = dob.getUTCFullYear();

  // Turns 5 on/before the cutoff ⇒ K-entry the same calendar year + 5;
  // otherwise K-entry the following calendar year + 6.
  const bornOnOrBeforeCutoff =
    birthMonth < K_ENTRY_CUTOFF_MONTH ||
    (birthMonth === K_ENTRY_CUTOFF_MONTH && birthDay <= K_ENTRY_CUTOFF_DAY);
  const kEntryYear = birthYear + (bornOnOrBeforeCutoff ? 5 : 6);

  const nowMonth = now.getMonth() + 1; // Date.getMonth() is 0-indexed
  const academicYear = nowMonth >= 8 ? now.getFullYear() : now.getFullYear() - 1;

  const raw = academicYear - kEntryYear;
  const rank = Math.min(8, Math.max(0, raw));
  return { rank, label: labelForRawRank(raw) };
}

/** Milliseconds in one "year" per the Gregorian mean tropical year
 *  (365.2425 days) — avoids calendar walking (leap years, month lengths). */
const MS_PER_YEAR = 365.2425 * 24 * 60 * 60 * 1000;

/**
 * Continuous, cutoff-IGNORING age-based grade: `(now − dateOfBirth)` in
 * years, minus 5 (the nominal kindergarten-entry age, so "grade for age 0" =
 * the start of K). A smooth quantity, not a notch — e.g. age 9.1 reads 4.1,
 * age 11.0 reads 6.0 (spec §4.1a). Floored at 0 so a pre-K-age child reads 0,
 * never negative; there is no upper clamp — display formatting (rounding,
 * decimal places) is the caller's job. `null` for a missing or unparseable
 * `dateOfBirth`; `now` is always an explicit argument (see header comment).
 */
export function gradeForAgeFromDob(
  dateOfBirth: string | null | undefined,
  now: Date,
): number | null {
  const dob = parseIsoDob(dateOfBirth);
  if (dob === null) return null;

  const ageYears = (now.getTime() - dob.getTime()) / MS_PER_YEAR;
  return Math.max(0, ageYears - 5);
}

/**
 * True when a scholar's continuous age-based grade (`gradeForAge`) disagrees
 * with their teacher-tagged / enrolled grade (`users.gradeLevel`) by a whole
 * grade or more — the "accelerated / held-back / stale profile" flag (spec
 * §4.1a). Compares `round(gradeForAge)` against the tagged grade's numeric
 * rank (via `normalizeGradeTag`, so "Grade 2" / "g2" / "2" all agree); a
 * tolerance of exactly 1 whole grade keeps a child a few months from a
 * birthday from flickering the flag. `false` when either side is unknown —
 * an absent anchor is never itself a "disagreement."
 */
export function gradeForAgeDisagreesWithTagged(
  gradeForAge: number | null,
  taggedGrade: string | null | undefined,
): boolean {
  if (gradeForAge === null) return false;

  const normalized = normalizeGradeTag(taggedGrade);
  if (normalized === undefined) return false;

  const taggedRank = normalized === "K" ? 0 : Number(normalized);
  if (!Number.isFinite(taggedRank)) return false;

  return Math.abs(Math.round(gradeForAge) - taggedRank) >= 1;
}
