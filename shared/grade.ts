// The ONE seam that normalizes a grade tag's STRING SHAPE before any placement /
// scheduler grade math parses it. Both grade primitives — `gradeRank`
// (convex/lib/practice/placement.ts) and `gradeOrdinal`
// (convex/lib/practice/scheduler.ts) — run their input through this first, so a
// legacy / seed long-form value like "Grade 2" is treated identically to the
// canonical notch "2". This module imports nothing so it resolves standalone.

/**
 * Normalize a grade tag to the canonical notch shape the practice grade math
 * speaks: `"K"` or `"1"`..`"9"`. Tolerates the legacy / seed long form
 * (`"Grade 2"`, `"grade k"`, `"G3"`, stray whitespace, casing) that older
 * writes and fixtures persisted on `users.gradeLevel` (and on some
 * `knowledgeNodes.grade` tags) — so a placement prior can never again be skewed
 * by string SHAPE alone. Anything unrecognized passes through trimmed, so the
 * primitives still treat it as "no signal" (rank −1 / undefined ordinal).
 *
 * READ-side defense only: the canonical setter (`isValidGradeLevel`) still stores
 * the bare notch. This just lets the grade math survive data that predates or
 * bypassed that setter (e.g. the "Grade 2" persona persisted in the field logs).
 */
export function normalizeGradeTag(
  grade: string | undefined | null,
): string | undefined {
  if (grade === undefined || grade === null) return undefined;
  const trimmed = grade.trim();
  if (trimmed === "") return undefined;
  // Optional "Grade "/"G" prefix, then a K or a 1–2 digit number. The `$` anchor
  // keeps a non-grade label like "Kindergarten" or "2nd" from matching.
  const m = /^(?:grade\s*|g\s*)?(K|[0-9]{1,2})$/i.exec(trimmed);
  if (!m) return trimmed;
  return m[1].toUpperCase();
}
