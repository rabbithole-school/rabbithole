import { describe, expect, it } from "vitest";

import {
  MAX_AUTOMATA_COMPILED_RUN,
  MAX_CHUNK_JSON_BYTES,
  MAX_ECOSYSTEM_SPECIES_SLOTS,
  MAX_GRID_CELLS_PER_COMPILED_RUN,
  MAX_SCENE_JSON_BYTES,
  MAX_SNAPSHOT_JSON_BYTES,
  RENDERER_PROTOCOL_VERSION,
  type EcosystemGridSimulatorSpec,
  type RuntimeSimulatorTemplate,
  type SimulatorSceneV1,
  type SimulatorSpec,
} from "../contract";
import type { PolicyIR } from "../policyIR";
import { canonicalJson } from "../prompt";
import { colorForSlotIndex } from "../helpers";
import {
  assembleSimulatorSpec,
  buildSimulatorTemplateCatalog,
  type SimulatorAuthorInput,
  validatedSimulatorSpec,
} from "../../../convex/lib/simulatorTemplatesCatalog";
import {
  SIMULATOR_TEMPLATES,
  simulatorTemplateErrors,
} from "../templates/registry";
import { estimateEcosystemCompiledTickBytes } from "../templates/ecosystemGrid";
import { launchedSpecies, runTemplate } from "./support/miniRunner";

const textEncoder = new TextEncoder();
const catalogExamples = new Map<string, SimulatorAuthorInput>(
  buildSimulatorTemplateCatalog().templates.map((entry) => [
    entry.templateId,
    entry.exampleAuthorInput,
  ]),
);

describe("template roster limits", () => {
  it("allows twelve ecosystem slots while retaining the five-slot public-goods ceiling", () => {
    const ecosystem = exampleSpec(
      SIMULATOR_TEMPLATES.ecosystemGrid,
    ) as EcosystemGridSimulatorSpec;
    const ecosystemSlots = Array.from({ length: MAX_ECOSYSTEM_SPECIES_SLOTS }, (_, index) => ({
      ...ecosystem.speciesSlots[0],
      slotId: `species-${index + 1}`,
      label: `Species ${index + 1}`,
      countMin: 0,
      countMax: 1,
      defaultCount: 0,
    }));
    expect(() =>
      SIMULATOR_TEMPLATES.ecosystemGrid.validateSpec({
        ...ecosystem,
        speciesSlots: ecosystemSlots,
      }),
    ).not.toThrow();
    expect(() =>
      SIMULATOR_TEMPLATES.ecosystemGrid.validateSpec({
        ...ecosystem,
        speciesSlots: [...ecosystemSlots, { ...ecosystemSlots[0], slotId: "species-13", label: "Species 13" }],
      }),
    ).toThrow(/1 through 12/);

    const publicGoods = exampleSpec(SIMULATOR_TEMPLATES.publicGoods);
    const publicGoodsSlots = Array.from({ length: 6 }, (_, index) => ({
      ...publicGoods.speciesSlots[0],
      slotId: `population-${index + 1}`,
      label: `Population ${index + 1}`,
      countMin: index === 0 ? publicGoods.speciesSlots[0].countMin : 0,
      countMax: publicGoods.speciesSlots[0].countMax,
      defaultCount: index === 0 ? publicGoods.speciesSlots[0].defaultCount : 0,
    }));
    expect(() =>
      SIMULATOR_TEMPLATES.publicGoods.validateSpec({
        ...publicGoods,
        speciesSlots: publicGoodsSlots,
      }),
    ).toThrow(/1 through 5/);

    const { terrain: _terrain, ...ecosystemConfig } = ecosystem.config;
    const rendered = SIMULATOR_TEMPLATES.ecosystemGrid.renderScene({
      state: SIMULATOR_TEMPLATES.ecosystemGrid.initialState({
        config: { ...ecosystemConfig, maxAutomata: MAX_ECOSYSTEM_SPECIES_SLOTS },
        species: ecosystemSlots.map((slot) => ({
          slotId: slot.slotId,
          label: slot.label,
          count: 1,
          countMax: slot.countMax,
          senses: slot.senses,
          prompt: "",
        })),
        seed: "twelve-species-palette",
      }),
      tick: 0,
    });
    const colors = rendered.entities
      .filter((entity) => entity.kind === "automaton")
      .map((entity) => entity.color);
    expect(new Set(colors).size).toBe(12);
    for (const [index, slot] of ecosystemSlots.entries()) {
      expect(rendered.entities.find((entity) => entity.label === slot.label)?.color).toBe(
        colorForSlotIndex(index),
      );
    }
  });
});

function byteLength(value: unknown): number {
  return textEncoder.encode(JSON.stringify(value)).length;
}

function exampleSpec(template: RuntimeSimulatorTemplate): SimulatorSpec {
  const example = catalogExamples.get(template.id);
  if (!example) {
    throw new Error(`Catalog has no example for registered template "${template.id}"`);
  }
  return validatedSimulatorSpec(assembleSimulatorSpec(example));
}

function expectValidScene(
  scene: SimulatorSceneV1,
  template: RuntimeSimulatorTemplate,
  tick: number,
) {
  expect(scene).toMatchObject({
    protocolVersion: RENDERER_PROTOCOL_VERSION,
    templateId: template.id,
    tick,
    viewport: {
      width: expect.any(Number),
      height: expect.any(Number),
      boundary: expect.stringMatching(/^(bounded|toroidal)$/),
    },
    entities: expect.any(Array),
    cells: expect.any(Array),
  });
  expect(scene.viewport.width).toBeGreaterThan(0);
  expect(scene.viewport.height).toBeGreaterThan(0);
  for (const entity of scene.entities) {
    expect(entity).toMatchObject({
      id: expect.any(String),
      kind: expect.any(String),
      x: expect.any(Number),
      y: expect.any(Number),
      layer: expect.any(Number),
    });
    expect(entity.x).toBeGreaterThanOrEqual(0);
    expect(entity.x).toBeLessThan(scene.viewport.width);
    expect(entity.y).toBeGreaterThanOrEqual(0);
    expect(entity.y).toBeLessThan(scene.viewport.height);
  }
  for (const cell of scene.cells) {
    expect(cell).toMatchObject({
      x: expect.any(Number),
      y: expect.any(Number),
      kind: expect.any(String),
      intensity: expect.any(Number),
    });
    expect(cell.x).toBeGreaterThanOrEqual(0);
    expect(cell.x).toBeLessThan(scene.viewport.width);
    expect(cell.y).toBeGreaterThanOrEqual(0);
    expect(cell.y).toBeLessThan(scene.viewport.height);
    expect(Number.isFinite(cell.intensity)).toBe(true);
  }
  expect(byteLength(scene)).toBeLessThanOrEqual(MAX_SCENE_JSON_BYTES);
}

describe.each(Object.values(SIMULATOR_TEMPLATES))(
  "$id template conformance",
  (template) => {
    const spec = exampleSpec(template);

    it("has an internally consistent registry entry and catalog example", () => {
      expect(simulatorTemplateErrors(template)).toEqual([]);
      expect(() => template.validateSpec(spec)).not.toThrow();
      expect(new Set(template.summaryMetricKeys).isSubsetOf(new Set(template.metricKeys))).toBe(
        true,
      );
    });

    it("is byte-deterministic for the same seed and action stream over 50 ticks", () => {
      const run = () =>
        runTemplate({
          template,
          spec,
          seed: "conformance-same-seed",
          ticks: 50,
          stopOnTerminal: false,
        });
      const first = run();
      const second = run();

      expect(first.ticks).toHaveLength(50);
      expect(second.ticks).toHaveLength(50);
      for (let index = 0; index < first.ticks.length; index += 1) {
        expect(first.ticks[index].stateJson).toBe(second.ticks[index].stateJson);
        expect(first.ticks[index].metrics).toEqual(second.ticks[index].metrics);
      }
      expect(() =>
        runTemplate({
          template,
          spec,
          seed: "conformance-different-seed",
          ticks: 50,
          stopOnTerminal: false,
        }),
      ).not.toThrow();
    });

    it("replays exactly from a mid-run checkpoint", () => {
      const full = runTemplate({
        template,
        spec,
        seed: "conformance-replay",
        ticks: 50,
        stopOnTerminal: false,
      });
      const checkpoint = full.ticks[24];
      const replay = runTemplate({
        template,
        spec,
        seed: "conformance-replay",
        state: JSON.parse(checkpoint.stateJson),
        startTick: 25,
        ticks: 25,
        stopOnTerminal: false,
      });

      expect(replay.ticks.map((tick) => tick.stateJson)).toEqual(
        full.ticks.slice(25).map((tick) => tick.stateJson),
      );
      expect(replay.ticks.map((tick) => tick.metrics)).toEqual(
        full.ticks.slice(25).map((tick) => tick.metrics),
      );
    });

    it("turns malformed actions neutral while preserving invalid-action telemetry", () => {
      const state = template.initialState({
        config: spec.config,
        species: launchedSpecies(spec),
        seed: "conformance-invalid",
      });
      const automaton = template.listAutomata(state)[0];
      expect(automaton).toBeDefined();
      expect(() => template.validateAction({ kind: "__malformed__", extra: true })).toThrow();

      const observation = template.buildObservation({
        state,
        automatonId: automaton.id,
        senses: automaton.senses,
        tick: 0,
      });
      const legal = template.legalActions({
        state,
        automatonId: automaton.id,
        observation,
        tick: 0,
      });
      const neutral =
        legal.find(
          (action) =>
            typeof action === "object" &&
            action !== null &&
            Reflect.get(action, "kind") === "noop",
        ) ?? legal[0];
      const applied = template.applyActions({
        state,
        actions: new Map([[automaton.id, template.validateAction(neutral)]]),
        tick: 0,
        tickSeed: "conformance-invalid:0",
      });
      const countedOnce = template.withInvalidActions({
        state: applied.state,
        count: 1,
      });
      const countedTwice = template.withInvalidActions({
        state: countedOnce,
        count: 1,
      });
      const countedTogether = template.withInvalidActions({
        state: applied.state,
        count: 2,
      });
      const deltaOnce = template.withInvalidActionDelta({
        delta: applied.delta,
        automatonIds: [automaton.id],
      });
      const deltaTwice = template.withInvalidActionDelta({
        delta: deltaOnce,
        automatonIds: [automaton.id],
      });
      const deltaTogether = template.withInvalidActionDelta({
        delta: applied.delta,
        automatonIds: [automaton.id, automaton.id],
      });

      expect(countedOnce).not.toEqual(applied.state);
      expect(countedTwice).toEqual(countedTogether);
      expect(deltaTwice).toEqual(deltaTogether);
      expect(() => template.validateState(countedOnce)).not.toThrow();
      expect(() => template.validateDelta(deltaOnce)).not.toThrow();
    });

    it("exposes only validated legal actions that apply without invalid rewriting", () => {
      const state = template.initialState({
        config: spec.config,
        species: launchedSpecies(spec),
        seed: "conformance-menu",
      });
      for (const automaton of template.listAutomata(state)) {
        const observation = template.buildObservation({
          state,
          automatonId: automaton.id,
          senses: automaton.senses,
          tick: 0,
        });
        const legal = template.legalActions({
          state,
          automatonId: automaton.id,
          observation,
          tick: 0,
        });
        const neutral =
          legal.find(
            (action) =>
              typeof action === "object" &&
              action !== null &&
              Reflect.get(action, "kind") === "noop",
          ) ?? legal[0];
        const neutralResult = template.applyActions({
          state,
          actions: new Map([[automaton.id, template.validateAction(neutral)]]),
          tick: 0,
          tickSeed: "conformance-menu:0",
        });
        // A template reports an internally rejected menu action as neutral physics
        // plus one invalid action, so this is the generic rejection oracle.
        const invalidNeutralState = template.withInvalidActions({
          state: neutralResult.state,
          count: 1,
        });

        expect(legal.length).toBeGreaterThan(0);
        for (const action of legal) {
          expect(() => template.validateAction(action)).not.toThrow();
          const result = template.applyActions({
            state,
            actions: new Map([[automaton.id, template.validateAction(action)]]),
            tick: 0,
            tickSeed: "conformance-menu:0",
          });
          expect(() => template.validateState(result.state)).not.toThrow();
          expect(result.state).not.toEqual(invalidNeutralState);
        }
      }
    });

    it("renders valid bounded scenes at launch and after 50 ticks", () => {
      const run = runTemplate({
        template,
        spec,
        seed: "conformance-scene",
        ticks: 50,
        stopOnTerminal: false,
      });
      expectValidScene(
        template.renderScene({ state: run.initialState, tick: 0 }),
        template,
        0,
      );
      expectValidScene(
        template.renderScene({ state: run.finalState, tick: 50 }),
        template,
        50,
      );
    });

    it("emits every declared metric and remains inside serialization limits", () => {
      const run = runTemplate({
        template,
        spec,
        seed: "conformance-bounds",
        ticks: 50,
        stopOnTerminal: false,
      });

      for (const tick of run.ticks) {
        for (const key of template.metricKeys) {
          expect(tick.metrics).toHaveProperty(key);
          expect(Number.isFinite(tick.metrics[key])).toBe(true);
        }
        expect(byteLength({
          tick: tick.tick,
          phase: tick.phase,
          actions: [...tick.actions],
          delta: tick.delta,
          metrics: tick.metrics,
        })).toBeLessThanOrEqual(MAX_CHUNK_JSON_BYTES);
        expect(byteLength(tick.state)).toBeLessThanOrEqual(MAX_SNAPSHOT_JSON_BYTES);
      }
      expect(
        byteLength(
          run.ticks.map((tick) => ({
            tick: tick.tick,
            phase: tick.phase,
            actions: [...tick.actions],
            delta: tick.delta,
            metrics: tick.metrics,
          })),
        ),
      ).toBeLessThanOrEqual(MAX_CHUNK_JSON_BYTES);
    });
  },
);

const POPULATION_POLICY: PolicyIR = {
  version: 1,
  templateId: "ecosystemGrid",
  slotId: "grazer",
  rules: [{ id: "wait", when: [], then: { kind: "noop" } }],
  default: { kind: "abstain" },
};
const WORST_ALLOWED_POPULATION_SENSES: EcosystemGridSimulatorSpec["speciesSlots"][number]["senses"] = [
  {
    senseId: "vision",
    range: 2,
    channels: ["automata", "resources", "boundary"],
  },
  {
    senseId: "smell",
    range: 2,
    channels: ["resources"],
  },
];

function populationSpec(input: {
  width: number;
  height: number;
  population: number;
  senses?: EcosystemGridSimulatorSpec["speciesSlots"][number]["senses"];
}): EcosystemGridSimulatorSpec {
  const spec = validatedSimulatorSpec(
    assembleSimulatorSpec({
      templateId: "ecosystemGrid",
      config: {
        width: input.width,
        height: input.height,
        boundary: "bounded",
        initialResourceDensity: 1,
        resourceRegrowthPerTick: 0,
        corpseDecayTicks: 4,
        baseMetabolicCost: 0,
        reproductionEnergyThreshold: 100,
        maxAutomata: input.population,
        environmentalNoise: { enabled: false, amplitude: 0 },
      },
      speciesSlots: [
        {
          slotId: "grazer",
          label: "Grazers",
          countMin: 1,
          countMax: input.population,
          defaultCount: input.population,
          senses: input.senses ?? WORST_ALLOWED_POPULATION_SENSES,
        },
      ],
      criterion: {
        kind: "measured",
        metricKey: "livingAutomata",
        direction: "maximize",
      },
      tickBudget: {
        iterationTicks: 50,
        seasonTicks: 200,
        absoluteMaxTicks: 200,
      },
    }),
  );
  if (spec.templateId !== "ecosystemGrid") {
    throw new Error("Population fixture assembled the wrong World template");
  }
  return spec;
}

function compiledTickByteLength(input: {
  spec: EcosystemGridSimulatorSpec;
  seed: string;
}): number {
  const template = SIMULATOR_TEMPLATES.ecosystemGrid;
  const run = runTemplate({
    template,
    spec: input.spec,
    seed: input.seed,
    policies: { grazer: POPULATION_POLICY },
    ticks: 1,
    stopOnTerminal: false,
  });
  const tick = run.ticks[0];
  const automata = template
    .listAutomata(run.initialState)
    .slice()
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((automaton) => {
      const observation = template.buildObservation({
        state: run.initialState,
        automatonId: automaton.id,
        senses: automaton.senses,
        tick: 0,
      });
      const legalActions = template.legalActions({
        state: run.initialState,
        automatonId: automaton.id,
        observation,
        tick: 0,
      });
      const acceptedAction = tick.actions.get(automaton.id);
      return {
        automatonId: automaton.id,
        slotId: automaton.slotId,
        observationJson: canonicalJson(observation),
        tickPhase: tick.phase,
        legalActionsJson: canonicalJson(legalActions),
        decisionHash: "0".repeat(64),
        source: "compiled",
        modelResponseJson: "[]",
        reasoning: "Rule wait fired: always -> wait",
        policyRuleId: "wait",
        policyTrace: "Rule wait fired: always -> wait",
        requestedActionJson: canonicalJson(acceptedAction),
        acceptedActionJson: canonicalJson(acceptedAction),
        accepted: true,
      };
    });
  return textEncoder.encode(
    canonicalJson({
      tick: 0,
      phase: tick.phase,
      physicsSeed: `${input.seed}:0`,
      automata,
      deltaJson: canonicalJson(tick.delta),
      metrics: Object.entries(tick.metrics).map(([key, value]) => ({ key, value })),
      invalidActionCount: 0,
    }),
  ).length;
}

describe("population-scale ecosystem conformance", () => {
  it("preserves heredity and trait criteria in population-scale specs", () => {
    const spec = populationSpec({
      width: 30,
      height: 22,
      population: MAX_AUTOMATA_COMPILED_RUN,
    });
    const hereditySpec = {
      ...spec,
      config: {
        ...spec.config,
        heredity: { enabled: true, mutationStd: 0.15 },
      },
      speciesSlots: spec.speciesSlots.map((slot) => ({
        ...slot,
        // Perception may double authored ranges, so range 1 preserves the
        // measured range-2 population envelope at the 2.0 trait ceiling.
        senses: slot.senses.map((sense) => ({ ...sense, range: 1 })),
      })),
      criterion: {
        kind: "measured" as const,
        metricKey: "traitSpread",
        direction: "maximize" as const,
      },
    };

    expect(() => SIMULATOR_TEMPLATES.ecosystemGrid.validateSpec(hereditySpec)).not.toThrow();
    expect(() =>
      SIMULATOR_TEMPLATES.ecosystemGrid.validateSpec({
        ...hereditySpec,
        config: { ...hereditySpec.config, heredity: undefined },
      }),
    ).toThrow(/requires config\.heredity\.enabled/);
  });

  it("keeps the compiled cap inside snapshot and scene half-limits at the largest grid", () => {
    const width = 40;
    const height = MAX_GRID_CELLS_PER_COMPILED_RUN / width;
    const spec = populationSpec({
      width,
      height,
      population: MAX_AUTOMATA_COMPILED_RUN,
    });
    const template = SIMULATOR_TEMPLATES.ecosystemGrid;
    const run = runTemplate({
      template,
      spec,
      seed: "population-byte-envelope",
      policies: { grazer: POPULATION_POLICY },
      ticks: 1,
      stopOnTerminal: false,
    });

    expect(width * height).toBe(MAX_GRID_CELLS_PER_COMPILED_RUN);
    expect(byteLength(run.initialState)).toBeLessThanOrEqual(
      MAX_SNAPSHOT_JSON_BYTES / 2,
    );
    expect(
      byteLength(template.renderScene({ state: run.initialState, tick: 0 })),
    ).toBeLessThanOrEqual(MAX_SCENE_JSON_BYTES / 2);
    expect(
      estimateEcosystemCompiledTickBytes(spec.config, spec.speciesSlots),
    ).toBe(299_008);
    expect(
      compiledTickByteLength({
        spec,
        seed: "population-worst-allowed-senses",
      }),
    ).toBeLessThanOrEqual(MAX_CHUNK_JSON_BYTES / 2);
  });

  it("rejects population-scale grids outside the measured byte envelope", () => {
    expect(() =>
      populationSpec({ width: 20, height: 20, population: MAX_AUTOMATA_COMPILED_RUN }),
    ).toThrow(/at least 10 grid cells per automaton/);
    expect(() =>
      populationSpec({ width: 41, height: 30, population: MAX_AUTOMATA_COMPILED_RUN }),
    ).toThrow(/at most 1200 grid cells/);
    expect(() =>
      populationSpec({ width: 30, height: 22, population: MAX_AUTOMATA_COMPILED_RUN + 1 }),
    ).toThrow(/config.maxAutomata must be from 1 through 64/);
    expect(() =>
      populationSpec({
        width: 30,
        height: 22,
        population: MAX_AUTOMATA_COMPILED_RUN,
        senses: [
          {
            senseId: "vision",
            range: 3,
            channels: ["automata", "resources", "boundary"],
          },
        ],
      }),
    ).toThrow(/compiled population senses are too broad/);
    expect(() =>
      populationSpec({
        width: 30,
        height: 22,
        population: MAX_AUTOMATA_COMPILED_RUN,
        senses: [
          {
            senseId: "vision",
            range: 100,
            channels: ["automata", "resources", "corpses", "boundary"],
          },
        ],
      }),
    ).toThrow(/compiled population senses are too broad/);
    const mixedSpec = populationSpec({
      width: 30,
      height: 22,
      population: MAX_AUTOMATA_COMPILED_RUN,
    });
    expect(() =>
      SIMULATOR_TEMPLATES.ecosystemGrid.validateSpec({
        ...mixedSpec,
        speciesSlots: [
          {
            slotId: "expanding",
            label: "Expanding grazers",
            countMin: 1,
            countMax: MAX_AUTOMATA_COMPILED_RUN,
            defaultCount: 1,
            senses: [
              {
                senseId: "vision",
                range: 10,
                channels: ["automata", "resources", "corpses", "boundary"],
              },
            ],
          },
          {
            slotId: "filler",
            label: "Short-lived plankton",
            countMin: MAX_AUTOMATA_COMPILED_RUN - 1,
            countMax: MAX_AUTOMATA_COMPILED_RUN - 1,
            defaultCount: MAX_AUTOMATA_COMPILED_RUN - 1,
            senses: [],
          },
        ],
      }),
    ).toThrow(/compiled population senses are too broad/);
  });

  it("is deterministic at N=60", () => {
    const spec = populationSpec({ width: 30, height: 20, population: 60 });
    const run = () =>
      runTemplate({
        template: SIMULATOR_TEMPLATES.ecosystemGrid,
        spec,
        seed: "population-determinism",
        policies: { grazer: POPULATION_POLICY },
        ticks: 50,
        stopOnTerminal: false,
      });

    const first = run();
    const second = run();
    expect(first.ticks.map((tick) => tick.stateJson)).toEqual(
      second.ticks.map((tick) => tick.stateJson),
    );
    expect(first.ticks.map((tick) => tick.metrics)).toEqual(
      second.ticks.map((tick) => tick.metrics),
    );
  });
});
