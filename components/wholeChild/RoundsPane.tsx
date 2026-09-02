"use client";

/**
 * The Rounds per-scholar pane — one child, projected, while the room talks.
 *
 * The order down the page is the order of the ritual itself:
 *
 *   1. What we said last week, read back. Continuity is the whole point of a
 *      weekly meeting; without it Rounds is five separate conversations.
 *   2. This week, in the sources' own words — dated and attributable.
 *   3. Guidance for this child: keep it, make it standing, end it, bring it
 *      back, or give it an end date.
 *   4. The staff note, which the tutor never sees.
 *
 * Two composers sit on this page and they are deliberately unalike. The staff
 * note is quiet and grey and private; guidance is green, loud, and read
 * verbatim by the tutor to the child at the start of every session. That
 * visual difference is a safety mechanism — the one place in this design where
 * colour is load-bearing rather than decorative — not a style choice.
 *
 * ⚠️ REDACTION BOUNDARY: nothing on this page copies evidence into guidance.
 * No quote button, no click-to-insert, no "use this". Observer analysis is
 * teacher-facing and may carry clinical framing; guidance is spoken to a
 * child. Whoever writes guidance types it themselves.
 *
 * Scholar-to-scholar navigation lives in the Whole Child header (one nav, not
 * two). Nothing here names a weekday: the institution's own anchor decides
 * which day Rounds falls on, and every label is a DATE.
 */
import { useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useMutation, useQuery } from "convex/react";
import {
  Box,
  Flex,
  Link as ChakraLink,
  Spinner,
  Stack,
  Text,
} from "@chakra-ui/react";
import NextLink from "next/link";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { Surface } from "@/components/ui/Surface";
import { SectionEyebrow } from "@/components/ui/SectionEyebrow";
import { RoundsEvidenceList } from "@/components/rounds/RoundsEvidenceList";
import { RoundsWeekFigures } from "@/components/rounds/RoundsWeekFigures";
import { CalibrationLine } from "@/components/rounds/CalibrationLine";
import { parseRoundsWeekParam } from "@/lib/roundsCadence";
import { RoundsLevelCard, RoundsLevelRuling } from "@/components/rounds/RoundsLevels";
import { RoundsNoteComposer } from "@/components/rounds/RoundsNoteComposer";
import { SelSynthesisCard } from "@/components/rounds/SelSynthesisCard";
import { SelTeacherRecord } from "@/components/rounds/SelTeacherRecord";
import {
  RoundsGuidanceCard,
  type GuidanceRow,
} from "@/components/rounds/RoundsGuidanceCard";
import {
  buildRoundsEvidence,
  isSilentWeek,
  roundsDate,
  roundsWindowLabel,
  NO_PREVIOUS_NOTE_CAVEAT,
  NO_PREVIOUS_NOTE_FINDING,
} from "@/components/rounds/roundsEvidence";
import { useBatchedScholarRows } from "@/components/rounds/useScholarBatches";
import {
  useSmoothedQuery,
  useSmoothedQueryWithPending,
} from "@/hooks/useSmoothedQuery";
import type {
  RoundsLevelSignals,
  RoundsPracticeSignals,
} from "@/components/rounds/roundsFigures";

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

const GOAL_STATUS_LABEL: Record<string, string> = {
  proposed: "Suggested, not yet accepted",
  active: "Active",
  met: "Met",
  not_yet: "Not yet",
  archived: "Archived",
};

/**
 * Weekly goals are Monday-anchored and Rounds is anchored to the institution's
 * own meeting day, so the two week keys do not line up and must never be
 * compared as strings. A goal belongs to this Rounds week when its Monday-to-
 * Monday span OVERLAPS the Rounds window.
 */
function goalOverlapsWindow(
  weekOf: string,
  startMs: number,
  endMs: number,
): boolean {
  const monday = Date.parse(`${weekOf}T00:00:00`);
  if (!Number.isFinite(monday)) return false;
  return monday < endMs && monday + WEEK_MS > startMs;
}

export function RoundsPane({
  scholarId,
  scholarName,
  periodId,
  cadence = "academic",
  institutionScope,
}: {
  scholarId: Id<"users">;
  scholarName: string;
  periodId: Id<"reportingPeriods">;
  cadence?: "academic" | "sel";
  institutionScope?: string;
}) {
  const searchParams = useSearchParams();
  const sel = cadence === "sel";

  const agenda = useQuery(api.rounds.agenda, {
    periodId,
    cadence,
    scope: institutionScope,
  });
  // The board hands the pane the week it was showing. A malformed value would
  // be read leniently by the server, but there is no reason to forward one, so
  // only a well-formed key overrides the open week.
  const viewedWeekKey = parseRoundsWeekParam(searchParams?.get("rweek"));
  const weekKey = agenda?.configured ? viewedWeekKey ?? agenda.weekKey : null;
  const week = useQuery(
    api.rounds.week,
    agenda && agenda.configured && weekKey
      ? { periodId, weekKey, cadence, scope: institutionScope }
      : "skip",
  );
  // The SEL synthesis for this scholar/week — the strengths-first written
  // summary the Thursday meeting reads. Academic never touches it.
  //
  // The scholar-specific reads below are SMOOTHED: switching scholars keeps this
  // pane mounted (no key remount), so a plain useQuery would drop each to
  // undefined and flash its card empty mid-swap. useSmoothedQuery holds the
  // previous scholar's value until the new one lands; the shared `swapping`
  // flag (from the always-on directives read) dims the pane during the swap so
  // the outgoing scholar's data is never mistaken for the incoming one's.
  const synthesis = useSmoothedQuery(
    api.selSyntheses.forScholarWeek,
    sel && weekKey ? { scholarId, weekKey } : "skip",
  );
  const generateSyntheses = useMutation(api.selSyntheses.generateForWeek);
  const [generating, setGenerating] = useState(false);
  const [generateError, setGenerateError] = useState<string | null>(null);
  // `rounds.week` returns only the guidance that was LIVE during the week under
  // review, which is right for the board. The pane also has to offer "bring it
  // back", so it reads the scholar's full directive history separately. This is
  // read in BOTH lenses, so its pending flag is the pane's swap signal.
  const { data: directives, isPending: swapping } = useSmoothedQueryWithPending(
    api.teacherDirectives.listByScholar,
    { scholarId },
  );
  // Weekly goals + reading level are academic-lens instruments; the SEL lens is
  // "just to discuss issues" and carries neither.
  const goals = useSmoothedQuery(
    api.weeklyGoals.listForScholar,
    sel ? "skip" : { scholarId },
  );

  // The three instruments, each read from its own source and never blended:
  // this week's practice arithmetic, the confirmed/estimated grade pair, and
  // the mechanical Flesch–Kincaid trend whose canonical chart lives on the
  // profile. All academic-lens only — the SEL lens reads none of them.
  const scholarIdList = useMemo(
    () => (sel ? [] : [scholarId as string]),
    [sel, scholarId],
  );

  // Read through the same batched helper the board uses. One scholar is one
  // batch, but the helper hands back a refusal rather than throwing, which is
  // what keeps the level boundary (operations staff cannot see reading level)
  // from taking the whole pane down mid-meeting.
  const practiceBatch = useBatchedScholarRows<RoundsPracticeSignals>(
    api.practiceDigest.weeklySignalsForScholars,
    scholarIdList,
  );
  const levelBatch = useBatchedScholarRows<RoundsLevelSignals>(
    api.scholars.levelSignalsForScholars,
    scholarIdList,
  );
  const readingTrend = useSmoothedQuery(
    api.messages.getScholarReadingTrend,
    sel ? "skip" : { scholarId },
  );

  const [nowMs] = useState(() => Date.now());

  const scholar = useMemo(
    () =>
      week?.scholars.find((s) => String(s.scholarId) === String(scholarId)) ??
      null,
    [week, scholarId],
  );

  const evidence = useMemo(() => {
    if (!scholar) return null;
    const input = {
      observations: scholar.observations,
      mastery: scholar.mastery,
      practice: scholar.practice,
      pulse: scholar.pulse,
    };
    return { lines: buildRoundsEvidence(input), silent: isSilentWeek(input) };
  }, [scholar]);

  const guidance: GuidanceRow[] = useMemo(() => {
    if (!directives) return [];
    return directives
      .map((d) => ({
        _id: String(d._id),
        label: d.label,
        content: d.content,
        expiresAt: d.expiresAt ?? null,
        isActive: d.isActive,
        updatedAt: d.updatedAt ?? d._creationTime,
      }))
      .sort((a, b) => {
        const aEnded = a.expiresAt !== null && a.expiresAt <= nowMs ? 1 : 0;
        const bEnded = b.expiresAt !== null && b.expiresAt <= nowMs ? 1 : 0;
        if (aEnded !== bEnded) return aEnded - bEnded;
        return b.updatedAt - a.updatedAt;
      });
  }, [directives, nowMs]);

  const weekGoals = useMemo(() => {
    if (!goals || !week) return [];
    return goals.filter((g) =>
      goalOverlapsWindow(g.weekOf, week.window.startMs, week.window.endMs),
    );
  }, [goals, week]);

  const figures = practiceBatch.byId.get(scholarId) ?? null;
  const levels = levelBatch.byId.get(scholarId) ?? null;
  // The latest bucket that actually scored something. Older empty buckets are
  // silence, not a drop to zero.
  const writingComplexity = useMemo(() => {
    const buckets = readingTrend?.trend ?? [];
    for (let i = buckets.length - 1; i >= 0; i -= 1) {
      const value = buckets[i]?.meanGradeLevel;
      if (typeof value === "number") return value;
    }
    return null;
  }, [readingTrend]);

  async function runGenerate() {
    if (!week?.configured || !weekKey) return;
    setGenerating(true);
    setGenerateError(null);
    try {
      await generateSyntheses({
        institutionId: week.institutionId,
        weekKey,
        window: week.window,
      });
    } catch (e) {
      setGenerateError(e instanceof Error ? e.message : String(e));
    } finally {
      setGenerating(false);
    }
  }

  if (agenda === undefined) {
    return (
      <Flex align="center" justify="center" minH="240px">
        <Spinner size="lg" color="violet.500" />
      </Flex>
    );
  }

  if (!agenda.configured) {
    // SEL has no configured cadence for this school. Say so calmly rather than
    // spinning on a skipped week query or showing the academic week.
    return (
      <Box h="full" overflow="auto">
        <Stack gap={5} maxW="1400px" pb={12}>
          <Surface p={{ base: 4, lg: 6 }}>
            <Stack gap={2} maxW="34rem">
              <SectionEyebrow>SEL Rounds</SectionEyebrow>
              <Text
                fontFamily="heading"
                fontSize="md"
                fontWeight="700"
                color="charcoal.600"
              >
                SEL Rounds isn&rsquo;t set up for this school yet.
              </Text>
              <Text
                fontFamily="body"
                fontSize="sm"
                color="charcoal.500"
                lineHeight="1.6"
              >
                Add an SEL cadence in the school&rsquo;s Rounds settings and this
                lens will fill in.
              </Text>
            </Stack>
          </Surface>
        </Stack>
      </Box>
    );
  }

  if (week === undefined) {
    return (
      <Flex align="center" justify="center" minH="240px">
        <Spinner size="lg" color="violet.500" />
      </Flex>
    );
  }

  const meetingId = agenda.meeting?._id ? String(agenda.meeting._id) : null;
  // The everyday-lens href for this scholar: the current URL with the Rounds
  // lens dropped. (The old Rounds⇄Everyday toggle lived here; the "into Rounds"
  // direction now comes from the board rows, and "out to Everyday" from this
  // link + the header's "View scholar page" button.)
  const everydayHref = () => {
    const params = new URLSearchParams(searchParams.toString());
    params.delete("rounds");
    const qs = params.toString();
    return qs ? `?${qs}` : "?";
  };

  return (
    <Box h="full" overflow="auto">
      {/* Dim the pane while a scholar swap's data is still loading, so a
          retained previous read is never mistaken for the incoming scholar's.
          The week frame itself stays put (agenda/week are scholar-independent),
          so this is a gentle fade, not a collapse. */}
      <Stack
        gap={5}
        maxW="1400px"
        pb={12}
        opacity={swapping ? 0.55 : 1}
        transition="opacity 0.15s ease"
        pointerEvents={swapping ? "none" : undefined}
      >
        <Surface p={{ base: 4, lg: 5 }}>
          <Stack gap={1}>
            <SectionEyebrow>
              {sel ? "SEL Rounds" : "Rounds"} · {week.weekLabel}
            </SectionEyebrow>
            <Text fontFamily="heading" fontSize="sm" color="charcoal.400">
              {roundsWindowLabel(week.window.startMs, week.window.endMs)}
            </Text>
          </Stack>
        </Surface>

        {/* 1 · What we said last week, read back before anything else. */}
        <Surface p={{ base: 4, lg: 5 }}>
          <SectionEyebrow
            boxProps={{
              title: NO_PREVIOUS_NOTE_CAVEAT,
              cursor: "help",
            }}
          >
            {sel ? "Last SEL Rounds" : "Last week"}
          </SectionEyebrow>
          {scholar?.previous && scholar.previous.note?.trim() ? (
            <Stack gap={1.5} mt={2}>
              <Text
                fontFamily="body"
                fontSize={{ base: "md", lg: "lg" }}
                lineHeight="1.5"
                color="charcoal.600"
              >
                &ldquo;{scholar.previous.note}&rdquo;
              </Text>
              <Text fontFamily="heading" fontSize="sm" color="charcoal.400">
                {sel ? "SEL Rounds" : "Rounds"} · {scholar.previous.weekLabel}
                {scholar.previous.discussedAt
                  ? ` · written ${roundsDate(scholar.previous.discussedAt)}`
                  : ""}
              </Text>
            </Stack>
          ) : (
            <Text fontFamily="body" fontSize="sm" color="charcoal.400" mt={2}>
              {NO_PREVIOUS_NOTE_FINDING}
            </Text>
          )}
        </Surface>

        {/* SEL · 2 — the written synthesis, strengths first. Teacher-facing,
            grey; it never reaches the tutor. */}
        {sel ? (
          <Surface p={{ base: 4, lg: 5 }}>
            <SectionEyebrow>This week&rsquo;s synthesis</SectionEyebrow>
            <Box mt={3}>
              <SelSynthesisCard
                synthesis={synthesis ?? null}
                loading={synthesis === undefined}
                canGenerate
                onGenerate={() => void runGenerate()}
                generating={generating}
                error={generateError}
              />
            </Box>
          </Surface>
        ) : null}

        {/* SEL · 3 — the pooled teacher record, quoted verbatim. */}
        {sel ? (
          <Surface p={{ base: 4, lg: 5 }}>
            <SectionEyebrow>Teacher observations · verbatim</SectionEyebrow>
            <Box mt={3}>
              <SelTeacherRecord observations={scholar?.observations ?? []} />
            </Box>
          </Surface>
        ) : null}

        {/* 2 · The week, in the sources' own words — figures first, then the
            words themselves. The figures are three fixed slots so a week with
            no practice reads as a stated absence rather than a missing block.
            Academic only: the SEL lens carries no practice/mastery/reading. */}
        {!sel ? (
        <Surface p={{ base: 4, lg: 5 }}>
          <SectionEyebrow>This week</SectionEyebrow>
          {/* The one real decision on the pane, hoisted here so it is settled
              before the room reads down the week rather than buried mid-scroll
              in the reading card. Renders nothing unless an estimate disagrees. */}
          <Box mt={3}>
            <RoundsLevelRuling
              scholarId={scholarId}
              scholarName={scholarName}
              signals={levels}
              unavailable={levelBatch.failed}
            />
          </Box>
          <Box mt={3}>
            <RoundsWeekFigures
              signals={figures}
              scholarName={scholarName}
              pastWeekLabel={
                viewedWeekKey && agenda && viewedWeekKey !== agenda.weekKey
                  ? week.weekLabel
                  : null
              }
            />
          </Box>
          {/* Predict-then-Check calibration — one per-child line beside the
              week's figures (spec §3.3). A trailing-window metacognitive
              diagnostic, so it only shows for the CURRENT week and renders
              nothing below the server's data floor. Never a score on the child;
              a read about the predictions. */}
          {!(viewedWeekKey && agenda && viewedWeekKey !== agenda.weekKey) ? (
            <Box mt={3}>
              <CalibrationLine scholarId={scholarId} />
            </Box>
          ) : null}
          <Box mt={4}>
            {evidence ? (
              <RoundsEvidenceList
                lines={evidence.lines}
                silent={evidence.silent}
              />
            ) : (
              <Text fontFamily="body" fontSize="sm" color="charcoal.400">
                {scholarName} is not on this week&rsquo;s Rounds roster.
              </Text>
            )}
          </Box>
        </Surface>
        ) : null}

        {/* Reading and writing — three separate instruments, named separately.
            The confirmed level is a human ruling the tutor acts on; the
            estimate is derived from this child's own writing and is stored
            only while it disagrees; Flesch–Kincaid is mechanical and charted
            elsewhere. Conflating them would misreport all three. The estimate
            DECISION is hoisted into "This week" above; this card explains the
            instruments. Academic only. */}
        {!sel ? (
        <Surface p={{ base: 4, lg: 5 }}>
          <SectionEyebrow>Reading and writing</SectionEyebrow>
          <Box mt={3}>
            <RoundsLevelCard
              scholarName={scholarName}
              signals={levels}
              writingComplexity={writingComplexity}
              unavailable={levelBatch.failed}
            />
          </Box>
        </Surface>
        ) : null}

        {/* 3 · Guidance — green, loud, read by the tutor. Unchanged on both
            lenses: the one green path out of the meeting. */}
        <RoundsGuidanceCard
          scholarId={String(scholarId)}
          scholarName={scholarName}
          guidance={guidance}
          meetingId={meetingId}
          nowMs={nowMs}
        />

        {/* 4 · The staff note — quiet, grey, private. Always writable: the note
            materializes this week's meeting server-side on first save. */}
        <Surface p={{ base: 4, lg: 5 }}>
          <RoundsNoteComposer
            periodId={String(periodId)}
            weekKey={weekKey}
            scholarId={String(scholarId)}
            scholarName={scholarName}
            note={scholar?.note ?? null}
            noteVersion={scholar?.noteVersion ?? null}
            discussedAt={scholar?.discussedAt ?? null}
            discussedByName={scholar?.discussedByName ?? null}
            scope={institutionScope}
            cadence={cadence}
            size="pane"
          />
        </Surface>

        {/* Weekly goals are the scholar's own. Rounds reads them; it never
            writes them — a guardrail demoted to the heading's tooltip rather
            than spending a line on it every week. Academic only. */}
        {!sel ? (
        <Surface p={{ base: 4, lg: 5 }}>
          <SectionEyebrow
            boxProps={{
              title: "Rounds reads weekly goals; it never writes them.",
              cursor: "help",
            }}
          >
            Weekly goals
          </SectionEyebrow>
          <Stack gap={3} mt={3}>
            {weekGoals.length === 0 ? (
              <Text fontFamily="body" fontSize="md" color="charcoal.400">
                No goal was running for {scholarName} in this week.
              </Text>
            ) : (
              weekGoals.map((g) => (
                <Box
                  key={String(g._id)}
                  borderWidth="1px"
                  borderColor="gray.200"
                  borderRadius="md"
                  px={4}
                  py={3}
                >
                  <Text
                    fontFamily="body"
                    fontSize="sm"
                    color="charcoal.600"
                    lineHeight="1.5"
                  >
                    {g.text}
                  </Text>
                  <Text
                    fontFamily="heading"
                    fontSize="sm"
                    color="charcoal.400"
                    mt={1}
                  >
                    {GOAL_STATUS_LABEL[g.status] ?? g.status} · set by{" "}
                    {g.source === "scholar" ? scholarName : "a teacher"} · week
                    of {g.weekOf}
                  </Text>
                  {g.reflection ? (
                    <Text
                      fontFamily="body"
                      fontSize="sm"
                      color="charcoal.500"
                      mt={2}
                    >
                      &ldquo;{g.reflection}&rdquo;
                    </Text>
                  ) : null}
                </Box>
              ))
            )}
          </Stack>
        </Surface>
        ) : null}

        {/* The full evidence feed is its own surface — the Everyday lens — not
            re-rendered here. Rounds is the weekly meeting view; a quiet link
            hands off to the canonical feed rather than making the pane endless. */}
        <ChakraLink
          asChild
          fontFamily="heading"
          fontSize="sm"
          fontWeight="600"
          color="violet.600"
          _hover={{ textDecoration: "underline" }}
        >
          <NextLink
            href={everydayHref()}
            scroll={false}
            data-testid="rounds-full-feed"
          >
            Full feed — {scholarName}&rsquo;s Everyday view →
          </NextLink>
        </ChakraLink>
      </Stack>
    </Box>
  );
}
