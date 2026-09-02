"use client";

import { useLayoutEffect, useRef, useState } from "react";
import {
  Box,
  Button,
  HStack,
  Popover,
  Portal,
  Spinner,
  Stack,
  Text,
} from "@chakra-ui/react";
import { CaretDown, Eye } from "@phosphor-icons/react";
import { useConvexAuth, useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { ScholarPickerContent } from "@/components/ScholarPicker";
import { remainingViewportHeight } from "@/lib/viewportShell";
import { toaster } from "@/lib/toaster";

const VIEWPORT_SHELL_HEIGHT_VARIABLE = "--rh-viewport-shell-height";

/**
 * App-wide "you are viewing as someone else" banner.
 *
 * The impersonation overlay is server-side and sticky by design (the server
 * must decide whose data a request may read — a client-declared identity would
 * be a privilege-escalation hole — and writes are blocked read-only + audited).
 * The trade-off is that a forgotten overlay leaves an admin silently seeing
 * another user's data. The only prior indicator was a small pill tucked inside
 * the AccountMenu dropdown, and only on pages that render it — easy to miss.
 *
 * This mounts once in Providers, so on EVERY page a live overlay shows a
 * high-contrast, sticky banner with a one-click Exit. `myImpersonation` is a
 * non-throwing query that returns null when not impersonating (or while
 * unauthenticated), so in the common case this renders nothing.
 */
export function ImpersonationBanner() {
  const { isAuthenticated } = useConvexAuth();
  const impersonation = useQuery(
    api.impersonation.myImpersonation,
    isAuthenticated ? {} : "skip",
  );
  const stopImpersonation = useMutation(api.impersonation.stopImpersonation);
  const switchImpersonation = useMutation(
    api.impersonation.switchImpersonationTarget,
  );
  const [exiting, setExiting] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [switchingTo, setSwitchingTo] = useState<string | null>(null);
  const [switchError, setSwitchError] = useState<string | null>(null);
  const bannerRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    if (!impersonation || !bannerRef.current) return;

    const rootStyle = document.documentElement.style;
    const previous = rootStyle.getPropertyValue(VIEWPORT_SHELL_HEIGHT_VARIABLE);
    const measure = () => {
      const height = bannerRef.current?.getBoundingClientRect().height;
      if (height != null) {
        rootStyle.setProperty(
          VIEWPORT_SHELL_HEIGHT_VARIABLE,
          remainingViewportHeight(height),
        );
      }
    };
    const observer = new ResizeObserver(measure);
    observer.observe(bannerRef.current);
    measure();

    return () => {
      observer.disconnect();
      if (previous) {
        rootStyle.setProperty(VIEWPORT_SHELL_HEIGHT_VARIABLE, previous);
      } else {
        rootStyle.removeProperty(VIEWPORT_SHELL_HEIGHT_VARIABLE);
      }
    };
  }, [impersonation]);

  if (!impersonation) return null;

  const handleExit = async () => {
    if (exiting) return;
    setExiting(true);
    try {
      await stopImpersonation({});
    } finally {
      // Full-document nav so every query re-resolves as the real admin.
      if (typeof window !== "undefined") {
        window.location.assign(new URL("/admin", window.location.origin).href);
      }
    }
  };

  const handleSwitch = async (targetUserId: string | null) => {
    if (
      !targetUserId ||
      targetUserId === String(impersonation.targetUserId) ||
      switchingTo
    ) {
      setPickerOpen(false);
      return;
    }

    setSwitchingTo(targetUserId);
    setSwitchError(null);
    try {
      await switchImpersonation({
        targetUserId: targetUserId as Id<"users">,
      });
      // Preserve path, query, and hash while every subscription re-resolves as
      // the newly selected scholar.
      window.location.reload();
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Please try again.";
      setSwitchError(message);
      toaster.error({
        title: "Couldn’t switch scholar",
        description: message,
      });
      setSwitchingTo(null);
    }
  };

  const hasScholarPicker = impersonation.switchableScholars.length > 0;

  return (
    <Box
      ref={bannerRef}
      position="sticky"
      top={0}
      // Dialog portals sit above ordinary app chrome. This escape hatch must
      // remain the topmost app control, including over profile setup dialogs.
      zIndex={2147483647}
      bg="orange.500"
      color="navy.500"
      px={4}
      py={2}
      boxShadow="md"
      role="region"
      aria-label="Viewing as another user"
      // Sit below the notch/status bar in the iPad shell.
      style={{ paddingTop: "max(0.5rem, env(safe-area-inset-top))" }}
    >
      <HStack maxW="5xl" mx="auto" gap={3} justify="center" flexWrap="wrap">
        <Eye size={15} />
        {hasScholarPicker ? (
          <>
            <Text fontFamily="heading" fontSize="sm" fontWeight="700">
              View as
            </Text>
            <Popover.Root
              open={pickerOpen}
              onOpenChange={(details) => {
                setPickerOpen(details.open);
                if (details.open) setSwitchError(null);
              }}
              positioning={{ placement: "bottom-start" }}
            >
              <Popover.Trigger asChild>
                <Button
                  size="xs"
                  bg="white"
                  color="navy.500"
                  maxW="14rem"
                  px={2.5}
                  fontFamily="heading"
                  fontSize="sm"
                  fontWeight="700"
                  _hover={{ bg: "orange.50" }}
                  aria-label={`Change who you are viewing as. Currently ${impersonation.targetName}`}
                  loading={switchingTo !== null}
                  loadingText="Switching…"
                >
                  <Text truncate>{impersonation.targetName}</Text>
                  <CaretDown size={13} weight="bold" />
                </Button>
              </Popover.Trigger>
              <Portal>
                <Popover.Positioner zIndex={2100}>
                  <Popover.Content
                    w={{ base: "calc(100vw - 2rem)", sm: "320px" }}
                    maxW="320px"
                    maxH="60vh"
                    borderRadius="lg"
                    shadow="lg"
                  >
                    <Popover.Body p={3}>
                      <Stack gap={2}>
                        <Text
                          fontFamily="heading"
                          fontSize="sm"
                          fontWeight="700"
                          color="navy.500"
                        >
                          Switch scholar
                        </Text>
                        <ScholarPickerContent
                          mode="single"
                          selected={String(impersonation.targetUserId)}
                          onChange={(scholarId) => {
                            void handleSwitch(scholarId);
                          }}
                          scholars={impersonation.switchableScholars}
                          showGroups={false}
                          showAffinityToggle={false}
                          autoFocusSearch
                          resetKey={pickerOpen ? 1 : 0}
                          sort="alpha"
                          maxH="220px"
                          emptyHint="No other scholars."
                          disabled={switchingTo !== null}
                        />
                        {switchingTo && (
                          <HStack gap={2} color="fg.muted">
                            <Spinner size="xs" />
                            <Text fontSize="sm">Switching scholar…</Text>
                          </HStack>
                        )}
                        {switchError && (
                          <Text fontSize="sm" color="red.600">
                            {switchError}
                          </Text>
                        )}
                      </Stack>
                    </Popover.Body>
                  </Popover.Content>
                </Popover.Positioner>
              </Portal>
            </Popover.Root>
          </>
        ) : (
          <Text as="span" fontFamily="heading" fontWeight="700" fontSize="sm">
            Viewing as {impersonation.targetName}
          </Text>
        )}
        <Text as="span" fontFamily="heading" fontWeight="700" fontSize="sm">
          · read-only
        </Text>
        <Text
          as="span"
          display={{ base: "none", lg: "inline" }}
          fontSize="sm"
          opacity={0.8}
        >
          signed in as {impersonation.adminName}
        </Text>
        <Button
          size="xs"
          bg="navy.500"
          color="white"
          _hover={{ bg: "navy.600" }}
          fontFamily="heading"
          fontSize="sm"
          fontWeight="700"
          onClick={() => {
            void handleExit();
          }}
          loading={exiting}
          loadingText="Exiting…"
        >
          Exit view-as
        </Button>
      </HStack>
    </Box>
  );
}
