/**
 * Presentation-only scope filter for the Rounds week board.
 *
 * The left rail's selected scholar-group scope FILTERS which rows the board
 * shows — it is NOT a new access surface. The teacher already legitimately
 * receives the institution-scoped `api.rounds.week` read; scoping here narrows
 * the DISPLAYED rows against a roster the layout has already resolved (and which
 * already strips non-roster / participation-filtered members). It never changes
 * which scholars the server returns, and — critically — it never touches the
 * MEETING, which is whole-institution state (Open/Close/Reopen, the week
 * stepper, "Open since…") regardless of the rail scope.
 */

/** Filter the board's per-scholar rows to the selected scope's roster.
 *  `visibleScholarIds === null | undefined` means "All scholars" — the full
 *  board, unchanged. A set narrows the rows to exactly that scope's members. */
export function filterScholarsByScope<T extends { scholarId: string }>(
  scholars: readonly T[],
  visibleScholarIds: ReadonlySet<string> | null | undefined,
): T[] {
  if (!visibleScholarIds) return [...scholars];
  return scholars.filter((s) => visibleScholarIds.has(String(s.scholarId)));
}

/** The one muted line the board shows under a group scope so a shorter board
 *  never silently implies the whole institution. Sentence case. Returns null
 *  when nothing is hidden (All scholars, or a scope that happens to be the whole
 *  roster) — no line at all in that case, exactly as before scoping existed. */
export function scopeCountLabel(
  shown: number,
  total: number,
  scoped: boolean,
): string | null {
  if (!scoped || shown === total) return null;
  return `Showing ${shown} of ${total} scholars`;
}
