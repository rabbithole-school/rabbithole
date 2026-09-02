"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { Box, Dialog, Flex, IconButton, Input, Text, Textarea, Button, HStack, Menu, Portal } from "@chakra-ui/react";
import { Plus, Trash, CaretDown, CaretRight, Check, PencilSimple, X } from "@phosphor-icons/react";
import { StyledDialogContent } from "@/components/ui/StyledDialogContent";
import { DeliverableKindIcon } from "@/components/DeliverableKindIcon";
import {
  flushAllArtifactSaves,
  clearArtifactSave,
  registerArtifactSave,
} from "./artifactSaveRegistry";
import { createDraftSaveDrain } from "@/shared/draftSaveDrain";
import {
  createArtifactDraftController,
  hasArtifactDraftConflict,
  hasIncomingArtifactConflict,
} from "@/shared/artifactDraftStore";

// ──────────────────────────────────────────────────────────────────────
// Pending-saves flush registry
//
// The artifact editor debounces saves by 500ms to avoid hammering
// Convex on every keystroke. But the AI tutor's context fetch (when
// the scholar sends a chat message) reads the artifact straight from
// the DB — so an unflushed edit means the AI sees stale content and
// will say things like "your edit might not have saved."
//
// Every active ArtifactEditor registers a flushPending() callback
// here on mount, unregisters on unmount. The chat send path
// (SessionInterface.handleSend) calls flushAllArtifactSaves() and
// awaits it before kicking off the HTTP stream, guaranteeing the
// AI sees the scholar's latest text.
// ──────────────────────────────────────────────────────────────────────

export { flushAllArtifactSaves } from "./artifactSaveRegistry";
import { ProcessPanel } from "./ProcessPanel";
import type { ProcessDefinition, ProcessStep } from "./ProcessPanel";
import { CodeArtifactViewer } from "./CodeArtifactViewer";
import { ArtifactDeliverableButton } from "./ArtifactDeliverableButton";
import { PhotoDeliverablePanel } from "./PhotoDeliverablePanel";
import { MapArtifactView } from "./geomap/MapArtifactView";
import { SlidesArtifactView, EmptyDeckSlidesEditor } from "./slides/SlidesArtifactView";
import { ManipulativeArtifactView } from "./manipulative/ManipulativeArtifactView";
import { parseStoredMapArtifact } from "@/lib/geomap/stored";

interface ArtifactDoc {
  _id: string;
  title: string;
  content: string;
  lastEditedBy: string;
  revision?: number;
  type?: "text" | "code" | "map" | "slides" | "manipulative";
  language?: string;
}

// Mapbox public token (Next inlines NEXT_PUBLIC_* at build). Present in every
// deployed environment (Vercel Production/Preview/Development on both rabbithole
// and rhtest); absent only in a local checkout that hasn't set it, where GeoMap
// falls back to its friendly offline state. Read at MODULE scope because the
// component below shadows the global `process` with a `process` prop
// (ProcessDefinition).
const MAPBOX_TOKEN = process.env.NEXT_PUBLIC_MAPBOX_TOKEN ?? null;

interface ArtifactPanelProps {
  artifacts: ArtifactDoc[];
  activeArtifactId: string | null;
  onSelectArtifact: (id: string) => void;
  onSave: (
    artifactId: string,
    updates: { content?: string; title?: string; baseRevision?: number },
  ) => Promise<ArtifactSaveResult>;
  onCreateArtifact: () => void;
  onDeleteArtifact: (id: string) => void | Promise<void>;
  onSyncChange?: (synced: boolean) => void;
  /** When true, the Check button on each artifact is disabled —
   *  clicking it would otherwise no-op silently because
   *  SessionInterface.handleSend bails while a previous stream is
   *  in flight. */
  isStreaming?: boolean;
  /** True while the AI is mid-stream calling `update_rubric_score`.
   *  Drives the check button's spinner so the scholar sees the check
   *  is in flight before any newly-earned flair appears. */
  isAiCheckingRubric?: boolean;
  /** Submit the visible document and, when it has criteria, ask the tutor to
   *  evaluate it. */
  onSubmitArtifact?: (
    artifact: ArtifactDoc,
    shouldCheck: boolean,
  ) => Promise<void>;
  youtubeUrl?: string | null;
  process?: ProcessDefinition | null;
  processCurrentStep?: string;
  processSteps?: ProcessStep[];
  /** Deliverable-rubric context for the project. When present, each
   *  artifact gets a per-document Check pill next to its title that
   *  carries its own rubric verdict — two drafts of the same story
   *  produce two independent checks. */
  deliverableContext?: {
    sessionId: import("@/convex/_generated/dataModel").Id<"sessions">;
    activityId: import("@/convex/_generated/dataModel").Id<"activities">;
    activityTitle: string;
    deliverableSpec: {
      kind: "photo" | "artifact" | "slides" | "text" | "audio" | "map";
      prompt: string;
      mode: "manual" | "auto" | "none";
      criteria: Array<{ id: string; label: string; description?: string }>;
      criteriaStatus?: "pending" | "ready" | "error" | null;
      criteriaError?: string | null;
    };
  };
  /** Viewer is not the session owner (teacher remote view) — map pin
   *  edits would be rejected server-side, so hide those affordances. */
  mapReadOnly?: boolean;
  /** Commit affordance on the map surface: sends a scholar-voice turn so the
   *  tutor reacts to the current pins. Reuses SessionInterface's send path. */
  onMapCommit?: (text: string) => void;
  /** Kickoff is still blocking sends — disables the map commit button so it's
   *  enabled exactly when the send path would accept the turn. */
  kickoffBlocksSending?: boolean;
  /** False in the teacher remote view. Newly earned flair enters the deliverable
   *  surface as the scholar's own live event; an observer's chips stay static,
   *  matching the transcript notice, which never animates for them either. */
  animateFlairArrivals?: boolean;
}

export type ArtifactSaveResult =
  | { ok: true; revision: number }
  | {
      ok: false;
      conflict: true;
      artifact: {
        _id: string;
        title: string;
        content: string;
        revision?: number;
        lastEditedBy: string;
      };
    };

export function ArtifactPanel({
  artifacts,
  activeArtifactId,
  onSelectArtifact,
  onSave,
  onCreateArtifact,
  onDeleteArtifact,
  onSyncChange,
  onSubmitArtifact,
  isStreaming = false,
  isAiCheckingRubric = false,
  youtubeUrl,
  process,
  processCurrentStep,
  processSteps,
  deliverableContext,
  mapReadOnly = false,
  onMapCommit,
  kickoffBlocksSending = false,
  animateFlairArrivals = true,
}: ArtifactPanelProps) {
  const hasProcess = !!(process && processCurrentStep && processSteps);
  const hasArtifacts = artifacts.length > 0;

  // Rename dialog state — triggered from the doc menu (Rename this
  // document). We need this here (not inside ArtifactEditor) because
  // the editor no longer renders a title input — the title lives on
  // the outer menu chip.
  const [renameOpen, setRenameOpen] = useState(false);
  const [renameDraft, setRenameDraft] = useState("");
  const [renameError, setRenameError] = useState<string | null>(null);
  const [renameSaving, setRenameSaving] = useState(false);

  // Process accordion state — kept because process is a separate
  // concept from documents and a scholar may want to collapse it to
  // give the active document more room.
  const [processExpanded, setProcessExpanded] = useState(true);

  // Auto-expand process when it first appears
  useEffect(() => {
    // Intentional: expand the process section when the process becomes available.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (hasProcess) setProcessExpanded(true);
  }, [hasProcess]);

  // Auto-switch to a newly-added artifact so the scholar sees the
  // new document immediately (replaces the old auto-expand behavior
  // from when the panel showed multiple artifacts at once).
  const prevIdsRef = useRef<Set<string>>(new Set(artifacts.map((a) => a._id)));
  useEffect(() => {
    const prevIds = prevIdsRef.current;
    const newIds = artifacts.filter((a) => !prevIds.has(a._id)).map((a) => a._id);
    if (newIds.length > 0) {
      // Last added wins (typically only one at a time anyway).
      void flushAllArtifactSaves()
        .then(() => onSelectArtifact(newIds[newIds.length - 1]))
        .catch(() => undefined);
    }
    prevIdsRef.current = new Set(artifacts.map((a) => a._id));
  }, [artifacts, onSelectArtifact]);

  const handleProcessTabClick = () => {
    setProcessExpanded((v) => !v);
  };

  // Resolve the artifact currently shown. The panel renders ONE
  // artifact at a time — switching happens via the title-dropdown
  // menu, not via an accordion of tabs.
  const activeArtifact =
    artifacts.find((a) => a._id === activeArtifactId) ?? artifacts[0] ?? null;
  const mapIsDeliverable =
    activeArtifact?.type === "map" &&
    deliverableContext?.deliverableSpec.kind === "map";
  const activeMapHasWork =
    activeArtifact?.type === "map" &&
    (parseStoredMapArtifact(activeArtifact.content)?.scholarPins.length ?? 0) > 0;

  const deleteArtifactSafely = async (artifactId: string) => {
    await flushAllArtifactSaves();
    await onDeleteArtifact(artifactId);
    clearArtifactSave(artifactId);
  };

  const saveRename = async () => {
    if (!activeArtifact) return;
    const title = renameDraft.trim();
    if (!title || title === activeArtifact.title) {
      setRenameOpen(false);
      return;
    }
    setRenameSaving(true);
    setRenameError(null);
    try {
      await flushAllArtifactSaves();
    } catch {
      setRenameError(
        "Choose a document version or retry its save before renaming.",
      );
      setRenameSaving(false);
      return;
    }
    try {
      let result = await onSave(activeArtifact._id, {
        title,
        baseRevision: activeArtifact.revision ?? 0,
      });
      if (!result.ok) {
        result = await onSave(activeArtifact._id, {
          title,
          baseRevision: result.artifact.revision ?? 0,
        });
      }
      if (!result.ok) {
        setRenameError("Couldn’t rename this document. Please try again.");
        return;
      }
      setRenameOpen(false);
    } catch {
      setRenameError("Couldn’t rename this document. Please try again.");
    } finally {
      setRenameSaving(false);
    }
  };

  // Extract YouTube video ID for embed
  const youtubeVideoId = youtubeUrl ? extractYouTubeId(youtubeUrl) : null;

  // Neither section has content. For a kind-aware deliverable, tell the truth
  // about what the scholar is meant to produce instead of the generic
  // "No documents yet" text panel (which is only honest for text/artifact).
  if (!hasProcess && !hasArtifacts && !youtubeVideoId) {
    const kind = deliverableContext?.deliverableSpec.kind;
    // Photo: a real capture + submit surface (Phase 1).
    if (kind === "photo" && deliverableContext) {
      return (
        <PhotoDeliverablePanel
          sessionId={deliverableContext.sessionId}
          activityId={deliverableContext.activityId}
          prompt={deliverableContext.deliverableSpec.prompt}
          mode={deliverableContext.deliverableSpec.mode}
          criteria={deliverableContext.deliverableSpec.criteria}
          criteriaStatus={deliverableContext.deliverableSpec.criteriaStatus}
          criteriaError={deliverableContext.deliverableSpec.criteriaError}
          disabled={isStreaming}
          animateFlairArrivals={animateFlairArrivals}
        />
      );
    }
    // Slides: no backing artifact yet — create the real deck, then the panel
    // re-renders with the artifact-backed editor.
    if (kind === "slides" && deliverableContext) {
      return (
        <Flex flex={1} flexDir="column" overflow="hidden" bg="gray.50">
          <EmptyDeckSlidesEditor
            sessionId={deliverableContext.sessionId}
            readOnly={mapReadOnly}
          />
        </Flex>
      );
    }
    // Audio: honest empty state — no capture path is built yet (deferred by the
    // deliverable-kinds plan §5.3). Say so plainly rather than dropping the
    // scholar into a text editor that doesn't match the promise.
    if (kind === "audio" && deliverableContext) {
      return (
        <PendingKindEmptyState
          kind={kind}
          prompt={deliverableContext.deliverableSpec.prompt}
        />
      );
    }
    if (kind === "map" && deliverableContext) {
      return (
        <Flex flex={1} flexDir="column" align="center" justify="center" bg="gray.50" gap={4} p={6}>
          <DeliverableKindIcon kind="map" size={40} color="violet.400" />
          <Text fontSize="sm" fontFamily="body" color="charcoal.600" lineHeight="1.5" maxW="md" textAlign="center">
            {deliverableContext.deliverableSpec.prompt}
          </Text>
          <Text fontSize="xs" fontFamily="body" color="charcoal.400" maxW="sm" textAlign="center" lineHeight="1.5">
            Your tutor will open the map here when it is time to work on it.
          </Text>
        </Flex>
      );
    }
    return (
      <Flex flex={1} flexDir="column" align="center" justify="center" bg="gray.50" gap={3} p={6}>
        <Text fontSize="sm" fontFamily="heading" color="charcoal.300">
          No documents yet
        </Text>
        <Button
          size="sm"
          variant="outline"
          colorPalette="violet"
          onClick={onCreateArtifact}
        >
          <Plus />
          Add Document
        </Button>
      </Flex>
    );
  }

  return (
    <Flex flex={1} flexDir="column" overflow="hidden" bg="gray.50" gap={4} px={4} pt={1} pb={3}>
      {/* ── YouTube video embed ── */}
      {youtubeVideoId && (
        <Box flexShrink={0} pt={2}>
          <Box
            borderRadius="lg"
            overflow="hidden"
            shadow="0 1px 3px rgba(0,0,0,0.08)"
            bg="black"
            css={{ aspectRatio: "16 / 9" }}
          >
            <iframe
              width="100%"
              height="100%"
              src={`https://www.youtube.com/embed/${youtubeVideoId}`}
              title="Video"
              allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
              allowFullScreen
              style={{ border: "none", display: "block" }}
            />
          </Box>
        </Box>
      )}

      {/* ── Process section ── */}
      {hasProcess && (
        <Flex flexDir="column" overflow="hidden" flexShrink={0}>
          {/* Process tab bar — on gray background */}
          <Flex py={3} align="center" gap={1} flexShrink={0}>
            <HStack gap={0.5} flex={1}>
              <Button
                size="sm"
                variant="ghost"
                fontFamily="heading"
                fontWeight={processExpanded ? "600" : "400"}
                color={processExpanded ? "navy.500" : "charcoal.400"}
                bg={processExpanded ? "white" : "transparent"}
                shadow={processExpanded ? "0 1px 3px rgba(0,0,0,0.08)" : "none"}
                _hover={{ bg: "white" }}
                borderRadius="md"
                px={2}
                py={2}
                h="auto"
                minH="24px"
                onClick={handleProcessTabClick}
                maxW="160px"
                overflow="hidden"
                textOverflow="ellipsis"
                whiteSpace="nowrap"
                gap={1}
              >
                {processExpanded ? <CaretDown size={14} style={{ flexShrink: 0 }} /> : <CaretRight size={14} style={{ flexShrink: 0 }} />}
                <Text as="span" flexShrink={0}>{process!.emoji || "📋"}</Text>
                {process!.title.length > 18 ? process!.title.slice(0, 18) + "..." : process!.title}
              </Button>
            </HStack>
          </Flex>
          {/* Process content — white card */}
          {processExpanded && (
            <Box
              overflow="auto"
              bg="white"
              borderRadius="lg"
              shadow="0 1px 3px rgba(0,0,0,0.08)"
            >
              <ProcessPanel
                process={process!}
                currentStep={processCurrentStep!}
                steps={processSteps!}
              />
            </Box>
          )}
        </Flex>
      )}

      {/* ── Active document section ──
          The panel shows ONE document at a time. Layout:
            1. Centered title (menu trigger) with snug chevron — the
               title doubles as the document switcher / add / delete
               menu.
            2. Centered stars-subtitle pill — same Refresh popover,
               but framed as the document's status line rather than a
               separate panel chrome at the bottom.
            3. The white doc card filling remaining space. */}
      {activeArtifact && (
        <Flex flexDir="column" overflow="hidden" flex={1}>
          <Flex pt={2} pb={1} align="center" justify="center" flexShrink={0}>
            <Menu.Root
              positioning={{ placement: "bottom" }}
              onSelect={(d) => {
                const val = String(d.value);
                if (val === "__add__") {
                  onCreateArtifact();
                } else if (val === "__delete__") {
                  void deleteArtifactSafely(activeArtifact._id).catch(
                    () => undefined,
                  );
                } else if (val === "__rename__") {
                  setRenameDraft(activeArtifact.title);
                  setRenameOpen(true);
                }
                // Document switches arrive via the RadioItemGroup's
                // onValueChange below, not here.
              }}
            >
              <Menu.Trigger asChild>
                <Button
                  size="sm"
                  variant="ghost"
                  fontFamily="heading"
                  fontWeight="700"
                  color="navy.500"
                  bg="transparent"
                  _hover={{ bg: "gray.100", color: "violet.600" }}
                  borderRadius="md"
                  px={2}
                  py={1}
                  h="auto"
                  minH="28px"
                  maxW="100%"
                  minW={0}
                  overflow="hidden"
                  gap={1}
                >
                  <Text
                    as="span"
                    overflow="hidden"
                    textOverflow="ellipsis"
                    whiteSpace="nowrap"
                    fontSize="md"
                  >
                    {activeArtifact.title}
                  </Text>
                  <CaretDown size={14} style={{ flexShrink: 0 }} />
                </Button>
              </Menu.Trigger>
              <Portal>
                <Menu.Positioner>
                  <Menu.Content minW="240px" fontSize="sm">
                    {/* All artifacts as a radio group — the active
                        one shows a checkmark via Menu.ItemIndicator.
                        Switching is handled here (not in Menu.Root's
                        onSelect) so Chakra manages the selected
                        value's checkmark state. */}
                    <Menu.RadioItemGroup
                      value={activeArtifact._id}
                      onValueChange={(d) => {
                        if (d.value && d.value !== activeArtifact._id) {
                          void flushAllArtifactSaves()
                            .then(() => onSelectArtifact(d.value))
                            .catch(() => undefined);
                        }
                      }}
                    >
                      <Menu.ItemGroupLabel>
                        Select a document
                      </Menu.ItemGroupLabel>
                      {artifacts.map((a) => (
                        <Menu.RadioItem
                          key={a._id}
                          value={a._id}
                          cursor="pointer"
                        >
                          <Menu.ItemIndicator>
                            <Check />
                          </Menu.ItemIndicator>
                          <Text
                            as="span"
                            overflow="hidden"
                            textOverflow="ellipsis"
                            whiteSpace="nowrap"
                          >
                            {a.title}
                          </Text>
                        </Menu.RadioItem>
                      ))}
                    </Menu.RadioItemGroup>
                    <Menu.Separator />
                    <Menu.Item value="__rename__" cursor="pointer">
                      <PencilSimple />
                      Rename this document
                    </Menu.Item>
                    <Menu.Item value="__add__" cursor="pointer">
                      <Plus />
                      Add new document
                    </Menu.Item>
                    <Menu.Item
                      value="__delete__"
                      color="red.600"
                      cursor="pointer"
                    >
                      <Trash />
                      Delete this document
                    </Menu.Item>
                  </Menu.Content>
                </Menu.Positioner>
              </Portal>
            </Menu.Root>
          </Flex>

          {/* Document content — white card */}
          <Flex
            flex={1}
            flexDir="column"
            overflow="hidden"
            bg="white"
            borderRadius="lg"
            shadow="0 1px 3px rgba(0,0,0,0.08)"
          >
            {activeArtifact.type === "map" ? (
              <MapArtifactView
                key={activeArtifact._id}
                artifactId={
                  activeArtifact._id as import("@/convex/_generated/dataModel").Id<"artifacts">
                }
                content={activeArtifact.content}
                token={MAPBOX_TOKEN}
                readOnly={mapReadOnly}
                onMapCommit={mapIsDeliverable ? undefined : onMapCommit}
                isStreaming={isStreaming}
                kickoffBlocksSending={kickoffBlocksSending}
              />
            ) : activeArtifact.type === "slides" ? (
              <SlidesArtifactView
                key={activeArtifact._id}
                artifactId={
                  activeArtifact._id as import("@/convex/_generated/dataModel").Id<"artifacts">
                }
                content={activeArtifact.content}
                readOnly={mapReadOnly}
              />
            ) : activeArtifact.type === "manipulative" ? (
              <ManipulativeArtifactView
                key={activeArtifact._id}
                content={activeArtifact.content}
              />
            ) : activeArtifact.type === "code" ? (
              <CodeArtifactViewer
                key={activeArtifact._id}
                artifact={activeArtifact}
                onSave={(updates) =>
                  onSave(activeArtifact._id, {
                    ...updates,
                    baseRevision: updates.baseRevision ?? activeArtifact.revision ?? 0,
                  })
                }
                onDelete={() => {
                  void deleteArtifactSafely(activeArtifact._id).catch(
                    () => undefined,
                  );
                }}
                onSyncChange={onSyncChange}
              />
            ) : (
              <ArtifactEditor
                key={activeArtifact._id}
                artifact={activeArtifact}
                onSave={(updates) =>
                  onSave(activeArtifact._id, {
                    ...updates,
                    baseRevision: updates.baseRevision ?? activeArtifact.revision ?? 0,
                  })
                }
                onDelete={() => {
                  void deleteArtifactSafely(activeArtifact._id).catch(
                    () => undefined,
                  );
                }}
                onSyncChange={onSyncChange}
              />
            )}
          </Flex>
          {/* A `manipulative` artifact is an ad-hoc, ungraded poke-able model —
              it must NEVER show the active activity's deliverable "Check my
              work" button (that would log a learning record against a thing the
              tutor dropped mid-chat). map/slides/text/code behavior is unchanged. */}
          {deliverableContext &&
            (deliverableContext.deliverableSpec.kind === "map"
              ? activeArtifact.type === "map"
              : activeArtifact.type !== "map" &&
                activeArtifact.type !== "manipulative") && (
            <Flex justify="center" pt={3} flexShrink={0}>
              <ArtifactDeliverableButton
                sessionId={deliverableContext.sessionId}
                activityId={deliverableContext.activityId}
                artifactId={
                  activeArtifact._id as import("@/convex/_generated/dataModel").Id<"artifacts">
                }
                deliverableSpec={deliverableContext.deliverableSpec}
                onSubmit={
                  onSubmitArtifact
                    ? () =>
                        onSubmitArtifact(
                          activeArtifact,
                          deliverableContext.deliverableSpec.criteria.length > 0,
                        )
                    : undefined
                }
                checkDisabled={
                  isStreaming ||
                  (activeArtifact.type === "map" && !activeMapHasWork)
                }
                isAiCheckingRubric={isAiCheckingRubric}
                animateFlairArrivals={animateFlairArrivals}
              />
            </Flex>
          )}
        </Flex>
      )}

      {/* Rename dialog — triggered from the doc menu. Saves the new
          title via the same onSave callback the editor used to use. */}
      {activeArtifact && (
        <Dialog.Root
          open={renameOpen}
          onOpenChange={(d) => setRenameOpen(d.open)}
          placement="center"
          motionPreset="slide-in-bottom"
        >
          <Portal>
            <Dialog.Backdrop />
            <Dialog.Positioner>
              <StyledDialogContent maxW="md">
                <Dialog.Header px={6} pt={5} pb={2}>
                  <Dialog.Title
                    fontFamily="heading"
                    fontWeight="700"
                    color="navy.500"
                    fontSize="lg"
                    flex={1}
                  >
                    Rename document
                  </Dialog.Title>
                  <Dialog.CloseTrigger asChild>
                    <IconButton
                      aria-label="Close"
                      size="sm"
                      variant="ghost"
                      color="charcoal.400"
                      _hover={{ bg: "gray.100" }}
                    >
                      <X />
                    </IconButton>
                  </Dialog.CloseTrigger>
                </Dialog.Header>
                <Dialog.Body px={6} py={3}>
                  <Input
                    value={renameDraft}
                    onChange={(e) => {
                      setRenameDraft(e.target.value);
                      setRenameError(null);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        const next = renameDraft.trim();
                        if (next && next !== activeArtifact.title) void saveRename();
                      }
                      if (e.key === "Escape") setRenameOpen(false);
                    }}
                    autoFocus
                    fontFamily="heading"
                    fontSize="md"
                  />
                  {renameError && (
                    <Text mt={2} fontSize="sm" color="red.600" role="alert">
                      {renameError}
                    </Text>
                  )}
                </Dialog.Body>
                <Dialog.Footer px={6} pb={5} pt={3}>
                  <Button
                    variant="ghost"
                    fontFamily="heading"
                    size="sm"
                    onClick={() => setRenameOpen(false)}
                  >
                    Cancel
                  </Button>
                  <Button
                    bg="violet.500"
                    color="white"
                    _hover={{ bg: "violet.700" }}
                    fontFamily="heading"
                    size="sm"
                    onClick={() => {
                      const next = renameDraft.trim();
                      if (next && next !== activeArtifact.title) {
                        void saveRename();
                      }
                    }}
                    disabled={
                      renameSaving ||
                      !renameDraft.trim() ||
                      renameDraft.trim() === activeArtifact.title
                    }
                  >
                    Save
                  </Button>
                </Dialog.Footer>
              </StyledDialogContent>
            </Dialog.Positioner>
          </Portal>
        </Dialog.Root>
      )}
    </Flex>
  );
}

// Single document editor
function ArtifactEditor({
  artifact,
  onSave,
  onSyncChange,
}: {
  artifact: ArtifactDoc;
  onSave: (updates: { content?: string; title?: string; baseRevision?: number }) => Promise<ArtifactSaveResult>;
  onDelete?: () => void;
  onSyncChange?: (synced: boolean) => void;
}) {
  const [draftController] = useState(() =>
    createArtifactDraftController(artifact._id),
  );
  const restoredDraft = draftController.initialDraft;
  const restoredConflict = hasArtifactDraftConflict(restoredDraft, artifact);
  const [localContent, setLocalContent] = useState(
    restoredDraft?.content ?? artifact.content,
  );
  const [localTitle, setLocalTitle] = useState(
    restoredDraft?.title ?? artifact.title,
  );
  const [showUpdateBanner, setShowUpdateBanner] = useState(restoredConflict);
  const lastKnownContentRef = useRef(artifact.content);
  const lastKnownTitleRef = useRef(artifact.title);
  const saveContentTimeoutRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const saveTitleTimeoutRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const revisionRef = useRef(artifact.revision ?? 0);
  const conflictRef = useRef(restoredConflict);
  const [saveError, setSaveError] = useState<string | null>(null);

  // Stable refs to current values so the registered flush closure
  // always sees the latest typed text, regardless of when it fires.
  const localContentRef = useRef(localContent);
  const localTitleRef = useRef(localTitle);
  const onSaveRef = useRef(onSave);
  useEffect(() => {
    localContentRef.current = localContent;
  }, [localContent]);
  useEffect(() => {
    localTitleRef.current = localTitle;
  }, [localTitle]);
  useEffect(() => {
    onSaveRef.current = onSave;
  }, [onSave]);

  const persistDraft = useCallback(() => {
    const snapshot = {
      content: localContentRef.current,
      title: localTitleRef.current,
      serverContent: lastKnownContentRef.current,
      serverTitle: lastKnownTitleRef.current,
      revision: revisionRef.current,
      conflict: conflictRef.current,
    };
    const dirty =
      localContentRef.current !== lastKnownContentRef.current ||
      localTitleRef.current !== lastKnownTitleRef.current;
    if (!dirty && !conflictRef.current) {
      draftController.clear();
      return;
    }
    draftController.write(snapshot);
  }, [draftController]);

  useEffect(() => {
    draftController.claim();
  }, [draftController]);

  const drainSavesRef = useRef<() => Promise<void>>(async () => undefined);
  const drainSaves = useCallback(() => drainSavesRef.current(), []);
  useEffect(() => {
    drainSavesRef.current = createDraftSaveDrain({
      hasPending: () =>
        localContentRef.current !== lastKnownContentRef.current ||
        localTitleRef.current !== lastKnownTitleRef.current,
      readDraft: () => ({
        content: localContentRef.current,
        title: localTitleRef.current,
      }),
      save: async ({ content, title }) => {
        if (conflictRef.current) {
          throw new Error(
            "This document changed in Rabbithole. Choose a version before continuing.",
          );
        }
        const contentDirty = content !== lastKnownContentRef.current;
        const titleDirty = title !== lastKnownTitleRef.current;
        const result = await onSaveRef.current({
          ...(contentDirty ? { content } : {}),
          ...(titleDirty ? { title } : {}),
          baseRevision: revisionRef.current,
        });
        if (!result.ok) {
          lastKnownContentRef.current = result.artifact.content;
          lastKnownTitleRef.current = result.artifact.title;
          revisionRef.current = result.artifact.revision ?? 0;
          conflictRef.current = true;
          setShowUpdateBanner(true);
          persistDraft();
          throw new Error(
            "This document changed in Rabbithole. Choose a version before continuing.",
          );
        }
        revisionRef.current = result.revision;
        if (contentDirty) lastKnownContentRef.current = content;
        if (titleDirty) lastKnownTitleRef.current = title;
        setSaveError(null);
        persistDraft();
      },
    });
  }, [persistDraft]);

  // Register a pending-save flusher for this editor. Called by
  // SessionInterface.handleSend before any chat send, so the AI's
  // context never sees pre-edit content.
  useEffect(() => {
    const id = artifact._id;
    return registerArtifactSave(id, async () => {
      clearTimeout(saveContentTimeoutRef.current);
      clearTimeout(saveTitleTimeoutRef.current);
      await drainSaves();
    });
  }, [artifact._id, drainSaves]);

  useEffect(() => {
    persistDraft();
    return persistDraft;
  }, [persistDraft]);

  const isSynced = localContent === artifact.content && localTitle === artifact.title;

  useEffect(() => {
    onSyncChange?.(isSynced);
  }, [isSynced, onSyncChange]);

  useEffect(() => {
    if (artifact.content !== lastKnownContentRef.current) {
      const hasConflict = hasIncomingArtifactConflict(
        localContentRef.current,
        lastKnownContentRef.current,
        artifact.content,
      );
      lastKnownContentRef.current = artifact.content;
      revisionRef.current = artifact.revision ?? 0;

      if (hasConflict) {
        clearTimeout(saveContentTimeoutRef.current);
        conflictRef.current = true;
        setShowUpdateBanner(true);
        persistDraft();
      } else {
        localContentRef.current = artifact.content;
        setLocalContent(artifact.content);
        conflictRef.current = false;
        setShowUpdateBanner(false);
        persistDraft();
      }
    } else if ((artifact.revision ?? 0) > revisionRef.current) {
      // A title-only write advances the artifact revision without changing this
      // editor's content. Rebase the content draft so its next save does not
      // conflict with an independent rename.
      revisionRef.current = artifact.revision ?? 0;
    }
  }, [artifact.content, artifact.revision, persistDraft]);

  useEffect(() => {
    if (artifact.title !== lastKnownTitleRef.current) {
      lastKnownTitleRef.current = artifact.title;
      setLocalTitle(artifact.title);
    }
  }, [artifact.title]);

  const handleContentChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const newContent = e.target.value;
    localContentRef.current = newContent;
    setLocalContent(newContent);
    if (!conflictRef.current) setShowUpdateBanner(false);
    persistDraft();

    clearTimeout(saveContentTimeoutRef.current);
    saveContentTimeoutRef.current = setTimeout(async () => {
      try {
        await drainSaves();
      } catch {
        setSaveError("Couldn’t save your draft. It is still here—try again.");
      }
    }, 500);
  };

  useEffect(() => {
    return () => {
      // Intentionally read the LATEST timeout ids at unmount to cancel any
      // pending save. Copying them into locals inside the effect (the lint
      // rule's suggested fix) would capture `undefined` at mount and never
      // clear the real timeout.
      clearTimeout(saveContentTimeoutRef.current);
      // eslint-disable-next-line react-hooks/exhaustive-deps
      clearTimeout(saveTitleTimeoutRef.current);
    };
  }, []);

  const handleAcceptUpdate = () => {
    clearTimeout(saveContentTimeoutRef.current);
    localContentRef.current = lastKnownContentRef.current;
    setLocalContent(lastKnownContentRef.current);
    conflictRef.current = false;
    setShowUpdateBanner(false);
    setSaveError(null);
    draftController.clear();
  };

  const handleKeepDraft = async () => {
    clearTimeout(saveContentTimeoutRef.current);
    try {
      conflictRef.current = false;
      await drainSaves();
      setShowUpdateBanner(false);
      setSaveError(null);
      draftController.clear();
    } catch {
      setSaveError("Couldn’t save your draft. It is still here—try again.");
    }
  };

  const wordCount = localContent
    .trim()
    .split(/\s+/)
    .filter((w) => w.length > 0).length;

  // Title + trash used to live in a row at the top of the editor,
  // duplicating the doc-tab chip's title and creating a second click
  // target. The title now lives ONLY on the outer doc-tab chip; the
  // trash moved into that chip's kebab menu. The editor renders only
  // the writing surface — there used to be a violet "Check" button
  // here too, but checking is now driven from the submit-and-check
  // affordance below the doc (or from the AI naturally inside chat), so
  // the in-editor button was redundant.
  return (
    <Flex flex={1} flexDir="column" overflow="hidden">
      {showUpdateBanner && (
        <Flex
          px={6}
          py={2}
          bg="violet.50"
          align="center"
          justify="space-between"
          flexShrink={0}
        >
          <Text fontSize="xs" fontFamily="heading" color="violet.700">
            This document changed somewhere else
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
      {saveError && <Text px={6} py={1} fontSize="xs" color="red.600" role="alert">{saveError}</Text>}

      <Box flex={1} overflow="hidden" px={3}>
        <Textarea
          value={localContent}
          onChange={handleContentChange}
          placeholder="Start writing"
          resize="none"
          h="100%"
          fontFamily="body"
          fontSize="xl"
          lineHeight="1.6"
          border="none"
          bg="white"
          p={3}
          _focus={{ boxShadow: "none", outline: "none" }}
        />
      </Box>

      <Text
        fontSize="xs"
        fontFamily="heading"
        color="charcoal.300"
        px={6}
        py={1}
        flexShrink={0}
      >
        {wordCount} {wordCount === 1 ? "word" : "words"}
      </Text>
    </Flex>
  );
}

function extractYouTubeId(url: string): string | null {
  const watchMatch = url.match(/(?:youtube\.com\/watch\?.*v=)([a-zA-Z0-9_-]{11})/);
  if (watchMatch) return watchMatch[1];
  const shortMatch = url.match(/youtu\.be\/([a-zA-Z0-9_-]{11})/);
  if (shortMatch) return shortMatch[1];
  const embedMatch = url.match(/youtube\.com\/embed\/([a-zA-Z0-9_-]{11})/);
  if (embedMatch) return embedMatch[1];
  return null;
}

/**
 * Honest empty state for a slides / audio deliverable. Phase 1 of the
 * deliverable-kinds plan does NOT build a deck picker or an audio recorder
 * (§5.3, explicitly deferred), so instead of dropping the scholar into a text
 * editor that doesn't match the promise, we show the prompt + a plain "hand it
 * to your teacher" cue. When the capture path lands, this is where it goes.
 */
function PendingKindEmptyState({
  kind,
  prompt,
}: {
  kind: "slides" | "audio";
  prompt: string;
}) {
  const label = kind === "slides" ? "Slides" : "Audio";
  return (
    <Flex flex={1} flexDir="column" align="center" justify="center" bg="gray.50" gap={4} p={6}>
      <DeliverableKindIcon kind={kind} size={40} color="violet.400" />
      <Text fontSize="xs" fontFamily="heading" fontWeight="600" color="violet.500" letterSpacing="0.04em">
        {label.toUpperCase()} DELIVERABLE
      </Text>
      <Text fontSize="sm" fontFamily="body" color="charcoal.600" lineHeight="1.5" maxW="md" textAlign="center">
        {prompt}
      </Text>
      <Text fontSize="xs" fontFamily="body" color="charcoal.400" maxW="sm" textAlign="center" lineHeight="1.5">
        {kind === "slides"
          ? "Build your deck outside Rabbithole, then share it with your teacher — in-app upload is coming soon."
          : "Record your audio outside Rabbithole, then share it with your teacher — in-app recording is coming soon."}
      </Text>
    </Flex>
  );
}
