"use client";

/**
 * The narrative composer (review/assessment-and-goals-plan.html §7, redesigned
 * 2026-07-02): a convenient way for a teacher to VIEW a scholar's evidence and
 * WRITE a report. AI help (drafting, checking, rating suggestions) was pulled
 * out entirely — that now lives in the curriculum bot's side panel, not baked
 * into this surface. The layout borrows the Whole Child meeting mode's visual
 * language: a header (scholar + subject/period + status + prev/next), a
 * horizontal tab strip (one per report tab), and a clean two-pane body
 * (evidence | authoring) inside rounded white cards, uniform across every tab
 * (components/narrative/BinderPane.tsx's `EvidenceHeader`).
 *
 * Owns every query/mutation for a single narrative; `EvidencePane`/
 * `OverallEvidence` and `WorkingLevelReadout` are pure display,
 * `NarrativeSectionEditor` owns each section's own autosave.
 *
 * Units are no longer teacher-picked — they're derived live from the
 * scholar's sessions this period (`courseNarratives.derivedUnits`) and fed
 * straight into the binder's `unitIds` arg; there is no unit-toggle UI left
 * anywhere in this composer.
 */
import { useCallback, useMemo, useState } from "react";
import Link from "next/link";
import { useMutation, useQuery } from "convex/react";
import { Box, Button, Checkbox, Flex, Heading, HStack, Spinner, Switch, Tabs, Text, VStack } from "@chakra-ui/react";
import { CaretLeft, CaretRight, Check, ShareNetwork } from "@phosphor-icons/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { toaster } from "@/lib/toaster";
import { Surface } from "@/components/ui/Surface";
import { PaneTabs } from "@/components/ui/PaneTabs";
import { RubricSlider } from "@/components/ui/RubricSlider";
import { ReportShell } from "@/components/narrative/ReportShell";
import { SectionStatusIcon, sectionState, type SectionState } from "@/components/narrative/SectionStatusIcon";
import {
  reportDone,
  reportShared,
  SharedTag,
  MarkReportDoneToggle,
} from "@/components/narrative/reportStatus";
import { EvidenceHeader, EvidencePane, OverallEvidence, type SectionKey } from "@/components/narrative/BinderPane";
import { WorkingLevelReadout } from "@/components/narrative/RubricStrip";
import { NarrativeSectionEditor } from "@/components/narrative/NarrativeSectionEditor";
import { PCM_META, type PcmDimension } from "@/convex/lib/pcm";

const TAB_LABELS: Record<SectionKey, string> = {
  context: "Context",
  progress: "Progress",
  dim_core: "Core",
  dim_connections: "Connections",
  dim_practice: "Practice",
  dim_identity: "Identity",
  goals: "Goals",
  overall: "Overall",
  approvals: "Approvals",
};

const TAB_ORDER: SectionKey[] = [
  "context",
  "progress",
  "dim_core",
  "dim_connections",
  "dim_practice",
  "dim_identity",
  "goals",
  "overall",
  "approvals",
];

const SECTIONS: {
  key: Exclude<SectionKey, "overall" | "approvals">;
  title: string;
  dimension?: PcmDimension;
  rows: number;
}[] = [
  { key: "context", title: "Context — what we studied", rows: 3 },
  { key: "progress", title: "Progress & accomplishments", rows: 6 },
  { key: "dim_core", title: "Core", dimension: "core", rows: 6 },
  { key: "dim_connections", title: "Connections", dimension: "connections", rows: 6 },
  { key: "dim_practice", title: "Practice", dimension: "practice", rows: 6 },
  { key: "dim_identity", title: "Identity", dimension: "identity", rows: 6 },
  { key: "goals", title: "Goals for Continued Growth", rows: 4 },
];

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
  const derivedUnits = useQuery(
    api.courseNarratives.derivedUnits,
    narrative
      ? { scholarId: narrative.scholarId, periodId: narrative.periodId, subject: narrative.subject }
      : "skip",
  );
  const binder = useQuery(
    api.assessmentBinder.forScholar,
    narrative && derivedUnits !== undefined
      ? {
          scholarId: narrative.scholarId,
          periodId: narrative.periodId,
          subject: narrative.subject,
          unitIds: derivedUnits.map((u) => u.id),
        }
      : "skip",
  );
  const workingLevel = useQuery(
    api.workingLevel.forScholar,
    narrative ? { scholarId: narrative.scholarId, periodId: narrative.periodId } : "skip",
  );
  const period = useQuery(
    api.reportingPeriods.get,
    narrative ? { periodId: narrative.periodId } : "skip",
  );
  const periodNarratives = useQuery(
    api.courseNarratives.listForPeriod,
    narrative ? { periodId: narrative.periodId } : "skip",
  );

  const setRatings = useMutation(api.courseNarratives.setRatings);
  const setGoals = useMutation(api.courseNarratives.setGoals);
  const toggleSignoff = useMutation(api.courseNarratives.toggleSignoff);
  const setSectionDone = useMutation(api.courseNarratives.setSectionDone);
  const setDone = useMutation(api.courseNarratives.setDone);
  const share = useMutation(api.courseNarratives.share);

  const [activeSection, setActiveSection] = useState<SectionKey>("context");
  const [signingOff, setSigningOff] = useState(false);
  const [sharing, setSharing] = useState(false);

  const acceptedGoalIds = useMemo(
    () => new Set((narrative?.goalIds ?? []).map(String)),
    [narrative?.goalIds],
  );

  // Prev/next scholar nav — this teacher's narratives in the same period,
  // alphabetical by scholar name (the same ordering the roster + Whole Child
  // meeting mode use).
  const sortedPeriodNarratives = useMemo(
    () => (periodNarratives ?? []).slice().sort((a, b) => a.scholarName.localeCompare(b.scholarName)),
    [periodNarratives],
  );
  const positionIndex = sortedPeriodNarratives.findIndex((n) => String(n._id) === String(narrativeId));
  const positionLabel =
    positionIndex >= 0 ? `${positionIndex + 1} of ${sortedPeriodNarratives.length}` : null;
  const prevId = positionIndex > 0 ? sortedPeriodNarratives[positionIndex - 1]._id : null;
  const nextId =
    positionIndex >= 0 && positionIndex < sortedPeriodNarratives.length - 1
      ? sortedPeriodNarratives[positionIndex + 1]._id
      : null;

  const toggleGoal = useCallback(
    async (goalId: Id<"scholarGoals">) => {
      if (!narrative) return;
      const current = new Set(narrative.goalIds.map(String));
      if (current.has(String(goalId))) current.delete(String(goalId));
      else current.add(String(goalId));
      try {
        await setGoals({ narrativeId: narrative._id, goalIds: [...current] as Id<"scholarGoals">[] });
      } catch (e) {
        toaster.error({
          title: "Couldn't update goals",
          description: e instanceof Error ? e.message : String(e),
        });
      }
    },
    [narrative, setGoals],
  );

  const handleSectionDone = useCallback(
    async (key: string, title: string, done: boolean) => {
      if (!narrative) return;
      try {
        await setSectionDone({ narrativeId: narrative._id, key, done, title });
      } catch (e) {
        toaster.error({
          title: "Couldn't update status",
          description: e instanceof Error ? e.message : String(e),
        });
      }
    },
    [narrative, setSectionDone],
  );

  const setDimensionRating = useCallback(
    async (dim: PcmDimension, value: number) => {
      if (!narrative) return;
      try {
        await setRatings({
          narrativeId: narrative._id,
          pcmRatings: { ...(narrative.pcmRatings ?? {}), [dim]: value },
          courseRating: narrative.courseRating,
        });
      } catch (e) {
        toaster.error({
          title: "Couldn't save rating",
          description: e instanceof Error ? e.message : String(e),
        });
      }
    },
    [narrative, setRatings],
  );

  const setCourseRating = useCallback(
    async (value: number) => {
      if (!narrative) return;
      try {
        await setRatings({
          narrativeId: narrative._id,
          pcmRatings: narrative.pcmRatings ?? {},
          courseRating: value,
        });
      } catch (e) {
        toaster.error({
          title: "Couldn't save the Course Performance Rating",
          description: e instanceof Error ? e.message : String(e),
        });
      }
    },
    [narrative, setRatings],
  );

  const handleToggleSignoff = useCallback(async () => {
    if (!narrative) return;
    setSigningOff(true);
    try {
      await toggleSignoff({ narrativeId: narrative._id });
    } catch (e) {
      toaster.error({
        title: "Couldn't update signoff",
        description: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setSigningOff(false);
    }
  }, [narrative, toggleSignoff]);

  const handleSetDone = useCallback(
    async (done: boolean) => {
      if (!narrative) return;
      try {
        await setDone({ narrativeId: narrative._id, done });
      } catch (e) {
        toaster.error({
          title: "Couldn't update status",
          description: e instanceof Error ? e.message : String(e),
        });
      }
    },
    [setDone, narrative],
  );

  const handleShare = useCallback(async () => {
    if (!narrative) return;
    setSharing(true);
    try {
      await share({ narrativeId: narrative._id });
      toaster.success({ title: "Narrative published" });
    } catch (e) {
      toaster.error({
        title: "Couldn't publish",
        description: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setSharing(false);
    }
  }, [share, narrative]);

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
          Narrative not found.
        </Text>
        <Link href={backHref}>
          <Text color="violet.600" fontSize="sm">
            ‹ Reports
          </Text>
        </Link>
      </Flex>
    );
  }

  return (
    <ReportShell
      crumbs={[
        { label: "All scholars", href: rosterHref },
        { label: narrative.scholarName, href: backHref },
        { label: narrative.subject },
      ]}
      scholarId={narrative.scholarId}
      actions={
        <HStack gap={1}>
          {prevId && (
            <Button asChild size="sm" variant="outline" fontFamily="heading">
              <Link href={`/teacher/report?n=${String(prevId)}`} aria-label="Previous scholar">
                <CaretLeft />
              </Link>
            </Button>
          )}
          {positionLabel && (
            <Text fontSize="xs" color="charcoal.400" fontFamily="heading" whiteSpace="nowrap" px={1}>
              {positionLabel}
            </Text>
          )}
          {nextId && (
            <Button asChild size="sm" variant="outline" fontFamily="heading">
              <Link href={`/teacher/report?n=${String(nextId)}`} aria-label="Next scholar">
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
              {narrative.subject}
            </Heading>
            <HStack gap={2.5} align="center" wrap="wrap" mt={0.5}>
              <Text fontSize="sm" color="charcoal.400" fontFamily="heading">
                {period?.label ?? "…"}
              </Text>
              <SharedTag status={narrative.status} />
            </HStack>
          </Box>
          <MarkReportDoneToggle
            done={reportDone(narrative.status)}
            onToggle={handleSetDone}
            disabled={reportShared(narrative.status)}
            label="Mark report as done"
          />
        </Flex>
      </Box>

      <Box px={6} pb={6} flex={1} minH={0}>
        <PaneTabs
          value={activeSection}
          onChange={(v) => setActiveSection(v as SectionKey)}
          mb={4}
          items={TAB_ORDER.map((key) => {
            const stored = narrative.sections.find((sec) => sec.key === key);
            let state: SectionState;
            if (key === "overall") {
              state = narrative.courseRating != null ? "done" : "empty";
            } else if (key === "approvals") {
              state =
                reportDone(narrative.status)
                  ? "done"
                  : narrative.signoffs.length > 0
                    ? "content"
                    : "empty";
            } else {
              state = sectionState(!!stored?.body.trim(), !!stored?.done);
            }
            return {
              value: key,
              label: TAB_LABELS[key],
              icon: <SectionStatusIcon state={state} size={13} />,
            };
          })}
        >

          {SECTIONS.map((s) => {
            const stored = narrative.sections.find((sec) => sec.key === s.key);
            return (
              <Tabs.Content key={s.key} value={s.key}>
                <Flex gap={4} align="stretch" wrap="wrap">
                  <Surface flex="1 1 380px" minW="320px" p={4}>
                    <EvidencePane
                      section={s.key}
                      binder={binder}
                      units={derivedUnits}
                      acceptedGoalIds={acceptedGoalIds}
                      onToggleGoal={toggleGoal}
                    />
                  </Surface>

                  <Surface flex="1 1 380px" minW="320px" p={4}>
                    {s.dimension && (
                      <Box mb={4} pb={4} borderBottom="1px solid" borderColor="gray.100">
                        <RubricSlider
                          label={`${PCM_META[s.dimension].label} rating`}
                          blurb={PCM_META[s.dimension].blurb}
                          value={narrative.pcmRatings?.[s.dimension]}
                          onChange={(n) => setDimensionRating(s.dimension!, n)}
                        />
                      </Box>
                    )}
                    <NarrativeSectionEditor
                      narrativeId={narrative._id}
                      sectionKey={s.key}
                      title={stored?.title ?? s.title}
                      initialBody={stored?.body ?? ""}
                      rows={s.rows}
                    />
                    <Flex justify="flex-end" mt={3} pt={3} borderTop="1px solid" borderColor="gray.100">
                      <Switch.Root
                        checked={!!stored?.done}
                        onCheckedChange={(d) => handleSectionDone(s.key, s.title, !!d.checked)}
                        colorPalette="green"
                        size="sm"
                      >
                        <Switch.HiddenInput />
                        <Switch.Control>
                          <Switch.Thumb />
                        </Switch.Control>
                        <Switch.Label fontSize="xs" fontFamily="heading" color="charcoal.500">
                          Mark as done
                        </Switch.Label>
                      </Switch.Root>
                    </Flex>
                  </Surface>
                </Flex>
              </Tabs.Content>
            );
          })}

          <Tabs.Content value="overall">
            <Flex gap={4} align="stretch" wrap="wrap">
              <Surface flex="1 1 380px" minW="320px" p={4}>
                <OverallEvidence binder={binder} pcmRatings={narrative.pcmRatings} />
                <Box mt={4} pt={4} borderTop="1px solid" borderColor="gray.100">
                  <WorkingLevelReadout workingLevel={workingLevel} />
                </Box>
              </Surface>
              <Surface flex="1 1 380px" minW="320px" p={4}>
                <RubricSlider
                  label="Course performance rating"
                  value={narrative.courseRating}
                  onChange={setCourseRating}
                />
              </Surface>
            </Flex>
          </Tabs.Content>

          <Tabs.Content value="approvals">
            <Flex gap={4} align="stretch" wrap="wrap">
              <Surface flex="1 1 380px" minW="320px" p={4}>
                <VStack align="stretch" gap={4}>
                  <EvidenceHeader label="Approvals" blurb="Team signoff — who's reviewed this report." />
                  <Checkbox.Root
                    size="md"
                    checked={narrative.signedOffByMe}
                    onCheckedChange={() => handleToggleSignoff()}
                    disabled={signingOff}
                  >
                    <Checkbox.HiddenInput />
                    <Checkbox.Control />
                    <Checkbox.Label fontSize="sm" fontFamily="heading" fontWeight="600" color="navy.600">
                      I&apos;ve reviewed this report
                    </Checkbox.Label>
                  </Checkbox.Root>
                  <VStack align="stretch" gap={1.5}>
                    {narrative.signoffs.length === 0 ? (
                      <Text fontSize="xs" color="charcoal.300" fontFamily="body">
                        No one has signed off yet.
                      </Text>
                    ) : (
                      narrative.signoffs.map((s) => (
                        <HStack
                          key={String(s.userId)}
                          justify="space-between"
                          px={2.5}
                          py={1.5}
                          borderWidth="1px"
                          borderColor="gray.100"
                          borderRadius="md"
                          bg="white"
                        >
                          <Text fontSize="xs" fontFamily="heading" fontWeight="600" color="navy.600">
                            {s.name} — {new Date(s.at).toLocaleDateString()}
                          </Text>
                          <Check size={14} color="#2f855a" />
                        </HStack>
                      ))
                    )}
                  </VStack>
                </VStack>
              </Surface>

              <Surface flex="1 1 380px" minW="320px" p={4}>
                <VStack align="stretch" gap={4}>
                  <HStack justify="space-between" align="start" gap={2}>
                    <Heading size="md" color="navy.600" fontFamily="heading">
                      Publish
                    </Heading>
                    <SharedTag status={narrative.status} />
                  </HStack>
                  <Box>
                    <MarkReportDoneToggle
                      done={reportDone(narrative.status)}
                      onToggle={handleSetDone}
                      disabled={reportShared(narrative.status)}
                      label="Mark report as done"
                    />
                    <Text fontSize="xs" color="charcoal.300" fontFamily="body" mt={1.5}>
                      Marks the write-up complete and snapshots the Working Level. Publishing becomes available once done.
                    </Text>
                  </Box>
                  <Box>
                    <Button
                      size="sm"
                      colorPalette="violet"
                      fontFamily="heading"
                      onClick={handleShare}
                      loading={sharing}
                      disabled={!reportDone(narrative.status) || reportShared(narrative.status)}
                    >
                      <ShareNetwork style={{ marginRight: 4 }} />
                      {reportShared(narrative.status) ? "Published to parents" : "Publish to parents"}
                    </Button>
                    <Text fontSize="xs" color="charcoal.300" fontFamily="body" mt={1.5}>
                      Publishes the report to the family. Enabled once the report is marked done.
                    </Text>
                  </Box>
                </VStack>
              </Surface>
            </Flex>
          </Tabs.Content>
        </PaneTabs>
      </Box>
    </ReportShell>
  );
}
