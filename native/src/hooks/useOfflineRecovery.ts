import { useCallback, useEffect, useRef, useState } from "react";

import { probeInternetReachable } from "@/lib/wifiRecovery/networkProbe";
import {
  INITIAL_OFFLINE_STATE,
  reduceProbe,
  type OfflineState,
} from "@/lib/wifiRecovery/offlineDecision";

/** How often to probe connectivity while the app is mounted (ms). */
export const PROBE_INTERVAL_MS = 5000;

export type OfflineRecovery = {
  /** True once the debounced decision logic says we're really offline. */
  isOffline: boolean;
  /** True while a connectivity probe is in flight. */
  isChecking: boolean;
  /** Force an immediate probe (used by the overlay's "Check again" button). */
  retryNow: () => void;
};

/**
 * Drives the connectivity probe loop and feeds results into the pure
 * `offlineDecision` machine. The loop lives inside a single mount effect and
 * self-schedules with `setTimeout` (not `setInterval`) so a new probe never
 * overlaps one still in flight; `retryNow` fires an immediate probe and resets
 * the cadence via a stable ref. All timers are cleared on unmount and every
 * setState is guarded against a probe resolving after unmount.
 */
export function useOfflineRecovery(): OfflineRecovery {
  const [isOffline, setIsOffline] = useState(false);
  const [isChecking, setIsChecking] = useState(false);

  // A stable indirection so `retryNow` can trigger the loop without depending on
  // the loop closure itself (which lives inside the effect below).
  const runRef = useRef<() => void>(() => {});

  useEffect(() => {
    let mounted = true;
    let inFlight = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let decision: OfflineState = INITIAL_OFFLINE_STATE;

    const clearTimer = () => {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    };

    const run = async () => {
      clearTimer();
      // A probe is already running; it will reschedule the next tick itself.
      if (inFlight) return;

      inFlight = true;
      if (mounted) setIsChecking(true);

      const ok = await probeInternetReachable();
      decision = reduceProbe(decision, { ok, at: Date.now() });

      inFlight = false;
      if (!mounted) return;

      setIsOffline(decision.isOffline);
      setIsChecking(false);

      clearTimer();
      timer = setTimeout(() => void run(), PROBE_INTERVAL_MS);
    };

    runRef.current = () => void run();
    void run();

    return () => {
      mounted = false;
      clearTimer();
    };
  }, []);

  const retryNow = useCallback(() => runRef.current(), []);

  return { isOffline, isChecking, retryNow };
}
