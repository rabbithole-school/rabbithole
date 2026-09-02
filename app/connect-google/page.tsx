"use client";

// One-click "connect Google Drive" entry point.
//
//   /connect-google?returnTo=<path>
//
// The Connect button normally lives inside the profile modal, which means it
// can't be linked to. Surfaces OUTSIDE the app — notably the Slack bot, which
// has to tell someone "I can't read your Drive" — need a URL they can hand
// over so the fix is one click instead of a scavenger hunt through settings.
//
// This route is safe to paste into a public Slack channel: it carries no
// token and no user id. It acts on whoever is signed in to THIS browser, so a
// bystander clicking it can only connect their own account, never the
// original recipient's. (Minting a signed OAuth `state` into the message
// instead would let anyone who saw it bind their Google account to the
// recipient's Rabbithole user — and would expire in ten minutes besides.)
//
// beginOAuth binds by getAuthUserId, i.e. the REAL session owner, so this is
// impersonation-immune like the in-app button.

import { Suspense, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Box, Heading, Spinner, Text, VStack } from "@chakra-ui/react";
import { useAction } from "convex/react";
import { api } from "@/convex/_generated/api";
import { useCurrentUser } from "@/hooks/useCurrentUser";

/** Reduce a returnTo param to a safe same-origin path (open-redirect guard). */
const safeReturnTo = (raw: string | null): string => {
  if (!raw) return "/teacher";
  let s = raw.replace(/[\t\n\r]/g, "");
  try {
    if (/^https?:\/\//i.test(s)) {
      const u = new URL(s);
      if (typeof window !== "undefined" && u.origin === window.location.origin) {
        s = u.pathname + u.search + u.hash;
      } else {
        return "/teacher";
      }
    }
  } catch {
    return "/teacher";
  }
  return /^\/[^/\\]/.test(s) ? s : "/teacher";
};

function ConnectGoogleRunner() {
  const params = useSearchParams();
  const router = useRouter();
  const returnTo = safeReturnTo(params.get("returnTo"));

  const { user, isLoading } = useCurrentUser();
  const beginOAuth = useAction(api.googleAccountsActions.beginOAuth);

  const [error, setError] = useState<string | null>(null);
  const startedRef = useRef(false);

  useEffect(() => {
    if (startedRef.current || isLoading) return;

    if (!user) {
      startedRef.current = true;
      router.replace(`/sign-in?next=${encodeURIComponent(
        `/connect-google?returnTo=${returnTo}`,
      )}`);
      return;
    }

    startedRef.current = true;
    void (async () => {
      try {
        const { url } = await beginOAuth({ returnTo });
        window.location.assign(url);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    })();
  }, [beginOAuth, isLoading, returnTo, router, user]);

  return (
    <Box
      minH="60vh"
      display="flex"
      alignItems="center"
      justifyContent="center"
      p={6}
    >
      <VStack gap={4} textAlign="center" maxW="md">
        {error === null ? (
          <>
            <Spinner size="lg" color="orange.500" />
            <Heading as="h1" fontFamily="heading" fontSize="lg" color="navy.500">
              Connecting your Google account…
            </Heading>
            <Text fontFamily="body" fontSize="sm" color="charcoal.400">
              Sending you to Google for personal Google Docs, Google Slides, and
              Drive access. You&apos;ll come right back.
            </Text>
          </>
        ) : (
          <>
            <Heading as="h1" fontFamily="heading" fontSize="lg" color="red.600">
              Couldn&apos;t start Google sign-in
            </Heading>
            <Text fontFamily="body" fontSize="sm" color="charcoal.500">
              {error}
            </Text>
          </>
        )}
      </VStack>
    </Box>
  );
}

export default function ConnectGooglePage() {
  return (
    <Suspense fallback={null}>
      <ConnectGoogleRunner />
    </Suspense>
  );
}
