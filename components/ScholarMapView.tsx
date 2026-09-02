"use client";

/**
 * ScholarMapView — the scholar's single Sky ⟷ Tree star map, as a controlled
 * fill-the-container surface.
 *
 * One mode, two lenses on the same scholar:
 *   • Sky  — the Concept Atlas scholar lens (demonstrated mastery + standards
 *            reached + pulled-next seeds), tap a seed star to begin a quest.
 *   • Tree — the practice tech-tree (mastery / automaticity / depth dials).
 *
 * Used by /scholar/map (the full-screen surface launched from the title bar).
 * Previously lived inline on /scholar home (ScholarPlate's StarMapSection),
 * which hijacked page scroll — now promoted to its own screen.
 */

import { Box } from "@chakra-ui/react";
import type { Id } from "@/convex/_generated/dataModel";
import type { ExploreSeedOptions } from "@/lib/bakePaths";
import { ConceptAtlasView } from "@/components/ConceptAtlasView";
import { MapTreeView } from "@/components/map/MapTreeView";

export type MapMode = "sky" | "tree";

export function ScholarMapView({
  scholarId,
  onExploreSeed,
  exploringSeedId,
  mode,
  selfChartable = false,
}: {
  scholarId: Id<"users">;
  onExploreSeed?: (id: Id<"seeds">, opts?: ExploreSeedOptions) => void;
  exploringSeedId?: string | null;
  mode: MapMode;
  /** Scholar viewing their OWN map (not a teacher remote-view) — enables the
   *  cold-start "Chart my sky" invite on a blank Sky lens. */
  selfChartable?: boolean;
}) {
  return (
    <Box flex={1} h="100%" minH={0} overflow="hidden">
      {mode === "tree" ? (
        <MapTreeView
          scholarId={scholarId}
          audience="scholar"
          height="100%"
          fill
          fitToViewport
        />
      ) : (
        <ConceptAtlasView
          lockedScholarId={scholarId}
          canCurate={false}
          fill
          onExploreSeed={onExploreSeed}
          exploringSeedId={exploringSeedId}
          selfChartable={selfChartable}
        />
      )}
    </Box>
  );
}
