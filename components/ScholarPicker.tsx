"use client";

// Shared scholar-picking primitive. One component for every surface that
// asks a teacher to choose scholar(s): assignment targeting (multi),
// Test Drive view-as (single), IS-for-scholar starter (single), etc.
//
// Handles: load+cache via useScholarRoster, single vs multi select,
// search (by name + group name), select-all/none, group chips, sort
// (alpha / by-group / my-scholars-first), and inline affinity stars.
//
// Group chips behave by mode:
//   - multi:  clicking a group toggles its whole membership into the
//             selection (the "all of geckos + Maile individually" union).
//   - single: clicking a group filters the visible list to that group.

import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  Box,
  Button,
  Flex,
  HStack,
  Input,
  Spinner,
  Stack,
  Text,
} from "@chakra-ui/react";
import { Heart, MagnifyingGlass, Check } from "@phosphor-icons/react";
import { Avatar } from "@/components/Avatar";
import {
  groupMatchesParticipation,
  PRIMARY_GROUP_TYPE,
} from "@/shared/scholarGroupRouting";
import {
  EXTENDED_EDUCATION_LABEL,
  ScholarParticipationFilter,
} from "@/components/ScholarParticipationFilter";
import {
  DEFAULT_SCHOLAR_PARTICIPATION,
  scholarMatchesParticipation,
  type ScholarParticipationSelection,
} from "@/shared/scholarParticipation";
import {
  useScholarRoster,
  type RosterGroup,
  type RosterScholar,
} from "@/hooks/useScholarRoster";

export type ScholarSortMode = "auto" | "alpha" | "group" | "mine-first";

type CommonProps = {
  /** Restrict to a subset of scholar ids. Default: whole roster. */
  scholarIds?: string[];
  showGroups?: boolean;
  showAffinityToggle?: boolean;
  searchable?: boolean;
  /** Background for the search field. */
  searchInputBg?: string;
  /** Keep the list hidden until a query is entered. */
  showInitialResults?: boolean;
  autoFocusSearch?: boolean;
  sort?: ScholarSortMode;
  maxH?: string;
  emptyHint?: string;
  /** Empty-state text for an ACTIVE-QUERY / group-filter miss (defaults to
   *  "No matches."). Callers pass scope-aware copy (see shared/scholarSearchCopy)
   *  so an out-of-institution search reads as scoped, not broken. */
  searchMissHint?: string;
  /** Called after a single-select scholar is chosen. */
  onSelect?: (scholarId: string) => void;
  /** Resets the search and restores focus when this value changes. */
  resetKey?: string | number;
  disabled?: boolean;
  /** Extended Education scholars are excluded unless a caller deliberately
   * opens a program-scoped picker. */
  includeProgramGuests?: boolean;
  /** Label Extended Education participants when they share a picker with
   * enrolled scholars. */
  showEnrollmentStanding?: boolean;
  /** Show an enrolled/Extended Education filter. Enrolled scholars are the
   * default; guests require an explicit opt-in. */
  showParticipationFilter?: boolean;
  participation?: ScholarParticipationSelection;
  onParticipationChange?: (selection: ScholarParticipationSelection) => void;
  /** Scholars to render in a de-emphasized "secondary" group beneath the main
   *  list (e.g. scholars who already have a device). They stay hidden until the
   *  trimmed query reaches `secondaryMinQueryLength` characters. */
  secondaryScholarIds?: Set<string>;
  /** Minimum trimmed query length before secondary scholars appear. Default 0
   *  (always shown). */
  secondaryMinQueryLength?: number;
  /** Optional per-scholar subtitle that replaces the reading-level line. */
  scholarSubtitle?: (scholarId: string) => string | null | undefined;
};

type ScholarPickerProps = CommonProps &
  (
    | {
        mode: "multi";
        selected: Set<string>;
        onChange: (next: Set<string>) => void;
        showSelectAll?: boolean;
      }
    | {
        mode: "single";
        selected: string | null;
        onChange: (next: string | null) => void;
        showSelectAll?: never;
      }
  );

export function ScholarPicker(props: ScholarPickerProps) {
  const [internalParticipation, setInternalParticipation] =
    useState<ScholarParticipationSelection>(DEFAULT_SCHOLAR_PARTICIPATION);
  const participation = props.participation ?? internalParticipation;
  const roster = useScholarRoster({
    includeProgramGuests: props.showParticipationFilter
      ? participation.extendedEducation
      : props.includeProgramGuests,
  });

  const changeParticipation = (next: ScholarParticipationSelection) => {
    if (props.onParticipationChange) props.onParticipationChange(next);
    else setInternalParticipation(next);
    const visibleIds = new Set(
      roster.scholars
        .filter((scholar) => scholarMatchesParticipation(scholar, next))
        .map((scholar) => scholar.id),
    );
    if (props.mode === "multi") {
      props.onChange(
        new Set([...props.selected].filter((scholarId) => visibleIds.has(scholarId))),
      );
    } else if (props.selected && !visibleIds.has(props.selected)) {
      props.onChange(null);
    }
  };

  return (
    <Stack gap={3}>
      {props.showParticipationFilter && (
        <ScholarParticipationFilter
          selection={participation}
          onChange={changeParticipation}
        />
      )}
      <ScholarPickerContent
        {...props}
        scholars={roster.scholars}
        groups={roster.groups}
        isLoading={roster.isLoading}
        onToggleAffinityScholar={roster.toggleAffinityScholar}
        participation={props.showParticipationFilter ? participation : undefined}
      />
    </Stack>
  );
}

export function ScholarPickerContent({
  resetKey,
  includeProgramGuests: _includeProgramGuests,
  participation,
  ...props
}: ScholarPickerProps & {
  scholars: RosterScholar[];
  groups?: RosterGroup[];
  isLoading?: boolean;
  onToggleAffinityScholar?: (scholarId: string) => void;
  participation?: ScholarParticipationSelection;
}) {
  const participationKey = participation
    ? `${participation.enrolled}:${participation.extendedEducation}`
    : "";
  return (
    <ScholarPickerContentInner
      key={`${resetKey ?? ""}:${participationKey}`}
      resetKey={resetKey}
      participation={participation}
      {...props}
    />
  );
}

function ScholarPickerContentInner({
  scholars,
  groups: rosterGroups = [],
  isLoading = false,
  onToggleAffinityScholar,
  participation,
  ...props
}: ScholarPickerProps & {
  scholars: RosterScholar[];
  groups?: RosterGroup[];
  isLoading?: boolean;
  onToggleAffinityScholar?: (scholarId: string) => void;
  participation?: ScholarParticipationSelection;
}) {
  const {
    mode,
    scholarIds,
    showGroups = true,
    showAffinityToggle = true,
    searchable = true,
    searchInputBg,
    showInitialResults = true,
    autoFocusSearch = false,
    sort = "auto",
    maxH = "320px",
    emptyHint = "No scholars.",
    searchMissHint = "No matches.",
    onSelect,
    resetKey,
    disabled = false,
    showEnrollmentStanding = false,
  } = props;

  const [query, setQuery] = useState("");
  // single-mode group filter (which group narrows the list, "" = none)
  const [groupFilter, setGroupFilter] = useState<string>("");
  // Keyboard-nav cursor over the visible list (combobox/listbox pattern):
  // type to filter → first match active → ↑/↓ to move → Enter to select.
  const [activeIndex, setActiveIndex] = useState(0);
  const listboxId = useId();
  const searchInputRef = useRef<HTMLInputElement>(null);

  useLayoutEffect(() => {
    if (resetKey !== undefined && autoFocusSearch && !disabled) {
      searchInputRef.current?.focus();
    }
  }, [autoFocusSearch, disabled, resetKey]);

  const selectedSet = useMemo(
    () =>
      mode === "multi"
        ? props.selected
        : new Set(props.selected ? [props.selected] : []),
    [mode, props.selected],
  );

  // Restrict to the caller's subset, if any.
  const pool = useMemo(() => {
    const allow = scholarIds ? new Set(scholarIds) : null;
    return scholars.filter((scholar) => {
      if (allow && !allow.has(scholar.id)) return false;
      if (!participation) return true;
      return scholarMatchesParticipation(scholar, participation);
    });
  }, [scholars, scholarIds, participation]);

  // Only show groups that have at least one member inside the pool.
  const groups = useMemo(() => {
    if (!showGroups) return [];
    const poolIds = new Set(pool.map((s) => s.id));
    return rosterGroups
      .filter(
        (group) =>
          !participation ||
          groupMatchesParticipation(
            group,
            participation.extendedEducation,
          ),
      )
      .map((g) => ({
        ...g,
        scholarIds: g.scholarIds.filter((id) => poolIds.has(id)),
      }))
      .filter((g) => g.scholarIds.length > 0);
  }, [showGroups, rosterGroups, pool, participation]);

  const hasMine = useMemo(() => pool.some((s) => s.isMine), [pool]);

  const effectiveSort: Exclude<ScholarSortMode, "auto"> =
    sort === "auto" ? (hasMine ? "mine-first" : "alpha") : sort;

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    // A name matches if its own text matches, or it belongs to a group
    // whose name matches (search-by-group).
    const matchingGroupIds = new Set(
      q
        ? groups.filter((g) => g.name.toLowerCase().includes(q)).map((g) => g.id)
        : [],
    );
    const isSecondary = (id: string) => !!props.secondaryScholarIds?.has(id);
    // Secondary scholars only surface once the query is long enough.
    const secondaryAllowed = q.length >= (props.secondaryMinQueryLength ?? 0);
    let list = pool.filter((s) => {
      if (isSecondary(s.id) && !secondaryAllowed) return false;
      if (groupFilter && !s.groupIds.includes(groupFilter)) return false;
      if (!q) return true;
      if (s.name.toLowerCase().includes(q)) return true;
      return s.groupIds.some((gid) => matchingGroupIds.has(gid));
    });

    list = [...list].sort((a, b) => {
      // Secondary scholars always sort beneath the primary list.
      const aSecondary = isSecondary(a.id);
      const bSecondary = isSecondary(b.id);
      if (aSecondary !== bSecondary) return aSecondary ? 1 : -1;
      if (effectiveSort === "mine-first" && a.isMine !== b.isMine) {
        return a.isMine ? -1 : 1;
      }
      if (effectiveSort === "group") {
        const ag = a.groupIds[0] ?? "~"; // groupless sort last
        const bg = b.groupIds[0] ?? "~";
        if (ag !== bg) return ag.localeCompare(bg);
      }
      return a.name.localeCompare(b.name);
    });
    return list;
  }, [
    pool,
    groups,
    query,
    groupFilter,
    effectiveSort,
    props.secondaryScholarIds,
    props.secondaryMinQueryLength,
  ]);
  const resultsVisible =
    showInitialResults || query.trim().length > 0 || groupFilter.length > 0;

  const groupById = useMemo(() => {
    const m = new Map<string, RosterGroup>();
    for (const g of rosterGroups) m.set(g.id, g);
    return m;
  }, [rosterGroups]);

  // Clamp the cursor to the current list; -1 when the list is empty.
  const activeIndexClamped =
    visible.length > 0 ? Math.min(activeIndex, visible.length - 1) : -1;
  const activeOptionId =
    activeIndexClamped >= 0 ? `${listboxId}-opt-${activeIndexClamped}` : undefined;

  // Keep the active row scrolled into view as the cursor moves.
  useEffect(() => {
    if (!activeOptionId) return;
    document.getElementById(activeOptionId)?.scrollIntoView({ block: "nearest" });
  }, [activeOptionId]);

  if (isLoading) {
    return (
      <Flex justify="center" py={6}>
        <Spinner size="sm" color="violet.500" />
      </Flex>
    );
  }

  // ── selection helpers ──────────────────────────────────────────────
  const handleRowClick = (id: string) => {
    if (disabled) return;
    if (mode === "single") {
      const next = props.selected === id ? null : id;
      props.onChange(next);
      if (next) onSelect?.(next);
      return;
    }
    const next = new Set(props.selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    props.onChange(next);
  };

  // Combobox keyboard nav from the search input.
  const handleSearchKeyDown = (e: React.KeyboardEvent) => {
    if (!resultsVisible || visible.length === 0) return;
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        setActiveIndex((i) => Math.min(i + 1, visible.length - 1));
        break;
      case "ArrowUp":
        e.preventDefault();
        setActiveIndex((i) => Math.max(i - 1, 0));
        break;
      case "Home":
        e.preventDefault();
        setActiveIndex(0);
        break;
      case "End":
        e.preventDefault();
        setActiveIndex(visible.length - 1);
        break;
      case "Enter": {
        e.preventDefault();
        const s = visible[activeIndexClamped];
        if (s) handleRowClick(s.id);
        break;
      }
    }
  };

  const handleGroupClick = (g: RosterGroup & { scholarIds: string[] }) => {
    if (mode === "single") {
      setGroupFilter((cur) => (cur === g.id ? "" : g.id));
      setActiveIndex(0); // group filter changed → re-highlight the top match
      return;
    }
    const next = new Set(props.selected);
    const allIn = g.scholarIds.every((id) => next.has(id));
    if (allIn) {
      for (const id of g.scholarIds) next.delete(id);
    } else {
      for (const id of g.scholarIds) next.add(id);
    }
    props.onChange(next);
  };

  const groupSelectionState = (
    g: RosterGroup & { scholarIds: string[] },
  ): "all" | "some" | "none" => {
    if (mode === "single") return groupFilter === g.id ? "all" : "none";
    const inCount = g.scholarIds.filter((id) => selectedSet.has(id)).length;
    if (inCount === 0) return "none";
    if (inCount === g.scholarIds.length) return "all";
    return "some";
  };

  const showSelectAll = mode === "multi" && (props.showSelectAll ?? true);

  return (
    <Stack gap={3}>
      {/* Search + select-all/none */}
      {(searchable || showSelectAll) && (
        <Flex align="center" gap={2}>
          {searchable && (
            <Box position="relative" flex={1}>
              <Box
                position="absolute"
                left={2.5}
                top="50%"
                transform="translateY(-50%)"
                color="charcoal.300"
                pointerEvents="none"
              >
                <MagnifyingGlass size={14} />
              </Box>
              <Input
                key={resetKey}
                ref={searchInputRef}
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setActiveIndex(0); // fresh search → highlight the top match
                }}
                onKeyDown={handleSearchKeyDown}
                placeholder={showGroups ? "Search scholars or groups…" : "Search scholars…"}
                size="sm"
                pl={8}
                bg={searchInputBg}
                autoFocus={autoFocusSearch}
                disabled={disabled}
                role="combobox"
                aria-expanded={resultsVisible}
                aria-controls={resultsVisible ? listboxId : undefined}
                aria-activedescendant={activeOptionId}
                aria-autocomplete="list"
              />
            </Box>
          )}
          {showSelectAll && (
            <HStack gap={1} flexShrink={0}>
              <Button
                size="2xs"
                variant="ghost"
                onClick={() =>
                  props.onChange(new Set(visible.map((s) => s.id)))
                }
              >
                All
              </Button>
              <Button
                size="2xs"
                variant="ghost"
                onClick={() => props.onChange(new Set())}
              >
                None
              </Button>
            </HStack>
          )}
        </Flex>
      )}

      {/* Group chips */}
      {groups.length > 0 && (
        <HStack gap={1.5} flexWrap="wrap">
          {groups.map((g) => {
            const state = groupSelectionState(g);
            const active = state !== "none";
            return (
              <Box
                key={g.id}
                as="button"
                px={2.5}
                py={1}
                borderRadius="full"
                borderWidth="1px"
                borderColor={active ? "cyan.500" : "gray.200"}
                bg={active ? "cyan.500" : "white"}
                color={active ? "white" : "charcoal.500"}
                fontSize="xs"
                fontFamily="heading"
                fontWeight="600"
                cursor="pointer"
                onClick={() => handleGroupClick(g)}
                transition="all 0.12s"
                _hover={{ borderColor: "cyan.400" }}
                title={
                  mode === "multi"
                    ? `${state === "all" ? "Remove" : "Add"} all of ${g.name}`
                    : `Filter to ${g.name}`
                }
              >
                {g.emoji ? `${g.emoji} ` : ""}
                {g.name}
                <Text as="span" opacity={0.7} ml={1}>
                  {state === "some"
                    ? `${g.scholarIds.filter((id) => selectedSet.has(id)).length}/${g.scholarIds.length}`
                    : g.scholarIds.length}
                </Text>
              </Box>
            );
          })}
        </HStack>
      )}

      {/* Count summary */}
      {mode === "multi" && (
        <Text
          fontSize="xs"
          color="charcoal.400"
          fontFamily="heading"
          fontWeight="600"
        >
          {selectedSet.size} selected
          {pool.length > 0 ? ` of ${pool.length}` : ""}
        </Text>
      )}

      {/* Scholar rows */}
      {resultsVisible && (
        <Box maxH={maxH} overflowY="auto">
          <Stack gap={1} role="listbox" id={listboxId} aria-label="Scholars">
            {visible.length === 0 ? (
              <Text fontSize="sm" color="charcoal.400" py={4} textAlign="center">
                {query.trim() || groupFilter ? searchMissHint : emptyHint}
              </Text>
            ) : (
              visible.map((s, i) => (
                <ScholarRow
                  key={s.id}
                  optionId={`${listboxId}-opt-${i}`}
                  scholar={s}
                  selected={selectedSet.has(s.id)}
                  active={i === activeIndexClamped}
                  mode={mode}
                  groupById={groupById}
                  showAffinityToggle={showAffinityToggle}
                  showEnrollmentStanding={showEnrollmentStanding}
                  subtitle={props.scholarSubtitle?.(s.id) ?? undefined}
                  onClick={() => handleRowClick(s.id)}
                  onMouseEnter={() => setActiveIndex(i)}
                  onToggleAffinity={() => onToggleAffinityScholar?.(s.id)}
                />
              ))
            )}
          </Stack>
        </Box>
      )}
    </Stack>
  );
}

function ScholarRow({
  scholar: s,
  selected,
  active,
  optionId,
  mode,
  groupById,
  showAffinityToggle,
  showEnrollmentStanding,
  subtitle,
  onClick,
  onMouseEnter,
  onToggleAffinity,
}: {
  scholar: RosterScholar;
  selected: boolean;
  active: boolean;
  optionId: string;
  mode: "single" | "multi";
  groupById: Map<string, RosterGroup>;
  showAffinityToggle: boolean;
  showEnrollmentStanding: boolean;
  subtitle?: string;
  onClick: () => void;
  onMouseEnter: () => void;
  onToggleAffinity: () => void;
}) {
  const mainGroupEmoji = s.groupIds
    .map((groupId) => groupById.get(groupId))
    .find(
      (group) =>
        group && (!group.type || group.type === PRIMARY_GROUP_TYPE),
    )?.emoji;

  return (
    <Flex
      as="button"
      role="option"
      id={optionId}
      aria-selected={selected}
      align="center"
      gap={2.5}
      px={2}
      py={1.5}
      borderRadius="md"
      borderWidth="1px"
      borderColor={selected ? "violet.400" : "transparent"}
      bg={selected ? "violet.50" : active ? "bg.subtle" : "transparent"}
      cursor="pointer"
      textAlign="left"
      w="full"
      _hover={{ bg: selected ? "violet.50" : "bg.subtle" }}
      transition="background 0.1s"
      onClick={onClick}
      onMouseEnter={onMouseEnter}
    >
      {/* selection marker */}
      <Flex
        w={4}
        h={4}
        flexShrink={0}
        align="center"
        justify="center"
        borderRadius={mode === "single" ? "full" : "sm"}
        borderWidth="1.5px"
        borderColor={selected ? "violet.500" : "gray.300"}
        bg={selected ? "violet.500" : "white"}
        color="white"
      >
        {selected && <Check size={11} strokeWidth={3} />}
      </Flex>

      {/* Group emoji(s) on the left, so group membership scans down the
          row's leading edge. Fixed-width slot keeps avatars aligned. */}
      <Flex
        w={5}
        flexShrink={0}
        justify="center"
        fontSize="sm"
        lineHeight={1}
        title={mainGroupEmoji ? "Main group" : undefined}
      >
        {mainGroupEmoji}
      </Flex>

      <Avatar size="xs" name={s.name} src={s.image ?? undefined} colorKey={s.id} />

      <Box flex={1} minW={0}>
        <Flex align="center" gap={1.5}>
          <Text
            fontFamily="heading"
            fontSize="sm"
            fontWeight="600"
            color="navy.500"
            overflow="hidden"
            whiteSpace="nowrap"
            textOverflow="ellipsis"
          >
            {s.name}
          </Text>
        </Flex>
        {subtitle ? (
          <Text fontFamily="body" fontSize="xs" color="charcoal.400">
            {subtitle}
          </Text>
        ) : showEnrollmentStanding &&
          s.enrollmentStanding === "program_guest" ? (
          <Text fontFamily="body" fontSize="xs" color="violet.600">
            {EXTENDED_EDUCATION_LABEL}
          </Text>
        ) : s.readingLevel ? (
          <Text fontFamily="body" fontSize="xs" color="charcoal.300">
            {s.readingLevel}
          </Text>
        ) : null}
      </Box>

      {showAffinityToggle && (
        <Box
          as="span"
          role="button"
          aria-label={s.isMine ? "Remove from my scholars" : "Add to my scholars"}
          p={1}
          borderRadius="md"
          color={s.isMine ? "red.400" : "charcoal.200"}
          _hover={{ color: "red.400", bg: "red.50" }}
          onClick={(e) => {
            e.stopPropagation();
            onToggleAffinity();
          }}
        >
          <Heart
            size={14}
            fill={s.isMine ? "currentColor" : "none"}
          />
        </Box>
      )}
    </Flex>
  );
}
