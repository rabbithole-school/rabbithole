"use client";

/**
 * Body-shaped loading placeholders for the main teacher/scholar/parent
 * surfaces. Same intent as the Curriculum skeletons
 * (HierarchyRowSkeleton / NodeEditorSkeleton) and the teacher route-level
 * loading.tsx skeletons (app/teacher/(dashboard)/_components/Skeletons.tsx):
 * a panel whose eventual SHAPE is known should load into a skeleton of that
 * shape, not a lone centered spinner that then pops/reflows into content.
 *
 * These differ from the route-level (loading.tsx) skeletons on purpose: a
 * route loading.tsx replaces the whole body during navigation, so it carries
 * its own chrome (bg + padding). These run AFTER mount, when a component's own
 * `useQuery` is still undefined — the page/pane already provides the chrome, so
 * each skeleton here is BODY-ONLY (no extra bg/padding) and slots into the same
 * container the resolved content uses.
 */

import {
  Box,
  Container,
  Flex,
  HStack,
  Skeleton,
  SkeletonCircle,
  Stack,
  Table,
  VStack,
} from "@chakra-ui/react";

/**
 * Assignments → Agenda body: a column of day sections (date label + a few
 * scheduled-activity cards). Body-only — the agenda's scroll container
 * (px/py) and header are already rendered around it.
 */
export function AgendaBodySkeleton() {
  return (
    <Stack gap={4} maxW="760px" mx="auto" aria-hidden>
      {[2, 1, 1].map((rows, d) => (
        <Box key={d}>
          <HStack gap={2} mb={1.5} px={1}>
            <Skeleton height="11px" w="84px" borderRadius="sm" />
          </HStack>
          <Stack gap={1.5}>
            {Array.from({ length: rows }).map((_, i) => (
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
                <SkeletonCircle size="6" flexShrink={0} />
                <VStack align="stretch" gap={1.5} flex={1} minW={0}>
                  <Skeleton height="11px" w="48%" borderRadius="sm" />
                  <Skeleton height="9px" w="28%" borderRadius="sm" />
                </VStack>
                <Skeleton height="20px" w="56px" borderRadius="full" flexShrink={0} />
              </Flex>
            ))}
          </Stack>
        </Box>
      ))}
    </Stack>
  );
}

/**
 * Quests tab body: PageHeader (title + subtitle) + the search/add
 * toolbar + a few per-scholar section cards. Body-only — the route page wraps
 * it in the gray.50 scroll container.
 */
export function QuestsTabSkeleton() {
  return (
    <Stack gap={4} aria-hidden>
      <Stack gap={1.5}>
        <Skeleton height="20px" w="190px" borderRadius="md" />
        <Skeleton height="11px" w="80%" borderRadius="sm" />
        <Skeleton height="11px" w="52%" borderRadius="sm" />
      </Stack>
      <Flex gap={2}>
        <Skeleton height="32px" flex={1} borderRadius="md" />
        <Skeleton height="32px" w="116px" borderRadius="md" />
      </Flex>
      <Stack gap={3}>
        {[0, 1, 2].map((i) => (
          <Box
            key={i}
            borderWidth="1px"
            borderColor="gray.200"
            borderRadius="md"
            bg="white"
            p={4}
          >
            <HStack gap={3} mb={3}>
              <SkeletonCircle size="8" />
              <Skeleton height="12px" w="38%" borderRadius="sm" />
            </HStack>
            <Stack gap={2}>
              <Skeleton height="36px" borderRadius="md" />
              <Skeleton height="36px" borderRadius="md" />
            </Stack>
          </Box>
        ))}
      </Stack>
    </Stack>
  );
}

/**
 * Assignment Run view's per-lesson activity-progress list: lesson eyebrows
 * each over a few activity rows (icon + title + a progress bar). Used both as
 * the body of AssignmentRunSkeleton and on its own while the activityProgress
 * query resolves after the panel's header has rendered.
 */
export function ActivityProgressSkeleton({ groups = 2 }: { groups?: number }) {
  return (
    <Stack gap={4} aria-hidden>
      {Array.from({ length: groups }).map((_, g) => (
        <Box key={g}>
          <Skeleton height="9px" w="92px" borderRadius="sm" mb={2} />
          <Stack gap={2}>
            {Array.from({ length: 3 - g }).map((_, i) => (
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
                <Skeleton boxSize="20px" borderRadius="sm" flexShrink={0} />
                <Skeleton height="11px" w="38%" borderRadius="sm" />
                <Box flex={1} />
                <Skeleton height="8px" w="120px" borderRadius="full" flexShrink={0} />
              </Flex>
            ))}
          </Stack>
        </Box>
      ))}
    </Stack>
  );
}

/**
 * Assignment Run view (AssignmentPanel) before its `assignments.get` query
 * resolves: the header Surface (emoji + eyebrow + title + facepile + action)
 * over the activity-progress body. Mirrors the panel's `embedded` padding so
 * the list-detail right pane and the standalone route both look right.
 */
export function AssignmentRunSkeleton({
  embedded = false,
}: {
  embedded?: boolean;
}) {
  return (
    <Box
      maxW={embedded ? "none" : "1200px"}
      mx={embedded ? 0 : "auto"}
      px={embedded ? 5 : 6}
      py={embedded ? 5 : 6}
      aria-hidden
    >
      {/* Header surface */}
      <Box
        borderWidth="1px"
        borderColor="gray.200"
        borderRadius="xl"
        bg="white"
        p={5}
        mb={5}
      >
        <Flex gap={3} align="flex-start">
          <Skeleton boxSize="40px" borderRadius="md" flexShrink={0} />
          <VStack align="stretch" gap={2} flex={1} minW={0}>
            <Skeleton height="10px" w="96px" borderRadius="sm" />
            <Skeleton height="22px" w="52%" borderRadius="md" />
            <HStack gap={1.5} mt={1}>
              {[0, 1, 2, 3].map((i) => (
                <SkeletonCircle key={i} size="6" />
              ))}
              <Skeleton height="10px" w="64px" borderRadius="sm" ml={2} />
            </HStack>
          </VStack>
          <Skeleton height="28px" w="84px" borderRadius="md" flexShrink={0} />
        </Flex>
      </Box>

      {/* Progress body */}
      <Box
        borderWidth="1px"
        borderColor="gray.200"
        borderRadius="xl"
        bg="white"
        p={5}
      >
        <Skeleton height="11px" w="124px" borderRadius="sm" mb={4} />
        <ActivityProgressSkeleton groups={2} />
      </Box>
    </Box>
  );
}

/**
 * Scholar home (app/scholar) before the user + projects + plate queries
 * resolve. Full-page (it replaces the whole screen, top bar included): a
 * top-bar strip over the centered 680px column of section cards.
 */
export function ScholarHomeSkeleton() {
  return (
    <Flex h="100dvh" bg="gray.50" flexDir="column" aria-hidden>
      <Flex
        align="center"
        gap={3}
        px={{ base: 4, md: 6 }}
        py={3}
        bg="white"
        borderBottom="1px solid"
        borderColor="gray.200"
      >
        <Skeleton height="22px" w="140px" borderRadius="md" />
        <Box flex={1} />
        <Skeleton height="20px" w="120px" borderRadius="full" />
        <SkeletonCircle size="8" />
      </Flex>
      <Box flex={1} overflowY="auto" pb={16}>
        <Box maxW="680px" mx="auto" px={{ base: 4, md: 6 }} pt={6}>
          <Stack gap={6}>
            {[0, 1].map((s) => (
              <Stack key={s} gap={3}>
                <Skeleton height="12px" w="128px" borderRadius="sm" />
                {[0, 1].map((i) => (
                  <Box
                    key={i}
                    borderWidth="1px"
                    borderColor="gray.200"
                    borderRadius="xl"
                    bg="white"
                    p={4}
                  >
                    <HStack gap={3}>
                      <Skeleton boxSize="40px" borderRadius="md" flexShrink={0} />
                      <VStack align="stretch" gap={2} flex={1} minW={0}>
                        <Skeleton height="13px" w="58%" borderRadius="sm" />
                        <Skeleton height="10px" w="38%" borderRadius="sm" />
                      </VStack>
                    </HStack>
                  </Box>
                ))}
              </Stack>
            ))}
          </Stack>
        </Box>
      </Box>
    </Flex>
  );
}

/**
 * Parent portal (ParentDashboard) before the linked-children query resolves:
 * the summary card + tab strip + a couple of content cards, inside the same
 * 4xl container the resolved portal uses.
 */
export function ParentPortalSkeleton() {
  return (
    <Container maxW="4xl" py={6} aria-hidden>
      <VStack align="stretch" gap={6}>
        <Box
          bg="white"
          borderRadius="xl"
          borderWidth="1px"
          borderColor="gray.200"
          p={6}
        >
          <Skeleton height="24px" w="42%" borderRadius="md" mb={4} />
          <HStack gap={6}>
            {[0, 1, 2].map((i) => (
              <VStack key={i} align="stretch" gap={1.5}>
                <Skeleton height="20px" w="40px" borderRadius="sm" />
                <Skeleton height="10px" w="72px" borderRadius="sm" />
              </VStack>
            ))}
          </HStack>
        </Box>
        <HStack gap={5} borderBottomWidth="1px" borderColor="gray.200" pb={2}>
          {["60px", "70px", "48px"].map((w, i) => (
            <Skeleton key={i} height="14px" w={w} borderRadius="sm" />
          ))}
        </HStack>
        <Stack gap={5}>
          {[0, 1].map((i) => (
            <Box
              key={i}
              borderWidth="1px"
              borderColor="gray.200"
              borderRadius="xl"
              bg="white"
              p={5}
            >
              <Skeleton height="12px" w="168px" borderRadius="sm" mb={3} />
              <Stack gap={2}>
                <Skeleton height="12px" w="90%" borderRadius="sm" />
                <Skeleton height="12px" w="74%" borderRadius="sm" />
                <Skeleton height="12px" w="58%" borderRadius="sm" />
              </Stack>
            </Box>
          ))}
        </Stack>
      </VStack>
    </Container>
  );
}

/**
 * Generic table-body loading placeholder: `rows` shimmer rows of `columns`
 * skeleton cells, slotted straight into a <Table.Body> while the table's
 * `useQuery` is still undefined. Same body-only intent as the skeletons above —
 * the page already renders the table chrome (toolbar + column headers), so we
 * only stand in for the rows. Crucially this lets a table distinguish LOADING
 * (query undefined → skeleton) from genuinely EMPTY (resolved []  → "No X yet"),
 * instead of flashing the empty-state copy during the initial load. Used by the
 * admin Families + Accounts tables.
 */
export function TableRowsSkeleton({
  rows = 6,
  columns,
}: {
  rows?: number;
  columns: number;
}) {
  // A few cell widths cycled per (row, col) so the placeholder reads as varied
  // data rather than a uniform grid.
  const widths = ["68%", "52%", "60%", "44%", "72%", "50%"];
  return (
    <>
      {Array.from({ length: rows }).map((_, r) => (
        <Table.Row key={r} aria-hidden>
          {Array.from({ length: columns }).map((_, c) => (
            <Table.Cell key={c} pl={c === 0 ? 4 : undefined}>
              <Skeleton
                height="12px"
                borderRadius="sm"
                w={widths[(r + c) % widths.length]}
              />
            </Table.Cell>
          ))}
        </Table.Row>
      ))}
    </>
  );
}
