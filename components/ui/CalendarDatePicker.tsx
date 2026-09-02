"use client";

import { useState, type CSSProperties } from "react";
import { Box, Button, HStack, Popover, Portal, Text, VStack } from "@chakra-ui/react";
import { CalendarBlank, CaretDown, CaretLeft, CaretRight } from "@phosphor-icons/react";
import { DayPicker } from "react-day-picker";
import "react-day-picker/style.css";

const miniCalendarVars = {
  "--rdp-accent-color": "#8f519f",
  "--rdp-accent-background-color": "#ecdbf0",
  "--rdp-today-color": "#1a1d42",
  "--rdp-day-width": "34px",
  "--rdp-day-height": "34px",
  "--rdp-day_button-width": "32px",
  "--rdp-day_button-height": "32px",
} as CSSProperties;

function shiftMonth(date: Date, delta: number): Date {
  return new Date(date.getFullYear(), date.getMonth() + delta, 1);
}

function monthYearLabel(date: Date): string {
  return new Intl.DateTimeFormat("en-US", { month: "short", year: "numeric" }).format(date);
}

function defaultDateLabel(date: Date): string {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(date);
}

export function MiniCalendar({
  selected,
  onSelect,
  weekdaysOnly = false,
}: {
  selected: Date;
  onSelect: (date: Date) => void;
  weekdaysOnly?: boolean;
}) {
  const [month, setMonth] = useState(selected);

  return (
    <Box
      className="rh-mini-calendar"
      style={miniCalendarVars}
      css={{
        fontFamily: "inherit",
        "& .rdp-root": { margin: "0", width: "100%" },
        "& .rdp-months": { justifyContent: "center" },
        "& .rdp-month_caption": { display: "none" },
        "& .rdp-weekday": { color: "#6b7280", fontSize: "0.68rem", fontWeight: "700" },
        "& .rdp-day_button": {
          borderRadius: "999px",
          fontFamily: "inherit",
          fontSize: "0.78rem",
          fontWeight: "600",
        },
        ...(weekdaysOnly
          ? {
            "& .rdp-weekdays > *:nth-child(n+6)": { display: "none" },
            "& .rdp-week > *:nth-child(n+6)": { display: "none" },
          }
          : {}),
      }}
    >
      <HStack justify="space-between" align="center" mb={2} px={1}>
        <Button
          size="xs"
          variant="ghost"
          aria-label="Previous month"
          onClick={() => setMonth(shiftMonth(month, -1))}
          color="navy.600"
          px={1}
          minW="auto"
        >
          <CaretLeft size={15} weight="bold" />
        </Button>
        <Text fontFamily="heading" fontWeight="800" fontSize="0.9rem" color="navy.700">
          {monthYearLabel(month)}
        </Text>
        <Button
          size="xs"
          variant="ghost"
          aria-label="Next month"
          onClick={() => setMonth(shiftMonth(month, 1))}
          color="navy.600"
          px={1}
          minW="auto"
        >
          <CaretRight size={15} weight="bold" />
        </Button>
      </HStack>
      <DayPicker
        mode="single"
        selected={selected}
        onSelect={(date) => date && onSelect(date)}
        month={month}
        onMonthChange={setMonth}
        weekStartsOn={1}
        showOutsideDays
        hideNavigation
      />
    </Box>
  );
}

export function CalendarDatePicker({
  value,
  onChange,
  ariaLabel,
}: {
  value: Date;
  onChange: (date: Date) => void;
  ariaLabel: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Popover.Root
      open={open}
      onOpenChange={(details) => setOpen(details.open)}
      positioning={{ placement: "bottom-start" }}
    >
      <Popover.Trigger asChild>
        <Button
          size="sm"
          variant="outline"
          borderRadius="full"
          fontFamily="heading"
          fontWeight="700"
          color="navy.700"
          bg="white"
          gap={1.5}
          px={3}
          aria-label={ariaLabel}
        >
          <CalendarBlank size={15} weight="fill" />
          {defaultDateLabel(value)}
          <CaretDown size={13} />
        </Button>
      </Popover.Trigger>
      <Portal>
        <Popover.Positioner>
          <Popover.Content w="340px" maxW="calc(100vw - 24px)" bg="white" borderColor="gray.200" shadow="xl" borderRadius="xl">
            <Popover.Arrow />
            <Popover.Body p={3}>
              <VStack align="stretch">
                <MiniCalendar
                  key={value.toISOString()}
                  selected={value}
                  onSelect={(date) => {
                    onChange(date);
                    setOpen(false);
                  }}
                />
              </VStack>
            </Popover.Body>
          </Popover.Content>
        </Popover.Positioner>
      </Portal>
    </Popover.Root>
  );
}
