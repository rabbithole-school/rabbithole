"use client";

/**
 * MathSkillsScopeButton — the Math Skills studio's single "who am I looking at"
 * control, living in the studio header band beside the domain title (the row
 * whose right cluster holds the Mastery/Content/Manipulatives lens toggle).
 *
 * It replaces the former left-aligned pill row (ScholarScopePills): one fixed
 * trigger labeled with the CURRENT scope, opening ONE popover with three stacked
 * sections so nothing re-buries — participation → scope → focus one scholar
 * (per review/math-skills-matrix-visual-language.html §2–§3). The trigger is
 * violet-filled when a narrowed scope is active and neutral/outline for the
 * "All scholars" default; the group list drops the `type === "math"` split
 * (math-tagged pods just sort first) so every real group appears in one list.
 *
 * Single-scholar focus is orthogonal to the group scope (a drill-in WITHIN the
 * pool), so its result shows as a removable violet avatar chip BESIDE the button
 * — a state indicator, not a third control — while the button keeps naming the
 * pool.
 *
 * A Chakra Popover (not a Menu) hosts the sections because the focus search
 * reuses the shared ScholarPicker, whose own search input + keyboard listbox
 * conflict with a Menu's roving focus / typeahead; every ScholarPicker consumer
 * in the app hosts it in a Popover/dialog for exactly this reason. This does NOT
 * introduce a new scholar-selection vocabulary — it re-homes the same two tiers
 * (group scope + ScholarPicker focus) into one labeled control.
 */

import { useState } from "react";
import { Button, HStack, Popover, Portal, Stack, Text } from "@chakra-ui/react";
import { CaretDown, Check, X } from "@phosphor-icons/react";
import { Avatar } from "@/components/Avatar";
import { ScholarPicker } from "@/components/ScholarPicker";
import { ScholarParticipationFilter } from "@/components/ScholarParticipationFilter";
import {
  useScholarRoster,
  type RosterGroup,
  type RosterScholar,
} from "@/hooks/useScholarRoster";
import { groupMatchesParticipation } from "@/shared/scholarGroupRouting";
import type { ScholarParticipationSelection } from "@/shared/scholarParticipation";

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <Text
      fontSize="2xs"
      fontWeight="700"
      color="charcoal.400"
      textTransform="uppercase"
      letterSpacing="0.04em"
      px={1}
    >
      {children}
    </Text>
  );
}

export function MathSkillsScopeButton({
  groups,
  scopeKey,
  hasMine,
  onSelectScope,
  visibleScholarIds,
  scopedScholarIds,
  effectiveScholar,
  onSelectScholar,
  participation,
  onParticipationChange,
}: {
  groups: RosterGroup[];
  /** "" = all scholars · "mine" = my scholars · otherwise a scholarGroup id. */
  scopeKey: string;
  /** Whether this host has a "My scholars" affinity scope. */
  hasMine: boolean;
  onSelectScope: (key: string) => void;
  /** Every scholar visible under the participation filter. */
  visibleScholarIds: string[];
  /** The current scope's scholar ids — the pool the focus search draws from. */
  scopedScholarIds: string[];
  /** The scholar currently drilled into (undefined = viewing the aggregate). */
  effectiveScholar: RosterScholar | undefined;
  /** Pass a username (or "") — "" returns to the group aggregate. */
  onSelectScholar: (scholarKey: string) => void;
  participation: ScholarParticipationSelection;
  onParticipationChange: (selection: ScholarParticipationSelection) => void;
}) {
  const [open, setOpen] = useState(false);
  const roster = useScholarRoster({
    includeProgramGuests: participation.extendedEducation,
  });

  const chooseScholar = (id: string | null) => {
    if (!id) {
      onSelectScholar("");
      setOpen(false);
      return;
    }
    const scholar = roster.scholars.find((s) => s.id === id);
    onSelectScholar(scholar?.username ?? id);
    setOpen(false);
  };

  const selectScope = (key: string) => {
    onSelectScope(key);
    setOpen(false);
  };

  // Every group the roster exposes reaches this scope in ONE list — the
  // `type === "math"` split is deliberately dropped (spec §2: it hid every real
  // pod). Math-tagged groups just sort first. Groups are still filtered by the
  // participation lens and to those with at least one currently-visible scholar,
  // preserving the former pill row's pool exactly.
  const visibleScholarIdSet = new Set(visibleScholarIds);
  const groupVisibleCount = (group: RosterGroup) =>
    group.scholarIds.reduce(
      (n, id) => n + (visibleScholarIdSet.has(id) ? 1 : 0),
      0,
    );
  const visibleGroups = groups
    .filter(
      (group) =>
        groupMatchesParticipation(group, participation.extendedEducation) &&
        group.scholarIds.some((id) => visibleScholarIdSet.has(id)),
    )
    .sort((a, b) => {
      const am = a.type === "math" ? 0 : 1;
      const bm = b.type === "math" ? 0 : 1;
      if (am !== bm) return am - bm;
      return a.name.localeCompare(b.name);
    });

  const activeGroup = groups.find((g) => g.id === scopeKey);

  // Trigger label reflects the current scope. A group also carries its live
  // scholar count; "All scholars" and "⭐ Mine" don't (there's nothing to
  // disambiguate). Violet fill signals a narrowed pool.
  const scopeActive = scopeKey !== "";
  const triggerLabel =
    scopeKey === ""
      ? "All scholars"
      : scopeKey === "mine"
        ? "⭐ Mine"
        : `${activeGroup?.emoji ? `${activeGroup.emoji} ` : ""}${activeGroup?.name ?? "Group"}`;
  const triggerCount = activeGroup ? scopedScholarIds.length : null;

  return (
    <HStack gap={1.5} align="center" minW={0}>
      <Popover.Root
        open={open}
        onOpenChange={(d) => setOpen(d.open)}
        positioning={{ placement: "bottom-start" }}
      >
        <Popover.Trigger asChild>
          <Button
            size="sm"
            variant="outline"
            borderRadius="full"
            h="auto"
            py={1}
            px={3}
            gap={1.5}
            flexShrink={0}
            maxW={{ base: "180px", md: "240px" }}
            fontFamily="heading"
            fontWeight={scopeActive ? "700" : "600"}
            fontSize="sm"
            bg={scopeActive ? "violet.600" : "white"}
            color={scopeActive ? "white" : "navy.600"}
            borderColor={scopeActive ? "violet.600" : "gray.200"}
            _hover={{ bg: scopeActive ? "violet.700" : "gray.50" }}
            aria-label="Choose which scholars to view"
            data-testid="math-scope-button"
          >
            <Text lineClamp={1} minW={0}>
              {triggerLabel}
            </Text>
            {triggerCount !== null && (
              <Text
                fontSize="xs"
                fontWeight="600"
                color={scopeActive ? "whiteAlpha.800" : "charcoal.400"}
                flexShrink={0}
              >
                {triggerCount}
              </Text>
            )}
            <CaretDown size={14} />
          </Button>
        </Popover.Trigger>
        <Portal>
          <Popover.Positioner>
            <Popover.Content w="300px" shadow="lg" borderRadius="lg">
              <Popover.Body p={3}>
                <Stack gap={3}>
                  {/* (a) participation */}
                  <ScholarParticipationFilter
                    variant="inline"
                    selection={participation}
                    onChange={onParticipationChange}
                  />

                  {/* (b) scope — one flat list, math pods first, then the rest */}
                  <Stack gap={1}>
                    <SectionLabel>Scope</SectionLabel>
                    <Stack gap={0.5}>
                      <ScopeRow
                        label="All scholars"
                        selected={scopeKey === ""}
                        onClick={() => selectScope("")}
                      />
                      {hasMine && (
                        <ScopeRow
                          label="⭐ Mine"
                          selected={scopeKey === "mine"}
                          onClick={() => selectScope("mine")}
                        />
                      )}
                      {visibleGroups.map((g) => (
                        <ScopeRow
                          key={g.id}
                          label={`${g.emoji ? `${g.emoji} ` : ""}${g.name}`}
                          count={groupVisibleCount(g)}
                          selected={scopeKey === g.id}
                          onClick={() => selectScope(g.id)}
                        />
                      ))}
                    </Stack>
                  </Stack>

                  {/* (c) focus one scholar — a drill-in WITHIN the current pool;
                      picking focuses, it does not re-scope. */}
                  <Stack gap={1.5}>
                    <SectionLabel>Focus one scholar</SectionLabel>
                    <ScholarPicker
                      mode="single"
                      selected={effectiveScholar?.id ?? null}
                      onChange={chooseScholar}
                      scholarIds={scopedScholarIds}
                      includeProgramGuests={participation.extendedEducation}
                      showGroups={false}
                      showAffinityToggle={false}
                      autoFocusSearch
                      maxH="220px"
                      emptyHint="No scholars in this scope."
                    />
                  </Stack>
                </Stack>
              </Popover.Body>
            </Popover.Content>
          </Popover.Positioner>
        </Portal>
      </Popover.Root>

      {/* Focused-scholar state: a removable violet avatar chip beside the
          button. The button itself keeps naming the pool (focus is orthogonal
          to scope), so this is a state indicator, not a third control. */}
      {effectiveScholar && (
        <HStack
          gap={1}
          flexShrink={0}
          borderRadius="full"
          bg="violet.50"
          borderWidth="1px"
          borderColor="violet.200"
          pl={1.5}
          pr={1}
          py={0.5}
        >
          <Avatar
            size="2xs"
            name={effectiveScholar.name}
            src={effectiveScholar.image ?? undefined}
            colorKey={effectiveScholar.id}
          />
          <Text
            fontFamily="heading"
            fontWeight="600"
            fontSize="sm"
            color="violet.700"
            lineClamp={1}
            maxW="120px"
          >
            {effectiveScholar.name}
          </Text>
          <Button
            variant="ghost"
            size="sm"
            h="auto"
            minW={0}
            p={0.5}
            borderRadius="full"
            color="violet.500"
            _hover={{ bg: "violet.100", color: "violet.700" }}
            onClick={() => onSelectScholar("")}
            aria-label={`Stop focusing ${effectiveScholar.name}`}
            title="Back to the group"
          >
            <X size={13} weight="bold" />
          </Button>
        </HStack>
      )}
    </HStack>
  );
}

function ScopeRow({
  label,
  count,
  selected,
  onClick,
}: {
  label: string;
  count?: number;
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <Button
      variant="ghost"
      size="sm"
      justifyContent="space-between"
      w="full"
      h="auto"
      py={1.5}
      px={2}
      gap={2}
      borderRadius="md"
      fontFamily="heading"
      fontWeight={selected ? "700" : "500"}
      fontSize="sm"
      color={selected ? "violet.700" : "navy.600"}
      bg={selected ? "violet.50" : "transparent"}
      _hover={{ bg: selected ? "violet.50" : "gray.50" }}
      onClick={onClick}
      aria-pressed={selected}
    >
      <Text lineClamp={1} flex={1} textAlign="left">
        {label}
      </Text>
      <HStack gap={1.5} flexShrink={0}>
        {count !== undefined && (
          <Text fontSize="xs" fontWeight="500" color="charcoal.300">
            {count}
          </Text>
        )}
        {selected && <Check size={13} color="var(--chakra-colors-violet-600)" />}
      </HStack>
    </Button>
  );
}
