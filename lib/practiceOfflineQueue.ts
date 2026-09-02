"use client";

/**
 * Offline-tolerant answering for the practice drill (roadmap §11 — iPad-native
 * polish). A network blip mid-session shouldn't drop the drill: when a submit
 * can't reach the server, PracticeSession queues `{itemId, answer}` locally
 * (persisted here so a reload during the outage doesn't lose it) and replays
 * each one through the EXISTING `submitAnswer` mutation once back online.
 *
 * This is deliberately dumb about grading — the correct answer is re-derived
 * server-side from the opaque `itemId` (`skillKey#seed` template items, or
 * `gen#<id>` for generated ones; see submitAnswer in convex/practiceSkills.ts),
 * so there is no client-side verdict to fake. The scholar sees an honest
 * "we'll check this when you're back online" instead of a guessed grade.
 */

import { useEffect, useState } from "react";
import type { ConfidenceLevel } from "@/convex/lib/practice/calibration";
import type { Id } from "@/convex/_generated/dataModel";

export type QueuedPracticeAnswer = {
  clientEventId: string;
  itemId: string;
  answer: string;
  /** Mirrors the `record` flag submitAnswer expects — false for a retry
   *  during the Socratic-handoff loop, so the scheduler isn't double-hit. */
  record: boolean;
  skillLabel: string;
  queuedAt: number;
  /** Predict-then-Check: the kid's optional pre-answer confidence, carried
   *  through the outage so the replayed submitAnswer logs the SAME prediction
   *  it would have online (never silently dropped). Present only on a recorded
   *  first attempt where the chip was used; absent otherwise. */
  predictedConfidence?: ConfidenceLevel;
  /** Preserve the server-authoritative breaker linkage across an outage. */
  breakerTriggerAttemptId?: Id<"practiceAttempts">;
  breakerEasyTriggerAttemptId?: Id<"practiceAttempts">;
  /** Quick Facts never opens the general-practice breaker surface. */
  suppressBreaker?: boolean;
  /** Ask the server to return the prepared first repair with a threshold miss. */
  prepareBreakerRepair?: boolean;
};

function storageKey(scholarId: string): string {
  return `rh-practice-offline-queue:${scholarId}`;
}

/** Reads the persisted queue for one scholar. Safe to call on the server (SSR). */
export function loadQueuedAnswers(scholarId: string): QueuedPracticeAnswer[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(storageKey(scholarId));
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as QueuedPracticeAnswer[]) : [];
  } catch {
    return [];
  }
}

/** Persists the queue (or clears the key entirely once it's empty). */
export function saveQueuedAnswers(scholarId: string, queue: QueuedPracticeAnswer[]): boolean {
  if (typeof window === "undefined") return false;
  try {
    if (queue.length === 0) window.localStorage.removeItem(storageKey(scholarId));
    else window.localStorage.setItem(storageKey(scholarId), JSON.stringify(queue));
    return true;
  } catch {
    return false;
  }
}

export function enqueueAnswer(
  scholarId: string,
  item: QueuedPracticeAnswer,
): QueuedPracticeAnswer[] | null {
  const next = [...loadQueuedAnswers(scholarId), item];
  return saveQueuedAnswers(scholarId, next) ? next : null;
}

/**
 * Hydration-safe `navigator.onLine`, kept live via the `online`/`offline`
 * window events. SSR and the first client render assume online (so they
 * agree, avoiding a hydration mismatch) — same convention as the useIsIPad()
 * hook in lib/native.ts.
 */
export function useBrowserOnline(): boolean {
  const [online, setOnline] = useState(true);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- client-only capability check, deferred past SSR to avoid a hydration mismatch
    setOnline(navigator.onLine);
    const onOnline = () => setOnline(true);
    const onOffline = () => setOnline(false);
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    return () => {
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
    };
  }, []);
  return online;
}
