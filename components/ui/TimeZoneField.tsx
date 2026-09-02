"use client";

// TimeZoneField — the shared "home time zone" picker for school onboarding
// (/join) and School Settings. One searchable Chakra Combobox over the full
// IANA zone list (see lib/timeZones): type "Auck" → Pacific/Auckland. Replaces
// the flat 8-option US-centric <select> both surfaces used to hardcode.
//
// The stored value stays the IANA identifier string; this control only changes
// how the ~450 zones are presented and searched.

import { useEffect, useMemo } from "react";
import {
  Combobox,
  Portal,
  useFilter,
  useListCollection,
  type ComboboxRootProps,
} from "@chakra-ui/react";
import { timeZoneOptions, type TimeZoneOption } from "@/lib/timeZones";

export interface TimeZoneFieldProps
  extends Omit<
    ComboboxRootProps,
    "collection" | "value" | "onValueChange" | "onChange" | "children" | "multiple"
  > {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  /** Forwarded to the input (e.g. aria-label, name). */
  inputProps?: React.ComponentProps<typeof Combobox.Input>;
}

export function TimeZoneField({
  value,
  onChange,
  disabled,
  placeholder = "Search time zones…",
  inputProps,
  size = "md",
  ...rootProps
}: TimeZoneFieldProps) {
  const { contains } = useFilter({ sensitivity: "base" });
  const items = useMemo(() => timeZoneOptions(value), [value]);
  const { collection, filter, set } = useListCollection<TimeZoneOption>({
    initialItems: items,
    filter: contains,
  });
  useEffect(() => {
    set(items);
  }, [items, set]);

  return (
    <Combobox.Root
      collection={collection}
      value={value ? [value] : []}
      onValueChange={(details) => {
        const next = details.value[0];
        if (next) onChange(next);
      }}
      onInputValueChange={(details) => filter(details.inputValue)}
      // Reset to the full list every time the field opens, so browsing works
      // even though the input already shows the selected zone's label.
      onOpenChange={(details) => {
        if (details.open) filter("");
      }}
      openOnClick
      disabled={disabled}
      size={size}
      positioning={{ sameWidth: true }}
      {...rootProps}
    >
      <Combobox.Control>
        <Combobox.Input
          placeholder={placeholder}
          fontFamily="heading"
          color="charcoal.500"
          borderColor="gray.200"
          borderRadius="md"
          _focus={{ borderColor: "violet.400", boxShadow: "none" }}
          _focusVisible={{ borderColor: "violet.400", boxShadow: "none" }}
          onFocus={(e) => e.currentTarget.select()}
          {...inputProps}
        />
        <Combobox.IndicatorGroup>
          <Combobox.Trigger color="charcoal.400" />
        </Combobox.IndicatorGroup>
      </Combobox.Control>
      <Portal>
        <Combobox.Positioner>
          <Combobox.Content
            bg="white"
            borderColor="gray.200"
            borderRadius="md"
            shadow="lg"
            maxH="18rem"
            overflowY="auto"
          >
            <Combobox.Empty
              color="charcoal.400"
              fontFamily="body"
              fontSize="sm"
              px={3}
              py={2}
            >
              No matching time zone.
            </Combobox.Empty>
            {collection.items.map((item) => (
              <Combobox.Item
                item={item}
                key={item.value}
                fontFamily="body"
                color="charcoal.500"
                _highlighted={{ bg: "violet.50" }}
                _selected={{ bg: "violet.50", fontWeight: "600" }}
              >
                <Combobox.ItemText>{item.label}</Combobox.ItemText>
                <Combobox.ItemIndicator />
              </Combobox.Item>
            ))}
          </Combobox.Content>
        </Combobox.Positioner>
      </Portal>
    </Combobox.Root>
  );
}
