"use client";

import { useState, type ReactNode } from "react";
import { Button, HStack, Popover, Portal, Text, VStack } from "@chakra-ui/react";
import {
  ArrowCounterClockwise,
  CalendarBlank,
  CaretDown,
  CaretLeft,
  CaretRight,
} from "@phosphor-icons/react";
import { MiniCalendar } from "@/components/ui/CalendarDatePicker";

// The shared date-navigation idiom: a ghost ‹ caret · a calendar-glyph pill that
// opens a MiniCalendar popover · a ghost › caret · an always-on ghost reset.
// The Schedule tab's DateTermPicker and the Scholars-tab Rounds week picker both
// compose this so the two controls stay pixel-identical. This owns only the
// SHAPE; each consumer owns the MEANING of a step, a picked day, and the reset.

export function DateNavPicker({
  label,
  labelWidth,
  selected,
  onSelect,
  onPrevious,
  onNext,
  previousAriaLabel,
  nextAriaLabel,
  reset,
  ariaLabel,
  weekdaysOnly = false,
  children,
}: {
  /** Rendered inside the pill (already framed by the consumer). */
  label: string;
  /** Fixed pill-label width (e.g. Schedule's "25ch"); omit for intrinsic. */
  labelWidth?: string;
  selected: Date;
  onSelect: (date: Date) => void;
  onPrevious: () => void;
  onNext: () => void;
  previousAriaLabel: string;
  nextAriaLabel: string;
  reset: { label: string; onReset: () => void };
  ariaLabel: string;
  weekdaysOnly?: boolean;
  /** Extra popover content rendered ABOVE the MiniCalendar. A render function
   *  receives `close` so an in-popover control (a term chip) can dismiss it. */
  children?: ReactNode | ((close: () => void) => ReactNode);
}) {
  const [open, setOpen] = useState(false);
  const close = () => setOpen(false);
  const extras = typeof children === "function" ? children(close) : children;

  return (
    <HStack gap={1.5} align="center">
      <Button
        size="xs"
        variant="ghost"
        aria-label={previousAriaLabel}
        onClick={onPrevious}
        color="navy.600"
        px={1.5}
        minW="auto"
      >
        <CaretLeft size={15} weight="bold" />
      </Button>

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
            justifyContent="flex-start"
            aria-label={ariaLabel}
          >
            <CalendarBlank size={15} weight="fill" style={{ flexShrink: 0 }} />
            <Text as="span" flexShrink={0} w={labelWidth} textAlign="left" lineClamp={1}>
              {label}
            </Text>
            <CaretDown size={13} style={{ flexShrink: 0 }} />
          </Button>
        </Popover.Trigger>
        <Portal>
          <Popover.Positioner>
            <Popover.Content
              w="340px"
              maxW="calc(100vw - 24px)"
              bg="white"
              borderColor="gray.200"
              shadow="xl"
              borderRadius="xl"
            >
              <Popover.Arrow />
              <Popover.Body p={3}>
                <VStack align="stretch" gap={3}>
                  {extras}
                  <MiniCalendar
                    key={selected.getTime()}
                    selected={selected}
                    onSelect={(date) => {
                      onSelect(date);
                      close();
                    }}
                    weekdaysOnly={weekdaysOnly}
                  />
                </VStack>
              </Popover.Body>
            </Popover.Content>
          </Popover.Positioner>
        </Portal>
      </Popover.Root>

      <Button
        size="xs"
        variant="ghost"
        aria-label={nextAriaLabel}
        onClick={onNext}
        color="navy.600"
        px={1.5}
        minW="auto"
      >
        <CaretRight size={15} weight="bold" />
      </Button>

      <Button
        size="xs"
        variant="ghost"
        onClick={reset.onReset}
        color="navy.600"
        fontFamily="heading"
        fontWeight="700"
        gap={1}
        px={2}
      >
        <ArrowCounterClockwise size={13} weight="bold" />
        {reset.label}
      </Button>
    </HStack>
  );
}
