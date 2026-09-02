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

type BuildEnvironment = Record<string, string | undefined>;

function valueOrUnknown(value: string | number | null | undefined): string {
  const normalized = String(value ?? "").trim();
  return normalized || "unknown";
}

function channelFromEnvironment(
  environment: BuildEnvironment,
): NativeClientChannel | null {
  const configuredChannel =
    environment.EXPO_PUBLIC_NATIVE_CLIENT_CHANNEL ??
    environment.EXPO_PUBLIC_BUILD_CHANNEL;
  const normalized = configuredChannel?.trim().toLowerCase();
  return normalized === "stable" || normalized === "canary" ? normalized : null;
}

function gitShaFromEnvironment(environment: BuildEnvironment): string {
  const explicit = environment.EXPO_PUBLIC_GIT_SHA?.trim();
  if (explicit) return explicit;

  const stamp = environment.EXPO_PUBLIC_BUILD_STAMP?.trim();
  const match = /^([0-9a-f]{7,40})-\d{8}T\d{6}Z$/i.exec(stamp ?? "");
  return match?.[1] ?? valueOrUnknown(stamp);
}

/**
 * Only Stable and Canary report production client inventory. Test and Metro are
 * intentionally absent rather than mislabeled as Stable on their own backends.
 */
export function resolveNativeClientBuildInfo(
  expoConfig: ExpoConfig | null | undefined,
  environment: BuildEnvironment = process.env,
): NativeClientBuildInfo {
  return {
    channel: channelFromEnvironment(environment),
    appVersion: valueOrUnknown(expoConfig?.version),
    buildNumber: valueOrUnknown(expoConfig?.ios?.buildNumber),
    gitSha: gitShaFromEnvironment(environment),
  };
}

export const nativeClientBuildInfo = resolveNativeClientBuildInfo(
  Constants.expoConfig,
);
