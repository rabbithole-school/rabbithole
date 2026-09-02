"use client";

/**
 * One rubric-dimension scoring row for the golden-set labeler: the dimension
 * label (hover the ⓘ for the VERBATIM rubric text), a 1–5 segmented control,
 * and a "?" (can't judge). WEB-ONLY (staff tool) — no native counterpart.
 *
 * Keyboard: with focus anywhere in the row, keys 1–5 set the score, "0"/"?"
 * marks can't-judge, Backspace/Delete clears. (The number handler lives on the
 * row so tabbing to a score button + pressing a digit works, without adding a
 * second tab stop for the row itself.)
 */
import { Box, Flex, HStack, Portal, Text, Tooltip } from "@chakra-ui/react";
import { Info } from "@phosphor-icons/react";
import { SCORE_MAX, SCORE_MIN, type RubricDimension } from "@/shared/tutorQualityRubric";

/** Collapse the rubric's source newlines/indentation into readable prose. */
function normalizeDescription(description: string): string {
  return description.replace(/\s+/g, " ").trim();
}

const SCORES = Array.from(
  { length: SCORE_MAX - SCORE_MIN + 1 },
  (_, i) => SCORE_MIN + i,
);

function Segment({
  children,
  selected,
  tone = "violet",
  onClick,
  ariaLabel,
}: {
  children: React.ReactNode;
  selected: boolean;
  tone?: "violet" | "gray";
  onClick: () => void;
  ariaLabel: string;
}) {
  const selectedBg = tone === "violet" ? "violet.500" : "charcoal.400";
  const selectedBorder = tone === "violet" ? "violet.500" : "charcoal.400";
  return (
    <Box
      as="button"
      aria-label={ariaLabel}
      aria-pressed={selected}
      onClick={onClick}
      minW="32px"
      h="32px"
      px={1}
      borderWidth="1px"
      borderRadius="md"
      cursor="pointer"
      transition="all 0.1s"
      fontFamily="heading"
      fontWeight="700"
      fontSize="sm"
      bg={selected ? selectedBg : "white"}
      color={selected ? "white" : "charcoal.500"}
      borderColor={selected ? selectedBorder : "gray.200"}
      _hover={selected ? undefined : { bg: "gray.50", borderColor: "gray.300" }}
      _focusVisible={{ outline: "2px solid", outlineColor: "violet.400", outlineOffset: "1px" }}
    >
      {children}
    </Box>
  );
}

export function DimensionRow({
  dim,
  value,
  cantJudge,
  onScore,
  onCantJudge,
  onClear,
}: {
  dim: RubricDimension;
  /** 1..5 or undefined when unscored. */
  value?: number;
  cantJudge: boolean;
  onScore: (score: number) => void;
  onCantJudge: () => void;
  onClear: () => void;
}) {
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key >= String(SCORE_MIN) && e.key <= String(SCORE_MAX)) {
      onScore(Number(e.key));
      e.preventDefault();
    } else if (e.key === "0" || e.key === "?") {
      onCantJudge();
      e.preventDefault();
    } else if (e.key === "Backspace" || e.key === "Delete") {
      onClear();
      e.preventDefault();
    }
  };

  return (
    <Flex
      align="center"
      gap={3}
      py={1.5}
      onKeyDown={handleKeyDown}
      role="group"
    >
      <HStack gap={1} flex={1} minW={0} align="center">
        <Tooltip.Root openDelay={200} closeDelay={0}>
          <Tooltip.Trigger asChild>
            <HStack gap={1} cursor="help" minW={0}>
              <Text
                fontFamily="heading"
                fontSize="sm"
                fontWeight="600"
                color="charcoal.600"
                truncate
              >
                {dim.label}
              </Text>
              <Box color="charcoal.300" flexShrink={0} lineHeight="0">
                <Info size={13} weight="bold" />
              </Box>
            </HStack>
          </Tooltip.Trigger>
          <Portal>
            <Tooltip.Positioner>
              <Tooltip.Content maxW="360px" bg="navy.600" color="white">
                <Text fontSize="xs" lineHeight="1.45">
                  {normalizeDescription(dim.description)}
                </Text>
              </Tooltip.Content>
            </Tooltip.Positioner>
          </Portal>
        </Tooltip.Root>
      </HStack>

      <HStack gap={1} flexShrink={0}>
        {SCORES.map((s) => (
          <Segment
            key={s}
            selected={value === s}
            ariaLabel={`${dim.label}: score ${s}`}
            onClick={() => (value === s ? onClear() : onScore(s))}
          >
            {s}
          </Segment>
        ))}
        <Box w="6px" />
        <Segment
          selected={cantJudge}
          tone="gray"
          ariaLabel={`${dim.label}: can't judge`}
          onClick={onCantJudge}
        >
          ?
        </Segment>
      </HStack>
    </Flex>
  );
}
