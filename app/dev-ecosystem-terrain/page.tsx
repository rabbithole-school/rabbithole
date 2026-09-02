"use client";

import { useMemo, useState } from "react";
import {
  Box,
  Button,
  Container,
  Field,
  Heading,
  HStack,
  Input,
  SimpleGrid,
  Stack,
  Text,
} from "@chakra-ui/react";
import { SimulatorViewport } from "@/components/workbench/SimulatorViewport";
import {
  ECOSYSTEM_LANDSCAPE_DEMO_CONFIG,
  MEADOW_ECOSYSTEM_DEMO_SCENE,
  MEADOW_ECOSYSTEM_DEMO_SPEC,
} from "@/lib/simulator/ecosystemBiomeDemos";
import {
  ecosystemLandscapeFingerprint,
  generateEcosystemLandscape,
} from "@/lib/simulator/ecosystemLandscape";
import { ecosystemBiome } from "@/lib/simulator/ecosystemTerrainTiles";
import type {
  EcosystemBiomeId,
  EcosystemGridSimulatorSpec,
} from "@/lib/simulator/contract";

const DEMO_BIOME_IDS = ["reef", "meadow"] as const satisfies readonly EcosystemBiomeId[];
const SEED_PRESETS = [
  { label: "Broad shelves", seed: "inspection-broad-shelves" },
  { label: "Broken ridges", seed: "inspection-broken-ridges" },
  { label: "Quiet basins", seed: "inspection-quiet-basins" },
] as const;
const SIZE_PRESETS = [
  { label: "12 × 8", width: 12, height: 8 },
  { label: "24 × 16", width: 24, height: 16 },
] as const;

interface InspectionSettings {
  seed: string;
  width: number;
  height: number;
  regionCount: number;
  roughness: number;
  lowlandCoverage: number;
  highlandCoverage: number;
}

/**
 * Unlinked renderer fixture for the terrain catalog. Its static spec and scene
 * are code-owned, so visual checks never write curriculum or production data.
 */
export default function DevEcosystemTerrain() {
  const [seedDraft, setSeedDraft] = useState<string>(SEED_PRESETS[0].seed);
  const [settings, setSettings] = useState<InspectionSettings>({
    seed: SEED_PRESETS[0].seed,
    width: MEADOW_ECOSYSTEM_DEMO_SPEC.config.width,
    height: MEADOW_ECOSYSTEM_DEMO_SPEC.config.height,
    regionCount: ECOSYSTEM_LANDSCAPE_DEMO_CONFIG.regionCount,
    roughness: ECOSYSTEM_LANDSCAPE_DEMO_CONFIG.roughness,
    lowlandCoverage: ECOSYSTEM_LANDSCAPE_DEMO_CONFIG.lowlandCoverage,
    highlandCoverage: ECOSYSTEM_LANDSCAPE_DEMO_CONFIG.highlandCoverage,
  });

  return (
    <Box minH="100dvh" bg="bg.subtle" py={{ base: 6, md: 10 }}>
      <Container maxW="1280px">
        <Stack gap={5}>
          <Box
            bg="white"
            borderWidth="1px"
            borderColor="border"
            borderRadius="lg"
            p={{ base: 5, md: 6 }}
          >
            <Heading size={{ base: "lg", md: "xl" }} color="charcoal.500">
              Procedural ecosystem landscapes
            </Heading>
            <Text mt={2} maxW="820px" color="fg.muted">
              Unlinked renderer fixture for seeded surface regions, shared transitions, and
              physics-terrain precedence. Generated bands are presentation only; shelter, shallows, currents,
              passability, resources, and habitats keep their existing rules.
            </Text>
            <Stack mt={5} gap={3}>
              <Field.Root maxW="460px">
                <Field.Label>Inspection seed</Field.Label>
                <Input
                  value={seedDraft}
                  onChange={(event) => {
                    const nextSeed = event.target.value;
                    setSeedDraft(nextSeed);
                    if (nextSeed.trim()) {
                      setSettings((current) => ({
                        ...current,
                        seed: nextSeed,
                      }));
                    }
                  }}
                  onBlur={() => {
                    if (!seedDraft.trim()) setSeedDraft(settings.seed);
                  }}
                  fontFamily="mono"
                />
                <Field.HelperText>
                  Re-enter a seed to reproduce its fingerprint and landscape exactly.
                </Field.HelperText>
              </Field.Root>
              <HStack gap={2} flexWrap="wrap">
                {SEED_PRESETS.map((preset) => (
                  <Button
                    key={preset.seed}
                    size="sm"
                    variant={settings.seed === preset.seed ? "solid" : "outline"}
                    colorPalette={settings.seed === preset.seed ? "violet" : "gray"}
                    onClick={() =>
                      {
                        setSeedDraft(preset.seed);
                        setSettings((current) => ({
                          ...current,
                          seed: preset.seed,
                        }));
                      }
                    }
                  >
                    {preset.label}
                  </Button>
                ))}
                {SIZE_PRESETS.map((preset) => (
                  <Button
                    key={preset.label}
                    size="sm"
                    variant={
                      settings.width === preset.width &&
                      settings.height === preset.height
                        ? "solid"
                        : "outline"
                    }
                    colorPalette="blue"
                    onClick={() =>
                      setSettings((current) => ({
                        ...current,
                        width: preset.width,
                        height: preset.height,
                      }))
                    }
                  >
                    {preset.label}
                  </Button>
                ))}
              </HStack>
              <SimpleGrid columns={{ base: 2, md: 4 }} gap={3} maxW="760px">
                <Field.Root>
                  <Field.Label>Regions</Field.Label>
                  <Input
                    type="number"
                    min={2}
                    max={12}
                    value={settings.regionCount}
                    onChange={(event) => {
                      const value = event.currentTarget.valueAsNumber;
                      if (!Number.isFinite(value)) return;
                      setSettings((current) => ({
                        ...current,
                        regionCount: Math.max(2, Math.min(12, Math.round(value))),
                      }));
                    }}
                  />
                </Field.Root>
                <Field.Root>
                  <Field.Label>Roughness</Field.Label>
                  <Input
                    type="number"
                    min={0}
                    max={1}
                    step={0.05}
                    value={settings.roughness}
                    onChange={(event) => {
                      const value = event.currentTarget.valueAsNumber;
                      if (!Number.isFinite(value)) return;
                      setSettings((current) => ({
                        ...current,
                        roughness: Math.max(0, Math.min(1, value)),
                      }));
                    }}
                  />
                </Field.Root>
                <Field.Root>
                  <Field.Label>Lowland target</Field.Label>
                  <Input
                    type="number"
                    min={0}
                    max={Math.max(0, 0.8 - settings.highlandCoverage)}
                    step={0.05}
                    value={settings.lowlandCoverage}
                    onChange={(event) => {
                      const value = event.currentTarget.valueAsNumber;
                      if (!Number.isFinite(value)) return;
                      setSettings((current) => ({
                        ...current,
                        lowlandCoverage: Math.max(
                          0,
                          Math.min(0.8 - current.highlandCoverage, value),
                        ),
                      }));
                    }}
                  />
                </Field.Root>
                <Field.Root>
                  <Field.Label>Highland target</Field.Label>
                  <Input
                    type="number"
                    min={0}
                    max={Math.max(0, 0.8 - settings.lowlandCoverage)}
                    step={0.05}
                    value={settings.highlandCoverage}
                    onChange={(event) => {
                      const value = event.currentTarget.valueAsNumber;
                      if (!Number.isFinite(value)) return;
                      setSettings((current) => ({
                        ...current,
                        highlandCoverage: Math.max(
                          0,
                          Math.min(0.8 - current.lowlandCoverage, value),
                        ),
                      }));
                    }}
                  />
                </Field.Root>
              </SimpleGrid>
            </Stack>
          </Box>
          <SimpleGrid columns={{ base: 1, lg: 2 }} gap={5}>
            {DEMO_BIOME_IDS.map((biomeId) => (
              <TerrainDemo key={biomeId} biomeId={biomeId} settings={settings} />
            ))}
          </SimpleGrid>
        </Stack>
      </Container>
    </Box>
  );
}

function TerrainDemo({
  biomeId,
  settings,
}: {
  biomeId: EcosystemBiomeId;
  settings: InspectionSettings;
}) {
  const biome = ecosystemBiome(biomeId);
  const landscapeConfig = useMemo(
    () => ({
      ...ECOSYSTEM_LANDSCAPE_DEMO_CONFIG,
      seed: settings.seed,
      regionCount: settings.regionCount,
      roughness: settings.roughness,
      lowlandCoverage: settings.lowlandCoverage,
      highlandCoverage: settings.highlandCoverage,
    }),
    [
      settings.highlandCoverage,
      settings.lowlandCoverage,
      settings.regionCount,
      settings.roughness,
      settings.seed,
    ],
  );
  const spec = useMemo<EcosystemGridSimulatorSpec>(
    () => ({
      ...MEADOW_ECOSYSTEM_DEMO_SPEC,
      config: {
        ...MEADOW_ECOSYSTEM_DEMO_SPEC.config,
        width: settings.width,
        height: settings.height,
        biome: biomeId,
        landscape: landscapeConfig,
      },
    }),
    [biomeId, landscapeConfig, settings.height, settings.width],
  );
  const scene = useMemo(
    () => ({
      ...MEADOW_ECOSYSTEM_DEMO_SCENE,
      viewport: {
        ...MEADOW_ECOSYSTEM_DEMO_SCENE.viewport,
        width: settings.width,
        height: settings.height,
      },
    }),
    [settings.height, settings.width],
  );
  const landscape = useMemo(
    () =>
      generateEcosystemLandscape({
        width: spec.config.width,
        height: spec.config.height,
        config: landscapeConfig,
      }),
    [landscapeConfig, spec.config.height, spec.config.width],
  );
  const fingerprint = ecosystemLandscapeFingerprint(landscape);

  return (
    <Box
      as="section"
      aria-labelledby={`${biome.id}-terrain-heading`}
      bg="white"
      borderWidth="1px"
      borderColor="border"
      borderRadius="lg"
      p={{ base: 4, md: 5 }}
    >
      <HStack justify="space-between" align="start" gap={4}>
        <Box>
          <Heading id={`${biome.id}-terrain-heading`} size="md" color="charcoal.500">
            {biome.label}
          </Heading>
          <Text mt={1} fontSize="sm" color="fg.muted">
            {biome.resource.label} markers · explicit terrain overrides scenic bands
          </Text>
        </Box>
        <Text
          data-landscape-fingerprint={fingerprint}
          fontFamily="mono"
          fontSize="sm"
          color="fg.muted"
          whiteSpace="nowrap"
        >
          v1 · {fingerprint}
        </Text>
      </HStack>
      <Box
        mt={4}
        h={{ base: "330px", md: "360px" }}
        display="flex"
        borderWidth="1px"
        borderColor="border"
        borderRadius="md"
        overflow="hidden"
      >
        <SimulatorViewport
          spec={spec}
          frame={null}
          liveScene={scene}
          isLiveHead
          run={null}
          tick={0}
          maxTick={0}
          moreComing={false}
          playing={false}
          onScrub={() => {}}
          onTogglePlay={() => {}}
          onSelectAutomaton={() => {}}
          selectedAutomatonId={null}
          speciesIcons={{}}
          runLabel="render fixture"
          personalDelta={null}
          showTransport={false}
        />
      </Box>
    </Box>
  );
}
