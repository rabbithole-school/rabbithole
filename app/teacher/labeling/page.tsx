"use client";

/**
 * /teacher/labeling — the golden-set labeling tool. A staff-only surface where
 * raters blind-score real tutor turns on the judge's rubric to calibrate the
 * Opus quality-judge (review/continuous-eval-plan.html §7). Three internal
 * views: Queue → Label (the core) → Agreement.
 *
 * This route sits OUTSIDE the teacher (dashboard) route group, so it doesn't
 * inherit that layout's staff gate — it runs its own here. Access matches the
 * backend (teacherQuery/teacherMutation = requireTeacher): teachers + admins
 * pass; everyone else is redirected. WEB-ONLY (staff tool; the native app is
 * scholar-facing).
 */
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Box, Flex, HStack, Spinner, Text } from "@chakra-ui/react";
import { ArrowLeft } from "@phosphor-icons/react";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { isTeacherRole, ROLES } from "@/convex/lib/roles";
import { isClientStaffRole } from "@/hooks/useSchoolOperationsAccess";
import type { Id } from "@/convex/_generated/dataModel";
import { SubNav } from "@/components/ui/SubNav";
import { LabelingQueue } from "@/components/labeling/LabelingQueue";
import { TranscriptLabeler } from "@/components/labeling/TranscriptLabeler";
import { AgreementView } from "@/components/labeling/AgreementView";
import { VIEWPORT_SHELL_HEIGHT } from "@/lib/viewportShell";

type View = "queue" | "label" | "agreement";

function LoadingScreen() {
  return (
    <Flex minH="100dvh" bg="gray.50" align="center" justify="center">
      <Spinner size="xl" color="violet.500" />
    </Flex>
  );
}

export default function LabelingPage() {
  const { user, isLoading } = useCurrentUser();
  const router = useRouter();

  const [view, setView] = useState<View>("queue");
  const [selectedSession, setSelectedSession] = useState<Id<"sessions"> | null>(null);
  const [scrollTarget, setScrollTarget] = useState<string | undefined>(undefined);

  // Staff gate: non-staff → their home; staff-but-not-teacher (operations staff /
  // curriculum_designer) → the teacher dashboard (they can't use these
  // teacher-gated functions).
  useEffect(() => {
    if (isLoading) return;
    if (!user) {
      router.replace("/sign-in");
      return;
    }
    if (!isTeacherRole(user.role)) {
      if (user.role === ROLES.PARENT) router.replace("/parent");
      else if (isClientStaffRole(user.role)) router.replace("/teacher");
      else router.replace("/scholar");
    }
  }, [user, isLoading, router]);

  if (isLoading || !user || !isTeacherRole(user.role)) {
    return <LoadingScreen />;
  }

  const openSession = (sessionId: Id<"sessions">) => {
    setSelectedSession(sessionId);
    setScrollTarget(undefined);
    setView("label");
  };

  const navItems = [
    { value: "queue" as const, label: "Queue" },
    ...(selectedSession ? [{ value: "label" as const, label: "Label" }] : []),
    { value: "agreement" as const, label: "Agreement" },
  ];

  return (
    <Flex h={VIEWPORT_SHELL_HEIGHT} direction="column" bg="gray.50">
      {/* Slim top bar (this route is outside the dashboard nav). */}
      <Box bg="white" borderBottomWidth="1px" borderColor="gray.200" flexShrink={0}>
        <Flex maxW="900px" mx="auto" px={{ base: 4, md: 6 }} h="52px" align="center" justify="space-between">
          <HStack gap={3}>
            <Link href="/teacher">
              <HStack gap={1} color="charcoal.400" _hover={{ color: "charcoal.600" }}>
                <ArrowLeft size={14} />
                <Text fontSize="xs" fontFamily="heading" fontWeight="600">
                  Teacher
                </Text>
              </HStack>
            </Link>
            <Text fontSize="sm" fontFamily="heading" fontWeight="700" color="navy.500">
              Golden-set labeling
            </Text>
          </HStack>
        </Flex>
      </Box>

      {/* Everything below the top bar owns the scroll (body is overflow-locked). */}
      <Box flex={1} minH={0} overflowY="auto">
        <Box maxW="900px" mx="auto" px={{ base: 4, md: 6 }} pt={4}>
          <SubNav
            items={navItems}
            value={view}
            onChange={(v) => setView(v as View)}
            mb={0}
          />
        </Box>

        {view === "queue" && <LabelingQueue onSelect={openSession} />}

        {view === "label" && selectedSession && (
          <TranscriptLabeler
            key={String(selectedSession)}
            sessionId={selectedSession}
            scrollToMessageId={scrollTarget}
            onBack={() => setView("queue")}
          />
        )}

        {view === "agreement" && (
          <AgreementView
            onNavigateToTurn={(sessionId, messageId) => {
              setSelectedSession(sessionId);
              setScrollTarget(messageId);
              setView("label");
            }}
          />
        )}
      </Box>
    </Flex>
  );
}
