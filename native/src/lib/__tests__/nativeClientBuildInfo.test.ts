import { describe, expect, it, vi } from "vitest";

vi.mock("expo-constants", () => ({ default: { expoConfig: {} } }));

import { resolveNativeClientBuildInfo } from "../nativeClientBuildInfo";

describe("resolveNativeClientBuildInfo", () => {
  it("reads stable release metadata from the Expo config", () => {
    expect(
      resolveNativeClientBuildInfo(
        { version: "1.2.3", ios: { buildNumber: "45" } },
        { EXPO_PUBLIC_NATIVE_CLIENT_CHANNEL: "stable", EXPO_PUBLIC_GIT_SHA: "abc1234" },
      ),
    ).toEqual({
      channel: "stable",
      appVersion: "1.2.3",
      buildNumber: "45",
      gitSha: "abc1234",
    });
  });

  it("recognizes only an explicit canary channel and extracts the SHA from a build stamp", () => {
    expect(
      resolveNativeClientBuildInfo(
        { version: "2.0.0", ios: { buildNumber: 7 } },
        {
          EXPO_PUBLIC_NATIVE_CLIENT_CHANNEL: " CANARY ",
          EXPO_PUBLIC_BUILD_STAMP: "def5678-20260810T010203Z",
        },
      ),
    ).toEqual({
      channel: "canary",
      appVersion: "2.0.0",
      buildNumber: "7",
      gitSha: "def5678",
    });
  });

  it("does not classify unconfigured builds as production clients", () => {
    expect(resolveNativeClientBuildInfo({}, { EXPO_PUBLIC_BUILD_CHANNEL: "preview" })).toEqual({
      channel: null,
      appVersion: "unknown",
      buildNumber: "unknown",
      gitSha: "unknown",
    });
  });
});
