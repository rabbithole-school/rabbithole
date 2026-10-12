import { describe, expect, it } from "vitest";

import {
  activeSimulatorRunLabel,
  findActiveSimulatorRun,
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
});
