"use client";

/**
 * Manual rehearsal — Replay driver.
 *
 * Drives a "Reset & replay" run: re-sends the prior rehearsal's scholar turns
 * (staged on the fresh project as `replayScript`) against the edited prompt
 * so the teacher watches instead of re-typing. Because the project's
 * `handleSend` already resolves only when the tutor's stream completes (it
 * awaits `stream.send`), replay is a plain sequential `await` loop over the
 * script — no isStreaming polling between turns. The one race we guard is
 * the very first turn landing on top of the auto-`<start>` greeting, via
 * `getIsStreaming`.
 *
 * Status machine: offered → running → paused (at the flagged-turn boundary,
 * or when the teacher hits Stop) → running (Continue) → done. `done` clears
 * the staged script server-side so a reload doesn't re-offer it.
 *
 * See review/test-drive-replay-plan.md.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { Doc } from "@/convex/_generated/dataModel";

export type ReplayStatus = "none" | "offered" | "running" | "paused" | "done";

// A failed/never-arriving greeting or a stream that never settles must not
// strand the strip in "running" forever — bail to `paused` (the teacher can
// Continue to retry) once these elapse.
const GREETING_TIMEOUT_MS = 30_000;
const TURN_SETTLE_TIMEOUT_MS = 30_000;
// A send that keeps no-op'ing (a stream still settling, or an empty turn that
// slipped through) is retried this many times before we pause rather than
// silently skipping the turn.
const MAX_SEND_RETRIES = 20;

export interface ManualRehearsalReplay {
  status: ReplayStatus;
  /** Total scholar turns available to replay. */
  total: number;
  /** Turns replayed so far. */
  sentCount: number;
  /** Target turn count of the current/most-recent run (≤ total). */
  runTarget: number;
  /** Default pause boundary (lands on the last flagged tutor response). */
  stopAfter: number;
  /** True when a 👎 flag created a boundary short of the full script. */
  hasFlagBoundary: boolean;
  /** Begin replay, pausing at the flagged-turn boundary (or the end). */
  start: () => void;
  /** Resume a paused replay through the end of the script. */
  continueToEnd: () => void;
  /** Stop after the in-flight turn finishes. */
  stop: () => void;
  /** Dismiss the offer / strip and clear the staged script. */
  dismiss: () => void;
  /**
   * Tell the driver a send happened that it didn't originate (the teacher
   * typed a turn). While offered/paused that means "I'm taking over" — the
   * strip retires. No-op during our own replayed turns.
   */
  notifyManualSend: () => void;
}

export function useManualRehearsalReplay({
  session,
  sendText,
  getIsStreaming,
  getGreetingLanded,
  clearReplay,
}: {
  session: Doc<"sessions"> | null | undefined;
  /**
   * The project's send path; resolves when the tutor's stream completes.
   * Resolves to `true` if a message was actually dispatched, `false` if it
   * no-op'd (empty input or a stream still in flight) — the driver only
   * advances on a real send.
   */
  sendText: (text: string) => Promise<boolean>;
  /** Reads the live streaming flag (guards the first-turn greeting race). */
  getIsStreaming: () => boolean;
  /**
   * True once the auto-`<start>` greeting has produced a tutor reply. The
   * first replayed turn waits on this so it can never preempt the greeting.
   */
  getGreetingLanded: () => boolean;
  /** Nulls the staged script server-side once consumed/dismissed. */
  clearReplay: () => void;
}): ManualRehearsalReplay {
  const [script, setScript] = useState<string[]>([]);
  const [stopAfter, setStopAfter] = useState(0);
  const [status, setStatus] = useState<ReplayStatus>("none");
  const [sentCount, setSentCount] = useState(0);
  const [runTarget, setRunTarget] = useState(0);

  // Stable refs so the run loop's closure sees live values without
  // re-creating the callbacks each render.
  const sentCountRef = useRef(0);
  const cancelRef = useRef(false);
  const dismissedRef = useRef(false);
  const runningRef = useRef(false);
  const sendTextRef = useRef(sendText);
  const getIsStreamingRef = useRef(getIsStreaming);
  const getGreetingLandedRef = useRef(getGreetingLanded);
  const clearReplayRef = useRef(clearReplay);
  const statusRef = useRef(status);
  // Keep the latest callbacks + status in refs (synced post-render — never
  // mutate a ref during render). The async run loop and notifyManualSend
  // read `.current` outside render.
  useEffect(() => {
    sendTextRef.current = sendText;
    getIsStreamingRef.current = getIsStreaming;
    getGreetingLandedRef.current = getGreetingLanded;
    clearReplayRef.current = clearReplay;
    statusRef.current = status;
  });

  // (Re)initialize whenever the project changes. SessionInterface is NOT
  // remounted on a /scholar/[id] navigation — it persists and just gets a
  // new projectId (that's why it carries a welcomeSentRef). So a plain
  // "capture once" latch would miss the 2nd+ "Reset & replay" in a session
  // (the exact rapid-iteration path this feature exists for). Key the
  // (re)capture on project._id, and bump an epoch so any run still in flight
  // from the previous project aborts before sending into the new one.
  // Re-runs when the SAME project's staged field clears (at `done`) are
  // ignored via the id check, so clearing the script doesn't wipe live state.
  const currentSessionRef = useRef<string | null>(null);
  const sessionEpochRef = useRef(0);
  const sessionKey = session?._id ? String(session._id) : null;
  const staged = session?.replayScript;
  const stagedStop = session?.replayStopAfter;
  useEffect(() => {
    if (!sessionKey) return;
    if (currentSessionRef.current === sessionKey) return;
    currentSessionRef.current = sessionKey;
    sessionEpochRef.current += 1; // abort any stale in-flight run
    cancelRef.current = false;
    dismissedRef.current = false;
    runningRef.current = false;
    sentCountRef.current = 0;
    const hasScript = !!(staged && staged.length > 0);
    // One-time derive of local replay state per project — same shape as
    // other "seed-on-prop" effects in the codebase.
    setSentCount(0);
    setScript(hasScript ? staged : []);
    setStopAfter(hasScript ? (stagedStop ?? staged!.length) : 0);
    setStatus(hasScript ? "offered" : "none");
  }, [sessionKey, staged, stagedStop]);

  const runTo = useCallback(async (target: number) => {
    if (runningRef.current) return;
    runningRef.current = true;
    cancelRef.current = false;
    const epoch = sessionEpochRef.current;
    // Abort if stopped, dismissed, or the project changed under us (a
    // mid-run "Reset & replay" must not send this rehearsal's turns into the
    // next one — handleSend is bound to the live projectId).
    const aborted = () =>
      cancelRef.current ||
      dismissedRef.current ||
      sessionEpochRef.current !== epoch;
    setRunTarget(target);
    setStatus("running");
    // Poll `cond` until it goes false. Returns true if it cleared normally,
    // false if we aborted OR hit `timeoutMs` (so a never-arriving greeting /
    // stuck stream falls through to `paused` instead of hanging forever).
    const waitWhile = async (cond: () => boolean, timeoutMs: number) => {
      const deadline = Date.now() + timeoutMs;
      while (cond()) {
        if (aborted() || Date.now() > deadline) return false;
        await new Promise((r) => setTimeout(r, 100));
      }
      return true;
    };
    try {
      // Wait for the opening <start> greeting to land before the first turn so
      // a replay can never preempt it (greeting + this run both kick off near
      // mount). A timeout here → skip the loop → finally lands us in `paused`.
      const ready = await waitWhile(
        () => !getGreetingLandedRef.current() || getIsStreamingRef.current(),
        GREETING_TIMEOUT_MS,
      );
      if (ready && !aborted()) {
        let sendRetries = 0;
        for (let i = sentCountRef.current; i < target; i++) {
          // Wait out any in-flight stream (the opening greeting on the first
          // turn) before sending — sendText no-ops while streaming.
          const settled = await waitWhile(
            () => getIsStreamingRef.current(),
            TURN_SETTLE_TIMEOUT_MS,
          );
          if (aborted()) break;
          if (!settled) break; // stream never settled → pause, don't spin
          // sendText resolves to false when handleSend no-op'd (a stream still
          // settling, or an empty turn). Don't advance on a no-op — retry the
          // same turn a bounded number of times, then pause. Advancing here
          // would silently skip a scholar turn and desync the count.
          const sent = await sendTextRef.current(script[i]);
          if (aborted()) break;
          if (!sent) {
            if (++sendRetries > MAX_SEND_RETRIES) break;
            i--; // retry the same index
            await new Promise((r) => setTimeout(r, 100));
            continue;
          }
          sendRetries = 0;
          sentCountRef.current = i + 1;
          setSentCount(i + 1);
        }
      }
    } finally {
      runningRef.current = false;
      if (dismissedRef.current || sessionEpochRef.current !== epoch) {
        // Dismissed, or the project changed — the capture effect owns
        // status for the new project; don't resurface a stale strip.
      } else if (!cancelRef.current && sentCountRef.current >= script.length) {
        setStatus("done");
        clearReplayRef.current();
      } else {
        setStatus("paused");
      }
    }
  }, [script]);

  const start = useCallback(() => {
    void runTo(stopAfter > 0 ? stopAfter : script.length);
  }, [runTo, stopAfter, script.length]);

  const continueToEnd = useCallback(() => {
    void runTo(script.length);
  }, [runTo, script.length]);

  const stop = useCallback(() => {
    cancelRef.current = true;
  }, []);

  const dismiss = useCallback(() => {
    cancelRef.current = true;
    dismissedRef.current = true;
    setStatus("none");
    clearReplayRef.current();
  }, []);

  const notifyManualSend = useCallback(() => {
    if (runningRef.current) return; // our own replayed turn — ignore
    const s = statusRef.current;
    if (s === "offered" || s === "paused") {
      // The teacher typed instead of replaying — they're driving manually.
      dismissedRef.current = true;
      setStatus("none");
      clearReplayRef.current();
    }
  }, []);

  return {
    status,
    total: script.length,
    sentCount,
    runTarget,
    stopAfter,
    hasFlagBoundary: stopAfter > 0 && stopAfter < script.length,
    start,
    continueToEnd,
    stop,
    dismiss,
    notifyManualSend,
  };
}
