"use client";

import { ChakraProvider, Toaster, Toast, Stack } from "@chakra-ui/react";
import { ConvexAuthProvider } from "@convex-dev/auth/react";
import { ConvexQueryCacheProvider } from "convex-helpers/react/cache";
import { ConvexReactClient } from "convex/react";
import { system } from "@/lib/theme";
import { toaster } from "@/lib/toaster";
import { EmotionRegistry } from "./EmotionRegistry";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { ImpersonationBanner } from "@/components/ImpersonationBanner";
import { SuspendedInstitutionGate } from "@/components/SuspendedInstitutionGate";
import { RoutePrefetcher } from "@/components/RoutePrefetcher";

const convex = new ConvexReactClient(
  process.env.NEXT_PUBLIC_CONVEX_URL as string,
  {
    // Convex's default browser guard installs a `beforeunload` listener that
    // fires the native "Leave site? Changes you made may not be saved." prompt
    // whenever a full-document navigation coincides with an in-flight mutation.
    // Our mutations are sub-second and transactional, so it protects almost
    // nothing — but it ambushed a school admin deleting their own school: the
    // intentional post-delete sign-out navigation tripped the prompt, making it
    // look like clicking "Leave" might abort the deletion (it can't — the delete
    // runs server-side and is uninterruptible). The native client already runs
    // without it (native/src/lib/convex.ts); match that on web.
    unsavedChangesWarning: false,
  }
);

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <ConvexAuthProvider client={convex}>
      {/* Keeps recently-unmounted query subscriptions warm so back-nav
          renders instantly (perceived-speed cache, plan Part 4). */}
      <ConvexQueryCacheProvider>
      <EmotionRegistry>
        <ChakraProvider value={system}>
          {/* App-wide safety net: a render error in ANY globally-mounted
              component (or a page) is caught here instead of white-screening
              the whole app with the browser's crash page. An "not
              authenticated" throw redirects to /sign-in. This is the durable
              fix for the class of crash a globally-mounted authed query caused
              — see review/admin-impersonation-redesign-plan.html §5.6. */}
          <ErrorBoundary>
            {/* App-wide "you are viewing as someone else" banner + one-click
                exit. Renders nothing unless the session has a live overlay, so
                it's guaranteed visible on every page (not just where the
                AccountMenu is mounted). See ImpersonationBanner. */}
            <ImpersonationBanner />
            <SuspendedInstitutionGate>
              <RoutePrefetcher>{children}</RoutePrefetcher>
            </SuspendedInstitutionGate>
            <Toaster toaster={toaster}>
              {(toast) => (
                <Toast.Root key={toast.id} width={{ md: "sm" }}>
                  <Stack gap="1" flex="1" maxWidth="100%">
                    {toast.title && <Toast.Title>{toast.title}</Toast.Title>}
                    {toast.description && (
                      <Toast.Description>{toast.description}</Toast.Description>
                    )}
                  </Stack>
                  <Toast.CloseTrigger />
                </Toast.Root>
              )}
            </Toaster>
          </ErrorBoundary>
        </ChakraProvider>
      </EmotionRegistry>
      </ConvexQueryCacheProvider>
    </ConvexAuthProvider>
  );
}
