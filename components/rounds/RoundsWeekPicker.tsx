"use client";

import { DateNavPicker } from "@/components/ui/DateNavPicker";
import {
  roundsWeekKeyForDay,
  roundsWeekLabel,
  shiftRoundsWeekKey,
} from "@/lib/roundsCadence";

// The Rounds header's week control — the DRY date-nav idiom the Schedule tab
// uses (DateNavPicker), reading and writing a `weekKey` instead of an instant.
// It replaces the carets that used to flank the board heading; the heading now
// names only the cadence and this pill carries the date.

// A `weekKey` is `YYYY-MM-DD` naming the week's anchor day. Parse/format it in
// LOCAL terms so the MiniCalendar highlights the same calendar day the label
// names (a UTC round-trip could slip a day near midnight).
function dateForWeekKey(weekKey: string): Date {
  const [y, m, d] = weekKey.split("-").map(Number);
  return new Date(y, (m ?? 1) - 1, d ?? 1);
}

function dayKeyOf(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export function RoundsWeekPicker({
  weekKey,
  currentWeekKey,
  onWeekKeyChange,
}: {
  /** The week the board is currently showing. */
  weekKey: string;
  /** The genuinely-current week — what "This week" returns to. */
  currentWeekKey: string;
  onWeekKeyChange: (weekKey: string) => void;
}) {
  return (
    <DateNavPicker
      label={roundsWeekLabel(weekKey)}
      selected={dateForWeekKey(weekKey)}
      onSelect={(date) =>
        onWeekKeyChange(roundsWeekKeyForDay(dayKeyOf(date), weekKey))
      }
      onPrevious={() => onWeekKeyChange(shiftRoundsWeekKey(weekKey, -1))}
      onNext={() => onWeekKeyChange(shiftRoundsWeekKey(weekKey, 1))}
      previousAriaLabel="Previous week"
      nextAriaLabel="Next week"
      reset={{ label: "This week", onReset: () => onWeekKeyChange(currentWeekKey) }}
      ariaLabel="Choose the Rounds week"
    />
  );
}
