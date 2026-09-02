import { describe, expect, it } from "vitest";

import {
  MAX_SCENE_JSON_BYTES,
  type LaunchedSpecies,
  type PrisonersDilemmaConfig,
  type SimulatorSpec,
} from "../contract";
import {
  DEFAULT_PRISONERS_DILEMMA_ROUNDS,
  PRISONERS_DILEMMA,
  type PrisonersDilemmaAction,
} from "../templates/prisonersDilemma";
import { SIMULATOR_TEMPLATE_IDS, SIMULATOR_TEMPLATES, simulatorTemplateErrors } from "../templates/registry";

const CONFIG: PrisonersDilemmaConfig = {
  rounds: 3,
  noiseProbability: 1,
  payoffMatrix: {
    mutualCooperation: 3,
    temptation: 5,
    sucker: 0,
    mutualDefection: 1,
  },
  maxAutomata: 2,
};

const SPECIES: readonly LaunchedSpecies[] = [
  {
    slotId: "deck_a",
    label: "Deck A",
    count: 1,
    countMax: 1,
    senses: [{ senseId: "history" }],
    prompt: "Cooperate, including after one apparent defection.",
  },
  {
    slotId: "deck_b",
    label: "Deck B",
    count: 1,
    countMax: 1,
    senses: [{ senseId: "history" }],
    prompt: "Cooperate every round.",
  },
];

const SPEC: SimulatorSpec = {
  version: 1,
  templateId: "prisonersDilemma",
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

describe("prisonersDilemma physics", () => {
  it("defaults to 50 rounds and produces identical truth from the same seed", () => {
    const withoutRounds = { ...CONFIG, rounds: undefined };
    const first = PRISONERS_DILEMMA.initialState({
      config: withoutRounds,
      species: SPECIES,
      seed: "same-seed",
    });
    const second = PRISONERS_DILEMMA.initialState({
      config: withoutRounds,
      species: SPECIES,
      seed: "same-seed",
    });
    expect(first).toEqual(second);
    expect(first.config.rounds).toBe(DEFAULT_PRISONERS_DILEMMA_ROUNDS);

    const actions = new Map<string, PrisonersDilemmaAction>(
      first.players.map((player) => [player.id, { kind: "cooperate" }]),
    );
    expect(
      PRISONERS_DILEMMA.applyActions({
        state: first,
        actions,
        tick: 0,
        tickSeed: "same-seed:0",
      }),
    ).toEqual(
      PRISONERS_DILEMMA.applyActions({
        state: second,
        actions,
        tick: 0,
        tickSeed: "same-seed:0",
      }),
    );
  });

  it("applies noise only to perception while preserving actual and perceived moves", () => {
    PRISONERS_DILEMMA.validateSpec(SPEC);
    const initial = PRISONERS_DILEMMA.initialState({
      config: CONFIG,
      species: SPECIES,
      seed: "noise-truth",
    });
    const cooperate = new Map<string, PrisonersDilemmaAction>(
      initial.players.map((player) => [player.id, { kind: "cooperate" }]),
    );
    const first = PRISONERS_DILEMMA.applyActions({
      state: initial,
      actions: cooperate,
      tick: 0,
      tickSeed: "noise-truth:0",
    });

    expect(first.delta.moves.map((entry) => entry.move)).toEqual(["cooperate", "cooperate"]);
    expect(first.delta.readings).toEqual(
      initial.players.map((player) => ({
        automatonId: player.id,
        sawOpponentMove: "defect",
        actualOpponentMove: "cooperate",
        misperceived: true,
      })),
    );

    const observation = PRISONERS_DILEMMA.buildObservation({
      state: first.state,
      automatonId: initial.players[0].id,
      senses: [{ senseId: "history" }],
      tick: 1,
    });
    expect(observation.history[0]).toMatchObject({
      myMove: "cooperate",
      opponentMove: "defect",
    });
    expect(observation.history[0]).not.toHaveProperty("actualOpponentMove");

    const second = PRISONERS_DILEMMA.applyActions({
      state: first.state,
      actions: cooperate,
      tick: 1,
      tickSeed: "noise-truth:1",
    });
    expect(second.delta.forgivenessAutomatonIds).toEqual(
      initial.players.map((player) => player.id),
    );
    expect(
      PRISONERS_DILEMMA.metrics({
        previousState: first.state,
        state: second.state,
        tick: 1,
      }),
    ).toMatchObject({
      "deckA.totalScore": 6,
      "deckB.totalScore": 6,
      "deckA.cooperationRate": 1,
      "deckB.cooperationRate": 1,
      "deckA.forgivenessEvents": 1,
      "deckB.forgivenessEvents": 1,
    });
  });

  it("registers the template with matching closed vocabularies", () => {
    expect(SIMULATOR_TEMPLATE_IDS).toContain("prisonersDilemma");
    expect(SIMULATOR_TEMPLATES.prisonersDilemma.id).toBe("prisonersDilemma");
    expect(simulatorTemplateErrors(SIMULATOR_TEMPLATES.prisonersDilemma)).toEqual([]);
  });

  it("shows the opponent-facing heading structurally and a per-round move token additively", () => {
    const initial = PRISONERS_DILEMMA.initialState({
      config: CONFIG,
      species: SPECIES,
      seed: "scene",
    });

    const beforeAnyRound = PRISONERS_DILEMMA.renderScene({ state: initial, tick: 0 });
    const automataBefore = beforeAnyRound.entities.filter((entity) => entity.kind === "automaton");
    expect(automataBefore).toHaveLength(2);
    // Automata face each other from the first render, before any round has
    // resolved -- heading is structural, not action-dependent.
    expect(automataBefore.map((entity) => entity.heading)).toEqual([0, Math.PI]);
    // No token entity exists until a round has actually resolved.
    expect(beforeAnyRound.entities.filter((entity) => entity.kind.startsWith("token:"))).toHaveLength(0);

    const cooperate = new Map<string, PrisonersDilemmaAction>(
      initial.players.map((player) => [player.id, { kind: "cooperate" }]),
    );
    const first = PRISONERS_DILEMMA.applyActions({
      state: initial,
      actions: cooperate,
      tick: 0,
      tickSeed: "scene:0",
    });
    const afterRound = PRISONERS_DILEMMA.renderScene({ state: first.state, tick: 1 });
    const automataAfter = afterRound.entities.filter((entity) => entity.kind === "automaton");
    expect(automataAfter.map((entity) => entity.heading)).toEqual([0, Math.PI]);
    const tokens = afterRound.entities.filter((entity) => entity.kind.startsWith("token:"));
    expect(tokens).toHaveLength(2);
    // The recorded moves are the noise-affected perception's ACTUAL truth
    // (`first.delta.moves`), so the token always matches physics, never what
    // an Automaton merely believed it saw.
    expect(tokens.map((token) => token.kind)).toEqual(
      first.delta.moves.map((entry) => `token:${entry.move}`),
    );
    for (const entity of [...automataAfter, ...tokens]) {
      expect(entity.x).toBeGreaterThanOrEqual(0);
      expect(entity.x).toBeLessThan(afterRound.viewport.width);
      expect(entity.y).toBeGreaterThanOrEqual(0);
      expect(entity.y).toBeLessThan(afterRound.viewport.height);
    }
    expect(new TextEncoder().encode(JSON.stringify(afterRound)).length).toBeLessThanOrEqual(
      MAX_SCENE_JSON_BYTES,
    );
  });
});
