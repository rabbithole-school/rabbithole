"use client";

/**
 * The scoring card that sits under one tutor (assistant) turn in the labeler:
 * a compact one-row-per-dimension scorer plus an optional free-text note.
 * WEB-ONLY (staff tool).
 */
import { useState } from "react";
import { Box, Flex, HStack, Text, Textarea } from "@chakra-ui/react";
import { NotePencil } from "@phosphor-icons/react";
import type { RubricDimension } from "@/shared/tutorQualityRubric";
import { Surface } from "@/components/ui/Surface";
import { SectionEyebrow } from "@/components/ui/SectionEyebrow";
import { DimensionRow } from "./DimensionRow";

export interface TurnLabelState {
  dims: Record<string, number>;
  cantJudge: string[];
  note: string;
}

export function TurnScoreCard({
  turnNumber,
  tutorContent,
  dimensions,
  label,
  scored,
  onScore,
  onCantJudge,
  onClear,
  onNoteChange,
  onNoteCommit,
}: {
  /** 1-based position among the transcript's tutor turns. */
  turnNumber: number;
  tutorContent: string;
  dimensions: RubricDimension[];
  label: TurnLabelState;
  /** Whether this turn has any score/can't-judge recorded (drives the header). */
  scored: boolean;
  onScore: (dimKey: string, score: number) => void;
  onCantJudge: (dimKey: string) => void;
  onClear: (dimKey: string) => void;
  onNoteChange: (note: string) => void;
  onNoteCommit: () => void;
}) {
  const [showNote, setShowNote] = useState(label.note.trim().length > 0);

  return (
    <Surface p={4} variant={scored ? "emphasis" : "default"}>
      <HStack gap={2} mb={2} align="baseline">
        <SectionEyebrow>Tutor</SectionEyebrow>
        <Text fontSize="2xs" color="charcoal.300" fontFamily="heading" fontWeight="600">
          turn {turnNumber}
        </Text>
      </HStack>
      <Text fontSize="sm" color="charcoal.700" lineHeight="1.5" whiteSpace="pre-wrap" mb={3}>
        {tutorContent}
      </Text>

      <Box borderTopWidth="1px" borderColor="gray.200" pt={3} />

      <Flex justify="space-between" align="center" mb={2}>
        <SectionEyebrow accent={scored ? "violet" : "default"}>
          {scored ? "Scored" : "Score this turn"}
        </SectionEyebrow>
        <Box
          as="button"
          onClick={() => setShowNote((v) => !v)}
          display="flex"
          alignItems="center"
          gap={1}
          color={label.note.trim() ? "violet.600" : "charcoal.400"}
          cursor="pointer"
          _hover={{ color: "violet.600" }}
        >
          <NotePencil size={14} weight={label.note.trim() ? "fill" : "regular"} />
          <Text fontSize="2xs" fontFamily="heading" fontWeight="700" textTransform="uppercase" letterSpacing="0.05em">
            Note
          </Text>
        </Box>
      </Flex>

      <Box>
        {dimensions.map((dim, i) => (
          <Box
            key={dim.key}
            borderTopWidth={i === 0 ? "0" : "1px"}
            borderColor="gray.100"
          >
            <DimensionRow
              dim={dim}
              value={label.dims[dim.key]}
              cantJudge={label.cantJudge.includes(dim.key)}
              onScore={(s) => onScore(dim.key, s)}
              onCantJudge={() => onCantJudge(dim.key)}
              onClear={() => onClear(dim.key)}
            />
          </Box>
        ))}
      </Box>

      {showNote && (
        <Box mt={3}>
          <Textarea
            value={label.note}
            onChange={(e) => onNoteChange(e.target.value)}
            onBlur={onNoteCommit}
            placeholder="Optional: why this score? (quote the load-bearing phrase)"
            size="sm"
            rows={2}
            resize="vertical"
            bg="white"
            borderColor="gray.200"
          />
        </Box>
      )}
    </Surface>
  );
}
