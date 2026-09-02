"use client";

import { Fragment, useState } from "react";
import { Box, Flex, Spinner, Text, VStack } from "@chakra-ui/react";
import { Brain, CaretRight } from "@phosphor-icons/react";
import { StreamToolRow } from "./ToolActivityIndicator";
import {
  splitStreamSegments,
  shouldShowStreamingTail,
  type ToolActivity,
  type ThinkingActivity,
} from "@/lib/toolActivityGroups";

/**
 * Renders the IN-PROGRESS assistant turn with its tool calls AND reasoning
 * inline — each tool-activity row / thinking block sits between the text the
 * model produced before it and the text after it, in the order the model fired
 * them. Replaces the old pattern of one concatenated text bubble with every
 * tool dumped in a log below it.
 *
 * Purely presentational: the host supplies `renderText` (its own markdown
 * renderer + bubble/flat wrapper for assistant text), so the scholar pane,
 * Curriculum Bot, and global Chat tab interleave identically. Tool / thinking
 * positions come from each item's `textOffset` (stamped by the stream hooks);
 * see splitStreamSegments. The backend inserts a blank line at every tool
 * boundary, so a split never lands mid-paragraph.
 *
 * `isStreaming` drives the trailing "still working" indicator: during a live
 * turn there are many static beats (pre-first-token, between a finished tool
 * and the next one, a pause after text, the wait for `done`) where nothing
 * else animates — the tail guarantees continuous feedback. See
 * `shouldShowStreamingTail`.
 *
 * `thinkingActivity` carries the model's summarized reasoning (staff surfaces
 * only — the backend gates emission). Each block renders as a collapsed
 * accordion the reader can expand. Scholar-safe surfaces never receive it, and
 * we defensively drop it when `scholarSafe`.
 */
export function StreamingTurn({
  content,
  toolActivity,
  thinkingActivity = [],
  renderText,
  gap = 2,
  scholarSafe = false,
  isStreaming = false,
}: {
  content: string;
  toolActivity: ToolActivity[];
  /** Ordered reasoning blocks (staff only); empty/ignored on scholar surfaces. */
  thinkingActivity?: ThinkingActivity[];
  /** Render one run of assistant text (markdown). Owns its own wrapper. */
  renderText: (text: string) => React.ReactNode;
  /** Vertical spacing between interleaved segments. */
  gap?: number;
  scholarSafe?: boolean;
  /** True while the turn is still streaming — drives the trailing indicator. */
  isStreaming?: boolean;
}) {
  const segments = splitStreamSegments(
    content,
    toolActivity,
    scholarSafe ? [] : thinkingActivity,
  );

  const showTail = shouldShowStreamingTail(isStreaming, segments);

  return (
    <VStack align="stretch" gap={gap} w="full">
      {segments.map((seg, i) =>
        seg.kind === "text" ? (
          seg.text.trim() ? (
            <Fragment key={i}>{renderText(seg.text)}</Fragment>
          ) : null
        ) : seg.kind === "thinking" ? (
          <Box key={i} w="full">
            <ThinkingBlock text={seg.text} done={seg.done} />
          </Box>
        ) : (
          <Box key={i} w="full">
            <StreamToolRow group={seg.group} scholarSafe={scholarSafe} />
          </Box>
        ),
      )}
      {showTail && <StreamingTail />}
    </VStack>
  );
}

/**
 * The model's summarized reasoning for one live-stream block, shown as a
 * collapsed accordion. While the block is still streaming the header animates;
 * once the model moves on it settles to a quiet "Reasoning summary" toggle.
 * These summaries are intentionally transient and are not persisted with the
 * finished message (data minimization for model-generated reasoning).
 */
function ThinkingBlock({ text, done }: { text: string; done: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const hasText = text.trim().length > 0;
  const isOpen = expanded && hasText;
  const toggle = () => setExpanded((value) => !value);

  return (
    <Box alignSelf="flex-start" w="full">
      <Flex
        align="center"
        gap={2}
        py={1}
        cursor={hasText ? "pointer" : "default"}
        onClick={hasText ? toggle : undefined}
        onKeyDown={
          hasText
            ? (event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  toggle();
                }
              }
            : undefined
        }
        role={hasText ? "button" : undefined}
        tabIndex={hasText ? 0 : undefined}
        aria-expanded={hasText ? isOpen : undefined}
        _hover={hasText ? { color: "charcoal.500" } : undefined}
      >
        {done ? (
          <Brain size={12} weight="duotone" color="var(--chakra-colors-violet-400)" />
        ) : (
          <Spinner size="xs" color="violet.400" />
        )}
        <Text
          fontSize="xs"
          fontFamily="heading"
          color="charcoal.300"
          fontStyle={done ? "normal" : "italic"}
        >
          {done ? "Reasoning summary" : "Reasoning\u2026"}
        </Text>
        {hasText && (
          <CaretRight
            size={10}
            weight="bold"
            color="var(--chakra-colors-charcoal-300)"
            style={{
              transform: isOpen ? "rotate(90deg)" : "none",
              transition: "transform 0.12s ease",
            }}
          />
        )}
      </Flex>
      {isOpen && (
        <Box pl={5} pb={1} borderLeftWidth="2px" borderColor="violet.100" ml="5px">
          <Text
            fontSize="xs"
            fontFamily="body"
            fontStyle="italic"
            color="charcoal.400"
            whiteSpace="pre-wrap"
          >
            {text}
          </Text>
        </Box>
      )}
    </Box>
  );
}

/**
 * The trailing "still working" indicator — the app's typing dots — appended to
 * a live turn whenever no other segment is animating (see
 * `shouldShowStreamingTail`). Guarantees the message area never looks hung mid-
 * turn.
 */
function StreamingTail() {
  return (
    <Flex align="center" gap={2} py={1} alignSelf="flex-start" aria-label="Working">
      <span className="typing-indicator" aria-hidden="true">
        <span />
        <span />
        <span />
      </span>
    </Flex>
  );
}
