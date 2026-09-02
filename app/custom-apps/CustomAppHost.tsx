"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { useAppStateIframeBridge } from "@/hooks/useAppStateIframeBridge";
import type { AppStateHostUpdate } from "@/hooks/useAppStateIframeBridge";
import {
  CUSTOM_APP_STATE_MIN_WRITE_INTERVAL_MS,
  isCustomAppStateRateLimitErrorData,
} from "@/shared/appStatePolicy";

const DEVICE_KEY_STORAGE = "rabbithole:app-state-device-v1";
const APP_STATE_KEY = "default";
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
}: {
  token: string;
  name: string;
  srcDoc: string;
  csp: string;
}) {
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
    deviceKey
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
    identity: `customApp:${token}`,
    snapshot,
    persist,
  });

  return (
    <iframe
      key={token}
      ref={iframeRef}
      title={name}
      srcDoc={srcDoc}
      onLoad={onLoad}
      {...({ csp } as { csp: string })}
      referrerPolicy="no-referrer"
      sandbox="allow-scripts allow-forms allow-popups allow-modals"
      style={{
        position: "fixed",
        inset: 0,
        width: "100%",
        height: "100%",
        border: "none",
      }}
    />
  );
}
