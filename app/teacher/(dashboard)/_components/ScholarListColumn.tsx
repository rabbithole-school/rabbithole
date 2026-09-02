"use client";

import type { ReactNode } from "react";
import { Box, Flex, HStack, VStack, Text } from "@chakra-ui/react";
import { CaretLeft, Users } from "@phosphor-icons/react";
import { Avatar } from "@/components/Avatar";
import type { RosterGroup } from "@/hooks/useScholarRoster";
import {
  ScholarParticipationFilter,
  type ScholarParticipationSelection,
} from "@/components/ScholarParticipationFilter";
import { groupMatchesParticipation } from "@/shared/scholarGroupRouting";
import { buildScopeRows } from "./scopeRows";
import { type Scholar } from "./types";

// ── Scholar List Column ───────────────────────────────────────────────────
// The persistent left rail. It carries TWO kinds of content depending on
// whether a scholar is open:
//
//   LANDING (no scholar selected) — SCOPE ROWS. One row per scope the teacher
//     can see: All scholars, then My scholars (when the roster offers it), then
//     every visible scholar group (emoji + name + count). Clicking a row
//     switches the main grid's scope. This replaces the old group dropdown: a
//     dropdown HID the existence of group-scoped surfaces; always-visible rows
//     advertise them (Andy's direction). Group management (create/rename/
//     delete/membership) is an administrative function and lives entirely on
//     the School tab (/school/groups) now.
//
//   DETAIL (a scholar selected) — the thin scholar PAGER. Avatar + name only
//     (no sparkline, no subtitle, no search — the app header owns global
//     search, and the card grid owns the engagement/pulse rendering, T1), with
//     a compact "back to scopes" header naming the current scope.
//
// The INSTITUTION is a global scope switched from the account menu, NOT here.

export function ScholarListColumn({
  scholars,
  currentId,
  onSelect,
  groups,
  scopeKey,
  scopeLabel,
  scopeEmoji,
  hasMine,
  allScholarsCount,
  onSelectScope,
  onBack,
  participation,
  onParticipationChange,
}: {
  scholars: Scholar[];
  /** "" (falsy) on the landing → scope rows; a scholar id → the pager. */
  currentId: string;
  onSelect: (id: string) => void;
  groups: RosterGroup[];
  /** "" = all scholars · "mine" = my scholars · otherwise a scholarGroup id. */
  scopeKey: string;
  scopeLabel: string;
  scopeEmoji: string | null;
  hasMine: boolean;
  /** Total roster size for the "All scholars" row count. */
  allScholarsCount: number;
  onSelectScope: (key: string) => void;
  /** Return from the pager to the scope rows (deselects the open scholar). */
  onBack: () => void;
  /** Extended-education participation filter — the only place a teacher can
   *  widen it on this surface (restored after the picker's removal). */
  participation: ScholarParticipationSelection;
  onParticipationChange: (selection: ScholarParticipationSelection) => void;
}) {
  const inDetail = !!currentId;

  return (
    <Flex
      data-testid="scholar-rail"
      direction="column"
      // FILL the rail panel rather than pinning a width. This column's only
      // caller is the scholars layout, where it sits inside a resizable
      // CollapsibleRailLayout panel: a fixed width left white space to the
      // right of the list when the divider was dragged wider than the pin,
      // and clipped the list when dragged narrower. The splitter's own
      // expandedPct/minPct/maxPct are the width policy; this just follows it.
      w="full"
      minW={0}
      h="full"
      borderRight="1px solid"
      borderColor="gray.200"
      bg="white"
    >
      {inDetail ? (
        <ScholarPager
          scholars={scholars}
          currentId={currentId}
          onSelect={onSelect}
          scopeLabel={scopeLabel}
          scopeEmoji={scopeEmoji}
          onBack={onBack}
        />
      ) : (
        <ScopeRows
          groups={groups}
          scopeKey={scopeKey}
          hasMine={hasMine}
          allScholarsCount={allScholarsCount}
          onSelectScope={onSelectScope}
          participation={participation}
          onParticipationChange={onParticipationChange}
        />
      )}
    </Flex>
  );
}

// ── Landing: scope rows ─────────────────────────────────────────────────────

function ScopeRow({
  active,
  onClick,
  glyph,
  label,
  count,
}: {
  active: boolean;
  onClick: () => void;
  /** An emoji string, or a React node (icon / initial circle). */
  glyph: ReactNode;
  label: string;
  count?: number;
}) {
  return (
    <HStack
      as="button"
      data-testid="scope-row"
      aria-current={active ? "true" : undefined}
      w="full"
      textAlign="left"
      gap={2.5}
      px={2.5}
      py={2.5}
      borderRadius="lg"
      cursor="pointer"
      bg={active ? "violet.50" : undefined}
      _hover={active ? undefined : { bg: "gray.50" }}
      _focusVisible={{ outline: "2px solid", outlineColor: "violet.400", outlineOffset: "-2px" }}
      onClick={onClick}
    >
      <Flex w="22px" justify="center" align="center" flexShrink={0} fontSize="md">
        {glyph}
      </Flex>
      <Text
        flex={1}
        minW={0}
        fontFamily="heading"
        fontSize="sm"
        fontWeight="700"
        color={active ? "violet.700" : "navy.500"}
        lineClamp={1}
      >
        {label}
      </Text>
      {count !== undefined && (
        <Text fontFamily="heading" fontSize="2xs" color="charcoal.300" flexShrink={0}>
          {count}
        </Text>
      )}
    </HStack>
  );
}

/** A group with no emoji gets its first initial in a small circle. */
function GroupGlyph({ emoji, name }: { emoji: string | null; name: string }) {
  if (emoji) return <>{emoji}</>;
  const initial = (name.trim()[0] ?? "?").toUpperCase();
  return (
    <Flex
      w="20px"
      h="20px"
      borderRadius="full"
      bg="gray.100"
      align="center"
      justify="center"
      fontSize="2xs"
      fontWeight="700"
      color="charcoal.500"
      fontFamily="heading"
    >
      {initial}
    </Flex>
  );
}

function ScopeRows({
  groups,
  scopeKey,
  hasMine,
  allScholarsCount,
  onSelectScope,
  participation,
  onParticipationChange,
}: {
  groups: RosterGroup[];
  scopeKey: string;
  hasMine: boolean;
  allScholarsCount: number;
  onSelectScope: (key: string) => void;
  participation: ScholarParticipationSelection;
  onParticipationChange: (selection: ScholarParticipationSelection) => void;
}) {
  // Guest-inclusive groups stay hidden until Extended education is selected
  // (shared/scholarGroupRouting.ts's standing rule) — otherwise a guest pod
  // would show a zero-count row and open a permanently empty grid.
  const visibleGroups = groups.filter((g) =>
    groupMatchesParticipation(g, participation.extendedEducation),
  );

  return (
    <>
      <Box px={3} pt={3} pb={2} flexShrink={0}>
        <Text
          fontFamily="heading"
          fontSize="2xs"
          fontWeight="700"
          letterSpacing="0.05em"
          textTransform="uppercase"
          color="charcoal.400"
        >
          Groups
        </Text>
      </Box>
      <VStack gap={0.5} align="stretch" overflowY="auto" flex={1} px={2} pb={2}>
        {buildScopeRows(visibleGroups, hasMine, allScholarsCount).map((row) => (
          <ScopeRow
            key={row.key || "__all"}
            active={scopeKey === row.key}
            onClick={() => onSelectScope(row.key)}
            glyph={
              row.key === "" ? (
                <Users size={17} weight="bold" color="#6b6b6b" />
              ) : row.emoji ? (
                row.emoji
              ) : (
                <GroupGlyph emoji={null} name={row.label} />
              )
            }
            label={row.label}
            count={row.count ?? undefined}
          />
        ))}
      </VStack>
      {/* Group MANAGEMENT (create/rename/delete) is not here — it moved to the
          School tab (/school/groups) as an administrative function. Only the
          participation filter rides in the footer now. */}
      <Box px={3} py={2.5} borderTop="1px solid" borderColor="gray.100" flexShrink={0}>
        <ScholarParticipationFilter
          variant="inline"
          selection={participation}
          onChange={onParticipationChange}
        />
      </Box>
    </>
  );
}

// ── Detail: the thin scholar pager ──────────────────────────────────────────

function ScholarPager({
  scholars,
  currentId,
  onSelect,
  scopeLabel,
  scopeEmoji,
  onBack,
}: {
  scholars: Scholar[];
  currentId: string;
  onSelect: (id: string) => void;
  scopeLabel: string;
  scopeEmoji: string | null;
  onBack: () => void;
}) {
  return (
    <>
      {/* Back to the scope rows — names the current scope. */}
      <HStack
        as="button"
        data-testid="rail-back-to-scopes"
        w="full"
        textAlign="left"
        gap={2}
        px={3}
        py={2.5}
        borderBottom="1px solid"
        borderColor="gray.100"
        cursor="pointer"
        _hover={{ bg: "gray.50" }}
        _focusVisible={{ outline: "2px solid", outlineColor: "violet.400", outlineOffset: "-2px" }}
        onClick={onBack}
        flexShrink={0}
        minH="44px"
      >
        <CaretLeft size={15} weight="bold" color="#6b6b6b" />
        <Text fontFamily="heading" fontSize="sm" fontWeight="700" color="navy.600" lineClamp={1}>
          {scopeEmoji ? `${scopeEmoji} ` : ""}{scopeLabel}
        </Text>
      </HStack>

      <VStack gap={0} align="stretch" overflowY="auto" flex={1} px={2} py={2}>
        {scholars.length === 0 ? (
          <Text fontSize="xs" color="charcoal.300" fontFamily="heading" textAlign="center" py={4}>
            No scholars here.
          </Text>
        ) : (
          scholars.map((s) => {
            const selected = s.id === currentId;
            return (
              <HStack
                key={s.id}
                as="button"
                aria-current={selected ? "true" : undefined}
                w="full"
                textAlign="left"
                gap={2.5}
                px={2}
                py={2}
                borderRadius="lg"
                cursor="pointer"
                bg={selected ? "violet.50" : undefined}
                _hover={selected ? undefined : { bg: "gray.50" }}
                _focusVisible={{ outline: "2px solid", outlineColor: "violet.400", outlineOffset: "-2px" }}
                onClick={() => onSelect(s.id)}
              >
                <Avatar size="sm" name={s.name || "Scholar"} src={s.image || undefined} colorKey={s.id} />
                <Text
                  flex={1}
                  minW={0}
                  fontFamily="heading"
                  fontSize="xs"
                  fontWeight="700"
                  color={selected ? "violet.700" : "navy.500"}
                  lineClamp={1}
                >
                  {s.name}
                </Text>
              </HStack>
            );
          })
        )}
      </VStack>
    </>
  );
}
