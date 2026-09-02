"use client";

/**
 * Top strip — now led by the SPECIES ROSTER (plan §7.1: the deck is the
 * headline). A horizontally-scrollable strip of species chips (color + charm +
 * label + count) sits front-and-centre; clicking one opens the deck focused on
 * that species, and a "+" appends a species when the World's roster is open. The
 * world identity + criterion sentence are demoted to a quiet second line. Right
 * edge: personal best · the Tutor and History toggles. "best" is a personal
 * ceiling ("best so far"), never a class rank (plan §4).
 */

import { memo } from "react";
import { Box, Button, Flex, HStack, Text } from "@chakra-ui/react";
import { ClockCounterClockwise, ChatCircle, Plus } from "@phosphor-icons/react";

import type { DeckCard, SimulatorSpec } from "@/lib/simulator/contract";
import { ECOSYSTEM_LANDSCAPE_DISCLOSURE } from "@/lib/simulator/ecosystemLandscape";
import { colorForSlotIndex, criterionFeedbackSentence, formatMetric, metricLabel } from "./helpers";

export const CriterionBar = memo(function CriterionBar({
  spec,
  title,
  deck,
  speciesIcons,
  bestScore,
  extinct,
  canAddSpecies,
  onFocusSpecies,
  onAddSpecies,
  onToggleHistory,
  historyOpen,
  onToggleTutor,
  tutorOpen,
  onOpenMenu,
}: {
  spec: SimulatorSpec;
  title: string;
  deck: readonly DeckCard[];
  speciesIcons: Record<string, string | undefined>;
  bestScore: number | null;
  extinct: boolean;
  canAddSpecies: boolean;
  onFocusSpecies: (slotId: string) => void;
  onAddSpecies: () => void;
  onToggleHistory: () => void;
  historyOpen: boolean;
  onToggleTutor: () => void;
  tutorOpen: boolean;
  onOpenMenu?: () => void;
}) {
  const isField = spec.templateId === "ecosystemGrid";
  const rosterLabel = isField ? "Species roster" : "Strategy roster";
  const editLabel = isField ? "species" : "strategy";
  const metric =
    spec.criterion.kind === "measured" && bestScore !== null
      ? metricLabel(spec.criterion.metricKey, bestScore)
      : null;
  const countBySlot = new Map(deck.map((card) => [card.slotId, card.count]));

  return (
    <Flex
      align="center"
      justify="space-between"
      gap={3}
      px={{ base: 3, md: 5 }}
      py={2}
      borderBottom="1px solid"
      borderColor="gray.200"
      bg="white"
      minH="56px"
    >
      <HStack gap={2} minW={0} flex={1}>
        {onOpenMenu ? (
          <Button size="xs" variant="ghost" onClick={onOpenMenu} aria-label="Open menu">
            ☰
          </Button>
        ) : null}
        <Box minW={0} flex={1}>
          <HStack
            gap={1.5}
            overflowX="auto"
            pb={0.5}
            css={{ scrollbarWidth: "none" }}
            role="group"
            aria-label={rosterLabel}
          >
            {spec.speciesSlots.map((slot, index) => {
              const count = countBySlot.get(slot.slotId) ?? slot.defaultCount;
              const color = colorForSlotIndex(index);
              const icon = speciesIcons[slot.label];
              return (
                <Button
                  key={slot.slotId}
                  size="2xs"
                  variant="outline"
                  colorPalette="violet"
                  flexShrink={0}
                  onClick={() => onFocusSpecies(slot.slotId)}
                  aria-label={`Edit ${slot.label} ${editLabel} (${count})`}
                >
                  <Box
                    w="14px"
                    h="14px"
                    borderRadius="full"
                    bg={icon ? "transparent" : color}
                    overflow="hidden"
                    flexShrink={0}
                  >
                    {icon ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={icon} alt="" width={14} height={14} style={{ objectFit: "contain" }} />
                    ) : null}
                  </Box>
                  <Text as="span" lineClamp={1}>
                    {slot.label}
                  </Text>
                  <Text as="span" fontWeight="700">
                    ×{count}
                  </Text>
                </Button>
              );
            })}
            {isField && canAddSpecies ? (
              <Button
                size="2xs"
                variant="outline"
                colorPalette="violet"
                flexShrink={0}
                onClick={onAddSpecies}
                aria-label="Add a species"
              >
                <Plus weight="bold" />
              </Button>
            ) : null}
          </HStack>
          <Text
            fontSize="2xs"
            color="gray.500"
            lineClamp={
              spec.templateId === "ecosystemGrid" && spec.config.landscape ? 2 : 1
            }
          >
            {isField ? "🌊 " : ""}{title} · {criterionFeedbackSentence(spec, extinct)}
            {isField && spec.config.landscape ? (
              <>
                <br />
                {ECOSYSTEM_LANDSCAPE_DISCLOSURE}
              </>
            ) : null}
          </Text>
        </Box>
      </HStack>

      <HStack gap={3} flexShrink={0}>
        <Box textAlign="right">
          <Text fontSize="2xs" color="gray.500" lineHeight="1">
            best so far
          </Text>
          <Text fontWeight="700" fontSize="sm" color="charcoal.600">
            {bestScore === null ? "—" : `${formatMetric(bestScore)}${metric ? ` ${metric}` : ""}`}
          </Text>
        </Box>
        <Button
          size="xs"
          variant={tutorOpen ? "solid" : "outline"}
          colorPalette="violet"
          onClick={onToggleTutor}
        >
          <ChatCircle weight="fill" /> Tutor
        </Button>
        <Button
          size="xs"
          variant={historyOpen ? "solid" : "outline"}
          colorPalette="violet"
          onClick={onToggleHistory}
        >
          <ClockCounterClockwise weight="bold" /> History
        </Button>
      </HStack>
    </Flex>
  );
});
