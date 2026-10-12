import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

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
    expect(resolveNativeClientBuildInfo({}, { EXPO_PUBLIC_NATIVE_CLIENT_CHANNEL: "preview" })).toEqual({
      channel: null,
      appVersion: "unknown",
      buildNumber: "unknown",
      gitSha: "unknown",
    });
  });
});

// TRA-457: babel-preset-expo inlines EXPO_PUBLIC_* only at a literal
// `process.env.EXPO_PUBLIC_X` read; at runtime `process.env` holds only
// NODE_ENV. So transform the real module the way a release bundle does, then
// run it against that bare runtime env. Reading the env through an alias
// (the pre-fix `environment = process.env` default) makes this return null.
describe("nativeClientBuildInfo in a release bundle", () => {
  const sourcePath = fileURLToPath(new URL("../nativeClientBuildInfo.ts", import.meta.url));
  const expoRequire = createRequire(createRequire(sourcePath).resolve("expo/package.json"));

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("inlines the channel and git SHA the release build sets", () => {
    vi.stubEnv("EXPO_PUBLIC_NATIVE_CLIENT_CHANNEL", "canary");
    vi.stubEnv("EXPO_PUBLIC_GIT_SHA", "feedface123");
    vi.stubEnv("EXPO_PUBLIC_BUILD_STAMP", "feedface123-20260929T010203Z");

    const babel = expoRequire("@babel/core");
    const { code } = babel.transformFileSync(sourcePath, {
      babelrc: false,
      configFile: false,
      presets: [expoRequire.resolve("babel-preset-expo")],
      caller: { name: "metro", bundler: "metro", platform: "ios", isDev: false, isServer: false },
    });

    const bundleModule = { exports: {} as { nativeClientBuildInfo?: unknown } };
    const fakeRequire = (id: string) =>
      id === "expo-constants"
        ? { __esModule: true, default: { expoConfig: { version: "1.0.25", ios: { buildNumber: "71" } } } }
        : expoRequire(id);
    new Function("require", "module", "exports", "process", code)(
      fakeRequire,
      bundleModule,
      bundleModule.exports,
      { env: { NODE_ENV: "production" } },
    );

    expect(bundleModule.exports.nativeClientBuildInfo).toEqual({
      channel: "canary",
      appVersion: "1.0.25",
      buildNumber: "71",
      gitSha: "feedface123",
    });
  });
});
