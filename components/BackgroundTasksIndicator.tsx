"use client";

/**
 * Global "background tasks running" indicator — a small spinner in the top-right
 * of the teacher header. Auto-improve runs (curriculumExperiments) execute in a
 * scheduled node action, so a teacher can start one inside an activity and then
 * navigate anywhere; before this, the only place a run was visible was the
 * activity it was launched from. This surfaces every in-flight run app-wide.
 *
 * Reactive (subscribes to curriculumExperiments.listRunning), so progress ticks
 * live and the spinner disappears on its own when the last run finishes. Renders
 * nothing when idle. Clicking opens a popover listing each run with its progress
 * and a deep link back to the unit designer for the activity that owns it.
 *
 * Mounted in both staff header paths (TeacherTopNav + StaffShell).
 */
import Link from "next/link";
import { curriculumUnitHref } from "@/lib/curriculumHref";
import { useConvexAuth, useQuery } from "convex/react";
import {
  Badge,
  Box,
  Flex,
  Popover,
  Portal,
  Progress,
  Spinner,
  Text,
} from "@chakra-ui/react";
import { Flask } from "@phosphor-icons/react";
import { api } from "@/convex/_generated/api";

const MODE_LABEL: Record<string, string> = {
  analyze: "Rehearse",
  propose: "Rehearse + revise",
  loop: "Rehearse + revise (loop)",
};

export function BackgroundTasksIndicator() {
  // `listRunning` is an authedQuery, and this indicator renders in headers that
  // can mount during the brief unauthenticated window of a cold hard-load
  // (bookmark / refresh of a teacher subroute). Firing the query then throws
  // "Not authenticated" and trips the page's ErrorBoundary — so gate on auth
  // being settled, matching the `isAuthenticated ? args : "skip"` convention
  // used everywhere else in the app.
  const { isAuthenticated } = useConvexAuth();
  const running = useQuery(
    api.curriculumExperiments.listRunning,
    isAuthenticated ? {} : "skip",
  );

  // Nothing in flight (or still loading / signed out) → show nothing.
  if (!running || running.length === 0) return null;

  return (
    <Popover.Root positioning={{ placement: "bottom-end" }}>
      <Popover.Trigger asChild>
        <Flex
          role="button"
          tabIndex={0}
          aria-label={`${running.length} background task${running.length === 1 ? "" : "s"} running`}
          align="center"
          gap={1.5}
          px={2}
          h="32px"
          borderRadius="md"
          cursor="pointer"
          color="cyan.600"
          _hover={{ bg: "cyan.50" }}
        >
          <Spinner size="sm" color="cyan.500" borderWidth="2px" />
          <Text fontSize="sm" fontFamily="heading" fontWeight="600">
            {running.length}
          </Text>
        </Flex>
      </Popover.Trigger>
      <Portal>
        <Popover.Positioner>
          <Popover.Content w="320px" shadow="lg" borderRadius="lg">
            <Popover.Body p={3}>
              <Flex align="center" gap={2} mb={2}>
                <Flask size={14} weight="duotone" color="var(--chakra-colors-cyan-500)" />
                <Text fontSize="xs" fontWeight="700" fontFamily="heading" color="charcoal.400">
                  Rehearsing · {running.length}
                </Text>
              </Flex>
              <Flex direction="column" gap={1}>
                {running.map((t) => (
                  <RunRow key={t.experimentId} task={t} />
                ))}
              </Flex>
            </Popover.Body>
          </Popover.Content>
        </Popover.Positioner>
      </Portal>
    </Popover.Root>
  );
}

type RunningTask = NonNullable<
  ReturnType<typeof useQuery<typeof api.curriculumExperiments.listRunning>>
>[number];

function RunRow({ task }: { task: RunningTask }) {
  const pct =
    task.sessionsTotal > 0
      ? Math.min(100, (task.sessionsDone / task.sessionsTotal) * 100)
      : 0;

  const body = (
    <Flex
      align="flex-start"
      gap={2.5}
      px={2}
      py={2}
      borderRadius="md"
      _hover={task.unitId ? { bg: "gray.50" } : undefined}
    >
      <Spinner size="xs" color="cyan.500" mt={1} flexShrink={0} />
      <Box flex={1} minW={0}>
        <Text
          fontSize="sm"
          fontFamily="heading"
          color="charcoal.700"
          lineClamp={1}
        >
          {task.activityTitle}
        </Text>
        <Flex align="center" gap={1.5} mb={1}>
          <Badge size="xs" colorPalette="cyan" variant="subtle">
            {MODE_LABEL[task.mode] ?? task.mode}
          </Badge>
          <Text fontSize="xs" color="charcoal.400" lineClamp={1}>
            {task.message ?? `${task.sessionsDone}/${task.sessionsTotal} runs`}
          </Text>
        </Flex>
        <Progress.Root value={pct} size="xs" colorPalette="cyan">
          <Progress.Track borderRadius="full">
            <Progress.Range borderRadius="full" />
          </Progress.Track>
        </Progress.Root>
      </Box>
    </Flex>
  );

  // Deep link to the unit designer with this activity selected, so a click
  // lands the teacher exactly where they can open the run. Standalone
  // activities (no unit) aren't reachable that way — render as a plain row.
  if (!task.unitId) return body;
  return (
    <Link
      href={curriculumUnitHref(task.unitId, { activityId: task.activityId })}
      style={{ textDecoration: "none" }}
    >
      {body}
    </Link>
  );
}
