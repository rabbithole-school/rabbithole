"use client";

import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { Box, Button, Flex, HStack, Table, Text } from "@chakra-ui/react";
import { CaretDown, CaretRight, Play } from "@phosphor-icons/react";

import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { Sparkline } from "@/components/Sparkline";
import { toaster } from "@/lib/toaster";
import { REPLICATOR_GENERATION_COUNT } from "@/lib/simulator/replicator";

function share(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

export function TournamentPanel({
  assignmentId,
}: {
  assignmentId: Id<"assignments">;
}) {
  const progress = useQuery(api.tournaments.progress, { assignmentId });
  const standings = useQuery(
    api.tournaments.standings,
    progress?.tournamentId ? { tournamentId: progress.tournamentId } : "skip",
  );
  const createTournament = useMutation(api.tournaments.create);
  const startTournament = useMutation(api.tournaments.start);
  const setCollapsed = useMutation(api.tournaments.setStandingsCollapsed);
  const [busy, setBusy] = useState(false);

  if (progress === undefined || progress === null) return null;

  const act = async (work: () => Promise<unknown>, success: string) => {
    setBusy(true);
    try {
      await work();
      toaster.success({ title: success });
    } catch (error) {
      toaster.error({
        title: error instanceof Error ? error.message : "Tournament action failed",
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Box
      as="section"
      aria-labelledby="tournament-panel-title"
      borderTopWidth="1px"
      borderColor="border.subtle"
      mt={4}
      pt={4}
    >
      <Flex justify="space-between" align="center" gap={3} wrap="wrap">
        <Box>
          <Text
            id="tournament-panel-title"
            fontSize="sm"
            fontFamily="heading"
            fontWeight="800"
            color="navy.500"
          >
            Tournament
          </Text>
          <Text fontSize="xs" color="fg.muted">
            {progress.status === "not_created"
              ? `${progress.entrantCount} submitted decks ready for round-robin play.`
              : `${progress.completedMatches}/${progress.matchCount} matches complete${progress.failedMatches ? ` · ${progress.failedMatches} failed` : ""}.`}
          </Text>
        </Box>

        <HStack gap={2}>
          {progress.status === "not_created" ? (
            <Button
              size="sm"
              colorPalette="violet"
              disabled={progress.entrantCount < 2}
              loading={busy}
              onClick={() =>
                act(
                  () => createTournament({ assignmentId }),
                  "Tournament created from the submitted decks",
                )
              }
            >
              Create Tournament
            </Button>
          ) : progress.status === "draft" && progress.tournamentId ? (
            <Button
              size="sm"
              colorPalette="violet"
              loading={busy}
              onClick={() =>
                act(
                  () => startTournament({ tournamentId: progress.tournamentId! }),
                  "Tournament started",
                )
              }
            >
              <Play size={14} weight="fill" />
              Start round robin
            </Button>
          ) : null}

          {progress.tournamentId ? (
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              aria-expanded={!progress.standingsCollapsed}
              onClick={() =>
                act(
                  () =>
                    setCollapsed({
                      tournamentId: progress.tournamentId!,
                      collapsed: !progress.standingsCollapsed,
                    }),
                  progress.standingsCollapsed ? "Standings expanded" : "Standings collapsed",
                )
              }
            >
              {progress.standingsCollapsed ? <CaretRight /> : <CaretDown />}
              Standings
            </Button>
          ) : null}
        </HStack>
      </Flex>

      {!progress.standingsCollapsed && standings && standings.length > 0 ? (
        <Box mt={3}>
          <Text fontSize="xs" color="fg.muted" mb={2}>
            Population share follows {REPLICATOR_GENERATION_COUNT} deterministic ecology
            generations from each deck&apos;s completed head-to-head scores.
          </Text>
          <Box overflowX="auto">
            <Table.Root size="sm" variant="line" aria-label="Tournament deck standings">
              <Table.Header>
                <Table.Row>
                  <Table.ColumnHeader>Rank</Table.ColumnHeader>
                  <Table.ColumnHeader>Deck</Table.ColumnHeader>
                  <Table.ColumnHeader textAlign="end">Population share</Table.ColumnHeader>
                  <Table.ColumnHeader textAlign="end">W–D–L</Table.ColumnHeader>
                  <Table.ColumnHeader textAlign="end">Score</Table.ColumnHeader>
                  <Table.ColumnHeader textAlign="end">Cooperate</Table.ColumnHeader>
                  <Table.ColumnHeader textAlign="end">Forgave</Table.ColumnHeader>
                </Table.Row>
              </Table.Header>
              <Table.Body>
                {standings.map((row, index) => (
                  <Table.Row key={row.simulatorBenchId}>
                    <Table.Cell textAlign="end">
                      {row.populationShare === undefined ? "—" : index + 1}
                    </Table.Cell>
                    <Table.Cell>
                      <Text fontWeight="700">{row.deckLabel}</Text>
                      <Text fontSize="2xs" color="fg.muted">
                        {row.scholar.name}
                      </Text>
                    </Table.Cell>
                    <Table.Cell textAlign="end">
                      {row.populationShare === undefined ? (
                        "—"
                      ) : (
                        <Flex justify="end" align="center" gap={2}>
                          <Sparkline
                            values={row.populationHistory}
                            width={64}
                            height={18}
                            band={null}
                            ariaLabel={`${row.deckLabel} population share over ${REPLICATOR_GENERATION_COUNT} generations`}
                          />
                          <Text fontVariantNumeric="tabular-nums">
                            {share(row.populationShare)}
                          </Text>
                        </Flex>
                      )}
                    </Table.Cell>
                    <Table.Cell textAlign="end">
                      {row.wins}–{row.draws}–{row.losses}
                    </Table.Cell>
                    <Table.Cell textAlign="end">{row.totalScore}</Table.Cell>
                    <Table.Cell textAlign="end">
                      {Math.round(row.cooperationRate * 100)}%
                    </Table.Cell>
                    <Table.Cell textAlign="end">{row.forgivenessEvents}</Table.Cell>
                  </Table.Row>
                ))}
              </Table.Body>
            </Table.Root>
          </Box>
        </Box>
      ) : null}
    </Box>
  );
}
