"use client";

import { useEffect, useState } from "react";
import { useAction, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Box, Button, HStack, Text, VStack } from "@chakra-ui/react";
import { Fingerprint, X } from "@phosphor-icons/react";
import {
  runPasskeyRegistration,
  isPasskeyCancellation,
  browserSupportsWebAuthn,
  guessDeviceLabel,
  relatedOriginPasskeyFallbackUrl,
} from "@/lib/passkeyClient";
import { PasskeyRelatedOriginFallback } from "@/components/PasskeyRelatedOriginFallback";

const DISMISS_KEY = "rh_passkey_upsell_dismissed";

/**
 * A quiet, dismissible "set up a passkey" nudge for a signed-in user who
 * doesn't have one yet — the post-login upgrade in the parent claim flow
 * (review/parent-account-claim-plan.html §3 auth ladder). Passkeys are
 * ADDITIVE here: magic-link stays the everyday path, this just makes the next
 * sign-in one tap (Face ID / Touch ID). Never blocking, never nags (dismissal
 * persists per-device), and self-hides once a passkey exists.
 *
 * Generic by design (gated on `passkeys.myStatus.hasPasskey`, which works for
 * any role) but only mounted in the parent portal today — staff are
 * force-enrolled via /setup-passkey and never reach a dashboard without one.
 */
export function PasskeyUpsell() {
  const status = useQuery(api.passkeys.myStatus, {});
  const startEnroll = useAction(api.passkeys.startEnrollment);
  const finishEnroll = useAction(api.passkeys.finishEnrollment);

  // Hidden on first paint (SSR has no navigator/localStorage); the effect
  // reveals it only when WebAuthn is supported and it wasn't dismissed before.
  const [visible, setVisible] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [passkeyFallbackUrl, setPasskeyFallbackUrl] = useState<string | null>(null);

  useEffect(() => {
    const ok =
      browserSupportsWebAuthn() && localStorage.getItem(DISMISS_KEY) !== "1";
    // eslint-disable-next-line react-hooks/set-state-in-effect -- client-only capability/dismissal check, deferred past SSR to avoid a hydration mismatch
    setVisible(ok);
  }, []);

  if (!visible || !status || status.hasPasskey) return null;

  const dismiss = () => {
    try {
      localStorage.setItem(DISMISS_KEY, "1");
    } catch {
      // ignore (private mode / storage disabled) — just hide for this view
    }
    setVisible(false);
    setPasskeyFallbackUrl(null);
  };

  const enroll = async () => {
    setBusy(true);
    setError("");
    setPasskeyFallbackUrl(null);
    try {
      await runPasskeyRegistration({
        start: () => startEnroll({}),
        finish: (args) => finishEnroll(args),
        label: guessDeviceLabel(),
      });
      // Success → myStatus.hasPasskey flips → this component returns null.
    } catch (err) {
      const fallbackUrl = relatedOriginPasskeyFallbackUrl(err, window.location);
      if (fallbackUrl) {
        setError("This browser can’t set up a passkey on rabbithole.school.");
        setPasskeyFallbackUrl(fallbackUrl);
        setBusy(false);
        return;
      }
      if (isPasskeyCancellation(err)) {
        setBusy(false);
        return;
      }
      console.error("Passkey enrollment failed:", err);
      setError("Couldn't set up the passkey. You can try again anytime.");
      setBusy(false);
    }
  };

  return (
    <Box
      position="relative"
      mb={6}
      px={5}
      py={4}
      bg="violet.50"
      borderWidth="1px"
      borderColor="violet.100"
      borderRadius="xl"
    >
      <Box
        as="button"
        aria-label="Dismiss"
        position="absolute"
        top={2}
        right={2}
        p={1.5}
        borderRadius="md"
        color="charcoal.300"
        cursor="pointer"
        _hover={{ bg: "blackAlpha.50", color: "charcoal.500" }}
        onClick={() => {
          if (!busy) dismiss();
        }}
      >
        <X size={16} weight="bold" />
      </Box>
      <HStack gap={4} align="center" pr={6}>
        <Box color="violet.500" flexShrink={0}>
          <Fingerprint size={28} weight="duotone" />
        </Box>
        <VStack align="flex-start" gap={0.5} flex="1" minW={0}>
          <Text fontFamily="heading" fontWeight="700" color="navy.500" fontSize="sm">
            Sign in faster next time
          </Text>
          <Text fontFamily="body" fontSize="sm" color="charcoal.500">
            Add a passkey — your device&apos;s Face ID or Touch ID — so you
            won&apos;t need to wait for an email link to sign in.
          </Text>
          {error && (
            <Text fontFamily="body" fontSize="xs" color="red.500" mt={1} role="alert">
              {error}
            </Text>
          )}
          {passkeyFallbackUrl && (
            <PasskeyRelatedOriginFallback href={passkeyFallbackUrl} />
          )}
        </VStack>
        <Button
          flexShrink={0}
          bg="violet.500"
          color="white"
          _hover={{ bg: "violet.600" }}
          fontFamily="heading"
          size="sm"
          onClick={enroll}
          disabled={busy}
        >
          {busy ? "Waiting for your device…" : "Set up passkey"}
        </Button>
      </HStack>
    </Box>
  );
}
