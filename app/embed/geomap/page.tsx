"use client";

/**
 * The SCOPED web canvas for a single map artifact, rendered as a first-class
 * native surface: the native session map card embeds THIS route in a
 * `react-native-webview` so the real web GeoMap ships to iPad verbatim, with no
 * site nav and no app chrome. Also renders standalone in a plain browser tab
 * that already has a Convex Auth session.
 *
 * Auth mirrors app/embed/manipulative/page.tsx: the native host mints a one-shot
 * embed token for its OWN identity and passes it in the URL FRAGMENT (`#et=...`).
 * We read it client-side only, strip it immediately, and redeem it via
 * `signIn("embedToken", { token })` — minting this page's own session so the
 * owner-only pin mutation authorizes. On failure we show a plain, kid-safe
 * message and do NOT retry-loop.
 *
 */
import { Suspense, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useConvexAuth, useQuery } from "convex/react";
import { useAuthActions } from "@convex-dev/auth/react";
import { Box, Center, Spinner, Text } from "@chakra-ui/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { MapArtifactView } from "@/components/geomap/MapArtifactView";

const getById = api.artifacts.getById;

// Read the one-shot embed token from the URL FRAGMENT (never the query string).
function readEmbedTokenFromHash(hash: string): string | null {
  const match = /(?:^#|[#&])et=([^&]+)/.exec(hash);
  return match ? decodeURIComponent(match[1]) : null;
}

function GeoMapEmbed() {
  const params = useSearchParams();
  const artifactId = params.get("artifactId");
  const { isAuthenticated, isLoading: authLoading } = useConvexAuth();
  const { signIn } = useAuthActions();

  const [handoff, setHandoff] = useState<"idle" | "pending" | "error">(() =>
    typeof window !== "undefined" && readEmbedTokenFromHash(window.location.hash)
      ? "pending"
      : "idle",
  );
  const handoffStarted = useRef(false);

  useEffect(() => {
    if (handoffStarted.current) return;
    const token =
      typeof window !== "undefined"
        ? readEmbedTokenFromHash(window.location.hash)
        : null;
    if (!token) return;
    handoffStarted.current = true;
    const url = new URL(window.location.href);
    url.hash = "";
    window.history.replaceState(null, "", url.toString());
    void signIn("embedToken", { token })
      .then((result) => setHandoff(result.signingIn ? "idle" : "error"))
      .catch(() => setHandoff("error"));
  }, [signIn]);

  const artifact = useQuery(
    getById,
    isAuthenticated && artifactId
      ? { artifactId: artifactId as Id<"artifacts"> }
      : "skip",
  );

  const mapboxToken = process.env.NEXT_PUBLIC_MAPBOX_TOKEN ?? null;

  if (!artifactId) {
    return (
      <Center h="100dvh" p={6}>
        <Text color="fg.muted">Missing ?artifactId=.</Text>
      </Center>
    );
  }
  if (handoff === "error") {
    return (
      <Center h="100dvh" p={6}>
        <Text color="fg.muted" textAlign="center">
          We couldn&apos;t open your map. Head back and tap it again to try once
          more.
        </Text>
      </Center>
    );
  }
  if (handoff === "pending" || authLoading || (isAuthenticated && artifact === undefined)) {
    return (
      <Center h="100dvh">
        <Spinner />
      </Center>
    );
  }
  if (!isAuthenticated) {
    return (
      <Center h="100dvh" p={6}>
        <Text color="fg.muted" textAlign="center">
          Open this map from the Rabbithole app, or sign in to this browser tab
          first.
        </Text>
      </Center>
    );
  }
  if (!artifact || artifact.type !== "map") {
    return (
      <Center h="100dvh" p={6}>
        <Text color="fg.muted" textAlign="center">
          This map couldn&apos;t be found.
        </Text>
      </Center>
    );
  }

  return (
    <Box h="100dvh" w="100dvw" overflow="hidden">
      <MapArtifactView
        artifactId={artifact._id}
        content={artifact.content}
        token={mapboxToken}
        compact
      />
    </Box>
  );
}

export default function GeoMapEmbedPage() {
  return (
    <Suspense
      fallback={
        <Center h="100dvh">
          <Spinner />
        </Center>
      }
    >
      <Box h="100dvh" w="100dvw" overflow="hidden">
        <GeoMapEmbed />
      </Box>
    </Suspense>
  );
}
