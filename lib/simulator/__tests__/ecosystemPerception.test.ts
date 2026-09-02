import { describe, expect, it } from "vitest";

import type {
  EcosystemGridSimulatorSpec,
  SimulatorSceneV1,
} from "../contract";
import {
  ecosystemGridDistance,
  projectEcosystemSenseCoverage,
  projectEcosystemSense,
} from "../ecosystemPerception";

const spec: EcosystemGridSimulatorSpec = {
  version: 1,
  templateId: "ecosystemGrid",
  templateVersion: 2,
  speciesSlots: [
    {
      slotId: "hunter",
      label: "Hunter",
      countMin: 1,
      countMax: 2,
      defaultCount: 1,
      senses: [
        { senseId: "vision", range: 3, channels: ["automata"] },
        { senseId: "smell", range: 4, channels: ["automata"] },
      ],
    },
  ],
  tickBudget: { iterationTicks: 8, seasonTicks: 8, absoluteMaxTicks: 8 },
  interpreter: { kind: "scripted", interpreterId: "test" },
  microWorld: true,
  config: {
    width: 5,
    height: 5,
    boundary: "toroidal",
    biome: "reef",
    initialResourceDensity: 0.4,
    baseMetabolicCost: 1,
    reproductionEnergyThreshold: 10,
    resourceRegrowthPerTick: 1,
    corpseDecayTicks: 1,
    maxAutomata: 2,
    environmentalNoise: { enabled: false, amplitude: 0 },
    terrain: {
      shelter: [],
      current: [],
      shallows: [{ x: 0, y: 0 }],
      predatorSlotIds: [],
    },
  },
  criterion: { kind: "measured", metricKey: "longevity", direction: "maximize" },
};

function scene(hidden: boolean): SimulatorSceneV1 {
  return {
    protocolVersion: 1,
    templateId: "ecosystemGrid",
    tick: 1,
    viewport: { width: 5, height: 5, boundary: "toroidal" },
    entities: [
      {
        id: "hunter:1",
        kind: "automaton",
        slotId: "hunter",
        x: 0,
        y: 0,
        layer: 2,
        label: "Hunter",
        perceptionTrait: 1,
      },
      {
        id: "hunter:2",
        kind: "automaton",
        slotId: "hunter",
        x: 4,
        y: 0,
        layer: 2,
        label: "Hunter",
        hidden,
      },
    ],
    cells: [],
  };
}

describe("ecosystem perception projection", () => {
  it("uses wrapped Manhattan distance", () => {
    expect(
      ecosystemGridDistance(
        { x: 0, y: 0 },
        { x: 4, y: 4 },
        { width: 5, height: 5, boundary: "toroidal" },
      ),
    ).toBe(2);
  });

  it("applies shallows range and distinguishes hidden sight from scent", () => {
    const vision = projectEcosystemSense({
      spec,
      scene: scene(true),
      actorId: "hunter:1",
      senseId: "vision",
    });
    const scent = projectEcosystemSense({
      spec,
      scene: scene(true),
      actorId: "hunter:1",
      senseId: "smell",
    });

    expect(vision?.range).toBe(1);
    expect(vision?.targets).toEqual([]);
    expect(scent?.range).toBe(2);
    expect(scent?.targets).toEqual([
      expect.objectContaining({
        key: "entity:hunter:2",
        status: "hidden",
        label: "Hunter is detected by scent but hidden from sight",
      }),
    ]);
  });

  it("covers only cells inside the canonical wrapped sense range", () => {
    const coverage = projectEcosystemSenseCoverage({
      spec,
      scene: scene(false),
      actorId: "hunter:1",
      senseId: "vision",
    });

    expect(coverage).toMatchObject({ actorId: "hunter:1", senseId: "vision", range: 1 });
    expect(coverage?.cells).toContainEqual({ x: 4, y: 0 });
    expect(coverage?.cells).toContainEqual({ x: 0, y: 4 });
    expect(coverage?.cells).not.toContainEqual({ x: 2, y: 0 });
  });
});
