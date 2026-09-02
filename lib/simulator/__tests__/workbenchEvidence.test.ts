import { describe, expect, it } from "vitest";

import type {
  EcosystemGridSimulatorSpec,
  LaunchedSpecies,
  MatrixGameSimulatorSpec,
  PrisonersDilemmaSimulatorSpec,
  PublicGoodsSimulatorSpec,
} from "../contract";
import {
  ECOSYSTEM_SENSE_CONFIRMATION_HORIZON_TICKS,
  frameAtTick,
  type StoredSimulatorRunChunk,
  type StoredTick,
} from "../scene";
import { ECOSYSTEM_GRID } from "../templates/ecosystemGrid";
import { MATRIX_GAME, type MatrixGameAction } from "../templates/matrixGame";
import {
  PRISONERS_DILEMMA,
  type PrisonersDilemmaAction,
} from "../templates/prisonersDilemma";
import { PUBLIC_GOODS, type PublicGoodsAction } from "../templates/publicGoods";
import {
  getWorkbenchRendererFamily,
  workbenchTimeNoun,
  WORKBENCH_RENDERER_FAMILY_BY_TEMPLATE,
} from "../templates/registry";

const MATCH_SPECIES: readonly LaunchedSpecies[] = [
  {
    slotId: "row",
    label: "Row strategy",
    count: 1,
    countMax: 1,
    senses: [{ senseId: "history" }],
    prompt: "Choose carefully.",
  },
  {
    slotId: "column",
    label: "Column strategy",
    count: 1,
    countMax: 1,
    senses: [{ senseId: "history" }],
    prompt: "Choose carefully.",
  },
];

const PRISONERS_DILEMMA_SPEC: PrisonersDilemmaSimulatorSpec = {
  version: 1,
  templateId: "prisonersDilemma",
  templateVersion: PRISONERS_DILEMMA.version,
  config: {
    rounds: 2,
    noiseProbability: 1,
    payoffMatrix: {
      mutualCooperation: 3,
      temptation: 5,
      sucker: 0,
      mutualDefection: 1,
    },
    maxAutomata: 2,
  },
  criterion: { kind: "adversarial", scoreMetricKeys: ["deckA.totalScore", "deckB.totalScore"] },
  speciesSlots: MATCH_SPECIES.map((species) => ({
    slotId: species.slotId,
    label: species.label,
    countMin: 1,
    countMax: 1,
    defaultCount: 1,
    senses: species.senses,
  })),
  tickBudget: { iterationTicks: 1, seasonTicks: 2, absoluteMaxTicks: 2 },
  interpreter: { kind: "scripted", interpreterId: "test" },
  microWorld: false,
};

const MATRIX_GAME_SPEC: MatrixGameSimulatorSpec = {
  version: 1,
  templateId: "matrixGame",
  templateVersion: MATRIX_GAME.version,
  config: {
    rounds: 2,
    noiseProbability: 1,
    actions: [
      { actionId: "optionA", label: "Hunt stag" },
      { actionId: "optionB", label: "Hunt hare" },
    ],
    payoffs: {
      optionA: {
        optionA: { a: 4, b: 4 },
        optionB: { a: -1, b: 3 },
      },
      optionB: {
        optionA: { a: 3, b: -1 },
        optionB: { a: 1, b: 1 },
      },
    },
    maxAutomata: 2,
  },
  criterion: { kind: "adversarial", scoreMetricKeys: ["deckA.totalScore", "deckB.totalScore"] },
  speciesSlots: MATCH_SPECIES.map((species) => ({
    slotId: species.slotId,
    label: species.label,
    countMin: 1,
    countMax: 1,
    defaultCount: 1,
    senses: species.senses,
  })),
  tickBudget: { iterationTicks: 1, seasonTicks: 2, absoluteMaxTicks: 2 },
  interpreter: { kind: "scripted", interpreterId: "test" },
  microWorld: false,
};

const COMMONS_SPECIES: readonly LaunchedSpecies[] = [
  {
    slotId: "villager",
    label: "Villager",
    count: 3,
    countMax: 3,
    senses: [{ senseId: "history" }],
    prompt: "Consider the group.",
  },
];

const PUBLIC_GOODS_SPEC: PublicGoodsSimulatorSpec = {
  version: 1,
  templateId: "publicGoods",
  templateVersion: PUBLIC_GOODS.version,
  config: {
    rounds: 2,
    endowmentPerRound: 5,
    multiplier: 2,
    noiseProbability: 1,
    maxAutomata: 3,
  },
  criterion: { kind: "measured", metricKey: "minScore", direction: "maximize" },
  speciesSlots: [{
    slotId: "villager",
    label: "Villager",
    countMin: 3,
    countMax: 3,
    defaultCount: 3,
    senses: [{ senseId: "history" }],
  }],
  tickBudget: { iterationTicks: 1, seasonTicks: 2, absoluteMaxTicks: 2 },
  interpreter: { kind: "scripted", interpreterId: "test" },
  microWorld: false,
};

function decisionTick(input: {
  tick: number;
  playerIds: readonly string[];
  slotIds: readonly string[];
  actions: readonly { kind: string }[];
  delta: object;
}): StoredTick {
  return {
    tick: input.tick,
    phase: `round ${input.tick + 1}`,
    automata: input.playerIds.map((automatonId, index) => ({
      automatonId,
      slotId: input.slotIds[index],
      observationJson: "{}",
      reasoning: "A bounded decision.",
      source: index === 0 ? "compiled" : "decision_cache",
      policyRuleId: index === 0 ? `rule-${input.tick + 1}` : undefined,
      policyTrace: index === 0 ? `trace ${input.tick + 1}` : undefined,
      acceptedActionJson: JSON.stringify(input.actions[index]),
      accepted: true,
    })),
    deltaJson: JSON.stringify(input.delta),
    metrics: [],
  };
}

function prisonersDilemmaChunk(): StoredSimulatorRunChunk {
  let state = PRISONERS_DILEMMA.initialState({
    config: PRISONERS_DILEMMA_SPEC.config,
    species: MATCH_SPECIES,
    seed: "pd-evidence",
  });
  const initialState = state;
  const ticks: StoredTick[] = [];
  const rounds: readonly [PrisonersDilemmaAction, PrisonersDilemmaAction][] = [
    [{ kind: "cooperate" }, { kind: "defect" }],
    [{ kind: "defect" }, { kind: "cooperate" }],
  ];
  for (const [tick, actions] of rounds.entries()) {
    const result = PRISONERS_DILEMMA.applyActions({
      state,
      actions: new Map(state.players.map((player, index) => [player.id, actions[index]])),
      tick,
      tickSeed: `pd-evidence:${tick}`,
    });
    ticks.push(decisionTick({
      tick,
      playerIds: state.players.map((player) => player.id),
      slotIds: state.players.map((player) => player.slotId),
      actions,
      delta: result.delta,
    }));
    state = result.state;
  }
  return {
    startTick: 0,
    endTick: 2,
    initialCheckpoint: {
      tick: 0,
      stateJson: JSON.stringify(initialState),
      sceneJson: JSON.stringify(PRISONERS_DILEMMA.renderScene({ state: initialState, tick: 0 })),
      stateHash: "pd-evidence",
    },
    ticks,
  };
}

function matrixGameChunk(): StoredSimulatorRunChunk {
  let state = MATRIX_GAME.initialState({
    config: MATRIX_GAME_SPEC.config,
    species: MATCH_SPECIES,
    seed: "matrix-evidence",
  });
  const initialState = state;
  const ticks: StoredTick[] = [];
  const rounds: readonly [MatrixGameAction, MatrixGameAction][] = [
    [{ kind: "optionA" }, { kind: "optionB" }],
    [{ kind: "optionB" }, { kind: "optionA" }],
  ];
  for (const [tick, actions] of rounds.entries()) {
    const result = MATRIX_GAME.applyActions({
      state,
      actions: new Map(state.players.map((player, index) => [player.id, actions[index]])),
      tick,
      tickSeed: `matrix-evidence:${tick}`,
    });
    ticks.push(decisionTick({
      tick,
      playerIds: state.players.map((player) => player.id),
      slotIds: state.players.map((player) => player.slotId),
      actions,
      delta: result.delta,
    }));
    state = result.state;
  }
  return {
    startTick: 0,
    endTick: 2,
    initialCheckpoint: {
      tick: 0,
      stateJson: JSON.stringify(initialState),
      sceneJson: JSON.stringify(MATRIX_GAME.renderScene({ state: initialState, tick: 0 })),
      stateHash: "matrix-evidence",
    },
    ticks,
  };
}

function publicGoodsChunk(): StoredSimulatorRunChunk {
  let state = PUBLIC_GOODS.initialState({
    config: PUBLIC_GOODS_SPEC.config,
    species: COMMONS_SPECIES,
    seed: "commons-evidence",
  });
  const initialState = state;
  const ticks: StoredTick[] = [];
  const rounds: readonly PublicGoodsAction[][] = [
    [{ kind: "contribute" }, { kind: "withhold" }, { kind: "contribute" }],
    [{ kind: "withhold" }, { kind: "withhold" }, { kind: "contribute" }],
  ];
  for (const [tick, actions] of rounds.entries()) {
    const result = PUBLIC_GOODS.applyActions({
      state,
      actions: new Map(state.players.map((player, index) => [player.id, actions[index]])),
      tick,
      tickSeed: `commons-evidence:${tick}`,
    });
    ticks.push(decisionTick({
      tick,
      playerIds: state.players.map((player) => player.id),
      slotIds: state.players.map((player) => player.slotId),
      actions,
      delta: result.delta,
    }));
    state = result.state;
  }
  return {
    startTick: 0,
    endTick: 2,
    initialCheckpoint: {
      tick: 0,
      stateJson: JSON.stringify(initialState),
      sceneJson: JSON.stringify(PUBLIC_GOODS.renderScene({ state: initialState, tick: 0 })),
      stateHash: "commons-evidence",
    },
    ticks,
  };
}

describe("Workbench renderer evidence", () => {
  it("owns an exhaustive template-to-renderer-family mapping and rejects unknown ids", () => {
    expect(WORKBENCH_RENDERER_FAMILY_BY_TEMPLATE).toEqual({
      ecosystemGrid: "field",
      prisonersDilemma: "match",
      matrixGame: "match",
      publicGoods: "commons",
    });
    expect(getWorkbenchRendererFamily("unknown-template")).toBeNull();
    expect(workbenchTimeNoun("ecosystemGrid")).toBe("day");
    expect(workbenchTimeNoun("matrixGame")).toBe("round");
  });

  it("projects every completed prisoner's dilemma round with totals, traces, and perception truth", () => {
    const chunk = prisonersDilemmaChunk();
    expect(frameAtTick([chunk], 0, PRISONERS_DILEMMA_SPEC).workbenchRoundEvidence).toEqual([]);

    const frame = frameAtTick([chunk], 2, PRISONERS_DILEMMA_SPEC);
    const ledger = frame.workbenchRoundEvidence;
    expect(ledger).toHaveLength(2);
    expect(ledger?.[0]).toMatchObject({
      kind: "match",
      round: 1,
      actors: [
        {},
        {
          id: "row:1",
          slotId: "row",
          label: "Row strategy",
          actionId: "defect",
          actionLabel: "Defect",
          roundPayoff: 5,
          cumulativeTotal: 5,
          decisionSource: "decision_cache",
          perception: {
            sawOpponentActionId: "defect",
            actualOpponentActionId: "cooperate",
            misperceived: true,
          },
        },
      ],
    });
    expect(ledger?.[1]).toMatchObject({
      round: 2,
      actors: [
        {
          id: "column:1",
          roundPayoff: 5,
          cumulativeTotal: 5,
          policyTrace: "trace 2",
        },
        {
          id: "row:1",
          roundPayoff: 0,
          cumulativeTotal: 5,
          decisionSource: "decision_cache",
        },
      ],
    });
    expect(ledger?.[0]?.actors[1].policyTrace).toBeUndefined();
    expect(frame.automata.find((automaton) => automaton.id === "row:1")?.senseAudit).toBe(
      "saw cooperate (actually defect)",
    );
  });

  it("keeps tournament-opponent strategy details redacted in round evidence", () => {
    const chunk = prisonersDilemmaChunk();
    const firstTick = chunk.ticks[0];
    const opponent = firstTick.automata[1];
    const redactedChunk = {
      ...chunk,
      ticks: [
        {
          ...firstTick,
          automata: [
            firstTick.automata[0],
            {
              ...opponent,
              detailsRedacted: true,
              source: undefined,
              policyRuleId: undefined,
              policyTrace: undefined,
            },
          ],
        },
        ...chunk.ticks.slice(1),
      ],
    };

    const actor = frameAtTick(
      [redactedChunk],
      1,
      PRISONERS_DILEMMA_SPEC,
    ).workbenchRoundEvidence?.[0]?.actors[1];

    expect(actor).toMatchObject({ detailsRedacted: true });
    expect(actor).not.toHaveProperty("decisionSource");
    expect(actor).not.toHaveProperty("policyRuleId");
    expect(actor).not.toHaveProperty("policyTrace");
  });

  it("uses authored matrix action labels while retaining the full match ledger", () => {
    const ledger = frameAtTick([matrixGameChunk()], 2, MATRIX_GAME_SPEC).workbenchRoundEvidence;
    expect(ledger).toHaveLength(2);
    expect(ledger?.[0]).toMatchObject({
      kind: "match",
      actors: [
        {},
        {
          actionId: "optionB",
          actionLabel: "Hunt hare",
          perception: {
            sawOpponentActionId: "optionB",
            sawOpponentActionLabel: "Hunt hare",
            actualOpponentActionLabel: "Hunt stag",
            misperceived: true,
          },
        },
      ],
    });
    expect(ledger?.[1]?.actors).toEqual(expect.arrayContaining([
      expect.objectContaining({ actionLabel: "Hunt hare", cumulativeTotal: 2 }),
      expect.objectContaining({ actionLabel: "Hunt stag", cumulativeTotal: 2 }),
    ]));
  });

  it("projects public-goods pool, contribution, payoff, and perception evidence for every round", () => {
    const ledger = frameAtTick([publicGoodsChunk()], 2, PUBLIC_GOODS_SPEC).workbenchRoundEvidence;
    expect(ledger).toHaveLength(2);
    expect(ledger?.[0]).toMatchObject({
      kind: "commons",
      round: 1,
      contributorCount: 2,
      pool: 20,
      sharePerPlayer: 20 / 3,
    });
    expect(ledger?.[0]?.actors[0]).toMatchObject({
      actionId: "contribute",
      actionLabel: "Contribute",
      roundPayoff: 20 / 3,
      cumulativeTotal: 20 / 3,
      perception: {
        actualContributorCount: 2,
        misperceived: true,
      },
    });
    expect(ledger?.[1]).toMatchObject({
      kind: "commons",
      round: 2,
      contributorCount: 1,
      pool: 10,
    });
    expect(ledger?.[1]?.actors[2]).toMatchObject({
      actionId: "contribute",
      roundPayoff: 10 / 3,
      cumulativeTotal: 10,
      perception: {
        actualContributorCount: 1,
        misperceived: true,
      },
    });
  });

  it("keeps field frames ledger-free and rejects malformed game evidence", () => {
    const ecosystemSpec: EcosystemGridSimulatorSpec = {
      version: 1,
      templateId: "ecosystemGrid",
      templateVersion: ECOSYSTEM_GRID.version,
      config: {
        width: 2,
        height: 2,
        boundary: "bounded",
        initialResourceDensity: 0,
        resourceRegrowthPerTick: 0,
        corpseDecayTicks: 1,
        baseMetabolicCost: 0,
        reproductionEnergyThreshold: 2,
        maxAutomata: 1,
        environmentalNoise: { enabled: false, amplitude: 0 },
      },
      criterion: { kind: "measured", metricKey: "longevity", direction: "maximize" },
      speciesSlots: [{
        slotId: "grazer",
        label: "Grazer",
        countMin: 1,
        countMax: 1,
        defaultCount: 1,
        senses: [{ senseId: "vision", range: 1, channels: ["automata"] }],
      }],
      tickBudget: { iterationTicks: 1, seasonTicks: 3, absoluteMaxTicks: 3 },
      interpreter: { kind: "scripted", interpreterId: "test" },
      microWorld: true,
    };
    const ecosystemState = ECOSYSTEM_GRID.initialState({
      config: ecosystemSpec.config,
      species: [{
        slotId: "grazer",
        label: "Grazer",
        count: 1,
        countMax: 1,
        senses: [{ senseId: "vision", range: 1, channels: ["automata"] }],
        prompt: "",
      }],
      seed: "field-evidence",
    });
    const fieldFrame = frameAtTick([{
      startTick: 0,
      endTick: 0,
      initialCheckpoint: {
        tick: 0,
        stateJson: JSON.stringify(ecosystemState),
        sceneJson: JSON.stringify(ECOSYSTEM_GRID.renderScene({ state: ecosystemState, tick: 0 })),
        stateHash: "field-evidence",
      },
      ticks: [],
    }], 0, ecosystemSpec);
    expect(fieldFrame).not.toHaveProperty("workbenchRoundEvidence");
    expect(fieldFrame).not.toHaveProperty("ecosystemSenseConfirmations");

    const actor = ecosystemState.automata[0];
    const discontinuousFrame = frameAtTick([{
      startTick: 0,
      endTick: 3,
      initialCheckpoint: {
        tick: 0,
        stateJson: JSON.stringify(ecosystemState),
        sceneJson: JSON.stringify(ECOSYSTEM_GRID.renderScene({ state: ecosystemState, tick: 0 })),
        stateHash: "field-evidence",
      },
      // A partial replay window must not pretend to know cells confirmed during
      // the skipped tick. Full history is loaded before the certainty field renders.
      ticks: [0, 2].map((tick) => decisionTick({
        tick,
        playerIds: [actor.id],
        slotIds: [actor.slotId],
        actions: [{ kind: "noop" }],
        delta: {},
      })),
    }], 3, ecosystemSpec, {
      ecosystemSenseEvidenceRequest: { actorId: actor.id, senseId: "vision" },
    });
    expect(discontinuousFrame.ecosystemSenseConfirmations).toEqual([]);

    let replayState = ecosystemState;
    let checkpointAtTwenty: StoredSimulatorRunChunk["checkpoint"];
    const longTicks: StoredTick[] = [];
    for (let tick = 0; tick < 30; tick += 1) {
      const actions = replayState.automata.map(() => ({ kind: "noop" as const }));
      const result = ECOSYSTEM_GRID.applyActions({
        state: replayState,
        actions: new Map(replayState.automata.map((automaton, index) => [
          automaton.id,
          actions[index],
        ])),
        tick,
        tickSeed: `bounded-confirmations:${tick}`,
      });
      longTicks.push(decisionTick({
        tick,
        playerIds: replayState.automata.map((automaton) => automaton.id),
        slotIds: replayState.automata.map((automaton) => automaton.slotId),
        actions,
        delta: {},
      }));
      replayState = result.state;
      if (tick === 19) {
        checkpointAtTwenty = {
          tick: 20,
          stateJson: JSON.stringify(replayState),
          sceneJson: JSON.stringify(ECOSYSTEM_GRID.renderScene({ state: replayState, tick: 20 })),
          stateHash: "bounded-confirmations:20",
        };
      }
    }
    const boundedFrame = frameAtTick([{
      startTick: 0,
      endTick: 30,
      initialCheckpoint: {
        tick: 0,
        stateJson: JSON.stringify(ecosystemState),
        sceneJson: JSON.stringify(ECOSYSTEM_GRID.renderScene({ state: ecosystemState, tick: 0 })),
        stateHash: "bounded-confirmations:0",
      },
      checkpoint: checkpointAtTwenty,
      // The bounded replay must use the nearby checkpoint; old history is not
      // needed to draw the five-tick fade horizon.
      ticks: longTicks.filter((tick) => tick.tick >= 20),
    }], 30, ecosystemSpec, {
      ecosystemSenseEvidenceRequest: { actorId: actor.id, senseId: "vision" },
    });
    expect(boundedFrame.ecosystemSenseConfirmations?.map((confirmation) => confirmation.tick)).toEqual(
      Array.from(
        { length: ECOSYSTEM_SENSE_CONFIRMATION_HORIZON_TICKS + 1 },
        (_, index) => 29 - ECOSYSTEM_SENSE_CONFIRMATION_HORIZON_TICKS + index,
      ),
    );

    const malformed = prisonersDilemmaChunk();
    const firstTick = malformed.ticks[0];
    expect(() => frameAtTick([{
      ...malformed,
      ticks: [{ ...firstTick, deltaJson: JSON.stringify({}) }, ...malformed.ticks.slice(1)],
    }], 1, PRISONERS_DILEMMA_SPEC)).toThrow(/prisonersDilemma: delta/);
  });
});
