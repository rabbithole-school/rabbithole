"use client";

/**
 * The Assign tab body — "go live with real scholars" at any altitude.
 * Shows this unit's assignment runs (active + past) and an Assign CTA that
 * opens StartAssignmentDialog **prefilled with the current node**: a whole
 * unit, just this lesson, or this single activity (per the dialog's
 * targetKind). See review/curriculum-rehearse-and-maturity.md — Assign is
 * the bridge between the sim-world rungs and Debrief.
 *
 * Ported from UnitSummary's old in-Summary "Assignments" section, now its
 * own tab + node-aware.
 */
import { useState } from "react";
import Link from "next/link";
import { useQuery } from "convex/react";
import { Badge, Box, Button, HStack, Stack, Text } from "@chakra-ui/react";
import { Plus } from "@phosphor-icons/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { SectionEyebrow } from "@/components/ui/SectionEyebrow";
import { ScholarFacepile } from "@/components/ScholarFacepile";
import { StartAssignmentDialog } from "@/components/StartAssignmentDialog";
import { formatRelative } from "@/lib/relativeTime";

export function AssignPane({
  unitId,
  lessonId,
  activityId,
  nodeLabel,
}: {
  unitId: Id<"units">;
  /** Set on a lesson's Assign tab — prefills the dialog to the whole lesson. */
  lessonId?: Id<"lessons">;
  /** Set on an activity's Assign tab — prefills to that single activity
   *  (requires lessonId so it resolves + shows single-activity scheduling). */
  activityId?: Id<"activities">;
  /** "unit" / "lesson" / "activity" — what the CTA assigns. */
  nodeLabel: string;
}) {
  const assignments = useQuery(api.assignments.listForUnit, { unitId });
  const [assignOpen, setAssignOpen] = useState(false);

  const active = (assignments ?? []).filter((a) => a.archivedAt === null);
  const past = (assignments ?? []).filter((a) => a.archivedAt !== null);

  return (
    <Box h="full" overflowY="auto">
      <Stack gap={6} p={8} maxW="900px">
        <HStack justify="space-between" align="baseline" flexWrap="wrap" gap={2}>
          <Stack gap={1}>
            <Text fontFamily="heading" fontWeight="700" fontSize="lg" color="navy.500">
              Assign this {nodeLabel}
            </Text>
            <Text fontSize="sm" color="charcoal.500" maxW="560px">
              Send {nodeLabel === "unit" ? "the whole unit" : `this ${nodeLabel}`}{" "}
              to a cohort — push activities to the class or send homework from
              the Run page. This is the bridge to a Debrief: real-scholar work
              is what the sims get checked against.
            </Text>
          </Stack>
          <Button
            bg="violet.500"
            color="white"
            _hover={{ bg: "violet.600" }}
            fontFamily="heading"
            fontWeight="600"
            size="sm"
            flexShrink={0}
            onClick={() => setAssignOpen(true)}
          >
            <Plus /> Assign
          </Button>
        </HStack>

        <Stack gap={3}>
          <HStack gap={2} align="baseline">
            <SectionEyebrow>Runs</SectionEyebrow>
            {active.length > 0 && (
              <Text fontSize="xs" color="charcoal.400" fontFamily="heading">
                · {active.length} active
              </Text>
            )}
          </HStack>

          {active.length === 0 ? (
            <Box
              py={6}
              px={6}
              bg="white"
              borderWidth="1px"
              borderColor="gray.200"
              borderStyle="dashed"
              borderRadius="lg"
            >
              <Text fontSize="sm" color="charcoal.400" textAlign="center">
                Not assigned to anyone yet.
              </Text>
            </Box>
          ) : (
            <Stack gap={1.5}>
              {active.map((a) => (
                <AssignmentRow key={String(a._id)} row={a} />
              ))}
            </Stack>
          )}

          {past.length > 0 && (
            <Stack gap={1.5} mt={2}>
              <Text
                fontSize="2xs"
                color="charcoal.400"
                fontFamily="heading"
                fontWeight="600"
                textTransform="uppercase"
                letterSpacing="0.04em"
              >
                Past ({past.length})
              </Text>
              {past.map((a) => (
                <AssignmentRow key={String(a._id)} row={a} archived />
              ))}
            </Stack>
          )}
        </Stack>
      </Stack>

      <StartAssignmentDialog
        open={assignOpen}
        onClose={() => setAssignOpen(false)}
        initialUnitId={unitId}
        initialLessonId={lessonId}
        initialActivityId={activityId}
      />
    </Box>
  );
}

type AssignmentRowData = NonNullable<
  ReturnType<typeof useQuery<typeof api.assignments.listForUnit>>
>[number];

function AssignmentRow({
  row,
  archived = false,
}: {
  row: AssignmentRowData;
  archived?: boolean;
}) {
  const href = `/teacher/schedule/${row._id}`;
  const pushCount = row.classFocusCount + row.homeworkCount;

  return (
    <HStack
      as={Link}
      // @ts-expect-error — Chakra v3's polymorphic `as` doesn't carry <a>
      // attrs through the type, but they're forwarded at runtime.
      href={href}
      gap={3}
      p={2.5}
      bg="white"
      borderWidth="1px"
      borderColor="gray.200"
      borderRadius="md"
      cursor="pointer"
      textDecoration="none"
      opacity={archived ? 0.7 : 1}
      transition="all 0.15s"
      _hover={{ bg: "gray.50", borderColor: "violet.300", shadow: "xs" }}
    >
      <Box fontSize="xl" lineHeight="1" flexShrink={0}>
        {row.unitEmoji ?? "📋"}
      </Box>
      <Stack gap={1} flex={1} minW={0}>
        <HStack gap={2} flexWrap="wrap">
          <Text fontFamily="heading" fontWeight="700" color="navy.500" fontSize="sm">
            {row.title ?? row.unitTitle}
          </Text>
          {!archived && row.classFocusCount > 0 && (
            <Badge bg="violet.100" color="violet.700" fontFamily="heading" fontSize="2xs">
              {row.classFocusCount} class focus
            </Badge>
          )}
          {!archived && row.homeworkCount > 0 && (
            <Badge bg="orange.100" color="orange.700" fontFamily="heading" fontSize="2xs">
              {row.homeworkCount} homework
            </Badge>
          )}
          {archived && (
            <Badge bg="gray.200" color="charcoal.500" fontFamily="heading" fontSize="2xs">
              Archived
            </Badge>
          )}
        </HStack>
        <HStack gap={2} align="center">
          <ScholarFacepile
            scholars={row.facepile}
            total={row.scholarCount}
            size="xs"
            max={4}
          />
          <Text fontSize="2xs" color="charcoal.400" fontFamily="heading">
            ·{" "}
            {archived
              ? `Archived ${formatRelative(row.archivedAt ?? row.startedAt)}`
              : `Started ${formatRelative(row.startedAt)}`}
            {!archived && pushCount === 0 ? " · nothing pushed yet" : ""}
          </Text>
        </HStack>
      </Stack>
    </HStack>
  );
}
