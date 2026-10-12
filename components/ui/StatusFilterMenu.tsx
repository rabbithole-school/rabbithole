"use client";

/**
 * StatusFilterMenu — the compact "Filter" button whose menu multi-selects
 * statuses (Math Skills' mastery bands, Admissions' application statuses).
 * Each row is a check, the status's own glyph and its label, so the menu
 * doubles as the glyph legend. A small count rides the funnel only when some
 * statuses are hidden.
 *
 *   <StatusFilterMenu
 *     items={[{ key: "earned", label: "Earned", icon: <MasteryDot state="earned" /> }, …]}
 *     selected={statuses}
 *     onChange={setStatuses}
 *     ariaLabel="Filter skills by mastery"
 *   />
 */
import { Box, Button, HStack, Menu, Portal, Text } from "@chakra-ui/react";
import { Funnel } from "@phosphor-icons/react";

export interface StatusFilterItem<K extends string = string> {
  key: K;
  label: string;
  /** The status glyph (decorative; the label names the status). */
  icon: React.ReactNode;
}

export interface StatusFilterMenuProps<K extends string = string> {
  /** In menu order. */
  items: StatusFilterItem<K>[];
  selected: ReadonlySet<K>;
  onChange: (next: Set<K>) => void;
  /** Accessible name for the trigger, e.g. "Filter skills by mastery". */
  ariaLabel: string;
  /**
   * Extra on/off filters shown below the statuses, after a separator
   * (e.g. "Show red-flagged candidates"). Each owns its own state.
   */
  options?: StatusFilterOption[];
}

export interface StatusFilterOption {
  key: string;
  label: string;
  icon?: React.ReactNode;
  checked: boolean;
  onChange: (checked: boolean) => void;
}

export function StatusFilterMenu<K extends string = string>({
  items,
  selected,
  onChange,
  ariaLabel,
  options = [],
}: StatusFilterMenuProps<K>) {
  const toggle = (key: K) => {
    const next = new Set(selected);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    onChange(next);
  };
  const hiddenCount = items.length - selected.size;

  return (
    <Menu.Root closeOnSelect={false} positioning={{ placement: "bottom-end" }}>
      <Menu.Trigger asChild>
        <Button
          size="sm"
          variant="ghost"
          h="auto"
          minH="32px"
          px={2.5}
          py={1.5}
          gap={1.5}
          flexShrink={0}
          color={hiddenCount > 0 ? "violet.700" : "charcoal.500"}
          _hover={{ bg: "gray.50" }}
          aria-label={ariaLabel}
        >
          <Funnel size={14} weight={hiddenCount > 0 ? "fill" : "regular"} />
          <Text fontFamily="heading" fontSize="sm" fontWeight="600">
            Filter
          </Text>
          {hiddenCount > 0 && (
            <Box
              as="span"
              minW="16px"
              h="16px"
              px={1}
              borderRadius="full"
              bg="violet.500"
              color="white"
              fontFamily="heading"
              fontSize="2xs"
              fontWeight="700"
              lineHeight="16px"
              textAlign="center"
            >
              {hiddenCount}
            </Box>
          )}
        </Button>
      </Menu.Trigger>
      <Portal>
        <Menu.Positioner>
          <Menu.Content minW="200px">
            {items.map((item) => (
              <Menu.CheckboxItem
                key={item.key}
                value={item.key}
                checked={selected.has(item.key)}
                cursor="pointer"
                onClick={() => toggle(item.key)}
              >
                <HStack gap={2.5} justify="space-between" w="full">
                  <HStack gap={2}>
                    {item.icon}
                    <Text>{item.label}</Text>
                  </HStack>
                  <Menu.ItemIndicator color="violet.600" />
                </HStack>
              </Menu.CheckboxItem>
            ))}
            {options.length > 0 && <Menu.Separator />}
            {options.map((option) => (
              <Menu.CheckboxItem
                key={option.key}
                value={option.key}
                checked={option.checked}
                cursor="pointer"
                onClick={() => option.onChange(!option.checked)}
              >
                <HStack gap={2.5} justify="space-between" w="full">
                  <HStack gap={2}>
                    {option.icon}
                    <Text>{option.label}</Text>
                  </HStack>
                  <Menu.ItemIndicator color="violet.600" />
                </HStack>
              </Menu.CheckboxItem>
            ))}
          </Menu.Content>
        </Menu.Positioner>
      </Portal>
    </Menu.Root>
  );
}
