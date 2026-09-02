import { describe, expect, it } from "vitest";

import { mergeSelectedRoundFrame, type SceneFrame } from "@/lib/simulator/scene";

describe("mergeSelectedRoundFrame", () => {
  it("keeps selected-round automata while retaining the complete ledger", () => {
    const selectedEvidence: NonNullable<SceneFrame["workbenchRoundEvidence"]> = [];
    const completeEvidence: NonNullable<SceneFrame["workbenchRoundEvidence"]> = [];
    const selected: SceneFrame = {
      tick: 3,
      automata: [
        {
          id: "actor",
          speciesLabel: "Trader",
          x: 3,
          y: 0,
          alive: true,
          lastAction: "cooperate",
        },
      ],
      terminalAutomata: [],
      terrain: [],
      metrics: {},
      scene: {
        protocolVersion: 1,
        templateId: "prisonersDilemma",
        tick: 3,
        viewport: { width: 1, height: 1, boundary: "bounded" },
        entities: [],
        cells: [],
      },
      workbenchRoundEvidence: selectedEvidence,
    };
    const complete: SceneFrame = {
      ...selected,
      tick: 20,
      automata: [{ ...selected.automata[0], x: 20 }],
      scene: { ...selected.scene, tick: 20 },
      workbenchRoundEvidence: completeEvidence,
    };

    const merged = mergeSelectedRoundFrame(selected, complete);

    expect(merged.tick).toBe(3);
    expect(merged.automata).toEqual(selected.automata);
    expect(merged.workbenchRoundEvidence).toBe(completeEvidence);
  });
});
