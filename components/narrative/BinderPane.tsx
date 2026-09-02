"use client";

import { Box, Flex, Heading, HStack, Spinner, Text, VStack } from "@chakra-ui/react";
import { Check, WarningCircle } from "@phosphor-icons/react";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { PCM_DIMENSIONS, PCM_META, bandForRating, type PcmDimension } from "@/convex/lib/pcm";
import { formatRelative } from "@/lib/relativeTime";

/** The nine narrative-tab keys, in report order (shared with NarrativeComposer). */
export type SectionKey =
  | "context"
  | "progress"
  | "dim_core"
  | "dim_connections"
  | "dim_practice"
  | "dim_identity"
  | "goals"
  | "overall"
  | "approvals";

type Binder = NonNullable<ReturnType<typeof useQuery<typeof api.assessmentBinder.forScholar>>>;
type Episode = Binder["anecdotes"][number];
type CounterEvidenceItem = Binder["counterEvidence"][number];
type LastGoal = Binder["lastGoals"][number];

const COVERAGE_LABEL: Record<Binder["coverage"], string> = {
  "mostly-online": "Mostly on-platform",
  "mostly-offline": "Mostly off-platform",
  balanced: "Balanced on/off-platform",
};

const SECTION_TO_DIMENSION: Partial<Record<SectionKey, PcmDimension>> = {
  dim_core: "core",
  dim_connections: "connections",
  dim_practice: "practice",
  dim_identity: "identity",
};

export interface EvidencePaneUnit {
  id: Id<"units">;
  title: string;
}

/**
 * The uniform left-pane header — a large heading (the tab's label) with a
 * muted, right-aligned one-line blurb. EVERY evidence pane (in this file and
 * the Overall/Approvals custom panes in NarrativeComposer) opens with this,
 * so the "what am I looking at" framing can't drift tab-to-tab.
 */
export function EvidenceHeader({ label, blurb }: { label: string; blurb?: string }) {
  return (
    <HStack justify="space-between" align="start" mb={1} gap={3}>
      <Heading size="md" color="navy.600" fontFamily="heading">
        {label}
      </Heading>
      {blurb && (
        <Text color="charcoal.300" fontSize="xs" fontFamily="body" textAlign="right" flexShrink={0} maxW="55%">
          {blurb}
        </Text>
      )}
    </HStack>
  );
}

/**
 * Left pane: the per-tab evidence view (review/assessment-and-goals-plan.html
 * §6, repurposed 2026-07-02 for the tabbed composer). Read-only reference the
 * teacher writes against — it never writes anything itself, EXCEPT the one
 * toggle wired up here: which goals continue (Goals). Units (Context) are
 * fully read-only, auto-derived from the scholar's sessions — there is no
 * more unit-picking UI anywhere in this pane.
 */
export function EvidencePane({
  section,
  binder,
  units,
  acceptedGoalIds,
  onToggleGoal,
}: {
  section: SectionKey;
  binder: Binder | undefined;
  /** Context tab only — the units this scholar actually worked on this period. */
  units?: EvidencePaneUnit[];
  /** Goals tab only — which of `binder.lastGoals` are accepted goalIds. */
  acceptedGoalIds?: Set<string>;
  onToggleGoal?: (goalId: Id<"scholarGoals">) => void;
}) {
  if (section === "context") {
    return <ContextEvidence units={units} />;
  }

  if (binder === undefined) {
    return (
      <Flex justify="center" py={10}>
        <Spinner size="md" color="violet.500" />
      </Flex>
    );
  }

  if (section === "progress") return <ProgressEvidence binder={binder} />;
  if (section === "goals")
    return <GoalsEvidence goals={binder.lastGoals} accepted={acceptedGoalIds} onToggle={onToggleGoal} />;

  const dim = SECTION_TO_DIMENSION[section];
  if (!dim) return null;
  return <DimensionEvidence binder={binder} dim={dim} />;
}

function ContextEvidence({ units }: { units?: EvidencePaneUnit[] }) {
  return (
    <VStack align="stretch" gap={3}>
      <EvidenceHeader label="Context" blurb="Units this scholar worked on this period (from their sessions)." />
      {units === undefined ? (
        <Spinner size="xs" color="violet.500" />
      ) : units.length === 0 ? (
        <Text fontSize="xs" color="charcoal.300" fontFamily="body">
          No sessions recorded for this scholar this period — nothing to show yet.
        </Text>
      ) : (
        <HStack wrap="wrap" gap={1.5}>
          {units.map((u) => (
            <Box
              key={String(u.id)}
              px={2.5}
              py={1}
              borderRadius="full"
              borderWidth="1px"
              borderColor="gray.200"
              bg="gray.50"
            >
              <Text fontSize="xs" fontFamily="heading" fontWeight="600" color="navy.600">
                {u.title}
              </Text>
            </Box>
          ))}
        </HStack>
      )}
    </VStack>
  );
}

function ProgressEvidence({ binder }: { binder: Binder }) {
  const allEpisodes = PCM_DIMENSIONS.flatMap((dim) =>
    binder.byDimension[dim].episodes.map((ep) => ({ ...ep, dimension: dim })),
  ).sort((a, b) => {
    const am = a.weight === "major" ? 1 : 0;
    const bm = b.weight === "major" ? 1 : 0;
    if (am !== bm) return bm - am;
    return b.at - a.at;
  });

  return (
    <VStack align="stretch" gap={4}>
      <EvidenceHeader
        label="Progress"
        blurb={`${COVERAGE_LABEL[binder.coverage]} · ${binder.counts.onPlatform} on-platform · ${binder.counts.offPlatform} off-platform`}
      />

      <Box>
        <Text fontFamily="heading" fontWeight="700" fontSize="sm" color="navy.600" mb={1}>
          Strongest episodes
        </Text>
        {allEpisodes.length === 0 ? (
          <Text fontSize="xs" color="charcoal.300" fontFamily="body">
            No dimension evidence recorded yet this period.
          </Text>
        ) : (
          <VStack align="stretch" gap={1.5}>
            {allEpisodes.slice(0, 8).map((ep, i) => (
              <EpisodeCard key={`${ep.dimension}-${i}`} episode={ep} dimensionLabel={PCM_META[ep.dimension].label} />
            ))}
          </VStack>
        )}
      </Box>

      {binder.anecdotes.length > 0 && (
        <Box>
          <Text fontFamily="heading" fontWeight="700" fontSize="sm" color="navy.600" mb={1}>
            Teacher anecdotes
          </Text>
          <VStack align="stretch" gap={1.5}>
            {binder.anecdotes.map((ep, i) => (
              <EpisodeCard key={`anecdote-${i}`} episode={ep} />
            ))}
          </VStack>
        </Box>
      )}

      <CounterEvidenceLane items={binder.counterEvidence} />
    </VStack>
  );
}

function DimensionEvidence({ binder, dim }: { binder: Binder; dim: PcmDimension }) {
  const brief = binder.byDimension[dim];
  const counter = binder.counterEvidence.filter((c) => c.dimension === dim);

  return (
    <VStack align="stretch" gap={3}>
      <EvidenceHeader label={PCM_META[dim].label} blurb={PCM_META[dim].blurb} />

      {brief.thin ? (
        <HStack p={2} bg="orange.50" borderRadius="md" borderWidth="1px" borderColor="orange.100" align="start" gap={1.5}>
          <WarningCircle size={13} color="#c05621" style={{ flexShrink: 0, marginTop: 2 }} />
          <Text fontSize="2xs" color="orange.700" fontFamily="body">
            {brief.note}
          </Text>
        </HStack>
      ) : (
        <Text fontSize="2xs" color="charcoal.400" fontFamily="body">
          {brief.note}
        </Text>
      )}

      {brief.episodes.length > 0 && (
        <VStack align="stretch" gap={1.5}>
          {brief.episodes.map((ep, i) => (
            <EpisodeCard key={`${dim}-${i}`} episode={ep} />
          ))}
        </VStack>
      )}

      <CounterEvidenceLane items={counter} />
    </VStack>
  );
}

function GoalsEvidence({
  goals,
  accepted,
  onToggle,
}: {
  goals: LastGoal[];
  accepted?: Set<string>;
  onToggle?: (goalId: Id<"scholarGoals">) => void;
}) {
  return (
    <VStack align="stretch" gap={3}>
      <EvidenceHeader label="Goals" blurb="Toggle which continue as this narrative's Goals for Continued Growth." />
      {goals.length === 0 ? (
        <Text fontSize="xs" color="charcoal.300" fontFamily="body">
          No goals recorded for this scholar yet.
        </Text>
      ) : (
        <VStack align="stretch" gap={2}>
          {goals.map((g) => {
            const isAccepted = accepted?.has(String(g._id)) ?? false;
            return (
              <Box
                key={String(g._id)}
                borderRadius="md"
                borderWidth="1px"
                borderColor={isAccepted ? "violet.300" : "gray.100"}
                bg={isAccepted ? "violet.50" : "white"}
                px={2.5}
                py={1.5}
              >
                <HStack as="button" onClick={() => onToggle?.(g._id)} justify="space-between" w="full" cursor="pointer" textAlign="left">
                  <Box>
                    <Text fontSize="xs" fontFamily="heading" fontWeight="600" color="navy.600">
                      {g.title}
                    </Text>
                    <Text fontSize="2xs" color="charcoal.300" fontFamily="body" textTransform="capitalize">
                      {g.kind} · {g.checkins.length} check-in{g.checkins.length === 1 ? "" : "s"}
                    </Text>
                  </Box>
                  {isAccepted && <Check size={14} color="#7c5cff" />}
                </HStack>
                {g.checkins.length > 0 && (
                  <VStack align="stretch" gap={1} mt={1.5} pl={2} borderLeft="2px solid" borderColor="gray.100">
                    {g.checkins.slice(0, 3).map((c, i) => (
                      <Box key={i}>
                        <Text fontSize="3xs" color="charcoal.300" fontFamily="body" textTransform="capitalize">
                          {formatRelative(c.at)} · {c.authorType}
                        </Text>
                        <Text fontSize="xs" color="charcoal.600" fontFamily="body">
                          {c.note}
                        </Text>
                      </Box>
                    ))}
                  </VStack>
                )}
              </Box>
            );
          })}
        </VStack>
      )}
    </VStack>
  );
}

/**
 * Overall tab's evidence pane: coverage + an at-a-glance, read-only summary
 * of the four dimension ratings. The composer renders `WorkingLevelReadout`
 * (components/narrative/RubricStrip.tsx) directly below this, in the same
 * left `<Surface>`.
 */
export function OverallEvidence({
  binder,
  pcmRatings,
}: {
  binder: Binder | undefined;
  pcmRatings?: Partial<Record<PcmDimension, number>>;
}) {
  return (
    <VStack align="stretch" gap={3}>
      <EvidenceHeader label="Overall" blurb="Coverage + the four dimension ratings, at a glance." />
      {binder && (
        <Text fontSize="2xs" color="charcoal.400" fontFamily="body">
          {COVERAGE_LABEL[binder.coverage]} · {binder.counts.onPlatform} on-platform · {binder.counts.offPlatform} off-platform
        </Text>
      )}
      <VStack align="stretch" gap={1.5}>
        {PCM_DIMENSIONS.map((dim) => {
          const value = pcmRatings?.[dim];
          const band = value != null ? bandForRating(value) : null;
          return (
            <HStack
              key={dim}
              justify="space-between"
              px={2.5}
              py={1.5}
              borderWidth="1px"
              borderColor="gray.100"
              borderRadius="md"
              bg="white"
            >
              <Text fontSize="xs" fontFamily="heading" fontWeight="600" color="navy.600">
                {PCM_META[dim].label}
              </Text>
              <Text fontSize="xs" color="charcoal.400" fontFamily="body">
                {band ? `${value} — ${band.band}` : "Not yet rated"}
              </Text>
            </HStack>
          );
        })}
      </VStack>
    </VStack>
  );
}

function CounterEvidenceLane({ items }: { items: CounterEvidenceItem[] }) {
  if (items.length === 0) return null;
  return (
    <Box p={2.5} bg="orange.50" borderRadius="md" borderWidth="1px" borderColor="orange.200">
      <HStack gap={1.5} mb={1.5}>
        <WarningCircle size={14} color="#c05621" />
        <Text
          fontFamily="heading"
          fontWeight="700"
          fontSize="2xs"
          color="orange.700"
          textTransform="uppercase"
          letterSpacing="0.04em"
        >
          Counter-evidence lane
        </Text>
      </HStack>
      <VStack align="stretch" gap={1.5}>
        {items.map((c, i) => (
          <Box key={i}>
            <Text fontSize="2xs" fontFamily="heading" fontWeight="600" color="orange.700">
              {c.source} · {formatRelative(c.at)}
            </Text>
            <Text fontSize="xs" color="charcoal.600" fontFamily="body">
              {c.summary}
            </Text>
          </Box>
        ))}
      </VStack>
    </Box>
  );
}

function EpisodeCard({ episode, dimensionLabel }: { episode: Episode; dimensionLabel?: string }) {
  return (
    <Box p={2} bg="white" borderWidth="1px" borderColor="gray.100" borderRadius="md">
      <HStack justify="space-between" align="start" gap={2} mb={0.5}>
        <HStack gap={1} wrap="wrap">
          <Text
            fontSize="3xs"
            fontFamily="heading"
            fontWeight="700"
            color="violet.600"
            textTransform="uppercase"
            letterSpacing="0.03em"
          >
            {episode.source}
          </Text>
          {dimensionLabel && (
            <Text
              fontSize="3xs"
              fontFamily="heading"
              fontWeight="600"
              color="navy.500"
              bg="navy.50"
              px={1}
              borderRadius="sm"
            >
              {dimensionLabel}
            </Text>
          )}
          {episode.sources > 1 && (
            <Text fontSize="3xs" color="charcoal.300" fontFamily="body">
              ×{episode.sources}
            </Text>
          )}
          {episode.studentInitiated && (
            <Text
              fontSize="3xs"
              fontFamily="heading"
              fontWeight="600"
              color="green.600"
              bg="green.50"
              px={1}
              borderRadius="sm"
            >
              student-initiated
            </Text>
          )}
          {episode.weight === "major" && (
            <Text
              fontSize="3xs"
              fontFamily="heading"
              fontWeight="600"
              color="navy.500"
              bg="navy.50"
              px={1}
              borderRadius="sm"
            >
              major
            </Text>
          )}
        </HStack>
        <Text fontSize="3xs" color="charcoal.300" fontFamily="body" flexShrink={0}>
          {formatRelative(episode.at)}
        </Text>
      </HStack>
      <Text fontSize="xs" color="charcoal.600" fontFamily="body">
        {episode.summary}
      </Text>
    </Box>
  );
}
