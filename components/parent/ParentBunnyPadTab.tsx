"use client";

/**
 * The parent portal's BunnyPad tab: the child's nightly bedtime and the
 * freeze controls, the two things a family can set on the school iPad.
 * Freeze is an everyday control, so it comes first. Moved out of Records on
 * Andy's call (parent portal decision board, 2026-11-18).
 */
import { useQuery } from "convex/react";
import { Heading, HStack, Spinner, VStack } from "@chakra-ui/react";

import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { EmptyState } from "@/components/ui/EmptyState";
import { ParentBedtimeCard } from "./ParentBedtimeCard";
import { ParentFreezeCard } from "./ParentFreezeCard";

export function ParentBunnyPadTab({
  scholarId,
  childName,
}: {
  scholarId: Id<"users">;
  childName: string;
}) {
  const bedtime = useQuery(api.scholarBedtimes.forParent, { scholarId });
  // The freeze card reads the same query; Convex shares the subscription.
  const freeze = useQuery(api.scheduledFreezes.forParentCard, { scholarId });
  const name = childName || "Your child";

  if (bedtime === undefined || freeze === undefined) {
    return (
      <HStack py={6} justify="center">
        <Spinner size="sm" color="violet.400" />
      </HStack>
    );
  }

  return (
    <VStack align="stretch" gap={4}>
      <Heading as="h1" size="lg" fontFamily="heading" color="navy.500">
        BunnyPad
      </Heading>
      {freeze === null && bedtime === null ? (
        <EmptyState
          title={`${name} doesn't have a BunnyPad yet`}
          hint="Once the school pairs one, you can freeze it and set its bedtime here."
        />
      ) : (
        <>
          <ParentFreezeCard
            key={`freeze-${scholarId}`}
            scholarId={scholarId}
            childName={childName}
          />
          {bedtime && (
            <ParentBedtimeCard
              key={`bedtime-${scholarId}`}
              scholarId={scholarId}
              childName={childName}
              status={bedtime}
            />
          )}
        </>
      )}
    </VStack>
  );
}
