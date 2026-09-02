"use client";

import { useState } from "react";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { Box, HStack, Text } from "@chakra-ui/react";
import { CaretDown, CaretRight } from "@phosphor-icons/react";

// ── Feed reassurance strip ──────────────────────────────────────────────
// A SECONDARY, quiet aside below the Feed's stat-tile header — never the
// hero. Two honest, positive, non-ranked signals (never a composite "level"
// scalar, never a percentile/leaderboard/learner↔learner comparison):
//
//   Coverage  — "on track or ahead on N of M grade-level standards" (breadth,
//               standards-as-tags, vs. the grade's OWN expectations).
//   Momentum  — "practiced N of the last 14 days" / "M skills strengthened
//               this week" (forward progress, not a rank).
//
// Collapsed by default to a single muted line; expands to the two full
// sentences on tap. See review/practice/practice-engine-roadmap.html §6.
//
// TODO(parent portal): the parent surface is a separate surface, out of
// scope for this lane — wire this same query there when that surface lands.
export function CoverageMomentumSummary({ scholarId }: { scholarId: string }) {
  const sid = scholarId as Id<"users">;
  const metrics = useQuery(api.feedMetrics.forScholar, { scholarId: sid });
  const [expanded, setExpanded] = useState(false);

  if (!metrics) return null;

  const { coverage, momentum } = metrics;

  const coverageLine =
    coverage && coverage.total > 0
      ? `On track or ahead on ${coverage.onTrackOrAhead} of ${coverage.total} grade-level standards`
      : null;

  const momentumParts: string[] = [];
  if (momentum.daysActive > 0) {
    momentumParts.push(`practiced ${momentum.daysActive} of the last ${momentum.windowDays} days`);
  }
  if (momentum.skillsStrengthened > 0) {
    momentumParts.push(
      `${momentum.skillsStrengthened} skill${momentum.skillsStrengthened === 1 ? "" : "s"} strengthened this week`,
    );
  }
  const momentumJoined = momentumParts.join(" · ");
  const momentumLine =
    momentumJoined.length > 0 ? momentumJoined[0].toUpperCase() + momentumJoined.slice(1) : null;

  // Nothing honest to say yet (no grade notch set + no practice/tutoring
  // evidence at all) — stay quiet rather than show a hollow "0 of 0".
  if (!coverageLine && !momentumLine) return null;

  const summary = [coverageLine, momentumLine].filter(Boolean).join(" · ");

  return (
    <Box
      as="button"
      onClick={() => setExpanded((v) => !v)}
      aria-expanded={expanded}
      aria-label="Coverage and momentum reassurance"
      w="full"
      textAlign="left"
      bg="white"
      borderWidth="1px"
      borderColor="gray.200"
      borderRadius="lg"
      px={3}
      py={expanded ? "10px" : "6px"}
      _hover={{ borderColor: "violet.100" }}
    >
      {expanded ? (
        <Box>
          <HStack justify="space-between" align="flex-start">
            <Box>
              {coverageLine && (
                <Text fontSize="xs" color="charcoal.400" fontFamily="body" lineHeight="1.4">
                  {coverageLine}.
                </Text>
              )}
              {momentumLine && (
                <Text fontSize="xs" color="charcoal.400" fontFamily="body" lineHeight="1.4" mt={coverageLine ? "2px" : 0}>
                  {momentumLine}.
                </Text>
              )}
            </Box>
            <CaretDown size={11} color="var(--chakra-colors-charcoal-300)" style={{ marginTop: "3px", flexShrink: 0 }} />
          </HStack>
        </Box>
      ) : (
        <HStack justify="space-between" gap={2}>
          <Text fontSize="2xs" color="charcoal.300" fontFamily="heading" lineClamp={1}>
            {summary}
          </Text>
          <CaretRight size={11} color="var(--chakra-colors-charcoal-300)" style={{ flexShrink: 0 }} />
        </HStack>
      )}
    </Box>
  );
}
