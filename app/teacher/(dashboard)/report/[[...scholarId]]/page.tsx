"use client";

import { Suspense, useEffect } from "react";
import dynamic from "next/dynamic";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Flex, Spinner } from "@chakra-ui/react";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { isTeacherRole } from "@/convex/lib/roles";
import type { Id } from "@/convex/_generated/dataModel";

/**
 * Teacher Reports route — SCHOLAR-FIRST IA (assessment-and-goals).
 *
 * The reporting surface is organized by scholar:
 *   /teacher/report                      -> roster of every scholar in the period
 *   /teacher/report/<scholarId>          -> that scholar's reporting detail
 *                                           (0+ course narratives, 0-1 Whole Child)
 *   /teacher/report/<scholarId>?n=<id>   -> the course-narrative composer
 *   /teacher/report/<scholarId>?wc=1     -> the Whole Child (meeting-mode) editor
 *
 * `?period=<id>` scopes to a reporting period (defaults to the current one).
 * The shared (dashboard) layout gates non-staff away; this adds the narrower
 * TEACHER gate (every query here is teacherQuery/teacherMutation).
 */
const ScholarReportRoster = dynamic(
  () => import("@/components/narrative/ScholarReportRoster").then((m) => m.ScholarReportRoster),
  { ssr: false },
);
const ScholarReportDetail = dynamic(
  () => import("@/components/narrative/ScholarReportDetail").then((m) => m.ScholarReportDetail),
  { ssr: false },
);
const ScholarWholeChildEditor = dynamic(
  () => import("@/components/narrative/ScholarWholeChildEditor").then((m) => m.ScholarWholeChildEditor),
  { ssr: false },
);
const NarrativeComposer = dynamic(
  () => import("@/components/narrative/NarrativeComposer").then((m) => m.NarrativeComposer),
  { ssr: false },
);

export default function ReportPage() {
  return (
    <Suspense fallback={<Loading />}>
      <ReportPageInner />
    </Suspense>
  );
}

function ReportPageInner() {
  const { user, isLoading } = useCurrentUser();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  useEffect(() => {
    if (isLoading) return;
    if (!user) {
      router.replace("/sign-in");
      return;
    }
    if (!isTeacherRole(user.role)) {
      router.replace("/teacher/chat");
    }
  }, [user, isLoading, router]);

  const rest = pathname.replace(/^\/teacher\/report\/?/, "");
  const scholarId = (rest ? rest.split("/").filter(Boolean)[0] ?? null : null) as Id<"users"> | null;
  const narrativeId = searchParams.get("n") as Id<"courseNarratives"> | null;
  const wc = searchParams.get("wc");
  const periodParam = searchParams.get("period");

  if (isLoading || !user || !isTeacherRole(user.role)) {
    return <Loading />;
  }

  let view: React.ReactNode;
  if (narrativeId) {
    const backHref = scholarId
      ? `/teacher/report/${String(scholarId)}${periodParam ? `?period=${periodParam}` : ""}`
      : "/teacher/report";
    const rosterHref = `/teacher/report${periodParam ? `?period=${periodParam}` : ""}`;
    view = <NarrativeComposer narrativeId={narrativeId} backHref={backHref} rosterHref={rosterHref} />;
  } else if (scholarId && wc) {
    view = <ScholarWholeChildEditor scholarId={scholarId} periodParam={periodParam} />;
  } else if (scholarId) {
    view = <ScholarReportDetail scholarId={scholarId} periodParam={periodParam} />;
  } else {
    view = <ScholarReportRoster />;
  }
  return view;
}

function Loading() {
  return (
    <Flex h="full" align="center" justify="center">
      <Spinner size="lg" color="violet.500" />
    </Flex>
  );
}
