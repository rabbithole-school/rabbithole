"use client";

/**
 * The parent-report composer: one prose report for one subject (or SEL), for
 * one scholar and period.
 *
 * Left: the evidence the draft is written from — exactly what
 * `parentReports.evidence` hands the model, family goals first — so every
 * sentence in the draft can be checked against the record. Right: the prose,
 * with bracketed placeholders highlighted, a Draft/Redraft button, and the
 * done + publish controls. A report with unfilled placeholders can't be
 * published (enforced server-side in `courseNarratives.share`).
 */
import { useCallback, useMemo, useState } from "react";
import Link from "next/link";
import { useMutation, useQuery } from "convex/react";
import { Box, Button, Flex, Heading, HStack, Spinner, Text, VStack } from "@chakra-ui/react";
import { ArrowsClockwise, CaretLeft, CaretRight, ShareNetwork, Sparkle, X } from "@phosphor-icons/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import {
  isDrafting,
  isEnrichmentSubject,
  isSelSubject,
  reportTitle,
  legacySectionNotes,
  publishBlocker,
  reportBody,
  type ParentReportEvidence,
} from "@/convex/lib/parentReport";
import { toaster } from "@/lib/toaster";
import { serverErrorMessage } from "@/lib/serverErrorMessage";
import { useNow } from "@/hooks/useNow";
import { useActiveInstitution } from "@/hooks/useActiveInstitution";
import { Surface } from "@/components/ui/Surface";
import { EmptyState } from "@/components/ui/EmptyState";
import { ReportShell } from "@/components/narrative/ReportShell";
import { reportDone, reportShared, SharedTag, MarkReportDoneToggle } from "@/components/narrative/reportStatus";
import { ReportProseEditor } from "@/components/narrative/ReportProseEditor";

export function NarrativeComposer({
  narrativeId,
  backHref = "/teacher/report",
  rosterHref = "/teacher/report",
}: {
  narrativeId: Id<"courseNarratives">;
  backHref?: string;
  rosterHref?: string;
}) {
  const narrative = useQuery(api.courseNarratives.get, { narrativeId });
  // The "Enrichment and projects" row is a list filled from the record (its
  // lines then rewritten for parents by the drafter): no evidence pane, no
  // placeholder hint.
  const listRow = narrative ? isEnrichmentSubject(narrative.subject) : false;
  const evidence = useQuery(api.parentReports.evidence, narrative && !listRow ? { narrativeId } : "skip");
  const { hrefWithActiveInstitution } = useActiveInstitution();
  const period = useQuery(api.reportingPeriods.get, narrative ? { periodId: narrative.periodId } : "skip");
  const periodNarratives = useQuery(
    api.courseNarratives.listForPeriod,
    narrative ? { periodId: narrative.periodId } : "skip",
  );

  const setDone = useMutation(api.courseNarratives.setDone);
  const share = useMutation(api.courseNarratives.share);
  const requestDraft = useMutation(api.parentReports.requestDraft);

  const [sharing, setSharing] = useState(false);
  const [confirmRedraft, setConfirmRedraft] = useState(false);
  const [unsaved, setUnsaved] = useState(false);
  const now = useNow(15_000);

  // Prev/next — this teacher's reports in the period, by scholar then subject.
  const sorted = useMemo(
    () =>
      (periodNarratives ?? [])
        .slice()
        .sort((a, b) => a.scholarName.localeCompare(b.scholarName) || a.subject.localeCompare(b.subject)),
    [periodNarratives],
  );
  const position = sorted.findIndex((n) => String(n._id) === String(narrativeId));
  const prevId = position > 0 ? sorted[position - 1]._id : null;
  const nextId = position >= 0 && position < sorted.length - 1 ? sorted[position + 1]._id : null;

  const handleDraft = useCallback(async () => {
    setConfirmRedraft(false);
    try {
      await requestDraft({ narrativeId });
    } catch (e) {
      toaster.error({ title: "Couldn't start the draft", description: serverErrorMessage(e) });
    }
  }, [requestDraft, narrativeId]);

  const handleSetDone = useCallback(
    async (done: boolean) => {
      try {
        await setDone({ narrativeId, done });
      } catch (e) {
        toaster.error({ title: "Couldn't update status", description: e instanceof Error ? e.message : String(e) });
      }
    },
    [setDone, narrativeId],
  );

  const handleShare = useCallback(async () => {
    setSharing(true);
    try {
      await share({ narrativeId });
      toaster.success({ title: "Report published to parents" });
    } catch (e) {
      toaster.error({ title: "Couldn't publish", description: e instanceof Error ? e.message : String(e) });
    } finally {
      setSharing(false);
    }
  }, [share, narrativeId]);

  if (narrative === undefined) {
    return (
      <Flex h="full" align="center" justify="center">
        <Spinner size="lg" color="violet.500" />
      </Flex>
    );
  }
  if (narrative === null) {
    return (
      <Flex h="full" align="center" justify="center" direction="column" gap={2}>
        <Text color="charcoal.400" fontFamily="heading">
          Report not found.
        </Text>
        <Link href={backHref}>
          <Text color="violet.600" fontSize="sm">
            ‹ Reports
          </Text>
        </Link>
      </Flex>
    );
  }

  const siblingHref = (id: Id<"courseNarratives">) =>
    hrefWithActiveInstitution(`/teacher/report?n=${String(id)}&period=${String(narrative.periodId)}`);

  const body = reportBody(narrative.sections);
  const legacyNotes = legacySectionNotes(narrative.sections);
  const drafting = isDrafting(narrative, now);
  const shared = reportShared(narrative.status);
  const blocker = publishBlocker(narrative.sections);
  const title = isSelSubject(narrative.subject) ? "SEL" : reportTitle(narrative.subject);

  return (
    <ReportShell
      crumbs={[
        { label: "All scholars", href: rosterHref },
        { label: narrative.scholarName, href: backHref },
        { label: title },
      ]}
      scholarId={narrative.scholarId}
      actions={
        <HStack gap={1}>
          {prevId && (
            <Button asChild size="sm" variant="outline" fontFamily="heading">
              <Link href={siblingHref(prevId)} aria-label="Previous report">
                <CaretLeft />
              </Link>
            </Button>
          )}
          {position >= 0 && (
            <Text fontSize="sm" color="charcoal.400" fontFamily="heading" whiteSpace="nowrap" px={1}>
              {position + 1} of {sorted.length}
            </Text>
          )}
          {nextId && (
            <Button asChild size="sm" variant="outline" fontFamily="heading">
              <Link href={siblingHref(nextId)} aria-label="Next report">
                <CaretRight />
              </Link>
            </Button>
          )}
        </HStack>
      }
    >
      <Box px={6} pb={3}>
        <Flex justify="space-between" align="center" gap={3} wrap="wrap">
          <Box>
            <Heading fontFamily="heading" fontWeight="700" size="lg" color="navy.600">
              {narrative.scholarName} · {title}
            </Heading>
            <HStack gap={2.5} align="center" wrap="wrap" mt={0.5}>
              <Text fontSize="sm" color="charcoal.400" fontFamily="heading">
                {period?.label ?? "…"}
              </Text>
              <SharedTag status={narrative.status} />
            </HStack>
          </Box>
          <HStack gap={3} wrap="wrap">
            <MarkReportDoneToggle
              done={reportDone(narrative.status)}
              onToggle={handleSetDone}
              disabled={shared}
              label="Mark as done"
            />
            <Button
              size="sm"
              colorPalette="violet"
              fontFamily="heading"
              onClick={handleShare}
              loading={sharing}
              disabled={shared || !reportDone(narrative.status) || blocker !== null || unsaved}
              title={
                shared
                  ? undefined
                  : (blocker ??
                    (unsaved ? "Saving your edits…" : reportDone(narrative.status) ? undefined : "Mark the report done first"))
              }
            >
              <ShareNetwork style={{ marginRight: 4 }} />
              {shared ? "Published to parents" : "Publish to parents"}
            </Button>
          </HStack>
        </Flex>
      </Box>

      <Box px={6} pb={6}>
        <Flex gap={4} align="stretch" wrap="wrap">
          {!listRow && (
            <Surface flex="1 1 360px" minW="300px" p={4}>
              <EvidencePane evidence={evidence} />
            </Surface>
          )}

          <Surface flex="1.4 1 440px" minW="320px" p={4}>
            <Flex justify="space-between" align="center" gap={3} mb={3} wrap="wrap">
              <Heading size="md" color="navy.600" fontFamily="heading">
                Report for parents
              </Heading>
              {!shared &&
                (drafting ? (
                  <HStack gap={2}>
                    <Spinner size="sm" color="violet.500" />
                    <Text fontSize="sm" fontFamily="heading" color="charcoal.500">
                      Drafting…
                    </Text>
                  </HStack>
                ) : evidence?.draftBlocked ? (
                  // A second report in the class's slot, or a class with no
                  // work: the server refuses a draft, so none is offered.
                  <Text fontSize="sm" fontFamily="body" color="charcoal.400" maxW="sm" textAlign="right">
                    {evidence.draftBlocked}
                  </Text>
                ) : confirmRedraft ? (
                  <HStack gap={2}>
                    <Text fontSize="sm" fontFamily="heading" color="charcoal.600">
                      Replace the current text?
                    </Text>
                    <Button size="sm" colorPalette="violet" fontFamily="heading" disabled={unsaved} onClick={handleDraft}>
                      Redraft
                    </Button>
                    <Button size="sm" variant="ghost" fontFamily="heading" onClick={() => setConfirmRedraft(false)}>
                      Cancel
                    </Button>
                  </HStack>
                ) : body.trim() ? (
                  <Button
                    size="sm"
                    variant="outline"
                    fontFamily="heading"
                    disabled={unsaved}
                    title={unsaved ? "Saving your edits…" : undefined}
                    onClick={() => setConfirmRedraft(true)}
                  >
                    <ArrowsClockwise style={{ marginRight: 4 }} /> Redraft
                  </Button>
                ) : (
                  <Button size="sm" colorPalette="violet" fontFamily="heading" disabled={unsaved} onClick={handleDraft}>
                    <Sparkle style={{ marginRight: 4 }} /> Draft from the record
                  </Button>
                ))}
            </Flex>
            {narrative.draftError && !drafting && (
              <Text fontSize="sm" color="red.600" fontFamily="body" mb={3}>
                The last draft didn&apos;t finish ({narrative.draftError}). Try again, or write the report by hand.
              </Text>
            )}
            {!listRow && (
              <Text fontSize="sm" color="charcoal.400" fontFamily="body" mb={3}>
                Highlighted [brackets] mark details the record doesn&apos;t hold. Replace each one, or delete it, before
                publishing.
              </Text>
            )}
            <ReportProseEditor
              narrativeId={narrative._id}
              initialBody={body}
              readOnly={drafting}
              published={shared}
              onUnsavedChange={setUnsaved}
            />
            <ReportPieces narrativeId={narrative._id} />

            {legacyNotes.length > 0 && (
              <Box mt={5} pt={4} borderTopWidth="1px" borderColor="gray.100">
                <Text fontFamily="heading" fontWeight="700" fontSize="sm" color="navy.600" mb={1}>
                  Your earlier notes
                </Text>
                <Text fontSize="sm" color="charcoal.400" fontFamily="body" mb={2}>
                  {shared && !body.trim()
                    ? "Written in the old section-by-section form. This report was published that way, so parents see these sections."
                    : "Written in the old section-by-section form. Drafts use them; parents never see them."}
                </Text>
                <VStack align="stretch" gap={2}>
                  {legacyNotes.map((n) => (
                    <Text key={n.title} fontSize="sm" color="charcoal.600" fontFamily="body" whiteSpace="pre-wrap">
                      <b>{n.title}:</b> {n.body}
                    </Text>
                  ))}
                </VStack>
              </Box>
            )}
          </Surface>
        </Flex>
      </Box>
    </ReportShell>
  );
}

const COLLAPSED_ITEMS = 5;

function EvidencePane({ evidence }: { evidence: ParentReportEvidence | null | undefined }) {
  if (evidence === undefined) {
    return (
      <Flex justify="center" py={10}>
        <Spinner color="violet.500" />
      </Flex>
    );
  }
  if (evidence === null) return null;
  const groups = evidence.groups.filter((g) => g.items.length > 0);
  return (
    <VStack align="stretch" gap={4}>
      <Box>
        <Heading size="md" color="navy.600" fontFamily="heading">
          What the draft draws on
        </Heading>
        <Text fontSize="sm" color="charcoal.400" fontFamily="body">
          {evidence.periodLabel}. The draft may only say what is here; everything else becomes a placeholder.
        </Text>
      </Box>
      <EvidenceGroupView
        label="Goals the family shared"
        items={evidence.familyGoals}
        empty="None recorded. Add family goals in the interim check-in, or file conference notes on the scholar's Documents."
      />
      {groups.length === 0 ? (
        <EmptyState title="No evidence this term yet" hint="A draft will be mostly placeholders." />
      ) : (
        groups.map((g) => <EvidenceGroupView key={g.key} label={g.label} items={g.items} />)
      )}
    </VStack>
  );
}

function EvidenceGroupView({ label, items, empty }: { label: string; items: string[]; empty?: string }) {
  const [open, setOpen] = useState(false);
  const shown = open ? items : items.slice(0, COLLAPSED_ITEMS);
  return (
    <Box>
      <Text fontFamily="heading" fontWeight="700" fontSize="sm" color="navy.600" mb={1}>
        {label}
      </Text>
      {items.length === 0 ? (
        <Text fontSize="sm" color="charcoal.400" fontFamily="body">
          {empty}
        </Text>
      ) : (
        <VStack align="stretch" gap={1}>
          {shown.map((item, i) => (
            <Text key={i} fontSize="sm" color="charcoal.600" fontFamily="body" lineHeight="1.5">
              • {item}
            </Text>
          ))}
          {items.length > COLLAPSED_ITEMS && (
            <Button
              size="xs"
              variant="ghost"
              alignSelf="flex-start"
              fontFamily="heading"
              fontSize="sm"
              color="violet.600"
              onClick={() => setOpen((o) => !o)}
            >
              {open ? "Show less" : `Show all ${items.length}`}
            </Button>
          )}
        </VStack>
      )}
    </Box>
  );
}

/**
 * The portfolio pieces listed under the report for the family to open. The
 * drafter picks them; the teacher takes off any that don't belong. A piece
 * the portfolio doesn't share with the family never shows under their report.
 */
function ReportPieces({ narrativeId }: { narrativeId: Id<"courseNarratives"> }) {
  const pieces = useQuery(api.parentReports.reportPieces, { narrativeId });
  const remove = useMutation(api.parentReports.removeReportPiece);
  if (!pieces || pieces.length === 0) return null;
  return (
    <Box mt={4}>
      <Text fontFamily="heading" fontWeight="700" fontSize="sm" color="navy.600" mb={1}>
        Work in this report
      </Text>
      <Text fontSize="sm" color="charcoal.400" fontFamily="body" mb={2}>
        The family can open these from under the report.
      </Text>
      <VStack align="stretch" gap={1}>
        {pieces.map((p) => (
          <HStack key={p.id} gap={2}>
            <Text fontSize="sm" color="charcoal.600" fontFamily="body" flex="1" minW={0}>
              {p.title}
              {!p.familyCanSee && (
                <Text as="span" color="charcoal.400">
                  {" "}
                  · not shared with the family, so it won&apos;t show
                </Text>
              )}
            </Text>
            <Button
              size="xs"
              variant="ghost"
              aria-label={`Take ${p.title} off this report`}
              onClick={() =>
                remove({ narrativeId, pieceId: p.id }).catch((e) =>
                  toaster.error({ title: "Couldn't take that piece off", description: serverErrorMessage(e) }),
                )
              }
            >
              <X />
            </Button>
          </HStack>
        ))}
      </VStack>
    </Box>
  );
}
