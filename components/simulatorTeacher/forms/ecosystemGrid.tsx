"use client";

/**
 * The ecosystemGrid Form — the ORIGINAL SimulatorSpecEditor fields, extracted
 * into the per-template form registry (see ../registry.ts) unchanged in
 * behavior. Criterion, budgets, physics config, and species slots are all
 * template-specific and owned here; SimulatorSpecEditor.tsx only renders the
 * shared Physics card (template/interpreter/micro-world) around this.
 */

import { Box, Button, HStack, Input, Stack, Switch, Text, Textarea } from "@chakra-ui/react";
import { Plus, Trash } from "@phosphor-icons/react";
import {
  COMPILED_POLICY_INTERPRETER_ID,
  type EcosystemBiomeId,
  type EcosystemGridConfig,
  type EcosystemLandscapeConfig,
  type SpeciesSlot,
  type SimulatorSpec,
} from "@/lib/simulator/contract";
import {
  clampEcosystemLandscapeRegionCount,
  ecosystemLandscapeRegionCountLimit,
  MIN_ECOSYSTEM_LANDSCAPE_REGIONS,
} from "@/lib/simulator/ecosystemLandscape";
import { ECOSYSTEM_BIOMES, ECOSYSTEM_BIOME_IDS } from "@/lib/simulator/ecosystemTerrainTiles";
import { availableCriterionMetricKeys, metricLabel } from "../helpers";
import { Label, NumField, SectionCard, selectStyle } from "./shared";
import type { DeepWritable, SimulatorFormEntry, SimulatorFormProps, SimulatorTemplateMeta } from "./types";

const DIRECTION_LABEL: Record<string, string> = {
  maximize: "Maximize",
  minimize: "Minimize",
  target: "Hit a target",
};

function defaultLandscape(activityId: string): EcosystemLandscapeConfig {
  return {
    version: 1,
    seed: `ecosystem-landscape-${activityId}`,
    regionCount: 5,
    roughness: 0.38,
    lowlandCoverage: 0.25,
    highlandCoverage: 0.25,
  };
}

export function defaultEcosystemGridSpec(
  templateMeta: SimulatorTemplateMeta,
  activityId = "draft",
): SimulatorSpec {
  return {
    version: 1,
    templateId: "ecosystemGrid",
    templateVersion: templateMeta.version,
    config: {
      width: 12,
      height: 8,
      boundary: "bounded",
      initialResourceDensity: 0.42,
      resourceRegrowthPerTick: 0.35,
      corpseDecayTicks: 4,
      baseMetabolicCost: 0.7,
      reproductionEnergyThreshold: 14,
      maxAutomata: 12,
      environmentalNoise: { enabled: false, amplitude: 0 },
      landscape: defaultLandscape(activityId),
    },
    criterion: { kind: "measured", metricKey: "longevity", direction: "maximize" },
    speciesSlots: [
      {
        slotId: "grazer",
        label: "Grazers",
        countMin: 1,
        countMax: 5,
        defaultCount: 4,
        senses: [{ senseId: "vision", range: 4 }],
        starterHint: "Find algae, graze when you reach it, and keep enough energy to survive.",
      },
    ],
    tickBudget: { iterationTicks: 60, seasonTicks: 200, absoluteMaxTicks: 200 },
    interpreter: {
      kind: "scripted",
      interpreterId: COMPILED_POLICY_INTERPRETER_ID,
    },
    microWorld: false,
  };
}

function EcosystemGridForm({
  activityId,
  draft,
  templateMeta,
  limits,
  patch,
}: SimulatorFormProps) {
  if (draft.templateId !== "ecosystemGrid") return null;
  const config = draft.config as EcosystemGridConfig;
  const criterionMetricKeys = availableCriterionMetricKeys(
    templateMeta.metricKeys,
    config.heredity?.enabled === true,
  );
  const landscapeCoverage =
    (config.landscape?.lowlandCoverage ?? 0) +
    (config.landscape?.highlandCoverage ?? 0);

  return (
    <>
      {/* Criterion */}
      <SectionCard title="Criterion — the success frame">
        <Stack gap={3}>
          <HStack gap={2}>
            {(["measured", "gallery"] as const).map((kind) => (
              <Button
                key={kind}
                size="xs"
                variant={draft.criterion.kind === kind ? "solid" : "outline"}
                bg={draft.criterion.kind === kind ? "violet.500" : "white"}
                color={draft.criterion.kind === kind ? "white" : "charcoal.500"}
                _hover={{ bg: draft.criterion.kind === kind ? "violet.600" : "gray.50" }}
                fontFamily="heading"
                onClick={() =>
                  patch((n) => {
                    n.criterion =
                      kind === "measured"
                        ? { kind: "measured", metricKey: criterionMetricKeys[0], direction: "maximize" }
                        : { kind: "gallery", frameKey: "exhibition" };
                  })
                }
              >
                {kind === "measured" ? "Measured" : "Gallery (subjective)"}
              </Button>
            ))}
          </HStack>
          {draft.criterion.kind === "measured" ? (
            <HStack gap={3} align="flex-end" flexWrap="wrap">
              <Box>
                <Label>Metric</Label>
                <select
                  aria-label="Criterion metric"
                  style={selectStyle}
                  value={draft.criterion.metricKey}
                  onChange={(e) =>
                    patch((n) => {
                      if (n.criterion.kind === "measured") n.criterion.metricKey = e.target.value;
                    })
                  }
                >
                  {criterionMetricKeys.map((key) => (
                    <option key={key} value={key}>
                      {metricLabel(key)}
                    </option>
                  ))}
                </select>
              </Box>
              <Box>
                <Label>Direction</Label>
                <select
                  aria-label="Criterion direction"
                  style={selectStyle}
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
          ) : draft.criterion.kind === "gallery" ? (
            <Stack gap={2}>
              <Box>
                <Label>Gallery frame</Label>
                <Input
                  aria-label="Gallery frame"
                  size="sm"
                  value={draft.criterion.frameKey}
                  onChange={(e) =>
                    patch((n) => {
                      if (n.criterion.kind === "gallery") n.criterion.frameKey = e.target.value;
                    })
                  }
                  placeholder="e.g. mural-wall"
                  fontFamily="heading"
                  fontSize="sm"
                  borderColor="gray.200"
                />
              </Box>
              <Box>
                <Label>Curator&apos;s note (optional, descriptive — never a score)</Label>
                <Textarea
                  aria-label="Curator's note"
                  size="sm"
                  rows={2}
                  value={draft.criterion.curatorNote ?? ""}
                  onChange={(e) =>
                    patch((n) => {
                      if (n.criterion.kind === "gallery")
                        n.criterion.curatorNote = e.target.value || undefined;
                    })
                  }
                  fontFamily="body"
                  fontSize="xs"
                  borderColor="gray.200"
                />
              </Box>
              <Text fontSize="2xs" color="charcoal.400">
                A gallery leans into subjectivity: the outcome is an exhibition of every
                scholar&apos;s work, appreciated by humans. No machine score lands on a child&apos;s
                art (plan §9.2).
              </Text>
            </Stack>
          ) : (
            <Text fontSize="xs" color="charcoal.500">
              Adversarial criteria are configured by the Tournament template.
            </Text>
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
          />
        </HStack>
        <Text fontSize="2xs" color="charcoal.400" mt={2}>
          Season ≥ iteration, absolute max ≥ season. Per-assignment run limits are set on
          Assign, not here.
        </Text>
      </SectionCard>

      {/* Config */}
      <SectionCard title="Simulator parameters">
        <Stack gap={3}>
          <HStack gap={3} flexWrap="wrap">
            <NumField
              label="Width"
              value={config.width}
              onChange={(value) =>
                patch((next) => {
                  const nextConfig = next.config as EcosystemGridConfig;
                  nextConfig.width = value;
                  if (nextConfig.landscape) {
                    nextConfig.landscape.regionCount = clampEcosystemLandscapeRegionCount(
                      nextConfig.landscape.regionCount,
                      nextConfig.width,
                      nextConfig.height,
                    );
                  }
                })
              }
              min={2}
              max={100}
              w="90px"
            />
            <NumField
              label="Height"
              value={config.height}
              onChange={(value) =>
                patch((next) => {
                  const nextConfig = next.config as EcosystemGridConfig;
                  nextConfig.height = value;
                  if (nextConfig.landscape) {
                    nextConfig.landscape.regionCount = clampEcosystemLandscapeRegionCount(
                      nextConfig.landscape.regionCount,
                      nextConfig.width,
                      nextConfig.height,
                    );
                  }
                })
              }
              min={2}
              max={100}
              w="90px"
            />
            <NumField label="Max automata" value={config.maxAutomata} onChange={(v) => patch((n) => ((n.config as EcosystemGridConfig).maxAutomata = v))} min={1} max={12} w="120px" />
            <Box>
              <Label>Boundary</Label>
              <select
                aria-label="Simulator boundary"
                style={selectStyle}
                value={config.boundary}
                onChange={(e) => patch((n) => ((n.config as EcosystemGridConfig).boundary = e.target.value as "bounded" | "toroidal"))}
              >
                <option value="bounded">bounded</option>
                <option value="toroidal">toroidal</option>
              </select>
            </Box>
            <Box>
              <Label>Biome</Label>
              <select
                aria-label="Ecosystem biome"
                style={selectStyle}
                value={config.biome ?? "reef"}
                onChange={(e) =>
                  patch((n) => {
                    const nextBiome = e.target.value as EcosystemBiomeId;
                    const nextConfig = n.config as EcosystemGridConfig;
                    if (nextBiome === "reef") delete nextConfig.biome;
                    else nextConfig.biome = nextBiome;
                  })
                }
              >
                {ECOSYSTEM_BIOME_IDS.map((biomeId) => (
                  <option key={biomeId} value={biomeId}>
                    {ECOSYSTEM_BIOMES[biomeId].label} ({biomeId === "reef" ? "water" : "land"})
                  </option>
                ))}
              </select>
            </Box>
          </HStack>
          <Text fontSize="xs" color="charcoal.500">
            Biome changes terrain art and the resource marker. Grid physics stay the same; land and
            water passability and species habitats are not modeled yet.
          </Text>
          <HStack gap={4} align="center" flexWrap="wrap">
            <Switch.Root
              checked={config.landscape !== undefined}
              onCheckedChange={(details) =>
                patch((next) => {
                  const nextConfig = next.config as EcosystemGridConfig;
                  if (details.checked) {
                    nextConfig.landscape ??= defaultLandscape(activityId);
                  } else {
                    delete nextConfig.landscape;
                  }
                })
              }
              colorPalette="violet"
              size="sm"
            >
              <Switch.HiddenInput />
              <Switch.Control>
                <Switch.Thumb />
              </Switch.Control>
              <Switch.Label fontFamily="heading" fontSize="sm" color="charcoal.500">
                Procedural landscape
              </Switch.Label>
            </Switch.Root>
          </HStack>
          {config.landscape ? (
            <Stack gap={3}>
              <HStack gap={3} align="flex-end" flexWrap="wrap">
                <Box>
                  <Label>Landscape seed</Label>
                  <Input
                    aria-label="Landscape seed"
                    size="sm"
                    w="240px"
                    value={config.landscape.seed}
                    onChange={(event) =>
                      patch((next) => {
                        const landscape = (next.config as EcosystemGridConfig).landscape;
                        if (landscape) landscape.seed = event.target.value;
                      })
                    }
                  />
                </Box>
                <NumField
                  label="Regions"
                  value={config.landscape.regionCount}
                  onChange={(value) =>
                    patch((next) => {
                      const nextConfig = next.config as EcosystemGridConfig;
                      const landscape = nextConfig.landscape;
                      if (landscape) {
                        landscape.regionCount = clampEcosystemLandscapeRegionCount(
                          value,
                          nextConfig.width,
                          nextConfig.height,
                        );
                      }
                    })
                  }
                  min={MIN_ECOSYSTEM_LANDSCAPE_REGIONS}
                  max={ecosystemLandscapeRegionCountLimit(config.width, config.height)}
                  w="100px"
                />
                <NumField
                  label="Roughness"
                  value={config.landscape.roughness}
                  onChange={(value) =>
                    patch((next) => {
                      const landscape = (next.config as EcosystemGridConfig).landscape;
                      if (landscape) landscape.roughness = value;
                    })
                  }
                  min={0}
                  max={1}
                  step={0.05}
                  w="110px"
                />
                <NumField
                  label="Lowland share"
                  value={config.landscape.lowlandCoverage}
                  onChange={(value) =>
                    patch((next) => {
                      const landscape = (next.config as EcosystemGridConfig).landscape;
                      if (landscape) landscape.lowlandCoverage = value;
                    })
                  }
                  min={0}
                  max={Math.max(0, 0.8 - config.landscape.highlandCoverage)}
                  step={0.05}
                  w="130px"
                />
                <NumField
                  label="Highland share"
                  value={config.landscape.highlandCoverage}
                  onChange={(value) =>
                    patch((next) => {
                      const landscape = (next.config as EcosystemGridConfig).landscape;
                      if (landscape) landscape.highlandCoverage = value;
                    })
                  }
                  min={0}
                  max={Math.max(0, 0.8 - config.landscape.lowlandCoverage)}
                  step={0.05}
                  w="140px"
                />
              </HStack>
              <Text
                fontSize="sm"
                color={landscapeCoverage > 0.8 ? "red.600" : "charcoal.500"}
              >
                The seed and four controls freeze coherent surface regions and boundary
                transitions in each run snapshot. Lowland and highland shares are targets; the
                generator reserves at least 20% plain buffer between them
                {landscapeCoverage > 0.8 ? " (reduce their combined share to 0.8 or less)" : ""}.
                This layer is visual only; shelter, shallows, currents, movement, resources, and
                habitats keep their existing rules.
              </Text>
            </Stack>
          ) : null}
          <HStack gap={3} flexWrap="wrap">
            <NumField label="Init resource ρ" value={config.initialResourceDensity} onChange={(v) => patch((n) => ((n.config as EcosystemGridConfig).initialResourceDensity = v))} step={0.01} min={0} max={1} w="130px" />
            <NumField label="Regrowth / tick" value={config.resourceRegrowthPerTick} onChange={(v) => patch((n) => ((n.config as EcosystemGridConfig).resourceRegrowthPerTick = v))} step={0.05} min={0} w="130px" />
            <NumField label="Metabolic cost" value={config.baseMetabolicCost} onChange={(v) => patch((n) => ((n.config as EcosystemGridConfig).baseMetabolicCost = v))} step={0.1} min={0} w="130px" />
            <NumField label="Repro threshold" value={config.reproductionEnergyThreshold} onChange={(v) => patch((n) => ((n.config as EcosystemGridConfig).reproductionEnergyThreshold = v))} step={1} min={1} w="130px" />
            <NumField label="Corpse decay" value={config.corpseDecayTicks} onChange={(v) => patch((n) => ((n.config as EcosystemGridConfig).corpseDecayTicks = v))} min={1} w="120px" />
          </HStack>
          <HStack gap={4} align="center">
            <Switch.Root
              checked={config.environmentalNoise.enabled}
              onCheckedChange={(d) => patch((n) => ((n.config as EcosystemGridConfig).environmentalNoise.enabled = !!d.checked))}
              colorPalette="violet"
              size="sm"
            >
              <Switch.HiddenInput />
              <Switch.Control>
                <Switch.Thumb />
              </Switch.Control>
              <Switch.Label fontSize="xs" color="charcoal.500">
                Environmental noise
              </Switch.Label>
            </Switch.Root>
            {config.environmentalNoise.enabled && (
              <NumField label="Amplitude" value={config.environmentalNoise.amplitude} onChange={(v) => patch((n) => ((n.config as EcosystemGridConfig).environmentalNoise.amplitude = v))} step={0.01} min={0} w="120px" />
            )}
          </HStack>
        </Stack>
      </SectionCard>

      {/* Species slots */}
      <SectionCard title={`Species — up to ${limits.maxEcosystemSpeciesSlots}`}>
        <Stack gap={3}>
          {draft.speciesSlots.map((slot, i) => (
            <SpeciesSlotEditor
              key={i}
              slot={slot}
              senseIds={templateMeta.senseIds}
              canRemove={draft.speciesSlots.length > 1}
              onChange={(next) =>
                patch((n) => {
                  n.speciesSlots[i] = next as DeepWritable<SpeciesSlot>;
                })
              }
              onRemove={() => patch((n) => n.speciesSlots.splice(i, 1))}
            />
          ))}
          {draft.speciesSlots.length < limits.maxEcosystemSpeciesSlots && (
            <Button
              size="sm"
              variant="outline"
              borderColor="gray.200"
              color="charcoal.500"
              fontFamily="heading"
              onClick={() =>
                patch((n) =>
                  n.speciesSlots.push({
                    slotId: `species_${n.speciesSlots.length + 1}`,
                    label: "New species",
                    countMin: 0,
                    countMax: 2,
                    defaultCount: 0,
                    senses: [{ senseId: templateMeta.senseIds[0], range: 3 }],
                  }),
                )
              }
            >
              <Plus size={14} style={{ marginRight: 4 }} /> Add species slot
            </Button>
          )}
        </Stack>
      </SectionCard>
    </>
  );
}

function SpeciesSlotEditor({
  slot,
  senseIds,
  canRemove,
  onChange,
  onRemove,
}: {
  slot: SpeciesSlot;
  senseIds: readonly string[];
  canRemove: boolean;
  onChange: (next: SpeciesSlot) => void;
  onRemove: () => void;
}) {
  const set = (mut: (s: DeepWritable<SpeciesSlot>) => void) => {
    const next = structuredClone(slot) as DeepWritable<SpeciesSlot>;
    mut(next);
    onChange(next as SpeciesSlot);
  };
  const usedSenses = new Set(slot.senses.map((s) => s.senseId));
  const freeSense = senseIds.find((id) => !usedSenses.has(id));

  return (
    <Box borderWidth="1px" borderColor="gray.200" borderRadius="md" bg="gray.50" p={3}>
      <HStack justify="space-between" align="flex-start" gap={3}>
        <Stack gap={2} flex={1}>
          <HStack gap={3} flexWrap="wrap">
            <Box>
              <Label>Slot id</Label>
              <Input aria-label="Species slot id" size="xs" value={slot.slotId} onChange={(e) => set((s) => (s.slotId = e.target.value))} w="130px" fontFamily="heading" borderColor="gray.200" />
            </Box>
            <Box>
              <Label>Label</Label>
              <Input aria-label="Species label" size="xs" value={slot.label} onChange={(e) => set((s) => (s.label = e.target.value))} w="150px" fontFamily="heading" borderColor="gray.200" />
            </Box>
          </HStack>
          <HStack gap={3} flexWrap="wrap">
            <NumField label="Min" value={slot.countMin} onChange={(v) => set((s) => (s.countMin = v))} min={0} w="70px" />
            <NumField label="Max" value={slot.countMax} onChange={(v) => set((s) => (s.countMax = v))} min={0} w="70px" />
            <NumField label="Default" value={slot.defaultCount} onChange={(v) => set((s) => (s.defaultCount = v))} min={0} w="80px" />
          </HStack>
          <Box>
            <Label>Senses (world-given)</Label>
            <Stack gap={1.5}>
              {slot.senses.map((sense, si) => (
                <HStack key={si} gap={2}>
                  <select
                    aria-label="Species sense"
                    style={{ ...selectStyle, fontSize: "12px" }}
                    value={sense.senseId}
                    onChange={(e) =>
                      set((s) => {
                        s.senses[si].senseId = e.target.value;
                      })
                    }
                  >
                    {senseIds.map((id) => (
                      <option key={id} value={id} disabled={usedSenses.has(id) && id !== sense.senseId}>
                        {id}
                      </option>
                    ))}
                  </select>
                  <Input
                    aria-label={`${sense.senseId} range`}
                    size="xs"
                    type="number"
                    min={0}
                    max={100}
                    w="80px"
                    value={sense.range ?? ""}
                    placeholder="range"
                    onChange={(e) =>
                      set((s) => {
                        s.senses[si].range =
                          e.target.value === "" ? undefined : Number(e.target.value);
                      })
                    }
                    fontFamily="heading"
                    borderColor="gray.200"
                  />
                  {slot.senses.length > 1 && (
                    <Button
                      aria-label={`Remove ${sense.senseId} sense`}
                      size="xs"
                      variant="ghost"
                      color="charcoal.400"
                      onClick={() => set((s) => s.senses.splice(si, 1))}
                    >
                      <Trash size={12} />
                    </Button>
                  )}
                </HStack>
              ))}
              {freeSense && (
                <Button
                  size="xs"
                  variant="ghost"
                  color="violet.500"
                  fontFamily="heading"
                  alignSelf="flex-start"
                  onClick={() => set((s) => s.senses.push({ senseId: freeSense, range: 3 }))}
                >
                  <Plus size={12} style={{ marginRight: 3 }} /> Add sense
                </Button>
              )}
            </Stack>
          </Box>
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
            aria-label={`Remove ${slot.label} species slot`}
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

export const ECOSYSTEM_GRID_FORM: SimulatorFormEntry = {
  templateId: "ecosystemGrid",
  startLabel: "Start from ecosystem-grid",
  defaultSpec: defaultEcosystemGridSpec,
  Form: EcosystemGridForm,
};
