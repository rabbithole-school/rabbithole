import { useConvexAuth, useMutation } from "convex/react";
import type { FunctionReference } from "convex/server";
import { useEffect, useRef } from "react";
import { AppState, type AppStateStatus } from "react-native";

import { api } from "@/lib/convex";
import { nativeClientBuildInfo } from "@/lib/nativeClientBuildInfo";
import { getStableDeviceId } from "@/lib/deviceIdentity";

export const NATIVE_CLIENT_HEARTBEAT_INTERVAL_MS = 5 * 60 * 1000;

type NativeClientHeartbeatApi = {
  nativeClientHeartbeat: {
    record: FunctionReference<
      "mutation",
      "public",
      {
        deviceId: string;
        channel: "stable" | "canary";
        appVersion: string;
        buildNumber: string;
        gitSha: string;
      }
    >;
  };
};

/** Reports immediately on foreground, then periodically while the app is active. */
export function useNativeClientHeartbeat() {
  const { isAuthenticated, isLoading } = useConvexAuth();
  // The native bundle vendors an anyApi binding, while the root generated
  // declaration is refreshed by Convex codegen at integration time.
  const recordHeartbeat = useMutation(
    (api as unknown as NativeClientHeartbeatApi).nativeClientHeartbeat.record,
  );
  const appStateRef = useRef<AppStateStatus>(AppState.currentState);

  useEffect(() => {
    const channel = nativeClientBuildInfo.channel;
    if (isLoading || !isAuthenticated || !channel) return;

    let mounted = true;
    let deviceId: string | null = null;
    let inFlight = false;
    let pending = false;

    const report = () => {
      if (!mounted || appStateRef.current !== "active" || !deviceId) return;
      if (inFlight) {
        pending = true;
        return;
      }
      inFlight = true;
      void recordHeartbeat({
        deviceId,
        ...nativeClientBuildInfo,
        channel,
      })
        .catch((error: unknown) => {
          console.warn("[native-client-heartbeat] report failed", error);
        })
        .finally(() => {
          inFlight = false;
          if (pending) {
            pending = false;
            report();
          }
        });
    };

    void getStableDeviceId()
      .then((resolvedDeviceId) => {
        if (!mounted) return;
        deviceId = resolvedDeviceId;
        report();
      })
      .catch((error: unknown) => {
        console.warn("[native-client-heartbeat] device id unavailable", error);
      });

    const timer = setInterval(report, NATIVE_CLIENT_HEARTBEAT_INTERVAL_MS);
    const subscription = AppState.addEventListener(
      "change",
      (nextState: AppStateStatus) => {
        appStateRef.current = nextState;
        if (nextState === "active") report();
      },
    );

    return () => {
      mounted = false;
      clearInterval(timer);
      subscription.remove();
    };
  }, [isAuthenticated, isLoading, recordHeartbeat]);
}
