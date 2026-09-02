import { describe, expect, it } from "vitest";

import {
  assembleSimulatorSpec,
  EXAMPLE_ECOSYSTEM_AUTHOR_INPUT,
  validatedSimulatorSpec,
} from "../../../convex/lib/simulatorTemplatesCatalog";
import {
  MAX_SCENE_JSON_BYTES,
  MAX_AUTOMATA_COMPILED_RUN,
  MAX_GRID_CELLS_PER_COMPILED_RUN,
  SIMULATOR_PROTOCOL_VERSION,
  type EcosystemGridConfig,
  type LaunchedSpecies,
} from "../contract";
import {
  ECOSYSTEM_GRID,
  ECOSYSTEM_GRID_TEMPLATE_VERSION,
  applyEcosystemActions,
  estimateEcosystemSceneBytes,
  inheritMetabolicTrait,
  inheritPerceptionTrait,
  validateEcosystemConfig,
  type EcosystemAction,
  type EcosystemState,
} from "../templates/ecosystemGrid";
import { MEADOW_ECOSYSTEM_DEMO_SPEC } from "../ecosystemBiomeDemos";
import {
  SIMULATOR_TEMPLATE_IDS,
  SIMULATOR_TEMPLATES,
  simulatorTemplateErrors,
} from "../templates/registry";

const CONFIG: EcosystemGridConfig = {
  width: 4,
  height: 4,
  boundary: "bounded",
  initialResourceDensity: 0.6,
  resourceRegrowthPerTick: 0.25,
  corpseDecayTicks: 3,
  baseMetabolicCost: 1,
  reproductionEnergyThreshold: 12,
  maxAutomata: 6,
  environmentalNoise: { enabled: true, amplitude: 0.1 },
};

const SPECIES: readonly LaunchedSpecies[] = [
  {
    slotId: "grazer",
    label: "Grazers",
    count: 2,
    countMax: 4,
    senses: [{ senseId: "vision", range: 2, channels: ["automata", "resources"] }],
    prompt: "Find algae, graze, and conserve energy.",
  },
  {
    slotId: "hunter",
    label: "Hunters",
    count: 1,
    countMax: 2,
    senses: [{ senseId: "smell", range: 3, channels: ["automata"] }],
    prompt: "Follow nearby prey by smell.",
  },
];

function state(seed = "00112233445566778899aabbccddeeff") {
  return ECOSYSTEM_GRID.initialState({ config: CONFIG, species: SPECIES, seed });
}

describe("ecosystemGrid physics", () => {
  it("creates identical worlds for the same seed and frozen prompt deck", () => {
    expect(state()).toEqual(state());
    expect(JSON.stringify(state())).toBe(JSON.stringify(state()));
    expect(state("different-seed")).not.toEqual(state());
  });

  it("accepts the code-owned meadow id without changing deterministic physics", () => {
    const reef = ECOSYSTEM_GRID.initialState({ config: CONFIG, species: SPECIES, seed: "biome-proof" });
    const meadow = ECOSYSTEM_GRID.initialState({
      config: { ...CONFIG, biome: "meadow" },
      species: SPECIES,
      seed: "biome-proof",
    });
    const stripBiome = (value: EcosystemState) => {
      const { biome: _biome, ...physicsConfig } = value.config;
      return { ...value, config: physicsConfig };
    };
    expect(stripBiome(meadow)).toEqual(stripBiome(reef));

    const actions = new Map<string, EcosystemAction>(
      reef.automata.map((automaton) => [automaton.id, { kind: "rest" }]),
    );
    const reefTick = applyEcosystemActions({ state: reef, actions, tick: 1, tickSeed: "biome-tick" });
    const meadowTick = applyEcosystemActions({ state: meadow, actions, tick: 1, tickSeed: "biome-tick" });
    expect(stripBiome(meadowTick.state)).toEqual(stripBiome(reefTick.state));
    expect(meadowTick.delta).toEqual(reefTick.delta);

    expect(validateEcosystemConfig({ ...CONFIG, biome: "meadow" }).biome).toBe("meadow");
    expect(() => validateEcosystemConfig({ ...CONFIG, biome: "unknown" })).toThrow(
      "config.biome must be one of reef, meadow",
    );
    expect(MEADOW_ECOSYSTEM_DEMO_SPEC.templateVersion).toBe(ECOSYSTEM_GRID_TEMPLATE_VERSION);
    expect(() => ECOSYSTEM_GRID.validateSpec(MEADOW_ECOSYSTEM_DEMO_SPEC)).not.toThrow();
  });

  it("keeps generated landscape relief outside deterministic physics", () => {
    const landscape = {
      version: 1 as const,
      seed: "physics-boundary",
      regionCount: 4,
      roughness: 0.4,
      lowlandCoverage: 0.25,
      highlandCoverage: 0.25,
    };
    const plain = ECOSYSTEM_GRID.initialState({
      config: CONFIG,
      species: SPECIES,
      seed: "landscape-physics-proof",
    });
    const scenic = ECOSYSTEM_GRID.initialState({
      config: { ...CONFIG, landscape },
      species: SPECIES,
      seed: "landscape-physics-proof",
    });
    const stripLandscape = (value: EcosystemState) => {
      const { landscape: _landscape, ...physicsConfig } = value.config;
      return { ...value, config: physicsConfig };
    };
    expect(stripLandscape(scenic)).toEqual(stripLandscape(plain));

    const actions = new Map<string, EcosystemAction>(
      plain.automata.map((automaton) => [automaton.id, { kind: "rest" }]),
    );
    const plainTick = applyEcosystemActions({
      state: plain,
      actions,
      tick: 1,
      tickSeed: "landscape-tick",
    });
    const scenicTick = applyEcosystemActions({
      state: scenic,
      actions,
      tick: 1,
      tickSeed: "landscape-tick",
    });
    expect(stripLandscape(scenicTick.state)).toEqual(stripLandscape(plainTick.state));
    expect(scenicTick.delta).toEqual(plainTick.delta);
    expect(ECOSYSTEM_GRID.renderScene({ state: scenic, tick: 1 })).toEqual(
      ECOSYSTEM_GRID.renderScene({ state: plain, tick: 1 }),
    );
  });

  it("filters observations exactly through the supplied Senses", () => {
    const world: EcosystemState = {
      ...state(),
      automata: [
        {
          id: "blind:1",
          slotId: "hunter",
          x: 1,
          y: 1,
          energy: 10,
          hidden: false,
          bornTick: 0,
        },
        {
          id: "prey:1",
          slotId: "grazer",
          x: 2,
          y: 1,
          energy: 8,
          hidden: false,
          bornTick: 0,
        },
        {
          id: "far:1",
          slotId: "grazer",
          x: 3,
          y: 3,
          energy: 8,
          hidden: false,
          bornTick: 0,
        },
      ],
      resources: [{ x: 1, y: 1, biomass: 5 }],
    };

    const smellOnly = ECOSYSTEM_GRID.buildObservation({
      state: world,
      automatonId: "blind:1",
      senses: [{ senseId: "smell", range: 1, channels: ["automata"] }],
      tick: 0,
    });
    expect(smellOnly).not.toHaveProperty("vision");
    expect(smellOnly.smell).toEqual({
      automata: [
        {
          id: "prey:1",
          slotId: "grazer",
          dx: 1,
          dy: 0,
          distance: 1,
          energy: 8,
          hidden: false,
        },
      ],
    });
    expect(smellOnly.smell).not.toHaveProperty("resources");

    const exactVision = ECOSYSTEM_GRID.buildObservation({
      state: world,
      automatonId: "blind:1",
      senses: [{ senseId: "vision", range: 0, channels: ["resources"] }],
      tick: 0,
    });
    expect(exactVision.vision).toEqual({
      resources: [{ x: 1, y: 1, dx: 0, dy: 0, distance: 0, biomass: 5 }],
    });
    expect(exactVision.vision).not.toHaveProperty("automata");
  });

  it("records each bounded-wall distance from the automaton's exact grid position", () => {
    const world: EcosystemState = {
      ...state(),
      config: { ...CONFIG, width: 5, height: 5 },
      automata: [{
        id: "center:1",
        slotId: "grazer",
        x: 2,
        y: 2,
        energy: 10,
        hidden: false,
        bornTick: 0,
      }],
      resources: [],
    };
    const observation = ECOSYSTEM_GRID.buildObservation({
      state: world,
      automatonId: "center:1",
      senses: [{ senseId: "vision", range: 2, channels: ["boundary"] }],
      tick: 0,
    });
    expect(observation.vision?.boundary).toEqual([
      { side: "north", distance: 2 },
      { side: "east", distance: 2 },
      { side: "south", distance: 2 },
      { side: "west", distance: 2 },
    ]);
  });

  it("is immutable, insertion-order independent, and deterministic per tick seed", () => {
    const before = state();
    const firstId = before.automata[0].id;
    const secondId = before.automata[1].id;
    const actionsA = new Map<string, EcosystemAction>([
      [firstId, { kind: "rest" }],
      [secondId, { kind: "hide" }],
    ]);
    const actionsB = new Map<string, EcosystemAction>([
      [secondId, { kind: "hide" }],
      [firstId, { kind: "rest" }],
    ]);
    const frozenBefore = JSON.stringify(before);

    const resultA = ECOSYSTEM_GRID.applyActions({
      state: before,
      actions: actionsA,
      tick: 0,
      tickSeed: "run-seed:0",
    });
    const resultB = ECOSYSTEM_GRID.applyActions({
      state: before,
      actions: actionsB,
      tick: 0,
      tickSeed: "run-seed:0",
    });

    expect(JSON.stringify(before)).toBe(frozenBefore);
    expect(resultA).toEqual(resultB);
    expect(ECOSYSTEM_GRID.metrics({ previousState: before, state: resultA.state, tick: 0 })).toEqual(
      ECOSYSTEM_GRID.metrics({ previousState: before, state: resultB.state, tick: 0 }),
    );
  });

  it("turns an illegal action into a no-op and counts only the invalid action", () => {
    const before = state();
    const automaton = before.automata[0];
    const result = ECOSYSTEM_GRID.applyActions({
      state: before,
      actions: new Map([
        [automaton.id, { kind: "move", to: { x: 99, y: 99 } } as EcosystemAction],
      ]),
      tick: 0,
      tickSeed: "invalid",
    });

    const after = result.state.automata.find((candidate) => candidate.id === automaton.id);
    expect(after).toMatchObject({ x: automaton.x, y: automaton.y });
    expect(result.delta.invalidAutomatonIds).toEqual([automaton.id]);
    expect(result.state.totalInvalidActions).toBe(before.totalInvalidActions + 1);
  });

  it("reports extinction and longevity without turning either into mastery", () => {
    const before: EcosystemState = {
      ...state(),
      config: {
        ...CONFIG,
        baseMetabolicCost: 5,
        heredity: { enabled: true, mutationStd: 0 },
      },
      automata: [
        {
          id: "last:1",
          slotId: "grazer",
          x: 0,
          y: 0,
          energy: 1,
          hidden: false,
          bornTick: 0,
          trait: 1.4,
          perceptionTrait: 1.7,
        },
      ],
      resources: [],
    };
    const result = ECOSYSTEM_GRID.applyActions({
      state: before,
      actions: new Map([["last:1", { kind: "noop" }]]),
      tick: 6,
      tickSeed: "extinction",
    });
    const metrics = ECOSYSTEM_GRID.metrics({
      previousState: before,
      state: result.state,
      tick: 6,
    });

    expect(result.terminal).toBe(true);
    expect(metrics).toMatchObject({
      longevity: 7,
      livingAutomata: 0,
      livingSpecies: 0,
      deaths: before.totalDeaths + 1,
      traitMean: 1.4,
      traitSpread: 0,
      perceptionMean: 1.7,
      perceptionSpread: 0,
    });
    expect(ECOSYSTEM_GRID.summaryMetricKeys).toContain("longevity");
    expect(ECOSYSTEM_GRID.metricKeys).not.toContain("mastery");
  });
});

describe("ecosystemGrid terrain", () => {
  const terrainConfig: EcosystemGridConfig = {
    ...CONFIG,
    initialResourceDensity: 1,
    resourceRegrowthPerTick: 0.5,
    environmentalNoise: { enabled: false, amplitude: 0 },
    terrain: {
      shelter: [{ x: 1, y: 1 }],
      current: [
        { x: 0, y: 2, direction: "east" },
        { x: 2, y: 2, direction: "west" },
      ],
      shallows: [{ x: 3, y: 3 }],
      predatorSlotIds: ["hunter"],
    },
  };

  it("validates closed in-grid non-overlapping terrain", () => {
    expect(ECOSYSTEM_GRID.validateConfig(terrainConfig).terrain).toEqual(
      terrainConfig.terrain,
    );
    expect(() =>
      ECOSYSTEM_GRID.validateConfig({
        ...terrainConfig,
        terrain: {
          ...terrainConfig.terrain!,
          shallows: [{ x: 1, y: 1 }],
        },
      }),
    ).toThrow(/overlaps shelter and shallows/);
    expect(() =>
      ECOSYSTEM_GRID.validateConfig({
        ...terrainConfig,
        terrain: {
          ...terrainConfig.terrain!,
          current: [{ x: 4, y: 0, direction: "east" }],
        },
      }),
    ).toThrow(/outside the grid/);
    expect(() =>
      ECOSYSTEM_GRID.validateConfig({
        ...terrainConfig,
        terrain: { ...terrainConfig.terrain!, reef: [] },
      }),
    ).toThrow(/unknown field "reef"/);
  });

  it("validates exact predator capacity outside shelter before launch", () => {
    const justEnoughShelter = [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 2, y: 0 },
      { x: 0, y: 1 },
    ];
    const capacityConfig = (shelter: { x: number; y: number }[]): EcosystemGridConfig => ({
      ...CONFIG,
      width: 3,
      height: 2,
      maxAutomata: 2,
      terrain: {
        shelter,
        current: [],
        shallows: [],
        predatorSlotIds: ["hunter"],
      },
    });
    const capacitySpec = (shelter: { x: number; y: number }[]) => ({
      version: SIMULATOR_PROTOCOL_VERSION,
      templateId: "ecosystemGrid" as const,
      templateVersion: ECOSYSTEM_GRID.version,
      config: capacityConfig(shelter),
      criterion: {
        kind: "measured" as const,
        metricKey: "longevity",
        direction: "maximize" as const,
      },
      speciesSlots: [
        {
          slotId: "hunter",
          label: "Hunters",
          countMin: 0,
          countMax: 2,
          defaultCount: 2,
          senses: [],
        },
      ],
      tickBudget: { iterationTicks: 1, seasonTicks: 2, absoluteMaxTicks: 2 },
      interpreter: { kind: "scripted" as const, interpreterId: "compiled-policy-v1" },
      microWorld: false,
    });
    const launchedHunters: readonly LaunchedSpecies[] = [
      {
        slotId: "hunter",
        label: "Hunters",
        count: 2,
        countMax: 2,
        senses: [],
        prompt: "Rest.",
      },
    ];

    expect(() => ECOSYSTEM_GRID.validateSpec(capacitySpec(justEnoughShelter))).not.toThrow();
    expect(() =>
      ECOSYSTEM_GRID.initialState({
        config: capacityConfig(justEnoughShelter),
        species: launchedHunters,
        seed: "predator-capacity:exact",
      }),
    ).not.toThrow();

    const oneShortShelter = [...justEnoughShelter, { x: 1, y: 1 }];
    expect(() => ECOSYSTEM_GRID.validateSpec(capacitySpec(oneShortShelter))).toThrow(
      /Shelter leaves too few cells for the default predator population/,
    );
    expect(() =>
      ECOSYSTEM_GRID.initialState({
        config: capacityConfig(oneShortShelter),
        species: launchedHunters,
        seed: "predator-capacity:short",
      }),
    ).toThrow(/Shelter leaves too few cells for the launched predator population/);
  });

  it("makes shelter food-free, safe from predation, and closed to predator movement", () => {
    const initial = ECOSYSTEM_GRID.initialState({
      config: terrainConfig,
      species: SPECIES,
      seed: "shelter",
    });
    expect(initial.resources).not.toContainEqual(
      expect.objectContaining({ x: 1, y: 1 }),
    );
    const world: EcosystemState = {
      ...initial,
      automata: [
        {
          id: "hunter:1",
          slotId: "hunter",
          x: 1,
          y: 0,
          energy: 10,
          hidden: false,
          bornTick: 0,
          heading: 0,
        },
        {
          id: "grazer:1",
          slotId: "grazer",
          x: 1,
          y: 1,
          energy: 10,
          hidden: true,
          bornTick: 0,
          heading: 0,
        },
      ],
      resources: [],
    };
    const observation = ECOSYSTEM_GRID.buildObservation({
      state: world,
      automatonId: "hunter:1",
      senses: [{ senseId: "smell", range: 2, channels: ["automata"] }],
      tick: 0,
    });
    const legal = ECOSYSTEM_GRID.legalActions({
      state: world,
      automatonId: "hunter:1",
      observation,
      tick: 0,
    });
    expect(legal).not.toContainEqual({ kind: "move", to: { x: 1, y: 1 } });
    expect(legal).not.toContainEqual({ kind: "eat", targetId: "grazer:1" });

    const result = ECOSYSTEM_GRID.applyActions({
      state: world,
      actions: new Map([
        ["hunter:1", { kind: "eat", targetId: "grazer:1" }],
        ["grazer:1", { kind: "noop" }],
      ]),
      tick: 0,
      tickSeed: "shelter:predation",
    });
    expect(result.delta.eaten).toEqual([]);
    expect(result.delta.invalidAutomatonIds).toEqual(["hunter:1"]);
    expect(result.state.automata.map(({ id }) => id)).toContain("grazer:1");
  });

  it("displaces current occupants deterministically with collision resolution", () => {
    const initial = ECOSYSTEM_GRID.initialState({
      config: terrainConfig,
      species: SPECIES,
      seed: "current",
    });
    const world: EcosystemState = {
      ...initial,
      automata: [
        {
          id: "grazer:1",
          slotId: "grazer",
          x: 0,
          y: 2,
          energy: 10,
          hidden: false,
          bornTick: 0,
          heading: Math.PI,
        },
        {
          id: "grazer:2",
          slotId: "grazer",
          x: 2,
          y: 2,
          energy: 10,
          hidden: false,
          bornTick: 0,
          heading: 0,
        },
      ],
      resources: [],
    };
    const run = () =>
      ECOSYSTEM_GRID.applyActions({
        state: world,
        actions: new Map([
          ["grazer:1", { kind: "noop" }],
          ["grazer:2", { kind: "noop" }],
        ]),
        tick: 0,
        tickSeed: "current:collision",
      });
    expect(run()).toEqual(run());
    expect(run().delta.moved).toHaveLength(1);
    expect(run().delta.moved[0].to).toEqual({ x: 1, y: 2 });
  });

  it("merges deliberate movement with current displacement without turning the fish", () => {
    const config: EcosystemGridConfig = {
      ...CONFIG,
      initialResourceDensity: 0,
      environmentalNoise: { enabled: false, amplitude: 0 },
      terrain: {
        shelter: [],
        current: [{ x: 1, y: 0, direction: "south" }],
        shallows: [],
        predatorSlotIds: [],
      },
    };
    const initial = ECOSYSTEM_GRID.initialState({
      config,
      species: [{ ...SPECIES[0], count: 1 }],
      seed: "move-then-current",
    });
    const world: EcosystemState = {
      ...initial,
      automata: [
        {
          ...initial.automata[0],
          x: 0,
          y: 0,
          heading: Math.PI,
        },
      ],
      resources: [],
    };
    const result = ECOSYSTEM_GRID.applyActions({
      state: world,
      actions: new Map([["grazer:1", { kind: "move", to: { x: 1, y: 0 } }]]),
      tick: 0,
      tickSeed: "move-then-current:tick",
    });

    expect(result.delta.moved).toEqual([
      {
        automatonId: "grazer:1",
        from: { x: 0, y: 0 },
        to: { x: 1, y: 1 },
      },
    ]);
    expect(result.state.automata[0]).toMatchObject({
      x: 1,
      y: 1,
      // The accepted eastward move sets heading 0; the southward current does not turn it.
      heading: 0,
    });
  });

  it("trades shallow-water sensing for doubled algae regrowth", () => {
    const initial = ECOSYSTEM_GRID.initialState({
      config: {
        ...terrainConfig,
        initialResourceDensity: 0,
        heredity: { enabled: true, mutationStd: 0 },
      },
      species: SPECIES,
      seed: "shallows",
    });
    const baseAutomaton = {
      id: "grazer:1",
      slotId: "grazer",
      x: 3,
      y: 3,
      energy: 10,
      hidden: false,
      bornTick: 0,
      heading: 0,
      trait: 1,
    };
    const world: EcosystemState = {
      ...initial,
      automata: [{ ...baseAutomaton, perceptionTrait: 2 }],
      resources: [{ x: 1, y: 3, biomass: 1 }],
    };
    const sharp = ECOSYSTEM_GRID.buildObservation({
      state: world,
      automatonId: "grazer:1",
      senses: [{ senseId: "vision", range: 2, channels: ["resources", "terrain"] }],
      tick: 0,
    });
    const dim = ECOSYSTEM_GRID.buildObservation({
      state: {
        ...world,
        automata: [{ ...baseAutomaton, perceptionTrait: 0.5 }],
      },
      automatonId: "grazer:1",
      senses: [{ senseId: "vision", range: 2, channels: ["resources", "terrain"] }],
      tick: 0,
    });
    expect(sharp.vision?.resources).toContainEqual(
      expect.objectContaining({ x: 1, y: 3, distance: 2 }),
    );
    expect(dim.vision?.resources).toEqual([]);
    expect(sharp.self.terrain).toEqual({ kind: "shallows" });
    const sharpSmell = ECOSYSTEM_GRID.buildObservation({
      state: world,
      automatonId: "grazer:1",
      senses: [{ senseId: "smell", range: 2, channels: ["resources"] }],
      tick: 0,
    });
    const dimSmell = ECOSYSTEM_GRID.buildObservation({
      state: {
        ...world,
        automata: [{ ...baseAutomaton, perceptionTrait: 0.5 }],
      },
      automatonId: "grazer:1",
      senses: [{ senseId: "smell", range: 2, channels: ["resources"] }],
      tick: 0,
    });
    expect(sharpSmell.smell?.resources).toHaveLength(1);
    expect(dimSmell.smell?.resources).toEqual([]);

    const after = ECOSYSTEM_GRID.applyActions({
      state: { ...world, resources: [] },
      actions: new Map([["grazer:1", { kind: "noop" }]]),
      tick: 0,
      tickSeed: "shallows:regrowth",
    }).state;
    expect(after.resources.find(({ x, y }) => x === 3 && y === 3)?.biomass).toBe(1);
    expect(after.resources.find(({ x, y }) => x === 2 && y === 3)?.biomass).toBe(0.5);
  });

  it("emits terrain kinds and persists accepted-move heading while resting", () => {
    const initial = ECOSYSTEM_GRID.initialState({
      config: terrainConfig,
      species: SPECIES,
      seed: "scene-terrain",
    });
    const moving: EcosystemState = {
      ...initial,
      automata: [
        {
          ...initial.automata.find(({ slotId }) => slotId === "grazer")!,
          x: 0,
          y: 0,
          heading: Math.PI,
        },
      ],
      resources: [],
    };
    const moved = ECOSYSTEM_GRID.applyActions({
      state: moving,
      actions: new Map([["grazer:1", { kind: "move", to: { x: 1, y: 0 } }]]),
      tick: 0,
      tickSeed: "heading:move",
    }).state;
    const rested = ECOSYSTEM_GRID.applyActions({
      state: moved,
      actions: new Map([["grazer:1", { kind: "rest" }]]),
      tick: 1,
      tickSeed: "heading:rest",
    }).state;
    const scene = ECOSYSTEM_GRID.renderScene({ state: rested, tick: 2 });
    expect(scene.entities[0].heading).toBe(0);
    expect(scene.cells.map(({ kind }) => kind)).toEqual(
      expect.arrayContaining(["shelter", "current_east", "current_west", "shallows"]),
    );
  });

  it("keeps the compiled population cap inside the scene envelope with dense terrain", () => {
    const width = 40;
    const height = MAX_GRID_CELLS_PER_COMPILED_RUN / width;
    const shelter = Array.from({ length: height }, (_, y) =>
      Array.from({ length: width }, (_, x) => ({ x, y })),
    ).flat();
    const config: EcosystemGridConfig = {
      width,
      height,
      boundary: "bounded",
      initialResourceDensity: 1,
      resourceRegrowthPerTick: 1,
      corpseDecayTicks: 3,
      baseMetabolicCost: 0.1,
      reproductionEnergyThreshold: 12,
      maxAutomata: MAX_AUTOMATA_COMPILED_RUN,
      environmentalNoise: { enabled: false, amplitude: 0 },
      terrain: {
        shelter,
        current: [],
        shallows: [],
        predatorSlotIds: [],
      },
    };
    const species = [{
      slotId: "grazer",
      label: "Grazers",
      count: MAX_AUTOMATA_COMPILED_RUN,
      countMax: MAX_AUTOMATA_COMPILED_RUN,
      senses: [{ senseId: "touch", range: 0, channels: ["terrain"] }],
      prompt: "Rest.",
    }] satisfies readonly LaunchedSpecies[];
    const spec = {
      version: SIMULATOR_PROTOCOL_VERSION,
      templateId: "ecosystemGrid" as const,
      templateVersion: ECOSYSTEM_GRID.version,
      config,
      criterion: { kind: "measured" as const, metricKey: "longevity", direction: "maximize" as const },
      speciesSlots: [{
        slotId: "grazer",
        label: "Grazers",
        countMin: 1,
        countMax: MAX_AUTOMATA_COMPILED_RUN,
        defaultCount: MAX_AUTOMATA_COMPILED_RUN,
        senses: species[0].senses,
      }],
      tickBudget: { iterationTicks: 1, seasonTicks: 2, absoluteMaxTicks: 2 },
      interpreter: { kind: "scripted" as const, interpreterId: "compiled-policy-v1" },
      microWorld: false,
    };
    expect(() => ECOSYSTEM_GRID.validateSpec(spec)).not.toThrow();
    const initial = ECOSYSTEM_GRID.initialState({
      config,
      species,
      seed: "dense-terrain-envelope",
    });
    const scene = ECOSYSTEM_GRID.renderScene({ state: initial, tick: 0 });
    expect(scene.cells).toHaveLength(MAX_GRID_CELLS_PER_COMPILED_RUN);
    expect(initial.resources).toEqual([]);
    expect(estimateEcosystemSceneBytes(config)).toBeLessThanOrEqual(MAX_SCENE_JSON_BYTES);
    expect(Buffer.byteLength(JSON.stringify(scene), "utf8")).toBeLessThanOrEqual(
      MAX_SCENE_JSON_BYTES,
    );
  });
});

describe("ecosystemGrid heredity", () => {
  const heredityConfig = (mutationStd: number): EcosystemGridConfig => ({
    width: 3,
    height: 3,
    boundary: "bounded",
    initialResourceDensity: 0,
    resourceRegrowthPerTick: 0,
    corpseDecayTicks: 3,
    baseMetabolicCost: 0,
    reproductionEnergyThreshold: 4,
    maxAutomata: 4,
    environmentalNoise: { enabled: false, amplitude: 0 },
    heredity: { enabled: true, mutationStd },
  });
  const oneSpecies: readonly LaunchedSpecies[] = [
    {
      slotId: "grazer",
      label: "Grazers",
      count: 1,
      countMax: 4,
      senses: [],
      prompt: "Reproduce.",
    },
  ];

  function reproductionState(mutationStd: number): EcosystemState {
    const initial = ECOSYSTEM_GRID.initialState({
      config: heredityConfig(mutationStd),
      species: oneSpecies,
      seed: "inheritance",
    });
    return {
      ...initial,
      automata: [
        {
          ...initial.automata[0],
          x: 1,
          y: 1,
          energy: 10,
          trait: 0.72,
        },
      ],
    };
  }

  it("inherits exactly without mutation and deterministically with mutation", () => {
    const exact = ECOSYSTEM_GRID.applyActions({
      state: reproductionState(0),
      actions: new Map([["grazer:1", { kind: "reproduce" }]]),
      tick: 0,
      tickSeed: "inheritance:exact",
    });
    expect(exact.delta.born).toHaveLength(1);
    expect(exact.delta.born[0].trait).toBe(0.72);
    expect(exact.state.automata).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "grazer:1", energy: 5, trait: 0.72 }),
        expect.objectContaining({ energy: 5, trait: 0.72, bornTick: 1 }),
      ]),
    );
    expect(ECOSYSTEM_GRID.validateDelta(exact.delta)).toEqual(exact.delta);

    const before = reproductionState(0.1);
    const reproduce = () =>
      ECOSYSTEM_GRID.applyActions({
        state: before,
        actions: new Map([["grazer:1", { kind: "reproduce" }]]),
        tick: 0,
        tickSeed: "inheritance:deterministic",
      });
    expect(reproduce()).toEqual(reproduce());
    expect(reproduce().delta.born[0].trait).not.toBe(0.72);
  });

  it("applies the inherited trait directly to metabolic cost", () => {
    const initial = reproductionState(0);
    const before: EcosystemState = {
      ...initial,
      config: { ...initial.config, baseMetabolicCost: 1 },
      automata: [
        { ...initial.automata[0], id: "efficient", x: 0, trait: 0.5 },
        { ...initial.automata[0], id: "costly", x: 2, trait: 2 },
      ],
    };
    const after = ECOSYSTEM_GRID.applyActions({
      state: before,
      actions: new Map([
        ["efficient", { kind: "noop" }],
        ["costly", { kind: "noop" }],
      ]),
      tick: 0,
      tickSeed: "metabolic-cost",
    }).state;

    expect(after.automata.find(({ id }) => id === "efficient")?.energy).toBe(9.35);
    expect(after.automata.find(({ id }) => id === "costly")?.energy).toBe(7.85);
  });

  it("charges the measured perception surcharge independently of body cost", () => {
    const initial = reproductionState(0);
    const before: EcosystemState = {
      ...initial,
      config: { ...initial.config, baseMetabolicCost: 1 },
      automata: [
        {
          ...initial.automata[0],
          id: "dim",
          x: 0,
          trait: 1,
          perceptionTrait: 0.5,
        },
        {
          ...initial.automata[0],
          id: "sharp",
          x: 2,
          trait: 1,
          perceptionTrait: 2,
        },
      ],
    };
    const after = ECOSYSTEM_GRID.applyActions({
      state: before,
      actions: new Map([
        ["dim", { kind: "noop" }],
        ["sharp", { kind: "noop" }],
      ]),
      tick: 0,
      tickSeed: "perception-surcharge",
    }).state;

    // Dim: 1 + 0.3*(0.5-0.5) = 1. Sharp: 1 + 0.3*(2-0.5) = 1.45.
    expect(after.automata.find(({ id }) => id === "dim")?.energy).toBe(9);
    expect(after.automata.find(({ id }) => id === "sharp")?.energy).toBe(8.55);
  });

  it("inherits perception independently, deterministically, and within its physical range", () => {
    const exact = ECOSYSTEM_GRID.applyActions({
      state: {
        ...reproductionState(0),
        automata: [
          {
            ...reproductionState(0).automata[0],
            perceptionTrait: 1.64,
          },
        ],
      },
      actions: new Map([["grazer:1", { kind: "reproduce" }]]),
      tick: 0,
      tickSeed: "perception:exact",
    });
    expect(exact.delta.born[0].perceptionTrait).toBe(1.64);

    const samples = Array.from({ length: 200 }, (_, index) =>
      inheritPerceptionTrait({
        parentTrait: index % 2 === 0 ? 0.5 : 2,
        mutationStd: 0.5,
        seed: `perception:${index}`,
      }),
    );
    expect(samples.every((trait) => trait >= 0.5 && trait <= 2)).toBe(true);
    expect(inheritPerceptionTrait({
      parentTrait: 1,
      mutationStd: 0.2,
      seed: "repeat",
    })).toBe(inheritPerceptionTrait({
      parentTrait: 1,
      mutationStd: 0.2,
      seed: "repeat",
    }));
  });

  it("clamps mutated traits to the physical range", () => {
    const low = Array.from({ length: 200 }, (_, index) =>
      inheritMetabolicTrait({
        parentTrait: 0.5,
        mutationStd: 0.5,
        seed: `low:${index}`,
      }),
    );
    const high = Array.from({ length: 200 }, (_, index) =>
      inheritMetabolicTrait({
        parentTrait: 2,
        mutationStd: 0.5,
        seed: `high:${index}`,
      }),
    );

    expect(Math.min(...low)).toBe(0.5);
    expect(Math.max(...high)).toBe(2);
    expect([...low, ...high].every((trait) => trait >= 0.5 && trait <= 2)).toBe(true);
  });

  it("selects for lower metabolic cost across scarce-food runs", () => {
    const config: EcosystemGridConfig = {
      width: 4,
      height: 3,
      boundary: "bounded",
      initialResourceDensity: 1,
      resourceRegrowthPerTick: 0.2,
      corpseDecayTicks: 2,
      baseMetabolicCost: 0.2,
      reproductionEnergyThreshold: 4,
      maxAutomata: 12,
      environmentalNoise: { enabled: false, amplitude: 0 },
      heredity: { enabled: true, mutationStd: 0.1 },
    };
    const species: readonly LaunchedSpecies[] = [
      {
        slotId: "grazer",
        label: "Grazers",
        count: 6,
        countMax: 12,
        senses: [{ senseId: "touch", range: 0, channels: ["resources"] }],
        prompt: "Graze, reproduce, and rest.",
      },
    ];
    const finalMetrics = Array.from({ length: 6 }, (_, seedIndex) => {
      let current = ECOSYSTEM_GRID.initialState({
        config,
        species,
        seed: `selection:${seedIndex}`,
      });
      for (let tick = 0; tick < 240 && current.automata.length > 0; tick += 1) {
        const actions = new Map<string, EcosystemAction>();
        const resources = new Map(
          current.resources.map((resource) => [`${resource.x},${resource.y}`, resource.biomass]),
        );
        for (const automaton of current.automata) {
          if (
            automaton.energy >= config.reproductionEnergyThreshold &&
            current.automata.length < config.maxAutomata
          ) {
            actions.set(automaton.id, { kind: "reproduce" });
          } else if ((resources.get(`${automaton.x},${automaton.y}`) ?? 0) > 0) {
            actions.set(automaton.id, {
              kind: "graze",
              at: { x: automaton.x, y: automaton.y },
            });
          } else {
            actions.set(automaton.id, { kind: "rest" });
          }
        }
        current = ECOSYSTEM_GRID.applyActions({
          state: current,
          actions,
          tick,
          tickSeed: `selection:${seedIndex}:${tick}`,
        }).state;
      }
      return ECOSYSTEM_GRID.metrics({
        previousState: current,
        state: current,
        tick: 239,
      });
    });
    const finalTraitMean =
      finalMetrics.reduce((total, metrics) => total + metrics.traitMean, 0) /
      finalMetrics.length;

    expect(finalMetrics.every((metrics) => metrics.livingAutomata > 0)).toBe(true);
    expect(finalTraitMean).toBeLessThan(0.95);
    expect(finalMetrics.every((metrics) => metrics.traitSpread > 0)).toBe(true);
  });

  it("FLIPS perception selection: sharp eyes win with predation and abundance, lose in scarcity", () => {
    const width = 8;
    const height = 6;
    const grazerSenses: LaunchedSpecies["senses"] = [
      { senseId: "vision", range: 2, channels: ["automata"] },
      { senseId: "touch", range: 0, channels: ["resources"] },
    ];
    const species: readonly LaunchedSpecies[] = [
      {
        slotId: "grazer",
        label: "Grazers",
        count: 8,
        countMax: 10,
        senses: grazerSenses,
        prompt: "Breed, flee sensed sharks, and graze.",
      },
      {
        slotId: "predator",
        label: "Shark",
        count: 2,
        countMax: 2,
        senses: [{ senseId: "smell", range: 6, channels: ["automata"] }],
        prompt: "Eat or approach the nearest grazer.",
      },
    ];
    const runSelection = (
      environment: "scarcity" | "predation",
      seedIndex: number,
    ) => {
      const terrain =
        environment === "predation"
          ? {
              shelter: [],
              current: [],
              shallows: Array.from({ length: height }, (_, y) =>
                Array.from({ length: width }, (_, x) => ({ x, y })),
              ).flat(),
              predatorSlotIds: ["predator"],
            }
          : undefined;
      const config: EcosystemGridConfig = {
        width,
        height,
        boundary: "bounded",
        initialResourceDensity: 1,
        resourceRegrowthPerTick: environment === "predation" ? 1 : 0.05,
        corpseDecayTicks: 2,
        baseMetabolicCost: 0.1,
        reproductionEnergyThreshold: 20,
        maxAutomata: 12,
        environmentalNoise: { enabled: false, amplitude: 0 },
        heredity: { enabled: true, mutationStd: 0 },
        ...(terrain ? { terrain } : {}),
      };
      const launched =
        environment === "predation" ? species : [species[0]];
      let current = ECOSYSTEM_GRID.initialState({
        config,
        species: launched,
        seed: `flip:${seedIndex}`,
      });
      current = {
        ...current,
        automata: current.automata.map((automaton) => ({
          ...automaton,
          trait: 1,
          perceptionTrait:
            automaton.slotId === "predator"
              ? 1
              : Number(automaton.id.split(":")[1]) % 2 === 0
                ? 2
                : 0.5,
        })),
      };

      const ticks = environment === "predation" ? 40 : 180;
      for (let tick = 0; tick < ticks && current.automata.length > 0; tick += 1) {
        const actions = new Map<string, EcosystemAction>();
        for (const automaton of current.automata) {
          const slot = launched.find(({ slotId }) => slotId === automaton.slotId)!;
          const observation = ECOSYSTEM_GRID.buildObservation({
            state: current,
            automatonId: automaton.id,
            senses: slot.senses,
            tick,
          });
          const legal = ECOSYSTEM_GRID.legalActions({
            state: current,
            automatonId: automaton.id,
            observation,
            tick,
          });
          const reproduce = legal.find((action) => action.kind === "reproduce");
          if (automaton.slotId === "grazer" && reproduce) {
            actions.set(automaton.id, reproduce);
            continue;
          }
          if (automaton.slotId === "predator") {
            const eat = legal.find((action) => action.kind === "eat");
            if (eat) {
              actions.set(automaton.id, eat);
              continue;
            }
            const prey = observation.smell?.automata
              ?.filter(({ slotId }) => slotId === "grazer")
              .sort((left, right) => left.distance - right.distance)[0];
            const moves = legal.filter(
              (action): action is Extract<EcosystemAction, { kind: "move" }> =>
                action.kind === "move",
            );
            if (prey && moves.length > 0) {
              moves.sort(
                (left, right) =>
                  Math.abs(prey.dx - (left.to.x - automaton.x)) +
                    Math.abs(prey.dy - (left.to.y - automaton.y)) -
                  (Math.abs(prey.dx - (right.to.x - automaton.x)) +
                    Math.abs(prey.dy - (right.to.y - automaton.y))),
              );
              actions.set(automaton.id, moves[0]);
              continue;
            }
          } else {
            const predator = observation.vision?.automata
              ?.filter(({ slotId }) => slotId === "predator")
              .sort((left, right) => left.distance - right.distance)[0];
            const moves = legal.filter(
              (action): action is Extract<EcosystemAction, { kind: "move" }> =>
                action.kind === "move",
            );
            if (predator && moves.length > 0) {
              moves.sort(
                (left, right) =>
                  Math.abs(predator.dx - (right.to.x - automaton.x)) +
                    Math.abs(predator.dy - (right.to.y - automaton.y)) -
                  (Math.abs(predator.dx - (left.to.x - automaton.x)) +
                    Math.abs(predator.dy - (left.to.y - automaton.y))),
              );
              actions.set(automaton.id, moves[0]);
              continue;
            }
            const graze = legal.find((action) => action.kind === "graze");
            if (graze) {
              actions.set(automaton.id, graze);
              continue;
            }
          }
          actions.set(
            automaton.id,
            legal.find((action) => action.kind === "rest") ?? { kind: "noop" },
          );
        }
        current = ECOSYSTEM_GRID.applyActions({
          state: current,
          actions,
          tick,
          tickSeed: `flip:${environment}:${seedIndex}:${tick}`,
        }).state;
      }
      const grazers = current.automata.filter(({ slotId }) => slotId === "grazer");
      expect(grazers.length).toBeGreaterThan(0);
      return grazers.reduce(
        (total, automaton) => total + (automaton.perceptionTrait ?? 1),
        0,
      ) / grazers.length;
    };

    const scarcityMeans = Array.from({ length: 8 }, (_, seed) =>
      runSelection("scarcity", seed),
    );
    const predationMeans = Array.from({ length: 8 }, (_, seed) =>
      runSelection("predation", seed),
    );
    const scarcityMean =
      scarcityMeans.reduce((total, mean) => total + mean, 0) / scarcityMeans.length;
    const predationMean =
      predationMeans.reduce((total, mean) => total + mean, 0) / predationMeans.length;

    /*
     * Eight paired seeded worlds all start at 1.25 (four 0.5 and four 2.0
     * founders). Scarcity ends at 1.1068 (-11.5%); predation + abundance ends
     * at 1.5125 (+21.0%). The 0.4057 separation is the causal FLIP, not a
     * single lucky lineage.
     */
    expect(scarcityMean).toBeLessThan(1.25);
    expect(predationMean).toBeGreaterThan(1.25);
    expect(predationMean - scarcityMean).toBeGreaterThan(0.3);
  });

  it("maps enabled traits to bounded scene sizes without changing disabled scenes", () => {
    const disabled = state();
    const disabledWithTraits: EcosystemState = {
      ...disabled,
      automata: disabled.automata.map((automaton, index) => ({
        ...automaton,
        trait: index === 0 ? 0.5 : 2,
      })),
    };
    expect(
      ECOSYSTEM_GRID.renderScene({ state: disabledWithTraits, tick: 0 }),
    ).toEqual(ECOSYSTEM_GRID.renderScene({ state: disabled, tick: 0 }));

    const maxConfig: EcosystemGridConfig = {
      ...heredityConfig(0.1),
      width: 4,
      height: 3,
      maxAutomata: 12,
    };
    const maxState = ECOSYSTEM_GRID.initialState({
      config: maxConfig,
      species: [{ ...oneSpecies[0], count: 12, countMax: 12 }],
      seed: "max-scene",
    });
    const variedState: EcosystemState = {
      ...maxState,
      automata: maxState.automata.map((automaton, index) => ({
        ...automaton,
        trait: 0.5 + (1.5 * index) / (maxState.automata.length - 1),
      })),
    };
    const validated = ECOSYSTEM_GRID.validateState(variedState);
    const scene = ECOSYSTEM_GRID.renderScene({ state: validated, tick: 0 });
    const automata = scene.entities.filter((entity) => entity.kind === "automaton");
    const sizes = automata.map((entity) => entity.size);

    expect(automata).toHaveLength(12);
    expect(new Set(sizes).size).toBeGreaterThan(1);
    expect(sizes.every((size) => size !== undefined && size >= 0.8 && size <= 1.2)).toBe(
      true,
    );
    expect(scene).toMatchObject({
      protocolVersion: 1,
      templateId: "ecosystemGrid",
      viewport: { width: 4, height: 3, boundary: "bounded" },
    });
    expect(Buffer.byteLength(JSON.stringify(scene), "utf8")).toBeLessThanOrEqual(
      MAX_SCENE_JSON_BYTES,
    );
  });

  it("accepts old states without trait fields and treats them as founders", () => {
    const current = ECOSYSTEM_GRID.initialState({
      config: heredityConfig(0.1),
      species: oneSpecies,
      seed: "old-state",
    });
    const oldState = {
      ...current,
      automata: current.automata.map(({ trait: _trait, ...automaton }) => automaton),
    };
    const validated = ECOSYSTEM_GRID.validateState(oldState);
    expect(validated.automata[0].trait).toBeUndefined();
    expect(
      ECOSYSTEM_GRID.metrics({ previousState: validated, state: validated, tick: 0 }),
    ).toMatchObject({ traitMean: 1, traitSpread: 0 });
  });

  it("validates heredity configuration bounds", () => {
    expect(() =>
      ECOSYSTEM_GRID.validateConfig({
        ...CONFIG,
        heredity: { enabled: true, mutationStd: -0.01 },
      }),
    ).toThrow(/mutationStd must be between 0 and 0.5/);
    expect(() =>
      ECOSYSTEM_GRID.validateConfig({
        ...CONFIG,
        heredity: { enabled: true, mutationStd: 0.51 },
      }),
    ).toThrow(/mutationStd must be between 0 and 0.5/);
  });

  it("rejects trait criteria unless heredity is enabled", () => {
    for (const metricKey of [
      "traitMean",
      "traitSpread",
      "perceptionMean",
      "perceptionSpread",
    ]) {
      const disabledSpec = assembleSimulatorSpec({
        ...EXAMPLE_ECOSYSTEM_AUTHOR_INPUT,
        criterion: { kind: "measured", metricKey, direction: "minimize" },
      });
      expect(() => validatedSimulatorSpec(disabledSpec)).toThrow(
        `criterion metric "${metricKey}" requires config.heredity.enabled to be true`,
      );

      const enabledSpec = assembleSimulatorSpec({
        ...EXAMPLE_ECOSYSTEM_AUTHOR_INPUT,
        config: {
          ...EXAMPLE_ECOSYSTEM_AUTHOR_INPUT.config,
          heredity: { enabled: true, mutationStd: 0.1 },
        },
        criterion: { kind: "measured", metricKey, direction: "minimize" },
      });
      expect(() => validatedSimulatorSpec(enabledSpec)).not.toThrow();
    }
  });
});

describe("world template registry", () => {
  it("keeps the closed tuple and code registry in agreement", () => {
    expect(Object.keys(SIMULATOR_TEMPLATES).sort()).toEqual([...SIMULATOR_TEMPLATE_IDS].sort());
    for (const id of SIMULATOR_TEMPLATE_IDS) {
      expect(SIMULATOR_TEMPLATES[id].id).toBe(id);
      expect(simulatorTemplateErrors(SIMULATOR_TEMPLATES[id])).toEqual([]);
    }
  });
});

describe("ecosystemGrid v2 compatibility boundary", () => {
  it("rejects v1 specs instead of pretending terrain and perception replay under v1 physics", () => {
    const v2 = assembleSimulatorSpec(EXAMPLE_ECOSYSTEM_AUTHOR_INPUT);
    expect(() => validatedSimulatorSpec(v2)).not.toThrow();
    expect(() => validatedSimulatorSpec({ ...v2, templateVersion: 1 })).toThrow(
      /unsupported template version 1/,
    );
  });
});
