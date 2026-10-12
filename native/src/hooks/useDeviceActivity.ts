// Drains the device-activity queue to Convex. Mounted once, app-wide, next to
// useNativeClientHeartbeat in the root layout.
//
// What it emits:
//   • app_foreground / app_background from AppState (the first foreground after
//     an external launch is emitted as external_return — see the queue).
//   • heartbeat every 60 s while foregrounded, so the server can distinguish
//     "still here" from "walked away and the screen locked".
//   • external_launch is pushed by the launcher itself, synchronously, at the
//     moment it opens the URL scheme.
//   • app_stuck_inactive / app_stuck_inactive_end when the app sits in iOS's
//     `inactive` state for minutes (TRA-331; StuckInactiveWatch). `inactive`
//     and `background` are told apart only for that watch: both still emit
//     app_background on the way out of `active`, so the usage roll-up's input
//     is unchanged.
//   • asam_enter / asam_exit are pushed by the lock controller.
//
// Flushing is NOT gated on `active`: the 60 s flush timer also runs while the
// app is inactive (JS keeps running there), so a stuck report can land while
// the iPad is still stuck.
//
// It never blocks the UI: every send is fire-and-forget, a failure re-queues
// the batch at the front for the next attempt, and the queue is bounded so an
// iPad that is offline all afternoon cannot grow without limit.

import { useConvexAuth, useMutation } from "convex/react";
import type { FunctionReference } from "convex/server";
import { useEffect, useRef } from "react";
import { AppState, type AppStateStatus } from "react-native";

import { api } from "@/lib/convex";
import { getStableDeviceId } from "@/lib/deviceIdentity";
import {
  DEVICE_ACTIVITY_FLUSH_INTERVAL_MS,
  DEVICE_ACTIVITY_HEARTBEAT_INTERVAL_MS,
  deviceActivityQueue,
  recordInteraction,
  setInteractionSink,
  shouldEmitHeartbeat,
  StuckInactiveWatch,
  type QueuedDeviceEvent,
} from "@/lib/deviceActivityQueue";

export { recordInteraction };

/** Matches convex/deviceActivity.ts MAX_EVENTS_PER_BATCH. */
const MAX_EVENTS_PER_FLUSH = 200;

type DeviceActivityApi = {
  deviceActivity: {
    record: FunctionReference<
      "mutation",
      "public",
      {
        deviceId: string;
        events: {
          kind: string;
          externalAppId?: string;
          clientAt: number;
          durationMs?: number;
          reason?: string;
          ok?: boolean;
        }[];
      }
    >;
  };
};

export function useDeviceActivity() {
  const { isAuthenticated, isLoading } = useConvexAuth();
  // The native bundle vendors an anyApi binding; the generated declaration is
  // refreshed by Convex codegen at integration time (same as the heartbeat).
  const recordActivity = useMutation(
    (api as unknown as DeviceActivityApi).deviceActivity.record,
  );
  const appStateRef = useRef<AppStateStatus>(AppState.currentState);
  // Starts at 0 — NOT seeded from mount/foreground/sign-in. Only recordInteraction
  // (a real touch/keypress) advances it, so an unattended relaunch reads as idle.
  const lastInteractionRef = useRef<number>(0);

  useEffect(() => {
    if (isLoading || !isAuthenticated) return;

    let mounted = true;
    let deviceId: string | null = null;
    let inFlight = false;

    // Route recordInteraction() into this mount's ref for the effect's lifetime.
    setInteractionSink((now: number) => {
      lastInteractionRef.current = now;
    });

    const flush = () => {
      if (!mounted || !deviceId || inFlight) return;
      if (deviceActivityQueue.size === 0) return;
      const batch: QueuedDeviceEvent[] =
        deviceActivityQueue.drain(MAX_EVENTS_PER_FLUSH);
      if (batch.length === 0) return;
      inFlight = true;
      void recordActivity({ deviceId, events: batch })
        .then(() => {
          deviceActivityQueue.handleFlushSuccess();
        })
        .catch((error: unknown) => {
          // Rejected: keep the events for the next attempt, but a batch the
          // server keeps refusing is dropped after MAX_FLUSH_ATTEMPTS so it
          // cannot wedge the queue. The ceiling still bounds the retries.
          const dropped = deviceActivityQueue.handleFlushFailure(batch);
          console.warn(
            dropped
              ? "[device-activity] flush refused repeatedly; batch dropped"
              : "[device-activity] flush failed",
            error,
          );
        })
        .finally(() => {
          inFlight = false;
        });
    };

    // The app is already foregrounded when this mounts (that is when a scholar
    // signs in), so open the record with it rather than waiting for a change.
    if (AppState.currentState === "active") {
      deviceActivityQueue.recordForeground(Date.now());
    }
    const stuckInactiveWatch = new StuckInactiveWatch(
      deviceActivityQueue,
      flush,
    );
    stuckInactiveWatch.update(AppState.currentState);

    void getStableDeviceId()
      .then((resolved) => {
        if (!mounted) return;
        deviceId = resolved;
        flush();
      })
      .catch((error: unknown) => {
        console.warn("[device-activity] device id unavailable", error);
      });

    const heartbeatTimer = setInterval(() => {
      const now = Date.now();
      // Foregrounded is necessary but not sufficient: only emit while a recent
      // human interaction still vouches for presence (see shouldEmitHeartbeat).
      if (
        !shouldEmitHeartbeat(
          appStateRef.current === "active",
          lastInteractionRef.current,
          now,
        )
      ) {
        return;
      }
      deviceActivityQueue.recordHeartbeat(now);
    }, DEVICE_ACTIVITY_HEARTBEAT_INTERVAL_MS);

    const flushTimer = setInterval(flush, DEVICE_ACTIVITY_FLUSH_INTERVAL_MS);

    const subscription = AppState.addEventListener(
      "change",
      (nextState: AppStateStatus) => {
        const previous = appStateRef.current;
        appStateRef.current = nextState;
        const now = Date.now();
        // Before the foreground below, so a stuck stretch's end precedes it.
        stuckInactiveWatch.update(nextState);
        if (nextState === "active" && previous !== "active") {
          deviceActivityQueue.recordForeground(now);
          flush();
          return;
        }
        if (nextState !== "active" && previous === "active") {
          deviceActivityQueue.recordBackground(now);
          // Best effort on the way out — iOS may suspend before this lands, in
          // which case the batch is simply retried on the next foreground.
          flush();
        }
      },
    );

    return () => {
      mounted = false;
      setInteractionSink(null);
      stuckInactiveWatch.stop();
      clearInterval(heartbeatTimer);
      clearInterval(flushTimer);
      subscription.remove();
    };
  }, [isAuthenticated, isLoading, recordActivity]);
}
