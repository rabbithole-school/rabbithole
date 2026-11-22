import { openUntilClosedLabel, openUntilPhrase } from "@/shared/openUntil";

/**
 * An "open until" give whose window has closed reads as closed on the grid
 * ("Closed Sat", the Run page's word), not "Live". The grid query can't read
 * the clock (T11), so it returns each window's boundary (a placement's
 * `openUntil`) and the page compares it with its minute clock here, the way
 * the Run page does (`openUntilClosedLine`: closed once `closesAt <= now`).
 * Open-until work has no Homework due card (TRA-724).
 *
 * A closed placement also stops counting as live (`linkState: "none"`), so its
 * border, its cell, and the drawer's "live work keeps running" copy follow.
 * Still-open windows get the same clock for their "Open until Thu" line:
 * the server sends the bare weekday, and from seven days out the date is
 * added here ("Open until Tue, Nov 24"; openUntilPhrase).
 *
 * Returns the same object when nothing has closed, so memos downstream hold.
 */
type WindowPlacement = {
  linkState: string;
  openUntil: number | null;
  openUntilLabel?: string | null;
};
export function withClosedWindows<
  P extends WindowPlacement,
  G extends { placements: P[]; weekPlacements: P[] },
>(grid: G, nowMs: number, timeZone: string): G {
  const closePlacement = (p: P): P => {
    if (p.openUntil != null && p.openUntil > nowMs) {
      const label = openUntilPhrase(p.openUntil, timeZone, nowMs);
      return p.openUntilLabel != null && p.openUntilLabel !== label
        ? { ...p, openUntilLabel: label }
        : p;
    }
    if (p.linkState !== "live" || p.openUntil == null) return p;
    return {
      ...p,
      linkState: "none",
      closedLabel: openUntilClosedLabel(p.openUntil, timeZone),
    };
  };
  const placements = grid.placements.map(closePlacement);
  const weekPlacements = grid.weekPlacements.map(closePlacement);
  const changed =
    placements.some((p, i) => p !== grid.placements[i]) ||
    weekPlacements.some((p, i) => p !== grid.weekPlacements[i]);
  return changed ? { ...grid, placements, weekPlacements } : grid;
}
