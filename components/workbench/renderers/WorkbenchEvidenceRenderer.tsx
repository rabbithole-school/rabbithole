"use client";

import { Box, Button, Flex, Text } from "@chakra-ui/react";

import type { SimulatorSpec } from "@/lib/simulator/contract";
import type {
  SceneFrame,
  WorkbenchCommonsRoundEvidence,
  WorkbenchMatchRoundEvidence,
} from "@/lib/simulator/scene";
import { commonsPotModel } from "@/lib/simulator/workbenchVisuals";
import { formatMetric } from "@/lib/simulator/helpers";
import { disambiguatedActorLabels } from "./evidence";
import { MatchVisualRecord } from "./MatchVisualRecord";

function CommonsPot({
  round,
  multiplier,
  endowment,
  onSelectAutomaton,
}: {
  round: WorkbenchCommonsRoundEvidence;
  multiplier: number;
  endowment: number;
  onSelectAutomaton: (id: string) => void;
}) {
  const labels = disambiguatedActorLabels(round.actors);
  const pot = commonsPotModel({ round, endowment, multiplier, labels });
  return (
    <Flex direction="column" gap={4} px={{ base: 3, md: 5 }} py={4}>
      <Flex align="baseline" justify="space-between" gap={3}>
        <Text fontSize="sm" fontWeight="700" color="charcoal.600">Round {pot.round}</Text>
        <Text fontSize="xs" color="gray.600">{pot.contributors}/{pot.players} put something in</Text>
      </Flex>
      <Flex direction={{ base: "column", lg: "row" }} align={{ lg: "center" }} gap={3}>
        <Flex flex={1} gap={2} wrap="wrap" align="center">
          {pot.actors.map((actor) => (
            <Button
              key={actor.id}
              size="xs"
              variant="outline"
              borderColor={actor.contributed > 0 ? "green.400" : "gray.300"}
              color={actor.contributed > 0 ? "green.700" : "gray.600"}
              onClick={() => onSelectAutomaton(actor.id)}
            >
              {actor.label} {actor.contributed > 0
                ? `+${formatMetric(actor.contributed)}`
                : `kept ${formatMetric(actor.kept)}`}
            </Button>
          ))}
        </Flex>
        <Box minW={{ lg: "170px" }} px={4} py={3} borderRadius="lg" bg="violet.50" border="1px solid" borderColor="violet.200" textAlign="center">
          <Text fontSize="2xs" fontWeight="700" color="violet.700">COMMON POT</Text>
          <Text fontSize="lg" fontWeight="800" color="violet.800">
            {formatMetric(pot.inputPool)} × {formatMetric(pot.multiplier)} = {formatMetric(pot.grownPool)}
          </Text>
        </Box>
        <Flex flex={1} gap={2} wrap="wrap" justify={{ lg: "flex-end" }}>
          {pot.actors.map((actor) => (
            <Button key={actor.id} size="xs" variant="subtle" colorPalette="violet" onClick={() => onSelectAutomaton(actor.id)}>
              {actor.label} gets {formatMetric(actor.share)} → {formatMetric(actor.payoff)}
            </Button>
          ))}
        </Flex>
      </Flex>
      <Box pt={3} borderTop="1px solid" borderColor="gray.200">
        <Text fontSize="2xs" fontWeight="700" color="gray.600" mb={2}>What each player read after this round</Text>
        <Flex gap={2} wrap="wrap">
          {pot.actors.map((actor) => (
            <Button
              key={actor.id}
              size="xs"
              variant="plain"
              px={1}
              color={actor.misperceived ? "orange.700" : "gray.700"}
              onClick={() => onSelectAutomaton(actor.id)}
            >
              {actor.label}: saw {actor.perceivedContributorCount}, actually {actor.actualContributorCount}
            </Button>
          ))}
        </Flex>
      </Box>
    </Flex>
  );
}

function CommonsRecord({
  spec,
  evidence,
  tick,
  onSelectAutomaton,
  onSelectRound,
}: {
  spec: Extract<SimulatorSpec, { templateId: "publicGoods" }>;
  evidence: readonly WorkbenchCommonsRoundEvidence[];
  tick: number;
  onSelectAutomaton: (id: string) => void;
  onSelectRound: (round: number) => void;
}) {
  const currentRound = evidence.find((round) => round.round === tick);
  return (
    <Flex direction="column" h="100%" minH={0}>
      <Box px={{ base: 3, md: 5 }} py={4} borderBottom="1px solid" borderColor="gray.200">
        <Text fontSize="sm" fontWeight="700" color="charcoal.600">
          Pot rule
        </Text>
        <Text fontSize="xs" color="gray.600">
          Each player starts with {spec.config.endowmentPerRound}. Contributions are multiplied by {spec.config.multiplier} and split evenly among players.
        </Text>
      </Box>
      {currentRound ? (
        <CommonsPot
          round={currentRound}
          multiplier={spec.config.multiplier}
          endowment={spec.config.endowmentPerRound}
          onSelectAutomaton={onSelectAutomaton}
        />
      ) : (
        <Text px={{ base: 3, md: 5 }} py={4} fontSize="sm" color="gray.500">
          No completed rounds in this pot yet.
        </Text>
      )}
      <Box px={{ base: 3, md: 5 }} py={3} borderTop="1px solid" borderColor="gray.200">
        <Text fontSize="2xs" fontWeight="700" color="gray.600" mb={2}>Completed rounds</Text>
        <Flex gap={2} wrap="wrap">
          {evidence.map((round) => (
            <Button
              key={round.round}
              size="xs"
              variant={round.round === currentRound?.round ? "solid" : "outline"}
              colorPalette="violet"
              onClick={() => onSelectRound(round.round)}
            >
              {round.round}
            </Button>
          ))}
        </Flex>
      </Box>
    </Flex>
  );
}

export function WorkbenchEvidenceRenderer({
  spec,
  frame,
  tick,
  onSelectAutomaton,
  hasRun,
  onSelectRound,
  runStatus,
  totalRounds,
}: {
  spec: Exclude<SimulatorSpec, { templateId: "ecosystemGrid" }>;
  frame: SceneFrame | null;
  tick: number;
  onSelectAutomaton: (id: string) => void;
  hasRun: boolean;
  onSelectRound: (round: number) => void;
  runStatus: "queued" | "ticking" | "completed" | "halted" | "crashed" | null;
  totalRounds: number;
}) {
  const finished = runStatus === "completed" || runStatus === "halted" || runStatus === "crashed";
  if (!frame && hasRun) {
    return (
      <Flex flex={1} align="center" justify="center" px={4} bg="white">
        <Text fontSize="sm" color="gray.500">
          {finished ? "Round evidence is unavailable for this run." : "Round evidence is loading."}
        </Text>
      </Flex>
    );
  }

  const evidence = frame?.workbenchRoundEvidence;
  if (hasRun && !evidence) {
    return (
      <Flex flex={1} align="center" justify="center" px={4} bg="white">
        <Text fontSize="sm" color="gray.500">
          {finished ? "Round evidence is unavailable for this run." : "Round evidence is loading."}
        </Text>
      </Flex>
    );
  }

  if (spec.templateId === "publicGoods") {
    return (
      <Box flex={1} minH={0} minW={0} bg="white" borderRight="1px solid" borderColor="gray.200">
        <CommonsRecord
          spec={spec}
          evidence={(evidence ?? []).filter((round): round is WorkbenchCommonsRoundEvidence => round.kind === "commons")}
          tick={tick}
          onSelectAutomaton={onSelectAutomaton}
          onSelectRound={onSelectRound}
        />
      </Box>
    );
  }

  return (
    <Box flex={1} minH={0} minW={0} bg="white" borderRight="1px solid" borderColor="gray.200">
      <MatchVisualRecord
        spec={spec}
        evidence={(evidence ?? []).filter((round): round is WorkbenchMatchRoundEvidence => round.kind === "match")}
        tick={tick}
        totalRounds={totalRounds}
        onSelectActor={onSelectAutomaton}
        onSelectRound={onSelectRound}
      />
    </Box>
  );
}
