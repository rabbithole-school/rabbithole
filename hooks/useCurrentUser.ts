"use client";

import { useConvexAuth } from "convex/react";
import { api } from "@/convex/_generated/api";
import { useCachedQuery } from "@/hooks/useCachedQuery";

/**
 * Hook to get the current authenticated user from Convex.
 * Returns { user, isLoading, isAuthenticated }.
 *
 * Backed by the perceived-speed cache (useCachedQuery): on a cold launch
 * the last-known user renders instantly while the live query confirms.
 * Once auth definitively settles signed-out, the snapshot is never
 * surfaced — consumers see null exactly as before.
 *
 * The query is gated on `tokenAuthed` (mirroring how callers gate other
 * auth-only queries on `isAuthenticated`). Without that gate, on a cold
 * post-login page load the query fires *before* the Convex client has
 * attached the freshly-minted auth token, so it runs unauthenticated and
 * resolves to `null` — a spurious "no user" that the post-login routing
 * guards (app/page.tsx → signOut, app/scholar/page.tsx → /sign-in) read as
 * "signed out", killing the brand-new session and bouncing the user back to
 * the login screen in a loop. Skipping until the token is attached means the
 * first read is always authenticated, so `null` only ever means a genuinely
 * missing user doc (the real stale-session case the guards exist for).
 */
export function useCurrentUser() {
  const { isLoading: authLoading, isAuthenticated: tokenAuthed } =
    useConvexAuth();
  const user = useCachedQuery(
    api.users.currentUser,
    tokenAuthed ? {} : "skip",
    "currentUser",
  );

  const effective = !authLoading && !tokenAuthed ? null : user;

  return {
    user: effective ?? null,
    isLoading: effective === undefined,
    isAuthenticated: effective !== null && effective !== undefined,
  };
}
