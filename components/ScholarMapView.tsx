"use client";

/**
 * ScholarMapView — the scholar's Sky ⟷ Tree map, as a controlled
 * fill-the-container surface.
 *
 * Two lenses:
 *   • Sky  — the kid's own sky (components/sky/YourSky.tsx, TRA-699): their
 *            wonders and shown Quests, from `skyStars.forSelf`. The kid's
 *            own only, so a teacher's remote view has no Sky lens.
 *   • Tree — the practice tech-tree (mastery / automaticity / depth dials).
 *
 * Used by /scholar/map (the full-screen surface the Quests tab's "Your sky"
 * band and the title bar's "Your Map" open).
 */

import { Box } from "@chakra-ui/react";
import type { Id } from "@/convex/_generated/dataModel";
import { MapTreeView } from "@/components/map/MapTreeView";
import { YourSky } from "@/components/sky/YourSky";

export type MapMode = "sky" | "tree";

export function ScholarMapView({
  scholarId,
  mode,
}: {
  scholarId: Id<"users">;
  mode: MapMode;
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
        <YourSky />
      )}
    </Box>
  );
}
