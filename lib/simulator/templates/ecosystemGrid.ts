import {
  MAX_AUTOMATA_COMPILED_RUN,
  MAX_AUTOMATA_PER_RUN,
  MAX_CHUNK_JSON_BYTES,
  MAX_ECOSYSTEM_SPECIES_SLOTS,
  MAX_GRID_CELLS_PER_COMPILED_RUN,
  MAX_PROMPT_CHARS,
  MAX_SCENE_JSON_BYTES,
  MIN_GRID_CELLS_PER_COMPILED_AUTOMATON,
  RENDERER_PROTOCOL_VERSION,
  SIMULATOR_PROTOCOL_VERSION,
  type EcosystemGridConfig,
  type LaunchedSpecies,
  type SensePackage,
  type SpeciesSlot,
  type WorldActionSchema,
  type SimulatorSceneV1,
  type SimulatorSpec,
  type SimulatorTemplate,
} from "../contract";
import { validateEcosystemLandscapeConfig } from "../ecosystemLandscape";
import {
  ECOSYSTEM_DEFAULT_SENSE_CHANNELS,
  effectiveEcosystemSenseRange,
} from "../ecosystemPerception";
import { ECOSYSTEM_BIOME_IDS } from "../ecosystemTerrainTiles";
import { SPECIES_COLORS } from "../helpers";

export const ECOSYSTEM_GRID_TEMPLATE_VERSION = 2 as const;

export const ECOSYSTEM_GRID_SENSE_IDS = ["vision", "smell", "touch"] as const;
export type EcosystemSenseId = (typeof ECOSYSTEM_GRID_SENSE_IDS)[number];

export const ECOSYSTEM_GRID_ACTION_KINDS = [
  "move",
  "eat",
  "graze",
  "hide",
  "rest",
  "reproduce",
  "noop",
] as const;

export type EcosystemAction =
  | { kind: "move"; to: GridPoint }
  | { kind: "eat"; targetId: string }
  | { kind: "graze"; at: GridPoint }
  | { kind: "hide" }
  | { kind: "rest" }
  | { kind: "reproduce" }
  | { kind: "noop" };

export const ECOSYSTEM_GRID_ACTION_SCHEMA: WorldActionSchema = {
  variants: [
    {
      kind: "move",
      description: "Move to one listed neighboring cell.",
      fields: [
        {
          name: "to",
          type: "point",
          required: true,
          description: "The exact listed destination.",
        },
      ],
    },
    {
      kind: "eat",
      description: "Try to eat one listed neighboring Automaton.",
      fields: [
        {
          name: "targetId",
          type: "string",
          required: true,
          description: "The exact listed target id.",
        },
      ],
    },
    {
      kind: "graze",
      description: "Graze the listed resource at the current cell.",
      fields: [
        {
          name: "at",
          type: "point",
          required: true,
          description: "The exact listed resource cell.",
        },
      ],
    },
    { kind: "hide", description: "Become hidden at the current cell.", fields: [] },
    { kind: "rest", description: "Stay put and conserve some energy.", fields: [] },
    {
      kind: "reproduce",
      description: "Try to reproduce into a neighboring free cell.",
      fields: [],
    },
    { kind: "noop", description: "Take no deliberate action this tick.", fields: [] },
  ],
};

export interface GridPoint {
  x: number;
  y: number;
}

export interface EcosystemAutomaton {
  id: string;
  slotId: string;
  x: number;
  y: number;
  energy: number;
  hidden: boolean;
  bornTick: number;
  heading?: number;
  trait?: number;
  perceptionTrait?: number;
}

export interface EcosystemSpeciesState {
  slotId: string;
  label: string;
  countMax: number;
  senses: SensePackage;
}

export interface EcosystemResource {
  x: number;
  y: number;
  biomass: number;
}

export interface EcosystemCorpse {
  id: string;
  slotId: string;
  x: number;
  y: number;
  decaysAtTick: number;
}

export interface EcosystemState {
  config: EcosystemGridConfig;
  species: readonly EcosystemSpeciesState[];
  automata: readonly EcosystemAutomaton[];
  resources: readonly EcosystemResource[];
  corpses: readonly EcosystemCorpse[];
  totalBirths: number;
  totalDeaths: number;
  totalInvalidActions: number;
}

export interface SensedAutomaton {
  id: string;
  slotId: string;
  dx: number;
  dy: number;
  distance: number;
  energy: number;
  hidden: boolean;
}

export interface SensedResource {
  x: number;
  y: number;
  dx: number;
  dy: number;
  distance: number;
  biomass: number;
}

export interface SensedCorpse {
  id: string;
  slotId: string;
  dx: number;
  dy: number;
  distance: number;
}

export type EcosystemTerrainKind = "shelter" | "current" | "shallows";

export interface SensedTerrain {
  kind: EcosystemTerrainKind;
  x: number;
  y: number;
  dx: number;
  dy: number;
  distance: number;
  direction?: "north" | "east" | "south" | "west";
}

export interface EcosystemSenseReading {
  automata?: readonly SensedAutomaton[];
  resources?: readonly SensedResource[];
  corpses?: readonly SensedCorpse[];
  terrain?: readonly SensedTerrain[];
  boundary?: readonly {
    side: "north" | "east" | "south" | "west";
    distance: number;
  }[];
}

export interface EcosystemObservation {
  self: {
    id: string;
    slotId: string;
    x: number;
    y: number;
    energy: number;
    hidden: boolean;
    terrain?: {
      kind: EcosystemTerrainKind;
      direction?: "north" | "east" | "south" | "west";
    };
  };
  vision?: EcosystemSenseReading;
  smell?: EcosystemSenseReading;
  touch?: EcosystemSenseReading;
}

export interface EcosystemDelta {
  moved: readonly { automatonId: string; from: GridPoint; to: GridPoint }[];
  hidden: readonly string[];
  grazed: readonly { automatonId: string; at: GridPoint; amount: number }[];
  eaten: readonly { automatonId: string; targetId: string }[];
  born: readonly EcosystemAutomaton[];
  died: readonly { automatonId: string; cause: "eaten" | "metabolism" }[];
  resourceChanges: readonly { at: GridPoint; before: number; after: number }[];
  invalidAutomatonIds: readonly string[];
}

export type EcosystemMetrics = {
  longevity: number;
  livingAutomata: number;
  scoringSlotSurvivors: number;
  livingSpecies: number;
  resourceBiomass: number;
  totalEnergy: number;
  births: number;
  deaths: number;
  invalidActions: number;
  traitMean: number;
  traitSpread: number;
  perceptionMean: number;
  perceptionSpread: number;
};

const SENSE_CHANNELS: Record<EcosystemSenseId, readonly string[]> =
  ECOSYSTEM_DEFAULT_SENSE_CHANNELS;

const RESOURCE_CAPACITY = 10;
const GRAZE_AMOUNT = 3;
const EAT_ENERGY_FRACTION = 0.5;
/**
 * 2026-08-12 dense-grid benchmark (N=12/30/64, ranges 1-100, one through
 * three senses, every legal channel combination measured): canonical stored
 * ticks stayed below 1,024 fixed bytes per automaton plus 96 bytes per sensed
 * automaton/resource/corpse entry. The estimator below applies those coefficients
 * to closed-form maximum entry counts, then preserves 2x chunk headroom.
 */
const COMPILED_TICK_BASE_BYTES_PER_AUTOMATON = 1_024;
const COMPILED_TICK_BYTES_PER_SENSE_ENTRY = 96;
const MAX_COMPILED_TICK_ESTIMATE_BYTES = MAX_CHUNK_JSON_BYTES / 2;
const MIN_METABOLIC_TRAIT = 0.5;
const MAX_METABOLIC_TRAIT = 2;
const MIN_PERCEPTION_TRAIT = 0.5;
const MAX_PERCEPTION_TRAIT = 2;
export const ECOSYSTEM_TRAIT_DOMAIN = {
  metabolic: { min: MIN_METABOLIC_TRAIT, max: MAX_METABOLIC_TRAIT },
  perception: { min: MIN_PERCEPTION_TRAIT, max: MAX_PERCEPTION_TRAIT },
} as const;
/**
 * Perception adds 0.3 * base cost for every trait point above 0.5. A founder
 * at 1.0 pays 0.15 * base; a sharp-eyed 2.0 fish pays 0.45 * base; a dim 0.5
 * fish pays no surcharge. Thus 2.0 versus 0.5 costs 45% of base each tick,
 * enough to matter under scarcity without erasing the existing body-cost trait.
 */
const PERCEPTION_SURCHARGE_PER_TRAIT_POINT = 0.3;
const SCENE_BASE_ESTIMATE_BYTES = 256;
const SCENE_AUTOMATON_ESTIMATE_BYTES = 224;
const SCENE_CORPSE_ESTIMATE_BYTES = 144;
const SCENE_RESOURCE_CELL_ESTIMATE_BYTES = 80;
const SCENE_TERRAIN_CELL_ESTIMATE_BYTES = 80;
const CARDINAL_STEPS: readonly GridPoint[] = [
  { x: 0, y: -1 },
  { x: 1, y: 0 },
  { x: 0, y: 1 },
  { x: -1, y: 0 },
];

function fail(message: string): never {
  throw new Error(`ecosystemGrid: ${message}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function finiteNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) fail(`${field} must be finite`);
  return value;
}

function integer(value: unknown, field: string): number {
  const parsed = finiteNumber(value, field);
  if (!Number.isInteger(parsed)) fail(`${field} must be an integer`);
  return parsed;
}

function nonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) fail(`${field} must be a non-empty string`);
  return value;
}

function assertOnlyKeys(value: Record<string, unknown>, allowed: readonly string[], field: string) {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) fail(`${field} carries unknown field "${key}"`);
  }
}

function parsePoint(value: unknown, field: string): GridPoint {
  if (!isRecord(value)) fail(`${field} must be an object`);
  assertOnlyKeys(value, ["x", "y"], field);
  return { x: integer(value.x, `${field}.x`), y: integer(value.y, `${field}.y`) };
}

function validateTerrain(
  value: unknown,
  width: number,
  height: number,
): NonNullable<EcosystemGridConfig["terrain"]> | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) fail("config.terrain must be an object");
  assertOnlyKeys(
    value,
    ["shelter", "current", "shallows", "predatorSlotIds"],
    "config.terrain",
  );
  if (
    !Array.isArray(value.shelter) ||
    !Array.isArray(value.current) ||
    !Array.isArray(value.shallows) ||
    !Array.isArray(value.predatorSlotIds)
  ) {
    fail("config.terrain cell kinds and predatorSlotIds must be arrays");
  }
  const occupied = new Map<string, EcosystemTerrainKind>();
  const parseTerrainPoint = (
    raw: unknown,
    field: string,
    kind: EcosystemTerrainKind,
  ): GridPoint => {
    const point = parsePoint(raw, field);
    if (point.x < 0 || point.x >= width || point.y < 0 || point.y >= height) {
      fail(`${field} is outside the grid`);
    }
    const key = pointKey(point);
    const previous = occupied.get(key);
    if (previous) fail(`config.terrain overlaps ${previous} and ${kind} at ${key}`);
    occupied.set(key, kind);
    return point;
  };
  const shelter = value.shelter.map((point, index) =>
    parseTerrainPoint(point, `config.terrain.shelter[${index}]`, "shelter"),
  );
  const current = value.current.map((raw, index) => {
    const field = `config.terrain.current[${index}]`;
    if (!isRecord(raw)) fail(`${field} must be an object`);
    assertOnlyKeys(raw, ["x", "y", "direction"], field);
    if (
      raw.direction !== "north" &&
      raw.direction !== "east" &&
      raw.direction !== "south" &&
      raw.direction !== "west"
    ) {
      fail(`${field}.direction must be north, east, south, or west`);
    }
    const point = parseTerrainPoint({ x: raw.x, y: raw.y }, field, "current");
    const direction: "north" | "east" | "south" | "west" = raw.direction;
    return { ...point, direction };
  });
  const shallows = value.shallows.map((point, index) =>
    parseTerrainPoint(point, `config.terrain.shallows[${index}]`, "shallows"),
  );
  const predatorSlotIds = value.predatorSlotIds.map((slotId, index) =>
    nonEmptyString(slotId, `config.terrain.predatorSlotIds[${index}]`),
  );
  if (new Set(predatorSlotIds).size !== predatorSlotIds.length) {
    fail("config.terrain.predatorSlotIds repeats a slotId");
  }
  const sortPoints = <T extends GridPoint>(points: T[]) =>
    points.sort((left, right) => left.y - right.y || left.x - right.x);
  return {
    shelter: sortPoints(shelter),
    current: sortPoints(current),
    shallows: sortPoints(shallows),
    predatorSlotIds: [...predatorSlotIds].sort(),
  };
}

export function validateEcosystemConfig(value: unknown): EcosystemGridConfig {
  if (!isRecord(value)) fail("config must be an object");
  assertOnlyKeys(
    value,
    [
      "width",
      "height",
      "boundary",
      "initialResourceDensity",
      "resourceRegrowthPerTick",
      "corpseDecayTicks",
      "baseMetabolicCost",
      "reproductionEnergyThreshold",
      "maxAutomata",
      "environmentalNoise",
      "initialPositions",
      "scoringSlotId",
      "biome",
      "landscape",
      "terrain",
      "heredity",
    ],
    "config",
  );
  const width = integer(value.width, "config.width");
  const height = integer(value.height, "config.height");
  if (width < 2 || width > 100 || height < 2 || height > 100) {
    fail("config dimensions must be integers from 2 through 100");
  }
  if (value.boundary !== "bounded" && value.boundary !== "toroidal") {
    fail('config.boundary must be "bounded" or "toroidal"');
  }
  const initialResourceDensity = finiteNumber(
    value.initialResourceDensity,
    "config.initialResourceDensity",
  );
  if (initialResourceDensity < 0 || initialResourceDensity > 1) {
    fail("config.initialResourceDensity must be between 0 and 1");
  }
  const resourceRegrowthPerTick = finiteNumber(
    value.resourceRegrowthPerTick,
    "config.resourceRegrowthPerTick",
  );
  if (resourceRegrowthPerTick < 0 || resourceRegrowthPerTick > RESOURCE_CAPACITY) {
    fail(`config.resourceRegrowthPerTick must be between 0 and ${RESOURCE_CAPACITY}`);
  }
  const corpseDecayTicks = integer(value.corpseDecayTicks, "config.corpseDecayTicks");
  if (corpseDecayTicks < 1) fail("config.corpseDecayTicks must be positive");
  const baseMetabolicCost = finiteNumber(value.baseMetabolicCost, "config.baseMetabolicCost");
  if (baseMetabolicCost < 0) fail("config.baseMetabolicCost must be non-negative");
  const reproductionEnergyThreshold = finiteNumber(
    value.reproductionEnergyThreshold,
    "config.reproductionEnergyThreshold",
  );
  if (reproductionEnergyThreshold <= 0) {
    fail("config.reproductionEnergyThreshold must be positive");
  }
  const maxAutomata = integer(value.maxAutomata, "config.maxAutomata");
  if (maxAutomata < 1 || maxAutomata > MAX_AUTOMATA_COMPILED_RUN) {
    fail(`config.maxAutomata must be from 1 through ${MAX_AUTOMATA_COMPILED_RUN}`);
  }
  const gridCells = width * height;
  if (
    maxAutomata > MAX_AUTOMATA_PER_RUN &&
    gridCells < maxAutomata * MIN_GRID_CELLS_PER_COMPILED_AUTOMATON
  ) {
    fail(
      `compiled populations need at least ${MIN_GRID_CELLS_PER_COMPILED_AUTOMATON} grid cells per automaton`,
    );
  }
  if (
    maxAutomata > MAX_AUTOMATA_PER_RUN &&
    gridCells > MAX_GRID_CELLS_PER_COMPILED_RUN
  ) {
    fail(
      `compiled populations support at most ${MAX_GRID_CELLS_PER_COMPILED_RUN} grid cells`,
    );
  }
  if (!isRecord(value.environmentalNoise)) {
    fail("config.environmentalNoise must be an object");
  }
  assertOnlyKeys(value.environmentalNoise, ["enabled", "amplitude"], "config.environmentalNoise");
  if (typeof value.environmentalNoise.enabled !== "boolean") {
    fail("config.environmentalNoise.enabled must be boolean");
  }
  const amplitude = finiteNumber(
    value.environmentalNoise.amplitude,
    "config.environmentalNoise.amplitude",
  );
  if (amplitude < 0 || amplitude > RESOURCE_CAPACITY) {
    fail(`config.environmentalNoise.amplitude must be between 0 and ${RESOURCE_CAPACITY}`);
  }
  const terrain = validateTerrain(value.terrain, width, height);
  let initialPositions: EcosystemGridConfig["initialPositions"];
  if (value.initialPositions !== undefined) {
    if (!isRecord(value.initialPositions)) fail("config.initialPositions must be an object");
    const occupied = new Set<string>();
    initialPositions = {};
    for (const [slotId, rawPositions] of Object.entries(value.initialPositions)) {
      nonEmptyString(slotId, "config.initialPositions slotId");
      if (!Array.isArray(rawPositions)) {
        fail(`config.initialPositions.${slotId} must be an array`);
      }
      initialPositions[slotId] = rawPositions.map((raw, index) => {
        const point = parsePoint(raw, `config.initialPositions.${slotId}[${index}]`);
        if (point.x < 0 || point.x >= width || point.y < 0 || point.y >= height) {
          fail(`config.initialPositions.${slotId}[${index}] is outside the grid`);
        }
        const key = pointKey(point);
        if (occupied.has(key)) fail(`config.initialPositions repeats cell ${key}`);
        occupied.add(key);
        return point;
      });
    }
  }
  const scoringSlotId =
    value.scoringSlotId === undefined
      ? undefined
      : nonEmptyString(value.scoringSlotId, "config.scoringSlotId");
  const landscape =
    value.landscape === undefined
      ? undefined
      : validateEcosystemLandscapeConfig(value.landscape, width, height);
  let biome: EcosystemGridConfig["biome"];
  if (value.biome !== undefined) {
    if (
      typeof value.biome !== "string" ||
      !(ECOSYSTEM_BIOME_IDS as readonly string[]).includes(value.biome)
    ) {
      fail(`config.biome must be one of ${ECOSYSTEM_BIOME_IDS.join(", ")}`);
    }
    biome = value.biome as EcosystemGridConfig["biome"];
  }
  let heredity: EcosystemGridConfig["heredity"];
  if (value.heredity !== undefined) {
    if (!isRecord(value.heredity)) fail("config.heredity must be an object");
    assertOnlyKeys(value.heredity, ["enabled", "mutationStd"], "config.heredity");
    if (typeof value.heredity.enabled !== "boolean") {
      fail("config.heredity.enabled must be boolean");
    }
    const mutationStd = finiteNumber(
      value.heredity.mutationStd,
      "config.heredity.mutationStd",
    );
    if (mutationStd < 0 || mutationStd > 0.5) {
      fail("config.heredity.mutationStd must be between 0 and 0.5");
    }
    if (value.heredity.enabled) {
      heredity = { enabled: true, mutationStd };
    }
  }
  return {
    width,
    height,
    boundary: value.boundary,
    initialResourceDensity,
    resourceRegrowthPerTick,
    corpseDecayTicks,
    baseMetabolicCost,
    reproductionEnergyThreshold,
    maxAutomata,
    environmentalNoise: {
      enabled: value.environmentalNoise.enabled,
      amplitude,
    },
    ...(initialPositions ? { initialPositions } : {}),
    ...(scoringSlotId ? { scoringSlotId } : {}),
    ...(biome ? { biome } : {}),
    ...(landscape ? { landscape } : {}),
    ...(terrain ? { terrain } : {}),
    ...(heredity ? { heredity } : {}),
  };
}

function validateSensePackage(senses: SensePackage, field: string) {
  const seen = new Set<string>();
  for (const [index, sense] of senses.entries()) {
    if (!isRecord(sense)) fail(`${field}[${index}] must be an object`);
    const senseId = nonEmptyString(sense.senseId, `${field}[${index}].senseId`);
    if (!(ECOSYSTEM_GRID_SENSE_IDS as readonly string[]).includes(senseId)) {
      fail(`${field}[${index}] has unknown sense "${senseId}"`);
    }
    if (seen.has(senseId)) fail(`${field} repeats sense "${senseId}"`);
    seen.add(senseId);
    if (sense.range !== undefined) {
      const range = integer(sense.range, `${field}[${index}].range`);
      if (range < 0 || range > 100) fail(`${field}[${index}].range is out of bounds`);
    }
    if (sense.channels !== undefined) {
      if (!Array.isArray(sense.channels)) fail(`${field}[${index}].channels must be an array`);
      const allowed = SENSE_CHANNELS[senseId as EcosystemSenseId];
      const channels = new Set<string>();
      for (const channel of sense.channels) {
        if (typeof channel !== "string" || !allowed.includes(channel)) {
          fail(`${field}[${index}] has unknown ${senseId} channel "${String(channel)}"`);
        }
        if (channels.has(channel)) fail(`${field}[${index}] repeats channel "${channel}"`);
        channels.add(channel);
      }
    }
  }
}

function maxSenseEntries(
  sense: SensePackage[number],
  config: EcosystemGridConfig,
): number {
  const senseId = sense.senseId as EcosystemSenseId;
  const authoredRange = sense.range ?? (senseId === "touch" ? 0 : 1);
  const range = Math.round(
    authoredRange * (config.heredity?.enabled ? MAX_PERCEPTION_TRAIT : 1),
  );
  const channels = sense.channels ?? SENSE_CHANNELS[senseId];
  const gridCells = config.width * config.height;
  const cellsInRange = Math.min(gridCells, 1 + 2 * range * (range + 1));
  let entries = 0;
  if (channels.includes("automata")) {
    entries += Math.min(config.maxAutomata - 1, Math.max(0, cellsInRange - 1));
  }
  if (channels.includes("resources")) entries += cellsInRange;
  if (channels.includes("corpses")) {
    // At most one full-population death wave is added per tick; each wave
    // remains visible for no more than corpseDecayTicks.
    entries += config.maxAutomata * config.corpseDecayTicks;
  }
  if (channels.includes("terrain")) {
    const terrainCells =
      (config.terrain?.shelter.length ?? 0) +
      (config.terrain?.current.length ?? 0) +
      (config.terrain?.shallows.length ?? 0);
    entries += Math.min(terrainCells, cellsInRange);
  }
  return entries;
}

/**
 * Spec-time scene envelope. Coefficients were measured against canonical JSON
 * with two-digit coordinates, full-precision intensities, headings, and long
 * current kind strings, then rounded up: 80 bytes/cell, 224/live entity, and
 * 144/corpse. Resources can eventually occupy every non-shelter cell; terrain
 * contributes one additional cell record at each authored coordinate.
 */
export function estimateEcosystemSceneBytes(config: EcosystemGridConfig): number {
  const gridCells = config.width * config.height;
  const shelterCells = config.terrain?.shelter.length ?? 0;
  const terrainCells =
    shelterCells +
    (config.terrain?.current.length ?? 0) +
    (config.terrain?.shallows.length ?? 0);
  return (
    SCENE_BASE_ESTIMATE_BYTES +
    config.maxAutomata * SCENE_AUTOMATON_ESTIMATE_BYTES +
    config.maxAutomata * config.corpseDecayTicks * SCENE_CORPSE_ESTIMATE_BYTES +
    (gridCells - shelterCells) * SCENE_RESOURCE_CELL_ESTIMATE_BYTES +
    terrainCells * SCENE_TERRAIN_CELL_ESTIMATE_BYTES
  );
}

export function estimateEcosystemCompiledTickBytes(
  config: EcosystemGridConfig,
  speciesSlots: readonly SpeciesSlot[],
): number {
  const slotsByCost = speciesSlots
    .map((slot) => ({
      slot,
      bytesPerAutomaton:
        COMPILED_TICK_BASE_BYTES_PER_AUTOMATON +
        COMPILED_TICK_BYTES_PER_SENSE_ENTRY *
          slot.senses.reduce(
            (total, sense) => total + maxSenseEntries(sense, config),
            0,
          ),
      count: 0,
    }))
    .sort((left, right) => right.bytesPerAutomaton - left.bytesPerAutomaton);
  const maximumPopulation = Math.min(
    config.maxAutomata,
    speciesSlots.reduce((total, slot) => total + slot.countMax, 0),
  );
  let remaining = Math.max(
    0,
    maximumPopulation,
  );
  for (const candidate of slotsByCost) {
    const added = Math.min(
      remaining,
      candidate.slot.countMax - candidate.count,
    );
    candidate.count += added;
    remaining -= added;
  }
  return slotsByCost.reduce(
    (total, candidate) =>
      total + candidate.count * candidate.bytesPerAutomaton,
    0,
  );
}

export function validateEcosystemSpec(spec: SimulatorSpec): void {
  if (spec.version !== SIMULATOR_PROTOCOL_VERSION) fail(`unsupported SimulatorSpec version ${spec.version}`);
  if (spec.templateId !== "ecosystemGrid") fail(`cannot validate template "${spec.templateId}"`);
  if (spec.templateVersion !== ECOSYSTEM_GRID_TEMPLATE_VERSION) {
    // There is intentionally no v1 replay shim: a stored ecosystem spec with
    // templateVersion 1 fails here, so launch/replay surfaces report
    // "unsupported template version 1" instead of running it under v2 physics.
    fail(`unsupported template version ${spec.templateVersion}`);
  }
  const config = validateEcosystemConfig(spec.config);
  if (spec.speciesSlots.length < 1 || spec.speciesSlots.length > MAX_ECOSYSTEM_SPECIES_SLOTS) {
    fail(`speciesSlots must contain from 1 through ${MAX_ECOSYSTEM_SPECIES_SLOTS} slots`);
  }
  const slotIds = new Set<string>();
  let defaultAutomata = 0;
  for (const [index, slot] of spec.speciesSlots.entries()) {
    const field = `speciesSlots[${index}]`;
    nonEmptyString(slot.slotId, `${field}.slotId`);
    nonEmptyString(slot.label, `${field}.label`);
    if (slotIds.has(slot.slotId)) fail(`speciesSlots repeats slotId "${slot.slotId}"`);
    slotIds.add(slot.slotId);
    if (
      !Number.isInteger(slot.countMin) ||
      !Number.isInteger(slot.countMax) ||
      !Number.isInteger(slot.defaultCount) ||
      slot.countMin < 0 ||
      slot.countMax < slot.countMin ||
      slot.defaultCount < slot.countMin ||
      slot.defaultCount > slot.countMax
    ) {
      fail(`${field} has an invalid count range`);
    }
    defaultAutomata += slot.defaultCount;
    validateSensePackage(slot.senses, `${field}.senses`);
  }
  for (const predatorSlotId of config.terrain?.predatorSlotIds ?? []) {
    if (!slotIds.has(predatorSlotId)) {
      fail(`config.terrain.predatorSlotIds names unknown slotId "${predatorSlotId}"`);
    }
  }
  if (config.scoringSlotId !== undefined && !slotIds.has(config.scoringSlotId)) {
    fail(`config.scoringSlotId names unknown slotId "${config.scoringSlotId}"`);
  }
  for (const [slotId, positions] of Object.entries(config.initialPositions ?? {})) {
    const slot = spec.speciesSlots.find((candidate) => candidate.slotId === slotId);
    if (!slot) fail(`config.initialPositions names unknown slotId "${slotId}"`);
    if (
      slot.countMin !== slot.countMax ||
      slot.countMin !== slot.defaultCount ||
      positions.length !== slot.defaultCount
    ) {
      fail(
        `config.initialPositions.${slotId} requires a fixed population matching its declared positions`,
      );
    }
    for (const point of positions) {
      if (
        isPredator(config, slotId) &&
        terrainAt(config, point)?.kind === "shelter"
      ) {
        fail(`config.initialPositions.${slotId} places a predator in shelter`);
      }
    }
  }
  const predatorSlotIds = new Set(config.terrain?.predatorSlotIds ?? []);
  const defaultPredators = spec.speciesSlots.reduce(
    (total, slot) =>
      total + (predatorSlotIds.has(slot.slotId) ? slot.defaultCount : 0),
    0,
  );
  const nonShelterCells =
    config.width * config.height - (config.terrain?.shelter.length ?? 0);
  if (defaultPredators > nonShelterCells) {
    fail("Shelter leaves too few cells for the default predator population");
  }
  if (
    defaultAutomata > config.maxAutomata ||
    defaultAutomata > MAX_AUTOMATA_COMPILED_RUN
  ) {
    fail("default species counts exceed the World automata limit");
  }
  if (
    config.maxAutomata > MAX_AUTOMATA_PER_RUN &&
    estimateEcosystemCompiledTickBytes(config, spec.speciesSlots) >
      MAX_COMPILED_TICK_ESTIMATE_BYTES
  ) {
    fail("compiled population senses are too broad for this World size");
  }
  if (estimateEcosystemSceneBytes(config) > MAX_SCENE_JSON_BYTES) {
    fail("config can produce a World scene larger than the scene byte limit");
  }
  const metricKeys = ECOSYSTEM_GRID.metricKeys as readonly string[];
  if (spec.criterion.kind === "measured" && !metricKeys.includes(spec.criterion.metricKey)) {
    fail(`criterion has unknown metric "${spec.criterion.metricKey}"`);
  }
  if (
    spec.criterion.kind === "measured" &&
    spec.criterion.metricKey === "scoringSlotSurvivors" &&
    !config.scoringSlotId
  ) {
    fail('criterion metric "scoringSlotSurvivors" requires config.scoringSlotId');
  }
  if (
    spec.criterion.kind === "measured" &&
    (spec.criterion.metricKey === "traitMean" ||
      spec.criterion.metricKey === "traitSpread" ||
      spec.criterion.metricKey === "perceptionMean" ||
      spec.criterion.metricKey === "perceptionSpread") &&
    !config.heredity?.enabled
  ) {
    fail(
      `criterion metric "${spec.criterion.metricKey}" requires config.heredity.enabled to be true`,
    );
  }
  const { iterationTicks, seasonTicks, absoluteMaxTicks } = spec.tickBudget;
  if (
    !Number.isInteger(iterationTicks) ||
    !Number.isInteger(seasonTicks) ||
    !Number.isInteger(absoluteMaxTicks) ||
    iterationTicks < 1 ||
    seasonTicks < iterationTicks ||
    absoluteMaxTicks < seasonTicks
  ) {
    fail("tickBudget must be positive and ordered iteration <= season <= absolute");
  }
}

function validateLaunchedSpecies(
  species: readonly LaunchedSpecies[],
  config: EcosystemGridConfig,
): void {
  if (species.length < 1 || species.length > MAX_ECOSYSTEM_SPECIES_SLOTS) {
    fail(`launch species must contain from 1 through ${MAX_ECOSYSTEM_SPECIES_SLOTS} slots`);
  }
  const ids = new Set<string>();
  let total = 0;
  for (const [index, slot] of species.entries()) {
    if (ids.has(slot.slotId)) fail(`launch species repeats slotId "${slot.slotId}"`);
    ids.add(slot.slotId);
    nonEmptyString(slot.slotId, `species[${index}].slotId`);
    nonEmptyString(slot.label, `species[${index}].label`);
    if (!Number.isInteger(slot.count) || slot.count < 0 || slot.count > slot.countMax) {
      fail(`species[${index}].count is outside its slot range`);
    }
    const fixedPositions = config.initialPositions?.[slot.slotId];
    if (fixedPositions && fixedPositions.length !== slot.count) {
      fail(`launch species "${slot.slotId}" does not match config.initialPositions`);
    }
    if (slot.prompt.length > MAX_PROMPT_CHARS) {
      fail(`species[${index}].prompt exceeds ${MAX_PROMPT_CHARS} characters`);
    }
    validateSensePackage(slot.senses, `species[${index}].senses`);
    total += slot.count;
  }
  for (const predatorSlotId of config.terrain?.predatorSlotIds ?? []) {
    if (!ids.has(predatorSlotId)) {
      fail(`config.terrain.predatorSlotIds names unknown launch slotId "${predatorSlotId}"`);
    }
  }
  const predatorSlotIds = new Set(config.terrain?.predatorSlotIds ?? []);
  const launchedPredators = species.reduce(
    (count, slot) => count + (predatorSlotIds.has(slot.slotId) ? slot.count : 0),
    0,
  );
  const nonShelterCells =
    config.width * config.height - (config.terrain?.shelter.length ?? 0);
  if (launchedPredators > nonShelterCells) {
    fail("Shelter leaves too few cells for the launched predator population");
  }
  if (total > config.maxAutomata || total > MAX_AUTOMATA_COMPILED_RUN) {
    fail("launch species exceed the World automata limit");
  }
  if (total > config.width * config.height) fail("launch species exceed available grid cells");
}

/**
 * A compact pure SHA-256 implementation keeps tie-breaking identical in Node,
 * Convex, browsers, and Hermes without importing a runtime or using ambient
 * randomness.
 */
function sha256Hex(text: string): string {
  const rightRotate = (value: number, amount: number) => (value >>> amount) | (value << (32 - amount));
  const maxWord = 2 ** 32;
  const words: number[] = [];
  const ascii = unescape(encodeURIComponent(text));
  const bitLength = ascii.length * 8;
  const hash: number[] = [];
  const constants: number[] = [];
  const composite: Record<number, boolean> = {};
  let primeCount = 0;
  for (let candidate = 2; primeCount < 64; candidate += 1) {
    if (composite[candidate]) continue;
    for (let multiple = candidate * candidate; multiple < 313; multiple += candidate) {
      composite[multiple] = true;
    }
    hash[primeCount] = (Math.sqrt(candidate) * maxWord) | 0;
    constants[primeCount] = (candidate ** (1 / 3) * maxWord) | 0;
    primeCount += 1;
  }
  let padded = `${ascii}\x80`;
  while (padded.length % 64 !== 56) padded += "\x00";
  for (let index = 0; index < padded.length; index += 1) {
    const code = padded.charCodeAt(index);
    words[index >> 2] = (words[index >> 2] ?? 0) | (code << ((3 - (index % 4)) * 8));
  }
  words.push(Math.floor(bitLength / maxWord), bitLength);

  for (let block = 0; block < words.length; block += 16) {
    const schedule = words.slice(block, block + 16);
    const previousHash = hash.slice(0, 8);
    let working = hash.slice(0, 8);
    for (let index = 0; index < 64; index += 1) {
      const w15 = schedule[index - 15];
      const w2 = schedule[index - 2];
      const scheduleWord =
        index < 16
          ? schedule[index]
          : (schedule[index - 16] +
              (rightRotate(w15, 7) ^ rightRotate(w15, 18) ^ (w15 >>> 3)) +
              schedule[index - 7] +
              (rightRotate(w2, 17) ^ rightRotate(w2, 19) ^ (w2 >>> 10))) |
            0;
      schedule[index] = scheduleWord;
      const e = working[4];
      const a = working[0];
      const temp1 =
        (working[7] +
          (rightRotate(e, 6) ^ rightRotate(e, 11) ^ rightRotate(e, 25)) +
          ((e & working[5]) ^ (~e & working[6])) +
          constants[index] +
          scheduleWord) |
        0;
      const temp2 =
        ((rightRotate(a, 2) ^ rightRotate(a, 13) ^ rightRotate(a, 22)) +
          ((a & working[1]) ^ (a & working[2]) ^ (working[1] & working[2]))) |
        0;
      working = [
        (temp1 + temp2) | 0,
        working[0],
        working[1],
        working[2],
        (working[3] + temp1) | 0,
        working[4],
        working[5],
        working[6],
      ];
    }
    for (let index = 0; index < 8; index += 1) hash[index] = (previousHash[index] + working[index]) | 0;
  }
  return hash
    .slice(0, 8)
    .map((word) => (word >>> 0).toString(16).padStart(8, "0"))
    .join("");
}

function seededRng(seed: string): () => number {
  const hex = sha256Hex(seed);
  let state = Number.parseInt(hex.slice(0, 8), 16) >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 2 ** 32;
  };
}

function deterministicUnit(seed: string): number {
  return Number.parseInt(sha256Hex(seed).slice(0, 13), 16) / 0x10000000000000;
}

function metabolicTrait(automaton: Readonly<EcosystemAutomaton>): number {
  return automaton.trait ?? 1;
}

function perceptionTrait(automaton: Readonly<EcosystemAutomaton>): number {
  return automaton.perceptionTrait ?? 1;
}

function optionalMetabolicTrait(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined;
  const trait = finiteNumber(value, field);
  if (trait < MIN_METABOLIC_TRAIT || trait > MAX_METABOLIC_TRAIT) {
    fail(`${field} must be between ${MIN_METABOLIC_TRAIT} and ${MAX_METABOLIC_TRAIT}`);
  }
  return trait;
}

export function inheritMetabolicTrait(input: {
  parentTrait: number;
  mutationStd: number;
  seed: string;
}): number {
  const rng = seededRng(input.seed);
  const u1 = Math.max(rng(), Number.EPSILON);
  const u2 = rng();
  const standardNormal = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  return Math.max(
    MIN_METABOLIC_TRAIT,
    Math.min(
      MAX_METABOLIC_TRAIT,
      input.parentTrait + standardNormal * input.mutationStd,
    ),
  );
}

function optionalPerceptionTrait(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined;
  const trait = finiteNumber(value, field);
  if (trait < MIN_PERCEPTION_TRAIT || trait > MAX_PERCEPTION_TRAIT) {
    fail(`${field} must be between ${MIN_PERCEPTION_TRAIT} and ${MAX_PERCEPTION_TRAIT}`);
  }
  return trait;
}

export function inheritPerceptionTrait(input: {
  parentTrait: number;
  mutationStd: number;
  seed: string;
}): number {
  const rng = seededRng(input.seed);
  const u1 = Math.max(rng(), Number.EPSILON);
  const u2 = rng();
  const standardNormal = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  return Math.max(
    MIN_PERCEPTION_TRAIT,
    Math.min(
      MAX_PERCEPTION_TRAIT,
      input.parentTrait + standardNormal * input.mutationStd,
    ),
  );
}

function pointKey(point: GridPoint): string {
  return `${point.x},${point.y}`;
}

function normalizePoint(point: GridPoint, config: EcosystemGridConfig): GridPoint | null {
  if (config.boundary === "toroidal") {
    return {
      x: ((point.x % config.width) + config.width) % config.width,
      y: ((point.y % config.height) + config.height) % config.height,
    };
  }
  if (point.x < 0 || point.x >= config.width || point.y < 0 || point.y >= config.height) {
    return null;
  }
  return point;
}

function axisDelta(from: number, to: number, size: number, toroidal: boolean): number {
  const direct = to - from;
  if (!toroidal) return direct;
  const wrapped = direct > 0 ? direct - size : direct + size;
  return Math.abs(wrapped) < Math.abs(direct) ? wrapped : direct;
}

function relativePoint(
  from: GridPoint,
  to: GridPoint,
  config: EcosystemGridConfig,
): { dx: number; dy: number; distance: number } {
  const toroidal = config.boundary === "toroidal";
  const dx = axisDelta(from.x, to.x, config.width, toroidal);
  const dy = axisDelta(from.y, to.y, config.height, toroidal);
  return { dx, dy, distance: Math.abs(dx) + Math.abs(dy) };
}

function resourceMap(resources: readonly EcosystemResource[]): Map<string, number> {
  return new Map(resources.map((resource) => [pointKey(resource), resource.biomass]));
}

function terrainAt(
  config: EcosystemGridConfig,
  point: GridPoint,
): { kind: EcosystemTerrainKind; direction?: "north" | "east" | "south" | "west" } | undefined {
  if (config.terrain?.shelter.some((cell) => cell.x === point.x && cell.y === point.y)) {
    return { kind: "shelter" };
  }
  const current = config.terrain?.current.find(
    (cell) => cell.x === point.x && cell.y === point.y,
  );
  if (current) return { kind: "current", direction: current.direction };
  if (config.terrain?.shallows.some((cell) => cell.x === point.x && cell.y === point.y)) {
    return { kind: "shallows" };
  }
  return undefined;
}

function isPredator(config: EcosystemGridConfig, slotId: string): boolean {
  return config.terrain?.predatorSlotIds.includes(slotId) ?? false;
}

function headingForMove(
  from: GridPoint,
  to: GridPoint,
  config: EcosystemGridConfig,
): number {
  const { dx, dy } = relativePoint(from, to, config);
  if (dx > 0) return 0;
  if (dy > 0) return Math.PI / 2;
  if (dx < 0) return Math.PI;
  return -Math.PI / 2;
}

function stableAutomata(automata: readonly EcosystemAutomaton[]): EcosystemAutomaton[] {
  return automata.map((automaton) => ({ ...automaton })).sort((a, b) => a.id.localeCompare(b.id));
}

export function createEcosystemInitialState(input: {
  config: EcosystemGridConfig;
  species: readonly LaunchedSpecies[];
  seed: string;
}): EcosystemState {
  const config = validateEcosystemConfig(input.config);
  validateLaunchedSpecies(input.species, config);
  const rng = seededRng(input.seed);
  const cells: GridPoint[] = [];
  for (let y = 0; y < config.height; y += 1) {
    for (let x = 0; x < config.width; x += 1) cells.push({ x, y });
  }
  for (let index = cells.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(rng() * (index + 1));
    [cells[index], cells[swap]] = [cells[swap], cells[index]];
  }
  const availableCells = [...cells];
  const automata: EcosystemAutomaton[] = [];
  const spawnOrder = input.species
    .map((species, index) => ({ species, index }))
    .sort(
      (left, right) =>
        Number(isPredator(config, right.species.slotId)) -
          Number(isPredator(config, left.species.slotId)) ||
        left.index - right.index,
    );
  for (const { species } of spawnOrder) {
    const fixedPositions = config.initialPositions?.[species.slotId];
    for (let index = 0; index < species.count; index += 1) {
      const fixedPoint = fixedPositions?.[index];
      const pointIndex = fixedPoint
        ? availableCells.findIndex(
            (point) => point.x === fixedPoint.x && point.y === fixedPoint.y,
          )
        : availableCells.findIndex(
            (point) =>
              !(
                isPredator(config, species.slotId) &&
                terrainAt(config, point)?.kind === "shelter"
              ),
          );
      if (pointIndex < 0) {
        fail(`no available initial cell for slot "${species.slotId}"`);
      }
      const [point] = availableCells.splice(pointIndex, 1);
      automata.push({
        id: `${species.slotId}:${index + 1}`,
        slotId: species.slotId,
        x: point.x,
        y: point.y,
        energy: config.reproductionEnergyThreshold * (0.6 + rng() * 0.2),
        hidden: false,
        bornTick: 0,
        heading: 0,
        ...(config.heredity?.enabled ? { trait: 1, perceptionTrait: 1 } : {}),
      });
    }
  }
  const resources: EcosystemResource[] = [];
  for (let y = 0; y < config.height; y += 1) {
    for (let x = 0; x < config.width; x += 1) {
      if (
        terrainAt(config, { x, y })?.kind !== "shelter" &&
        rng() < config.initialResourceDensity
      ) {
        resources.push({ x, y, biomass: 4 + rng() * 4 });
      }
    }
  }
  return {
    config,
    species: input.species.map(({ slotId, label, countMax, senses }) => ({
      slotId,
      label,
      countMax,
      senses: senses.map((sense) => ({
        ...sense,
        channels: sense.channels ? [...sense.channels] : undefined,
      })),
    })),
    automata: stableAutomata(automata),
    resources: resources.sort((a, b) => a.y - b.y || a.x - b.x),
    corpses: [],
    totalBirths: 0,
    totalDeaths: 0,
    totalInvalidActions: 0,
  };
}

function senseReading(
  state: Readonly<EcosystemState>,
  self: EcosystemAutomaton,
  senseId: EcosystemSenseId,
  range: number,
  requestedChannels?: readonly string[],
): EcosystemSenseReading {
  const channels = requestedChannels ?? SENSE_CHANNELS[senseId];
  const reading: EcosystemSenseReading = {};
  if (channels.includes("automata")) {
    reading.automata = state.automata
      .filter((other) => other.id !== self.id)
      .map((other) => ({ other, relative: relativePoint(self, other, state.config) }))
      .filter(({ other, relative }) => relative.distance <= range && (!other.hidden || senseId !== "vision"))
      .map(({ other, relative }) => ({
        id: other.id,
        slotId: other.slotId,
        ...relative,
        energy: other.energy,
        hidden: other.hidden,
      }))
      .sort((a, b) => a.distance - b.distance || a.id.localeCompare(b.id));
  }
  if (channels.includes("resources")) {
    reading.resources = state.resources
      .map((resource) => ({ resource, relative: relativePoint(self, resource, state.config) }))
      .filter(({ relative }) => relative.distance <= range)
      .map(({ resource, relative }) => ({ ...resource, ...relative }))
      .sort((a, b) => a.distance - b.distance || a.y - b.y || a.x - b.x);
  }
  if (channels.includes("corpses")) {
    reading.corpses = state.corpses
      .map((corpse) => ({ corpse, relative: relativePoint(self, corpse, state.config) }))
      .filter(({ relative }) => relative.distance <= range)
      .map(({ corpse, relative }) => ({
        id: corpse.id,
        slotId: corpse.slotId,
        ...relative,
      }))
      .sort((a, b) => a.distance - b.distance || a.id.localeCompare(b.id));
  }
  if (channels.includes("terrain")) {
    const terrain = [
      ...(state.config.terrain?.shelter.map((cell) => ({
        ...cell,
        kind: "shelter" as const,
      })) ?? []),
      ...(state.config.terrain?.current.map((cell) => ({
        ...cell,
        kind: "current" as const,
      })) ?? []),
      ...(state.config.terrain?.shallows.map((cell) => ({
        ...cell,
        kind: "shallows" as const,
      })) ?? []),
    ];
    reading.terrain = terrain
      .map((cell) => ({ cell, relative: relativePoint(self, cell, state.config) }))
      .filter(({ relative }) => relative.distance <= range)
      .map(({ cell, relative }) => ({ ...cell, ...relative }))
      .sort((a, b) => a.distance - b.distance || a.y - b.y || a.x - b.x);
  }
  if (channels.includes("boundary")) {
    reading.boundary =
      state.config.boundary === "toroidal"
        ? []
        : [
            ...(self.y <= range ? [{ side: "north" as const, distance: self.y }] : []),
            ...(state.config.width - 1 - self.x <= range
              ? [{ side: "east" as const, distance: state.config.width - 1 - self.x }]
              : []),
            ...(state.config.height - 1 - self.y <= range
              ? [{ side: "south" as const, distance: state.config.height - 1 - self.y }]
              : []),
            ...(self.x <= range ? [{ side: "west" as const, distance: self.x }] : []),
          ];
  }
  return reading;
}

export function buildEcosystemObservation(input: {
  state: Readonly<EcosystemState>;
  automatonId: string;
  senses: SensePackage;
  tick: number;
}): EcosystemObservation {
  const self = input.state.automata.find((automaton) => automaton.id === input.automatonId);
  if (!self) fail(`unknown automaton "${input.automatonId}"`);
  validateSensePackage(input.senses, `senses for ${input.automatonId}`);
  const observation: EcosystemObservation = {
    self: {
      id: self.id,
      slotId: self.slotId,
      x: self.x,
      y: self.y,
      energy: self.energy,
      hidden: self.hidden,
      ...(terrainAt(input.state.config, self)
        ? { terrain: terrainAt(input.state.config, self) }
        : {}),
    },
  };
  for (const sense of input.senses) {
    const senseId = sense.senseId as EcosystemSenseId;
    const scaledRange = effectiveEcosystemSenseRange({
      sense,
      perceptionTrait: perceptionTrait(self),
      inShallows: terrainAt(input.state.config, self)?.kind === "shallows",
    });
    observation[senseId] = senseReading(
      input.state,
      self,
      senseId,
      scaledRange,
      sense.channels,
    );
  }
  return observation;
}

function observedAutomata(observation: Readonly<EcosystemObservation>): SensedAutomaton[] {
  const byId = new Map<string, SensedAutomaton>();
  for (const reading of [observation.vision, observation.smell, observation.touch]) {
    for (const automaton of reading?.automata ?? []) byId.set(automaton.id, automaton);
  }
  return [...byId.values()];
}

function observedResources(observation: Readonly<EcosystemObservation>): SensedResource[] {
  const byPoint = new Map<string, SensedResource>();
  for (const reading of [observation.vision, observation.smell, observation.touch]) {
    for (const resource of reading?.resources ?? []) byPoint.set(pointKey(resource), resource);
  }
  return [...byPoint.values()];
}

export function ecosystemLegalActions(input: {
  state: Readonly<EcosystemState>;
  automatonId: string;
  observation: Readonly<EcosystemObservation>;
  tick: number;
}): readonly EcosystemAction[] {
  const self = input.state.automata.find((automaton) => automaton.id === input.automatonId);
  if (!self) return [{ kind: "noop" }];
  const actions: EcosystemAction[] = [];
  const destinations = new Map<string, GridPoint>();
  for (const step of CARDINAL_STEPS) {
    const destination = normalizePoint({ x: self.x + step.x, y: self.y + step.y }, input.state.config);
    if (
      destination &&
      !(
        isPredator(input.state.config, self.slotId) &&
        terrainAt(input.state.config, destination)?.kind === "shelter"
      )
    ) {
      destinations.set(pointKey(destination), destination);
    }
  }
  for (const destination of [...destinations.values()].sort((a, b) => a.y - b.y || a.x - b.x)) {
    actions.push({ kind: "move", to: destination });
  }
  for (const target of observedAutomata(input.observation)
    .filter(
      (automaton) => {
        const target = input.state.automata.find(
          (candidate) => candidate.id === automaton.id,
        );
        return (
          automaton.distance <= 1 &&
          target !== undefined &&
          terrainAt(input.state.config, target)?.kind !== "shelter"
        );
      },
    )
    .sort((a, b) => a.id.localeCompare(b.id))) {
    actions.push({ kind: "eat", targetId: target.id });
  }
  if (
    observedResources(input.observation).some(
      (resource) =>
        resource.x === self.x && resource.y === self.y && resource.biomass > 0,
    )
  ) {
    actions.push({ kind: "graze", at: { x: self.x, y: self.y } });
  }
  actions.push({ kind: "hide" }, { kind: "rest" });
  if (
    self.energy >= input.state.config.reproductionEnergyThreshold &&
    input.state.automata.length < input.state.config.maxAutomata
  ) {
    actions.push({ kind: "reproduce" });
  }
  actions.push({ kind: "noop" });
  return actions;
}

export function validateEcosystemAction(value: unknown): EcosystemAction {
  if (!isRecord(value)) fail("action must be an object");
  const kind = nonEmptyString(value.kind, "action.kind");
  switch (kind) {
    case "move":
      assertOnlyKeys(value, ["kind", "to"], "move action");
      return { kind, to: parsePoint(value.to, "move.to") };
    case "eat":
      assertOnlyKeys(value, ["kind", "targetId"], "eat action");
      return { kind, targetId: nonEmptyString(value.targetId, "eat.targetId") };
    case "graze":
      assertOnlyKeys(value, ["kind", "at"], "graze action");
      return { kind, at: parsePoint(value.at, "graze.at") };
    case "hide":
    case "rest":
    case "reproduce":
    case "noop":
      assertOnlyKeys(value, ["kind"], `${kind} action`);
      return { kind };
    default:
      return fail(`unknown action kind "${kind}"`);
  }
}

function canonicalAction(action: EcosystemAction): string {
  switch (action.kind) {
    case "move":
      return `move:${action.to.x},${action.to.y}`;
    case "eat":
      return `eat:${action.targetId}`;
    case "graze":
      return `graze:${action.at.x},${action.at.y}`;
    default:
      return action.kind;
  }
}

function phaseForTick(tick: number): string {
  return tick % 20 < 10 ? "day" : "night";
}

export function applyEcosystemActions(input: {
  state: Readonly<EcosystemState>;
  actions: ReadonlyMap<string, EcosystemAction>;
  tick: number;
  tickSeed: string;
}): {
  state: EcosystemState;
  delta: EcosystemDelta;
  terminal: boolean;
  phase: string;
} {
  const previous = input.state;
  const automata = stableAutomata(previous.automata);
  const speciesById = new Map(previous.species.map((species) => [species.slotId, species]));
  const accepted = new Map<string, EcosystemAction>();
  const invalidAutomatonIds: string[] = [];
  for (const automaton of automata) {
    const requested = input.actions.get(automaton.id) ?? { kind: "noop" };
    const species = speciesById.get(automaton.slotId);
    if (!species) fail(`state has no Species slot "${automaton.slotId}"`);
    const observation = buildEcosystemObservation({
      state: previous,
      automatonId: automaton.id,
      senses: species.senses,
      tick: input.tick,
    });
    const legal = ecosystemLegalActions({
      state: previous,
      automatonId: automaton.id,
      observation,
      tick: input.tick,
    });
    if (legal.some((action) => canonicalAction(action) === canonicalAction(requested))) {
      accepted.set(automaton.id, requested);
    } else {
      accepted.set(automaton.id, { kind: "noop" });
      invalidAutomatonIds.push(automaton.id);
    }
  }

  const moveCandidates = new Map<string, { automatonId: string; to: GridPoint }[]>();
  for (const automaton of automata) {
    const action = accepted.get(automaton.id);
    if (action?.kind !== "move") continue;
    const key = pointKey(action.to);
    const candidates = moveCandidates.get(key) ?? [];
    candidates.push({ automatonId: automaton.id, to: action.to });
    moveCandidates.set(key, candidates);
  }
  const provisionalMoves = new Map<string, GridPoint>();
  for (const [key, candidates] of [...moveCandidates.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    candidates.sort((a, b) => a.automatonId.localeCompare(b.automatonId));
    const winnerIndex = Math.floor(
      deterministicUnit(`${input.tickSeed}:${input.tick}:${key}`) * candidates.length,
    );
    const winner = candidates[Math.min(winnerIndex, candidates.length - 1)];
    provisionalMoves.set(winner.automatonId, winner.to);
  }
  const occupantByPoint = new Map(automata.map((automaton) => [pointKey(automaton), automaton.id]));
  let changed = true;
  while (changed) {
    changed = false;
    for (const [automatonId, destination] of provisionalMoves) {
      const occupant = occupantByPoint.get(pointKey(destination));
      if (occupant && occupant !== automatonId && !provisionalMoves.has(occupant)) {
        provisionalMoves.delete(automatonId);
        changed = true;
      }
    }
  }

  const moved: EcosystemDelta["moved"][number][] = [];
  let working = automata.map((automaton) => {
    const destination = provisionalMoves.get(automaton.id);
    if (!destination) return { ...automaton };
    moved.push({
      automatonId: automaton.id,
      from: { x: automaton.x, y: automaton.y },
      to: { ...destination },
    });
    return {
      ...automaton,
      ...destination,
      heading: headingForMove(automaton, destination, previous.config),
      hidden: false,
    };
  });
  const hidden: string[] = [];
  working = working.map((automaton) => {
    if (accepted.get(automaton.id)?.kind !== "hide") return automaton;
    hidden.push(automaton.id);
    return { ...automaton, hidden: true };
  });

  const eaten: EcosystemDelta["eaten"][number][] = [];
  const died: EcosystemDelta["died"][number][] = [];
  const corpses = previous.corpses
    .filter((corpse) => corpse.decaysAtTick > input.tick + 1)
    .map((corpse) => ({ ...corpse }));
  const consumed = new Set<string>();
  const energyGain = new Map<string, number>();
  const workingById = new Map(working.map((automaton) => [automaton.id, automaton]));
  for (const automaton of working) {
    const action = accepted.get(automaton.id);
    if (
      action?.kind !== "eat" ||
      consumed.has(automaton.id) ||
      consumed.has(action.targetId)
    ) {
      continue;
    }
    const target = workingById.get(action.targetId);
    if (
      !target ||
      relativePoint(automaton, target, previous.config).distance > 1 ||
      terrainAt(previous.config, target)?.kind === "shelter"
    ) {
      continue;
    }
    consumed.add(target.id);
    eaten.push({ automatonId: automaton.id, targetId: target.id });
    died.push({ automatonId: target.id, cause: "eaten" });
    energyGain.set(
      automaton.id,
      (energyGain.get(automaton.id) ?? 0) + target.energy * EAT_ENERGY_FRACTION,
    );
    corpses.push({
      id: `corpse:${target.id}:${input.tick + 1}`,
      slotId: target.slotId,
      x: target.x,
      y: target.y,
      decaysAtTick: input.tick + 1 + previous.config.corpseDecayTicks,
    });
  }
  working = working.filter((automaton) => !consumed.has(automaton.id));

  const resources = resourceMap(previous.resources);
  const grazed: EcosystemDelta["grazed"][number][] = [];
  for (const automaton of working) {
    const action = accepted.get(automaton.id);
    if (action?.kind !== "graze") continue;
    const key = pointKey(action.at);
    const available = resources.get(key) ?? 0;
    const amount = Math.min(GRAZE_AMOUNT, available);
    if (amount <= 0) continue;
    resources.set(key, available - amount);
    energyGain.set(automaton.id, (energyGain.get(automaton.id) ?? 0) + amount);
    grazed.push({ automatonId: automaton.id, at: { ...action.at }, amount });
  }

  working = working.map((automaton) => {
    const action = accepted.get(automaton.id);
    const gain = energyGain.get(automaton.id) ?? 0;
    if (!previous.config.heredity?.enabled) {
      return {
        ...automaton,
        energy:
          automaton.energy -
          previous.config.baseMetabolicCost +
          (action?.kind === "rest" ? previous.config.baseMetabolicCost * 0.5 : 0) +
          gain,
      };
    }
    const effectiveMetabolicCost =
      previous.config.baseMetabolicCost *
      (metabolicTrait(automaton) +
        PERCEPTION_SURCHARGE_PER_TRAIT_POINT *
          (perceptionTrait(automaton) - MIN_PERCEPTION_TRAIT));
    return {
      ...automaton,
      energy:
        automaton.energy -
        effectiveMetabolicCost +
        (action?.kind === "rest" ? effectiveMetabolicCost * 0.5 : 0) +
        gain,
    };
  });
  const metabolicDeaths = working.filter((automaton) => automaton.energy <= 0);
  for (const automaton of metabolicDeaths) {
    died.push({ automatonId: automaton.id, cause: "metabolism" });
    corpses.push({
      id: `corpse:${automaton.id}:${input.tick + 1}`,
      slotId: automaton.slotId,
      x: automaton.x,
      y: automaton.y,
      decaysAtTick: input.tick + 1 + previous.config.corpseDecayTicks,
    });
  }
  const metabolicDeathIds = new Set(metabolicDeaths.map((automaton) => automaton.id));
  working = working.filter((automaton) => !metabolicDeathIds.has(automaton.id));

  const occupied = new Set(working.map(pointKey));
  const born: EcosystemAutomaton[] = [];
  for (const parent of working) {
    if (accepted.get(parent.id)?.kind !== "reproduce") continue;
    if (parent.energy < previous.config.reproductionEnergyThreshold) continue;
    if (working.length + born.length >= previous.config.maxAutomata) break;
    const slot = speciesById.get(parent.slotId);
    const slotPopulation =
      working.filter((automaton) => automaton.slotId === parent.slotId).length +
      born.filter((automaton) => automaton.slotId === parent.slotId).length;
    if (!slot || slotPopulation >= slot.countMax) continue;
    const free = CARDINAL_STEPS.map((step) =>
      normalizePoint({ x: parent.x + step.x, y: parent.y + step.y }, previous.config),
    )
      .filter(
        (point): point is GridPoint =>
          point !== null &&
          !occupied.has(pointKey(point)) &&
          !(
            isPredator(previous.config, parent.slotId) &&
            terrainAt(previous.config, point)?.kind === "shelter"
          ),
      )
      .sort((a, b) => a.y - b.y || a.x - b.x)[0];
    if (!free) continue;
    const childEnergy = parent.energy / 2;
    parent.energy = childEnergy;
    const child: EcosystemAutomaton = {
      id: `${parent.id}:b${input.tick + 1}:${born.length + 1}`,
      slotId: parent.slotId,
      ...free,
      energy: childEnergy,
      hidden: false,
      bornTick: input.tick + 1,
      heading: parent.heading ?? 0,
      ...(previous.config.heredity?.enabled
        ? {
            trait: inheritMetabolicTrait({
              parentTrait: metabolicTrait(parent),
              mutationStd: previous.config.heredity.mutationStd,
              seed: `${input.tickSeed}:${input.tick}:trait:${parent.id}:${born.length + 1}`,
            }),
            perceptionTrait: inheritPerceptionTrait({
              parentTrait: perceptionTrait(parent),
              mutationStd: previous.config.heredity.mutationStd,
              seed: `${input.tickSeed}:${input.tick}:perceptionTrait:${parent.id}:${born.length + 1}`,
            }),
          }
        : {}),
    };
    born.push(child);
    occupied.add(pointKey(free));
  }
  working.push(...born);
  working = stableAutomata(working);

  const currentByPoint = new Map(
    (previous.config.terrain?.current ?? []).map((cell) => [pointKey(cell), cell]),
  );
  const currentSteps = {
    north: { x: 0, y: -1 },
    east: { x: 1, y: 0 },
    south: { x: 0, y: 1 },
    west: { x: -1, y: 0 },
  } as const;
  const currentCandidates = new Map<string, { automatonId: string; to: GridPoint }[]>();
  for (const automaton of working) {
    const current = currentByPoint.get(pointKey(automaton));
    if (!current) continue;
    const step = currentSteps[current.direction];
    const destination = normalizePoint(
      { x: automaton.x + step.x, y: automaton.y + step.y },
      previous.config,
    );
    if (
      !destination ||
      (isPredator(previous.config, automaton.slotId) &&
        terrainAt(previous.config, destination)?.kind === "shelter")
    ) {
      continue;
    }
    const candidates = currentCandidates.get(pointKey(destination)) ?? [];
    candidates.push({ automatonId: automaton.id, to: destination });
    currentCandidates.set(pointKey(destination), candidates);
  }
  const currentMoves = new Map<string, GridPoint>();
  for (const [key, candidates] of [...currentCandidates.entries()].sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    candidates.sort((a, b) => a.automatonId.localeCompare(b.automatonId));
    const winnerIndex = Math.floor(
      deterministicUnit(`${input.tickSeed}:${input.tick}:current:${key}`) *
        candidates.length,
    );
    const winner = candidates[Math.min(winnerIndex, candidates.length - 1)];
    currentMoves.set(winner.automatonId, winner.to);
  }
  const currentOccupants = new Map(
    working.map((automaton) => [pointKey(automaton), automaton.id]),
  );
  changed = true;
  while (changed) {
    changed = false;
    for (const [automatonId, destination] of currentMoves) {
      const occupant = currentOccupants.get(pointKey(destination));
      if (occupant && occupant !== automatonId && !currentMoves.has(occupant)) {
        currentMoves.delete(automatonId);
        changed = true;
      }
    }
  }
  const tickStartById = new Map(automata.map((automaton) => [automaton.id, automaton]));
  working = stableAutomata(
    working.map((automaton) => {
      const destination = currentMoves.get(automaton.id);
      if (!destination) return automaton;
      const from = tickStartById.get(automaton.id) ?? automaton;
      const existingMove = moved.find((entry) => entry.automatonId === automaton.id);
      if (existingMove) existingMove.to = { ...destination };
      else {
        moved.push({
          automatonId: automaton.id,
          from: { x: from.x, y: from.y },
          to: { ...destination },
        });
      }
      // A current is environment-driven displacement, not an accepted move:
      // preserve the heading set by this tick's deliberate move (or prior rest).
      return { ...automaton, ...destination, hidden: false };
    }),
  );
  for (let index = 0; index < born.length; index += 1) {
    const displaced = working.find((automaton) => automaton.id === born[index].id);
    if (displaced) born[index] = displaced;
  }

  const beforeResources = resourceMap(previous.resources);
  for (let y = 0; y < previous.config.height; y += 1) {
    for (let x = 0; x < previous.config.width; x += 1) {
      const key = pointKey({ x, y });
      const terrain = terrainAt(previous.config, { x, y });
      if (terrain?.kind === "shelter") {
        resources.delete(key);
        continue;
      }
      const noise = previous.config.environmentalNoise.enabled
        ? (deterministicUnit(`${input.tickSeed}:${input.tick}:resource:${key}`) * 2 - 1) *
          previous.config.environmentalNoise.amplitude
        : 0;
      const next = Math.max(
        0,
        Math.min(
          RESOURCE_CAPACITY,
          (resources.get(key) ?? 0) +
            previous.config.resourceRegrowthPerTick *
              (terrain?.kind === "shallows" ? 2 : 1) +
            noise,
        ),
      );
      if (next > 0) resources.set(key, next);
      else resources.delete(key);
    }
  }
  const resourceChanges: EcosystemDelta["resourceChanges"][number][] = [];
  const resourceKeys = new Set([...beforeResources.keys(), ...resources.keys()]);
  for (const key of [...resourceKeys].sort()) {
    const before = beforeResources.get(key) ?? 0;
    const after = resources.get(key) ?? 0;
    if (before === after) continue;
    const [x, y] = key.split(",").map(Number);
    resourceChanges.push({ at: { x, y }, before, after });
  }
  const nextResources = [...resources.entries()]
    .map(([key, biomass]) => {
      const [x, y] = key.split(",").map(Number);
      return { x, y, biomass };
    })
    .sort((a, b) => a.y - b.y || a.x - b.x);

  const state: EcosystemState = {
    config: {
      ...previous.config,
      environmentalNoise: { ...previous.config.environmentalNoise },
      ...(previous.config.heredity
        ? { heredity: { ...previous.config.heredity } }
        : {}),
      ...(previous.config.landscape
        ? { landscape: { ...previous.config.landscape } }
        : {}),
      ...(previous.config.terrain
        ? {
            terrain: {
              shelter: previous.config.terrain.shelter.map((cell) => ({ ...cell })),
              current: previous.config.terrain.current.map((cell) => ({ ...cell })),
              shallows: previous.config.terrain.shallows.map((cell) => ({ ...cell })),
              predatorSlotIds: [...previous.config.terrain.predatorSlotIds],
            },
          }
        : {}),
      ...(previous.config.initialPositions
        ? {
            initialPositions: Object.fromEntries(
              Object.entries(previous.config.initialPositions).map(([slotId, positions]) => [
                slotId,
                positions.map((point) => ({ ...point })),
              ]),
            ),
          }
        : {}),
      ...(previous.config.scoringSlotId
        ? { scoringSlotId: previous.config.scoringSlotId }
        : {}),
    },
    species: previous.species.map((species) => ({
      ...species,
      senses: species.senses.map((sense) => ({
        ...sense,
        channels: sense.channels ? [...sense.channels] : undefined,
      })),
    })),
    automata: working,
    resources: nextResources,
    corpses: corpses.sort((a, b) => a.id.localeCompare(b.id)),
    totalBirths: previous.totalBirths + born.length,
    totalDeaths: previous.totalDeaths + died.length,
    totalInvalidActions: previous.totalInvalidActions + invalidAutomatonIds.length,
  };
  return {
    state,
    delta: {
      moved: moved.sort((a, b) => a.automatonId.localeCompare(b.automatonId)),
      hidden: hidden.sort(),
      grazed: grazed.sort((a, b) => a.automatonId.localeCompare(b.automatonId)),
      eaten: eaten.sort((a, b) => a.automatonId.localeCompare(b.automatonId)),
      born,
      died: died.sort((a, b) => a.automatonId.localeCompare(b.automatonId)),
      resourceChanges,
      invalidAutomatonIds: invalidAutomatonIds.sort(),
    },
    terminal: state.automata.length === 0,
    phase: phaseForTick(input.tick),
  };
}

export function ecosystemMetrics(input: {
  previousState: Readonly<EcosystemState>;
  state: Readonly<EcosystemState>;
  tick: number;
}): EcosystemMetrics {
  const livingSpecies = new Set(input.state.automata.map((automaton) => automaton.slotId)).size;
  // An extinct population has no trait samples. Carry its final living values
  // forward instead of inventing the founder defaults, which would make a dead
  // lineage look as though evolution had returned it to baseline.
  const traitPopulation =
    input.state.automata.length > 0 ? input.state.automata : input.previousState.automata;
  const traits = input.state.config.heredity?.enabled
    ? traitPopulation.map(metabolicTrait)
    : [];
  const traitMean =
    traits.length > 0
      ? traits.reduce((total, trait) => total + trait, 0) / traits.length
      : 1;
  const traitSpread =
    traits.length > 0 ? Math.max(...traits) - Math.min(...traits) : 0;
  const perceptions = input.state.config.heredity?.enabled
    ? traitPopulation.map(perceptionTrait)
    : [];
  const perceptionMean =
    perceptions.length > 0
      ? perceptions.reduce((total, trait) => total + trait, 0) / perceptions.length
      : 1;
  const perceptionSpread =
    perceptions.length > 0 ? Math.max(...perceptions) - Math.min(...perceptions) : 0;
  return {
    longevity: input.tick + 1,
    livingAutomata: input.state.automata.length,
    scoringSlotSurvivors: input.state.config.scoringSlotId
      ? input.state.automata.filter(
          (automaton) => automaton.slotId === input.state.config.scoringSlotId,
        ).length
      : 0,
    livingSpecies,
    resourceBiomass: input.state.resources.reduce(
      (total, resource) => total + resource.biomass,
      0,
    ),
    totalEnergy: input.state.automata.reduce((total, automaton) => total + automaton.energy, 0),
    births: input.state.totalBirths,
    deaths: input.state.totalDeaths,
    invalidActions: input.state.totalInvalidActions,
    traitMean,
    traitSpread,
    perceptionMean,
    perceptionSpread,
  };
}

export function renderEcosystemScene(input: {
  state: Readonly<EcosystemState>;
  tick: number;
}): SimulatorSceneV1 {
  const colorBySlot = new Map(
    input.state.species.map((species, index) => [
      species.slotId,
      SPECIES_COLORS[index % SPECIES_COLORS.length],
    ]),
  );
  return {
    protocolVersion: RENDERER_PROTOCOL_VERSION,
    templateId: "ecosystemGrid",
    tick: input.tick,
    viewport: {
      width: input.state.config.width,
      height: input.state.config.height,
      boundary: input.state.config.boundary,
    },
    entities: [
      ...input.state.automata.map((automaton) => ({
        id: automaton.id,
        kind: "automaton",
        slotId: automaton.slotId,
        x: automaton.x,
        y: automaton.y,
        layer: 2,
        label: input.state.species.find((species) => species.slotId === automaton.slotId)?.label,
        color: colorBySlot.get(automaton.slotId),
        size: input.state.config.heredity?.enabled
          ? Math.min(
              1.2,
              Math.max(
                0.8,
                0.8 +
                  ((metabolicTrait(automaton) - MIN_METABOLIC_TRAIT) /
                    (MAX_METABOLIC_TRAIT - MIN_METABOLIC_TRAIT)) *
                    0.4,
              ),
            )
          : 0.8,
        hidden: automaton.hidden,
        energy: automaton.energy,
        ...(input.state.config.heredity?.enabled
          ? { trait: metabolicTrait(automaton) }
          : {}),
        perceptionTrait: perceptionTrait(automaton),
        heading: automaton.heading ?? 0,
      })),
      ...input.state.corpses.map((corpse) => ({
        id: corpse.id,
        kind: "corpse",
        automatonId: corpse.id.split(":").slice(1, -1).join(":"),
        x: corpse.x,
        y: corpse.y,
        layer: 1,
        color: "#78716C",
        size: 0.55,
      })),
    ].sort((a, b) => a.layer - b.layer || a.id.localeCompare(b.id)),
    cells: [
      ...(input.state.config.terrain?.shelter.map((cell) => ({
        ...cell,
        kind: "shelter",
        intensity: 1,
      })) ?? []),
      ...(input.state.config.terrain?.current.map((cell) => ({
        x: cell.x,
        y: cell.y,
        kind: `current_${cell.direction}`,
        intensity: 1,
      })) ?? []),
      ...(input.state.config.terrain?.shallows.map((cell) => ({
        ...cell,
        kind: "shallows",
        intensity: 1,
      })) ?? []),
      ...input.state.resources.map((resource) => ({
        x: resource.x,
        y: resource.y,
        kind: "resource",
        intensity: resource.biomass / RESOURCE_CAPACITY,
      })),
    ],
  };
}

function validateEcosystemState(value: unknown): EcosystemState {
  if (!isRecord(value)) fail("state must be an object");
  const config = validateEcosystemConfig(value.config);
  if (
    !Array.isArray(value.species) ||
    !Array.isArray(value.automata) ||
    !Array.isArray(value.resources) ||
    !Array.isArray(value.corpses)
  ) {
    fail("state collections must be arrays");
  }
  const species: EcosystemSpeciesState[] = value.species.map((raw, index) => {
    if (!isRecord(raw)) fail(`state.species[${index}] must be an object`);
    if (!Array.isArray(raw.senses)) fail(`state.species[${index}].senses must be an array`);
    const senses = raw.senses.map((sense, senseIndex) => {
      if (!isRecord(sense)) fail(`state.species[${index}].senses[${senseIndex}] must be an object`);
      if (
        sense.channels !== undefined &&
        (!Array.isArray(sense.channels) ||
          sense.channels.some((channel) => typeof channel !== "string"))
      ) {
        fail(`state.species[${index}].senses[${senseIndex}].channels must be strings`);
      }
      return {
        senseId: nonEmptyString(
          sense.senseId,
          `state.species[${index}].senses[${senseIndex}].senseId`,
        ),
        range:
          sense.range === undefined
            ? undefined
            : integer(sense.range, `state.species[${index}].senses[${senseIndex}].range`),
        channels: sense.channels === undefined ? undefined : [...sense.channels],
      };
    });
    validateSensePackage(senses, `state.species[${index}].senses`);
    return {
      slotId: nonEmptyString(raw.slotId, `state.species[${index}].slotId`),
      label: nonEmptyString(raw.label, `state.species[${index}].label`),
      countMax: integer(raw.countMax, `state.species[${index}].countMax`),
      senses,
    };
  });
  const slotIds = new Set(species.map((slot) => slot.slotId));
  if (slotIds.size !== species.length) fail("state.species repeats a slotId");

  const parseAutomaton = (raw: unknown, field: string): EcosystemAutomaton => {
    if (!isRecord(raw)) fail(`${field} must be an object`);
    const trait = optionalMetabolicTrait(raw.trait, `${field}.trait`);
    const parsedPerceptionTrait = optionalPerceptionTrait(
      raw.perceptionTrait,
      `${field}.perceptionTrait`,
    );
    const automaton = {
      id: nonEmptyString(raw.id, `${field}.id`),
      slotId: nonEmptyString(raw.slotId, `${field}.slotId`),
      x: integer(raw.x, `${field}.x`),
      y: integer(raw.y, `${field}.y`),
      energy: finiteNumber(raw.energy, `${field}.energy`),
      hidden: raw.hidden,
      bornTick: integer(raw.bornTick, `${field}.bornTick`),
      heading:
        raw.heading === undefined ? undefined : finiteNumber(raw.heading, `${field}.heading`),
      ...(trait === undefined ? {} : { trait }),
      ...(parsedPerceptionTrait === undefined
        ? {}
        : { perceptionTrait: parsedPerceptionTrait }),
    };
    if (typeof automaton.hidden !== "boolean") fail(`${field}.hidden must be boolean`);
    if (!slotIds.has(automaton.slotId)) fail(`${field} has unknown slotId "${automaton.slotId}"`);
    if (normalizePoint(automaton, config) === null) fail(`${field} is outside the grid`);
    return { ...automaton, hidden: automaton.hidden };
  };
  const automata = value.automata.map((raw, index) =>
    parseAutomaton(raw, `state.automata[${index}]`),
  );
  if (new Set(automata.map((automaton) => automaton.id)).size !== automata.length) {
    fail("state.automata repeats an id");
  }
  if (automata.length > config.maxAutomata) fail("state exceeds config.maxAutomata");
  for (const automaton of automata) {
    if (
      isPredator(config, automaton.slotId) &&
      terrainAt(config, automaton)?.kind === "shelter"
    ) {
      fail(`state predator "${automaton.id}" occupies shelter`);
    }
  }

  const resources = value.resources.map((raw, index) => {
    if (!isRecord(raw)) fail(`state.resources[${index}] must be an object`);
    const resource = {
      x: integer(raw.x, `state.resources[${index}].x`),
      y: integer(raw.y, `state.resources[${index}].y`),
      biomass: finiteNumber(raw.biomass, `state.resources[${index}].biomass`),
    };
    if (normalizePoint(resource, config) === null) fail(`state.resources[${index}] is outside the grid`);
    if (resource.biomass <= 0 || resource.biomass > RESOURCE_CAPACITY) {
      fail(`state.resources[${index}].biomass is out of bounds`);
    }
    if (terrainAt(config, resource)?.kind === "shelter") {
      fail(`state.resources[${index}] occupies shelter`);
    }
    return resource;
  });
  if (new Set(resources.map(pointKey)).size !== resources.length) {
    fail("state.resources repeats a cell");
  }

  const corpses = value.corpses.map((raw, index) => {
    if (!isRecord(raw)) fail(`state.corpses[${index}] must be an object`);
    const corpse = {
      id: nonEmptyString(raw.id, `state.corpses[${index}].id`),
      slotId: nonEmptyString(raw.slotId, `state.corpses[${index}].slotId`),
      x: integer(raw.x, `state.corpses[${index}].x`),
      y: integer(raw.y, `state.corpses[${index}].y`),
      decaysAtTick: integer(raw.decaysAtTick, `state.corpses[${index}].decaysAtTick`),
    };
    if (!slotIds.has(corpse.slotId)) fail(`state.corpses[${index}] has an unknown slotId`);
    if (normalizePoint(corpse, config) === null) fail(`state.corpses[${index}] is outside the grid`);
    return corpse;
  });
  return {
    config,
    species,
    automata: stableAutomata(automata),
    resources: resources.sort((a, b) => a.y - b.y || a.x - b.x),
    corpses: corpses.sort((a, b) => a.id.localeCompare(b.id)),
    totalBirths: integer(value.totalBirths, "state.totalBirths"),
    totalDeaths: integer(value.totalDeaths, "state.totalDeaths"),
    totalInvalidActions: integer(value.totalInvalidActions, "state.totalInvalidActions"),
  };
}

function validateEcosystemDelta(value: unknown): EcosystemDelta {
  if (!isRecord(value)) fail("delta must be an object");
  const arrayField = (key: string): unknown[] => {
    const field = value[key];
    if (!Array.isArray(field)) fail(`delta.${key} must be an array`);
    return field;
  };
  const movedValues = arrayField("moved");
  const hiddenValues = arrayField("hidden");
  const grazedValues = arrayField("grazed");
  const eatenValues = arrayField("eaten");
  const bornValues = arrayField("born");
  const diedValues = arrayField("died");
  const resourceChangeValues = arrayField("resourceChanges");
  const invalidAutomatonIdValues = arrayField("invalidAutomatonIds");
  const stringArray = (values: unknown[], field: string): string[] =>
    values.map((entry, index) => nonEmptyString(entry, `${field}[${index}]`));
  const moved = movedValues.map((raw, index) => {
    if (!isRecord(raw)) fail(`delta.moved[${index}] must be an object`);
    return {
      automatonId: nonEmptyString(raw.automatonId, `delta.moved[${index}].automatonId`),
      from: parsePoint(raw.from, `delta.moved[${index}].from`),
      to: parsePoint(raw.to, `delta.moved[${index}].to`),
    };
  });
  const grazed = grazedValues.map((raw, index) => {
    if (!isRecord(raw)) fail(`delta.grazed[${index}] must be an object`);
    return {
      automatonId: nonEmptyString(raw.automatonId, `delta.grazed[${index}].automatonId`),
      at: parsePoint(raw.at, `delta.grazed[${index}].at`),
      amount: finiteNumber(raw.amount, `delta.grazed[${index}].amount`),
    };
  });
  const eaten = eatenValues.map((raw, index) => {
    if (!isRecord(raw)) fail(`delta.eaten[${index}] must be an object`);
    return {
      automatonId: nonEmptyString(raw.automatonId, `delta.eaten[${index}].automatonId`),
      targetId: nonEmptyString(raw.targetId, `delta.eaten[${index}].targetId`),
    };
  });
  const born = bornValues.map((raw, index) => {
    if (!isRecord(raw)) fail(`delta.born[${index}] must be an object`);
    if (typeof raw.hidden !== "boolean") fail(`delta.born[${index}].hidden must be boolean`);
    const trait = optionalMetabolicTrait(raw.trait, `delta.born[${index}].trait`);
    const parsedPerceptionTrait = optionalPerceptionTrait(
      raw.perceptionTrait,
      `delta.born[${index}].perceptionTrait`,
    );
    return {
      id: nonEmptyString(raw.id, `delta.born[${index}].id`),
      slotId: nonEmptyString(raw.slotId, `delta.born[${index}].slotId`),
      x: integer(raw.x, `delta.born[${index}].x`),
      y: integer(raw.y, `delta.born[${index}].y`),
      energy: finiteNumber(raw.energy, `delta.born[${index}].energy`),
      hidden: raw.hidden,
      bornTick: integer(raw.bornTick, `delta.born[${index}].bornTick`),
      heading:
        raw.heading === undefined
          ? undefined
          : finiteNumber(raw.heading, `delta.born[${index}].heading`),
      ...(trait === undefined ? {} : { trait }),
      ...(parsedPerceptionTrait === undefined
        ? {}
        : { perceptionTrait: parsedPerceptionTrait }),
    };
  });
  const died = diedValues.map((raw, index) => {
    if (!isRecord(raw)) fail(`delta.died[${index}] must be an object`);
    if (raw.cause !== "eaten" && raw.cause !== "metabolism") {
      fail(`delta.died[${index}].cause is unknown`);
    }
    const cause: "eaten" | "metabolism" = raw.cause;
    return {
      automatonId: nonEmptyString(raw.automatonId, `delta.died[${index}].automatonId`),
      cause,
    };
  });
  const resourceChanges = resourceChangeValues.map((raw, index) => {
    if (!isRecord(raw)) fail(`delta.resourceChanges[${index}] must be an object`);
    return {
      at: parsePoint(raw.at, `delta.resourceChanges[${index}].at`),
      before: finiteNumber(raw.before, `delta.resourceChanges[${index}].before`),
      after: finiteNumber(raw.after, `delta.resourceChanges[${index}].after`),
    };
  });
  return {
    moved,
    hidden: stringArray(hiddenValues, "delta.hidden"),
    grazed,
    eaten,
    born,
    died,
    resourceChanges,
    invalidAutomatonIds: stringArray(invalidAutomatonIdValues, "delta.invalidAutomatonIds"),
  };
}

export const ECOSYSTEM_GRID: SimulatorTemplate<
  EcosystemGridConfig,
  EcosystemState,
  EcosystemObservation,
  EcosystemAction,
  EcosystemDelta,
  EcosystemMetrics
> = {
  id: "ecosystemGrid",
  version: ECOSYSTEM_GRID_TEMPLATE_VERSION,
  rendererProtocolVersion: RENDERER_PROTOCOL_VERSION,
  // Stage B owns the substantive prompt manual and measured artifact. Zero
  // means cache_control MUST be omitted rather than claiming an unmeasured hit.
  cacheablePrefixMeasuredTokens: 0,
  senseIds: ECOSYSTEM_GRID_SENSE_IDS,
  actionKinds: ECOSYSTEM_GRID_ACTION_KINDS,
  actionSchema: ECOSYSTEM_GRID_ACTION_SCHEMA,
  metricKeys: [
    "longevity",
    "livingAutomata",
    "scoringSlotSurvivors",
    "livingSpecies",
    "resourceBiomass",
    "totalEnergy",
    "births",
    "deaths",
    "invalidActions",
    "traitMean",
    "traitSpread",
    "perceptionMean",
    "perceptionSpread",
  ],
  summaryMetricKeys: [
    "longevity",
    "livingAutomata",
    "scoringSlotSurvivors",
    "livingSpecies",
    "resourceBiomass",
    "totalEnergy",
    "traitMean",
    "traitSpread",
    "perceptionMean",
    "perceptionSpread",
  ],
  validateConfig: validateEcosystemConfig,
  validateState: validateEcosystemState,
  validateAction: validateEcosystemAction,
  validateDelta: validateEcosystemDelta,
  validateSpec: validateEcosystemSpec,
  initialState: createEcosystemInitialState,
  buildObservation: buildEcosystemObservation,
  legalActions: ecosystemLegalActions,
  listAutomata: (state) =>
    state.automata.map((automaton) => ({
      id: automaton.id,
      slotId: automaton.slotId,
      senses:
        state.species.find((species) => species.slotId === automaton.slotId)?.senses ?? [],
    })),
  tickPhase: ({ tick }) => phaseForTick(tick),
  applyActions: applyEcosystemActions,
  metrics: ecosystemMetrics,
  withInvalidActions: ({ state, count }) => ({
    ...state,
    totalInvalidActions: state.totalInvalidActions + count,
  }),
  withInvalidActionDelta: ({ delta, automatonIds }) => ({
    ...delta,
    invalidAutomatonIds: [...delta.invalidAutomatonIds, ...automatonIds].sort(),
  }),
  renderScene: renderEcosystemScene,
};
