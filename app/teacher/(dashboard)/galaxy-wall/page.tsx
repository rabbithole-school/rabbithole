"use client";

import dynamic from "next/dynamic";
import { Box } from "@chakra-ui/react";

// The entryway "wall" version of the Class Galaxy — a no-touch, high-density
// ambient display meant to be perused on the big monitor by the door (the
// galaxy companion to the Trophy Case). Renders the shared Concept Atlas in
// Galaxy mode (concepts.classGalaxy), curation disabled.
const ConceptAtlasView = dynamic(
  () => import("@/components/ConceptAtlasView").then((m) => m.ConceptAtlasView),
  { ssr: false },
);

export default function GalaxyWallPage() {
  return (
    <Box h="100dvh" overflow="hidden" bg="#05040c" p={4}>
      <ConceptAtlasView lockMode="galaxy" canCurate={false} height="calc(100dvh - 32px)" />
    </Box>
  );
}
