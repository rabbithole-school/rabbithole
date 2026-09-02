import { describe, expect, it } from "vitest";

import {
  MAX_SCENE_JSON_BYTES,
  type LaunchedSpecies,
  type MatrixGameConfig,
  type MatrixGameSimulatorSpec,
} from "../contract";
import { buildAutomatonPrompt } from "../prompt";
import {
  MATRIX_GAME,
  type MatrixGameAction,
} from "../templates/matrixGame";
import {
  SIMULATOR_TEMPLATE_IDS,
  SIMULATOR_TEMPLATES,
  simulatorTemplateErrors,
} from "../templates/registry";

const CONFIG: MatrixGameConfig = {
  rounds: 3,
  noiseProbability: 1,
  actions: [
    { actionId: "optionA", label: "Hunt stag" },
    { actionId: "optionB", label: "Hunt hare" },
  ],
  payoffs: {
    optionA: {
      optionA: { a: 4, b: 5 },
      optionB: { a: -2, b: 3 },
    },
    optionB: {
      optionA: { a: 2, b: -1 },
      optionB: { a: 1, b: 1.5 },
    },
  },
  maxAutomata: 2,
};

const SPECIES: readonly LaunchedSpecies[] = [
  {
    slotId: "row",
    label: "Row strategy",
    count: 1,
    countMax: 1,
    senses: [{ senseId: "history" }],
    prompt: "Hunt stag.",
  },
  {
    slotId: "column",
    label: "Column strategy",
    count: 1,
    countMax: 1,
    senses: [{ senseId: "history" }],
    prompt: "Hunt hare.",
  },
];

const SPEC: MatrixGameSimulatorSpec = {
  version: 1,
  templateId: "matrixGame",
  templateVersion: 1,
  config: CONFIG,
  criterion: {
    kind: "adversarial",
    scoreMetricKeys: ["deckA.totalScore", "deckB.totalScore"],
  },
  speciesSlots: SPECIES.map((species) => ({
    slotId: species.slotId,
    label: species.label,
    countMin: 1,
    countMax: 1,
    defaultCount: 1,
    senses: species.senses,
  })),
  tickBudget: { iterationTicks: 1, seasonTicks: 3, absoluteMaxTicks: 3 },
  interpreter: { kind: "llm", role: "AUTOMATON" },
  microWorld: false,
};

function play(
  seed: string,
  first: MatrixGameAction = { kind: "optionA" },
  second: MatrixGameAction = { kind: "optionB" },
) {
  const initial = MATRIX_GAME.initialState({ config: CONFIG, species: SPECIES, seed });
  const actions = new Map<string, MatrixGameAction>([
    [initial.players[0].id, first],
    [initial.players[1].id, second],
  ]);
  return MATRIX_GAME.applyActions({
    state: initial,
    actions,
    tick: 0,
    tickSeed: `${seed}:0`,
  });
}

function fullRun(seed: string) {
  let state = MATRIX_GAME.initialState({ config: CONFIG, species: SPECIES, seed });
  const deltas = [];
  for (let tick = 0; tick < CONFIG.rounds; tick += 1) {
    const result = MATRIX_GAME.applyActions({
      state,
      actions: new Map([
        [state.players[0].id, { kind: tick % 2 === 0 ? "optionA" : "optionB" }],
        [state.players[1].id, { kind: "optionB" }],
      ]),
      tick,
      tickSeed: `${seed}:${tick}`,
    });
    state = result.state;
    deltas.push(result.delta);
  }
  return { state, deltas };
}

function expectSceneWithinBounds(scene: ReturnType<typeof MATRIX_GAME.renderScene>) {
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

describe("matrixGame physics", () => {
  it("normalizes a full matrix and validates adversarial and joint-score criteria", () => {
    expect(MATRIX_GAME.validateConfig(CONFIG)).toEqual(CONFIG);
    expect(() => MATRIX_GAME.validateSpec(SPEC)).not.toThrow();
    expect(() =>
      MATRIX_GAME.validateSpec({
        ...SPEC,
        criterion: { kind: "measured", metricKey: "jointScore", direction: "maximize" },
      }),
    ).not.toThrow();

    expect(() =>
      MATRIX_GAME.validateConfig({ ...CONFIG, rounds: 501 }),
    ).toThrow(/rounds/);
    expect(() =>
      MATRIX_GAME.validateConfig({
        ...CONFIG,
        actions: [
          { actionId: "optionA", label: "One" },
          { actionId: "optionA", label: "Again" },
        ],
      }),
    ).toThrow(/exactly once/);
    expect(() =>
      MATRIX_GAME.validateConfig({
        ...CONFIG,
        payoffs: {
          ...CONFIG.payoffs,
          optionA: {
            ...CONFIG.payoffs.optionA,
            optionB: { a: 1_001, b: 0 },
          },
        },
      }),
    ).toThrow(/-1000 and 1000/);
    expect(() =>
      MATRIX_GAME.validateSpec({
        ...SPEC,
        criterion: { kind: "measured", metricKey: "roundsPlayed", direction: "maximize" },
      }),
    ).toThrow(/jointScore/);
  });

  it("uses the authored asymmetric cell without transposing the column payoff", () => {
    const result = play("asymmetric");
    expect(result.delta.actions.map((entry) => entry.actionId)).toEqual([
      "optionA",
      "optionB",
    ]);
    expect(result.delta.payoffs.map((entry) => entry.value)).toEqual([-2, 3]);
    expect(result.state.players.map((player) => player.totalScore)).toEqual([-2, 3]);
    expect(
      MATRIX_GAME.metrics({
        previousState: MATRIX_GAME.initialState({
          config: CONFIG,
          species: SPECIES,
          seed: "asymmetric",
        }),
        state: result.state,
        tick: 0,
      }),
    ).toEqual({
      "deckA.totalScore": -2,
      "deckB.totalScore": 3,
      jointScore: 1,
      "deckA.optionARate": 1,
      "deckB.optionARate": 0,
      roundsPlayed: 1,
    });
  });

  it("makes noisy labeled history deterministic without exposing hidden truth", () => {
    const first = play("same-seed");
    const second = play("same-seed");
    expect(first).toEqual(second);
    expect(fullRun("full-seed")).toEqual(fullRun("full-seed"));
    expect(first.delta.readings).toEqual([
      {
        automatonId: "column:1",
        sawOpponentAction: "optionA",
        actualOpponentAction: "optionB",
        misperceived: true,
      },
      {
        automatonId: "row:1",
        sawOpponentAction: "optionB",
        actualOpponentAction: "optionA",
        misperceived: true,
      },
    ]);
    const observation = MATRIX_GAME.buildObservation({
      state: first.state,
      automatonId: first.state.players[0].id,
      senses: [{ senseId: "history" }],
      tick: 1,
    });
    expect(observation.actions).toEqual(CONFIG.actions);
    expect(observation.history[0]).toMatchObject({
      myActionLabel: "Hunt stag",
      opponentAction: "optionA",
      opponentActionLabel: "Hunt stag",
    });
    expect(observation.history[0]).not.toHaveProperty("actualOpponentAction");
  });

  it("exports a closed legal menu, bounded scene, and neutral invalid-action telemetry", () => {
    const result = play("scene");
    expect(
      MATRIX_GAME.legalActions({
        state: result.state,
        automatonId: result.state.players[0].id,
        observation: MATRIX_GAME.buildObservation({
          state: result.state,
          automatonId: result.state.players[0].id,
          senses: [{ senseId: "history" }],
          tick: 1,
        }),
        tick: 1,
      }),
    ).toEqual([{ kind: "optionA" }, { kind: "optionB" }]);
    const unchangedScores = result.state.players.map((player) => player.totalScore);
    const invalidState = MATRIX_GAME.withInvalidActions({ state: result.state, count: 2 });
    expect(invalidState.players.map((player) => player.totalScore)).toEqual(unchangedScores);
    expect(invalidState.totalInvalidActions).toBe(2);
    expect(
      MATRIX_GAME.withInvalidActionDelta({
        delta: result.delta,
        automatonIds: ["row:1"],
      }).invalidAutomatonIds,
    ).toEqual(["row:1"]);
    const scene = MATRIX_GAME.renderScene({ state: result.state, tick: 1 });
    expect(scene).toMatchObject({
      protocolVersion: 1,
      templateId: "matrixGame",
    });
    const automata = scene.entities.filter((entity) => entity.kind === "automaton");
    expect(automata).toHaveLength(2);
    expect(automata.map((entity) => entity.label)).toEqual(["Column strategy", "Row strategy"]);
    expect(new Set(automata.map((entity) => `${entity.x}:${entity.y}`)).size).toBe(
      automata.length,
    );
    expectSceneWithinBounds(scene);
  });

  it("keeps species labels stable while facing the Automata and adding per-round action tokens", () => {
    const withoutRound = MATRIX_GAME.initialState({ config: CONFIG, species: SPECIES, seed: "aliveness" });
    const beforeAnyRound = MATRIX_GAME.renderScene({ state: withoutRound, tick: 0 });
    const automataBefore = beforeAnyRound.entities.filter((entity) => entity.kind === "automaton");
    expect(automataBefore).toHaveLength(2);
    // Automata face each other from the first render, before any round has
    // resolved -- heading is structural, not action-dependent.
    expect(automataBefore.map((entity) => entity.heading)).toEqual([0, Math.PI]);
    // No token entity exists until a round has actually resolved.
    expect(beforeAnyRound.entities.filter((entity) => entity.kind.startsWith("token:"))).toHaveLength(0);

    const result = play("aliveness", { kind: "optionA" }, { kind: "optionB" });
    const afterRound = MATRIX_GAME.renderScene({ state: result.state, tick: 1 });
    const automataAfter = afterRound.entities.filter((entity) => entity.kind === "automaton");
    expect(automataAfter.map((entity) => entity.heading)).toEqual([0, Math.PI]);
    expect(automataAfter.map((entity) => entity.label)).toEqual(
      automataBefore.map((entity) => entity.label),
    );
    const tokens = afterRound.entities.filter((entity) => entity.kind.startsWith("token:"));
    expect(tokens).toHaveLength(2);
    expect(tokens.map((token) => token.kind)).toEqual(
      result.delta.actions.map((entry) => `token:${entry.actionId}`),
    );
    // matrixGame token labels are the AUTHORED action label, never the bare
    // actionId -- the same distinction the observation/prompt already make.
    expect(tokens.map((token) => token.label)).toEqual(
      result.delta.actions.map((entry) => (entry.actionId === "optionA" ? "Hunt stag" : "Hunt hare")),
    );
    expectSceneWithinBounds(afterRound);
  });

  it("rejects duplicate player ids when persisted state is revalidated", () => {
    const { state } = play("duplicate-state");
    expect(() =>
      MATRIX_GAME.validateState({
        ...state,
        players: [
          state.players[0],
          { ...state.players[1], id: state.players[0].id },
        ],
      }),
    ).toThrow(/repeats a player id/);
  });

  it("registers matching closed vocabularies", () => {
    expect(SIMULATOR_TEMPLATE_IDS).toContain("matrixGame");
    expect(SIMULATOR_TEMPLATES.matrixGame.id).toBe("matrixGame");
    expect(simulatorTemplateErrors(SIMULATOR_TEMPLATES.matrixGame)).toEqual([]);
  });

  it("renders authored action labels and matrix payoffs into the model prompt", async () => {
    const state = MATRIX_GAME.initialState({
      config: CONFIG,
      species: SPECIES,
      seed: "prompt",
    });
    const observation = MATRIX_GAME.buildObservation({
      state,
      automatonId: state.players[0].id,
      senses: [{ senseId: "history" }],
      tick: 0,
    });
    const prompt = await buildAutomatonPrompt({
      template: SIMULATOR_TEMPLATES.matrixGame,
      spec: SPEC,
      deckCard: { slotId: state.players[0].slotId, count: 1, prompt: "Hunt stag." },
      observation,
      legalActions: [{ kind: "optionA" }, { kind: "optionB" }],
      tick: 0,
      phase: "round 1",
    });
    expect(prompt.dynamicSuffix).toContain("MATRIX GAME REFERENCE");
    expect(prompt.dynamicSuffix).toContain("Hunt stag");
    expect(prompt.dynamicSuffix).toContain('"a":-2');
    expect(prompt.cacheControlEligible).toBe(true);
  });
});
