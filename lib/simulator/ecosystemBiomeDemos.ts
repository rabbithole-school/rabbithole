import {
  COMPILED_POLICY_INTERPRETER_ID,
  type EcosystemGridSimulatorSpec,
  type EcosystemLandscapeConfig,
  type SimulatorSceneV1,
} from "./contract";
import { ECOSYSTEM_GRID_TEMPLATE_VERSION } from "./templates/ecosystemGrid";

export const ECOSYSTEM_LANDSCAPE_DEMO_CONFIG: EcosystemLandscapeConfig = {
  version: 1,
  seed: "meadow-inspection",
  regionCount: 5,
  roughness: 0.38,
  lowlandCoverage: 0.25,
  highlandCoverage: 0.25,
};

/**
 * A deterministic, code-owned meadow world for development and renderer tests.
 * It is not seed curriculum or learner data; activities opt in by copying its
 * stable biome id through the existing Simulator spec editor.
 */
export const MEADOW_ECOSYSTEM_DEMO_SPEC: EcosystemGridSimulatorSpec = {
  version: 1,
  templateId: "ecosystemGrid",
  templateVersion: ECOSYSTEM_GRID_TEMPLATE_VERSION,
  config: {
    width: 12,
    height: 8,
    boundary: "bounded",
    biome: "meadow",
    landscape: ECOSYSTEM_LANDSCAPE_DEMO_CONFIG,
    terrain: {
      shelter: [{ x: 1, y: 1 }],
      current: [
        { x: 2, y: 1, direction: "north" },
        { x: 3, y: 1, direction: "south" },
        { x: 4, y: 1, direction: "east" },
        { x: 5, y: 1, direction: "west" },
      ],
      shallows: [{ x: 6, y: 1 }],
      predatorSlotIds: [],
    },
    initialResourceDensity: 0.42,
    resourceRegrowthPerTick: 0.35,
    corpseDecayTicks: 4,
    baseMetabolicCost: 0.7,
    reproductionEnergyThreshold: 14,
    maxAutomata: 12,
    environmentalNoise: { enabled: false, amplitude: 0 },
  },
  criterion: { kind: "measured", metricKey: "longevity", direction: "maximize" },
  speciesSlots: [
    {
      slotId: "forager",
      label: "Foragers",
      countMin: 2,
      countMax: 5,
      defaultCount: 4,
      senses: [{ senseId: "vision", range: 4 }],
      starterHint: "Find forage, conserve energy, and adapt to the terrain.",
    },
  ],
  tickBudget: { iterationTicks: 60, seasonTicks: 200, absoluteMaxTicks: 200 },
  interpreter: { kind: "scripted", interpreterId: COMPILED_POLICY_INTERPRETER_ID },
  microWorld: false,
};

/**
 * Companion static scene for the unlinked development renderer demo. It is
 * code-owned and never reaches curriculum, run, or learner data.
 */
export const MEADOW_ECOSYSTEM_DEMO_SCENE: SimulatorSceneV1 = {
  protocolVersion: 1,
  templateId: "ecosystemGrid",
  tick: 0,
  viewport: {
    width: MEADOW_ECOSYSTEM_DEMO_SPEC.config.width,
    height: MEADOW_ECOSYSTEM_DEMO_SPEC.config.height,
    boundary: MEADOW_ECOSYSTEM_DEMO_SPEC.config.boundary,
  },
  entities: [
    {
      id: "meadow-demo-forager",
      kind: "automaton",
      x: 3,
      y: 3,
      layer: 1,
      label: "Forager",
      color: "#65A30D",
      size: 0.72,
    },
  ],
  cells: [
    { x: 1, y: 1, kind: "shelter", intensity: 1 },
    { x: 2, y: 1, kind: "current_north", intensity: 1 },
    { x: 3, y: 1, kind: "current_south", intensity: 1 },
    { x: 4, y: 1, kind: "current_east", intensity: 1 },
    { x: 5, y: 1, kind: "current_west", intensity: 1 },
    { x: 6, y: 1, kind: "shallows", intensity: 1 },
    { x: 6, y: 3, kind: "resource", intensity: 0.9 },
  ],
};
