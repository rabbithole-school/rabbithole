"use client";

/**
 * Per-scholar reporting detail (scholar-first IA).
 *
 * Everything for ONE scholar in a reporting period on one page:
 *   • Course narratives — 0+, one per subject. List + "Add narrative".
 *   • Whole Child report — 0–1. Start / open (the editor is meeting mode).
 *
 * The deep editors (NarrativeComposer, MeetingMode) are reached from here; this
 * is the hub that ties a scholar's two report types together.
 */
import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMutation, useQuery } from "convex/react";
import {
  Box,
  Button,
  Dialog,
  Flex,
  Heading,
  HStack,
  IconButton,
  Portal,
  Spinner,
  Stack,
  Text,
  VStack,
} from "@chakra-ui/react";
import { CaretRight, NotePencil, Plus, UsersThree, X } from "@phosphor-icons/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { Avatar } from "@/components/Avatar";
import { StyledDialogContent } from "@/components/ui/StyledDialogContent";
import { useScholarRoster } from "@/hooks/useScholarRoster";
import { ReportShell } from "@/components/narrative/ReportShell";
import { SectionStatusIcon } from "@/components/narrative/SectionStatusIcon";
import { reportSectionState, SharedTag } from "@/components/narrative/reportStatus";
import { toaster } from "@/lib/toaster";

export function ScholarReportDetail({
  scholarId,
  periodParam,
}: {
  scholarId: Id<"users">;
  periodParam: string | null;
}) {
  const router = useRouter();
  const current = useQuery(api.reportingPeriods.current, {});
  const periods = useQuery(api.reportingPeriods.list, {});

  const activePeriod = periods
    ? (periodParam && periods.find((p) => String(p._id) === periodParam)) || current || periods[0] || null
    : (current ?? undefined);
  const periodId = (activePeriod?._id ?? null) as Id<"reportingPeriods"> | null;

  const { scholars, isLoading: rosterLoading } = useScholarRoster();
  const scholar = scholars.find((s) => s.id === String(scholarId));

  const allNarratives = useQuery(api.courseNarratives.listForScholar, { scholarId });
  const wholeChild = useQuery(
    api.wholeChildNarratives.getForScholarPeriod,
    periodId ? { scholarId, periodId } : "skip",
  );

  const [addOpen, setAddOpen] = useState(false);

  const backHref = `/teacher/report${periodId ? `?period=${String(periodId)}` : ""}`;
  const withPeriod = (suffix: string) =>
    `/teacher/report/${String(scholarId)}${suffix}${periodId ? `${suffix.includes("?") ? "&" : "?"}period=${String(periodId)}` : ""}`;

  const narratives = (allNarratives ?? []).filter((n) => !periodId || String(n.periodId) === String(periodId));
  const loading = periods === undefined || rosterLoading || allNarratives === undefined || (periodId !== null && wholeChild === undefined);

  return (
    <ReportShell
      crumbs={[
        { label: "All scholars", href: backHref },
        { label: scholar?.name ?? "Scholar" },
      ]}
      scholarId={scholarId}
    >
      <Box px={6} pb={6}>

        {loading || !scholar ? (
          <Flex justify="center" py={16}><Spinner size="lg" color="violet.500" /></Flex>
        ) : (
          <>
            <HStack gap={3} mb={5}>
              <Avatar name={scholar.name} src={scholar.image ?? undefined} colorKey={scholarId} size="md" />
              <Box>
                <Heading fontFamily="heading" fontWeight="700" size="lg" color="navy.600">
                  {scholar.name}
                </Heading>
                <Text fontSize="sm" color="charcoal.400" fontFamily="body">
                  {activePeriod?.label ?? "No reporting period"}
                </Text>
              </Box>
            </HStack>

            {/* Course narratives */}
            <SectionCard
              title="Course narratives"
              icon={<NotePencil size={15} weight="fill" />}
              action={
                <Button size="xs" variant="outline" colorPalette="violet" onClick={() => setAddOpen(true)} disabled={!periodId}>
                  <Plus size={12} /> Add narrative
                </Button>
              }
            >
              {narratives.length === 0 ? (
                <Text fontSize="sm" color="charcoal.300" fontFamily="heading" py={3} textAlign="center">
                  No course narratives yet — add one per subject.
                </Text>
              ) : (
                <VStack align="stretch" gap={2}>
                  {narratives.map((n) => {
                    const hasContent =
                      n.sections.some((s) => s.body.trim().length > 0) || n.courseRating != null;
                    return (
                      <Link key={String(n._id)} href={withPeriod(`?n=${String(n._id)}`)} style={{ textDecoration: "none" }}>
                        <Flex align="center" gap={2.5} bg="gray.50" borderRadius="md" px={3} py={2.5} borderWidth="1px" borderColor="gray.100" _hover={{ borderColor: "violet.200", bg: "white" }} cursor="pointer">
                          <SectionStatusIcon state={reportSectionState(n.status, hasContent)} size={15} />
                          <Text flex={1} fontFamily="heading" fontWeight="600" fontSize="sm" color="navy.600">
                            {n.subject}
                          </Text>
                          <SharedTag status={n.status} />
                          <CaretRight size={13} color="var(--chakra-colors-charcoal-300)" />
                        </Flex>
                      </Link>
                    );
                  })}
                </VStack>
              )}
            </SectionCard>

            {/* Whole Child */}
            <SectionCard title="Whole Child report" icon={<UsersThree size={15} weight="fill" />}>
              {!periodId ? null : wholeChild ? (
                <Link href={withPeriod("?wc=1")} style={{ textDecoration: "none" }}>
                  <Flex align="center" gap={2.5} bg="gray.50" borderRadius="md" px={3} py={2.5} borderWidth="1px" borderColor="gray.100" _hover={{ borderColor: "violet.200", bg: "white" }} cursor="pointer">
                    <SectionStatusIcon
                      state={reportSectionState(
                        wholeChild.status,
                        wholeChild.sections.some((s) => s.body.trim().length > 0),
                      )}
                      size={15}
                    />
                    <Text flex={1} fontFamily="heading" fontWeight="600" fontSize="sm" color="navy.600">
                      Whole Child narrative
                    </Text>
                    <SharedTag status={wholeChild.status} />
                    <CaretRight size={13} color="var(--chakra-colors-charcoal-300)" />
                  </Flex>
                </Link>
              ) : (
                <Flex align="center" justify="space-between" gap={3} py={1}>
                  <Text fontSize="sm" color="charcoal.400" fontFamily="body">
                    Not started. One team-authored report per scholar.
                  </Text>
                  <Button asChild size="xs" colorPalette="violet">
                    <Link href={withPeriod("?wc=1")}>
                      <Plus size={12} style={{ marginRight: 4 }} /> Start Whole Child report
                    </Link>
                  </Button>
                </Flex>
              )}
            </SectionCard>
          </>
        )}
      </Box>

      {periodId && (
        <AddNarrativeDialog
          open={addOpen}
          onClose={() => setAddOpen(false)}
          scholarId={scholarId}
          periodId={periodId}
          existingSubjects={narratives.map((n) => n.subject.toLowerCase())}
          onOpened={(id) => {
            setAddOpen(false);
            router.push(withPeriod(`?n=${String(id)}`));
          }}
        />
      )}
    </ReportShell>
  );
}

function SectionCard({
  title,
  icon,
  action,
  children,
}: {
  title: string;
  icon: React.ReactNode;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <Box bg="white" borderRadius="xl" borderWidth="1px" borderColor="gray.100" p={4} mb={4}>
      <Flex align="center" justify="space-between" mb={3}>
        <HStack gap={2} color="violet.600">
          {icon}
          <Text fontFamily="heading" fontWeight="700" fontSize="sm" color="navy.600">
            {title}
          </Text>
        </HStack>
        {action}
      </Flex>
      {children}
    </Box>
  );
}

function AddNarrativeDialog({
  open,
  onClose,
  scholarId,
  periodId,
  existingSubjects,
  onOpened,
}: {
  open: boolean;
  onClose: () => void;
  scholarId: Id<"users">;
  periodId: Id<"reportingPeriods">;
  existingSubjects: string[];
  onOpened: (narrativeId: Id<"courseNarratives">) => void;
}) {
  const subjects = useQuery(api.units.subjects, open ? {} : "skip");
  const openNarrative = useMutation(api.courseNarratives.open);
  const [subject, setSubject] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const handleClose = () => {
    if (submitting) return;
    onClose();
    setSubject("");
  };

  const isDup = existingSubjects.includes(subject.trim().toLowerCase());

  const handleStart = async () => {
    if (!subject.trim() || isDup) return;
    setSubmitting(true);
    try {
      const id = await openNarrative({ scholarId, periodId, subject: subject.trim() });
      onOpened(id);
      setSubject("");
    } catch (e) {
      toaster.error({ title: "Couldn't add narrative", description: e instanceof Error ? e.message : String(e) });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog.Root open={open} onOpenChange={(d) => !d.open && handleClose()} placement="center" motionPreset="slide-in-bottom">
      <Portal>
        <Dialog.Backdrop />
        <Dialog.Positioner>
          <StyledDialogContent maxW="sm">
            <Dialog.Header px={6} pt={6} pb={2}>
              <Stack gap={0} flex={1} minW={0}>
                <Text fontSize="xs" color="charcoal.400" fontFamily="heading" fontWeight="600" textTransform="uppercase" letterSpacing="0.05em">
                  New course narrative
                </Text>
                <Heading size="md" color="navy.500" fontFamily="heading" fontWeight="700">
                  Add a subject
                </Heading>
              </Stack>
              <Dialog.CloseTrigger asChild>
                <IconButton aria-label="Close" size="sm" variant="ghost" color="charcoal.400" _hover={{ bg: "gray.100" }}>
                  <X />
                </IconButton>
              </Dialog.CloseTrigger>
            </Dialog.Header>
            <Dialog.Body px={6} pb={6}>
              <Stack gap={3}>
                <input
                  list="add-narrative-subjects"
                  value={subject}
                  onChange={(e) => setSubject(e.target.value)}
                  placeholder="Mathematics · Science · Humanities…"
                  autoFocus
                  style={{ width: "100%", fontSize: 13, padding: "6px 8px", borderRadius: 8, border: "1px solid #e2e8f0", fontFamily: "inherit" }}
                />
                <datalist id="add-narrative-subjects">
                  {(subjects ?? []).map((s) => (
                    <option key={s} value={s} />
                  ))}
                </datalist>
                {isDup && (
                  <Text fontSize="2xs" color="red.500" fontFamily="body">
                    This scholar already has a {subject.trim()} narrative this period.
                  </Text>
                )}
                <Flex justify="flex-end" gap={2}>
                  <Button variant="ghost" size="sm" fontFamily="heading" onClick={handleClose} disabled={submitting}>
                    Cancel
                  </Button>
                  <Button size="sm" colorPalette="violet" fontFamily="heading" onClick={handleStart} loading={submitting} disabled={!subject.trim() || isDup}>
                    Add narrative
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
