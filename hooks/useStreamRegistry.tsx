"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { useAuthToken } from "@convex-dev/auth/react";
import { toaster } from "@/lib/toaster";
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
}

const IDLE_STATE: SessionStreamState = {
  isStreaming: false,
  streamingContent: "",
  streamingMsgId: null,
  toolActivity: [],
  thinkingActivity: [],
  isThinking: false,
};

interface StreamRegistryContextValue {
  startStream: (
    sessionId: string,
    url: string,
    body: Record<string, unknown>,
    initialMsgId: string
  ) => Promise<void>;
  stopStream: (sessionId: string) => void;
  getStreamState: (sessionId: string) => SessionStreamState;
  streamingSessionIds: string[];
}

const StreamRegistryContext = createContext<StreamRegistryContextValue>({
  startStream: async () => {},
  stopStream: () => {},
  getStreamState: () => IDLE_STATE,
  streamingSessionIds: [],
});

export function StreamRegistryProvider({ children }: { children: React.ReactNode }) {
  const [streams, setStreams] = useState<Record<string, SessionStreamState>>({});
  const abortRefs = useRef<Record<string, AbortController>>({});
  // Convex Auth JWT — attached to every stream POST so the Convex HTTP
  // actions can authenticate the caller (getAuthUserId) instead of
  // trusting an id from the request body.
  const authToken = useAuthToken();
  const authTokenRef = useRef<string | null>(authToken);
  useEffect(() => {
    authTokenRef.current = authToken;
  }, [authToken]);

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

  const startStream = useCallback(
    async (
      sessionId: string,
      url: string,
      body: Record<string, unknown>,
      initialMsgId: string
    ) => {
      // Abort any existing stream for this session before starting a new one
      abortRefs.current[sessionId]?.abort();

      const controller = new AbortController();
      abortRefs.current[sessionId] = controller;

      patchSession(sessionId, {
        isStreaming: true,
        streamingContent: "",
        streamingMsgId: initialMsgId,
        toolActivity: [],
        thinkingActivity: [],
        isThinking: false,
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
                toaster.error({
                  title: "AI error",
                  description: "Something went wrong. Please try again.",
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
        // Only clear if the session is still registered as streaming (data.done may have already removed it)
        setStreams((prev) => {
          if (!prev[sessionId]) return prev;
          const next = { ...prev };
          delete next[sessionId];
          return next;
        });
      }
    },
    [applyThinkingEvent, patchSession, updateToolActivity]
  );

  const stopStream = useCallback(
    (sessionId: string) => {
      abortRefs.current[sessionId]?.abort();
      delete abortRefs.current[sessionId];
      patchSession(sessionId, null);
    },
    [patchSession]
  );

  const getStreamState = useCallback(
    (sessionId: string): SessionStreamState => {
      return streams[sessionId] ?? IDLE_STATE;
    },
    [streams]
  );

  return (
    <StreamRegistryContext.Provider
      value={{
        startStream,
        stopStream,
        getStreamState,
        streamingSessionIds: Object.keys(streams),
      }}
    >
      {children}
    </StreamRegistryContext.Provider>
  );
}

export function useStreamRegistry() {
  return useContext(StreamRegistryContext);
}
