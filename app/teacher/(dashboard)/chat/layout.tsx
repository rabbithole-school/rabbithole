"use client";

import dynamic from "next/dynamic";
import { Box, Flex } from "@chakra-ui/react";

// Chat tab (routes: /teacher/chat and /teacher/chat/<chatId>) — the AI
// curriculum-design assistant. The assistant lives in this LAYOUT (not the
// page) so it persists across chat navigations: switching threads only
// changes the URL's chat segment, never remounting the assistant (which
// owns the StreamRegistry — a remount would drop in-flight streams). The
// catch-all page underneath is a stub. ssr:false matches the old dashboard's
// dynamic import (the assistant is browser-only).
const CurriculumAssistant = dynamic(() => import("@/components/CurriculumAssistant"), {
  ssr: false,
});

export default function ChatLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <Flex h="full" w="full" overflow="hidden" position="relative">
      <CurriculumAssistant />
      {/* Route-transition loading fallback overlays the surface instead of
          stacking below it (no double-skeleton on a client nav into chat);
          pointerEvents:none passes clicks through to the assistant. */}
      <Box position="absolute" inset={0} pointerEvents="none">
        {children}
      </Box>
    </Flex>
  );
}
