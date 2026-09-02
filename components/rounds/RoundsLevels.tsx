"use client";

/**
 * Reading and writing, told apart.
 *
 * THREE instruments share a vocabulary in this product and must never share a
 * rendering:
 *
 *   confirmed          a teacher-ratified SETTING the tutor adapts to. `setAt`
 *                      is when a human ratified, not when anything was measured.
 *   writing estimate   derived from the child's OWN PRODUCTION — typed chat and
 *                      OCR'd handwriting. No reception evidence exists anywhere
 *                      in this system, so this is never called a reading level.
 *                      It is stored only while it disagrees, so its presence is
 *                      the signal.
 *   writing complexity Flesch–Kincaid over typed messages. Mechanical. Its
 *                      canonical rendering is the profile chart; we state the
 *                      latest value and point there instead of drawing a second.
 *
 * The board carries `confirmed` for everyone and surfaces the estimate only
 * where it disagrees. The pane shows all three, each labelled for its own
 * instrument, with the estimate's age visible so staleness is legible.
 */

import { Badge, Button, HStack, Stack, Text } from "@chakra-ui/react";
import { useMutation } from "convex/react";
import { useState } from "react";

import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";

import {
  confirmedLevelLine,
  levelPhrase,
  writingComplexityLine,
  writingEstimateLine,
  type RoundsLevelSignals,
} from "./roundsFigures";

/**
 * Said when the level read was refused — non-teaching operations staff have no
 * access to it. A quiet "not available", never an error banner: the rest of the
 * week is theirs to read, and the meeting should not stop for a boundary
 * working as designed.
 */
const LEVEL_UNAVAILABLE = "Reading level not available to your role";

/** The compact board form: the setting, plus the disagreement when there is one. */
export function RoundsLevelLine({
  signals,
  scholarName,
  unavailable = false,
}: {
  signals: RoundsLevelSignals | null;
  scholarName: string;
  unavailable?: boolean;
}) {
  if (unavailable) {
    return (
      <Text fontFamily="heading" fontSize="sm" fontWeight="600" color="charcoal.300">
        {LEVEL_UNAVAILABLE}
      </Text>
    );
  }
  if (!signals) return null;
  const confirmed = confirmedLevelLine(signals);
  const estimate = writingEstimateLine(signals, scholarName);

  return (
    <Stack gap={1}>
      <Text fontFamily="heading" fontSize="sm" fontWeight="600" color="charcoal.400">
        {confirmed.headline}
      </Text>
      {estimate ? (
        <Stack
          gap={0.5}
          borderWidth="1px"
          borderColor="orange.300"
          bg="orange.50"
          borderRadius="md"
          px={2}
          py={1.5}
        >
          <Text fontFamily="heading" fontSize="sm" fontWeight="700" color="charcoal.500">
            {estimate.headline}
          </Text>
          <Text fontFamily="body" fontSize="sm" color="charcoal.400">
            {estimate.shortCaption}
          </Text>
        </Stack>
      ) : null}
    </Stack>
  );
}

/** The pane form: all three instruments, told apart. The estimate DECISION is
 *  hoisted out to `RoundsLevelRuling` so the one real action on the pane is
 *  visible without scrolling; this card is the reference reading of each
 *  instrument, not where the ruling is made. */
export function RoundsLevelCard({
  scholarName,
  signals,
  writingComplexity,
  unavailable = false,
}: {
  scholarName: string;
  signals: RoundsLevelSignals | null;
  /** Latest Flesch–Kincaid grade level over typed messages, or null. */
  writingComplexity: number | null;
  /** The level read was refused for this viewer. Say so; show the rest. */
  unavailable?: boolean;
}) {
  const complexityOnly = writingComplexityLine(writingComplexity);
  if (unavailable || !signals) {
    if (!unavailable) return null;
    return (
      <Stack gap={4}>
        <Text fontFamily="body" fontSize="sm" color="charcoal.400">
          {LEVEL_UNAVAILABLE}. The rest of {scholarName}&rsquo;s week is below.
        </Text>
        <Stack gap={0.5}>
          <Text fontFamily="heading" fontSize="sm" fontWeight="600" color="charcoal.400">
            {complexityOnly.headline}
          </Text>
          <Text fontFamily="body" fontSize="sm" color="charcoal.300">
            {complexityOnly.caption}
          </Text>
        </Stack>
      </Stack>
    );
  }

  const confirmed = confirmedLevelLine(signals);
  const estimate = writingEstimateLine(signals, scholarName);
  const complexity = writingComplexityLine(writingComplexity);

  return (
    <Stack gap={4}>
      <Stack gap={1}>
        <HStack gap={2} align="baseline" flexWrap="wrap">
          <Text fontFamily="heading" fontSize="md" fontWeight="700" color="charcoal.600">
            {confirmed.headline}
          </Text>
          <Badge
            variant="subtle"
            colorPalette="gray"
            fontFamily="heading"
            fontSize="xs"
          >
            The tutor adapts to this
          </Badge>
        </HStack>
        {confirmed.caption ? (
          <Text fontFamily="body" fontSize="sm" color="charcoal.400">
            {confirmed.caption}
          </Text>
        ) : null}
      </Stack>

      {estimate ? (
        <Text fontFamily="body" fontSize="sm" color="charcoal.400">
          {estimate.headline} — settle it at the top of the week.
        </Text>
      ) : (
        <Text fontFamily="body" fontSize="sm" color="charcoal.400">
          {scholarName}&rsquo;s writing currently agrees with that setting, so
          there is no estimate to settle.
        </Text>
      )}

      <Stack gap={0.5}>
        <Text fontFamily="heading" fontSize="sm" fontWeight="600" color="charcoal.400">
          {complexity.headline}
        </Text>
        <Text fontFamily="body" fontSize="sm" color="charcoal.300">
          {complexity.caption} Its chart lives on the profile as &ldquo;Scholar
          writing over time&rdquo;.
        </Text>
      </Stack>
    </Stack>
  );
}

/**
 * The one real decision on the pane, lifted out of the reading card so it is
 * visible without scrolling: accept the writing-derived estimate as the
 * confirmed setting, or keep the standing ruling. Renders NOTHING unless an
 * estimate is currently disagreeing — agreement clears it server-side, so a
 * returned estimate always means there is a decision to make.
 *
 * The mutation logic lives here, once. `RoundsLevelCard` explains the
 * instruments; this is where the ruling is made.
 */
export function RoundsLevelRuling({
  scholarId,
  scholarName,
  signals,
  unavailable = false,
}: {
  scholarId: Id<"users">;
  scholarName: string;
  signals: RoundsLevelSignals | null;
  unavailable?: boolean;
}) {
  const accept = useMutation(api.scholars.acceptReadingLevelSuggestion);
  const dismiss = useMutation(api.scholars.dismissReadingLevelSuggestion);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const estimate = signals ? writingEstimateLine(signals, scholarName) : null;
  if (unavailable || !signals || !estimate) return null;

  const run = async (action: "accept" | "dismiss") => {
    setBusy(true);
    setFailure(null);
    try {
      if (action === "accept") await accept({ scholarId });
      else await dismiss({ scholarId });
    } catch {
      setFailure(
        `That did not save, so ${scholarName}'s level is unchanged. Try again in a moment.`,
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <Stack
      gap={2}
      borderWidth="1px"
      borderColor="orange.300"
      bg="orange.50"
      borderRadius="md"
      p={4}
    >
      <Text fontFamily="heading" fontSize="md" fontWeight="700" color="charcoal.600">
        {estimate.headline}
      </Text>
      <Text fontFamily="body" fontSize="sm" color="charcoal.500">
        {estimate.caption}
      </Text>
      <HStack gap={3} flexWrap="wrap" pt={1}>
        <Button
          size="sm"
          colorPalette="navy"
          fontFamily="heading"
          loading={busy}
          onClick={() => void run("accept")}
        >
          Use {levelPhrase(signals.estimate.level)}
        </Button>
        <Button
          size="sm"
          variant="outline"
          fontFamily="heading"
          loading={busy}
          onClick={() => void run("dismiss")}
        >
          {estimate.dismissLabel}
        </Button>
      </HStack>
      {failure ? (
        <Text fontFamily="body" fontSize="sm" color="red.600">
          {failure}
        </Text>
      ) : null}
    </Stack>
  );
}
