// Native twin of web's hooks/useAppTutorUpdates.ts — the client half of "one
// queue to the tutor" for the screens that host an app (session/[id].tsx,
// VibecodeScreen). The queue itself (coalescing, held/busy retention, the
// character-update floor) is the vendored pure module; this hook binds it to
// React: latest-value refs for the host's turn state and send function, a
// drain whenever the tutor goes idle, and a drain whenever the queue grows.

import { useEffect, useMemo, useRef, useState } from "react";

import {
  createAppTutorUpdateQueue,
  latestTutorLine,
  tutorLinePreview,
  type AppTutorRequest,
  type AppTutorSendResult,
  type AppTutorUpdateBatch,
  type AppTutorUpdateQueue,
} from "../../vendor/shared/appTutorRequest";

export function useAppTutorUpdates({
  sessionId,
  enabled,
  busy,
  send,
}: {
  /**
   * A screen that stays mounted across a session change (a route param
   * update) gets a fresh queue, so nothing queued or retrying for the old
   * session goes out through the new one's send.
   */
  sessionId: string;
  /** Only the session OWNER's client may start tutor turns. */
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

  // The queue is built in an effect, so its ref reads stay out of render. A
  // session change under a mounted screen (a route param update) disposes it
  // and builds a fresh one, so nothing queued or retrying for the old session
  // goes out through the new one's send.
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
 * The tutor's newest line, for the strip shown while the chat drawer is
 * closed. Unread only if it arrived after this screen opened and after the
 * drawer was last open. It stays up until the scholar next acts — opens the
 * drawer, sends, taps an ask, or talks to the app's character (each host
 * calls `markRead`) — and never comes back after that. Silent app-update
 * turns leave no row, so they never produce or resurrect a strip.
 */
export function useUnreadTutorLine<
  T extends { id: string; role: string; content: string },
>({
  messages,
  loaded,
  chatOpen,
  streaming,
}: {
  messages: readonly T[];
  loaded: boolean;
  chatOpen: boolean;
  streaming: boolean;
}) {
  const latest = latestTutorLine(messages);
  const latestId = latest?.id ?? null;
  const [seenId, setSeenId] = useState<string | null | undefined>(undefined);
  if (loaded && (seenId === undefined || (chatOpen && seenId !== latestId))) {
    setSeenId(latestId);
  }

  // markRead reaches the WebView bridge, which may hold an older closure; it
  // must mark the line on screen NOW, never an older one (which would turn
  // the current line back into an unread one).
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
