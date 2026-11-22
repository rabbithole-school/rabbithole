"use client";

import { useEffect, useRef, useState } from "react";
import { useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import {
  createAppPlayTracker,
  type AppPlayInteractionSource,
  type AppPlayTracker,
} from "@/shared/appPlaySession";

function pageVisible(): boolean {
  return typeof document === "undefined" || document.visibilityState === "visible";
}

/**
 * Record when this app is on screen (convex/appPlaySessions.ts): while
 * `onScreen` is true and the tab is visible. With `interactions`, the
 * interval also carries active time and ends itself once nobody has touched
 * the app for a while (shared/appPlaySession.ts). The server decides whether
 * this viewer is tracked at all — a teacher watching a scholar's app gets null
 * back from start() and nothing is written. Native twin:
 * native/src/hooks/useAppPlaySession.ts.
 */
export function useAppPlaySession(
  artifactId: Id<"artifacts"> | null,
  onScreen: boolean,
  interactions?: AppPlayInteractionSource,
): void {
  const start = useMutation(api.appPlaySessions.start);
  const heartbeat = useMutation(api.appPlaySessions.heartbeat);
  const end = useMutation(api.appPlaySessions.end);
  // Built and disposed in an effect (StrictMode-safe); the active flag is
  // mirrored in a ref so a tracker rebuilt for a new artifact starts in the
  // current state.
  const trackerRef = useRef<AppPlayTracker | null>(null);
  const activeRef = useRef(false);
  const [visible, setVisible] = useState(pageVisible);
  const tracksInteraction = interactions !== undefined;

  useEffect(() => {
    if (artifactId === null) return;
    const next = createAppPlayTracker<Id<"appPlaySessions">>({
      start: () =>
        start({
          artifactId,
          surface: "web",
          ...(tracksInteraction ? { tracksInteraction: true } : {}),
        }),
      heartbeat: (playSessionId, activity) =>
        heartbeat({ playSessionId, ...activity }),
      end: ({ playSessionId, resumes }, endedAt, activity) =>
        end({ playSessionId, resumes, endedAt, ...activity }),
      tracksInteraction,
      setInterval: (fn, ms) => window.setInterval(fn, ms),
      clearInterval: (handle) => window.clearInterval(handle as number),
      onError: (error) =>
        console.warn("[rabbithole] app play tracking failed", error),
    });
    trackerRef.current = next;
    next.setActive(activeRef.current);
    return () => {
      next.dispose();
      if (trackerRef.current === next) trackerRef.current = null;
    };
  }, [artifactId, start, heartbeat, end, tracksInteraction]);

  useEffect(
    () => interactions?.subscribe(() => trackerRef.current?.noteInteraction()),
    [interactions],
  );

  useEffect(() => {
    const sync = () => setVisible(pageVisible());
    const hide = () => setVisible(false);
    document.addEventListener("visibilitychange", sync);
    window.addEventListener("pagehide", hide);
    window.addEventListener("pageshow", sync);
    return () => {
      document.removeEventListener("visibilitychange", sync);
      window.removeEventListener("pagehide", hide);
      window.removeEventListener("pageshow", sync);
    };
  }, []);

  const active = onScreen && visible;
  useEffect(() => {
    activeRef.current = active;
    trackerRef.current?.setActive(active);
  }, [active]);
}
