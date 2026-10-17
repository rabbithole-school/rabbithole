"use client";

// The teacher-assignment mode's own settings rendering: scholar picker, the
// optional Simulator run budget, and the "When" panel (deliver now vs plan,
// class-focus vs homework, timing, the per-activity "For" subset). Split out
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
import { ActivityModeBadge, type ActivityMode } from "@/lib/activityMode";
import { DURATIONS } from "./scheduling";
import { DateTimeInput, PlainSelect, SubLabel } from "./primitives";

export function TeacherSettings({
  scholarSel,
  runnerRoster,
  onScholarSelChange,
  hasWorldTarget,
  worldBudget,
  onWorldBudgetChange,
  isSingleActivity,
  deliverNow,
  setDeliverNow,
  mode,
  setMode,
  startsAt,
  setStartsAt,
  durationMin,
  setDurationMin,
  dueAt,
  setDueAt,
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
  setDeliverNow: (value: boolean) => void;
  mode: ActivityMode;
  setMode: (value: ActivityMode) => void;
  startsAt: string;
  setStartsAt: (value: string) => void;
  durationMin: number;
  setDurationMin: (value: number) => void;
  dueAt: string;
  setDueAt: (value: string) => void;
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

      {/* When — a single activity can go live now or be planned; a unit/lesson
          always lands on the calendar. */}
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
          When
        </Text>

        {isSingleActivity && (
          <HStack gap={2} mb={3}>
            {(
              [
                { key: true, label: "Start now" },
                { key: false, label: "Schedule" },
              ] as const
            ).map((opt) => (
              <Box
                as="button"
                key={opt.label}
                onClick={() => setDeliverNow(opt.key)}
                aria-pressed={deliverNow === opt.key}
                px={3}
                py={1.5}
                borderRadius="md"
                borderWidth="1px"
                borderColor={deliverNow === opt.key ? "violet.300" : "gray.200"}
                bg={deliverNow === opt.key ? "violet.50" : "white"}
                cursor="pointer"
                _hover={{
                  bg: deliverNow === opt.key ? undefined : "gray.50",
                }}
                fontFamily="heading"
                fontWeight="700"
                fontSize="sm"
                color={deliverNow === opt.key ? "violet.700" : "charcoal.500"}
              >
                {opt.label}
              </Box>
            ))}
          </HStack>
        )}

        {isSingleActivity && (
          <HStack gap={2} mb={3}>
            {(["classFocus", "homework"] as ActivityMode[]).map((m) => (
              <Box
                as="button"
                key={m}
                onClick={() => setMode(m)}
                px={3}
                py={1.5}
                borderRadius="md"
                borderWidth="1px"
                borderColor={
                  mode === m
                    ? m === "classFocus"
                      ? "violet.300"
                      : "orange.300"
                    : "gray.200"
                }
                bg={
                  mode === m
                    ? m === "classFocus"
                      ? "violet.50"
                      : "orange.50"
                    : "white"
                }
                cursor="pointer"
                _hover={{ bg: mode === m ? undefined : "gray.50" }}
              >
                <ActivityModeBadge mode={m} variant="soft" />
              </Box>
            ))}
          </HStack>
        )}

        <HStack gap={4} align="flex-start" flexWrap="wrap">
          {!(isSingleActivity && deliverNow) && (
            <Box flex={1} minW="200px">
              <SubLabel>
                {isSingleActivity && mode === "homework"
                  ? "Assign at"
                  : "Starts"}
              </SubLabel>
              <DateTimeInput value={startsAt} onChange={setStartsAt} />
            </Box>
          )}
          {isSingleActivity && mode === "classFocus" && (
            <Box minW="140px">
              <SubLabel>Duration</SubLabel>
              <PlainSelect
                value={String(durationMin)}
                onChange={(v) => setDurationMin(Number(v))}
              >
                {DURATIONS.map((d) => (
                  <option key={d.min} value={d.min}>
                    {d.label}
                  </option>
                ))}
              </PlainSelect>
            </Box>
          )}
          {isSingleActivity && mode === "homework" && (
            <Box flex={1} minW="200px">
              <SubLabel>Due</SubLabel>
              <DateTimeInput value={dueAt} onChange={setDueAt} />
            </Box>
          )}
        </HStack>

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
            The {targetKind === "lesson" ? "lesson" : "unit"}&apos;s activities
            lay onto the agenda from this date using the pacing set in the
            curriculum. Anything without a set gap lands on the start date —
            push those to the class with &ldquo;Start now&rdquo; as you reach
            them.
          </Text>
        )}

        {isSingleActivity && deliverNow && (
          <Text fontSize="xs" color="charcoal.400" fontFamily="body" mt={2}>
            Scholars see this activity right away.
            {mode === "classFocus"
              ? " It clears from class focus after the duration above."
              : " It lands on their plate with the due date above."}
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
