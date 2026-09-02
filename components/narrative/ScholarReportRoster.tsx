"use client";

/**
 * Scholar-first Reports index (IA exploration).
 *
 * The reporting surface is organized by SCHOLAR, not by report type: every
 * scholar in the reporting period is a row, and clicking one opens their
 * reporting detail where you add 0+ course narratives (one per subject) and
 * 0–1 Whole Child report. This roster just shows each scholar's status at a
 * glance and routes into their detail.
 */
import { useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useMutation, useQuery } from "convex/react";
import {
  Box,
  Button,
  Dialog,
  Flex,
  Heading,
  HStack,
  IconButton,
  Menu,
  Portal,
  Spinner,
  Stack,
  Text,
  VStack,
} from "@chakra-ui/react";
import { CalendarBlank, CaretRight, DotsThree, Plus, ShareNetwork, X } from "@phosphor-icons/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { Avatar } from "@/components/Avatar";
import { StyledDialogContent } from "@/components/ui/StyledDialogContent";
import { EmptyState } from "@/components/ui/EmptyState";
import { CreatePeriodDialog } from "@/components/narrative/NarrativeQueue";
import { ReportShell } from "@/components/narrative/ReportShell";
import { SectionStatusIcon } from "@/components/narrative/SectionStatusIcon";
import { reportSectionState, reportShared, SharedCountTag } from "@/components/narrative/reportStatus";
import { useScholarRoster, type RosterScholar } from "@/hooks/useScholarRoster";
import { toaster } from "@/lib/toaster";

export function ScholarReportRoster() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const periodParam = searchParams.get("period");

  const current = useQuery(api.reportingPeriods.current, {});
  const periods = useQuery(api.reportingPeriods.list, {});

  const activePeriod = periods
    ? (periodParam && periods.find((p) => String(p._id) === periodParam)) || current || periods[0] || null
    : (current ?? undefined);
  const activePeriodId = (activePeriod?._id ?? null) as Id<"reportingPeriods"> | null;

  const { scholars, isLoading: rosterLoading } = useScholarRoster();
  const narratives = useQuery(
    api.courseNarratives.listForPeriod,
    activePeriodId ? { periodId: activePeriodId } : "skip",
  );
  const wholeChild = useQuery(
    api.wholeChildNarratives.listForPeriod,
    activePeriodId ? { periodId: activePeriodId } : "skip",
  );

  const sharePeriod = useMutation(api.courseNarratives.sharePeriod);
  const [sharing, setSharing] = useState(false);
  const [newPeriodOpen, setNewPeriodOpen] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);

  // Per-scholar rollup (client-side join) — one entry per report so the row can
  // render a status dot each (course narratives + the whole-child report).
  type ReportDot = { key: string; label: string; status: string; hasContent: boolean };
  const courseByScholar = new Map<string, ReportDot[]>();
  for (const n of narratives ?? []) {
    const arr = courseByScholar.get(String(n.scholarId)) ?? [];
    arr.push({ key: String(n._id), label: n.subject, status: n.status, hasContent: n.hasContent });
    courseByScholar.set(String(n.scholarId), arr);
  }
  const wcByScholar = new Map<string, { status: string; hasContent: boolean }>();
  for (const w of wholeChild ?? []) {
    wcByScholar.set(String(w.scholarId), { status: w.status, hasContent: w.hasContent });
  }

  const doneCount = (narratives ?? []).filter((n) => n.status === "final" || n.status === "shared").length;
  // The finalized (not-yet-shared) narratives "Share with parents" will publish.
  const toShare = (narratives ?? []).filter((n) => n.status === "final");

  const sorted = [...scholars].sort((a, b) => a.name.localeCompare(b.name));
  const dataLoading =
    periods === undefined ||
    (activePeriodId !== null && (narratives === undefined || wholeChild === undefined || rosterLoading));

  const setPeriod = (id: string) => {
    const params = new URLSearchParams(searchParams.toString());
    params.set("period", id);
    router.replace(`/teacher/report?${params.toString()}`, { scroll: false });
  };

  const scholarHref = (id: string) =>
    `/teacher/report/${id}${activePeriodId ? `?period=${String(activePeriodId)}` : ""}`;

  const handleSharePeriod = async () => {
    if (!activePeriodId) return;
    setSharing(true);
    try {
      const res = await sharePeriod({ periodId: activePeriodId });
      toaster.success({ title: `Published ${res.shared} narrative${res.shared === 1 ? "" : "s"} to parents` });
      setShareOpen(false);
    } catch (e) {
      toaster.error({ title: "Couldn't publish to parents", description: e instanceof Error ? e.message : String(e) });
    } finally {
      setSharing(false);
    }
  };

  return (
    <ReportShell
      crumbs={[{ label: "All scholars" }]}
      actions={
        <>
          <PeriodTabs
            periods={periods ?? []}
            activePeriodId={activePeriodId}
            onSelect={setPeriod}
            onNewPeriod={() => setNewPeriodOpen(true)}
          />
          <Button size="sm" colorPalette="violet" onClick={() => setShareOpen(true)} disabled={!activePeriodId || doneCount === 0}>
            <ShareNetwork size={14} /> Publish to parents
          </Button>
        </>
      }
    >
      <Box px={6} pb={6}>
        {activePeriod?.narrativesDueAt && (
          <Text fontSize="xs" color="charcoal.400" fontFamily="body" mb={4}>
            Narratives due {new Date(activePeriod.narrativesDueAt).toLocaleDateString()}
          </Text>
        )}

        {periods === undefined ? (
          <Flex justify="center" py={10}><Spinner size="lg" color="violet.500" /></Flex>
        ) : !activePeriodId ? (
          <EmptyState
            size="lg"
            icon={<CalendarBlank weight="duotone" />}
            title="No reporting period yet"
            hint="Set up a term window to start writing course narratives and Whole Child reports for your scholars."
            cta={{
              label: "Set up a reporting period",
              icon: <Plus size={14} />,
              onClick: () => setNewPeriodOpen(true),
              primary: true,
            }}
          />
        ) : dataLoading ? (
          <Flex justify="center" py={10}><Spinner size="lg" color="violet.500" /></Flex>
        ) : sorted.length === 0 ? (
          <Text fontSize="sm" color="charcoal.300" fontFamily="heading" textAlign="center" py={10}>
            No scholars in this roster yet.
          </Text>
        ) : (
          <VStack align="stretch" gap={2}>
            {sorted.map((s) => (
              <ScholarRow
                key={s.id}
                scholar={s}
                href={scholarHref(s.id)}
                courseReports={courseByScholar.get(s.id) ?? []}
                wc={wcByScholar.get(s.id)}
              />
            ))}
          </VStack>
        )}
      </Box>

      <CreatePeriodDialog
        open={newPeriodOpen}
        onClose={() => setNewPeriodOpen(false)}
        onCreated={(id) => {
          setNewPeriodOpen(false);
          setPeriod(String(id));
        }}
      />

      <ShareWithParentsDialog
        open={shareOpen}
        onClose={() => setShareOpen(false)}
        toShare={toShare}
        periodLabel={activePeriod?.label ?? ""}
        sharing={sharing}
        onConfirm={handleSharePeriod}
      />
    </ReportShell>
  );
}

function ScholarRow({
  scholar,
  href,
  courseReports,
  wc,
}: {
  scholar: RosterScholar;
  href: string;
  courseReports: { key: string; label: string; status: string; hasContent: boolean }[];
  wc: { status: string; hasContent: boolean } | undefined;
}) {
  // A status dot per report. Course narratives float left; the whole-child dot
  // is pinned far right (just before the caret) so every row's WC dot lines up.
  const courseDots = courseReports.map((r) => ({
    key: r.key,
    label: r.label,
    state: reportSectionState(r.status, r.hasContent),
  }));
  const wcState = wc ? reportSectionState(wc.status, wc.hasContent) : ("empty" as const);
  const sharedCount =
    courseReports.filter((r) => reportShared(r.status)).length + (wc && reportShared(wc.status) ? 1 : 0);

  return (
    <Link href={href} style={{ textDecoration: "none" }}>
      <Flex align="center" gap={3} bg="white" borderRadius="lg" px={4} py={3} borderWidth="1px" borderColor="gray.100" _hover={{ borderColor: "violet.200", shadow: "xs" }} cursor="pointer">
        <Avatar name={scholar.name} src={scholar.image ?? undefined} colorKey={scholar.id} size="sm" />
        <Text fontFamily="heading" fontWeight="700" fontSize="sm" color="navy.600" truncate flex={1} minW={0}>
          {scholar.name}
        </Text>
        {/* Right group, in order: [shared tag] | [course dots] | [whole-child dot].
            The WC dot is pinned rightmost so it aligns down the column. */}
        <HStack gap={2} flexShrink={0}>
          <SharedCountTag count={sharedCount} />
          {sharedCount > 0 && <RowDivider />}
          {courseDots.length > 0 && (
            <HStack gap={1.5}>
              {courseDots.map((d) => (
                <Box key={d.key} as="span" display="inline-flex" alignItems="center" title={d.label}>
                  <SectionStatusIcon state={d.state} size={13} />
                </Box>
              ))}
            </HStack>
          )}
          {courseDots.length > 0 && <RowDivider />}
          <Box as="span" display="inline-flex" alignItems="center" title="Whole Child">
            <SectionStatusIcon state={wcState} size={13} />
          </Box>
        </HStack>
        <CaretRight color="var(--chakra-colors-charcoal-300)" />
      </Flex>
    </Link>
  );
}

function RowDivider() {
  return <Box w="1px" h="14px" bg="gray.200" flexShrink={0} />;
}

function PeriodTabs({
  periods,
  activePeriodId,
  onSelect,
  onNewPeriod,
}: {
  periods: { _id: Id<"reportingPeriods">; label: string }[];
  activePeriodId: Id<"reportingPeriods"> | null;
  onSelect: (id: string) => void;
  onNewPeriod: () => void;
}) {
  return (
    <HStack gap={1} bg="gray.100" p={1} borderRadius="lg" display="inline-flex">
      {periods.map((p) => {
        const active = !!activePeriodId && String(p._id) === String(activePeriodId);
        return (
          <Box
            as="button"
            key={String(p._id)}
            onClick={() => onSelect(String(p._id))}
            aria-current={active ? "true" : undefined}
            px={3}
            py={1}
            borderRadius="md"
            fontFamily="heading"
            fontWeight="700"
            fontSize="xs"
            whiteSpace="nowrap"
            bg={active ? "white" : "transparent"}
            color={active ? "violet.700" : "charcoal.500"}
            shadow={active ? "xs" : "none"}
            _hover={{ bg: active ? "white" : "gray.200" }}
            cursor="pointer"
          >
            {p.label}
          </Box>
        );
      })}
      <Menu.Root>
        <Menu.Trigger asChild>
          <IconButton aria-label="Period options" size="xs" variant="ghost" color="charcoal.400" _hover={{ bg: "gray.200" }} borderRadius="md">
            <DotsThree weight="bold" />
          </IconButton>
        </Menu.Trigger>
        <Portal>
          <Menu.Positioner>
            <Menu.Content>
              <Menu.Item value="new" cursor="pointer" onClick={onNewPeriod}>
                <Plus /> New reporting period
              </Menu.Item>
            </Menu.Content>
          </Menu.Positioner>
        </Portal>
      </Menu.Root>
    </HStack>
  );
}

function ShareWithParentsDialog({
  open,
  onClose,
  toShare,
  periodLabel,
  sharing,
  onConfirm,
}: {
  open: boolean;
  onClose: () => void;
  toShare: { _id: Id<"courseNarratives">; scholarName: string; subject: string }[];
  periodLabel: string;
  sharing: boolean;
  onConfirm: () => void;
}) {
  const n = toShare.length;
  return (
    <Dialog.Root
      open={open}
      onOpenChange={(d) => !d.open && !sharing && onClose()}
      placement="center"
      motionPreset="slide-in-bottom"
    >
      <Portal>
        <Dialog.Backdrop />
        <Dialog.Positioner>
          <StyledDialogContent maxW="md">
            <Dialog.Header px={6} pt={6} pb={2}>
              <Stack gap={0} flex={1} minW={0}>
                <Text fontSize="xs" color="charcoal.400" fontFamily="heading" fontWeight="600" textTransform="uppercase" letterSpacing="0.05em">
                  Publish to parents
                </Text>
                <Heading size="md" color="navy.500" fontFamily="heading" fontWeight="700">
                  Publish {n} report{n === 1 ? "" : "s"} to families?
                </Heading>
              </Stack>
              <Dialog.CloseTrigger asChild>
                <IconButton aria-label="Close" size="sm" variant="ghost" color="charcoal.400" _hover={{ bg: "gray.100" }} disabled={sharing}>
                  <X />
                </IconButton>
              </Dialog.CloseTrigger>
            </Dialog.Header>
            <Dialog.Body px={6} pb={6}>
              <Stack gap={4}>
                <Text fontSize="sm" color="charcoal.500" fontFamily="body">
                  These finalized course narratives for {periodLabel} will be published to the
                  parent portal and become visible to families. Drafts are not published, and this
                  can&apos;t be unpublished from here.
                </Text>
                {n === 0 ? (
                  <Text fontSize="sm" color="charcoal.400" fontFamily="heading">
                    No finalized reports to publish yet.
                  </Text>
                ) : (
                  <Stack gap={1.5} maxH="240px" overflowY="auto">
                    {toShare.map((r) => (
                      <HStack key={String(r._id)} justify="space-between" px={3} py={2} borderWidth="1px" borderColor="gray.100" borderRadius="md">
                        <Text fontSize="sm" fontFamily="heading" fontWeight="600" color="navy.600">
                          {r.scholarName}
                        </Text>
                        <Text fontSize="xs" color="charcoal.400" fontFamily="body">
                          {r.subject}
                        </Text>
                      </HStack>
                    ))}
                  </Stack>
                )}
                <Flex justify="flex-end" gap={2} pt={1}>
                  <Button variant="ghost" size="sm" fontFamily="heading" onClick={onClose} disabled={sharing}>
                    Cancel
                  </Button>
                  <Button size="sm" colorPalette="violet" fontFamily="heading" onClick={onConfirm} loading={sharing} disabled={n === 0}>
                    <ShareNetwork size={14} style={{ marginRight: 4 }} /> Publish to parents
                  </Button>
                </Flex>
              </Stack>
            </Dialog.Body>
          </StyledDialogContent>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
}
