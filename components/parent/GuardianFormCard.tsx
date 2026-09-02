"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import { ArrowRight } from "@phosphor-icons/react";
import { Box, Button, Heading, HStack, Stack, Text } from "@chakra-ui/react";

import type { Id } from "@/convex/_generated/dataModel";
import { FormCompletionBadge } from "./FormCompletionBadge";
import { ParentFormCardShell } from "./ParentFormCardShell";

export type GuardianFormStatus = {
  status: "completed" | "in_progress" | "not_started";
  submittedAt: number | null;
  unsentChanges: boolean;
};

export function GuardianFormCard({
  scholarId,
  path,
  title,
  status,
  icon,
}: {
  scholarId: Id<"users">;
  path: string;
  title: string;
  status: GuardianFormStatus;
  icon: ReactNode;
}) {
  const complete = status.status === "completed";
  const actionLabel =
    status.unsentChanges || status.status === "in_progress"
      ? "Continue"
      : complete
        ? "Review & update"
        : "Start form";

  return (
    <ParentFormCardShell>
      <Stack
        direction={{ base: "column", md: "row" }}
        align={{ base: "stretch", md: "center" }}
        justify="space-between"
        gap={4}
      >
        <HStack gap={3} align="start">
          <Box
            flexShrink={0}
            position="relative"
            p={2}
            borderRadius="lg"
            bg={complete ? "green.50" : "bg.subtle"}
            color={complete ? "green.700" : "fg.muted"}
            aria-hidden="true"
          >
            {icon}
            {complete && <FormCompletionBadge />}
          </Box>
          <Box>
            <Heading size="sm" color="navy.500">
              {title}
            </Heading>
            <Text fontSize="sm" color="fg.muted" mt={1}>
              {status.unsentChanges
                ? "Saved changes still need your electronic signature."
                : complete
                  ? `Submitted ${status.submittedAt ? new Date(status.submittedAt).toLocaleDateString() : "recently"}.`
                  : status.status === "in_progress"
                    ? "Your progress is saved."
                    : "Not started."}
            </Text>
          </Box>
        </HStack>
        <Button
          asChild
          size="sm"
          variant={actionLabel === "Review & update" ? "ghost" : "solid"}
          colorPalette="violet"
          alignSelf={{ base: "stretch", md: "center" }}
        >
          <Link href={`${path}?scholarId=${scholarId}`}>
            {actionLabel}
            <ArrowRight size={16} weight="bold" />
          </Link>
        </Button>
      </Stack>
    </ParentFormCardShell>
  );
}
