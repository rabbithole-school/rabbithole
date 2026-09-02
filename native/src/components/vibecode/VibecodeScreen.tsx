/**
 * VibecodeScreen — the native, Lovable-style "describe → generate a live app →
 * iterate" surface for a `sessionMode: "vibecode"` session (vibecode-spec.md).
 *
 * The app IS the session's newest HTML code artifact. We read the artifacts
 * reactively (`api.artifacts.getBySession`), pick the newest whose content looks
 * like HTML, and render it full-screen in a WebView. A bottom chat Drawer drives
 * the build: it reuses the native tutor STREAMING PATH verbatim in mechanism —
 * the same `api.sessions.sendMessage` mutation + `${convexSiteUrl}/project-stream`
 * SSE loop the session screen and SidelineTutorSheet stream through — so whispers,
 * teacher visibility, and observer wiring come for free.
 *
 * WEBVIEW NOTE: the app's canonical embedded-web host is `ExternalAppHost`, but
 * it is a URL-based, store-driven keep-alive singleton (`source={{ uri }}`,
 * cookie/session tracking, allowlists) — it has no path to render inline HTML we
 * hold in memory. So the live preview reuses its UNDERLYING WebView pattern (the
 * `WebView as any` + `source={{ html }}` idiom already established in
 * `app/dev-hdr-stars.tsx`) rather than hand-rolling a novel WebView config. The
 * host is keyed on the artifact id + a content hash so any edit_document str_replace
 * (which mutates the SAME artifact row) reliably reloads the preview.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { Stack } from "expo-router";
import { fetch as expoFetch } from "expo/fetch";
import * as Haptics from "expo-haptics";
import { SymbolView } from "expo-symbols";
import { useMutation, useQuery } from "convex/react";
import { useAuthToken } from "@convex-dev/auth/react";

import { Drawer } from "@/components/ui/Drawer";
import { ChatBubble } from "@/components/ChatBubble";
import { StreamingText } from "@/components/StreamingText";
import { CodeArtifactWebView } from "@/components/CodeArtifactWebView";
import { api, convexSiteUrl, type Id } from "@/lib/convex";
import { chatBubbleStyles, OPENER_SENTINEL } from "@/lib/chatBubbles";
import { friendlyToolName } from "@/lib/toolLabels";
import { fonts, useColors } from "@/theme";
import {
  CODE_TOOLS,
  newestHtmlArtifact,
} from "../../../vendor/vibecode/helpers";
import { AppTextInput } from "@/components/AppTextInput";

type VibecodeMessage = { id: string; role: string; content: string };
type TutorActivity =
  | { kind: "thinking" }
  | { kind: "tool"; label: string }
  | { kind: "image" };

export function VibecodeScreen({ sessionId }: { sessionId: Id<"sessions"> }) {
  const colors = useColors();
  // The canonical chat-turn metrics (shared with the scholar tutor chat) — used
  // for the in-flight streaming bubble; settled turns render via <ChatBubble>.
  const bubbleStyles = useMemo(() => chatBubbleStyles(colors), [colors]);
  const [chatOpen, setChatOpen] = useState(false);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [streamingText, setStreamingText] = useState("");
  const [activity, setActivity] = useState<TutorActivity | null>(null);
  const [wantsComposerFocus, setWantsComposerFocus] = useState(false);
  // True while a create_code / edit_document tool is in flight — drives the
  // preview "building…" overlay and the drawer badge.
  const [building, setBuilding] = useState(false);
  const scrollRef = useRef<ScrollView>(null);
  const composerRef = useRef<TextInput>(null);
  const authToken = useAuthToken();

  const sendMessage = useMutation(api.sessions.sendMessage);
  const data = useQuery(api.sessions.getWithMessages, { id: sessionId });
  const artifacts = useQuery(api.artifacts.getBySession, { sessionId });
  const me = useQuery(api.users.currentUser, {});
  const ttsEnabled = me?.ttsEnabled !== false;

  const headerTitle = data?.session?.title ?? "Build";

  const htmlArtifact = useMemo(
    () => newestHtmlArtifact(artifacts),
    [artifacts],
  );

  const messages: VibecodeMessage[] = (data?.messages ?? [])
    .filter((message) => (message as { notebookEntry?: unknown }).notebookEntry === undefined)
    // The hidden opener the client auto-sends is a protocol token, never a bubble.
    .filter((message) => message.content !== OPENER_SENTINEL)
    .map((message) => ({ id: message.id, role: message.role, content: message.content }));

  const handleSend = async () => {
    const text = input.trim();
    if (!text || streaming) return;
    setInput("");
    setStreaming(true);
    setStreamingText("");
    setActivity(null);
    try {
      const res = await sendMessage({
        sessionId,
        message: text,
        inputModality: "typed",
      });
      const resp = await expoFetch(`${convexSiteUrl}/project-stream`, {
        method: "POST",
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
              if (ev.thinking) setActivity({ kind: "thinking" });
              if (ev.toolStart?.name && ev.toolStart.name !== "generate_image") {
                setActivity({ kind: "tool", label: friendlyToolName(ev.toolStart.name) });
                if (CODE_TOOLS.has(ev.toolStart.name)) setBuilding(true);
              }
              if (ev.toolComplete?.name && ev.toolComplete.name !== "generate_image") {
                setActivity((a) => (a && a.kind === "tool" ? null : a));
                if (CODE_TOOLS.has(ev.toolComplete.name)) setBuilding(false);
              }
              if (ev.generatingImage === "started") setActivity({ kind: "image" });
              if (ev.generatedImage) setActivity((a) => (a && a.kind === "image" ? null : a));
              if (ev.text) {
                full += ev.text;
                setStreamingText(full);
                setActivity((a) => (a ? null : a));
              }
              if (ev.newAssistantMsg) full = "";
            } catch {
              // ignore non-JSON keepalive lines
            }
          }
        }
      }
    } catch (error) {
      console.warn("[vibecode] stream failed", error);
    } finally {
      setStreaming(false);
      setStreamingText("");
      setActivity(null);
      setBuilding(false);
    }
  };

  const toggleChat = () => {
    Haptics.selectionAsync();
    setChatOpen((open) => !open);
  };

  useEffect(() => {
    if (!chatOpen || !wantsComposerFocus) return;
    const frame = requestAnimationFrame(() => {
      composerRef.current?.focus();
      setWantsComposerFocus(false);
    });
    return () => cancelAnimationFrame(frame);
  }, [chatOpen, wantsComposerFocus]);

  return (
    <>
      <Stack.Screen
        options={{
          title: headerTitle,
          headerRight: () => (
            <Pressable
              onPress={toggleChat}
              hitSlop={10}
              accessibilityRole="button"
              accessibilityLabel="Chat with the app builder"
            >
              <SymbolView
                name="bubble.left.and.bubble.right.fill"
                size={26}
                tintColor={colors.violet}
              />
            </Pressable>
          ),
        }}
      />

      <View style={[styles.root, { backgroundColor: colors.bg }]}>
        {htmlArtifact ? (
          <View style={styles.previewWrap}>
            <CodeArtifactWebView
              key={htmlArtifact._id}
              artifactId={htmlArtifact._id}
              content={htmlArtifact.content}
              style={styles.webView}
            />
            {building ? (
              <View style={styles.buildingOverlay} pointerEvents="none">
                <View style={[styles.buildingPill, { backgroundColor: colors.violetSolid }]}>
                  <ActivityIndicator size="small" color={colors.white} />
                  <Text style={[styles.buildingText, { color: colors.white }]}>building…</Text>
                </View>
              </View>
            ) : null}
          </View>
        ) : (
          <View style={styles.empty}>
            <SymbolView
              name="hammer.fill"
              size={44}
              tintColor={colors.violet}
              style={styles.emptyIcon}
            />
            <Text style={[styles.emptyTitle, { color: colors.fg }]}>
              Describe the app you want to build
            </Text>
            <Text style={[styles.emptyBody, { color: colors.fgMuted }]}>
              Tell the builder your idea — a game, a story, a simulation — and it
              writes a live app right here. Then keep refining it.
            </Text>
            <Pressable
              onPress={() => {
                Haptics.selectionAsync();
                setChatOpen(true);
                setWantsComposerFocus(true);
              }}
              style={[styles.emptyCta, { backgroundColor: colors.violetSolid }]}
              accessibilityRole="button"
            >
              <Text style={[styles.emptyCtaText, { color: colors.white }]}>
                Start building
              </Text>
            </Pressable>
          </View>
        )}
      </View>

      <Drawer
        open={chatOpen}
        onClose={() => setChatOpen(false)}
        side="bottom"
        title="Build"
        eyebrow={building ? "building…" : "describe · critique · iterate"}
      >
        <View style={styles.chatBody}>
          <ScrollView
            ref={scrollRef}
            style={styles.thread}
            contentContainerStyle={styles.threadBody}
            onContentSizeChange={() => scrollRef.current?.scrollToEnd({ animated: true })}
          >
            {messages.length === 0 ? (
              <Text style={[styles.chatEmpty, { color: colors.fgMuted }]}>
                Describe the app you want to build — the builder writes it and you
                iterate.
              </Text>
            ) : (
              messages.map((message) => (
                <ChatBubble
                  key={message.id}
                  role={message.role}
                  content={message.content}
                  ttsEnabled={ttsEnabled}
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
                      {building
                        ? "building…"
                        : activity?.kind === "tool"
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
              ref={composerRef}
              value={input}
              onChangeText={setInput}
              placeholder="Describe or change the app…"
              placeholderTextColor={colors.fgMuted}
              style={[styles.input, { color: colors.fg, borderColor: colors.border }]}
              multiline
            />
            <Pressable
              onPress={handleSend}
              disabled={streaming || !input.trim()}
              style={[
                styles.send,
                { backgroundColor: streaming || !input.trim() ? colors.gray200 : colors.violetSolid },
              ]}
            >
              <Text style={[styles.sendText, { color: colors.white }]}>Send</Text>
            </Pressable>
          </View>
        </View>
      </Drawer>
    </>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  previewWrap: { flex: 1 },
  webView: { flex: 1, backgroundColor: "transparent" },
  buildingOverlay: {
    position: "absolute",
    top: 12,
    left: 0,
    right: 0,
    alignItems: "center",
  },
  buildingPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 999,
  },
  buildingText: { fontFamily: fonts.semibold, fontSize: 13 },

  empty: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 32,
    gap: 12,
  },
  emptyIcon: { marginBottom: 4 },
  emptyTitle: { fontFamily: fonts.bold, fontSize: 20, textAlign: "center" },
  emptyBody: {
    fontFamily: fonts.regular,
    fontSize: 15,
    lineHeight: 22,
    textAlign: "center",
  },
  emptyCta: {
    marginTop: 8,
    paddingHorizontal: 22,
    paddingVertical: 12,
    borderRadius: 14,
  },
  emptyCtaText: { fontFamily: fonts.semibold, fontSize: 15 },

  // Chat drawer — turns render via the shared <ChatBubble> (canonical navy
  // own-turn bubble, bare tutor voice, shared text scale).
  chatBody: { flex: 1 },
  thread: { flex: 1 },
  threadBody: { paddingVertical: 12, gap: 8 },
  chatEmpty: { fontFamily: fonts.regular, fontSize: 14 },
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
