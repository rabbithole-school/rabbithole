import { describe, expect, it } from "vitest";

import {
  MAX_AUTOMATA_PER_RUN,
  MAX_SCENE_JSON_BYTES,
  type LaunchedSpecies,
  type PublicGoodsConfig,
  type PublicGoodsSimulatorSpec,
} from "../contract";
import { buildAutomatonPrompt } from "../prompt";
import {
  PUBLIC_GOODS,
  type PublicGoodsAction,
} from "../templates/publicGoods";
import {
  SIMULATOR_TEMPLATE_IDS,
  SIMULATOR_TEMPLATES,
  simulatorTemplateErrors,
} from "../templates/registry";

const CONFIG: PublicGoodsConfig = {
  rounds: 3,
  endowmentPerRound: 10,
  multiplier: 2,
  noiseProbability: 1,
  maxAutomata: 6,
};

const CLONES: readonly LaunchedSpecies[] = [
  {
    slotId: "villager",
    label: "Villager",
    count: 6,
    countMax: 6,
    senses: [{ senseId: "history" }],
    prompt: "Contribute when the same law should work for everyone.",
  },
];

const SPEC: PublicGoodsSimulatorSpec = {
  version: 1,
  templateId: "publicGoods",
  templateVersion: 1,
  config: CONFIG,
  criterion: { kind: "measured", metricKey: "minScore", direction: "maximize" },
  speciesSlots: [
    {
      slotId: "villager",
      label: "Villager",
      countMin: 3,
      countMax: 6,
      defaultCount: 6,
      senses: [{ senseId: "history" }],
    },
  ],
  tickBudget: { iterationTicks: 1, seasonTicks: 3, absoluteMaxTicks: 3 },
  interpreter: { kind: "llm", role: "AUTOMATON" },
  microWorld: false,
};

function firstRound(
  seed: string,
  contributingIds: ReadonlySet<string>,
) {
  const initial = PUBLIC_GOODS.initialState({ config: CONFIG, species: CLONES, seed });
  const actions = new Map<string, PublicGoodsAction>(
    initial.players.map((player) => [
      player.id,
      { kind: contributingIds.has(player.id) ? "contribute" : "withhold" },
    ]),
  );
  return {
    initial,
    result: PUBLIC_GOODS.applyActions({
      state: initial,
      actions,
      tick: 0,
      tickSeed: `${seed}:0`,
    }),
  };
}

function fullRun(seed: string) {
  let state = PUBLIC_GOODS.initialState({ config: CONFIG, species: CLONES, seed });
  const deltas = [];
  for (let tick = 0; tick < CONFIG.rounds; tick += 1) {
    const result = PUBLIC_GOODS.applyActions({
      state,
      actions: new Map(
        state.players.map((player, index) => [
          player.id,
          { kind: (index + tick) % 2 === 0 ? "contribute" : "withhold" },
        ]),
      ),
      tick,
      tickSeed: `${seed}:${tick}`,
    });
    state = result.state;
    deltas.push(result.delta);
  }
  return { state, deltas };
}

function expectSceneWithinBounds(scene: ReturnType<typeof PUBLIC_GOODS.renderScene>) {
  for (const entity of scene.entities) {
    expect(entity.x).toBeGreaterThanOrEqual(0);
    expect(entity.x).toBeLessThan(scene.viewport.width);
    expect(entity.y).toBeGreaterThanOrEqual(0);
    expect(entity.y).toBeLessThan(scene.viewport.height);
  }
  for (const cell of scene.cells) {
    expect(cell.x).toBeGreaterThanOrEqual(0);
    expect(cell.x).toBeLessThan(scene.viewport.width);
    expect(cell.y).toBeGreaterThanOrEqual(0);
    expect(cell.y).toBeLessThan(scene.viewport.height);
    expect(cell.intensity).toBeGreaterThanOrEqual(0);
    expect(cell.intensity).toBeLessThanOrEqual(1);
  }
  expect(new TextEncoder().encode(JSON.stringify(scene)).length).toBeLessThanOrEqual(
    MAX_SCENE_JSON_BYTES,
  );
}

describe("publicGoods physics", () => {
  it("normalizes the configured bounds and validates clone and heterogeneous populations", () => {
    expect(PUBLIC_GOODS.validateConfig(CONFIG)).toEqual(CONFIG);
    expect(() => PUBLIC_GOODS.validateSpec(SPEC)).not.toThrow();
    expect(() =>
      PUBLIC_GOODS.validateSpec({
        ...SPEC,
        speciesSlots: [
          {
            slotId: "contributors",
            label: "Contributors",
            countMin: 0,
            countMax: 3,
            defaultCount: 3,
            senses: [{ senseId: "history" }],
          },
          {
            slotId: "skeptics",
            label: "Skeptics",
            countMin: 0,
            countMax: 3,
            defaultCount: 3,
            senses: [{ senseId: "history" }],
          },
        ],
      }),
    ).not.toThrow();
    expect(() =>
      PUBLIC_GOODS.validateConfig({ ...CONFIG, maxAutomata: MAX_AUTOMATA_PER_RUN + 1 }),
    ).toThrow(/maxAutomata/);
    expect(() =>
      PUBLIC_GOODS.validateSpec({
        ...SPEC,
        config: { ...CONFIG, multiplier: 6 },
      }),
    ).toThrow(/less than/);
    expect(() =>
      PUBLIC_GOODS.validateSpec({
        ...SPEC,
        criterion: { kind: "measured", metricKey: "maxScore", direction: "maximize" },
      }),
    ).toThrow(/group metric/);
  });

  it("splits the multiplied pool among every player and preserves free-rider endowments", () => {
    const initial = PUBLIC_GOODS.initialState({
      config: { ...CONFIG, noiseProbability: 0 },
      species: CLONES,
      seed: "payoffs",
    });
    const contributors = new Set(initial.players.slice(0, 3).map((player) => player.id));
    const actions = new Map<string, PublicGoodsAction>(
      initial.players.map((player) => [
        player.id,
        { kind: contributors.has(player.id) ? "contribute" : "withhold" },
      ]),
    );
    const result = PUBLIC_GOODS.applyActions({
      state: initial,
      actions,
      tick: 0,
      tickSeed: "payoffs:0",
    });
    expect(result.delta).toMatchObject({
      contributorCount: 3,
      pool: 60,
      sharePerPlayer: 10,
    });
    expect(result.delta.payoffs.map((entry) => entry.value)).toEqual([
      10, 10, 10, 20, 20, 20,
    ]);
    expect(
      PUBLIC_GOODS.metrics({ previousState: initial, state: result.state, tick: 0 }),
    ).toEqual({
      groupWelfare: 90,
      minScore: 10,
      maxScore: 20,
      contributionRate: 0.5,
      poolLastRound: 60,
      roundsPlayed: 1,
      invalidActions: 0,
    });
  });

  it("makes bounded contributor-count noise deterministic and observation-only", () => {
    const { result: first } = firstRound("same-seed", new Set(CLONES.map(() => "")));
    const { result: second } = firstRound("same-seed", new Set(CLONES.map(() => "")));
    expect(first).toEqual(second);
    expect(fullRun("full-seed")).toEqual(fullRun("full-seed"));
    expect(first.delta.contributorCount).toBe(0);
    expect(first.delta.readings.every((reading) => reading.perceivedContributorCount === 1)).toBe(
      true,
    );
    const observation = PUBLIC_GOODS.buildObservation({
      state: first.state,
      automatonId: first.state.players[0].id,
      senses: [{ senseId: "history" }],
      tick: 1,
    });
    expect(observation.history[0]).toMatchObject({
      contributorCount: 1,
      myAction: "withhold",
      myPayoff: 10,
    });
    expect(observation.history[0]).not.toHaveProperty("actualContributorCount");
  });

  it("exports a neutral legal fallback, bounded circle scene, and invalid-action metric", () => {
    const { initial, result } = firstRound("scene", new Set(["villager:1", "villager:2"]));
    expect(
      PUBLIC_GOODS.legalActions({
        state: initial,
        automatonId: initial.players[0].id,
        observation: PUBLIC_GOODS.buildObservation({
          state: initial,
          automatonId: initial.players[0].id,
          senses: [{ senseId: "history" }],
          tick: 0,
        }),
        tick: 0,
      }),
    ).toEqual([{ kind: "withhold" }, { kind: "contribute" }]);
    const invalidState = PUBLIC_GOODS.withInvalidActions({ state: result.state, count: 2 });
    expect(invalidState.players).toEqual(result.state.players);
    expect(
      PUBLIC_GOODS.metrics({
        previousState: result.state,
        state: invalidState,
        tick: 1,
      }).invalidActions,
    ).toBe(2);
    expect(
      PUBLIC_GOODS.withInvalidActionDelta({
        delta: result.delta,
        automatonIds: ["villager:3"],
      }).invalidAutomatonIds,
    ).toEqual(["villager:3"]);
    const scene = PUBLIC_GOODS.renderScene({ state: result.state, tick: 1 });
    const automataEntities = scene.entities.filter((entity) => entity.kind === "automaton");
    expect(automataEntities).toHaveLength(6);
    expect(scene.entities.filter((entity) => entity.kind === "pool")).toHaveLength(1);
    expect(scene.entities.filter((entity) => entity.kind.startsWith("token:"))).toHaveLength(6);
    expect(scene.cells).toEqual([
      { x: 10, y: 10, kind: "public-pool", intensity: 2 / 6 },
    ]);
    expectSceneWithinBounds(scene);
  });

  it("promotes the pool to a first-class entity that tracks the round pool, and faces villagers by their action", () => {
    const { initial } = firstRound("aliveness", new Set());
    const beforeAnyRound = PUBLIC_GOODS.renderScene({ state: initial, tick: 0 });
    const poolBefore = beforeAnyRound.entities.find((entity) => entity.kind === "pool");
    expect(poolBefore).toBeDefined();
    expect(poolBefore?.size).toBe(0.6); // empty pool: the floor size, no round yet.
    expect(beforeAnyRound.entities.filter((entity) => entity.kind.startsWith("token:"))).toHaveLength(0);

    const { result } = firstRound("aliveness", new Set(["villager:1", "villager:2", "villager:3"]));
    const afterRound = PUBLIC_GOODS.renderScene({ state: result.state, tick: 1 });
    const poolAfter = afterRound.entities.find((entity) => entity.kind === "pool");
    // Half the village contributed: pool tracks exactly the same normalized
    // intensity the retained `public-pool` cell already carries.
    const cell = afterRound.cells.find((candidate) => candidate.kind === "public-pool")!;
    expect(poolAfter?.size).toBeCloseTo(0.6 + cell.intensity * 1.4);

    const tokens = afterRound.entities.filter((entity) => entity.kind.startsWith("token:"));
    expect(tokens).toHaveLength(6);
    expect(tokens.map((token) => token.kind)).toEqual(
      result.delta.actions.map((entry) => `token:${entry.action}`),
    );

    const automata = afterRound.entities.filter((entity) => entity.kind === "automaton");
    for (const [index, entity] of automata.entries()) {
      const action = result.delta.actions.find((entry) => entry.automatonId === entity.id)!.action;
      const angle = (index / automata.length) * Math.PI * 2 - Math.PI / 2;
      const expectedHeading = action === "withhold" ? angle : angle + Math.PI;
      expect(entity.heading).toBeCloseTo(expectedHeading);
    }
    expectSceneWithinBounds(afterRound);
  });

  it("keeps the scene within byte bounds with pool, automata, and token entities at MAX_AUTOMATA_PER_RUN", () => {
    const maxConfig: PublicGoodsConfig = { ...CONFIG, maxAutomata: MAX_AUTOMATA_PER_RUN };
    const maxClones: readonly LaunchedSpecies[] = [
      { ...CLONES[0], count: MAX_AUTOMATA_PER_RUN, countMax: MAX_AUTOMATA_PER_RUN },
    ];
    const initial = PUBLIC_GOODS.initialState({
      config: maxConfig,
      species: maxClones,
      seed: "max-players",
    });
    const actions = new Map<string, PublicGoodsAction>(
      initial.players.map((player, index) => [
        player.id,
        { kind: index % 2 === 0 ? "contribute" : "withhold" },
      ]),
    );
    const result = PUBLIC_GOODS.applyActions({
      state: initial,
      actions,
      tick: 0,
      tickSeed: "max-players:0",
    });
    const scene = PUBLIC_GOODS.renderScene({ state: result.state, tick: 1 });
    expect(scene.entities.filter((entity) => entity.kind === "automaton")).toHaveLength(
      MAX_AUTOMATA_PER_RUN,
    );
    expect(scene.entities.filter((entity) => entity.kind.startsWith("token:"))).toHaveLength(
      MAX_AUTOMATA_PER_RUN,
    );
    expect(scene.entities.filter((entity) => entity.kind === "pool")).toHaveLength(1);
    expectSceneWithinBounds(scene);
  });

  it("rejects duplicate players and corrupted persisted round truth", () => {
    const { result } = firstRound("validate-state", new Set(["villager:1", "villager:2"]));
    expect(() => PUBLIC_GOODS.validateState(result.state)).not.toThrow();
    expect(() =>
      PUBLIC_GOODS.validateState({
        ...result.state,
        players: result.state.players.map((player, index) =>
          index === 1 ? { ...player, id: result.state.players[0].id } : player,
        ),
      }),
    ).toThrow(/repeats a player id/);
    expect(() =>
      PUBLIC_GOODS.validateState({
        ...result.state,
        rounds: [
          {
            ...result.state.rounds[0],
            actions: result.state.rounds[0].actions.slice(1),
          },
        ],
      }),
    ).toThrow(/exactly one action/);
    expect(() =>
      PUBLIC_GOODS.validateState({
        ...result.state,
        rounds: [{ ...result.state.rounds[0], pool: 999 }],
      }),
    ).toThrow(/pool totals/);
  });

  it("registers matching closed vocabularies", () => {
    expect(SIMULATOR_TEMPLATE_IDS).toContain("publicGoods");
    expect(SIMULATOR_TEMPLATES.publicGoods.id).toBe("publicGoods");
    expect(simulatorTemplateErrors(SIMULATOR_TEMPLATES.publicGoods)).toEqual([]);
  });

  it("renders pool rules and perceived history into the model prompt", async () => {
    const state = PUBLIC_GOODS.initialState({
      config: CONFIG,
      species: CLONES,
      seed: "prompt",
    });
    const observation = PUBLIC_GOODS.buildObservation({
      state,
      automatonId: state.players[0].id,
      senses: [{ senseId: "history" }],
      tick: 0,
    });
    const prompt = await buildAutomatonPrompt({
      template: SIMULATOR_TEMPLATES.publicGoods,
      spec: SPEC,
      deckCard: {
        slotId: "villager",
        count: 6,
        prompt: "Use one rule for every villager.",
      },
      observation,
      legalActions: [{ kind: "withhold" }, { kind: "contribute" }],
      tick: 0,
      phase: "round 1",
    });
    expect(prompt.dynamicSuffix).toContain("PUBLIC GOODS REFERENCE");
    expect(prompt.dynamicSuffix).toContain('"endowmentPerRound":10');
    expect(prompt.dynamicSuffix).toContain("including those who withheld");
    expect(prompt.cacheControlEligible).toBe(true);
  });
});
