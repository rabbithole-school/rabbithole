"use client";

/**
 * "Assign…" on a Scholar's Prep row: make the scholar's best next question
 * HOMEWORK, due on a school day the teacher picks. Not a suggestion — there is
 * no accept/decline round-trip; the scholar sees it under Prep → Due with its
 * date (`assignments.assignQuestionAsHomework`). The menu lists the next open
 * school days from the institution's calendar (the row's `assignDays`) and
 * "Pick a date…", which opens the shared mini calendar. No default date is baked
 * into the button: choosing a day is the assignment.
 */

import { useState } from "react";
import { useMutation } from "convex/react";
import { Box, Button, Menu, Popover, Portal } from "@chakra-ui/react";
import { CaretDown } from "@phosphor-icons/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { MiniCalendar } from "@/components/ui/CalendarDatePicker";
import { toaster } from "@/lib/toaster";
import { shiftDayKey } from "@/shared/institutionDay";

const PICK_DATE = "__pick";

function dateForDayKey(dayKey: string): Date {
  const [y, m, d] = dayKey.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d, 12));
}

/** "Tomorrow · Tue" · "Wednesday" · "Mon, Oct 20" — a school day relative to
 *  the scholar's institution-local today. */
export function assignDayLabel(dayKey: string, todayKey: string): string {
  const date = dateForDayKey(dayKey);
  const fmt = (opts: Intl.DateTimeFormatOptions) =>
    new Intl.DateTimeFormat("en-US", { timeZone: "UTC", ...opts }).format(date);
  if (dayKey === shiftDayKey(todayKey, 1)) {
    return `Tomorrow · ${fmt({ weekday: "short" })}`;
  }
  if (dayKey <= shiftDayKey(todayKey, 6)) return fmt({ weekday: "long" });
  return fmt({ weekday: "short", month: "short", day: "numeric" });
}

/** "due tomorrow" / "due Wednesday" / "due Mon, Oct 20" for the toast. */
function dueLabel(dayKey: string, todayKey: string): string {
  const label = assignDayLabel(dayKey, todayKey);
  return dayKey === shiftDayKey(todayKey, 1) ? "Due tomorrow" : `Due ${label}`;
}

export function AssignQuestionMenu({
  scholarId,
  scholarName,
  seedId,
  todayKey,
  assignDays,
}: {
  scholarId: string;
  scholarName: string;
  seedId: Id<"seeds">;
  /** The scholar's institution-local today (`YYYY-MM-DD`). */
  todayKey: string;
  /** The next open school days, ascending. */
  assignDays: string[];
}) {
  const assign = useMutation(api.assignments.assignQuestionAsHomework);
  const [pending, setPending] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);

  const assignFor = async (dueDayKey: string) => {
    if (pending) return;
    if (dueDayKey <= todayKey) {
      toaster.error({ title: "Pick a school day after today" });
      return;
    }
    setPending(true);
    try {
      await assign({ scholarId: scholarId as Id<"users">, seedId, dueDayKey });
      toaster.success({
        title: `Assigned to ${scholarName}`,
        description: dueLabel(dueDayKey, todayKey),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      // Convex wraps server errors; surface the reason line only.
      const reason = message.match(/Uncaught Error: ([^\n]+)/)?.[1] ?? null;
      toaster.error({
        title: "Couldn't assign that question",
        description: reason ?? "Please try again.",
      });
    } finally {
      setPending(false);
    }
  };

  return (
    <Popover.Root
      open={pickerOpen}
      onOpenChange={(details) => setPickerOpen(details.open)}
      positioning={{ placement: "bottom-end" }}
    >
      <Popover.Anchor asChild>
        <Box display="inline-block">
          <Menu.Root
            positioning={{ placement: "bottom-end" }}
            onSelect={({ value }) => {
              if (value === PICK_DATE) setPickerOpen(true);
              else void assignFor(value);
            }}
          >
            <Menu.Trigger asChild>
              <Button
                size="sm"
                variant="outline"
                fontFamily="heading"
                fontSize="sm"
                fontWeight="700"
                color="violet.700"
                borderColor="violet.200"
                bg="white"
                _hover={{ bg: "violet.50" }}
                loading={pending}
                aria-label={`Assign this question to ${scholarName} as homework`}
                data-testid="prep-assign"
              >
                Assign…
                <CaretDown size={12} weight="bold" />
              </Button>
            </Menu.Trigger>
            <Portal>
              <Menu.Positioner>
                <Menu.Content minW="200px">
                  <Menu.ItemGroup>
                    <Menu.ItemGroupLabel>Due</Menu.ItemGroupLabel>
                    {assignDays.map((dayKey) => (
                      <Menu.Item key={dayKey} value={dayKey} cursor="pointer" fontSize="sm">
                        {assignDayLabel(dayKey, todayKey)}
                      </Menu.Item>
                    ))}
                  </Menu.ItemGroup>
                  <Menu.Separator />
                  <Menu.Item value={PICK_DATE} cursor="pointer" fontSize="sm">
                    Pick a date…
                  </Menu.Item>
                </Menu.Content>
              </Menu.Positioner>
            </Portal>
          </Menu.Root>
        </Box>
      </Popover.Anchor>
      <Portal>
        <Popover.Positioner>
          <Popover.Content
            w="320px"
            maxW="calc(100vw - 24px)"
            bg="white"
            borderColor="gray.200"
            shadow="xl"
            borderRadius="xl"
          >
            <Popover.Body p={3}>
              {pickerOpen && (
                <MiniCalendar
                  weekdaysOnly
                  selected={dateForDayKey(assignDays[0] ?? shiftDayKey(todayKey, 1))}
                  onSelect={(date) => {
                    setPickerOpen(false);
                    const dayKey = [
                      date.getFullYear(),
                      String(date.getMonth() + 1).padStart(2, "0"),
                      String(date.getDate()).padStart(2, "0"),
                    ].join("-");
                    void assignFor(dayKey);
                  }}
                />
              )}
            </Popover.Body>
          </Popover.Content>
        </Popover.Positioner>
      </Portal>
    </Popover.Root>
  );
}
