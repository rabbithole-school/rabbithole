"use client";

/**
 * Whole Child editor within the scholar-first Reports IA (?wc=1).
 *
 * Thin wrapper resolving the scholar + reporting period, then handing off to
 * the shared meeting-mode editor with a back link to the scholar's reporting
 * detail. The Whole Child narrative is created lazily by MeetingMode itself.
 */
import { useQuery } from "convex/react";
import { Flex, Spinner, Text } from "@chakra-ui/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { useScholarRoster } from "@/hooks/useScholarRoster";
import { MeetingMode } from "@/components/wholeChild/MeetingMode";
import { useSetAideScope } from "@/components/aide/AideDockProvider";

export function ScholarWholeChildEditor({
  scholarId,
  periodParam,
}: {
  scholarId: Id<"users">;
  periodParam: string | null;
}) {
  // Publish scholar scope so the header Robot → dock is about THIS scholar here
  // too (this ?wc=1 view renders MeetingMode directly, not through ReportShell,
  // so it must publish its own scope — otherwise the dock stays global). FIX 4.
  useSetAideScope({ kind: "scholar", scholarId });
  const current = useQuery(api.reportingPeriods.current, {});
  const periods = useQuery(api.reportingPeriods.list, {});
  const { scholars, isLoading: rosterLoading } = useScholarRoster();

  const activePeriod = periods
    ? (periodParam && periods.find((p) => String(p._id) === periodParam)) || current || periods[0] || null
    : (current ?? undefined);
  const scholar = scholars.find((s) => s.id === String(scholarId));

  const backHref = `/teacher/report/${String(scholarId)}${activePeriod ? `?period=${String(activePeriod._id)}` : ""}`;

  if (periods === undefined || current === undefined || rosterLoading) {
    return (
      <Flex h="full" align="center" justify="center" bg="gray.50">
        <Spinner size="lg" color="violet.500" />
      </Flex>
    );
  }
  if (!activePeriod) {
    return (
      <Flex h="full" align="center" justify="center" bg="gray.50">
        <Text color="charcoal.400" fontFamily="heading" fontSize="sm">
          No reporting period set up yet.
        </Text>
      </Flex>
    );
  }
  if (!scholar) {
    return (
      <Flex h="full" align="center" justify="center" bg="gray.50">
        <Text color="charcoal.400" fontFamily="heading" fontSize="sm">
          No scholar found with that id.
        </Text>
      </Flex>
    );
  }

  return (
    <MeetingMode
      scholarId={scholarId}
      scholarName={scholar.name}
      periodId={activePeriod._id}
      periodLabel={activePeriod.label}
      backHref={backHref}
      breadcrumb={[
        { label: "All scholars", href: `/teacher/report?period=${String(activePeriod._id)}` },
        { label: scholar.name, href: backHref },
        { label: "Whole Child" },
      ]}
    />
  );
}
