"use client";

/**
 * EmptyState — the one canonical empty-state primitive for teacher surfaces.
 *
 * The rule (Andy, 2026-07): an empty state may freely INCLUDE or OMIT any of
 * its five elements — icon, dashed outline, title, hint, CTA — but there must
 * be ONE AND ONLY ONE visual treatment for each. This component owns those
 * treatments so surfaces stop re-deriving them by hand and drifting apart
 * (heading vs body font, italic vs upright, violet vs charcoal, sm here / md
 * there, solid card vs dashed chip). Same spirit as {@link ./SubNav} and
 * {@link ./PaneTabs}: codify the recipe once, use it everywhere.
 *
 * The single treatment per element:
 *   - icon   — color charcoal.200, sized by `size` (the caller passes the bare
 *              Phosphor icon; this wraps it in a Box that owns the size).
 *   - title  — fontFamily heading, fontWeight 600, color charcoal.400,
 *              fontSize sm (md) / md (lg). ALWAYS this — even inside the dashed
 *              outline. The outline is a *container* treatment only; text
 *              inside uses the same canonical title/hint as everywhere else.
 *   - hint   — fontFamily body, color charcoal.300, fontSize xs (md) / sm (lg),
 *              maxW 420px, centered.
 *   - cta    — Button size sm, fontFamily heading. default = variant outline,
 *              borderColor gray.200, color charcoal.600; primary = the violet
 *              solid (colorPalette violet) used by Reports' "Set up a
 *              reporting period".
 *   - outline — a 1px dashed gray.200 chip (borderRadius md, px 3, py 2.5).
 *              CONTAINER treatment only; when only a title is present it lays
 *              out as a single left-aligned row (matches the agenda chip).
 *
 * Sizes: `md` = in-card / inline empties (py 6, icon 28px, title sm); `lg` =
 * full-surface empties (py 10, icon 52px, title md).
 *
 *   <EmptyState
 *     icon={<ChatCircle weight="duotone" />}
 *     title="No conversations yet"
 *     hint="Start one with a family."
 *     cta={{ label: "New message", icon: <Plus size={14} />, onClick: openCompose }}
 *   />
 */
import { Box, Button, Text, VStack } from "@chakra-ui/react";

export interface EmptyStateCta {
  label: string;
  /** Optional leading icon node (e.g. <Plus size={14} />). */
  icon?: React.ReactNode;
  onClick: () => void;
  /** true → the violet solid (Reports recipe); default → outline. */
  primary?: boolean;
}

export interface EmptyStateProps {
  /** The one required element. */
  title: string;
  /** A bare Phosphor icon; this component owns its color + size. */
  icon?: React.ReactNode;
  /** One supporting sentence. */
  hint?: string;
  /** A single call-to-action button. */
  cta?: EmptyStateCta;
  /** Wrap in the canonical dashed chip (container treatment only). */
  outline?: boolean;
  /** md = inline/in-card (default); lg = full-surface. */
  size?: "md" | "lg";
}

export function EmptyState({
  title,
  icon,
  hint,
  cta,
  outline = false,
  size = "md",
}: EmptyStateProps) {
  const lg = size === "lg";

  const iconNode = icon ? (
    <Box color="charcoal.200" fontSize={lg ? "52px" : "28px"} lineHeight="0">
      {icon}
    </Box>
  ) : null;

  const titleNode = (
    <Text
      fontFamily="heading"
      fontWeight="600"
      color="charcoal.400"
      fontSize={lg ? "md" : "sm"}
    >
      {title}
    </Text>
  );

  const hintNode = hint ? (
    <Text
      fontFamily="body"
      fontSize={lg ? "sm" : "xs"}
      color="charcoal.300"
      maxW="420px"
      textAlign="center"
    >
      {hint}
    </Text>
  ) : null;

  const ctaNode = cta ? (
    <Button
      size="sm"
      fontFamily="heading"
      onClick={cta.onClick}
      {...(cta.primary
        ? { colorPalette: "violet" }
        : { variant: "outline", borderColor: "gray.200", color: "charcoal.600" })}
    >
      {cta.icon}
      {cta.label}
    </Button>
  ) : null;

  // Dashed outline: a container treatment only. A bare title collapses to a
  // single left-aligned row (the agenda chip); anything richer stacks inside.
  if (outline) {
    const bare = !iconNode && !hintNode && !ctaNode;
    return (
      <Box
        borderWidth="1px"
        borderStyle="dashed"
        borderColor="gray.200"
        borderRadius="md"
        px={3}
        py={2.5}
        userSelect="none"
      >
        {bare ? (
          titleNode
        ) : (
          <VStack gap={lg ? 3 : 1} align="center" textAlign="center">
            {iconNode}
            {titleNode}
            {hintNode}
            {ctaNode}
          </VStack>
        )}
      </Box>
    );
  }

  return (
    <VStack gap={lg ? 3 : 1} py={lg ? 10 : 6} align="center" textAlign="center" userSelect="none">
      {iconNode}
      {titleNode}
      {hintNode}
      {ctaNode}
    </VStack>
  );
}
