"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import {
  Box,
  Flex,
  Text,
  HStack,
  VStack,
  Input,
  Badge,
  Portal,
  Dialog,
} from "@chakra-ui/react";
import { Avatar } from "@/components/Avatar";
import { curriculumUnitHref } from "@/lib/curriculumHref";
import {
  noScholarMatchCopy,
  type ScholarSearchScope,
} from "@/shared/scholarSearchCopy";

// ── Command Palette (⌘K) ─────────────────────────────────────────────
// Global jump-to for scholars + curriculum. Lives in StaffShell so it is
// reachable from every staff tab.
//
// It reads `listDirectoryScholars`, NOT the roster's `listScholars`: this
// surface renders a name and an avatar, and `listScholars` collects every
// message of every session of every scholar to build pulse/status/transcript
// fields none of which are drawn here. Gating that on `isOpen` never made it
// cheap — it only moved the whole cost onto the keystroke, which is the one
// moment latency is most visible. The subscriptions are still `isOpen`-gated so
// they stay out of the layout's steady state; the low-frequency curriculum
// lists are passed in from the shell that already subscribes to them.

type CmdEntry = { key: string; href: string; label: string; sublabel?: string } & (
  | { kind: "scholar"; scholar: Scholar }
  | { kind: "curriculum" | "skill"; emoji: string; category: string }
);
type Scholar = {
  _id: string;
  username?: string | null;
  name?: string | null;
  image?: string | null;
};
type UnitInfo = {
  _id: string;
  title: string;
  emoji?: string;
};
type SkillEntry = {
  nodeKey: string;
  label: string;
  domain: string;
  domainLabel: string;
};

type CurriculumHit =
  | {
      kind: "lesson";
      unitId: string;
      unitTitle: string;
      lessonId: string;
      lessonTitle: string;
    }
  | {
      kind: "activity";
      unitId: string;
      unitTitle: string;
      lessonId: string;
      lessonTitle: string;
      activityId: string;
      activityTitle: string;
    };

/** The server-side searches (skills, curriculum) walk real data, so they run
 *  on a PAUSE rather than on every keystroke. Local filtering — scholars,
 *  units, perspectives, processes — stays instant against `query` itself, so
 *  typing never feels laggy while the wider searches catch up. */
const SEARCH_DEBOUNCE_MS = 180;

function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return debounced;
}

const EMPTY_SCHOLARS: Scholar[] = [];
const EMPTY_SKILLS: SkillEntry[] = [];
const EMPTY_CURRICULUM: CurriculumHit[] = [];
const EMPTY_RESULTS: CmdEntry[] = [];

export function searchSkillsQueryArgs(
  canSearchSkills: boolean,
  isOpen: boolean,
  query: string,
): { query: string; limit: number } | "skip" {
  return canSearchSkills && isOpen && query.trim().length >= 2
    ? { query, limit: 12 }
    : "skip";
}

/** Same three gates as the skills search (role, open, ≥2 chars), against the
 *  curriculum-access role instead — a staffer with no Units tab has nowhere to
 *  land, so they never issue the query. The server enforces this too. */
export function searchCurriculumQueryArgs(
  canSearchCurriculum: boolean,
  isOpen: boolean,
  query: string,
  scope: string | undefined,
): { query: string; scope?: string; limit: number } | "skip" {
  if (!(canSearchCurriculum && isOpen && query.trim().length >= 2)) return "skip";
  return scope ? { query, scope, limit: 12 } : { query, limit: 12 };
}

export function buildEntries(
  scholars: Scholar[],
  units: UnitInfo[],
  perspectives: { _id: string; title: string; icon?: string | null }[],
  processes: { _id: string; title: string; emoji?: string | null }[],
  skills: SkillEntry[],
  curriculum: CurriculumHit[],
  q: string,
): CmdEntry[] {
  const needle = q.toLowerCase();
  const match = (s: string) => !q || s.toLowerCase().includes(needle);
  return [
    // Match the username too, not just the display name: the username IS the
    // destination (`/teacher/scholars/<username>`), so typing the thing you can
    // read off the URL bar returning nothing was the one miss nobody could
    // explain. It doubles as the sublabel for the same reason.
    ...scholars
      .filter((s) => match(s.name ?? "") || match(s.username ?? ""))
      .map((s) => ({
        kind: "scholar" as const, key: s._id,
        href: `/teacher/scholars/${s.username ?? s._id}`,
        label: s.name ?? "Scholar", sublabel: s.username ?? undefined, scholar: s,
      })),
    ...units.filter((u) => match(u.title)).map((u) => ({
      kind: "curriculum" as const, key: `unit-${u._id}`,
      href: curriculumUnitHref(u._id),
      label: u.title, emoji: u.emoji ?? "📚", category: "Unit",
    })),
    // Personas are DEPRECATED (anti-parasocial) — intentionally not searchable.
    ...perspectives.filter((p) => match(p.title)).map((p) => ({
      kind: "curriculum" as const, key: `perspective-${p._id}`,
      href: `/teacher/perspective/${p._id}`,
      label: p.title, emoji: p.icon ?? "👁", category: "Perspective",
    })),
    ...processes.filter((p) => match(p.title)).map((p) => ({
      kind: "curriculum" as const, key: `process-${p._id}`,
      href: `/teacher/process/${p._id}`,
      label: p.title, emoji: p.emoji ?? "🔄", category: "Process",
    })),
    ...skills.map((skill) => ({
      kind: "skill" as const,
      key: `skill-${skill.nodeKey}`,
      href: `/teacher/math-skills?node=${encodeURIComponent(skill.nodeKey)}`,
      label: skill.label,
      sublabel: skill.domainLabel,
      emoji: "🧮",
      category: "Math skill",
    })),
    // Lessons + activities. Already filtered server-side, so no client `match`.
    // The sublabel is the path back up ("Unit › Lesson") because an activity
    // title alone ("Warm-up") does not tell you which of the six warm-ups it is.
    ...curriculum.map((hit) =>
      hit.kind === "lesson"
        ? {
            kind: "curriculum" as const,
            key: `lesson-${hit.lessonId}`,
            href: curriculumUnitHref(hit.unitId, { lessonId: hit.lessonId }),
            label: hit.lessonTitle,
            sublabel: hit.unitTitle,
            emoji: "📖",
            category: "Lesson",
          }
        : {
            kind: "curriculum" as const,
            key: `activity-${hit.activityId}`,
            href: curriculumUnitHref(hit.unitId, { activityId: hit.activityId }),
            label: hit.activityTitle,
            sublabel: `${hit.unitTitle} › ${hit.lessonTitle}`,
            emoji: "✏️",
            category: "Activity",
          },
    ),
  ];
}

export function CommandPalette({
  units,
  perspectives,
  processes,
  isOpen,
  onClose,
  onNavigate,
  institutionName,
  institutionSearchScope,
  institutionScope,
  canSearchSkills,
  canSearchCurriculum,
}: {
  units: UnitInfo[];
  perspectives: { _id: string; title: string; icon?: string | null }[];
  processes: { _id: string; title: string; emoji?: string | null }[];
  isOpen: boolean;
  onClose: () => void;
  onNavigate: (href: string) => void;
  /** Active institution's display name (for honest scope-aware miss copy). */
  institutionName?: string | null;
  /** Whether one institution or every institution is in view. */
  institutionSearchScope?: ScholarSearchScope;
  /** URL scope forwarded to institution-aware search queries. */
  institutionScope?: string;
  /** Whether the current staff role may use the teacher-only skills search. */
  canSearchSkills: boolean;
  /** Whether the caller has curriculum access — i.e. a Units tab to land on. */
  canSearchCurriculum: boolean;
}) {
  // Gate the live scholar subscription on open — keeps it out of the layout's
  // steady state. (`?? []` so a freshly-opened palette renders curriculum
  // results immediately while scholars load.)
  const scholars = (
    useQuery(
      api.users.listDirectoryScholars,
      isOpen
        ? { institutionScope: institutionScope || undefined }
        : "skip",
    ) ?? EMPTY_SCHOLARS
  ) as Scholar[];
  const [query, setQuery] = useState("");
  const [activeIdx, setActiveIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const searchTerm = useDebounced(query, SEARCH_DEBOUNCE_MS);
  const skills =
    (useQuery(
      api.standingPractice.searchSkills,
      searchSkillsQueryArgs(canSearchSkills, isOpen, searchTerm),
    ) ?? EMPTY_SKILLS);
  const curriculum =
    (useQuery(
      api.units.searchCurriculum,
      searchCurriculumQueryArgs(
        canSearchCurriculum,
        isOpen,
        searchTerm,
        institutionScope,
      ),
    ) ?? EMPTY_CURRICULUM) as CurriculumHit[];

  const results = useMemo(
    () => (
      isOpen
        ? buildEntries(
            scholars, units, perspectives, processes, skills, curriculum, query,
          )
        : EMPTY_RESULTS
    ),
    [
      isOpen, scholars, units, perspectives, processes, skills, curriculum,
      query,
    ],
  );

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- reset palette state when dialog opens
    if (isOpen) { setQuery(""); setActiveIdx(0); setTimeout(() => inputRef.current?.focus(), 40); }
  }, [isOpen]);

  // eslint-disable-next-line react-hooks/set-state-in-effect -- reset highlighted result when query changes
  useEffect(() => { setActiveIdx(0); }, [query]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") { e.preventDefault(); setActiveIdx((i) => Math.min(i + 1, results.length - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActiveIdx((i) => Math.max(i - 1, 0)); }
    else if (e.key === "Enter" && results[activeIdx]) { onNavigate(results[activeIdx].href); }
    else if (e.key === "Escape") { onClose(); }
  };

  return (
    <Dialog.Root open={isOpen} onOpenChange={(e) => { if (!e.open) onClose(); }} placement="top">
      <Portal>
        <Dialog.Backdrop mt="-2em" h="calc(100vh + 4em)" />
        {/* Top-anchored portaled dialog: fold the iPad status-bar inset into
            the top offset so the palette clears it inside an app webview.
            env(safe-area-inset-top) is 0 in desktop browsers → no-op on web. */}
        <Dialog.Positioner pt="calc(15vh + env(safe-area-inset-top))" pb="0" alignItems="flex-start">
          <Dialog.Content maxW="480px" borderRadius="xl" shadow="2xl" overflow="hidden" p={0} mt={0}>
            {/* Search input */}
            <Box px={4} py={3} borderBottom="1px solid" borderColor="gray.200">
              <Input
                ref={inputRef as React.RefObject<HTMLInputElement>}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="Jump to a scholar, unit, lesson, activity, or math skill…"
                border="none"
                fontFamily="heading"
                fontSize="md"
                _focus={{ boxShadow: "none" }}
                _focusVisible={{ boxShadow: "none" }}
              />
            </Box>

            {/* Results */}
            <Box maxH="360px" overflowY="auto">
              {results.length === 0 ? (
                <Box px={4} py={8} textAlign="center">
                  <Text fontFamily="heading" fontSize="sm" color="charcoal.300">
                    {query.trim()
                      ? noScholarMatchCopy({
                          institutionName: institutionName ?? null,
                          scope: institutionSearchScope ?? "all",
                          includesCurriculum: true,
                        })
                      : "No results"}
                  </Text>
                </Box>
              ) : (
                results.map((item, i) => (
                  <HStack
                    key={item.key}
                    px={4}
                    py={2.5}
                    gap={3}
                    cursor="pointer"
                    bg={i === activeIdx ? "violet.50" : "white"}
                    _hover={{ bg: "violet.50" }}
                    onClick={() => onNavigate(item.href)}
                    onMouseEnter={() => setActiveIdx(i)}
                  >
                    {item.kind === "scholar" ? (
                      <Avatar size="sm" name={item.scholar.name ?? undefined} src={item.scholar.image || undefined} colorKey={item.scholar._id} />
                    ) : (
                      <Flex w="32px" h="32px" align="center" justify="center" flexShrink={0} fontSize="lg">
                        {item.emoji}
                      </Flex>
                    )}
                    <VStack gap={0} align="start" flex={1} minW={0}>
                      <Text fontFamily="heading" fontSize="sm" fontWeight={i === activeIdx ? "600" : "400"} color="navy.500">
                        {item.label}
                      </Text>
                      {item.sublabel && (
                        <Text fontFamily="heading" fontSize="xs" color="charcoal.400" overflow="hidden" whiteSpace="nowrap" textOverflow="ellipsis">
                          {item.sublabel}
                        </Text>
                      )}
                    </VStack>
                    {item.kind !== "scholar" && (
                      <Badge bg="gray.100" color="charcoal.400" fontFamily="heading" fontSize="2xs" px={1.5} flexShrink={0}>
                        {item.category}
                      </Badge>
                    )}
                  </HStack>
                ))
              )}
            </Box>

            {/* Footer hints */}
            <HStack px={4} py={2} borderTop="1px solid" borderColor="gray.100" bg="gray.50" gap={4}>
              <Text fontFamily="heading" fontSize="2xs" color="charcoal.300">↑↓ navigate</Text>
              <Text fontFamily="heading" fontSize="2xs" color="charcoal.300">↵ open</Text>
              <Text fontFamily="heading" fontSize="2xs" color="charcoal.300">esc close</Text>
              <Box flex={1} />
              <Text fontFamily="heading" fontSize="2xs" color="charcoal.300">⌘K</Text>
            </HStack>
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
}
