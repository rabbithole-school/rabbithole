"use client";

/**
 * The Rounds instance of the shared `WorkTableHeader` — the meeting framing:
 * the week window and, under a group scope, the scope-count line, plus the SEL
 * not-configured empty state. It composes `WorkTableHeader` so the title +
 * subtitle SHAPE (and therefore the height) matches the Homework tab's header —
 * the table below never jumps when switching tabs.
 *
 * There is no open/close control any more: Rounds has no meeting state machine.
 * A meeting materializes the first time the room writes a note (see
 * `convex/rounds.ts` `ensureMeeting`), so the header carries no action.
 */

import { Stack, Text } from "@chakra-ui/react";
import type { FunctionReturnType } from "convex/server";

import { api } from "@/convex/_generated/api";
import { Surface } from "@/components/ui/Surface";
import type { RoundsCadenceKind } from "@/lib/roundsCadence";

import { roundsWindowLabel } from "./roundsEvidence";
import { scopeCountLabel } from "./roundsBoardScope";
import {
  WorkTableHeader,
  type SubtitleLine,
} from "@/app/teacher/(dashboard)/_components/WorkTableHeader";

type WeekPayload = FunctionReturnType<typeof api.rounds.week>;

const CADENCE_TITLE: Record<RoundsCadenceKind, string> = {
  academic: "Academic Rounds",
  sel: "SEL Rounds",
};

export function RoundsBoardHeader({
  cadence,
  week,
  scoped,
  shownCount,
  totalCount,
  reservedLines,
}: {
  cadence: RoundsCadenceKind;
  /** The `api.rounds.week` payload, or undefined while it first loads. */
  week: WeekPayload | undefined;
  /** A group scope is active (the board shows fewer rows than the institution). */
  scoped: boolean;
  shownCount: number;
  totalCount: number;
  /** Reserved subtitle line slots — shared with the Homework header so the
   *  block height matches across tabs. */
  reservedLines: number;
}) {
  const title = CADENCE_TITLE[cadence];

  // SEL has no configured cadence for this school. Not a crash and not the
  // academic week — one calm sentence pointing at where a cadence is set. The
  // title keeps the shared shape; the grade/name columns below stay solid.
  if (week && !week.configured) {
    return (
      <WorkTableHeader title={title} subtitle={[]} reservedLines={reservedLines}>
        <Surface p={{ base: 6, lg: 10 }}>
          <Stack gap={2} maxW="34rem" data-testid="rounds-sel-unconfigured">
            <Text fontFamily="heading" fontSize="md" fontWeight="700" color="charcoal.600">
              SEL Rounds isn&rsquo;t set up for this school yet.
            </Text>
            <Text fontFamily="body" fontSize="sm" color="charcoal.500" lineHeight="1.6">
              Add an SEL cadence in the school&rsquo;s Rounds settings — a weekday
              and time for the meeting — and this lens will fill in. Until then,
              the Academic lens above is the running meeting.
            </Text>
          </Stack>
        </Surface>
      </WorkTableHeader>
    );
  }

  const countLine = scopeCountLabel(shownCount, totalCount, scoped);

  // The subtitle: the week window, then the scope-count line when a group scope
  // narrows the board. Gated on `week` so nothing renders (as content) until the
  // payload lands; the reserved slots still hold the height in the meantime.
  const subtitle: (SubtitleLine | null)[] = week
    ? [
        { text: roundsWindowLabel(week.window.startMs, week.window.endMs), tone: "strong" },
        ...(countLine
          ? [{ text: countLine, tone: "muted" as const, testId: "rounds-scope-count" }]
          : []),
      ]
    : [];

  return (
    <WorkTableHeader title={title} subtitle={subtitle} reservedLines={reservedLines} />
  );
}
