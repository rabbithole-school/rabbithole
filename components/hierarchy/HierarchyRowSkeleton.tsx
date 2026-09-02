"use client";

/**
 * Loading placeholders shaped like a HierarchyRow / the outline tree, so a
 * loading list shows its eventual SHAPE (emoji + label rows) instead of a lone
 * centered spinner that then pops/reflows into rows. Mirrors the rhythm of the
 * real rows (same p={2} / gap={2} / 20px leading slot). Same intent as
 * NodeEditorSkeleton, for the Curriculum Units list + Outline tree.
 */
import { Box, Flex, Skeleton, Stack } from "@chakra-ui/react";

const WIDTHS = ["72%", "56%", "80%", "48%", "66%", "60%", "76%", "52%"];

export function HierarchyRowSkeleton({
  indent = 0,
  sublabel = true,
  labelW = "70%",
}: {
  indent?: number;
  sublabel?: boolean;
  labelW?: string;
}) {
  return (
    <Flex align="center" gap={2} p={2} pl={2 + indent * 3}>
      <Skeleton boxSize="20px" borderRadius="full" flexShrink={0} />
      <Stack gap={1.5} flex={1} minW={0}>
        <Skeleton height="11px" w={labelW} borderRadius="sm" />
        {sublabel && <Skeleton height="9px" w="32%" borderRadius="sm" />}
      </Stack>
    </Flex>
  );
}

/** N skeleton rows with varied widths — a flat list placeholder (Units list). */
export function HierarchyListSkeleton({
  rows = 6,
  sublabel = true,
}: {
  rows?: number;
  sublabel?: boolean;
}) {
  return (
    <Stack gap={0.5} aria-hidden>
      {Array.from({ length: rows }).map((_, i) => (
        <HierarchyRowSkeleton
          key={i}
          sublabel={sublabel}
          labelW={WIDTHS[i % WIDTHS.length]}
        />
      ))}
    </Stack>
  );
}

/** A strand-header + indented lesson/activity rows — the Outline tree shape. */
export function HierarchyTreeSkeleton() {
  return (
    <Box p={1.5} aria-hidden>
      {/* unit row */}
      <HierarchyRowSkeleton sublabel={false} labelW="78%" />
      {[0, 1].map((s) => (
        <Box key={s} mt={2}>
          {/* strand header */}
          <Skeleton height="9px" w="56px" m={2} borderRadius="sm" />
          <HierarchyRowSkeleton sublabel={false} labelW="68%" />
          <HierarchyRowSkeleton indent={1} sublabel={false} labelW="52%" />
          <HierarchyRowSkeleton sublabel={false} labelW="60%" />
        </Box>
      ))}
    </Box>
  );
}
