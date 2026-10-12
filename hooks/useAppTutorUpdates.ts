"use client";

// The client half of "one queue to the tutor" for web screens that host an app
// (SessionInterface, VibecodeWorkshop). The queue itself — coalescing, the
// held/busy retention, the character-update floor — is the pure module in
// shared/appTutorRequest.ts (vendored to native, whose twin hook mirrors this
// one). This hook only binds it to React: latest-value refs for the host's
// streaming state and send function, a drain whenever the tutor goes idle,
// and a drain whenever the queue gains an item.

import { useEffect, useMemo, useRef, useState } from "react";

import {
  createAppTutorUpdateQueue,
  latestTutorLine,
  tutorLinePreview,
  type AppTutorRequest,
  type AppTutorSendResult,
  type AppTutorUpdateBatch,
  type AppTutorUpdateQueue,
} from "@/shared/appTutorRequest";

export function useAppTutorUpdates({
  sessionId,
  enabled,
  busy,
  send,
}: {
  /**
   * The session the queue delivers to. A host that stays mounted across a
   * session change gets a fresh queue, so nothing queued (or retrying) for the
   * old session can go out through the new one's send.
   */
  sessionId: string;
  /**
   * Only the session OWNER's client may start tutor turns. A teacher reading a
   * scholar's session remotely hosts the same app but must never drain.
   */
  enabled: boolean;
  /** A tutor turn is streaming or about to (kickoff, send in flight). */
  busy: boolean;
  /** Start one app-update turn; resolves once its mutation has settled. */
  send: (batch: AppTutorUpdateBatch) => Promise<AppTutorSendResult>;
}) {
  const busyRef = useRef(busy);
  const enabledRef = useRef(enabled);
  const sendRef = useRef(send);
  useEffect(() => {
    busyRef.current = busy;
    enabledRef.current = enabled;
    sendRef.current = send;
  });

  // The queue is built in an effect, so its ref reads stay out of render and
  // a StrictMode remount gets a live queue (a disposed queue never sends
  // again). A session change under a mounted screen disposes it and builds a
  // fresh one, so nothing queued or retrying for the old session goes out
  // through the new one's send.
  const queueRef = useRef<AppTutorUpdateQueue | null>(null);
  useEffect(() => {
    const queue = createAppTutorUpdateQueue({
      isStreaming: () => busyRef.current || !enabledRef.current,
      send: (batch) => sendRef.current(batch),
    });
    queueRef.current = queue;
    return () => {
      queue.reset();
      queue.dispose();
      queueRef.current = null;
    };
  }, [sessionId]);

  // The tutor just went idle (or this viewer became the owner): deliver
  // whatever waited behind the reply.
  useEffect(() => {
    if (!busy && enabled) void queueRef.current?.drain();
  }, [busy, enabled, sessionId]);

  return useMemo(
    () => ({
      onAskTutor: (request: AppTutorRequest) => {
        if (!enabledRef.current) return;
        queueRef.current?.enqueue({ kind: "ask", ...request });
        void queueRef.current?.drain();
      },
      onAppAiTurn: () => {
        if (!enabledRef.current) return;
        queueRef.current?.enqueue({ kind: "appAi" });
        void queueRef.current?.drain();
      },
      /** Call when the scholar sends a turn of their own. */
      clearAppAi: () => queueRef.current?.clearAppAi(),
    }),
    [],
  );
}

/**
 * The tutor's newest line, for a strip shown while the chat is closed. A line
 * counts as unread only if it arrived after this screen opened and after the
 * chat was last open. It stays up until the scholar next acts — opens the
 * chat, sends, taps an ask, or talks to the app's character (each host calls
 * `markRead`) — and never comes back after that. Silent app-update turns
 * leave no row, so they never produce or resurrect a strip.
 */
export function useUnreadTutorLine<
  T extends { id: string; role: string; content: string },
>({
  messages,
  loaded,
  chatOpen,
  streaming,
}: {
  /** The tutor thread as this screen shows it. */
  messages: readonly T[];
  /** The transcript query has resolved (so the first read is a baseline). */
  loaded: boolean;
  chatOpen: boolean;
  /** Hold the strip until the turn finishes, so it never shows a partial. */
  streaming: boolean;
}) {
  const latest = latestTutorLine(messages);
  const latestId = latest?.id ?? null;
  // undefined = no baseline yet. Adjusted during render (not in an effect) so
  // a line the scholar is already looking at never flashes as unread.
  const [seenId, setSeenId] = useState<string | null | undefined>(undefined);
  if (loaded && (seenId === undefined || (chatOpen && seenId !== latestId))) {
    setSeenId(latestId);
  }

  // markRead reaches hosts that may hold an older closure (the app frame's
  // bridge); it must mark the line on screen NOW, never an older one, which
  // would turn the current line back into an unread one.
  const latestIdRef = useRef(latestId);
  useEffect(() => {
    latestIdRef.current = latestId;
  });

  const unread =
    latest && seenId !== undefined && latestId !== seenId && !chatOpen && !streaming
      ? { id: latest.id, preview: tutorLinePreview(latest.content) }
      : null;
  return {
    unread,
    markRead: () => setSeenId(latestIdRef.current),
  };
}
