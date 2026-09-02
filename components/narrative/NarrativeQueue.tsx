"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useMutation, useQuery } from "convex/react";
import {
  Badge,
  Box,
  Button,
  Dialog,
  Flex,
  Heading,
  HStack,
  IconButton,
  Portal,
  Progress,
  Spinner,
  Stack,
  Text,
  VStack,
} from "@chakra-ui/react";
import { ArrowSquareOut, CalendarBlank, Plus, ShareNetwork, X } from "@phosphor-icons/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { StyledDialogContent } from "@/components/ui/StyledDialogContent";
import { ReportingViewTabs } from "@/components/ReportingViewTabs";
import { ScholarPicker } from "@/components/ScholarPicker";
import { FieldSelect } from "@/components/ui/FieldSelect";
import { EmptyState } from "@/components/ui/EmptyState";
import { toaster } from "@/lib/toaster";
import { useActiveInstitution } from "@/hooks/useActiveInstitution";

const STATUS_META = {
  draft: { bg: "gray.100", color: "charcoal.500", label: "Draft" },
  final: { bg: "green.50", color: "green.700", label: "Final" },
  shared: { bg: "violet.100", color: "violet.700", label: "Shared" },
} as const;

/**
 * The period queue: the teacher's narratives for the current reporting period
 * ("N of M done"), a picker to start a new narrative, and a "Share all
 * finals" action (review/assessment-and-goals-plan.html §7).
 */
export function NarrativeQueue() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const periodParam = searchParams.get("period");
  const { scopeParam } = useActiveInstitution();

  const current = useQuery(api.reportingPeriods.current, { scope: scopeParam });
  const periods = useQuery(api.reportingPeriods.list, { scope: scopeParam });

  const activePeriod = periods
    ? (periodParam && periods.find((p) => String(p._id) === periodParam)) || current || periods[0] || null
    : (current ?? undefined);
  const activePeriodId = (activePeriod?._id ?? null) as Id<"reportingPeriods"> | null;

  const narratives = useQuery(
    api.courseNarratives.listForPeriod,
    activePeriodId ? { periodId: activePeriodId } : "skip",
  );

  const sharePeriod = useMutation(api.courseNarratives.sharePeriod);
  const [sharing, setSharing] = useState(false);
  const [newOpen, setNewOpen] = useState(false);
  const [newPeriodOpen, setNewPeriodOpen] = useState(false);

  const doneCount = (narratives ?? []).filter((n) => n.status === "final" || n.status === "shared").length;
  const total = narratives?.length ?? 0;

  const handleSharePeriod = async () => {
    if (!activePeriodId) return;
    setSharing(true);
    try {
      const res = await sharePeriod({ periodId: activePeriodId });
      toaster.success({ title: `Shared ${res.shared} narrative${res.shared === 1 ? "" : "s"}` });
    } catch (e) {
      toaster.error({
        title: "Couldn't share the period",
        description: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setSharing(false);
    }
  };

  const setPeriod = (id: string) => {
    const params = new URLSearchParams(searchParams.toString());
    params.set("period", id);
    router.replace(`/teacher/report?${params.toString()}`, { scroll: false });
  };

  return (
    <Box h="full" overflowY="auto" bg="gray.50">
      <Box maxW="900px" mx="auto" p={{ base: 4, md: 6 }}>
        <Box mb={4}>
          <ReportingViewTabs />
        </Box>
        <Flex justify="space-between" align="start" wrap="wrap" gap={3} mb={4}>
          <Box>
            <Text
              fontFamily="heading"
              fontWeight="800"
              fontSize="xs"
              textTransform="uppercase"
              letterSpacing="0.05em"
              color="charcoal.400"
            >
              Course narratives
            </Text>
            <HStack gap={2} mt={0.5} wrap="wrap">
              <Heading fontFamily="heading" fontWeight="700" size="lg" color="navy.600">
                {activePeriod?.label ?? "No reporting period"}
              </Heading>
              {periods && periods.length > 1 && (
                <FieldSelect
                  value={activePeriodId ? String(activePeriodId) : ""}
                  onChange={setPeriod}
                  size="sm"
                  w="auto"
                  fieldProps={{ "aria-label": "Reporting period" }}
                >
                  {periods.map((p) => (
                    <option key={String(p._id)} value={String(p._id)}>
                      {p.label}
                    </option>
                  ))}
                </FieldSelect>
              )}
              <IconButton
                aria-label="New reporting period"
                title="New reporting period"
                size="xs"
                variant="ghost"
                colorPalette="violet"
                onClick={() => setNewPeriodOpen(true)}
              >
                <Plus />
              </IconButton>
            </HStack>
            {activePeriod?.narrativesDueAt && (
              <Text fontSize="xs" color="charcoal.400" fontFamily="body" mt={0.5}>
                Due {new Date(activePeriod.narrativesDueAt).toLocaleDateString()}
              </Text>
            )}
          </Box>
          <HStack gap={2}>
            <Button
              size="sm"
              variant="outline"
              colorPalette="violet"
              onClick={() => setNewOpen(true)}
              disabled={!activePeriodId}
            >
              <Plus size={14} /> New narrative
            </Button>
            <Button
              size="sm"
              colorPalette="violet"
              onClick={handleSharePeriod}
              loading={sharing}
              disabled={!activePeriodId || doneCount === 0}
            >
              <ShareNetwork size={14} /> Share all finals
            </Button>
          </HStack>
        </Flex>

        {total > 0 && (
          <Box mb={4}>
            <HStack justify="space-between" mb={1}>
              <Text fontSize="xs" fontFamily="heading" color="charcoal.500">
                {doneCount} of {total} done
              </Text>
            </HStack>
            <Progress.Root value={total > 0 ? (doneCount / total) * 100 : 0} size="sm" colorPalette="violet">
              <Progress.Track borderRadius="full">
                <Progress.Range borderRadius="full" />
              </Progress.Track>
            </Progress.Root>
          </Box>
        )}

        {periods === undefined ? (
          <Flex justify="center" py={10}>
            <Spinner size="lg" color="violet.500" />
          </Flex>
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
        ) : narratives === undefined ? (
          <Flex justify="center" py={10}>
            <Spinner size="lg" color="violet.500" />
          </Flex>
        ) : narratives.length === 0 ? (
          <Text fontSize="sm" color="charcoal.300" fontFamily="heading" textAlign="center" py={10}>
            No narratives started yet for this period.
          </Text>
        ) : (
          <VStack align="stretch" gap={2}>
            {narratives.map((n) => (
              <Link key={String(n._id)} href={`/teacher/report?n=${String(n._id)}`} style={{ textDecoration: "none" }}>
                <Flex
                  justify="space-between"
                  align="center"
                  bg="white"
                  borderRadius="lg"
                  px={4}
                  py={3}
                  borderWidth="1px"
                  borderColor="gray.100"
                  _hover={{ borderColor: "violet.200", shadow: "xs" }}
                  cursor="pointer"
                >
                  <Box minW={0}>
                    <Text fontFamily="heading" fontWeight="700" fontSize="sm" color="navy.600">
                      {n.scholarName}
                    </Text>
                    <Text fontSize="xs" color="charcoal.400" fontFamily="body">
                      {n.subject}
                    </Text>
                  </Box>
                  <HStack gap={2} flexShrink={0}>
                    <StatusBadge status={n.status} />
                    <ArrowSquareOut size={13} color="#a3aab3" />
                  </HStack>
                </Flex>
              </Link>
            ))}
          </VStack>
        )}
      </Box>

      <NewNarrativeDialog
        open={newOpen}
        onClose={() => setNewOpen(false)}
        periodId={activePeriodId}
        onOpened={(id) => {
          setNewOpen(false);
          router.push(`/teacher/report?n=${String(id)}`);
        }}
      />

      <CreatePeriodDialog
        open={newPeriodOpen}
        onClose={() => setNewPeriodOpen(false)}
        onCreated={(id) => {
          setNewPeriodOpen(false);
          setPeriod(String(id));
        }}
      />
    </Box>
  );
}

function StatusBadge({ status }: { status: keyof typeof STATUS_META }) {
  const s = STATUS_META[status];
  return (
    <Badge
      bg={s.bg}
      color={s.color}
      fontSize="2xs"
      fontFamily="heading"
      fontWeight="700"
      textTransform="uppercase"
      px={2}
      borderRadius="full"
    >
      {s.label}
    </Badge>
  );
}

export function NewNarrativeDialog({
  open,
  onClose,
  periodId,
  onOpened,
}: {
  open: boolean;
  onClose: () => void;
  periodId: Id<"reportingPeriods"> | null;
  onOpened: (narrativeId: Id<"courseNarratives">) => void;
}) {
  const subjects = useQuery(api.units.subjects, open ? {} : "skip");
  const openNarrative = useMutation(api.courseNarratives.open);

  const [scholarId, setScholarId] = useState("");
  const [subject, setSubject] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const reset = () => {
    setScholarId("");
    setSubject("");
  };
  const handleClose = () => {
    if (submitting) return;
    onClose();
    reset();
  };

  const handleStart = async () => {
    if (!periodId || !scholarId || !subject.trim()) return;
    setSubmitting(true);
    try {
      const id = await openNarrative({
        scholarId: scholarId as Id<"users">,
        periodId,
        subject: subject.trim(),
      });
      toaster.success({ title: "Narrative started" });
      onOpened(id);
      reset();
    } catch (e) {
      toaster.error({
        title: "Couldn't start narrative",
        description: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog.Root open={open} onOpenChange={(d) => !d.open && handleClose()} placement="center" motionPreset="slide-in-bottom">
      <Portal>
        <Dialog.Backdrop />
        <Dialog.Positioner>
          <StyledDialogContent maxW="md">
            <Dialog.Header px={6} pt={6} pb={2}>
              <Stack gap={0} flex={1} minW={0}>
                <Text
                  fontSize="xs"
                  color="charcoal.400"
                  fontFamily="heading"
                  fontWeight="600"
                  textTransform="uppercase"
                  letterSpacing="0.05em"
                >
                  New narrative
                </Text>
                <Heading size="md" color="navy.500" fontFamily="heading" fontWeight="700">
                  Start a course narrative
                </Heading>
              </Stack>
              <Dialog.CloseTrigger asChild>
                <IconButton aria-label="Close" size="sm" variant="ghost" color="charcoal.400" _hover={{ bg: "gray.100" }}>
                  <X />
                </IconButton>
              </Dialog.CloseTrigger>
            </Dialog.Header>
            <Dialog.Body px={6} pb={6}>
              <Stack gap={4}>
                <Stack gap={2}>
                  <FieldLabel>Scholar</FieldLabel>
                  <ScholarPicker
                    mode="single"
                    selected={scholarId || null}
                    onChange={(id) => setScholarId(id ?? "")}
                    maxH="240px"
                  />
                </Stack>
                <Stack gap={2}>
                  <FieldLabel>Subject</FieldLabel>
                  <input
                    list="narrative-subjects"
                    value={subject}
                    onChange={(e) => setSubject(e.target.value)}
                    placeholder="Mathematics · Science · Humanities…"
                    style={{
                      width: "100%",
                      fontSize: 13,
                      padding: "6px 8px",
                      borderRadius: 8,
                      border: "1px solid #e2e8f0",
                      fontFamily: "inherit",
                    }}
                  />
                  <datalist id="narrative-subjects">
                    {(subjects ?? []).map((s) => (
                      <option key={s} value={s} />
                    ))}
                  </datalist>
                </Stack>
                <Text fontSize="2xs" color="charcoal.300" fontFamily="body">
                  Units are derived automatically from the scholar&apos;s sessions this period — no need to pick them.
                </Text>

                <Flex justify="flex-end" gap={2} pt={1}>
                  <Button variant="ghost" size="sm" fontFamily="heading" onClick={handleClose} disabled={submitting}>
                    Cancel
                  </Button>
                  <Button
                    size="sm"
                    colorPalette="violet"
                    fontFamily="heading"
                    onClick={handleStart}
                    loading={submitting}
                    disabled={!scholarId || !subject.trim()}
                  >
                    Start narrative
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

/** Sensible default label from today's date, e.g. "Fall 2026". */
function defaultPeriodLabel(d = new Date()): string {
  const m = d.getMonth();
  const season = m <= 1 ? "Winter" : m <= 4 ? "Spring" : m <= 7 ? "Summer" : "Fall";
  return `${season} ${d.getFullYear()}`;
}

/** epoch ms → "YYYY-MM-DD" (local) for a native date input. */
function toDateInput(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** "YYYY-MM-DD" → epoch ms at local midnight (0 if empty/invalid). */
function fromDateInput(s: string): number {
  if (!s) return 0;
  const t = new Date(`${s}T00:00:00`).getTime();
  return Number.isNaN(t) ? 0 : t;
}

const DAY = 86_400_000;

const dateInputStyle: React.CSSProperties = {
  width: "100%",
  fontSize: 13,
  padding: "6px 8px",
  borderRadius: 8,
  border: "1px solid #e2e8f0",
  fontFamily: "inherit",
};

/**
 * Create a reporting period (assessment-and-goals §13). The narrative queue is
 * useless without one, and there was no other UI to make the first period — so
 * any staffer can set one up here. Defaults to an OPEN 4-month window (open =
 * the period you write into, so it immediately becomes `current`).
 */
export function CreatePeriodDialog({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (periodId: Id<"reportingPeriods">) => void;
}) {
  const create = useMutation(api.reportingPeriods.create);

  const [label, setLabel] = useState(defaultPeriodLabel());
  const [startsAt, setStartsAt] = useState(() => toDateInput(Date.now()));
  const [endsAt, setEndsAt] = useState(() => toDateInput(Date.now() + 120 * DAY));
  const [status, setStatus] = useState<"upcoming" | "open" | "writing" | "closed">("open");
  const [submitting, setSubmitting] = useState(false);

  const reset = () => {
    setLabel(defaultPeriodLabel());
    setStartsAt(toDateInput(Date.now()));
    setEndsAt(toDateInput(Date.now() + 120 * DAY));
    setStatus("open");
  };
  const handleClose = () => {
    if (submitting) return;
    onClose();
    reset();
  };

  const startMs = fromDateInput(startsAt);
  const endMs = fromDateInput(endsAt);
  const valid = !!label.trim() && startMs > 0 && endMs > startMs;

  const handleCreate = async () => {
    if (!valid) return;
    setSubmitting(true);
    try {
      const period = await create({
        label: label.trim(),
        startsAt: startMs,
        endsAt: endMs,
        status,
      });
      toaster.success({ title: "Reporting period created" });
      if (period?._id) onCreated(period._id);
      reset();
    } catch (e) {
      toaster.error({
        title: "Couldn't create the period",
        description: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog.Root open={open} onOpenChange={(d) => !d.open && handleClose()} placement="center" motionPreset="slide-in-bottom">
      <Portal>
        <Dialog.Backdrop />
        <Dialog.Positioner>
          <StyledDialogContent maxW="md">
            <Dialog.Header px={6} pt={6} pb={2}>
              <Stack gap={0} flex={1} minW={0}>
                <Text
                  fontSize="xs"
                  color="charcoal.400"
                  fontFamily="heading"
                  fontWeight="600"
                  textTransform="uppercase"
                  letterSpacing="0.05em"
                >
                  Reporting period
                </Text>
                <Heading size="md" color="navy.500" fontFamily="heading" fontWeight="700">
                  New reporting period
                </Heading>
              </Stack>
              <Dialog.CloseTrigger asChild>
                <IconButton aria-label="Close" size="sm" variant="ghost" color="charcoal.400" _hover={{ bg: "gray.100" }}>
                  <X />
                </IconButton>
              </Dialog.CloseTrigger>
            </Dialog.Header>
            <Dialog.Body px={6} pb={6}>
              <Stack gap={4}>
                <Stack gap={2}>
                  <FieldLabel>Label</FieldLabel>
                  <input
                    value={label}
                    onChange={(e) => setLabel(e.target.value)}
                    placeholder="Fall 2026"
                    style={dateInputStyle}
                  />
                </Stack>
                <Flex gap={3}>
                  <Stack gap={2} flex={1}>
                    <FieldLabel>Starts</FieldLabel>
                    <input type="date" value={startsAt} onChange={(e) => setStartsAt(e.target.value)} style={dateInputStyle} />
                  </Stack>
                  <Stack gap={2} flex={1}>
                    <FieldLabel>Ends</FieldLabel>
                    <input type="date" value={endsAt} onChange={(e) => setEndsAt(e.target.value)} style={dateInputStyle} />
                  </Stack>
                </Flex>
                <Stack gap={2}>
                  <FieldLabel>Status</FieldLabel>
                  <FieldSelect
                    value={status}
                    onChange={(v) => setStatus(v as typeof status)}
                    size="sm"
                    fieldProps={{ "aria-label": "Period status" }}
                  >
                    <option value="open">Open (write into this one)</option>
                    <option value="writing">Writing</option>
                    <option value="upcoming">Upcoming</option>
                    <option value="closed">Closed</option>
                  </FieldSelect>
                </Stack>
                {startMs > 0 && endMs > 0 && endMs <= startMs && (
                  <Text fontSize="2xs" color="red.500" fontFamily="body">
                    End date must be after the start date.
                  </Text>
                )}

                <Flex justify="flex-end" gap={2} pt={1}>
                  <Button variant="ghost" size="sm" fontFamily="heading" onClick={handleClose} disabled={submitting}>
                    Cancel
                  </Button>
                  <Button
                    size="sm"
                    colorPalette="violet"
                    fontFamily="heading"
                    onClick={handleCreate}
                    loading={submitting}
                    disabled={!valid}
                  >
                    Create period
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

function FieldLabel({ children }: { children: React.ReactNode }) {
  return (
    <Text
      fontSize="xs"
      color="charcoal.400"
      fontFamily="heading"
      fontWeight="600"
      textTransform="uppercase"
      letterSpacing="0.04em"
    >
      {children}
    </Text>
  );
}
