"use client";

/**
 * ActivityCard — the ONE card for "here's a thing to do, here's who it's
 * for, and here's how it ladders up to something bigger." It backs every
 * activity / quest / unit / session row across the scholar home and the
 * teacher dashboard. See the activity-card design audit
 * (card-design-system.html).
 *
 * Built on <Surface>, so the border is ALWAYS the neutral gray hairline —
 * origin/relationship is signalled by the SLOTS (glyph · kicker ·
 * attribution · status · CTA verb), never by a colour-coded border.
 *
 * Two densities:
 *   - "detailed" — recommendations & drawers: big glyph, all slots.
 *   - "compact"  — lanes & list rows: smaller glyph, tighter.
 *
 * A whole-card `href`/`onClick` renders a STRETCHED overlay link/button so
 * trailing action buttons (archive, etc.) stay valid and clickable — no
 * `<button>` inside `<a>` (fixes the plate-card button-in-anchor bug).
 *
 * Layout: [glyph] [content stack — children] [trailing]. Compose the
 * content with <ActivityCardTitle>, <ActivityCardMeta>, <SectionEyebrow>
 * (kicker), <Avatar>/<ScholarFacepile> (attribution).
 */

import NextLink from "next/link";
import {
  Box,
  Flex,
  Stack,
  Text,
  Spinner,
  Link as ChakraLink,
  chakra,
  type BoxProps,
  type TextProps,
} from "@chakra-ui/react";
import { CaretRight } from "@phosphor-icons/react";
import { Surface } from "@/components/ui/Surface";
import { haptic } from "@/lib/native";

type Density = "detailed" | "compact";

const DENSITY: Record<Density, { glyph: string; title: TextProps["fontSize"]; gap: number }> = {
  detailed: { glyph: "28px", title: "md", gap: 3 },
  compact: { glyph: "lg", title: "sm", gap: 3 },
};

export interface ActivityCardProps extends Omit<BoxProps, "title" | "onClick"> {
  /** Leading visual — an emoji string or an icon node. */
  glyph?: React.ReactNode;
  /** Right-hand column — RAISED interactive controls (e.g. an archive
   *  button) that must stay clickable ABOVE the stretched card link. */
  trailing?: React.ReactNode;
  /** A subtle, NON-interactive call-to-action affordance (e.g. <ActivityCardCta>
   *  Start</ActivityCardCta>). It sits UNDER the stretched overlay, so the whole
   *  card is the tap target (iPad-friendly) — the label just hints the action. */
  cta?: React.ReactNode;
  /** A raised secondary action placed immediately after the CTA. */
  secondaryAction?: React.ReactNode;
  /** Makes the whole card a link (stretched overlay). */
  href?: string;
  /** Makes the whole card a button (stretched overlay). Ignored if `href`
   *  is set. */
  onClick?: () => void;
  /** Accessible label for the stretched link/button (usually the title). */
  ariaLabel?: string;
  /** "detailed" (default) or "compact". */
  density?: Density;
  /** Hover lift. Defaults to true when the card is clickable. */
  interactive?: boolean;
  children: React.ReactNode;
}

export function ActivityCard({
  glyph,
  trailing,
  cta,
  secondaryAction,
  href,
  onClick,
  ariaLabel,
  density = "detailed",
  interactive,
  children,
  ...rest
}: ActivityCardProps) {
  const d = DENSITY[density];
  const clickable = !!(href || onClick);
  const lift = interactive ?? clickable;

  return (
    <Surface
      role="group"
      position="relative"
      px={4}
      py={3}
      transition="all 0.12s"
      contentVisibility="auto"
      containIntrinsicSize={density === "detailed" ? "160px" : "96px"}
      _hover={lift ? { shadow: "sm", borderColor: "gray.300" } : undefined}
      {...rest}
    >
      <Flex align="flex-start" gap={d.gap}>
        {glyph != null && glyph !== false && (
          <Box
            fontSize={d.glyph}
            lineHeight="1"
            flexShrink={0}
            mt={density === "detailed" ? 0.5 : 0}
          >
            {glyph}
          </Box>
        )}
        <Stack gap={1} flex={1} minW={0}>
          {children}
        </Stack>
        {((trailing != null && trailing !== false) ||
          (cta != null && cta !== false) ||
          (secondaryAction != null && secondaryAction !== false)) && (
          <Flex flexShrink={0} alignSelf="center" align="center" gap={1.5}>
            {trailing != null && trailing !== false && (
              // Raised so its buttons stay clickable above the overlay.
              <Box position="relative" zIndex={1}>{trailing}</Box>
            )}
            {cta != null && cta !== false && <Box flexShrink={0}>{cta}</Box>}
            {secondaryAction != null && secondaryAction !== false && (
              <Box position="relative" zIndex={1} flexShrink={0}>
                {secondaryAction}
              </Box>
            )}
          </Flex>
        )}
      </Flex>

      {/* Stretched-overlay interaction — keeps trailing buttons valid. */}
      {href && (
        <ChakraLink
          asChild
          position="absolute"
          inset={0}
          borderRadius="lg"
          aria-label={ariaLabel}
          _focusVisible={{
            outline: "2px solid",
            outlineColor: "violet.400",
            outlineOffset: "2px",
          }}
        >
          <NextLink href={href} onPointerDown={() => haptic("light")} />
        </ChakraLink>
      )}
      {onClick && !href && (
        <chakra.button
          type="button"
          position="absolute"
          inset={0}
          borderRadius="lg"
          cursor="pointer"
          aria-label={ariaLabel}
          onPointerDown={() => haptic("light")}
          onClick={onClick}
          _focusVisible={{
            outline: "2px solid",
            outlineColor: "violet.400",
            outlineOffset: "2px",
          }}
        />
      )}
    </Surface>
  );
}

/** The canonical card title — heading/600/navy, sized by density. Truncates
 *  to one line by default; pass `clamp` to wrap to two. */
export function ActivityCardTitle({
  children,
  density = "detailed",
  clamp = false,
  ...rest
}: {
  children: React.ReactNode;
  density?: Density;
  clamp?: boolean;
} & Omit<TextProps, "children">) {
  return (
    <Text
      fontFamily="heading"
      fontWeight="600"
      color="navy.500"
      fontSize={DENSITY[density].title}
      lineHeight="1.3"
      {...(clamp
        ? { lineClamp: 2 }
        : { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" })}
      {...rest}
    >
      {children}
    </Text>
  );
}

/** The canonical muted meta/status line (counts, time-ago, "stalled"). Pass
 *  `tone` to colour it (e.g. "orange.600" for an attention signal). */
export function ActivityCardMeta({
  children,
  tone,
  ...rest
}: {
  children: React.ReactNode;
  tone?: string;
} & Omit<TextProps, "children">) {
  return (
    <Text fontSize="xs" color={tone ?? "charcoal.400"} fontFamily="heading" userSelect="none" {...rest}>
      {children}
    </Text>
  );
}

/**
 * ActivityCardCta — the subtle, consistent action affordance for a card
 * ("Start" / "Continue" / "Join"). It is intentionally NOT a separate click
 * target: it sits under the card's stretched overlay so the WHOLE card is the
 * tap target (iPad-friendly), and the label just signals what tapping does.
 * Pass `loading` to swap in a spinner while the action runs.
 */
export function ActivityCardCta({
  children,
  loading = false,
  showCaret = true,
}: {
  children: React.ReactNode;
  loading?: boolean;
  showCaret?: boolean;
}) {
  return (
    <Box
      as="span"
      display="inline-flex"
      alignItems="center"
      gap={0.5}
      flexShrink={0}
      fontFamily="heading"
      fontWeight="600"
      fontSize="xs"
      color="violet.600"
      px={2.5}
      py={1.5}
      borderRadius="md"
      whiteSpace="nowrap"
      userSelect="none"
      transition="background 0.12s"
      _groupHover={{ bg: "violet.50" }}
    >
      {loading ? (
        <Spinner size="xs" />
      ) : (
        <>
          {children}
          {showCaret && <CaretRight size={12} weight="bold" />}
        </>
      )}
    </Box>
  );
}
