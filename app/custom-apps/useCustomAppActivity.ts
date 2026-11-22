"use client";

import { useEffect, useRef, useState } from "react";
import { useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import {
  APP_PLAY_RESUME_GAP_MS,
  createAppPlayTracker,
  type AppPlayTracker,
} from "@/shared/appPlaySession";

/** The iPad overlay's capture tick (ExternalAppHost CAPTURE_INTERVAL_MS). */
const TILE_HEARTBEAT_MS = 25_000;
/** readScholarWebActivity's freshness window: a row is live only within this
 *  of its last check-in. A longer gap here means the machine slept or the tab
 *  was frozen, so the row is left to end at its last check-in rather than
 *  finalized (or extended) across the silence. */
const TILE_STALE_GAP_MS = 90_000;

/**
 * Record a signed-in scholar's time on a launcher tile opened on the web, in
 * the same webActivitySessions log the iPad overlay writes for every tile
 * (start → check-in → finalize), so teachers and the aide read both from one
 * place. Anyone else — signed out, staff previewing, a scholar without the
 * tile on their launcher — writes nothing, and neither does a visit a web
 * assignment opened (`enabled` false: that assignment's own row records it).
 *
 * Switching away for under APP_PLAY_RESUME_GAP_MS keeps the session open, so
 * glancing at another tab does not litter the teacher's card with rows;
 * leaving the page ends it at once.
 */
export function useCustomAppActivity(token: string, enabled: boolean): void {
  const { user } = useCurrentUser();
  const tracked = enabled && user?.role === "scholar";
  const start = useMutation(api.webActivitySessions.startForTile);
  const recordProgress = useMutation(api.webActivitySessions.recordProgress);
  const finalize = useMutation(api.webActivitySessions.finalize);
  const trackerRef = useRef<AppPlayTracker | null>(null);
  const activeRef = useRef(false);
  const [visible, setVisible] = useState(
    () => typeof document === "undefined" || document.visibilityState === "visible",
  );

  useEffect(() => {
    if (!tracked) return;
    let lastBeatAt = 0;
    const fresh = () => Date.now() - lastBeatAt <= TILE_STALE_GAP_MS;
    const next = createAppPlayTracker<Id<"webActivitySessions">>({
      start: async () => {
        const started = await start({ customAppToken: token });
        if (!started) return null;
        lastBeatAt = Date.now();
        // finalize() stamps its own time; this log has no clock to align.
        return {
          playSessionId: started.sessionId,
          resumes: 0,
          serverNow: Date.now(),
        };
      },
      heartbeat: async (sessionId) => {
        if (!fresh()) return false;
        await recordProgress({ sessionId });
        lastBeatAt = Date.now();
        return true;
      },
      end: async ({ playSessionId }) => {
        if (fresh()) await finalize({ sessionId: playSessionId });
      },
      setInterval: (fn, ms) => window.setInterval(fn, ms),
      clearInterval: (handle) => window.clearInterval(handle as number),
      heartbeatMs: TILE_HEARTBEAT_MS,
      onError: (error) =>
        console.warn("[rabbithole] tile activity tracking failed", error),
    });
    trackerRef.current = next;
    next.setActive(activeRef.current);
    return () => {
      next.dispose();
      if (trackerRef.current === next) trackerRef.current = null;
    };
  }, [tracked, token, start, recordProgress, finalize]);

  useEffect(() => {
    let hideTimer: number | undefined;
    const sync = () => {
      window.clearTimeout(hideTimer);
      if (document.visibilityState === "visible") {
        setVisible(true);
      } else {
        hideTimer = window.setTimeout(
          () => setVisible(false),
          APP_PLAY_RESUME_GAP_MS,
        );
      }
    };
    const leave = () => {
      window.clearTimeout(hideTimer);
      setVisible(false);
    };
    document.addEventListener("visibilitychange", sync);
    window.addEventListener("pagehide", leave);
    window.addEventListener("pageshow", sync);
    return () => {
      window.clearTimeout(hideTimer);
      document.removeEventListener("visibilitychange", sync);
      window.removeEventListener("pagehide", leave);
      window.removeEventListener("pageshow", sync);
    };
  }, []);

  useEffect(() => {
    activeRef.current = visible;
    trackerRef.current?.setActive(visible);
  }, [visible]);
}
