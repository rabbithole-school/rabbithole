"use client";

// URL-driven "View as…" (impersonation) entry point for the OVERLAY model.
//
//   /impersonate?user=<userId>&redirect=<path>
//
// A logged-in platform-admin hitting this route records a server-side,
// read-only overlay on their OWN session (no token, no incognito) and
// full-reloads to `redirect` (default "/"), so the whole app resolves as the
// target in the SAME tab. This is the agent/SOP-friendly counterpart to the
// interactive /admin/impersonate picker — handy for prod where /dev-login
// doesn't exist. "Exit" lives in the account menu.
//
// The backend re-validates every guard (platform-admin, escalation, self,
// disabled) in startImpersonation — this page is a convenience, not the trust
// boundary. See convex/impersonation.ts + review/admin-impersonation-redesign-plan.html.

import { Suspense, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Box, Heading, Spinner, Text, VStack } from "@chakra-ui/react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { isPlatformAdminRole, type Role } from "@/convex/lib/roles";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useViewingContext } from "@/hooks/useViewingContext";

/** Reduce a redirect param to a safe same-origin path (open-redirect guard). */
const safeRedirect = (raw: string | null): string => {
  if (!raw) return "/";
  let s = raw.replace(/[\t\n\r]/g, "");
  try {
    if (/^https?:\/\//i.test(s)) {
      const u = new URL(s);
      if (
        typeof window !== "undefined" &&
        u.origin === window.location.origin
      ) {
        s = u.pathname + u.search + u.hash;
      } else {
        return "/";
      }
    }
  } catch {
    return "/";
  }
  return s === "/" || /^\/[^/\\]/.test(s) ? s : "/";
};

function ImpersonateRunner() {
  const params = useSearchParams();
  const router = useRouter();
  // Accepts a username OR a user id (the server resolves both) — so the URL can
  // carry a friendly ?user=<username>, mirroring /dev-login?u=<username>.
  const targetHandle = (params.get("user") ?? "").trim();
  const redirect = safeRedirect(params.get("redirect"));

  const { user, isLoading } = useCurrentUser();
  const { mode: viewingMode, viewingPending } = useViewingContext();
  const enabled = useQuery(api.impersonation.isEnabled, {});
  const startImpersonation = useMutation(api.impersonation.startImpersonation);
  const stopImpersonation = useMutation(api.impersonation.stopImpersonation);

  const [status, setStatus] = useState<"working" | "error">("working");
  const [error, setError] = useState<string | null>(null);
  const startedRef = useRef(false);

  // While impersonating, the session resolves as the (non-admin) target, so we
  // can't read the real admin role off `user`. But being in "actAs" mode proves
  // the real session is a platform-admin — treat that as admin too.
  const isAdmin =
    viewingMode === "actAs" ||
    isPlatformAdminRole(user?.role as Role | undefined);

  useEffect(() => {
    if (startedRef.current) return;
    // Wait for auth + feature flag + viewing context to settle.
    if (isLoading || viewingPending || enabled === undefined) return;

    const fail = (message: string) => {
      startedRef.current = true;
      setError(message);
      setStatus("error");
    };

    if (!user) {
      // Not signed in — bounce to sign-in, come back here after.
      startedRef.current = true;
      router.replace(`/sign-in?next=${encodeURIComponent(
        `/impersonate?user=${targetHandle}&redirect=${redirect}`,
      )}`);
      return;
    }
    if (!enabled) return fail("View-as is not enabled on this deployment.");
    if (!isAdmin) return fail("Only a platform-admin can view as another user.");
    if (!targetHandle) return fail("Missing ?user=<username or userId> in the URL.");

    startedRef.current = true;
    void (async () => {
      try {
        // Switching targets while already impersonating: clear the current
        // overlay first so startImpersonation resolves as the real admin again.
        if (viewingMode === "actAs") {
          await stopImpersonation({});
        }
        await startImpersonation({ targetHandle });
        // Full-document reload — the app now renders as the target.
        window.location.assign(redirect);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        setStatus("error");
      }
    })();
  }, [
    enabled,
    isAdmin,
    isLoading,
    redirect,
    startImpersonation,
    stopImpersonation,
    targetHandle,
    router,
    user,
    viewingMode,
    viewingPending,
  ]);

  return (
    <Box
      minH="60vh"
      display="flex"
      alignItems="center"
      justifyContent="center"
      p={6}
    >
      <VStack gap={4} textAlign="center" maxW="md">
        {status === "working" ? (
          <>
            <Spinner size="lg" color="orange.500" />
            <Heading
              as="h1"
              fontFamily="heading"
              fontSize="lg"
              color="navy.500"
            >
              Starting view-as…
            </Heading>
            <Text fontFamily="body" fontSize="sm" color="charcoal.400">
              Recording a read-only overlay on your session, then loading the app
              as this user.
            </Text>
          </>
        ) : (
          <>
            <Heading
              as="h1"
              fontFamily="heading"
              fontSize="lg"
              color="red.600"
            >
              Couldn&apos;t start view-as
            </Heading>
            <Text fontFamily="body" fontSize="sm" color="charcoal.500">
              {error}
            </Text>
            <Text fontFamily="body" fontSize="xs" color="charcoal.400">
              Usage: <code>/impersonate?user=&lt;username or userId&gt;&amp;redirect=&lt;path&gt;</code>
            </Text>
          </>
        )}
      </VStack>
    </Box>
  );
}

export default function ImpersonatePage() {
  return (
    <Suspense fallback={null}>
      <ImpersonateRunner />
    </Suspense>
  );
}
