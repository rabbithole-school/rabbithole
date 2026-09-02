"use client";

/**
 * SubNav — one canonical inline sub-navigation for the second level of a
 * surface (e.g. ScholarProfile's Progress sections, Records sub-tabs,
 * Standards' subject row). Replaces the three different idioms that had
 * drifted apart — solid-violet pills, underline `Tabs`, outline buttons —
 * with a single segmented control whose selected state matches the
 * curriculum builder's `HierarchyRow` selection (violet.50 tint +
 * violet.700 label, borderless), so a "selected" thing reads the same
 * everywhere in the app.
 *
 *   <SubNav
 *     items={[{ value: "tree", label: "Tree" }, …]}
 *     value={section}
 *     onChange={setSection}
 *   />
 *
 * The control is intentionally quieter than the top-level `Tabs` (which
 * own the louder subtle-gray pill) so the hierarchy reads L1 → L2 at a
 * glance instead of two equally-loud bars.
 */
import { Box, HStack, Stack, Text } from "@chakra-ui/react";

export interface SubNavItem<T extends string = string> {
  value: T;
  label: string;
  /** Optional leading icon/emoji node. */
  leading?: React.ReactNode;
  /** Optional small count rendered after the label. */
  count?: number;
}

export interface SubNavProps<T extends string = string> {
  items: SubNavItem<T>[];
  value: T;
  onChange: (value: T) => void;
  /** Right-aligned slot (e.g. an "Add" affordance) on the same row. */
  action?: React.ReactNode;
  /** data-testid for Playwright hooks. */
  testId?: string;
  /** Bottom margin (defaults to 4). Set 0 when the parent stack owns spacing. */
  mb?: number;
}

export function SubNav<T extends string = string>({
  items,
  value,
  onChange,
  action,
  testId,
  mb = 4,
}: SubNavProps<T>) {
  return (
    <Stack
      direction={{ base: "column", sm: "row" }}
      gap={3}
      mb={mb}
      align={{ base: "stretch", sm: "center" }}
      data-testid={testId}
    >
      <HStack
        gap={0.5}
        minW={0}
        overflowX="auto"
        overscrollBehaviorX="contain"
        w={{ base: "full", sm: "auto" }}
        flex={{ base: "initial", sm: 1 }}
      >
        {items.map((item) => {
          const selected = item.value === value;
          return (
            <Box
              key={item.value}
              as="button"
              onClick={() => onChange(item.value)}
              px={3}
              py={1.5}
              borderRadius="md"
              cursor="pointer"
              flexShrink={0}
              whiteSpace="nowrap"
              bg={selected ? "violet.50" : "transparent"}
              transition="all 0.12s"
              _hover={selected ? undefined : { bg: "gray.100" }}
              aria-pressed={selected}
            >
              <HStack gap={1.5}>
                {item.leading && (
                  <Box
                    flexShrink={0}
                    color={selected ? "violet.600" : "charcoal.400"}
                    lineHeight="0"
                  >
                    {item.leading}
                  </Box>
                )}
                <Text
                  fontFamily="heading"
                  fontSize="xs"
                  fontWeight={selected ? "700" : "600"}
                  color={selected ? "violet.700" : "charcoal.400"}
                >
                  {item.label}
                </Text>
                {item.count !== undefined && (
                  <Text
                    fontFamily="heading"
                    fontSize="2xs"
                    fontWeight="600"
                    color={selected ? "violet.500" : "charcoal.300"}
                  >
                    {item.count}
                  </Text>
                )}
              </HStack>
            </Box>
          );
        })}
      </HStack>
      {action && (
        <Box alignSelf={{ base: "flex-end", sm: "auto" }} flexShrink={0}>
          {action}
        </Box>
      )}
    </Stack>
  );
}
