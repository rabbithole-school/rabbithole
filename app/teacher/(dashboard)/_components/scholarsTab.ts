// Pure derivation of the Scholars-tab page tab from the URL state the layout
// already encodes (`rounds`/`rkind`, plus `view=tonight` for Homework) — and
// the params a tab writes back. Extracted so the "legacy links keep resolving"
// contract is unit-testable without the DOM. This is the mapping table in code.
//
//   no rounds, no view      → Snapshot
//   view=tonight            → Homework   (the legacy prep-window / TeacherToday link)
//   rounds=1 (academic)     → Academic Rounds
//   rounds=1&rkind=sel      → SEL Rounds
//
// `rounds` takes precedence over `view` so the derivation is total (a rounds
// link is never also a homework link in practice).

import type { ScholarsTab } from "./ScholarsTabBar";

export function tabFromUrlState(
  roundsMode: boolean,
  cadence: "academic" | "sel",
  viewParam: string | null,
): ScholarsTab {
  if (roundsMode) return cadence === "sel" ? "sel-rounds" : "academic-rounds";
  if (viewParam === "tonight") return "homework";
  return "snapshot";
}

/** A tab → the params it writes. Snapshot clears everything; Homework sets
 *  `view=tonight`; the Rounds tabs set rounds + cadence and drop the pinned
 *  week (each cadence owns its own current week). */
export function urlStateForTab(tab: ScholarsTab): {
  rounds: boolean;
  rkind?: "academic" | "sel";
  rweek: null;
  view: "tonight" | null;
} {
  switch (tab) {
    case "homework":
      return { rounds: false, rweek: null, view: "tonight" };
    case "academic-rounds":
      return { rounds: true, rkind: "academic", rweek: null, view: null };
    case "sel-rounds":
      return { rounds: true, rkind: "sel", rweek: null, view: null };
    case "snapshot":
    default:
      return { rounds: false, rweek: null, view: null };
  }
}
