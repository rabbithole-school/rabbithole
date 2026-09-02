import { describe, expect, it } from "vitest";

import {
  activeSimulatorRunLabel,
  findActiveSimulatorRun,
  firstRunHint,
  START_SIMULATION_LABEL,
} from "./simulatorRunLauncher";

describe("simulator run launcher", () => {
  it("finds the first queued or ticking run", () => {
    const runs = [
      { status: "completed" as const, latestCommittedTick: 40, targetTicks: 40 },
      { status: "queued" as const, latestCommittedTick: 0, targetTicks: 200 },
      { status: "ticking" as const, latestCommittedTick: 12, targetTicks: 40 },
    ];

    expect(findActiveSimulatorRun(runs)).toBe(runs[1]);
  });

  it("labels queued and ticking runs without playback language", () => {
    expect(
      activeSimulatorRunLabel({
        status: "queued",
        latestCommittedTick: 0,
        targetTicks: 40,
      }),
    ).toBe("Queued");
    expect(
      activeSimulatorRunLabel({
        status: "ticking",
        latestCommittedTick: 12,
        targetTicks: 40,
      }),
    ).toBe("Running · day 12 of 40");
  });

  it("keeps launch copy identical across surfaces", () => {
    expect(START_SIMULATION_LABEL).toBe("Start simulation");
    expect(firstRunHint(1)).toBe(
      "Start with the starter deck. This first simulation becomes your baseline.",
    );
    expect(firstRunHint(2)).toBe(
      "Start this simulation to set a baseline for your deck.",
    );
  });
});
