"use client";

/**
 * Pager — the one canonical "‹ X of Y ›" position pager: previous/next chevron
 * links flanking the current position in an ordered set you step through one
 * item at a time (a report composer's scholars, a Rounds roster). Both ends are
 * real `<a href>`s so cmd/middle-click opens a new tab and the browser owns the
 * nav; a missing end simply omits that chevron.
 *
 * Distinct from the app's segmented controls: {@link ./ViewToggle} flips a lens
 * over the SAME content, {@link ./PaneTabs} swaps WHICH pane — this walks a
 * SEQUENCE, with the position shown between the arrows.
 *
 * Extracted from the near-identical inline pagers in MeetingMode and
 * NarrativeComposer (T1: one canonical rendering per signal). Other prev/next
 * chevron sites can migrate here — see the PR that introduced it.
 */
import { Button, HStack, Text } from "@chakra-ui/react";
import { CaretLeft, CaretRight } from "@phosphor-icons/react";
import Link from "next/link";

/**
 * The "X of Y" position text for a zero-based `index` within `total` items, or
 * `null` when there is no valid position (nothing to show between the arrows).
 * Pure so the position logic is testable without a renderer.
 */
export function pagerLabel(index: number, total: number): string | null {
  if (!Number.isInteger(index) || index < 0 || total <= 0 || index >= total) {
    return null;
  }
  return `${index + 1} of ${total}`;
}

export function Pager({
  prevHref,
  nextHref,
  label,
  navLabel = "Pagination",
  prevLabel = "Previous",
  nextLabel = "Next",
}: {
  prevHref?: string | null;
  nextHref?: string | null;
  /** Position text shown between the chevrons, e.g. "3 of 12" (see pagerLabel). */
  label?: string | null;
  /** Accessible label for the nav group. */
  navLabel?: string;
  /** aria-label for the previous chevron. */
  prevLabel?: string;
  /** aria-label for the next chevron. */
  nextLabel?: string;
}) {
  // Nothing to page and no position to show → render nothing.
  if (!prevHref && !nextHref && !label) return null;
  return (
    <HStack as="nav" gap={2} aria-label={navLabel}>
      {prevHref ? (
        <Button asChild size="sm" variant="outline" fontFamily="heading">
          <Link href={prevHref} aria-label={prevLabel}>
            <CaretLeft />
          </Link>
        </Button>
      ) : null}
      {label ? (
        <Text
          minW="10ch"
          textAlign="center"
          fontSize="sm"
          fontFamily="heading"
          color="charcoal.500"
          whiteSpace="nowrap"
          aria-live="polite"
        >
          {label}
        </Text>
      ) : null}
      {nextHref ? (
        <Button asChild size="sm" variant="outline" fontFamily="heading">
          <Link href={nextHref} aria-label={nextLabel}>
            <CaretRight />
          </Link>
        </Button>
      ) : null}
    </HStack>
  );
}
