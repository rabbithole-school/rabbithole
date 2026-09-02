import { getManagedConfig } from "../../modules/managed-config";
import { resolveCaptureStationEnrollmentToken } from "./captureStationTokenLogic";

export { resolveCaptureStationEnrollmentToken } from "./captureStationTokenLogic";

export function captureStationEnrollmentToken(): string | null {
  return resolveCaptureStationEnrollmentToken(
    getManagedConfig()?.captureStationToken,
    process.env.EXPO_PUBLIC_DEV_CAPTURE_STATION_TOKEN,
    __DEV__,
  );
}
