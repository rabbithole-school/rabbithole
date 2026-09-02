"use client";

import { Box, Flex, HStack, Skeleton, SkeletonCircle, VStack } from "@chakra-ui/react";

/**
 * Loading skeletons for the teacher dashboard.
 *
 * Most tab route fallbacks (scholars / assignments / chat / curriculum
 * `loading.tsx`) now render NOTHING: those tabs' client `layout.tsx` mounts
 * `{children}` as an absolute, full-bleed overlay, so a full-surface skeleton in
 * the route fallback would paint on top of the layout's already-warm real
 * content (the "skeleton overlaid on real data" bug). Each such layout instead
 * owns its OWN scoped skeletons (e.g. `ScholarRailSkeleton`), driven by its real
 * Convex query state — the single source of truth for that tab's loading UI.
 *
 * What remains here: the layout-owned scoped skeleton (`ScholarRailSkeleton`),
 * the Quests page fallback (`ListSkeleton` — a real page with no client layout),
 * and the neutral `GenericBodySkeleton` for the shared `(dashboard)` boundary
 * (the cold first paint of the dashboard body). The top nav is never included —
 * it lives in the persistent dashboard layout and stays mounted across tabs.
 */

/** Just the left rail column of the Scholars surface — used on its own while
 *  the roster (listScholars) loads but the right-hand detail is already
 *  rendering (a deep-link to one scholar resolves + loads in parallel). */
export function ScholarRailSkeleton() {
  return (
    <Flex
      direction="column"
      w={{ base: "200px", lg: "248px" }}
      flexShrink={0}
      h="full"
      borderRight="1px solid"
      borderColor="gray.200"
      bg="white"
    >
      <HStack px={2.5} py={2} gap={1} borderBottom="1px solid" borderColor="gray.100" flexShrink={0}>
        <Skeleton height="32px" flex={1} borderRadius="md" />
        <Skeleton height="32px" width="32px" borderRadius="md" />
      </HStack>

      <Box px={3} py={2} flexShrink={0}>
        <Skeleton height="34px" borderRadius="md" />
      </Box>

      <VStack gap={0} align="stretch" overflowY="auto" flex={1} px={2} pb={2}>
        {Array.from({ length: 10 }).map((_, i) => (
          <HStack key={i} w="full" gap={2.5} px={2} py={2} borderRadius="lg">
            <SkeletonCircle size="8" />
            <VStack align="stretch" gap={1.5} flex={1} minW={0}>
              <Skeleton height="12px" width="70%" borderRadius="sm" />
              <Skeleton height="8px" width="45%" borderRadius="sm" />
            </VStack>
            <SkeletonCircle size="2.5" flexShrink={0} />
          </HStack>
        ))}
      </VStack>
    </Flex>
  );
}

/** Generic list (Quests) — header + a column of rows. */
export function ListSkeleton() {
  return (
    <Box flex={1} overflowY="auto" px={6} py={4} h="full" bg="gray.50">
      <Skeleton height="24px" width="200px" borderRadius="md" mb={6} />
      <VStack align="stretch" gap={2.5}>
        {Array.from({ length: 6 }).map((_, i) => (
          <Flex
            key={i}
            align="center"
            gap={3}
            borderWidth="1px"
            borderColor="gray.200"
            borderRadius="md"
            p={3}
            bg="white"
          >
            <SkeletonCircle size="8" />
            <Skeleton height="12px" width={`${40 + (i % 3) * 12}%`} borderRadius="sm" />
            <Box flex={1} />
            <Skeleton height="20px" width="48px" borderRadius="full" />
          </Flex>
        ))}
      </VStack>
    </Box>
  );
}

/** Neutral body fallback — used by the shared (dashboard) loading boundary. */
export function GenericBodySkeleton() {
  return (
    <Box flex={1} overflowY="auto" p={8} h="full">
      <Skeleton height="24px" width="180px" borderRadius="md" mb={6} />
      <VStack align="stretch" gap={3}>
        {Array.from({ length: 5 }).map((_, i) => (
          <Skeleton key={i} height="56px" borderRadius="lg" />
        ))}
      </VStack>
    </Box>
  );
}
