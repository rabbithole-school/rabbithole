"use client";

/**
 * Per-scholar reporting detail (scholar-first IA).
 *
 * Everything for ONE scholar in a reporting period on one page:
 *   • Parent reports — one prose report per class (every class on the
 *     scholar's own timetable, and any other class they worked in this
 *     period), plus SEL. Each
 *     can be drafted from the record, then edited and published.
 *   • Interim check-in — the mid-term form (its family goals feed the reports).
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
import { CaretRight, ClipboardText, NotePencil, Plus, Sparkle, X } from "@phosphor-icons/react";
import { api } from "@/convex/_generated/api";
import type { Doc, Id } from "@/convex/_generated/dataModel";
import { INTERIM_ITEM_KEYS, interimHasContent, interimRatedCount } from "@/convex/lib/interimCheckinTemplate";
import {
  ENRICHMENT_TITLE,
  findPlaceholders,
  isEnrichmentSubject,
  isDrafting,
  reportBody,
  reportTitle,
  subjectKey,
} from "@/convex/lib/parentReport";
import { useNow } from "@/hooks/useNow";
import { Avatar } from "@/components/Avatar";
import { StyledDialogContent } from "@/components/ui/StyledDialogContent";
import { useScholarRoster } from "@/hooks/useScholarRoster";
import { ReportShell } from "@/components/narrative/ReportShell";
import { SectionStatusIcon } from "@/components/narrative/SectionStatusIcon";
import { reportSectionState, SharedTag } from "@/components/narrative/reportStatus";
import { toaster } from "@/lib/toaster";
import { serverErrorMessage } from "@/lib/serverErrorMessage";
import { useActiveInstitution } from "@/hooks/useActiveInstitution";

export function ScholarReportDetail({
  scholarId,
  periodParam,
}: {
  scholarId: Id<"users">;
  periodParam: string | null;
}) {
  const router = useRouter();
  const { scopeParam, hrefWithActiveInstitution } = useActiveInstitution();
  const current = useQuery(api.reportingPeriods.current, { scope: scopeParam });
  const periods = useQuery(api.reportingPeriods.list, { scope: scopeParam });

  const activePeriod = periods
    ? (periodParam && periods.find((p) => String(p._id) === periodParam)) || current || periods[0] || null
    : (current ?? undefined);
  const periodId = (activePeriod?._id ?? null) as Id<"reportingPeriods"> | null;

  const { scholars, isLoading: rosterLoading } = useScholarRoster();
  const scholar = scholars.find((s) => s.id === String(scholarId));

  const allNarratives = useQuery(api.courseNarratives.listForScholar, { scholarId });
  const subjects = useQuery(
    api.parentReports.subjectsForScholarPeriod,
    periodId ? { scholarId, periodId } : "skip",
  );
  const checkin = useQuery(
    api.interimCheckins.getForScholarPeriod,
    periodId ? { scholarId, periodId } : "skip",
  );

  const requestDraft = useMutation(api.parentReports.requestDraft);
  const now = useNow(15_000);
  const draftAll = useMutation(api.parentReports.draftAllForScholar);
  const [addOpen, setAddOpen] = useState(false);
  const [busySubject, setBusySubject] = useState<string | null>(null);
  const [draftingAll, setDraftingAll] = useState(false);

  const backHref = hrefWithActiveInstitution(`/teacher/report${periodId ? `?period=${String(periodId)}` : ""}`);
  const withPeriod = (suffix: string) =>
    hrefWithActiveInstitution(
      `/teacher/report/${String(scholarId)}${suffix}${periodId ? `${suffix.includes("?") ? "&" : "?"}period=${String(periodId)}` : ""}`,
    );

  const narratives = (allNarratives ?? []).filter((n) => !periodId || String(n.periodId) === String(periodId));
  const loading =
    periods === undefined ||
    rosterLoading ||
    allNarratives === undefined ||
    (periodId !== null && (checkin === undefined || subjects === undefined));

  // The rows come from the server, already paired with their reports (classes
  // A to Z, then SEL, then names a teacher typed). A class with no work this
  // term (`hasEvidence: false`) is never drafted: "Draft all" skips it and a
  // single draft is refused, so it is offered for writing by hand instead.
  const byId = new Map(narratives.map((n) => [String(n._id), n]));
  const rows: {
    subject: string;
    hasEvidence: boolean;
    autoDraft: boolean;
    leftover: boolean;
    narrative: Doc<"courseNarratives"> | null;
  }[] =
    (subjects?.rows ?? []).map((r) => ({
      subject: r.subject,
      hasEvidence: r.hasEvidence,
      autoDraft: r.autoDraft,
      leftover: r.leftover,
      narrative: r.narrativeId ? (byId.get(String(r.narrativeId)) ?? null) : null,
    }));
  // The reports "Draft all" will actually draft, by the server's own rule.
  const undrafted = rows.filter(
    (r) =>
      r.autoDraft &&
      r.hasEvidence &&
      (!r.narrative ||
        (r.narrative.status !== "shared" && !reportBody(r.narrative.sections).trim() && !isDrafting(r.narrative, now))),
  ).length;
  const [writing, setWriting] = useState<string | null>(null);

  const handleDraftOne = async (subject: string) => {
    if (!periodId) return;
    setBusySubject(subject);
    try {
      const id = await requestDraft({ scholarId, periodId, subject });
      router.push(withPeriod(`?n=${String(id)}`));
    } catch (e) {
      toaster.error({ title: "Couldn't start the draft", description: serverErrorMessage(e) });
    } finally {
      setBusySubject(null);
    }
  };

  const handleDraftAll = async () => {
    if (!periodId) return;
    setDraftingAll(true);
    try {
      const res = await draftAll({ scholarId, periodId });
      // The enrichment row is listed at once; its lines are then written for parents.
      const drafting = res.scheduled > 0 ? `Drafting ${res.scheduled} report${res.scheduled === 1 ? "" : "s"}` : "";
      const filled = res.filled > 0 ? `${drafting ? " and" : "Writing"} ${ENRICHMENT_TITLE}` : "";
      toaster.success({ title: `${drafting}${filled}` || "Nothing to draft" });
    } catch (e) {
      toaster.error({ title: "Couldn't start the drafts", description: e instanceof Error ? e.message : String(e) });
    } finally {
      setDraftingAll(false);
    }
  };

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

            <SectionCard
              title="Reports for parents"
              icon={<NotePencil size={15} weight="fill" />}
              action={
                <HStack gap={2}>
                  <Button size="sm" variant="ghost" colorPalette="violet" fontFamily="heading" onClick={() => setAddOpen(true)} disabled={!periodId}>
                    <Plus size={12} /> Add class
                  </Button>
                  {undrafted > 0 && (
                    <Button size="sm" colorPalette="violet" fontFamily="heading" onClick={handleDraftAll} loading={draftingAll} disabled={!periodId}>
                      <Sparkle size={12} /> Draft {undrafted === 1 ? "1 report" : `all ${undrafted}`}
                    </Button>
                  )}
                </HStack>
              }
            >
              <Text fontSize="sm" color="charcoal.400" fontFamily="body" mb={3}>
                One report per class on {scholar.name.split(" ")[0]}&apos;s timetable, and any other class they worked in this
                period, plus SEL. Drafts come from the
                record and the family&apos;s goals; you edit and publish.
              </Text>
              {subjects?.recentOnly && (
                <Text fontSize="xs" color="charcoal.400" fontFamily="body" mb={3}>
                  Showing the most recent work: {scholar.name.split(" ")[0]} has more sessions this term than one page reads.
                </Text>
              )}
              <VStack align="stretch" gap={2}>
                {rows.map(({ subject, hasEvidence, leftover, narrative: n }) => {
                  if (!n && !hasEvidence) {
                    return (
                      <Flex key={subject} align="center" gap={2.5} bg="gray.50" borderRadius="md" px={3} py={2} borderWidth="1px" borderColor="gray.100">
                        <SectionStatusIcon state="empty" size={15} />
                        <Box flex={1} minW={0}>
                          <Text fontFamily="heading" fontWeight="600" fontSize="sm" color="navy.600">
                            {reportTitle(subject)}
                          </Text>
                          <Text fontSize="xs" color="charcoal.400" fontFamily="body">
                            {isEnrichmentSubject(subject)
                              ? "Nothing to list yet: no project worked on in more than one session."
                              : "No work in Rabbithole for this class yet."}
                          </Text>
                        </Box>
                        <Text fontSize="sm" color="charcoal.400" fontFamily="heading">
                          Not started
                        </Text>
                        <Button
                          size="xs"
                          variant="outline"
                          colorPalette="violet"
                          fontFamily="heading"
                          fontSize="sm"
                          onClick={() => setWriting(subject)}
                          disabled={!periodId}
                        >
                          <NotePencil size={12} /> Write
                        </Button>
                      </Flex>
                    );
                  }
                  if (!n) {
                    return (
                      <Flex key={subject} align="center" gap={2.5} bg="gray.50" borderRadius="md" px={3} py={2} borderWidth="1px" borderColor="gray.100">
                        <SectionStatusIcon state="empty" size={15} />
                        <Text flex={1} fontFamily="heading" fontWeight="600" fontSize="sm" color="navy.600">
                          {reportTitle(subject)}
                        </Text>
                        <Text fontSize="sm" color="charcoal.400" fontFamily="heading">
                          Not started
                        </Text>
                        <Button
                          size="xs"
                          variant="outline"
                          colorPalette="violet"
                          fontFamily="heading"
                          fontSize="sm"
                          onClick={() => handleDraftOne(subject)}
                          loading={busySubject === subject}
                          disabled={!periodId || busySubject !== null}
                        >
                          <Sparkle size={12} /> Draft
                        </Button>
                      </Flex>
                    );
                  }
                  const body = reportBody(n.sections);
                  const placeholders = findPlaceholders(body).length;
                  const hasContent = body.trim().length > 0 || n.sections.some((s) => s.body.trim().length > 0);
                  return (
                    <Link key={String(n._id)} href={withPeriod(`?n=${String(n._id)}`)} style={{ textDecoration: "none" }}>
                      <Flex align="center" gap={2.5} bg="gray.50" borderRadius="md" px={3} py={2.5} borderWidth="1px" borderColor="gray.100" _hover={{ borderColor: "violet.200", bg: "white" }} cursor="pointer">
                        <SectionStatusIcon state={reportSectionState(n.status, hasContent)} size={15} />
                        <Box flex={1} minW={0}>
                          <Text fontFamily="heading" fontWeight="600" fontSize="sm" color="navy.600">
                            {reportTitle(n.subject)}
                          </Text>
                          {leftover && (
                            <Text fontSize="xs" color="charcoal.400" fontFamily="body">
                              {n.status === "shared"
                                ? "A second report for this class. Parents see both."
                                : "A second report for this class. Parents won’t see it."}
                            </Text>
                          )}
                        </Box>
                        {isDrafting(n, now) ? (
                          <HStack gap={1.5}>
                            <Spinner size="xs" color="violet.500" />
                            <Text fontSize="sm" color="charcoal.500" fontFamily="heading">Drafting…</Text>
                          </HStack>
                        ) : placeholders > 0 ? (
                          <Text fontSize="sm" fontFamily="heading" color="charcoal.600">
                            <Box as="span" bg="yellow.200" px={1.5} borderRadius="sm" mr={1}>{placeholders}</Box>
                            to fill
                          </Text>
                        ) : null}
                        <SharedTag status={n.status} />
                        <CaretRight size={13} color="var(--chakra-colors-charcoal-300)" />
                      </Flex>
                    </Link>
                  );
                })}
              </VStack>
            </SectionCard>

            {/* Interim check-in */}
            <SectionCard title="Interim check-in" icon={<ClipboardText size={15} weight="fill" />}>
              {!periodId ? null : checkin ? (
                <Link href={withPeriod("?ic=1")} style={{ textDecoration: "none" }}>
                  <Flex align="center" gap={2.5} bg="gray.50" borderRadius="md" px={3} py={2.5} borderWidth="1px" borderColor="gray.100" _hover={{ borderColor: "violet.200", bg: "white" }} cursor="pointer">
                    <SectionStatusIcon
                      state={reportSectionState(checkin.status, interimHasContent(checkin))}
                      size={15}
                    />
                    <Text flex={1} fontFamily="heading" fontWeight="600" fontSize="sm" color="navy.600">
                      Interim check-in
                    </Text>
                    <Text fontSize="xs" color="charcoal.400" fontFamily="body">
                      {interimRatedCount(checkin.ratings)} of {INTERIM_ITEM_KEYS.length} rated
                    </Text>
                    <CaretRight size={13} color="var(--chakra-colors-charcoal-300)" />
                  </Flex>
                </Link>
              ) : (
                <Flex align="center" justify="space-between" gap={3} py={1}>
                  <Text fontSize="sm" color="charcoal.400" fontFamily="body">
                    Not started. One per scholar each term.
                  </Text>
                  <Button asChild size="xs" colorPalette="violet">
                    <Link href={withPeriod("?ic=1")}>
                      <Plus size={12} style={{ marginRight: 4 }} /> Start interim check-in
                    </Link>
                  </Button>
                </Flex>
              )}
            </SectionCard>
          </>
        )}
      </Box>

      {periodId && (
        <WriteReportDialog
          subject={writing}
          onClose={() => setWriting(null)}
          scholarId={scholarId}
          periodId={periodId}
          onSaved={(id) => {
            setWriting(null);
            router.push(withPeriod(`?n=${String(id)}`));
          }}
        />
      )}

      {periodId && (
        <AddNarrativeDialog
          open={addOpen}
          onClose={() => setAddOpen(false)}
          scholarId={scholarId}
          periodId={periodId}
          existingSubjects={rows.map((r) => subjectKey(r.subject))}
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

/**
 * Write a class report by hand when there is nothing to draft from. Nothing is
 * created until the teacher saves, and Save is ONE mutation (`open` with the
 * body), so a failed save leaves no empty row. Closing with text typed asks
 * first, with the same inline confirm the composer uses before a redraft. The
 * Dialog stays mounted and the form remounts per open (the body-lock rule in
 * engineering-principles.md).
 */
function WriteReportDialog({
  subject,
  onClose,
  scholarId,
  periodId,
  onSaved,
}: {
  subject: string | null;
  onClose: () => void;
  scholarId: Id<"users">;
  periodId: Id<"reportingPeriods">;
  onSaved: (narrativeId: Id<"courseNarratives">) => void;
}) {
  const [dirty, setDirty] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const close = () => {
    setDirty(false);
    setConfirming(false);
    onClose();
  };
  const requestClose = () => (dirty ? setConfirming(true) : close());
  return (
    <Dialog.Root
      open={subject !== null}
      onOpenChange={(d) => !d.open && requestClose()}
      placement="center"
      motionPreset="slide-in-bottom"
    >
      <Portal>
        <Dialog.Backdrop />
        <Dialog.Positioner>
          <StyledDialogContent maxW="lg">
            {subject !== null && (
              <WriteReportForm
                subject={subject}
                scholarId={scholarId}
                periodId={periodId}
                confirming={confirming}
                onDirtyChange={setDirty}
                onRequestClose={requestClose}
                onDiscard={close}
                onKeepWriting={() => setConfirming(false)}
                onSaved={(id) => {
                  setDirty(false);
                  setConfirming(false);
                  onSaved(id);
                }}
              />
            )}
          </StyledDialogContent>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
}

function WriteReportForm({
  subject,
  scholarId,
  periodId,
  confirming,
  onDirtyChange,
  onRequestClose,
  onDiscard,
  onKeepWriting,
  onSaved,
}: {
  subject: string;
  scholarId: Id<"users">;
  periodId: Id<"reportingPeriods">;
  confirming: boolean;
  onDirtyChange: (dirty: boolean) => void;
  onRequestClose: () => void;
  onDiscard: () => void;
  onKeepWriting: () => void;
  onSaved: (narrativeId: Id<"courseNarratives">) => void;
}) {
  const openNarrative = useMutation(api.courseNarratives.open);
  const [body, setBody] = useState("");
  const [saving, setSaving] = useState(false);

  const handleChange = (next: string) => {
    setBody(next);
    onDirtyChange(next.trim().length > 0);
  };

  const handleSave = async () => {
    if (!body.trim()) return;
    setSaving(true);
    try {
      onSaved(await openNarrative({ scholarId, periodId, subject, body }));
    } catch (e) {
      toaster.error({ title: "Couldn't save the report", description: serverErrorMessage(e) });
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <Dialog.Header px={6} pt={6} pb={2}>
        <Stack gap={0} flex={1} minW={0}>
          <Text fontSize="xs" color="charcoal.400" fontFamily="heading" fontWeight="600" textTransform="uppercase" letterSpacing="0.05em">
            Write by hand
          </Text>
          <Heading size="md" color="navy.500" fontFamily="heading" fontWeight="700">
            {reportTitle(subject)}{isEnrichmentSubject(subject) ? "" : " report"}
          </Heading>
        </Stack>
        <IconButton aria-label="Close" size="sm" variant="ghost" color="charcoal.400" _hover={{ bg: "gray.100" }} onClick={onRequestClose}>
          <X />
        </IconButton>
      </Dialog.Header>
      <Dialog.Body px={6} pb={6}>
        <Stack gap={3}>
          <Text fontSize="sm" color="charcoal.400" fontFamily="body">
            No work in Rabbithole for this class yet, so there&apos;s nothing to draft from.
          </Text>
          <textarea
            value={body}
            onChange={(e) => handleChange(e.target.value)}
            placeholder="Write the report for parents…"
            autoFocus
            rows={10}
            style={{ width: "100%", fontSize: 15, lineHeight: 1.7, padding: "12px 14px", borderRadius: 10, border: "1px solid #e2e8f0", fontFamily: "inherit", resize: "vertical" }}
          />
          {confirming ? (
            <Flex justify="flex-end" align="center" gap={2}>
              <Text fontSize="sm" fontFamily="heading" color="charcoal.600">
                Discard what you wrote?
              </Text>
              <Button size="sm" colorPalette="red" variant="outline" fontFamily="heading" onClick={onDiscard}>
                Discard
              </Button>
              <Button size="sm" variant="ghost" fontFamily="heading" onClick={onKeepWriting}>
                Keep writing
              </Button>
            </Flex>
          ) : (
            <Flex justify="flex-end" gap={2}>
              <Button variant="ghost" size="sm" fontFamily="heading" onClick={onRequestClose} disabled={saving}>
                Cancel
              </Button>
              <Button size="sm" colorPalette="violet" fontFamily="heading" onClick={handleSave} loading={saving} disabled={!body.trim()}>
                Save
              </Button>
            </Flex>
          )}
        </Stack>
      </Dialog.Body>
    </>
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
  // The scholar's own classes; a school with no classes on record for the
  // term falls back to the curriculum's unit subjects.
  const classes = useQuery(api.parentReports.classesForScholarPeriod, open ? { scholarId, periodId } : "skip");
  const unitSubjects = useQuery(api.units.subjects, open && classes?.length === 0 ? {} : "skip");
  const subjects = classes && classes.length > 0 ? classes : unitSubjects;
  const openNarrative = useMutation(api.courseNarratives.open);
  const [subject, setSubject] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const handleClose = () => {
    if (submitting) return;
    onClose();
    setSubject("");
  };

  const isDup = existingSubjects.includes(subjectKey(subject));

  const handleStart = async () => {
    if (!subject.trim() || isDup) return;
    setSubmitting(true);
    try {
      const id = await openNarrative({ scholarId, periodId, subject: subject.trim() });
      onOpened(id);
      setSubject("");
    } catch (e) {
      toaster.error({ title: "Couldn't add the report", description: e instanceof Error ? e.message : String(e) });
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
                  New report
                </Text>
                <Heading size="md" color="navy.500" fontFamily="heading" fontWeight="700">
                  Add a class
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
                  placeholder="Math · Science · Humanities…"
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
                    This scholar already has a {subject.trim()} report this period.
                  </Text>
                )}
                <Flex justify="flex-end" gap={2}>
                  <Button variant="ghost" size="sm" fontFamily="heading" onClick={handleClose} disabled={submitting}>
                    Cancel
                  </Button>
                  <Button size="sm" colorPalette="violet" fontFamily="heading" onClick={handleStart} loading={submitting} disabled={!subject.trim() || isDup}>
                    Add report
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
