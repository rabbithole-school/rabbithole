import { useEffect, useRef } from "react";
import Constants from "expo-constants";
import {
  usePathname,
  useRouter,
  useSitemap,
  useUnstableGlobalHref,
} from "expo-router";

import { devServerUrlFromHostUri } from "@/lib/devClientSafety";
import {
  isDevNavigationCommand,
  navigationHrefMatches,
  sitemapHasPathname,
  type DevNavigationCommand,
} from "@/lib/devNavigationBridge";

const POLL_INTERVAL_MS = 500;
const MAX_POLL_INTERVAL_MS = 5_000;
const NAVIGATION_TIMEOUT_MS = 5_000;
// A suspended iPad (auto-lock) freezes this JS loop while Metro keeps queueing;
// on wake the whole backlog would replay as surprise navigations minutes after
// the agent gave up (observed on hardware 2026-08-19). Commands older than this
// are acked as expired instead of executed.
const COMMAND_TTL_MS = 30_000;

type PendingResult = {
  command: DevNavigationCommand;
  status: "ok" | "route-not-found" | "error";
  error?: string;
};

// Stable across route remounts in this JS runtime. Fast Refresh replaces the
// module and mints a new ID; Metro then rejects it with 409 until ownership is
// explicitly reset, so a refreshed or zombie runtime can never take over silently.
const CLIENT_ID = `${Date.now().toString(36)}-${Math.floor(
  Math.random() * 0xffffffff,
).toString(36)}`;
const OWNER_CONFLICT_ERROR =
  "another app instance owns this bridge (POST /rh-nav/owner/reset to hand over)";

// Route transitions can remount this bridge; keep command ownership alive until
// its ACK lands so the new instance observes arrival instead of replaying it.
let activeNavigation: { command: DevNavigationCommand; startedAt: number } | null = null;
let pendingResult: PendingResult | null = null;

class StaleNavigationCommandError extends Error {}

async function postCurrent(
  serverUrl: string,
  pathname: string,
  href: string,
  result?: PendingResult,
): Promise<void> {
  const response = await fetch(`${serverUrl}/rh-nav/current`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      clientId: CLIENT_ID,
      pathname,
      href,
      serverId: result?.command.serverId,
      commandId: result?.command.id,
      status: result?.status,
      error: result?.error,
    }),
  });
  if (!response.ok) {
    if (response.status === 409) {
      const body = (await response.json().catch(() => null)) as { error?: unknown } | null;
      if (
        typeof body?.error === "string" &&
        body.error.startsWith("another client owns this bridge")
      ) {
        throw new Error(OWNER_CONFLICT_ERROR);
      }
    }
    if (response.status === 409 && result) {
      throw new StaleNavigationCommandError(
        "Metro rejected a command from an earlier server instance",
      );
    }
    throw new Error(`Metro returned HTTP ${response.status} while reporting navigation`);
  }
}

async function nextCommand(serverUrl: string): Promise<DevNavigationCommand | null> {
  const response = await fetch(
    `${serverUrl}/rh-nav/next?client=${encodeURIComponent(CLIENT_ID)}`,
    { headers: { Accept: "application/json" } },
  );
  if (!response.ok) {
    if (response.status === 409) {
      throw new Error(OWNER_CONFLICT_ERROR);
    }
    throw new Error(`Metro returned HTTP ${response.status} while polling navigation`);
  }
  const body = (await response.json()) as { command?: unknown };
  return isDevNavigationCommand(body.command) ? body.command : null;
}

// Route deep links are swallowed by expo-dev-launcher before JS receives them
// (expo/expo#19846; Rabbithole sim + iPad postmortem, 2026-08-19). This opt-in
// bridge polls the already-reachable Metro transport and navigates from inside
// the running JS runtime, where expo-router can handle the route deterministically.
// Module-scope nav state (ff156cc85) assumes exactly ONE mounted instance —
// the single dev-only mount in _layout.tsx. A second concurrent mount would
// double-navigate and clobber activeNavigation (REVIEW-REMOUNT #2), so make
// the invariant loud instead of silent.
let mountedInstances = 0;

export function DevNavigationBridge() {
  const pathname = usePathname();
  const href = useUnstableGlobalHref();
  const router = useRouter();
  const sitemap = useSitemap();
  const pathnameRef = useRef(pathname);
  const hrefRef = useRef(href);
  const lastFailureRef = useRef<string | null>(null);
  const serverUrl = devServerUrlFromHostUri(Constants.expoConfig?.hostUri);

  useEffect(() => {
    mountedInstances += 1;
    if (mountedInstances > 1) {
      console.warn(
        `[dev-navigation] ${mountedInstances} DevNavigationBridge instances are mounted — module-scope nav state assumes a singleton; navigation results may interleave`,
      );
    }
    return () => {
      mountedInstances -= 1;
    };
  }, []);

  useEffect(() => {
    pathnameRef.current = pathname;
    hrefRef.current = href;
  }, [href, pathname]);

  useEffect(() => {
    if (!serverUrl) {
      console.warn("[dev-navigation] Expo hostUri is unavailable");
      return;
    }
    void postCurrent(serverUrl, pathname, href).catch((error) => {
      console.warn("[dev-navigation] could not report current route", error);
    });
  }, [href, pathname, serverUrl]);

  useEffect(() => {
    if (!serverUrl) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let consecutiveFailures = 0;

    const recordFailure = (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      if (lastFailureRef.current !== message) {
        console.warn("[dev-navigation] bridge request failed", error);
        lastFailureRef.current = message;
      }
    };

    const runPoll = async () => {
      const pending = pendingResult;
      if (pending) {
        await postCurrent(
          serverUrl,
          pathnameRef.current,
          hrefRef.current,
          pending,
        ).catch((error) => {
          if (cancelled) return;
          if (error instanceof StaleNavigationCommandError) {
            console.warn("[dev-navigation] discarded stale command after Metro restart");
            return;
          }
          return Promise.reject(error);
        });
        if (cancelled) return;
        consecutiveFailures = 0;
        pendingResult = null;
        activeNavigation = null;
        lastFailureRef.current = null;
        return;
      }

      const active = activeNavigation;
      if (active) {
        const arrived = active.command.pathname.includes("?")
          ? navigationHrefMatches(hrefRef.current, active.command.pathname)
          : pathnameRef.current === active.command.routePathname;
        if (arrived) {
          pendingResult = { command: active.command, status: "ok" };
        } else if (Date.now() - active.startedAt >= NAVIGATION_TIMEOUT_MS) {
          pendingResult = {
            command: active.command,
            status: "error",
            error: `navigation timed out at ${pathnameRef.current}`,
          };
        }
        return;
      }

      const command = await nextCommand(serverUrl);
      if (cancelled) return;
      consecutiveFailures = 0;
      if (!command) {
        lastFailureRef.current = null;
        return;
      }
      if (Date.now() - command.queuedAt > COMMAND_TTL_MS) {
        pendingResult = {
          command,
          status: "error",
          error: `command expired: queued ${Math.round((Date.now() - command.queuedAt) / 1000)}s ago (app was likely suspended)`,
        };
        return;
      }
      if (!sitemapHasPathname(sitemap, command.routePathname)) {
        pendingResult = {
          command,
          status: "route-not-found",
          error: `no Expo Router route matches ${command.routePathname}`,
        };
        return;
      }

      activeNavigation = { command, startedAt: Date.now() };
      const alreadyThere = command.pathname.includes("?")
        ? navigationHrefMatches(hrefRef.current, command.pathname)
        : pathnameRef.current === command.routePathname;
      if (alreadyThere) {
        pendingResult = { command, status: "ok" };
      } else {
        router.replace(command.pathname as never);
      }
      lastFailureRef.current = null;
    };

    const scheduleNextPoll = () => {
      if (!cancelled) {
        const delay = Math.min(
          POLL_INTERVAL_MS * 2 ** consecutiveFailures,
          MAX_POLL_INTERVAL_MS,
        );
        timer = setTimeout(poll, delay);
      }
    };

    const handlePollFailure = (error: unknown) => {
      if (cancelled) return;
      consecutiveFailures += 1;
      recordFailure(error);
    };

    function poll() {
      void runPoll().catch(handlePollFailure).then(scheduleNextPoll, scheduleNextPoll);
    }

    poll();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [router, serverUrl, sitemap]);

  return null;
}
