/**
 * The demoted sideline tutor (plan §7.1, §4.1). The bench IS a session, so this
 * reuses the native chat STREAMING PATH verbatim — the same `sendMessage`
 * mutation + `${convexSiteUrl}/session-stream` SSE the session screen streams
 * through, rendered with the same `StreamingText` / `Markdown` primitives — which
 * brings whispers, teacher visibility, and observer wiring for free.
 *
 * ANTI-OFFLOADING: the tutor can question and stream, but has ZERO path that
 * writes the prompt deck. That absence IS the enforcement (the backend omits the
 * tool too); the line "reply ▸ can't edit your deck" makes the boundary legible.
 * Do NOT add an "apply to deck" affordance here, ever.
 *
 * (Chosen over lifting the session screen's chat block into a shared component —
 * that edits a large file another lane owns and risks chat regressions; the
 * extraction is flagged as follow-up in the Stage-E report.)
 */

import { useEffect, useMemo, useRef, useState } from "react";
import {
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { fetch as expoFetch } from "expo/fetch";
import { useMutation, useQuery } from "convex/react";
import { useAuthToken } from "@convex-dev/auth/react";

import { Sheet } from "./Sheet";
import { ChatBubble } from "@/components/ChatBubble";
import { StreamingText } from "@/components/StreamingText";
import { SymbolView } from "expo-symbols";
import { api, convexSiteUrl, type Id } from "@/lib/convex";
import { chatBubbleStyles, OPENER_SENTINEL } from "@/lib/chatBubbles";
import { composerPayloadKey } from "@/lib/sendLock";
import { friendlyToolName } from "@/lib/toolLabels";
import { tutorStreamErrorMessage } from "@/lib/tutorStreamError";
import { fonts, useColors } from "@/theme";
import { AppTextInput } from "@/components/AppTextInput";

type TutorMessage = {
  id: string;
  role: string;
  content: string;
  stopRequestedAt?: number;
};
type TutorActivity =
  | { kind: "thinking" }
  | { kind: "tool"; label: string }
  | { kind: "image" };

export function SidelineTutorSheet({
  sessionId,
  open,
  onClose,
}: {
  sessionId: Id<"sessions">;
  open: boolean;
  onClose: () => void;
}) {
  const colors = useColors();
  const bubbleStyles = useMemo(() => chatBubbleStyles(colors), [colors]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [streamingText, setStreamingText] = useState("");
  const [activity, setActivity] = useState<TutorActivity | null>(null);
  const scrollRef = useRef<ScrollView>(null);
  const authToken = useAuthToken();
  // Aborts the in-flight tutor stream on Stop / steer. The turn-seq guard keeps
  // an aborted turn's cleanup from clobbering the turn that replaced it.
  const abortRef = useRef<AbortController | null>(null);
  const turnSeqRef = useRef(0);
  // The composer text of the send most recently dispatched — null once the
  // scholar has typed since. handleSend clears the composer synchronously,
  // but `setInput("")` commits on a LATER task, so for a frame the
  // already-rendered submit handler still closes over the old text and a
  // repeated Return would send it again (the duplicate the session screen
  // fixed in #3808). Comparing the submitted text against this stamp makes
  // that resubmit a no-op; typing clears it, so a genuinely retyped identical
  // answer still sends. No in-flight send lock is needed here: the clear is
  // synchronous, so the commit gap is the only window.
  const sentComposerRef = useRef<string | null>(null);
  const liveAssistantIdRef = useRef<string | null>(null);
  // Set by Stop regardless of whether the assistant id is known yet, so a Stop
  // tapped during the pre-mutation window is honored once the row exists.
  const stopRequestedRef = useRef(false);

  const sendMessage = useMutation(api.sessions.sendMessage);
  const requestStop = useMutation(api.sessions.requestStop);
  const data = useQuery(api.sessions.getWithMessages, open ? { id: sessionId } : "skip");
  const me = useQuery(api.users.currentUser, open ? {} : "skip");
  const ttsEnabled = me?.ttsEnabled !== false;

  // Notebook entries are also stored as messages; the tutor thread shows only
  // real conversation, never the Notebook rows.
  const messages: TutorMessage[] = (data?.messages ?? [])
    .filter((message) => (message as { notebookEntry?: unknown }).notebookEntry === undefined)
    // The hidden opener the client auto-sends is a protocol token, never a bubble.
    .filter((message) => message.content !== OPENER_SENTINEL)
    .map((message) => ({
      id: message.id,
      role: message.role,
      content: message.content,
      stopRequestedAt: (message as { stopRequestedAt?: number }).stopRequestedAt,
    }));

  useEffect(() => {
    scrollRef.current?.scrollToEnd({ animated: true });
  }, [messages.length, streamingText]);

  // Stop the in-flight reply: ask the server to finalize at the current partial,
  // then abort the local reader. The partial stays on screen — the finalized row
  // lands via the reactive query within ≤1.5s.
  const stopStream = () => {
    stopRequestedRef.current = true;
    if (liveAssistantIdRef.current) {
      void requestStop({ sessionId }).catch((e) =>
        console.warn("[tutor sheet] requestStop failed", e),
      );
    }
    abortRef.current?.abort();
  };

  const onChangeInput = (next: string) => {
    // Any edit means the box is no longer the send just dispatched.
    sentComposerRef.current = null;
    setInput(next);
  };

  const handleSend = async () => {
    const text = input.trim();
    if (!text) return;
    // An untouched composer still holding the send just dispatched is a
    // stale-closure resubmit, not a new turn (see sentComposerRef).
    const composerSnapshot = composerPayloadKey(text, null);
    if (sentComposerRef.current === composerSnapshot) return;
    // Steer: a send while a reply is streaming stops it first, then sends.
    if (streaming) stopStream();
    const myTurn = ++turnSeqRef.current;
    const controller = new AbortController();
    abortRef.current = controller;
    stopRequestedRef.current = false;
    setInput("");
    // Synchronous, unlike setInput — this is what closes the commit gap.
    sentComposerRef.current = composerSnapshot;
    setStreaming(true);
    setStreamingText("");
    setActivity(null);
    try {
      const res = await sendMessage({
        sessionId,
        message: text,
        inputModality: "typed",
      });
      liveAssistantIdRef.current = res.assistantMsgId;
      // A Stop tapped during the pre-mutation window: the assistant row now
      // exists, so finalize it server-side and skip the (already-aborted) fetch.
      if (stopRequestedRef.current || controller.signal.aborted) {
        void requestStop({ sessionId }).catch((e) =>
          console.warn("[tutor sheet] requestStop failed", e),
        );
        return;
      }
      const resp = await expoFetch(`${convexSiteUrl}/session-stream`, {
        method: "POST",
        signal: controller.signal,
        headers: {
          "Content-Type": "application/json",
          ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
        },
        body: JSON.stringify({
          sessionId: res.sessionId,
          streamId: res.streamId,
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
              // Tool/thinking/image activity → the quiet inline status row, exactly
              // as the native session chat renders it. Tool RESULT strings are never
              // surfaced (they can be raw developer failures a scholar must not see).
              if (ev.thinking) setActivity({ kind: "thinking" });
              if (ev.toolStart?.name && ev.toolStart.name !== "generate_image") {
                setActivity({ kind: "tool", label: friendlyToolName(ev.toolStart.name) });
              }
              if (ev.toolComplete?.name && ev.toolComplete.name !== "generate_image") {
                setActivity((a) => (a && a.kind === "tool" ? null : a));
              }
              if (ev.generatingImage === "started") setActivity({ kind: "image" });
              if (ev.generatedImage) setActivity((a) => (a && a.kind === "image" ? null : a));
              if (ev.text) {
                full += ev.text;
                setStreamingText(full);
                setActivity((a) => (a ? null : a));
              }
              if (ev.newAssistantMsg) {
                liveAssistantIdRef.current = ev.newAssistantMsg;
                full = "";
              }
              if (ev.error) {
                Alert.alert("Rabbithole", tutorStreamErrorMessage(ev.error));
              }
            } catch {
              // ignore non-JSON keepalive lines
            }
          }
        }
      }
    } catch (error) {
      if ((error as Error)?.name !== "AbortError") {
        console.warn("[tutor sheet] stream failed", error);
      }
    } finally {
      // Only the turn that still owns the stream resets shared UI state.
      if (turnSeqRef.current === myTurn) {
        setStreaming(false);
        setStreamingText("");
        setActivity(null);
        liveAssistantIdRef.current = null;
        if (abortRef.current === controller) abortRef.current = null;
      }
    }
  };

  // The open trigger lives in the header (CriterionBar), a sibling of the
  // Notebook toggle — not a floating FAB. This sheet is purely controlled, and
  // presents through the shared right-edge Drawer (swipe-right to dismiss).
  return (
    <Sheet
      open={open}
      onClose={onClose}
      side="right"
      title="Tutor"
      eyebrow="sideline · can't edit your deck"
    >
      <View style={styles.body}>
        <ScrollView ref={scrollRef} style={styles.thread} contentContainerStyle={styles.threadBody}>
          {messages.length === 0 ? (
            <Text style={[styles.empty, { color: colors.fgMuted }]}>
              ask the tutor about what you saw — it won&apos;t touch your deck.
            </Text>
          ) : (
            messages.map((message) => (
              <ChatBubble
                key={message.id}
                role={message.role}
                content={message.content}
                ttsEnabled={ttsEnabled}
                stopRequestedAt={message.stopRequestedAt}
              />
            ))
          )}
          {streaming ? (
            <View style={styles.streamRow}>
              <View style={bubbleStyles.tutorBare}>
                {streamingText ? (
                  <StreamingText
                    content={streamingText}
                    done={false}
                    color={colors.charcoal}
                    style={bubbleStyles.bubbleText}
                  />
                ) : (
                  <Text style={[bubbleStyles.bubbleText, { color: colors.charcoalSubtle }]}>
                    {activity?.kind === "tool"
                      ? activity.label
                      : activity?.kind === "image"
                        ? "Making a picture…"
                        : "Thinking…"}
                  </Text>
                )}
              </View>
            </View>
          ) : null}
        </ScrollView>

        <View style={[styles.composer, { borderTopColor: colors.border }]}>
          <AppTextInput
            value={input}
            onChangeText={onChangeInput}
            placeholder="reply to the tutor…"
            placeholderTextColor={colors.fgMuted}
            style={[styles.input, { color: colors.fg, borderColor: colors.border }]}
            multiline
            submitBehavior="submit"
            onSubmitEditing={handleSend}
          />
          <Pressable
            onPress={streaming ? stopStream : handleSend}
            disabled={!streaming && !input.trim()}
            accessibilityRole="button"
            accessibilityLabel={streaming ? "Stop generating" : "Send"}
            style={[
              styles.send,
              {
                backgroundColor:
                  !streaming && !input.trim() ? colors.gray200 : colors.violetSolid,
              },
            ]}
          >
            {streaming ? (
              <SymbolView name="stop.fill" size={16} tintColor={colors.white} />
            ) : (
              <Text style={[styles.sendText, { color: colors.white }]}>Send</Text>
            )}
          </Pressable>
        </View>
      </View>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  // Fills the shared Drawer body (which already supplies horizontal padding):
  // a flexing thread above a pinned composer.
  body: { flex: 1 },
  thread: { flex: 1 },
  threadBody: { paddingVertical: 12, gap: 8 },
  empty: { fontFamily: fonts.regular, fontSize: 14 },
  streamRow: { flexDirection: "row" },
  composer: {
    flexDirection: "row",
    alignItems: "flex-end",
    gap: 8,
    paddingVertical: 10,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  input: {
    flex: 1,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 8,
    fontFamily: fonts.regular,
    fontSize: 14,
    maxHeight: 90,
  },
  send: { paddingHorizontal: 16, paddingVertical: 10, borderRadius: 12 },
  sendText: { fontFamily: fonts.semibold, fontSize: 14 },
});
