"use client";

import { Button, HStack, Menu, Portal, Text } from "@chakra-ui/react";
import { CaretDown, Check } from "@phosphor-icons/react";
import { Avatar } from "@/components/Avatar";
import { subjectMatches } from "@/lib/subjects";

interface FilterableUnit {
  teacherId?: string | null;
  teacherName?: string | null;
  subject?: string | null;
}

export interface UnitAuthorOption {
  id: string;
  name: string;
}

function filterTriggerLabel(category: string, selection?: string): string {
  return selection ? `${category}: ${selection}` : category;
}

export function unitAuthorOptions(
  units: readonly FilterableUnit[],
): UnitAuthorOption[] {
  const byId = new Map<string, string>();
  for (const unit of units) {
    if (unit.teacherId) {
      byId.set(String(unit.teacherId), unit.teacherName ?? "Unknown");
    }
  }
  return [...byId.entries()].map(([id, name]) => ({ id, name }));
}

export function unitMatchesFilters(
  unit: FilterableUnit,
  authorId: string,
  subject: string | null,
): boolean {
  return (
    (authorId === "all" || String(unit.teacherId) === authorId) &&
    (!subject || subjectMatches(unit.subject ?? undefined, subject))
  );
}

/**
 * Single-select Subject filter as a ghost-variant dropdown. Shared by
 * the teacher Curriculum list and the scholar unit picker so both
 * surfaces narrow by subject the same way.
 *
 * Renders nothing when there's fewer than two subjects to choose
 * between — a filter with one option (or none) is just clutter. The
 * "size" prop is preserved for call-site compatibility but no longer
 * varies the layout (the menu trigger is small either way).
 */
export function SubjectFilterChips({
  subjects,
  selected,
  onSelect,
}: {
  subjects: string[];
  selected: string | null;
  onSelect: (subject: string | null) => void;
  size?: "sm" | "xs";
}) {
  if (subjects.length < 2) return null;

  const label = filterTriggerLabel("Subject", selected ?? undefined);

  return (
    <Menu.Root positioning={{ placement: "bottom-start" }}>
      <Menu.Trigger asChild>
        <Button
          size="xs"
          variant="ghost"
          color="charcoal.500"
          _hover={{ bg: "gray.100" }}
          aria-label={`Filter units by ${label.toLowerCase()}`}
        >
          <HStack gap={1.5}>
            <Text fontFamily="heading" fontSize="xs" fontWeight="600">
              {label}
            </Text>
            <CaretDown size={12} />
          </HStack>
        </Button>
      </Menu.Trigger>
      <Portal>
        <Menu.Positioner>
          <Menu.Content minW="200px">
            <Menu.Item
              value="__all__"
              cursor="pointer"
              onClick={() => onSelect(null)}
            >
              <HStack gap={2}>
                <Text>All subjects</Text>
                {selected === null && (
                  <Text color="violet.600" fontSize="2xs">
                    ✓
                  </Text>
                )}
              </HStack>
            </Menu.Item>
            {subjects.map((s) => (
              <Menu.Item
                key={s}
                value={s}
                cursor="pointer"
                onClick={() => onSelect(s)}
              >
                <HStack gap={2}>
                  <Text>{s}</Text>
                  {selected === s && (
                    <Text color="violet.600" fontSize="2xs">
                      ✓
                    </Text>
                  )}
                </HStack>
              </Menu.Item>
            ))}
          </Menu.Content>
        </Menu.Positioner>
      </Portal>
    </Menu.Root>
  );
}

/**
 * Shared unit-author filter. Both Curriculum and assignment use the same
 * vocabulary and option ordering so "Authored by" never means two things.
 */
export function UnitAuthorFilterMenu({
  authors,
  value,
  onChange,
  meId,
  meName,
}: {
  authors: UnitAuthorOption[];
  value: string;
  onChange: (value: string) => void;
  meId: string;
  meName?: string;
}) {
  const isMe = !!meId && value === meId;
  const selected = authors.find((author) => author.id === value);
  const selectedLabel =
    value === "all"
      ? "All authors"
      : isMe
        ? "Me"
        : selected?.name ?? "All authors";
  const triggerLabel = filterTriggerLabel(
    "Author",
    value === "all" ? undefined : selectedLabel,
  );
  const others = authors.filter((author) => author.id !== meId);

  return (
    <Menu.Root positioning={{ placement: "bottom-start" }}>
      <Menu.Trigger asChild>
        <Button
          size="xs"
          variant="outline"
          bg={value === "all" ? "transparent" : "violet.50"}
          color={value === "all" ? "charcoal.500" : "violet.700"}
          borderColor={value === "all" ? "gray.200" : "violet.200"}
          _hover={{ bg: value === "all" ? "gray.100" : "violet.100" }}
          aria-label={`Filter units by ${triggerLabel.toLowerCase()}`}
          maxW="190px"
        >
          <Text
            as="span"
            fontFamily="heading"
            fontSize="xs"
            fontWeight="600"
            lineClamp={1}
          >
            {triggerLabel}
          </Text>
          <CaretDown size={12} weight="bold" />
        </Button>
      </Menu.Trigger>
      <Portal>
        <Menu.Positioner>
          <Menu.Content minW="220px" maxH="60vh" overflowY="auto">
            <Menu.Item
              value="all"
              cursor="pointer"
              onClick={() => onChange("all")}
            >
              <HStack gap={2} w="full">
                <Text flex={1}>All authors</Text>
                {value === "all" && <Check size={13} />}
              </HStack>
            </Menu.Item>
            {meId && (
              <Menu.Item
                value={meId}
                cursor="pointer"
                onClick={() => onChange(meId)}
              >
                <HStack gap={2} w="full">
                  <Avatar
                    name={meName ?? "Me"}
                    colorKey={meId}
                    size="2xs"
                  />
                  <Text flex={1} fontWeight="700">
                    Me
                  </Text>
                  {isMe && <Check size={13} />}
                </HStack>
              </Menu.Item>
            )}
            {others.length > 0 && <Menu.Separator />}
            {others.map((author) => (
              <Menu.Item
                key={author.id}
                value={author.id}
                cursor="pointer"
                onClick={() => onChange(author.id)}
              >
                <HStack gap={2} w="full">
                  <Avatar
                    name={author.name}
                    colorKey={author.id}
                    size="2xs"
                  />
                  <Text flex={1} lineClamp={1}>
                    {author.name}
                  </Text>
                  {value === author.id && <Check size={13} />}
                </HStack>
              </Menu.Item>
            ))}
          </Menu.Content>
        </Menu.Positioner>
      </Portal>
    </Menu.Root>
  );
}
