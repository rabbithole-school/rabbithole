import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { LaunchJournal } from "../appHealth";

const written = vi.hoisted(() => [] as LaunchJournal[]);

vi.mock("react-native", () => ({
  AppState: { currentState: "active", addEventListener: vi.fn() },
}));
vi.mock("expo-device", () => ({ getUptimeAsync: vi.fn(async () => 1_000) }));
vi.mock("@/lib/appHealthStore", () => ({
  readJournal: vi.fn(async () => null),
  writeJournal: vi.fn(async (journal: LaunchJournal) => {
    written.push(journal);
  }),
  addToOutbox: vi.fn(async () => {}),
}));
vi.mock("@/lib/appStatusBus", () => ({
  appStatusBus: { getRoute: () => ({ route: "/" }), subscribe: vi.fn() },
}));
vi.mock("@/lib/nativeClientBuildInfo", () => ({
  nativeClientBuildInfo: {
    channel: "canary",
    appVersion: "1.0.0",
    buildNumber: "1",
    gitSha: "abcdef1234",
  },
}));

const { reloadDeliberately, startAppHealthMonitor } = await import(
  "../appHealthMonitor"
);

const lastWrite = () => written.at(-1);

describe("reloadDeliberately", () => {
  beforeAll(async () => {
    vi.useFakeTimers(); // the monitor's stall poll is a setInterval
    startAppHealthMonitor();
    await vi.advanceTimersByTimeAsync(0);
  });

  afterAll(() => {
    vi.useRealTimers();
  });

  it("writes the reload mark before reloading", async () => {
    let markedWhenReloaded: number | undefined;
    await reloadDeliberately(async () => {
      markedWhenReloaded = lastWrite()?.reloadedAt;
    });
    expect(markedWhenReloaded).toEqual(expect.any(Number));
  });

  it("takes the mark off again when the reload fails", async () => {
    const failure = new Error("reload unavailable");
    await expect(
      reloadDeliberately(async () => {
        expect(lastWrite()?.reloadedAt).toEqual(expect.any(Number));
        throw failure;
      }),
    ).rejects.toBe(failure);
    expect(lastWrite()).toBeDefined();
    expect(lastWrite()?.reloadedAt).toBeUndefined();
  });
});
