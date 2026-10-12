"use client";

/**
 * ScholarScopePicker — the ONE compact "which scholars am I looking at" control
 * for every teacher surface that narrows to a pool: the Math Skills studio
 * header, the Quests board toolbar, and the Room cue's "Send to".
 *
 * TWO FORMS, ONE VOCABULARY. A scope is named identically wherever a teacher
 * meets it, because both forms render the same rows from
 * `components/scopeRows.ts` (`buildScopeRows`): All scholars → ⭐ My scholars
 * (when the host has an affinity) → every visible group in roster order.
 *   - The Scholars-tab left rail renders those rows ALWAYS-VISIBLE (a rail-sized
 *     surface can afford to advertise that group-scoped views exist; a dropdown
 *     hid them — Andy's direction). That form stays where it is.
 *   - Everywhere else the surface has room for a control, not a rail — so this
 *     component collapses the same rows behind one pill trigger that NAMES the
 *     current scope.
 * This is deliberately not a third vocabulary: no host may re-render a scope in
 * its own way.
 *
 * SCOPE vs. FOCUS. The scope is the POOL (all / mine / a group). Focusing a
 * single scholar is orthogonal — a drill-in WITHIN that pool — so the trigger
 * keeps naming the pool and the focused scholar shows as a removable violet
 * avatar chip BESIDE it: a state indicator, not a second control. Hosts that
 * have no drill-in (Room cue) simply omit the focus props, and the section
 * disappears.
 *
 * WHY A POPOVER, NOT A MENU. The focus section reuses the shared ScholarPicker,
 * whose own search input + keyboard listbox conflict with a Menu's roving focus
 * and typeahead; every ScholarPicker consumer in the app hosts it in a
 * Popover/dialog for exactly this reason.
 *
 * NO "MANAGE GROUPS…". Creating/renaming/deleting a group is an administrative
 * function and lives entirely on the School tab (/school/groups) — the rail
 * retired its link for that reason, and a scope control that also edits scopes
 * is two jobs in one menu.
 */

import { useState } from "react";
import { Button, Flex, HStack, Popover, Portal, Stack, Text } from "@chakra-ui/react";
import { CaretDown, Check, X } from "@phosphor-icons/react";
import { Avatar } from "@/components/Avatar";
import { ScholarPicker } from "@/components/ScholarPicker";
import { ScholarParticipationFilter } from "@/components/ScholarParticipationFilter";
import { buildScopeRows, type ScopeRow as ScopeRowData } from "@/components/scopeRows";
import type { RosterGroup } from "@/hooks/useScholarRoster";
import { groupMatchesParticipation } from "@/shared/scholarGroupRouting";
import type { ScholarParticipationSelection } from "@/shared/scholarParticipation";

/** The minimum a host must know about the focused scholar to render the chip —
 *  small on purpose so a host holding raw `users.listScholars` rows (Quests) can
 *  satisfy it without converting to a RosterScholar. */
export type ScopeFocusScholar = {
  id: string;
  name: string;
  image?: string | null;
};

export function ScholarScopePicker({
  groups,
  scopeKey,
  hasMine,
  onSelectScope,
  visibleScholarIds,
  participation,
  onParticipationChange,
  scopedScholarIds,
  focusScholar,
  onFocusScholar,
  portalled = true,
}: {
  groups: RosterGroup[];
  /** "" = all scholars · "mine" = my scholars · otherwise a scholarGroup id. */
  scopeKey: string;
  /** Whether this host has a "My scholars" affinity scope. */
  hasMine: boolean;
  onSelectScope: (key: string) => void;
  /** Every scholar visible under the participation filter — the "All scholars"
   *  count and the per-group counts are both derived from this pool. */
  visibleScholarIds: string[];
  /** Participation section — rendered only when both props are passed. */
  participation?: ScholarParticipationSelection;
  onParticipationChange?: (selection: ScholarParticipationSelection) => void;
  /** Focus tier (all-or-nothing): the current scope's scholar ids, i.e. the pool
   *  the focus search draws from. */
  scopedScholarIds?: string[];
  /** The scholar currently drilled into (undefined = viewing the aggregate). */
  focusScholar?: ScopeFocusScholar;
  /** `null` returns to the aggregate. */
  onFocusScholar?: (scholarId: string | null) => void;
  /** Whether the popover body is portaled to `document.body` (default `true`).
   *  Set `false` when hosting inside another portaled overlay (e.g. the Room
   *  cue's Popover): a body-portaled overlay becomes a DOM *sibling* of its
   *  host, so the host's outside-interaction handling eats clicks. Rendering in
   *  place keeps it a descendant of the host's content, so clicks register. */
  portalled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const showFocus = Boolean(onFocusScholar && scopedScholarIds);
  const extendedEducation = participation?.extendedEducation ?? false;

  // Every group the roster exposes reaches this control in ONE list, in roster
  // order — no per-host sort, so the picker carries no single caller's
  // vocabulary. Groups are filtered by the participation lens and to those with
  // at least one currently-visible scholar, and their counts are narrowed to
  // visible members so a row never advertises scholars the filter hides.
  const visibleScholarIdSet = new Set(visibleScholarIds);
  const visibleGroups: RosterGroup[] = groups
    .filter(
      (group) =>
        (!participation ||
          groupMatchesParticipation(group, extendedEducation)) &&
        group.scholarIds.some((id) => visibleScholarIdSet.has(id)),
    )
    .map((group) => ({
      ...group,
      scholarIds: group.scholarIds.filter((id) => visibleScholarIdSet.has(id)),
    }));

  const rows = buildScopeRows(visibleGroups, hasMine, visibleScholarIds.length);
  const activeRow = rows.find((row) => row.key === scopeKey);

  const selectScope = (key: string) => {
    onSelectScope(key);
    setOpen(false);
  };

  const chooseScholar = (id: string | null) => {
    onFocusScholar?.(id);
    setOpen(false);
  };

  // The trigger names the CURRENT scope; a group also carries its live scholar
  // count (there's nothing to disambiguate on All scholars / My scholars).
  // Violet fill signals a narrowed pool.
  const scopeActive = scopeKey !== "";
  const triggerLabel = activeRow
    ? rowLabel(activeRow)
    : scopeKey === ""
      ? "All scholars"
      : "Group";
  const triggerCount =
    scopeActive && scopeKey !== "mine" ? (activeRow?.count ?? 0) : null;

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
            data-testid="scholar-scope-picker"
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
        <Portal disabled={!portalled}>
          <Popover.Positioner>
            <Popover.Content w="300px" shadow="lg" borderRadius="lg">
              <Popover.Body p={3}>
                <Stack gap={3}>
                  {/* (a) participation */}
                  {participation && onParticipationChange && (
                    <ScholarParticipationFilter
                      variant="inline"
                      selection={participation}
                      onChange={onParticipationChange}
                    />
                  )}

                  {/* (b) scope — the rail's rows, one flat list, roster order */}
                  <Stack gap={1}>
                    <SectionLabel>Scope</SectionLabel>
                    <Stack gap={0.5}>
                      {rows.map((row) => (
                        <ScopeRow
                          key={row.key || "__all"}
                          label={rowLabel(row)}
                          initial={
                            row.key !== "" && row.key !== "mine" && !row.emoji
                              ? row.label
                              : null
                          }
                          count={row.count ?? undefined}
                          selected={scopeKey === row.key}
                          onClick={() => selectScope(row.key)}
                        />
                      ))}
                    </Stack>
                  </Stack>

                  {/* (c) focus one scholar — a drill-in WITHIN the current pool;
                      picking focuses, it does not re-scope. */}
                  {showFocus && (
                    <Stack gap={1.5}>
                      <SectionLabel>Focus one scholar</SectionLabel>
                      <ScholarPicker
                        mode="single"
                        selected={focusScholar?.id ?? null}
                        onChange={chooseScholar}
                        scholarIds={scopedScholarIds}
                        includeProgramGuests={extendedEducation}
                        showGroups={false}
                        showAffinityToggle={false}
                        autoFocusSearch
                        maxH="220px"
                        emptyHint="No scholars in this scope."
                      />
                    </Stack>
                  )}
                </Stack>
              </Popover.Body>
            </Popover.Content>
          </Popover.Positioner>
        </Portal>
      </Popover.Root>

      {/* Focused-scholar state: a removable violet avatar chip beside the
          button. The button itself keeps naming the pool (focus is orthogonal
          to scope), so this is a state indicator, not a third control. */}
      {focusScholar && (
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
            name={focusScholar.name}
            src={focusScholar.image ?? undefined}
            colorKey={focusScholar.id}
          />
          <Text
            fontFamily="heading"
            fontWeight="600"
            fontSize="sm"
            color="violet.700"
            lineClamp={1}
            maxW="120px"
          >
            {focusScholar.name}
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
            onClick={() => onFocusScholar?.(null)}
            aria-label={`Stop focusing ${focusScholar.name}`}
            title="Back to the group"
          >
            <X size={13} weight="bold" />
          </Button>
        </HStack>
      )}
    </HStack>
  );
}

/** A row's compact one-line name — the rail's label with its glyph inlined, so
 *  "My scholars" reads "⭐ My scholars" in both forms. */
function rowLabel(row: ScopeRowData): string {
  return row.emoji ? `${row.emoji} ${row.label}` : row.label;
}

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

function ScopeRow({
  label,
  initial,
  count,
  selected,
  onClick,
}: {
  label: string;
  /** A group with no emoji renders an initial badge, matching the rail. */
  initial?: string | null;
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
      <HStack gap={1.5} flex={1} minW={0}>
        {initial && (
          <Flex
            w="18px"
            h="18px"
            flexShrink={0}
            borderRadius="md"
            bg="gray.100"
            align="center"
            justify="center"
            fontSize="2xs"
            fontWeight="700"
            color="charcoal.500"
          >
            {initial.trim().charAt(0).toUpperCase()}
          </Flex>
        )}
        <Text lineClamp={1} flex={1} textAlign="left">
          {label}
        </Text>
      </HStack>
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
