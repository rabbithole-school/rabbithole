"use client";

/**
 * The demoted sideline tutor. The bench IS a session, so this reuses the exact
 * streaming chassis the chat uses — `useAgentStream` posting to `/session-stream`
 * — which brings whispers, teacher visibility, and observer wiring for free.
 *
 * ANTI-OFFLOADING (plan §7.1, §4.1): the tutor can question and stream, but has
 * ZERO path that writes the prompt deck. That absence IS the enforcement; the
 * affordance line "reply ▸ (cannot edit your deck)" makes the boundary legible.
 * Do not add an "apply to deck" button here, ever.
 */

import { memo, useEffect, useRef, useState } from "react";
import { useMutation } from "convex/react";
import { Box, Button, Flex, HStack, Text, Textarea } from "@chakra-ui/react";
import { Square, X } from "@phosphor-icons/react";

import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { convexSiteUrl } from "@/lib/convexUrls";
import { useAgentStream } from "@/hooks/useAgentStream";
import { useCachedQuery } from "@/hooks/useCachedQuery";
import { MarkdownBlock, StreamingMarkdown } from "@/components/StreamingMarkdown";
import { ToolActivityIndicator } from "@/components/ToolActivityIndicator";

function Bubble({
  role,
  content,
  streaming,
  stopRequestedAt,
}: {
  role: string;
  content: string;
  streaming?: boolean;
  stopRequestedAt?: number;
}) {
  const isUser = role === "user";
  return (
    <Flex flexDir="column" align={isUser ? "flex-end" : "flex-start"}>
      <Box
        maxW="85%"
        px={3}
        py={2}
        borderRadius="lg"
        bg={isUser ? "violet.500" : "gray.100"}
        color={isUser ? "white" : "charcoal.600"}
        fontSize="sm"
        css={{ "& p": { margin: 0 }, "& p + p": { marginTop: "0.5em" } }}
      >
        {isUser ? (
          <Text whiteSpace="pre-wrap">{content}</Text>
        ) : streaming ? (
          <StreamingMarkdown content={content} />
        ) : (
          // Parity with the native tutor: assistant replies render Markdown
          // (review Finding 7), not plain text.
          <MarkdownBlock content={content} />
        )}
      </Box>
      {/* A finalized assistant reply the user cut short shows a muted caption. */}
      {!isUser && !streaming && stopRequestedAt !== undefined ? (
        <Text fontSize="xs" color="fg.muted" fontFamily="heading" mt={1}>
          Stopped
        </Text>
      ) : null}
    </Flex>
  );
}

export const SidelineTutorDrawer = memo(function SidelineTutorDrawer({
  sessionId,
  open,
  onClose,
}: {
  sessionId: Id<"sessions">;
  open: boolean;
  onClose: () => void;
}) {
  const [input, setInput] = useState("");
  const stream = useAgentStream();
  const sendMsg = useMutation(api.sessions.sendMessage);
  const requestStop = useMutation(api.sessions.requestStop);
  const scrollRef = useRef<HTMLDivElement>(null);

  const sessionData = useCachedQuery(
    api.sessions.getWithMessages,
    open ? { id: sessionId } : "skip",
    null,
  );
  // Notebook entries are also stored as messages; the tutor thread shows only
  // real conversation, never the Notebook rows.
  const messages = (sessionData?.messages ?? []).filter(
    (message: { notebookEntry?: unknown }) => message.notebookEntry === undefined,
  );

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages.length, stream.streamingContent]);

  const handleSend = async () => {
    const text = input.trim();
    if (!text) return;
    setInput("");
    // Steering: sending while the tutor streams stops the current reply
    // (server loop + local fetch) and replaces it with this turn.
    if (stream.isStreaming) {
      void requestStop({ sessionId });
      void stream.stop();
    }
    try {
      const result = await sendMsg({
        sessionId,
        message: text,
        inputModality: "typed",
      });
      await stream.send(
        `${convexSiteUrl()}/session-stream`,
        {
          sessionId: result.sessionId,
          streamId: result.streamId,
          assistantMsgId: result.assistantMsgId,
        },
        result.assistantMsgId,
      );
    } catch (error) {
      console.error("tutor send failed", error);
    }
  };

  // The composer's Stop control: stop the server loop AND abort the local
  // fetch, keeping the partial text on screen.
  const handleStop = () => {
    void requestStop({ sessionId });
    void stream.stop();
  };

  if (!open) {
    // The trigger now lives in the header (CriterionBar), next to History —
    // one canonical placement. This surface is controlled by the parent.
    return null;
  }

  return (
    <Flex
      position="absolute"
      bottom={4}
      right={4}
      w={{ base: "calc(100% - 32px)", md: "360px" }}
      h="440px"
      maxH="calc(100% - 32px)"
      flexDir="column"
      bg="white"
      borderWidth="1px"
      borderColor="gray.200"
      borderRadius="xl"
      shadow="lg"
      overflow="hidden"
    >
      <Flex align="center" justify="space-between" px={3} py={2} borderBottom="1px solid" borderColor="gray.200">
        <Box>
          <Text fontSize="xs" fontWeight="700" color="charcoal.600" letterSpacing="0.04em">
            TUTOR · sideline
          </Text>
          <Text fontSize="2xs" color="gray.400">
            reply ▸ (cannot edit your deck)
          </Text>
        </Box>
        <Button size="xs" variant="ghost" onClick={onClose} aria-label="Close tutor">
          <X />
        </Button>
      </Flex>

      <Box ref={scrollRef} flex={1} minH={0} overflowY="auto" p={3}>
        <Flex flexDir="column" gap={2}>
          {messages.length === 0 ? (
            <Text fontSize="sm" color="gray.400">
              ask the tutor about what you saw — it won&apos;t touch your deck.
            </Text>
          ) : (
            messages.map((message: { id: string; role: string; content: string; stopRequestedAt?: number }) => (
              <Bubble
                key={message.id}
                role={message.role}
                content={message.content}
                stopRequestedAt={message.stopRequestedAt}
              />
            ))
          )}
          {/* Tool activity — the tutor's actions are visible, not silently
              dropped (review Finding 7). Scholar-safe screening applies. */}
          {stream.isStreaming && stream.toolActivity.length > 0 ? (
            <ToolActivityIndicator toolActivity={stream.toolActivity} scholarSafe />
          ) : null}
          {stream.isStreaming ? (
            stream.streamingContent ? (
              <Bubble role="assistant" content={stream.streamingContent} streaming />
            ) : (
              <Text fontSize="xs" color="gray.400" px={1}>
                {stream.isThinking ? "Thinking deeply…" : "…"}
              </Text>
            )
          ) : null}
        </Flex>
      </Box>

      <HStack p={2} borderTop="1px solid" borderColor="gray.200" gap={2}>
        <Textarea
          value={input}
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              void handleSend();
            }
          }}
          placeholder="reply to the tutor…"
          rows={1}
          size="sm"
          resize="none"
          aria-label="Reply to the tutor"
        />
        {stream.isStreaming ? (
          <Button
            size="sm"
            variant="ghost"
            color="charcoal.400"
            onClick={handleStop}
            aria-label="Stop generating"
          >
            <Square weight="fill" />
          </Button>
        ) : (
          <Button size="sm" colorPalette="violet" onClick={handleSend} disabled={!input.trim()}>
            Send
          </Button>
        )}
      </HStack>
    </Flex>
  );
});
