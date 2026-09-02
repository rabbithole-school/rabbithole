"use client";

import { useMemo, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import {
  Box,
  Button,
  Flex,
  Heading,
  HStack,
  Spinner,
  Stack,
  Text,
} from "@chakra-ui/react";
import { CalendarBlank } from "@phosphor-icons/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { StartAssignmentDialog } from "@/components/StartAssignmentDialog";
import { Surface } from "@/components/ui/Surface";
import { toaster } from "@/lib/toaster";
import { useActiveInstitution } from "@/hooks/useActiveInstitution";

function nextWeekdayMs(now = Date.now()) {
  const date = new Date(now);
  do {
    date.setDate(date.getDate() + 1);
  } while (date.getDay() === 0 || date.getDay() === 6);
  date.setHours(12, 0, 0, 0);
  return date.getTime();
}

export function ProgramSchedule() {
  const { scopeParam } = useActiveInstitution(true);
  const overview = useQuery(api.assignments.programScheduleOverview, {
    institutionScope: scopeParam,
  });
  const periodState = useQuery(api.masterSchedule.programPeriods, {
    institutionScope: scopeParam,
  });
  const endActivity = useMutation(api.assignments.endProgramActivity);
  const [open, setOpen] = useState(false);
  const [groupId, setGroupId] = useState("");
  const [endingKey, setEndingKey] = useState<string | null>(null);
  const [defaultDueDateMs, setDefaultDueDateMs] = useState(nextWeekdayMs);

  const effectiveGroupId =
    groupId || String(overview?.groups[0]?.groupId ?? "");
  const selectedGroup = overview?.groups.find(
    (group) => String(group.groupId) === effectiveGroupId,
  );
  const selectedPeriod =
    periodState?.current ?? periodState?.periods[0] ?? null;
  const scheduledByGroup = useMemo(() => {
    const rows = new Map<string, NonNullable<typeof overview>["scheduled"]>();
    for (const group of overview?.groups ?? []) rows.set(String(group.groupId), []);
    for (const row of overview?.scheduled ?? []) {
      rows.get(String(row.groupId))?.push(row);
    }
    return rows;
  }, [overview]);

  const handleEnd = async (
    assignmentId: Id<"assignments">,
    activityId: Id<"activities">,
    activityTitle: string,
  ) => {
    const key = `${assignmentId}:${activityId}`;
    setEndingKey(key);
    try {
      await endActivity({ assignmentId, activityId });
      toaster.success({
        title: "Activity ended",
        description: `${activityTitle} is no longer available to this program.`,
      });
    } catch (error) {
      toaster.error({
        title: "Couldn’t end activity",
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setEndingKey(null);
    }
  };

  if (!overview) {
    return (
      <Flex h="full" align="center" justify="center">
        <Spinner color="violet.500" />
      </Flex>
    );
  }

  return (
    <Box h="full" overflowY="auto" bg="bg.subtle" p={{ base: 4, md: 6 }}>
      <Stack maxW="5xl" mx="auto" gap={5}>
        <Flex
          direction={{ base: "column", sm: "row" }}
          align={{ base: "stretch", sm: "center" }}
          justify="space-between"
          gap={3}
        >
          <Box>
            <HStack gap={2} color="navy.500">
              <CalendarBlank size={24} weight="duotone" />
              <Heading size="lg" fontFamily="heading">
                Available work
              </Heading>
            </HStack>
            <Text mt={1} color="fg.muted">
              Activities and their materials that scholars can open now.
            </Text>
          </Box>
        </Flex>

        {overview.groups.length === 0 && (
          <Surface p={{ base: 4, md: 5 }}>
            <Text color="fg.muted">
              No programs are assigned to you yet. A school administrator can
              add program access from Staff.
            </Text>
          </Surface>
        )}

        {overview.groups.map((group) => {
          const scheduled = scheduledByGroup.get(String(group.groupId)) ?? [];
          return (
            <Surface key={group.groupId} p={{ base: 4, md: 5 }}>
              <Flex align="center" justify="space-between" gap={3} mb={4}>
                <Box>
                  <Heading size="md" fontFamily="heading" color="navy.500">
                    {group.groupName}
                  </Heading>
                  <Text fontSize="sm" color="fg.muted">
                    {scheduled.length === 0
                      ? "No activities available yet."
                      : `${scheduled.length} available ${scheduled.length === 1 ? "activity" : "activities"}`}
                  </Text>
                </Box>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={!selectedPeriod}
                  onClick={() => {
                    setGroupId(String(group.groupId));
                    setDefaultDueDateMs(nextWeekdayMs());
                    setOpen(true);
                  }}
                >
                  Schedule homework
                </Button>
              </Flex>

              {scheduled.length === 0 ? (
                <Text
                  py={8}
                  textAlign="center"
                  fontSize="sm"
                  color="fg.muted"
                >
                  Schedule homework to choose existing work or create a
                  handout for a due date.
                </Text>
              ) : (
                <Stack gap={2}>
                  {scheduled.map((row) => (
                    <Flex
                      key={`${row.assignmentId}:${row.activityId}`}
                      direction={{ base: "column", sm: "row" }}
                      align={{ base: "flex-start", sm: "center" }}
                      justify="space-between"
                      gap={1}
                      px={3}
                      py={2.5}
                      bg="bg.subtle"
                      borderRadius="md"
                    >
                      <Box minW={0}>
                        <Text fontFamily="heading" fontWeight="600">
                          {row.activityTitle}
                        </Text>
                        <Text fontSize="sm" color="fg.muted">
                          {row.unitTitle}
                        </Text>
                        <Text
                          mt={1}
                          maxW="xl"
                          fontSize="xs"
                          color="fg.muted"
                          lineClamp={2}
                        >
                          {row.recipientCount}{" "}
                          {row.recipientCount === 1 ? "scholar" : "scholars"}
                          {" · "}
                          {row.materialCount === 0
                            ? "No materials"
                            : `${row.materialCount} ${
                                row.materialCount === 1
                                  ? "material"
                                  : "materials"
                              }`}
                        </Text>
                      </Box>
                      <Stack
                        align={{ base: "flex-start", sm: "flex-end" }}
                        gap={1}
                        flexShrink={0}
                      >
                        <Text fontSize="xs" color="fg.muted">
                          Available since{" "}
                          {new Intl.DateTimeFormat(undefined, {
                            month: "short",
                            day: "numeric",
                          }).format(row.sharedAt)}
                        </Text>
                        <Button
                          size="xs"
                          variant="ghost"
                          colorPalette="red"
                          loading={
                            endingKey ===
                            `${row.assignmentId}:${row.activityId}`
                          }
                          onClick={() =>
                            void handleEnd(
                              row.assignmentId,
                              row.activityId,
                              row.activityTitle,
                            )
                          }
                        >
                          End availability
                        </Button>
                      </Stack>
                    </Flex>
                  ))}
                </Stack>
              )}
            </Surface>
          );
        })}
      </Stack>

      <StartAssignmentDialog
        open={
          open &&
          selectedGroup !== undefined &&
          selectedPeriod !== null
        }
        onClose={() => {
          setOpen(false);
          setGroupId("");
        }}
        programTarget={
          selectedGroup && selectedPeriod
            ? {
                groupId: selectedGroup.groupId,
                groupName: selectedGroup.groupName,
                institutionScope: scopeParam,
                periodId: selectedPeriod._id,
                subject: selectedGroup.groupName,
                scheduleTarget: {
                  mode: "homework",
                  dueDateMs: defaultDueDateMs,
                },
              }
            : undefined
        }
        contextText={
          selectedGroup
            ? `Choose existing work or create a handout for ${selectedGroup.groupName}.`
            : undefined
        }
      />
    </Box>
  );
}
