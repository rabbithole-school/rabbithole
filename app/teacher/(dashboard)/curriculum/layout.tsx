"use client";

import { Box, Flex } from "@chakra-ui/react";
import { CurriculumColumnView } from "@/components/CurriculumColumnView";

/**
 * The Curriculum surface lives in this LAYOUT (not the page) so it persists
 * across `/teacher/curriculum/*` navigations — the column-view slide and
 * unit→unit switching stay mounted instead of flashing. The catch-all page
 * underneath is just a stub so the paths resolve. See
 * review/curriculum-rehearse-and-maturity.md.
 *
 * The top nav + staff gate now live in the shared dashboard layout
 * (`app/teacher/(dashboard)/layout.tsx`), so this layout only renders the
 * curriculum surface itself.
 */
export default function CurriculumLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <Flex direction="column" h="full" overflow="hidden" position="relative">
      <CurriculumColumnView />
      {/* The catch-all page's route-transition loading fallback (loading.tsx)
          OVERLAYS the surface instead of stacking below it. Without this, a
          client-side nav INTO a unit (e.g. from the Quests tab) renders the
          column-view AND loading.tsx's skeleton at the same time — two
          offset skeletons. The stub page is null in steady state, and
          pointerEvents:none lets clicks pass through to the surface. */}
      <Box position="absolute" inset={0} pointerEvents="none">
        {children}
      </Box>
    </Flex>
  );
}
