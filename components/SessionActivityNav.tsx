"use client";

import { useMemo, useState } from "react";
import type { ActivityKind } from "@/lib/activityKinds";
import { useRouter } from "next/navigation";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import {
  Box,
  Flex,
  HStack,
  VStack,
  Text,
  Button,
  IconButton,
  Input,
  Dialog,
  Menu,
  Portal,
  Spinner,
} from "@chakra-ui/react";
import {
  CheckCircle,
  ArrowClockwise,
  CaretDown,
  PencilSimple,
  X,
} from "@phosphor-icons/react";
import { UnitOutlineTree, type TreeSelection } from "./UnitOutlineTree";
import { StyledDialogContent } from "@/components/ui/StyledDialogContent";
import { ActivityKindIcon } from "./ActivityKindIcon";
import { useRemote } from "@/hooks/useRemote";
import { useWebAssignment } from "@/hooks/useWebAssignment";
import { WebAssignmentDoneDialog } from "@/components/WebAssignmentDoneDialog";
import type { WebDonePrompt } from "@/hooks/useWebAssignment";
import { useGameActivity } from "@/hooks/useGameActivity";
import type { GameCapabilityPrompt } from "@/hooks/useGameActivity";
import { GameCapabilityNotice } from "@/components/GameCapabilityNotice";
import { pickNextIncompleteAfter } from "@/shared/nextIncompleteActivity";
import { toaster } from "@/lib/toaster";

interface OfflineDialogState {
  activityId: Id<"activities">;
  title: string;
  description: string | null;
}

export interface ProjectActivityNavData {
  hasActivityContext: boolean;
  unit: { _id: Id<"units">; title: string; emoji?: string | null } | null;
  lessonTitle: string | null;
  activity: { _id: Id<"activities">; title: string; kind: ActivityKind } | null;
  isCurrentDone: boolean;
  /** True when this activity has a rubric that gates "ready to advance" — a
   *  conversation advanceRubric OR a graded deliverable (mode !== "none"). The
   *  Continue CTA waits for the rubric (isCurrentDone) instead of a raw
   *  message-count heuristic when this is true. */
  hasRubricGate: boolean;
  /** The next incomplete online activity in this unit, if any. */
  nextOnlineActivity: { _id: Id<"activities">; title: string } | null;
  unitOnlineActivityCount: number;
  unitCompletedOnlineCount: number;
  /** Open the navigator modal. */
  open: () => void;
  /** Mark / unmark the current activity complete. */
  toggleComplete: () => Promise<void>;
  /** Mark the current activity complete (idempotent) and open + navigate to
   *  the next online activity. No-op when there's no next online activity. */
  continueToNext: () => Promise<void>;
  /** @internal — for ProjectActivityNavModal */
  _modal: {
    modalOpen: boolean;
    setModalOpen: (open: boolean) => void;
    offlineDialog: OfflineDialogState | null;
    setOfflineDialog: (s: OfflineDialogState | null) => void;
    pendingNav: boolean;
    handleSelectFromTree: (sel: TreeSelection) => Promise<void>;
    sessionUnitId: Id<"units"> | null;
    sessionAssignmentId: Id<"assignments"> | null;
    unitTitle: string | null;
    unitEmoji: string | null | undefined;
    activityForSelection:
      | { _id: Id<"activities">; lessonId: Id<"lessons"> }
      | null;
    scholarId: Id<"users"> | null;
    webDonePrompt: WebDonePrompt | null;
    resolveWebDonePrompt: (markDone: boolean) => void;
    gamePrompt: GameCapabilityPrompt | null;
    dismissGamePrompt: () => void;
  };
}

export function useSessionActivityNav(
  sessionId: Id<"sessions">,
  scholarId: Id<"users"> | null,
  remoteUserId: string | null,
  asLearner = false,
): ProjectActivityNavData {
  const router = useRouter();
  const { stamp } = useRemote();
  const session = useQuery(api.sessions.get, { id: sessionId });
  const unit = useQuery(
    api.units.get,
    session?.unitId ? { id: session.unitId } : "skip",
  );
  const lesson = useQuery(
    api.lessons.getPublic,
    session?.lessonId ? { id: session.lessonId } : "skip",
  );
  const activity = useQuery(
    api.activities.getPublic,
    session?.activityId ? { id: session.activityId } : "skip",
  );
  const completions = useQuery(
    api.activityCompletions.listForScholarInUnit,
    session?.unitId && scholarId
      ? {
          unitId: session.unitId,
          scholarId: scholarId ?? undefined,
          assignmentId: session.assignmentId ?? undefined,
        }
      : "skip",
  );
  const unitActivities = useQuery(
    api.activities.listByUnitPublic,
    session?.unitId
      ? {
          unitId: session.unitId,
          assignmentId: session.assignmentId ?? undefined,
        }
      : "skip",
  );
  const activeSessions = useQuery(api.sessions.list, {
    userId: remoteUserId ? (remoteUserId as Id<"users">) : undefined,
    asLearner,
  });
  const markComplete = useMutation(api.activityCompletions.markComplete);
  const unmarkComplete = useMutation(api.activityCompletions.unmarkComplete);
  const createSession = useMutation(api.sessions.create);
  const webAssignment = useWebAssignment();
  const gameActivity = useGameActivity();

  const [modalOpen, setModalOpen] = useState(false);
  const [pendingNav, setPendingNav] = useState(false);
  const [offlineDialog, setOfflineDialog] = useState<{
    activityId: Id<"activities">;
    title: string;
    description: string | null;
  } | null>(null);

  const completedSet = useMemo(() => {
    const s = new Set<string>();
    for (const c of completions ?? []) s.add(String(c.activityId));
    return s;
  }, [completions]);

  const hasActivityContext = !!session?.unitId && !!unit;
  const isCurrentDone = activity ? completedSet.has(String(activity._id)) : false;

  // Does this activity have a rubric that defines "ready to advance"? A
  // conversation advanceRubric, or a graded deliverable (not "none" mode).
  const hasRubricGate =
    !!activity &&
    (!!activity.advanceRubric ||
      (!!activity.deliverable && activity.deliverable.mode !== "none"));

  const onlineUnitActivities = useMemo(
    () => (unitActivities ?? []).filter((a) => a.kind === "online"),
    [unitActivities],
  );
  const unitCompletedOnlineCount = useMemo(
    () =>
      onlineUnitActivities.filter((a) => completedSet.has(String(a._id))).length,
    [completedSet, onlineUnitActivities],
  );

  const nextOnlineActivity = useMemo(() => {
    if (!activity || onlineUnitActivities.length === 0) return null;
    const idx = onlineUnitActivities.findIndex((a) => a._id === activity._id);
    // Forward-only: never wrap backward to an earlier incomplete activity (see
    // shared/nextIncompleteActivity.ts). Home owns routing to earlier holes.
    const next = pickNextIncompleteAfter(
      onlineUnitActivities,
      idx,
      (a) => completedSet.has(String(a._id)),
    );
    return next ? { _id: next._id, title: next.title } : null;
  }, [activity, completedSet, onlineUnitActivities]);

  const existingSessionForActivity = (activityId: Id<"activities">) =>
    activeSessions?.find(
      (s) =>
        s.activityId &&
        String(s.activityId) === String(activityId) &&
        (session?.assignmentId
          ? String(s.assignmentId ?? "") === String(session.assignmentId)
          : s.assignmentId === undefined),
    );

  const toggleComplete = async () => {
    if (!activity) return;
    if (isCurrentDone) {
      await unmarkComplete({
        activityId: activity._id,
        scholarId: remoteUserId ? (remoteUserId as Id<"users">) : undefined,
        sessionId,
      });
    } else {
      await markComplete({
        activityId: activity._id,
        scholarId: remoteUserId ? (remoteUserId as Id<"users">) : undefined,
        sessionId,
      });
    }
  };

  // "Continue to the next part" — one action that both completes the current
  // activity (so it counts toward unit progress + the badge) and opens the
  // next one. Mirrors how a teacher pushing the next class-focus activity
  // would advance a scholar, but self-serve.
  const continueToNext = async () => {
    if (!activity || !session?.unitId || !nextOnlineActivity) return;
    if (!isCurrentDone) {
      await markComplete({
        activityId: activity._id,
        scholarId: remoteUserId ? (remoteUserId as Id<"users">) : undefined,
        sessionId,
      });
    }
    setPendingNav(true);
    try {
      const args: Record<string, unknown> = {
        unitId: session.unitId as Id<"units">,
        activityId: nextOnlineActivity._id,
      };
      if (session.assignmentId) {
        args.assignmentId = session.assignmentId as Id<"assignments">;
      }
      if (remoteUserId) args.userId = remoteUserId as Id<"users">;
      const existing = existingSessionForActivity(nextOnlineActivity._id);
      if (existing?.id) {
        router.push(stamp(`/scholar/${existing.id}`));
        return;
      }
      const result = await createSession(
        args as Parameters<typeof createSession>[0],
      );
      if (result) {
        router.push(stamp(`/scholar/${result.id}`));
      }
    } catch (error) {
      console.error("Activity navigation launch failed:", error);
      toaster.error({
        title: "Couldn't start that activity",
        description: "Please try again.",
      });
    } finally {
      setPendingNav(false);
    }
  };

  const handleSelectFromTree = async (sel: TreeSelection) => {
    if (sel.type !== "activity") return;
    // Web assignments launch the external site — no chat project.
    if (sel.kind === "web") {
      setModalOpen(false);
      await webAssignment.launch({
        activityId: sel.activityId,
        assignmentId: session?.assignmentId,
        title: sel.title ?? null,
      });
      return;
    }
    // Games are iPad-only (policy) — the browser gets the honest notice.
    if (sel.kind === "game") {
      setModalOpen(false);
      await gameActivity.launch({
        activityId: sel.activityId,
        title: sel.title ?? null,
      });
      return;
    }
    if (sel.kind === "offline" || sel.kind === "shareBack") {
      setOfflineDialog({
        activityId: sel.activityId,
        title: sel.title ?? "Activity",
        description: sel.description ?? null,
      });
      return;
    }
    if (activity && sel.activityId === activity._id) {
      setModalOpen(false);
      return;
    }
    setPendingNav(true);
    try {
      const args: Record<string, unknown> = {
        unitId: session?.unitId as Id<"units">,
        activityId: sel.activityId,
      };
      if (session?.assignmentId) {
        args.assignmentId = session.assignmentId as Id<"assignments">;
      }
      if (remoteUserId) args.userId = remoteUserId as Id<"users">;
      const existing = existingSessionForActivity(sel.activityId);
      if (existing?.id) {
        router.push(stamp(`/scholar/${existing.id}`));
        return;
      }
      const result = await createSession(
        args as Parameters<typeof createSession>[0],
      );
      if (result) {
        router.push(stamp(`/scholar/${result.id}`));
      }
    } catch (error) {
      console.error("Activity navigation launch failed:", error);
      toaster.error({
        title: "Couldn't start that activity",
        description: "Please try again.",
      });
    } finally {
      setPendingNav(false);
    }
  };

  return {
    hasActivityContext,
    unit: unit
      ? { _id: unit._id, title: unit.title, emoji: unit.emoji ?? null }
      : null,
    lessonTitle: lesson?.title ?? null,
    activity: activity
      ? { _id: activity._id, title: activity.title, kind: activity.kind }
      : null,
    isCurrentDone,
    hasRubricGate,
    nextOnlineActivity,
    unitOnlineActivityCount: onlineUnitActivities.length,
    unitCompletedOnlineCount,
    open: () => setModalOpen(true),
    toggleComplete,
    continueToNext,
    _modal: {
      modalOpen,
      setModalOpen,
      offlineDialog,
      setOfflineDialog,
      pendingNav,
      handleSelectFromTree,
      sessionUnitId: (session?.unitId as Id<"units"> | undefined) ?? null,
      sessionAssignmentId:
        (session?.assignmentId as Id<"assignments"> | undefined) ?? null,
      unitTitle: unit?.title ?? null,
      unitEmoji: unit?.emoji,
      // Only lesson-anchored activities participate in the lesson tree
      // navigator. Quest-only activities (no lessonId) are routed
      // elsewhere and aren't selectable here.
      activityForSelection:
        activity && activity.lessonId
          ? { _id: activity._id, lessonId: activity.lessonId }
          : null,
      scholarId,
      webDonePrompt: webAssignment.donePrompt,
      resolveWebDonePrompt: webAssignment.resolveDonePrompt,
      gamePrompt: gameActivity.prompt,
      dismissGamePrompt: gameActivity.dismiss,
    },
  };
}

// TODO: make this modal more scholar-friendly. Today it's basically the
// teacher outline tree. For scholars it should also include AI-generated
// sections like "What you've learned in this unit so far" and "What you'll
// learn next" — pulling from the activityCompletions + activity
// descriptions/system prompts. Track in CLAUDE.md roadmap.
export function ProjectActivityNavModal({
  data,
}: {
  data: ProjectActivityNavData;
}) {
  const {
    modalOpen,
    setModalOpen,
    offlineDialog,
    setOfflineDialog,
    pendingNav,
    handleSelectFromTree,
    sessionUnitId,
    sessionAssignmentId,
    unitTitle,
    unitEmoji,
    activityForSelection,
    scholarId,
    webDonePrompt,
    resolveWebDonePrompt,
    gamePrompt,
    dismissGamePrompt,
  } = data._modal;

  return (
    <>
      <WebAssignmentDoneDialog
        prompt={webDonePrompt}
        onResolve={resolveWebDonePrompt}
      />
      <GameCapabilityNotice prompt={gamePrompt} onDismiss={dismissGamePrompt} />
      <Dialog.Root
        open={modalOpen}
        onOpenChange={(d) => setModalOpen(d.open)}
        placement="center"
        motionPreset="slide-in-bottom"
      >
        <Portal>
          <Dialog.Backdrop />
          <Dialog.Positioner>
            <StyledDialogContent maxW="2xl">
              <Dialog.Header px={6} pt={5} pb={2}>
                <HStack gap={2} flex={1}>
                  {unitEmoji && <Text fontSize="lg">{unitEmoji}</Text>}
                  <Dialog.Title
                    fontFamily="heading"
                    fontWeight="700"
                    color="navy.500"
                    fontSize="lg"
                  >
                    {unitTitle ?? "Where am I?"}
                  </Dialog.Title>
                </HStack>
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
                <Box maxH="60vh" overflowY="auto">
                  {sessionUnitId && (
                    <UnitOutlineTree
                      unitId={sessionUnitId}
                      mode="pick"
                      scholarId={scholarId ?? undefined}
                      assignmentId={sessionAssignmentId ?? undefined}
                      enableOfflinePick
                      alwaysExpanded
                      selected={
                        activityForSelection
                          ? {
                              type: "activity",
                              unitId: sessionUnitId,
                              lessonId: activityForSelection.lessonId,
                              activityId: activityForSelection._id,
                            }
                          : null
                      }
                      onSelect={handleSelectFromTree}
                    />
                  )}
                  {pendingNav && (
                    <Flex justify="center" py={2} gap={2}>
                      <Spinner size="sm" color="violet.500" />
                      <Text fontSize="xs" color="charcoal.400">
                        Starting…
                      </Text>
                    </Flex>
                  )}
                </Box>
              </Dialog.Body>
            </StyledDialogContent>
          </Dialog.Positioner>
        </Portal>
      </Dialog.Root>

      <OfflineActivityDialog
        open={!!offlineDialog}
        activity={offlineDialog}
        onClose={() => setOfflineDialog(null)}
      />
    </>
  );
}


/**
 * Renders the project title as a clickable menu trigger with a down-caret.
 * The whole title-row is the click target; opening the menu shows
 * Rename + Mark Complete (when applicable).
 *
 * Falls back to a plain title (no caret, no click) when neither action is
 * available — e.g. remote-mode views.
 */
export function ProjectTitleMenu({
  data,
  sessionTitle,
  onRename,
}: {
  data: ReturnType<typeof useSessionActivityNav>;
  sessionTitle: string;
  onRename?: (next: string) => void;
}) {
  const [renameOpen, setRenameOpen] = useState(false);
  const [renameDraft, setRenameDraft] = useState(sessionTitle);

  const canRename = !!onRename;
  // Mark-complete is currently only meaningful for online activities (offline
  // ones are teacher-led; no scholar-side completion).
  const canMarkComplete = !!data.activity && data.activity.kind === "online";
  const hasMenu = canRename || canMarkComplete;

  if (!hasMenu) {
    return (
      <Text
        fontWeight="600"
        fontFamily="heading"
        color="navy.500"
        fontSize="sm"
        truncate
        flexShrink={1}
        minW={0}
      >
        {sessionTitle}
      </Text>
    );
  }

  return (
    <>
      <Menu.Root positioning={{ placement: "bottom-start" }}>
        <Menu.Trigger asChild>
          <HStack
            as="button"
            gap={1}
            cursor="pointer"
            borderRadius="md"
            px={1}
            py={0.5}
            ml={-1}
            _hover={{ bg: "gray.100" }}
            color="navy.500"
            minW={0}
            flexShrink={1}
          >
            <Text
              fontWeight="600"
              fontFamily="heading"
              color="navy.500"
              fontSize="sm"
              truncate
              minW={0}
            >
              {sessionTitle}
            </Text>
            <Box color="charcoal.400" flexShrink={0}>
              <CaretDown size={14} />
            </Box>
          </HStack>
        </Menu.Trigger>
        <Portal>
          <Menu.Positioner>
            <Menu.Content minW="180px">
              {canRename && (
                <Menu.Item
                  value="rename"
                  cursor="pointer"
                  onClick={() => {
                    setRenameDraft(sessionTitle);
                    setRenameOpen(true);
                  }}
                >
                  <PencilSimple />
                  Rename session
                </Menu.Item>
              )}
              {canMarkComplete && (
                <Menu.Item
                  value="mark-complete"
                  cursor="pointer"
                  onClick={data.toggleComplete}
                  color={data.isCurrentDone ? "charcoal.600" : "green.700"}
                >
                  {data.isCurrentDone ? <ArrowClockwise /> : <CheckCircle />}
                  {data.isCurrentDone ? "Mark not done" : "Mark complete"}
                </Menu.Item>
              )}
            </Menu.Content>
          </Menu.Positioner>
        </Portal>
      </Menu.Root>

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
                  Rename session
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
                  onChange={(e) => setRenameDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      const next = renameDraft.trim();
                      if (next && next !== sessionTitle && onRename) onRename(next);
                      setRenameOpen(false);
                    }
                    if (e.key === "Escape") setRenameOpen(false);
                  }}
                  autoFocus
                  fontFamily="heading"
                  fontSize="md"
                />
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
                    if (next && next !== sessionTitle && onRename) onRename(next);
                    setRenameOpen(false);
                  }}
                  disabled={
                    !renameDraft.trim() || renameDraft.trim() === sessionTitle
                  }
                >
                  Save
                </Button>
              </Dialog.Footer>
            </StyledDialogContent>
          </Dialog.Positioner>
        </Portal>
      </Dialog.Root>
    </>
  );
}

function OfflineActivityDialog({
  open,
  activity,
  onClose,
}: {
  open: boolean;
  activity: { title: string; description: string | null } | null;
  onClose: () => void;
}) {
  return (
    <Dialog.Root
      open={open}
      onOpenChange={(d) => {
        if (!d.open) onClose();
      }}
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
                <HStack gap={2} as="span">
                  <ActivityKindIcon kind="offline" size={18} />
                  <span>Classroom activity</span>
                </HStack>
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
            <Dialog.Body px={6} pt={3} pb={5}>
              {activity && (
                <VStack gap={3} align="stretch">
                  <Text
                    fontFamily="heading"
                    fontSize="md"
                    color="navy.500"
                    fontWeight="600"
                  >
                    {activity.title}
                  </Text>
                  {activity.description && (
                    <Text fontSize="sm" color="charcoal.500" lineHeight="1.5">
                      {activity.description}
                    </Text>
                  )}
                  <Box
                    bg="orange.50"
                    border="1px solid"
                    borderColor="orange.200"
                    px={3}
                    py={2}
                    borderRadius="md"
                  >
                    <Text fontSize="xs" color="orange.700" fontFamily="heading">
                      This is an in-class activity — your teacher will run it.
                    </Text>
                    <Text
                      fontSize="xs"
                      color="orange.700"
                      fontFamily="body"
                      mt={1}
                      lineHeight="1.5"
                    >
                      Do your work on paper, then hand it to your teacher —
                      they&apos;ll scan it in so it shows up here.
                    </Text>
                  </Box>
                </VStack>
              )}
            </Dialog.Body>
          </StyledDialogContent>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
}
