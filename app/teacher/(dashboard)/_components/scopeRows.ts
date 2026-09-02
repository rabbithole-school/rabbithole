import type { RosterGroup } from "@/hooks/useScholarRoster";

// Pure derivation of the rail's scope rows from roster data — extracted so the
// "renders from the data, never hardcoded names" contract (Andy's rationale for
// scope rows over a dropdown) can be unit-tested without a DOM. The order is
// fixed: All scholars, then My scholars (only when the roster offers it), then
// every visible group in the order the roster hook returns them.

export type ScopeRow = {
  /** "" = all scholars · "mine" = my scholars · otherwise a scholarGroup id. */
  key: string;
  label: string;
  /** Emoji for a group, "⭐" for my scholars, null for the icon-rendered All row. */
  emoji: string | null;
  /** Count shown on the row, or null when a count isn't meaningful (My scholars). */
  count: number | null;
};

export function buildScopeRows(
  groups: RosterGroup[],
  hasMine: boolean,
  allScholarsCount: number,
): ScopeRow[] {
  const rows: ScopeRow[] = [
    { key: "", label: "All scholars", emoji: null, count: allScholarsCount },
  ];
  if (hasMine) {
    rows.push({ key: "mine", label: "My scholars", emoji: "⭐", count: null });
  }
  for (const g of groups) {
    rows.push({
      key: g.id,
      label: g.name,
      emoji: g.emoji,
      count: g.scholarIds.length,
    });
  }
  return rows;
}
