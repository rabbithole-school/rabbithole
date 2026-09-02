"use client";

import { Box, Flex, HStack, Skeleton, VStack } from "@chakra-ui/react";
import { Scroll } from "./shared";

type Kind = "activity" | "lesson" | "unit";

/**
 * Loading-state placeholder for the node editor's three concrete
 * variants. Renders the same vertical rhythm + field count as the
 * real ActivityFields / LessonFields / UnitFields so the layout
 * doesn't jump when the data resolves and the skeleton swaps for
 * the populated form.
 *
 * Used when:
 * - A field component's own useQuery is undefined (no `return null`
 *   flicker between activity transitions)
 * - UnitDesigner has a `?activity=…` URL but the activity doc hasn't
 *   resolved yet (no EmptyState flicker between activity transitions)
 */
export function NodeEditorSkeleton({ kind = "activity" }: { kind?: Kind }) {
  return (
    <Scroll>
      {/* Section header — title + subtitle + right-side action button */}
      <Flex align="center" justify="space-between" gap={3}>
        <VStack align="stretch" gap={1.5} flex={1} minW={0}>
          <Skeleton height="28px" maxW="360px" borderRadius="md" />
          <Skeleton height="12px" maxW="80px" borderRadius="sm" />
        </VStack>
        <HStack gap={1.5}>
          <Skeleton boxSize="28px" borderRadius="md" />
          {kind === "activity" && (
            <Skeleton height="28px" width="100px" borderRadius="md" />
          )}
        </HStack>
      </Flex>

      {/* Kind / duration row — only on activity */}
      {kind === "activity" && (
        <Flex gap={3}>
          <FieldSkeleton flex={1}>
            <Skeleton height="32px" borderRadius="md" />
          </FieldSkeleton>
          <FieldSkeleton flex={1}>
            <Skeleton height="32px" borderRadius="md" />
          </FieldSkeleton>
        </Flex>
      )}

      {/* Unit-specific: subject + grade level + big idea row */}
      {kind === "unit" && (
        <Flex gap={3}>
          <FieldSkeleton flex={1}>
            <Skeleton height="32px" borderRadius="md" />
          </FieldSkeleton>
          <FieldSkeleton flex={1}>
            <Skeleton height="32px" borderRadius="md" />
          </FieldSkeleton>
        </Flex>
      )}

      {/* Description */}
      <FieldSkeleton>
        <VStack align="stretch" gap={1.5}>
          <Skeleton height="14px" width="98%" borderRadius="sm" />
          <Skeleton height="14px" width="92%" borderRadius="sm" />
          <Skeleton height="14px" width="60%" borderRadius="sm" />
        </VStack>
      </FieldSkeleton>

      {/* System prompt — large textarea-shaped block */}
      {kind !== "unit" && (
        <FieldSkeleton>
          <Skeleton height="220px" borderRadius="md" />
        </FieldSkeleton>
      )}

      {/* Slides row — only on activity */}
      {kind === "activity" && (
        <FieldSkeleton>
          <Skeleton height="84px" borderRadius="md" />
        </FieldSkeleton>
      )}

      {/* Unit / lesson lists at the bottom */}
      {kind !== "activity" && (
        <FieldSkeleton>
          <VStack align="stretch" gap={1.5}>
            <Skeleton height="20px" width="70%" borderRadius="sm" />
            <Skeleton height="20px" width="55%" borderRadius="sm" />
            <Skeleton height="20px" width="65%" borderRadius="sm" />
          </VStack>
        </FieldSkeleton>
      )}
    </Scroll>
  );
}

function FieldSkeleton({
  flex,
  children,
}: {
  flex?: number;
  children: React.ReactNode;
}) {
  return (
    <Box flex={flex} display="flex" flexDirection="column" gap={1.5}>
      {/* Field label */}
      <Skeleton height="11px" width="80px" borderRadius="sm" />
      {children}
    </Box>
  );
}
