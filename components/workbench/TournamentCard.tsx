"use client";

import { useQuery } from "convex/react";
import { Box, Button, Flex, Stack, Text } from "@chakra-ui/react";
import { Play } from "@phosphor-icons/react";

import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import type { WorkbenchRunId } from "@/hooks/useWorkbenchData";
import { Sparkline } from "@/components/Sparkline";
import { REPLICATOR_GENERATION_COUNT } from "@/lib/simulator/replicator";

function percent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function share(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

export function TournamentCard({
  sessionId,
  onSelectRun,
}: {
  sessionId: Id<"sessions">;
  onSelectRun: (runId: WorkbenchRunId) => void;
}) {
  const tournament = useQuery(api.tournaments.forScholar, { sessionId });
  if (!tournament) return null;

  return (
    <Box
      as="section"
      aria-labelledby="tournament-card-title"
      borderTopWidth="1px"
      borderColor="border.subtle"
      pt={3}
      mt={3}
    >
      <Flex justify="space-between" align="baseline" gap={2} mb={2}>
        <Text
          id="tournament-card-title"
          fontSize="xs"
          fontWeight="800"
          color="fg.default"
        >
          Tournament · {tournament.ownDeckLabel}
        </Text>
        <Text fontSize="2xs" color="fg.muted" textTransform="capitalize">
          {tournament.status}
        </Text>
      </Flex>

      <Stack gap={1.5}>
        {tournament.matches.map((match) => (
          <Flex
            key={match.pairingKey}
            align="center"
            justify="space-between"
            gap={2}
            px={2}
            py={1.5}
            borderWidth="1px"
            borderColor="border.subtle"
            borderRadius="md"
          >
            <Box minW={0}>
              <Text fontSize="xs" fontWeight="600" truncate>
                vs {match.opponentDeckLabel}
              </Text>
              <Text fontSize="2xs" color="fg.muted">
                {match.ownScore === null
                  ? match.status
                  : `${match.ownScore}–${match.opponentScore} · ${percent(match.cooperationRate ?? 0)} cooperate`}
              </Text>
            </Box>
            {match.runId ? (
              <Button
                size="2xs"
                variant="ghost"
                colorPalette="violet"
                aria-label={`Replay ${tournament.ownDeckLabel} against ${match.opponentDeckLabel}`}
                onClick={() => onSelectRun(match.runId!)}
              >
                <Play size={12} weight="fill" />
                Replay
              </Button>
            ) : null}
          </Flex>
        ))}
      </Stack>

      {tournament.populationShare ? (
        <Box bg="bg.subtle" borderRadius="md" px={2} py={2} mt={2}>
          <Flex justify="space-between" align="center" gap={2}>
            <Text fontSize="2xs" fontWeight="700" color="fg.default">
              Population share
            </Text>
            <Flex align="center" gap={2}>
              <Sparkline
                values={tournament.populationShare.history}
                width={72}
                height={18}
                band={null}
                ariaLabel={`${tournament.ownDeckLabel} population share over ${tournament.populationShare.generations} generations`}
              />
              <Text fontSize="2xs" fontVariantNumeric="tabular-nums">
                {share(tournament.populationShare.finalShare)}
              </Text>
            </Flex>
          </Flex>
          <Text fontSize="2xs" color="fg.muted" lineHeight="1.5" mt={1}>
            {REPLICATOR_GENERATION_COUNT} ecology generations show how this deck fares as the
            field changes. Standings are shares of the population, not scores, so the top
            scorer may not win: a deck that exploits its partners spreads at first, then
            starves as the decks it preyed on die out.
          </Text>
        </Box>
      ) : null}

      {tournament.matches.some((match) => match.status === "completed") ? (
        <Box bg="bg.subtle" borderRadius="md" px={2} py={2} mt={2}>
          <Text fontSize="2xs" fontWeight="700" color="fg.default">
            What strategies thrived
          </Text>
          <Text fontSize="2xs" color="fg.muted" lineHeight="1.5">
            The field cooperated {percent(tournament.lessonStats.cooperationRate)} of rounds
            and recorded {tournament.lessonStats.forgivenessEvents} forgiveness events.
            {tournament.lessonStats.forgivingDeckAverageScore !== null &&
            tournament.lessonStats.otherDeckAverageScore !== null
              ? ` Decks that forgave averaged ${tournament.lessonStats.forgivingDeckAverageScore.toFixed(1)} points per match; other decks averaged ${tournament.lessonStats.otherDeckAverageScore.toFixed(1)}.`
              : ""}
          </Text>
        </Box>
      ) : null}
    </Box>
  );
}
