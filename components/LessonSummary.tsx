"use client";

/**
 * Summary tab of a LESSON — a read view: what the lesson is and the
 * activities under it, each with its maturity dot. Lessons are structural
 * (Review is unit-level, rehearsal is activity-level), so there's no lesson
 * maturity timeline yet — its activities carry the status. Editing is the
 * Edit tab. See review/curriculum-rehearse-and-maturity.md.
 */
import Link from "next/link";
import { useQuery } from "convex/react";
import { Badge, Box, Flex, HStack, Spinner, Stack, Text } from "@chakra-ui/react";
import { api } from "@/convex/_generated/api";
import { curriculumUnitHref } from "@/lib/curriculumHref";
import type { Id } from "@/convex/_generated/dataModel";
import { SectionEyebrow } from "@/components/ui/SectionEyebrow";
import { ActivityKindIcon } from "@/components/ActivityKindIcon";
import { ReadinessInline } from "@/components/curriculumDoc/ReadinessGate";
import { STRAND_CONFIG } from "@/lib/constants";

export function LessonSummary({
  unitId,
  lessonId,
}: {
  unitId: Id<"units">;
  lessonId: Id<"lessons">;
}) {
  const lesson = useQuery(api.lessons.get, { id: lessonId });
  const activities = useQuery(api.activities.listByLesson, { lessonId });
  const nodeStatuses = useQuery(api.unitMaturity.getNodeStatuses, { unitId });

  if (lesson === undefined) {
    return (
      <Flex h="full" align="center" justify="center">
        <Spinner size="md" color="violet.500" />
      </Flex>
    );
  }
  if (lesson === null) {
    return (
      <Flex h="full" align="center" justify="center">
        <Text fontSize="sm" color="charcoal.400">
          Lesson not found
        </Text>
      </Flex>
    );
  }

  const strand = (
    ["core", "connections", "practice", "identity"] as const
  ).includes(lesson.strand as never)
    ? (lesson.strand as "core" | "connections" | "practice" | "identity")
    : null;
  const strandCfg = strand ? STRAND_CONFIG[strand] : null;

  return (
    <Box h="full" overflowY="auto">
      <Stack gap={6} px={8} pt={2} pb={8} maxW="900px">
        {/* HEADER — title + strand + duration. */}
        <Stack gap={2}>
          <Text fontFamily="heading" fontWeight="700" fontSize="xl" color="navy.500">
            {lesson.title}
          </Text>
          <HStack gap={2} flexWrap="wrap">
            {strandCfg && (
              <Badge
                bg="white"
                color="gray.600"
                fontFamily="heading"
                fontSize="2xs"
                display="inline-flex"
                alignItems="center"
                gap={1}
              >
                <strandCfg.icon size={10} weight="bold" />
                {strandCfg.label}
              </Badge>
            )}
            {typeof lesson.durationMinutes === "number" && (
              <Badge bg="gray.100" color="charcoal.500" fontFamily="heading" fontSize="2xs">
                {lesson.durationMinutes} min
              </Badge>
            )}
          </HStack>
        </Stack>

        {/* ACTIVITIES — the work under this lesson, each linking to its own
            Summary, with its maturity dot. */}
        <Stack gap={3}>
          <SectionEyebrow>Activities</SectionEyebrow>
          {activities === undefined ? (
            <Spinner size="sm" color="violet.500" />
          ) : activities.length === 0 ? (
            <Text fontSize="sm" color="charcoal.400">
              No activities yet — add one in the outline or the Edit tab.
            </Text>
          ) : (
            <Stack gap={1.5}>
              {activities.map((a) => {
                const readiness =
                  nodeStatuses?.readiness.activities[String(a._id)];
                return (
                  <HStack
                    key={String(a._id)}
                    as={Link}
                    // @ts-expect-error — Chakra v3 polymorphic `as` doesn't
                    // carry <a> attrs in the type; forwarded at runtime.
                    href={curriculumUnitHref(unitId, { activityId: a._id })}
                    gap={3}
                    p={2.5}
                    bg="white"
                    borderWidth="1px"
                    borderColor="gray.200"
                    borderRadius="md"
                    cursor="pointer"
                    textDecoration="none"
                    _hover={{ bg: "gray.50", borderColor: "violet.300" }}
                  >
                    <ActivityKindIcon kind={a.kind} />
                    <Text
                      fontFamily="heading"
                      fontWeight="600"
                      fontSize="sm"
                      color="navy.500"
                      flex={1}
                      minW={0}
                      truncate
                    >
                      {a.title}
                    </Text>
                    {a.kind === "online" && readiness && (
                      <ReadinessInline readiness={readiness} w="96px" />
                    )}
                  </HStack>
                );
              })}
            </Stack>
          )}
        </Stack>
      </Stack>
    </Box>
  );
}
