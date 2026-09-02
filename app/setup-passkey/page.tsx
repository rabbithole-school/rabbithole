"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useConvexAuth, useQuery, useAction } from "convex/react";
import { useAuthActions } from "@convex-dev/auth/react";
import {
  Box,
  Button,
  Container,
  Heading,
  Text,
  VStack,
} from "@chakra-ui/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { useViewingContext } from "@/hooks/useViewingContext";
import {
  runPasskeyRegistration,
  isPasskeyCancellation,
  browserSupportsWebAuthn,
  guessDeviceLabel,
  relatedOriginPasskeyFallbackUrl,
} from "@/lib/passkeyClient";
import { PasskeyRelatedOriginFallback } from "@/components/PasskeyRelatedOriginFallback";

/**
 * Mandatory passkey enrollment for a signed-in staff member who has none.
 * The post-login router (app/page.tsx) and the staff dashboard send staff
 * here when `mustEnroll` is true; this is how passwordless self-migrates.
 */
export default function SetupPasskeyPage() {
  const { isAuthenticated, isLoading: authLoading } = useConvexAuth();
  const router = useRouter();
  const { signOut } = useAuthActions();
  const status = useQuery(
    api.passkeys.myStatus,
    isAuthenticated ? {} : "skip",
  );
  const startEnroll = useAction(api.passkeys.startEnrollment);
  const finishEnroll = useAction(api.passkeys.finishEnrollment);
  // An impersonated session must never enroll a passkey on anyone's account —
  // bounce back to the router (which sends the view-as session to its home).
  const { mode: viewingMode } = useViewingContext();

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [passkeyFallbackUrl, setPasskeyFallbackUrl] = useState<string | null>(null);

  // If they aren't signed in, or they already have a passkey, or this is a
  // view-as session, leave.
  useEffect(() => {
    if (authLoading) return;
    if (!isAuthenticated) {
      router.replace("/sign-in");
      return;
    }
    if (viewingMode === "actAs") {
      router.replace("/");
      return;
    }
    if (status && !status.mustEnroll) {
      router.replace("/");
    }
  }, [authLoading, isAuthenticated, status, viewingMode, router]);

  const handleSetup = async () => {
    setBusy(true);
    setError("");
    setPasskeyFallbackUrl(null);
    try {
      await runPasskeyRegistration({
        start: () => startEnroll({}),
        finish: (args: {
          challengeId: Id<"webauthnChallenges">;
          response: string;
          label?: string;
        }) => finishEnroll(args),
        label: guessDeviceLabel(),
      });
      router.replace("/");
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
      console.error("Passkey setup failed:", err);
      setError(
        err instanceof Error
          ? err.message
          : "Something went wrong setting up your passkey.",
      );
      setBusy(false);
    }
  };

  // browserSupportsWebAuthn() touches `navigator`, which is absent during SSR.
  // Calling it inline makes the server render the "unsupported" branch and the
  // client render the "supported" branch → hydration mismatch. Assume
  // supported for SSR + the first client render (so they match), then correct
  // after mount.
  const [supported, setSupported] = useState(true);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- client-only capability check, deferred past SSR to avoid a hydration mismatch
    setSupported(browserSupportsWebAuthn());
  }, []);

  return (
    <Box
      minH="100dvh"
      bg="linear-gradient(135deg, #222656 0%, #1a1d42 50%, #364153 100%)"
      display="flex"
      alignItems="center"
      justifyContent="center"
      p={4}
      position="fixed"
      inset={0}
      overflowY="auto"
    >
      <Container maxW="md">
        <VStack
          gap={6}
          bg="white"
          p={{ base: 8, md: 12 }}
          borderRadius="2xl"
          shadow="2xl"
          textAlign="center"
        >
          <Box fontSize="48px" lineHeight="1" userSelect="none">
            🔑
          </Box>
          <VStack gap={2}>
            <Heading
              as="h1"
              size="xl"
              fontFamily="heading"
              color="navy.500"
              letterSpacing="tight"
            >
              Set up your passkey
            </Heading>
            <Text color="charcoal.400" fontFamily="heading" fontSize="sm">
              Staff accounts use a passkey instead of a password. Set one up to
              continue — it replaces your password from now on. Tip: choose
              iCloud Keychain (iPhone/Mac) or Google (Android) so it works on
              all your devices automatically.
            </Text>
          </VStack>

          {!supported && (
            <Text fontSize="sm" color="red.500" fontFamily="body">
              This browser doesn&apos;t support passkeys. Try Safari or
              Chrome.
            </Text>
          )}
          {error && (
            <Text fontSize="sm" color="red.500" fontFamily="body" role="alert">
              {error}
            </Text>
          )}
          {passkeyFallbackUrl && (
            <PasskeyRelatedOriginFallback href={passkeyFallbackUrl} />
          )}

          <Button
            size="lg"
            w="full"
            bg="violet.500"
            color="white"
            _hover={{ bg: "violet.600" }}
            fontFamily="heading"
            fontWeight="500"
            h={14}
            disabled={!supported || busy}
            onClick={handleSetup}
          >
            {busy ? "Waiting for your device…" : "Create my passkey"}
          </Button>

          <Text
            fontSize="xs"
            color="charcoal.300"
            fontFamily="heading"
            cursor="pointer"
            _hover={{ color: "violet.500", textDecoration: "underline" }}
            onClick={() => {
              setPasskeyFallbackUrl(null);
              void signOut();
            }}
          >
            Sign out
          </Text>
        </VStack>
      </Container>
    </Box>
  );
}
