"use client";

/**
 * The per-node maturity glyph — a small CSS circle whose fill/color
 * encodes how far a unit / lesson / activity has come on its own
 * Draft → Rehearsed → Debriefed ladder. Replaces the duration tag in the
 * design-mode outline (UnitOutlineTree) and anchors each node's vertical
 * Summary timeline. Status comes from `unitMaturity.getNodeStatuses`; the
 * mapping logic is pure in `convex/lib/unitMaturity.ts` (NodeStatus).
 *
 * Coarse on purpose — the precise rung lives in the node's Summary
 * timeline. Color carries the state; shape (hollow / half / filled)
 * reinforces it so it isn't color-only.
 */
import { Box, Portal, Spinner, Tooltip } from "@chakra-ui/react";
import type { NodeStatus } from "@/convex/lib/unitMaturity";

export const STATUS_GLYPH_COLORS = {
  built: "gray.300",
  draft: "gray.300",
  inProgress: "violet.500",
  matured: "green.500",
  needsWork: "orange.500",
  incomplete: "yellow.700",
} as const;

/** Green used for the in-progress spinner — matches the Readiness signal. */
const RUNNING_GREEN = "green.600";

const META: Record<NodeStatus, { color: string; label: string }> = {
  built: { color: STATUS_GLYPH_COLORS.built, label: "Built" },
  draft: {
    color: STATUS_GLYPH_COLORS.draft,
    label: "Draft — not yet scholar-bot rehearsed",
  },
  inProgress: {
    color: STATUS_GLYPH_COLORS.inProgress,
    label: "Scholar-bot rehearsed — not yet debriefed",
  },
  matured: {
    color: STATUS_GLYPH_COLORS.matured,
    label: "Debriefed — matches real scholars",
  },
  needsWork: {
    color: STATUS_GLYPH_COLORS.needsWork,
    label: "Needs work — fell short of the bar",
  },
};

export function DashedStatusCircle({
  size,
  color = "var(--chakra-colors-yellow-700)",
}: {
  size: number;
  color?: string;
}) {
  const strokeWidth = 1;
  const center = size / 2;
  const radius = (size - strokeWidth) / 2;
  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      aria-hidden="true"
      style={{ display: "block", flexShrink: 0 }}
    >
      <circle
        cx={center}
        cy={center}
        r={radius}
        fill="none"
        stroke={color}
        strokeWidth={strokeWidth}
        strokeDasharray="1 1"
        strokeLinecap="butt"
      />
    </svg>
  );
}

function DotIcon({ status, size }: { status: NodeStatus; size: number }) {
  const baseProps = {
    w: `${size}px`,
    h: `${size}px`,
    borderRadius: "full",
    borderWidth: "1px",
    flexShrink: 0,
  } as const;

  switch (status) {
    case "matured":
      return (
        <Box
          {...baseProps}
          borderColor={STATUS_GLYPH_COLORS.matured}
          bg={STATUS_GLYPH_COLORS.matured}
        />
      );
    case "inProgress":
      return (
        <Box
          {...baseProps}
          borderColor={STATUS_GLYPH_COLORS.inProgress}
          bgImage="linear-gradient(to right, var(--chakra-colors-violet-500) 50%, transparent 50%)"
        />
      );
    case "needsWork":
      return (
        <Box
          {...baseProps}
          borderColor={STATUS_GLYPH_COLORS.needsWork}
          bg="orange.50"
        />
      );
    case "built":
      return (
        <Box
          {...baseProps}
          borderColor={STATUS_GLYPH_COLORS.built}
          bg={STATUS_GLYPH_COLORS.built}
        />
      );
    default:
      return <Box {...baseProps} borderColor={STATUS_GLYPH_COLORS.draft} />;
  }
}

export function MaturityStatusDot({
  status,
  size = 12,
  running = false,
}: {
  status: NodeStatus;
  size?: number;
  /** A heuristic review or scholar-bot rehearsal is in flight for this node —
   *  show a green spinner so the list view signals that something's happening
   *  (the maturity meter step spins in lockstep). */
  running?: boolean;
}) {
  const { color, label } = META[status];
  if (running) {
    return (
      <Tooltip.Root openDelay={250} closeDelay={0}>
        <Tooltip.Trigger asChild>
          <Box
            display="flex"
            alignItems="center"
            flexShrink={0}
            cursor="default"
            aria-label="In progress…"
          >
            <Spinner
              boxSize={`${size}px`}
              borderWidth="2px"
              color={RUNNING_GREEN}
            />
          </Box>
        </Tooltip.Trigger>
        <Portal>
          <Tooltip.Positioner>
            <Tooltip.Content>In progress…</Tooltip.Content>
          </Tooltip.Positioner>
        </Portal>
      </Tooltip.Root>
    );
  }
  return (
    <Tooltip.Root openDelay={250} closeDelay={0}>
      <Tooltip.Trigger asChild>
        <Box
          color={color}
          display="flex"
          alignItems="center"
          flexShrink={0}
          cursor="default"
          aria-label={label}
        >
          <DotIcon status={status} size={size} />
        </Box>
      </Tooltip.Trigger>
      <Portal>
        <Tooltip.Positioner>
          <Tooltip.Content>{label}</Tooltip.Content>
        </Tooltip.Positioner>
      </Portal>
    </Tooltip.Root>
  );
}

/** The human-readable label for a status — reused by the Summary timeline. */
export function statusLabel(status: NodeStatus): string {
  return META[status].label;
}
