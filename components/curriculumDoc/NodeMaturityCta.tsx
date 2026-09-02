"use client";

/**
 * The right-aligned maturity control for a curriculum document node — the
 * COMPOSED pill of PR #1072 §8, redrawn as one neutral click target: a micro
 * green Readiness strip (the preflight gate that fills) beside the violet
 * Sessions record (the field measurement strip), separated by a hairline so the
 * two signals never share a hue. There is deliberately NO green pill body — the
 * green lives only in the strip fill and the "✓ Ready" mark, the violet only in
 * the Sessions read, so they never clash. One affordance rides alongside every
 * unit / lesson / activity headline and launches the two-panel maturity hub.
 *
 * Green answers "is it ready to assign?"; violet answers "what's its record?".
 * A weak session mean tints the mean amber. Web-only teacher surface.
 */
import { Box, Button, Flex, Text } from "@chakra-ui/react";
import { Play } from "@phosphor-icons/react";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import type { Readiness } from "@/convex/lib/unitMaturity";
import {
  EMPTY_SESSIONS,
  type SessionsSignal,
  totalSessions,
} from "@/convex/lib/activitySessions";
import {
  ReadinessStrip,
  ReadyBadge,
  readinessCaption,
  READY_GREEN,
} from "./ReadinessGate";
import { SessionsPillMark } from "./SessionsSignal";

/** A one-line hover summary of both signals, for the pill's native title. */
function pillTitle(readiness: Readiness, sessions: SessionsSignal): string {
  const caption = readinessCaption(readiness);
  const parts = [
    readiness.ready ? "Ready to assign" : `Getting ready — ${caption ?? ""}`,
  ];
  if (totalSessions(sessions) > 0) {
    const mean =
      sessions.meanFitness !== null
        ? ` · mean ${sessions.meanFitness.toFixed(1)}`
        : " · no completions yet";
    parts.push(
      `${totalSessions(sessions)} sessions · ${sessions.activeCount} active · ${sessions.completeCount} complete${mean}`,
    );
  }
  return parts.join("   ·   ");
}

/**
 * The composed maturity pill. Give it the node's rolled-up Readiness + Sessions
 * signals and an `onOpen` that launches the hub for that node.
 */
export function NodeMaturityCta({
  readiness,
  sessions,
  onOpen,
}: {
  readiness: Readiness;
  sessions: SessionsSignal;
  onOpen: () => void;
}) {
  const ready = readiness.ready;
  const hasSessions = totalSessions(sessions) > 0;
  const caption = readinessCaption(readiness);
  return (
    <Button
      type="button"
      size="xs"
      h="30px"
      px={2.5}
      gap={2}
      flexShrink={0}
      borderRadius="full"
      borderWidth="1px"
      borderColor="gray.200"
      bg="white"
      _hover={{ bg: "gray.50", borderColor: "gray.300" }}
      title={pillTitle(readiness, sessions)}
      onClick={(e) => {
        e.stopPropagation();
        onOpen();
      }}
    >
      <Flex align="center" gap={1.5} flexShrink={0}>
        <ReadinessStrip readiness={readiness} w="34px" h="11px" />
        {ready ? (
          <ReadyBadge />
        ) : (
          <Text
            fontFamily="heading"
            fontWeight="700"
            fontSize="xs"
            color={readiness.running ? READY_GREEN : "charcoal.500"}
            whiteSpace="nowrap"
          >
            {caption}
          </Text>
        )}
      </Flex>
      {hasSessions && (
        <>
          <Box w="1px" h="16px" bg="gray.200" flexShrink={0} />
          <SessionsPillMark sessions={sessions} />
        </>
      )}
    </Button>
  );
}

// A fixed-footprint shimmer so the pill reserves its slot before its two signals
// land — the whole right-hand cluster used to jump when it popped in from zero.
// Same 30px height + pill chrome as the loaded control, roughly the width of the
// Readiness half, so the settle is a quiet fill rather than a layout shift.
const PILL_SHIMMER = {
  animation: "rh-pill-shimmer 1.2s ease-in-out infinite",
  "@keyframes rh-pill-shimmer": {
    "0%,100%": { opacity: 0.5 },
    "50%": { opacity: 0.85 },
  },
} as const;

function MaturityPillSkeleton() {
  return (
    <Flex
      h="30px"
      px={2.5}
      gap={2}
      align="center"
      flexShrink={0}
      borderRadius="full"
      borderWidth="1px"
      borderColor="gray.200"
      bg="white"
      aria-hidden
    >
      <Box w="34px" h="11px" borderRadius="4px" bg="#e3efe9" css={PILL_SHIMMER} />
      <Box w="46px" h="9px" borderRadius="full" bg="gray.100" css={PILL_SHIMMER} />
    </Flex>
  );
}

/**
 * Self-contained maturity control for a node — subscribes to the two rolled-up
 * signals (`getNodeStatuses.readiness` + `activitySessions.getForUnit`), picks
 * this node's slice, and renders the composed pill. Identical (unitId) queries
 * dedupe on the Convex client, so many of these on one page share subscriptions.
 * Renders nothing until the signals load. `onOpen` launches the node's hub.
 */
export function NodeMaturityControls({
  unitId,
  lessonId,
  activityId,
  onOpen,
}: {
  unitId: Id<"units">;
  lessonId?: Id<"lessons">;
  activityId?: Id<"activities">;
  onOpen: () => void;
}) {
  const nodeStatuses = useQuery(api.unitMaturity.getNodeStatuses, { unitId });
  const sessionsData = useQuery(api.activitySessions.getForUnit, { unitId });
  if (nodeStatuses === undefined || sessionsData === undefined)
    return <MaturityPillSkeleton />;

  const readiness: Readiness | undefined = activityId
    ? nodeStatuses.readiness.activities[String(activityId)]
    : lessonId
      ? nodeStatuses.readiness.lessons[String(lessonId)]
      : nodeStatuses.readiness.unit;
  const sessions: SessionsSignal = activityId
    ? sessionsData.activities[String(activityId)] ?? EMPTY_SESSIONS
    : lessonId
      ? sessionsData.lessons[String(lessonId)] ?? EMPTY_SESSIONS
      : sessionsData.unit;

  if (!readiness) return null;
  return <NodeMaturityCta readiness={readiness} sessions={sessions} onOpen={onOpen} />;
}

/**
 * A quiet-but-labeled "Rehearse" button that stands in every node's sticky
 * header — the one-click word that opens the maturity hub straight to the
 * rehearse surface (activities → RehearsePane, with the sims panel + the "Drive
 * it yourself" manual-rehearse button; unit/lesson → RollupPane preflight).
 * It's deliberately NOT saturated: `variant="outline"` with an even 1px border,
 * so the colored maturity pill stays the header's one accent. `onOpen` is wired
 * by the caller to launch the hub at the HubView "rehearse" surface.
 */
export function RehearseButton({ onOpen }: { onOpen: () => void }) {
  return (
    <Button
      type="button"
      variant="outline"
      size="xs"
      h="26px"
      px={2.5}
      gap={1.5}
      flexShrink={0}
      borderRadius="md"
      borderWidth="1px"
      borderColor="gray.200"
      bg="white"
      color="charcoal.600"
      fontFamily="heading"
      fontWeight="600"
      fontSize="xs"
      _hover={{ bg: "gray.50" }}
      onClick={(e) => {
        e.stopPropagation();
        onOpen();
      }}
    >
      <Play size={14} weight="bold" style={{ flexShrink: 0 }} />
      Rehearse
    </Button>
  );
}
