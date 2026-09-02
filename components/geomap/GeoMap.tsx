"use client";

/**
 * GeoMap — the ONE web renderer for a `GeoMapSpec` (the shared contract in
 * lib/geomap/types). Both the scholar's ArtifactPanel and the native webview's
 * /embed/geomap route mount this.
 *
 * Token-gated by design: with no `token` it renders a friendly, dependency-free
 * offline state and NEVER loads mapbox-gl. Only when a token is present does it
 * lazy-load {@link ./MapCanvas} (ssr:false), so SSR and the tokenless path cost
 * nothing.
 *
 * `NEXT_PUBLIC_MAPBOX_TOKEN` IS provisioned in Vercel — Production, Preview and
 * Development, on both `rabbithole` and `rhtest` — so every deployed environment
 * takes the MapCanvas branch. Local dev is the only tokenless one, and only
 * because nothing populates the var in a checkout's `.env.local`. Treat the
 * offline state as the local-dev/offline path, NOT as production reality: a
 * stale "no key is provisioned yet" note here previously sent a debugging
 * session down the wrong branch entirely (2026-08-06).
 */
import dynamic from "next/dynamic";
import { Box, Center, Text, VStack } from "@chakra-ui/react";
import type { GeoMapRendererProps } from "@/lib/geomap/types";

const MapCanvas = dynamic(() => import("./MapCanvas"), {
  ssr: false,
  loading: () => <Box h="100%" w="100%" bg="gray.100" />,
});

function NoTokenState({ compact }: { compact?: boolean }) {
  return (
    <Center h="100%" w="100%" bg="white" p={compact ? 4 : 6}>
      <VStack gap={2} textAlign="center" maxW="320px">
        <Text fontSize={compact ? "32px" : "44px"} lineHeight="1">
          🗺️
        </Text>
        <Text fontFamily="heading" fontWeight="700" fontSize="md" color="charcoal.500">
          Maps need the internet and a map key
        </Text>
        <Text fontFamily="body" fontSize="sm" color="charcoal.400">
          Ask your teacher to turn maps on!
        </Text>
      </VStack>
    </Center>
  );
}

export default function GeoMap(props: GeoMapRendererProps) {
  if (!props.token) return <NoTokenState compact={props.compact} />;
  return <MapCanvas {...props} token={props.token} />;
}
