"use client";

/**
 * SectionEyebrow — the smallcaps label that sits above a section
 * header. One canonical shape replaces the five inline variants that
 * used to drift across tabs (see review/visual-harmonization.md §B2).
 *
 *   <SectionEyebrow>Pinned</SectionEyebrow>
 *   <SectionEyebrow count={3}>Activities</SectionEyebrow>
 *   <SectionEyebrow accent="violet">Active class assignment</SectionEyebrow>
 *
 * Shape: fontSize="2xs" fontWeight="700" letterSpacing="0.05em"
 *        textTransform="uppercase" fontFamily="heading".
 *
 * Pass extra Chakra props (px, pt, etc.) via `boxProps`.
 */
import { HStack, Text, type TextProps } from "@chakra-ui/react";

export interface SectionEyebrowProps {
  children: React.ReactNode;
  /** Optional count rendered to the right of the label (small,
   *  slightly muted). */
  count?: number;
  /** Color variant. `default` = charcoal.400 (muted),
   *  `violet` = violet.600 (accent — used for "active" eyebrows). */
  accent?: "default" | "violet";
  /** Forwarded to the outer Text so callers can adjust padding etc. */
  boxProps?: Omit<TextProps, "children">;
}

export function SectionEyebrow({
  children,
  count,
  accent = "default",
  boxProps,
}: SectionEyebrowProps) {
  const color = accent === "violet" ? "violet.600" : "charcoal.400";

  const label = (
    <Text
      fontFamily="heading"
      fontSize="2xs"
      fontWeight="700"
      color={color}
      textTransform="uppercase"
      letterSpacing="0.05em"
      userSelect="none"
      {...boxProps}
    >
      {children}
    </Text>
  );

  if (count === undefined) return label;

  return (
    <HStack gap={2} align="baseline" userSelect="none">
      {label}
      <Text
        fontFamily="heading"
        fontSize="2xs"
        fontWeight="600"
        color="charcoal.300"
      >
        {count}
      </Text>
    </HStack>
  );
}
