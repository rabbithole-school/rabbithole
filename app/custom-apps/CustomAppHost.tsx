"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useConvexAuth, useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { useAppStateIframeBridge } from "@/hooks/useAppStateIframeBridge";
import type { AppStateHostUpdate } from "@/hooks/useAppStateIframeBridge";
import {
  CUSTOM_APP_STATE_MIN_WRITE_INTERVAL_MS,
  isCustomAppStateRateLimitErrorData,
} from "@/shared/appStatePolicy";
import { useCustomAppActivity } from "./useCustomAppActivity";

const DEVICE_KEY_STORAGE = "rabbithole:app-state-device-v1";
const APP_STATE_KEY = "default";
const CREDIT_BAR_PX = 28;
function newDeviceKey(): string {
  if (typeof crypto.randomUUID === "function") {
    return `anon:${crypto.randomUUID()}`;
  }
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return `anon:${Array.from(bytes, (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("")}`;
}

export function CustomAppHost({
  token,
  name,
  srcDoc,
  csp,
  credit,
  trackLaunch,
}: {
  token: string;
  name: string;
  srcDoc: string;
  csp: string;
  /** "Made by <first name>" under a scholar's published app. */
  credit: string | null;
  /** False when a web assignment opened this page: its own session row
   *  already records the visit. */
  trackLaunch: boolean;
}) {
  useCustomAppActivity(token, trackLaunch);
  // A signed-in viewer's state is their own (keyed server-side to their user,
  // convex/appStates.ts customAppPartition); a signed-out one's is the
  // device's. Until auth settles the server can't tell which, so nothing
  // reads or writes state, and the app doesn't mount, before then.
  const { isLoading: authLoading, isAuthenticated } = useConvexAuth();
  // Signing in or out in another tab changes whose partition this app saves
  // to. The open app still holds what it loaded from the old one, so start it
  // over from the new one rather than let it save that across.
  const partitionKey = `${token}:${isAuthenticated ? "user" : "device"}`;
  const [deviceKey, setDeviceKey] = useState<string | null>(null);
  const updateState = useMutation(api.appStates.updateCustomAppState);
  const writeQueueRef = useRef<Promise<void>>(Promise.resolve());
  const lastWriteAtRef = useRef(0);

  useEffect(() => {
    try {
      const stored = localStorage.getItem(DEVICE_KEY_STORAGE);
      if (stored) {
        // eslint-disable-next-line react-hooks/set-state-in-effect -- initialize the client-only device identity from persistent storage after mount.
        setDeviceKey(stored);
        return;
      }
      const created = newDeviceKey();
      localStorage.setItem(DEVICE_KEY_STORAGE, created);
      setDeviceKey(created);
    } catch (error) {
      const temporary = newDeviceKey();
      console.warn(
        "[rabbithole] app-state device key could not be persisted; using a temporary key",
        error,
      );
      setDeviceKey(temporary);
    }
  }, []);

  const snapshot = useQuery(
    api.appStates.getCustomAppState,
    deviceKey && !authLoading
      ? { token, userId: deviceKey, key: APP_STATE_KEY }
      : "skip",
  );
  const persist = useCallback(
    async (update: AppStateHostUpdate) => {
      if (!deviceKey) {
        throw new Error("Custom app state cannot persist before device setup");
      }
      if (update.actionResult) {
        throw new Error("Static custom apps cannot acknowledge tutor actions");
      }
      const write = writeQueueRef.current.then(async () => {
        const waitMs = Math.max(
          0,
          lastWriteAtRef.current +
            CUSTOM_APP_STATE_MIN_WRITE_INTERVAL_MS -
            Date.now(),
        );
        if (waitMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, waitMs));
        }
        while (true) {
          try {
            const result = await updateState({
              token,
              userId: deviceKey,
              key: APP_STATE_KEY,
              patch: update.patch,
              logs: update.logs,
              actions: update.actions,
            });
            lastWriteAtRef.current = Date.now();
            return result;
          } catch (error) {
            const data =
              error && typeof error === "object" && "data" in error
                ? (error as { data?: unknown }).data
                : undefined;
            if (!isCustomAppStateRateLimitErrorData(data)) {
              throw error;
            }
            // Tabs share the host-origin device key but not React refs. A small
            // jitter lets two legitimate tabs converge after one loses the
            // server-enforced per-partition race.
            await new Promise((resolve) =>
              setTimeout(
                resolve,
                data.retryAfterMs + Math.floor(Math.random() * 100),
              ),
            );
          }
        }
      });
      writeQueueRef.current = write.then(
        () => undefined,
        () => undefined,
      );
      return await write;
    },
    [deviceKey, token, updateState],
  );
  const { iframeRef, onLoad } = useAppStateIframeBridge({
    identity: `customApp:${partitionKey}`,
    snapshot,
    persist,
  });

  // The frame mounts only after hydration (the device key is set in an
  // effect). Rendered on the server, the srcdoc could load and send its
  // bridge `ready` before the host's message listener existed, and the app
  // would never receive `init`: its `subscribe` callbacks never fire, so an
  // app that waits for saved state before letting the scholar type stays
  // stuck. The state can't load before the device key and settled auth anyway.
  if (!deviceKey || authLoading) return null;

  const frame = (
    <iframe
      key={partitionKey}
      ref={iframeRef}
      title={name}
      srcDoc={srcDoc}
      onLoad={onLoad}
      {...({ csp } as { csp: string })}
      referrerPolicy="no-referrer"
      sandbox="allow-scripts allow-forms allow-popups allow-modals"
      style={{
        position: "fixed",
        top: 0,
        left: 0,
        width: "100%",
        height: credit ? `calc(100% - ${CREDIT_BAR_PX}px)` : "100%",
        border: "none",
      }}
    />
  );
  if (!credit) return frame;
  // Below the app, never over it: an overlay would cover the app's own UI.
  return (
    <>
      {frame}
      <div
        style={{
          position: "fixed",
          left: 0,
          right: 0,
          bottom: 0,
          height: CREDIT_BAR_PX,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "#ffffff",
          borderTop: "1px solid #e5e7eb",
          color: "#64748b",
          fontSize: 13,
          fontWeight: 600,
          fontFamily: "var(--font-hanken-grotesk), system-ui, sans-serif",
        }}
      >
        Made by {credit}
      </div>
    </>
  );
}
