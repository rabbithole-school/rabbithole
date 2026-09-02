import { describe, expect, it } from "vitest";

import type { EcosystemGridSimulatorSpec } from "../contract";
import {
  frameAtTick,
  initialTerrainPreviewScene,
  replayCursor,
  type StoredSimulatorRunChunk,
} from "../scene";
import { ECOSYSTEM_GRID } from "../templates/ecosystemGrid";

const SPEC: EcosystemGridSimulatorSpec = {
  version: 1,
  templateId: "ecosystemGrid",
  templateVersion: ECOSYSTEM_GRID.version,
  config: {
    width: 3,
    height: 3,
    boundary: "bounded",
    initialResourceDensity: 0,
    resourceRegrowthPerTick: 0,
    corpseDecayTicks: 2,
    baseMetabolicCost: 0,
    reproductionEnergyThreshold: 20,
    maxAutomata: 2,
    environmentalNoise: { enabled: false, amplitude: 0 },
  },
  criterion: { kind: "measured", metricKey: "longevity", direction: "maximize" },
  speciesSlots: [
    {
      slotId: "grazer",
      label: "Grazer",
      countMin: 1,
      countMax: 2,
      defaultCount: 1,
      senses: [],
    },
  ],
  tickBudget: { iterationTicks: 5, seasonTicks: 5, absoluteMaxTicks: 5 },
  interpreter: { kind: "scripted", interpreterId: "test" },
  microWorld: true,
};

function fixture(): StoredSimulatorRunChunk {
  const initial = ECOSYSTEM_GRID.initialState({
    config: SPEC.config,
    species: [
      {
        slotId: "grazer",
        label: "Grazer",
        count: 1,
        countMax: 2,
        senses: [],
        prompt: "Rest.",
      },
    ],
    seed: "scene-test",
  });
  const scene = ECOSYSTEM_GRID.renderScene({ state: initial, tick: 0 });
  return {
    startTick: 0,
    endTick: 2,
    initialCheckpoint: {
      tick: 0,
      stateJson: JSON.stringify(initial),
      sceneJson: JSON.stringify(scene),
      stateHash: "initial",
    },
    ticks: [0, 1].map((tick) => ({
      tick,
      phase: "day",
      physicsSeed: `scene-test:${tick}`,
      automata: initial.automata.map((automaton) => ({
        automatonId: automaton.id,
        observationJson: JSON.stringify({ self: automaton }),
        reasoning: "Rest conserves energy.",
        acceptedActionJson: JSON.stringify({ kind: "rest" }),
        accepted: true,
      })),
      metrics: [{ key: "longevity", value: tick + 1 }],
    })),
  };
}

describe("World scene replay", () => {
  it("derives a deterministic terrain-only ecosystem preview before any run", () => {
    const previewSpec: EcosystemGridSimulatorSpec = {
      ...SPEC,
      config: {
        ...SPEC.config,
        initialResourceDensity: 1,
        biome: "meadow",
        landscape: {
          version: 1,
          seed: "first-ever-meadow",
          regionCount: 3,
          roughness: 0.4,
          lowlandCoverage: 0.25,
          highlandCoverage: 0.25,
        },
        terrain: {
          shelter: [{ x: 0, y: 0 }],
          current: [{ x: 1, y: 0, direction: "east" }],
          shallows: [{ x: 2, y: 0 }],
          predatorSlotIds: [],
        },
      },
    };

    const preview = initialTerrainPreviewScene(previewSpec);

    expect(preview).toEqual(initialTerrainPreviewScene(previewSpec));
    expect(preview).toMatchObject({
      tick: 0,
      templateId: "ecosystemGrid",
      entities: [],
      viewport: { width: 3, height: 3 },
    });
    expect(preview?.cells).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ x: 0, y: 0, kind: "shelter" }),
        expect.objectContaining({ x: 1, y: 0, kind: "current_east" }),
        expect.objectContaining({ x: 2, y: 0, kind: "shallows" }),
        expect.objectContaining({ kind: "resource" }),
      ]),
    );
    expect(preview).not.toHaveProperty("metrics");
  });

  it("keeps legacy and non-terrain templates on their established no-run fallback", () => {
    const legacyBiomeSpec: EcosystemGridSimulatorSpec = {
      ...SPEC,
      config: { ...SPEC.config, biome: undefined },
    };
    expect(initialTerrainPreviewScene(legacyBiomeSpec)?.templateId).toBe("ecosystemGrid");
    expect(initialTerrainPreviewScene({
      ...SPEC,
      templateId: "publicGoods",
      templateVersion: 1,
      config: {
        rounds: 1,
        endowmentPerRound: 1,
        multiplier: 1,
        noiseProbability: 0,
        maxAutomata: 2,
      },
    } as unknown as EcosystemGridSimulatorSpec)).toBeNull();
    expect(initialTerrainPreviewScene({
      ...legacyBiomeSpec,
      config: { ...legacyBiomeSpec.config, biome: "future-biome" },
    } as unknown as EcosystemGridSimulatorSpec)).toBeNull();
    expect(initialTerrainPreviewScene({
      ...legacyBiomeSpec,
      templateVersion: legacyBiomeSpec.templateVersion + 1,
    })).toBeNull();
    expect(
      initialTerrainPreviewScene({
        ...SPEC,
        speciesSlots: [{ ...SPEC.speciesSlots[0], countMin: -1 }],
      }),
    ).toBeNull();
  });

  it("does not replace a frozen run snapshot with the current preview spec", () => {
    const currentSpec: EcosystemGridSimulatorSpec = {
      ...SPEC,
      config: { ...SPEC.config, width: 5, height: 4, biome: "meadow" },
    };

    const preview = initialTerrainPreviewScene(currentSpec);
    const replay = frameAtTick([fixture()], 0, SPEC);

    expect(preview?.viewport).toMatchObject({ width: 5, height: 4 });
    expect(replay.scene.viewport).toMatchObject({ width: 3, height: 3 });
    expect(replay.scene.entities).toHaveLength(1);
    expect(replay.metrics).toEqual({});
  });

  it("deterministically seeks from the nearest checkpoint", () => {
    const chunk = fixture();
    expect(frameAtTick([chunk], 2, SPEC)).toEqual(frameAtTick([chunk], 2, SPEC));
    expect(frameAtTick([chunk], 2, SPEC)).toMatchObject({
      tick: 2,
      metrics: { longevity: 2 },
      automata: [{ lastAction: "rest", thought: "Rest conserves energy." }],
    });
  });

  it("pages through replayCursor and reuses the framework-free derivation", async () => {
    const chunk = fixture();
    const loads: number[] = [];
    const cursor = replayCursor("run-1", {
      loadChunks: async ({ fromTick }) => {
        loads.push(fromTick);
        return [chunk];
      },
    });
    expect(await cursor.frameAtTick(2, SPEC)).toEqual(frameAtTick([chunk], 2, SPEC));
    expect(loads.length).toBeGreaterThan(0);
  });

  it("surfaces a screened one-line memory, honoring whatever scratch the caller already redacted", () => {
    const chunk = fixture();
    const withMemory: StoredSimulatorRunChunk = {
      ...chunk,
      ticks: chunk.ticks.map((tick) => ({
        ...tick,
        automata: tick.automata.map((automaton) => ({
          ...automaton,
          scratchAfter: "The other automaton looked ready to cooperate again.",
        })),
      })),
    };
    expect(frameAtTick([withMemory], 2, SPEC).automata).toMatchObject([
      { remembers: "The other automaton looked ready to cooperate again." },
    ]);

    // Scratch may contain newlines; the surfaced memory must stay ONE line
    // (review finding: screenWorldText preserves newlines).
    const withMultilineMemory: StoredSimulatorRunChunk = {
      ...chunk,
      ticks: chunk.ticks.map((tick) => ({
        ...tick,
        automata: tick.automata.map((automaton) => ({
          ...automaton,
          scratchAfter: "line one\nline two\n\n  line three  ",
        })),
      })),
    };
    expect(frameAtTick([withMultilineMemory], 2, SPEC).automata).toMatchObject([
      { remembers: "line one line two line three" },
    ]);

    // The unsafe-text screen (screenWorldText) applies to scratch exactly
    // like every other human-facing World text field.
    const withUnsafeMemory: StoredSimulatorRunChunk = {
      ...chunk,
      ticks: chunk.ticks.map((tick) => ({
        ...tick,
        automata: tick.automata.map((automaton) => ({
          ...automaton,
          scratchAfter: "email me at nobody@example.com",
        })),
      })),
    };
    expect(frameAtTick([withUnsafeMemory], 2, SPEC).automata[0].remembers).toBe(
      "Content unavailable for display.",
    );

    // Tournament redaction is enforced upstream, at the query seam
    // (convex/simulatorRuns.ts's projectChunkForHumans), by setting an
    // unauthorized viewer's scratchAfter to `undefined` before a chunk ever
    // reaches this module. Absent scratch here must stay absent, never a
    // fabricated placeholder that could mislead a reader into thinking
    // "no memory" when the truth is "hidden".
    expect(frameAtTick([chunk], 2, SPEC).automata[0].remembers).toBeUndefined();
  });

  it("preserves a terminal automaton's final living decision for Inspector selection", () => {
    const terminalSpec: EcosystemGridSimulatorSpec = {
      ...SPEC,
      config: { ...SPEC.config, baseMetabolicCost: 2 },
    };
    const initial = ECOSYSTEM_GRID.initialState({
      config: terminalSpec.config,
      species: [{
        slotId: "grazer",
        label: "Grazer",
        count: 1,
        countMax: 1,
        senses: [],
        prompt: "Rest.",
      }],
      seed: "terminal-scene-test",
    });
    const automaton = { ...initial.automata[0], energy: 1 };
    const state = { ...initial, automata: [automaton], resources: [] };
    const scene = ECOSYSTEM_GRID.renderScene({ state, tick: 0 });
    const chunk: StoredSimulatorRunChunk = {
      startTick: 0,
      endTick: 1,
      initialCheckpoint: {
        tick: 0,
        stateJson: JSON.stringify(state),
        sceneJson: JSON.stringify(scene),
        stateHash: "terminal-initial",
      },
      ticks: [{
        tick: 0,
        phase: "day",
        physicsSeed: "terminal-scene-test:0",
        automata: [{
          automatonId: automaton.id,
          slotId: "grazer",
          observationJson: JSON.stringify({ self: automaton }),
          reasoning: "Resting uses less energy.",
          acceptedActionJson: JSON.stringify({ kind: "rest" }),
          accepted: true,
        }],
        metrics: [{ key: "longevity", value: 1 }],
      }],
    };

    const frame = frameAtTick([chunk], 1, terminalSpec);
    expect(frame.automata).toEqual([]);
    expect(frame.terminalAutomata).toMatchObject([{
      id: automaton.id,
      alive: false,
      lastAction: "rest",
      thought: "Resting uses less energy.",
      lastDecisionTick: 0,
    }]);
    expect(frame.scene.entities).toContainEqual(expect.objectContaining({
      kind: "corpse",
      automatonId: automaton.id,
    }));
  });
});
