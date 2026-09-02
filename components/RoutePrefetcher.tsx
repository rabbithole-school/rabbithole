"use client";

import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { useConvex } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";

/**
 * Local-first navigation prefetch (perceived-speed). Mounted once in Providers.
 *
 * Warms BOTH the Next route and the Convex query cache for session links the user
 * is likely to open next — on hover/touch intent and for links currently in (or
 * near) the viewport — so that tapping a session paints from cache instead of a
 * round-trip + spinner. Measured: scholar session open 509ms → 101ms (~5.1×) on a
 * production build (see review/native-ipad-app-plan.md).
 *
 * Passive and side-effect only: it never intercepts clicks or alters navigation —
 * links navigate normally (instant, App Router). Prefetch wiring is deferred to
 * idle so it doesn't tax hydration / first paint.
 */
function closestAnchor(target: EventTarget | null): HTMLAnchorElement | null {
  return target instanceof Element ? target.closest<HTMLAnchorElement>("a[href]") : null;
}

/** How long to hold a warmed session-query subscription — long enough to cover
 *  intent → click → mount, short enough to not linger as a live subscription. */
const WARM_TTL_MS = 10000;

function internalHref(anchor: HTMLAnchorElement): string | null {
  if (anchor.target && anchor.target !== "_self") return null;
  if (anchor.hasAttribute("download")) return null;
  const url = new URL(anchor.href, window.location.href);
  if (url.origin !== window.location.origin) return null;
  if (url.pathname.startsWith("/api/")) return null;
  return `${url.pathname}${url.search}${url.hash}`;
}

function sessionIdFromHref(href: string): Id<"sessions"> | null {
  const url = new URL(href, window.location.href);
  const match = /^\/scholar\/([^/?#]+)$/.exec(url.pathname);
  if (!match) return null;
  const id = decodeURIComponent(match[1]);
  if (id === "new" || id === "profile" || id === "unit") return null;
  return id as Id<"sessions">;
}

export function RoutePrefetcher({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const convex = useConvex();
  const prefetchedSessions = useRef(new Set<string>());
  const warmTimers = useRef<ReturnType<typeof setTimeout>[]>([]);

  useEffect(() => {
    // Hold a query subscription warm briefly so a later useQuery shares it and
    // paints from cache. A one-shot client.query() unsubscribes the instant the
    // result lands (see convex react client), so it does NOT keep data warm —
    // we must hold the watch ourselves for a short TTL.
    const warm = (sub: { onUpdate: (cb: () => void) => () => void }) => {
      const unsubscribe = sub.onUpdate(() => {});
      const timer = setTimeout(unsubscribe, WARM_TTL_MS);
      warmTimers.current.push(timer);
    };

    const prefetch = (href: string) => {
      try {
        router.prefetch(href);
      } catch {}

      const sessionId = sessionIdFromHref(href);
      if (!sessionId || prefetchedSessions.current.has(String(sessionId))) return;
      prefetchedSessions.current.add(String(sessionId));
      try {
        warm(convex.watchQuery(api.sessions.getWithMessages, { id: sessionId }));
        warm(convex.watchQuery(api.artifacts.getBySession, { sessionId }));
        warm(convex.watchQuery(api.sessions.getDeliverableSnapshot, { sessionId }));
      } catch {
        prefetchedSessions.current.delete(String(sessionId));
      }
    };

    let idleId: number | null = null;
    const scheduleVisiblePrefetch = () => {
      if (idleId !== null) return;
      const run = () => {
        idleId = null;
        const anchors = Array.from(
          document.querySelectorAll<HTMLAnchorElement>('a[href*="/scholar/"]'),
        );
        let count = 0;
        for (const anchor of anchors) {
          const href = internalHref(anchor);
          if (!href || !sessionIdFromHref(href)) continue;
          const rect = anchor.getBoundingClientRect();
          const nearViewport =
            rect.bottom >= -240 &&
            rect.top <= window.innerHeight + 480 &&
            rect.right >= 0 &&
            rect.left <= window.innerWidth;
          if (!nearViewport) continue;
          prefetch(href);
          count++;
          if (count >= 8) break;
        }
      };
      if ("requestIdleCallback" in window) {
        idleId = window.requestIdleCallback(run, { timeout: 900 });
      } else {
        idleId = setTimeout(run, 350) as unknown as number;
      }
    };

    const onIntent = (event: Event) => {
      const anchor = closestAnchor(event.target);
      if (!anchor) return;
      const href = internalHref(anchor);
      if (href) prefetch(href);
    };

    // Defer all prefetch wiring (visible scan + the whole-<body> MutationObserver)
    // to idle so it doesn't run during hydration / first paint.
    const observer = new MutationObserver(scheduleVisiblePrefetch);
    let initId: number | null = null;
    const startWiring = () => {
      initId = null;
      scheduleVisiblePrefetch();
      observer.observe(document.body, { childList: true, subtree: true });
    };
    if ("requestIdleCallback" in window) {
      initId = window.requestIdleCallback(startWiring, { timeout: 2000 });
    } else {
      initId = setTimeout(startWiring, 800) as unknown as number;
    }

    document.addEventListener("pointerover", onIntent, { capture: true });
    document.addEventListener("touchstart", onIntent, { capture: true, passive: true });
    return () => {
      document.removeEventListener("pointerover", onIntent, { capture: true });
      document.removeEventListener("touchstart", onIntent, { capture: true });
      observer.disconnect();
      const cancel = (id: number | null) => {
        if (id === null) return;
        if ("cancelIdleCallback" in window) window.cancelIdleCallback(id);
        else clearTimeout(id);
      };
      cancel(initId);
      cancel(idleId);
      warmTimers.current.forEach(clearTimeout);
      warmTimers.current = [];
    };
  }, [convex, router]);

  return <>{children}</>;
}
