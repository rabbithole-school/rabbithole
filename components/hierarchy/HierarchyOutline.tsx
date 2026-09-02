"use client";

/**
 * Outline (accordion) container — vertical tree of HierarchyRows.
 * Used in the design screen left pane. Rows nest via the `indent`
 * prop on HierarchyRow; the container itself is just a tight Stack.
 *
 * Same row primitive, same selection style, same strand-divider
 * dividers as HierarchyColumn — what differs is the interaction
 * (click row to expand inline vs. drill into next column).
 */
import React from "react";
import { Stack } from "@chakra-ui/react";

export function HierarchyOutline({
  children,
  testId,
}: {
  children: React.ReactNode;
  testId?: string;
}) {
  return (
    <Stack gap={0.5} role="tree" data-testid={testId}>
      {children}
    </Stack>
  );
}
