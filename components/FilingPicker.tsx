"use client";

// The scanner's one filing control: where does this scan belong?
//
// A single searchable listbox spanning BOTH destinations a scanned page can
// have — an academic assignment, or a scholar record filed by document type.
// One list, not two, on purpose: the destinations are mutually exclusive (a
// report card is not "an assignment with a type"), so offering them as
// siblings in one option space is what makes the distinction legible. It is
// also the only way the keyboard contract stays coherent — one
// `aria-activedescendant` cursor and one search box that reaches "immun" as
// readily as "Aquaponics".
//
// Record kinds are rendered straight from the canonical DOCUMENT_KINDS table
// (never a local copy), so this menu can never name a kind the server would
// refuse, and a new kind added there appears here with no change.
//
// Formerly AssignmentPicker; the scanner is still its only consumer, so it
// stays the inner list rather than a dialog.

import { useEffect, useId, useMemo, useState } from "react";
import { useQuery } from "convex/react";
import { Box, Flex, Input, Spinner, Stack, Text, VStack } from "@chakra-ui/react";
import { MagnifyingGlass, Check, Prohibit } from "@phosphor-icons/react";
import { api } from "@/convex/_generated/api";
import {
  DOCUMENT_KIND_GROUPS,
  type DocumentKindSpec,
} from "@/convex/lib/documentKinds";

/** One navigable option. Assignments set a field; records move the scan to
 *  another store entirely (the caller confirms before committing that). */
export type FilingOption =
  | {
      type: "assignment";
      key: string;
      label: string;
      /** null = the explicit "Not for an assignment" choice. */
      id: string | null;
    }
  | {
      type: "record";
      key: string;
      label: string;
      spec: DocumentKindSpec;
      /** Non-null renders the option inert, with the reason read out. */
      disabledReason: string | null;
    };

interface FilingPickerProps {
  /** Current assignment value: an id, null for "none", "" when unresolved. */
  selected: string | null;
  /** Chose an assignment id, or null for "Not for an assignment". */
  onChooseAssignment: (next: string | null) => void;
  /** Chose a record kind — irreversible, so the caller confirms first. */
  onChooseRecord: (spec: DocumentKindSpec) => void;
  /** Batch assignment flows can omit the separate "not an assignment" action. */
  allowNoAssignment?: boolean;
  /** Record kinds this caller may file, already filtered by capability. */
  recordKinds?: readonly DocumentKindSpec[];
  /** Why a kind can't be chosen right now (no scholar, no signed record, …). */
  recordDisabledReason?: (spec: DocumentKindSpec) => string | null;
  emptyHint?: string;
  maxH?: string;
}

export function limitRecentAssignments<
  T extends { id: string; createdAt: number },
>(
  assignments: readonly T[],
  hasQuery: boolean,
  selectedId: string | null,
  limit = 5,
): T[] {
  const newestFirst = assignments
    .slice()
    .sort((a, b) => b.createdAt - a.createdAt);
  if (hasQuery) return newestFirst;

  const recent = newestFirst.slice(0, limit);
  const selected = newestFirst.find((assignment) => assignment.id === selectedId);
  if (selected && !recent.some((assignment) => assignment.id === selected.id)) {
    recent.push(selected);
  }
  return recent;
}

export function FilingPicker({
  selected,
  onChooseAssignment,
  onChooseRecord,
  allowNoAssignment = true,
  recordKinds,
  recordDisabledReason,
  emptyHint = "Nothing to file to yet.",
  maxH = "320px",
}: FilingPickerProps) {
  const assignments = useQuery(api.portfolio.listAssignmentsForPicker, {});
  const [query, setQuery] = useState("");
  // Keyboard-nav cursor over the FLAT option list (all groups, in order).
  const [activeIndex, setActiveIndex] = useState(0);
  const listboxId = useId();

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const matches = (text: string) => !q || text.toLowerCase().includes(q);

    const assignmentOptions: FilingOption[] = [];
    // The explicit "not an assignment" choice is filtered like any other row,
    // so a search for "report" doesn't leave it stranded at the top.
    if (allowNoAssignment && matches("Not for an assignment")) {
      assignmentOptions.push({
        type: "assignment",
        key: "assignment:none",
        label: "Not for an assignment",
        id: null,
      });
    }
    const compatible = (assignments ?? []).filter((a) => matches(a.title));
    const visible = limitRecentAssignments(
      compatible,
      q.length > 0,
      selected,
    );
    for (const a of visible) {
      assignmentOptions.push({
        type: "assignment",
        key: `assignment:${a.id}`,
        label: a.title,
        id: a.id,
      });
    }

    const result: {
      key: string;
      label: string;
      options: FilingOption[];
      startIndex: number;
    }[] = [];
    const push = (key: string, label: string, options: FilingOption[]) => {
      if (options.length === 0) return;
      const startIndex = result.reduce((n, g) => n + g.options.length, 0);
      result.push({ key, label, options, startIndex });
    };

    push("assignments", "Assignments", assignmentOptions);

    // Record groups, in canonical order. A group with nothing to show is
    // dropped entirely rather than rendered as an empty heading.
    for (const groupLabel of DOCUMENT_KIND_GROUPS) {
      const options: FilingOption[] = (recordKinds ?? [])
        .filter((spec) => spec.group === groupLabel && matches(spec.label))
        .map((spec) => ({
          type: "record" as const,
          key: `record:${spec.kind}`,
          label: spec.label,
          spec,
          disabledReason: recordDisabledReason?.(spec) ?? null,
        }));
      push(groupLabel, groupLabel, options);
    }

    return result;
  }, [
    assignments,
    allowNoAssignment,
    query,
    selected,
    recordKinds,
    recordDisabledReason,
  ]);

  const flat = useMemo(() => groups.flatMap((g) => g.options), [groups]);
  const activeIndexClamped = Math.max(
    0,
    Math.min(activeIndex, flat.length - 1),
  );
  const activeOptionId = `${listboxId}-opt-${activeIndexClamped}`;

  useEffect(() => {
    document.getElementById(activeOptionId)?.scrollIntoView({ block: "nearest" });
  }, [activeOptionId]);

  const choose = (option: FilingOption | undefined) => {
    if (!option) return;
    if (option.type === "assignment") onChooseAssignment(option.id);
    // A disabled kind stays navigable so its reason is discoverable, but it
    // must not commit.
    else if (!option.disabledReason) onChooseRecord(option.spec);
  };

  const handleSearchKeyDown = (e: React.KeyboardEvent) => {
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        setActiveIndex((i) => Math.min(i + 1, flat.length - 1));
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
        setActiveIndex(flat.length - 1);
        break;
      case "Enter":
        e.preventDefault();
        choose(flat[activeIndexClamped]);
        break;
    }
  };

  if (assignments === undefined) {
    return (
      <Flex justify="center" py={6}>
        <Spinner size="sm" color="violet.500" />
      </Flex>
    );
  }

  // Running index across groups, so the cursor spans one option space.
  return (
    <Stack gap={3}>
      <Box position="relative">
        <Box position="absolute" left={2.5} top="50%" transform="translateY(-50%)" color="charcoal.300" pointerEvents="none">
          <MagnifyingGlass size={14} />
        </Box>
        <Input
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            // Any change to the result set re-highlights its first row.
            setActiveIndex(0);
          }}
          onKeyDown={handleSearchKeyDown}
          placeholder="Search assignments and record types…"
          size="sm"
          pl={8}
          autoFocus
          role="combobox"
          aria-expanded
          aria-controls={listboxId}
          aria-activedescendant={flat.length > 0 ? activeOptionId : undefined}
          aria-autocomplete="list"
        />
      </Box>

      <Box maxH={maxH} overflowY="auto">
        {flat.length === 0 ? (
          <Text fontSize="sm" color="charcoal.400" py={4} textAlign="center">
             {query.trim() ? "No matches." : emptyHint}
          </Text>
        ) : (
          <Stack
            gap={1}
            role="listbox"
            id={listboxId}
            aria-label="Assignments and record types"
          >
            {groups.map((group) => {
              const headingId = `${listboxId}-group-${group.key.replace(/\s+/g, "-")}`;
              return (
                <Box key={group.key} role="group" aria-labelledby={headingId}>
                  <Text
                    id={headingId}
                    fontSize="2xs"
                    fontWeight="700"
                    fontFamily="heading"
                    color="charcoal.400"
                    textTransform="uppercase"
                    letterSpacing="0.05em"
                    px={2}
                    pt={2}
                    pb={1}
                  >
                    {group.label}
                  </Text>
                  <Stack gap={1}>
                    {group.options.map((option, i) => {
                      // One flat cursor across every group, so the keyboard
                      // contract is a single aria-activedescendant space.
                      const index = group.startIndex + i;
                      return (
                        <Row
                          key={option.key}
                          optionId={`${listboxId}-opt-${index}`}
                          label={option.label}
                          icon={
                            option.type === "assignment" && option.id === null ? (
                              <Prohibit size={13} />
                            ) : undefined
                          }
                          selected={
                            option.type === "assignment" && selected === option.id
                          }
                          disabledReason={
                            option.type === "record" ? option.disabledReason : null
                          }
                          active={activeIndexClamped === index}
                          onClick={() => choose(option)}
                          onMouseEnter={() => setActiveIndex(index)}
                        />
                      );
                    })}
                  </Stack>
                </Box>
              );
            })}
          </Stack>
        )}
      </Box>
    </Stack>
  );
}

function Row({
  label,
  selected,
  active,
  optionId,
  icon,
  disabledReason,
  onClick,
  onMouseEnter,
}: {
  label: string;
  selected: boolean;
  active: boolean;
  optionId: string;
  icon?: React.ReactNode;
  disabledReason?: string | null;
  onClick: () => void;
  onMouseEnter: () => void;
}) {
  const disabled = !!disabledReason;
  const hintId = disabled ? `${optionId}-hint` : undefined;
  return (
    <Flex
      as="button"
      role="option"
      tabIndex={-1}
      id={optionId}
      aria-selected={selected}
      aria-disabled={disabled || undefined}
      aria-describedby={hintId}
      align={disabled ? "start" : "center"}
      gap={2.5}
      px={2}
      py={1.5}
      borderRadius="md"
      borderWidth="1px"
      borderColor={selected ? "violet.400" : active && !disabled ? "violet.200" : "transparent"}
      bg={selected ? "violet.50" : active && !disabled ? "gray.100" : "transparent"}
      cursor={disabled ? "not-allowed" : "pointer"}
      textAlign="left"
      w="full"
      _hover={disabled ? undefined : { bg: selected ? "violet.50" : "gray.100" }}
      transition="all 0.1s"
      onClick={onClick}
      onMouseDown={(event) => event.preventDefault()}
      onMouseEnter={onMouseEnter}
    >
      {icon && <Box color="charcoal.400" opacity={disabled ? 0.4 : 1}>{icon}</Box>}
      <VStack align="start" gap={0} minW={0} flex={1}>
        <Text
          fontFamily="heading"
          fontSize="sm"
          fontWeight="600"
          color={disabled ? "charcoal.400" : "navy.500"}
          truncate
          w="full"
        >
          {label}
        </Text>
        {disabledReason && (
          <Text
            id={hintId}
            fontSize="2xs"
            fontFamily="body"
            color="charcoal.400"
            lineHeight="1.35"
            whiteSpace="normal"
          >
            {disabledReason}
          </Text>
        )}
      </VStack>
      {selected && (
        <Box color="violet.500" flexShrink={0} aria-hidden>
          <Check size={16} weight="bold" />
        </Box>
      )}
    </Flex>
  );
}
