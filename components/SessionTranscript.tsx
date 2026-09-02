"use client";

import type { ReactNode } from "react";
import { useEffect, useRef } from "react";
import { Box, Flex, Spinner, Text } from "@chakra-ui/react";
import { Keyboard, Microphone } from "@phosphor-icons/react";

import type { ToolActivity } from "@/hooks/useAgentStream";
import { MarkdownBlock } from "@/components/StreamingMarkdown";
import { StreamingText } from "@/components/StreamingText";
import { ToolActivityIndicator } from "@/components/ToolActivityIndicator";

export interface SessionTranscriptMessage {
  id: string;
  content: string;
}

export interface ReconciledSessionMessage<T extends SessionTranscriptMessage> {
  message: T;
  isActiveStream: boolean;
}

export type MessageInputModality = "typed" | "spoken";

export function SessionInputModality({
  modality,
}: {
  modality?: MessageInputModality;
}) {
  if (!modality) return null;

  const label = modality === "spoken" ? "Spoken" : "Typed";
  const Icon = modality === "spoken" ? Microphone : Keyboard;

  return (
    <Flex
      as="span"
      align="center"
      gap={1}
      color="charcoal.300"
      aria-label={`${label} input`}
      title={`${label} input`}
    >
      <Icon size={12} aria-hidden />
      <Text as="span" fontSize="xs" fontFamily="heading">
        {label}
      </Text>
    </Flex>
  );
}

interface ReconcileSessionMessagesOptions {
  streamingMsgId: string | null;
  streamingContent: string;
  lastStreamedContent?: ReadonlyMap<string, string>;
  keepActiveMessageWhenEmpty?: boolean;
}

/**
 * Replaces the active Convex placeholder row's content with its SSE content.
 * The result never appends a second local streaming row, so one message id can
 * render only once while its turn is in flight.
 */
export function reconcileSessionMessages<T extends SessionTranscriptMessage>(
  messages: readonly T[],
  {
    streamingMsgId,
    streamingContent,
    lastStreamedContent,
    keepActiveMessageWhenEmpty = false,
  }: ReconcileSessionMessagesOptions,
): ReconciledSessionMessage<T>[] {
  const reconciled: ReconciledSessionMessage<T>[] = [];

  for (const message of messages) {
    const isActiveStream =
      streamingMsgId !== null && message.id === streamingMsgId;
    const bridgedContent =
      message.content || lastStreamedContent?.get(message.id) || "";
    const content = isActiveStream
      ? streamingContent || bridgedContent
      : bridgedContent;

    if (!content && !(isActiveStream && keepActiveMessageWhenEmpty)) continue;

    reconciled.push({
      message: { ...message, content },
      isActiveStream,
    });
  }

  return reconciled;
}

/**
 * Bridges the stream-to-persist handoff. The server persists the assistant
 * text before it emits `done`, but the Convex subscription can deliver that
 * content a frame later. Retaining the last streamed text keeps the same row
 * visible throughout that gap.
 */
export function useReconciledSessionMessages<T extends SessionTranscriptMessage>({
  messages,
  streamingMsgId,
  streamingContent,
  keepActiveMessageWhenEmpty = false,
}: {
  messages: readonly T[];
  streamingMsgId: string | null;
  streamingContent: string;
  keepActiveMessageWhenEmpty?: boolean;
}): ReconciledSessionMessage<T>[] {
  const lastStreamedRef = useRef<Map<string, string>>(new Map());

  useEffect(() => {
    if (streamingMsgId && streamingContent) {
      lastStreamedRef.current.set(streamingMsgId, streamingContent);
    }
  }, [streamingMsgId, streamingContent]);

  return reconcileSessionMessages(messages, {
    streamingMsgId,
    streamingContent,
    // eslint-disable-next-line react-hooks/refs -- exact stream-to-persist bridge retained from SessionInterface
    lastStreamedContent: lastStreamedRef.current,
    keepActiveMessageWhenEmpty,
  });
}

export function SessionAssistantMessageBody({
  content,
  isStreaming = false,
  generatingImage = false,
  settled,
  fontSize = "lg",
}: {
  content: string;
  isStreaming?: boolean;
  generatingImage?: boolean;
  settled?: ReactNode;
  // The full-screen session chat reads at "lg"; compact side-panel hosts
  // (VibecodeWorkshop) pass their own scale so one surface never mixes sizes.
  fontSize?: string;
}) {
  return (
    <Box
      className="chat-markdown"
      fontFamily="body"
      fontSize={fontSize}
      color="charcoal.500"
    >
      <StreamingText
        content={content}
        done={!isStreaming}
        settled={settled ?? <MarkdownBlock content={content} />}
      />
      {generatingImage && (
        <Flex align="center" gap={2} mt={2}>
          <Spinner size="xs" color="violet.500" />
          <Text
            fontSize="sm"
            fontFamily="heading"
            color="violet.500"
            fontWeight="600"
          >
            Generating image...
          </Text>
        </Flex>
      )}
    </Box>
  );
}

export function SessionStreamStatus({
  isStreaming,
  streamingContent,
  generatingImage = false,
  toolActivity,
  scholarSafe = false,
}: {
  isStreaming: boolean;
  streamingContent: string;
  generatingImage?: boolean;
  toolActivity: ToolActivity[];
  scholarSafe?: boolean;
}) {
  if (!isStreaming) return null;

  if (toolActivity.length > 0) {
    return (
      <ToolActivityIndicator
        toolActivity={toolActivity}
        scholarSafe={scholarSafe}
      />
    );
  }

  if (streamingContent || generatingImage) return null;

  return (
    <Box
      alignSelf="flex-start"
      bg="gray.100"
      px={4}
      py={3}
      borderRadius="xl"
      borderBottomLeftRadius="sm"
    >
      <div className="typing-indicator">
        <span></span>
        <span></span>
        <span></span>
      </div>
    </Box>
  );
}
