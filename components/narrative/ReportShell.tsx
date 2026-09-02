"use client";

/**
 * The shared shell for every `/teacher/report` route (roster · scholar detail ·
 * course-narrative composer · Whole Child editor).
 *
 * Owns the cross-page furniture so the individual views don't each re-implement
 * (and drift on) it: the full-height layout and the breadcrumb + right-actions
 * row. A view just renders
 * `<ReportShell crumbs actions scholarId>{body}</ReportShell>` and provides its
 * own crumbs / actions / body.
 *
 * The aide is the global header Robot → docked panel; this shell just publishes
 * its SCOPE — the current `scholarId` on a detail / editor, the general aide on
 * the roster — so opening the dock is always about the report you're viewing.
 */
import { type ReactNode } from "react";
import { Flex, HStack } from "@chakra-ui/react";
import type { Id } from "@/convex/_generated/dataModel";
import type { Crumb } from "@/components/ui/Breadcrumb";
import { ReportBreadcrumbRow } from "@/components/narrative/ReportBreadcrumbRow";
import { useSetAideScope } from "@/components/aide/AideDockProvider";

export function ReportShell({
  crumbs,
  actions,
  scholarId,
  children,
}: {
  crumbs: Crumb[];
  /** Extra right-slot actions (period tabs, prev/next). */
  actions?: ReactNode;
  /** Scopes the aide to a scholar; omit on the roster for the general aide. */
  scholarId?: Id<"users">;
  children: ReactNode;
}) {
  useSetAideScope(
    scholarId ? { kind: "scholar", scholarId } : { kind: "global" },
  );

  return (
    <Flex h="full" overflow="hidden">
      <Flex direction="column" flex={1} minW={0} h="full" overflow="auto" bg="gray.50">
        <ReportBreadcrumbRow
          crumbs={crumbs}
          rightSlot={
            actions ? (
              <HStack gap={3} align="center" wrap="wrap" justify="flex-end">
                {actions}
              </HStack>
            ) : undefined
          }
        />
        {children}
      </Flex>
    </Flex>
  );
}
