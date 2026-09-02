"use client";

/**
 * Signal 1 · Readiness — the green PREFLIGHT gate (PR #1072 §8). It's a strip
 * that FILLS, left→right, as a teacher clears three gates BEFORE assigning:
 *
 *   Built  →  Heuristic review  →  Scholar-bot rehearsal  →  ✓ Ready
 *
 * "Ready" = built AND heuristic-reviewed AND (rehearsal passed OR skipped OR
 * nothing online to rehearse). It deliberately does NOT depend on assignments,
 * real sessions, or the sim↔real calibration — that's the violet Sessions
 * signal's job (SessionsSignal.tsx). See `deriveReadiness` in
 * convex/lib/unitMaturity.ts for the pure rule this renders.
 *
 * Three densities, one grammar: the filling strip (list rows + hub), a "✓ Ready"
 * badge / "k/3 building" caption where a strip won't fit, and the full stepped
 * panel with Skip / Spinner in the hub. Green = ready, a green barber-pole =
 * a step running (motion, not a new color). Web-only teacher surface.
 */
import { Box, Button, Flex, Portal, Spinner, Text, Tooltip } from "@chakra-ui/react";
import { Check } from "@phosphor-icons/react";
import type {
  Readiness,
  ReadinessStep,
  ReadinessStepState,
} from "@/convex/lib/unitMaturity";
import { AMBER } from "./SessionsSignal";
import { CircleCheck, HollowDot } from "./MaturityGlyphs";

// The §7/§8 palette, pinned to exact hexes so every surface matches the mock.
export const READY_GREEN = "#006a45";
const RUN_HATCH =
  "repeating-linear-gradient(115deg,#2f8f66 0 5px,#8ac7ab 5px 10px)";
const SKIP_HATCH =
  "repeating-linear-gradient(45deg,#dde1e6 0 3px,transparent 3px 7px)";

const SLIDE = {
  animation: "rh-rd-slide 0.7s linear infinite",
  backgroundSize: "14px 100%",
  "@keyframes rh-rd-slide": { to: { backgroundPosition: "14px 0" } },
} as const;

/** How many of the three gates are satisfied (done / skipped / n-a). */
function satisfiedCount(readiness: Readiness): number {
  return readiness.steps.filter(
    (s) => s.state === "done" || s.state === "skipped" || s.state === "na",
  ).length;
}

/** The resting caption beside the strip. Null once ready (a badge takes over). */
export function readinessCaption(readiness: Readiness): string | null {
  if (readiness.ready) return null;
  if (readiness.running) {
    return readiness.runningStepId === "heuristicReview"
      ? "review running…"
      : "rehearsal running…";
  }
  return `${satisfiedCount(readiness)}/${readiness.steps.length} building`;
}

/** One segment of the filling strip. */
function StripSegment({
  state,
  last,
}: {
  state: ReadinessStepState;
  last: boolean;
}) {
  const base = {
    flex: 1,
    h: "full",
    borderRightWidth: last ? "0" : "2px",
    borderRightColor: "white",
  } as const;
  if (state === "done" || state === "na") {
    return <Box {...base} bg={READY_GREEN} />;
  }
  if (state === "running") {
    return <Box {...base} bgImage={RUN_HATCH} css={SLIDE} />;
  }
  if (state === "skipped") {
    return <Box {...base} bgImage={SKIP_HATCH} />;
  }
  return <Box {...base} bg="transparent" />;
}

/** The filling readiness strip. `w` lets it size from a micro pill accent up to
 *  the full-width hub bar. */
export function ReadinessStrip({
  readiness,
  w = "112px",
  h = "15px",
}: {
  readiness: Readiness;
  w?: string;
  h?: string;
}) {
  return (
    <Flex
      w={w}
      h={h}
      borderRadius="8px"
      overflow="hidden"
      bg="#eceef1"
      boxShadow="inset 0 0 0 1px #e0e3e7"
      flexShrink={0}
      align="center"
    >
      {readiness.steps.map((s, i) => (
        <StripSegment
          key={s.id}
          state={s.state}
          last={i === readiness.steps.length - 1}
        />
      ))}
    </Flex>
  );
}

/** The terminal "✓ Ready" badge (green), shown once the gate is full. */
export function ReadyBadge() {
  return (
    <Flex align="center" gap={1.5} flexShrink={0}>
      <Check size={13} weight="bold" color={READY_GREEN} />
      <Text fontFamily="heading" fontWeight="800" fontSize="xs" color={READY_GREEN}>
        Ready
      </Text>
    </Flex>
  );
}

/** The outline / left-nav micro-indicator — a tiny version of the filling strip
 *  that speaks the exact same grammar as the header pill (same #006a45 fill,
 *  same shape, same barber-pole while a step runs) so the left panel stops
 *  showing a mismatched scalar dot. Coarse on purpose — hover for the caption,
 *  open the node for the full gate. Preserves at-a-glance bubble-up in the tree. */
export function ReadinessDot({
  readiness,
  w = "11px",
}: {
  readiness: Readiness;
  w?: string;
}) {
  const caption = readiness.ready
    ? "✓ Ready"
    : readinessCaption(readiness) ?? "Readiness";
  return (
    <Tooltip.Root openDelay={250} closeDelay={0}>
      <Tooltip.Trigger asChild>
        <Box
          display="flex"
          alignItems="center"
          flexShrink={0}
          cursor="default"
          opacity={0.8}
          aria-label={caption}
        >
          <ReadinessStrip readiness={readiness} w={w} h="5px" />
        </Box>
      </Tooltip.Trigger>
      <Portal>
        <Tooltip.Positioner>
          <Tooltip.Content>{caption}</Tooltip.Content>
        </Tooltip.Positioner>
      </Portal>
    </Tooltip.Root>
  );
}

/** Strip + resting caption/badge — the list-row & summary readout. */
export function ReadinessInline({
  readiness,
  w,
}: {
  readiness: Readiness;
  w?: string;
}) {
  return (
    <Flex align="center" gap={2} minW={0}>
      <ReadinessStrip readiness={readiness} w={w} />
      {readiness.ready ? (
        <ReadyBadge />
      ) : (
        <Text
          fontSize="xs"
          color={readiness.running ? READY_GREEN : "charcoal.400"}
          whiteSpace="nowrap"
        >
          {readinessCaption(readiness)}
        </Text>
      )}
    </Flex>
  );
}

// ── Hub panel · "Get it ready" ──────────────────────────────────────────

/** The gauge dot next to each step in the hub panel. Running → green Spinner;
 *  satisfied → green circle-check; skipped → dashed ring; todo → hollow ring.
 *  The circle-check / hollow-ring forms are shared with the violet Sessions
 *  panel (MaturityGlyphs) so both signals read as one system. */
function GaugeDot({ state }: { state: ReadinessStepState }) {
  if (state === "running") {
    return <Spinner size="xs" color={READY_GREEN} borderWidth="2px" flexShrink={0} />;
  }
  if (state === "done" || state === "na") {
    return <CircleCheck color={READY_GREEN} />;
  }
  if (state === "skipped") {
    return <HollowDot color="#c7ccd4" dashed />;
  }
  return <HollowDot />;
}

function StepRow({
  step,
  action,
}: {
  step: ReadinessStep;
  action?: React.ReactNode;
}) {
  return (
    <Flex align="center" gap={2.5} py={2} borderBottomWidth="1px" borderBottomColor="gray.100" borderStyle="dashed">
      <GaugeDot state={step.state} />
      <Text fontFamily="heading" fontWeight="700" fontSize="sm" color="#3a4658">
        {step.label}
      </Text>
      <Flex ml="auto" align="center" gap={1.5}>
        {action ?? (
          <Text fontSize="xs" color="charcoal.400">
            {step.detail}
          </Text>
        )}
      </Flex>
    </Flex>
  );
}

function GhostBtn({
  children,
  onClick,
  disabled,
}: {
  children: React.ReactNode;
  onClick?: () => void;
  disabled?: boolean;
}) {
  return (
    <Button
      size="xs"
      h="26px"
      variant="outline"
      borderStyle="dashed"
      borderColor="gray.300"
      color="charcoal.400"
      fontFamily="heading"
      fontWeight="700"
      fontSize="xs"
      onClick={onClick}
      disabled={disabled}
    >
      {children}
    </Button>
  );
}

function PrimaryBtn({
  children,
  onClick,
  disabled,
}: {
  children: React.ReactNode;
  onClick?: () => void;
  disabled?: boolean;
}) {
  return (
    <Button
      size="xs"
      h="26px"
      bg={READY_GREEN}
      color="white"
      fontFamily="heading"
      fontWeight="700"
      fontSize="xs"
      _hover={{ bg: READY_GREEN, filter: "brightness(1.1)" }}
      onClick={onClick}
      disabled={disabled}
    >
      {children}
    </Button>
  );
}

/**
 * The hub's left panel — "Get it ready". The filling strip on top, then the
 * three gates with their live detail and the actions that advance them:
 * run the heuristic review, run (or Skip) the expensive scholar-bot rehearsal.
 */
export function ReadinessGatePanel({
  readiness,
  simMean = null,
  simSessionCount = 0,
  onRunReview,
  onRunRehearsal,
  onToggleSkip,
  pending = false,
}: {
  readiness: Readiness;
  /** The sims' predicted fitness (best rehearsal) — also the amber tick under
   *  Sessions; shown as "predicted mean X.X" on the rehearsal step. */
  simMean?: number | null;
  /** How many rehearsal sims backed that prediction — the "N simulated sessions"
   *  count on the rehearsal step. */
  simSessionCount?: number;
  onRunReview?: () => void;
  onRunRehearsal?: () => void;
  onToggleSkip?: (skip: boolean) => void;
  pending?: boolean;
}) {
  const [built, review, rehearsal] = readiness.steps;

  const reviewAction =
    review.state === "running" ? (
      <Flex align="center" gap={1.5}>
        <Spinner size="xs" color={READY_GREEN} />
        <Text fontSize="xs" color={READY_GREEN} fontWeight="700">
          Running…
        </Text>
      </Flex>
    ) : review.state === "done" ? (
      <Text fontSize="xs" color="charcoal.400">
        {review.detail}
      </Text>
    ) : built.state === "done" ? (
      <PrimaryBtn onClick={onRunReview} disabled={pending}>
        Run review
      </PrimaryBtn>
    ) : (
      <Text fontSize="xs" color="charcoal.400">
        {review.detail}
      </Text>
    );

  let rehearsalAction: React.ReactNode;
  if (rehearsal.state === "running") {
    rehearsalAction = (
      <Flex align="center" gap={1.5}>
        <Spinner size="xs" color={READY_GREEN} />
        <Text fontSize="xs" color={READY_GREEN} fontWeight="700">
          Running…
        </Text>
      </Flex>
    );
  } else if (rehearsal.state === "na") {
    rehearsalAction = (
      <Text fontSize="xs" color="charcoal.400">
        {rehearsal.detail}
      </Text>
    );
  } else if (rehearsal.state === "skipped") {
    rehearsalAction = (
      <Flex align="center" gap={1.5}>
        <Text fontSize="xs" color="charcoal.400">
          Skipped
        </Text>
        <GhostBtn onClick={() => onToggleSkip?.(false)} disabled={pending}>
          Un-skip
        </GhostBtn>
        <GhostBtn onClick={onRunRehearsal}>Open</GhostBtn>
      </Flex>
    );
  } else if (rehearsal.state === "done") {
    // Mirror the real "N sessions · mean X.X" grammar on the sim side: the
    // rehearsal volume + its predicted fitness (amber, tying to the tick). The
    // "Open" ghost keeps the rehearse surface reachable once the step is done —
    // it only opens the view (RehearsePane), it does not trigger a new run.
    rehearsalAction = (
      <Flex align="center" gap={1.5}>
        {simSessionCount > 0 ? (
          <Text fontSize="xs" color="charcoal.400" whiteSpace="nowrap">
            {simSessionCount} simulated{" "}
            {simSessionCount === 1 ? "session" : "sessions"}
            {simMean != null && (
              <>
                {" · "}
                <Box as="span" color={AMBER} fontWeight="700">
                  predicted mean {simMean.toFixed(1)}
                </Box>
              </>
            )}
          </Text>
        ) : (
          <Text fontSize="xs" color="charcoal.400">
            {rehearsal.detail}
          </Text>
        )}
        <GhostBtn onClick={onRunRehearsal}>Open</GhostBtn>
      </Flex>
    );
  } else {
    // todo — offer both the expensive run and the escape hatch.
    rehearsalAction = (
      <Flex align="center" gap={1.5}>
        <GhostBtn onClick={() => onToggleSkip?.(true)} disabled={pending}>
          Skip
        </GhostBtn>
        <PrimaryBtn onClick={onRunRehearsal} disabled={pending || built.state !== "done"}>
          Run rehearsal
        </PrimaryBtn>
      </Flex>
    );
  }

  return (
    <Box p={5} h="full" overflowY="auto">
      <Text fontFamily="heading" fontWeight="800" fontSize="md" color="navy.500">
        Get it ready
      </Text>
      <Text fontSize="xs" color="charcoal.400" mb={3}>
        Preflight — do this before assigning
      </Text>
      <Box mb={4}>
        <ReadinessStrip readiness={readiness} w="100%" h="17px" />
      </Box>
      <StepRow step={built} />
      <StepRow step={review} action={reviewAction} />
      <StepRow step={rehearsal} action={rehearsalAction} />
      {readiness.ready && (
        <Flex mt={4} align="center" gap={1.5}>
          <Check size={15} weight="bold" color={READY_GREEN} />
          <Text fontFamily="heading" fontWeight="800" fontSize="sm" color={READY_GREEN}>
            Ready to assign
          </Text>
        </Flex>
      )}
    </Box>
  );
}
