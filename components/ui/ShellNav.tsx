"use client";

/**
 * ShellNav — the shared route navigation for the settings-style shells
 * (`/school/*`, `/admin/*`). One component, one vocabulary: every shell's
 * section list looks and behaves the same instead of each layout hand-rolling
 * its own strip.
 *
 * It renders REAL LINKS (`next/link`), never Ark `Tabs` and never
 * button + `router.push`. Tabs model in-page panel *selection*: the `tablist`
 * role tells assistive tech there are panels here, which is wrong for something
 * that changes the URL, and a button drops every link affordance. Anchors give
 * cmd/ctrl/middle-click → new tab, right-click → copy link, and the browser's
 * hover URL preview for free, and Next's `Link` still soft-navigates plain
 * left-clicks. Active state is derived from the URL, the way a nav should be.
 *
 * Two forms, chosen by width: a fixed left rail on desktop (all labels visible,
 * no truncation as shells grow past ~8 sections) and the shell's existing
 * single-line horizontal strip below that. Only one is in the accessibility
 * tree at a time — the other is `display: none`, which removes it entirely.
 *
 * Callers own item filtering (role gates, feature flags) and pass resolved
 * items plus the current `pathname`.
 */

import Link from "next/link";
import { useEffect, useRef, type ReactNode } from "react";
import { Box, HStack, Stack, Text } from "@chakra-ui/react";

export interface ShellNavItem {
  href: string;
  label: string;
  icon: ReactNode;
}

export interface ShellNavProps {
  items: ShellNavItem[];
  /** Current route, from `usePathname()`. */
  pathname: string;
  /** Accessible name for the `<nav>` landmark, e.g. "School sections". */
  ariaLabel: string;
}

/** Desktop rail width — fixed, per the "rails fixed, content splits resize" rule. */
const RAIL_WIDTH = { lg: "200px", xl: "220px" };

/** Comfortable touch target for both forms. */
const MIN_TARGET = "40px";

function isActive(pathname: string, href: string): boolean {
  const path = href.split(/[?#]/, 1)[0];
  return pathname === path || pathname.startsWith(path + "/");
}

function NavIcon({ icon }: { icon: ReactNode }) {
  return (
    <Box
      display="flex"
      alignItems="center"
      flexShrink={0}
      lineHeight="0"
    >
      {icon}
    </Box>
  );
}

export function ShellNav({ items, pathname, ariaLabel }: ShellNavProps) {
  const narrowNavRef = useRef<HTMLDivElement>(null);
  const narrowActiveRef = useRef<HTMLAnchorElement>(null);
  const activeHref = items.find((item) => isActive(pathname, item.href))?.href;

  useEffect(() => {
    const nav = narrowNavRef.current;
    const active = narrowActiveRef.current;
    if (!nav || !active || nav.clientWidth === 0) return;

    const itemStart = active.offsetLeft;
    const itemEnd = itemStart + active.offsetWidth;
    const visibleStart = nav.scrollLeft;
    const visibleEnd = visibleStart + nav.clientWidth;

    if (itemStart < visibleStart) {
      nav.scrollTo({ left: itemStart, behavior: "auto" });
    } else if (itemEnd > visibleEnd) {
      nav.scrollTo({ left: itemEnd - nav.clientWidth, behavior: "auto" });
    }
  }, [activeHref]);

  return (
    <>
      {/* Desktop: fixed left rail. Selected uses the app's established
          selection vocabulary (violet.50 tint + violet.700 label, borderless —
          same as SubNav / HierarchyRow), so "selected" reads identically
          everywhere. No accent stripe. */}
      <Stack
        as="nav"
        aria-label={ariaLabel}
        display={{ base: "none", lg: "flex" }}
        w={RAIL_WIDTH}
        flexShrink={0}
        gap={0.5}
        align="stretch"
      >
        {items.map((item) => {
          const active = isActive(pathname, item.href);
          return (
            <Link
              key={item.href}
              href={item.href}
              aria-current={active ? "page" : undefined}
              style={{ textDecoration: "none", display: "block" }}
            >
              <HStack
                gap={2}
                px={3}
                py={2}
                minH={MIN_TARGET}
                borderRadius="md"
                bg={active ? "violet.50" : "transparent"}
                color={active ? "violet.700" : "charcoal.400"}
                transition="background-color 0.12s, color 0.12s"
                _hover={active ? undefined : { bg: "gray.100", color: "navy.500" }}
              >
                <NavIcon icon={item.icon} />
                <Text
                  fontFamily="heading"
                  fontSize="sm"
                  fontWeight={active ? "600" : "500"}
                  lineHeight="1.3"
                >
                  {item.label}
                </Text>
              </HStack>
            </Link>
          );
        })}
      </Stack>

      {/* Narrow: the shells' existing horizontal strip — one line, scrollable
          rather than wrapping, with the violet underline active treatment.
          `minW={0}` + `overflowX="auto"` keep it the shrinkable region; the
          scrollbar stays visible so there's an affordance for the overflow. */}
      <HStack
        ref={narrowNavRef}
        as="nav"
        aria-label={ariaLabel}
        display={{ base: "flex", lg: "none" }}
        borderBottom="1px solid"
        borderColor="gray.200"
        gap={1}
        align="stretch"
        w="full"
        minW={0}
        overflowX="auto"
        position="relative"
      >
        {items.map((item) => {
          const active = isActive(pathname, item.href);
          return (
            <Link
              ref={active ? narrowActiveRef : undefined}
              key={item.href}
              href={item.href}
              aria-current={active ? "page" : undefined}
              // The anchor is the flex item here, so it — not just its inner
              // row — must refuse to shrink, or long labels wrap/compress.
              style={{ textDecoration: "none", display: "block", flexShrink: 0 }}
            >
              <HStack
                gap={2}
                px={4}
                py={2}
                minH={MIN_TARGET}
                flexShrink={0}
                whiteSpace="nowrap"
                color={active ? "violet.600" : "charcoal.400"}
                borderBottomWidth="2px"
                borderColor={active ? "violet.500" : "transparent"}
                transition="color 0.12s"
                _hover={{ color: active ? "violet.600" : "navy.500" }}
              >
                <NavIcon icon={item.icon} />
                <Text
                  fontFamily="heading"
                  fontSize="sm"
                  fontWeight={active ? "600" : "500"}
                  lineHeight="1.3"
                >
                  {item.label}
                </Text>
              </HStack>
            </Link>
          );
        })}
      </HStack>
    </>
  );
}
