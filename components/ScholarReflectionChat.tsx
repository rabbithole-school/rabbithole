"use client";

import { useEffect, useRef, useState } from "react";
import { usePaginatedQuery, useQuery, useMutation } from "convex/react";
import { Box, Button, Flex, Text, VStack } from "@chakra-ui/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { useAgentStream } from "@/hooks/useAgentStream";
import { AideThread } from "./AideThread";
import { convexSiteUrl } from "@/lib/convexUrls";
import { isWithinPrepWindow, formatLocalTimeLabel } from "@/convex/lib/metaBlocks";
import { TEACHER_LINE } from "@/shared/admonishments";

/**
 * The scholar reflection chat (web) — "Today's wrap-up". An aide-style thread
 * (shared <AideThread> + useAgentStream, voice via the built-in mic) streaming
 * against /meta-stream. On open it resolves today's thread (getOrCreateToday)
 * and, if empty, triggers the day-aware opener (startOpener → /meta-stream,
 * which materializes the `<start>` marker server-side). Teacher-visible by
 * design (§9) — a quiet honesty footer says so. No badges/counts (§7).
 * review/scholar-meta-prep-time-plan.html §§3, 4, 8.
 */
export function ScholarReflectionChat({
  seed,
  purpose = "reflection",
}: {
  /** A spark chip tap from the ideas board: pre-fill the composer with this
   *  phrase (mechanism a). `nonce` bumps on every tap so re-tapping the same
   *  chip re-seeds. */
  seed?: { text: string; nonce: number } | null;
  purpose?: "reflection" | "introspection";
}) {
  const getOrCreateToday = useMutation(api.metaChat.getOrCreateToday);
  const getOrCreateIntrospection = useMutation(
    api.metaChat.getOrCreateIntrospection,
  );
  const startOpener = useMutation(api.metaChat.startOpener);
  const sendMessage = useMutation(api.metaChat.sendMessage);
  const block = useQuery(
    api.metaChat.myPrepTimeBlock,
    purpose === "reflection" ? {} : "skip",
  );

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
  const { streamingContent, streamingMsgId, isStreaming, toolActivity, send } =
    useAgentStream();
  const [input, setInput] = useState("");
  const openerFiredRef = useRef(false);

  // A spark chip was tapped: pre-fill the composer with its phrase so the kid
  // finishes the thought and sends (never auto-sent — a spark is a
  // sentence-starter). React's documented "adjust state when a prop changes"
  // pattern — compare against the last-applied nonce (state, not a ref) and set
  // during render — so tapping the same chip re-seeds without a cascading-render
  // effect. Focus is handled by AideThread via focusSignal below.
  const [seenSparkNonce, setSeenSparkNonce] = useState<number | undefined>(undefined);
  if (seed && seed.nonce !== seenSparkNonce) {
    setSeenSparkNonce(seed.nonce);
    setInput(seed.text);
  }

  // Keep the "ends HH:MM" eyebrow honest across a long visit (~60s tick).
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(id);
  }, []);

  // Resolve the daily reflection or the one standing introspection thread.
  useEffect(() => {
    let cancelled = false;
    const resolve =
      purpose === "reflection"
        ? getOrCreateToday({})
        : getOrCreateIntrospection({});
    resolve.then((r) => {
      if (!cancelled) setChatId(r.chatId);
    });
    return () => {
      cancelled = true;
    };
  }, [getOrCreateIntrospection, getOrCreateToday, purpose]);

  // Fire the purpose-aware opener exactly once for a truly empty thread.
  useEffect(() => {
    if (!chatId || openerFiredRef.current) return;
    if (messageStatus === "LoadingFirstPage") return;
    openerFiredRef.current = true;
    if (messages.length > 0) return; // resuming — opener already happened
    (async () => {
      const res = await startOpener({ chatId });
      if (!res) return;
      await send(
        `${convexSiteUrl()}/meta-stream`,
        { chatId, assistantMsgId: res.assistantMsgId, kickoff: true },
        res.assistantMsgId,
      );
    })();
  }, [chatId, messageStatus, messages, startOpener, send]);

  const handleSend = async () => {
    const content = input.trim();
    if (!content || isStreaming || !chatId) return;
    setInput("");
    const { assistantMsgId } = await sendMessage({ chatId, content });
    await send(
      `${convexSiteUrl()}/meta-stream`,
      { chatId, assistantMsgId },
      assistantMsgId,
    );
  };

  const withinWindow = block ? isWithinPrepWindow(block, now) : false;

  // Only real (non-empty) turns render; the in-flight assistant row is empty in
  // the DB and shown via the streaming turn, so filtering it here avoids a
  // blank bubble flashing between insert and stream start.
  const visibleMessages = [...messages]
    .reverse()
    .filter((m) => m.content.trim() !== "")
    .map((m) => ({ _id: String(m._id), role: m.role, content: m.content }));

  return (
    <Flex direction="column" h="full" minH={0}>
      <Box
        px={4}
        pt={3}
        pb={2.5}
        borderBottomWidth="1px"
        borderColor="gray.200"
        bg="white"
        flexShrink={0}
      >
        <Text fontFamily="heading" fontWeight="700" fontSize="md" color="navy.500">
          {purpose === "reflection" ? "Today's reflection" : "Ask Rabbithole"}
        </Text>
        {withinWindow && block && (
          <Text fontFamily="body" fontSize="xs" color="charcoal.400" mt={0.5}>
            Scholar’s Prep · ends {formatLocalTimeLabel(block.endLocal)}
          </Text>
        )}
      </Box>

      <AideThread
        messages={visibleMessages}
        streamingMsgId={streamingMsgId}
        streamingContent={streamingContent}
        isStreaming={isStreaming}
        toolActivity={toolActivity}
        density="scholar"
        scholarSafe
        input={input}
        onInputChange={setInput}
        onSend={handleSend}
        placeholder={
          purpose === "reflection"
            ? "Tell me about today…"
            : "Ask about Rabbithole…"
        }
        topNote={
          messageStatus === "CanLoadMore" ? (
            <Flex justify="center" pb={2}>
              <Button
                variant="ghost"
                size="xs"
                onClick={() => loadMore(40)}
                color="violet.600"
              >
                Load earlier messages
              </Button>
            </Flex>
          ) : undefined
        }
        focusSignal={seed?.nonce}
        autoFocus
        emptyState={
          <VStack gap={2} py={10} textAlign="center" color="charcoal.300">
            <Text fontFamily="heading" fontSize="sm" color="charcoal.400">
              {purpose === "reflection"
                ? "Let's reflect on your day"
                : "Ask how Rabbithole works"}
            </Text>
            <Text fontFamily="body" fontSize="sm" maxW="sm">
              {purpose === "reflection"
                ? "A couple of questions about how today went — and anything you wish we'd do differently."
                : "Ask about the tutor, your Sky, your learning record, or why Rabbithole behaves a certain way."}
            </Text>
          </VStack>
        }
        belowInput={
          <Text
            fontFamily="body"
            fontSize="2xs"
            color="charcoal.300"
            mt={1.5}
            textAlign="center"
          >
            {TEACHER_LINE}
          </Text>
        }
      />
    </Flex>
  );
}
