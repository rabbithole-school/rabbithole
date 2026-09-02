import { describe, expect, it } from "vitest";

import type {
  WorkbenchCommonsRoundEvidence,
  WorkbenchMatchRoundEvidence,
} from "../scene";
import { commonsPotModel, matchVisualModel } from "../workbenchVisuals";

function actor(input: {
  id: string;
  label: string;
  actionId: "cooperate" | "defect";
  saw: "cooperate" | "defect";
  actual: "cooperate" | "defect";
  total: number;
  rule?: string;
  fallback?: boolean;
  detailsRedacted?: boolean;
}) {
  const label = (value: "cooperate" | "defect") =>
    value === "cooperate" ? "Cooperate" : "Defect";
  return {
    id: input.id,
    label: input.label,
    actionId: input.actionId,
    actionLabel: label(input.actionId),
    roundPayoff: 1,
    cumulativeTotal: input.total,
    decisionSource: input.fallback ? "compiled-fallback" as const : "compiled" as const,
    detailsRedacted: input.detailsRedacted,
    policyRuleId: input.rule,
    perception: {
      sawOpponentActionId: input.saw,
      sawOpponentActionLabel: label(input.saw),
      actualOpponentActionId: input.actual,
      actualOpponentActionLabel: label(input.actual),
      misperceived: input.saw !== input.actual,
    },
  };
}

const evidence: readonly WorkbenchMatchRoundEvidence[] = [
  {
    kind: "match",
    round: 1,
    actors: [
      actor({ id: "a", label: "You", actionId: "cooperate", saw: "defect", actual: "cooperate", total: 3, rule: "open" }),
      actor({ id: "b", label: "Copy", actionId: "cooperate", saw: "cooperate", actual: "cooperate", total: 3, rule: "open" }),
    ],
  },
  {
    kind: "match",
    round: 2,
    actors: [
      actor({ id: "a", label: "You", actionId: "defect", saw: "cooperate", actual: "cooperate", total: 8, rule: "answer" }),
      actor({ id: "b", label: "Copy", actionId: "cooperate", saw: "defect", actual: "defect", total: 3, rule: "reward" }),
    ],
  },
  {
    kind: "match",
    round: 3,
    actors: [
      actor({ id: "a", label: "You", actionId: "cooperate", saw: "cooperate", actual: "defect", total: 8, fallback: true }),
      actor({ id: "b", label: "Copy", actionId: "defect", saw: "cooperate", actual: "cooperate", total: 8, rule: "answer" }),
    ],
  },
];

describe("Workbench match visual model", () => {
  it("keeps post-round perception attached to the following decision", () => {
    const model = matchVisualModel(evidence);
    expect(model.actions).toEqual([
      { id: "cooperate", label: "Cooperate" },
      { id: "defect", label: "Defect" },
    ]);
    expect(model.actors[0].responseCounts).toContainEqual({
      sawActionId: "defect",
      nextActionId: "defect",
      count: 1,
    });

    expect(model.actors[0].responseCounts).toContainEqual({
      sawActionId: "cooperate",
      nextActionId: "cooperate",
      count: 1,
    });
  });

  describe("Workbench commons pot model", () => {
    it("keeps every bucket conserved through the multiplied pool and equal split", () => {
      const round: WorkbenchCommonsRoundEvidence = {
        kind: "commons",
        round: 3,
        contributorCount: 2,
        pool: 16,
        sharePerPlayer: 4,
        actors: [
          {
            id: "a",
            label: "A",
            actionId: "contribute",
            actionLabel: "Contribute",
            roundPayoff: 4,
            cumulativeTotal: 12,
            perception: { perceivedContributorCount: 3, actualContributorCount: 2, misperceived: true },
          },
          {
            id: "b",
            label: "B",
            actionId: "withhold",
            actionLabel: "Withhold",
            roundPayoff: 8,
            cumulativeTotal: 14,
            perception: { perceivedContributorCount: 2, actualContributorCount: 2, misperceived: false },
          },
          {
            id: "c",
            label: "C",
            actionId: "contribute",
            actionLabel: "Contribute",
            roundPayoff: 4,
            cumulativeTotal: 10,
            perception: { perceivedContributorCount: 2, actualContributorCount: 2, misperceived: false },
          },
          {
            id: "d",
            label: "D",
            actionId: "withhold",
            actionLabel: "Withhold",
            roundPayoff: 8,
            cumulativeTotal: 15,
            perception: { perceivedContributorCount: 1, actualContributorCount: 2, misperceived: true },
          },
        ],
      };

      const model = commonsPotModel({ round, endowment: 4, multiplier: 2 });
      expect(model).toMatchObject({
        inputPool: 8,
        multiplier: 2,
        grownPool: 16,
        sharePerPlayer: 4,
      });
      expect(model.actors).toEqual(expect.arrayContaining([
        expect.objectContaining({
          id: "a",
          contributed: 4,
          kept: 0,
          share: 4,
          misperceived: true,
        }),
        expect.objectContaining({
          id: "b",
          contributed: 0,
          kept: 4,
          share: 4,
          misperceived: false,
        }),
      ]));
      expect(model.inputPool * model.multiplier).toBe(model.grownPool);
      expect(model.sharePerPlayer * model.players).toBe(model.grownPool);
      expect(new Set(model.actors.map((actor) => actor.share))).toEqual(new Set([4]));
    });

    it.each([0, 2, 4])(
      "balances the pot with %i contributors without inventing unequal payouts",
      (contributorCount) => {
        const endowment = 4;
        const multiplier = 2;
        const players = 4;
        const pool = contributorCount * endowment * multiplier;
        const sharePerPlayer = pool / players;
        const round: WorkbenchCommonsRoundEvidence = {
          kind: "commons",
          round: 1,
          contributorCount,
          pool,
          sharePerPlayer,
          actors: Array.from({ length: players }, (_, index) => {
            const contributed = index < contributorCount;
            return {
              id: `actor:${index}`,
              label: `Actor ${index}`,
              actionId: contributed ? "contribute" : "withhold",
              actionLabel: contributed ? "Contribute" : "Withhold",
              roundPayoff: (contributed ? 0 : endowment) + sharePerPlayer,
              cumulativeTotal: 0,
              perception: {
                perceivedContributorCount: contributorCount,
                actualContributorCount: contributorCount,
                misperceived: false,
              },
            };
          }),
        };

        const model = commonsPotModel({ round, endowment, multiplier });
        expect(model.inputPool * model.multiplier).toBe(model.grownPool);
        expect(model.sharePerPlayer * model.players).toBe(model.grownPool);
        expect(new Set(model.actors.map((actor) => actor.share))).toEqual(
          new Set([sharePerPlayer]),
        );
      },
    );
  });

  it("projects perception fractures, totals, rule activations, and fallbacks", () => {
    const actorModel = matchVisualModel(evidence).actors[0];
    expect(actorModel.actions.map((round) => round.misperceived)).toEqual([true, false, true]);
    expect(actorModel.actions.map((round) => round.cumulativeTotal)).toEqual([3, 8, 8]);
    expect(actorModel.ruleBands).toEqual([
      { id: "rule:open", label: "open", kind: "rule", rounds: [1] },
      { id: "rule:answer", label: "answer", kind: "rule", rounds: [2] },
      {
        id: "compiled-fallback",
        label: "No compiled match",
        kind: "fallback",
        rounds: [3],
      },
    ]);
  });

  it("preserves whether rule details are private", () => {
    const redactedEvidence: readonly WorkbenchMatchRoundEvidence[] = [{
      kind: "match",
      round: 1,
      actors: [
        actor({
          id: "private",
          label: "Opponent",
          actionId: "cooperate",
          saw: "cooperate",
          actual: "cooperate",
          total: 3,
          detailsRedacted: true,
        }),
      ],
    }];

    expect(matchVisualModel(redactedEvidence).actors[0]).toMatchObject({
      id: "private",
      detailsRedacted: true,
      ruleBands: [],
    });
  });
});
