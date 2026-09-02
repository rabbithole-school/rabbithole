"use client";

import { SquaresFour, House, GraduationCap, Heart } from "@phosphor-icons/react";
import { ViewToggle } from "@/components/ui/ViewToggle";

// The Scholars-tab page tab bar: four top-level views of this surface, rendered
// with the SHARED <ViewToggle> — the exact pill-group grammar the Math skills
// lens switcher uses (white active pill, ~14px leading phosphor icon).
//
//   Snapshot        — the group-scoped card grid + digest/prep (the landing).
//   Homework        — one row per scholar: their tonight/homework list.
//   Academic Rounds — the weekly Rounds board at the academic cadence.
//   SEL Rounds      — the weekly Rounds board at the SEL cadence.
//
// Cadence is owned by these page tabs, so the board's own Academic/SEL cadence
// toggle is gone on this surface. Labels are Andy's locked nomenclature.
//
// The active tab is DERIVED from the URL state the layout already encodes
// (`rounds`/`rkind`, plus `view=tonight` for Homework), so every legacy link
// keeps resolving (see scholarsTab.ts).

export type ScholarsTab = "snapshot" | "homework" | "academic-rounds" | "sel-rounds";

export function ScholarsTabBar({
  active,
  onChange,
}: {
  active: ScholarsTab;
  onChange: (tab: ScholarsTab) => void;
}) {
  return (
    <ViewToggle<ScholarsTab>
      items={[
        { value: "snapshot", label: "Snapshot", icon: <SquaresFour size={14} /> },
        { value: "homework", label: "Homework", icon: <House size={14} /> },
        { value: "academic-rounds", label: "Academic Rounds", icon: <GraduationCap size={14} /> },
        { value: "sel-rounds", label: "SEL Rounds", icon: <Heart size={14} /> },
      ]}
      value={active}
      onChange={onChange}
      ariaLabel="Scholars view"
      testId="scholars-tab-bar"
    />
  );
}
