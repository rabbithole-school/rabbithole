"use client";

/**
 * MisconceptionFlag — teacher-only indicator badge for a knowledge node.
 *
 * ── USAGE ────────────────────────────────────────────────────────────────
 * Render NEXT TO a KnowledgeNodeDial in the consuming component:
 *
 *   {isTeacher && reading.hasOpenMisconception && (
 *     <MisconceptionFlag />
 *   )}
 *
 * This component is intentionally standalone — it does NOT modify
 * KnowledgeNodeDial.tsx. The caller is responsible for the teacher guard.
 *
 * ── COPY NOTES ───────────────────────────────────────────────────────────
 * Growth-framed; never deficit language. The tooltip says
 * "Possible misconception — needs a closer look" (teacher action, not a
 * verdict on the scholar). The ⚑ icon is widely understood as a soft flag
 * ("check this") not a hard warning.
 *
 * ── CHAKRA UI v3 ─────────────────────────────────────────────────────────
 * Uses Tooltip compound API (Tooltip.Root / .Trigger / .Positioner /
 * .Content) per the house pattern in ManualRehearsalBanner.tsx.
 * Colour palette: amber (warm attention, not alarm).
 */

import { Box, Tooltip } from "@chakra-ui/react";

const DEFAULT_LABEL = "Possible misconception — needs a closer look";

export interface MisconceptionFlagProps {
  /**
   * Accessible label and tooltip text.
   * Default: "Possible misconception — needs a closer look".
   */
  label?: string;
  /** Bounding-box size in px. Default 16. */
  size?: number;
}

/**
 * A small amber ⚑ badge with a tooltip.
 * TEACHER-ONLY — render only when `isTeacher && reading.hasOpenMisconception`.
 */
export function MisconceptionFlag({
  label = DEFAULT_LABEL,
  size = 16,
}: MisconceptionFlagProps) {
  const fontSize = `${Math.round(size * 0.72)}px`;

  return (
    <Tooltip.Root openDelay={200} closeDelay={0}>
      <Tooltip.Trigger asChild>
        <Box
          as="span"
          role="img"
          aria-label={label}
          display="inline-flex"
          alignItems="center"
          justifyContent="center"
          width={`${size}px`}
          height={`${size}px`}
          borderRadius="full"
          bg="yellow.100"
          color="yellow.700"
          fontSize={fontSize}
          lineHeight={1}
          flexShrink={0}
          cursor="default"
          userSelect="none"
          _dark={{ bg: "yellow.900", color: "yellow.300" }}
        >
          ⚑
        </Box>
      </Tooltip.Trigger>
      <Tooltip.Positioner>
        <Tooltip.Content maxW="220px" fontSize="xs">
          {label}
        </Tooltip.Content>
      </Tooltip.Positioner>
    </Tooltip.Root>
  );
}
