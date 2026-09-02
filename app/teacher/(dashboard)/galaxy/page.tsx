"use client";

import { Suspense } from "react";
import dynamic from "next/dynamic";
import { useSearchParams } from "next/navigation";
import { Box, Heading, Text } from "@chakra-ui/react";

// The Concept Atlas — one shared space for every concept the school touches
// (grounded standards + demonstrated mastery + exploration seeds), placed by
// meaning, with three lenses: the Full atlas, a scholar's Sky, and the Class
// Galaxy. Backed by convex/concepts.ts. This is the single unified surface;
// /teacher/atlas (and /atlas) redirect here. Deep-link a lens via ?lens=.
const ConceptAtlasView = dynamic(
  () => import("@/components/ConceptAtlasView").then((m) => m.ConceptAtlasView),
  { ssr: false },
);

const LENSES = ["atlas", "scholar", "galaxy"] as const;
type Lens = (typeof LENSES)[number];

function GalaxyInner() {
  const params = useSearchParams();
  const lensParam = params.get("lens");
  const groupId = params.get("group") ?? undefined;
  const initialMode: Lens = (LENSES as readonly string[]).includes(lensParam ?? "")
    ? (lensParam as Lens)
    : "atlas";
  return (
    <Box h="full" overflowY="auto" bg="gray.50">
      <Box maxW="1180px" mx="auto" p={{ base: 3, md: 6 }}>
        <Heading size="md" fontFamily="heading" color="navy.600" mb={1}>
          🌌 Concept Atlas
        </Heading>
        <Text fontSize="sm" color="charcoal.500" mb={4} maxW="80ch">
          One shared space for every concept the school touches — the grounded{" "}
          <b>tech tree</b> (standards), <b>demonstrated mastery</b>, and exploration{" "}
          <b>seeds</b> — placed by meaning. Toggle the lens: the <b>Full atlas</b>, a
          scholar&apos;s <b>Sky</b>, or the <b>Class Galaxy</b> (every scholar&apos;s
          Sky overlaid — where the cohort converges).
        </Text>
        <ConceptAtlasView initialMode={initialMode} groupId={groupId} height="clamp(420px, calc(100dvh - 260px), 880px)" />
      </Box>
    </Box>
  );
}

export default function GalaxyPage() {
  return (
    <Suspense fallback={<Box h="full" />}>
      <GalaxyInner />
    </Suspense>
  );
}
