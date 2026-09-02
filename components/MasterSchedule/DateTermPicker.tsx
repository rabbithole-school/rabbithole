"use client";

import { Button, HStack, Text } from "@chakra-ui/react";
import type { Id } from "@/convex/_generated/dataModel";
import { DateNavPicker } from "@/components/ui/DateNavPicker";

type ScheduleMode = "week" | "day";

export type ReportingPeriodOption = {
  _id: Id<"reportingPeriods">;
  label: string;
  status: string;
  startsAt: number;
  endsAt: number;
};

type DateTermPickerProps = {
  terms: ReportingPeriodOption[];
  currentTerm?: ReportingPeriodOption | null;
  termId: Id<"reportingPeriods"> | null;
  anchorMs: number;
  scheduleMode: ScheduleMode;
  onAnchorChange: (ms: number) => void;
  onPrevious: () => void;
  onNext: () => void;
  onToday: () => void;
};

const DAY_MS = 24 * 60 * 60 * 1000;

function startOfLocalDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function mondayOf(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  const dow = d.getDay();
  d.setDate(d.getDate() - ((dow + 6) % 7));
  return d.getTime();
}

function clampToWeekday(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  const dow = d.getDay();
  if (dow === 6) d.setDate(d.getDate() + 2);
  else if (dow === 0) d.setDate(d.getDate() + 1);
  return d.getTime();
}

function monthDay(ms: number): string {
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" }).format(new Date(ms));
}

function fullDay(ms: number): string {
  return new Intl.DateTimeFormat("en-US", {
    weekday: "long",
    month: "short",
    day: "numeric",
  }).format(new Date(ms));
}

function weekRange(ms: number): string {
  const start = mondayOf(ms);
  const end = start + 4 * DAY_MS;
  const startDate = new Date(start);
  const endDate = new Date(end);
  const sameMonth = startDate.getMonth() === endDate.getMonth() && startDate.getFullYear() === endDate.getFullYear();
  return sameMonth ? `${monthDay(start)}–${endDate.getDate()}` : `${monthDay(start)}–${monthDay(end)}`;
}

export function DateTermPicker({
  terms,
  currentTerm,
  termId,
  anchorMs,
  scheduleMode,
  onAnchorChange,
  onPrevious,
  onNext,
  onToday,
}: DateTermPickerProps) {
  const activeTerm =
    terms.find((term) => term._id === termId) ??
    currentTerm ??
    terms.find((term) => anchorMs >= term.startsAt && anchorMs <= term.endsAt) ??
    null;
  const contextLabel =
    scheduleMode === "day" ? fullDay(anchorMs) : weekRange(anchorMs);

  return (
    <DateNavPicker
      label={`${activeTerm?.label ?? "Term"} · ${contextLabel}`}
      labelWidth={scheduleMode === "day" ? "30ch" : "25ch"}
      selected={new Date(startOfLocalDay(anchorMs))}
      onSelect={(date) => onAnchorChange(clampToWeekday(date.getTime()))}
      onPrevious={onPrevious}
      onNext={onNext}
      previousAriaLabel={`Previous ${scheduleMode}`}
      nextAriaLabel={`Next ${scheduleMode}`}
      reset={{ label: "Today", onReset: onToday }}
      ariaLabel="Choose schedule date or term"
      weekdaysOnly
    >
      {(close) =>
        terms.length === 0 ? (
          <Text fontSize="sm" color="charcoal.300">
            No terms yet
          </Text>
        ) : (
          <HStack align="center" gap={1.5} flexWrap="wrap">
            {[...terms]
              .sort((a, b) => a.startsAt - b.startsAt)
              .map((term) => {
                const isActive = term._id === termId;
                return (
                  <Button
                    key={String(term._id)}
                    size="xs"
                    variant={isActive ? "solid" : "subtle"}
                    colorPalette="violet"
                    rounded="full"
                    fontFamily="heading"
                    fontWeight={isActive ? "800" : "600"}
                    aria-pressed={isActive}
                    onClick={() => {
                      onAnchorChange(clampToWeekday(term.startsAt));
                      close();
                    }}
                  >
                    {term.label}
                  </Button>
                );
              })}
          </HStack>
        )
      }
    </DateNavPicker>
  );
}
