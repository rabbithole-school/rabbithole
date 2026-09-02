"use client";

import { useQuery } from "convex/react";
import { Box, Flex, HStack, Text, Wrap } from "@chakra-ui/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { Avatar } from "@/components/Avatar";
import { Surface } from "@/components/ui/Surface";
import { useNow } from "@/hooks/useNow";
import { assignedChipText } from "./HomeworkContent";

// ── Prep board — "Tonight, for the room" ──────────────────────────────────
// The teacher-facing half of the prep ritual: one row per scholar in the group
// → their derived assigned homework (with due phrases), the items they chose
// for tonight and any notes (the parts of the list a teacher can't see anywhere
// else), a NEUTRAL empty-list flag, and the named outcome of homework that was
// due by this morning. It is a READ (T4): the teacher never edits a scholar's
// items from here — those are the scholar's. One canonical rendering (T1); the
// Today prep-window row only links here, it doesn't re-render this.

type GroupPlan = NonNullable<
  ReturnType<typeof useQuery<typeof api.takeHomePlans.forGroupAsTeacher>>
>;
type ScholarRow = GroupPlan["scholars"][number];

function Chip({
  eyebrow,
  text,
  bg,
}: {
  eyebrow: string;
  text: string;
  bg: string;
}) {
  return (
    <Box
      bg={bg}
      borderWidth="1px"
      borderColor="gray.200"
      borderRadius="md"
      px={2.5}
      py={1}
      maxW="full"
    >
      <Text fontFamily="body" fontSize="xs" color="charcoal.500" lineHeight="1.35">
        <Text as="span" fontWeight="700" color="charcoal.600">
          {eyebrow}
        </Text>{" "}
        {text}
      </Text>
    </Box>
  );
}

function TonightChips({ scholar, nowMs }: { scholar: ScholarRow; nowMs: number }) {
  if (scholar.emptyList) {
    return (
      <Text fontFamily="body" fontSize="sm" color="charcoal.400">
        Nothing on the list yet
      </Text>
    );
  }
  return (
    <Wrap gap={2}>
      {scholar.assigned.map((item) => (
        <Chip
          key={item.id}
          eyebrow="Assigned"
          text={assignedChipText(item, scholar.timeZone, nowMs).text}
          bg="blue.50"
        />
      ))}
      {scholar.selected.map((item) =>
        item.kind === "note" ? (
          <Chip key={item.id} eyebrow="Note" text={item.text} bg="amber.50" />
        ) : (
          <Chip
            key={item.id}
            eyebrow="Chosen"
            text={item.label}
            bg="violet.50"
          />
        ),
      )}
    </Wrap>
  );
}

function LastNight({ scholar }: { scholar: ScholarRow }) {
  const total = scholar.lastNight.length;
  const notDone = scholar.lastNight.filter((h) => !h.done);
  let color = "charcoal.400";
  let body: string;
  if (total === 0) {
    body = "nothing due";
  } else if (notDone.length === 0) {
    color = "green.600";
    body = `${total} of ${total} done`;
  } else {
    color = "amber.600";
    // Name what wasn't done (T10), never a bare count.
    body = notDone.map((h) => `${h.label} not done`).join(" · ");
  }
  return (
    <Box textAlign={{ base: "left", md: "right" }} minW={0}>
      <Text
        fontFamily="heading"
        fontSize="2xs"
        fontWeight="700"
        letterSpacing="0.04em"
        textTransform="uppercase"
        color="charcoal.400"
      >
        Due by today
      </Text>
      <Text fontFamily="body" fontSize="sm" color={color} lineHeight="1.35">
        {body}
      </Text>
    </Box>
  );
}

function ScholarRowView({ scholar, nowMs }: { scholar: ScholarRow; nowMs: number }) {
  return (
    <Flex
      align={{ base: "flex-start", md: "center" }}
      gap={4}
      px={{ base: 4, md: 5 }}
      py={4}
      direction={{ base: "column", md: "row" }}
    >
      <HStack gap={2.5} minW={{ md: "160px" }} flexShrink={0}>
        <Avatar
          size="sm"
          name={scholar.name}
          src={scholar.image || undefined}
          colorKey={scholar.scholarId}
        />
        <Text
          fontFamily="heading"
          fontWeight="600"
          fontSize="sm"
          color="navy.600"
          truncate
        >
          {scholar.name}
        </Text>
      </HStack>
      <Box flex={1} minW={0}>
        <TonightChips scholar={scholar} nowMs={nowMs} />
      </Box>
      <Box w={{ md: "180px" }} flexShrink={0}>
        <LastNight scholar={scholar} />
      </Box>
    </Flex>
  );
}

export function PrepBoard({ groupId }: { groupId: Id<"scholarGroups"> }) {
  // `now` drives the institution-local day key + homework read, exactly as the
  // scholar card does. Minute cadence is plenty for a nightly ritual.
  const nowMs = useNow(60_000);
  const plan = useQuery(api.takeHomePlans.forGroupAsTeacher, {
    groupId,
    now: nowMs,
  });

  if (plan === undefined || plan.scholars.length === 0) return null;

  const emptyCount = plan.scholars.filter((s) => s.emptyList).length;
  const scholarCount = plan.scholars.length;

  return (
    <Box>
      <Text
        fontFamily="heading"
        fontSize="xs"
        fontWeight="700"
        letterSpacing="0.04em"
        textTransform="uppercase"
        color="charcoal.400"
        mb={3}
      >
        Tonight, for the room
      </Text>
      <Surface overflow="hidden">
        <Flex
          align="center"
          justify="space-between"
          gap={3}
          px={{ base: 4, md: 5 }}
          py={3.5}
          borderBottomWidth="1px"
          borderColor="gray.100"
        >
          <Text fontFamily="heading" fontWeight="600" fontSize="md" color="navy.500">
            🌙 Tonight&apos;s lists
          </Text>
          <Text fontFamily="body" fontSize="xs" color="charcoal.400">
            {scholarCount} scholar{scholarCount === 1 ? "" : "s"}
            {emptyCount > 0
              ? ` · ${emptyCount} with an empty list`
              : ""}
          </Text>
        </Flex>
        <Box>
          {plan.scholars.map((scholar, index) => (
            <Box
              key={scholar.scholarId}
              borderTopWidth={index === 0 ? "0" : "1px"}
              borderColor="gray.100"
            >
              <ScholarRowView scholar={scholar} nowMs={nowMs} />
            </Box>
          ))}
        </Box>
      </Surface>
    </Box>
  );
}
