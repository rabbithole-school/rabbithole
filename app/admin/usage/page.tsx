"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Box, Heading, Stack, Table, Text, VStack } from "@chakra-ui/react";
import { usePaginatedQuery } from "convex/react";
import { Coins } from "@phosphor-icons/react";
import { api } from "@/convex/_generated/api";
import { TableRowsSkeleton } from "@/components/skeletons/PanelSkeletons";
import { EmptyState } from "@/components/ui/EmptyState";
import { FieldSelect } from "@/components/ui/FieldSelect";
import { Surface } from "@/components/ui/Surface";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { isPlatformAdminRole, type Role } from "@/convex/lib/roles";

const DAY_MS = 24 * 60 * 60 * 1000;
const PAGE_SIZE = 2_000;
const INITIAL_WINDOW_END = Date.now();

interface UsageRow {
  institutionId: string | null;
  label: string;
  estimatedCost: number;
  totals: {
    inputTokens: number;
    cacheWriteTokens: number;
    cacheReadTokens: number;
    outputTokens: number;
  };
  calls: number;
}

function formatTokens(tokens: number): string {
  return Math.round(tokens).toLocaleString("en-US");
}

function formatCost(cost: number): string {
  return cost.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

export default function UsagePage() {
  const { user, isLoading } = useCurrentUser();
  const router = useRouter();
  const isAdmin = isPlatformAdminRole(user?.role as Role | undefined);
  const [windowDays, setWindowDays] = useState<7 | 30>(7);
  const [windowEnd, setWindowEnd] = useState(INITIAL_WINDOW_END);
  const {
    results: usageFragments,
    status,
    loadMore,
  } = usePaginatedQuery(
    api.usage.byInstitution,
    isAdmin
      ? {
          sinceMs: windowEnd - windowDays * DAY_MS,
          untilMs: windowEnd,
        }
      : "skip",
    { initialNumItems: PAGE_SIZE },
  );
  const usage = useMemo(() => {
    const byInstitution = new Map<string, UsageRow>();
    for (const fragment of usageFragments) {
      const key = fragment.institutionId ?? "unattributed";
      const current = byInstitution.get(key);
      if (!current) {
        byInstitution.set(key, {
          ...fragment,
          totals: { ...fragment.totals },
        });
        continue;
      }
      current.estimatedCost += fragment.estimatedCost;
      current.totals.inputTokens += fragment.totals.inputTokens;
      current.totals.cacheWriteTokens += fragment.totals.cacheWriteTokens;
      current.totals.cacheReadTokens += fragment.totals.cacheReadTokens;
      current.totals.outputTokens += fragment.totals.outputTokens;
      current.calls += fragment.calls;
    }
    const rows = [...byInstitution.values()].sort(
      (a, b) =>
        b.estimatedCost - a.estimatedCost || a.label.localeCompare(b.label),
    );
    return {
      rows,
      estimatedCost: rows.reduce(
        (sum, row) => sum + row.estimatedCost,
        0,
      ),
      totalTokens: rows.reduce(
        (totals, row) => ({
          inputTokens: totals.inputTokens + row.totals.inputTokens,
          cacheWriteTokens:
            totals.cacheWriteTokens + row.totals.cacheWriteTokens,
          cacheReadTokens:
            totals.cacheReadTokens + row.totals.cacheReadTokens,
          outputTokens: totals.outputTokens + row.totals.outputTokens,
        }),
        {
          inputTokens: 0,
          cacheWriteTokens: 0,
          cacheReadTokens: 0,
          outputTokens: 0,
        },
      ),
    };
  }, [usageFragments]);

  useEffect(() => {
    if (status === "CanLoadMore") loadMore(PAGE_SIZE);
  }, [loadMore, status]);

  useEffect(() => {
    if (isLoading) return;
    if (!user) {
      router.replace("/sign-in");
      return;
    }
    if (!isAdmin) router.replace("/");
  }, [isAdmin, isLoading, router, user]);

  if (isLoading || !user || !isAdmin) return null;

  return (
    <VStack align="stretch" gap={6}>
      <Stack
        direction={{ base: "column", md: "row" }}
        align={{ base: "stretch", md: "end" }}
        justify="space-between"
        gap={4}
      >
        <Box>
          <Heading
            as="h1"
            fontFamily="heading"
            fontSize="2xl"
            color="navy.500"
            mb={1}
          >
            AI token usage
          </Heading>
          <Text fontFamily="body" fontSize="sm" color="charcoal.400">
            Estimated Anthropic usage by institution.
          </Text>
        </Box>
        <FieldSelect
          value={String(windowDays)}
          onChange={(value) => {
            setWindowDays(value === "30" ? 30 : 7);
            setWindowEnd(Date.now());
          }}
          w={{ base: "full", md: "160px" }}
          fieldProps={{ "aria-label": "Usage window" }}
        >
          <option value="7">Last 7 days</option>
          <option value="30">Last 30 days</option>
        </FieldSelect>
      </Stack>

      <Surface overflowX="auto">
        {status === "Exhausted" && usage.rows.length === 0 ? (
          <EmptyState
            icon={<Coins />}
            title="No AI usage recorded"
            hint={`No token events were recorded in the last ${windowDays} days.`}
          />
        ) : (
          <Table.Root size="sm" minW="820px">
            <Table.Header>
              <Table.Row>
                <Table.ColumnHeader fontFamily="heading" pl={4}>
                  Institution
                </Table.ColumnHeader>
                <Table.ColumnHeader fontFamily="heading" textAlign="end">
                  Input
                </Table.ColumnHeader>
                <Table.ColumnHeader fontFamily="heading" textAlign="end">
                  Cache write
                </Table.ColumnHeader>
                <Table.ColumnHeader fontFamily="heading" textAlign="end">
                  Cache read
                </Table.ColumnHeader>
                <Table.ColumnHeader fontFamily="heading" textAlign="end">
                  Output
                </Table.ColumnHeader>
                <Table.ColumnHeader fontFamily="heading" textAlign="end" pr={4}>
                  Est. cost
                </Table.ColumnHeader>
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {status === "LoadingFirstPage" ? (
                <TableRowsSkeleton columns={6} rows={3} />
              ) : (
                <>
                  {usage.rows.map((row) => (
                    <Table.Row key={row.institutionId ?? "unattributed"}>
                      <Table.Cell fontFamily="body" fontWeight="500" pl={4}>
                        {row.label}
                      </Table.Cell>
                      <Table.Cell fontFamily="body" textAlign="end">
                        {formatTokens(row.totals.inputTokens)}
                      </Table.Cell>
                      <Table.Cell fontFamily="body" textAlign="end">
                        {formatTokens(row.totals.cacheWriteTokens)}
                      </Table.Cell>
                      <Table.Cell fontFamily="body" textAlign="end">
                        {formatTokens(row.totals.cacheReadTokens)}
                      </Table.Cell>
                      <Table.Cell fontFamily="body" textAlign="end">
                        {formatTokens(row.totals.outputTokens)}
                      </Table.Cell>
                      <Table.Cell fontFamily="body" textAlign="end" pr={4}>
                        {formatCost(row.estimatedCost)}
                      </Table.Cell>
                    </Table.Row>
                  ))}
                  <Table.Row bg="gray.50">
                    <Table.Cell fontFamily="heading" fontWeight="600" pl={4}>
                      Total
                    </Table.Cell>
                    <Table.Cell fontFamily="body" fontWeight="600" textAlign="end">
                      {formatTokens(usage.totalTokens.inputTokens)}
                    </Table.Cell>
                    <Table.Cell fontFamily="body" fontWeight="600" textAlign="end">
                      {formatTokens(usage.totalTokens.cacheWriteTokens)}
                    </Table.Cell>
                    <Table.Cell fontFamily="body" fontWeight="600" textAlign="end">
                      {formatTokens(usage.totalTokens.cacheReadTokens)}
                    </Table.Cell>
                    <Table.Cell fontFamily="body" fontWeight="600" textAlign="end">
                      {formatTokens(usage.totalTokens.outputTokens)}
                    </Table.Cell>
                    <Table.Cell
                      fontFamily="body"
                      fontWeight="600"
                      textAlign="end"
                      pr={4}
                    >
                      {formatCost(usage.estimatedCost)}
                    </Table.Cell>
                  </Table.Row>
                </>
              )}
            </Table.Body>
          </Table.Root>
        )}
      </Surface>
    </VStack>
  );
}
