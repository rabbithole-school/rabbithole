"use client";

/**
 * The publicGoods Form (see ../registry.ts). A publicGoods World is an
 * N-player repeated contribution pool: rounds/endowment/multiplier/noise are
 * config, the criterion is always measured over one of three group
 * objectives (never adversarial/gallery — validatePublicGoodsSpec rejects
 * anything else), and species slots model a population (1-5 slots, default
 * counts summing to 3 through config.maxAutomata) rather than the fixed
 * two-deck shape prisonersDilemma/matrixGame use. A one-slot "clone village"
 * (one shared prompt run by every player) is the common case and the
 * catalog's own example.
 */

import { Box, Button, HStack, Input, Stack, Text, Textarea } from "@chakra-ui/react";
import { Plus, Trash } from "@phosphor-icons/react";
import {
  COMPILED_POLICY_INTERPRETER_ID,
  type PublicGoodsConfig,
  type SpeciesSlot,
  type SimulatorSpec,
} from "@/lib/simulator/contract";
import { Label, NumField, SectionCard } from "./shared";
import {
  multiplierIssues,
  PUBLIC_GOODS_CRITERION_METRIC_KEYS,
  PUBLIC_GOODS_METRIC_LABEL,
  publicGoodsGoalSentence,
  totalDefaultCount,
  type PublicGoodsCriterionMetricKey,
} from "./publicGoodsHelpers";
import type { DeepWritable, SimulatorFormEntry, SimulatorFormProps, SimulatorTemplateMeta } from "./types";

const DIRECTION_LABEL: Record<string, string> = {
  maximize: "Maximize",
  minimize: "Minimize",
  target: "Hit a target",
};

export function defaultPublicGoodsSpec(templateMeta: SimulatorTemplateMeta): SimulatorSpec {
  return {
    version: 1,
    templateId: "publicGoods",
    templateVersion: templateMeta.version,
    config: {
      rounds: 30,
      endowmentPerRound: 10,
      multiplier: 2.4,
      noiseProbability: 0.05,
      maxAutomata: 6,
    },
    criterion: {
      kind: "measured",
      metricKey: "minScore",
      direction: "maximize",
    },
    speciesSlots: [
      {
        slotId: "villager",
        label: "Villagers",
        countMin: 3,
        countMax: 6,
        defaultCount: 6,
        senses: [{ senseId: "history" }],
        starterHint:
          "Write one contribution law that should work when every villager follows the same law.",
      },
    ],
    tickBudget: { iterationTicks: 5, seasonTicks: 30, absoluteMaxTicks: 30 },
    interpreter: {
      kind: "scripted",
      interpreterId: COMPILED_POLICY_INTERPRETER_ID,
    },
    microWorld: false,
  };
}

function PublicGoodsForm({ draft, limits, patch }: SimulatorFormProps) {
  if (draft.templateId !== "publicGoods") return null;
  const config = draft.config as PublicGoodsConfig;
  const rounds = config.rounds;
  const launchedPlayers = totalDefaultCount(draft.speciesSlots);
  const issues = multiplierIssues(config.multiplier, launchedPlayers);
  const metricKey = draft.criterion.metricKey as PublicGoodsCriterionMetricKey;
  const goalSentence = publicGoodsGoalSentence(draft.criterion.metricKey, draft.criterion.direction);

  return (
    <>
      {/* Criterion */}
      <SectionCard title="Criterion — the group goal">
        <Stack gap={3}>
          <HStack gap={2} flexWrap="wrap">
            {PUBLIC_GOODS_CRITERION_METRIC_KEYS.map((key) => (
              <Button
                key={key}
                size="xs"
                variant={metricKey === key ? "solid" : "outline"}
                bg={metricKey === key ? "violet.500" : "white"}
                color={metricKey === key ? "white" : "charcoal.500"}
                _hover={{ bg: metricKey === key ? "violet.600" : "gray.50" }}
                fontFamily="heading"
                onClick={() =>
                  patch((n) => {
                    if (n.criterion.kind === "measured") n.criterion.metricKey = key;
                  })
                }
              >
                {PUBLIC_GOODS_METRIC_LABEL[key]}
              </Button>
            ))}
          </HStack>
          <HStack gap={3} align="flex-end" flexWrap="wrap">
            <Box>
              <Label>Direction</Label>
              <select
                aria-label="Criterion direction"
                style={{
                  fontSize: "13px",
                  padding: "6px 8px",
                  borderRadius: "6px",
                  border: "1px solid #e2e8f0",
                  fontFamily: "var(--chakra-fonts-heading)",
                  background: "white",
                }}
                value={draft.criterion.direction}
                onChange={(e) =>
                  patch((n) => {
                    if (n.criterion.kind === "measured")
                      n.criterion.direction = e.target.value as "maximize" | "minimize" | "target";
                  })
                }
              >
                {(["maximize", "minimize", "target"] as const).map((d) => (
                  <option key={d} value={d}>
                    {DIRECTION_LABEL[d]}
                  </option>
                ))}
              </select>
            </Box>
            {draft.criterion.direction === "target" && (
              <NumField
                label="Target"
                value={draft.criterion.target ?? 0}
                onChange={(v) =>
                  patch((n) => {
                    if (n.criterion.kind === "measured") n.criterion.target = v;
                  })
                }
              />
            )}
          </HStack>
          <Text fontSize="xs" color="charcoal.500">
            Goal: <strong>{goalSentence}</strong>
          </Text>
        </Stack>
      </SectionCard>

      {/* Game parameters */}
      <SectionCard title="Game parameters">
        <Stack gap={3}>
          <HStack gap={3} flexWrap="wrap">
            <NumField
              label="Rounds"
              value={rounds}
              onChange={(v) => patch((n) => ((n.config as DeepWritable<PublicGoodsConfig>).rounds = v))}
              min={1}
              max={200}
              w="100px"
            />
            <NumField
              label="Endowment / round"
              value={config.endowmentPerRound}
              onChange={(v) =>
                patch((n) => ((n.config as DeepWritable<PublicGoodsConfig>).endowmentPerRound = v))
              }
              min={1}
              max={100}
              w="140px"
            />
            <NumField
              label="Multiplier"
              value={config.multiplier}
              onChange={(v) => patch((n) => ((n.config as DeepWritable<PublicGoodsConfig>).multiplier = v))}
              step={0.1}
              w="110px"
            />
            <NumField
              label="Noise probability"
              value={config.noiseProbability}
              onChange={(v) =>
                patch((n) => ((n.config as DeepWritable<PublicGoodsConfig>).noiseProbability = v))
              }
              step={0.01}
              min={0}
              max={1}
              w="140px"
            />
            <NumField
              label="Max automata"
              value={config.maxAutomata}
              onChange={(v) => patch((n) => ((n.config as DeepWritable<PublicGoodsConfig>).maxAutomata = v))}
              min={3}
              max={limits.maxAutomataPerRun}
              w="120px"
            />
          </HStack>
          <Text fontSize="2xs" color="charcoal.400">
            The multiplier must be greater than 1 and less than the number of players launched by
            default ({launchedPlayers}) — every player&apos;s pooled contribution is multiplied, then
            split evenly, so a multiplier at or above the player count would let contribution never
            lose value.
          </Text>
          {issues.length > 0 && (
            <Box borderWidth="1px" borderColor="amber.300" bg="amber.50" borderRadius="md" px={2} py={1.5}>
              <Stack gap={0.5}>
                {issues.map((issue) => (
                  <Text key={issue} fontSize="2xs" color="amber.700">
                    {issue}
                  </Text>
                ))}
              </Stack>
            </Box>
          )}
        </Stack>
      </SectionCard>

      {/* Budgets */}
      <SectionCard title="Budgets">
        <HStack gap={3} flexWrap="wrap">
          <NumField
            label="Iteration ticks"
            value={draft.tickBudget.iterationTicks}
            onChange={(v) => patch((n) => (n.tickBudget.iterationTicks = v))}
            min={1}
          />
          <NumField
            label="Season ticks"
            value={draft.tickBudget.seasonTicks}
            onChange={(v) => patch((n) => (n.tickBudget.seasonTicks = v))}
            min={1}
          />
          <NumField
            label="Absolute max"
            value={draft.tickBudget.absoluteMaxTicks}
            onChange={(v) => patch((n) => (n.tickBudget.absoluteMaxTicks = v))}
            min={1}
            max={rounds}
          />
        </HStack>
        <Text fontSize="2xs" color="charcoal.400" mt={2}>
          Season ≥ iteration, absolute max ≥ season, and absolute max ≤ rounds ({rounds}).
        </Text>
        {draft.tickBudget.absoluteMaxTicks > rounds && (
          <Text fontSize="2xs" color="amber.700" mt={1}>
            Absolute max ({draft.tickBudget.absoluteMaxTicks}) exceeds rounds ({rounds}) — lower one
            of them before saving.
          </Text>
        )}
      </SectionCard>

      {/* Population */}
      <SectionCard title={`Population — up to ${limits.maxSpeciesSlots} slots`}>
        <Stack gap={3}>
          <Text fontSize="2xs" color="charcoal.400">
            One slot runs a shared &quot;clone village&quot; prompt for every player in it. Add a second slot
            for a heterogeneous population — e.g. a few strategic villagers among many honest ones.
            Every slot perceives exactly the history Sense (fixed). Default counts must sum from 3
            through config.maxAutomata ({config.maxAutomata}); currently {launchedPlayers}.
          </Text>
          {draft.speciesSlots.map((slot, i) => (
            <PopulationSlotEditor
              key={i}
              slot={slot}
              canRemove={draft.speciesSlots.length > 1}
              onChange={(next) =>
                patch((n) => {
                  n.speciesSlots[i] = next as DeepWritable<SpeciesSlot>;
                })
              }
              onRemove={() => patch((n) => n.speciesSlots.splice(i, 1))}
            />
          ))}
          {draft.speciesSlots.length < limits.maxSpeciesSlots && (
            <Button
              size="sm"
              variant="outline"
              borderColor="gray.200"
              color="charcoal.500"
              fontFamily="heading"
              onClick={() =>
                patch((n) =>
                  n.speciesSlots.push({
                    slotId: `population_${n.speciesSlots.length + 1}`,
                    label: "New population",
                    countMin: 0,
                    countMax: 2,
                    defaultCount: 0,
                    senses: [{ senseId: "history" }],
                  }),
                )
              }
            >
              <Plus size={14} style={{ marginRight: 4 }} /> Add population slot
            </Button>
          )}
        </Stack>
      </SectionCard>
    </>
  );
}

function PopulationSlotEditor({
  slot,
  canRemove,
  onChange,
  onRemove,
}: {
  slot: SpeciesSlot;
  canRemove: boolean;
  onChange: (next: SpeciesSlot) => void;
  onRemove: () => void;
}) {
  const set = (mut: (s: DeepWritable<SpeciesSlot>) => void) => {
    const next = structuredClone(slot) as DeepWritable<SpeciesSlot>;
    mut(next);
    onChange(next as SpeciesSlot);
  };

  return (
    <Box borderWidth="1px" borderColor="gray.200" borderRadius="md" bg="gray.50" p={3}>
      <HStack justify="space-between" align="flex-start" gap={3}>
        <Stack gap={2} flex={1}>
          <HStack gap={3} flexWrap="wrap">
            <Box>
              <Label>Slot id</Label>
              <Input aria-label="Population slot id" size="xs" value={slot.slotId} onChange={(e) => set((s) => (s.slotId = e.target.value))} w="130px" fontFamily="heading" borderColor="gray.200" />
            </Box>
            <Box>
              <Label>Label</Label>
              <Input aria-label="Population label" size="xs" value={slot.label} onChange={(e) => set((s) => (s.label = e.target.value))} w="150px" fontFamily="heading" borderColor="gray.200" />
            </Box>
          </HStack>
          <HStack gap={3} flexWrap="wrap">
            <NumField label="Min" value={slot.countMin} onChange={(v) => set((s) => (s.countMin = v))} min={0} w="70px" />
            <NumField label="Max" value={slot.countMax} onChange={(v) => set((s) => (s.countMax = v))} min={0} w="70px" />
            <NumField label="Default" value={slot.defaultCount} onChange={(v) => set((s) => (s.defaultCount = v))} min={0} w="80px" />
          </HStack>
          <Box>
            <Label>Starter hint (optional)</Label>
            <Textarea
              aria-label={`${slot.label} starter hint`}
              size="xs"
              rows={2}
              value={slot.starterHint ?? ""}
              onChange={(e) => set((s) => (s.starterHint = e.target.value || undefined))}
              fontFamily="body"
              fontSize="xs"
              borderColor="gray.200"
            />
          </Box>
        </Stack>
        {canRemove && (
          <Button
            aria-label={`Remove ${slot.label} population slot`}
            size="xs"
            variant="ghost"
            color="red.400"
            onClick={onRemove}
          >
            <Trash size={14} />
          </Button>
        )}
      </HStack>
    </Box>
  );
}

export const PUBLIC_GOODS_FORM: SimulatorFormEntry = {
  templateId: "publicGoods",
  startLabel: "Start from public-goods",
  defaultSpec: defaultPublicGoodsSpec,
  Form: PublicGoodsForm,
};
