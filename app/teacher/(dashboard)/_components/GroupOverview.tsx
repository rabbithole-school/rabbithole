"use client";

import { Box, Flex, VStack, Text, Button } from "@chakra-ui/react";
import { Users } from "@phosphor-icons/react";
import NextLink from "next/link";
import { type Scholar } from "./types";
import { RosterBoard } from "./RosterBoard";
import { useNow } from "@/hooks/useNow";
import { useRosterPulse } from "@/hooks/useRosterPulse";

// ── Group Overview ────────────────────────────────────────────────────────
// The /teacher/scholars "Snapshot" tab content (no scholar selected): the
// card grid + the group-scoped digest/prep sections. It renders under the
// page-level Snapshot · Academic Rounds · SEL Rounds tab bar (the layout owns
// the tabs; Rounds is a sibling tab, not a door here). Class Galaxy lives on
// the Quests tab (beside Trophy Case) and Math skills has its own top-nav tab,
// so neither is duplicated here. Group-membership admin now lives solely on
// the School tab's Groups page (same ManageGroupsDialog); the left rail
// carries the scope rows.
//
// Scholar CREATION is not here: registration belongs on the School tab
// (/school/directory/scholars). This surface only reads + manages membership.
//
// Workshop ideas are no longer surfaced here either: scholar suggestions route
// to Slack (#workshop) on capture (scholarSuggestions.postWorkshopIdea), and
// staff read + reply to them through the Slack/web aide (list_scholar_suggestions
// / respond_to_suggestion) — the reply reaches the scholar in their reflection
// chat, unchanged. So the page ends at the class digest + prep config.
//
// TODO(pods): "groups" (scholarGroups) is the same concept the product calls
// "Pods" — consider renaming the model + UI to Pods in a dedicated pass.

export function GroupOverview({
  groupId,
  scholars,
  totalScholars,
  onSelectScholar,
  institutionScope,
}: {
  /** Real scholarGroup id — undefined for "All scholars" / "My scholars" (lenses fall back to whole-class). */
  groupId?: string;
  scholars: Scholar[];
  totalScholars: number;
  onSelectScholar: (id: string) => void;
  /** Institution lens scope, threaded to the roster's "Lately" pulse query. */
  institutionScope: string | undefined;
}) {
  // ONE clock + ONE rosterPulse for the whole group page.
  const nowMs = useNow(30_000);
  const { practicedToday } = useRosterPulse(institutionScope, nowMs);

  // No scholars at all → the first-run empty state. Creation is NOT offered
  // here (Andy, 2026-08-24): registration lives on the School tab, so the empty
  // state points there rather than dead-ending. `onSelectScholar` is unused in
  // this branch but kept in the props for the populated view below.
  if (totalScholars === 0) {
    return (
      <Flex align="center" justify="center" h="full" p={8}>
        <VStack gap={4}>
          <Users size={48} color="#c1c1c1" />
          <Text fontFamily="heading" color="charcoal.400" fontSize="md">No scholars enrolled yet</Text>
          <Button asChild size="sm" bg="violet.500" color="white" fontFamily="heading" _hover={{ bg: "violet.600" }}>
            <NextLink href="/school/directory/scholars">
              <Users size={15} style={{ marginRight: "6px" }} /> Add scholars in the School directory
            </NextLink>
          </Button>
        </VStack>
      </Flex>
    );
  }

  return (
    // pt=0: the tab bar above carries its own vertical padding, so any top
    // padding here reads as a dead band under it (Andy, 2026-08-25).
    <Box h="full" overflowY="auto" px={{ base: 5, lg: 8 }} pb={{ base: 5, lg: 8 }} pt={0}>
      <Box maxW="1000px" mx="auto">
        {/* No page header here — the tab bar is the top element now, and the
            rail's active scope row carries the scope context (the big
            "All scholars"/group-name header + "N scholars · M active now"
            subhead were removed, Andy's call). The card grid leads. */}

        {/* The roster — Now / Lately / Tonight over one list of names. Now +
            Lately answer "what's everyone doing now?" and "how's everyone doing
            lately?" off the observer's existing analyses; Tonight is the prep
            read (each scholar's assigned homework, chosen items + notes, and
            last night's outcome) — folded IN here as a third segment rather than
            a second scholar list stacked below. Real pods get Tonight; the
            whole-class scopes don't (no groupId to read). */}
        {/* No top margin on the FIRST section — the wrapper's padding
            already sets the gap below the tab bar; an mt here double-stacked it
            into a dead vertical band (Andy, 2026-08-25). Later sections keep
            their mt={8} between-section rhythm. */}
        <Box>
          <RosterBoard
            scholars={scholars}
            onSelectScholar={onSelectScholar}
            practicedToday={practicedToday}
            emptyState={
              <Text fontFamily="body" color="charcoal.400" fontSize="sm" py={2}>
                {groupId
                  ? "No scholars in this group yet — manage membership from the School tab's Groups page."
                  : "No scholars here yet."}
              </Text>
            }
          />
        </Box>

        {/* The class-scoped digest card was KILLED (Andy, 2026-08-25): in a
            month on prod the class-scoped generator produced zero rows — a
            standing surface whose data source never fired. The activity-scoped
            digest lives on where it's used: the assignment Run page
            (ClassDigestInline in AssignmentPanel). */}

        {/* The Scholar's Prep participation TOGGLE was removed (Andy,
            2026-08-24): participation is school-config-level state, managed
            via the setGroupDailyBlock mutation (aide / admin tooling) rather
            than a per-group UI control. The ritual's WHEN stays on the bell
            schedule (Move 5); participation stays in scholarGroups.dailyBlocks. */}
      </Box>
    </Box>
  );
}
