/**
 * CodeArtifactWebView — the ONE canonical native host for a `type: "code"`
 * artifact's live, running preview.
 *
 * This is the WebView + app-state bridge machinery extracted verbatim from
 * VibecodeScreen so there is a SINGLE native HTML host, not a second parallel
 * one. It renders the artifact's HTML full-bleed in a `react-native-webview`,
 * injects the shared `RABBITHOLE_APP_STATE_SDK` (same SDK the web
 * CodeArtifactViewer injects into its sandboxed iframe), and drives the full
 * app-state bridge: per-session app state, shared-room state, presence, and
 * registered app actions. It is the native twin of the web
 * <iframe sandbox srcDoc={injectAppStateSdk(code)} /> preview.
 *
 * Consumers:
 *   • VibecodeScreen — the full-screen landscape build surface (a
 *     `sessionMode: "vibecode"` session), which wraps this with a chat drawer
 *     and a "building…" overlay.
 *   • DeliverablePanel / DeliverableCard — the NORMAL-session scholar
 *     deliverable surfaces, so a code artifact runs on iPad exactly as it does
 *     on web instead of rendering as a wall of monospace source.
 *
 * KEYING: key this component on the artifact id (`key={artifactId}`) so a fresh
 * artifact remounts the whole bridge with clean state. In-place edits to the
 * SAME artifact keep the bridge alive and only reload the inner WebView, which
 * is keyed on a content fingerprint below.
 *
 * WEBVIEW NOTE (mirrors VibecodeScreen): the app's canonical embedded-web host
 * is ExternalAppHost, but it is a URL-based keep-alive singleton with no path to
 * render inline HTML held in memory. So this reuses its UNDERLYING WebView
 * pattern (the `WebView as any` + `source={{ html }}` idiom) rather than
 * hand-rolling a novel WebView config.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { StyleSheet, type StyleProp, type ViewStyle } from "react-native";
import { useConvex, useMutation, useQuery } from "convex/react";
import WebView from "react-native-webview";

import { api, type Id } from "@/lib/convex";
import {
  APP_STATE_MAX_LOG_ENTRIES,
  appActionRegistryWriteDecision,
  appStateFlushDelay,
  RABBITHOLE_APP_STATE_SDK,
  appStateHostInjectionScript,
  matchesAppStateBridgeNonce,
  mergeAppStateDoc,
  parseAppStateBridgeMessage,
} from "../../vendor/shared/appStateBridge.mjs";
import type {
  AppActionRegistration,
  AppActionResult,
} from "../../vendor/shared/appActionPolicy";
import {
  commitResolvedRoomSelection,
  isRoomAppStateRateLimitErrorData,
  ROOM_PRESENCE_HEARTBEAT_MS,
  type RequestedRoom,
} from "../../vendor/shared/roomAppState";

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
  artifactId: Id<"artifacts">;
  content: string;
  /** Style for the underlying WebView (defaults to a flex-1 transparent fill). */
  style?: StyleProp<ViewStyle>;
};

export function CodeArtifactWebView({
  artifactId,
  content,
  style,
}: CodeArtifactWebViewProps) {
  const webViewRef = useRef<{ injectJavaScript: (script: string) => void } | null>(
    null,
  );
  const appStateReadyRef = useRef(false);
  const appStateInitializedRef = useRef(false);
  const appStateNonceRef = useRef<string | null>(null);
  const appStateWriteTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
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
      artifactId: Id<"artifacts">;
      patch: Record<string, unknown>;
    }>
  >([]);
  const nextAppStateWriteIdRef = useRef(0);
  // artifactId is stable for this component's lifetime (consumers key on it), so
  // the "active artifact" the async guards below compare against is a constant.
  const activeAppStateArtifactIdRef = useRef<Id<"artifacts">>(artifactId);
  activeAppStateArtifactIdRef.current = artifactId;
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

  const updateAppState = useMutation(api.appStates.updateSessionState);
  const updateRoomState = useMutation(api.appStates.updateRoomState);
  const joinRoomPresence = useMutation(api.appStates.joinRoomPresence);
  const leaveRoomPresence = useMutation(api.appStates.leaveRoomPresence);

  // Key the WebView on id + content hash so an in-place edit reliably reloads it.
  const webViewKey = `${artifactId}:${hashContent(content)}`;
  const appState = useQuery(api.appStates.getSessionState, { artifactId });
  const appStateArtifactId = artifactId;
  const defaultRoom = useQuery(api.rooms.defaultForArtifact, { artifactId });
  const requestedRoomId =
    requestedRoom && requestedRoom.artifactId === appStateArtifactId
      ? requestedRoom.roomId
      : null;
  const activeRoomId: Id<"rooms"> | null | undefined =
    requestedRoomId ??
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
            activeAppStateArtifactIdRef.current !== targetArtifactId
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

  const flushAppState = useCallback(() => {
    clearTimeout(appStateWriteTimerRef.current);
    appStateWriteTimerRef.current = undefined;
    appStatePendingSinceRef.current = undefined;
    if (!appStateArtifactId) return;
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
      return;
    }
    const writeId = nextAppStateWriteIdRef.current++;
    const writeArtifactId = appStateArtifactId;
    if (Object.keys(patch).length > 0) {
      inFlightAppStatePatchesRef.current.push({
        id: writeId,
        artifactId: writeArtifactId,
        patch,
      });
    }
    void updateAppState({
      artifactId: appStateArtifactId,
      patch: Object.keys(patch).length > 0 ? patch : undefined,
      logs: logs.length > 0 ? logs : undefined,
      actions,
    })
      .then(() => {
        inFlightAppStatePatchesRef.current =
          inFlightAppStatePatchesRef.current.filter(
            (entry) => entry.id !== writeId,
          );
      })
      .catch((error) => {
        inFlightAppStatePatchesRef.current =
          inFlightAppStatePatchesRef.current.filter(
            (entry) => entry.id !== writeId,
          );
        if (activeAppStateArtifactIdRef.current === writeArtifactId) {
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
      });
  }, [appStateArtifactId, updateAppState]);

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
        .filter((entry) => entry.artifactId === appStateArtifactId)
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
        appState?.actionRequest,
      ),
    );
    appStateInitializedRef.current = true;
  }, [
    activeRoomId,
    appState,
    appStateArtifactId,
    roomPresence,
    sharedState,
  ]);

  const handleAppStateMessage = useCallback(
    (event: { nativeEvent: { data: string } }) => {
      const message = parseAppStateBridgeMessage(event.nativeEvent.data);
      if (!message) return;
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
        void updateAppState({ artifactId: currentArtifactId, actionResult }).catch(
          (error) =>
            console.warn("[code-webview] failed to acknowledge app action", error),
        );
        return;
      }
      if (message.type === "actions") {
        if (message.actions === undefined) return;
        queueAppActions(message.actions);
        return;
      }
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
      postAppState,
      queueAppActions,
      resolveRoomSelection,
      updateAppState,
    ],
  );

  useEffect(() => {
    if (appState === undefined) return;
    const deferredActions = deferredAppActionsRef.current;
    if (deferredActions !== undefined) queueAppActions(deferredActions);
  }, [appState, queueAppActions]);

  useEffect(() => {
    deferredAppActionsRef.current = undefined;
  }, [appStateArtifactId]);

  useEffect(() => {
    postAppState();
  }, [appState, postAppState]);

  useEffect(() => () => flushAppState(), [flushAppState]);

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

  return (
    <CodeWebView
      ref={webViewRef}
      key={webViewKey}
      source={{ html: content }}
      injectedJavaScriptBeforeContentLoaded={RABBITHOLE_APP_STATE_SDK}
      onLoadStart={() => {
        appStateReadyRef.current = false;
        appStateInitializedRef.current = false;
        appStateNonceRef.current = null;
      }}
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
      // iframes keep working); silently block every other top-frame navigation
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
      // window.open must not spawn a second WebView window (mirrors the iframe
      // sandbox omitting allow-popups).
      setSupportMultipleWindows={false}
      style={[styles.webView, style]}
      javaScriptEnabled
      domStorageEnabled
      allowsInlineMediaPlayback
      mediaPlaybackRequiresUserAction={false}
      bounces={false}
      overScrollMode="never"
    />
  );
}

const styles = StyleSheet.create({
  webView: { flex: 1, backgroundColor: "transparent" },
});
