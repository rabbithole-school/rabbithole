"use client";

import { useCallback, useState, useRef, useEffect, useMemo } from "react";
import { Box, Flex, Text, Button, IconButton, Textarea, HStack } from "@chakra-ui/react";
import { Code, Eye, Trash, ArrowClockwise } from "@phosphor-icons/react";
import { useAction, useConvex, useMutation, useQuery } from "convex/react";
import { EmptyState } from "@/components/ui/EmptyState";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import {
  commitResolvedRoomSelection,
  isRoomAppStateRateLimitErrorData,
  ROOM_PRESENCE_HEARTBEAT_MS,
  type RequestedRoom,
} from "@/shared/roomAppState";
import {
  useAppStateIframeBridge,
  useAppStateIframeSrcDoc,
  withLoadBoundary,
  type CaptureAppSnapshot,
  type AppStateHostUpdate,
} from "@/hooks/useAppStateIframeBridge";
import type { AppTutorRequest } from "@/shared/appTutorRequest";
import {
  routeAppBridgeRequest,
  type AppBridgeRequest,
} from "@/shared/appBridgeRequest";
import { registerArtifactSave } from "./artifactSaveRegistry";
import type { ArtifactSaveResult } from "./ArtifactPanel";
import { createDraftSaveDrain } from "@/shared/draftSaveDrain";
import {
  createArtifactDraftController,
  hasArtifactDraftConflict,
  hasIncomingArtifactConflict,
} from "@/shared/artifactDraftStore";
import { appAssetRef, requestedAppAssetIds } from "@/shared/appAssets";
import {
  effectiveWorkshopView,
  snapshotCaptureForView,
  type WorkshopView,
} from "@/shared/workshopView";

const EMPTY_APP_ASSET_MAP = new Map<string, string>();

interface CodeArtifactViewerProps {
  artifact: {
    _id: string;
    title: string;
    content: string;
    lastEditedBy: string;
    revision?: number;
    language?: string;
  };
  onSave?: (updates: { content?: string; title?: string; baseRevision?: number }) => Promise<ArtifactSaveResult>;
  onDelete?: () => void;
  onSyncChange?: (synced: boolean) => void;
  onSnapshotCaptureReady?: (capture: CaptureAppSnapshot | null) => void;
  onAskTutor?: (request: AppTutorRequest) => void | Promise<void>;
  /** Fired after a character exchange or judgment completes, so the session
   *  screen can queue a tutor update. */
  onAppAiTurn?: () => void;
  /** False when the viewer is not the session's owner (a teacher watching):
   *  the character and judges then answer `unavailable` with no server call,
   *  which would refuse anyway. */
  appAiEnabled?: boolean;
  // Play mode: the app's code is read-only. No Code toggle (Preview only) and
  // no `onSave` — Play must never mutate the teacher's current app.
  // See review/teacher-build-flow.html §4.
  readOnly?: boolean;
  /** A scholar playing an app they do not build (TRA-477): show the app only,
   *  with no toolbar — no lone Preview pill, no refresh, no language label.
   *  Edit and staff keep the toolbar. */
  appOnly?: boolean;
}

export function CodeArtifactViewer({
  artifact,
  onSave,
  onDelete,
  onSyncChange,
  onSnapshotCaptureReady,
  onAskTutor,
  onAppAiTurn,
  appAiEnabled = true,
  readOnly = false,
  appOnly = false,
}: CodeArtifactViewerProps) {
  const [view, setView] = useState<WorkshopView>("preview");
  const effectiveView = effectiveWorkshopView(readOnly, view);
  const [draftController] = useState(() =>
    createArtifactDraftController(String(artifact._id)),
  );
  const restoredDraft = draftController.initialDraft;
  const restoredConflict = hasArtifactDraftConflict(restoredDraft, artifact);
  const [localCode, setLocalCode] = useState(
    restoredDraft?.content ?? artifact.content,
  );
  const localCodeRef = useRef(localCode);
  const [showUpdateBanner, setShowUpdateBanner] = useState(restoredConflict);
  const lastKnownContentRef = useRef(artifact.content);
  const saveTimeoutRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const revisionRef = useRef(artifact.revision ?? 0);
  const conflictRef = useRef(restoredConflict);
  const [saveError, setSaveError] = useState<string | null>(null);
  const onSaveRef = useRef(onSave);
  const readOnlyRef = useRef(readOnly);
  // Whether this viewer FIRST mounted read-only (an initial Play mount). Such a
  // mount never had an editable save path, so a draft restored from local
  // storage here can only be dropped to server truth. A runtime Edit→Play
  // transition is different: the Workshop flushes the draft through the live
  // Edit `onSave` first and stays in Edit if that flush fails, so a draft that
  // survives the transition must never be silently discarded.
  const initialReadOnlyRef = useRef(readOnly);
  useEffect(() => {
    localCodeRef.current = localCode;
  }, [localCode]);
  useEffect(() => {
    onSaveRef.current = onSave;
  }, [onSave]);
  useEffect(() => {
    readOnlyRef.current = readOnly;
  }, [readOnly]);
  const persistDraft = useCallback(() => {
    const snapshot = {
      content: localCodeRef.current,
      serverContent: lastKnownContentRef.current,
      revision: revisionRef.current,
      conflict: conflictRef.current,
    };
    const dirty = localCodeRef.current !== lastKnownContentRef.current;
    if (!dirty && !conflictRef.current) {
      draftController.clear();
      return;
    }
    draftController.write(snapshot);
  }, [draftController]);
  useEffect(() => {
    draftController.claim();
  }, [draftController]);
  const [previewKey, setPreviewKey] = useState(0);
  const artifactId = artifact._id as Id<"artifacts">;
  const activeArtifactIdRef = useRef(artifactId);
  useEffect(() => {
    activeArtifactIdRef.current = artifactId;
  }, [artifactId]);
  const nextRoomSelectionRequestIdRef = useRef(0);
  const [roomSelectionVersion, setRoomSelectionVersion] = useState(0);
  const convex = useConvex();
  const appState = useQuery(api.appStates.getSessionState, { artifactId });
  const resolveAppAssets = useAction(
    api.appAssetHostActions.resolveArtifactAssets,
  );
  const updateAppState = useMutation(api.appStates.updateSessionState);
  const appAiSay = useAction(api.appAiActions.say);
  const appAiJudge = useAction(api.appAiActions.judge);
  const defaultRoom = useQuery(api.rooms.defaultForArtifact, { artifactId });
  const [requestedRoom, setRequestedRoom] = useState<
    RequestedRoom<Id<"artifacts">, Id<"rooms">> | null
  >(null);
  const requestedRoomId =
    requestedRoom?.artifactId === artifactId ? requestedRoom.roomId : null;
  const activeRoomId: Id<"rooms"> | null | undefined =
    requestedRoomId ??
    (defaultRoom === undefined ? undefined : (defaultRoom?._id ?? null));
  const sharedState = useQuery(
    api.appStates.getRoomState,
    activeRoomId ? { roomId: activeRoomId } : "skip",
  );
  const roomPresence = useQuery(
    api.appStates.getRoomPresence,
    activeRoomId ? { roomId: activeRoomId } : "skip",
  );
  const updateRoomState = useMutation(api.appStates.updateRoomState);
  const joinRoomPresence = useMutation(api.appStates.joinRoomPresence);
  const leaveRoomPresence = useMutation(api.appStates.leaveRoomPresence);

  const resolveRoomSelection = useCallback(
    (rawRoomId: string) => {
      const requestId = nextRoomSelectionRequestIdRef.current++;
      void convex
        .query(api.rooms.resolveAccessibleForArtifact, {
          artifactId,
          roomId: rawRoomId,
        })
        .then((room) => {
          if (
            nextRoomSelectionRequestIdRef.current !== requestId + 1 ||
            activeArtifactIdRef.current !== artifactId
          ) {
            return;
          }
          if (!room) {
            // Re-send the committed room so the iframe abandons its rejected raw ID.
            setRoomSelectionVersion((version) => version + 1);
          }
          setRequestedRoom((current) =>
            commitResolvedRoomSelection(current, artifactId, room?._id ?? null),
          );
        })
        .catch((error) =>
          console.error("[rabbithole] failed to resolve shared room", error),
        );
    },
    [artifactId, convex],
  );
  const isSynced = localCode === artifact.content;

  // An empty (or whitespace-only) code artifact's Preview is a featureless
  // blank-white iframe — indistinguishable from "broken screen" to a kid. In
  // the Preview view we swap in the house empty state. The Code view keeps its
  // editable textarea (with a kid-appropriate placeholder) so an empty
  // artifact is still hand-typeable and never unmounts under the cursor.
  const isEmpty = localCode.trim() === "";

  useEffect(() => {
    onSyncChange?.(isSynced);
  }, [isSynced, onSyncChange]);

  const persistAppState = useCallback(
    async (update: AppStateHostUpdate) =>
      await updateAppState({
        artifactId,
        patch: update.patch,
        logs: update.logs,
        actions: update.actions,
        actionResult: update.actionResult,
      }),
    [artifactId, updateAppState],
  );
  // The server resolves artifact → session and records the turn; the bridge
  // tells the session screen (onAppAiTurn) once the app has the success. A
  // non-owner's call would be refused, so it gets `unavailable` at once.
  const answerAppRequest = useCallback(
    (request: AppBridgeRequest) =>
      routeAppBridgeRequest(
        request,
        appAiEnabled
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
      ),
    [appAiEnabled, appAiJudge, appAiSay, artifactId],
  );
  const persistSharedState = useCallback(
    async (roomId: Id<"rooms">, patch: Record<string, unknown>) => {
      while (true) {
        try {
          return await updateRoomState({
            roomId,
            patch,
          });
        } catch (error) {
          const data =
            error && typeof error === "object" && "data" in error
              ? (error as { data?: unknown }).data
              : undefined;
          if (!isRoomAppStateRateLimitErrorData(data)) throw error;
          await new Promise((resolve) =>
            setTimeout(resolve, data.retryAfterMs),
          );
        }
      }
    },
    [updateRoomState],
  );
  const {
    iframeRef,
    onLoad: onAppFrameLoad,
    captureSnapshot,
    currentLoadBoundary,
  } = useAppStateIframeBridge({
    identity: `session:${artifactId}`,
    snapshot: appState,
    persist: persistAppState,
    onAskTutor,
    onRequest: answerAppRequest,
    onAppAiTurn,
    shared: {
      roomId: activeRoomId,
      selectionVersion: roomSelectionVersion,
      snapshot: sharedState,
      presence: roomPresence,
      persist: persistSharedState,
      onSelect: resolveRoomSelection,
    },
  });
  const requestedAssetIds = useMemo(
    () => requestedAppAssetIds(localCode),
    [localCode],
  );
  const assetRequestKey = requestedAssetIds.join("\u0000");
  const assetRequestHtml = requestedAssetIds.map(appAssetRef).join("");
  const [assetResolution, setAssetResolution] = useState<{
    key: string;
    urls?: Map<string, string>;
    error?: unknown;
  }>({ key: "", urls: EMPTY_APP_ASSET_MAP });
  useEffect(() => {
    if (assetRequestKey === "") return;
    let cancelled = false;
    void resolveAppAssets({
      artifactId,
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
  }, [artifactId, assetRequestHtml, assetRequestKey, resolveAppAssets]);
  const assetUrls =
    assetRequestKey === ""
      ? EMPTY_APP_ASSET_MAP
      : assetResolution.key === assetRequestKey
      ? (assetResolution.urls ?? null)
      : null;
  const sandbox = useAppStateIframeSrcDoc(localCode, appState, assetUrls);
  if (
    assetResolution.key === assetRequestKey &&
    assetResolution.error !== undefined
  ) {
    throw assetResolution.error;
  }

  useEffect(() => {
    // Read-only rendering pins the view to Preview via `effectiveView`, so the
    // capture registration must key on the SAME source of truth. Testing the
    // raw `view` here left `onSnapshotCaptureReady(null)` registered after a
    // Code→Play switch — the iframe was visible but Play turns could not upload
    // the app snapshot the coaching path reads (N2).
    onSnapshotCaptureReady?.(
      snapshotCaptureForView(
        effectiveView,
        isEmpty,
        withLoadBoundary(captureSnapshot, currentLoadBoundary),
      ),
    );
    return () => onSnapshotCaptureReady?.(null);
  }, [
    captureSnapshot,
    currentLoadBoundary,
    isEmpty,
    onSnapshotCaptureReady,
    effectiveView,
  ]);

  useEffect(() => {
    if (!activeRoomId) return;
    void joinRoomPresence({ roomId: activeRoomId });
    const heartbeat = setInterval(() => {
      void joinRoomPresence({ roomId: activeRoomId });
    }, ROOM_PRESENCE_HEARTBEAT_MS);
    return () => {
      clearInterval(heartbeat);
      void leaveRoomPresence({ roomId: activeRoomId });
    };
  }, [activeRoomId, joinRoomPresence, leaveRoomPresence]);

  const save = useCallback(async (content: string) => {
    if (conflictRef.current) {
      throw new Error(
        "This code changed in Rabbithole. Choose a version before continuing.",
      );
    }
    const doSave = onSaveRef.current;
    // Read-only (Play) mounts pass no `onSave`; there is no editor to produce a
    // pending draft, but guard defensively so a stray drain is a no-op.
    if (!doSave) return;
    const result = await doSave({
      content,
      baseRevision: revisionRef.current,
    });
    if (!result.ok) {
      clearTimeout(saveTimeoutRef.current);
      lastKnownContentRef.current = result.artifact.content;
      revisionRef.current = result.artifact.revision ?? 0;
      conflictRef.current = true;
      setShowUpdateBanner(true);
      persistDraft();
      throw new Error("This code changed in Rabbithole. Choose a version before continuing.");
    }
    lastKnownContentRef.current = content;
    revisionRef.current = result.revision;
    setSaveError(null);
    persistDraft();
  }, [persistDraft]);

  const drainSavesRef = useRef<() => Promise<void>>(async () => undefined);
  const drainSaves = useCallback(() => drainSavesRef.current(), []);
  useEffect(() => {
    drainSavesRef.current = createDraftSaveDrain({
      hasPending: () =>
        !readOnlyRef.current &&
        localCodeRef.current !== lastKnownContentRef.current,
      readDraft: () => localCodeRef.current,
      save,
    });
  }, [save]);

  useEffect(() => registerArtifactSave(String(artifactId), async () => {
    clearTimeout(saveTimeoutRef.current);
    await drainSaves();
  }), [artifactId, drainSaves]);

  // Play is read-only: no `onSave` is passed, so a still-pending Edit draft
  // (or a draft restored from local storage on an initial Play mount) can never
  // be saved. Left pending, `hasPending()` stays true while `save()` is a
  // no-op, and the globally-registered drain — awaited by every tutor send via
  // flushAllArtifactSaves() — spins forever and blocks the send (N1). Clearing
  // is limited to an INITIAL Play mount, the only case with no editable save
  // path: drop the unsavable restored draft to server truth so `hasPending()`
  // is false. On a runtime Edit→Play transition the Workshop already flushed
  // through the live Edit `onSave` (and stayed in Edit if that flush failed),
  // so a draft surviving here is NOT silently discarded.
  useEffect(() => {
    if (!readOnly) {
      // Once the viewer has been editable, every later read-only transition is
      // a runtime one the Workshop flushed first: never clear a draft again.
      initialReadOnlyRef.current = false;
      return;
    }
    clearTimeout(saveTimeoutRef.current);
    if (!initialReadOnlyRef.current) return;
    initialReadOnlyRef.current = false;
    if (localCodeRef.current !== lastKnownContentRef.current) {
      localCodeRef.current = lastKnownContentRef.current;
      setLocalCode(lastKnownContentRef.current);
    }
    conflictRef.current = false;
    setShowUpdateBanner(false);
    setSaveError(null);
    draftController.clear();
  }, [readOnly, draftController]);

  useEffect(() => {
    persistDraft();
    return persistDraft;
  }, [persistDraft]);

  // Detect external updates (from AI)
  useEffect(() => {
    if (artifact.content !== lastKnownContentRef.current) {
      const hasConflict = hasIncomingArtifactConflict(
        localCodeRef.current,
        lastKnownContentRef.current,
        artifact.content,
      );
      lastKnownContentRef.current = artifact.content;
      revisionRef.current = artifact.revision ?? 0;
      if (hasConflict) {
        clearTimeout(saveTimeoutRef.current);
        conflictRef.current = true;
        setShowUpdateBanner(true);
        persistDraft();
      } else {
        localCodeRef.current = artifact.content;
        setLocalCode(artifact.content);
        conflictRef.current = false;
        setShowUpdateBanner(false);
        persistDraft();
      }
    } else if ((artifact.revision ?? 0) > revisionRef.current) {
      revisionRef.current = artifact.revision ?? 0;
    }
  }, [artifact.content, artifact.revision, persistDraft]);

  const handleCodeChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const newCode = e.target.value;
    localCodeRef.current = newCode;
    setLocalCode(newCode);
    if (!conflictRef.current) setShowUpdateBanner(false);
    persistDraft();
    setSaveError(null);
    clearTimeout(saveTimeoutRef.current);
    saveTimeoutRef.current = setTimeout(() => {
      void drainSaves().catch(() => {
        setSaveError("Couldn’t save your draft. It is still here—try again.");
      });
    }, 800);
  };

  const handleAcceptUpdate = () => {
    clearTimeout(saveTimeoutRef.current);
    localCodeRef.current = lastKnownContentRef.current;
    setLocalCode(lastKnownContentRef.current);
    conflictRef.current = false;
    setShowUpdateBanner(false);
    setSaveError(null);
    draftController.clear();
  };

  const handleKeepDraft = async () => {
    clearTimeout(saveTimeoutRef.current);
    try {
      conflictRef.current = false;
      await drainSaves();
      setShowUpdateBanner(false);
      draftController.clear();
    } catch {
      setSaveError("Couldn’t save your draft. It is still here—try again.");
    }
  };

  const refreshPreview = () => setPreviewKey((k) => k + 1);

  useEffect(() => {
    return () => {
      clearTimeout(saveTimeoutRef.current);
    };
  }, []);

  return (
    <Flex flex={1} flexDir="column" overflow="hidden">
      {/* Toolbar */}
      {!appOnly && (
        <Flex
          align="center"
          px={3}
          py={2}
          gap={2}
          flexShrink={0}
          borderBottomWidth="1px"
          borderColor="gray.100"
        >
          <HStack gap={1} flex={1}>
            <Button
              size="xs"
              variant={effectiveView === "preview" ? "solid" : "ghost"}
              bg={effectiveView === "preview" ? "violet.500" : undefined}
              color={effectiveView === "preview" ? "white" : "charcoal.500"}
              _hover={effectiveView === "preview" ? { bg: "violet.600" } : { bg: "gray.100" }}
              fontFamily="heading"
              onClick={() => setView("preview")}
            >
              <Eye size={12} style={{ marginRight: "4px" }} />
              Preview
            </Button>
            {!readOnly && (
              <Button
                size="xs"
                variant={view === "code" ? "solid" : "ghost"}
                bg={view === "code" ? "violet.500" : undefined}
                color={view === "code" ? "white" : "charcoal.500"}
                _hover={view === "code" ? { bg: "violet.600" } : { bg: "gray.100" }}
                fontFamily="heading"
                onClick={() => setView("code")}
              >
                <Code size={12} style={{ marginRight: "4px" }} />
                Code
              </Button>
            )}
            {effectiveView === "preview" && (
              <IconButton
                aria-label="Refresh preview"
                size="xs"
                variant="ghost"
                color="charcoal.400"
                _hover={{ color: "violet.500" }}
                onClick={refreshPreview}
              >
                <ArrowClockwise size={12} />
              </IconButton>
            )}
          </HStack>
          <Text fontSize="xs" fontFamily="heading" color="charcoal.300">
            {artifact.language || "html"}
          </Text>
          {onDelete && (
            <IconButton
              aria-label="Delete"
              size="xs"
              variant="ghost"
              color="charcoal.300"
              _hover={{ color: "red.500" }}
              onClick={onDelete}
            >
              <Trash size={12} />
            </IconButton>
          )}
        </Flex>
      )}

      {showUpdateBanner && (
        <Flex px={4} py={2} bg="violet.50" align="center" justify="space-between" flexShrink={0}>
          <Text fontSize="xs" fontFamily="heading" color="violet.700">
            This code changed somewhere else
          </Text>
          <HStack gap={2}>
            <Button size="xs" variant="outline" colorPalette="violet" onClick={handleAcceptUpdate}>
              Use Rabbithole’s version
            </Button>
            <Button size="xs" colorPalette="violet" onClick={() => void handleKeepDraft()}>
              Keep my draft
            </Button>
          </HStack>
        </Flex>
      )}
      {saveError && <Text px={4} py={1} fontSize="xs" color="red.600" role="alert">{saveError}</Text>}

      {/* Content */}
      {effectiveView === "preview" ? (
        isEmpty ? (
          <Flex flex={1} align="center" justify="center" bg="white" p={6}>
            <EmptyState
              size="lg"
              icon={<Code weight="duotone" />}
              title="Nothing here yet"
              hint="Build your document with your tutor — it will show up here."
            />
          </Flex>
        ) : (
          <Box flex={1} overflow="hidden" bg="white">
            {sandbox !== null && (
              <iframe
                ref={iframeRef}
                key={previewKey}
                sandbox="allow-scripts"
                srcDoc={sandbox.srcDoc}
                {...({ csp: sandbox.csp } as { csp: string })}
                onLoad={onAppFrameLoad}
                style={{
                  width: "100%",
                  height: "100%",
                  border: "none",
                  background: "white",
                }}
                title={artifact.title}
              />
            )}
          </Box>
        )
      ) : (
        <Box flex={1} overflow="hidden" p={2}>
          <Textarea
            value={localCode}
            onChange={handleCodeChange}
            placeholder="No code yet — your tutor can start this with you, or type here"
            _placeholder={{ color: "green.600" }}
            fontFamily="monospace"
            fontSize="xs"
            lineHeight="1.5"
            resize="none"
            h="100%"
            bg="gray.900"
            color="green.300"
            border="none"
            borderRadius="md"
            p={3}
            spellCheck={false}
            _focus={{ boxShadow: "none", outline: "none" }}
          />
        </Box>
      )}
    </Flex>
  );
}
