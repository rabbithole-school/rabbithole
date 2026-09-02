"use client";

/**
 * GranuleCoverageGrid — scholars × the unit's EQs/EUs on the
 * assignment Run page ("Understanding" tab).
 *
 * Status is derived, observer-reported coverage (see granuleEvidence
 * in schema.ts): green = demonstrated, yellow = probed but not yet
 * demonstrated, gray = Rabbithole hasn't probed it. A mostly-gray
 * COLUMN is a curriculum gap (no conversation engaged that question);
 * a mostly-yellow ROW is a scholar who needs attention. There are no
 * teacher overrides by design — the grid reports what Rabbithole
 * observed, full stop.
 *
 * Teacher-only surface: colors/Bloom levels never render to kids.
 */

import { useMemo, useState } from "react";
import Link from "next/link";
import { useQuery } from "convex/react";
import { Badge, Box, Button, HStack, Stack, Text } from "@chakra-ui/react";
import { WarningCircle, ArrowRight } from "@phosphor-icons/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { Avatar } from "@/components/Avatar";
import { Surface } from "@/components/ui/Surface";
import { formatRelative } from "@/lib/relativeTime";
import { statusFromEvidence } from "@/convex/lib/granules";
import type { GranuleStatus } from "@/convex/lib/granules";

const STATUS_BG: Record<GranuleStatus, string> = {
  green: "green.400",
  yellow: "yellow.400",
  gray: "gray.300",
};

const STATUS_LABEL: Record<GranuleStatus, string> = {
  green: "demonstrated",
  yellow: "probed, not yet demonstrated",
  gray: "not yet probed",
};

export function GranuleCoverageGrid({
  assignmentId,
}: {
  assignmentId: Id<"assignments">;
}) {
  const coverage = useQuery(api.granuleEvidence.coverageForAssignment, {
    assignmentId,
  });
  const [selected, setSelected] = useState<{
    scholarIdx: number;
    granuleKey: string;
  } | null>(null);
  const [view, setView] = useState<"coverage" | "prepost">("coverage");
  const coverageGranules = coverage?.granules;

  const labeled = useMemo(() => {
    if (!coverageGranules) return [];

    // Short column labels: EQ1, EQ2… EU1… in list order per kind.
    let eqN = 0;
    let euN = 0;
    return coverageGranules.map((g) => ({
      ...g,
      label: g.kind === "eq" ? `EQ${++eqN}` : `EU${++euN}`,
    }));
  }, [coverageGranules]);

  if (!coverage) return null;
  const { granules, scholars } = coverage;
  if (granules.length === 0) {
    return (
      <Text fontSize="sm" color="charcoal.400" py={6} textAlign="center">
        This unit has no essential questions or enduring understandings
        yet — add them in the unit designer to track understanding
        coverage here.
      </Text>
    );
  }

  const selectedScholar =
    selected !== null ? scholars[selected.scholarIdx] : null;
  const selectedGranule =
    selected !== null
      ? labeled.find((g) => g.key === selected.granuleKey) ?? null
      : null;
  const selectedCell =
    selectedScholar && selectedGranule
      ? selectedScholar.cells[selectedGranule.key]
      : null;

  return (
    <Stack gap={4}>
      {/* Legend: what each column asks */}
      <Surface p={4}>
        <Stack gap={1.5}>
          {labeled.map((g) => (
            <HStack key={g.key} gap={2} align="baseline">
              <Text
                fontSize="2xs"
                fontFamily="heading"
                fontWeight="700"
                color={g.kind === "eq" ? "violet.600" : "navy.500"}
                minW="34px"
              >
                {g.label}
              </Text>
              <Text fontSize="sm" color="charcoal.600">
                {g.text}
              </Text>
            </HStack>
          ))}
          <HStack gap={4} mt={2} flexWrap="wrap">
            {(Object.keys(STATUS_BG) as GranuleStatus[]).map((s) => (
              <HStack key={s} gap={1.5}>
                <Box w="10px" h="10px" borderRadius="full" bg={STATUS_BG[s]} />
                <Text fontSize="2xs" color="charcoal.400" fontFamily="heading">
                  {STATUS_LABEL[s]}
                </Text>
              </HStack>
            ))}
            <Text fontSize="2xs" color="charcoal.400" fontFamily="heading">
              Gray columns mean Rabbithole hasn&apos;t probed it — a
              coverage gap, not a scholar deficit.
            </Text>
          </HStack>
        </Stack>
      </Surface>

      {/* View toggle: cumulative coverage vs. baseline→exit movement.
          Pre/post reads the phase stamped on each evidence row (set from
          the activity recipe), so it only lights up for units that run a
          Baseline and/or Exit-ticket activity. */}
      <HStack gap={2} align="center" flexWrap="wrap">
        {(
          [
            { key: "coverage", label: "Coverage" },
            { key: "prepost", label: "Before → After" },
          ] as const
        ).map((opt) => (
          <Button
            key={opt.key}
            size="2xs"
            variant={view === opt.key ? "solid" : "outline"}
            bg={view === opt.key ? "violet.500" : undefined}
            color={view === opt.key ? "white" : "charcoal.500"}
            _hover={{ bg: view === opt.key ? "violet.600" : "violet.50" }}
            fontFamily="heading"
            onClick={() => setView(opt.key)}
          >
            {opt.label}
          </Button>
        ))}
        {view === "prepost" && (
          <Text fontSize="2xs" color="charcoal.400" fontFamily="heading">
            Left dot = baseline (start of unit), right = exit ticket (end).
            A yellow→green move is the unit moving the needle.
          </Text>
        )}
      </HStack>

      {/* The grid */}
      <Surface p={0} overflowX="auto">
        <Box
          display="grid"
          gridTemplateColumns={`minmax(160px, 1fr) repeat(${labeled.length}, minmax(${view === "prepost" ? "64px" : "48px"}, ${view === "prepost" ? "84px" : "64px"}))`}
          alignItems="stretch"
          userSelect="none"
        >
          {/* Header row */}
          <Box p={2} borderBottomWidth="1px" borderColor="gray.200" />
          {labeled.map((g) => (
            <Box
              key={g.key}
              p={2}
              borderBottomWidth="1px"
              borderColor="gray.200"
              textAlign="center"
            >
              <Text
                fontSize="2xs"
                fontFamily="heading"
                fontWeight="700"
                color={g.kind === "eq" ? "violet.600" : "navy.500"}
              >
                {g.label}
              </Text>
            </Box>
          ))}

          {scholars.map((s, scholarIdx) => (
            <Box key={String(s.scholarId)} display="contents">
              <HStack
                gap={2}
                p={2}
                borderBottomWidth="1px"
                borderColor="gray.100"
                minW={0}
              >
                <Avatar
                  size="xs"
                  name={s.name || undefined}
                  src={s.image || undefined}
                  colorKey={String(s.scholarId)}
                />
                <Text
                  fontSize="xs"
                  fontFamily="heading"
                  fontWeight="600"
                  color="navy.500"
                  overflow="hidden"
                  textOverflow="ellipsis"
                  whiteSpace="nowrap"
                >
                  {s.name}
                </Text>
              </HStack>
              {labeled.map((g) => {
                const cell = s.cells[g.key];
                const status = cell?.status ?? "gray";
                const hasEvidence = (cell?.evidence.length ?? 0) > 0;
                const hasMisconception = cell?.evidence.some(
                  (e) => e.hasMisconception,
                );
                const baselineStatus = statusFromEvidence(
                  (cell?.evidence ?? []).filter((e) => e.phase === "baseline"),
                );
                const exitStatus = statusFromEvidence(
                  (cell?.evidence ?? []).filter((e) => e.phase === "exit"),
                );
                const moved =
                  exitStatus === "green" && baselineStatus !== "green";
                const isSelected =
                  selected?.scholarIdx === scholarIdx &&
                  selected?.granuleKey === g.key;
                return (
                  <Box
                    key={g.key}
                    as={hasEvidence ? "button" : "div"}
                    onClick={
                      hasEvidence
                        ? () =>
                            setSelected(
                              isSelected
                                ? null
                                : { scholarIdx, granuleKey: g.key },
                            )
                        : undefined
                    }
                    display="flex"
                    alignItems="center"
                    justifyContent="center"
                    p={2}
                    borderBottomWidth="1px"
                    borderColor="gray.100"
                    bg={
                      isSelected
                        ? "violet.50"
                        : view === "prepost" && moved
                          ? "green.50"
                          : undefined
                    }
                    cursor={hasEvidence ? "pointer" : "default"}
                    title={
                      view === "prepost"
                        ? `${s.name} · ${g.label}: ${STATUS_LABEL[baselineStatus]} → ${STATUS_LABEL[exitStatus]}`
                        : `${s.name} · ${g.label}: ${STATUS_LABEL[status]}`
                    }
                  >
                    {view === "prepost" ? (
                      <HStack gap={1} align="center">
                        <Box
                          w="12px"
                          h="12px"
                          borderRadius="full"
                          bg={STATUS_BG[baselineStatus]}
                          borderWidth="1px"
                          borderColor={
                            baselineStatus === "gray"
                              ? "gray.300"
                              : "transparent"
                          }
                        />
                        <Box color={moved ? "green.500" : "charcoal.300"}>
                          <ArrowRight size={10} weight="bold" />
                        </Box>
                        <Box
                          w="12px"
                          h="12px"
                          borderRadius="full"
                          bg={STATUS_BG[exitStatus]}
                          borderWidth="1px"
                          borderColor={
                            exitStatus === "gray" ? "gray.300" : "transparent"
                          }
                        />
                      </HStack>
                    ) : (
                      <Box position="relative">
                        <Box
                          w="14px"
                          h="14px"
                          borderRadius="full"
                          bg={STATUS_BG[status]}
                          borderWidth="1px"
                          borderColor={
                            status === "gray" ? "gray.300" : "transparent"
                          }
                        />
                        {hasMisconception && (
                          <Box
                            position="absolute"
                            top="-6px"
                            right="-8px"
                            color="orange.500"
                          >
                            <WarningCircle size={11} weight="fill" />
                          </Box>
                        )}
                      </Box>
                    )}
                  </Box>
                );
              })}
            </Box>
          ))}
        </Box>
      </Surface>

      {/* Evidence drill-in for the selected cell */}
      {selectedCell && selectedScholar && selectedGranule && (
        <Surface p={4}>
          <Stack gap={3}>
            <HStack gap={2} align="baseline">
              <Text
                fontSize="sm"
                fontFamily="heading"
                fontWeight="700"
                color="navy.500"
              >
                {selectedScholar.name} · {selectedGranule.label}
              </Text>
              <Text fontSize="xs" color="charcoal.400">
                {selectedGranule.text}
              </Text>
            </HStack>
            {selectedCell.evidence.map((e, i) => (
              <Box
                key={i}
                p={3}
                borderWidth="1px"
                borderColor="gray.200"
                borderRadius="md"
              >
                <HStack gap={2} mb={1} flexWrap="wrap">
                  <Badge
                    bg={e.outcome === "demonstrated" ? "green.100" : "yellow.100"}
                    color={
                      e.outcome === "demonstrated" ? "green.700" : "yellow.800"
                    }
                    fontFamily="heading"
                  >
                    {e.outcome}
                  </Badge>
                  {e.phase && (
                    <Badge bg="violet.100" color="violet.700" fontFamily="heading">
                      {e.phase === "baseline" ? "baseline" : "exit ticket"}
                    </Badge>
                  )}
                  {e.bloomLevel && (
                    <Badge bg="gray.100" color="charcoal.500" fontFamily="heading">
                      {e.bloomLevel}
                    </Badge>
                  )}
                  {e.hasMisconception && (
                    <Badge bg="orange.100" color="orange.700" fontFamily="heading">
                      misconception
                    </Badge>
                  )}
                  <Text fontSize="2xs" color="charcoal.400" fontFamily="heading">
                    {formatRelative(e.observedAt)}
                  </Text>
                </HStack>
                <Text fontSize="sm" color="charcoal.600">
                  {e.evidenceSummary}
                </Text>
                {e.transcriptExcerpt && (
                  <Text fontSize="xs" color="charcoal.400" fontStyle="italic" mt={1}>
                    &ldquo;{e.transcriptExcerpt}&rdquo;
                  </Text>
                )}
                <Box mt={1}>
                  <Link href={`/scholar/${e.sessionId}`}>
                    <Button size="2xs" variant="ghost" color="violet.500">
                      Open session →
                    </Button>
                  </Link>
                </Box>
              </Box>
            ))}
          </Stack>
        </Surface>
      )}
    </Stack>
  );
}
