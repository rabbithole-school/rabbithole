"use client";

/**
 * WorkTableHeader — the ONE header shape above the shared `ScholarWorkTable`,
 * rendered identically for all three tabs (Homework · Academic Rounds · SEL
 * Rounds) so switching tabs never moves the table's top edge.
 *
 * HEIGHT STABILITY: the subtitle is a fixed number of line SLOTS
 * (`reservedLines`). Real lines fill from the top; the remainder render as
 * invisible `\u00A0` lines of the same `sm` type, so the block's height is a
 * pure function of `reservedLines`, not of how much any one tab has to say.
 * The layout derives `reservedLines` from the scope state (which does not
 * change on a tab switch), so the header height is constant across tabs and
 * across the Rounds week-payload load (empty slots hold the space until data
 * arrives). The right action slot reserves the meeting button's height so an
 * empty slot (Homework) matches a filled one (Rounds).
 */

import type { ReactNode } from "react";
import { Box, HStack, Stack, Text } from "@chakra-ui/react";
import { useNow } from "@/hooks/useNow";

export type SubtitleLine = {
  text: string;
  /** "strong" = charcoal.400 (the window line); "muted" = charcoal.300. */
  tone?: "strong" | "muted";
  testId?: string;
};

/** Reserved height of the right action slot ≈ a `size="md"` button, so an empty
 *  slot on Homework holds the same space as the Rounds meeting button. */
const ACTION_SLOT_MIN_H = "2.5rem";

export function WorkTableHeader({
  title,
  subtitle,
  reservedLines,
  action = null,
  children,
}: {
  title: string;
  /** The meaningful subtitle lines (top-aligned); padded to `reservedLines`. */
  subtitle: (SubtitleLine | null)[];
  reservedLines: number;
  action?: ReactNode;
  /** Rendered below the title row (error box / SEL not-configured surface). */
  children?: ReactNode;
}) {
  const lines: (SubtitleLine | null)[] = [...subtitle];
  while (lines.length < reservedLines) lines.push(null);

  return (
    // pt=0: the tab bar above owns the gap below itself.
    <Stack gap={4} px={{ base: 4, lg: 8 }} pt={0} pb={5}>
      <HStack justify="space-between" align="flex-start" flexWrap="wrap" gap={4}>
        <Stack gap={1} minW={0}>
          <Text
            fontFamily="heading"
            fontSize={{ base: "lg", lg: "xl" }}
            fontWeight="700"
            color="charcoal.600"
            data-testid="rounds-title"
          >
            {title}
          </Text>
          <Stack gap={1}>
            {lines.map((line, i) => (
              <Text
                // Reserved slots are structural, not content — index keys are
                // correct here (fixed count, no reordering).
                key={i}
                fontFamily="heading"
                fontSize="sm"
                color={line?.tone === "strong" ? "charcoal.400" : "charcoal.300"}
                lineClamp={1}
                data-testid={line?.testId}
                aria-hidden={line ? undefined : true}
              >
                {line ? line.text : "\u00A0"}
              </Text>
            ))}
          </Stack>
        </Stack>

        <Box flexShrink={0} minH={ACTION_SLOT_MIN_H}>
          {action}
        </Box>
      </HStack>
      {children}
    </Stack>
  );
}

/**
 * The Homework tab's instance of the shared header. Title "Homework" + one
 * factual quiet line naming today's date; the remaining subtitle slots are
 * reserved-empty so the block height matches the Rounds tabs. The date derives
 * from `useNow` (T11 — a minute-bucketed clock, never a bare `Date.now()` in
 * render), so "today" rolls at midnight instead of freezing.
 */
export function HomeworkTableHeader({ reservedLines }: { reservedLines: number }) {
  const now = new Date(useNow(60_000));
  const weekday = now.toLocaleDateString("en-US", { weekday: "short" });
  const month = now.toLocaleDateString("en-US", { month: "short" });
  const dayLabel = `${weekday} ${now.getDate()} ${month}`;

  return (
    <WorkTableHeader
      title="Homework"
      subtitle={[{ text: `Tonight's list · ${dayLabel}`, tone: "strong" }]}
      reservedLines={reservedLines}
    />
  );
}
