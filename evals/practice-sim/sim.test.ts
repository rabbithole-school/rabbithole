import { describe, expect, test } from "vitest";
import { runSimulation } from "./sim";

describe("practice simulated-scholar harness", () => {
  test("short runs are deterministic and produce reviews by day 5", () => {
    const opts = {
      days: 5,
      scholars: 3,
      seed: 11,
      domain: "whole-number-arithmetic" as const,
      scenario: "baseline" as const,
    };
    const first = runSimulation(opts);
    const second = runSimulation(opts);

    expect(second).toEqual(first);
    expect(first.reviewShareByDay[4]?.reviewShare ?? 0).toBeGreaterThan(0);
    expect(first.totalItems).toBeGreaterThan(0);
  });

  test("phase2 scenario runs deterministically", () => {
    const opts = {
      days: 5,
      scholars: 3,
      seed: 11,
      domain: "whole-number-arithmetic" as const,
      scenario: "phase2" as const,
    };
    expect(runSimulation(opts)).toEqual(runSimulation(opts));
  });
});
