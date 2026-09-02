"use client";

import { useMemo, type ReactNode } from "react";
import { Box, HStack, Stack, Text, chakra } from "@chakra-ui/react";
import { Avatar } from "@/components/Avatar";
import { FlagMisconceptionControl } from "@/components/practice/FlagMisconceptionControl";
import type { Id } from "@/convex/_generated/dataModel";
import { type Scholar, timeAgo } from "./types";

// ── RosterBoard — the Snapshot scholar-card grid ────────────────────────────
// A responsive GRID of one card per scholar. Each card is intentionally spare:
// avatar + name + active-now dot + practiced-today dot, then the Now
// one-liner + recency. The homework/tonight strip moved OFF the card to its own
// Homework tab (Andy), and the sparkline was dropped earlier — so the card is
// now a quiet "who's who + what are they doing right now", nothing more.
//
// SUBSCRIPTIONS: no per-card queries. The parent (GroupOverview) owns ONE clock
// + ONE rosterPulse and passes practiced-today down; active-now reads the
// already-loaded roster feed. There is no tonight read here anymore — it lives
// on the Homework tab.

// A scholar is "active now" if seen within this window.
const ACTIVE_WINDOW_MS = 15 * 60 * 1000;

// Module helper (not called in render scope) so the freshness check can read the
// clock without tripping the react-hooks/purity rule — same idiom as timeAgo.
function isActiveNow(lastActive: number | null | undefined): boolean {
  return (lastActive ?? 0) >= Date.now() - ACTIVE_WINDOW_MS;
}

export interface RosterBoardProps {
  scholars: Scholar[];
  onSelectScholar: (id: string) => void;
  /** Scholars who practised today, from the parent's batched roster read. */
  practicedToday: Set<string>;
  /** Shown when there are no scholars. */
  emptyState?: ReactNode;
}

export function RosterBoard({
  scholars,
  onSelectScholar,
  practicedToday,
  emptyState,
}: RosterBoardProps) {
  // Most-recently-active first — the live triage order.
  const sorted = useMemo(
    () => [...scholars].sort((a, b) => (b.lastActive ?? 0) - (a.lastActive ?? 0)),
    [scholars],
  );

  return (
    <Box data-testid="roster-board">
      {scholars.length === 0 ? (
        emptyState ?? null
      ) : (
        <Box
          display="grid"
          gridTemplateColumns={{ base: "1fr", md: "repeat(2, 1fr)", xl: "repeat(3, 1fr)" }}
          gap={4}
        >
          {sorted.map((s) => (
            <ScholarCard
              key={s.id}
              scholar={s}
              practicedToday={practicedToday.has(s.id)}
              onSelect={onSelectScholar}
            />
          ))}
        </Box>
      )}
    </Box>
  );
}

// ── The card ────────────────────────────────────────────────────────────────

function ScholarCard({
  scholar,
  practicedToday,
  onSelect,
}: {
  scholar: Scholar;
  practicedToday: boolean;
  onSelect: (id: string) => void;
}) {
  const active = isActiveNow(scholar.lastActive);
  const activity =
    scholar.statusSummary ||
    scholar.processTitle ||
    scholar.lastSessionTitle ||
    "No activity yet";

  return (
    <Box
      role="group"
      className="group"
      position="relative"
      borderWidth="1px"
      borderColor="gray.200"
      borderRadius="xl"
      bg="white"
      p={4}
      transition="border-color 0.15s ease, background 0.15s ease"
      _hover={{ borderColor: "violet.300", bg: "gray.50" }}
    >
      {/* Whole-card click target (overlay idiom — like GalaxyEntry). Sits above
          the non-interactive content; the flag control below sits above IT. */}
      <chakra.button
        type="button"
        aria-label={`Open ${scholar.name || "scholar"}`}
        onClick={() => onSelect(scholar.id)}
        position="absolute"
        inset={0}
        zIndex={1}
        borderRadius="xl"
        cursor="pointer"
        _focusVisible={{ outline: "2px solid", outlineColor: "violet.400", outlineOffset: "2px" }}
      />

      {/* Flag — quiet card action, above the overlay so its popover works. */}
      <Box position="absolute" top={2.5} right={2.5} zIndex={2}>
        <FlagMisconceptionControl
          scholarId={scholar.id as Id<"users">}
          scholarName={scholar.name || "Scholar"}
        />
      </Box>

      <Stack gap={3} position="relative" zIndex={0}>
        {/* Header: avatar + name + presence + practiced dots. */}
        <HStack gap={2.5} align="center" pr={7}>
          <Avatar size="sm" name={scholar.name || "Scholar"} src={scholar.image || undefined} colorKey={scholar.id} />
          <Box flex={1} minW={0}>
            <Text fontFamily="heading" fontSize="sm" fontWeight="700" color="navy.500" lineClamp={1}>
              {scholar.name || "Scholar"}
            </Text>
          </Box>
          {active && (
            <Box
              as="span"
              w="8px"
              h="8px"
              borderRadius="full"
              bg="green.400"
              flexShrink={0}
              title="Active now"
              aria-label="Active now"
            />
          )}
          {practicedToday && (
            <Box
              as="span"
              w="7px"
              h="7px"
              borderRadius="full"
              bg="violet.400"
              flexShrink={0}
              title="Practiced today"
              aria-label="Practiced today"
            />
          )}
        </HStack>

        {/* Now — the observer/activity one-liner + recency. */}
        <Box>
          <Text fontFamily="body" fontSize="sm" color="charcoal.600" lineClamp={2} lineHeight="1.4">
            {activity}
          </Text>
          <Text
            fontFamily="heading"
            fontSize="2xs"
            fontWeight="600"
            color={active ? "green.600" : "charcoal.300"}
            mt={1}
          >
            {scholar.lastActive ? timeAgo(scholar.lastActive) : "No activity yet"}
          </Text>
        </Box>
      </Stack>
    </Box>
  );
}
