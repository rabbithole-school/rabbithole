"use client";

/**
 * DueChip (web) — THE one rendering of a deadline anywhere a scholar sees one.
 *
 * Before this existed the same fact was drawn four different ways on the Home
 * screen alone: an amber pill on the right of Coming up, a left-aligned
 * bordered pill in the Now digest, an orange sub-line under the plate row, and
 * an orange replacement of the take-home row's attribution. Two of them also
 * spoke a second lexicon ("due Thu" where the rest of the app says "due
 * Thursday"). One signal, one canonical rendering (T1).
 *
 * The shape never varies: a pill in the row's status slot, carrying the FULL
 * phrase from `dueStatus()`. Urgency changes TONE only — never position, never
 * size, never whether the phrase is abbreviated. A scholar learns one thing to
 * look for and then only has to read its colour.
 *
 * Tone is derived, not passed:
 *   loud  — overdue or due today. The two cases a scholar must act on tonight.
 *   quiet — due later. Real information, but not an alarm.
 *
 * `closures` applies the "this week" display rule (TRA-581): work due on its
 * week's last school day says "due this week" instead of a weekday. Still the
 * same pill; only the phrase changes.
 *
 * `floor` lets a surface RAISE the minimum emphasis (a printed take-home sheet
 * treats everything on it as tonight's business) without inventing a different
 * form. A surface may set a floor; it may never change the shape.
 */

import { Box, Text } from "@chakra-ui/react";
import { homeworkDueStatus, type WeekClosure } from "@/shared/homeworkWeek";

export type DueTone = "quiet" | "loud";

const TONES: Record<DueTone, { bg: string; color: string }> = {
  quiet: { bg: "gray.100", color: "charcoal.500" },
  loud: { bg: "orange.50", color: "orange.600" },
};

/** The neutral pill every status chip shares — a deadline, a start time, a
 *  future non-deadline status. Exported so a caller can fill the same slot
 *  with a non-due fact without hand-rolling the geometry. */
export function StatusChip({
  children,
  tone = "quiet",
}: {
  children: React.ReactNode;
  tone?: DueTone;
}) {
  const { bg, color } = TONES[tone];
  return (
    <Box flexShrink={0} bg={bg} borderRadius="full" px={2} py={0.5}>
      <Text fontSize="2xs" fontFamily="heading" fontWeight="600" color={color}>
        {children}
      </Text>
    </Box>
  );
}

export function DueChip({
  dueAt,
  nowMs,
  timeZone,
  floor,
  closures,
}: {
  dueAt: number | null | undefined;
  nowMs: number;
  timeZone: string;
  /** Raise the minimum tone for this surface. Never lowers a loud deadline. */
  floor?: DueTone;
  /** The school's closures. Given, a due date on its week's last school day
   *  reads "due this week" / "due next week" (shared/homeworkWeek.ts). */
  closures?: readonly WeekClosure[];
}) {
  const due = homeworkDueStatus(dueAt, nowMs, timeZone, closures);
  // No deadline is not an empty chip — it is no chip. An assigned activity with
  // no due date is a real, common case and must not render a hole.
  if (!due) return null;
  const urgent = due.status === "overdue" || due.status === "dueToday";
  const tone: DueTone = urgent || floor === "loud" ? "loud" : "quiet";
  return <StatusChip tone={tone}>{due.phrase}</StatusChip>;
}
