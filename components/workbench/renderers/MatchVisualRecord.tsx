"use client";

import { useMemo, useState } from "react";
import { Box, Button, Flex, Grid, HStack, Text, VStack } from "@chakra-ui/react";

import type { SimulatorSpec } from "@/lib/simulator/contract";
import type {
  WorkbenchMatchRoundEvidence,
} from "@/lib/simulator/scene";
import { matchVisualModel } from "@/lib/simulator/workbenchVisuals";
import {
  disambiguatedActorLabels,
  formatDecisionSource,
  matchPayoffMatrix,
} from "./evidence";

const ACTOR_COLORS = ["#172033", "#DB2777"] as const;
const ACTION_COLORS = ["#16815E", "#D96D38", "#2879BD", "#8F4AA3"] as const;
const CHART_WIDTH = 720;
const CHART_HEIGHT = 150;
const CHART_PADDING = 12;

function specActorLabels(
  spec: Extract<SimulatorSpec, { templateId: "prisonersDilemma" | "matrixGame" }>,
): readonly string[] {
  return spec.speciesSlots
    .flatMap((slot) =>
      Array.from({ length: slot.defaultCount }, (_, index) =>
        slot.defaultCount > 1 ? `${slot.label} ${index + 1}` : slot.label,
      ),
    )
    .slice(0, 2);
}

function actionColor(actionId: string, actionIds: readonly string[]): string {
  const index = Math.max(0, actionIds.indexOf(actionId));
  return ACTION_COLORS[index % ACTION_COLORS.length];
}

function MatchPayoffTable({
  spec,
  selectedRound,
}: {
  spec: Extract<SimulatorSpec, { templateId: "prisonersDilemma" | "matrixGame" }>;
  selectedRound: WorkbenchMatchRoundEvidence | undefined;
}) {
  const matrix = matchPayoffMatrix(spec);
  const payoffOwners = selectedRound
    ? disambiguatedActorLabels(selectedRound.actors)
    : specActorLabels(spec);
  return (
    <Box overflowX="auto">
      <Text fontSize="2xs" color="gray.500" mb={2}>
        Each cell lists {payoffOwners[0] ?? "the first strategy"} first, then{" "}
        {payoffOwners[1] ?? "the second strategy"}.
      </Text>
      <Grid
        minW="420px"
        gridTemplateColumns={`minmax(130px, 1fr) repeat(${matrix.columnActions.length}, minmax(100px, 1fr))`}
        borderTopWidth="1px"
        borderLeftWidth="1px"
        borderColor="gray.200"
        role="table"
        aria-label="Payoff table"
      >
        <Box px={3} py={2} bg="gray.50" borderRightWidth="1px" borderBottomWidth="1px" borderColor="gray.200" role="columnheader">
          <Text fontSize="2xs" color="gray.500" fontWeight="700">Row / column action</Text>
        </Box>
        {matrix.columnActions.map((action) => (
          <Box key={action.id} px={3} py={2} bg="gray.50" borderRightWidth="1px" borderBottomWidth="1px" borderColor="gray.200" role="columnheader">
            <Text fontSize="2xs" color="gray.500" fontWeight="700">{action.label}</Text>
          </Box>
        ))}
        {matrix.rowActions.flatMap((row) => [
          <Box key={`${row.id}:label`} px={3} py={2.5} borderRightWidth="1px" borderBottomWidth="1px" borderColor="gray.200" role="rowheader">
            <Text fontSize="xs" color="charcoal.600" fontWeight="700">{row.label}</Text>
          </Box>,
          ...matrix.columnActions.map((column) => {
            const cell = matrix.cells.find(
              (candidate) =>
                candidate.rowActionId === row.id &&
                candidate.columnActionId === column.id,
            );
            const selected =
              selectedRound?.actors[0]?.actionId === row.id &&
              selectedRound.actors[1]?.actionId === column.id;
            return (
              <Box
                key={`${row.id}:${column.id}`}
                px={3}
                py={2.5}
                borderRightWidth="1px"
                borderBottomWidth="1px"
                borderColor={selected ? "charcoal.400" : "gray.200"}
                bg={selected ? "violet.50" : "white"}
                boxShadow={selected ? "inset 0 0 0 1px var(--chakra-colors-violet-500)" : undefined}
                role="cell"
              >
                <Text fontSize="xs" color="gray.700" fontWeight={selected ? "700" : "500"}>
                  {cell ? `${cell.rowPayoff}, ${cell.columnPayoff}` : "Not available"}
                </Text>
              </Box>
            );
          }),
        ])}
      </Grid>
    </Box>
  );
}

function ActionRibbon({
  evidence,
  totalRounds,
  selectedRound,
  onSelectRound,
  onSelectActor,
}: {
  evidence: readonly WorkbenchMatchRoundEvidence[];
  totalRounds: number;
  selectedRound: number;
  onSelectRound: (round: number) => void;
  onSelectActor: (id: string) => void;
}) {
  const model = useMemo(() => matchVisualModel(evidence), [evidence]);
  const actionIds = model.actions.map((action) => action.id);
  const labels = disambiguatedActorLabels(model.actors);
  const hasFractures = model.actors.some((actor) =>
    actor.actions.some((action) => action.misperceived),
  );
  return (
    <VStack align="stretch" gap={3}>
      <HStack gap={4} flexWrap="wrap" aria-label="Action colors">
        {model.actions.map((action) => (
          <HStack key={action.id} gap={1.5}>
            <Box w="10px" h="10px" borderRadius="2px" bg={actionColor(action.id, actionIds)} />
            <Text fontSize="2xs" color="gray.600">{action.label}</Text>
          </HStack>
        ))}
        {hasFractures ? (
          <HStack gap={1.5}>
            <Box w="9px" h="9px" bg="red.500" transform="rotate(45deg)" borderRadius="1px" />
            <Text fontSize="2xs" color="gray.600">Read differed from reality</Text>
          </HStack>
        ) : null}
      </HStack>
      <Box overflowX="auto" pb={1}>
        <VStack align="stretch" gap={2} minW={`${Math.max(560, totalRounds * 22 + 124)}px`}>
          {model.actors.map((actor, actorIndex) => (
            <Grid key={actor.id} gridTemplateColumns="116px 1fr" gap={2} alignItems="center">
              <Button
                size="xs"
                variant="plain"
                justifyContent="flex-start"
                px={0}
                color="charcoal.600"
                onClick={() => onSelectActor(actor.id)}
              >
                {labels[actorIndex]}
              </Button>
              <Grid
                gridTemplateColumns={`repeat(${Math.max(1, totalRounds)}, minmax(18px, 1fr))`}
                gap="2px"
                role="list"
                aria-label={`${labels[actorIndex]} action ribbon`}
              >
                {actor.actions.map((action) => (
                  <Button
                    key={action.round}
                    minW={0}
                    h="28px"
                    p={0}
                    borderRadius="3px"
                    bg={actionColor(action.actionId, actionIds)}
                    borderWidth={action.round === selectedRound ? "2px" : "0"}
                    borderColor="charcoal.900"
                    position="relative"
                    aria-label={`Round ${action.round}: ${labels[actorIndex]} chose ${action.actionLabel}${action.misperceived ? "; read differed from reality" : ""}`}
                    onClick={() => onSelectRound(action.round)}
                    _hover={{ filter: "brightness(.94)" }}
                    _focusVisible={{ outline: "2px solid", outlineColor: "violet.500", outlineOffset: "2px" }}
                  >
                    {action.misperceived ? (
                      <Box
                        position="absolute"
                        top="-4px"
                        right="-3px"
                        w="8px"
                        h="8px"
                        bg="red.500"
                        border="1px solid white"
                        transform="rotate(45deg)"
                        borderRadius="1px"
                      />
                    ) : null}
                  </Button>
                ))}
              </Grid>
            </Grid>
          ))}
        </VStack>
      </Box>
    </VStack>
  );
}

function ScoreTrajectory({
  spec,
  evidence,
  selectedRound,
  totalRounds,
}: {
  spec: Extract<SimulatorSpec, { templateId: "prisonersDilemma" | "matrixGame" }>;
  evidence: readonly WorkbenchMatchRoundEvidence[];
  selectedRound: number;
  totalRounds: number;
}) {
  const model = useMemo(() => matchVisualModel(evidence), [evidence]);
  const roundCount = Math.max(1, totalRounds);
  const payoffValues = matchPayoffMatrix(spec).cells.flatMap((cell) => [
    cell.rowPayoff,
    cell.columnPayoff,
  ]);
  const min = Math.min(0, ...payoffValues) * roundCount;
  const max = Math.max(1 / roundCount, ...payoffValues) * roundCount;
  const span = max - min || 1;
  const x = (round: number) =>
    CHART_PADDING +
    ((round - 1) / Math.max(1, roundCount - 1)) *
      (CHART_WIDTH - CHART_PADDING * 2);
  const y = (value: number) =>
    CHART_HEIGHT -
    CHART_PADDING -
    ((value - min) / span) * (CHART_HEIGHT - CHART_PADDING * 2);
  return (
    <Box>
      <Text fontSize="2xs" color="gray.500" fontWeight="700" mb={1}>
        Cumulative payoff
      </Text>
      <Box asChild w="full" h="150px">
        <svg
          viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`}
          role="img"
          aria-label="Cumulative payoff trajectory"
        >
          {[0.25, 0.5, 0.75].map((portion) => (
            <line
              key={portion}
              x1={CHART_PADDING}
              x2={CHART_WIDTH - CHART_PADDING}
              y1={CHART_PADDING + portion * (CHART_HEIGHT - CHART_PADDING * 2)}
              y2={CHART_PADDING + portion * (CHART_HEIGHT - CHART_PADDING * 2)}
              stroke="#E4E7EC"
              strokeWidth="1"
            />
          ))}
          {model.actors.map((actor, actorIndex) => {
            const tied =
              actorIndex > 0 &&
              model.actors.every((candidate) =>
                candidate.actions.every(
                  (action, index) =>
                    action.cumulativeTotal === actor.actions[index]?.cumulativeTotal,
                ),
              );
            return (
              <polyline
                key={actor.id}
                points={actor.actions
                  .map((action) => `${x(action.round)},${y(action.cumulativeTotal)}`)
                  .join(" ")}
                fill="none"
                stroke={ACTOR_COLORS[actorIndex % ACTOR_COLORS.length]}
                strokeWidth="3"
                strokeDasharray={tied ? "8 5" : undefined}
              />
            );
          })}
          <line
            x1={x(selectedRound)}
            x2={x(selectedRound)}
            y1={4}
            y2={CHART_HEIGHT - 4}
            stroke="#172033"
            strokeWidth="2"
          />
        </svg>
      </Box>
      <HStack gap={4} flexWrap="wrap">
        {disambiguatedActorLabels(model.actors).map((label, index) => (
          <HStack key={model.actors[index]?.id ?? label} gap={1.5}>
            <Box w="18px" h="3px" bg={ACTOR_COLORS[index % ACTOR_COLORS.length]} />
            <Text fontSize="2xs" color="gray.600">{label}</Text>
          </HStack>
        ))}
      </HStack>
    </Box>
  );
}

function SelectedRoundLens({
  round,
  totalRounds,
  onSelectActor,
}: {
  round: WorkbenchMatchRoundEvidence;
  totalRounds: number;
  onSelectActor: (id: string) => void;
}) {
  const labels = disambiguatedActorLabels(round.actors);
  return (
    <Box bg="navy.700" color="white" borderRadius="xl" p={4}>
      <Text fontSize="2xs" color="cyan.200" fontWeight="800" letterSpacing=".08em">
        ROUND {round.round} OF {totalRounds}
      </Text>
      <VStack align="stretch" gap={3} mt={3}>
        {round.actors.map((actor, index) => (
          <Box key={actor.id} bg="whiteAlpha.100" borderRadius="lg" p={3}>
            <Flex justify="space-between" align="start" gap={3}>
              <Button
                size="xs"
                variant="plain"
                color="white"
                px={0}
                h="auto"
                minH="auto"
                justifyContent="flex-start"
                onClick={() => onSelectActor(actor.id)}
              >
                {labels[index]}
              </Button>
              <Text fontSize="xs" fontWeight="700">{actor.actionLabel}</Text>
            </Flex>
            <Text fontSize="2xs" color="whiteAlpha.800">
              +{actor.roundPayoff} this round · {actor.cumulativeTotal} total
            </Text>
            <Text fontSize="2xs" color="whiteAlpha.800" mt={2}>
              Read after this round: {actor.perception.sawOpponentActionLabel}
              {actor.perception.misperceived
                ? ` · actual ${actor.perception.actualOpponentActionLabel}`
                : ""}
            </Text>
            {actor.perception.misperceived ? (
              <Text fontSize="2xs" color="orange.200" mt={1}>
                This read can inform round {round.round + 1}, not the action already taken.
              </Text>
            ) : null}
            {actor.detailsRedacted ? (
              <Text fontSize="2xs" color="whiteAlpha.700" mt={2}>
                Opponent strategy details are private.
              </Text>
            ) : (
              <Text fontSize="2xs" color="whiteAlpha.700" mt={2}>
                {formatDecisionSource(actor.decisionSource)}
                {actor.policyRuleId ? ` · ${actor.policyRuleId}` : ""}
                {actor.policyTrace ? ` — ${actor.policyTrace}` : ""}
              </Text>
            )}
          </Box>
        ))}
      </VStack>
    </Box>
  );
}

function ResponseMatrix({
  actorId,
  evidence,
}: {
  actorId: string;
  evidence: readonly WorkbenchMatchRoundEvidence[];
}) {
  const model = useMemo(() => matchVisualModel(evidence), [evidence]);
  const actor = model.actors.find((candidate) => candidate.id === actorId);
  if (!actor || model.actions.length === 0) return null;
  const maxCount = Math.max(1, ...actor.responseCounts.map((entry) => entry.count));
  return (
    <Box>
      <Text fontSize="2xs" color="gray.500" fontWeight="800" mb={2}>
        WHAT I DID NEXT, AFTER WHAT I SAW
      </Text>
      <Grid
        gridTemplateColumns={`minmax(100px, .8fr) repeat(${model.actions.length}, minmax(84px, 1fr))`}
        borderTopWidth="1px"
        borderLeftWidth="1px"
        borderColor="gray.200"
      >
        <Box bg="gray.50" borderRightWidth="1px" borderBottomWidth="1px" borderColor="gray.200" />
        {model.actions.map((action) => (
          <Box key={action.id} px={2} py={2} bg="gray.50" borderRightWidth="1px" borderBottomWidth="1px" borderColor="gray.200">
            <Text fontSize="2xs" color="gray.600" textAlign="center">Saw {action.label.toLowerCase()}</Text>
          </Box>
        ))}
        {model.actions.flatMap((nextAction) => [
          <Flex key={`${nextAction.id}:label`} px={2} py={2} minH="84px" align="center" borderRightWidth="1px" borderBottomWidth="1px" borderColor="gray.200">
            <Text fontSize="2xs" color="gray.600">Then {nextAction.label.toLowerCase()}</Text>
          </Flex>,
          ...model.actions.map((sawAction) => {
            const count =
              actor.responseCounts.find(
                (entry) =>
                  entry.sawActionId === sawAction.id &&
                  entry.nextActionId === nextAction.id,
              )?.count ?? 0;
            const diameter = count === 0 ? 0 : 18 + Math.sqrt(count / maxCount) * 44;
            return (
              <Flex key={`${nextAction.id}:${sawAction.id}`} minH="84px" align="center" justify="center" borderRightWidth="1px" borderBottomWidth="1px" borderColor="gray.200">
                {count > 0 ? (
                  <Flex
                    w={`${diameter}px`}
                    h={`${diameter}px`}
                    borderRadius="full"
                    align="center"
                    justify="center"
                    bg="violet.100"
                    color="violet.800"
                    fontSize="sm"
                    fontWeight="800"
                    aria-label={`${count} times`}
                  >
                    {count}
                  </Flex>
                ) : (
                  <Text fontSize="2xs" color="gray.400">0</Text>
                )}
              </Flex>
            );
          }),
        ])}
      </Grid>
    </Box>
  );
}

function RuleBands({
  actorId,
  evidence,
  selectedRound,
  totalRounds,
}: {
  actorId: string;
  evidence: readonly WorkbenchMatchRoundEvidence[];
  selectedRound: number;
  totalRounds: number;
}) {
  const actor = useMemo(
    () => matchVisualModel(evidence).actors.find((candidate) => candidate.id === actorId),
    [actorId, evidence],
  );
  if (actor?.detailsRedacted) {
    return (
      <Box>
        <Text fontSize="2xs" color="gray.500" fontWeight="800">WHICH RULE FIRED</Text>
        <Text fontSize="xs" color="gray.500" mt={2}>Opponent strategy details are private.</Text>
      </Box>
    );
  }
  if (!actor || actor.ruleBands.length === 0) {
    return (
      <Box>
        <Text fontSize="2xs" color="gray.500" fontWeight="800">WHICH RULE FIRED</Text>
        <Text fontSize="xs" color="gray.500" mt={2}>No visible compiled-rule trace for this strategy.</Text>
      </Box>
    );
  }
  return (
    <Box>
      <Text fontSize="2xs" color="gray.500" fontWeight="800" mb={2}>
        WHICH RULE FIRED
      </Text>
      <VStack align="stretch" gap={2}>
        {actor.ruleBands.map((band) => {
          const active = new Set(band.rounds);
          return (
            <Grid key={band.id} gridTemplateColumns="minmax(110px, 150px) 1fr" gap={3} alignItems="center">
              <Text fontSize="2xs" color="gray.600" lineClamp={2}>{band.label}</Text>
              <Grid
                gridTemplateColumns={`repeat(${Math.max(1, totalRounds)}, minmax(2px, 1fr))`}
                gap="2px"
                h="18px"
                aria-label={`${band.label} activation band`}
              >
                {Array.from({ length: totalRounds }, (_, index) => index + 1).map((round) => (
                  <Box
                    key={round}
                    bg={
                      active.has(round)
                        ? band.kind === "fallback"
                          ? "gray.300"
                          : "violet.500"
                        : "gray.100"
                    }
                    backgroundImage={
                      active.has(round) && band.kind === "fallback"
                        ? "repeating-linear-gradient(135deg, #98A2B3 0 3px, #EAECF0 3px 6px)"
                        : undefined
                    }
                    borderRadius="2px"
                    outline={round === selectedRound ? "1px solid #172033" : undefined}
                    aria-label={`Round ${round}${active.has(round) ? ": active" : ": inactive"}`}
                  />
                ))}
              </Grid>
            </Grid>
          );
        })}
      </VStack>
    </Box>
  );
}

export function MatchVisualRecord({
  spec,
  evidence,
  tick,
  totalRounds,
  onSelectActor,
  onSelectRound,
}: {
  spec: Extract<SimulatorSpec, { templateId: "prisonersDilemma" | "matrixGame" }>;
  evidence: readonly WorkbenchMatchRoundEvidence[];
  tick: number;
  totalRounds: number;
  onSelectActor: (id: string) => void;
  onSelectRound: (round: number) => void;
}) {
  const selectedRound = evidence.find((round) => round.round === tick) ?? evidence.at(-1);
  const model = useMemo(() => matchVisualModel(evidence), [evidence]);
  const [shapeActorId, setShapeActorId] = useState<string | null>(null);
  const activeShapeActorId =
    model.actors.some((actor) => actor.id === shapeActorId)
      ? shapeActorId!
      : model.actors.find((actor) => actor.ruleBands.length > 0)?.id ??
        model.actors[0]?.id ??
        "";
  const actorLabels = disambiguatedActorLabels(model.actors);

  if (!selectedRound) {
    return (
      <Flex flex={1} align="center" justify="center" px={4}>
        <Text fontSize="sm" color="gray.500">Rounds will appear as this match begins.</Text>
      </Flex>
    );
  }

  return (
    <Box flex={1} minH={0} overflowY="auto" bg="white">
      <VStack align="stretch" gap={5} px={{ base: 3, md: 5 }} py={4}>
        <Box>
          <Text fontSize="sm" fontWeight="800" color="charcoal.600">The match line</Text>
          <Text fontSize="xs" color="gray.500" mb={3}>
            Tap any mark to inspect that exact round.
          </Text>
          <ActionRibbon
            evidence={evidence}
            totalRounds={totalRounds}
            selectedRound={selectedRound.round}
            onSelectRound={onSelectRound}
            onSelectActor={onSelectActor}
          />
        </Box>

        <Grid gridTemplateColumns={{ base: "1fr", xl: "minmax(0, 1.7fr) minmax(250px, .8fr)" }} gap={4}>
          <ScoreTrajectory
            spec={spec}
            evidence={evidence}
            selectedRound={selectedRound.round}
            totalRounds={totalRounds}
          />
          <SelectedRoundLens
            round={selectedRound}
            totalRounds={totalRounds}
            onSelectActor={onSelectActor}
          />
        </Grid>

        <Box borderTopWidth="1px" borderColor="gray.200" pt={5}>
          <Flex justify="space-between" align={{ base: "start", md: "center" }} direction={{ base: "column", md: "row" }} gap={3} mb={4}>
            <Box>
              <Text fontSize="sm" fontWeight="800" color="charcoal.600">Strategy shape</Text>
              <Text fontSize="xs" color="gray.500">The pattern is shown; what it means is still yours to explain.</Text>
            </Box>
            <HStack gap={2} flexWrap="wrap">
              {model.actors.map((actor, index) => (
                <Button
                  key={actor.id}
                  size="xs"
                  variant={actor.id === activeShapeActorId ? "solid" : "outline"}
                  colorPalette="violet"
                  onClick={() => setShapeActorId(actor.id)}
                >
                  {actorLabels[index]}
                </Button>
              ))}
            </HStack>
          </Flex>
          <Grid gridTemplateColumns={{ base: "1fr", xl: "minmax(300px, .8fr) minmax(0, 1.2fr)" }} gap={5}>
            <ResponseMatrix actorId={activeShapeActorId} evidence={evidence} />
            <RuleBands
              actorId={activeShapeActorId}
              evidence={evidence}
              selectedRound={selectedRound.round}
              totalRounds={totalRounds}
            />
          </Grid>
        </Box>

        <Box borderTopWidth="1px" borderColor="gray.200" pt={5} pb={3}>
          <Text fontSize="sm" fontWeight="800" color="charcoal.600" mb={2}>Payoff table</Text>
          <MatchPayoffTable spec={spec} selectedRound={selectedRound} />
        </Box>
      </VStack>
    </Box>
  );
}
