"use client";

/**
 * Roll-up placeholder for an operation that's activity-grained (Rehearse,
 * Debrief) shown at a coarser altitude (unit or lesson). The stake in the
 * ground: every operation makes sense at every level — here it's "X of Y
 * activities {rehearsed|debriefed}" + drill-down links to each activity
 * where the real op lives. Gets fancier over time (a true sim-runs-a-whole-
 * unit) without changing the surface. See
 * review/curriculum-rehearse-and-maturity.md.
 */
import Link from "next/link";
import { useQuery } from "convex/react";
import { Box, Flex, HStack, Progress, Spinner, Stack, Text } from "@chakra-ui/react";
import { CaretRight } from "@phosphor-icons/react";
import { curriculumUnitHref } from "@/lib/curriculumHref";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { EMPTY_SESSIONS } from "@/convex/lib/activitySessions";
import { isRehearsableActivityKind } from "@/lib/rehearsalActivityKinds";
import { SectionEyebrow } from "@/components/ui/SectionEyebrow";
import { ActivityKindIcon } from "@/components/ActivityKindIcon";
import { ReadinessInline } from "@/components/curriculumDoc/ReadinessGate";
import { SessionsInline } from "@/components/curriculumDoc/SessionsSignal";

const COPY = {
  preflight: {
    verb: "ready",
    blurb:
      "Readiness runs per activity — scholar-bot rehearsal for Online, manual rehearsal for Vibecode, and Simulator-specific Preflight. Here's where each stands; open one to rehearse it.",
  },
  debrief: {
    verb: "debriefed",
    blurb:
      "Debriefing uses each activity's own session surface. Here's where each stands; open one to debrief it.",
  },
} as const;

export function RollupPane({
  unitId,
  lessonId,
  op,
  onOpenActivity,
}: {
  unitId: Id<"units">;
  /** Scope to one lesson's activities; omit for the whole unit. */
  lessonId?: Id<"lessons">;
  op: "preflight" | "debrief";
  /** When provided, a row retargets the surface in place (the hosting hub
   *  swaps to that activity) instead of linking to the column-view pane URL —
   *  the document view can't honor that pane path, so the link would only
   *  scroll and never open the activity's rehearse/debrief surface. Absent =
   *  keep the column-view Link (UnitDesigner relies on it). */
  onOpenActivity?: (a: {
    activityId: Id<"activities">;
    lessonId: Id<"lessons">;
    title: string;
  }) => void;
}) {
  const tab = op === "debrief" ? "debrief" : "preflight";
  // Readiness/preflight is the green signal; Sessions/debrief is the violet one.
  const accent = op === "debrief" ? "violet" : "green";
  const fromLesson = useQuery(
    api.activities.listByLesson,
    lessonId ? { lessonId } : "skip",
  );
  const fromUnit = useQuery(
    api.activities.listByUnitPublic,
    lessonId ? "skip" : { unitId },
  );
  const nodeStatuses = useQuery(api.unitMaturity.getNodeStatuses, { unitId });
  // Sessions field record — only needed for the violet debrief roll-up.
  const sessionsData = useQuery(
    api.activitySessions.getForUnit,
    op === "debrief" ? { unitId } : "skip",
  );

  const all = lessonId ? fromLesson : fromUnit;
  const sessionsLoading = op === "debrief" && sessionsData === undefined;
  if (all === undefined || nodeStatuses === undefined || sessionsLoading) {
    return (
      <Flex h="full" align="center" justify="center">
        <Spinner size="md" color={`${accent}.500`} />
      </Flex>
    );
  }

  // Every activity with a real Preflight/Rehearse surface participates. "Done"
  // is read from the same canonical signals used elsewhere in the curriculum UI.
  const rehearsable = all.filter((a) => isRehearsableActivityKind(a.kind));
  const isDone = (id: string): boolean =>
    op === "debrief"
      ? (sessionsData?.activities[id]?.meanFitness ?? null) !== null
      : nodeStatuses.readiness.activities[id]?.ready === true;
  const doneCount = rehearsable.filter((a) => isDone(String(a._id))).length;
  const pct =
    rehearsable.length > 0 ? (doneCount / rehearsable.length) * 100 : 0;
  const copy = COPY[op];

  return (
    <Box h="full" overflowY="auto">
      <Stack gap={6} p={8} maxW="900px">
        <Stack gap={2}>
          <SectionEyebrow>{op === "debrief" ? "Debrief" : "Preflight"} · roll-up</SectionEyebrow>
          <Text fontSize="sm" color="charcoal.500" maxW="600px">
            {copy.blurb}
          </Text>
        </Stack>

        {rehearsable.length === 0 ? (
          <Text fontSize="sm" color="charcoal.400">
            No rehearsable activities here yet.
          </Text>
        ) : (
          <Stack gap={4}>
            <Box maxW="420px">
              <HStack justify="space-between" mb={1}>
                <Text fontSize="sm" fontFamily="heading" color="charcoal.600">
                  {doneCount} of {rehearsable.length} {copy.verb}
                </Text>
              </HStack>
              <Progress.Root value={pct} size="sm" colorPalette={accent}>
                <Progress.Track borderRadius="full">
                  <Progress.Range borderRadius="full" />
                </Progress.Track>
              </Progress.Root>
            </Box>

            <Stack gap={1.5}>
              {rehearsable.map((a) => {
                const id = String(a._id);
                const readiness = nodeStatuses.readiness.activities[id];
                // Schema leaves lessonId optional (scholar-scoped activities
                // lack one) — a retarget needs it, so such a row keeps the
                // Link fallback rather than becoming a dead button.
                const rowLessonId = a.lessonId;
                const retarget =
                  onOpenActivity && rowLessonId
                    ? () =>
                        onOpenActivity({
                          activityId: a._id,
                          lessonId: rowLessonId,
                          title: a.title,
                        })
                    : undefined;
                // `as`/`href`/`type` are the polymorphic native <a>/<button>
                // attrs Chakra forwards at runtime but omits from HStack's
                // prop type; a spread (unlike an inline attr) skips excess-
                // property checks, so no suppression is needed. Retarget in
                // place when possible, else fall back to the legacy
                // column-view pane URL.
                const polymorphic = retarget
                  ? ({ as: "button", type: "button" } as const)
                  : ({
                      as: Link,
                      href: curriculumUnitHref(unitId, {
                        activityId: a._id,
                        pane: tab,
                      }),
                    } as const);
                return (
                  <HStack
                    key={id}
                    {...polymorphic}
                    onClick={retarget}
                    gap={3}
                    p={2.5}
                    bg="white"
                    borderWidth="1px"
                    borderColor="gray.200"
                    borderRadius="md"
                    cursor="pointer"
                    textAlign="left"
                    textDecoration="none"
                    _hover={{ bg: "gray.50", borderColor: `${accent}.300` }}
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
                    {op === "debrief" ? (
                      <SessionsInline
                        sessions={sessionsData?.activities[id] ?? EMPTY_SESSIONS}
                      />
                    ) : (
                      readiness && (
                        <ReadinessInline readiness={readiness} w="96px" />
                      )
                    )}
                    <Box color="charcoal.300" flexShrink={0}>
                      <CaretRight size={14} />
                    </Box>
                  </HStack>
                );
              })}
            </Stack>
          </Stack>
        )}
      </Stack>
    </Box>
  );
}
