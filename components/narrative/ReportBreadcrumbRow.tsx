"use client";

/**
 * Shared header row for every `/teacher/report` route — the breadcrumb (left)
 * + optional actions (right), at ONE consistent full-width position (px6 pt5).
 *
 * Every reporting view (roster · scholar detail · course-narrative composer ·
 * Whole Child editor) renders this as its first row, so the breadcrumb's
 * left/top position is identical everywhere and navigating between them doesn't
 * shift the layout. Keep the reporting views full-width (no maxW centering) so
 * this holds.
 */
import type { ReactNode } from "react";
import { Box, Flex } from "@chakra-ui/react";
import { Breadcrumb, type Crumb } from "@/components/ui/Breadcrumb";

export function ReportBreadcrumbRow({
  crumbs,
  rightSlot,
}: {
  crumbs: Crumb[];
  rightSlot?: ReactNode;
}) {
  return (
    <Flex px={6} pt={5} pb={3} minH="4rem" align="center" justify="space-between" gap={3} wrap="wrap">
      <Breadcrumb items={crumbs} />
      {rightSlot ? <Box flexShrink={0}>{rightSlot}</Box> : null}
    </Flex>
  );
}
