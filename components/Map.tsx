"use client";

/**
 * Map — the ONE unified knowledge Map (roadmap §6).
 *
 * A single component, two sibling MODES toggled in-page (never a route change,
 * so a real toggle control is correct here), and ONE redaction prop (`audience`)
 * that is the ONLY difference between the scholar / teacher / parent surfaces:
 *
 *   • tree view — the tech-tree skin ("climb the tree"): X = DAG depth, the
 *     frontier glows, arrowed prerequisites. Renders <MapTreeView/>.
 *   • sky view  — the omnidirectional Concept Atlas ("explore the sky"):
 *     associative threads on the dark night-sky. Delegates to the proven
 *     <ConceptAtlasView/> (locked to this scholar) so the Sky keeps working
 *     verbatim; both skins already share ONE camera core (lib/mapCamera.ts).
 *
 * Same graph, same component — flipping `audience` swaps the overlay, not the IA.
 */

import { useState } from "react";
import type { Id } from "@/convex/_generated/dataModel";
import { Box, Button, Flex, HStack, Text } from "@chakra-ui/react";
import { MapTreeView, type MapAudience } from "@/components/map/MapTreeView";
import { ConceptAtlasView } from "@/components/ConceptAtlasView";

export type MapMode = "tree" | "sky";
export type { MapAudience };

export type MapProps = {
  scholarId: Id<"users">;
  /** The ONE redaction knob — scholar | teacher | parent. */
  audience: MapAudience;
  /** Controlled mode; omit to let the in-page toggle own it. */
  mode?: MapMode;
  initialMode?: MapMode;
  onModeChange?: (mode: MapMode) => void;
  height?: number;
  /** Practice domain override (tree view). */
  domain?: string;
  /** Hide the tree⟷sky toggle (e.g. when embedded somewhere that pins a mode). */
  showToggle?: boolean;
  /** Full-bleed: fill the parent (h="100%", no card border/radius) instead of a fixed px card. */
  fill?: boolean;
  /**
   * Multiply the tree's label TEXT font size (screen-space overlay labels are a
   * FIXED on-screen size, so they don't scale with camera zoom). Default 1 keeps
   * the web tree unchanged; the native iPad embed passes >1 for legibility.
   */
  labelScale?: number;
  /** Scholar-only: launch a session from a tapped seed star (Sky view). */
  onExploreSeed?: (seedId: Id<"seeds">) => void;
  /** Scholar-only: the seed currently launching (drives the sheet's loading state). */
  exploringSeedId?: string | null;
};

export function Map({
  scholarId,
  audience,
  mode,
  initialMode = "tree",
  onModeChange,
  height = 560,
  domain,
  showToggle = true,
  fill = false,
  labelScale = 1,
  onExploreSeed,
  exploringSeedId,
}: MapProps) {
  const [internal, setInternal] = useState<MapMode>(initialMode);
  const active: MapMode = mode ?? internal;

  const setMode = (m: MapMode) => {
    if (mode === undefined) setInternal(m);
    onModeChange?.(m);
  };

  const isParent = audience === "parent";

  return (
    <Box h={fill ? "100%" : undefined} display={fill ? "flex" : undefined} flexDirection={fill ? "column" : undefined}>
      {showToggle && (
        <Flex mb={3} flexShrink={fill ? 0 : undefined} align="center" gap={3} wrap="wrap">
          <HStack gap={1} bg="gray.100" borderRadius="lg" p={1}>
            {(["tree", "sky"] as MapMode[]).map((m) => (
              <Button key={m} size="sm" minH="44px"
                variant={active === m ? "solid" : "ghost"} colorPalette="violet"
                aria-pressed={active === m} onClick={() => setMode(m)}>
                {m === "tree" ? "Math skills tree" : "Sky view"}
              </Button>
            ))}
          </HStack>
          <Text fontSize="xs" color="charcoal.400">
            {active === "tree" ? "Climb the tree — prerequisites building toward mastery."
              : "Explore the sky — every idea connected to every other."}
          </Text>
        </Flex>
      )}

      <Box flex={fill ? 1 : undefined} minH={fill ? 0 : undefined}>
        {active === "tree" ? (
          <MapTreeView scholarId={scholarId} audience={audience} domain={domain} height={height} fill={fill} labelScale={labelScale} />
        ) : isParent ? (
          // Sky for a parent needs a guardian-gated read (atlasForScholar is
          // teacher-or-self); until then, the TIER_1 placeholder.
          <Flex h={fill ? "100%" : `${height}px`} align="center" justify="center" px={8}
            borderRadius={fill ? undefined : "xl"} borderWidth={fill ? undefined : "1px"} borderColor={fill ? undefined : "#2a2350"}
            css={{ background: "radial-gradient(130% 130% at 50% 38%,#1d1444,#0a0718 76%)" }}>
            <Text fontSize="sm" color="#cdbef2" textAlign="center" maxW="34ch">
              Your child&apos;s sky of connected ideas is coming soon.
            </Text>
          </Flex>
        ) : (
          <ConceptAtlasView
            lockedScholarId={scholarId}
            canCurate={audience === "teacher"}
            height={`${height}px`}
            fill={fill}
            onExploreSeed={audience === "scholar" ? onExploreSeed : undefined}
            exploringSeedId={audience === "scholar" ? exploringSeedId : undefined}
            selfChartable={audience === "scholar"}
          />
        )}
      </Box>
    </Box>
  );
}
