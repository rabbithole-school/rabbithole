"use client";

import { Box } from "@chakra-ui/react";
import {
  Laptop,
  Desk,
  CheckCircle,
  UsersThree,
  GlobeSimple,
  MathOperations,
  GameController,
  Planet,
  Wrench,
} from "@phosphor-icons/react";
import type { ActivityKind } from "@/lib/activityKinds";

interface ActivityKindIconProps {
  kind: ActivityKind;
  completed?: boolean;
  size?: number;
  /** CSS color (any chakra token or hex). Defaults to charcoal.500 — subtle
   *  enough to live next to text without competing with it. */
  color?: string;
}

/**
 * Render the icon for an activity kind. DRY across the outline tree, project
 * navigator, kind picker, etc. — change the icon set in one place.
 *
 * Uses Phosphor "regular" weight for online/offline (subtle outline glyphs)
 * and a filled green CheckCircle for completed activities.
 */
export function ActivityKindIcon({
  kind,
  completed,
  size = 14,
  color,
}: ActivityKindIconProps) {
  if (completed) {
    return (
      <Box
        as="span"
        display="inline-flex"
        alignItems="center"
        color={color ?? "green.500"}
        flexShrink={0}
      >
        <CheckCircle size={size} weight="fill" />
      </Box>
    );
  }
  const Icon =
    kind === "online"
      ? Laptop
      : kind === "shareBack"
        ? UsersThree
        : kind === "web"
          ? GlobeSimple
          : kind === "problem_set"
            ? MathOperations
            : kind === "game"
              ? GameController
              : kind === "simulator"
                ? Planet
                : kind === "vibecode"
                  ? Wrench
                  : Desk;
  return (
    <Box
      as="span"
      display="inline-flex"
      alignItems="center"
      color={color ?? "charcoal.400"}
      flexShrink={0}
    >
      <Icon size={size} weight="regular" />
    </Box>
  );
}
