import { describe, expect, test } from "vitest";
import {
  batteryReadingIsStale,
  DEVICE_BATTERY_STALE_AFTER_MS,
  deviceBatteryBand,
} from "./deviceBattery";

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

describe("batteryReadingIsStale", () => {
  const now = Date.UTC(2026, 10, 7, 22, 30);

  test("a reading from minutes ago is fresh", () => {
    expect(batteryReadingIsStale(now - 10 * 60 * 1000, now)).toBe(false);
  });

  test("a reading exactly at the cutoff is still fresh", () => {
    expect(batteryReadingIsStale(now - DEVICE_BATTERY_STALE_AFTER_MS, now)).toBe(
      false,
    );
  });

  test("a reading past the cutoff is stale", () => {
    expect(
      batteryReadingIsStale(now - DEVICE_BATTERY_STALE_AFTER_MS - 1, now),
    ).toBe(true);
  });

  test("yesterday's reading is stale", () => {
    expect(batteryReadingIsStale(now - 22 * 60 * 60 * 1000, now)).toBe(true);
  });

  test("an undated reading is stale", () => {
    expect(batteryReadingIsStale(null, now)).toBe(true);
    expect(batteryReadingIsStale(Number.NaN, now)).toBe(true);
  });
});
