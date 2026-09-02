"use client";

import { useMemo } from "react";
import { useConvexAuth, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { isTeacherRole, type Role } from "@/convex/lib/roles";
import { useCurrentUser } from "@/hooks/useCurrentUser";

/**
 * Unifies the two "viewing the app as another user" modes:
 *
 * - `actAs`   — admin impersonation. A server-side overlay recorded on the
 *               admin's own session (`api.impersonation.myImpersonation`)
 *               makes every query re-resolve as the target, read-only.
 * - `inspect` — teacher `?remote=<scholarId>` mode: the teacher stays
 *               themselves but reads a scholar's surface.
 *
 * `mode` is the single source of truth for "am I looking through someone
 * else's eyes, and how?". Components that need to act on viewing state
 * (AccountMenu pills + exits, routing guards) consume this hook.
 */
export type ViewingMode = "actAs" | "inspect" | null;

interface ViewingContextOptions {
  remoteUserId?: string | null;
  pathname?: string | null;
}

export function useViewingContext({
  remoteUserId = null,
  pathname = null,
}: ViewingContextOptions = {}) {
  const { isAuthenticated } = useConvexAuth();
  const { user } = useCurrentUser();
  const impersonation = useQuery(
    api.impersonation.myImpersonation,
    isAuthenticated ? {} : "skip",
  );

  const isInspecting = !!(
    isAuthenticated &&
    impersonation === null &&
    remoteUserId &&
    pathname?.startsWith("/scholar") &&
    isTeacherRole(user?.role as Role | undefined)
  );

  return useMemo(() => {
    const mode: ViewingMode = impersonation
      ? "actAs"
      : isInspecting
        ? "inspect"
        : null;
    return {
      mode,
      impersonation: impersonation ?? null,
      // True while the impersonation query is still resolving (auth'd but not
      // yet answered). Routing guards MUST wait for this before acting on
      // `mode`, or they'll briefly treat an impersonated session as normal and
      // (e.g.) bounce it to /setup-passkey — the F5-class flash.
      viewingPending: isAuthenticated && impersonation === undefined,
    };
  }, [impersonation, isAuthenticated, isInspecting]);
}
