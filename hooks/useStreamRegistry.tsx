"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { useAuthToken } from "@convex-dev/auth/react";
import { toaster } from "@/lib/toaster";
import { LLM_BUSY_MESSAGE } from "@/shared/llmLimiter";
import type { ToolActivity, ThinkingActivity } from "@/lib/toolActivityGroups";
import { reduceThinkingStreamState } from "@/lib/thinkingStreamState";

// Canonical definition lives in lib (shared with the coalescer); re-exported
// here so existing `@/hooks/useStreamRegistry` imports keep working.
export type { ToolActivity, ThinkingActivity };

export interface SessionStreamState {
  isStreaming: boolean;
  streamingContent: string;
  streamingMsgId: string | null;
  /** Ordered tool-activity log for the current turn (accumulates; the
   * indicator coalesces consecutive same-type calls). */
  toolActivity: ToolActivity[];
  /** Ordered extended-thinking blocks for the current turn (staff surface),
   * positioned inline by textOffset; rendered as collapsible accordions. */
  thinkingActivity: ThinkingActivity[];
  /** The model is in a pre-text extended-thinking pause (Fable's always-on
   * thinking, ~10-30s) — lets UIs label the silence "Thinking deeply…". */
  isThinking: boolean;
  /** The user stopped this turn: the stream is no longer live but the partial
   * streamingContent is kept on screen until the persisted (finalized) row
   * takes over. Never true while isStreaming. */
  stopped: boolean;
}

const IDLE_STATE: SessionStreamState = {
  isStreaming: false,
  streamingContent: "",
  streamingMsgId: null,
  toolActivity: [],
  thinkingActivity: [],
  isThinking: false,
  stopped: false,
};

interface StreamRegistryContextValue {
  startStream: (
    sessionId: string,
    url: string,
    body: Record<string, unknown>,
    initialMsgId: string
  ) => Promise<void>;
  stopStream: (sessionId: string) => void;
  /**
   * Drop the lingering "stopped" shell for a session once its finalized
   * (server-persisted) row has landed, so the transcript renders that row
   * alone. No-op unless the session is currently in the stopped state.
   */
  releaseStopped: (sessionId: string) => void;
  getStreamState: (sessionId: string) => SessionStreamState;
  streamingSessionIds: string[];
}

const StreamRegistryContext = createContext<StreamRegistryContextValue>({
  startStream: async () => {},
  stopStream: () => {},
  releaseStopped: () => {},
  getStreamState: () => IDLE_STATE,
  streamingSessionIds: [],
});

export function StreamRegistryProvider({ children }: { children: React.ReactNode }) {
  const [streams, setStreams] = useState<Record<string, SessionStreamState>>({});
  const abortRefs = useRef<Record<string, AbortController>>({});
  // The in-flight run promise per session, so a new startStream (steering) can
  // preempt the current one and await its settle before starting — the two
  // runs never interleave their state.
  const runPromiseRefs = useRef<Record<string, Promise<void>>>({});
  // Set true by stopStream so the aborted run's finally KEEPS the partial on
  // screen (a user stop) instead of deleting the session (a hard error).
  const userStoppedRefs = useRef<Record<string, boolean>>({});
  // Monotonic per-session token: each startStream bumps it and captures its
  // value, so a third rapid send can pre-empt a second still queued behind the
  // first run's settle (the superseded run bails instead of streaming).
  const sendGenerationRefs = useRef<Record<string, number>>({});
  // Flipped false on provider unmount so queued runs don't start after teardown.
  const mountedRef = useRef(true);
  // Convex Auth JWT — attached to every stream POST so the Convex HTTP
  // actions can authenticate the caller (getAuthUserId) instead of
  // trusting an id from the request body.
  const authToken = useAuthToken();
  const authTokenRef = useRef<string | null>(authToken);
  useEffect(() => {
    authTokenRef.current = authToken;
  }, [authToken]);

  // Provider unmount: abort every in-flight fetch and invalidate any queued
  // runs (bump each session's generation so a run awaiting a settle bails
  // instead of firing a stream into a torn-down tree).
  useEffect(() => {
    // Re-arm on every mount: React StrictMode (dev) runs mount → cleanup →
    // mount, so a cleanup-only flag would stay false and refuse every stream.
    mountedRef.current = true;
    const abortControllers = abortRefs.current;
    const generations = sendGenerationRefs.current;
    return () => {
      mountedRef.current = false;
      for (const sessionId of Object.keys(abortControllers)) {
        abortControllers[sessionId]?.abort();
      }
      for (const sessionId of Object.keys(generations)) {
        generations[sessionId] += 1;
      }
    };
  }, []);

  const patchSession = useCallback(
    (sessionId: string, update: Partial<SessionStreamState> | null) => {
      setStreams((prev) => {
        if (update === null) {
          if (!prev[sessionId]) return prev;
          const next = { ...prev };
          delete next[sessionId];
          return next;
        }
        return {
          ...prev,
          [sessionId]: { ...(prev[sessionId] ?? IDLE_STATE), ...update },
        };
      });
    },
    []
  );

  // Functional update of one session's tool log (needs the prev array, which
  // patchSession's partial-merge can't express).
  const updateToolActivity = useCallback(
    (sessionId: string, updater: (log: ToolActivity[]) => ToolActivity[]) => {
      setStreams((prev) => {
        const cur = prev[sessionId] ?? IDLE_STATE;
        return {
          ...prev,
          [sessionId]: { ...cur, toolActivity: updater(cur.toolActivity) },
        };
      });
    },
    []
  );

  const applyThinkingEvent = useCallback(
    (
      sessionId: string,
      event: Record<string, unknown>,
      currentTextOffset: number,
      currentSequence: number,
    ) => {
      setStreams((prev) => {
        const cur = prev[sessionId] ?? IDLE_STATE;
        const thinking = reduceThinkingStreamState(
          {
            thinkingActivity: cur.thinkingActivity,
            isThinking: cur.isThinking,
          },
          event,
          currentTextOffset,
          currentSequence,
        );
        if (
          thinking.thinkingActivity === cur.thinkingActivity &&
          thinking.isThinking === cur.isThinking
        ) {
          return prev;
        }
        return {
          ...prev,
          [sessionId]: { ...cur, ...thinking },
        };
      });
    },
    []
  );

  const runStream = useCallback(
    async (
      sessionId: string,
      url: string,
      body: Record<string, unknown>,
      initialMsgId: string
    ) => {
      // A fresh run for this session: clear any stale user-stop marker so this
      // run's own finally cleans up normally.
      userStoppedRefs.current[sessionId] = false;

      const controller = new AbortController();
      abortRefs.current[sessionId] = controller;

      patchSession(sessionId, {
        isStreaming: true,
        streamingContent: "",
        streamingMsgId: initialMsgId,
        toolActivity: [],
        thinkingActivity: [],
        isThinking: false,
        stopped: false,
      });

      let fullContent = "";
      let eventSequence = 0;

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

        const reader = res.body?.getReader();
        const decoder = new TextDecoder();

        if (reader) {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            const text = decoder.decode(value);
            const lines = text.split("\n");

            for (const line of lines) {
              if (!line.startsWith("data: ")) continue;
              let data: Record<string, unknown>;
              try {
                data = JSON.parse(line.slice(6));
              } catch {
                continue;
              }

              const sequence = eventSequence++;
              applyThinkingEvent(sessionId, data, fullContent.length, sequence);

              // Accumulate an ordered tool log for the turn (the indicator
              // coalesces consecutive same-type calls); completed rows
              // persist until `done` removes the session state.
              if (data.toolStart) {
                const ts = data.toolStart as { name: string };
                const textOffset = fullContent.length;
                updateToolActivity(sessionId, (log) => [
                  ...log,
                  { name: ts.name, status: "running", textOffset, sequence },
                ]);
              }

              if (data.toolComplete) {
                const tc = data.toolComplete as { name: string; result?: string };
                updateToolActivity(sessionId, (log) => {
                  for (let i = log.length - 1; i >= 0; i--) {
                    if (log[i].name === tc.name && log[i].status === "running") {
                      const next = [...log];
                      next[i] = { ...log[i], status: "complete", result: tc.result };
                      return next;
                    }
                  }
                  return [...log, { name: tc.name, status: "complete", result: tc.result }];
                });
              }

              if (data.text) {
                fullContent += data.text as string;
                patchSession(sessionId, { streamingContent: fullContent });
              }

              if (data.newAssistantMsg) {
                patchSession(sessionId, {
                  streamingMsgId: data.newAssistantMsg as string,
                  streamingContent: "",
                });
                fullContent = "";
              }

              if (data.error) {
                const isBusy =
                  typeof data.error === "string" &&
                  data.error === LLM_BUSY_MESSAGE;
                toaster.error({
                  title: isBusy ? "Just a moment" : "AI error",
                  description: isBusy
                    ? data.error
                    : "Something went wrong. Please try again.",
                });
              }

              if (data.done) {
                patchSession(sessionId, null);
                delete abortRefs.current[sessionId];
              }
            }
          }
        }
      } catch (err) {
        if ((err as Error).name !== "AbortError") {
          console.error("Stream error:", err);
          toaster.error({
            title: "Connection lost",
            description: "The AI response was interrupted. Please try again.",
          });
        }
      } finally {
        delete abortRefs.current[sessionId];
        const wasUserStopped = userStoppedRefs.current[sessionId];
        // The marker has been captured for this run; clear it so a later run
        // for the same session doesn't inherit a stale user-stop flag.
        delete userStoppedRefs.current[sessionId];
        // A user-initiated stop keeps the partial on screen: drop the live
        // stream id (so the message list stops skipping the persisted row and
        // the finalized row takes over) but do NOT wipe the entry. Any other
        // exit (natural `done`, error) removes the session as before.
        setStreams((prev) => {
          if (!prev[sessionId]) return prev;
          if (wasUserStopped) {
            return {
              ...prev,
              [sessionId]: {
                ...prev[sessionId],
                isStreaming: false,
                stopped: true,
                streamingMsgId: null,
              },
            };
          }
          const next = { ...prev };
          delete next[sessionId];
          return next;
        });
      }
    },
    [applyThinkingEvent, patchSession, updateToolActivity]
  );

  // Public entry point. Preempts any in-flight run for this session (steering):
  // abort its fetch, then wait for that run to settle before starting the new
  // one, so their states never interleave. A first send starts immediately.
  const startStream = useCallback(
    async (
      sessionId: string,
      url: string,
      body: Record<string, unknown>,
      initialMsgId: string
    ) => {
      const previous = runPromiseRefs.current[sessionId];
      const myGeneration = (sendGenerationRefs.current[sessionId] ?? 0) + 1;
      sendGenerationRefs.current[sessionId] = myGeneration;
      abortRefs.current[sessionId]?.abort();
      const p = (async () => {
        if (previous) {
          try {
            await previous;
          } catch {
            /* the previous run owns its own error handling */
          }
        }
        // A newer startStream for this session arrived while we waited for
        // `previous` to settle (or the provider unmounted) — don't start a
        // superseded stream.
        if (!mountedRef.current) return;
        if (sendGenerationRefs.current[sessionId] !== myGeneration) return;
        await runStream(sessionId, url, body, initialMsgId);
      })();
      runPromiseRefs.current[sessionId] = p;
      void p.finally(() => {
        if (runPromiseRefs.current[sessionId] === p) {
          delete runPromiseRefs.current[sessionId];
        }
      });
      await p;
    },
    [runStream]
  );

  const stopStream = useCallback(
    (sessionId: string) => {
      // A user-initiated stop: mark it so the aborted run's finally keeps the
      // partial content on screen (the persisted, server-finalized row takes
      // over within ≤1.5 s), abort the fetch, and flip this session out of the
      // live-streaming state without dropping its text.
      userStoppedRefs.current[sessionId] = true;
      abortRefs.current[sessionId]?.abort();
      patchSession(sessionId, {
        isStreaming: false,
        stopped: true,
        streamingMsgId: null,
      });
    },
    [patchSession]
  );

  const getStreamState = useCallback(
    (sessionId: string): SessionStreamState => {
      return streams[sessionId] ?? IDLE_STATE;
    },
    [streams]
  );

  const releaseStopped = useCallback((sessionId: string) => {
    // The finalized (server-persisted) row has landed for a session the user
    // stopped: drop the lingering stopped shell so the message list renders the
    // persisted row alone. No-op if the session isn't in the stopped state.
    setStreams((prev) => {
      const cur = prev[sessionId];
      if (!cur || !cur.stopped) return prev;
      const next = { ...prev };
      delete next[sessionId];
      return next;
    });
  }, []);

  return (
    <StreamRegistryContext.Provider
      value={{
        startStream,
        stopStream,
        releaseStopped,
        getStreamState,
        streamingSessionIds: Object.keys(streams).filter(
          (id) => streams[id]?.isStreaming
        ),
      }}
    >
      {children}
    </StreamRegistryContext.Provider>
  );
}

export function useStreamRegistry() {
  return useContext(StreamRegistryContext);
}
