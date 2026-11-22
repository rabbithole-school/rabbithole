"use client";

import { useEffect, useState } from "react";
import { useAction, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import {
  Box,
  Button,
  HStack,
  Popover,
  Portal,
  Text,
  Tooltip,
  VStack,
  chakra,
} from "@chakra-ui/react";
import { Fingerprint } from "@phosphor-icons/react";
import {
  runPasskeyRegistration,
  isPasskeyCancellation,
  browserSupportsWebAuthn,
  guessDeviceLabel,
  relatedOriginPasskeyFallbackUrl,
} from "@/lib/passkeyClient";
import { PasskeyRelatedOriginFallback } from "@/components/PasskeyRelatedOriginFallback";
import { toaster } from "@/lib/toaster";

// The pill's predecessor was a dismissible page card that stored a
// "dismissed" flag on the device. The pill ignores it on purpose (Andy,
// 2026-11-08): the card was dismissed because it was loud and on every page,
// and that "no" doesn't carry over to a quiet header pill.

const BENEFIT =
  "Sign in with Face ID or Touch ID next time, with no waiting for an email link.";

/**
 * The quiet "set up a passkey" nudge in the parent portal header, beside the
 * account menu: the post-login upgrade in the parent claim flow
 * (review/parent-account-claim-plan.html §3 auth ladder). Passkeys are
 * additive here (magic-link stays the everyday path); this makes the next
 * sign-in one tap. It shows only when the browser supports WebAuthn and the
 * signed-in user has no passkey yet, and disappears once one exists.
 *
 * Mounted only in the parent portal header; the caller keeps it out of a
 * staff preview and applicant-only mode. Staff are force-enrolled via
 * /setup-passkey and never reach a dashboard without one.
 *
 * Clicking starts enrollment straight away. A failure, or the related-origin
 * fallback link, opens a small popover anchored to the pill; success is a
 * toast.
 */
export function PasskeyPill() {
  const status = useQuery(api.passkeys.myStatus, {});
  const startEnroll = useAction(api.passkeys.startEnrollment);
  const finishEnroll = useAction(api.passkeys.finishEnrollment);

  // Hidden on first paint (SSR has no navigator/localStorage); the effect
  // reveals it only when WebAuthn is supported.
  const [eligible, setEligible] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [fallbackUrl, setFallbackUrl] = useState<string | null>(null);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- client-only capability check, deferred past SSR to avoid a hydration mismatch
    setEligible(browserSupportsWebAuthn());
  }, []);

  if (!eligible || !status || status.hasPasskey) return null;

  const popoverOpen = !!error || !!fallbackUrl;
  const closePopover = () => {
    setError("");
    setFallbackUrl(null);
  };

  const enroll = async () => {
    setBusy(true);
    closePopover();
    try {
      await runPasskeyRegistration({
        start: () => startEnroll({}),
        finish: (args) => finishEnroll(args),
        label: guessDeviceLabel(),
      });
      // myStatus.hasPasskey flips, so the pill unmounts; the toast outlives it.
      toaster.success({
        title: "Passkey added",
        description: "Next time, sign in with Face ID or Touch ID.",
      });
    } catch (err) {
      const url = relatedOriginPasskeyFallbackUrl(err, window.location);
      if (url) {
        setError("This browser can’t set up a passkey on rabbithole.school.");
        setFallbackUrl(url);
      } else if (!isPasskeyCancellation(err)) {
        console.error("Passkey enrollment failed:", err);
        setError("Couldn't set up the passkey. You can try again anytime.");
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <Popover.Root
      open={popoverOpen}
      onOpenChange={(details) => {
        if (!details.open) closePopover();
      }}
      positioning={{ placement: "bottom-end" }}
    >
      <Popover.Anchor asChild>
        <Box display="inline-flex" flexShrink={0}>
          <Tooltip.Root
            openDelay={200}
            closeDelay={0}
            disabled={popoverOpen || busy}
          >
            <Tooltip.Trigger asChild>
              <chakra.button
                type="button"
                aria-label="Set up a passkey"
                aria-busy={busy}
                onClick={() => void enroll()}
                disabled={busy}
                display="inline-flex"
                alignItems="center"
                gap={1.5}
                minH={7}
                px={{ base: 1.5, md: 2.5 }}
                borderRadius="full"
                borderWidth="1px"
                borderColor="gray.200"
                bg="white"
                color="violet.600"
                cursor={busy ? "progress" : "pointer"}
                transition="background 0.12s"
                _hover={{ bg: "violet.50", borderColor: "violet.200" }}
                _focusVisible={{
                  outline: "2px solid",
                  outlineColor: "violet.400",
                  outlineOffset: "1px",
                }}
              >
                <Fingerprint size={16} weight="duotone" />
                <Text
                  as="span"
                  display={{ base: "none", md: "inline" }}
                  fontFamily="heading"
                  fontWeight="500"
                  fontSize="xs"
                  whiteSpace="nowrap"
                >
                  {busy ? "Waiting…" : "Set up passkey"}
                </Text>
              </chakra.button>
            </Tooltip.Trigger>
            <Portal>
              <Tooltip.Positioner>
                <Tooltip.Content fontFamily="heading" fontSize="xs" maxW="240px">
                  {BENEFIT}
                </Tooltip.Content>
              </Tooltip.Positioner>
            </Portal>
          </Tooltip.Root>
        </Box>
      </Popover.Anchor>
      <Portal>
        <Popover.Positioner>
          <Popover.Content w="280px" shadow="lg" borderRadius="lg">
            <Popover.Body p={3}>
              <VStack align="stretch" gap={2}>
                <Text fontFamily="body" fontSize="sm" color="red.600" role="alert">
                  {error}
                </Text>
                {fallbackUrl ? (
                  <PasskeyRelatedOriginFallback href={fallbackUrl} />
                ) : (
                  <HStack justify="flex-end">
                    <Button
                      size="xs"
                      variant="ghost"
                      fontFamily="heading"
                      onClick={closePopover}
                    >
                      Close
                    </Button>
                    <Button
                      size="xs"
                      variant="outline"
                      fontFamily="heading"
                      color="violet.600"
                      borderColor="violet.300"
                      onClick={() => void enroll()}
                    >
                      Try again
                    </Button>
                  </HStack>
                )}
              </VStack>
            </Popover.Body>
          </Popover.Content>
        </Popover.Positioner>
      </Portal>
    </Popover.Root>
  );
}
