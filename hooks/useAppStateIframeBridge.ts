"use client";

import { useCallback, useEffect, useRef } from "react";
import {
  APP_STATE_MAX_LOG_ENTRIES,
  appActionRegistryWriteDecision,
  appStateFlushDelay,
  createAppStateHostMessage,
  matchesAppStateBridgeNonce,
  mergeAppStateDoc,
  parseAppStateBridgeMessage,
} from "@/lib/appStateBridge.mjs";
import type {
  AppActionRegistration,
  AppActionRequest,
  AppActionResult,
} from "@/shared/appActionPolicy";

type AppStateSnapshot = {
  doc: unknown;
  actions: AppActionRegistration[];
  actionRequest?: AppActionRequest;
  version: number;
  updatedAt: number;
};

export type AppStateHostUpdate = {
  patch?: Record<string, unknown>;
  logs?: Array<{
    level: "log" | "warn" | "error";
    message: string;
  }>;
  actions?: AppActionRegistration[];
  actionResult?: AppActionResult;
};

type SharedAppStateBridge<RoomId extends string> = {
  roomId: RoomId | null | undefined;
  selectionVersion?: number;
  snapshot: AppStateSnapshot | null | undefined;
  presence: unknown[] | undefined;
  persist: (
    roomId: RoomId,
    patch: Record<string, unknown>,
  ) => Promise<unknown>;
  onSelect: (roomId: string) => void;
};

export function useAppStateIframeBridge<RoomId extends string = string>({
  identity,
  snapshot,
  persist,
  shared,
}: {
  identity: string;
  snapshot: AppStateSnapshot | null | undefined;
  persist: (update: AppStateHostUpdate) => Promise<unknown>;
  shared?: SharedAppStateBridge<RoomId>;
}) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const readyWindowRef = useRef<Window | null>(null);
  const nonceRef = useRef<string | null>(null);
  const initializedRef = useRef(false);
  const connectedIdentityRef = useRef<string | null>(null);
  const lastSentVersionRef = useRef<string | null>(null);
  const snapshotRef = useRef(snapshot);
  const persistRef = useRef(persist);
  const pendingPersistRef = useRef<typeof persist | null>(null);
  const pendingPatchRef = useRef<Record<string, unknown>>({});
  const pendingLogsRef = useRef<AppStateHostUpdate["logs"]>([]);
  const pendingActionsRef = useRef<AppActionRegistration[] | undefined>(
    undefined,
  );
  const deferredActionsRef = useRef<AppActionRegistration[] | undefined>(
    undefined,
  );
  const inFlightPatchesRef = useRef<
    Array<{ id: number; identity: string; patch: Record<string, unknown> }>
  >([]);
  const nextWriteIdRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const pendingSinceRef = useRef<number | undefined>(undefined);
  const identityRef = useRef(identity);
  const activeIdentityRef = useRef(identity);
  const sharedRef = useRef(shared);
  const activeSharedRoomRef = useRef(shared?.roomId);
  const pendingSharedPatchRef = useRef<Record<string, unknown>>({});
  const sharedInFlightRef = useRef<
    Array<{ id: number; roomId: RoomId; patch: Record<string, unknown> }>
  >([]);
  const sharedWriteIdRef = useRef(0);
  const sharedTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const sharedPendingSinceRef = useRef<number | undefined>(undefined);

  /* eslint-disable react-hooks/refs -- Stable iframe/window listeners and write queues must read current committed host inputs. */
  snapshotRef.current = snapshot;
  persistRef.current = persist;
  activeIdentityRef.current = identity;
  sharedRef.current = shared;
  /* eslint-enable react-hooks/refs */

  const postSnapshot = useCallback(() => {
    const frameWindow = readyWindowRef.current;
    const nonce = nonceRef.current;
    const current = snapshotRef.current;
    if (
      !frameWindow ||
      !nonce ||
      current === undefined ||
      connectedIdentityRef.current !== activeIdentityRef.current
    ) {
      return;
    }
    const type = initializedRef.current ? "update" : "init";
    const pendingPatches = [
      ...inFlightPatchesRef.current
        .filter((entry) => entry.identity === activeIdentityRef.current)
        .map((entry) => entry.patch),
      pendingPatchRef.current,
    ];
    const sharedValue = sharedRef.current;
    const sharedMessage =
      sharedValue?.roomId === null
        ? null
        : typeof sharedValue?.roomId === "string" &&
            sharedValue.snapshot !== undefined &&
            sharedValue.presence !== undefined
          ? {
              roomId: sharedValue.roomId,
              doc: mergeAppStateDoc(sharedValue.snapshot?.doc, [
                ...sharedInFlightRef.current
                  .filter((entry) => entry.roomId === sharedValue.roomId)
                  .map((entry) => entry.patch),
                pendingSharedPatchRef.current,
              ]),
              presence: sharedValue.presence,
            }
          : undefined;
    frameWindow.postMessage(
      createAppStateHostMessage(
        type,
        mergeAppStateDoc(current?.doc, pendingPatches),
        nonce,
        sharedMessage,
        current?.actionRequest,
      ),
      "*",
    );
    initializedRef.current = true;
    lastSentVersionRef.current = current
      ? `${current.version}:${current.updatedAt}`
      : "empty";
  }, []);

  const flushShared = useCallback(() => {
    clearTimeout(sharedTimerRef.current);
    sharedTimerRef.current = undefined;
    sharedPendingSinceRef.current = undefined;
    const roomId = activeSharedRoomRef.current;
    const writer = sharedRef.current?.persist;
    const patch = pendingSharedPatchRef.current;
    pendingSharedPatchRef.current = {};
    if (!roomId || !writer || Object.keys(patch).length === 0) return;
    const writeId = sharedWriteIdRef.current++;
    sharedInFlightRef.current.push({ id: writeId, roomId, patch });
    void writer(roomId, patch)
      .then(() => {
        sharedInFlightRef.current = sharedInFlightRef.current.filter(
          (entry) => entry.id !== writeId,
        );
      })
      .catch((error) => {
        sharedInFlightRef.current = sharedInFlightRef.current.filter(
          (entry) => entry.id !== writeId,
        );
        postSnapshot();
        console.error("[rabbithole] failed to persist shared app state", error);
      });
  }, [postSnapshot]);

  const flush = useCallback((identityOverride?: string) => {
    clearTimeout(timerRef.current);
    timerRef.current = undefined;
    pendingSinceRef.current = undefined;
    const writer = pendingPersistRef.current;
    const patch = pendingPatchRef.current;
    const logs = pendingLogsRef.current ?? [];
    const actions = pendingActionsRef.current;
    pendingPersistRef.current = null;
    pendingPatchRef.current = {};
    pendingLogsRef.current = [];
    pendingActionsRef.current = undefined;
    if (
      !writer ||
      (Object.keys(patch).length === 0 &&
        logs.length === 0 &&
        actions === undefined)
    ) {
      return;
    }
    const writeId = nextWriteIdRef.current++;
    const writeIdentity = identityOverride ?? activeIdentityRef.current;
    if (Object.keys(patch).length > 0) {
      inFlightPatchesRef.current.push({
        id: writeId,
        identity: writeIdentity,
        patch,
      });
    }
    void writer({
      patch: Object.keys(patch).length > 0 ? patch : undefined,
      logs: logs.length > 0 ? logs : undefined,
      actions,
    })
      .then(() => {
        inFlightPatchesRef.current = inFlightPatchesRef.current.filter(
          (entry) => entry.id !== writeId,
        );
      })
      .catch((error) => {
        inFlightPatchesRef.current = inFlightPatchesRef.current.filter(
          (entry) => entry.id !== writeId,
        );
        if (activeIdentityRef.current === writeIdentity) {
          pendingPatchRef.current = {
            ...patch,
            ...pendingPatchRef.current,
          };
          pendingLogsRef.current = [
            ...logs,
            ...(pendingLogsRef.current ?? []),
          ].slice(-APP_STATE_MAX_LOG_ENTRIES);
          if (
            actions !== undefined &&
            pendingActionsRef.current === undefined
          ) {
            pendingActionsRef.current = actions;
          }
          pendingPersistRef.current = writer;
        }
        console.error("[rabbithole] failed to persist app state", error);
      });
  }, []);

  const queueActions = useCallback(
    (actions: AppActionRegistration[]) => {
      const current = snapshotRef.current;
      const decision = appActionRegistryWriteDecision(
        current === null ? null : current?.actions,
        actions,
      );
      if (decision === "defer") {
        deferredActionsRef.current = actions;
        return;
      }
      deferredActionsRef.current = undefined;
      if (decision === "skip") {
        pendingActionsRef.current = undefined;
        return;
      }
      pendingActionsRef.current = actions;
      pendingPersistRef.current ??= persistRef.current;
      pendingSinceRef.current ??= Date.now();
      clearTimeout(timerRef.current);
      timerRef.current = setTimeout(
        flush,
        appStateFlushDelay(pendingSinceRef.current),
      );
    },
    [flush],
  );

  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      const frameWindow = iframeRef.current?.contentWindow;
      // A sandboxed srcDoc has an opaque origin, so the WindowProxy is the
      // authentication boundary; `event.origin` is always "null".
      if (!frameWindow || event.source !== frameWindow) return;
      const message = parseAppStateBridgeMessage(event.data);
      if (!message) return;
      if (message.type === "ready") {
        readyWindowRef.current = frameWindow;
        nonceRef.current = message.nonce;
        connectedIdentityRef.current = activeIdentityRef.current;
        initializedRef.current = false;
        lastSentVersionRef.current = null;
        postSnapshot();
        return;
      }
      if (!matchesAppStateBridgeNonce(message, nonceRef.current)) return;
      if (message.type === "sharedSelect") {
        sharedRef.current?.onSelect(message.roomId);
        return;
      }
      if (message.type === "sharedChange") {
        if (message.roomId !== activeSharedRoomRef.current) return;
        pendingSharedPatchRef.current = {
          ...pendingSharedPatchRef.current,
          ...message.patch,
        };
        sharedPendingSinceRef.current ??= Date.now();
        clearTimeout(sharedTimerRef.current);
        sharedTimerRef.current = setTimeout(
          flushShared,
          appStateFlushDelay(sharedPendingSinceRef.current),
        );
        return;
      }
      if (message.type === "actionResult") {
        const actionResult: AppActionResult = message.ok
          ? {
              requestId: message.requestId,
              ok: true,
              result: message.result,
            }
          : {
              requestId: message.requestId,
              ok: false,
              error: message.error,
            };
        void persistRef
          .current({ actionResult })
          .catch((error) =>
            console.error(
              "[rabbithole] failed to acknowledge app action",
              error,
            ),
          );
        return;
      }
      if (message.type === "actions") {
        if (message.actions === undefined) return;
        queueActions(message.actions);
        return;
      }

      if (message.patch) {
        pendingPatchRef.current = {
          ...pendingPatchRef.current,
          ...message.patch,
        };
      }
      if (message.logs?.length) {
        pendingLogsRef.current = [
          ...(pendingLogsRef.current ?? []),
          ...message.logs,
        ].slice(-APP_STATE_MAX_LOG_ENTRIES);
      }
      pendingPersistRef.current ??= persistRef.current;
      pendingSinceRef.current ??= Date.now();
      clearTimeout(timerRef.current);
      timerRef.current = setTimeout(
        flush,
        appStateFlushDelay(pendingSinceRef.current),
      );
    };

    window.addEventListener("message", handleMessage);
    return () => {
      window.removeEventListener("message", handleMessage);
      flush();
      flushShared();
    };
  }, [flush, flushShared, postSnapshot, queueActions]);

  useEffect(() => {
    const current = snapshot;
    if (!readyWindowRef.current || current === undefined) return;
    const deferredActions = deferredActionsRef.current;
    if (deferredActions !== undefined) queueActions(deferredActions);
    const version = current
      ? `${current.version}:${current.updatedAt}`
      : "empty";
    if (version !== lastSentVersionRef.current) postSnapshot();
  }, [postSnapshot, queueActions, snapshot]);

  useEffect(() => {
    postSnapshot();
  }, [
    postSnapshot,
    shared?.presence,
    shared?.roomId,
    shared?.selectionVersion,
    shared?.snapshot,
  ]);

  useEffect(() => {
    if (identityRef.current === identity) return;
    flush(identityRef.current);
    readyWindowRef.current = null;
    nonceRef.current = null;
    initializedRef.current = false;
    connectedIdentityRef.current = null;
    lastSentVersionRef.current = null;
    deferredActionsRef.current = undefined;
    identityRef.current = identity;
  }, [flush, identity]);

  useEffect(() => {
    const previous = activeSharedRoomRef.current;
    const next = shared?.roomId;
    if (previous === next) return;
    if (typeof previous === "string") flushShared();
    pendingSharedPatchRef.current = {};
    sharedInFlightRef.current = [];
    activeSharedRoomRef.current = next;
    postSnapshot();
  }, [flushShared, postSnapshot, shared?.roomId]);

  const onLoad = useCallback(() => {
    readyWindowRef.current = iframeRef.current?.contentWindow ?? null;
    lastSentVersionRef.current = null;
    postSnapshot();
  }, [postSnapshot]);

  return { iframeRef, onLoad };
}
