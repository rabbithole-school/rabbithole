"use client";

/**
 * The evidence column, shared by the Rounds week board and the per-scholar
 * pane. Every line is dated and attributable and, where the source wrote
 * words, those words are quoted rather than counted.
 *
 * Deliberately NOT interactive. There is no "quote this into guidance"
 * affordance anywhere in this component, by design: observer analysis is
 * teacher-facing and may carry clinical framing, while guidance is read
 * verbatim by the tutor to the child. Keeping the two apart is a redaction
 * boundary, not a UX preference. A copy button would be the same leak with one
 * extra click of consent.
 */

import { Badge, Box, HStack, Stack, Text } from "@chakra-ui/react";

import {
  foldRoundsAbsence,
  SILENT_WEEK_FINDING,
  type RoundsEvidenceLine,
} from "./roundsEvidence";

function SourceTag({ label }: { label: string }) {
  return (
    <Text
      as="span"
      fontFamily="heading"
      fontSize="xs"
      fontWeight="700"
      letterSpacing="0.06em"
      textTransform="uppercase"
      color="charcoal.400"
      flexShrink={0}
      minW="4.75rem"
      pt="0.15rem"
    >
      {label}
    </Text>
  );
}

export function RoundsEvidenceList({
  lines,
  silent,
  compact = false,
}: {
  lines: RoundsEvidenceLine[];
  silent: boolean;
  /** Board rows run a touch tighter than the pane. */
  compact?: boolean;
}) {
  if (silent) {
    return (
      <Box
        borderWidth="1px"
        borderColor="gray.200"
        borderRadius="md"
        bg="gray.50"
        px={4}
        py={3}
      >
        <Text fontFamily="body" fontSize="sm" color="charcoal.500">
          {SILENT_WEEK_FINDING}
        </Text>
        <Text fontFamily="body" fontSize="sm" color="charcoal.400" mt={1}>
          A quiet week is a finding. Say it out loud before moving on.
        </Text>
      </Box>
    );
  }

  const { present, absence } = foldRoundsAbsence(lines);

  return (
    <Stack gap={compact ? 2 : 3}>
      {present.map((line) => (
        <HStack key={line.key} align="flex-start" gap={3}>
          <SourceTag label={line.source} />
          <Box flex="1" minW={0}>
            {line.quote ? (
              <Text
                fontFamily="body"
                fontSize="sm"
                lineHeight="1.5"
                color="charcoal.600"
              >
                &ldquo;{line.quote}&rdquo;
              </Text>
            ) : null}
            {line.body ? (
              <HStack gap={2} align="center" flexWrap="wrap">
                <Text
                  fontFamily="body"
                  fontSize="sm"
                  lineHeight="1.5"
                  color={line.absence ? "charcoal.400" : "charcoal.600"}
                >
                  {line.body}
                </Text>
                {line.rung ? (
                  <HStack gap={1.5} align="center">
                    {line.rung.from ? (
                      <>
                        <Text
                          fontFamily="heading"
                          fontSize="sm"
                          color="charcoal.400"
                        >
                          {line.rung.from}
                        </Text>
                        <Text
                          fontFamily="heading"
                          fontSize="sm"
                          color="charcoal.400"
                          aria-hidden
                        >
                          →
                        </Text>
                      </>
                    ) : null}
                    <Badge
                      bg={`${line.rung.color}.100`}
                      color={`${line.rung.color}.700`}
                      borderRadius="full"
                      px={2.5}
                      py={0.5}
                      fontFamily="heading"
                      fontSize="sm"
                      fontWeight="700"
                      textTransform="none"
                    >
                      {line.rung.label}
                    </Badge>
                  </HStack>
                ) : null}
              </HStack>
            ) : null}
            <Text
              fontFamily="heading"
              fontSize="sm"
              color="charcoal.300"
              mt={0.5}
            >
              {line.provenance}
              {line.overflow ? (
                <Text as="span" color="charcoal.400" fontWeight="600">
                  {" "}
                  · {line.overflow}
                </Text>
              ) : null}
            </Text>
          </Box>
        </HStack>
      ))}
      {absence ? (
        <Text fontFamily="body" fontSize="sm" color="charcoal.400">
          {absence}
        </Text>
      ) : null}
    </Stack>
  );
}
