import { describe, it, expect } from "vitest";

import { buildStageMap, type InventoryTeam } from "../graphemeStageMap";

describe("buildStageMap", () => {
  it("returns an empty map for missing / empty inventory (plain-text fast path)", () => {
    expect(buildStageMap(undefined)).toEqual({});
    expect(buildStageMap(null)).toEqual({});
    expect(buildStageMap([])).toEqual({});
  });

  it("maps each team to its stage", () => {
    const teams: InventoryTeam[] = [
      { team: "sh", stage: "training" },
      { team: "th", stage: "fading" },
      { team: "ea", stage: "graduated" },
    ];
    expect(buildStageMap(teams)).toEqual({
      sh: "training",
      th: "fading",
      ea: "graduated",
    });
  });

  it("carries graduated teams through (toSegments treats them as plain ink)", () => {
    const map = buildStageMap([{ team: "oo", stage: "graduated" }]);
    expect(Object.keys(map)).toEqual(["oo"]);
    expect(map.oo).toBe("graduated");
  });

  it("lets a later duplicate team win (defensive; inventory is deduped server-side)", () => {
    const map = buildStageMap([
      { team: "sh", stage: "training" },
      { team: "sh", stage: "fading" },
    ]);
    expect(map.sh).toBe("fading");
  });
});
