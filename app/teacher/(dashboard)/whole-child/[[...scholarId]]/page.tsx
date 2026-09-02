"use client";

/**
 * Whole Child meeting mode + advisor composer
 * (review/assessment-and-goals-plan.html §8) — the team pools
 * category-tagged observations all period long, then meets and works this surface
 * scholar-by-scholar to reach a written consensus. No `scholarId` segment shows the
 * roster for the current reporting period; `/teacher/whole-child/<scholarId>`
 * opens meeting mode for that scholar (real <Link> nav — no client-side
 * router.push tab-switching).
 *
 * Deliberately gated tighter than the surrounding `(dashboard)` layout: that
 * layout admits any staff role (including operations staff / curriculum_designer),
 * but Whole Child holds sensitive team assessment — only teaching staff
 * (`isTeacherRole`) should reach it.
 */
import { useEffect } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { useQuery } from "convex/react";
import { Flex, Spinner, Text } from "@chakra-ui/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useActiveInstitution } from "@/hooks/useActiveInstitution";
import { isTeacherRole } from "@/convex/lib/roles";
import { useScholarRoster } from "@/hooks/useScholarRoster";
import { withInstitutionScope } from "@/lib/institutionLinks";
import { WholeChildRoster, sortRosterScholars } from "@/components/wholeChild/WholeChildRoster";
import { MeetingMode } from "@/components/wholeChild/MeetingMode";

function CenteredMessage({ children }: { children: React.ReactNode }) {
  return (
    <Flex h="full" align="center" justify="center" bg="gray.50">
      <Text color="charcoal.400" fontFamily="heading" fontSize="sm">
        {children}
      </Text>
    </Flex>
  );
}

function CenteredSpinner() {
  return (
    <Flex h="full" align="center" justify="center" bg="gray.50">
      <Spinner size="lg" color="violet.500" />
    </Flex>
  );
}

export default function WholeChildPage() {
  const { user, isLoading: isUserLoading } = useCurrentUser();
  const params = useParams();
  const router = useRouter();
  const searchParams = useSearchParams();
  const mode = searchParams.get("mode") === "rounds" ? "rounds" : "report";
  const scholarIdSegments = params?.scholarId as string[] | undefined;
  const scholarId =
    scholarIdSegments && scholarIdSegments.length > 0 ? (scholarIdSegments[0] as Id<"users">) : null;

  const isAllowed = !!user && isTeacherRole(user.role);
  const { activeInstitution, scopeParam } = useActiveInstitution(isAllowed);

  const period = useQuery(
    api.reportingPeriods.current,
    isAllowed && activeInstitution !== undefined
      ? { scope: scopeParam || undefined }
      : "skip",
  );
  const { scholars, isLoading: isRosterLoading } = useScholarRoster();

  useEffect(() => {
    if (mode !== "rounds") return;
    const requestedScope = searchParams.get("inst");
    router.replace(
      `/teacher/scholars${scholarId ? `/${scholarId}` : ""}?rounds=1${requestedScope ? `&inst=${encodeURIComponent(requestedScope)}` : ""}`,
    );
  }, [mode, router, searchParams, scholarId]);

  if (mode === "rounds") return <CenteredSpinner />;

  if (isUserLoading) return <CenteredSpinner />;
  if (!isAllowed) return <CenteredMessage>Teaching staff only.</CenteredMessage>;
  if (activeInstitution === undefined) return <CenteredSpinner />;
  if (period === undefined || isRosterLoading) return <CenteredSpinner />;
  if (period === null) {
    return (
      <CenteredMessage>
        No open reporting period yet — set one up from the Reports tab to run Whole Child meetings.
      </CenteredMessage>
    );
  }

  const sorted = sortRosterScholars(scholars);
  if (!scholarId && mode === "report") {
    return <WholeChildRoster periodId={period._id} periodLabel={period.label} />;
  }

  const selectedScholarId = scholarId;
  if (!selectedScholarId) {
    return <CenteredMessage>No scholars are available for Rounds.</CenteredMessage>;
  }
  const index = sorted.findIndex((s) => s.id === selectedScholarId);
  if (index === -1) {
    return <CenteredMessage>No scholar found with that id.</CenteredMessage>;
  }
  const scholar = sorted[index];
  const prev = sorted[index - 1];
  const next = sorted[index + 1];
  const scholarHref = (id: string) =>
    withInstitutionScope(
      `/teacher/whole-child/${id}`,
      scopeParam,
    );

  return (
    <MeetingMode
      scholarId={selectedScholarId}
      scholarName={scholar.name}
      periodId={period._id}
      periodLabel={period.label}
      backHref={withInstitutionScope("/teacher/whole-child", scopeParam)}
      prevHref={prev ? scholarHref(prev.id) : null}
      nextHref={next ? scholarHref(next.id) : null}
      positionLabel={`${index + 1} of ${sorted.length}`}
      institutionScope={scopeParam || undefined}
    />
  );
}
