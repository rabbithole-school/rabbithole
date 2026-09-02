import { describe, expect, it, vi } from "vitest";

vi.mock("convex/react", () => ({ useQuery: vi.fn() }));
vi.mock("@/lib/convex", () => ({ api: { simulatorRuns: { chunks: "chunks" } } }));

import type { SimulatorSpec } from "../../../../vendor/simulator/contract";
import { workbenchSceneFetchPlan } from "../useWorkbenchScene";
import {
  disambiguatedActorLabels,
  formatDecisionSource,
  isSelectedMatchPayoffCell,
  workbenchActorNoun,
  workbenchDeckNoun,
  workbenchTimeNoun,
} from "../workbenchTerminology";

const field = { templateId: "ecosystemGrid" } as SimulatorSpec;
const match = { templateId: "matrixGame" } as SimulatorSpec;
const commons = { templateId: "publicGoods" } as SimulatorSpec;

describe("Workbench renderer terminology and evidence fetches", () => {
  it("keeps field language separate from match and commons language", () => {
    expect(workbenchTimeNoun(field)).toBe("day");
    expect(workbenchActorNoun(field)).toBe("species");
    expect(workbenchDeckNoun(field)).toBe("prompt deck");
    expect(workbenchTimeNoun(match)).toBe("round");
    expect(workbenchActorNoun(commons)).toBe("player");
    expect(workbenchDeckNoun(match)).toBe("strategy rules");
  });

  it("fetches complete round evidence while a match follows the live head", () => {
    expect(workbenchSceneFetchPlan(match, 32, false)).toEqual({
      active: true,
      bootstrapLimit: 40,
      fullPageOffsets: [0],
      aroundStart: null,
    });
    expect(workbenchSceneFetchPlan(commons, 32, false)).toMatchObject({
      active: true,
      bootstrapLimit: 40,
      fullPageOffsets: [0],
      aroundStart: null,
    });
  });

  it("retains the field live-scene optimization until replay is needed", () => {
    expect(workbenchSceneFetchPlan(field, 32, false).active).toBe(false);
    expect(workbenchSceneFetchPlan(field, 32, true)).toEqual({
      active: true,
      bootstrapLimit: 8,
      fullPageOffsets: [],
      aroundStart: 10,
    });
  });

  it("adds only the required bounded evidence pages for long matches", () => {
    expect(workbenchSceneFetchPlan(match, 201, false).fullPageOffsets).toEqual([0, 200]);
    expect(workbenchSceneFetchPlan(match, 500, false).fullPageOffsets).toEqual([0, 200, 400]);
  });

  it("uses the shared, human-facing decision source copy", () => {
    expect(formatDecisionSource("compiled")).toBe("Rule ran exactly");
    expect(formatDecisionSource("compiled-fallback")).toBe("Rule fallback");
    expect(formatDecisionSource("decision_cache")).toBe("Recorded decision");
    expect(formatDecisionSource("model")).toBe("Model read the prompt");
  });

  it("numbers duplicate actor labels without mutating the evidence", () => {
    const actors = [{ label: "Trader Ana" }, { label: "Trader Ana" }, { label: "Trader Ben" }];
    expect(disambiguatedActorLabels(actors)).toEqual([
      "Trader Ana 1",
      "Trader Ana 2",
      "Trader Ben",
    ]);
    expect(actors).toEqual([{ label: "Trader Ana" }, { label: "Trader Ana" }, { label: "Trader Ben" }]);
  });

  it("identifies only the payoff cell played in the selected round", () => {
    const round = { actors: [{ actionId: "optionB" }, { actionId: "optionA" }] };
    expect(isSelectedMatchPayoffCell(round, "optionB", "optionA")).toBe(true);
    expect(isSelectedMatchPayoffCell(round, "optionA", "optionB")).toBe(false);
  });
});
