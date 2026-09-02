import { describe, expect, it } from "vitest";

import {
  ASAM_AWAKE_WINDOW_MS,
  remainingAsamAwakeMs,
  shouldKeepAsamAwake,
} from "../displayPolicy";

const T0 = 100_000;

describe("ASAM display activity policy", () => {
  it("keeps an active ASAM session awake inside the rolling window", () => {
    const state = {
      inSingleAppMode: true,
      appIsActive: true,
      lastActivityAt: T0,
      now: T0 + 15 * 60 * 1_000,
    };

    expect(shouldKeepAsamAwake(state)).toBe(true);
    expect(remainingAsamAwakeMs(state)).toBe(45 * 60 * 1_000);
  });

  it("expires exactly 60 minutes after the most recent activity", () => {
    expect(
      shouldKeepAsamAwake({
        inSingleAppMode: true,
        appIsActive: true,
        lastActivityAt: T0,
        now: T0 + ASAM_AWAKE_WINDOW_MS - 1,
      }),
    ).toBe(true);
    expect(
      shouldKeepAsamAwake({
        inSingleAppMode: true,
        appIsActive: true,
        lastActivityAt: T0,
        now: T0 + ASAM_AWAKE_WINDOW_MS,
      }),
    ).toBe(false);
  });

  it("does not keep the display awake outside ASAM or in the background", () => {
    const base = {
      lastActivityAt: T0,
      now: T0 + 1_000,
    };

    expect(
      shouldKeepAsamAwake({
        ...base,
        inSingleAppMode: false,
        appIsActive: true,
      }),
    ).toBe(false);
    expect(
      shouldKeepAsamAwake({
        ...base,
        inSingleAppMode: true,
        appIsActive: false,
      }),
    ).toBe(false);
  });

  it("requires activity before enabling keep-awake", () => {
    expect(
      shouldKeepAsamAwake({
        inSingleAppMode: true,
        appIsActive: true,
        lastActivityAt: null,
        now: T0,
      }),
    ).toBe(false);
  });
});
