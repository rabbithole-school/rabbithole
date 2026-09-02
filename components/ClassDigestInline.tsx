"use client";

/**
 * ClassDigestInline — the glanceable digest line that lives in context
 * (folded into the assignment header for the cohort "today's read", or in
 * an expanded activity row). One component, both scopes.
 *
 * Deliberately NOT a card: no fill, no border, no chips — just the
 * headline as a sentence plus a quiet link to the full view. Identity
 * comes from a smallcaps eyebrow + typography, not a tinted banner.
 */

import Link from "next/link";
import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { Button, Flex, HStack, Spinner, Text } from "@chakra-ui/react";
import { ArrowRight } from "@phosphor-icons/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { SectionEyebrow } from "@/components/ui/SectionEyebrow";
import { useActiveInstitution } from "@/hooks/useActiveInstitution";

export function ClassDigestInline({
  scope,
  assignmentId,
  activityId,
}: {
  scope: "activity" | "cohort";
  assignmentId: Id<"assignments">;
  activityId?: Id<"activities">;
}) {
  const { scopeParam } = useActiveInstitution();
  const activityRes = useQuery(
    api.classDigests.getActivityDigest,
    scope === "activity" && activityId
      ? { assignmentId, activityId, scope: scopeParam }
      : "skip",
  );
  const cohortRes = useQuery(
    api.classDigests.getCohortDigest,
    scope === "cohort" ? { assignmentId, scope: scopeParam } : "skip",
  );
  const res = scope === "activity" ? activityRes : cohortRes;

  const requestActivity = useMutation(api.classDigests.requestActivityDigest);
  const requestCohort = useMutation(api.classDigests.requestCohortDigest);
  const [busy, setBusy] = useState(false);
  const generate = async () => {
    setBusy(true);
    try {
      if (scope === "activity" && activityId) {
        await requestActivity({ assignmentId, activityId });
      } else {
        await requestCohort({ assignmentId });
      }
    } finally {
      setBusy(false);
    }
  };

  const href =
    scope === "cohort"
      ? `/teacher/digest?assignment=${assignmentId}&scope=cohort`
      : `/teacher/digest?assignment=${assignmentId}&activity=${activityId}`;

  if (res === undefined || res === null) return null;
  const digest = res.digest;

  // Nothing yet — a quiet manual kick (it also auto-generates).
  if (!digest) {
    return (
      <Button
        size="xs"
        variant="ghost"
        color="violet.500"
        px={0}
        fontFamily="heading"
        onClick={generate}
        loading={busy}
      >
        {scope === "cohort" ? "Generate today's read" : "Generate digest"}
      </Button>
    );
  }

  if (digest.status === "pending" || busy) {
    return (
      <HStack gap={2} color="charcoal.400">
        <Spinner size="xs" />
        <Text fontSize="xs" fontFamily="heading">
          Writing the digest…
        </Text>
      </HStack>
    );
  }

  if (digest.status === "error") {
    return (
      <HStack gap={2} color="charcoal.400">
        <Text fontSize="xs">Digest unavailable.</Text>
        <Button size="2xs" variant="ghost" color="violet.500" px={0} onClick={generate} loading={busy}>
          Retry
        </Button>
      </HStack>
    );
  }

  const viewLink = (
    <HStack gap={1} color="violet.500" flexShrink={0}>
      <Text fontSize="xs" fontFamily="heading" fontWeight="600">
        {scope === "cohort" ? "Open digest" : "View digest"}
      </Text>
      <ArrowRight size={12} />
    </HStack>
  );

  if (scope === "cohort") {
    return (
      <Link href={href} style={{ textDecoration: "none", display: "block" }}>
        <Flex justify="space-between" align="flex-end" gap={4}>
          <div>
            <SectionEyebrow>Today&apos;s read</SectionEyebrow>
            <Text fontSize="sm" color="navy.600" lineHeight="1.45" mt={0.5}>
              {digest.headline}
              {digest.stale && (
                <Text as="span" color="charcoal.300" fontWeight="400">
                  {" "}
                  · {digest.newSince} new since
                </Text>
              )}
            </Text>
          </div>
          {viewLink}
        </Flex>
      </Link>
    );
  }

  // activity scope — a single quiet line inside the expanded row
  return (
    <Link href={href} style={{ textDecoration: "none", display: "block" }}>
      <Flex justify="space-between" align="center" gap={4}>
        <Text fontSize="sm" color="navy.600" lineHeight="1.4" minW={0}>
          {digest.headline}
        </Text>
        {viewLink}
      </Flex>
    </Link>
  );
}
