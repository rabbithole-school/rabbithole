"use client";

/**
 * Whole Child roster (review/assessment-and-goals-plan.html §8) — every
 * scholar in the current reporting period plus where their Whole Child
 * Narrative stands: not started · in progress (an advisor has opened it) ·
 * team agreed (meeting mode's "Team agreed" stamp) · final · shared.
 * Clicking a row opens meeting mode for that scholar
 * (`/teacher/whole-child/<scholarId>`).
 */
import Link from "next/link";
import { useQuery } from "convex/react";
import { Box, Flex, Stack, Text } from "@chakra-ui/react";
import { CaretRight } from "@phosphor-icons/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { useScholarRoster, type RosterScholar } from "@/hooks/useScholarRoster";
import { Avatar } from "@/components/Avatar";
import { PageHeader } from "@/components/ui/PageHeader";
import { ReportingViewTabs } from "@/components/ReportingViewTabs";
import { Surface } from "@/components/ui/Surface";
import { formatTimeAgo } from "@/lib/relativeTime";

export interface WholeChildRosterProps {
  periodId: Id<"reportingPeriods">;
  periodLabel: string;
}

type NarrativeStatus = "draft" | "teamReview" | "final" | "shared";
type RosterStatus = "notStarted" | NarrativeStatus;

const STATUS_META: Record<RosterStatus, { label: string; bg: string; color: string }> = {
  notStarted: { label: "Not started", bg: "gray.100", color: "gray.600" },
  draft: { label: "In progress", bg: "violet.50", color: "violet.600" },
  teamReview: { label: "Team agreed", bg: "teal.50", color: "teal.700" },
  final: { label: "Done", bg: "green.50", color: "green.700" },
  shared: { label: "Published", bg: "green.50", color: "green.700" },
};

/**
 * The badge state for a roster row. `teamAgreedAt` (not a `status` value) is the
 * team-consensus signal — done/shared live on `status`, orthogonally — so the
 * "Team agreed" rung is derived from the stamp, shown until the report is
 * marked done/published.
 */
function deriveRosterStatus(
  entry: { status: NarrativeStatus; teamAgreedAt: number | null } | undefined,
): RosterStatus {
  if (!entry) return "notStarted";
  if (entry.status === "shared") return "shared";
  if (entry.status === "final") return "final";
  if (entry.teamAgreedAt != null) return "teamReview";
  return "draft";
}

/** Alphabetical by display name — the single ordering shared by the roster
 *  list and meeting mode's prev/next scholar navigation. */
export function sortRosterScholars(scholars: RosterScholar[]): RosterScholar[] {
  return [...scholars].sort((a, b) => a.name.localeCompare(b.name));
}

function StatusBadge({ status }: { status: RosterStatus }) {
  const meta = STATUS_META[status];
  return (
    <Box
      as="span"
      bg={meta.bg}
      color={meta.color}
      fontFamily="heading"
      fontWeight="600"
      fontSize="2xs"
      textTransform="uppercase"
      letterSpacing="0.03em"
      px={2}
      py={1}
      borderRadius="full"
      flexShrink={0}
    >
      {meta.label}
    </Box>
  );
}

export function WholeChildRoster({ periodId, periodLabel }: WholeChildRosterProps) {
  const { scholars, isLoading: rosterLoading } = useScholarRoster();
  const narratives = useQuery(api.wholeChildNarratives.listForPeriod, { periodId });

  const statusByScholar = new Map<
    string,
    { status: NarrativeStatus; teamAgreedAt: number | null }
  >();
  for (const n of narratives ?? []) {
    statusByScholar.set(String(n.scholarId), {
      status: n.status as NarrativeStatus,
      teamAgreedAt: n.teamAgreedAt,
    });
  }

  const sorted = sortRosterScholars(scholars);
  const agreedCount = sorted.filter(
    (s) => statusByScholar.get(s.id)?.teamAgreedAt != null,
  ).length;

  const loading = rosterLoading || narratives === undefined;

  return (
    <Flex direction="column" h="full" overflow="auto" bg="gray.50">
      <Box px={6} pt={5} pb={3}>
        <Box mb={3}>
          <ReportingViewTabs />
        </Box>
        <PageHeader
          title="Whole Child"
          subtitle={
            loading
              ? periodLabel
              : `${periodLabel} · ${agreedCount} of ${sorted.length} team-agreed`
          }
        />
      </Box>

      <Box px={6} pb={6} flex={1}>
        <Surface overflow="hidden">
          {loading ? (
            <Text color="charcoal.400" fontFamily="heading" fontSize="sm" px={4} py={6} textAlign="center">
              Loading roster…
            </Text>
          ) : sorted.length === 0 ? (
            <Text color="charcoal.400" fontFamily="heading" fontSize="sm" px={4} py={6} textAlign="center">
              No scholars in this roster yet.
            </Text>
          ) : (
            <Stack gap={0}>
              {sorted.map((scholar, i) => {
                const entry = statusByScholar.get(scholar.id);
                const status: RosterStatus = deriveRosterStatus(entry);
                return (
                  <Link
                    key={scholar.id}
                    href={`/teacher/whole-child/${scholar.id}`}
                    style={{ textDecoration: "none", display: "block" }}
                  >
                    <Flex
                      align="center"
                      gap={3}
                      px={4}
                      py={3}
                      borderBottomWidth={i < sorted.length - 1 ? "1px" : 0}
                      borderColor="gray.100"
                      _hover={{ bg: "gray.50" }}
                      cursor="pointer"
                    >
                      <Avatar name={scholar.name} src={scholar.image ?? undefined} colorKey={scholar.id} size="sm" />
                      <Box flex={1} minW={0}>
                        <Text fontFamily="heading" fontWeight="600" color="navy.500" fontSize="sm" truncate>
                          {scholar.name}
                        </Text>
                        {entry?.teamAgreedAt && (
                          <Text fontSize="xs" color="charcoal.400" fontFamily="heading">
                            Agreed {formatTimeAgo(entry.teamAgreedAt)}
                          </Text>
                        )}
                      </Box>
                      <StatusBadge status={status} />
                      <CaretRight color="var(--chakra-colors-charcoal-300)" />
                    </Flex>
                  </Link>
                );
              })}
            </Stack>
          )}
        </Surface>
      </Box>
    </Flex>
  );
}
