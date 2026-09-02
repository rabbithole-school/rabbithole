"use client";

import dynamic from "next/dynamic";
import { useSearchParams } from "next/navigation";
import { Box } from "@chakra-ui/react";

// The classroom "entrance screen" — earned mission badges + "Ask Oliver
// about…" spark prompts (Quests Q4). Kiosk-style; meant for the big display.
// Optionally scoped to a scholar group via ?group=<id>.
const TrophyCase = dynamic(
  () => import("@/components/TrophyCase").then((m) => m.TrophyCase),
  { ssr: false },
);

export default function TrophyCasePage() {
  const groupId = useSearchParams().get("group") ?? undefined;
  return (
    <Box h="full" overflow="auto">
      <TrophyCase groupId={groupId} />
    </Box>
  );
}
