"use client";

/** Shared +/- stepper used by manipulatives that adjust an integer count. */
import { Box, Flex, Text } from "@chakra-ui/react";

export function Stepper({
  value,
  min,
  max,
  onChange,
  label,
  compact = false,
}: {
  value: number;
  min: number;
  max: number;
  onChange: (v: number) => void;
  label: string;
  /**
   * Drops the "{value} {label}" readout and lets the two buttons share the
   * caller's width. For a stepper that sits under a column which ALREADY shows
   * both the noun (the place header) and the count (the big digit) — place
   * value's per-place columns — the readout is a third rendering of the same
   * two facts, and its 92px minimum is what pushed a three-place chart past
   * every container it renders in. The buttons keep the word in their
   * `aria-label`, so nothing is lost to a screen reader.
   */
  compact?: boolean;
}) {
  const btn = (delta: number, disabled: boolean, sym: string) => (
    <Box
      as="button"
      onClick={() => !disabled && onChange(value + delta)}
      w={compact ? "auto" : "36px"}
      flex={compact ? "1 1 0" : undefined}
      minW={compact ? "24px" : undefined}
      maxW={compact ? "44px" : undefined}
      h={compact ? "40px" : "36px"}
      borderRadius="10px"
      borderWidth="1px"
      borderColor="border.default"
      fontSize="20px"
      fontWeight="700"
      lineHeight="1"
      color={disabled ? "fg.subtle" : "brand.primary"}
      bg="white"
      _hover={disabled ? {} : { bg: "bg.muted" }}
      css={{ cursor: disabled ? "default" : "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}
      aria-label={`${sym === "−" ? "fewer" : "more"} ${label}`}
    >
      {sym}
    </Box>
  );
  return (
    <Flex align="center" justify="center" gap={compact ? "6px" : 2} w={compact ? "100%" : undefined}>
      {btn(-1, value <= min, "−")}
      {!compact && (
        <Text minW="92px" textAlign="center" fontSize="13px" color="fg.muted" fontWeight="600">
          {value} {label}
        </Text>
      )}
      {btn(1, value >= max, "+")}
    </Flex>
  );
}
