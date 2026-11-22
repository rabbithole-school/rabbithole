"use client";

import { useRef, useState } from "react";
import { Box, HStack, Text } from "@chakra-ui/react";
import { FieldSelect } from "@/components/ui/FieldSelect";
import { gradeLabelFromRank } from "@/shared/gradeRange";
import {
  UNIT_GRADE_HIGHEST,
  UNIT_GRADE_LOWEST,
  unitGradePickerState,
  withUnitGradeFrom,
  withUnitGradeTo,
} from "@/shared/unitGrade";

/** The quiet line under a saved grade the picker can't read. */
export const UNREADABLE_GRADE_HINT = "Not a grade from K to 8. Pick the grades this unit is for.";

const RANKS = Array.from(
  { length: UNIT_GRADE_HIGHEST - UNIT_GRADE_LOWEST + 1 },
  (_, i) => UNIT_GRADE_LOWEST + i,
);
// The first select's value for a saved grade it can't read (never a rank).
const AS_SAVED = "saved";

/**
 * The unit's grade picker: one grade, or a span from one grade to another,
 * within K–8 (`shared/unitGrade.ts`). Each pick saves at once, in the one
 * stored form, and shows at once: the next pick builds on it even before the
 * save comes back. A saved grade the picker can't read keeps showing as-is,
 * with a quiet prompt, and nothing changes until a teacher picks.
 */
export function GradePicker({
  gradeLevel,
  onPick,
  hint = true,
}: {
  /** The unit's saved grade level. */
  gradeLevel: string | null | undefined;
  /** Save this grade level (null clears it). A returned promise settling
   *  hands the display back to `gradeLevel`. */
  onPick: (next: string | null) => unknown;
  /** Show the prompt under a grade it can't read. Off where the caller shows
   *  it already, or for a scholar's own unit (no grade rules). */
  hint?: boolean;
}) {
  // The last pick, shown until its save settles (then `gradeLevel` has it).
  const [pending, setPending] = useState<{ value: string | null; seq: number } | null>(null);
  const seq = useRef(0);
  const pick = (next: string | null) => {
    const mine = ++seq.current;
    setPending({ value: next, seq: mine });
    void Promise.resolve(onPick(next)).finally(() =>
      setPending((p) => (p?.seq === mine ? null : p)),
    );
  };
  const { span, unreadable } = unitGradePickerState(pending ? pending.value : gradeLevel);
  const fromValue = unreadable ? AS_SAVED : span ? String(span.from) : "";
  return (
    <Box>
      <HStack gap={2}>
        <FieldSelect
          flex={1}
          value={fromValue}
          onChange={(next) => {
            if (next === fromValue || next === AS_SAVED) return;
            pick(withUnitGradeFrom(span, next === "" ? null : Number(next)));
          }}
          fieldProps={{ "aria-label": "First grade" }}
        >
          <option value="">No grade</option>
          {unreadable && <option value={AS_SAVED}>{unreadable}</option>}
          {RANKS.map((rank) => (
            <option key={rank} value={String(rank)}>
              {gradeLabelFromRank(rank)}
            </option>
          ))}
        </FieldSelect>
        <Text fontSize="sm" fontFamily="body" color="charcoal.400" flexShrink={0}>
          to
        </Text>
        <FieldSelect
          flex={1}
          value={span ? String(span.to) : ""}
          disabled={!span}
          onChange={(next) => {
            if (span && next !== String(span.to)) pick(withUnitGradeTo(span, Number(next)));
          }}
          fieldProps={{ "aria-label": "Last grade" }}
        >
          {!span && <option value="" />}
          {RANKS.filter((rank) => !span || rank >= span.from).map((rank) => (
            <option key={rank} value={String(rank)}>
              {gradeLabelFromRank(rank)}
            </option>
          ))}
        </FieldSelect>
      </HStack>
      {hint && unreadable && (
        <Text mt={1} fontSize="xs" color="charcoal.400" fontFamily="body">
          {UNREADABLE_GRADE_HINT}
        </Text>
      )}
    </Box>
  );
}
