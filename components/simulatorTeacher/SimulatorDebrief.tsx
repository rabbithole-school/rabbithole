"use client";

/**
 * The DEBRIEF tab for a World (plan §8). FACTUAL and sortable — the adversarial
 * review dropped the uncalibrated "worth discussing" classifier (T6) and the
 * substitute gallery (T3/T8/T10). What remains is the real read model: direction
 * trails (sortable), a zero-hypothesis flag list, the prompt decks (the star
 * exhibit) grouped by a deterministic strategy signature with notebook excerpts,
 * a per-scholar score distribution, and invalid-action hot-spots.
 *
 * DOCTRINE: this is the teacher view — scores are visible and spread is drawn
 * honestly — but every number is a fact about a DECK; the cross-scholar view
 * compares DESIGNS, never ranks children.
 *
 * P2 SEAM (not built here): the real exhibition is a scholar-CHOSEN shareBack
 * submission (run + deck + reflection) rendered on a teacher-gated PROJECTOR
 * with a cohort playlist and full-screen replay (plan §8, §11). That submission
 * table + projector view are deliberately deferred, not faked with a
 * latest/best-run substitute.
 */

import { useMemo } from "react";
import { useQuery } from "convex/react";
import { Box, Flex, HStack, Stack, Text } from "@chakra-ui/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { fmt, metricLabel } from "./helpers";

function Panel({ title, subtitle, children }: { title: string; subtitle?: string; children: React.ReactNode }) {
  return (
    <Box borderWidth="1px" borderColor="gray.200" borderRadius="lg" bg="white" p={4}>
      <Text fontFamily="heading" fontWeight="800" fontSize="sm" color="navy.500">
        {title}
      </Text>
      {subtitle ? (
        <Text fontSize="xs" color="charcoal.500" mb={3}>
          {subtitle}
        </Text>
      ) : (
        <Box mb={3} />
      )}
      {children}
    </Box>
  );
}

export function SimulatorDebrief({
  activityId,
  assignmentId,
}: {
  activityId: Id<"activities">;
  assignmentId?: Id<"assignments">;
}) {
  const data = useQuery(api.simulatorTeacher.debrief, { activityId, assignmentId });
  const hotspots = useQuery(api.simulatorTeacher.invalidHotspots, { activityId, assignmentId });

  const distByScore = useMemo(() => {
    if (!data) return { min: 0, max: 1 };
    const scores = data.distribution.map((d) => d.score);
    if (scores.length === 0) return { min: 0, max: 1 };
    return { min: Math.min(...scores), max: Math.max(...scores) };
  }, [data]);

  // Decks clustered by their factual population signature (diversity of approach).
  const deckGroups = useMemo(() => {
    if (!data) return [];
    const groups = new Map<string, typeof data.decks>();
    for (const deck of data.decks) {
      const key = deck.signature || "(no species)";
      const list = groups.get(key) ?? [];
      list.push(deck);
      groups.set(key, list);
    }
    return [...groups.entries()].sort((a, b) => b[1].length - a[1].length);
  }, [data]);

  if (data === undefined) {
    return (
      <Flex h="full" align="center" justify="center">
        <Text fontSize="sm" color="charcoal.400">
          Loading…
        </Text>
      </Flex>
    );
  }
  if (data === null) {
    return (
      <Flex h="full" align="center" justify="center" p={8}>
        <Text fontSize="sm" color="charcoal.400" textAlign="center">
          This activity has no Simulator configured yet.
        </Text>
      </Flex>
    );
  }
  if (data.totals.runCount === 0) {
    return (
      <Flex h="full" align="center" justify="center" p={8}>
        <Text fontSize="sm" color="charcoal.400" textAlign="center" maxW="360px">
          No runs yet. Once scholars work the bench, their direction trails and decks appear here.
        </Text>
      </Flex>
    );
  }

  const span = Math.max(1, distByScore.max - distByScore.min);
  const barX = (score: number) => ((score - distByScore.min) / span) * 100;

  return (
    <Box h="full" overflowY="auto" p={5}>
      <Stack gap={4} maxW="960px" mx="auto" pb={12}>
        <Box>
          <Text fontFamily="heading" fontWeight="800" fontSize="md" color="navy.500">
            {data.title} — Debrief
          </Text>
          <Text fontSize="xs" color="charcoal.400">
            {data.criterion.kind === "gallery"
              ? "Gallery criterion"
              : `${metricLabel(data.criterion.metricKey)} · ${data.criterion.direction}`}{" "}
            · {data.totals.scholarCount} scholars · {data.totals.runCount} runs
          </Text>
        </Box>

        {/* Discoveries — celebrate a scholar who reasoned about the horizon */}
        {data.discoveries && (
          <Box borderWidth="1px" borderColor="violet.200" bg="violet.50" borderRadius="lg" px={4} py={3}>
            <Text fontSize="2xs" fontFamily="heading" fontWeight="700" color="violet.700" textTransform="uppercase" letterSpacing="0.05em" mb={2}>
              Discoveries — someone found the last move
            </Text>
            <Stack gap={1.5}>
              {data.discoveries.scholars.map((s) => (
                <Text key={String(s.scholarId)} fontSize="xs" color="charcoal.600">
                  <Text as="span" fontFamily="heading" fontWeight="700" color="charcoal.700">
                    {s.name}
                  </Text>{" "}
                  reasoned all the way to the horizon: their {s.slotLabels.join(" and ")}{" "}
                  {s.slotLabels.length === 1 ? "deck cooperates" : "decks cooperate"} through the game, then{" "}
                  {s.defectsAtEndgame ? "defects" : "switches"} as the final round(s) close — backward
                  induction, discovered by hand. That&apos;s real reasoning about consequences, not a loophole.
                </Text>
              ))}
            </Stack>
            <Text fontSize="xs" color="violet.700" mt={2}>
              Discussion: {data.discoveries.discussionQuestion} (It also opens the door to the evolutionary
              tournament, where nobody knows which round is last.)
            </Text>
          </Box>
        )}

        {/* Zero-hypothesis flag — a factual list, not a ranked pick */}
        {data.flaggedZeroHypothesis.length > 0 && (
          <Box borderWidth="1px" borderColor="amber.200" bg="amber.50" borderRadius="lg" px={4} py={3}>
            <Text fontSize="2xs" fontFamily="heading" fontWeight="700" color="amber.700" textTransform="uppercase" letterSpacing="0.05em" mb={1}>
              Ran the bench but never formed a hypothesis
            </Text>
            <Text fontSize="xs" color="charcoal.600">
              {data.flaggedZeroHypothesis.map((s) => `${s.name} (${s.runCount})`).join(" · ")}
            </Text>
          </Box>
        )}

        {/* Direction trails — sortable facts */}
        <Panel title="Direction trails" subtitle="Each scholar's arc — runs, hypotheses, deck revisions, personal best. Sort by any column.">
          <Box overflowX="auto">
            <Box as="table" w="full" fontSize="xs" style={{ borderCollapse: "collapse" }}>
              <Box as="thead">
                <Box as="tr" color="charcoal.400" textAlign="left">
                  {["Scholar", "Runs", "Hypotheses", "Deck versions", "First", "Best", "Δ", "Invalid"].map((h) => (
                    <Box as="th" key={h} py={1} pr={4} fontFamily="heading" fontWeight="700" fontSize="2xs" textTransform="uppercase" letterSpacing="0.04em">
                      {h}
                    </Box>
                  ))}
                </Box>
              </Box>
              <Box as="tbody">
                {data.trails.map((t) => (
                  <Box as="tr" key={t.scholarId} borderTopWidth="1px" borderColor="gray.100">
                    <Box as="td" py={1.5} pr={4} fontFamily="heading" fontWeight="600" color="charcoal.600">
                      {t.name}
                      {!t.hasHypothesis && (
                        <Text as="span" color="amber.600" ml={1} fontSize="2xs">
                          ⚑
                        </Text>
                      )}
                    </Box>
                    <Box as="td" py={1.5} pr={4} color="charcoal.500">{t.runCount}</Box>
                    <Box as="td" py={1.5} pr={4} color="charcoal.500">{t.hypothesesCount}</Box>
                    <Box as="td" py={1.5} pr={4} color="charcoal.500">{t.deckVersionCount}</Box>
                    <Box as="td" py={1.5} pr={4} color="charcoal.500">{fmt(t.firstScore)}</Box>
                    <Box as="td" py={1.5} pr={4} color="charcoal.600" fontWeight="700">{fmt(t.bestScore)}</Box>
                    <Box as="td" py={1.5} pr={4} color={(t.personalDelta ?? 0) > 0 ? "green.600" : "charcoal.400"}>
                      {t.personalDelta === null ? "—" : (t.personalDelta > 0 ? "+" : "") + fmt(t.personalDelta)}
                    </Box>
                    <Box as="td" py={1.5} pr={4} color="charcoal.500">{Math.round(t.invalidRate * 100)}%</Box>
                  </Box>
                ))}
              </Box>
            </Box>
          </Box>
        </Panel>

        {/* Score distribution */}
        {data.criterion.kind === "measured" && data.distribution.length > 0 && (
          <Panel title="Score distribution" subtitle={`Every run's ${metricLabel(data.criterion.metricKey)}, spread honestly (${fmt(distByScore.min)} – ${fmt(distByScore.max)}). One row per scholar.`}>
            <Stack gap={1.5}>
              {data.decks.map((d) => {
                const runs = data.distribution.filter((r) => String(r.scholarId) === String(d.scholarId));
                if (runs.length === 0) return null;
                return (
                  <HStack key={String(d.scholarId)} gap={3}>
                    <Text w="120px" fontSize="2xs" fontFamily="heading" color="charcoal.500" truncate>
                      {d.name}
                    </Text>
                    <Box position="relative" flex={1} h="16px" bg="gray.100" borderRadius="full">
                      {runs.map((r, i) => (
                        <Box
                          key={i}
                          position="absolute"
                          top="2px"
                          left={`calc(${barX(r.score)}% - 6px)`}
                          w="12px"
                          h="12px"
                          borderRadius="full"
                          bg="violet.400"
                          title={`v${r.deckVersion}: ${fmt(r.score)}`}
                        />
                      ))}
                    </Box>
                  </HStack>
                );
              })}
            </Stack>
          </Panel>
        )}

        {/* Prompt decks grouped by strategy signature */}
        <Panel title="Prompt decks — by approach" subtitle="The actual prompts scholars wrote (the star exhibit), clustered by population shape so you can see diversity of approach.">
          <Stack gap={4}>
            {deckGroups.map(([signature, decks]) => (
              <Box key={signature}>
                <Text fontSize="2xs" fontFamily="heading" fontWeight="700" color="violet.600" textTransform="uppercase" letterSpacing="0.05em" mb={2}>
                  {signature} · {decks.length} {decks.length === 1 ? "deck" : "decks"}
                </Text>
                <Stack gap={3}>
                  {decks.map((d) => (
                    <Box key={String(d.scholarId)} borderWidth="1px" borderColor="gray.100" borderRadius="md" p={3}>
                      <HStack justify="space-between" mb={2}>
                        <Text fontSize="sm" fontFamily="heading" fontWeight="700" color="charcoal.600">
                          {d.name}
                        </Text>
                        <Text fontSize="2xs" color="charcoal.400">
                          deck v{d.deckVersion}
                        </Text>
                      </HStack>
                      <Stack gap={1.5}>
                        {d.cards.map((c) => (
                          <Box key={c.slotId}>
                            <Text fontSize="2xs" fontFamily="heading" fontWeight="700" color="charcoal.500">
                              {c.label} ×{c.count}
                            </Text>
                            <Text fontSize="xs" color="charcoal.600" whiteSpace="pre-wrap">
                              {c.prompt || <Text as="span" color="charcoal.300">(empty)</Text>}
                            </Text>
                          </Box>
                        ))}
                      </Stack>
                      {d.excerpts.length > 0 && (
                        <Box mt={2} pt={2} borderTopWidth="1px" borderColor="gray.100">
                          <Text fontSize="2xs" fontFamily="heading" fontWeight="700" color="charcoal.400" mb={1}>
                            Notebook
                          </Text>
                          <Stack gap={0.5}>
                            {d.excerpts.map((e, i) => (
                              <Text key={i} fontSize="2xs" color="charcoal.500">
                                <Text as="span" color="charcoal.400">
                                  {e.kind}:
                                </Text>{" "}
                                {e.text.slice(0, 200)}
                              </Text>
                            ))}
                          </Stack>
                        </Box>
                      )}
                    </Box>
                  ))}
                </Stack>
              </Box>
            ))}
          </Stack>
        </Panel>

        {/* Invalid-action hot-spots */}
        <Panel
          title="Invalid-action hot-spots"
          subtitle="Which Species prompts confused automata — a writing lesson hiding in telemetry (sampled from the worst runs)."
        >
          {hotspots === undefined ? (
            <Text fontSize="xs" color="charcoal.400">Loading…</Text>
          ) : !hotspots || hotspots.hotspots.length === 0 ? (
            <Text fontSize="xs" color="charcoal.400">No invalid actions found — prompts parsed cleanly.</Text>
          ) : (
            <Stack gap={2}>
              <Text fontSize="2xs" color="charcoal.400">
                Sampled from {hotspots.sampledRuns} run{hotspots.sampledRuns === 1 ? "" : "s"}.
              </Text>
              {hotspots.hotspots.map((h) => (
                <Box key={h.slotId} borderWidth="1px" borderColor="gray.100" borderRadius="md" p={2.5}>
                  <HStack justify="space-between">
                    <Text fontSize="xs" fontFamily="heading" fontWeight="700" color="charcoal.600">
                      {h.label}
                    </Text>
                    <Text fontSize="2xs" color="red.500" fontFamily="heading">
                      {h.invalid} invalid{h.topCode ? ` · ${h.topCode.code}` : ""}
                    </Text>
                  </HStack>
                  {h.promptSample && (
                    <Text fontSize="2xs" color="charcoal.400" mt={1} whiteSpace="pre-wrap">
                      “{h.promptSample.slice(0, 240)}”
                    </Text>
                  )}
                </Box>
              ))}
            </Stack>
          )}
        </Panel>
      </Stack>
    </Box>
  );
}
