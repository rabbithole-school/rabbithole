"use client";

/**
 * Provenance marker for writing the tutor typed down on a scholar's behalf.
 *
 * A scholar can reach the page two ways: they typed it, or they said it and
 * the tutor transcribed their exact words into the document for them (the
 * `transcribe` command on the tutor's edit_document tool). Both are real work,
 * but they are not the same work — and a portfolio meant to be a portrait the
 * scholar recognizes as theirs must not quietly blur "she wrote it" into "she
 * said it and the tutor typed it."
 *
 * This is the single canonical rendering of that signal. Import it wherever a
 * teacher reads submitted writing rather than adding a second vocabulary for
 * the same fact.
 */
import { Text } from "@chakra-ui/react";

export function TutorTranscriptionChip({
  size = "2xs",
}: {
  /** Match the surrounding row's type scale (lists run smaller). */
  size?: "2xs" | "xs";
}) {
  return (
    <Text
      as="span"
      display="inline-block"
      alignSelf="flex-start"
      fontSize={size}
      fontWeight="600"
      color="charcoal.500"
      bg="gray.100"
      borderWidth="1px"
      borderColor="gray.200"
      borderRadius="sm"
      px={1.5}
      py={0.5}
      title="Some of this reached the page because the tutor typed the scholar's spoken words down for them, word for word."
    >
      Tutor wrote this down
    </Text>
  );
}
