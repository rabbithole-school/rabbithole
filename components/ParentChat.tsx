"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useQuery, useMutation } from "convex/react";
import { Flex, Text, VStack } from "@chakra-ui/react";
import { api } from "@/convex/_generated/api";
import { useAgentStream } from "@/hooks/useAgentStream";
import { AideThread } from "./AideThread";
import { convexSiteUrl } from "@/lib/convexUrls";

/**
 * The parent aide chat. Streams via the shared useAgentStream hook against
 * /parent-chat-stream, whose tools are guardianship-scoped to this parent's
 * own children (tier-1 only). Single flat thread per parent, rendered with
 * the shared <AideThread> core so streaming / markdown / tool-activity stays
 * identical to the teacher + scholar aides. Fills its host (the parent aide
 * dock gives it the panel height).
 *
 * `seed` pre-fills the composer (mechanism mirrors the teacher dock's
 * composer seed): the parent reviews/edits and hits send — never an
 * auto-send. `nonce` bumps on every request so re-seeding the same text
 * re-fills; `onSeedConsumed` lets the host clear its pending seed once
 * applied (so a stale seed can't re-fill on a later remount). The exception
 * is `send: true` — used by the canned-question chips, where the parent
 * tapped an exact, fully-formed question, so tapping IS the send.
 */
export function ParentChat({
  seed,
  onSeedConsumed,
}: {
  seed?: { text: string; nonce: number; send?: boolean } | null;
  onSeedConsumed?: () => void;
} = {}) {
  const messages = useQuery(api.parentChat.listMessages) ?? [];
  const sendMessage = useMutation(api.parentChat.sendMessage);
  const {
    streamingContent,
    streamingMsgId,
    isStreaming,
    isThinking,
    toolActivity,
    send,
  } = useAgentStream();
  const [input, setInput] = useState("");
  // Bumped when a seed lands so <AideThread> focuses the composer with the
  // caret at the end — the parent just confirms/edits and hits send.
  const [focusSignal, setFocusSignal] = useState<number | undefined>(undefined);
  const seededNonce = useRef<number | null>(null);

  const sendContent = useCallback(
    async (content: string) => {
      if (!content || isStreaming) return;
      const { assistantMsgId } = await sendMessage({ content });
      const convexUrl = convexSiteUrl();
      await send(`${convexUrl}/parent-chat-stream`, { assistantMsgId }, assistantMsgId);
    },
    [isStreaming, sendMessage, send],
  );

  // The seededNonce guard makes re-runs no-ops. A send-seed leaves any typed
  // draft in the composer untouched.
  useEffect(() => {
    if (seed && seed.nonce !== seededNonce.current) {
      seededNonce.current = seed.nonce;
      if (seed.send) {
        void sendContent(seed.text.trim());
      } else {
        // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional composer pre-fill on a new seed
        setInput(seed.text);
        setFocusSignal(seed.nonce);
      }
      onSeedConsumed?.();
    }
  }, [seed, onSeedConsumed, sendContent]);

  const handleSend = async () => {
    const content = input.trim();
    if (!content || isStreaming) return;
    setInput("");
    await sendContent(content);
  };

  return (
    <Flex direction="column" flex={1} minH={0} h="full">
      <AideThread
        messages={messages.map((m) => ({ _id: String(m._id), role: m.role, content: m.content }))}
        streamingMsgId={streamingMsgId}
        streamingContent={streamingContent}
        isStreaming={isStreaming}
        isThinking={isThinking}
        toolActivity={toolActivity}
        input={input}
        onInputChange={setInput}
        onSend={handleSend}
        focusSignal={focusSignal}
        placeholder="Ask about your child's learning…"
        emptyState={
          <VStack gap={2} py={10} textAlign="center" color="charcoal.300">
            <Text fontFamily="heading" fontSize="sm" color="charcoal.400">
              Ask about your child&apos;s learning
            </Text>
            <Text fontFamily="body" fontSize="sm" maxW="sm">
              e.g. &ldquo;What has my child been mastering lately?&rdquo; or
              &ldquo;What might be good to explore next?&rdquo;
            </Text>
          </VStack>
        }
      />
    </Flex>
  );
}
