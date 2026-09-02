"use client";

import dynamic from "next/dynamic";
import { useCallback, useState } from "react";
import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { Flex, Box, Spinner } from "@chakra-ui/react";
import { AssignmentsViewToggle, type AssignmentsView } from "@/components/AssignmentsViewToggle";
import { MasterScheduleView } from "@/components/MasterSchedule/MasterScheduleView";
import { HappeningNow } from "@/components/MasterSchedule/HappeningNow";
import { AssignmentsListDetail } from "../_components/AssignmentsListDetail";
import { assignmentIdFromPathname } from "../_components/assignmentsPath";
import { ProgramSchedule } from "@/components/ProgramSchedule";
import { EmptyState } from "@/components/ui/EmptyState";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { isTeacherRole } from "@/convex/lib/roles";

const StartAssignmentDialog = dynamic(
  () => import("@/components/StartAssignmentDialog").then((m) => m.StartAssignmentDialog),
  { ssr: false },
);

// Schedule tab — cohort scheduling, finder-style list-detail. Lives in this
// LAYOUT (not the page) so it persists across selection navigations: opening an
// assignment only changes the `/teacher/schedule/<assignmentId>` path
// segment, never remounting the surface. The catch-all page underneath is a
// stub. The aide is the global header Robot → docked panel (general scope on
// this tab), not a per-tab dock.
//
// Four top-level views via the Now | Day | Week | List toggle:
//   • Week (default) / Day → MasterScheduleView (the term timetable).
//   • Now → HappeningNow (the live cross-section of the schedule).
//   • List → AssignmentsListDetail, the exhaustive assignments + standing-
//     practice inventory with the embedded Run page. This is the accounting
//     surface: every active assignment the teacher owns, whether or not it is
//     placed on the timetable. A deep-linked assignment id also resolves here
//     (it selects that row), so a link to one assignment's Run page lands
//     meaningfully. `?view=list` requests it with no selection; the legacy
//     `?view=now`/`?view=schedule` params still resolve. The path parser lives
//     in `_components/assignmentsPath` — a layout file may only export its
//     default.
export default function ScheduleLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { user, isLoading } = useCurrentUser();
  const programPublisher =
    !!user?.hasProgramPublishingAccess &&
    !isTeacherRole(user.role);
  const programScoped = programPublisher && !!user?.hasCurriculumAccess;

  const selectedFromPath = assignmentIdFromPathname(pathname);
  const viewParam = searchParams.get("view");
  const assignmentsView: AssignmentsView =
    viewParam === "now"
      ? "now"
      : viewParam === "list"
        ? "list"
        : viewParam === "day"
          ? "day"
          : viewParam === "week" || viewParam === "schedule"
            ? "week"
            : selectedFromPath
              ? // A deep-linked assignment lives in the List surface (its Run
                // page is the list-detail's detail pane).
                "list"
              : "week";

  const [globalStartOpen, setGlobalStartOpen] = useState(false);
  const programView: AssignmentsView =
    assignmentsView === "day" || assignmentsView === "list"
      ? assignmentsView
      : "week";

  const setAssignmentsView = useCallback(
    (view: AssignmentsView) => {
      const params = new URLSearchParams(searchParams.toString());
      params.set("view", view);
      router.replace(`/teacher/schedule?${params.toString()}`, { scroll: false });
    },
    [router, searchParams],
  );
  const setProgramView = useCallback(
    (view: AssignmentsView) => {
      if (view === "now") return;
      const params = new URLSearchParams(searchParams.toString());
      params.set("view", view);
      router.replace(`/teacher/schedule?${params.toString()}`, { scroll: false });
    },
    [router, searchParams],
  );

  if (isLoading) {
    return (
      <Flex h="full" align="center" justify="center">
        <Spinner color="violet.500" />
      </Flex>
    );
  }

  if (programPublisher && !user?.hasCurriculumAccess) {
    return (
      <Flex h="full" align="center" justify="center">
        <EmptyState
          size="lg"
          title="Schedule access is incomplete"
          hint="Publishing program work also needs curriculum access. A school administrator can update both permissions from Staff."
        />
      </Flex>
    );
  }

  if (programScoped) {
    const viewToggle = (
      <AssignmentsViewToggle
        view={programView}
        onChange={setProgramView}
        includeNow={false}
      />
    );

    return (
      <Flex h="full" overflow="hidden" position="relative">
        <Flex flex={1} direction="column" overflow="hidden" minW={0}>
          {programView === "list" ? (
            <>
              <Flex
                px={3}
                py={1.5}
                align="center"
                borderBottom="1px solid"
                borderColor="gray.100"
                bg="white"
                flexShrink={0}
              >
                {viewToggle}
              </Flex>
              <Box flex={1} overflow="hidden">
                <ProgramSchedule />
              </Box>
            </>
          ) : (
            <MasterScheduleView
              mode={programView}
              viewToggle={viewToggle}
              programScoped
            />
          )}
        </Flex>
        <Box position="absolute" inset={0} pointerEvents="none">
          {children}
        </Box>
      </Flex>
    );
  }

  return (
    <Flex h="full" overflow="hidden" position="relative">
      <Flex flex={1} direction="column" overflow="hidden" minW={0}>
        {assignmentsView === "day" || assignmentsView === "week" ? (
          <Box flex={1} overflow="hidden">
            <MasterScheduleView
              mode={assignmentsView}
              viewToggle={
                <AssignmentsViewToggle
                  view={assignmentsView}
                  onChange={setAssignmentsView}
                />
              }
            />
          </Box>
        ) : (
          <>
            <Flex
              px={3}
              py={1.5}
              align="center"
              borderBottom="1px solid"
              borderColor="gray.100"
              bg="white"
              flexShrink={0}
            >
              <AssignmentsViewToggle
                view={assignmentsView}
                onChange={setAssignmentsView}
              />
              <Box flex={1} />
            </Flex>
            {assignmentsView === "list" ? (
              // List = the exhaustive finder-style list-detail (every active
              // assignment + standing practice), with the Run/Debrief detail
              // pane. Mounts with no selection unless an assignment id is in the
              // path (deep link / chip → Run page).
              <AssignmentsListDetail
                onStartAssignment={() => setGlobalStartOpen(true)}
              />
            ) : (
              // Now = the live "happening now" cross-section (the schedule's now
              // projection), not a flat list of assignments.
              <Box flex={1} overflow="hidden">
                <HappeningNow />
              </Box>
            )}
          </>
        )}
      </Flex>

      {/* Global Start dialog — kind chooser (Class vs. Quest). */}
      <StartAssignmentDialog
        open={globalStartOpen}
        onClose={() => setGlobalStartOpen(false)}
      />

      {/* Route-transition loading fallback overlays the surface instead of
          stacking below it (no double-skeleton on a client nav into the tab);
          pointerEvents:none passes clicks through. */}
      <Box position="absolute" inset={0} pointerEvents="none">
        {children}
      </Box>
    </Flex>
  );
}
