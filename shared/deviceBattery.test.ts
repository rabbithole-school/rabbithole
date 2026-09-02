import { describe, expect, test } from "vitest";
import { deviceBatteryBand } from "./deviceBattery";

describe("deviceBatteryBand", () => {
  test.each([
    [0, "low"],
    [19, "low"],
    [20, "medium"],
    [49, "medium"],
    [50, "high"],
    [99, "high"],
    [100, "full"],
    [null, "unknown"],
    [-1, "unknown"],
    [101, "unknown"],
  ] as const)("classifies %s as %s", (level, expected) => {
    expect(deviceBatteryBand(level)).toBe(expected);
  });
});
