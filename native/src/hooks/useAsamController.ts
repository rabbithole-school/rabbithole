import * as SecureStore from "expo-secure-store";
import { useConvexAuth, useMutation, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AppState, type AppStateStatus } from "react-native";

import { useOfflineRecovery } from "@/hooks/useOfflineRecovery";
import {
  applyAsamAction,
  decideAsamAction,
  decideOneTimeDisarmAction,
  isAppReentry,
  shouldUseOfflineRecoveryBypass,
} from "@/lib/asam/asamDecision";
import { api } from "@/lib/convex";
import { getStableDeviceId } from "@/lib/deviceIdentity";
import {
  enterSingleAppMode,
  exitSingleAppMode,
  isSingleAppModeActive,
} from "@/lib/singleAppMode";
import { rabbitholeWebUrl } from "@/lib/webEmbedConfig";

const LOCK_STATE_CACHE_KEY = "rabbithole.lock.lastKnownState";

// Derived from the query's own generated return type (rather than hand-rolled)
// so a backend contract change — a renamed field, a new disarmMode literal —
// fails typecheck here instead of compiling silently and drifting at runtime.
export type DeviceLockState = NonNullable<
  FunctionReturnType<typeof api.deviceLock.stateForDevice>
>;

type CachedLockState = {
  deviceId: string;
  state: DeviceLockState;
};

export type AsamController = {
  inSam: boolean;
  busy: boolean;
  error: string | null;
  offlineBypass: boolean;
  lockState: DeviceLockState | null;
  deviceSettingsUrl: string | null;
  qrCodeUrl: string | null;
  /** Temporarily release ASAM so system UI such as Control Center can open. */
  releaseForSystemUI: () => void;
  /** End a temporary system-UI release and restore the normal ASAM policy. */
  restoreAfterSystemUI: () => void;
};

function parseCachedState(raw: string | null): CachedLockState | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as CachedLockState;
    return parsed?.deviceId && parsed?.state?.pairedDeviceId ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Reconciles the server-owned Rabbithole Lock intent with iOS Single App Mode.
 * Offline Wi-Fi recovery remains the highest-priority override, and only a
 * currently confirmed paired-device record may cause an ASAM entry.
 */
export function useAsamController(): AsamController {
  const { isOffline } = useOfflineRecovery();
  const { isAuthenticated } = useConvexAuth();
  const [deviceId, setDeviceId] = useState<string | null>(null);
  const [cachedState, setCachedState] = useState<CachedLockState | null>(null);
  const [inSam, setInSam] = useState(() => isSingleAppModeActive());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [releasedForSystemUI, setReleasedForSystemUI] = useState(false);
  const [appEntryVersion, setAppEntryVersion] = useState(0);
  const appStateRef = useRef<AppStateStatus>(AppState.currentState);
  const oneTimeObservedRef = useRef<{
    desiredUpdatedAt: number;
    appEntryVersion: number;
  } | null>(null);
  const consumedOneTimeRef = useRef<number | null>(null);
  const acknowledgementRef = useRef<string | null>(null);

  const remoteState = useQuery(
    api.deviceLock.stateForDevice,
    deviceId ? { deviceId } : "skip",
  );
  const reportAppliedState = useMutation(api.deviceLock.reportAppliedState);
  const consumeOneTimeDisarm = useMutation(
    api.deviceLock.consumeOneTimeDisarm,
  );

  useEffect(() => {
    let mounted = true;
    void Promise.all([
      getStableDeviceId(),
      SecureStore.getItemAsync(LOCK_STATE_CACHE_KEY),
    ]).then(([stableId, rawCache]) => {
      if (!mounted) return;
      setDeviceId(stableId);
      setCachedState(parseCachedState(rawCache));
    });
    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    if (remoteState === undefined || !deviceId) return;
    if (remoteState === null) {
      void SecureStore.deleteItemAsync(LOCK_STATE_CACHE_KEY).then(() => {
        setCachedState(null);
      });
      return;
    }
    const nextCache = { deviceId, state: remoteState };
    void SecureStore
      .setItemAsync(LOCK_STATE_CACHE_KEY, JSON.stringify(nextCache))
      .then(() => {
        setCachedState(nextCache);
      });
  }, [deviceId, remoteState]);

  useEffect(() => {
    const desiredUpdatedAt =
      remoteState?.desiredState === "disarmed" &&
      remoteState.disarmMode === "one_time"
        ? remoteState.desiredUpdatedAt
        : null;
    const action = decideOneTimeDisarmAction({
      desiredUpdatedAt,
      observedUpdatedAt:
        oneTimeObservedRef.current?.desiredUpdatedAt ?? null,
      observedEntryVersion:
        oneTimeObservedRef.current?.appEntryVersion ?? null,
      appEntryVersion,
      isAppActive: AppState.currentState === "active",
      inSam,
    });
    if (action === "clear") {
      oneTimeObservedRef.current = null;
      consumedOneTimeRef.current = null;
      return;
    }
    if (action === "observe" && desiredUpdatedAt !== null) {
      oneTimeObservedRef.current = {
        desiredUpdatedAt,
        appEntryVersion,
      };
      return;
    }
    if (
      action !== "consume" ||
      !deviceId ||
      desiredUpdatedAt === null ||
      consumedOneTimeRef.current === desiredUpdatedAt
    ) {
      return;
    }
    consumedOneTimeRef.current = desiredUpdatedAt;
    void consumeOneTimeDisarm({
      deviceId,
      expectedUpdatedAt: desiredUpdatedAt,
    }).catch((nextError) => {
      consumedOneTimeRef.current = null;
      setError(
        nextError instanceof Error
          ? nextError.message
          : "Could not re-arm Rabbithole Lock.",
      );
    });
  }, [
    appEntryVersion,
    consumeOneTimeDisarm,
    deviceId,
    inSam,
    remoteState,
  ]);

  useEffect(() => {
    let mounted = true;
    let inFlight = false;
    let rerun = false;

    const reconcile = async () => {
      if (inFlight) {
        rerun = true;
        return;
      }
      inFlight = true;
      if (mounted) {
        setBusy(true);
        setError(null);
      }
      try {
        do {
          rerun = false;
          const action = decideAsamAction({
            isOnline: !isOffline,
            paired:
              remoteState === undefined ? "unknown" : remoteState !== null,
            armed:
              remoteState?.desiredState === "armed" &&
              !releasedForSystemUI,
            inSam: isSingleAppModeActive(),
          });
          await applyAsamAction(action, {
            enter: enterSingleAppMode,
            exit: exitSingleAppMode,
          });
          if (mounted) setInSam(isSingleAppModeActive());
        } while (rerun);
      } catch (nextError) {
        if (mounted) {
          setError(
            nextError instanceof Error
              ? nextError.message
              : "Rabbithole Lock could not update.",
          );
        }
      }
      inFlight = false;
      if (mounted) setBusy(false);
    };

    void reconcile();
    const subscription = AppState.addEventListener("change", (nextState) => {
      if (isAppReentry(appStateRef.current, nextState)) {
        setAppEntryVersion((version) => version + 1);
      }
      if (nextState === "active") void reconcile();
      appStateRef.current = nextState;
    });
    return () => {
      mounted = false;
      subscription.remove();
    };
  }, [isOffline, releasedForSystemUI, remoteState]);

  useEffect(() => {
    if (!deviceId || !remoteState || !isAuthenticated) return;
    const acknowledgementKey = [
      remoteState.desiredUpdatedAt,
      remoteState.desiredState,
      inSam,
    ].join(":");
    if (acknowledgementRef.current === acknowledgementKey) {
      return;
    }
    acknowledgementRef.current = acknowledgementKey;
    void reportAppliedState({
      deviceId,
      desiredUpdatedAt: remoteState.desiredUpdatedAt,
      desiredState: remoteState.desiredState,
      inSingleAppMode: inSam,
    }).catch((nextError) => {
      acknowledgementRef.current = null;
      setError(
        nextError instanceof Error
          ? nextError.message
          : "Could not report Rabbithole Lock status.",
      );
    });
  }, [deviceId, inSam, isAuthenticated, remoteState, reportAppliedState]);

  // Cached state keeps the four-finger status useful while reconnecting. It
  // never drives an ASAM entry; only the current remoteState does that.
  const lockState =
    remoteState === undefined && cachedState?.deviceId === deviceId
      ? cachedState.state
      : remoteState ?? null;
  const deviceSettingsUrl = useMemo(
    () =>
      lockState
        ? rabbitholeWebUrl(lockState.settingsPath)
        : null,
    [lockState],
  );
  const qrCodeUrl = deviceSettingsUrl ? `${deviceSettingsUrl}/qr` : null;

  const releaseForSystemUI = useCallback(() => {
    setReleasedForSystemUI(true);
    void exitSingleAppMode();
  }, []);

  const restoreAfterSystemUI = useCallback(
    () => setReleasedForSystemUI(false),
    [],
  );

  return {
    inSam,
    busy,
    error,
    offlineBypass: shouldUseOfflineRecoveryBypass({
      isOnline: !isOffline,
      paired: remoteState === undefined ? "unknown" : remoteState !== null,
      armed:
        remoteState?.desiredState === "armed" && !releasedForSystemUI,
      inSam,
    }),
    lockState,
    deviceSettingsUrl,
    qrCodeUrl,
    releaseForSystemUI,
    restoreAfterSystemUI,
  };
}
