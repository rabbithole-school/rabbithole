import { requireOptionalNativeModule } from "expo-modules-core";

import type {
  DevClientSafetyModule,
  DevClientSafetyResult,
} from "./src/DevClientSafety.types";

const nativeModule =
  requireOptionalNativeModule<DevClientSafetyModule>("DevClientSafety");

export function guardCurrentDevServer(
  url: string,
): Promise<DevClientSafetyResult> | null {
  return nativeModule?.guardCurrentServer(url) ?? null;
}
