"use client";

import { Suspense } from "react";
import Link from "next/link";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { useQuery } from "convex/react";
import { Flex, Spinner, Text } from "@chakra-ui/react";
import { api } from "@/convex/_generated/api";
import { Id } from "@/convex/_generated/dataModel";
import { ProgressPageShell } from "@/components/ProgressPageShell";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { isTeacherRole } from "@/convex/lib/roles";

export default function ProgressPage() {
  return (
    <Suspense
      fallback={
        <Flex minH="100vh" bg="white" align="center" justify="center">
          <Spinner size="xl" color="violet.500" />
        </Flex>
      }
    >
      <ProgressInner />
    </Suspense>
  );
}

function ProgressInner() {
  const params = useParams<{ sessionId: string }>();
  const router = useRouter();
  const searchParams = useSearchParams();
  const sessionId = params.sessionId as Id<"sessions">;
  const { user, isLoading: isUserLoading } = useCurrentUser();
  const session = useQuery(api.sessions.get, { id: sessionId });
  // Teacher remote mode — pass through to the shell so the home
  // button routes to /teacher, the dual-avatar AccountMenu chip
  // shows up, and isMyIsUnit keys off the remote scholar (not the
  // viewing teacher). Mirror the wiring in /scholar/unit/[unitId].
  const remoteParam = searchParams.get("remote");
  const remoteUserId =
    remoteParam &&
    user &&
    isTeacherRole(user.role)
      ? (remoteParam as Id<"users">)
      : null;

  if (isUserLoading || session === undefined) {
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
  if (session === null) {
    return (
      <Flex
        minH="100vh"
        bg="white"
        align="center"
        justify="center"
        flexDir="column"
        gap={4}
      >
        <Text fontSize="lg" fontFamily="heading" color="charcoal.500">
          Session not found.
        </Text>
        <Link href="/scholar" style={{ textDecoration: "none" }}>
          <Text
            fontSize="sm"
            color="violet.500"
            fontFamily="heading"
            fontWeight="600"
          >
            ← Back to my sessions
          </Text>
        </Link>
      </Flex>
    );
  }

  return (
    <ProgressPageShell sessionId={sessionId} remoteUserId={remoteUserId} />
  );
}
