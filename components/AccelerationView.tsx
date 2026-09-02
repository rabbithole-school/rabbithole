"use client";

/**
 * AccelerationView — the grounded **Knowledge Tree** lens (the "Knowledge Tree"
 * subtab on a scholar's Progress nav). Replaces the old fixed-fractions tree
 * stub AND the CCSS "Standards" checklist with one surface: a per-strand
 * grade-band mastery portrait colored so reach ABOVE the scholar's
 * chronological grade is the headline (a gifted school raises the ceiling),
 * with a notch at their actual
 * grade and any genuinely below-age area flagged as a concept to shore up —
 * never a deficit score, never a learner↔learner comparison.
 *
 * Click a cell to zoom into the band's fine sub-topic graph (CellDetailView);
 * from a node, pivot into the open-map "Sky" lens (ConceptStarMap). Reads
 * acceleration.forScholar. Design: review/knowledge-tree-expansion.html.
 */

import { Box, Flex, Grid, Spinner, Stack, Text } from "@chakra-ui/react";
import { Check, Checks, type Icon as PhosphorIcon } from "@phosphor-icons/react";
import { useState } from "react";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { CellDetailView } from "@/components/CellDetailView";
import { Automaticity } from "@/components/Automaticity";

type Stop = "notyet" | "approaching" | "met" | "beyond";

// Option C — the four-stop "Beyond" scale: a cell's colour says where the
// scholar lands relative to each standard's OWN expected rigor, not an invented
// %. gray → yellow → green → blue; the goal is to turn the squares blue.
const STOP: Record<Stop, { bg: string; border: string; color: string }> = {
  notyet: { bg: "#f1f3f6", border: "#dfe4ea", color: "#9aa3af" },
  approaching: { bg: "#fbf4dd", border: "#e3c07a", color: "#8a6d1c" },
  met: { bg: "#d8efe1", border: "#7cc49b", color: "#1f7a52" },
  beyond: { bg: "#dff1f0", border: "#5fb6b0", color: "#16707e" },
};

const LEGEND: Array<{ stop: Stop; label: string; Icon: PhosphorIcon | null }> = [
  { stop: "notyet", label: "Not yet", Icon: null },
  { stop: "approaching", label: "Approaching", Icon: null },
  { stop: "met", label: "Met the standard", Icon: Check },
  { stop: "beyond", label: "Beyond", Icon: Checks },
];

export function AccelerationView({
  scholarId,
  onPivotToSky,
}: {
  scholarId: string;
  /** Pivot a node's concept into the Sky (open-map) tab, anchored on it. */
  onPivotToSky?: (concept: string, grounding?: string) => void;
}) {
  const [zoom, setZoom] = useState<{
    strandKey: string;
    strandLabel: string;
    grade: string;
  } | null>(null);
  const data = useQuery(api.acceleration.forScholar, {
    scholarId: scholarId as Id<"users">,
  });

  if (data === undefined) {
    return (
      <Flex h="240px" align="center" justify="center">
        <Spinner color="green.400" />
      </Flex>
    );
  }

  const { chronologicalGrade, grades, subjects } = data;

  if (subjects.length === 0) {
    return (
      <Box bg="gray.50" borderRadius="lg" p={6} textAlign="center">
        <Text fontSize="sm" color="charcoal.400">
          No grade-banded standards are loaded yet. Once the standards catalog is
          imported, every strand will appear here and fill in as the scholar
          demonstrates understanding tied to those standards.
        </Text>
      </Box>
    );
  }

  // grid: label column + one column per grade
  const templateColumns = `150px repeat(${grades.length}, 1fr)`;

  return (
    <Stack gap={4} data-testid="acceleration-view">
      <Box overflowX="auto">
        <Box minW="560px">
          {/* grade header */}
          <Grid templateColumns={templateColumns} gap={1.5} mb={1.5} alignItems="end">
            <Text fontSize="xs" fontWeight="700" color="charcoal.400" letterSpacing="0.04em">
              GRADE →
            </Text>
            {grades.map((g) => {
              const isNotch = g === chronologicalGrade;
              return (
                <Box key={g} textAlign="center">
                  {isNotch && (
                    <Box
                      data-testid="accel-notch"
                      bg="#eceef2"
                      color="#5a6472"
                      fontSize="9px"
                      fontWeight="700"
                      borderRadius="full"
                      px={1.5}
                      py={0.5}
                      mb={1}
                      whiteSpace="nowrap"
                    >
                      age · gr {g}
                    </Box>
                  )}
                  <Text fontSize="xs" fontWeight="700" color="charcoal.500">
                    {g}
                  </Text>
                </Box>
              );
            })}
          </Grid>

          {/* subject rows */}
          <Stack gap={1.5}>
            {subjects.map((subject) => (
              <Grid
                key={subject.key}
                templateColumns={templateColumns}
                gap={1.5}
                alignItems="center"
              >
                <Flex align="center" gap={1.5} minW={0} pr={2}>
                  <Text
                    flex={1}
                    minW={0}
                    fontSize="sm"
                    fontWeight="700"
                    color="charcoal.600"
                    lineClamp={2}
                    lineHeight="1.15"
                    title={subject.label}
                  >
                    {subject.label}
                  </Text>
                  {subject.reachAhead >= 1 && (
                    <Text fontSize="xs" fontWeight="800" color="#1f7a52" whiteSpace="nowrap" flexShrink={0}>
                      ▶ +{subject.reachAhead}
                    </Text>
                  )}
                </Flex>
                {subject.cells.map((cell) => {
                  const s = STOP[cell.stop as Stop];
                  const clickable = cell.status !== "none";
                  const open = () =>
                    setZoom({ strandKey: subject.key, strandLabel: subject.label, grade: cell.grade });
                  return (
                    <Box
                      key={cell.grade}
                      data-testid={`accel-cell-${subject.key}-${cell.grade}`}
                      data-status={cell.status}
                      data-stop={cell.stop}
                      role={clickable ? "button" : undefined}
                      tabIndex={clickable ? 0 : undefined}
                      onClick={clickable ? open : undefined}
                      onKeyDown={
                        clickable
                          ? (e) => {
                              if (e.key === "Enter" || e.key === " ") {
                                e.preventDefault();
                                open();
                              }
                            }
                          : undefined
                      }
                      bg={s.bg}
                      borderWidth="1.5px"
                      borderStyle="solid"
                      borderColor={s.border}
                      borderRadius="md"
                      h="34px"
                      position="relative"
                      display="flex"
                      alignItems="center"
                      justifyContent="center"
                      cursor={clickable ? "pointer" : "default"}
                      transition="transform 0.08s, box-shadow 0.08s"
                      _hover={
                        clickable
                          ? { transform: "translateY(-1px)", boxShadow: "sm" }
                          : undefined
                      }
                      title={
                        cell.pct === null
                          ? `Grade ${cell.grade}: not yet reached`
                          : `Grade ${cell.grade}: ${cell.pct}% of the grade's standards met or beyond — ${cell.count} demonstrated so far${clickable ? " · click to zoom in" : ""}`
                      }
                    >
                      <Text fontSize="xs" fontWeight="700" color={s.color}>
                        {cell.pct === null ? "—" : cell.pct}
                      </Text>
                      {cell.fluencyLevel ? (
                        <Box position="absolute" bottom="1px" right="2px">
                          <Automaticity
                            level={cell.fluencyLevel}
                            source={cell.fluencySource}
                            size={8}
                          />
                        </Box>
                      ) : null}
                    </Box>
                  );
                })}
              </Grid>
            ))}
          </Stack>
        </Box>
      </Box>

      {/* number → standard zoom, in a Drawer (kept mounted for open/close
          animation). From a node, "View in star map" pivots up to the Sky tab. */}
      <CellDetailView
        scholarId={scholarId}
        cell={zoom}
        onClose={() => setZoom(null)}
        onPivotToSky={(concept, grounding) => {
          setZoom(null);
          onPivotToSky?.(concept, grounding);
        }}
      />

      {/* legend */}
      <Flex gap={4} wrap="wrap" fontSize="11px" color="charcoal.400" align="center">
        {LEGEND.map((l) => (
          <Flex key={l.stop} align="center" gap={1.5}>
            <Flex w="15px" h="15px" borderRadius="4px" align="center" justify="center" bg={STOP[l.stop].bg} borderWidth="1px" borderColor={STOP[l.stop].border}>
              {l.Icon ? <l.Icon size={9} weight="bold" color={STOP[l.stop].color} /> : null}
            </Flex>
            {l.label}
          </Flex>
        ))}
        <Flex align="center" gap={1.5}>
          <Automaticity level={3} source="teacher" size={11} />
          Automaticity (effortless recall)
        </Flex>
      </Flex>

      <Text fontSize="xs" color="charcoal.400">
        The number is the share of that grade&apos;s standards the scholar has
        <b> met or gone beyond</b> — progress toward 100% of the grade (the same
        figure the drill-down ring shows). The <b>colour</b> says how the work
        they&apos;ve reached so far lands against each standard&apos;s own bar:
        approaching, met, or <b>beyond</b> its expected rigor. Reach above the
        notch and squares turned blue are the headline; a yellow area before the
        notch is a concept to build next, owned by the scholar — never a ranking
        against other scholars. Click any colored cell to zoom into its fine
        sub-topic graph.
      </Text>
    </Stack>
  );
}
