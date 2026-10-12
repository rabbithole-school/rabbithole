import { useCallback, useEffect, useRef, useState } from "react";
import { useMutation, usePaginatedQuery } from "convex/react";
import { useAuthToken } from "@convex-dev/auth/react";
import { fetch as expoFetch } from "expo/fetch";

import { api, convexSiteUrl, type Id } from "@/lib/convex";
import { friendlyToolName } from "@/lib/toolLabels";
import type { ChatActivity } from "@/components/ChatActivityRow";

// The empty-thread opener sentinel — the SAME mechanism the session tutor uses
// (see components/SessionInterface.tsx auto-<start>). /meta-stream builds its
// turns from the persisted non-empty messages, so sending "<start>" makes the
// bot open; the UI filters it out of the transcript.
const OPENER_SENTINEL = "<start>";

export type ReflectionBubble = {
  key: string;
  role: "user" | "assistant";
  content: string;
  streamId: string | null;
  stopRequestedAt?: number;
};

/**
 * The Workshop chat, native side. Owns either today's reflection or the
 * standing Ask Rabbithole thread, the live message list, and the SSE turn —
 * reusing the exact expo/fetch + `data:` SSE reader the session chat uses
 * (native/src/app/session/[id].tsx). One turn at a time; the composer stays
 * disabled while `streaming`.
 */
export function useReflectionChat(
  purpose: "reflection" | "introspection" = "reflection",
) {
  const authToken = useAuthToken();
  const getOrCreateToday = useMutation(api.metaChat.getOrCreateToday);
  const getOrCreateIntrospection = useMutation(
    api.metaChat.getOrCreateIntrospection,
  );
  const sendMessageMut = useMutation(api.metaChat.sendMessage);
  const requestStopMut = useMutation(api.metaChat.requestStop);

  const [chatId, setChatId] = useState<Id<"metaChats"> | null>(null);
  const {
    results: messages,
    status: messageStatus,
    loadMore,
  } = usePaginatedQuery(
    api.metaChat.listMessages,
    chatId ? { chatId } : "skip",
    { initialNumItems: 40 },
  );

  const [streaming, setStreaming] = useState(false);
  const [streamingText, setStreamingText] = useState("");
  const [liveAssistantId, setLiveAssistantId] = useState<string | null>(null);
  // The transient "activity" shown while the bot works before its reply starts
  // — an extended-thinking pause or a Code Explorer tool call. Mirrors the web
  // AideThread's inline tool row; cleared the moment text streams (see below).
  const [activity, setActivity] = useState<ChatActivity | null>(null);

  const creatingRef = useRef(false);
  const openerSentRef = useRef(false);
  // Aborts the in-flight /meta-stream reader on Stop / steer. A turn-seq guard
  // keeps an aborted (steered-away) turn's cleanup from clobbering the turn that
  // replaced it; a streaming ref reads the live flag synchronously.
  const abortRef = useRef<AbortController | null>(null);
  const turnSeqRef = useRef(0);
  const streamingRef = useRef(false);
  // The assistant metaMessage row currently streaming — the requestStop target.
  const liveAssistantIdRef = useRef<string | null>(null);
  // Set by Stop regardless of whether the assistant id is known yet, so a Stop
  // tapped during the pre-mutation window is honored once the row exists.
  const stopRequestedRef = useRef(false);
  // Whether the live assistant row has actually been seen in the query yet. The
  // release effect must not treat an ABSENT row as "the empty stop row was
  // reaped" until it was first observed — otherwise a not-yet-propagated query
  // clears the held partial immediately.
  const liveRowObservedRef = useRef(false);

  // Resolve today's thread once on mount (day flips at local midnight in the
  // block's tz — handled server-side).
  useEffect(() => {
    if (chatId || creatingRef.current) return;
    creatingRef.current = true;
    const resolve =
      purpose === "reflection"
        ? getOrCreateToday({})
        : getOrCreateIntrospection({});
    resolve
      .then((r) => setChatId(r.chatId))
      .catch((e) => console.warn("[meta] getOrCreate failed", e))
      .finally(() => {
        creatingRef.current = false;
      });
  }, [chatId, getOrCreateIntrospection, getOrCreateToday, purpose]);

  const runTurn = useCallback(
    async (content: string) => {
      if (!chatId) return;
      // Steer: a send while a reply is streaming stops it first, then sends.
      if (streamingRef.current) {
        if (liveAssistantIdRef.current) {
          void requestStopMut({
            messageId: liveAssistantIdRef.current as Id<"metaMessages">,
          }).catch((e) => console.warn("[meta] requestStop failed", e));
        }
        abortRef.current?.abort();
      }
      const myTurn = ++turnSeqRef.current;
      const controller = new AbortController();
      abortRef.current = controller;
      stopRequestedRef.current = false;
      let aborted = false;
      setStreaming(true);
      streamingRef.current = true;
      setStreamingText("");
      setActivity(null);
      try {
        const res = await sendMessageMut({ chatId, content });
        setLiveAssistantId(res.assistantMsgId);
        liveAssistantIdRef.current = res.assistantMsgId;
        liveRowObservedRef.current = false;
        // A Stop tapped during the pre-mutation window: the assistant row now
        // exists, so finalize it server-side and skip the (already-aborted)
        // fetch. There is no partial to preserve, so let the finally clear.
        if (stopRequestedRef.current || controller.signal.aborted) {
          void requestStopMut({
            messageId: res.assistantMsgId as Id<"metaMessages">,
          }).catch((e) => console.warn("[meta] requestStop failed", e));
          return;
        }
        // Stream the bot's reply. A failure HERE is not message loss — the
        // scholar turn is already persisted and the reactive query will show
        // the reply once the server finishes it — so we only log.
        try {
          const resp = await expoFetch(`${convexSiteUrl}/meta-stream`, {
            method: "POST",
            signal: controller.signal,
            headers: {
              "Content-Type": "application/json",
              ...(authToken ? { Authorization: "Bearer " + authToken } : {}),
            },
            body: JSON.stringify({
              chatId,
              assistantMsgId: res.assistantMsgId,
            }),
          });
          const reader = resp.body?.getReader();
          const decoder = new TextDecoder();
          let full = "";
          if (reader) {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              for (const line of decoder.decode(value).split("\n")) {
                if (!line.startsWith("data: ")) continue;
                try {
                  const ev = JSON.parse(line.slice(6));
                  if (ev.thinking) {
                    setActivity({ kind: "thinking" });
                  }
                  if (ev.toolStart?.name) {
                    setActivity({
                      kind: "tool",
                      label: friendlyToolName(ev.toolStart.name),
                    });
                  }
                  if (ev.text) {
                    full += ev.text;
                    setStreamingText(full);
                    // The reply has begun — the activity row disappears.
                    setActivity((a) => (a ? null : a));
                  }
                } catch {
                  // ignore non-JSON keepalive lines
                }
              }
            }
          }
          // Let the persisted row catch up before handing off to the settled
          // render, so the swap from streaming text is seamless.
          await new Promise((r) => setTimeout(r, 320));
        } catch (streamErr) {
          if ((streamErr as Error)?.name === "AbortError") {
            aborted = true;
          } else {
            console.warn("[meta-stream] failed", streamErr);
          }
        }
      } catch (e) {
        // The mutation itself failed → the turn was not saved. Re-throw so the
        // composer can restore the scholar's text.
        console.warn("[meta send] failed", e);
        throw e;
      } finally {
        // Only the turn that still owns the stream resets shared state. On a
        // user-initiated Stop (aborted) we keep the partial text + live id on
        // screen — the finalized row lands via the reactive query.
        if (turnSeqRef.current === myTurn) {
          setStreaming(false);
          streamingRef.current = false;
          if (!aborted) {
            setStreamingText("");
            setLiveAssistantId(null);
            liveAssistantIdRef.current = null;
          }
          setActivity(null);
          if (abortRef.current === controller) abortRef.current = null;
        }
      }
    },
    [chatId, sendMessageMut, authToken, requestStopMut],
  );

  // Stop the in-flight reply: ask the server to finalize at the current partial,
  // then abort the local reader. The partial stays on screen (see runTurn's
  // finally) until the finalized row lands.
  const stop = useCallback(() => {
    stopRequestedRef.current = true;
    if (liveAssistantIdRef.current) {
      void requestStopMut({
        messageId: liveAssistantIdRef.current as Id<"metaMessages">,
      }).catch((e) => console.warn("[meta] requestStop failed", e));
    }
    abortRef.current?.abort();
  }, [requestStopMut]);

  // After a user Stop, runTurn's finally holds the partial on screen (keeps
  // streamingText + liveAssistantId) instead of clearing it. Release the hold
  // once the server-finalized row lands (streamId cleared) — or the empty-stop
  // row is dropped — so the bubble settles into its finalized content + the
  // muted "Stopped" caption. A normal turn clears liveAssistantId in its finally,
  // so this is a no-op there.
  useEffect(() => {
    if (streaming || !liveAssistantId) return;
    const release = () => {
      setStreamingText("");
      setLiveAssistantId(null);
      liveAssistantIdRef.current = null;
      liveRowObservedRef.current = false;
    };
    const row = messages.find((m) => m._id === liveAssistantId);
    if (row) {
      liveRowObservedRef.current = true;
      // Finalized (server cleared streamId) → hand off to the settled render.
      if (row.streamId == null) release();
    } else if (liveRowObservedRef.current) {
      // The row was seen streaming and is now gone (the empty stop row was
      // reaped) → release. An absent row that was NEVER observed just means the
      // query hasn't propagated the insert yet, so we keep holding the partial.
      release();
    }
  }, [messages, streaming, liveAssistantId]);

  // Empty-thread opener: fire the <start> turn exactly once when today's thread
  // has no messages yet (matches the session tutor's auto-greeting). Deferred a
  // tick so the streaming setState doesn't run synchronously inside the effect.
  useEffect(() => {
    if (!chatId || streaming || openerSentRef.current) return;
    if (messageStatus === "LoadingFirstPage") return;
    if (messages.length === 0) {
      openerSentRef.current = true;
      const t = setTimeout(() => {
        void runTurn(OPENER_SENTINEL);
      }, 0);
      return () => clearTimeout(t);
    }
  }, [chatId, messageStatus, messages, streaming, runTurn]);

  const send = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed) return;
      await runTurn(trimmed);
    },
    [runTurn],
  );

  const bubbles: ReflectionBubble[] = [...messages]
    .reverse()
    .filter((m) => !(m.role === "user" && m.content === OPENER_SENTINEL))
    .map((m) => ({
      key: m._id,
      role: m.role,
      content: m.content,
      streamId: m.streamId,
      stopRequestedAt: (m as { stopRequestedAt?: number }).stopRequestedAt,
    }));

  return {
    /** True once today's thread id is resolved. */
    ready: chatId !== null,
    /** True while the initial message list is loading. */
    loading: messageStatus === "LoadingFirstPage",
    bubbles,
    streaming,
    streamingText,
    liveAssistantId,
    /** The transient tool/thinking status for the in-flight turn, or null. */
    activity,
    canLoadMore: messageStatus === "CanLoadMore",
    loadMore: () => loadMore(40),
    send,
    /** Stop the in-flight reply (keeps the partial visible). */
    stop,
  };
}
