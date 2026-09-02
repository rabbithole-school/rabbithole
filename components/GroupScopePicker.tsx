"use client";

import { Button, HStack, Text, Menu, Portal } from "@chakra-ui/react";
import { CaretDown, Check } from "@phosphor-icons/react";
import type { RosterGroup } from "@/hooks/useScholarRoster";
import {
  ScholarParticipationFilter,
  type ScholarParticipationSelection,
} from "@/components/ScholarParticipationFilter";
import { groupMatchesParticipation } from "@/shared/scholarGroupRouting";

// Shared group (a.k.a. pod) scope picker — ONE identical dropdown menu behind
// two hosts that do the same job (scope a surface to a scholar group): the
// Scholars-tab left rail and the Assignments agenda header. The trigger shows
// the CURRENT scope (emoji + name + chevron); the items switch scope —
// All scholars / My scholars (only when the host has that concept) / each group
// / separator / Manage groups…. Only the TRIGGER styling varies (`variant`);
// the menu body is byte-identical across both hosts. Groups belong to the
// current institution — the institution itself is a global scope switched from
// the account menu, NOT here; this control is groups-only.

export type GroupScopePickerVariant = "rail" | "compact";

export function GroupScopePicker({
  groups,
  scopeKey,
  scopeLabel,
  scopeEmoji,
  hasMine,
  onSelectScope,
  onManageGroups,
  participation,
  onParticipationChange,
  variant = "rail",
  portalled = true,
}: {
  groups: RosterGroup[];
  /** "" = all scholars · "mine" = my scholars · otherwise a scholarGroup id. */
  scopeKey: string;
  scopeLabel: string;
  scopeEmoji: string | null;
  /** Whether this host has a "My scholars" affinity scope (omit the item if not). */
  hasMine: boolean;
  onSelectScope: (key: string) => void;
  onManageGroups: () => void;
  participation?: ScholarParticipationSelection;
  onParticipationChange?: (selection: ScholarParticipationSelection) => void;
  /** `rail` = full-width borderBottom row (Scholars rail); `compact` = inline
   *  pill trigger (agenda header). The MENU is identical either way. */
  variant?: GroupScopePickerVariant;
  /** Whether the menu body is portaled to `document.body` (default `true`). Set
   *  `false` when hosting inside another portaled overlay (e.g. a Popover): a
   *  body-portaled menu becomes a DOM *sibling* of the overlay, so the overlay's
   *  outside-interaction handling eats menu clicks. Rendering the menu in place
   *  keeps it a descendant of the overlay's content, so clicks register. */
  portalled?: boolean;
}) {
  const triggerLabel = scopeLabel;
  const triggerEmoji = scopeEmoji ?? (scopeKey === "mine" ? "⭐" : "");
  const visibleGroups =
    participation && !participation.extendedEducation
      ? groups.filter((group) =>
          groupMatchesParticipation(group, participation.extendedEducation),
        )
      : groups;
  const handleParticipationChange = (
    next: ScholarParticipationSelection,
  ) => {
    const activeGroup = groups.find((group) => group.id === scopeKey);
    if (
      activeGroup &&
      !groupMatchesParticipation(activeGroup, next.extendedEducation)
    ) {
      onSelectScope("");
    }
    onParticipationChange?.(next);
  };

  return (
    <Menu.Root positioning={{ placement: "bottom-start" }}>
      <Menu.Trigger asChild>
        {variant === "compact" ? (
          <Button
            size="sm"
            variant="outline"
            justifyContent="space-between"
            gap={1.5}
            fontFamily="heading"
            fontWeight="600"
            fontSize="sm"
            color="navy.600"
            bg="white"
            borderWidth="1px"
            borderColor="gray.200"
            borderRadius="full"
            px={3}
            h="auto"
            py={1}
            maxW="200px"
            _hover={{ bg: "gray.50" }}
            title="Switch group"
          >
            <Text lineClamp={1}>{triggerEmoji ? `${triggerEmoji} ` : ""}{triggerLabel}</Text>
            <CaretDown size={14} />
          </Button>
        ) : (
          <Button
            w="full"
            size="sm"
            variant="ghost"
            justifyContent="space-between"
            fontFamily="heading"
            fontWeight="800"
            color="navy.600"
            borderBottom="1px solid"
            borderColor="gray.100"
            borderRadius={0}
            px={3}
            py={2.5}
            minH="68px"
            _hover={{ bg: "gray.50" }}
            title="Switch group"
          >
            <Text lineClamp={1}>{triggerEmoji ? `${triggerEmoji} ` : ""}{triggerLabel}</Text>
            <CaretDown size={14} />
          </Button>
        )}
      </Menu.Trigger>
      <Portal disabled={!portalled}>
        <Menu.Positioner>
          <Menu.Content minW="230px" maxH="70vh" overflowY="auto">
            {participation && onParticipationChange && (
              <>
                <ScholarParticipationFilter
                  variant="menu"
                  selection={participation}
                  onChange={handleParticipationChange}
                />
                <Menu.Separator />
              </>
            )}

            {/* "All scholars" root + my-scholars + each group. */}
            <Menu.ItemGroup>
              <Menu.ItemGroupLabel fontSize="2xs" textTransform="uppercase" letterSpacing="0.04em" color="charcoal.300" px={2} pt={1}>
                Groups
              </Menu.ItemGroupLabel>
              <Menu.Item value="group:" cursor="pointer" onClick={() => onSelectScope("")}>
                <HStack w="full" gap={2}>
                  <Text flex={1}>All scholars</Text>
                  {scopeKey === "" && <Check size={13} />}
                </HStack>
              </Menu.Item>
              {hasMine && (
                <Menu.Item value="group:mine" cursor="pointer" onClick={() => onSelectScope("mine")}>
                  <HStack w="full" gap={2}>
                    <Text flex={1}>⭐ My scholars</Text>
                    {scopeKey === "mine" && <Check size={13} />}
                  </HStack>
                </Menu.Item>
              )}
              {visibleGroups.map((g) => (
                <Menu.Item key={g.id} value={`group:${g.id}`} cursor="pointer" onClick={() => onSelectScope(g.id)}>
                  <HStack w="full" gap={2}>
                    <Text flex={1} lineClamp={1}>{g.emoji ? `${g.emoji} ` : ""}{g.name}</Text>
                    <Text fontSize="2xs" color="charcoal.300">{g.scholarIds.length}</Text>
                    {scopeKey === g.id && <Check size={13} />}
                  </HStack>
                </Menu.Item>
              ))}
            </Menu.ItemGroup>

            <Menu.Separator />
            <Menu.Item value="__manage" cursor="pointer" color="violet.600" onClick={onManageGroups}>
              Manage groups…
            </Menu.Item>
          </Menu.Content>
        </Menu.Positioner>
      </Portal>
    </Menu.Root>
  );
}
