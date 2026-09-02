"use client";

import { Suspense } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Box, Button, Flex, Spinner } from "@chakra-ui/react";
import { ArrowLeft } from "@phosphor-icons/react";
import { ClassDigestView } from "@/components/ClassDigestView";
import type { Id } from "@/convex/_generated/dataModel";

/**
 * `/teacher/digest?assignment=<id>&activity=<id>` (activity scope) or
 * `/teacher/digest?assignment=<id>&scope=cohort` (cohort "today's read").
 *
 * The "room to breathe" full view of a class digest — one route, both
 * scopes (query-driven to avoid dynamic-segment collisions between an
 * activityId and a literal "cohort"). useSearchParams must sit under a
 * Suspense boundary: this is a static route (no dynamic segment), so Next
 * prerenders it and would otherwise fail the build.
 */
function ClassDigestPageBody() {
  const sp = useSearchParams();
  const assignment = sp.get("assignment") as Id<"assignments"> | null;
  const activity = sp.get("activity") as Id<"activities"> | null;
  const scope = sp.get("scope") === "cohort" ? "cohort" : "activity";

  const backHref = assignment
    ? `/teacher/schedule/${assignment}`
    : "/teacher/schedule";

  return (
    <Box>
      <Box maxW="860px" mx="auto" px={6} pt={4}>
        <Link href={backHref}>
          <Button size="xs" variant="ghost" color="charcoal.500">
            <ArrowLeft size={12} style={{ marginRight: 4 }} />
            Back to assignment
          </Button>
        </Link>
      </Box>
      {assignment && (scope === "cohort" || activity) ? (
        <ClassDigestView
          scope={scope}
          assignmentId={assignment}
          activityId={activity ?? undefined}
        />
      ) : (
        <Box maxW="860px" mx="auto" px={6} py={10} color="charcoal.400">
          Missing assignment or activity reference.
        </Box>
      )}
    </Box>
  );
}

export default function ClassDigestPage() {
  return (
    <Suspense
      fallback={
        <Flex justify="center" py={20}>
          <Spinner size="lg" color="violet.500" />
        </Flex>
      }
    >
      <ClassDigestPageBody />
    </Suspense>
  );
}
