"use client";

import { Suspense, useState } from "react";
import Link from "next/link";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { useMutation, useQuery } from "convex/react";
import {
  Box,
  Button,
  Flex,
  Heading,
  Spinner,
  Stack,
  Text,
} from "@chakra-ui/react";
import { api } from "@/convex/_generated/api";
import { Id } from "@/convex/_generated/dataModel";
import { ProgressPageShell } from "@/components/ProgressPageShell";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { isTeacherRole } from "@/convex/lib/roles";
import { toaster } from "@/lib/toaster";
import { useLearnerContext } from "@/hooks/useLearnerContext";

/**
 * `/scholar/unit/[unitId]` — the canonical, unit-scoped URL for the
 * Big Picture surface. Resolves the scholar's most-recent project
 * anchored to this unit (any lesson, any activity) and hands off to
 * `ProgressPageShell`. The shell renders the same body the drawer
 * uses, so unit + lesson framing + activities all show up exactly as
 * the scholar saw them inside their project.
 *
 * Special case: an IS Unit the calling scholar authored that has no
 * activities yet renders a "Plan with AI" hero instead of the
 * "you haven't started this yet" dead-end. The planning conversation
 * lives at the unit level (not an activity); clicking the CTA
 * creates a unit-anchored project where the AI tutor populates the
 * unit by calling create_lesson / create_activity.
 *
 * Remote mode (`?remote=<scholarId>`): a teacher inspects this unit
 * as the named scholar. All reads route through that scholar's
 * userId; the "Plan with AI" button is suppressed (a teacher should
 * not author the scholar's IS project); the "Edit unit" affordance
 * still respects whether the *remote scholar* (not the teacher)
 * authored the IS unit.
 */
export default function UnitProgressPage() {
  return (
    <Suspense
      fallback={
        <Flex minH="100vh" bg="white" align="center" justify="center">
          <Spinner size="xl" color="violet.500" />
        </Flex>
      }
    >
      <UnitInner />
    </Suspense>
  );
}

function UnitInner() {
  const params = useParams();
  const router = useRouter();
  const searchParams = useSearchParams();
  const unitId = params.unitId as Id<"units">;
  const { user, isLoading: isUserLoading } = useCurrentUser();
  const { hasLearnerContext } = useLearnerContext(!!user);

  const remoteParam = searchParams.get("remote");
  const isRemoteMode = !!(
    remoteParam &&
    user &&
    isTeacherRole(user.role)
  );
  const remoteUserId = isRemoteMode
    ? (remoteParam as Id<"users">)
    : null;

  // The user identity used for scholar-scoped reads on this page —
  // the remote scholar when a teacher's viewing-as, otherwise the
  // caller themselves.
  const viewedUserId = remoteUserId ?? (user?._id ?? null);

  const resolved = useQuery(
    api.sessions.sessionForUnit,
    user
      ? remoteUserId
        ? { unitId, userId: remoteUserId }
        : {
            unitId,
            asLearner: user.role === "scholar" || hasLearnerContext,
          }
      : "skip",
  );
  const unit = useQuery(api.units.get, { id: unitId });

  if (isUserLoading || resolved === undefined || unit === undefined) {
    return (
      <Flex minH="100vh" bg="white" align="center" justify="center">
        <Spinner size="xl" color="violet.500" />
      </Flex>
    );
  }
  if (!user) {
    if (typeof window !== "undefined") {
      router.replace("/login");
    }
    return null;
  }
  if (!resolved.sessionId) {
    // "Is this my (i.e. the viewed scholar's) IS unit?" — in remote
    // mode, "my" means the remote scholar, not the teacher.
    const isViewedScholarsIsUnit =
      !!unit?.authorScholarId &&
      !!viewedUserId &&
      unit.authorScholarId === viewedUserId;
    if (isViewedScholarsIsUnit) {
      return (
        <IsPlanningEmptyState
          unitId={unitId}
          unitTitle={unit.title}
          unitEmoji={unit.emoji ?? null}
          isRemoteMode={isRemoteMode}
        />
      );
    }
    return (
      <Flex minH="100vh" bg="white" align="center" justify="center">
        <Stack gap={3} align="center">
          <Text fontSize="lg" fontFamily="heading" color="charcoal.500">
            {isRemoteMode
              ? "This scholar hasn't started this unit yet."
              : "You haven't started this unit yet."}
          </Text>
          <Link
            href={isRemoteMode ? "/teacher/curriculum" : "/scholar"}
            style={{ textDecoration: "none" }}
          >
            <Text
              fontSize="sm"
              color="violet.500"
              fontFamily="heading"
              fontWeight="600"
            >
              {isRemoteMode ? "← Back to curriculum" : "← Back to my sessions"}
            </Text>
          </Link>
        </Stack>
      </Flex>
    );
  }
  return (
    <ProgressPageShell
      sessionId={resolved.sessionId}
      remoteUserId={remoteUserId}
    />
  );
}

/**
 * Empty-state hero shown when the calling scholar opens their own
 * IS Unit that has no activities yet. The "Plan with AI" CTA
 * creates a unit-anchored project — no activityId, no fake "kickoff"
 * activity in the way — and routes there. The AI tutor uses the IS
 * planning tools to populate the unit live during that conversation.
 *
 * In remote mode the planning CTA is suppressed: a teacher should
 * not create the scholar's IS project on their behalf (it would be
 * owned by the teacher and observed under their identity). The hero
 * still explains the unit's state.
 */
export function IsPlanningEmptyState({
  unitId,
  unitTitle,
  unitEmoji,
  isRemoteMode,
}: {
  unitId: Id<"units">;
  unitTitle: string;
  unitEmoji: string | null;
  isRemoteMode: boolean;
}) {
  const router = useRouter();
  const createSession = useMutation(api.sessions.create);
  const [starting, setStarting] = useState(false);

  const handleStart = async () => {
    setStarting(true);
    try {
      const result = await createSession({ unitId });
      if (result) router.push(`/scholar/${result.id}`);
    } catch (error) {
      console.error("Independent study planning launch failed:", error);
      toaster.error({
        title: "Couldn't start that activity",
        description: "Please try again.",
      });
    } finally {
      setStarting(false);
    }
  };

  return (
    <Flex minH="100vh" bg="white" align="center" justify="center" px={6}>
      <Stack
        gap={5}
        align="center"
        maxW="520px"
        textAlign="center"
        p={8}
        bg="violet.50"
        borderRadius="2xl"
        borderWidth="1px"
        borderColor="violet.200"
      >
        <Box fontSize="5xl" lineHeight="1">
          {unitEmoji ?? "⚡"}
        </Box>
        <Stack gap={2} align="center">
          <Heading
            as="h1"
            fontFamily="heading"
            fontWeight="700"
            color="navy.500"
            fontSize="2xl"
            lineHeight="1.2"
          >
            {unitTitle}
          </Heading>
          <Text fontSize="sm" color="charcoal.500" maxW="400px">
            {isRemoteMode
              ? "This scholar hasn't started planning this IS unit yet. They'll see a \"Plan with AI\" button when they open it."
              : "This unit doesn't have any activities yet. Chat with the AI to plan it together — describe what you want to learn, and the AI will help you build it out."}
          </Text>
        </Stack>
        {!isRemoteMode && (
          <Button
            size="lg"
            bg="violet.500"
            color="white"
            _hover={{ bg: "violet.600" }}
            fontFamily="heading"
            fontWeight="700"
            onClick={handleStart}
            loading={starting}
          >
            ✨ Plan this with the AI
          </Button>
        )}
        <Link
          href={isRemoteMode ? "/teacher/curriculum" : "/scholar"}
          style={{ textDecoration: "none" }}
        >
          <Text fontSize="xs" color="charcoal.400" fontFamily="heading">
            {isRemoteMode ? "← Back to curriculum" : "← Back to my sessions"}
          </Text>
        </Link>
      </Stack>
    </Flex>
  );
}
