"use client";

import { useState, useRef, useCallback, useEffect } from "react";
import { useAuthToken } from "@convex-dev/auth/react";
import { toaster } from "@/lib/toaster";
import type { ToolActivity } from "@/lib/toolActivityGroups";

// Re-exported so the existing `@/hooks/useAgentStream` imports keep working;
// the canonical definition now lives in lib (shared with the coalescer).
export type { ToolActivity };

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
  stop: () => void;
}

export function useAgentStream(options?: UseAgentStreamOptions): UseAgentStreamReturn {
  const [streamingContent, setStreamingContent] = useState("");
  const [streamingMsgId, setStreamingMsgId] = useState<string | null>(null);
  const [isStreaming, setIsStreaming] = useState(false);
  const [toolActivity, setToolActivity] = useState<ToolActivity[]>([]);
  const [generatingImage, setGeneratingImage] = useState(false);
  const [isThinking, setIsThinking] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
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
    abortRef.current?.abort();
  }, []);

  useEffect(() => {
    return () => {
      cancelStreamingFrame();
      abortRef.current?.abort();
    };
  }, [cancelStreamingFrame]);

  const send = useCallback(
    async (url: string, body: Record<string, unknown>, initialMsgId?: string) => {
      setIsStreaming(true);
      clearStreamingContent();
      setStreamingMsgId(initialMsgId ?? null);
      setToolActivity([]);
      setGeneratingImage(false);
      setIsThinking(false);

      const controller = new AbortController();
      abortRef.current = controller;
      let fullContent = "";
      let completed = false;
      let failed = false;

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
              let data: StreamEvent;
              try {
                data = JSON.parse(line.slice(6)) as StreamEvent;
              } catch {
                continue;
              }

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

              // --- Error from server ---
              if (data.error) {
                failed = true;
                toaster.error({ title: "AI error", description: "Something went wrong. Please try again." });
              }

              // --- Done ---
              // Keep the accumulated tool log as-is (the next send() resets
              // it). The indicator is gated on isStreaming, which flips false
              // in `finally`, so the log stops rendering once the turn ends —
              // the persisted assistant text + populated outline take over.
              if (data.done) {
                completed = true;
                clearStreamingContent();
                setStreamingMsgId(null);
                setGeneratingImage(false);
                setIsThinking(false);
              }
            }
          }
        }
      } catch (err) {
        if ((err as Error).name !== "AbortError") {
          console.error("Stream error:", err);
          toaster.error({ title: "Connection lost", description: "The AI response was interrupted. Please try again." });
        }
        clearStreamingContent();
        setStreamingMsgId(null);
        setGeneratingImage(false);
      } finally {
        abortRef.current = null;
        setIsStreaming(false);
        setIsThinking(false);
      }
      return completed && !failed;
    },
    [clearStreamingContent, scheduleStreamingContent],
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
  };
}
