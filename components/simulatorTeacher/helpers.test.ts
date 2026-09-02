import { describe, expect, it } from "vitest";

import {
  availableCriterionMetricKeys,
  metricLabel,
} from "./helpers";

describe("World criterion metric options", () => {
  const metrics = [
    "longevity",
    "traitMean",
    "livingAutomata",
    "traitSpread",
    "perceptionMean",
    "perceptionSpread",
  ];

  it("hides trait criteria when heredity is disabled", () => {
    expect(availableCriterionMetricKeys(metrics, false)).toEqual([
      "longevity",
      "livingAutomata",
    ]);
  });

  it("offers trait criteria with sentence-case labels when heredity is enabled", () => {
    expect(availableCriterionMetricKeys(metrics, true)).toEqual(metrics);
    expect(metricLabel("traitMean")).toBe("Average trait");
    expect(metricLabel("traitSpread")).toBe("Trait spread");
    expect(metricLabel("perceptionMean")).toBe("Average perception");
    expect(metricLabel("perceptionSpread")).toBe("Perception spread");
  });
});
