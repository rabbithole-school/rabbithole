"use client";

import type { Id } from "@/convex/_generated/dataModel";
import { Box, Button, Heading, HStack, Stack, Text, VStack } from "@chakra-ui/react";
import { Heart, ArrowRight } from "@phosphor-icons/react";
import Link from "next/link";
import { FormCompletionBadge } from "./FormCompletionBadge";
import { getHealthFormBannerState } from "./healthFormState";
import { ParentFormCardShell } from "./ParentFormCardShell";

export type ParentHealthRecordStatus = {
  completed: boolean;
  submittedAt: number | null;
  hasDraft: boolean;
  unsentChanges?: boolean;
};

/**
 * Onboarding task banner for completing a child's health & emergency info.
 * Absent once a signed canonical record exists — with one exception: answers
 * saved but never signed for leave the school reading the older record, and a
 * guardian who left the form without signing has nowhere else to find that out.
 */
export function HealthFormOnboardingBanner({
  scholarId,
  scholarName,
  status,
}: {
  scholarId: Id<"users">;
  scholarName: string;
  status: ParentHealthRecordStatus;
}) {
  const card = getHealthFormBannerState(status, scholarName);
  if (!card.showOnProgress) return null;

  return (
    <Box
      mb={6}
      px={5}
      py={4}
      bg={card.unsentChanges ? "amber.50" : "green.50"}
      borderWidth="1px"
      borderColor={card.unsentChanges ? "amber.200" : "green.100"}
      borderRadius="xl"
      role="status"
    >
      <HStack gap={3} align="start">
        <Box
          flexShrink={0}
          display="inline-flex"
          p={2}
          bg={card.unsentChanges ? "amber.100" : "green.100"}
          borderRadius="lg"
          color={card.unsentChanges ? "amber.700" : "green.700"}
        >
          <Heart size={24} weight="duotone" />
        </Box>
        <VStack gap={2} flex={1} align="stretch">
          <Text
            fontSize="md"
            fontWeight="600"
            fontFamily="heading"
            color="charcoal.700"
          >
            {card.title}
          </Text>
          <Text fontSize="sm" fontFamily="body" color="charcoal.500">
            {card.unsentChanges
              ? "Your changes are saved but not signed, so the school still sees your last signed form. Documents you uploaded are already on file."
              : "Required before the first day. Takes about 5 minutes. You can save your progress and finish later."}
          </Text>
          <HStack gap={2} mt={1}>
            <Button
              asChild
              size="sm"
              variant={card.actionLabel === "Review & update" ? "ghost" : "solid"}
              colorPalette="violet"
              fontFamily="body"
            >
              <Link href={`/parent/health-form?scholarId=${scholarId}`}>
                {card.actionLabel}
                <ArrowRight size={16} weight="bold" />
              </Link>
            </Button>
          </HStack>
        </VStack>
      </HStack>
    </Box>
  );
}

export function ParentHealthRecordCard({
  scholarId,
  status,
}: {
  scholarId: Id<"users">;
  status: ParentHealthRecordStatus;
}) {
  const card = getHealthFormBannerState(status, "");

  return (
    <ParentFormCardShell labelledBy="health-record-heading">
      <Stack
        direction={{ base: "column", md: "row" }}
        align={{ base: "stretch", md: "center" }}
        justify="space-between"
        gap={4}
      >
        <HStack align="start" gap={3}>
          <Box
            flexShrink={0}
            display="inline-flex"
            position="relative"
            p={2}
            bg={card.showInRecords ? "green.50" : "gray.100"}
            borderRadius="lg"
            color={card.showInRecords ? "green.700" : "charcoal.400"}
          >
            <Heart size={24} weight="duotone" />
            {card.showInRecords && <FormCompletionBadge />}
          </Box>
          <VStack gap={1} align="stretch">
            <Heading
              id="health-record-heading"
              size="sm"
              fontFamily="heading"
              color="navy.500"
            >
              {card.showInRecords
                ? "Health & emergency information"
                : "No health & emergency form on file"}
            </Heading>
            <Text fontSize="sm" fontFamily="body" color="charcoal.500">
              {card.showInRecords ? (
                <>
                  Submitted{" "}
                  {card.submittedAt
                    ? new Date(card.submittedAt).toLocaleDateString()
                    : "recently"}
                  .{" "}
                  {card.unsentChanges
                    ? "You have saved changes that still need your signature."
                    : "Uploading a document updates it right away; changing an answer needs a new electronic signature."}
                </>
              ) : (
                "Complete the form so the school has current emergency information."
              )}
            </Text>
          </VStack>
        </HStack>
        <Button
          asChild
          size="sm"
          variant={card.actionLabel === "Review & update" ? "ghost" : "solid"}
          colorPalette="violet"
          fontFamily="body"
          alignSelf={{ base: "stretch", md: "center" }}
        >
          <Link href={`/parent/health-form?scholarId=${scholarId}`}>
            {card.actionLabel}
            <ArrowRight size={16} weight="bold" />
          </Link>
        </Button>
      </Stack>
    </ParentFormCardShell>
  );
}
