"use client";

/**
 * CheckInHomeCard — the scholar Home's "finish the check-in" accelerator
 * (finish-the-check-in SURFACES, PR2, Surface 1).
 *
 * The always-on path is the daily playlist's own "· mapping" band (PR1) —
 * ≤2 unplaced-domain probes folded into the ordinary daily set, no scholar
 * action required. This card is the OPTIONAL accelerator for a scholar who
 * wants to power through the rest of the map in one sitting: "Math check-in ·
 * N of M domains mapped → Continue check-in", routing to the revived
 * multi-domain orchestrator (`?checkin=all`).
 *
 * An accelerator, not a fixture (rule 5): renders ONLY while
 * `mapProgressForScholar.hasServable` is true and the map isn't complete yet,
 * and disappears PERMANENTLY the moment every eligible domain has converged —
 * `showCheckInHomeCard` (shared/checkInMapCopy.ts) is the single predicate
 * both frontends read, so this can't drift from native's twin
 * (native/src/components/practice/PracticePlaylistCard.tsx).
 *
 * Visual: the same light "receipt strip" Surface idiom as its siblings
 * (DailyRecapCard, PlaylistCard) — this is everyday accelerator copy, not a
 * once-ever milestone (that's MapCompletionCard, the "night" InvitationCard
 * surface).
 */

import type { CSSProperties } from "react";
import NextLink from "next/link";
import { Box, Flex, Link as ChakraLink, Text } from "@chakra-ui/react";
import { ArrowRight, Compass } from "@phosphor-icons/react";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { Surface } from "@/components/ui/Surface";
import {
  CHECK_IN_HOME_TITLE,
  checkInHomeCta,
  checkInHomeSubtitle,
  showCheckInHomeCard,
} from "@/shared/checkInMapCopy";

// ── The survey-plot progress strip ─────────────────────────────────────────
// A decorative row of rounded-square "map plots" beside the "N of M domains
// mapped" subtitle, one per eligible domain — so the fraction is also SEEN, not
// just read. Spec: math-skills-mapping-mark-spike.html §"Scholar home — the
// check-in card" (the amended survey-plot family, VIOLET on every surface; the
// teal CTA below stays teal as brand chrome). Filled = mapped · half-drawn (two
// sides solid) = in progress · dotted = not yet. Purely decorative — the
// subtitle text already carries the meaning — so the strip is aria-hidden.
const MAP_VIOLET = "#7c3aed";

type PlotState = "mapped" | "inflight" | "notyet";

/** Per-eligible-domain plot states derived from the SAME data the subtitle
 *  uses (`mapProgressForScholar` → mapped/eligible/started). Only COUNTS reach
 *  this card, not per-domain status, so a single "in progress" plot is inferred
 *  from `started` (the scholar has answered a probe but not finished the map);
 *  the remainder are "not yet." Mapped plots fill from the left. */
function mapPlotStates(mapped: number, eligible: number, started: boolean): PlotState[] {
  const filled = Math.max(0, Math.min(mapped, eligible));
  const inflight = started && filled < eligible ? 1 : 0;
  const notYet = Math.max(0, eligible - filled - inflight);
  return [
    ...Array<PlotState>(filled).fill("mapped"),
    ...Array<PlotState>(inflight).fill("inflight"),
    ...Array<PlotState>(notYet).fill("notyet"),
  ];
}

function plotStyle(state: PlotState): CSSProperties {
  const base: CSSProperties = {
    width: 10,
    height: 10,
    borderRadius: 3,
    boxSizing: "border-box",
    flex: "0 0 auto",
  };
  if (state === "mapped") {
    return { ...base, border: `2px solid ${MAP_VIOLET}`, background: MAP_VIOLET };
  }
  if (state === "inflight") {
    // Two sides solid, two dotted — a survey underway.
    return {
      ...base,
      border: `2px dotted ${MAP_VIOLET}`,
      borderLeftStyle: "solid",
      borderBottomStyle: "solid",
      background: "transparent",
    };
  }
  return { ...base, border: `2px dotted ${MAP_VIOLET}`, background: "transparent" };
}

function MapProgressStrip({
  mapped,
  eligible,
  started,
}: {
  mapped: number;
  eligible: number;
  started: boolean;
}) {
  const plots = mapPlotStates(mapped, eligible, started);
  if (plots.length === 0) return null;
  return (
    <Flex aria-hidden align="center" gap="3px" flexShrink={0}>
      {plots.map((state, i) => (
        <Box key={i} style={plotStyle(state)} />
      ))}
    </Flex>
  );
}

export function CheckInHomeCard({
  scholarId,
  href,
}: {
  scholarId: Id<"users"> | undefined;
  /** Where "Continue check-in" lands — the page stamps it (remote-mode
   *  aware), mirroring MapHomeCard's `mapHref` convention. */
  href: string;
}) {
  const progress = useQuery(
    api.practiceSkills.mapProgressForScholar,
    scholarId ? { scholarId } : "skip",
  );

  if (!showCheckInHomeCard(progress)) return null;
  // showCheckInHomeCard already narrowed `progress` to a defined, servable,
  // unmapped state — but TS can't see through the helper, so re-assert here.
  if (!progress) return null;

  return (
    <Surface as="section" aria-label={CHECK_IN_HOME_TITLE} p={0} overflow="hidden">
      <Flex align="center" justify="space-between" gap={3} px={4} py={4}>
        <Flex align="center" gap={3} minW={0}>
          <Box color="charcoal.500" flexShrink={0}>
            <Compass size={22} weight="duotone" />
          </Box>
          <Box minW={0}>
            <Text fontFamily="heading" fontWeight="700" color="navy.500" fontSize="md">
              {CHECK_IN_HOME_TITLE}
            </Text>
            <Flex align="center" gap={1.5}>
              <MapProgressStrip
                mapped={progress.mapped}
                eligible={progress.eligible}
                started={progress.started}
              />
              <Text fontSize="sm" color="#65706a">
                {checkInHomeSubtitle(progress.mapped, progress.eligible)}
              </Text>
            </Flex>
          </Box>
        </Flex>
        <ChakraLink
          asChild
          flexShrink={0}
          display="inline-flex"
          alignItems="center"
          gap={1.5}
          px={3.5}
          py={2}
          borderRadius="lg"
          bg="teal.500"
          color="white"
          fontFamily="heading"
          fontWeight="600"
          fontSize="sm"
          _hover={{ bg: "teal.600", textDecoration: "none" }}
        >
          <NextLink href={href}>
            {checkInHomeCta(progress.started)}
            <ArrowRight size={16} weight="bold" />
          </NextLink>
        </ChakraLink>
      </Flex>
    </Surface>
  );
}
