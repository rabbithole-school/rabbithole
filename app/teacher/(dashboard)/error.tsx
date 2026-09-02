"use client";

import { useEffect } from "react";
import { Box, Button, Flex, Heading, Text, VStack } from "@chakra-ui/react";
import { ArrowClockwise, Warning } from "@phosphor-icons/react";

/**
 * Route-level error boundary for the teacher dashboard tabs. Because it sits
 * inside the `(dashboard)` segment, the shared layout (top nav) stays mounted
 * and only the tab body is replaced — the teacher keeps their bearings and can
 * retry the failed route in place via `reset()`.
 */
export default function DashboardError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("Teacher dashboard route error:", error);
  }, [error]);

  return (
    <Flex flex={1} h="full" align="center" justify="center" bg="gray.50" p={8}>
      <VStack gap={4} maxW="420px" textAlign="center">
        <Box color="amber.500">
          <Warning size={40} weight="fill" />
        </Box>
        <Heading size="md" fontFamily="heading" color="navy.500">
          Something went wrong
        </Heading>
        <Text fontSize="sm" color="charcoal.400">
          This view hit an error while loading. You can retry without leaving the
          dashboard, or switch tabs in the nav above.
        </Text>
        <Button
          size="sm"
          colorPalette="violet"
          onClick={reset}
          fontFamily="heading"
        >
          <ArrowClockwise size={16} style={{ marginRight: "6px" }} />
          Try again
        </Button>
      </VStack>
    </Flex>
  );
}
