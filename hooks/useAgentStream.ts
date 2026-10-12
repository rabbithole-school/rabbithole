"use client";

import { useState, useRef, useCallback, useEffect } from "react";
import { useAuthToken } from "@convex-dev/auth/react";
import type { ToolActivity } from "@/lib/toolActivityGroups";
import { LLM_BUSY_MESSAGE } from "@/shared/llmLimiter";
import { parseRetryAfterSeconds, planStreamRetry } from "@/shared/streamRetry";

// Re-exported so the existing `@/hooks/useAgentStream` imports keep working;
// the canonical definition now lives in lib (shared with the coalescer).
export type { ToolActivity };

/** Wait `ms`, resolving true on timeout or false the moment `signal` aborts. */
function sleepAbortable(ms: number, signal: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve(false);
    const onAbort = () => {
      clearTimeout(timer);
      resolve(false);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve(true);
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** Parsed SSE event data */
export interface StreamEvent {
  text?: string;
  done?: boolean;
  error?: string;
  toolStart?: { name: string };
  toolComplete?: { name: string; result?: string };
  artifactUpdate?: boolean;
  newArtifactId?: string;
  processStepUpdate?: { step: string; status: string; commentary?: string };
  newAssistantMsg?: string;
  generatedImage?: boolean;
  generatingImage?: string;
  /** The model started an extended-thinking block (Fable thinks before
   * its first visible token — can be 10-30s). Cleared on first text. */
  thinking?: boolean;
  /** App designer: the mode the turn actually runs in, sent first when it
   * differs from the client's request. Usually "play" — a forged or clamped
   * Edit request under `never`/locked `afterCompletion` runs as Play. It can
   * also be "edit" when a turn's stored designer stamp outranks a "play"
   * request. The client acts on the Play case (snapping to Play); an "edit"
   * value is currently ignored. */
  workshopMode?: "edit" | "play";
}

/**
 * Stands in for the server's own error event when a stream closes with
 * neither `done` nor `error` — the server action was killed mid-turn.
 */
export const STREAM_ENDED_EARLY = "stream-ended-early";

/**
 * Read an agent SSE body to its end, handing each `data:` event to `onEvent`;
 * an `onEvent` that returns true stops reading. Lines are buffered across
 * chunks, so an event split between two reads is not lost. Resolves true once
 * a `done` event has arrived. A stream that closes without `done` or `error`
 * gets a synthetic error event first, so it fails through the same path a
 * server error takes instead of reading as a finished turn.
 */
export async function readAgentStream(
  reader: { read(): Promise<{ done: boolean; value?: Uint8Array }> },
  onEvent: (data: StreamEvent) => boolean | void,
): Promise<boolean> {
  const decoder = new TextDecoder();
  let buffer = "";
  let sawDone = false;
  let sawError = false;
  // True when onEvent asked to stop.
  const handleLines = (lines: string[]) => {
    for (const raw of lines) {
      const line = raw.replace(/\r$/, "");
      if (!line.startsWith("data: ")) continue;
      let data: StreamEvent;
      try {
        data = JSON.parse(line.slice(6)) as StreamEvent;
      } catch {
        continue;
      }
      if (data.done) sawDone = true;
      if (data.error) sawError = true;
      if (onEvent(data) === true) return true;
    }
    return false;
  };
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    if (handleLines(lines)) return sawDone;
  }
  buffer += decoder.decode();
  if (handleLines(buffer.split("\n"))) return sawDone;
  if (!sawDone && !sawError) onEvent({ error: STREAM_ENDED_EARLY });
  return sawDone;
}

interface UseAgentStreamOptions {
  /** Called for every parsed SSE event, before default state updates. */
  onEvent?: (data: StreamEvent) => void;
}

export interface UseAgentStreamReturn {
  streamingContent: string;
  streamingMsgId: string | null;
  isStreaming: boolean;
  /** Ordered tool-activity log for the current streaming turn (accumulates;
   * the indicator coalesces consecutive same-type calls). Reset on each send. */
  toolActivity: ToolActivity[];
  generatingImage: boolean;
  /** True while the model is in a pre-text extended-thinking pause (Fable's
   * always-on thinking) — lets UIs label the silence "Thinking deeply…". */
  isThinking: boolean;
  send: (url: string, body: Record<string, unknown>, initialMsgId?: string) => Promise<boolean>;
  /**
   * User-initiated stop. Aborts the in-flight fetch but KEEPS the partial
   * content on screen (the persisted row, which the server finalizes within
   * ≤1.5 s, takes over) — unlike a steer, which discards it. Returns the
   * in-flight run's promise so a caller can await the settle. Never marks the
   * turn as failed and never toasts.
   */
  stop: () => Promise<boolean>;
  /** When the last turn failed because the server was busy: the wait it
   *  asked for (`Retry-After`, seconds; null if it sent none). Undefined when
   *  the last turn did not fail on a busy refusal. Feeds `busyRetryCopy`. */
  busyRetryAfterSec: number | null | undefined;
}

export function useAgentStream(options?: UseAgentStreamOptions): UseAgentStreamReturn {
  const [streamingContent, setStreamingContent] = useState("");
  const [streamingMsgId, setStreamingMsgId] = useState<string | null>(null);
  const [isStreaming, setIsStreaming] = useState(false);
  const [toolActivity, setToolActivity] = useState<ToolActivity[]>([]);
  const [generatingImage, setGeneratingImage] = useState(false);
  const [isThinking, setIsThinking] = useState(false);
  const [busyRetryAfterSec, setBusyRetryAfterSec] = useState<
    number | null | undefined
  >(undefined);
  const abortRef = useRef<AbortController | null>(null);
  // Set true by stop() so the in-flight run's finally keeps the partial content
  // (a user stop) instead of clearing it (a hard error / steer preemption).
  const userStopRef = useRef(false);
  // The promise of the currently-running send() loop, so a new send() can
  // preempt it (steering) and await its settle before starting.
  const runPromiseRef = useRef<Promise<boolean> | null>(null);
  // Monotonic token: each send() bumps it and captures its value. After
  // awaiting the previous run's settle, a send bails if a NEWER send has since
  // superseded it — so a third rapid send can pre-empt a second still queued
  // behind the first, instead of both firing back-to-back.
  const sendGenerationRef = useRef(0);
  const streamingFrameRef = useRef<number | null>(null);
  const latestStreamingContentRef = useRef("");

  const cancelStreamingFrame = useCallback(() => {
    if (streamingFrameRef.current !== null) {
      cancelAnimationFrame(streamingFrameRef.current);
      streamingFrameRef.current = null;
    }
  }, []);

  const flushStreamingContent = useCallback(() => {
    setStreamingContent(latestStreamingContentRef.current);
    streamingFrameRef.current = null;
  }, []);

  const scheduleStreamingContent = useCallback((content: string) => {
    latestStreamingContentRef.current = content;
    if (streamingFrameRef.current !== null) return;
    streamingFrameRef.current = requestAnimationFrame(flushStreamingContent);
  }, [flushStreamingContent]);

  const clearStreamingContent = useCallback(() => {
    latestStreamingContentRef.current = "";
    cancelStreamingFrame();
    setStreamingContent("");
  }, [cancelStreamingFrame]);

  // Convex Auth JWT — attached to the stream POST so the Convex HTTP
  // action can authenticate the caller (getAuthUserId) and authorize
  // project access, instead of trusting a projectId from the body.
  const authToken = useAuthToken();
  const authTokenRef = useRef<string | null>(authToken);
  useEffect(() => {
    authTokenRef.current = authToken;
  }, [authToken]);

  // Stable ref for onEvent callback so `send` doesn't re-create on every render
  const onEventRef = useRef(options?.onEvent);
  useEffect(() => {
    onEventRef.current = options?.onEvent;
  });

  const stop = useCallback(() => {
    userStopRef.current = true;
    abortRef.current?.abort();
    return runPromiseRef.current ?? Promise.resolve(false);
  }, []);

  useEffect(() => {
    return () => {
      cancelStreamingFrame();
      abortRef.current?.abort();
    };
  }, [cancelStreamingFrame]);

  const runSend = useCallback(
    async (url: string, body: Record<string, unknown>, initialMsgId?: string) => {
      setIsStreaming(true);
      clearStreamingContent();
      setStreamingMsgId(initialMsgId ?? null);
      setToolActivity([]);
      setGeneratingImage(false);
      setIsThinking(false);

      // One attempt = one POST to the stream endpoint. A busy refusal (HTTP 429
      // + LLM_BUSY_MESSAGE) is retryable; everything else is terminal.
      type AttemptOutcome =
        | { kind: "completed" }
        | { kind: "busy"; retryAfterSec: number | null }
        | { kind: "error" }
        | { kind: "aborted" };

      const runAttempt = async (
        controller: AbortController,
      ): Promise<AttemptOutcome> => {
        let fullContent = "";
        try {
          const token = authTokenRef.current;
          const res = await fetch(url, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              ...(token ? { Authorization: `Bearer ${token}` } : {}),
            },
            signal: controller.signal,
            body: JSON.stringify(body),
          });

          // Busy refusal: the limiter answers 429 before any streaming, with a
          // one-line SSE error body and a Retry-After header. Read it whole (it
          // is tiny) rather than entering the token loop.
          if (res.status === 429) {
            let errorMessage = "";
            try {
              const text = await res.text();
              for (const line of text.split("\n")) {
                if (!line.startsWith("data: ")) continue;
                try {
                  const data = JSON.parse(line.slice(6)) as StreamEvent;
                  if (data.error) errorMessage = data.error;
                } catch {
                  /* ignore keepalive */
                }
              }
            } catch {
              /* body already consumed / aborted */
            }
            if (errorMessage === LLM_BUSY_MESSAGE) {
              return {
                kind: "busy",
                retryAfterSec: parseRetryAfterSeconds(
                  res.headers.get("Retry-After"),
                ),
              };
            }
            // A different 429 (e.g. the test-server cost breaker) is terminal.
            // No toast — the surface represents the failed turn inline (a calm
            // "didn't go through — try again" affordance on the scholar's own
            // message), so a stream/busy failure never fires a toast.
            return { kind: "error" };
          }

          const reader = res.body?.getReader();

          const handleEvent = (data: StreamEvent): boolean => {
            // Forward to component-specific handler first
            onEventRef.current?.(data);

            // --- Tool progress events ---
            // Accumulate an ordered log for the turn (vs. the old single
            // transient indicator): toolStart appends a running row;
            // toolComplete flips the matching running row to complete.
            // Completed rows persist until the next send() resets the log.
            //
            // `generate_image` is excluded: the only surface that fires it
            // (the scholar tutor) renders a dedicated in-bubble "Generating
            // image…" indicator off the `generatingImage` flag below, so a
            // log row would double up with it.
            if (data.toolStart && data.toolStart.name !== "generate_image") {
              const name = data.toolStart.name;
              const textOffset = fullContent.length;
              setToolActivity((prev) => [...prev, { name, status: "running", textOffset }]);
            }

            if (data.toolComplete && data.toolComplete.name !== "generate_image") {
              const { name, result } = data.toolComplete;
              setToolActivity((prev) => {
                // Flip the LAST still-running row with this name to complete.
                for (let i = prev.length - 1; i >= 0; i--) {
                  if (prev[i].name === name && prev[i].status === "running") {
                    const next = [...prev];
                    next[i] = { ...prev[i], status: "complete", result };
                    return next;
                  }
                }
                // Defensive: a complete with no matching start — append it.
                return [...prev, { name, status: "complete", result }];
              });
            }

            // --- Image generation flag (drives the tutor's in-bubble
            // "Generating image…" indicator; see the generate_image note above). ---
            if (data.generatingImage === "started") {
              setGeneratingImage(true);
            }
            if (data.generatedImage) {
              setGeneratingImage(false);
            }

            // --- Extended-thinking pause (Fable) ---
            if (data.thinking) {
              setIsThinking(true);
            }

            // --- Text streaming ---
            if (data.text) {
              setIsThinking(false);
              fullContent += data.text;
              scheduleStreamingContent(fullContent);
            }

            // --- Stream split (new assistant message after tool) ---
            if (data.newAssistantMsg) {
              setStreamingMsgId(data.newAssistantMsg);
              fullContent = "";
              clearStreamingContent();
            }

            // --- Done ---
            if (data.done) {
              clearStreamingContent();
              setStreamingMsgId(null);
              setGeneratingImage(false);
              setIsThinking(false);
              return true;
            }
            return false;
          };

          // Only a `done` event completes the turn. A mid-stream error (the
          // lease was already granted, so not a busy refusal we can cleanly
          // re-POST) and a stream that closed without either (the server died
          // mid-turn) both mark the turn failed — the inline affordance shows,
          // no toast.
          if (reader && (await readAgentStream(reader, handleEvent))) {
            return { kind: "completed" };
          }
          return { kind: "error" };
        } catch (err) {
          if ((err as Error).name === "AbortError") {
            return { kind: "aborted" };
          }
          // A genuine network drop. Represented inline as a failed turn (the
          // retry affordance), not a toast — see the no-toast policy above.
          console.error("Stream error:", err);
          return { kind: "error" };
        }
      };

      const startedAt = Date.now();
      let completed = false;
      let failed = false;
      let userStopped = false;
      setBusyRetryAfterSec(undefined);

      try {
        for (;;) {
          // Reset the per-attempt visible state but KEEP streamingMsgId set, so
          // the pending "thinking" indicator stays up across a wait+retry — a
          // busy backend must read as a slow turn, never a flash of nothing.
          clearStreamingContent();
          setToolActivity([]);
          setGeneratingImage(false);
          setIsThinking(false);

          const controller = new AbortController();
          abortRef.current = controller;
          const outcome = await runAttempt(controller);

          if (outcome.kind === "completed") {
            completed = true;
            break;
          }
          if (outcome.kind === "aborted") {
            break;
          }
          if (outcome.kind === "busy") {
            const plan = planStreamRetry({
              busy: true,
              elapsedMs: Date.now() - startedAt,
              retryAfterSec: outcome.retryAfterSec,
            });
            if (plan.retry) {
              const waited = await sleepAbortable(plan.delayMs, controller.signal);
              if (!waited) break; // scholar hit stop during the wait
              continue;
            }
            // Budget exhausted (or a user-window Retry-After too long to wait).
            // No toast — the surface shows a calm inline "didn't go through —
            // try again" affordance instead, with the honest wait.
            setBusyRetryAfterSec(outcome.retryAfterSec);
            failed = true;
            break;
          }
          // Hard error (no toast — inline affordance shows).
          failed = true;
          break;
        }
      } finally {
        abortRef.current = null;
        setIsStreaming(false);
        setIsThinking(false);
        setGeneratingImage(false);
        // A user-initiated stop keeps the partial content on screen: drop the
        // active-stream id so the finalized (persisted) row takes over when it
        // lands (≤1.5 s), but do NOT wipe the streamed text — the transcript
        // bridge keeps the partial visible across the handoff.
        userStopped = userStopRef.current;
        userStopRef.current = false;
        if (!completed && !userStopped) {
          clearStreamingContent();
          setStreamingMsgId(null);
        } else if (userStopped) {
          setStreamingMsgId(null);
        }
      }
      // A user stop is a clean end, not a failed turn — return true so the host
      // never shows the "didn't go through" affordance for it.
      return (completed && !failed) || userStopped;
    },
    [clearStreamingContent, scheduleStreamingContent],
  );

  // Public send(). Preempts any in-flight run (steering): abort the current
  // fetch, then wait for that run to settle before starting the new one, so the
  // two streams never interleave their state. A first send (nothing in flight)
  // starts immediately.
  const send = useCallback(
    (url: string, body: Record<string, unknown>, initialMsgId?: string) => {
      const previous = runPromiseRef.current;
      const myGeneration = ++sendGenerationRef.current;
      if (abortRef.current) {
        // A steer, not a user stop — the new turn replaces the old partial, so
        // leave userStopRef false (the aborted run clears its own state).
        abortRef.current.abort();
      }
      const p = (async () => {
        if (previous) {
          try {
            await previous;
          } catch {
            /* the previous run owns its own error handling */
          }
        }
        // A newer send() arrived while we waited for `previous` to settle — it
        // owns the turn now; don't start a superseded stream.
        if (sendGenerationRef.current !== myGeneration) return false;
        return runSend(url, body, initialMsgId);
      })();
      runPromiseRef.current = p;
      void p.finally(() => {
        if (runPromiseRef.current === p) runPromiseRef.current = null;
      });
      return p;
    },
    [runSend],
  );

  return {
    streamingContent,
    streamingMsgId,
    isStreaming,
    toolActivity,
    generatingImage,
    isThinking,
    send,
    stop,
    busyRetryAfterSec,
  };
}
