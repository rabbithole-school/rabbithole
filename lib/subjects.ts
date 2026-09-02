/**
 * Subject helpers shared across the Subject filter chips (teacher
 * Curriculum list + scholar unit picker). Mirrors the case-folding /
 * dedup logic in `convex/units.ts:subjects` so a list derived
 * client-side from already-loaded units matches the server query.
 */

/**
 * Distinct, non-empty subjects from a units array, deduped
 * case-insensitively (first-seen casing wins) and sorted alphabetically.
 */
export function uniqueSubjects(
  units: { subject?: string | null }[],
): string[] {
  const byFolded = new Map<string, string>();
  for (const u of units) {
    const s = u.subject?.trim();
    if (!s) continue;
    const folded = s.toLowerCase();
    if (!byFolded.has(folded)) byFolded.set(folded, s);
  }
  return [...byFolded.values()].sort((a, b) => a.localeCompare(b));
}

/** Case-insensitive subject match — used when filtering a unit list. */
export function subjectMatches(
  unitSubject: string | null | undefined,
  selected: string,
): boolean {
  return (unitSubject?.trim().toLowerCase() ?? "") === selected.toLowerCase();
}
