import { describe, expect, it } from "vitest";

import type {
  MatrixGameSimulatorSpec,
  PrisonersDilemmaSimulatorSpec,
} from "@/lib/simulator/contract";
import { matchPayoffMatrix } from "../evidence";

const base = {
  version: 1 as const,
  templateVersion: 1,
  speciesSlots: [],
  tickBudget: { iterationTicks: 2, seasonTicks: 4, absoluteMaxTicks: 4 },
  interpreter: { kind: "scripted" as const, interpreterId: "test" },
  microWorld: false,
};

const matrixSpec: MatrixGameSimulatorSpec = {
  ...base,
  templateId: "matrixGame",
  config: {
    rounds: 4,
    noiseProbability: 0,
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
};

const prisonersSpec: PrisonersDilemmaSimulatorSpec = {
  ...base,
  templateId: "prisonersDilemma",
  config: {
    rounds: 4,
    noiseProbability: 0,
    payoffMatrix: {
      mutualCooperation: 3,
      temptation: 5,
      sucker: 0,
      mutualDefection: 1,
    },
    maxAutomata: 2,
  },
  criterion: { kind: "adversarial", scoreMetricKeys: ["deckA.totalScore", "deckB.totalScore"] },
};

describe("Workbench evidence formatting", () => {
  it("preserves authored matrix action labels and payoff orientation", () => {
    const matrix = matchPayoffMatrix(matrixSpec);
    expect(matrix.columnActions.map((action) => action.label)).toEqual(["Hunt stag", "Hunt hare"]);
    expect(matrix.cells).toContainEqual({
      rowActionId: "optionA",
      columnActionId: "optionB",
      rowPayoff: -1,
      columnPayoff: 3,
    });
    expect(matchPayoffMatrix(prisonersSpec).cells).toContainEqual({
      rowActionId: "defect",
      columnActionId: "cooperate",
      rowPayoff: 5,
      columnPayoff: 0,
    });
  });
});
