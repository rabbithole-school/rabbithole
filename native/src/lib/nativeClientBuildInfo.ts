import Constants from "expo-constants";

export type NativeClientChannel = "stable" | "canary";

export type NativeClientBuildInfo = {
  channel: NativeClientChannel | null;
  appVersion: string;
  buildNumber: string;
  gitSha: string;
};

type ExpoConfig = {
  version?: string | null;
  ios?: { buildNumber?: string | number | null } | null;
};

export type NativeClientBuildEnvironment = {
  EXPO_PUBLIC_NATIVE_CLIENT_CHANNEL?: string;
  EXPO_PUBLIC_GIT_SHA?: string;
  EXPO_PUBLIC_BUILD_STAMP?: string;
};

function valueOrUnknown(value: string | number | null | undefined): string {
  const normalized = String(value ?? "").trim();
  return normalized || "unknown";
}

function channelFromEnvironment(
  environment: NativeClientBuildEnvironment,
): NativeClientChannel | null {
  const normalized = environment.EXPO_PUBLIC_NATIVE_CLIENT_CHANNEL?.trim().toLowerCase();
  return normalized === "stable" || normalized === "canary" ? normalized : null;
}

function gitShaFromEnvironment(environment: NativeClientBuildEnvironment): string {
  const explicit = environment.EXPO_PUBLIC_GIT_SHA?.trim();
  if (explicit) return explicit;

  const stamp = environment.EXPO_PUBLIC_BUILD_STAMP?.trim();
  const match = /^([0-9a-f]{7,40})-\d{8}T\d{6}Z$/i.exec(stamp ?? "");
  return match?.[1] ?? valueOrUnknown(stamp);
}

/**
 * Only Stable and Canary report production client inventory. Metro is
 * intentionally absent rather than mislabeled as Stable.
 */
export function resolveNativeClientBuildInfo(
  expoConfig: ExpoConfig | null | undefined,
  environment: NativeClientBuildEnvironment,
): NativeClientBuildInfo {
  return {
    channel: channelFromEnvironment(environment),
    appVersion: valueOrUnknown(expoConfig?.version),
    buildNumber: valueOrUnknown(expoConfig?.ios?.buildNumber),
    gitSha: gitShaFromEnvironment(environment),
  };
}

/**
 * Each key is spelled out as a literal `process.env.EXPO_PUBLIC_X` read because
 * that member expression is the only form babel-preset-expo inlines into a
 * release bundle. At runtime `process.env` holds only NODE_ENV, so passing
 * `process.env` itself (as a default parameter did until TRA-457) read nothing
 * and left every release build with a null channel.
 */
const releaseBuildEnvironment: NativeClientBuildEnvironment = {
  EXPO_PUBLIC_NATIVE_CLIENT_CHANNEL: process.env.EXPO_PUBLIC_NATIVE_CLIENT_CHANNEL,
  EXPO_PUBLIC_GIT_SHA: process.env.EXPO_PUBLIC_GIT_SHA,
  EXPO_PUBLIC_BUILD_STAMP: process.env.EXPO_PUBLIC_BUILD_STAMP,
};

export const nativeClientBuildInfo = resolveNativeClientBuildInfo(
  Constants.expoConfig,
  releaseBuildEnvironment,
);
