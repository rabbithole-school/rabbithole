"use client";

/**
 * The STANDARD multi-step challenge frame — the shared scaffolding a scholar
 * should recognize on sight, whether the inner content is:
 *   • Model A — a mini-playlist of linked sub-items (state does NOT carry
 *     across steps; each step is independently graded, e.g. `TwoStepDemo`).
 *   • Model B — one manipulative whose spec carries internal stages/moves and
 *     carried state, graded only at a terminal condition (a game). No such
 *     kind exists any more: the Factor Game, the only one, is a game module
 *     now (`lib/games/contract.ts`). The frame still supports the shape.
 *
 * It owns exactly the chrome every multi-step challenge shares — nothing
 * board- or game-specific:
 *   • a header (concept eyebrow · prompt title · an "Extra credit ★" chip)
 *   • a step/stage progress indicator (either an open-ended "Move N" pill for
 *     a game, or fixed "Step X of Y" dots for a linear sequence)
 *   • a consistent commit → feedback → advance rhythm, via the `footer` slot
 *     (the caller supplies its own Check/Next/turn-status controls — those
 *     differ per model, the chrome around them does not)
 *   • one unmistakable "challenge complete" end state (with an optional
 *     "Play again")
 *
 * Visually it matches `Manipulative.tsx` exactly (same card, type scale,
 * button + chip styles, palette) so the two frames read as one family. Larger
 * tap targets throughout — this is scholar-facing on iPad.
 */
import { Box, Flex, Text } from "@chakra-ui/react";
import type { ReactNode } from "react";
import { C, wash } from "./colors";

/**
 * The SETTLED, stable progress API for `MultiStepChallenge` — every
 * multi-step challenge (present and future) reports its progress as one of
 * exactly these two shapes; do not add new `mode`s ad hoc, extend an existing
 * one instead (both are deliberately minimal — a label/value pair and a
 * current/total pair):
 *
 *   • `"count"` — open-ended, no fixed total (a game: Factor Game's "Move 7",
 *     a future Nim's "Turn 4", …). `label` is the noun ("Move", "Turn");
 *     `value` is whatever's counting up.
 *   • `"steps"` — a fixed-length, ordered sequence (any `MultiStepSequenceSpec`
 *     — Model A): step dots + "Step X of Y", `current` 1-based.
 */
export type ChallengeProgress =
  | { mode: "count"; label: string; value: number }
  | { mode: "steps"; current: number; total: number };

export interface MultiStepChallengeProps {
  concept: string;
  title: string;
  extraCredit?: boolean;
  source?: string;
  progress: ChallengeProgress;
  /** True once the challenge has reached its terminal/complete condition. */
  complete: boolean;
  /** Shown inside the "Challenge complete" banner, e.g. "You won, 19–11 ✓". */
  completeSummary?: ReactNode;
  /** "Play again" — only shown when `complete` and provided. */
  onReset?: () => void;
  /** The commit/advance controls for the CURRENT step (differs per model). */
  footer?: ReactNode;
  /** The inner renderer: a game board (Model B) or the active sub-item (Model A). */
  children: ReactNode;
  /** Stable hook for e2e tests / screenshot scripts to scope one card. */
  testId?: string;
}

function ProgressIndicator({ progress }: { progress: ChallengeProgress }) {
  if (progress.mode === "count") {
    return (
      <Box
        fontSize="13px"
        fontWeight="700"
        px="12px"
        py="5px"
        borderRadius="999px"
        style={{ background: "#e7fbfe", color: C.teal }}
      >
        {progress.label} {progress.value}
      </Box>
    );
  }
  const { current, total } = progress;
  return (
    <Flex align="center" gap={2}>
      <Flex gap="6px" align="center">
        {Array.from({ length: total }, (_, i) => (
          <Box
            key={i}
            w="12px"
            h="12px"
            borderRadius="999px"
            bg={i < current ? "brand.primary" : "bg.muted"}
            borderWidth={i < current ? 0 : "1px"}
            borderColor="border.default"
            transition="background .2s ease"
          />
        ))}
      </Flex>
      <Text fontSize="13px" fontWeight="700" color="fg.muted">
        Step {current} of {total}
      </Text>
    </Flex>
  );
}

export function MultiStepChallenge({
  concept,
  title,
  extraCredit,
  source,
  progress,
  complete,
  completeSummary,
  onReset,
  footer,
  children,
  testId,
}: MultiStepChallengeProps) {
  return (
    <Box
      data-testid={testId}
      borderWidth="1px"
      borderColor="border.default"
      borderRadius="18px"
      bg="white"
      p={{ base: 4, md: 5 }}
      boxShadow="0 6px 22px rgba(34,38,86,.06)"
      maxW="620px"
      w="100%"
    >
      <Flex justify="space-between" align="flex-start" gap={3} mb={1}>
        <Box minW={0}>
          <Text fontSize="11px" fontWeight="700" letterSpacing="0.08em" textTransform="uppercase" color="fg.muted">
            {concept}
          </Text>
          <Text fontSize={{ base: "17px", md: "19px" }} fontWeight="700" color="brand.primary" lineHeight="1.25">
            {title}
          </Text>
          {source && (
            <Text mt="2px" fontSize="12px" color="fg.subtle" fontWeight="600">
              Inspired by {source}
            </Text>
          )}
        </Box>
        {extraCredit && (
          <Box
            flexShrink={0}
            fontSize="11px"
            fontWeight="700"
            px="10px"
            py="4px"
            borderRadius="999px"
            style={{ background: wash(C.yellow, 0.5), color: C.navy }}
          >
            Extra credit ★
          </Box>
        )}
      </Flex>

      <Flex mt={2} mb={3} align="center" justify="space-between" gap={3} wrap="wrap">
        <ProgressIndicator progress={progress} />
      </Flex>

      <Box css={{ touchAction: "none", userSelect: "none" }}>{children}</Box>

      {complete ? (
        <Box
          mt={4}
          p="14px"
          borderRadius="14px"
          style={{ background: "rgba(0,221,145,.16)", color: "#00875a" }}
        >
          <Flex align="center" justify="space-between" gap={3} wrap="wrap">
            <Box>
              <Text fontSize="15px" fontWeight="800">
                Challenge complete! ✓
              </Text>
              {completeSummary && (
                <Text fontSize="13px" fontWeight="600" mt="2px">
                  {completeSummary}
                </Text>
              )}
            </Box>
            {onReset && (
              <Box
                as="button"
                onClick={onReset}
                fontSize="14px"
                fontWeight="700"
                color="white"
                bg="brand.primary"
                px="18px"
                py="10px"
                minH="44px"
                borderRadius="10px"
                _hover={{ bg: "navy.700" }}
                css={{ cursor: "pointer" }}
              >
                Play again
              </Box>
            )}
          </Flex>
        </Box>
      ) : (
        footer && (
          <Flex mt={4} align="center" justify="flex-end" gap={2} minH="44px" wrap="wrap">
            {footer}
          </Flex>
        )
      )}
    </Box>
  );
}
