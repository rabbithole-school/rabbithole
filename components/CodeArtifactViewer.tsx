"use client";

import { useCallback, useState, useRef, useEffect } from "react";
import { Box, Flex, Text, Button, IconButton, Textarea, HStack } from "@chakra-ui/react";
import { Code, Eye, Trash, ArrowClockwise } from "@phosphor-icons/react";
import { useConvex, useMutation, useQuery } from "convex/react";
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
  injectAppStateSdk,
} from "@/lib/appStateBridge.mjs";
import {
  useAppStateIframeBridge,
  type AppStateHostUpdate,
} from "@/hooks/useAppStateIframeBridge";
import { registerArtifactSave } from "./artifactSaveRegistry";
import type { ArtifactSaveResult } from "./ArtifactPanel";
import { createDraftSaveDrain } from "@/shared/draftSaveDrain";
import {
  createArtifactDraftController,
  hasArtifactDraftConflict,
  hasIncomingArtifactConflict,
} from "@/shared/artifactDraftStore";

interface CodeArtifactViewerProps {
  artifact: {
    _id: string;
    title: string;
    content: string;
    lastEditedBy: string;
    revision?: number;
    language?: string;
  };
  onSave: (updates: { content?: string; title?: string; baseRevision?: number }) => Promise<ArtifactSaveResult>;
  onDelete?: () => void;
  onSyncChange?: (synced: boolean) => void;
}

export function CodeArtifactViewer({
  artifact,
  onSave,
  onDelete,
  onSyncChange,
}: CodeArtifactViewerProps) {
  const [view, setView] = useState<"preview" | "code">("preview");
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
  useEffect(() => {
    localCodeRef.current = localCode;
  }, [localCode]);
  useEffect(() => {
    onSaveRef.current = onSave;
  }, [onSave]);
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
  const updateAppState = useMutation(api.appStates.updateSessionState);
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
  const srcDoc = injectAppStateSdk(localCode);

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
  const { iframeRef, onLoad: onAppFrameLoad } = useAppStateIframeBridge({
    identity: `session:${artifactId}`,
    snapshot: appState,
    persist: persistAppState,
    shared: {
      roomId: activeRoomId,
      selectionVersion: roomSelectionVersion,
      snapshot: sharedState,
      presence: roomPresence,
      persist: persistSharedState,
      onSelect: resolveRoomSelection,
    },
  });

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
    const result = await onSaveRef.current({
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
      hasPending: () => localCodeRef.current !== lastKnownContentRef.current,
      readDraft: () => localCodeRef.current,
      save,
    });
  }, [save]);

  useEffect(() => registerArtifactSave(String(artifactId), async () => {
    clearTimeout(saveTimeoutRef.current);
    await drainSaves();
  }), [artifactId, drainSaves]);

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
            variant={view === "preview" ? "solid" : "ghost"}
            bg={view === "preview" ? "violet.500" : undefined}
            color={view === "preview" ? "white" : "charcoal.500"}
            _hover={view === "preview" ? { bg: "violet.600" } : { bg: "gray.100" }}
            fontFamily="heading"
            onClick={() => setView("preview")}
          >
            <Eye size={12} style={{ marginRight: "4px" }} />
            Preview
          </Button>
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
          {view === "preview" && (
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
      {view === "preview" ? (
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
            <iframe
              ref={iframeRef}
              key={previewKey}
              sandbox="allow-scripts"
              srcDoc={srcDoc}
              onLoad={onAppFrameLoad}
              style={{
                width: "100%",
                height: "100%",
                border: "none",
                background: "white",
              }}
              title={artifact.title}
            />
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
