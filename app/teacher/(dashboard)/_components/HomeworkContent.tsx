"use client";

/**
 * The per-scholar CONTENT cell of a Homework row (Scholar's Prep) — what is due,
 * what they closed today, their best next question, and last night's outcome. Extracted from the old HomeworkList so the shared
 * `ScholarWorkTable` can render the grade + name columns once and swap only
 * this cell as the tab changes. The windowed read + row layout moved to the
 * table; only the chip/outcome rendering lives here.
 */

import { Box, Flex, Stack, Text, Wrap } from "@chakra-ui/react";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { useNow } from "@/hooks/useNow";
import { DEFAULT_TIMEZONE, dueStatus } from "@/shared/institutionDay";

/** The batched, windowed read is chunked into fixed pages so no single
 *  subscription's read volume grows unbounded. A deliberate read-volume bound
 *  the shared table preserves — one `useQueries` entry per page. */
export const HOMEWORK_PAGE_SIZE = 20;

export type ViewPlan = NonNullable<
  ReturnType<typeof useQuery<typeof api.takeHomePlans.forVisibleScholarsAsTeacher>>
>;
export type HomeworkPlanRow = ViewPlan["scholars"][number];

function HomeworkChip({ text, bg, color }: { text: string; bg: string; color: string }) {
  return (
    <Box bg={bg} borderWidth="1px" borderColor="gray.200" borderRadius="md" px={2.5} py={1} maxW="full">
      <Text fontFamily="body" fontSize="xs" color={color} lineHeight="1.35">
        {text}
      </Text>
    </Box>
  );
}

// `dueStatus()` renders overdue homework as "was due …"; the chip tint mirrors
// that — orange for overdue, neutral grey otherwise. Derived from the payload's
// `dueAt`, NOT by string-matching `meta`: `meta` is attribution (the unit), and
// the deadline is its own signal. THE one composition both teacher chip
// surfaces use, so the prep board and the homework table can never drift (T1).
export function assignedChipText(
  item: { label: string; meta: string | null; dueAt: number | null },
  timeZone: string | null,
  nowMs: number,
): { text: string; overdue: boolean } {
  const due = dueStatus(item.dueAt, nowMs, timeZone ?? DEFAULT_TIMEZONE);
  const detail = due?.phrase ?? item.meta;
  return {
    text: detail ? `${item.label} · ${detail}` : item.label,
    overdue: due?.status === "overdue",
  };
}

export function HomeworkChips({
  plan,
  planLoading,
}: {
  plan: HomeworkPlanRow | undefined;
  planLoading: boolean;
}) {
  // T11 "match the clock to the claim": overdue is a live, time-relative claim,
  // so derive it from a minute-bucketed reactive clock rather than a bare
  // `Date.now()` in render (which freezes the reading and trips react-compiler's
  // impure-call-in-render rule). One clock per surface, threaded into the map.
  const nowMs = useNow(60_000);
  // Query still loading → the only honest ellipsis.
  if (planLoading) {
    return (
      <Text fontFamily="body" fontSize="xs" color="charcoal.300">
        …
      </Text>
    );
  }
  // Resolved, but this scholar has no row — the read access-filtered them (a
  // legacy scholar with no institution). An honest quiet unavailable, NOT a
  // permanent loading ellipsis.
  if (!plan) {
    return (
      <Text fontFamily="body" fontSize="xs" color="charcoal.300" fontStyle="italic">
        Not available
      </Text>
    );
  }
  // Due (the scholar's Prep → Due list) then what they closed today (their
  // "Done today?" close-outs). The retired tonight plan ("Chosen" items and
  // notes) is not rendered: the scholar can no longer choose items.
  return (
    <Wrap gap={2}>
      {/* "Nothing due" would contradict a later-dated question chip beside it. */}
      {plan.emptyList && (plan.later ?? []).length === 0 && (
        <HomeworkChip text="Nothing due" bg="gray.100" color="charcoal.400" />
      )}
      {plan.assigned.map((item) => {
        const { text, overdue } = assignedChipText(item, plan.timeZone, nowMs);
        return (
          <HomeworkChip
            key={item.id}
            text={text}
            bg={overdue ? "orange.100" : "gray.100"}
            color={overdue ? "orange.700" : "charcoal.600"}
          />
        );
      })}
      {/* Question homework set for a day past the Due window (TRA-476): the
          same chip composition, so "due Thursday" reads like any deadline.
          `?? []`: an older backend's row (deploy skew) has no `later`. */}
      {(plan.later ?? []).map((item) => {
        const { text, overdue } = assignedChipText(item, plan.timeZone, nowMs);
        return (
          <HomeworkChip
            key={item.id}
            text={text}
            bg={overdue ? "orange.100" : "gray.100"}
            color={overdue ? "orange.700" : "charcoal.600"}
          />
        );
      })}
      {/* `?? []`: an older backend's row (deploy skew) has no closedToday. */}
      {(plan.closedToday ?? []).map((item) => (
        <HomeworkChip
          key={item.itemId}
          text={`✓ ${item.label} · done today`}
          bg="green.50"
          color="green.700"
        />
      ))}
    </Wrap>
  );
}

/** The scholar's single best next question (top question of their queue),
 *  one line. The "Assign…" control sits outside the row's anchor. */
export function BestNextQuestion({ plan }: { plan: HomeworkPlanRow | undefined }) {
  if (!plan?.bestNext) return null;
  return (
    <Text
      fontFamily="body"
      fontSize="sm"
      color="charcoal.500"
      lineHeight="1.35"
      lineClamp={1}
      title={plan.bestNext.prompt}
      data-testid="prep-best-next"
    >
      <Text as="span" aria-hidden="true" mr={1.5}>
        {plan.bestNext.emoji}
      </Text>
      {plan.bestNext.prompt}
    </Text>
  );
}

// The lean read still returns `lastNight` cheaply (the lean flag only drops the
// suggestions/resolvedToday scans), so last night's outcome rides along quietly
// — named, never a bare count (T10).
export function LastNight({ plan }: { plan: HomeworkPlanRow | undefined }) {
  if (!plan || plan.lastNight.length === 0) {
    return (
      <Text fontFamily="body" fontSize="sm" color="charcoal.300" textAlign={{ base: "left", md: "right" }}>
        —
      </Text>
    );
  }
  const total = plan.lastNight.length;
  const notDone = plan.lastNight.filter((h) => !h.done);
  const done = notDone.length === 0;
  return (
    <Text
      fontFamily="body"
      fontSize="sm"
      color={done ? "green.600" : "amber.600"}
      lineHeight="1.35"
      textAlign={{ base: "left", md: "right" }}
    >
      {done
        ? `${total} of ${total} done`
        : notDone.map((h) => `${h.label} not done`).join(" · ")}
    </Text>
  );
}

/** The Homework (Scholar's Prep) tab's content cell: due + closed-today chips
 *  and the best next question (flex), then last night's outcome. */
export function HomeworkContent({
  plan,
  planLoading,
}: {
  plan: HomeworkPlanRow | undefined;
  planLoading: boolean;
}) {
  return (
    <Flex
      gap={{ base: 2, md: 4 }}
      align={{ base: "flex-start", md: "center" }}
      direction={{ base: "column", md: "row" }}
      minW={0}
    >
      <Stack flex={1} minW={0} gap={1.5}>
        <HomeworkChips plan={plan} planLoading={planLoading} />
        <BestNextQuestion plan={plan} />
      </Stack>
      <Box w={{ md: "180px" }} flexShrink={0}>
        <LastNight plan={plan} />
      </Box>
    </Flex>
  );
}
