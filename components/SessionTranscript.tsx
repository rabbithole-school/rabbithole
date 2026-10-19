"use client";

import type { ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import { Box, Button, Flex, Spinner, Text } from "@chakra-ui/react";
import {
  ArrowClockwise,
  ChatCircle,
  Keyboard,
  Microphone,
} from "@phosphor-icons/react";

import type { ToolActivity } from "@/hooks/useAgentStream";
import { MarkdownBlock } from "@/components/StreamingMarkdown";
import { StreamingText } from "@/components/StreamingText";
import { ToolActivityIndicator } from "@/components/ToolActivityIndicator";
import { pendingTurnLabel } from "@/shared/streamRetry";
import { stripYourTurnMarkers } from "@/shared/beginnerReading";

export interface SessionTranscriptMessage {
  id: string;
  content: string;
}

export interface ReconciledSessionMessage<T extends SessionTranscriptMessage> {
  message: T;
  isActiveStream: boolean;
}

export type MessageInputModality = "typed" | "spoken" | "app";

export function SessionInputModality({
  modality,
}: {
  modality?: MessageInputModality;
}) {
  if (!modality) return null;

  const label =
    modality === "spoken" ? "Spoken" : modality === "app" ? "App" : "Typed";
  const Icon =
    modality === "spoken" ? Microphone : modality === "app" ? ChatCircle : Keyboard;

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
  stopRequestedAt,
}: {
  content: string;
  isStreaming?: boolean;
  generatingImage?: boolean;
  settled?: ReactNode;
  // The full-screen session chat reads at "lg"; compact side-panel hosts
  // (VibecodeWorkshop) pass their own scale so one surface never mixes sizes.
  fontSize?: string;
  // When set on a finalized (non-streaming) turn, the user cut this reply
  // short — render a muted "Stopped" caption under the body. Opt-in: the
  // full-screen session chat renders its own caption in MessageBubble, so it
  // leaves this undefined to avoid double-rendering.
  stopRequestedAt?: number | null;
}) {
  // A beginner's "your turn" line (TRA-504) shows as its words here; only the
  // iPad styles it as the child's line so far.
  const shown = stripYourTurnMarkers(content);
  return (
    <Box
      className="chat-markdown"
      fontFamily="body"
      fontSize={fontSize}
      color="charcoal.500"
    >
      <StreamingText
        content={shown}
        done={!isStreaming}
        settled={settled ?? <MarkdownBlock content={shown} />}
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
      {!isStreaming && stopRequestedAt && (
        <Text fontSize="xs" fontFamily="heading" color="fg.muted" mt={1}>
          Stopped
        </Text>
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
  pending = false,
  pendingSince = null,
}: {
  isStreaming: boolean;
  streamingContent: string;
  generatingImage?: boolean;
  toolActivity: ToolActivity[];
  scholarSafe?: boolean;
  /**
   * The turn is pending from server truth (an empty assistant placeholder with
   * a streamId) even if this client is not itself streaming — so a remount or a
   * wait-and-retry keeps the "thinking" indicator up instead of flashing empty.
   */
  pending?: boolean;
  /** When the pending turn began (ms), for the escalating "thinking" copy. */
  pendingSince?: number | null;
}) {
  const active = isStreaming || pending;
  if (!active) return null;

  if (toolActivity.length > 0) {
    return (
      <ToolActivityIndicator
        toolActivity={toolActivity}
        scholarSafe={scholarSafe}
      />
    );
  }

  if (streamingContent || generatingImage) return null;

  return <TutorThinkingIndicator pendingSince={pendingSince} />;
}

/**
 * The single canonical "thinking" state for a pending tutor turn: the typing
 * dots, with copy that escalates the longer the scholar waits ("Still
 * thinking…" then "Taking a little longer than usual…"). One place, per
 * surface — it must NOT vanish when a tool event arrives (the caller keeps it
 * mounted; see SessionStreamStatus) and it survives a wait-and-retry.
 */
function TutorThinkingIndicator({
  pendingSince,
}: {
  pendingSince?: number | null;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (pendingSince == null) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [pendingSince]);

  const label =
    pendingSince != null ? pendingTurnLabel(now - pendingSince) : null;

  return (
    <Flex align="center" gap={2} alignSelf="flex-start">
      <Box bg="gray.100" px={4} py={3} borderRadius="xl" borderBottomLeftRadius="sm">
        <div className="typing-indicator">
          <span></span>
          <span></span>
          <span></span>
        </div>
      </Box>
      {label && (
        <Text fontSize="sm" fontFamily="heading" color="charcoal.300">
          {label}
        </Text>
      )}
    </Flex>
  );
}

/**
 * A failed turn never evaporates: the scholar's message stays visible and this
 * calm inline notice offers a one-tap retry that re-runs the same turn (no
 * retyping, no duplicate message). Shown only when the placeholder is dead —
 * the client gave up, or the server's orphan-reap window has passed.
 */
export function TutorTurnFailedNotice({
  onRetry,
  note,
  addKeyHref,
}: {
  onRetry: () => void;
  /** Why, when it's worth saying (a busy server's honest wait, a missing key). */
  note?: string | null;
  /** The local runner's page for adding the tutor's Anthropic key, built by
   *  tutorKeyHref so a save brings the scholar straight back to this chat. */
  addKeyHref?: string | null;
}) {
  return (
    <Flex align="center" gap={2} alignSelf="flex-start" px={4} py={1} wrap="wrap">
      <Text fontSize="sm" fontFamily="body" color="charcoal.300">
        {note ?? "Didn't go through"}
      </Text>
      {addKeyHref && (
        <Button
          asChild
          size="xs"
          variant="ghost"
          color="violet.500"
          fontFamily="heading"
        >
          <a href={addKeyHref}>
            Add the key
          </a>
        </Button>
      )}
      <Button
        size="xs"
        variant="ghost"
        color="violet.500"
        fontFamily="heading"
        onClick={onRetry}
      >
        <ArrowClockwise size={12} weight="bold" />
        Try again
      </Button>
    </Flex>
  );
}
