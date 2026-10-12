"use client";

import type { ReactNode } from "react";
import { Portal, Tabs, Tooltip } from "@chakra-ui/react";

export type ContextTabItem<T extends string> = {
  value: T;
  label: ReactNode;
  /** Disable this segment (e.g. a locked Edit mode). */
  disabled?: boolean;
  /** Hover hint, used for a disabled segment's explanation. */
  tooltip?: string;
};

export function ContextTabs<T extends string>({
  items,
  value,
  onChange,
  ariaLabel,
}: {
  items: ContextTabItem<T>[];
  value: T;
  onChange: (value: T) => void;
  ariaLabel: string;
}) {
  return (
    <Tabs.Root
      value={value}
      onValueChange={(details) => onChange(details.value as T)}
      variant="enclosed"
      size="sm"
    >
      <Tabs.List aria-label={ariaLabel}>
        {items.map((item) => {
          const trigger = (
            <Tabs.Trigger
              key={item.value}
              value={item.value}
              fontFamily="heading"
              disabled={item.disabled}
            >
              {item.label}
            </Tabs.Trigger>
          );
          if (!item.tooltip) return trigger;
          return (
            <Tooltip.Root key={item.value} openDelay={200}>
              {/* A native `disabled` button suppresses pointer/focus events, so
                  the tooltip on a locked Edit segment would never open. Wrap it
                  in a focusable span that DOES receive hover/focus (F12). */}
              <Tooltip.Trigger asChild>
                <span tabIndex={0} style={{ display: "inline-flex" }}>
                  {trigger}
                </span>
              </Tooltip.Trigger>
              {/* Portaled: inside the Workshop header the positioner was
                  painted under the toolbar below it, so only a sliver of the
                  hint showed. */}
              <Portal>
                <Tooltip.Positioner>
                  <Tooltip.Content fontFamily="heading" fontSize="xs">
                    {item.tooltip}
                  </Tooltip.Content>
                </Tooltip.Positioner>
              </Portal>
            </Tooltip.Root>
          );
        })}
      </Tabs.List>
    </Tabs.Root>
  );
}
