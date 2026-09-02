"use client";

/**
 * The right column, tabbed:
 *  · Mind — for the tapped automaton, SAW (sense-filtered) / THOUGHT / DID from
 *    the persisted tick record, plus a NEUTRAL invalid-action marker. No oracle
 *    text: the panel reports what the automaton perceived and chose, never why a
 *    prompt "was unclear" (plan §4.3).
 *  · Compare — a dot strip of criterion score per run grouped by deck version so
 *    two runs of the SAME deck scoring differently are visible on screen; a
 *    personal-delta headline ("+3 vs your best deck"); select two → overlaid
 *    metric series (+ a word-level deck diff once the run projection carries the
 *    deck snapshot — see report gap).
 */

import { useMemo, useState } from "react";
import { Box, Button, Flex, HStack, Text, VStack } from "@chakra-ui/react";

import type { DeckCard, SimulatorSpec } from "@/lib/simulator/contract";
import type { SceneFrame } from "@/hooks/useWorkbenchScene";
import type { SimulatorRun, SimulatorRunListItem, WorkbenchRunId } from "@/hooks/useWorkbenchData";
import { useWorkbenchRun } from "@/hooks/useWorkbenchData";
import {
  criterionMetricKey,
  formatMetric,
  isBetter,
  metricLabel,
  runCompareDisplayValue,
} from "./helpers";
import { wordDiff } from "./viewport";
import { describeAction, describeObservation } from "./observation";
import { isRedactedObservation } from "@/lib/simulator/screenText";

type Tab = "mind" | "compare";

function MindTab({
  spec,
  frame,
  run,
  selectedAutomatonId,
}: {
  spec: SimulatorSpec;
  frame: SceneFrame | null;
  run: SimulatorRun | null;
  selectedAutomatonId: string | null;
}) {
  const isField = spec.templateId === "ecosystemGrid";
  const labelBySlot = useMemo(
    () => Object.fromEntries(spec.speciesSlots.map((slot) => [slot.slotId, slot.label])),
    [spec],
  );
  const automaton =
    frame?.automata.find((entity) => entity.id === selectedAutomatonId) ??
    frame?.terminalAutomata.find((entity) => entity.id === selectedAutomatonId) ??
    null;
  const sawRedacted = isRedactedObservation(automaton?.saw);
  const sawLines = useMemo(
    () =>
      automaton && !isRedactedObservation(automaton.saw)
        ? describeObservation(automaton.saw, labelBySlot)
        : [],
    [automaton, labelBySlot],
  );
  if (!automaton) {
    return (
      <Text fontSize="sm" color="gray.400" px={3} py={4}>
        {isField
          ? "Tap an automaton in the field to read what it saw, thought, and did."
          : "Select a player in the record to read its strategy, perception, and decision."}
      </Text>
    );
  }
  const didLine = describeAction(automaton.did, automaton.lastAction);
  const policySlot = run?.compiledPolicySnapshot?.find(
    (slot) => slot.slotId === automaton.slotId,
  );
  const prompt = run?.deckSnapshot.find(
    (card) => card.slotId === automaton.slotId,
  )?.prompt;
  return (
    <VStack align="stretch" gap={3} px={3} py={3}>
      <HStack justify="space-between">
        <Text fontWeight="700" fontSize="sm" color="charcoal.600">
          {automaton.speciesLabel}
        </Text>
        <Text fontSize="xs" color="gray.500">
          ({automaton.x}, {automaton.y}){automaton.energy !== undefined ? ` · energy ${formatMetric(automaton.energy)}` : ""}
        </Text>
      </HStack>
      {!automaton.alive ? (
        <Text fontSize="xs" color="gray.500">
          Last decision before the terminal outcome · {isField ? "day" : "round"} {automaton.lastDecisionTick}
        </Text>
      ) : null}

      {automaton.invalid ? (
        <Box borderWidth="1px" borderColor="orange.300" bg="orange.50" borderRadius="md" px={2} py={1} alignSelf="flex-start">
          <Text fontSize="xs" color="orange.700">
            ⚠ invalid action this tick
          </Text>
        </Box>
      ) : null}

      <Box>
        <Text fontSize="2xs" color="gray.500" fontWeight="700" letterSpacing="0.05em">
          What it noticed
        </Text>
        {sawRedacted ? (
          <Text fontSize="xs" color="gray.500" fontStyle="italic" bg="gray.50" borderRadius="md" p={2}>
            Hidden during tournaments
          </Text>
        ) : sawLines.length > 0 ? (
          <VStack align="stretch" gap={0.5} bg="gray.50" borderRadius="md" p={2}>
            {sawLines.map((line, index) => (
              <Text key={index} fontSize="xs" color="gray.700">
                {line}
              </Text>
            ))}
          </VStack>
        ) : (
          <Text fontSize="xs" color="gray.500" bg="gray.50" borderRadius="md" p={2}>
            senses quiet — nothing nearby
          </Text>
        )}
        {automaton.senseAudit ? (
          <Text fontSize="2xs" color="orange.700" mt={1}>
            {automaton.senseAudit}
          </Text>
        ) : null}
      </Box>
      <Box>
        <Text fontSize="2xs" color="gray.500" fontWeight="700" letterSpacing="0.05em">
          Why it chose
        </Text>
        <Text fontSize="xs" color="gray.700" bg="gray.50" borderRadius="md" p={2}>
          {automaton.policyTrace || automaton.thought || "—"}
        </Text>
      </Box>
      <Box>
        <Text fontSize="2xs" color="gray.500" fontWeight="700" letterSpacing="0.05em">
          What it did
        </Text>
        <Text fontSize="xs" color="gray.700" bg="gray.50" borderRadius="md" p={2}>
          {didLine}
        </Text>
      </Box>
      {policySlot ? (
        <Box borderWidth="1px" borderColor="gray.200" borderRadius="md" p={2.5}>
          <Text fontSize="2xs" color="gray.500" fontWeight="700" letterSpacing="0.05em">
            {isField ? "How this species follows its instructions" : "How this strategy follows its rules"}
          </Text>
          <Text fontSize="xs" color="gray.600" mt={1}>
            {isField ? "Prompt" : "Strategy rule"}: {prompt || "—"}
          </Text>
          {policySlot.status === "ready" ? (
            <VStack align="stretch" gap={1} mt={2}>
              {policySlot.ruleSummaries.map((summary, index) => (
                <Text key={`${policySlot.slotId}-${index}`} fontSize="xs" color="gray.700">
                  {index + 1}. {summary}
                </Text>
              ))}
              <Text fontSize="xs" color="gray.500">
                If none match, it chooses from what it noticed.
              </Text>
            </VStack>
          ) : (
            <Text fontSize="xs" color="orange.700" mt={2}>
              {policySlot.reason === "failed"
                ? `These rules were not ready for this run, so the ${isField ? "species" : "strategy"} chose from what it noticed.`
                : policySlot.reason === "compiling"
                  ? `These rules were still getting ready when the run started, so the ${isField ? "species" : "strategy"} chose from what it noticed.`
                  : `These rules were unavailable when the run started, so the ${isField ? "species" : "strategy"} chose from what it noticed.`}
            </Text>
          )}
        </Box>
      ) : null}
    </VStack>
  );
}

function CompareTab({
  spec,
  runs,
  selectedRunId,
  onSelectRun,
}: {
  spec: SimulatorSpec;
  runs: SimulatorRunListItem[];
  selectedRunId: WorkbenchRunId | null;
  onSelectRun: (runId: WorkbenchRunId) => void;
}) {
  const compared = useMemo(
    () =>
      runs
        .map((run) => ({
          run,
          outcome: runCompareDisplayValue(spec, run.criterionScores, run.currentMetrics, run.extinct),
        }))
        .filter(
          (entry): entry is { run: SimulatorRunListItem; outcome: { value: number; terminal: boolean } } =>
            entry.outcome !== null,
        ),
    [runs, spec],
  );
  const [pair, setPair] = useState<WorkbenchRunId[]>([]);

  const metricKey = criterionMetricKey(spec);

  if (compared.length === 0) {
    return (
      <Text fontSize="sm" color="gray.400" px={3} py={4}>
        finished runs plot here — one dot per run, grouped by deck version, so you
        can see when the same deck lands differently.
      </Text>
    );
  }

  const values = compared.map((entry) => entry.outcome.value);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const scored = compared.filter((entry) => !entry.outcome.terminal);
  const best =
    scored.length > 0
      ? scored.reduce(
          (bestValue, entry) =>
            isBetter(spec, entry.outcome.value, bestValue) ? entry.outcome.value : bestValue,
          scored[0].outcome.value,
        )
      : null;

  // Group by deck version for the dot strip rows.
  const byVersion = new Map<number, typeof compared>();
  for (const entry of compared) {
    const list = byVersion.get(entry.run.deckVersion) ?? [];
    list.push(entry);
    byVersion.set(entry.run.deckVersion, list);
  }
  const versions = [...byVersion.keys()].sort((a, b) => a - b);

  const selected = scored.find((entry) => entry.run._id === selectedRunId);
  const delta = selected && best !== null ? selected.outcome.value - best : 0;
  const deltaLabel =
    selected && best !== null
      ? isBetter(spec, selected.outcome.value, best)
        ? `new best`
        : selected.outcome.value === best
          ? `matches your best`
          : `${delta > 0 ? "+" : ""}${formatMetric(delta)} vs your best deck`
      : null;

  const toggle = (runId: WorkbenchRunId) => {
    setPair((current) =>
      current.includes(runId)
        ? current.filter((id) => id !== runId)
        : [...current, runId].slice(-2),
    );
    onSelectRun(runId);
  };

  const dotX = (value: number) => `${((value - min) / span) * 100}%`;

  return (
    <VStack align="stretch" gap={3} px={3} py={3}>
      {deltaLabel ? (
        <Box bg="violet.50" borderRadius="md" px={3} py={2}>
          <Text fontSize="sm" fontWeight="700" color="violet.700">
            {deltaLabel}
          </Text>
          <Text fontSize="2xs" color="gray.500">
            your result vs your own best — never a class ranking
          </Text>
        </Box>
      ) : null}

      <Box>
        <Text fontSize="2xs" color="gray.500" mb={1}>
          {metricKey ? metricLabel(metricKey) : "score"} · low {formatMetric(min)} → high {formatMetric(max)}
        </Text>
        {compared.some((entry) => entry.outcome.terminal) ? (
          <Text fontSize="2xs" color="orange.700" mb={1}>
            square dots are terminal outcomes: their final measured value is not a score.
          </Text>
        ) : null}
        <VStack align="stretch" gap={2}>
          {versions.map((version) => (
            <Box key={version}>
              <Text fontSize="2xs" color="gray.400" mb={0.5}>
                deck v{version}
              </Text>
              <Box position="relative" h="18px" bg="gray.50" borderRadius="full">
                {(byVersion.get(version) ?? []).map((entry) => {
                  const on = pair.includes(entry.run._id);
                  const { terminal, value } = entry.outcome;
                  const isBest = !terminal && value === best;
                  return (
                    <Box
                      key={entry.run._id}
                      role="button"
                      tabIndex={0}
                      aria-pressed={on}
                      aria-label={`${terminal ? "Terminal outcome, final measured value" : "Run scoring"} ${formatMetric(value)}${metricKey ? ` ${metricLabel(metricKey, value)}` : ""}, deck v${version}${terminal ? ", not a scored result" : ""}${on ? " (selected to compare)" : ""}`}
                      position="absolute"
                      left={dotX(value)}
                      top="50%"
                      transform="translate(-50%, -50%)"
                      w={on ? "16px" : "13px"}
                      h={on ? "16px" : "13px"}
                      borderRadius={terminal ? "2px" : "full"}
                      bg={terminal ? "orange.800" : isBest ? "violet.500" : "cyan.500"}
                      borderWidth={on ? "2px" : "0"}
                      borderColor="charcoal.600"
                      cursor="pointer"
                      title={`${terminal ? "Terminal outcome: " : ""}${formatMetric(value)}`}
                      onClick={() => toggle(entry.run._id)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" || event.key === " ") {
                          event.preventDefault();
                          toggle(entry.run._id);
                        }
                      }}
                      _focusVisible={{ outline: "2px solid", outlineColor: "violet.400", outlineOffset: "2px" }}
                      _dark={
                        terminal
                          ? { bg: "orange.400" }
                          : undefined
                      }
                    />
                  );
                })}
              </Box>
            </Box>
          ))}
        </VStack>
      </Box>

      {pair.length === 2 ? (
        <>
          <DeckDiff spec={spec} runIds={[pair[0], pair[1]]} />
          <CompareOverlay spec={spec} runs={runs.filter((run) => pair.includes(run._id))} />
        </>
      ) : (
        <Text fontSize="2xs" color="gray.400">
          tap two dots to overlay their runs and diff their prompt decks.
        </Text>
      )}
    </VStack>
  );
}

function DeckDiff({ spec, runIds }: { spec: SimulatorSpec; runIds: [WorkbenchRunId, WorkbenchRunId] }) {
  // The frozen prompt text lives on the detail projection (simulatorRuns.get),
  // fetched per selected run — the lean manifest omits it (review Finding 5).
  const runA = useWorkbenchRun(runIds[0]);
  const runB = useWorkbenchRun(runIds[1]);
  if (!runA?.deckSnapshot || !runB?.deckSnapshot) {
    return (
      <Text fontSize="2xs" color="gray.400">
        loading the two prompt decks…
      </Text>
    );
  }
  const bySlotA = new Map<string, DeckCard>(runA.deckSnapshot.map((card) => [card.slotId, card]));
  const bySlotB = new Map<string, DeckCard>(runB.deckSnapshot.map((card) => [card.slotId, card]));
  const changed = spec.speciesSlots.filter((slot) => {
    const a = bySlotA.get(slot.slotId);
    const b = bySlotB.get(slot.slotId);
    return a?.prompt !== b?.prompt || a?.count !== b?.count;
  });

  return (
    <Box>
      <Text fontSize="2xs" color="gray.500" fontWeight="700" mb={1}>
        deck diff · v{runA.deckVersion} → v{runB.deckVersion}
      </Text>
      {changed.length === 0 ? (
        <Text fontSize="2xs" color="gray.400">
          the two decks are identical — any score difference is luck, not your edit.
        </Text>
      ) : (
        <VStack align="stretch" gap={2}>
          {changed.map((slot) => {
            const a = bySlotA.get(slot.slotId);
            const b = bySlotB.get(slot.slotId);
            const tokens = wordDiff(a?.prompt ?? "", b?.prompt ?? "");
            return (
              <Box key={slot.slotId} bg="gray.50" borderRadius="md" p={2}>
                <Text fontSize="2xs" fontWeight="700" color="charcoal.600" mb={0.5}>
                  {slot.label}
                  {a?.count !== b?.count ? ` · count ${a?.count} → ${b?.count}` : ""}
                </Text>
                <Text fontSize="xs" lineHeight="1.5">
                  {tokens.map((token, index) => (
                    <Box
                      as="span"
                      key={index}
                      bg={token.kind === "added" ? "green.100" : token.kind === "removed" ? "red.100" : "transparent"}
                      color={token.kind === "removed" ? "red.700" : token.kind === "added" ? "green.800" : "gray.700"}
                      textDecoration={token.kind === "removed" ? "line-through" : undefined}
                    >
                      {token.text}
                    </Box>
                  ))}
                </Text>
              </Box>
            );
          })}
        </VStack>
      )}
    </Box>
  );
}

function CompareOverlay({ spec, runs }: { spec: SimulatorSpec; runs: SimulatorRunListItem[] }) {
  const metricKey = criterionMetricKey(spec);
  const palette = ["#7C3AED", "#0E7490"];
  const width = 236;
  const height = 70;

  const seriesFor = (run: SimulatorRunListItem) =>
    metricKey
      ? run.summarySeries
          .map((sample) => {
            const value = sample.values.find((candidate) => candidate.key === metricKey);
            return value ? { tick: sample.tick, value: value.value } : null;
          })
          .filter((point): point is { tick: number; value: number } => point !== null)
      : [];

  const all = runs.flatMap(seriesFor);
  if (all.length < 2) {
    return (
      <Text fontSize="2xs" color="gray.400">
        overlaid metric series appear once these runs have data.
      </Text>
    );
  }
  const maxTick = Math.max(...all.map((point) => point.tick), 1);
  const maxVal = Math.max(...all.map((point) => point.value), 1);
  const minVal = Math.min(...all.map((point) => point.value), 0);
  const valSpan = maxVal - minVal || 1;

  return (
    <Box>
      <Text fontSize="2xs" color="gray.500" fontWeight="700" mb={1}>
        {metricKey ? metricLabel(metricKey) : "metric"} over time
      </Text>
      <svg width={width} height={height}>
        {runs.map((run, index) => {
          const points = seriesFor(run)
            .map((point) => {
              const px = (point.tick / maxTick) * width;
              const py = height - ((point.value - minVal) / valSpan) * (height - 4) - 2;
              return `${px.toFixed(1)},${py.toFixed(1)}`;
            })
            .join(" ");
          return <polyline key={run._id} points={points} fill="none" stroke={palette[index % palette.length]} strokeWidth={1.6} />;
        })}
      </svg>
      <HStack gap={3} mt={1}>
        {runs.map((run, index) => (
          <HStack key={run._id} gap={1}>
            <Box w="8px" h="8px" borderRadius="full" bg={palette[index % palette.length]} />
            <Text fontSize="2xs" color="gray.600">
              v{run.deckVersion}{run.extinct ? " · terminal outcome" : ""}
            </Text>
          </HStack>
        ))}
      </HStack>
    </Box>
  );
}

export function InspectorPanel({
  spec,
  frame,
  run,
  runs,
  selectedRunId,
  onSelectRun,
  selectedAutomatonId,
  tab,
  onTabChange,
}: {
  spec: SimulatorSpec;
  frame: SceneFrame | null;
  run: SimulatorRun | null;
  runs: SimulatorRunListItem[];
  selectedRunId: WorkbenchRunId | null;
  onSelectRun: (runId: WorkbenchRunId) => void;
  selectedAutomatonId: string | null;
  tab: Tab;
  onTabChange: (tab: Tab) => void;
}) {
  return (
    <Flex flexDir="column" h="100%" minH={0} role="region" aria-label="Inspector">
      <HStack gap={0} px={3} pt={2} role="tablist" aria-label="Inspector tabs">
        {(["mind", "compare"] as Tab[]).map((option) => (
          <Button
            key={option}
            size="xs"
            flex={1}
            role="tab"
            aria-selected={tab === option}
            variant={tab === option ? "solid" : "ghost"}
            colorPalette="violet"
            borderRadius="md"
            onClick={() => onTabChange(option)}
          >
            {option === "mind" ? "Mind" : "Compare"}
          </Button>
        ))}
      </HStack>
      <Box flex={1} minH={0} overflowY="auto">
        {tab === "mind" ? (
          <MindTab
            spec={spec}
            frame={frame}
            run={run}
            selectedAutomatonId={selectedAutomatonId}
          />
        ) : (
          <CompareTab spec={spec} runs={runs} selectedRunId={selectedRunId} onSelectRun={onSelectRun} />
        )}
      </Box>
    </Flex>
  );
}
