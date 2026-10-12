"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import * as appStateBridgeRuntime from "@/lib/appStateBridge.mjs";
import {
  APP_STATE_MAX_LOG_ENTRIES,
  appActionRegistryWriteDecision,
  appStateFlushDelay,
  createAppBridgeResponseMessage,
  createAppStateHostMessage,
  injectAppStateSdk,
  matchesAppStateBridgeNonce,
  mergeAppStateDoc,
  parseAppStateBridgeMessage,
} from "@/lib/appStateBridge.mjs";
import type { Id } from "@/convex/_generated/dataModel";
import type {
  AppActionRegistration,
  AppActionRequest,
  AppActionResult,
} from "@/shared/appActionPolicy";
import { prepareCustomAppSandbox } from "@/shared/customAppSandbox";
import {
  forwardAppTutorRequest,
  type AppTutorRequest,
} from "@/shared/appTutorRequest";

export { forwardAppTutorRequest } from "@/shared/appTutorRequest";
import type { AppAssetUrlResolver } from "@/shared/appAssets";
import type {
  AppBridgeResponsePayload,
  CharacterLine,
} from "@/shared/appAiPolicy";
import {
  appBridgeFailure,
  deliverAppBridgeReply,
  routeAppBridgeRequest,
  type AppBridgeRequest,
} from "@/shared/appBridgeRequest";

const NO_APP_ASSET_URL = () => undefined;
const EMPTY_APP_ASSET_URLS = new Map<string, string>();

const {
  APP_SNAPSHOT_MAX_WIDTH,
  APP_SNAPSHOT_READY_TYPE,
  APP_SNAPSHOT_RESULT_TYPE,
  APP_SNAPSHOT_TIMEOUT_MS,
  createAppSnapshotRequestMessage,
} = appStateBridgeRuntime as typeof appStateBridgeRuntime & {
  APP_SNAPSHOT_MAX_WIDTH: 800;
  APP_SNAPSHOT_READY_TYPE: "rabbithole:snapshot:ready";
  APP_SNAPSHOT_RESULT_TYPE: "rabbithole:snapshot:result";
  APP_SNAPSHOT_TIMEOUT_MS: 6_000;
  createAppSnapshotRequestMessage: (
    nonce: string,
    requestId: string,
    maxWidth?: number,
    width?: number,
    height?: number,
  ) => Record<string, unknown>;
};

type AppSnapshotBridgeMessage =
  | {
      type: "rabbithole:snapshot:ready";
      nonce: string;
    }
  | {
      type: "rabbithole:snapshot:result";
      nonce: string;
      requestId: string;
      dataUrl: string;
      hash: string;
    }
  | {
      type: "rabbithole:snapshot:result";
      nonce: string;
      requestId: string;
      error: string;
    };

const parseBridgeMessage = parseAppStateBridgeMessage as (
  value: unknown,
) =>
  | NonNullable<ReturnType<typeof parseAppStateBridgeMessage>>
  | AppSnapshotBridgeMessage
  | null;

type AppStateSnapshot = {
  doc: unknown;
  actions: AppActionRegistration[];
  actionRequest?: AppActionRequest;
  /** A line the tutor speaks through the app's character (owner host only). */
  characterLine?: CharacterLine | null;
  log?: Array<{
    level: "log" | "warn" | "error";
    message: string;
    at: number;
  }>;
  version: number;
  updatedAt: number;
};

export type AppStateIframeSandbox = {
  csp: string;
  srcDoc: string;
};

export async function createAppStateIframeSandbox(
  html: string,
  snapshot: AppStateSnapshot | null | undefined,
  resolveAssetUrl: AppAssetUrlResolver = NO_APP_ASSET_URL,
): Promise<AppStateIframeSandbox | null> {
  return snapshot === undefined
    ? null
    : await prepareCustomAppSandbox(html, injectAppStateSdk, resolveAssetUrl);
}

export async function createAppStateIframeSrcDoc(
  html: string,
  snapshot: AppStateSnapshot | null | undefined,
  resolveAssetUrl: AppAssetUrlResolver = NO_APP_ASSET_URL,
): Promise<string | null> {
  return (
    await createAppStateIframeSandbox(html, snapshot, resolveAssetUrl)
  )?.srcDoc ?? null;
}

export function useAppStateIframeSrcDoc(
  html: string,
  snapshot: AppStateSnapshot | null | undefined,
  assetUrls: ReadonlyMap<string, string> | null = EMPTY_APP_ASSET_URLS,
): AppStateIframeSandbox | null {
  const requestedHtml =
    snapshot === undefined || assetUrls === null ? null : html;
  const [prepared, setPrepared] = useState<{
    html: string;
    sandbox?: AppStateIframeSandbox;
    error?: unknown;
  } | null>(null);

  useEffect(() => {
    if (requestedHtml === null) return;

    let cancelled = false;
    void createAppStateIframeSandbox(
      requestedHtml,
      null,
      (assetId) => assetUrls?.get(assetId),
    ).then(
      (sandbox) => {
        if (!cancelled) {
          setPrepared({
            html: requestedHtml,
            sandbox: sandbox ?? undefined,
          });
        }
      },
      (error: unknown) => {
        if (!cancelled) setPrepared({ html: requestedHtml, error });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [assetUrls, requestedHtml]);

  if (requestedHtml === null || prepared?.html !== requestedHtml) return null;
  if (prepared.error !== undefined) throw prepared.error;
  return prepared.sandbox ?? null;
}

export type AppStateHostUpdate = {
  patch?: Record<string, unknown>;
  logs?: Array<{
    level: "log" | "warn" | "error";
    message: string;
  }>;
  actions?: AppActionRegistration[];
  actionResult?: AppActionResult;
};

export type AppSnapshotCapture = {
  image: AppSnapshotImageCapture | null;
  consoleLines: string[];
  stateJson: string;
};

export type AppSnapshotLoadBoundary = {
  loadVersion: number;
  nonce: string | null;
};

type AppSnapshotImageCapture = {
  dataUrl: string;
  hash: string;
};

export type CaptureAppSnapshot = ((
  afterLoad?: AppSnapshotLoadBoundary,
  deadlineAt?: number,
) => Promise<AppSnapshotCapture>) & {
  currentLoadBoundary: () => AppSnapshotLoadBoundary;
};

/** Compose the capture function with its load-boundary reader. Call it from an
 *  effect (CodeArtifactViewer does), never during render: the React Compiler
 *  reads the composition as a ref access when it happens in a useMemo. */
export function withLoadBoundary(
  capture: (
    afterLoad?: AppSnapshotLoadBoundary,
    deadlineAt?: number,
  ) => Promise<AppSnapshotCapture>,
  currentLoadBoundary: () => AppSnapshotLoadBoundary,
): CaptureAppSnapshot {
  return Object.assign(
    (afterLoad?: AppSnapshotLoadBoundary, deadlineAt?: number) =>
      capture(afterLoad, deadlineAt),
    { currentLoadBoundary },
  );
}

type AppSnapshotConsoleEntry = {
  level: "log" | "warn" | "error";
  message: string;
};

const SNAPSHOT_CAPTURE_CONSOLE_NOISE =
  /Error while reading CSS rules from/;

export function collectAppSnapshotConsoleLines(
  logs: readonly AppSnapshotConsoleEntry[],
): string[] {
  const latestLogs = logs
    .filter(
      (entry) => !SNAPSHOT_CAPTURE_CONSOLE_NOISE.test(entry.message),
    )
    .slice(-40);
  return [
    ...latestLogs.filter((entry) => entry.level === "error"),
    ...latestLogs.filter((entry) => entry.level === "warn"),
    ...latestLogs.filter((entry) => entry.level === "log"),
  ].map((entry) => `[${entry.level}] ${entry.message}`.slice(0, 500));
}

const APP_SNAPSHOT_UPLOAD_MAX_BYTES = 400 * 1024;

function appSnapshotDataUrlToBlob(dataUrl: string): Blob {
  const match = /^data:(image\/(?:jpeg|png));base64,(.+)$/.exec(dataUrl);
  if (!match) throw new Error("App snapshot was not a JPEG or PNG data URL");
  const binary = atob(match[2]);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) {
    bytes[index] = binary.charCodeAt(index);
  }
  return new Blob([bytes], { type: match[1] });
}

type UploadAppSnapshotArgs = {
  captureSnapshot: CaptureAppSnapshot | null;
  lastSentHash: string | null;
  generateUploadUrl: () => Promise<string>;
  force?: boolean;
  afterLoad?: AppSnapshotLoadBoundary;
  deadlineAt?: number;
};

type UploadedAppSnapshot = {
  storageId: Id<"_storage">;
  hash: string;
};

type AppSnapshotCaptureUploadResult = {
  storageId: Id<"_storage"> | null;
  hash: string | null;
  consoleLines: string[];
  stateJson: string;
};

export function uploadChangedAppSnapshot(
  args: UploadAppSnapshotArgs & { returnCaptureOnUploadSkip: true },
): Promise<AppSnapshotCaptureUploadResult | null>;
export function uploadChangedAppSnapshot(
  args: UploadAppSnapshotArgs & { returnCaptureOnUploadSkip?: false },
): Promise<UploadedAppSnapshot | null>;
export async function uploadChangedAppSnapshot({
  captureSnapshot,
  lastSentHash,
  generateUploadUrl,
  force = false,
  afterLoad,
  deadlineAt,
  returnCaptureOnUploadSkip = false,
}: UploadAppSnapshotArgs & {
  returnCaptureOnUploadSkip?: boolean;
}): Promise<
  AppSnapshotCaptureUploadResult | UploadedAppSnapshot | null
> {
  if (!captureSnapshot) return null;
  const capture = await captureSnapshot(afterLoad, deadlineAt);
  const skipped = {
    storageId: null,
    hash: capture.image?.hash ?? null,
    consoleLines: capture.consoleLines,
    stateJson: capture.stateJson,
  };
  if (!capture.image) {
    return returnCaptureOnUploadSkip ? skipped : null;
  }
  if (!force && capture.image.hash === lastSentHash) return null;
  const blob = appSnapshotDataUrlToBlob(capture.image.dataUrl);
  if (blob.size > APP_SNAPSHOT_UPLOAD_MAX_BYTES) {
    console.warn(
      `[rabbithole] app snapshot is ${blob.size} bytes; sending without it`,
    );
    return returnCaptureOnUploadSkip ? skipped : null;
  }
  if (deadlineAt !== undefined && performance.now() >= deadlineAt) {
    return returnCaptureOnUploadSkip ? skipped : null;
  }
  let uploadUrl: string;
  try {
    uploadUrl = await generateUploadUrl();
  } catch (error) {
    if (!returnCaptureOnUploadSkip) throw error;
    console.warn("[rabbithole] app snapshot upload URL failed:", error);
    return skipped;
  }
  if (deadlineAt !== undefined && performance.now() >= deadlineAt) {
    return returnCaptureOnUploadSkip ? skipped : null;
  }
  const uploadController =
    deadlineAt === undefined ? null : new AbortController();
  const uploadTimer =
    uploadController && deadlineAt !== undefined
      ? setTimeout(
          () => uploadController.abort(),
          Math.max(0, deadlineAt - performance.now()),
        )
      : null;
  let response: Response;
  try {
    response = await fetch(uploadUrl, {
      method: "POST",
      headers: { "Content-Type": blob.type },
      body: blob,
      ...(uploadController ? { signal: uploadController.signal } : {}),
    });
  } catch (error) {
    if (!returnCaptureOnUploadSkip) throw error;
    console.warn("[rabbithole] app snapshot upload failed:", error);
    return skipped;
  } finally {
    if (uploadTimer) clearTimeout(uploadTimer);
  }
  if (!response.ok) {
    if (!returnCaptureOnUploadSkip) {
      throw new Error(`App snapshot upload failed (${response.status})`);
    }
    console.warn(
      `[rabbithole] app snapshot upload failed (${response.status})`,
    );
    return skipped;
  }
  const result = (await response.json()) as { storageId?: unknown };
  if (typeof result.storageId !== "string" || !result.storageId) {
    if (!returnCaptureOnUploadSkip) {
      throw new Error("App snapshot upload returned no storage id");
    }
    console.warn("[rabbithole] app snapshot upload returned no storage id");
    return skipped;
  }
  return {
    storageId: result.storageId as Id<"_storage">,
    hash: capture.image.hash,
    consoleLines: capture.consoleLines,
    stateJson: capture.stateJson,
  };
}

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

/** Answers a frame `request` (character.say / judge). Hosts without one —
 *  e.g. custom-app tiles, which have no session — answer `unavailable`. */
export type AppBridgeRequestHandler = (
  request: AppBridgeRequest,
) => Promise<AppBridgeResponsePayload>;

// Keyed on the character line too, so a spoken line always reaches the frame
// even if its writer forgot to bump the row's version.
function snapshotVersionKey(current: AppStateSnapshot | null | undefined) {
  return current
    ? `${current.version}:${current.updatedAt}:${current.characterLine?.id ?? ""}`
    : "empty";
}

export function useAppStateIframeBridge<RoomId extends string = string>({
  identity,
  snapshot,
  persist,
  shared,
  onAskTutor,
  onRequest,
  onAppAiTurn,
}: {
  identity: string;
  snapshot: AppStateSnapshot | null | undefined;
  persist: (update: AppStateHostUpdate) => Promise<unknown>;
  shared?: SharedAppStateBridge<RoomId>;
  onAskTutor?: (request: AppTutorRequest) => void | Promise<void>;
  onRequest?: AppBridgeRequestHandler;
  /** A character/judge success reached the app (see deliverAppBridgeReply). */
  onAppAiTurn?: () => void;
}) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const readyWindowRef = useRef<Window | null>(null);
  const nonceRef = useRef<string | null>(null);
  const snapshotReadyWindowRef = useRef<Window | null>(null);
  const snapshotNonceRef = useRef<string | null>(null);
  const snapshotIdentityRef = useRef<string | null>(null);
  const frameLoadVersionRef = useRef(0);
  const settledFrameLoadVersionRef = useRef(0);
  const warnedSnapshotCaptureErrorRef = useRef(false);
  const nextSnapshotRequestIdRef = useRef(0);
  const pendingSnapshotRequestsRef = useRef(
    new Map<
      string,
      {
        resolve: (snapshot: AppSnapshotImageCapture | null) => void;
        timer: ReturnType<typeof setTimeout>;
      }
    >(),
  );
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
  const inFlightLogsRef = useRef<
    Array<{
      id: number;
      identity: string;
      logs: NonNullable<AppStateHostUpdate["logs"]>;
    }>
  >([]);
  const inFlightWritesRef = useRef<
    Array<{ id: number; identity: string; promise: Promise<boolean> }>
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
  const onAskTutorRef = useRef(onAskTutor);
  const onRequestRef = useRef(onRequest);
  const onAppAiTurnRef = useRef(onAppAiTurn);

  /* eslint-disable react-hooks/refs -- Stable iframe/window listeners and write queues must read current committed host inputs. */
  snapshotRef.current = snapshot;
  persistRef.current = persist;
  activeIdentityRef.current = identity;
  sharedRef.current = shared;
  onAskTutorRef.current = onAskTutor;
  onRequestRef.current = onRequest;
  onAppAiTurnRef.current = onAppAiTurn;
  /* eslint-enable react-hooks/refs */

  const clearPendingSnapshotRequests = useCallback(() => {
    for (const pending of pendingSnapshotRequestsRef.current.values()) {
      clearTimeout(pending.timer);
      pending.resolve(null);
    }
    pendingSnapshotRequestsRef.current.clear();
  }, []);

  const waitForSnapshotReady = useCallback(async (
    afterLoad?: AppSnapshotLoadBoundary,
    deadlineAt?: number,
  ) => {
    const targetLoad =
      afterLoad
        ? afterLoad.loadVersion + 1
        : Math.max(1, frameLoadVersionRef.current);
    const deadline =
      deadlineAt ?? performance.now() + APP_SNAPSHOT_TIMEOUT_MS;
    return await new Promise<boolean>((resolve) => {
      const check = () => {
        const frameWindow = iframeRef.current?.contentWindow ?? null;
        const ready =
          settledFrameLoadVersionRef.current >= targetLoad &&
          frameWindow !== null &&
          frameWindow === snapshotReadyWindowRef.current &&
          snapshotNonceRef.current !== null &&
          (!afterLoad || snapshotNonceRef.current !== afterLoad.nonce) &&
          snapshotIdentityRef.current === activeIdentityRef.current;
        if (ready) {
          requestAnimationFrame(() => resolve(true));
          return;
        }
        if (performance.now() >= deadline) {
          resolve(false);
          return;
        }
        requestAnimationFrame(check);
      };
      check();
    });
  }, []);

  const readCaptureContext = useCallback(() => {
    const current = snapshotRef.current;
    const doc = mergeAppStateDoc(current?.doc, [
      ...inFlightPatchesRef.current
        .filter((entry) => entry.identity === activeIdentityRef.current)
        .map((entry) => entry.patch),
      pendingPatchRef.current,
    ]);
    const logs = [
      ...(current?.log ?? []),
      ...inFlightLogsRef.current
        .filter((entry) => entry.identity === activeIdentityRef.current)
        .flatMap((entry) => entry.logs),
      ...(pendingLogsRef.current ?? []),
    ];
    return {
      consoleLines: collectAppSnapshotConsoleLines(logs),
      stateJson: JSON.stringify(doc ?? {}),
    };
  }, []);

  const captureSnapshotBase = useCallback(async (
    afterLoad?: AppSnapshotLoadBoundary,
    deadlineAt?: number,
  ): Promise<AppSnapshotCapture> => {
    const ready = await waitForSnapshotReady(afterLoad, deadlineAt);
    const frame = iframeRef.current;
    const frameWindow = frame?.contentWindow ?? null;
    const nonce = snapshotNonceRef.current;
    if (
      !ready ||
      !frame ||
      !frameWindow ||
      frameWindow !== snapshotReadyWindowRef.current ||
      !nonce ||
      snapshotIdentityRef.current !== activeIdentityRef.current
    ) {
      return { image: null, ...readCaptureContext() };
    }
    const requestId =
      `${activeIdentityRef.current}:snapshot:` +
      nextSnapshotRequestIdRef.current++;
    const remaining =
      deadlineAt === undefined
        ? APP_SNAPSHOT_TIMEOUT_MS
        : Math.max(0, deadlineAt - performance.now());
    if (remaining === 0) {
      return { image: null, ...readCaptureContext() };
    }
    const image = await new Promise<AppSnapshotImageCapture | null>((resolve) => {
      const timer = setTimeout(() => {
        pendingSnapshotRequestsRef.current.delete(requestId);
        resolve(null);
      }, Math.min(APP_SNAPSHOT_TIMEOUT_MS, remaining));
      pendingSnapshotRequestsRef.current.set(requestId, { resolve, timer });
      frameWindow.postMessage(
        createAppSnapshotRequestMessage(
          nonce,
          requestId,
          APP_SNAPSHOT_MAX_WIDTH,
          frame.clientWidth,
          frame.clientHeight,
        ),
        "*",
      );
    });
    return { image, ...readCaptureContext() };
  }, [readCaptureContext, waitForSnapshotReady]);
  const currentLoadBoundary = useCallback(
    (): AppSnapshotLoadBoundary => ({
      loadVersion: settledFrameLoadVersionRef.current,
      nonce: snapshotNonceRef.current,
    }),
    [],
  );


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
        current?.characterLine,
      ),
      "*",
    );
    initializedRef.current = true;
    lastSentVersionRef.current = snapshotVersionKey(current);
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

  const flush = useCallback(
    (identityOverride?: string): Promise<boolean> => {
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
        const activeWrites = inFlightWritesRef.current
          .filter((entry) => entry.identity === activeIdentityRef.current)
          .map((entry) => entry.promise);
        return activeWrites.length > 0
          ? Promise.all(activeWrites).then((results) =>
              results.every(Boolean),
            )
          : Promise.resolve(true);
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
      if (logs.length > 0) {
        inFlightLogsRef.current.push({
          id: writeId,
          identity: writeIdentity,
          logs,
        });
      }
      const writePromise = writer({
        patch: Object.keys(patch).length > 0 ? patch : undefined,
        logs: logs.length > 0 ? logs : undefined,
        actions,
      })
        .then(() => {
          inFlightPatchesRef.current = inFlightPatchesRef.current.filter(
            (entry) => entry.id !== writeId,
          );
          inFlightLogsRef.current = inFlightLogsRef.current.filter(
            (entry) => entry.id !== writeId,
          );
          return true;
        })
        .catch((error) => {
          inFlightPatchesRef.current = inFlightPatchesRef.current.filter(
            (entry) => entry.id !== writeId,
          );
          inFlightLogsRef.current = inFlightLogsRef.current.filter(
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
          return false;
        })
        .finally(() => {
          inFlightWritesRef.current = inFlightWritesRef.current.filter(
            (entry) => entry.id !== writeId,
          );
        });
      inFlightWritesRef.current.push({
        id: writeId,
        identity: writeIdentity,
        promise: writePromise,
      });
      return writePromise;
    },
    [],
  );

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
      const message = parseBridgeMessage(event.data);
      if (!message) return;
      if (message.type === APP_SNAPSHOT_READY_TYPE) {
        if (
          snapshotNonceRef.current !== message.nonce
        ) {
          clearPendingSnapshotRequests();
          warnedSnapshotCaptureErrorRef.current = false;
        }
        snapshotReadyWindowRef.current = frameWindow;
        snapshotNonceRef.current = message.nonce;
        snapshotIdentityRef.current = activeIdentityRef.current;
        return;
      }
      if (message.type === APP_SNAPSHOT_RESULT_TYPE) {
        if (
          !matchesAppStateBridgeNonce(message, snapshotNonceRef.current)
        ) {
          return;
        }
        const pending = pendingSnapshotRequestsRef.current.get(
          message.requestId,
        );
        if (!pending) return;
        clearTimeout(pending.timer);
        pendingSnapshotRequestsRef.current.delete(message.requestId);
        if (
          "error" in message &&
          !warnedSnapshotCaptureErrorRef.current
        ) {
          warnedSnapshotCaptureErrorRef.current = true;
          console.warn(
            "[rabbithole] app snapshot capture failed:",
            message.error,
          );
        }
        pending.resolve(
          "dataUrl" in message
            ? { dataUrl: message.dataUrl, hash: message.hash }
            : null,
        );
        return;
      }
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
      if (message.type === "askTutor") {
        void forwardAppTutorRequest({
          request: {
            message: message.message,
            ...(message.context ? { context: message.context } : {}),
          },
          flush,
          handler: onAskTutorRef.current,
        })
          .catch((error) =>
            console.error("[rabbithole] app tutor request failed", error),
          );
        return;
      }
      if (message.type === "request") {
        const requestNonce = message.nonce;
        const handler = onRequestRef.current;
        void (handler ? handler(message) : routeAppBridgeRequest(message, {}))
          .catch(() => appBridgeFailure("failed"))
          .then((payload) =>
            deliverAppBridgeReply(payload, {
              // A reloaded or swapped frame has a new nonce; its SDK no longer
              // holds this request, so the reply is dropped, not misrouted.
              isCurrent: () => nonceRef.current === requestNonce,
              post: (reply) =>
                iframeRef.current?.contentWindow?.postMessage(
                  createAppBridgeResponseMessage(
                    requestNonce,
                    message.requestId,
                    reply,
                  ),
                  "*",
                ),
              onAppAiTurn: onAppAiTurnRef.current,
            }),
          );
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
      clearPendingSnapshotRequests();
      flush();
      flushShared();
    };
  }, [
    clearPendingSnapshotRequests,
    flush,
    flushShared,
    postSnapshot,
    queueActions,
  ]);

  useEffect(() => {
    const current = snapshot;
    if (!readyWindowRef.current || current === undefined) return;
    const deferredActions = deferredActionsRef.current;
    if (deferredActions !== undefined) queueActions(deferredActions);
    if (snapshotVersionKey(current) !== lastSentVersionRef.current) {
      postSnapshot();
    }
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
    snapshotReadyWindowRef.current = null;
    snapshotNonceRef.current = null;
    snapshotIdentityRef.current = null;
    warnedSnapshotCaptureErrorRef.current = false;
    clearPendingSnapshotRequests();
    initializedRef.current = false;
    connectedIdentityRef.current = null;
    lastSentVersionRef.current = null;
    frameLoadVersionRef.current = 0;
    settledFrameLoadVersionRef.current = 0;
    deferredActionsRef.current = undefined;
    inFlightLogsRef.current = [];
    identityRef.current = identity;
  }, [clearPendingSnapshotRequests, flush, identity]);

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
    const loadVersion = frameLoadVersionRef.current + 1;
    frameLoadVersionRef.current = loadVersion;
    requestAnimationFrame(() => {
      settledFrameLoadVersionRef.current = Math.max(
        settledFrameLoadVersionRef.current,
        loadVersion,
      );
    });
  }, [postSnapshot]);

  return {
    iframeRef,
    onLoad,
    captureSnapshot: captureSnapshotBase,
    currentLoadBoundary,
  };
}
