"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useQuery, useMutation } from "convex/react";
import {
  Box,
  Button,
  Dialog,
  Flex,
  HStack,
  IconButton,
  Input,
  Portal,
  Spinner,
  Stack,
  Text,
} from "@chakra-ui/react";
import { ArrowRight, CheckCircle, Circle, PencilSimple, Play, ArrowClockwise, X } from "@phosphor-icons/react";
import { StyledDialogContent } from "@/components/ui/StyledDialogContent";
import { HierarchyRow } from "@/components/hierarchy";
import { api } from "@/convex/_generated/api";
import { Id } from "@/convex/_generated/dataModel";
import { useRemote } from "@/hooks/useRemote";

interface BigPictureContentProps {
  sessionId: Id<"sessions">;
  sessionTitle: string;
  /** When provided, exposes a "Rename project" action. */
  onRename?: (next: string) => void;
  /** When provided, exposes a Mark complete / Mark not done action. */
  onToggleComplete?: () => void;
  isCurrentDone?: boolean;
  /** Whether mark-complete applies (online activity only). */
  canMarkComplete?: boolean;
  /** Layout variant. "drawer" = dense; "full" = more breathing room. */
  variant?: "drawer" | "full";
  /** Called after the user navigates away (e.g., into a sibling
   *  activity's project). Drawer uses this to close itself. */
  onAfterNavigate?: () => void;
  /** When true, the underlying query runs (subscribed). Drawer sets
   *  this to its open state so we don't subscribe when hidden. */
  active?: boolean;
  /** When true, suppress the QuestProgressView / LessonProgressView
   *  per-kind header block. The full-screen shell renders its own
   *  page H1 (quest or unit title) above this component, so the
   *  in-component header would duplicate. The drawer keeps the
   *  in-component header (no separate H1 there). */
  hideTopHeader?: boolean;
}

type GetBigPicture = NonNullable<
  ReturnType<typeof useQuery<typeof api.sessions.getBigPicture>>
>;
type Progress = NonNullable<GetBigPicture["progress"]>;
type LessonProgress = Extract<Progress, { kind: "lesson" }>;
type ActivityRow = LessonProgress["activities"][number];

/**
 * Shared body of the Big Picture / Progress surface. Used by:
 *   - `ReflectionDrawer` (variant="drawer") — slides in from the
 *     left when the scholar taps the compass button.
 *   - `/scholar/[sessionId]/progress` (variant="full") — full-screen
 *     route for the same content, useful for quest homework where
 *     the scholar wants a dedicated overview.
 *
 * Renders three sections in order:
 *   1. "Where you are" — Unit › Lesson › Activity › My project tree
 *      with inline Rename / Mark complete actions.
 *   2. Progress strip — quest activities + badges OR lesson
 *      activities, with prev/next peeks and subtle encouragement.
 *   3. Reflection sections — AI-generated prose ("The big idea",
 *      "Why this matters", etc.).
 */
export function BigPictureContent({
  sessionId,
  sessionTitle,
  onRename,
  onToggleComplete,
  isCurrentDone,
  canMarkComplete,
  variant = "drawer",
  onAfterNavigate,
  active = true,
  hideTopHeader = false,
}: BigPictureContentProps) {
  const data = useQuery(
    api.sessions.getBigPicture,
    active ? { sessionId } : "skip",
  );
  const regenerate = useMutation(api.sessions.regenerateReflection);
  const router = useRouter();
  const { stamp } = useRemote();
  const [renameOpen, setRenameOpen] = useState(false);
  // Seeded fresh from sessionTitle at every open-site below, so no
  // sync-to-prop effect is needed (the draft is only read while open).
  const [renameDraft, setRenameDraft] = useState(sessionTitle);

  const handleNavigateToSession = (id: Id<"sessions">) => {
    router.push(stamp(`/scholar/${id}`));
    onAfterNavigate?.();
  };

  const gap = variant === "full" ? 7 : 5;

  return (
    <>
      {data === undefined && <ProgressSkeleton />}
      {data === null && (
        <Text fontSize="sm" color="charcoal.400">
          No session found.
        </Text>
      )}
      {data && (
        <Stack gap={gap}>
          {/* The Activities list below already shows "YOU'RE HERE"
              against the right activity, so the tree-view "Where
              you are" became redundant. Replaced by a compact unit
              line at the top of the lesson view, and the existing
              quest header for quest projects. */}

          {data.progress?.kind === "lesson" && (
            <LessonProgressView
              progress={data.progress}
              onNavigate={handleNavigateToSession}
              variant={variant}
              hideTopHeader={hideTopHeader}
              onRename={
                onRename
                  ? () => {
                      setRenameDraft(sessionTitle);
                      setRenameOpen(true);
                    }
                  : undefined
              }
              onToggleComplete={
                canMarkComplete ? onToggleComplete : undefined
              }
              isCurrentDone={isCurrentDone}
            />
          )}

          {/* Fallback when there's no quest/lesson context — typically
              an independent-study task or a scholar-scoped project.
              Show a compact project title + actions row so Rename /
              Mark complete still have a home. */}
          {!data.progress && (
            <StandaloneSessionHeader
              sessionTitle={sessionTitle}
              onRename={
                onRename
                  ? () => {
                      setRenameDraft(sessionTitle);
                      setRenameOpen(true);
                    }
                  : undefined
              }
              onToggleComplete={
                canMarkComplete ? onToggleComplete : undefined
              }
              isCurrentDone={isCurrentDone}
            />
          )}

          {data.reflectionStatus === "pending" && <PendingBanner />}
          {data.reflectionStatus === "error" && (
            <ErrorBanner
              message={data.reflectionError}
              onRetry={async () => {
                await regenerate({ sessionId });
              }}
            />
          )}
          {data.reflection &&
            data.reflection.sections.map((s, i) => (
              <ProgressSection key={i} label={s.heading} body={s.body} />
            ))}
        </Stack>
      )}

      {/* Rename dialog */}
      {onRename && (
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
                        if (next && next !== sessionTitle) onRename(next);
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
                      if (next && next !== sessionTitle) onRename(next);
                      setRenameOpen(false);
                    }}
                    disabled={
                      !renameDraft.trim() ||
                      renameDraft.trim() === sessionTitle
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
    </>
  );
}

// ── Reflection section ──────────────────────────────────────────────

function ProgressSection({
  label,
  body,
  children,
}: {
  label: string;
  body?: string | null;
  children?: React.ReactNode;
}) {
  return (
    <Box>
      <Text
        fontSize="sm"
        fontFamily="heading"
        fontWeight="700"
        color="navy.500"
        mb={1}
      >
        {label}
      </Text>
      {body !== undefined && body !== null ? (
        <Text
          fontSize="sm"
          color="charcoal.700"
          lineHeight="1.6"
          fontFamily="body"
          whiteSpace="pre-wrap"
        >
          {body}
        </Text>
      ) : (
        children
      )}
    </Box>
  );
}

// ── Standalone project header (independent study / no progress) ────

function StandaloneSessionHeader({
  sessionTitle,
  onRename,
  onToggleComplete,
  isCurrentDone,
}: {
  sessionTitle: string;
  onRename?: () => void;
  onToggleComplete?: () => void;
  isCurrentDone?: boolean;
}) {
  return (
    <Stack gap={1.5}>
      <Text
        fontSize="2xs"
        fontFamily="heading"
        fontWeight="700"
        color="charcoal.400"
        textTransform="uppercase"
        letterSpacing="0.05em"
      >
        Quest
      </Text>
      <Text
        fontSize="md"
        fontFamily="heading"
        fontWeight="700"
        color="navy.500"
        lineHeight="1.3"
      >
        {sessionTitle}
      </Text>
      <NodeActions
        onRename={onRename}
        onToggleComplete={onToggleComplete}
        isCurrentDone={isCurrentDone}
      />
    </Stack>
  );
}

function NodeActions({
  onRename,
  onToggleComplete,
  isCurrentDone,
}: {
  onRename?: () => void;
  onToggleComplete?: () => void;
  isCurrentDone?: boolean;
}) {
  if (!onRename && !onToggleComplete) return null;
  return (
    <HStack gap={1} mt={1.5} ml={-1.5}>
      {onRename && (
        <Button
          size="2xs"
          variant="ghost"
          color="charcoal.500"
          _hover={{ color: "violet.600", bg: "gray.100" }}
          fontFamily="heading"
          fontWeight="500"
          onClick={onRename}
          px={1.5}
          h="22px"
        >
          <PencilSimple size={11} style={{ marginRight: 4 }} />
          Rename
        </Button>
      )}
      {onToggleComplete && (
        <Button
          size="2xs"
          variant="ghost"
          color={isCurrentDone ? "charcoal.500" : "green.600"}
          _hover={{
            color: isCurrentDone ? "charcoal.700" : "green.700",
            bg: "gray.100",
          }}
          fontFamily="heading"
          fontWeight="500"
          onClick={onToggleComplete}
          px={1.5}
          h="22px"
        >
          {isCurrentDone ? (
            <ArrowClockwise size={11} style={{ marginRight: 4 }} />
          ) : (
            <CheckCircle size={11} style={{ marginRight: 4 }} />
          )}
          {isCurrentDone ? "Mark not done" : "Mark complete"}
        </Button>
      )}
    </HStack>
  );
}

// ── Quest progress ──────────────────────────────────────────────────

// QuestProgressView removed — Quests dropped. Lesson progress
// covers everything now (Independent Study Units are regular units
// with authorScholarId set).

// ── Lesson progress ─────────────────────────────────────────────────

function LessonProgressView({
  progress,
  onNavigate,
  variant,
  hideTopHeader,
  onRename,
  onToggleComplete,
  isCurrentDone,
}: {
  progress: LessonProgress;
  onNavigate: (sessionId: Id<"sessions">) => void;
  variant: "drawer" | "full";
  hideTopHeader?: boolean;
  onRename?: () => void;
  onToggleComplete?: () => void;
  isCurrentDone?: boolean;
}) {
  const totalActivities = progress.activities.length;
  const passedActivities = progress.activities.filter(
    (a) => a.status === "passed",
  ).length;
  // In-class lessons are paced by the teacher, so the "what's next"
  // hint is gentler than in a quest.
  let hint: string | null = null;
  if (progress.nextActivity) {
    hint = `Next: ${progress.nextActivity.title}.`;
  } else if (
    passedActivities === totalActivities &&
    totalActivities > 0
  ) {
    hint = "All activities in this lesson are done.";
  }

  return (
    <Stack gap={3}>
      {!hideTopHeader && (
        /* Compact unit + lesson header — only renders when this view
           is mounted without an outer page H1 (e.g. inside the
           drawer). The full-screen shell hides it because its own
           page H1 already carries the unit title. */
        <Box>
          <HStack gap={1.5} mb={0.5}>
            {progress.unitEmoji && (
              <Text fontSize="md" lineHeight="1" flexShrink={0}>
                {progress.unitEmoji}
              </Text>
            )}
            <Text
              fontSize="2xs"
              fontFamily="heading"
              fontWeight="700"
              color="charcoal.400"
              textTransform="uppercase"
              letterSpacing="0.05em"
            >
              Unit
            </Text>
          </HStack>
          <Text
            fontSize={variant === "full" ? "lg" : "sm"}
            fontFamily="heading"
            fontWeight="700"
            color="navy.500"
            lineHeight="1.3"
          >
            {progress.unitTitle}
          </Text>
          <Text
            fontSize="xs"
            color="charcoal.500"
            lineHeight="1.4"
            mt={0.5}
          >
            {progress.lessonTitle}
          </Text>
        </Box>
      )}

      <ActivitiesList
        activities={progress.activities}
        onNavigate={onNavigate}
        sectionLabel={`Activities (${passedActivities} of ${totalActivities} passed)`}
        onRename={onRename}
        onToggleComplete={onToggleComplete}
        isCurrentDone={isCurrentDone}
      />
      {hint && (
        <HStack
          gap={1.5}
          px={2}
          py={1.5}
          bg="gray.50"
          borderRadius="md"
          color="charcoal.500"
        >
          <ArrowRight size={12} style={{ flexShrink: 0 }} />
          <Text fontSize="xs" fontFamily="heading" fontWeight="600">
            {hint}
          </Text>
        </HStack>
      )}
    </Stack>
  );
}

// ── Activity / badge rows ───────────────────────────────────────────

function ActivitiesList({
  activities,
  onNavigate,
  sectionLabel,
  onRename,
  onToggleComplete,
  isCurrentDone,
}: {
  activities: ActivityRow[];
  onNavigate: (sessionId: Id<"sessions">) => void;
  sectionLabel: string;
  onRename?: () => void;
  onToggleComplete?: () => void;
  isCurrentDone?: boolean;
}) {
  return (
    <Stack gap={1}>
      <Text
        fontSize="2xs"
        fontFamily="heading"
        fontWeight="700"
        color="charcoal.400"
        textTransform="uppercase"
        letterSpacing="0.05em"
      >
        {sectionLabel}
      </Text>
      <Stack gap={1.5}>
        {activities.map((a) => (
          <ActivityRowView
            key={String(a.activityId)}
            activity={a}
            onNavigate={onNavigate}
            onRename={a.isCurrent ? onRename : undefined}
            onToggleComplete={a.isCurrent ? onToggleComplete : undefined}
            isCurrentDone={a.isCurrent ? isCurrentDone : undefined}
          />
        ))}
      </Stack>
    </Stack>
  );
}

function ActivityRowView({
  activity,
  onNavigate,
  onRename,
  onToggleComplete,
  isCurrentDone,
}: {
  activity: ActivityRow;
  onNavigate: (sessionId: Id<"sessions">) => void;
  onRename?: () => void;
  onToggleComplete?: () => void;
  isCurrentDone?: boolean;
}) {
  // Pattern C of the unified hierarchy DRY pass: the progress strip
  // uses the same HierarchyRow primitive as StartAssignmentDialog,
  // Curriculum browser, UnitPickerDialog, and the design-screen
  // outline. What changes is the trailing slot — a status pip (✓ /
  // ▶ / ○) instead of a chevron — and the optional sub-row of stars
  // + inline rename/complete actions for the current activity.
  //
  // The current row is also clickable — useful on the full-screen
  // /scholar/quest/[id] surface, where clicking YOU'RE HERE takes
  // the scholar back into their working project. Inside the drawer
  // this is effectively a no-op (we're already on that project, the
  // drawer just closes) but it's harmless.
  const canClick = !!activity.sessionId;
  const StatusIcon =
    activity.status === "passed"
      ? CheckCircle
      : activity.status === "in-progress"
        ? Play
        : Circle;
  const iconColor =
    activity.status === "passed"
      ? "green.500"
      : activity.status === "in-progress"
        ? "violet.500"
        : "gray.400";
  const hasInlineActions = activity.isCurrent && (onRename || onToggleComplete);

  return (
    <Stack gap={0}>
      <HierarchyRow
        leading={
          <Box color={iconColor} flexShrink={0}>
            <StatusIcon size={14} />
          </Box>
        }
        label={activity.title}
        selected={activity.isCurrent}
        /* 🏠 chip dropped — homework is now a property of the push, not the activity. */
        onClick={
          canClick && activity.sessionId
            ? () => onNavigate(activity.sessionId!)
            : undefined
        }
        trailing={
          activity.isCurrent
            ? {
                kind: "status",
                icon: (
                  <Text
                    as="span"
                    fontSize="2xs"
                    fontFamily="heading"
                    fontWeight="700"
                    color="violet.500"
                    textTransform="uppercase"
                    letterSpacing="0.05em"
                  >
                    You&apos;re here
                  </Text>
                ),
              }
            : { kind: "none" }
        }
      />
      {hasInlineActions && (
        <Box pl={9} pr={2} pb={1.5} pt={0.5}>
          <NodeActions
            onRename={onRename}
            onToggleComplete={onToggleComplete}
            isCurrentDone={isCurrentDone}
          />
        </Box>
      )}
    </Stack>
  );
}

// BadgesList + BadgeRowView removed — quest-scoped badges are gone.
// Unit-level badges land in Phase D with a different surface
// (scholar's "Earned" badges section on /scholar home).

// ── Loading / pending / error ───────────────────────────────────────

function PendingBanner() {
  return (
    <Flex
      gap={2}
      align="center"
      px={3}
      py={2.5}
      bg="violet.50"
      borderRadius="md"
      borderWidth="1px"
      borderColor="violet.200"
      color="violet.700"
    >
      <Spinner size="xs" />
      <Text fontSize="xs" fontFamily="heading" fontWeight="600">
        Writing your big-picture summary…
      </Text>
    </Flex>
  );
}

function ErrorBanner({
  message,
  onRetry,
}: {
  message: string | null;
  onRetry: () => void;
}) {
  return (
    <Box
      px={3}
      py={2.5}
      bg="red.50"
      borderRadius="md"
      borderWidth="1px"
      borderColor="red.300"
    >
      <Text
        fontSize="xs"
        fontFamily="heading"
        fontWeight="700"
        color="red.700"
        mb={1}
      >
        Couldn&apos;t generate the big-picture summary
      </Text>
      <Text fontSize="xs" color="charcoal.600" mb={2}>
        {message ?? "Unknown error"}
      </Text>
      <Button
        size="xs"
        variant="outline"
        borderColor="red.300"
        color="red.600"
        onClick={onRetry}
      >
        <ArrowClockwise size={11} style={{ marginRight: 4 }} />
        Try again
      </Button>
    </Box>
  );
}

function ProgressSkeleton() {
  return (
    <Stack gap={5}>
      {[1, 2, 3].map((i) => (
        <Box key={i}>
          <Box w="80px" h="10px" bg="gray.200" borderRadius="sm" mb={2} />
          <Box w="full" h="14px" bg="gray.100" borderRadius="sm" mb={1.5} />
          <Box w="90%" h="14px" bg="gray.100" borderRadius="sm" mb={1.5} />
          <Box w="60%" h="14px" bg="gray.100" borderRadius="sm" />
        </Box>
      ))}
    </Stack>
  );
}
