"use client";

import { useLayoutEffect, useRef, type ReactNode } from "react";
import { Box, Button, HStack } from "@chakra-ui/react";
import { Eye } from "@phosphor-icons/react";
import { remainingViewportHeight } from "@/lib/viewportShell";

const VIEWPORT_SHELL_HEIGHT_VARIABLE = "--rh-viewport-shell-height";

/**
 * The full-width bar across the top of the app that says "you are seeing
 * this as someone else", with a one-click exit. One component for both
 * ways a staff member sees another person's Rabbithole:
 *
 * - `impersonate` (orange): a platform admin's View As overlay
 *   (ImpersonationBanner), the whole app resolving as another user.
 * - `preview` (violet): a teacher's preview of a family's parent portal
 *   (`/parent?remote=`), where the teacher stays signed in as themselves.
 *
 * The colors differ on purpose, so nobody mistakes a family preview for a
 * full impersonation. The bar is sticky above the page's own navigation and
 * shortens `VIEWPORT_SHELL_HEIGHT` by its own height, so full-height shells
 * still fit the screen.
 */
export function ViewingAsBar({
  tone,
  label,
  children,
  exitLabel,
  exiting = false,
  onExit,
}: {
  tone: "impersonate" | "preview";
  /** Accessible name for the region. */
  label: string;
  children: ReactNode;
  exitLabel: string;
  exiting?: boolean;
  onExit: () => void;
}) {
  const barRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const bar = barRef.current;
    if (!bar) return;

    const rootStyle = document.documentElement.style;
    const previous = rootStyle.getPropertyValue(VIEWPORT_SHELL_HEIGHT_VARIABLE);
    const measure = () => {
      rootStyle.setProperty(
        VIEWPORT_SHELL_HEIGHT_VARIABLE,
        remainingViewportHeight(bar.getBoundingClientRect().height),
      );
    };
    const observer = new ResizeObserver(measure);
    observer.observe(bar);
    measure();

    return () => {
      observer.disconnect();
      if (previous) {
        rootStyle.setProperty(VIEWPORT_SHELL_HEIGHT_VARIABLE, previous);
      } else {
        rootStyle.removeProperty(VIEWPORT_SHELL_HEIGHT_VARIABLE);
      }
    };
  }, []);

  const impersonate = tone === "impersonate";

  return (
    <Box
      ref={barRef}
      position="sticky"
      top={0}
      // Dialog portals sit above ordinary app chrome. This escape hatch must
      // remain the topmost app control, including over profile setup dialogs.
      zIndex={2147483647}
      bg={impersonate ? "orange.500" : "violet.600"}
      color={impersonate ? "navy.500" : "white"}
      px={4}
      py={2}
      boxShadow="md"
      role="region"
      aria-label={label}
      // Sit below the notch/status bar in the iPad shell.
      style={{ paddingTop: "max(0.5rem, env(safe-area-inset-top))" }}
    >
      <HStack maxW="5xl" mx="auto" gap={3} justify="center" flexWrap="wrap">
        <Eye size={15} />
        {children}
        <Button
          size="xs"
          bg={impersonate ? "navy.500" : "white"}
          color={impersonate ? "white" : "violet.700"}
          _hover={{ bg: impersonate ? "navy.600" : "violet.50" }}
          fontFamily="heading"
          fontSize="sm"
          fontWeight="700"
          onClick={onExit}
          loading={exiting}
          loadingText="Exiting…"
        >
          {exitLabel}
        </Button>
      </HStack>
    </Box>
  );
}
