import { describe, expect, it } from "vitest";

import { runEndReasonLine } from "../SimulatorViewport";

describe("run end reason", () => {
  it("describes a terminal field run as ending early", () => {
    expect(
      runEndReasonLine("completed", "terminal_physics", 30, "iteration", "day", 12),
    ).toBe("Ended early · the world reached a standstill");
  });

  it("describes a full-length round game as complete", () => {
    expect(
      runEndReasonLine("completed", "terminal_physics", 30, "iteration", "round", 30),
    ).toBe("Simulation complete · reached 30 rounds");
  });

  it("describes a short terminal round game as ending early", () => {
    expect(
      runEndReasonLine("completed", "terminal_physics", 30, "iteration", "round", 12),
    ).toBe("Ended early · the run reached a standstill");
  });

  it("uses the target only when the run reached its normal limit", () => {
    expect(runEndReasonLine("completed", undefined, 30, "iteration")).toBe(
      "Simulation complete · reached 30 days",
    );
    expect(runEndReasonLine("completed", undefined, 30, "season")).toBe(
      "Simulation complete · reached 30 days",
    );
  });
});
