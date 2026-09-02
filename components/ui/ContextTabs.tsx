"use client";

import { Tabs } from "@chakra-ui/react";

export type ContextTabItem<T extends string> = {
  value: T;
  label: string;
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
        {items.map((item) => (
          <Tabs.Trigger
            key={item.value}
            value={item.value}
            fontFamily="heading"
          >
            {item.label}
          </Tabs.Trigger>
        ))}
      </Tabs.List>
    </Tabs.Root>
  );
}
