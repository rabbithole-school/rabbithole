"use client";

import { useEffect, useRef } from "react";
import Link from "next/link";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { remarkHardBreaks } from "@/lib/remarkHardBreaks";
import { Box, Flex, IconButton, Spinner, Text, VStack, Textarea } from "@chakra-ui/react";
import { PaperPlaneTilt } from "@phosphor-icons/react";
import { StreamingTurn } from "./StreamingTurn";
import { DictationMicButton } from "./DictationMicButton";
import type { ToolActivity } from "@/hooks/useAgentStream";
import { useIsTouchDevice } from "@/hooks/useIsTouchDevice";

/**
 * Type scale for an aide thread.
 * - `staff` (default): the compact teacher/parent/curriculum sizing — leaves
 *   every existing aide surface untouched.
 * - `scholar`: the scholar tutor-chat sizing (SessionInterface) — 18px message
 *   text + the tutor composer scale — for kid-facing threads (the Workshop
 *   reflection chat). Scholar assistant text reuses the tutor `.chat-markdown`
 *   CSS, so the markdown renders identically to the session chat.
 */
export type AideDensity = "staff" | "scholar";

// Internal links (scholar/session/unit deep-links the aide emits) route via
// next/link; external links open in a new tab. Exported so every aide
// surface (incl. the global Chat tab) renders the bot's markdown identically.
export const aideMarkdownComponents = {
  a: ({ href, children }: { href?: string; children?: React.ReactNode }) => {
    if (href?.startsWith("/")) {
      return (
        <Link href={href} style={{ color: "var(--chakra-colors-violet-600)", fontWeight: 600, textDecoration: "underline" }}>
          {children}
        </Link>
      );
    }
    return (
      <a href={href} target="_blank" rel="noopener noreferrer" style={{ color: "var(--chakra-colors-violet-600)", textDecoration: "underline" }}>
        {children}
      </a>
    );
  },
};

// Aide chat honors single newlines as line breaks (remarkHardBreaks) — the
// bot writes short single-newline-separated lines (e.g. a Unit/Lesson/Activity
// recap) and expects each on its own line, chat-style.
export const aideRemarkPlugins = [remarkGfm, remarkHardBreaks];

// Assistant messages render flat (full-width, no bubble) — better than a
// constrained bubble for the long curriculum/profile content the aides
// produce. One markdown style for every aide thread.
const assistantCss = {
  "& p": { marginBottom: "0.4em", fontSize: "13px", lineHeight: "1.5" },
  "& p:last-child": { marginBottom: 0 },
  "& ul": { paddingLeft: "1.4em", marginBottom: "0.4em", fontSize: "13px", listStyle: "disc", listStylePosition: "outside" as const },
  "& ol": { paddingLeft: "1.4em", marginBottom: "0.4em", fontSize: "13px", listStyle: "decimal", listStylePosition: "outside" as const },
  "& li": { marginBottom: "0.15em", display: "list-item" },
  "& code": { background: "var(--chakra-colors-gray-100)", padding: "0.1em 0.2em", borderRadius: "3px", fontSize: "0.85em" },
  "& pre": { background: "var(--chakra-colors-gray-100)", padding: "0.6em", borderRadius: "6px", overflowX: "auto" as const, marginBottom: "0.4em" },
  "& pre code": { background: "none", padding: 0 },
  "& strong": { fontWeight: 600 },
  "& table": { borderCollapse: "collapse" as const, marginBottom: "0.4em", fontSize: "12px", width: "100%" },
  "& th, & td": { border: "1px solid var(--chakra-colors-gray-300)", padding: "3px 6px", textAlign: "left" as const },
  "& th": { background: "var(--chakra-colors-gray-100)", fontWeight: 600 },
  "& h1, & h2, & h3, & h4": { fontSize: "14px", fontWeight: 600, marginBottom: "0.3em", marginTop: "0.6em", color: "var(--chakra-colors-navy-500)" },
} as const;

export interface AideMessage {
  _id: string;
  role: string;
  content: string;
}

/**
 * One message in an aide-style thread — the single source of truth for how a
 * turn looks: `role === "user"` renders a right-aligned navy bubble, anything
 * else renders flat full-width markdown (the aide/tutor voice). Reused by the
 * live AideThread AND read-only transcripts (e.g. the auto-improve sim cast),
 * so a tutoring transcript looks identical to the curriculum bot. Map a
 * transcript's two roles onto this: the human/scholar → "user", the AI → "assistant".
 */
export function AideMessageBubble({
  role,
  content,
  prefix,
  density = "staff",
}: {
  role: string;
  content: string;
  /** Rendered above a user bubble (e.g. the unit bot's flag chips). */
  prefix?: React.ReactNode;
  /** Type scale — see AideDensity. Defaults to staff (no visual change). */
  density?: AideDensity;
}) {
  const isScholar = density === "scholar";
  if (role === "user") {
    return (
      <Box alignSelf="flex-end" maxW="90%">
        {prefix}
        <Box bg="navy.500" color="white" px={3} py={2} borderRadius="lg" borderBottomRightRadius="sm" shadow="sm">
          <Text fontFamily="body" fontSize={isScholar ? "lg" : "xs"} whiteSpace="pre-wrap">{content}</Text>
        </Box>
      </Box>
    );
  }
  // Scholar assistant text reuses the tutor chat's `.chat-markdown` styling at
  // fontSize lg, so it renders pixel-identically to the session chat (no forked
  // sizes). Staff keeps the compact inline `assistantCss`.
  if (isScholar) {
    return (
      <Box alignSelf="stretch" color="charcoal.600" px={1} py={1} w="full">
        <Box className="chat-markdown" fontFamily="body" fontSize="lg">
          <ReactMarkdown remarkPlugins={aideRemarkPlugins} components={aideMarkdownComponents}>
            {content}
          </ReactMarkdown>
        </Box>
      </Box>
    );
  }
  return (
    <Box alignSelf="stretch" color="charcoal.600" px={1} py={1} w="full" css={assistantCss}>
      <Text fontFamily="body" fontSize="xs" as="div">
        <ReactMarkdown remarkPlugins={aideRemarkPlugins} components={aideMarkdownComponents}>
          {content}
        </ReactMarkdown>
      </Text>
    </Box>
  );
}

export interface AideThreadProps<M extends AideMessage = AideMessage> {
  messages: M[];
  /** id of the message currently streaming (its content comes from streamingContent) */
  streamingMsgId: string | null;
  streamingContent: string;
  isStreaming: boolean;
  /** The model is in a pre-text extended-thinking pause (Fable's always-on
   * thinking, ~10-30s) — labels the pre-text spinner so it reads as work. */
  isThinking?: boolean;
  toolActivity: ToolActivity[];
  input: string;
  onInputChange: (v: string) => void;
  onSend: () => void;
  placeholder?: string;
  /** Shown when there are no messages and nothing is streaming. */
  emptyState?: React.ReactNode;
  /** Rendered at the very top of the transcript, above the first message
   *  (e.g. the unit bot's scope line). Hidden while the empty state shows. */
  topNote?: React.ReactNode;
  /** Rendered above a user message bubble (e.g. the unit bot's flag chips). */
  renderUserPrefix?: (message: M) => React.ReactNode;
  /** Rendered between the message list and the input (e.g. pending flags). */
  aboveInput?: React.ReactNode;
  /** Rendered directly below the composer (e.g. a quiet honesty footer). */
  belowInput?: React.ReactNode;
  /** Type scale — see AideDensity. Defaults to staff (no visual change). */
  density?: AideDensity;
  /** Hide model/staff tool results and unknown tool ids on scholar surfaces. */
  scholarSafe?: boolean;
  /** Bump this to a new number to focus the composer and place the cursor at
   *  the end (e.g. after a host pre-fills the input from a spark chip).
   *  Undefined on every other aide surface → no focus behavior. */
  focusSignal?: number;
  /** Keep the composer focused: autoFocus on mount AND refocus each time a
   *  stream completes (the textarea is `disabled` while streaming, which blurs
   *  it, so the caret would otherwise vanish every turn). Opt-in — scholar
   *  chat surfaces (the Workshop reflection / Ask threads) want this so the kid
   *  can keep typing; staff aides leave it off. Defaults to off. */
  autoFocus?: boolean;
}

/**
 * The shared aide chat thread — message list (flat assistant markdown +
 * user bubbles), tool-activity indicator, streaming spinner, and the input
 * row (auto-grow textarea + mic + send). Purely presentational: the host
 * owns the messages, the stream state (useAgentStream or the StreamRegistry),
 * and the send action, so this one body renders the scholar pane, the unit
 * designer's Curriculum Bot, and (later) the global Chat tab alike.
 */
export function AideThread<M extends AideMessage = AideMessage>({
  messages,
  streamingMsgId,
  streamingContent,
  isStreaming,
  isThinking,
  toolActivity,
  input,
  onInputChange,
  onSend,
  placeholder = "Ask a question…",
  emptyState,
  topNote,
  renderUserPrefix,
  aboveInput,
  belowInput,
  density = "staff",
  scholarSafe = false,
  focusSignal,
  autoFocus = false,
}: AideThreadProps<M>) {
  const isScholar = density === "scholar";
  const isTouchDevice = useIsTouchDevice();
  // Scholar composer matches the tutor chat: md on touch, xl on desktop.
  const composerFontSize = isScholar ? (isTouchDevice ? "md" : "xl") : "xs";
  const scrollRef = useRef<HTMLDivElement>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // Auto-scroll only when the user is already near the bottom, so reading
  // back through history isn't yanked down by an incoming stream.
  const pinnedToBottom = useRef(true);

  const recomputePinned = () => {
    const el = scrollRef.current;
    if (!el) return;
    pinnedToBottom.current =
      el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };

  useEffect(() => {
    if (pinnedToBottom.current) {
      // Instant, not smooth: during rapid token streaming a smooth anchor
      // animates continuously and janks. Matches the unit bot's prior behavior.
      endRef.current?.scrollIntoView({ behavior: "auto" });
    }
  }, [messages, streamingContent]);

  useEffect(() => {
    const ta = textareaRef.current;
    if (ta) {
      ta.style.height = "auto";
      ta.style.height = `${Math.min(ta.scrollHeight, 200)}px`;
    }
  }, [input]);

  // Host asked us to focus the composer (a spark chip pre-filled the input) —
  // focus and drop the cursor at the end so the kid can finish the thought.
  // Only fires when focusSignal changes to a real number; no-op elsewhere.
  useEffect(() => {
    if (focusSignal === undefined) return;
    const ta = textareaRef.current;
    if (!ta || ta.disabled) return;
    ta.focus();
    const end = ta.value.length;
    ta.setSelectionRange(end, end);
  }, [focusSignal]);

  // Refocus the composer every time a stream completes (opt-in via autoFocus).
  // The textarea is `disabled` while isStreaming === true; the browser blurs
  // disabled elements, so the caret would otherwise vanish each turn and the
  // kid would have to click back into the input to keep typing. Tracking the
  // prior value focuses on the true → false transition only (not on load, where
  // the Chakra `autoFocus` prop handles the initial focus). Matches the tutor
  // chat (SessionInterface).
  const wasStreamingRef = useRef(isStreaming);
  useEffect(() => {
    if (!autoFocus) return;
    if (wasStreamingRef.current && !isStreaming) {
      textareaRef.current?.focus({ preventScroll: true });
    }
    wasStreamingRef.current = isStreaming;
  }, [autoFocus, isStreaming]);

  const visible = messages.filter(
    (m) => !(streamingMsgId && String(m._id) === streamingMsgId),
  );
  const showEmpty = visible.length === 0 && !streamingContent && !isStreaming;

  return (
    <Flex flex={1} direction="column" overflow="hidden" minH={0}>
      <Box ref={scrollRef} flex={1} overflowY="auto" px={4} py={3} onScroll={recomputePinned}>
        <VStack gap={3} align="stretch">
          {showEmpty && emptyState}
          {!showEmpty && topNote}

          {visible.map((m) => (
            <AideMessageBubble
              key={String(m._id)}
              role={m.role}
              content={m.content}
              density={density}
              prefix={m.role === "user" ? renderUserPrefix?.(m) : undefined}
            />
          ))}

          {/* Live streaming turn — assistant text with its tool calls inline,
              right where the model fired them (not in a log below). */}
          {isStreaming && (streamingContent || toolActivity.length > 0) && (
            <StreamingTurn
              content={streamingContent}
              toolActivity={toolActivity}
              isStreaming={isStreaming}
              scholarSafe={scholarSafe}
              renderText={(text) => <AideMessageBubble role="assistant" content={text} density={density} />}
            />
          )}
          {isStreaming && !streamingContent && toolActivity.length === 0 && (
            <Flex alignSelf="flex-start" bg="gray.100" px={3} py={2} borderRadius="lg" borderBottomLeftRadius="sm" align="center" gap={2}>
              <Spinner size="sm" color="violet.500" />
              {isThinking && (
                <Text fontFamily="heading" fontSize="xs" color="charcoal.400">
                  Thinking deeply…
                </Text>
              )}
            </Flex>
          )}
          <div ref={endRef} />
        </VStack>
      </Box>

      {aboveInput}

      <Box px={3} py={2} borderTop="1px solid" borderColor="gray.200" bg="gray.50">
        <Flex gap={2} align="flex-end">
          <Textarea
            ref={textareaRef}
            autoFocus={autoFocus}
            value={input}
            onChange={(e) => onInputChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                onSend();
              }
            }}
            placeholder={placeholder}
            resize="none"
            rows={1}
            overflow="hidden"
            bg="white"
            border="1px solid"
            borderColor="gray.300"
            borderRadius="lg"
            _focus={{ borderColor: "violet.400", boxShadow: "none", outline: "none" }}
            _focusVisible={{ boxShadow: "none", outline: "none" }}
            _placeholder={{ color: "charcoal.300" }}
            fontFamily="body"
            fontSize={composerFontSize}
            py={2}
            px={3}
            disabled={isStreaming}
          />
          <DictationMicButton
            size="sm"
            disabled={isStreaming}
            onTranscript={(text) => onInputChange(input ? `${input.trimEnd()} ${text}` : text)}
          />
          <IconButton
            aria-label="Send message"
            size="sm"
            bg="violet.500"
            color="white"
            _hover={{ bg: "violet.600" }}
            _disabled={{ opacity: 0.4, cursor: "not-allowed" }}
            borderRadius="lg"
            onClick={onSend}
            disabled={!input.trim() || isStreaming}
          >
            <PaperPlaneTilt size={14} />
          </IconButton>
        </Flex>
        {belowInput}
      </Box>
    </Flex>
  );
}
