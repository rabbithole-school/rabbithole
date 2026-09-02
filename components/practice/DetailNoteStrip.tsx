"use client";

/**
 * DetailNoteStrip — the one calm note treatment the scholar-scoped detail
 * bodies use for a standing fact about what they are showing: a taught glyph,
 * the state WORD, and one plain-language sentence, on a quiet gray strip.
 *
 * Extracted from `DomainMapStatusStrip` when the Math plan's scope exclusion
 * needed the SAME hierarchy — a domain that is out of plan scope and a domain
 * that has never been mapped are both "here is why this reading is what it is",
 * and giving them two different shells would have made one look more urgent
 * than the other. Neutral gray, never red: both are policy/state, not errors.
 *
 * The strip is a shell only. Each consumer owns its glyph and its whole
 * sentence (T12) — this file names nothing about mapping or plans.
 */

import { Box, Flex, Text } from "@chakra-ui/react";
import type { ReactNode } from "react";

export function DetailNoteStrip({
  glyph,
  word,
  sentence,
  testId,
}: {
  /** The mark this note teaches, at ~15px — the same glyph the matrix draws. */
  glyph: ReactNode;
  /** The state word, in bold ink: "Needs mapping", "Not served". */
  word: string;
  /** One lowercase clause completing "<word> — <sentence>". */
  sentence: string;
  testId: string;
}) {
  return (
    <Flex
      data-testid={testId}
      align="flex-start"
      gap={2}
      px={2.5}
      py={2}
      mb={3}
      borderWidth="1px"
      borderColor="gray.200"
      borderRadius="lg"
      bg="gray.50"
    >
      <Box mt="1px" flexShrink={0}>
        {glyph}
      </Box>
      <Text fontSize="13px" color="charcoal.600" lineHeight="1.4">
        <Text as="span" fontWeight="700" color="charcoal.700">
          {word}
        </Text>
        {" — "}
        {sentence}
      </Text>
    </Flex>
  );
}
