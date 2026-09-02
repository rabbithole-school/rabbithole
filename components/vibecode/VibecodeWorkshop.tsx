"use client";

/**
 * VibecodeWorkshop — the WEB twin of the native `VibecodeScreen`.
 * A `sessionMode: "vibecode"` session, rendered PREVIEW-FIRST: the app IS the
 * session's newest HTML code artifact, shown live in a sandboxed iframe
 * center-stage (via the shared `CodeArtifactViewer`), with a chat panel that
 * drives the build.
 *
 * DRY / reuse: the chat reuses the SAME tutor streaming path as the scholar
 * session — `api.sessions.sendMessage` + `${convexSiteUrl}/project-stream` via
 * `useAgentStream` — so whispers, teacher visibility, and observer wiring come
 * for free, exactly as `SessionInterface` and native `VibecodeScreen` stream.
 * The only sanctioned difference from native is the surface skin (DOM iframe +
 * Chakra here vs react-native-webview + sheets there — the two-frontends split).
 *
 * Like native, there is NO auto-opener: the scholar starts by describing the app
 * (the empty state's CTA), and the activity's build brief lives in the system
 * prompt, so the builder responds in-context on the first turn.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Box,
  Button,
  Drawer,
  Flex,
  IconButton,
  Portal,
  Spinner,
  Text,
  Textarea,
  VStack,
  useBreakpointValue,
} from "@chakra-ui/react";
import { ChatCircle, Hammer, List, PaperPlaneRight, X } from "@phosphor-icons/react";
import { useMutation, useQuery } from "convex/react";

import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { useAgentStream, type StreamEvent } from "@/hooks/useAgentStream";
import { useSendLock } from "@/hooks/useSendLock";
import { convexSiteUrl } from "@/lib/convexUrls";
import { toaster } from "@/lib/toaster";
import { CodeArtifactViewer } from "@/components/CodeArtifactViewer";
import { flushAllArtifactSaves } from "@/components/ArtifactPanel";
import {
  SessionAssistantMessageBody,
  SessionStreamStatus,
  useReconciledSessionMessages,
} from "@/components/SessionTranscript";
import { EmptyState } from "@/components/ui/EmptyState";

/** Tools whose in-flight state means "the app is rebuilding". */
const CODE_TOOLS = new Set(["create_code", "edit_document"]);
/** The hidden protocol token a tutor session can auto-send; never a bubble. */
const OPENER = "<start>";

/** Does this artifact's content look like a renderable HTML document/fragment?
 *  Mirrors the native VibecodeScreen predicate so both surfaces pick the same
 *  artifact as "the app". */
function looksLikeHtml(content: string): boolean {
  const c = content.trimStart().toLowerCase();
  if (!c.includes("<")) return false;
  return (
    c.startsWith("<!doctype html") ||
    c.startsWith("<html") ||
    c.includes("<body") ||
    c.includes("<div") ||
    c.includes("<style") ||
    c.includes("<script") ||
    c.includes("<canvas") ||
    c.includes("<svg")
  );
}

type VibecodeMessage = { id: string; role: string; content: string };

export function VibecodeWorkshop({
  sessionId,
  onOpenSidebar,
}: {
  sessionId: Id<"sessions">;
  onOpenSidebar?: () => void;
}) {
  const data = useQuery(api.sessions.getWithMessages, { id: sessionId });
  const artifacts = useQuery(api.artifacts.getBySession, { sessionId });
  const sendMsg = useMutation(api.sessions.sendMessage);
  const saveArtifact = useMutation(api.artifacts.scholarUpdate);

  const isNarrow = useBreakpointValue({ base: true, lg: false }) ?? false;
  const [chatOpen, setChatOpen] = useState(false);
  const [input, setInput] = useState("");
  // True while a create_code / edit_document tool is in flight — drives the
  // preview "building…" overlay and the composer eyebrow.
  const [building, setBuilding] = useState(false);
  const [sending, setSending] = useState(false);
  const [wantsComposerFocus, setWantsComposerFocus] = useState(false);
  const runWithSendLock = useSendLock();
  const threadRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);

  const onEvent = useCallback((ev: StreamEvent) => {
    if (ev.toolStart?.name && CODE_TOOLS.has(ev.toolStart.name)) setBuilding(true);
    if (ev.toolComplete?.name && CODE_TOOLS.has(ev.toolComplete.name)) setBuilding(false);
    if (ev.done || ev.error) setBuilding(false);
  }, []);
  const stream = useAgentStream({ onEvent });
  const {
    streamingContent,
    streamingMsgId,
    isStreaming,
    toolActivity,
  } = stream;

  const title = data?.session?.title ?? "Build";

  // The app = the newest artifact whose content looks like HTML (never the map
  // artifact). Reactive: a create_code insert or an edit_document str_replace
  // both flow through here.
  const htmlArtifact = useMemo(() => {
    if (!artifacts) return null;
    let newest: (typeof artifacts)[number] | null = null;
    for (const a of artifacts) {
      if (a.type === "map") continue;
      if (!looksLikeHtml(a.content)) continue;
      if (!newest || a._creationTime > newest._creationTime) newest = a;
    }
    return newest;
  }, [artifacts]);

  const messages: VibecodeMessage[] = (data?.messages ?? [])
    .filter((m) => (m as { notebookEntry?: unknown }).notebookEntry === undefined)
    .filter((m) => m.role === "user" || m.role === "assistant")
    .filter((m) => m.content !== OPENER)
    .map((m) => ({ id: m.id, role: m.role, content: m.content }));
  const reconciledMessages = useReconciledSessionMessages({
    messages,
    streamingMsgId,
    streamingContent,
  });

  // Keep the thread pinned to the newest turn as content streams in.
  useEffect(() => {
    threadRef.current?.scrollTo({ top: threadRef.current.scrollHeight });
  }, [messages.length, streamingContent, isStreaming]);

  useEffect(() => {
    if (!chatOpen || !wantsComposerFocus) return;
    const frame = requestAnimationFrame(() => {
      composerRef.current?.focus();
      setWantsComposerFocus(false);
    });
    return () => cancelAnimationFrame(frame);
  }, [chatOpen, wantsComposerFocus]);

  const handleSend = async () => {
    const text = input.trim();
    if (!text || isStreaming) return;
    await runWithSendLock(async () => {
      try {
        await flushAllArtifactSaves();
      } catch (error) {
        console.error("[vibecode] document save blocked send", error);
        toaster.error({
          title: "Finish saving your app",
          description:
            "Choose an app version or retry its save before sending your message.",
        });
        return;
      }
      try {
        setSending(true);
        const result = await sendMsg({
          sessionId,
          message: text,
          inputModality: "typed",
        });
        setInput("");
        await stream.send(
          `${convexSiteUrl()}/project-stream`,
          {
            sessionId: result.sessionId,
            streamId: result.streamId,
            assistantMsgId: result.assistantMsgId,
          },
          result.assistantMsgId,
        );
      } catch (error) {
        console.error("[vibecode] stream failed", error);
      } finally {
        setSending(false);
        // The stream has settled (done, aborted, or dropped). useAgentStream does
        // NOT emit a terminal onEvent when the fetch itself fails, so clear the
        // build overlay here too — otherwise a stream dropped mid-build leaves it
        // stuck on "building…".
        setBuilding(false);
      }
    });
  };

  if (data === undefined) {
    return (
      <Flex
        flex={1}
        align="center"
        justify="center"
        bg="gray.50"
        role="status"
        aria-label="Loading the workshop"
      >
        <Spinner size="xl" color="violet.500" />
      </Flex>
    );
  }

  const thread = (
    <Flex flexDir="column" h="100%" minH={0}>
      <Box ref={threadRef} flex={1} minH={0} overflowY="auto" px={4} py={4}>
        {messages.length === 0 && !isStreaming ? (
          <Text fontSize="sm" fontFamily="heading" color="charcoal.400" px={1}>
            Describe the app you want to build — the builder writes it and you iterate.
          </Text>
        ) : (
          <VStack align="stretch" gap={3}>
            {reconciledMessages.map(({ message: m, isActiveStream }) =>
              m.role === "user" ? (
                <Flex key={m.id} justify="flex-end">
                  <Box
                    maxW="85%"
                    bg="navy.500"
                    color="white"
                    px={3.5}
                    py={2}
                    borderRadius="lg"
                    borderBottomRightRadius="sm"
                    fontSize="sm"
                    whiteSpace="pre-wrap"
                    wordBreak="break-word"
                  >
                    {m.content}
                  </Box>
                </Flex>
              ) : (
                <Box key={m.id} px={1} color="charcoal.600">
                  <SessionAssistantMessageBody
                    content={m.content}
                    isStreaming={isActiveStream && !!streamingContent}
                    fontSize="sm"
                  />
                </Box>
              ),
            )}
            <SessionStreamStatus
              isStreaming={isStreaming}
              streamingContent={streamingContent}
              toolActivity={toolActivity}
              scholarSafe
            />
          </VStack>
        )}
      </Box>

      <Flex
        px={3}
        py={3}
        gap={2}
        align="flex-end"
        borderTop="1px solid"
        borderColor="gray.200"
        flexShrink={0}
      >
        <Textarea
          ref={composerRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void handleSend();
            }
          }}
          placeholder="Describe or change the app…"
          rows={1}
          resize="none"
          fontSize="sm"
          maxH="120px"
          bg="white"
          borderColor="gray.300"
        />
        <IconButton
          aria-label="Send"
          colorPalette="violet"
          onClick={() => void handleSend()}
          disabled={isStreaming || sending || !input.trim()}
        >
          <PaperPlaneRight weight="fill" />
        </IconButton>
      </Flex>
    </Flex>
  );

  const header = (
    <Flex
      align="center"
      gap={2}
      px={3}
      py={2}
      borderBottom="1px solid"
      borderColor="gray.200"
      bg="white"
      flexShrink={0}
    >
      {onOpenSidebar && (
        <IconButton
          aria-label="Open menu"
          variant="ghost"
          size="sm"
          color="charcoal.500"
          onClick={onOpenSidebar}
        >
          <List />
        </IconButton>
      )}
      <Hammer weight="duotone" color="var(--chakra-colors-violet-500)" />
      <Text
        fontFamily="heading"
        fontWeight="600"
        color="navy.500"
        fontSize="sm"
        flex={1}
        lineClamp={1}
      >
        {title}
      </Text>
      <Button
        size="xs"
        variant={chatOpen ? "solid" : "outline"}
        colorPalette="violet"
        onClick={() => setChatOpen((open) => !open)}
      >
        <ChatCircle weight={chatOpen ? "fill" : "regular"} style={{ marginRight: 4 }} />
        {chatOpen ? "Hide chat" : "Chat"}
      </Button>
    </Flex>
  );

  const preview = htmlArtifact ? (
    // Must be a flex COLUMN: CodeArtifactViewer's root is `flex={1}`, which
    // collapses to content height inside a plain block Box — the "app cut
    // off at ~400px" bug. ArtifactPanel mounts the same viewer in a flex
    // parent for the same reason.
    <Flex position="relative" flexDir="column" flex={1} minH={0} minW={0} bg="white">
      <CodeArtifactViewer
        key={htmlArtifact._id}
        artifact={htmlArtifact}
        onSave={(updates) =>
          saveArtifact({
            artifactId: htmlArtifact._id,
            ...updates,
            baseRevision: updates.baseRevision ?? htmlArtifact.revision ?? 0,
          })
        }
      />
      {building && (
        <Flex position="absolute" top={3} left={0} right={0} justify="center" pointerEvents="none">
          <Flex
            align="center"
            gap={2}
            bg="violet.500"
            color="white"
            px={3.5}
            py={1.5}
            borderRadius="full"
            shadow="md"
          >
            <Spinner size="xs" />
            <Text fontSize="xs" fontFamily="heading" fontWeight="600">
              building…
            </Text>
          </Flex>
        </Flex>
      )}
    </Flex>
  ) : (
    <Flex flex={1} minH={0} align="center" justify="center" bg="gray.50" p={8}>
      <VStack gap={4} maxW="380px" textAlign="center">
        <EmptyState
          size="lg"
          icon={<Hammer weight="duotone" />}
          title="Describe the app you want to build"
          hint="Tell the builder your idea — a game, a story, a simulation — and it writes a live app right here. Then keep refining it."
        />
        <Button
          colorPalette="violet"
          onClick={() => {
            setChatOpen(true);
            setWantsComposerFocus(true);
          }}
        >
          Start building
        </Button>
      </VStack>
    </Flex>
  );

  return (
    <Flex flexDir="column" flex={1} minH={0} minW={0}>
      {header}
      {isNarrow ? (
        <>
          {preview}
          <Drawer.Root open={chatOpen} onOpenChange={(e) => setChatOpen(e.open)} placement="bottom">
            <Portal>
              <Drawer.Backdrop />
              <Drawer.Positioner>
                <Drawer.Content bg="white" h="70vh" roundedTop="lg">
                  <Flex align="center" px={4} py={2} borderBottom="1px solid" borderColor="gray.200">
                    <Text fontFamily="heading" fontWeight="600" color="navy.500" fontSize="sm" flex={1}>
                      Build
                    </Text>
                    <IconButton
                      aria-label="Close chat"
                      variant="ghost"
                      size="sm"
                      onClick={() => setChatOpen(false)}
                    >
                      <X />
                    </IconButton>
                  </Flex>
                  <Box flex={1} minH={0}>
                    {thread}
                  </Box>
                </Drawer.Content>
              </Drawer.Positioner>
            </Portal>
          </Drawer.Root>
        </>
      ) : (
        <Flex flex={1} minH={0}>
          {preview}
          {chatOpen && (
            <Box
              w="380px"
              flexShrink={0}
              borderLeft="1px solid"
              borderColor="gray.200"
              minH={0}
              bg="white"
            >
              {thread}
            </Box>
          )}
        </Flex>
      )}
    </Flex>
  );
}
