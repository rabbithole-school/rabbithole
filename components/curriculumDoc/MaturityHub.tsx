"use client";

/**
 * The maturity HUB — one modal that re-homes the curriculum-quality surfaces,
 * now organised as PR #1072 §8's two panels: **Get it ready** (the green
 * Readiness preflight gate) beside **Track its record** (the violet Sessions
 * field record). Launched from a node's composed maturity pill
 * (`NodeMaturityCta`).
 *
 * The two-panel summary is the front door. Its actions open the deeper surfaces
 * in place (a swap with a back link), so there's exactly ONE entry point for
 * each operation — the redundant second "Review" button is gone:
 *   - Get it ready · Heuristic review → fires the Curriculum Bot audit
 *     (UnitReviewView shows the coherence grid)
 *   - Get it ready · Scholar-bot rehearsal → RehearsePane (activity) /
 *     RollupPane preflight (unit/lesson); Skip is an explicit escape hatch
 *   - Track its record · Debrief → RehearsePane debrief / RollupPane debrief
 *
 * Altitude-aware: readiness/sessions are rolled up per node by the backend, so
 * a unit/lesson hub summarises everything beneath it. Web-only teacher surface;
 * native parity is N/A.
 */
import { useCallback, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import {
  Box,
  Button,
  Dialog,
  Flex,
  Grid,
  Portal,
  Text,
} from "@chakra-ui/react";
import { ArrowLeft } from "@phosphor-icons/react";
import { api } from "@/convex/_generated/api";
import { REVIEW_UNIT_PROMPT } from "@/lib/curriculumBotPrompts";
import { EMPTY_SESSIONS } from "@/convex/lib/activitySessions";
import type { SessionsSignal } from "@/convex/lib/activitySessions";
import type { Readiness } from "@/convex/lib/unitMaturity";
import { UnitReviewView } from "@/components/UnitReviewView";
import { RehearsePane } from "@/components/RehearsePane";
import { RollupPane } from "@/components/RollupPane";
import { StyledDialogContent } from "@/components/ui/StyledDialogContent";
import type { RehearseFixField } from "@/components/nodeEditor/rehearseResult";
import { ReadinessGatePanel } from "./ReadinessGate";
import { SessionsPanel } from "./SessionsSignal";
import type { DocNode } from "./types";

const KIND_LABEL: Record<DocNode["kind"], string> = {
  unit: "Unit",
  lesson: "Lesson",
  activity: "Activity",
};

/** Which deeper surface the summary has swapped to (null = the two panels). */
export type HubView = "review" | "rehearse" | "debrief";

export interface MaturityHubTarget {
  node: DocNode;
  title: string;
  /** Open straight to a deeper surface instead of the two-panel summary. */
  initialView?: HubView;
}

interface NodeStatusesShape {
  readiness: {
    unit: Readiness;
    lessons: Record<string, Readiness>;
    activities: Record<string, Readiness>;
  };
}

interface SessionsShape {
  unit: SessionsSignal;
  lessons: Record<string, SessionsSignal>;
  activities: Record<string, SessionsSignal>;
}

function readinessFor(node: DocNode, statuses: NodeStatusesShape | undefined): Readiness | null {
  if (!statuses) return null;
  if (node.kind === "lesson") return statuses.readiness.lessons[String(node.lessonId)] ?? null;
  if (node.kind === "activity") return statuses.readiness.activities[String(node.activityId)] ?? null;
  return statuses.readiness.unit;
}

function sessionsFor(node: DocNode, data: SessionsShape | undefined): SessionsSignal {
  if (!data) return EMPTY_SESSIONS;
  if (node.kind === "lesson") return data.lessons[String(node.lessonId)] ?? EMPTY_SESSIONS;
  if (node.kind === "activity") return data.activities[String(node.activityId)] ?? EMPTY_SESSIONS;
  return data.unit;
}

/** The deeper surface for a swapped view, scoped to the node's altitude. */
function ExpandedSurface({
  view,
  node,
  askAi,
  onRetarget,
  onFixFinding,
}: {
  view: HubView;
  node: DocNode;
  askAi: (prompt: string) => void;
  /** Retarget the hub onto one activity when a unit/lesson roll-up row is
   *  opened. The roll-up's rows can't navigate (the doc view ignores the
   *  column-view pane URL), so we swap the surface in place instead. */
  onRetarget?: (target: MaturityHubTarget) => void;
  /** Routes a Preflight finding's "Fix this" to the activity's EXISTING
   *  Resources / Deliverable / Duration / Tutor-prompt editor. Only the
   *  activity-level rehearse view renders findings. */
  onFixFinding?: (field: RehearseFixField) => void;
}) {
  if (view === "review") {
    return <UnitReviewView unitId={node.unitId} askAi={askAi} />;
  }
  if (view === "rehearse") {
    return node.kind === "activity" ? (
      <RehearsePane
        activityId={node.activityId}
        view="rehearse"
        askAi={askAi}
        onFixFinding={onFixFinding}
      />
    ) : (
      <RollupPane
        unitId={node.unitId}
        lessonId={node.kind === "lesson" ? node.lessonId : undefined}
        op="preflight"
        onOpenActivity={
          onRetarget
            ? (a) =>
                onRetarget({
                  node: {
                    kind: "activity",
                    unitId: node.unitId,
                    lessonId: a.lessonId,
                    activityId: a.activityId,
                    actKind: "online",
                  },
                  title: a.title,
                  initialView: "rehearse",
                })
            : undefined
        }
      />
    );
  }
  return node.kind === "activity" ? (
    <RehearsePane activityId={node.activityId} view="debrief" askAi={askAi} />
  ) : (
    <RollupPane
      unitId={node.unitId}
      lessonId={node.kind === "lesson" ? node.lessonId : undefined}
      op="debrief"
      onOpenActivity={
        onRetarget
          ? (a) =>
              onRetarget({
                node: {
                  kind: "activity",
                  unitId: node.unitId,
                  lessonId: a.lessonId,
                  activityId: a.activityId,
                  actKind: "online",
                },
                title: a.title,
                initialView: "debrief",
              })
          : undefined
      }
    />
  );
}

export function MaturityHub({
  target,
  askAi,
  onClose,
  onAssign,
  onRetarget,
  onBack,
  onFixFinding,
}: {
  target: MaturityHubTarget | null;
  askAi: (prompt: string) => void;
  onClose: () => void;
  /** Assign THIS node to scholars. The hub closes and the parent opens
   *  StartAssignmentDialog as a sibling — never stacked over this modal
   *  (Ark body-lock; see engineering-principles.md). */
  onAssign?: (node: DocNode) => void;
  /** Swap the hub onto one activity from a unit/lesson roll-up row. The parent
   *  just updates `target`; the open view is derived from a stamp of that
   *  target, so the surface re-homes in place on the SAME render — no
   *  navigation, no modal restack, no stale frame. */
  onRetarget?: (target: MaturityHubTarget) => void;
  /** Present only while a retarget is on the parent's stack: the Back button
   *  pops to the roll-up list the row was clicked in, instead of dropping to
   *  this activity's own summary (the serial-rehearse loop needs the list). */
  onBack?: () => void;
  /** Routes a rehearse-view Preflight finding's "Fix this" to the activity's
   *  EXISTING Resources / Deliverable / Duration / Tutor-prompt editor. The
   *  parent (CurriculumDocumentView) closes this hub, scrolls to the
   *  activity, and opens/highlights the matching field. */
  onFixFinding?: (field: RehearseFixField) => void;
}) {
  const [pending, setPending] = useState(false);

  const node = target?.node ?? null;
  const nodeStatuses = useQuery(
    api.unitMaturity.getNodeStatuses,
    node ? { unitId: node.unitId } : "skip",
  ) as NodeStatusesShape | undefined;
  const sessionsData = useQuery(
    api.activitySessions.getForUnit,
    node ? { unitId: node.unitId } : "skip",
  ) as SessionsShape | undefined;
  const markReviewStarted = useMutation(api.unitReviews.markReviewStarted);
  const setRehearsalSkipped = useMutation(api.unitReviews.setRehearsalSkipped);

  // The open view, stamped with the target it belongs to and DERIVED rather
  // than reset by an effect. Two bugs went with that effect: it ran after the
  // paint, so retargeting the hub rendered the PREVIOUS node's view for a
  // frame; and `initialView` was absent from its dependency key, so asking for
  // a different view of the SAME node was missed entirely (the caller does
  // exactly that — `initialView: "rehearse"` at :130, `"debrief"` at :156).
  // Including it in the stamp fixes both.
  //
  // Deliberately NOT a `key` on this component — its root is a `Dialog.Root`,
  // and remounting an Ark overlay scope while `open` leaks the body lock
  // (`pointer-events: none` page-wide; see
  // `.claude/rules/engineering-principles.md`). Deriving avoids the remount.
  const key = target
    ? `${target.node.kind}:${JSON.stringify(target.node)}:${target.initialView ?? ""}`
    : null;
  const [viewFor, setViewFor] = useState<{ key: string | null; view: HubView | null }>({
    key,
    view: target?.initialView ?? null,
  });
  const view = viewFor.key === key ? viewFor.view : (target?.initialView ?? null);
  const setView = useCallback(
    (next: HubView | null) => setViewFor({ key, view: next }),
    [key],
  );

  if (!target || !node) return null;

  const readiness = readinessFor(node, nodeStatuses);
  const sessions = sessionsFor(node, sessionsData);

  const runReview = async () => {
    setPending(true);
    try {
      await markReviewStarted({ unitId: node.unitId });
      askAi(REVIEW_UNIT_PROMPT);
      setView("review");
    } finally {
      setPending(false);
    }
  };

  const toggleSkip = async (skip: boolean) => {
    setPending(true);
    try {
      await setRehearsalSkipped({ unitId: node.unitId, skipped: skip });
    } finally {
      setPending(false);
    }
  };

  return (
    <Dialog.Root
      open
      onOpenChange={(d) => {
        if (!d.open) onClose();
      }}
      placement="center"
    >
      <Portal>
        <Dialog.Backdrop />
        <Dialog.Positioner>
          <StyledDialogContent maxW="1040px" w="94vw">
            <Dialog.Header px={6} pt={5} pb={4} borderBottomWidth="1px" borderColor="gray.100">
              <Flex align="flex-start" justify="space-between" gap={4} w="full">
                <Box minW={0}>
                  <Text
                    fontFamily="heading"
                    fontSize="2xs"
                    fontWeight="800"
                    letterSpacing="0.08em"
                    textTransform="uppercase"
                    color="charcoal.400"
                  >
                    {KIND_LABEL[node.kind]} · readiness & sessions
                  </Text>
                  <Dialog.Title asChild>
                    <Text
                      fontFamily="heading"
                      fontSize="lg"
                      fontWeight="800"
                      color="navy.500"
                      lineHeight="1.2"
                      truncate
                    >
                      {target.title}
                    </Text>
                  </Dialog.Title>
                </Box>
                <Dialog.CloseTrigger asChild>
                  <Button size="sm" variant="ghost" color="charcoal.500">
                    Close
                  </Button>
                </Dialog.CloseTrigger>
              </Flex>
            </Dialog.Header>
            <Dialog.Body
              h="min(74vh, 720px)"
              minH="420px"
              p={0}
              overflow="hidden"
              bg="white"
            >
              {view ? (
                <Flex direction="column" h="full">
                  <Flex px={4} py={2} borderBottomWidth="1px" borderColor="gray.100" flexShrink={0}>
                    <Button
                      size="xs"
                      variant="ghost"
                      color="charcoal.500"
                      fontFamily="heading"
                      fontWeight="700"
                      onClick={onBack ?? (() => setView(null))}
                    >
                      <ArrowLeft size={14} weight="bold" style={{ marginRight: 4 }} />
                      {onBack ? "Back to list" : "Back to summary"}
                    </Button>
                  </Flex>
                  <Box flex={1} minH={0} overflow="hidden" bg="gray.50">
                    <ExpandedSurface
                      view={view}
                      node={node}
                      askAi={askAi}
                      onRetarget={onRetarget}
                      onFixFinding={onFixFinding}
                    />
                  </Box>
                </Flex>
              ) : readiness === null ? (
                <Flex h="full" align="center" justify="center">
                  <Text color="charcoal.400">Loading…</Text>
                </Flex>
              ) : (
                <Flex direction="column" h="full">
                  <Grid templateColumns={{ base: "1fr", md: "1fr 1fr" }} flex={1} minH={0}>
                    <Box
                      borderRightWidth={{ base: 0, md: "1px" }}
                      borderBottomWidth={{ base: "1px", md: 0 }}
                      borderColor="gray.100"
                      minH={0}
                    >
                      <ReadinessGatePanel
                        readiness={readiness}
                        simMean={sessions.simMean}
                        simSessionCount={sessions.simSessionCount}
                        pending={pending}
                        onRunReview={runReview}
                        onRunRehearsal={() => setView("rehearse")}
                        onToggleSkip={toggleSkip}
                      />
                    </Box>
                    <Box minH={0}>
                      <SessionsPanel
                        sessions={sessions}
                        onRunDebrief={() => setView("debrief")}
                      />
                    </Box>
                  </Grid>
                  {/* The bridge rung: Assign sits between "Get it ready" and
                      "Track its record" (Draft → Reviewed → Rehearsed → ASSIGNED
                      → Debriefed). Assign-at-any-maturity is intentional, so
                      this is always live. It closes the hub and hands off to
                      StartAssignmentDialog (never stacked over this modal). */}
                  {onAssign && (
                    <Flex
                      align="center"
                      justify="space-between"
                      gap={3}
                      px={5}
                      py={3}
                      borderTopWidth="1px"
                      borderColor="gray.100"
                      bg="gray.50"
                      flexShrink={0}
                    >
                      <Text fontSize="sm" color="charcoal.500" fontFamily="body">
                        {readiness.ready
                          ? "Ready — assign it to scholars."
                          : "Assign it to scholars whenever you're ready."}
                      </Text>
                      <Button
                        size="sm"
                        bg="violet.500"
                        color="white"
                        fontFamily="heading"
                        fontWeight="700"
                        _hover={{ bg: "violet.600" }}
                        onClick={() => onAssign(node)}
                      >
                        Assign to scholars
                      </Button>
                    </Flex>
                  )}
                </Flex>
              )}
            </Dialog.Body>
          </StyledDialogContent>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
}
