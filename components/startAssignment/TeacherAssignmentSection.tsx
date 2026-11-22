"use client";

// The teacher-assignment mode's own settings rendering: scholar picker, the
// optional Simulator run budget, the two give questions (shows up / finish,
// components/GiveWindowFields.tsx), and the per-activity "For" subset. Split out
// of StartAssignmentDialog so a third scheduling mode is a sibling module
// rather than another branch in the shared shell (TRA-21).

import { Box, Button, Flex, HStack, Text } from "@chakra-ui/react";
import { Warning } from "@phosphor-icons/react";
import { ScholarPicker, ScholarPickerContent } from "@/components/ScholarPicker";
import type { RosterScholar } from "@/hooks/useScholarRoster";
import {
  SimulatorRunBudgetFields,
  type SimulatorRunBudgetValue,
} from "@/components/simulatorTeacher/SimulatorRunBudgetFields";
import {
  GiveWindowFields,
  type GiveChoices,
  type GiveRefusal,
  type GiveFinish,
  type ShowsUp,
} from "@/components/GiveWindowFields";
import { SubLabel } from "./primitives";

export function TeacherSettings({
  scholarSel,
  runnerRoster,
  onScholarSelChange,
  hasWorldTarget,
  worldBudget,
  onWorldBudgetChange,
  isSingleActivity,
  deliverNow,
  nowMs,
  giveChoices,
  showsUp,
  setShowsUp,
  finish,
  setFinish,
  effectiveForSel,
  setForSel,
  forScholarIds,
  handleForSelChange,
  isPast,
  targetKind,
}: {
  scholarSel: Set<string>;
  /** A curriculum:run holder's assignee roster (identity only). When set, the
   *  pickers render it instead of the teacher roster, which she cannot read. */
  runnerRoster?: RosterScholar[];
  onScholarSelChange: (selection: Set<string>) => void;
  hasWorldTarget: boolean;
  worldBudget: SimulatorRunBudgetValue;
  onWorldBudgetChange: (next: SimulatorRunBudgetValue) => void;
  isSingleActivity: boolean;
  deliverNow: boolean;
  nowMs: number;
  giveChoices: GiveChoices | GiveRefusal | null | undefined;
  showsUp: ShowsUp;
  setShowsUp: (value: ShowsUp) => void;
  finish: GiveFinish | null;
  setFinish: (value: GiveFinish) => void;
  effectiveForSel: Set<string> | null;
  setForSel: (value: Set<string> | null) => void;
  forScholarIds: string[];
  handleForSelChange: (next: Set<string>) => void;
  isPast: boolean;
  targetKind: "unit" | "lesson" | "activity";
}) {
  return (
    <>
      <Box>
        <Text
          fontSize="xs"
          color="charcoal.400"
          fontFamily="heading"
          fontWeight="600"
          textTransform="uppercase"
          letterSpacing="0.04em"
          mb={2}
        >
          Scholars
        </Text>
        {runnerRoster ? (
          <ScholarPickerContent
            mode="multi"
            scholars={runnerRoster}
            selected={scholarSel}
            onChange={onScholarSelChange}
            showGroups={false}
            showAffinityToggle={false}
            maxH="220px"
            emptyHint="No scholars at this unit's school."
          />
        ) : (
          <ScholarPicker
            mode="multi"
            selected={scholarSel}
            onChange={onScholarSelChange}
            maxH="220px"
          />
        )}
      </Box>

      {/* World run budget + season — per-scholar execution policy for the
          cohort's Workbench Worlds (plan §8 Assign). Uses the ONE shared
          budget primitive; shown when the picked target is a World. */}
      {hasWorldTarget && (
        <Box>
          <Text
            fontSize="xs"
            color="charcoal.400"
            fontFamily="heading"
            fontWeight="600"
            textTransform="uppercase"
            letterSpacing="0.04em"
            mb={2}
          >
            🌍 Simulator run budget &amp; season (per scholar)
          </Text>
          <SimulatorRunBudgetFields
            value={worldBudget}
            onChange={onWorldBudgetChange}
          />
        </Box>
      )}

      {/* When it shows up and when they should finish it (TRA-571). */}
      <Box>
        <GiveWindowFields
          choices={giveChoices}
          nowMs={nowMs}
          showsUp={showsUp}
          onShowsUpChange={setShowsUp}
          finish={finish}
          onFinishChange={setFinish}
        />

        {isSingleActivity && (
          <Box
            mt={4}
            p={3}
            bg="white"
            borderWidth="1px"
            borderColor="gray.200"
            borderRadius="md"
          >
            <Flex align="flex-start" justify="space-between" gap={3}>
              <Box flex={1} minW={0}>
                <SubLabel>For</SubLabel>
                <Text
                  fontSize="sm"
                  fontFamily="heading"
                  fontWeight={effectiveForSel === null ? "500" : "600"}
                  color={effectiveForSel === null ? "charcoal.400" : "navy.500"}
                >
                  {effectiveForSel === null
                    ? "Everyone in this assignment"
                    : effectiveForSel.size === 0
                      ? "Everyone (no specific scholars selected)"
                      : effectiveForSel.size === scholarSel.size
                        ? "Everyone selected"
                        : `${effectiveForSel.size} specific scholar${effectiveForSel.size === 1 ? "" : "s"}`}
                </Text>
              </Box>
              <Button
                size="2xs"
                variant={effectiveForSel === null ? "outline" : "ghost"}
                color={effectiveForSel === null ? "violet.600" : "charcoal.500"}
                borderColor="violet.200"
                fontFamily="heading"
                onClick={() =>
                  setForSel(
                    effectiveForSel === null ? new Set(scholarSel) : null,
                  )
                }
              >
                {effectiveForSel === null
                  ? "Choose specific scholars"
                  : "Use everyone"}
              </Button>
            </Flex>

            {effectiveForSel !== null && (
              <Box mt={3}>
                {runnerRoster ? (
                  <ScholarPickerContent
                    mode="multi"
                    scholars={runnerRoster}
                    selected={effectiveForSel}
                    onChange={handleForSelChange}
                    scholarIds={forScholarIds}
                    showGroups={false}
                    showAffinityToggle={false}
                    maxH="180px"
                    emptyHint={
                      scholarSel.size === 0
                        ? "Pick scholars above first."
                        : "No scholars in this assignment."
                    }
                  />
                ) : (
                <ScholarPicker
                  mode="multi"
                  selected={effectiveForSel}
                  onChange={handleForSelChange}
                  scholarIds={forScholarIds}
                  maxH="180px"
                  emptyHint={
                    scholarSel.size === 0
                      ? "Pick scholars above first."
                      : "No scholars in this assignment."
                  }
                />
                )}
              </Box>
            )}

            <Text fontSize="xs" color="charcoal.400" fontFamily="body" mt={2}>
              Only these scholars will see this activity. Leave as Everyone to
              assign it to the whole group.
            </Text>
          </Box>
        )}

        {!isSingleActivity && (
          <Text fontSize="xs" color="charcoal.400" fontFamily="body" mt={2}>
            Every activity in the {targetKind === "lesson" ? "lesson" : "unit"}{" "}
            {showsUp.kind === "now"
              ? "goes live now"
              : `shows up ${new Intl.DateTimeFormat("en-US", {
                  weekday: "short",
                  month: "short",
                  day: "numeric",
                  hour: "numeric",
                  minute: "2-digit",
                  timeZone:
                    giveChoices && "timeZone" in giveChoices
                      ? giveChoices.timeZone
                      : undefined,
                }).format(new Date(showsUp.at))}`}{" "}
            with the same finish.
          </Text>
        )}

        {isPast && !(isSingleActivity && deliverNow) && (
          <HStack
            gap={2}
            px={3}
            py={2}
            mt={2}
            bg="orange.50"
            borderWidth="1px"
            borderColor="orange.200"
            borderRadius="md"
          >
            <Warning size={16} color="var(--chakra-colors-orange-500)" />
            <Text fontSize="xs" color="orange.700" fontFamily="heading">
              That time is in the past — it won&apos;t auto-start. It stays
              planned until you hit Start now.
            </Text>
          </HStack>
        )}
      </Box>
    </>
  );
}
