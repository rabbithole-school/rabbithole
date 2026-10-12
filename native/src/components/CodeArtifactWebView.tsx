/**
 * CodeArtifactWebView — the ONE canonical native host for a `type: "code"`
 * artifact's live, running preview.
 *
 * This is the WebView + app-state bridge machinery extracted verbatim from
 * VibecodeScreen so there is a SINGLE native HTML host, not a second parallel
 * one. It renders the artifact's HTML full-bleed in a `react-native-webview`,
 * runs HTML through the shared sandbox preparation path (the same CSP, bridge
 * scripts, and brand stylesheet the web CodeArtifactViewer injects), and drives
 * the full bridge: visual capture, scoped app state, optional shared-room
 * state, presence, and registered app actions. It is the native twin of the web
 * sandboxed iframe preview.
 *
 * Consumers:
 *   • VibecodeScreen — the full-screen landscape build surface (a
 *     `sessionMode: "vibecode"` session), which wraps this with a chat drawer
 *     and a "building…" overlay.
 *   • DeliverablePanel / DeliverableCard — the NORMAL-session scholar
 *     deliverable surfaces, so a code artifact runs on iPad exactly as it does
 *     on web instead of rendering as a wall of monospace source.
 *
 * KEYING: key this component on the scope identity so a fresh artifact or
 * custom app remounts the whole bridge with clean state. In-place edits to the
 * same scope keep the bridge alive and only reload the inner WebView, which is
 * keyed on a content fingerprint below.
 *
 * WEBVIEW NOTE (mirrors VibecodeScreen): the app's canonical embedded-web host
 * is ExternalAppHost, but it is a URL-based keep-alive singleton with no path to
 * render inline HTML held in memory. So this reuses its UNDERLYING WebView
 * pattern (the `WebView as any` + `source={{ html }}` idiom) rather than
 * hand-rolling a novel WebView config.
 */

import {
  type Component,
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  StyleSheet,
  type LayoutChangeEvent,
  type StyleProp,
  View,
  type ViewStyle,
} from "react-native";
import { useAction, useConvex, useMutation, useQuery } from "convex/react";
import WebView from "react-native-webview";

import { api, type Id } from "@/lib/convex";
import {
  collectAppSnapshotConsoleLines,
  type AppSnapshotCapture,
  type AppSnapshotImageCapture,
  type AppSnapshotLoadBoundary,
} from "@/lib/appSnapshot";
import { waitForAppSnapshotReady } from "@/lib/appSnapshotReady";
import { nativeAppSnapshotInjectionScript } from "@/lib/nativeAppSnapshotCapture";
import { PAUSE_MEDIA_SNIPPET } from "@/lib/pauseMediaSnippet";
import {
  selectCodeArtifactStateScope,
  type CodeArtifactStateScope,
} from "@/lib/codeArtifactStateScope";
import * as appStateBridgeRuntime from "../../vendor/shared/appStateBridge.mjs";
import {
  APP_STATE_MAX_LOG_ENTRIES,
  appActionRegistryWriteDecision,
  appBridgeResponseInjectionScript,
  appStateFlushDelay,
  appStateHostInjectionScript,
  injectAppStateSdk,
  matchesAppStateBridgeNonce,
  mergeAppStateDoc,
  parseAppStateBridgeMessage,
} from "../../vendor/shared/appStateBridge.mjs";
import type {
  AppActionRegistration,
  AppActionResult,
} from "../../vendor/shared/appActionPolicy";
import {
  CUSTOM_APP_STATE_MIN_WRITE_INTERVAL_MS,
  isCustomAppStateRateLimitErrorData,
} from "../../vendor/shared/appStatePolicy";
import {
  commitResolvedRoomSelection,
  isRoomAppStateRateLimitErrorData,
  ROOM_PRESENCE_HEARTBEAT_MS,
  type RequestedRoom,
} from "../../vendor/shared/roomAppState";
import { prepareCustomAppSandbox } from "../../vendor/shared/customAppSandbox";
import { resolveNativeAppKitSource } from "@/lib/appKitAssets";
import {
  forwardAppTutorRequest,
  type AppTutorRequest,
} from "../../vendor/shared/appTutorRequest";
import {
  appAssetRef,
  requestedAppAssetIds,
} from "../../vendor/shared/appAssets";
import type { CharacterLine } from "../../vendor/shared/appAiPolicy";
import {
  deliverAppBridgeReply,
  routeAppBridgeRequest,
} from "../../vendor/shared/appBridgeRequest";

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

// react-native-webview's component type resolves to `never` under this Expo/TS
// combo for several iOS-only props, but they're supported at runtime — same cast
// ExternalAppHost / dev-hdr-stars / VibecodeScreen use.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const CodeWebView = WebView as any;

type AppStateLogInput = {
  level: "log" | "warn" | "error";
  message: string;
};

/** Cheap stable content fingerprint so an in-place edit reloads the WebView. */
function hashContent(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (Math.imul(h, 31) + s.charCodeAt(i)) | 0;
  }
  return `${s.length}:${h >>> 0}`;
}

export type CodeArtifactWebViewProps = {
  scope: CodeArtifactStateScope;
  content: string;
  onLoadStart?: () => void;
  onLoadEnd?: () => void;
  onError?: (message: string) => void;
  onAskTutor?: (request: AppTutorRequest) => void | Promise<void>;
  /** Fired after a character exchange or judgment completes, so the session
   *  screen can queue a tutor update. */
  onAppAiTurn?: () => void;
  /** False when the viewer is not the session's owner (a teacher watching):
   *  the character and judges then answer `unavailable` with no server call,
   *  which would refuse anyway. */
  appAiEnabled?: boolean;
  appAssetUrls?: ReadonlyMap<string, string>;
  /** Style for the underlying WebView (defaults to a flex-1 transparent fill). */
  style?: StyleProp<ViewStyle>;
};

export type CodeArtifactWebViewHandle = {
  captureSnapshot: (
    afterLoad?: AppSnapshotLoadBoundary,
    deadlineAt?: number,
  ) => Promise<AppSnapshotCapture>;
  currentLoadBoundary: () => AppSnapshotLoadBoundary;
  /** Pause any playing media without unmounting (keep-alive host close). */
  pauseMedia: () => void;
  /**
   * Drop any debounced app-state patch/logs and wait for in-flight writes, so
   * a following server-side clear (Reset app state) cannot be undone by the
   * unmount flush re-posting a stale patch. Also pauses further app-state
   * writes until `resumeAppStateWrites` (or a remount) re-arms the writer.
   */
  discardPendingAppState: () => Promise<void>;
  /** Re-arm the writer after a discard whose Reset did not remount this host. */
  resumeAppStateWrites: () => void;
};

export const CodeArtifactWebView = forwardRef<
  CodeArtifactWebViewHandle,
  CodeArtifactWebViewProps
>(function CodeArtifactWebView(
  {
    scope,
    content,
    onLoadStart,
    onLoadEnd,
    onError,
    onAskTutor,
    onAppAiTurn,
    appAiEnabled = true,
    appAssetUrls,
    style,
  },
  ref,
) {
  const stateBinding = selectCodeArtifactStateScope(scope);
  const resolveAppAssets = useAction(
    api.appAssetHostActions.resolveArtifactAssets,
  );
  const requestedAssetIds = useMemo(
    () => requestedAppAssetIds(content),
    [content],
  );
  const assetRequestKey = requestedAssetIds.join("\u0000");
  const assetRequestHtml = requestedAssetIds.map(appAssetRef).join("");
  const [assetResolution, setAssetResolution] = useState<{
    key: string;
    urls?: Map<string, string>;
    error?: unknown;
  }>({ key: "", urls: new Map() });
  const invalidCustomAppAssetRefs =
    assetRequestKey !== "" &&
    stateBinding.artifactId === null &&
    appAssetUrls === undefined;
  useEffect(() => {
    if (assetRequestKey === "" || stateBinding.artifactId === null) return;
    let cancelled = false;
    void resolveAppAssets({
      artifactId: stateBinding.artifactId,
      html: assetRequestHtml,
    }).then(
      (assets) => {
        if (!cancelled) {
          setAssetResolution({
            key: assetRequestKey,
            urls: new Map(assets.map((asset) => [asset.id, asset.url])),
          });
        }
      },
      (error: unknown) => {
        if (!cancelled) setAssetResolution({ key: assetRequestKey, error });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [
    assetRequestKey,
    assetRequestHtml,
    resolveAppAssets,
    stateBinding.artifactId,
  ]);
  useEffect(() => {
    if (invalidCustomAppAssetRefs) {
      onError?.("Static custom app assets were not prepared.");
      return;
    }
    if (
      assetResolution.key === assetRequestKey &&
      assetResolution.error !== undefined
    ) {
      const message =
        assetResolution.error instanceof Error
          ? assetResolution.error.message
          : String(assetResolution.error);
      onError?.(message);
    }
  }, [
    assetRequestKey,
    assetResolution,
    invalidCustomAppAssetRefs,
    onError,
  ]);
  const [sourceHtml, setSourceHtml] = useState<string | null>(null);
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;
  const onAppAiTurnRef = useRef(onAppAiTurn);
  onAppAiTurnRef.current = onAppAiTurn;
  useEffect(() => {
    let active = true;
    setSourceHtml(null);
    const resolvedUrls =
      assetRequestKey === ""
        ? new Map<string, string>()
        : (appAssetUrls ??
          (assetResolution.key === assetRequestKey
            ? assetResolution.urls
            : undefined));
    if (
      invalidCustomAppAssetRefs ||
      assetResolution.error !== undefined
    ) {
      setSourceHtml("");
      return () => {
        active = false;
      };
    }
    if (resolvedUrls === undefined) {
      return () => {
        active = false;
      };
    }
    void prepareCustomAppSandbox(
      content,
      injectAppStateSdk,
      resolveNativeAppKitSource,
      (assetId) => resolvedUrls.get(assetId),
    )
      .then(({ srcDoc }) => {
        if (active) setSourceHtml(srcDoc);
      })
      .catch((error: unknown) => {
        if (!active) return;
        onErrorRef.current?.(
          error instanceof Error
            ? error.message
            : "The custom app could not be prepared.",
        );
      });
    return () => {
      active = false;
    };
  }, [
    assetRequestKey,
    assetResolution,
    appAssetUrls,
    content,
    invalidCustomAppAssetRefs,
  ]);
  const appStateIdentity = stateBinding.identity;
  const sessionArtifactId = stateBinding.artifactId;
  const customAppArgs = stateBinding.customAppArgs;
  const customAppToken = customAppArgs?.token ?? null;
  const customAppStateUserId = customAppArgs?.userId ?? null;
  const customAppStateKey = customAppArgs?.key ?? null;
  const supportsActionResults = stateBinding.supportsActionResults;
  const webViewRef = useRef<
    (Component & { injectJavaScript: (script: string) => void }) | null
  >(null);
  const snapshotNonceRef = useRef<string | null>(null);
  const webViewLoadVersionRef = useRef(0);
  const settledWebViewLoadVersionRef = useRef(0);
  const snapshotLayoutRef = useRef<{
    width: number;
    height: number;
  } | null>(null);
  const nextSnapshotRequestIdRef = useRef(0);
  const pendingSnapshotRequestsRef = useRef(
    new Map<
      string,
      {
        resolve: (
          snapshot:
            | AppSnapshotImageCapture
            | { error: string }
            | null,
        ) => void;
        timer: ReturnType<typeof setTimeout>;
      }
    >(),
  );
  const appStateReadyRef = useRef(false);
  const appStateInitializedRef = useRef(false);
  const appStateNonceRef = useRef<string | null>(null);
  const appStateWriteTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  // App-state writer epoch: `discardPendingAppState` bumps it and pauses writes,
  // so a patch/action enqueued during the discard, a failed write restoring its
  // patch, or the unmount flush cannot re-persist state the Reset is clearing.
  // Every enqueue/retry-restore captures the epoch it started under and is
  // dropped once the epoch moves; new writes stay paused until the reset
  // sequence resumes them (or the host remounts).
  const appStateWriteEpochRef = useRef(0);
  const appStateWritesPausedRef = useRef(false);
  const appStatePendingSinceRef = useRef<number | undefined>(undefined);
  const pendingAppStatePatchRef = useRef<Record<string, unknown>>({});
  const pendingAppStateLogsRef = useRef<AppStateLogInput[]>([]);
  const pendingAppActionsRef = useRef<AppActionRegistration[] | undefined>(
    undefined,
  );
  const deferredAppActionsRef = useRef<AppActionRegistration[] | undefined>(
    undefined,
  );
  const inFlightAppStatePatchesRef = useRef<
    Array<{
      id: number;
      identity: string;
      patch: Record<string, unknown>;
    }>
  >([]);
  const inFlightAppStateLogsRef = useRef<
    Array<{
      id: number;
      identity: string;
      logs: AppStateLogInput[];
    }>
  >([]);
  const inFlightAppStateWritesRef = useRef<
    Array<{
      id: number;
      identity: string;
      promise: Promise<boolean>;
    }>
  >([]);
  const nextAppStateWriteIdRef = useRef(0);
  const customAppWriteQueueRef = useRef<Promise<void>>(Promise.resolve());
  const customAppLastWriteAtRef = useRef(0);
  // Consumers key on this identity, so async writes can reject stale work
  // without coupling the custom-app scope to an artifact id.
  const activeAppStateIdentityRef = useRef(appStateIdentity);
  activeAppStateIdentityRef.current = appStateIdentity;
  const activeAppStateArtifactIdRef = useRef<Id<"artifacts"> | null>(
    sessionArtifactId,
  );
  activeAppStateArtifactIdRef.current = sessionArtifactId;
  const [requestedRoom, setRequestedRoom] = useState<
    RequestedRoom<Id<"artifacts">, Id<"rooms">> | null
  >(null);
  // WebView input remains raw until the resolver returns a typed, authorized ID.
  const [, setPendingRoomSelection] = useState<{
    artifactId: Id<"artifacts">;
    roomId: string;
    requestId: number;
  } | null>(null);
  const nextRoomSelectionRequestIdRef = useRef(0);
  const [roomSelectionVersion, setRoomSelectionVersion] = useState(0);
  const pendingSharedPatchRef = useRef<Record<string, unknown>>({});
  const inFlightSharedPatchesRef = useRef<
    Array<{
      id: number;
      roomId: Id<"rooms">;
      patch: Record<string, unknown>;
    }>
  >([]);
  const nextSharedWriteIdRef = useRef(0);
  const sharedWriteTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const sharedPendingSinceRef = useRef<number | undefined>(undefined);
  const activeSharedRoomIdRef = useRef<Id<"rooms"> | null | undefined>(
    undefined,
  );
  const convex = useConvex();
  const appStateSnapshotRef = useRef<
    | {
        doc?: unknown;
        log?: AppStateLogInput[];
      }
    | null
    | undefined
  >(undefined);

  const updateSessionAppState = useMutation(api.appStates.updateSessionState);
  const updateCustomAppState = useMutation(api.appStates.updateCustomAppState);
  const updateRoomState = useMutation(api.appStates.updateRoomState);
  const joinRoomPresence = useMutation(api.appStates.joinRoomPresence);
  const leaveRoomPresence = useMutation(api.appStates.leaveRoomPresence);
  const appAiSay = useAction(api.appAiActions.say);
  const appAiJudge = useAction(api.appAiActions.judge);

  const persistAppState = useCallback(
    async (update: {
      patch?: Record<string, unknown>;
      logs?: AppStateLogInput[];
      actions?: AppActionRegistration[];
    }) => {
      if (sessionArtifactId !== null) {
        await updateSessionAppState({
          artifactId: sessionArtifactId,
          ...update,
        });
        return;
      }

      if (
        customAppToken === null ||
        customAppStateUserId === null ||
        customAppStateKey === null
      ) {
        throw new Error("Custom app state binding is missing");
      }
      const write = customAppWriteQueueRef.current.then(async () => {
        const waitMs = Math.max(
          0,
          customAppLastWriteAtRef.current +
            CUSTOM_APP_STATE_MIN_WRITE_INTERVAL_MS -
            Date.now(),
        );
        if (waitMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, waitMs));
        }
        while (true) {
          try {
            await updateCustomAppState({
              token: customAppToken,
              userId: customAppStateUserId,
              key: customAppStateKey,
              ...update,
            });
            customAppLastWriteAtRef.current = Date.now();
            return;
          } catch (error) {
            const data =
              error && typeof error === "object" && "data" in error
                ? (error as { data?: unknown }).data
                : undefined;
            if (!isCustomAppStateRateLimitErrorData(data)) throw error;
            // No jitter: this queue is the single writer for one device partition.
            await new Promise((resolve) =>
              setTimeout(resolve, data.retryAfterMs),
            );
          }
        }
      });
      customAppWriteQueueRef.current = write.then(
        () => undefined,
        () => undefined,
      );
      await write;
    },
    [
      customAppStateKey,
      customAppStateUserId,
      customAppToken,
      sessionArtifactId,
      updateCustomAppState,
      updateSessionAppState,
    ],
  );

  const waitForSnapshotReady = useCallback(async (
    afterLoad?: AppSnapshotLoadBoundary,
    deadlineAt?: number,
  ) => {
    return await waitForAppSnapshotReady({
      afterLoad,
      deadlineAt:
        deadlineAt ?? performance.now() + APP_SNAPSHOT_TIMEOUT_MS,
      current: () => ({
        loadVersion: settledWebViewLoadVersionRef.current,
        nonce: snapshotNonceRef.current,
      }),
      now: () => performance.now(),
      requestFrame: (callback) => requestAnimationFrame(callback),
    });
  }, []);

  const clearPendingSnapshotRequests = useCallback(() => {
    for (const pending of pendingSnapshotRequestsRef.current.values()) {
      clearTimeout(pending.timer);
      pending.resolve(null);
    }
    pendingSnapshotRequestsRef.current.clear();
  }, []);

  const readCaptureContext = useCallback(() => {
    const current = appStateSnapshotRef.current;
    const doc = mergeAppStateDoc(current?.doc, [
      ...inFlightAppStatePatchesRef.current
        .filter((entry) => entry.identity === activeAppStateIdentityRef.current)
        .map((entry) => entry.patch),
      pendingAppStatePatchRef.current,
    ]);
    const logs = [
      ...(current?.log ?? []),
      ...inFlightAppStateLogsRef.current
        .filter((entry) => entry.identity === activeAppStateIdentityRef.current)
        .flatMap((entry) => entry.logs),
      ...pendingAppStateLogsRef.current,
    ];
    return {
      consoleLines: collectAppSnapshotConsoleLines(logs),
      stateJson: JSON.stringify(doc ?? {}),
    };
  }, []);

  const captureSnapshot = useCallback(async (
    afterLoad?: AppSnapshotLoadBoundary,
    deadlineAt?: number,
  ): Promise<AppSnapshotCapture> => {
    const ready =
      afterLoad !== undefined || deadlineAt !== undefined
        ? await waitForSnapshotReady(afterLoad, deadlineAt)
        : snapshotNonceRef.current !== null;
    const webView = webViewRef.current;
    const nonce = snapshotNonceRef.current;
    const layout = snapshotLayoutRef.current;
    if (!ready || !webView || !nonce || !layout) {
      return {
        image: null,
        imageError: ready ? "bridge-unavailable" : "timeout",
        ...readCaptureContext(),
      };
    }
    const requestId = `${appStateIdentity}:snapshot:${nextSnapshotRequestIdRef.current++}`;
    const remaining =
      deadlineAt === undefined
        ? APP_SNAPSHOT_TIMEOUT_MS
        : Math.max(0, deadlineAt - performance.now());
    if (remaining === 0) {
      return {
        image: null,
        imageError: "timeout",
        ...readCaptureContext(),
      };
    }
    const message = JSON.stringify(
      createAppSnapshotRequestMessage(
        nonce,
        requestId,
        APP_SNAPSHOT_MAX_WIDTH,
        layout.width,
        layout.height,
      ),
    ).replaceAll("<", "\\u003c");
    const result = await new Promise<
      AppSnapshotImageCapture | { error: string } | null
    >((resolve) => {
      const timeoutMs = Math.min(APP_SNAPSHOT_TIMEOUT_MS, remaining);
      const timer = setTimeout(() => {
        pendingSnapshotRequestsRef.current.delete(requestId);
        resolve(null);
      }, timeoutMs);
      pendingSnapshotRequestsRef.current.set(requestId, { resolve, timer });
      try {
        webView.injectJavaScript(
          nativeAppSnapshotInjectionScript(
            message,
            timeoutMs,
            APP_SNAPSHOT_MAX_WIDTH,
          ),
        );
      } catch {
        clearTimeout(timer);
        pendingSnapshotRequestsRef.current.delete(requestId);
        resolve(null);
      }
    });
    return {
      image: result && "dataUrl" in result ? result : null,
      imageError:
        result && "error" in result
          ? `capture-error:${result.error}`
          : result
            ? undefined
            : "timeout",
      ...readCaptureContext(),
    };
  }, [
    appStateIdentity,
    readCaptureContext,
    waitForSnapshotReady,
  ]);

  const currentLoadBoundary = useCallback(
    (): AppSnapshotLoadBoundary => ({
      loadVersion: settledWebViewLoadVersionRef.current,
      nonce: snapshotNonceRef.current,
    }),
    [],
  );

  const pauseMedia = useCallback(() => {
    try {
      webViewRef.current?.injectJavaScript(PAUSE_MEDIA_SNIPPET);
    } catch {
      // WebView may be tearing down; pausing is best-effort.
    }
  }, []);

  // Reset app state (F10): the host flushes pending app-state writes from its
  // unmount cleanup, so a Reset that clears the server row and then remounts
  // would race a debounced or in-flight patch re-creating the state. Drop the
  // pending patch and wait out in-flight writes BEFORE the caller clears.
  const discardPendingAppState = useCallback(async () => {
    // Invalidate the writer BEFORE clearing: any enqueue during the await
    // below, and any failed in-flight write, is now tagged with a stale epoch
    // and dropped, and further writes stay paused until the reset resumes them.
    appStateWriteEpochRef.current += 1;
    appStateWritesPausedRef.current = true;
    clearTimeout(appStateWriteTimerRef.current);
    appStateWriteTimerRef.current = undefined;
    appStatePendingSinceRef.current = undefined;
    pendingAppStatePatchRef.current = {};
    pendingAppStateLogsRef.current = [];
    pendingAppActionsRef.current = undefined;
    const activeWrites = inFlightAppStateWritesRef.current.map(
      (entry) => entry.promise,
    );
    if (activeWrites.length > 0) await Promise.allSettled(activeWrites);
  }, []);

  // Re-arm the app-state writer after a Reset that did NOT remount this host
  // (e.g. the server clear failed), so a still-mounted app can persist again.
  const resumeAppStateWrites = useCallback(() => {
    appStateWritesPausedRef.current = false;
  }, []);

  useImperativeHandle(
    ref,
    () => ({
      captureSnapshot,
      currentLoadBoundary,
      pauseMedia,
      discardPendingAppState,
      resumeAppStateWrites,
    }),
    [
      captureSnapshot,
      currentLoadBoundary,
      pauseMedia,
      discardPendingAppState,
      resumeAppStateWrites,
    ],
  );

  // Key the WebView on scope + content hash so an in-place edit reliably reloads it.
  const webViewKey =
    sourceHtml === null
      ? `${appStateIdentity}:loading`
      : `${appStateIdentity}:${hashContent(sourceHtml)}`;
  const sessionAppState = useQuery(
    api.appStates.getSessionState,
    sessionArtifactId !== null ? { artifactId: sessionArtifactId } : "skip",
  );
  const customAppState = useQuery(
    api.appStates.getCustomAppState,
    customAppToken !== null &&
      customAppStateUserId !== null &&
      customAppStateKey !== null
      ? {
          token: customAppToken,
          userId: customAppStateUserId,
          key: customAppStateKey,
        }
      : "skip",
  );
  const appState =
    sessionArtifactId !== null ? sessionAppState : customAppState;
  useEffect(() => {
    appStateSnapshotRef.current = appState;
  }, [appState]);
  const defaultRoom = useQuery(
    api.rooms.defaultForArtifact,
    sessionArtifactId !== null ? { artifactId: sessionArtifactId } : "skip",
  );
  const requestedRoomId =
    requestedRoom &&
    sessionArtifactId &&
    requestedRoom.artifactId === sessionArtifactId
      ? requestedRoom.roomId
      : null;
  const activeRoomId: Id<"rooms"> | null | undefined =
    sessionArtifactId === null
      ? null
      : requestedRoomId ??
        (defaultRoom === undefined ? undefined : (defaultRoom?._id ?? null));
  activeSharedRoomIdRef.current = activeRoomId;
  const sharedState = useQuery(
    api.appStates.getRoomState,
    activeRoomId ? { roomId: activeRoomId } : "skip",
  );
  const roomPresence = useQuery(
    api.appStates.getRoomPresence,
    activeRoomId ? { roomId: activeRoomId } : "skip",
  );

  const resolveRoomSelection = useCallback(
    (targetArtifactId: Id<"artifacts">, rawRoomId: string) => {
      const requestId = nextRoomSelectionRequestIdRef.current++;
      setPendingRoomSelection({
        artifactId: targetArtifactId,
        roomId: rawRoomId,
        requestId,
      });
      void convex
        .query(api.rooms.resolveAccessibleForArtifact, {
          artifactId: targetArtifactId,
          roomId: rawRoomId,
        })
        .then((room) => {
          if (
            nextRoomSelectionRequestIdRef.current !== requestId + 1 ||
            activeAppStateIdentityRef.current !== String(targetArtifactId)
          ) {
            return;
          }
          if (!room) {
            // Re-send the committed room so the WebView abandons its rejected raw ID.
            setRoomSelectionVersion((version) => version + 1);
          }
          setRequestedRoom((current) =>
            commitResolvedRoomSelection(
              current,
              targetArtifactId,
              room?._id ?? null,
            ),
          );
        })
        .catch((error) =>
          console.warn("[code-webview] failed to resolve shared room", error),
        )
        .finally(() => {
          setPendingRoomSelection((pending) =>
            pending?.requestId === requestId ? null : pending,
          );
        });
    },
    [convex],
  );

  const flushAppState = useCallback((): Promise<boolean> => {
    const epoch = appStateWriteEpochRef.current;
    clearTimeout(appStateWriteTimerRef.current);
    appStateWriteTimerRef.current = undefined;
    appStatePendingSinceRef.current = undefined;
    const patch = pendingAppStatePatchRef.current;
    const logs = pendingAppStateLogsRef.current;
    const actions = pendingAppActionsRef.current;
    pendingAppStatePatchRef.current = {};
    pendingAppStateLogsRef.current = [];
    pendingAppActionsRef.current = undefined;
    if (
      Object.keys(patch).length === 0 &&
      logs.length === 0 &&
      actions === undefined
    ) {
      const activeWrites = inFlightAppStateWritesRef.current
        .filter((entry) => entry.identity === activeAppStateIdentityRef.current)
        .map((entry) => entry.promise);
      return activeWrites.length > 0
        ? Promise.all(activeWrites).then((results) => results.every(Boolean))
        : Promise.resolve(true);
    }
    const writeId = nextAppStateWriteIdRef.current++;
    const writeIdentity = appStateIdentity;
    if (Object.keys(patch).length > 0) {
      inFlightAppStatePatchesRef.current.push({
        id: writeId,
        identity: writeIdentity,
        patch,
      });
    }
    if (logs.length > 0) {
      inFlightAppStateLogsRef.current.push({
        id: writeId,
        identity: writeIdentity,
        logs,
      });
    }
    const writePromise = persistAppState({
      patch: Object.keys(patch).length > 0 ? patch : undefined,
      logs: logs.length > 0 ? logs : undefined,
      actions,
    })
      .then(() => {
        inFlightAppStatePatchesRef.current =
          inFlightAppStatePatchesRef.current.filter(
            (entry) => entry.id !== writeId,
          );
        inFlightAppStateLogsRef.current =
          inFlightAppStateLogsRef.current.filter(
            (entry) => entry.id !== writeId,
          );
        return true;
      })
      .catch((error) => {
        inFlightAppStatePatchesRef.current =
          inFlightAppStatePatchesRef.current.filter(
            (entry) => entry.id !== writeId,
          );
        inFlightAppStateLogsRef.current =
          inFlightAppStateLogsRef.current.filter(
            (entry) => entry.id !== writeId,
          );
        if (
          appStateWriteEpochRef.current === epoch &&
          activeAppStateIdentityRef.current === writeIdentity
        ) {
          pendingAppStatePatchRef.current = {
            ...patch,
            ...pendingAppStatePatchRef.current,
          };
          pendingAppStateLogsRef.current = [
            ...logs,
            ...pendingAppStateLogsRef.current,
          ].slice(-APP_STATE_MAX_LOG_ENTRIES);
          if (
            actions !== undefined &&
            pendingAppActionsRef.current === undefined
          ) {
            pendingAppActionsRef.current = actions;
          }
        }
        console.warn("[code-webview] failed to persist app state", error);
        return false;
      })
      .finally(() => {
        inFlightAppStateWritesRef.current =
          inFlightAppStateWritesRef.current.filter(
            (entry) => entry.id !== writeId,
          );
      });
    inFlightAppStateWritesRef.current.push({
      id: writeId,
      identity: writeIdentity,
      promise: writePromise,
    });
    return writePromise;
  }, [appStateIdentity, persistAppState]);

  const flushSharedState = useCallback(function flushSharedState(
    roomOverride?: Id<"rooms">,
  ) {
    clearTimeout(sharedWriteTimerRef.current);
    sharedWriteTimerRef.current = undefined;
    sharedPendingSinceRef.current = undefined;
    const roomId = roomOverride ?? activeSharedRoomIdRef.current;
    const patch = pendingSharedPatchRef.current;
    pendingSharedPatchRef.current = {};
    if (!roomId || Object.keys(patch).length === 0) return;
    const writeId = nextSharedWriteIdRef.current++;
    inFlightSharedPatchesRef.current.push({ id: writeId, roomId, patch });
    void updateRoomState({ roomId, patch })
      .then(() => {
        inFlightSharedPatchesRef.current =
          inFlightSharedPatchesRef.current.filter(
            (entry) => entry.id !== writeId,
          );
      })
      .catch((error) => {
        inFlightSharedPatchesRef.current =
          inFlightSharedPatchesRef.current.filter(
            (entry) => entry.id !== writeId,
          );
        const data =
          error && typeof error === "object" && "data" in error
            ? (error as { data?: unknown }).data
            : undefined;
        if (
          activeSharedRoomIdRef.current === roomId &&
          isRoomAppStateRateLimitErrorData(data)
        ) {
          pendingSharedPatchRef.current = {
            ...patch,
            ...pendingSharedPatchRef.current,
          };
          if (sharedPendingSinceRef.current == null) {
            sharedPendingSinceRef.current = Date.now();
          }
          sharedWriteTimerRef.current = setTimeout(
            flushSharedState,
            data.retryAfterMs,
          );
        }
        console.warn("[code-webview] failed to persist shared app state", error);
      });
  }, [updateRoomState]);

  const queueAppActions = useCallback(
    (actions: AppActionRegistration[]) => {
      if (appStateWritesPausedRef.current) return;
      const decision = appActionRegistryWriteDecision(
        appState === null ? null : appState?.actions,
        actions,
      );
      if (decision === "defer") {
        deferredAppActionsRef.current = actions;
        return;
      }
      deferredAppActionsRef.current = undefined;
      if (decision === "skip") {
        pendingAppActionsRef.current = undefined;
        return;
      }
      pendingAppActionsRef.current = actions;
      if (appStatePendingSinceRef.current == null) {
        appStatePendingSinceRef.current = Date.now();
      }
      clearTimeout(appStateWriteTimerRef.current);
      appStateWriteTimerRef.current = setTimeout(
        flushAppState,
        appStateFlushDelay(appStatePendingSinceRef.current),
      );
    },
    [appState, flushAppState],
  );

  const postAppState = useCallback(() => {
    if (
      !appStateReadyRef.current ||
      !webViewRef.current ||
      !appStateNonceRef.current ||
      appState === undefined
    ) {
      return;
    }
    const type = appStateInitializedRef.current ? "update" : "init";
    const pendingPatches = [
      ...inFlightAppStatePatchesRef.current
        .filter((entry) => entry.identity === appStateIdentity)
        .map((entry) => entry.patch),
      pendingAppStatePatchRef.current,
    ];
    const sharedMessage =
      activeRoomId === null
        ? null
        : activeRoomId &&
            sharedState !== undefined &&
            roomPresence !== undefined
          ? {
              roomId: activeRoomId,
              doc: mergeAppStateDoc(sharedState?.doc, [
                ...inFlightSharedPatchesRef.current
                  .filter((entry) => entry.roomId === activeRoomId)
                  .map((entry) => entry.patch),
                pendingSharedPatchRef.current,
              ]),
              presence: roomPresence,
            }
          : undefined;
    webViewRef.current.injectJavaScript(
      appStateHostInjectionScript(
        type,
        mergeAppStateDoc(appState?.doc, pendingPatches),
        appStateNonceRef.current,
        sharedMessage,
        supportsActionResults && appState && "actionRequest" in appState
          ? appState.actionRequest
          : undefined,
        // Characters are session-only; the field is absent until the session
        // state query projects it.
        supportsActionResults && appState && "characterLine" in appState
          ? (appState as { characterLine?: CharacterLine | null })
              .characterLine
          : undefined,
      ),
    );
    appStateInitializedRef.current = true;
  }, [
    activeRoomId,
    appState,
    appStateIdentity,
    roomPresence,
    sharedState,
    supportsActionResults,
  ]);

  const handleAppStateMessage = useCallback(
    (event: { nativeEvent: { data: string } }) => {
      const message = parseBridgeMessage(event.nativeEvent.data);
      if (!message) return;
      if (message.type === APP_SNAPSHOT_READY_TYPE) {
        if (
          snapshotNonceRef.current &&
          snapshotNonceRef.current !== message.nonce
        ) {
          clearPendingSnapshotRequests();
        }
        snapshotNonceRef.current = message.nonce;
        return;
      }
      if (message.type === APP_SNAPSHOT_RESULT_TYPE) {
        if (!matchesAppStateBridgeNonce(message, snapshotNonceRef.current)) {
          return;
        }
        const pending = pendingSnapshotRequestsRef.current.get(
          message.requestId,
        );
        if (!pending) return;
        clearTimeout(pending.timer);
        pendingSnapshotRequestsRef.current.delete(message.requestId);
        pending.resolve(
          "dataUrl" in message
            ? { dataUrl: message.dataUrl, hash: message.hash }
            : { error: message.error },
        );
        return;
      }
      if (message.type === "ready") {
        appStateReadyRef.current = true;
        appStateInitializedRef.current = false;
        appStateNonceRef.current = message.nonce;
        postAppState();
        return;
      }
      if (!matchesAppStateBridgeNonce(message, appStateNonceRef.current)) return;
      if (message.type === "sharedSelect") {
        const currentArtifactId = activeAppStateArtifactIdRef.current;
        if (!currentArtifactId) return;
        resolveRoomSelection(currentArtifactId, message.roomId);
        return;
      }
      if (message.type === "sharedChange") {
        if (message.roomId !== activeSharedRoomIdRef.current) return;
        pendingSharedPatchRef.current = {
          ...pendingSharedPatchRef.current,
          ...message.patch,
        };
        if (sharedPendingSinceRef.current == null) {
          sharedPendingSinceRef.current = Date.now();
        }
        clearTimeout(sharedWriteTimerRef.current);
        sharedWriteTimerRef.current = setTimeout(
          flushSharedState,
          appStateFlushDelay(sharedPendingSinceRef.current),
        );
        return;
      }
      if (message.type === "actionResult") {
        if (!supportsActionResults) return;
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
        const currentArtifactId = activeAppStateArtifactIdRef.current;
        if (!currentArtifactId) return;
        void updateSessionAppState({
          artifactId: currentArtifactId,
          actionResult,
        }).catch((error) =>
          console.warn("[code-webview] failed to acknowledge app action", error),
        );
        return;
      }
      if (message.type === "actions") {
        if (message.actions === undefined) return;
        queueAppActions(message.actions);
        return;
      }
      if (message.type === "askTutor") {
        void forwardAppTutorRequest({
          request: {
            message: message.message,
            ...(message.context ? { context: message.context } : {}),
          },
          flush: flushAppState,
          handler: onAskTutor,
        }).catch((error) =>
          console.warn("[code-webview] app tutor request failed", error),
        );
        return;
      }
      if (message.type === "request") {
        const requestNonce = message.nonce;
        // Session scope only, and the owner only: a custom-app tile has no
        // session, tutor, or teacher-readable record, and a non-owner's call
        // is refused server-side, so both answer `unavailable` at once.
        const artifactId = activeAppStateArtifactIdRef.current;
        void routeAppBridgeRequest(
          message,
          artifactId && appAiEnabled
            ? {
                say: (text, context) =>
                  appAiSay({
                    artifactId,
                    text,
                    ...(context ? { context } : {}),
                  }),
                judge: (judgeId, answer, context) =>
                  appAiJudge({
                    artifactId,
                    judgeId,
                    answer,
                    ...(context ? { context } : {}),
                  }),
              }
            : {},
        ).then((payload) =>
          deliverAppBridgeReply(payload, {
            // A reloaded page has a new nonce and no longer holds this request.
            isCurrent: () => appStateNonceRef.current === requestNonce,
            post: (reply) =>
              webViewRef.current?.injectJavaScript(
                appBridgeResponseInjectionScript(
                  requestNonce,
                  message.requestId,
                  reply,
                ),
              ),
            onAppAiTurn: onAppAiTurnRef.current,
          }),
        );
        return;
      }
      if (appStateWritesPausedRef.current) return;
      if (message.patch) {
        pendingAppStatePatchRef.current = {
          ...pendingAppStatePatchRef.current,
          ...message.patch,
        };
      }
      if (message.logs?.length) {
        pendingAppStateLogsRef.current.push(...message.logs);
        pendingAppStateLogsRef.current =
          pendingAppStateLogsRef.current.slice(-APP_STATE_MAX_LOG_ENTRIES);
      }
      if (appStatePendingSinceRef.current == null) {
        appStatePendingSinceRef.current = Date.now();
      }
      clearTimeout(appStateWriteTimerRef.current);
      appStateWriteTimerRef.current = setTimeout(
        flushAppState,
        appStateFlushDelay(appStatePendingSinceRef.current),
      );
    },
    [
      flushAppState,
      flushSharedState,
      clearPendingSnapshotRequests,
      appAiEnabled,
      appAiJudge,
      appAiSay,
      onAskTutor,
      postAppState,
      queueAppActions,
      resolveRoomSelection,
      supportsActionResults,
      updateSessionAppState,
    ],
  );

  useEffect(() => {
    if (appState === undefined) return;
    const deferredActions = deferredAppActionsRef.current;
    if (deferredActions !== undefined) queueAppActions(deferredActions);
  }, [appState, queueAppActions]);

  useEffect(() => {
    deferredAppActionsRef.current = undefined;
    clearPendingSnapshotRequests();
  }, [appStateIdentity, clearPendingSnapshotRequests]);

  useEffect(() => {
    postAppState();
  }, [appState, postAppState]);

  useEffect(
    () => () => {
      clearPendingSnapshotRequests();
      void flushAppState();
    },
    [clearPendingSnapshotRequests, flushAppState],
  );

  useEffect(() => {
    postAppState();
  }, [
    activeRoomId,
    postAppState,
    roomPresence,
    roomSelectionVersion,
    sharedState,
  ]);

  useEffect(() => {
    if (!activeRoomId) return;
    void joinRoomPresence({ roomId: activeRoomId });
    const heartbeat = setInterval(() => {
      void joinRoomPresence({ roomId: activeRoomId });
    }, ROOM_PRESENCE_HEARTBEAT_MS);
    return () => {
      clearInterval(heartbeat);
      flushSharedState(activeRoomId);
      void leaveRoomPresence({ roomId: activeRoomId });
    };
  }, [
    activeRoomId,
    flushSharedState,
    joinRoomPresence,
    leaveRoomPresence,
  ]);

  if (sourceHtml === null) {
    return <View style={[styles.webView, style]} />;
  }

  return (
    <View
      onLayout={(event: LayoutChangeEvent) => {
        const { width, height } = event.nativeEvent.layout;
        snapshotLayoutRef.current =
          width > 0 && height > 0
            ? {
                width: Math.round(width),
                height: Math.round(height),
              }
            : null;
      }}
      style={[styles.captureSurface, style]}
      collapsable={false}
    >
      <CodeWebView
        ref={webViewRef}
        key={webViewKey}
        source={{ html: sourceHtml }}
        onLoadStart={() => {
          clearPendingSnapshotRequests();
          webViewLoadVersionRef.current += 1;
          snapshotNonceRef.current = null;
          appStateReadyRef.current = false;
          appStateInitializedRef.current = false;
          appStateNonceRef.current = null;
          onLoadStart?.();
        }}
        onLoadEnd={() => {
          settledWebViewLoadVersionRef.current = Math.max(
            settledWebViewLoadVersionRef.current,
            webViewLoadVersionRef.current,
          );
          onLoadEnd?.();
        }}
        onError={(event: { nativeEvent: { description?: string } }) =>
          onError?.(
            event.nativeEvent.description ??
              "The custom app could not be loaded.",
          )
        }
        onMessage={handleAppStateMessage}
        originWhitelist={["*"]}
        // Web parity: the web viewer sandboxes the artifact in an
        // `<iframe sandbox="allow-scripts">` with NO allow-top-navigation and NO
        // allow-popups, so the artifact can never navigate the frame elsewhere or
        // open windows. react-native-webview has no sandbox, so we enforce the
        // same boundary explicitly — otherwise a link click / window.location /
        // injected redirect in tutor-generated HTML could replace the running
        // artifact with an arbitrary external page INSIDE the app chrome (now
        // reachable from normal scholar sessions). Allow only the initial inline
        // document (iOS surfaces `source={{ html }}` as about:blank), data:/blob:
        // documents, and non-top-frame subframe loads (so artifact-embedded
        // iframes keep working). HTTPS image requests are subresources rather
        // than navigations, so the CSP's resolved asset origins govern them while
        // this callback remains a top-frame navigation lock. Silently block every
        // other top-frame navigation
        // — do NOT open it externally (a scholar device must not be bounced into
        // Safari either).
        onShouldStartLoadWithRequest={(request: {
          url: string;
          isTopFrame?: boolean;
        }) => {
          if (request.isTopFrame === false) return true;
          const url = request.url ?? "";
          return (
            url === "about:blank" ||
            url.startsWith("about:blank") ||
            url.startsWith("data:") ||
            url.startsWith("blob:")
          );
        }}
        // window.open must not spawn a second WebView window. Web custom apps
        // allow popups, but native intentionally keeps the stricter lockdown:
        // opaque-origin, connect-src 'none' apps rarely need another window.
        setSupportMultipleWindows={false}
        style={styles.webView}
        javaScriptEnabled
        domStorageEnabled
        allowsInlineMediaPlayback
        mediaPlaybackRequiresUserAction={false}
        bounces={false}
        overScrollMode="never"
      />
    </View>
  );
});

const styles = StyleSheet.create({
  captureSurface: { flex: 1, backgroundColor: "#ffffff" },
  webView: { flex: 1, backgroundColor: "#ffffff" },
});
