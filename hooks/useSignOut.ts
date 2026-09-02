"use client";

import { useCallback, useRef, useState } from "react";
import { useAuthActions } from "@convex-dev/auth/react";
import { useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import { clearCachedQueries } from "@/hooks/useCachedQuery";

/**
 * Sign out and reliably land on a signed-out destination.
 *
 * The raw `signOut()` from @convex-dev/auth is async but many call sites
 * fire-and-forget it — the UI is left showing the authenticated view until
 * a query errors or the user refreshes. This hook awaits the signOut and
 * then does a full-document navigation (default `/sign-in`) so nothing from
 * the previous session's Convex subscriptions lingers. Pass a `destination`
 * to land somewhere else — e.g. the `/school-deleted` confirmation page after
 * an admin deletes their own school.
 *
 * Returns `[signOut, isSigningOut]`. The hook is idempotent: subsequent
 * calls while a sign-out is in flight are no-ops, so callers can safely
 * use it as a click handler without worrying about double-clicks racing
 * with auth-state-driven re-renders bouncing the user back to /scholar.
 */
export function useSignOut(): [(destination?: string) => Promise<void>, boolean] {
  const { signOut } = useAuthActions();
  const stopImpersonation = useMutation(api.impersonation.stopImpersonation);
  const [isSigningOut, setIsSigningOut] = useState(false);
  const inFlightRef = useRef(false);

  const handler = useCallback(async (destination = "/sign-in") => {
    // Some call sites wire this straight to onClick, so the first arg can be a
    // DOM event rather than a path. Only honor a real same-origin path; anything
    // else (an event, an external URL) falls back to /sign-in.
    const target =
      typeof destination === "string" &&
      destination.startsWith("/") &&
      !destination.startsWith("//")
        ? destination
        : "/sign-in";
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    setIsSigningOut(true);
    try {
      await stopImpersonation({}).catch(() => {});
      await signOut();
    } catch (err) {
      console.error("Sign out failed:", err);
    } finally {
      // Drop perceived-speed snapshots so the next user on this device
      // never sees the previous session's data flash.
      clearCachedQueries();
      if (typeof window !== "undefined") {
        window.location.href = target;
      }
    }
  }, [signOut, stopImpersonation]);

  return [handler, isSigningOut];
}
