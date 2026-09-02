"use client";

/**
 * The per-scholar CONTENT cell of a Rounds row — everything to the right of the
 * shared grade + name columns: the single load-bearing headline, the promoted
 * detail chips (evidence density / running guidance) and the staff note.
 *
 * Extracted verbatim from the old RoundsWeekBoard `ScholarRow` so the shared
 * `ScholarWorkTable` (Homework · Academic Rounds · SEL Rounds) can render the
 * grade/name columns ONCE and swap only this cell as the tab changes — the
 * evidence/synthesis rendering is MOVED here, not re-derived.
 */

import { useMemo } from "react";
import { Box, HStack, Stack, Text } from "@chakra-ui/react";
import { NotePencil } from "@phosphor-icons/react";
import type { FunctionReturnType } from "convex/server";

import { api } from "@/convex/_generated/api";
import type { RoundsCadenceKind } from "@/lib/roundsCadence";

import { selRowHeadline, selTeacherRecord, type SelSynthesisRow } from "./selSynthesisView";
import { roundsHeadline } from "./roundsEvidence";
import {
  academicRowDetail,
  selRowDetail,
  type RoundsRowDetailChip,
} from "./roundsRowDetail";

export type WeekScholar = FunctionReturnType<
  typeof api.rounds.week
>["scholars"][number];

/**
 * One promoted detail chip under the row headline. Guidance is the only chip
 * that reaches green — it is the signal spoken to the child — so everything
 * else stays muted charcoal.
 */
function DetailChip({ chip }: { chip: RoundsRowDetailChip }) {
  const guidance = chip.tone === "guidance";
  return (
    <HStack gap={1.5} align="center" flexShrink={0}>
      {guidance ? (
        <Box
          w="0.4rem"
          h="0.4rem"
          borderRadius="full"
          bg="green.500"
          flexShrink={0}
          aria-hidden
        />
      ) : null}
      <Text
        fontFamily="heading"
        fontSize="xs"
        fontWeight={guidance ? "600" : "500"}
        color={guidance ? "charcoal.500" : "charcoal.400"}
        lineClamp={1}
      >
        {chip.text}
      </Text>
    </HStack>
  );
}

export function RoundsRowContent({
  scholar,
  cadence,
  synthesis,
  synthesisLoading,
}: {
  scholar: WeekScholar;
  cadence: RoundsCadenceKind;
  /** The week's SEL synthesis for this scholar (SEL cadence only). */
  synthesis: SelSynthesisRow | null;
  synthesisLoading: boolean;
}) {
  const sel = cadence === "sel";
  const evidenceInput = useMemo(
    () => ({
      observations: scholar.observations,
      mastery: scholar.mastery,
      practice: scholar.practice,
      pulse: scholar.pulse,
    }),
    [scholar.observations, scholar.mastery, scholar.practice, scholar.pulse],
  );
  const headline = sel
    ? selRowHeadline(synthesis, synthesisLoading)
    : roundsHeadline(evidenceInput);

  const guidanceCount = scholar.guidance.length;
  const detail = useMemo(
    () =>
      sel
        ? selRowDetail(
            synthesis,
            selTeacherRecord(scholar.observations).length,
            guidanceCount,
          )
        : academicRowDetail(evidenceInput, guidanceCount),
    [sel, synthesis, scholar.observations, evidenceInput, guidanceCount],
  );

  const noteFirstLine = scholar.note?.trim()
    ? scholar.note.trim().split(/\r?\n/)[0]
    : null;

  return (
    <Stack gap={1.5} minW={0}>
      {/* The single most load-bearing headline for this scholar's week. */}
      <Text
        fontFamily="body"
        fontSize="xs"
        color={headline.quiet ? "charcoal.300" : "charcoal.500"}
        fontStyle={headline.quiet ? "italic" : "normal"}
        minW={0}
        lineClamp={1}
      >
        {headline.text}
      </Text>

      {/* The promoted signals — how much happened, whether standing guidance is
          running, and the staff note if one exists — so the row answers "who
          needs the room's time?" unopened. */}
      {detail.length > 0 || noteFirstLine ? (
        <HStack gap={{ base: 2, lg: 4 }} align="center" minW={0} rowGap={1} flexWrap="wrap">
          {detail.map((chip) => (
            <DetailChip key={chip.key} chip={chip} />
          ))}
          {noteFirstLine ? (
            <HStack gap={1} align="center" color="charcoal.300" flex="1" minW={0}>
              <NotePencil size={13} weight="regular" aria-hidden />
              <Text fontFamily="body" fontSize="xs" lineClamp={1}>
                {noteFirstLine}
              </Text>
            </HStack>
          ) : null}
        </HStack>
      ) : null}
    </Stack>
  );
}
