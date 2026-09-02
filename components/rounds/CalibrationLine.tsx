"use client";

/**
 * CalibrationLine — the Predict-then-Check calibration read for one scholar,
 * moved out of the retired CohortFrontier onto the weekly Rounds pane (its
 * correct cadence: a trailing-window metacognitive diagnostic belongs to the
 * weekly per-child conversation, not a live triage board).
 *
 * Reads `api.practiceCalibration.calibrationForScholar` (teacher-facing;
 * scholars never see these numbers) and renders exactly one line beside the
 * week's practice figures. It renders NOTHING below the server's
 * insufficient-data floor — the `calibrationFigureLine` helper returns null and
 * we return null, so a data-poor week shows no empty shell. Growth-framed: the
 * copy describes the child's PREDICTIONS versus results, never a score on the
 * child.
 */

import { useQuery } from "convex/react";
import { Box, HStack, Stack, Text } from "@chakra-ui/react";
import { Target, Compass } from "@phosphor-icons/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { calibrationFigureLine } from "./roundsFigures";

export function CalibrationLine({ scholarId }: { scholarId: Id<"users"> }) {
  const calibration = useQuery(api.practiceCalibration.calibrationForScholar, {
    scholarId,
  });
  const line = calibrationFigureLine(calibration);
  if (!line) return null;

  const Icon = line.wellCalibrated ? Target : Compass;
  const iconColor = line.wellCalibrated ? "green.500" : "charcoal.400";

  return (
    <HStack
      gap={2}
      align="flex-start"
      borderWidth="1px"
      borderColor="gray.200"
      borderRadius="md"
      bg="gray.50"
      px={4}
      py={3}
    >
      <Box as="span" color={iconColor} mt="1px" flexShrink={0}>
        <Icon size={16} weight="bold" />
      </Box>
      <Stack gap={0.5} minW={0}>
        <Text fontFamily="heading" fontSize="sm" fontWeight="600" color="charcoal.500">
          {line.label}
        </Text>
        <Text
          fontFamily="heading"
          fontSize="md"
          fontWeight="700"
          color={line.wellCalibrated ? "green.600" : "navy.500"}
        >
          {line.value}
        </Text>
        <Text fontFamily="body" fontSize="sm" color="charcoal.300">
          {line.caption}
        </Text>
      </Stack>
    </HStack>
  );
}
