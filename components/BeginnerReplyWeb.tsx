"use client";

/**
 * BeginnerReplyWeb — a settled tutor reply for a BEGINNER reader on the web
 * (read level `beginner`, TRA-504). The web twin of the iPad's
 * BeginnerReplyText, minus word highlight and tap-a-word (iPad-only for now):
 *
 *   • The reply is cleaned the same way (`beginnerDisplay`: no markdown
 *     markers, no lone emoji; a counting row of the same emoji stays), with
 *     the reading-ramp colors moved onto the cleaned text.
 *   • A decodable `<your-turn>` line is set apart in a labeled box, "Your
 *     turn: read this out loud", with a mic button on the newest reply that
 *     starts the ordinary dictation marked as reading the line aloud.
 *   • A marked line that fails the check is dropped (the voice skips it too),
 *     and while the inventory is still loading (`alphabet` null) lines wait.
 */
import { Box, Button, Flex, Text } from "@chakra-ui/react";
import { Microphone } from "@phosphor-icons/react";
import { useMemo } from "react";

import { GraphemeText } from "@/components/GraphemeText";
import {
  beginnerDisplay,
  checkDecodable,
  mapSpans,
  partSpans,
  splitYourTurn,
  type DecodableAlphabet,
} from "@/shared/beginnerReading";
import type { GraphemeSpan, GraphemeStages } from "@/shared/graphemeSegments";

export function BeginnerReplyWeb({
  content,
  spans,
  stages,
  alphabet,
  onReadAloud,
  readAloudDisabled = false,
  yourTurnFontSize = "3xl",
}: {
  content: string;
  spans?: readonly GraphemeSpan[];
  stages: GraphemeStages;
  alphabet: DecodableAlphabet | null;
  onReadAloud?: () => void;
  readAloudDisabled?: boolean;
  /** The your-turn line's size, moved up with young-reader text steps. */
  yourTurnFontSize?: string;
}) {
  const parts = useMemo(() => {
    return splitYourTurn(content)
      .map((p) => {
        const shown = beginnerDisplay(p.text);
        return {
          kind: p.kind,
          text: shown.text,
          spans: mapSpans(partSpans(p, spans ?? []), shown.map),
          styled:
            p.kind === "yourTurn" && !!alphabet && checkDecodable(p.text, alphabet).ok,
        };
      })
      .filter((p) => p.text.trim().length > 0 && (p.kind === "text" || p.styled));
  }, [content, spans, alphabet]);

  return (
    <Box>
      {parts.map((part, i) =>
        part.kind === "yourTurn" ? (
          <Flex
            key={i}
            mt={3}
            gap={4}
            align="center"
            borderWidth="2px"
            borderColor="violet.400"
            bg="violet.50"
            borderRadius="xl"
            px={4}
            py={3}
            alignSelf="flex-start"
            data-testid="your-turn-line"
          >
            <Box>
              <Text fontSize="sm" fontFamily="heading" color="violet.600" mb={1}>
                Your turn: read this out loud
              </Text>
              <Text fontSize={yourTurnFontSize} lineHeight="short" fontFamily="body" color="charcoal.600">
                <GraphemeText text={part.text.trim()} spans={part.spans} stages={stages} />
              </Text>
            </Box>
            {onReadAloud && (
              <Button
                onClick={onReadAloud}
                disabled={readAloudDisabled}
                aria-label="Read it out loud"
                borderRadius="full"
                bg="violet.500"
                color="white"
                w="52px"
                h="52px"
                minW="52px"
                p={0}
                _hover={{ bg: "violet.600" }}
              >
                <Microphone size={26} weight="fill" />
              </Button>
            )}
          </Flex>
        ) : (
          <Box key={i} as="span" whiteSpace="pre-wrap">
            <GraphemeText text={part.text} spans={part.spans} stages={stages} />
          </Box>
        ),
      )}
    </Box>
  );
}
