import { describe, expect, test } from "vitest";

import { defaultMatrixGameCriterion } from "./matrixGameHelpers";
import { deckModeFromSlots, speciesSlotsForDeckMode } from "./prisonersDilemmaHelpers";
import { validateMatrixGameSpec } from "@/lib/simulator/templates/matrixGame";
import { defaultMatrixGameSpec } from "./matrixGame";

function templateMeta() {
  return {
    id: "matrixGame",
    version: 1,
    senseIds: ["history"],
    actionKinds: ["optionA", "optionB"],
    metricKeys: [],
    summaryMetricKeys: [],
  };
}

describe("matrixGame criterion toggle", () => {
  test("adversarial always produces the fixed deck-score pair", () => {
    expect(defaultMatrixGameCriterion("adversarial")).toEqual({
      kind: "adversarial",
      scoreMetricKeys: ["deckA.totalScore", "deckB.totalScore"],
    });
  });

  test("measured always produces the fixed jointScore metric, defaulting to maximize", () => {
    expect(defaultMatrixGameCriterion("measured")).toEqual({
      kind: "measured",
      metricKey: "jointScore",
      direction: "maximize",
      target: undefined,
    });
  });

  test("measured preserves a previous measured direction/target across an adversarial round-trip", () => {
    const previous = { kind: "measured" as const, metricKey: "jointScore", direction: "target" as const, target: 12 };
    expect(defaultMatrixGameCriterion("measured", previous)).toEqual({
      kind: "measured",
      metricKey: "jointScore",
      direction: "target",
      target: 12,
    });
    // Switching to adversarial and back to measured still recovers the direction.
    const adversarial = defaultMatrixGameCriterion("adversarial", previous);
    expect(defaultMatrixGameCriterion("measured", adversarial)).toEqual({
      kind: "measured",
      metricKey: "jointScore",
      direction: "maximize",
      target: undefined,
    });
  });

  test("both criterion kinds validate against the real server validateSpec", () => {
    const base = defaultMatrixGameSpec(templateMeta());
    if (base.templateId !== "matrixGame") throw new Error("unreachable");
    expect(() =>
      validateMatrixGameSpec({ ...base, criterion: defaultMatrixGameCriterion("adversarial") }),
    ).not.toThrow();
    expect(() =>
      validateMatrixGameSpec({ ...base, criterion: defaultMatrixGameCriterion("measured") }),
    ).not.toThrow();
  });
});

describe("matrixGame reuses the prisonersDilemma deck-mode rule (identical species-slot constraint)", () => {
  test("the default spec's two decks are recognized as twoDecks and validate", () => {
    const spec = defaultMatrixGameSpec(templateMeta());
    expect(deckModeFromSlots(spec.speciesSlots)).toBe("twoDecks");
    expect(() => validateMatrixGameSpec(spec)).not.toThrow();
  });

  test("collapsing to self-play still sums to exactly 2 automata and validates", () => {
    const spec = defaultMatrixGameSpec(templateMeta());
    const selfPlaySlots = speciesSlotsForDeckMode("selfPlay", spec.speciesSlots);
    expect(selfPlaySlots.reduce((sum, s) => sum + s.defaultCount, 0)).toBe(2);
    expect(() =>
      validateMatrixGameSpec({ ...spec, speciesSlots: selfPlaySlots }),
    ).not.toThrow();
  });
});
