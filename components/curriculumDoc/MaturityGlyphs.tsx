"use client";

/**
 * Shared status glyphs for the two maturity signals (PR #1072 §8). Readiness
 * (green) and Sessions (violet) are different measurements, but a satisfied
 * rung, a live rung, and an unreached rung should read as the SAME KIND of mark
 * in each — just recoloured. Keeping the glyphs here (instead of a violet dot on
 * one side and a green circle-check on the other) is what makes the two panels
 * feel like one system. The plain filled dot is deliberately NOT here: it means
 * "one datapoint" in the Sessions distribution, so status rungs use these
 * circle/ring/check forms to stay out of the scatter's vocabulary.
 */
import { Box, Flex } from "@chakra-ui/react";
import { Check } from "@phosphor-icons/react";

/** A filled disc with a white check — the shared "this rung is satisfied" mark.
 *  Green in the Readiness gate, violet in the Sessions record. */
export function CircleCheck({
  color,
  size = 14,
  check,
}: {
  color: string;
  size?: number;
  check?: number;
}) {
  return (
    <Flex
      w={`${size}px`}
      h={`${size}px`}
      borderRadius="full"
      bg={color}
      align="center"
      justify="center"
      color="white"
      flexShrink={0}
    >
      <Check size={check ?? Math.round(size * 0.64)} weight="bold" />
    </Flex>
  );
}

/** A hollow status ring — a rung not yet reached (solid) or deliberately
 *  skipped (dashed). The empty-state twin of {@link CircleCheck}. */
export function HollowDot({
  color = "#d0d4d9",
  size = 14,
  dashed = false,
}: {
  color?: string;
  size?: number;
  dashed?: boolean;
}) {
  return (
    <Box
      w={`${size}px`}
      h={`${size}px`}
      borderRadius="full"
      borderWidth="2px"
      borderStyle={dashed ? "dashed" : "solid"}
      borderColor={color}
      bg="white"
      flexShrink={0}
    />
  );
}

/** A ring with a small filled core — the app's existing "in progress /
 *  currently here" mark (the scholar plate's ActivityStatusDot "here" state,
 *  and kin to the schedule's static "Live" pip). Deliberately STATIC: it says
 *  "running now" without a spinner's "any second now" urgency, which is the
 *  right register for a session that may take scholars minutes, hours, or days
 *  to finish. The middle rung between {@link HollowDot} and {@link CircleCheck}. */
export function InProgressDot({
  color,
  size = 14,
}: {
  color: string;
  size?: number;
}) {
  const core = Math.max(4, Math.round(size * 0.36));
  return (
    <Flex
      w={`${size}px`}
      h={`${size}px`}
      borderRadius="full"
      borderWidth="2px"
      borderColor={color}
      align="center"
      justify="center"
      flexShrink={0}
    >
      <Box w={`${core}px`} h={`${core}px`} borderRadius="full" bg={color} />
    </Flex>
  );
}
