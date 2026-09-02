/**
 * Grade-range formatting for the Math Skills surfaces.
 *
 * Grade tokens in this repo are strings: "K" (kindergarten) then "1".."12"
 * (`knowledgeNodes.grade`, `masteryDial` grade hints, seed graphs). These
 * helpers map a token to a sortable rank and render a compact min–max label
 * ("Grade K–6", "Grade 4–5", or just "Grade 4" when a single grade covers the
 * set). Shared so the domain rail (via a Convex query) and the strand headers
 * (client-side, from the visible skill nodes) produce identical wording.
 */

/** Map a grade token to a sortable rank: "K" → 0, "1".."12" → 1..12, else null. */
export function gradeRank(grade: string | null | undefined): number | null {
  if (grade == null) return null;
  const token = grade.trim();
  if (token === "") return null;
  if (token.toUpperCase() === "K") return 0;
  const n = Number(token);
  return Number.isFinite(n) ? n : null;
}

/** Render a single rank back to its display token: 0 (or below) → "K". */
export function gradeLabelFromRank(rank: number): string {
  return rank <= 0 ? "K" : String(rank);
}

/**
 * Format a min/max rank pair as "Grade K–6" / "Grade 4" (collapsed when equal),
 * or null when either bound is unknown.
 */
export function formatGradeRange(
  minRank: number | null | undefined,
  maxRank: number | null | undefined,
): string | null {
  if (minRank == null || maxRank == null) return null;
  const lo = Math.min(minRank, maxRank);
  const hi = Math.max(minRank, maxRank);
  return lo === hi
    ? `Grade ${gradeLabelFromRank(lo)}`
    : `Grade ${gradeLabelFromRank(lo)}\u2013${gradeLabelFromRank(hi)}`;
}

/**
 * Format the grade span of a collection of grade tokens — "Grade K–6", "Grade
 * 4", or null when none of them carry a known grade.
 */
export function gradeRangeLabel(
  grades: Iterable<string | null | undefined>,
): string | null {
  let min: number | null = null;
  let max: number | null = null;
  for (const grade of grades) {
    const rank = gradeRank(grade);
    if (rank === null) continue;
    if (min === null || rank < min) min = rank;
    if (max === null || rank > max) max = rank;
  }
  return formatGradeRange(min, max);
}
