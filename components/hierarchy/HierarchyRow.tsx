"use client";

/**
 * Unified row component for every place we represent the unit / lesson
 * / activity hierarchy. Same typography, same selected/hover treatment,
 * same metadata layout — what changes between surfaces is the trailing
 * indicator (chevron / triangle / check / status pip) and what the
 * click does. Modeled on Finder's row primitive being the same across
 * column / list / icon / gallery views.
 *
 * Used in:
 *   • HierarchyColumn (StartAssignmentDialog, Curriculum browser, UnitPicker)
 *   • HierarchyOutline (design screen left pane)
 *   • Eventually: BigPictureContent activity rows (Big Picture)
 */
import React from "react";
import NextLink from "next/link";
import { Box, Flex, Stack, Text } from "@chakra-ui/react";
import {
  CaretRight,
  CaretDown,
  Check,
  Plus,
} from "@phosphor-icons/react";

export type HierarchyRowTrailing =
  | { kind: "none" }
  | { kind: "chevron" }
  | {
      kind: "triangle";
      expanded: boolean;
      onToggle?: () => void;
    }
  | { kind: "check" }
  | { kind: "status"; icon: React.ReactNode };

export type HierarchyRowVariant = "default" | "pseudo" | "create" | "empty";

export interface HierarchyRowProps {
  /** Leading content — usually a single emoji string (`"🌉"`) or a
   *  React node (icon). Renders in a fixed slot so titles align across
   *  rows whether or not they have a leading element. */
  leading?: React.ReactNode;
  label: string;
  sublabel?: React.ReactNode;
  selected?: boolean;
  onClick?: () => void;
  /** When set, the row renders as a real link (cmd/ctrl-click opens in a
   *  new tab, URL shows on hover). `onClick` still fires on plain clicks
   *  for same-tab selection; modified clicks fall through to the browser. */
  href?: string;
  trailing?: HierarchyRowTrailing;
  /** `default` = standard row. `pseudo` = italic / muted (used for
   *  "Whole unit · no lesson lock" affordances). `create` = "➕ New X"
   *  affordance with dashed/violet styling. `empty` = "(no lessons yet)"
   *  muted italic non-clickable placeholder. */
  variant?: HierarchyRowVariant;
  /** Outline view nesting — 0=top-level, 1=lesson, 2=activity. Each
   *  level adds 12px of left indentation. */
  indent?: number;
  /** Optional small chip rendered between the label and the trailing
   *  indicator. Used for "🏠 Homework" / future flags. */
  accentBadge?: React.ReactNode;
  disabled?: boolean;
  /** Optional data-testid for Playwright hooks. */
  testId?: string;
}

export function HierarchyRow({
  leading,
  label,
  sublabel,
  selected = false,
  onClick,
  href,
  trailing = { kind: "none" },
  variant = "default",
  indent = 0,
  accentBadge,
  disabled = false,
  testId,
}: HierarchyRowProps) {
  const isPseudo = variant === "pseudo";
  const isCreate = variant === "create";
  const isEmpty = variant === "empty";

  // Colors — kept consistent across surfaces so a unit row looks the
  // same in Curriculum > Units, StartAssignmentDialog, and the
  // design screen outline. Selection is borderless (June 2026): a
  // violet.50 tint + a violet.700 label, matching `selectedListRowProps`
  // and the outline's NodeRow so every list reads identically.
  const bg = selected ? "violet.50" : "transparent";
  const borderColor = "transparent";
  const borderStyle = "solid";
  const labelColor = isEmpty
    ? "charcoal.300"
    : isPseudo
      ? "charcoal.500"
      : isCreate
        ? "charcoal.400"
        : selected
          ? "violet.700"
          : "navy.500";
  const labelStyle = isPseudo || isEmpty ? "italic" : "normal";
  // Bold is reserved for the selected row; everything else is medium weight,
  // so a long list isn't a wall of bold.
  const labelWeight = isEmpty ? "400" : selected ? "600" : "500";

  // With an href the row is wrapped in a NextLink (the anchor is the
  // interactive element), so the Flex must not also be a <button> —
  // nested interactive elements are invalid. Plain clicks preventDefault
  // and fall through to onClick for same-tab selection; modified clicks
  // let the browser open a new tab via the href.
  const handleClick =
    disabled || !onClick
      ? undefined
      : (e: React.MouseEvent) => {
          if (
            href &&
            (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0)
          ) {
            return;
          }
          if (href) e.preventDefault();
          onClick();
        };

  // A row is interactive if it navigates (href) or selects (onClick) —
  // either way it should read as clickable (pointer + hover + press
  // feedback). Previously only onClick rows did, so the href-only Curriculum
  // unit rows looked inert.
  const interactive = (!!onClick || !!href) && !disabled && !isEmpty;

  const row = (
    <Flex
      as={onClick && !disabled && !href ? "button" : "div"}
      onClick={handleClick}
      align="center"
      gap={2}
      p={2}
      pl={2 + indent * 3}
      borderRadius="md"
      bg={bg}
      borderWidth="1px"
      borderColor={borderColor}
      borderStyle={borderStyle}
      cursor={interactive ? "pointer" : "default"}
      opacity={disabled ? 0.5 : 1}
      transition="all 0.12s"
      _hover={
        interactive
          ? { bg: selected ? "violet.100" : "gray.100" }
          : undefined
      }
      _active={
        interactive
          ? { bg: selected ? "violet.200" : "gray.200" }
          : undefined
      }
      textAlign="left"
      w="full"
      userSelect="none"
      data-testid={testId}
      role={onClick && !href ? "button" : undefined}
      aria-pressed={onClick && !href ? selected : undefined}
      aria-current={href && selected ? "page" : undefined}
    >
      {/* Leading slot — emoji or icon. Fixed 20px width so labels
          align across rows whether or not they have a leading element.
          For create rows, the + icon also lives in this 20px slot so
          "+ New unit" / "+ New lesson" / "+ New activity" all align
          their title text with the emoji'd unit rows. */}
      <Box
        flexShrink={0}
        minW="20px"
        display="flex"
        alignItems="center"
        justifyContent="center"
        color={isCreate ? "charcoal.400" : "charcoal.500"}
      >
        {isCreate ? (
          <Plus size={14} />
        ) : leading ? (
          typeof leading === "string" ? (
            <Text fontSize="md" lineHeight="1">
              {leading}
            </Text>
          ) : (
            leading
          )
        ) : null}
      </Box>

      <Stack gap={0} flex={1} minW={0}>
        <Text
          fontFamily="heading"
          fontWeight={labelWeight}
          color={labelColor}
          fontSize="sm"
          fontStyle={labelStyle}
          lineHeight="1.2"
          overflow="hidden"
          textOverflow="ellipsis"
          whiteSpace="nowrap"
        >
          {label}
        </Text>
        {sublabel != null &&
          (typeof sublabel === "string" ? (
            <Text
              fontSize="2xs"
              color="charcoal.400"
              fontFamily="body"
              lineHeight="1.2"
              overflow="hidden"
              textOverflow="ellipsis"
              whiteSpace="nowrap"
            >
              {sublabel}
            </Text>
          ) : (
            sublabel
          ))}
      </Stack>

      {accentBadge && <Box flexShrink={0}>{accentBadge}</Box>}

      {/* Trailing indicator — what makes the row read as drillable /
          expandable / selected / status-tagged. */}
      <Trailing trailing={trailing} />
    </Flex>
  );

  if (href && !disabled) {
    return (
      <NextLink
        href={href}
        style={{ display: "block", textDecoration: "none", color: "inherit" }}
      >
        {row}
      </NextLink>
    );
  }
  return row;
}

function Trailing({
  trailing,
}: {
  trailing: HierarchyRowTrailing;
}) {
  // (Previously we swapped chevron → check on selected rows. Dropped
  // — selection state is already obvious from the violet pill, and
  // the check-instead-of-chevron created a "this row no longer
  // drills" reading that's misleading: clicking a selected row still
  // toggles / re-confirms selection.)
  switch (trailing.kind) {
    case "chevron":
      return (
        <Box color="charcoal.300" flexShrink={0}>
          <CaretRight size={14} />
        </Box>
      );
    case "triangle":
      return (
        <Box
          as={trailing.onToggle ? "button" : "div"}
          onClick={
            trailing.onToggle
              ? (e: React.MouseEvent) => {
                  // Stop click bubbling so the parent row's onClick
                  // doesn't fire when the user just wants to expand.
                  e.stopPropagation();
                  trailing.onToggle?.();
                }
              : undefined
          }
          flexShrink={0}
          color="charcoal.400"
          cursor={trailing.onToggle ? "pointer" : "default"}
          _hover={trailing.onToggle ? { color: "violet.500" } : undefined}
          p={0.5}
          mx={-0.5}
          borderRadius="sm"
          lineHeight="0"
        >
          {trailing.expanded ? (
            <CaretDown size={14} />
          ) : (
            <CaretRight size={14} />
          )}
        </Box>
      );
    case "check":
      return (
        <Box color="violet.500" flexShrink={0}>
          <Check size={14} />
        </Box>
      );
    case "status":
      return <Box flexShrink={0}>{trailing.icon}</Box>;
    case "none":
    default:
      return null;
  }
}
