"use client";

/**
 * The "Rehearse" surface for the self-improving-curricula loop
 * (review/self-improving-curricula-plan.md +
 * review/curriculum-rehearse-and-maturity.md).
 *
 * The single export is `RehearseBody` — run controls + a scorecard, a
 * master/detail sims browser, a side-by-side prompt diff, and the Debrief
 * (sim-vs-real) view. It's rendered full-page in the unit surface's
 * Rehearse tab (components/RehearsePane.tsx). It used to live in a
 * bottom-sheet drawer (the now-deleted RehearseButton + RehearseModal);
 * the drawer was retired when Rehearse became a tab.
 *
 * Reactive throughout (subscribes to curriculumExperiments.get). Nothing ships
 * unless the teacher promotes a variant — a normal teacher-gated
 * activities.update.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useMutation, useQuery } from "convex/react";
import {
  Badge,
  Box,
  Button,
  Checkbox,
  Flex,
  Grid,
  HStack,
  Portal,
  Progress,
  Spinner,
  Stack,
  Tabs,
  Text,
  Tooltip,
} from "@chakra-ui/react";
import { Flask, ThumbsDown } from "@phosphor-icons/react";
import { api } from "@/convex/_generated/api";
import type { Doc, Id } from "@/convex/_generated/dataModel";
import { lineDiff } from "@/convex/lib/curriculumDiff";
import {
  aggregate,
  isBetter,
  type Aggregate,
  type BetterResult,
  type ExperimentPairwise,
  type PairwiseComparison,
  type SessionVerdict,
} from "@/convex/lib/curriculumScore";
import {
  DESIGN_DIMS,
  DIMENSION_GROUPS,
  DIMENSION_LABELS,
  FITNESS_DIMS,
  GIFTED_DIMS,
  type CurriculumDimension,
} from "@/convex/lib/curriculumDimensions";
import { scholarAvatar, DEFAULT_CAST as DEFAULT_SIMS } from "@/convex/lib/curriculumSimShared";
import { budgetMinutes, turnsForMinutes } from "@/convex/lib/rehearsalBudget";
import type { PreflightResult } from "@/convex/lib/curriculumPreflightResult";
import {
  canFixFinding,
  findingCoverageLabel,
  findingHandoffCaveat,
  fixFieldForFinding,
  protectedCoverageNotice,
  sortedFindings,
  type RehearseFixField,
} from "@/components/nodeEditor/rehearseResult";
import { AideMessageBubble } from "@/components/AideThread";
import { stemPreviewText } from "@/shared/practiceStemBlocks";
import { DebriefMoments } from "@/components/DebriefMoments";
import { JudgeTeacherValidation } from "@/components/JudgeTeacherValidation";
// The stored experiment mode (the orchestrator's state machine — kept as
// is; renaming the backend enum is the deferred schema churn). The UI no
// longer surfaces these as four tabs: it's a Rehearse / Debrief view with
// a "revise" checkbox, and revise → propose. "loop" is no longer reachable
// from the UI (it lingers only to LABEL historical experiments).
type Mode = "analyze" | "propose" | "loop";
// What the teacher is looking at: run the sims (Rehearse) or compare a
// finished run to real scholars (Debrief).
type RehearseView = "rehearse" | "debrief";

// Color the four lenses distinctly. Design remains diagnosis-only.
const dimPalette = (d: string): string =>
  (FITNESS_DIMS as readonly string[]).includes(d)
    ? "cyan"
    : (GIFTED_DIMS as readonly string[]).includes(d)
      ? "violet"
      : (DESIGN_DIMS as readonly string[]).includes(d)
        ? "orange"
        : "blue";

// One score format everywhere: a whole number stays whole (an individual's 3,
// not 3.0); a mean keeps one decimal (3.8). Non-finite (missing dim) → "–".
function fmtScore(n: number | undefined): string {
  if (typeof n !== "number" || !Number.isFinite(n)) return "–";
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

function finiteScore(n: number | undefined): number | undefined {
  return typeof n === "number" && Number.isFinite(n) ? n : undefined;
}

// A 0–5 score as a 0–100 Progress percentage. A missing dim (e.g. a pre-
// gifted-lens stored verdict aggregates to NaN) must read as empty, not NaN —
// `NaN ?? 0` is still NaN, which a Progress bar can't render.
function meterPct(n: number | undefined): number {
  return Number.isFinite(n) ? ((n as number) / 5) * 100 : 0;
}

// How a session ended, in plain words. "maxTurns" is deliberately neutral —
// running out of SIMULATED turns is not a failure (real scholars have no turn
// budget), so we don't word it like one.
const STOP_LABEL: Record<string, string> = {
  goal: "Reached the goal",
  stuck: "Got stuck",
  maxTurns: "Ran out of turns",
};

// ── Outcome probe (adoptable #1) ────────────────────────────────────
// A small held-out set of VERIFIED practice items the sim kid answered in
// character (pre-session, cold; post-session, with the transcript), graded
// DETERMINISTICALLY by the practice verifier — no judge. We show the sim
// pre→post delta over ISOMORPHIC items. Read it as a DELTA BETWEEN VARIANTS
// over the same sims, never as an absolute (a sim kid carries a "too capable"
// bias). Context for the teacher; never gates promotion.
type SessionProbe = NonNullable<Detail["sessions"][number]["probe"]>;
type VariantProbeMean = Detail["probeByVariant"][string];

function fmtProbePct(fraction: number): string {
  return `${Math.round(fraction * 100)}%`;
}
function fmtProbeDelta(delta: number): string {
  const pct = Math.round(delta * 100);
  return pct > 0 ? `+${pct}%` : `${pct}%`;
}
function probeDeltaColor(delta: number): string {
  if (delta > 0.001) return "green.600";
  if (delta < -0.001) return "red.500";
  return "charcoal.400";
}

function ProbeHeading() {
  return (
    <Text
      fontSize="xs"
      fontFamily="heading"
      fontWeight="semibold"
      letterSpacing="wide"
      textTransform="uppercase"
      color="charcoal.400"
      mb={1}
    >
      Outcome probe
    </Text>
  );
}

// One scholar's probe on the Scorecard tab: the pre→post line + per-item ✓/✗.
function ProbeScholarDetail({
  probe,
  skipReason,
}: {
  probe?: SessionProbe | null;
  skipReason?: string | null;
}) {
  if (!probe) {
    if (!skipReason) return null;
    return (
      <Box mb={3}>
        <ProbeHeading />
        <Text fontSize="xs" color="charcoal.400">
          No held-out probe — {skipReason}.
        </Text>
      </Box>
    );
  }
  return (
    <Box mb={3}>
      <ProbeHeading />
      <Text fontSize="sm" color="charcoal.700" lineHeight="1.55">
        pre {fmtProbePct(probe.preScore)} → post {fmtProbePct(probe.postScore)}{" "}
        <Text as="span" fontWeight="semibold" color={probeDeltaColor(probe.delta)}>
          (Δ {fmtProbeDelta(probe.delta)})
        </Text>
      </Text>
      <Stack gap={0.5} mt={1.5}>
        {probe.items.map((it, i) => (
          <Text key={i} fontSize="xs" color="charcoal.500" fontFamily="mono">
            <Text as="span" color={it.preCorrect ? "green.600" : "red.500"}>
              {it.preCorrect ? "✓" : "✗"}
            </Text>{" "}
            →{" "}
            <Text as="span" color={it.postCorrect ? "green.600" : "red.500"}>
              {it.postCorrect ? "✓" : "✗"}
            </Text>{" "}
            {/* Bucket B: a dense mono probe line — flatten any table run to one
                scannable line, never a nested block table. */}
            {stemPreviewText(it.stem)}
          </Text>
        ))}
      </Stack>
    </Box>
  );
}

function ProbeMeanRow({ label, mean }: { label: string; mean: VariantProbeMean }) {
  return (
    <HStack justify="space-between" fontSize="sm">
      <Text color="charcoal.600" fontFamily="heading">
        {label}
      </Text>
      <Text color="charcoal.700">
        pre {fmtProbePct(mean.preScore)} → post {fmtProbePct(mean.postScore)}{" "}
        <Text as="span" fontWeight="semibold" color={probeDeltaColor(mean.delta)}>
          (Δ {fmtProbeDelta(mean.delta)})
        </Text>{" "}
        <Text as="span" color="charcoal.400" fontSize="xs">
          · {mean.n} {mean.n === 1 ? "sim" : "sims"}
        </Text>
      </Text>
    </HStack>
  );
}

// The per-variant probe means (baseline, and any proposed edit) — the
// like-for-like pre→post over the same sims on identical held-out items.
function ProbeVariantSummary({
  probeByVariant,
  baselineVariantId,
  candidate,
}: {
  probeByVariant: Detail["probeByVariant"];
  baselineVariantId: string | null;
  candidate: Detail["variants"][number] | undefined;
}) {
  const baseMean = baselineVariantId ? probeByVariant[baselineVariantId] : undefined;
  const candMean = candidate ? probeByVariant[candidate._id] : undefined;
  if (!baseMean && !candMean) return null;
  return (
    <Box borderWidth="1px" borderColor="gray.200" borderRadius="md" p={3} bg="white">
      <Text fontSize="sm" fontFamily="heading" fontWeight="semibold" color="charcoal.700" mb={1}>
        Outcome probe (held-out items)
      </Text>
      <Text fontSize="xs" color="charcoal.400" mb={2} lineHeight="1.5">
        Sim kids answered verified practice items before and after the session,
        graded deterministically (no judge). Read this as a relative delta between
        variants over the same sims — not as an absolute score.
      </Text>
      <Stack gap={1}>
        {baseMean && (
          <ProbeMeanRow label={candidate ? "Baseline" : "This run"} mean={baseMean} />
        )}
        {candMean && <ProbeMeanRow label="Proposed edit" mean={candMean} />}
      </Stack>
    </Box>
  );
}

// The "kept / held" explanation, in plain words — names the dims a held edit
// would have lowered using their friendly labels instead of raw keys.
function friendlyDecisionReason(decision: BetterResult): string {
  if (!decision.better && decision.gate.violations.length) {
    const dims = decision.gate.violations
      .map((v) => DIMENSION_LABELS[v.dim] ?? v.dim)
      .join(", ");
    return `Held — this edit would lower ${dims}`;
  }
  return decision.reason;
}

// Adoptable #3 — the pairwise promote gate, in the results. Promotion is
// decided head-to-head (baseline vs candidate, SAME kid, order randomized),
// aggregated across the sims, with the protected-dim veto retained. The
// absolute DeltaTable below stays for diagnosis; this shows WHY it promoted.
function PairwiseSummary({ pairwise }: { pairwise: ExperimentPairwise }) {
  if (pairwise.decidedBy === "absolute-fallback") {
    return (
      <Text fontSize="xs" color="charcoal.400" mb={2}>
        Pairwise judge unavailable this run — decided on the absolute gate
        instead{pairwise.note ? ` (${pairwise.note})` : ""}.
      </Text>
    );
  }
  const comparisons = (pairwise.comparisons ?? []) as PairwiseComparison[];
  const chipPalette = (w: PairwiseComparison["winner"]) =>
    w === "candidate" ? "green" : w === "baseline" ? "gray" : "yellow";
  const chipLabel = (w: PairwiseComparison["winner"]) =>
    w === "candidate" ? "edit" : w === "baseline" ? "baseline" : "tie";
  return (
    <Box mb={2}>
      <Text fontSize="xs" color="charcoal.500" mb={1.5}>
        Sim preference (head-to-head, same kid, order randomized):{" "}
        <Text as="span" fontWeight="semibold" color="charcoal.700">
          edit {pairwise.candidateWins}–{pairwise.baselineWins} baseline
        </Text>
        {pairwise.ties ? `, ${pairwise.ties} tie` : ""} — net{" "}
        {pairwise.net >= 0 ? "+" : ""}
        {pairwise.net}.
      </Text>
      {comparisons.length > 0 && (
        <HStack gap={1.5} flexWrap="wrap">
          {comparisons.map((c, i) => (
            <Badge
              key={`${c.profileName}-${i}`}
              size="xs"
              colorPalette={chipPalette(c.winner)}
              variant="subtle"
              title={c.reason}
            >
              {c.profileName}: {chipLabel(c.winner)}
            </Badge>
          ))}
        </HStack>
      )}
    </Box>
  );
}

// Labels for the stored mode — used only to name historical experiments
// in the run switcher (the live control is the Rehearse/Debrief view +
// the "revise" checkbox below). The stored backend enum
// (analyze/propose/loop) is intentionally NOT renamed — that's the
// deferred schema churn; the UI just no longer exposes it as four tabs.
const MODE_LABEL: Record<Mode, string> = {
  analyze: "Scholar-bot rehearsal",
  propose: "Scholar-bot rehearsal + revise",
  loop: "Scholar-bot rehearsal + revise (loop)",
};

// The Rehearse surface — a Rehearse / Debrief view toggle + a "revise"
// checkbox, the run bar, and the running/results/debrief views. Rendered
// full-page in the unit surface's Rehearse tab (RehearsePane). It used to
// live in a bottom-sheet drawer (RehearseModal); that drawer is retired
// — see review/curriculum-rehearse-and-maturity.md.
export function RehearseBody({
  activityId,
  view,
  durationMinutes,
  onManualRehearsal,
  askAi,
  onFixFinding,
}: {
  activityId: Id<"activities">;
  /** Rehearse (run the sims) vs. Debrief (compare a run to real scholars).
   *  Driven by the activity's Rehearse / Debrief TABS now — the old in-panel
   *  segmented toggle is gone (review/curriculum-rehearse-and-maturity.md).
   *  The same component instance persists across the two tabs, so a run's
   *  state survives switching to Debrief and back. */
  view: RehearseView;
  /** The activity's Duration — the sim's turn budget auto-populates from
   *  it (turnsForMinutes); shown to the teacher so the run reads as "does
   *  this fit the time it was given?". */
  durationMinutes?: number | null;
  onManualRehearsal?: () => void;
  /** Hands a canned prompt to the Curriculum Bot pane (Debrief CTAs). */
  askAi?: (prompt: string) => void;
  /** Routes a Preflight finding's "Fix this" (Results view) to the EXISTING
   *  Resources / Deliverable / Duration / Tutor-prompt editor for this
   *  activity. Undefined on surfaces that don't wire an editor (findings
   *  still render there — just without a "Fix this" button). */
  onFixFinding?: (field: RehearseFixField) => void;
}) {
  const experiments = useQuery(api.curriculumExperiments.listByActivity, {
    activityId,
  });
  const start = useMutation(api.curriculumExperiments.start);
  const cancel = useMutation(api.curriculumExperiments.cancel);

  const [selectedId, setSelectedId] =
    useState<Id<"curriculumExperiments"> | null>(null);
  // revise → the stored "propose" mode (run + propose a prompt edit, never
  // auto-applied); unchecked → "analyze" (run + score only). The
  // multiplicative "loop" mode is no longer reachable from the UI.
  const [revise, setRevise] = useState(false);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Selected experiment: explicit pick, else the most recent.
  const effectiveId = selectedId ?? experiments?.[0]?._id ?? null;
  const detail = useQuery(
    api.curriculumExperiments.get,
    effectiveId ? { experimentId: effectiveId } : "skip",
  );
  const running = detail?.experiment.status === "running";

  const simCount = 4;
  // analyze → 1 variant (baseline), propose → 2 (baseline + candidate).
  const estSessions = simCount * (revise ? 2 : 1);

  const handleRun = async () => {
    if (view === "debrief") return; // not a sim run — handled by its own view
    setStarting(true);
    setError(null);
    try {
      const { experimentId } = await start({
        activityId,
        mode: revise ? "propose" : "analyze",
      });
      setSelectedId(experimentId);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't start — try again.");
    } finally {
      setStarting(false);
    }
  };

  // Duration-grounded budget (auto-populated from the activity's Duration):
  // how many turns each sim gets, framed as the minutes the activity was
  // given. NOT a speed instruction to the tutor — just the loop bound.
  const budgetMin = budgetMinutes(durationMinutes);
  const budgetTurns = turnsForMinutes(durationMinutes);

  return (
    <Stack gap={4} flex="1" minH="0">
      <RunBar
        view={view}
        budgetMin={budgetMin}
        budgetTurns={budgetTurns}
        revise={revise}
        setRevise={setRevise}
        estSessions={estSessions}
        starting={starting}
        running={!!running}
        onRun={handleRun}
        error={error}
        experiments={experiments ?? []}
        selectedId={effectiveId}
        onSelect={setSelectedId}
      />

      {running && detail && (
        <RunningView
          detail={detail}
          onCancel={() => cancel({ experimentId: detail.experiment._id })}
        />
      )}

      {!running && view === "debrief" && (
        <DebriefView detail={detail ?? null} activityId={activityId} askAi={askAi} />
      )}

      {!running && view === "rehearse" && detail && (
        <ResultsView
          detail={detail}
          onManualRehearsal={onManualRehearsal}
          onFixFinding={onFixFinding}
        />
      )}

      {!detail && !running && view === "rehearse" && (
        <Stack
          align="center"
          justify="center"
          flex="1"
          gap={3}
          py={8}
          px={6}
          bg="white"
          borderWidth="1px"
          borderColor="gray.200"
          borderStyle="dashed"
          borderRadius="lg"
        >
          {/* The sims, waiting to be sent in. */}
          <Flex>
            {DEFAULT_SIMS.map((p, i) => (
              // eslint-disable-next-line @next/next/no-img-element -- tiny static avatar icon; next/image is overkill
              <img
                key={p.name}
                src={scholarAvatar(p.name)}
                alt=""
                title={`${p.name} · ${p.readingLevel}`}
                width={48}
                height={48}
                style={{
                  borderRadius: "9999px",
                  border: "2px solid white",
                  boxShadow: "0 1px 3px rgba(0,0,0,0.14)",
                  marginLeft: i === 0 ? 0 : -10,
                }}
              />
            ))}
          </Flex>
          <Text
            fontSize="sm"
            color="charcoal.400"
            textAlign="center"
            maxW="380px"
          >
            Press Run to send {DEFAULT_SIMS.length} sims through this
            activity. Tick &ldquo;revise&rdquo; to also propose a prompt edit.
          </Text>
        </Stack>
      )}
    </Stack>
  );
}

function RunBar({
  view,
  revise,
  setRevise,
  estSessions,
  budgetMin,
  budgetTurns,
  starting,
  running,
  onRun,
  error,
  experiments,
  selectedId,
  onSelect,
}: {
  view: RehearseView;
  revise: boolean;
  setRevise: (b: boolean) => void;
  estSessions: number;
  budgetMin: number;
  budgetTurns: number;
  starting: boolean;
  running: boolean;
  onRun: () => void;
  error: string | null;
  experiments: Doc<"curriculumExperiments">[];
  selectedId: Id<"curriculumExperiments"> | null;
  onSelect: (id: Id<"curriculumExperiments">) => void;
}) {
  const hasControls = view === "rehearse" || experiments.length > 1 || !!error;
  if (!hasControls) return null;

  return (
    <Box
      bg="white"
      borderWidth="1px"
      borderColor="gray.200"
      borderRadius="lg"
      p={4}
    >
      <Flex gap={3} align="center" wrap="wrap">
        {/* Run + revise + estimate — the Rehearse view only (the view is
            chosen by the activity's Rehearse / Debrief tabs now). Debrief
            has its own "Compare to real scholars" action in its view. */}
        {view === "rehearse" && (
          <HStack gap={3}>
            <Button
              size="xs"
              bg="cyan.500"
              color="white"
              _hover={{ bg: "cyan.600" }}
              onClick={onRun}
              loading={starting}
              loadingText="Starting…"
              disabled={running}
              fontFamily="heading"
            >
              <Flask size={13} weight="duotone" style={{ marginRight: 4 }} />
              Run
            </Button>
            <Checkbox.Root
              size="sm"
              checked={revise}
              disabled={running}
              onCheckedChange={(d) => setRevise(d.checked === true)}
            >
              <Checkbox.HiddenInput />
              <Checkbox.Control />
              <Checkbox.Label fontSize="xs" color="charcoal.500" fontFamily="heading">
                revise
              </Checkbox.Label>
            </Checkbox.Root>
            <Tooltip.Root openDelay={300} closeDelay={0}>
              <Tooltip.Trigger asChild>
                <Text fontSize="xs" color="charcoal.400" cursor="default">
                  ~{estSessions} session{estSessions === 1 ? "" : "s"} ·{" "}
                  {budgetMin} min budget
                </Text>
              </Tooltip.Trigger>
              <Portal>
                <Tooltip.Positioner>
                  <Tooltip.Content maxW="280px">
                    Each sim gets ~{budgetTurns} turns — the activity&apos;s{" "}
                    {budgetMin}-minute Duration at ~2.5 min/turn. The run asks:
                    can a scholar get through this in the time it was given?
                    Running out of turns is a real signal, not a failure.
                  </Tooltip.Content>
                </Tooltip.Positioner>
              </Portal>
            </Tooltip.Root>
          </HStack>
        )}

        {/* History switcher — only when there's more than one run. */}
        {experiments.length > 1 && (
          <HStack gap={1.5} ml="auto">
            <Text fontSize="xs" color="charcoal.400">
              Run
            </Text>
            <select
              value={selectedId ?? ""}
              onChange={(e) =>
                onSelect(e.target.value as Id<"curriculumExperiments">)
              }
              style={{
                fontSize: "11px",
                padding: "2px 6px",
                borderRadius: 6,
                border: "1px solid var(--chakra-colors-gray-300)",
                fontFamily: "var(--chakra-fonts-heading)",
              }}
            >
              {experiments.map((e, i) => (
                <option key={e._id} value={e._id}>
                  {MODE_LABEL[e.mode as Mode]} · {e.status}
                  {i === 0 ? " (latest)" : ""}
                </option>
              ))}
            </select>
          </HStack>
        )}
      </Flex>
      {error && (
        <Text fontSize="xs" color="red.500" mt={2}>
          {error}
        </Text>
      )}
    </Box>
  );
}

// The conversation currently being simulated, streamed turn-by-turn from
// progress.liveTranscript (written by runSession's onTurn hook). Shows the
// active scholar with a spinner and a "thinking…" line for the turn still
// being generated, so the run reads as a live conversation, not a black box.
type LiveInfo = {
  name: string;
  readingLevel: string;
  turns: ReadonlyArray<{ role: "tutor" | "scholar"; content: string }>;
};

// The in-flight conversation's turns + a "<who> is thinking…" line for the turn
// still being generated. Rendered inside the sims browser's detail pane — the
// master-list row carries the name + live badge, and the pane handles scroll.
function LiveTranscriptBody({ name, turns }: { name: string; turns: LiveInfo["turns"] }) {
  const last = turns[turns.length - 1];
  const thinking =
    turns.length === 0
      ? `${name} is getting started…`
      : last.role === "tutor"
        ? `${name} is thinking…`
        : "Tutor is thinking…";
  return (
    <Stack gap={3} align="stretch" p={3}>
      {turns.map((t, i) => (
        // Same chat UI as the curriculum bot: AI tutor → flat markdown,
        // scholar → right-aligned bubble (see AideMessageBubble).
        <AideMessageBubble
          key={i}
          role={t.role === "tutor" ? "assistant" : "user"}
          content={t.content}
        />
      ))}
      {/* The turn still being generated. */}
      <HStack gap={2} color="charcoal.400">
        <Spinner size="xs" color="cyan.400" />
        <Text fontSize="xs" fontStyle="italic">
          {thinking}
        </Text>
      </HStack>
    </Stack>
  );
}

// Live run view — NOT a black box. The progress header shows the current
// step; the active scholar's conversation streams in live below it; and every
// robo-scholar conversation that has finished so far appears under that
// (reactively, as recordSession lands) with its score + avatar, with the
// baseline scorecard filling in once its sims finish. So walking away and
// coming back mid-run shows everything that happened, not just a lone spinner.
function RunningView({
  detail,
  onCancel,
}: {
  detail: Detail;
  onCancel: () => void;
}) {
  const { experiment, baselineVariant, sessions, roster } = detail;
  const { progress } = experiment;
  const mode = experiment.mode as Mode;
  const pct =
    progress.sessionsTotal > 0
      ? Math.min(100, (progress.sessionsDone / progress.sessionsTotal) * 100)
      : 0;
  const baselineAgg = baselineVariant?.aggregateScores as Aggregate | undefined;
  const live: LiveInfo | null = progress.liveScholarName
    ? {
        name: progress.liveScholarName,
        readingLevel: progress.liveScholarReadingLevel ?? "",
        turns: progress.liveTranscript ?? [],
      }
    : null;
  // Scholars not yet finished and not currently streaming → queued.
  const doneIds = new Set(sessions.map((s) => s.profileId));
  const queued = roster
    .filter((r) => !doneIds.has(r.profileId) && r.name !== live?.name)
    .map((r) => ({ name: r.name, readingLevel: r.readingLevel }));
  return (
    <Stack gap={3} py={2} flex="1" minH="0">
      <HStack gap={2}>
        <Spinner size="sm" color="cyan.500" />
        <Text fontSize="sm" fontFamily="heading" color="charcoal.600" flex="1">
          {progress.message ?? `${MODE_LABEL[mode]} running…`}
        </Text>
        <Button
          size="xs"
          variant="outline"
          borderColor="gray.300"
          color="charcoal.500"
          onClick={onCancel}
          fontFamily="heading"
        >
          Cancel
        </Button>
      </HStack>
      <Progress.Root value={pct} size="sm" colorPalette="cyan">
        <Progress.Track borderRadius="full">
          <Progress.Range borderRadius="full" />
        </Progress.Track>
      </Progress.Root>
      <Text fontSize="xs" color="charcoal.400">
        {progress.sessionsDone}/{progress.sessionsTotal} runs
      </Text>

      {/* Stable sims list: every scholar from the start (done / streaming /
          queued) in run order, with a pending Overview that fills in when the
          sims finish. The streaming scholar is selected by default. */}
      <SimsBrowser
        fill
        overview={{
          verdict: experiment.overallVerdict,
          agg: baselineAgg,
          n: roster.length,
        }}
        sessions={sessions}
        live={live}
        queued={queued}
      />
    </Stack>
  );
}

type Detail = NonNullable<
  ReturnType<typeof useQuery<typeof api.curriculumExperiments.get>>
>;

function ResultsView({
  detail,
  onManualRehearsal,
  onFixFinding,
}: {
  detail: Detail;
  onManualRehearsal?: () => void;
  onFixFinding?: (field: RehearseFixField) => void;
}) {
  const { experiment, baselineVariant, variants, sessions } = detail;
  const promote = useMutation(api.curriculumExperiments.promoteVariant);
  const [promoting, setPromoting] = useState(false);

  if (experiment.status === "failed") {
    return (
      <Box borderWidth="1px" borderColor="red.200" bg="red.50" borderRadius="md" p={3}>
        <Text fontSize="sm" color="red.600" fontFamily="heading">
          Experiment failed
        </Text>
        <Text fontSize="xs" color="red.500" mt={1}>
          {experiment.error ?? "Unknown error."}
        </Text>
      </Box>
    );
  }
  if (experiment.status === "cancelled") {
    return (
      <Text fontSize="sm" color="charcoal.400" py={6}>
        Cancelled.
      </Text>
    );
  }

  const baselineAgg = baselineVariant?.aggregateScores as Aggregate | undefined;
  const candidates = variants
    .filter((v) => v.origin !== "baseline" && v.aggregateScores)
    .sort(
      (a, b) =>
        ((b.aggregateScores as Aggregate).fitness ?? 0) -
        ((a.aggregateScores as Aggregate).fitness ?? 0),
    );
  const champion = variants.find(
    (v) => v._id === experiment.bestVariantId && v.origin !== "baseline",
  );
  const best = champion ?? candidates[0];
  const bestAgg = best?.aggregateScores as Aggregate | undefined;
  const baselineSessions = sessions.filter(
    (s) => s.variantId === experiment.baselineVariantId,
  );
  const decision = baselineAgg && bestAgg ? isBetter(bestAgg, baselineAgg) : null;
  // Adoptable #3 — the persisted pairwise promote-gate result (propose/loop).
  // When present it's the AUTHORITATIVE promotion decision; the absolute
  // `decision` above is kept for the diagnosis DeltaTable + older experiments.
  const pairwise = experiment.pairwise as ExperimentPairwise | undefined;
  const promoted = pairwise ? pairwise.promote : (decision?.better ?? false);
  const alreadyPromoted = best?.status === "promoted";

  const handlePromote = async () => {
    if (!best) return;
    setPromoting(true);
    try {
      await promote({ variantId: best._id });
    } finally {
      setPromoting(false);
    }
  };

  return (
    <Stack gap={4} flex="1" minH="0">
      {/* Results — master/detail. The Overview entry (default-selected) shows
          the overall verdict + Activity Scorecard; each scholar shows their own
          verdict + scorecard, same shape. */}
      {baselineSessions.length > 0 && (
        <SimsBrowser
          fill
          sessions={baselineSessions}
          overview={
            baselineAgg
              ? {
                  verdict: experiment.overallVerdict,
                  agg: baselineAgg,
                  n: baselineAgg.n,
                  // With a proposed edit on screen, the verdict is about the
                  // starting activity — say so. Analyze has no edit → "Overall".
                  verdictLabel: best ? "Baseline verdict" : undefined,
                  preflightResult: experiment.preflightResult,
                }
              : undefined
          }
          onFixFinding={onFixFinding}
        />
      )}

      {/* Outcome probe (adoptable #1) — per-variant held-out pre→post means. */}
      <ProbeVariantSummary
        probeByVariant={detail.probeByVariant}
        baselineVariantId={experiment.baselineVariantId ?? null}
        candidate={best}
      />

      {/* Proposed edit (propose/loop) — the delta the loop suggests. */}
      {best && bestAgg && baselineAgg && decision && (
        <Box borderWidth="1px" borderColor="gray.200" borderRadius="md" p={3} bg="white">
          <HStack gap={2} mb={2}>
            <Text fontSize="sm" fontFamily="heading" fontWeight="semibold" color="charcoal.700">
              Proposed edit
            </Text>
            <Badge
              size="xs"
              colorPalette={promoted ? "green" : "gray"}
              variant="subtle"
            >
              {promoted
                ? pairwise
                  ? "sims prefer it"
                  : "clears the gate"
                : "held"}
            </Badge>
          </HStack>
          {/* Pairwise decision (adoptable #3) drives promotion; the DeltaTable
              below stays for absolute-dimension diagnosis. */}
          {pairwise && <PairwiseSummary pairwise={pairwise} />}
          <Text fontSize="xs" color="charcoal.400" mb={2}>
            {friendlyDecisionReason(decision)}
          </Text>
          <DeltaTable before={baselineAgg} after={bestAgg} />
        </Box>
      )}

      {/* Side-by-side diff + rationale (full width). */}
      {best && (
        <Box borderWidth="1px" borderColor="gray.200" borderRadius="md" p={3} bg="white">
          <HStack justify="space-between" mb={2}>
            <Text fontSize="sm" fontFamily="heading" fontWeight="semibold" color="charcoal.700">
              Prompt diff
            </Text>
            {alreadyPromoted ? (
              <HStack gap={2}>
                <Badge size="sm" colorPalette="green">
                  Promoted to activity ✓
                </Badge>
                {/* Handoff to the manual loop: hand-verify the AI's edit by
                    playing through it, then replay your turns (PR #148). */}
                {onManualRehearsal && (
                  <Button
                    size="xs"
                    variant="outline"
                    borderColor="cyan.400"
                    color="cyan.700"
                    _hover={{ bg: "cyan.50" }}
                    onClick={onManualRehearsal}
                    fontFamily="heading"
                  >
                    Rehearse manually with the new prompt →
                  </Button>
                )}
              </HStack>
            ) : (
              <Button
                size="xs"
                bg="green.500"
                color="white"
                _hover={{ bg: "green.600" }}
                onClick={handlePromote}
                loading={promoting}
                loadingText="Promoting…"
                fontFamily="heading"
              >
                Promote to activity
              </Button>
            )}
          </HStack>
          <SideBySideDiff
            before={baselineVariant?.systemPrompt ?? ""}
            after={best.systemPrompt ?? ""}
          />
          {best.rationale && (
            <Box mt={3}>
              <Text fontSize="xs" color="charcoal.500" fontFamily="heading" mb={0.5}>
                Why this edit
              </Text>
              <Text fontSize="xs" color="charcoal.600" lineHeight="1.6">
                {best.rationale}
              </Text>
            </Box>
          )}
        </Box>
      )}
    </Stack>
  );
}

// The "Reality check" tab: compare this run's sim baseline to real scholar
// transcripts. Owns the grounding action/state; the Debrief panel renders
// roomy (its own view) instead of cramped at the bottom of the results.
type ScholarFeedback = {
  count: number;
  examples: { snippet: string; reason: string | null }[];
};

type GroundingResult = {
  status: "done" | "no-data" | "error";
  trustworthy?: boolean;
  fitnessDelta?: number;
  realN?: number;
  note?: string;
  goalAttainmentOptimistic?: boolean;
  goalAttainmentDelta?: number;
  goalAttainmentNote?: string | null;
  scholarFeedback?: ScholarFeedback;
};

function DebriefView({
  detail,
  activityId,
  askAi,
}: {
  detail: Detail | null;
  activityId: Id<"activities">;
  askAi?: (prompt: string) => void;
}) {
  const ground = useMutation(api.curriculumExperiments.groundExperiment);
  const [grounding, setGrounding] = useState(false);
  const groundingResult = detail?.experiment.grounding as
    | GroundingResult
    | undefined;
  const handleGround = async () => {
    if (!detail) return;
    setGrounding(true);
    try {
      await ground({ experimentId: detail.experiment._id });
    } finally {
      setGrounding(false);
    }
  };
  return (
    <Stack gap={6} flex="1" minH="0" overflowY="auto">
      {/* Calibration: do the sims track real scholars? Only when a sim
          rehearsal exists to compare against. */}
      {detail ? (
        <Debrief
          grounding={groundingResult}
          onGround={handleGround}
          loading={grounding}
        />
      ) : (
        <Text fontSize="xs" color="charcoal.400">
          Run a Rehearse to also compare the sims against real scholars.
        </Text>
      )}
      {/* Judge ↔ teacher validation: blind pairwise picks over the real
          sessions the judge scored during grounding, correlated with the
          judge's ranking → our own r/agreement (sim-realism adoptable #2). */}
      <JudgeTeacherValidation activityId={activityId} />
      {/* The substantive half: real-scholar Key Moments to catch + action,
          and design moves — independent of whether a sim ran. */}
      <DebriefMoments activityId={activityId} askAi={askAi} />
    </Stack>
  );
}

// The grouped dimension meters — the single source of truth for the score grid,
// rendered for BOTH the sims aggregate and an individual scholar (fed by
// aggregate([verdict])). Each row is just label + meter + value (no icons —
// the meter color carries the group), so the labels share one clean left edge.
function DimMeters({
  agg,
  sourceVerdict,
}: {
  agg: Aggregate;
  sourceVerdict?: Partial<Record<CurriculumDimension, number | undefined>>;
}) {
  return (
    // The three groups sit side by side, each a single column — the old
    // 2-columns-per-group grid implied a meaning the columns didn't have.
    // Wraps to fewer columns when the pane is narrow.
    <Flex wrap="wrap" gap={6} align="start">
      {DIMENSION_GROUPS.map((g) => (
        <Box key={g.label} flex="1 1 260px" minW="240px">
          <GroupHeading label={g.label} caption={g.caption} />
          <Stack gap={1} mt={1}>
            {g.dims.map((d) => {
              // A dimension nobody was judged on must read as empty ("–"),
              // not as a genuine 0 — mean([]) is 0 and would render as a floor.
              const value = sourceVerdict
                ? finiteScore(sourceVerdict[d])
                : agg.judgedN?.[d] === 0
                  ? undefined
                  : finiteScore(agg.dims[d]);
              return (
              <HStack key={d} gap={2}>
                <Text
                  fontSize="xs"
                  color="charcoal.500"
                  width="112px"
                  flexShrink={0}
                  whiteSpace="nowrap"
                >
                  {DIMENSION_LABELS[d]}
                </Text>
                <Box flex="1">
                  <Progress.Root
                    value={meterPct(value)}
                    size="xs"
                    colorPalette={dimPalette(d)}
                  >
                    <Progress.Track borderRadius="full">
                      <Progress.Range borderRadius="full" />
                    </Progress.Track>
                  </Progress.Root>
                </Box>
                <Text fontSize="xs" color="charcoal.600" width="22px" flexShrink={0} textAlign="right">
                  {fmtScore(value)}
                </Text>
              </HStack>
              );
            })}
          </Stack>
        </Box>
      ))}
    </Flex>
  );
}

// Eyebrow heading for a dimension group — carries the meaning so the bar
// colors are reinforcement, not the only signal.
function GroupHeading({ label, caption }: { label: string; caption: string }) {
  return (
    <HStack gap={1.5} mb={1} align="baseline" flexWrap="wrap">
      <Text
        fontSize="xs"
        fontFamily="heading"
        fontWeight="semibold"
        letterSpacing="wide"
        textTransform="uppercase"
        color="charcoal.600"
      >
        {label}
      </Text>
      <Text fontSize="xs" color="charcoal.400">
        {caption}
      </Text>
    </HStack>
  );
}

function DeltaTable({ before, after }: { before: Aggregate; after: Aggregate }) {
  return (
    <Stack gap={3}>
      {DIMENSION_GROUPS.map((g) => (
        <Box key={g.label}>
          <GroupHeading label={g.label} caption={g.caption} />
          <Grid templateColumns="1fr 1fr" gapX={4} gapY={1}>
            {g.dims.map((d) => {
              const b = finiteScore(before.dims[d]);
              const a = finiteScore(after.dims[d]);
              const delta =
                b === undefined || a === undefined ? undefined : a - b;
              const arrow =
                delta !== undefined && delta > 0.001
                  ? "▲"
                  : delta !== undefined && delta < -0.001
                    ? "▼"
                    : "·";
              const color =
                delta !== undefined && delta > 0.001
                  ? "green.600"
                  : delta !== undefined && delta < -0.001
                    ? "red.500"
                    : "charcoal.400";
              return (
                <HStack key={d} gap={1.5} fontSize="xs">
                  <Text color="charcoal.500" width="92px" flexShrink={0}>
                    {DIMENSION_LABELS[d]}
                  </Text>
                  <Text color="charcoal.400" flex="1">
                    {fmtScore(b)}→{fmtScore(a)}
                  </Text>
                  <Text color={color} width="48px" flexShrink={0} fontFamily="heading">
                    {delta === undefined
                      ? "–"
                      : `${arrow}${delta >= 0 ? "+" : ""}${delta.toFixed(2)}`}
                  </Text>
                </HStack>
              );
            })}
          </Grid>
        </Box>
      ))}
    </Stack>
  );
}

type SbsRow = { left: string | null; right: string | null; changed: boolean };
function toSideBySide(before: string, after: string): SbsRow[] {
  const d = lineDiff(before, after);
  const rows: SbsRow[] = [];
  let i = 0;
  while (i < d.length) {
    if (d[i].sign === " ") {
      rows.push({ left: d[i].text, right: d[i].text, changed: false });
      i++;
    } else {
      const dels: string[] = [];
      const adds: string[] = [];
      while (i < d.length && d[i].sign === "-") dels.push(d[i++].text);
      while (i < d.length && d[i].sign === "+") adds.push(d[i++].text);
      const n = Math.max(dels.length, adds.length);
      for (let k = 0; k < n; k++) {
        rows.push({
          left: dels[k] ?? null,
          right: adds[k] ?? null,
          changed: true,
        });
      }
    }
  }
  return rows;
}

function SideBySideDiff({ before, after }: { before: string; after: string }) {
  const rows = toSideBySide(before, after);
  const cell = (text: string | null, changed: boolean, side: "l" | "r") => (
    <Box
      px={2}
      py={0.5}
      fontFamily="mono"
      fontSize="xs"
      whiteSpace="pre-wrap"
      color={
        text === null
          ? "transparent"
          : changed
            ? side === "l"
              ? "red.700"
              : "green.700"
            : "charcoal.500"
      }
      bg={
        changed
          ? side === "l"
            ? "red.50"
            : "green.50"
          : "transparent"
      }
      borderRightWidth={side === "l" ? "1px" : 0}
      borderColor="gray.200"
    >
      {text ?? "·"}
    </Box>
  );
  return (
    <Box
      borderWidth="1px"
      borderColor="gray.200"
      borderRadius="sm"
      overflow="hidden"
      maxH="320px"
      overflowY="auto"
    >
      <Grid templateColumns="1fr 1fr">
        {rows.map((r, i) => (
          <Box key={i} display="contents">
            {cell(r.left, r.changed, "l")}
            {cell(r.right, r.changed, "r")}
          </Box>
        ))}
      </Grid>
    </Box>
  );
}

// One selectable scholar row — shared chrome for the live + finished entries.
function SimRow({
  selected,
  onClick,
  children,
}: {
  selected: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <Flex
      as="button"
      direction="column"
      align="stretch"
      gap={1.5}
      px={2.5}
      py={2}
      borderWidth="1px"
      borderColor={selected ? "cyan.300" : "gray.200"}
      bg={selected ? "cyan.50" : "white"}
      borderRadius="md"
      onClick={onClick}
      textAlign="left"
      cursor="pointer"
      _hover={{ borderColor: "cyan.300" }}
    >
      {children}
    </Flex>
  );
}

// Mean of the curriculum-fit dims for one session verdict.
function fitOf(v: Record<string, number>): number {
  return FITNESS_DIMS.reduce((s, d) => s + (v[d] ?? 0), 0) / FITNESS_DIMS.length;
}

// One glanceable curriculum-fit meter for a sims row (Overview or a scholar) —
// replaces the three per-dim mini meters. The per-dim breakdown still lives in
// the detail view (DimMeters).
function FitMeter({ value }: { value: number }) {
  return (
    <Tooltip.Root openDelay={150} closeDelay={0}>
      <Tooltip.Trigger asChild>
        <HStack gap={2} w="full" cursor="default">
          <Box flex="1">
            <Progress.Root value={meterPct(value)} size="sm" colorPalette="cyan">
              <Progress.Track borderRadius="full">
                <Progress.Range borderRadius="full" />
              </Progress.Track>
            </Progress.Root>
          </Box>
          <Text fontSize="xs" color="charcoal.500" width="22px" flexShrink={0} textAlign="right">
            {fmtScore(value)}
          </Text>
        </HStack>
      </Tooltip.Trigger>
      <Portal>
        <Tooltip.Positioner>
          <Tooltip.Content>Goals · {fmtScore(value)}/5</Tooltip.Content>
        </Tooltip.Positioner>
      </Portal>
    </Tooltip.Root>
  );
}

// The Overview row's "avatar" — a neutral beaker glyph in the same ~28px slot
// as the scholar avatars, so the name gridline stays consistent.
function OverviewGlyph() {
  return (
    <Flex
      width="28px"
      height="28px"
      flexShrink={0}
      borderRadius="full"
      borderWidth="1px"
      borderColor="gray.200"
      bg="gray.50"
      color="charcoal.400"
      align="center"
      justify="center"
    >
      <Flask size={15} weight="duotone" />
    </Flex>
  );
}

function SimsBrowser({
  sessions,
  live,
  label,
  overview,
  queued,
  fill,
  onFixFinding,
}: {
  sessions: Detail["sessions"];
  live?: LiveInfo | null;
  label?: string;
  // The FIRST entry is an "Overview" (sims-level verdict + aggregate scorecard)
  // — same master/detail shape as a scholar. During a run `agg` is absent and
  // the row shows a pending state; `n` is always the full sim count.
  overview?: {
    verdict?: string;
    agg?: Aggregate;
    n: number;
    verdictLabel?: string;
    preflightResult?: PreflightResult;
  };
  // Scholars not yet started (running view) — shown queued, in order, so the
  // list is the whole sim roster from the start instead of growing as each finishes.
  queued?: { name: string; readingLevel: string }[];
  // Fill the available drawer height (detail pane flexes + scrolls) instead of
  // the fixed 360px cap. ResultsView passes this; RunningView keeps the cap.
  fill?: boolean;
  /** Routes a Preflight finding's "Fix this" to the EXISTING activity editor
   *  it targets (see components/nodeEditor/rehearseResult.ts). */
  onFixFinding?: (field: RehearseFixField) => void;
}) {
  const [selected, setSelected] = useState<number | null>(null);
  const detailRef = useRef<HTMLDivElement>(null);

  // Roster order: Overview, finished (in run order), the streaming one, then
  // the queued ones — a stable list that fills in place rather than reordering.
  const entries = [
    ...(overview ? [{ kind: "overview" as const, overview }] : []),
    ...sessions.map((s) => ({ kind: "done" as const, session: s })),
    ...(live ? [{ kind: "live" as const, live }] : []),
    ...(queued ?? []).map((q) => ({ kind: "queued" as const, queued: q })),
  ];
  // Selection follows the streaming scholar by default; once the user clicks a
  // row it sticks. Falls back to the first entry (Overview, in results).
  const liveIdx = entries.findIndex((e) => e.kind === "live");
  const sel = selected ?? (liveIdx >= 0 ? liveIdx : 0);
  const active = entries[sel] ?? entries[0];

  // Keep the detail pane pinned to the newest turn while watching the live one.
  const liveTurns = active?.kind === "live" ? active.live.turns.length : -1;
  useEffect(() => {
    const el = detailRef.current;
    if (el && active?.kind === "live") el.scrollTop = el.scrollHeight;
  }, [liveTurns, active?.kind]);

  return (
    <Box {...(fill ? { flex: "1", minH: "0", display: "flex", flexDirection: "column" as const } : {})}>
      {label && (
        <Text fontSize="sm" fontFamily="heading" fontWeight="semibold" color="charcoal.700" mb={2}>
          {label}
        </Text>
      )}
      <Flex
        gap={3}
        align="stretch"
        direction={{ base: "column", md: "row" }}
        {...(fill ? { flex: "1", minH: "0" } : {})}
      >
        {/* Master: Overview (when present) + scholar list (live one on top). */}
        <Stack gap={1} flexShrink={0} width={{ base: "100%", md: "230px" }}>
          {entries.map((e, i) => {
            // Indent for the meter + status so they line up with the NAME
            // (avatar slot 28px + the 2-gap = 36px), not the avatar.
            const indent = "36px";
            if (e.kind === "overview") {
              const ov = e.overview;
              // The rate's denominator excludes turn-capped sessions that never
              // showed goal evidence, so the count must use goalRateN, not n.
              const goalDenom = ov.agg ? (ov.agg.goalRateN ?? ov.agg.n ?? 0) : 0;
              const reached = ov.agg
                ? Math.round((ov.agg.goalAttainmentRate ?? 0) * goalDenom)
                : 0;
              const truncated = ov.agg?.goalTruncatedN ?? 0;
              return (
                <SimRow key="overview" selected={i === sel} onClick={() => setSelected(i)}>
                  <HStack align="center" gap={2}>
                    <OverviewGlyph />
                    <Text fontSize="xs" fontFamily="heading" color="charcoal.700">
                      Overview{" "}
                      <Text as="span" color="charcoal.400">
                        all {ov.n}
                      </Text>
                    </Text>
                  </HStack>
                  <Box pl={indent}>
                    {ov.agg ? (
                      <>
                        <FitMeter value={ov.agg.fitness ?? 0} />
                        <Text fontSize="xs" color="charcoal.400" mt={1}>
                          {goalDenom > 0
                            ? `${reached} of ${goalDenom} reached goal`
                            : "goal inconclusive"}
                          {truncated > 0 ? ` · ${truncated} cut short` : ""}
                        </Text>
                      </>
                    ) : (
                      <Text fontSize="xs" color="charcoal.400">
                        Running…
                      </Text>
                    )}
                  </Box>
                </SimRow>
              );
            }
            if (e.kind === "live") {
              return (
                <SimRow key="live" selected={i === sel} onClick={() => setSelected(i)}>
                  <HStack align="center" gap={2}>
                    {/* eslint-disable-next-line @next/next/no-img-element -- tiny static avatar icon; next/image is overkill */}
                    <img
                      src={scholarAvatar(e.live.name)}
                      alt=""
                      width={28}
                      height={28}
                      style={{
                        borderRadius: "9999px",
                        flexShrink: 0,
                        border: "1px solid var(--chakra-colors-gray-200)",
                      }}
                    />
                    <Text fontSize="xs" fontFamily="heading" color="charcoal.700" flex="1" minW="0">
                      {e.live.name}{" "}
                      <Text as="span" color="charcoal.400">
                        {e.live.readingLevel}
                      </Text>
                    </Text>
                    <Spinner size="xs" color="cyan.500" />
                  </HStack>
                  <Box pl={indent}>
                    <Text fontSize="xs" color="charcoal.400">
                      Streaming…
                    </Text>
                  </Box>
                </SimRow>
              );
            }
            if (e.kind === "queued") {
              return (
                <SimRow key={`q-${e.queued.name}`} selected={i === sel} onClick={() => setSelected(i)}>
                  <HStack align="center" gap={2} opacity={0.5}>
                    {/* eslint-disable-next-line @next/next/no-img-element -- tiny static avatar icon; next/image is overkill */}
                    <img
                      src={scholarAvatar(e.queued.name)}
                      alt=""
                      width={28}
                      height={28}
                      style={{
                        borderRadius: "9999px",
                        flexShrink: 0,
                        border: "1px solid var(--chakra-colors-gray-200)",
                        filter: "grayscale(1)",
                      }}
                    />
                    <Text fontSize="xs" fontFamily="heading" color="charcoal.700">
                      {e.queued.name}{" "}
                      <Text as="span" color="charcoal.400">
                        {e.queued.readingLevel}
                      </Text>
                    </Text>
                  </HStack>
                  <Box pl={indent}>
                    <Text fontSize="xs" color="charcoal.400">
                      Queued
                    </Text>
                  </Box>
                </SimRow>
              );
            }
            const s = e.session;
            const v = s.verdict as Record<string, number> | undefined;
            return (
              <SimRow key={s._id} selected={i === sel} onClick={() => setSelected(i)}>
                <HStack align="center" gap={2}>
                  {/* eslint-disable-next-line @next/next/no-img-element -- tiny static avatar icon; next/image is overkill */}
                  <img
                    src={scholarAvatar(s.profile?.name ?? "")}
                    alt=""
                    width={28}
                    height={28}
                    style={{
                      borderRadius: "9999px",
                      flexShrink: 0,
                      border: "1px solid var(--chakra-colors-gray-200)",
                    }}
                  />
                  <Text fontSize="xs" fontFamily="heading" color="charcoal.700">
                    {s.profile?.name ?? "scholar"}{" "}
                    <Text as="span" color="charcoal.400">
                      {s.profile?.readingLevel ?? ""}
                    </Text>
                  </Text>
                </HStack>
                <Box pl={indent}>
                  {v && <FitMeter value={fitOf(v)} />}
                  <Text fontSize="xs" color="charcoal.400" mt={1}>
                    {STOP_LABEL[s.stopReason] ?? s.stopReason}
                  </Text>
                </Box>
              </SimRow>
            );
          })}
        </Stack>

        {/* Detail: transcript of the selected scholar (live one streams). */}
        {active && (
          <Box
            ref={detailRef}
            flex="1"
            minH="0"
            borderWidth="1px"
            borderColor="gray.200"
            borderRadius="md"
            bg="white"
            maxH={fill ? undefined : "360px"}
            overflowY="auto"
          >
            {active.kind === "overview" ? (
              <OverviewDetail
                verdict={active.overview.verdict}
                agg={active.overview.agg}
                label={active.overview.verdictLabel}
                preflightResult={active.overview.preflightResult}
                onFixFinding={onFixFinding}
              />
            ) : active.kind === "live" ? (
              <LiveTranscriptBody name={active.live.name} turns={active.live.turns} />
            ) : active.kind === "queued" ? (
              <Box px={4} py={3}>
                <Text fontSize="sm" color="charcoal.400">
                  {active.queued.name} hasn&apos;t started yet — queued.
                </Text>
              </Box>
            ) : (
              <TranscriptDetail session={active.session} />
            )}
          </Box>
        )}
      </Flex>
    </Box>
  );
}

const SEVERITY_PALETTE: Record<PreflightResult["findings"][number]["severity"], string> = {
  critical: "red",
  high: "orange",
  medium: "yellow",
  low: "gray",
};

/**
 * The structured Preflight findings list — the evidence-backed twin of the
 * plain-text overall verdict above it. Each finding routes "Fix this" to the
 * EXISTING Resources / Deliverable / Duration / Tutor-prompt editor via
 * `onFixFinding`; a finding with nothing to route to (targetSurface
 * "rehearse", e.g. "re-run this") shows no button.
 */
function PreflightFindings({
  result,
  onFixFinding,
}: {
  result?: PreflightResult;
  onFixFinding?: (field: RehearseFixField) => void;
}) {
  if (!result) return null;
  const findings = sortedFindings(result);
  const coverageNotice = protectedCoverageNotice(result);
  if (findings.length === 0 && !coverageNotice) return null;

  return (
    <Box mb={4}>
      <Text
        fontSize="xs"
        fontFamily="heading"
        fontWeight="semibold"
        letterSpacing="wide"
        textTransform="uppercase"
        color="charcoal.400"
        mb={2}
      >
        Findings
      </Text>
      {coverageNotice && (
        <Text fontSize="xs" color="orange.600" mb={2}>
          {coverageNotice}
        </Text>
      )}
      <Stack gap={2}>
        {findings.map((finding) => {
          const field = fixFieldForFinding(finding);
          const showFix = !!field && !!onFixFinding && canFixFinding(result, finding);
          const coverageLabel = findingCoverageLabel(result, finding);
          return (
            <Box
              key={finding.id}
              borderWidth="1px"
              borderColor="gray.200"
              borderRadius="md"
              p={2}
              bg="white"
            >
              <HStack justify="space-between" align="start" gap={2}>
                <Stack gap={1} flex="1" minW="0">
                  <HStack gap={2} wrap="wrap">
                    <Badge size="xs" colorPalette={SEVERITY_PALETTE[finding.severity]} variant="subtle">
                      {finding.severity}
                    </Badge>
                    {coverageLabel && (
                      <Badge size="xs" colorPalette="gray" variant="outline">
                        {coverageLabel}
                      </Badge>
                    )}
                    <Text fontSize="sm" fontFamily="heading" color="charcoal.700">
                      {finding.title}
                    </Text>
                  </HStack>
                  <Text fontSize="xs" color="charcoal.500">
                    {finding.suggestedAction}
                  </Text>
                  {finding.evidence.length > 0 && (
                    <Text fontSize="xs" color="charcoal.400">
                      {finding.evidence[0]}
                    </Text>
                  )}
                </Stack>
                {showFix && (
                  <Tooltip.Root>
                    <Tooltip.Trigger asChild>
                      <Button
                        size="xs"
                        variant="outline"
                        borderColor="cyan.400"
                        color="cyan.700"
                        _hover={{ bg: "cyan.50" }}
                        onClick={() => onFixFinding?.(field as RehearseFixField)}
                        fontFamily="heading"
                        flexShrink={0}
                      >
                        Fix this →
                      </Button>
                    </Tooltip.Trigger>
                    <Portal>
                      <Tooltip.Positioner>
                        <Tooltip.Content maxW="260px">
                          {findingHandoffCaveat(finding, result.coverage.context)}
                        </Tooltip.Content>
                      </Tooltip.Positioner>
                    </Portal>
                  </Tooltip.Root>
                )}
              </HStack>
            </Box>
          );
        })}
      </Stack>
    </Box>
  );
}

// The "Overview" entry's detail: the sims-level overall verdict (pinned, same
// as a scholar's) + the aggregate Activity Scorecard. Same shape as
// TranscriptDetail so the master/detail reads consistently.
function OverviewDetail({
  verdict,
  agg,
  label,
  preflightResult,
  onFixFinding,
}: {
  verdict?: string;
  agg?: Aggregate;
  // In propose/loop the verdict describes the BASELINE sims (the edit's delta
  // lives in the separate "Proposed edit" box), so callers relabel it.
  label?: string;
  preflightResult?: PreflightResult;
  onFixFinding?: (field: RehearseFixField) => void;
}) {
  return (
    <Box px={4} py={3}>
      {verdict && (
        <Box mb={4}>
          <Text
            fontSize="xs"
            fontFamily="heading"
            fontWeight="semibold"
            letterSpacing="wide"
            textTransform="uppercase"
            color="charcoal.400"
            mb={1}
          >
            {label ?? "Overall verdict"}
          </Text>
          <Text fontSize="sm" color="charcoal.700" lineHeight="1.55">
            {verdict}
          </Text>
        </Box>
      )}
      <PreflightFindings result={preflightResult} onFixFinding={onFixFinding} />
      {/* No headline fitness/goal or "Scorecard" subhead — the sims row shows
          the fit meter + goal, and the verdict above sets the context. This is
          just the full per-dim breakdown. */}
      {agg ? (
        <DimMeters agg={agg} />
      ) : (
        <Text fontSize="sm" color="charcoal.400">
          The sims are still running — the verdict and scores appear when they
          finish.
        </Text>
      )}
    </Box>
  );
}

// Scorecard | Transcript toggle for a scholar's detail pane — Chakra line
// tabs, with the underline broken out to the card edges (negative mx counters
// the card's px so the rule reads wall-to-wall).
function DetailTabs({
  tab,
  setTab,
}: {
  tab: "scorecard" | "transcript";
  setTab: (t: "scorecard" | "transcript") => void;
}) {
  return (
    <Tabs.Root
      value={tab}
      onValueChange={(e) => setTab(e.value as "scorecard" | "transcript")}
      variant="line"
      size="sm"
      colorPalette="cyan"
    >
      <Tabs.List mx={-4} px={4}>
        <Tabs.Trigger value="scorecard" fontFamily="heading" fontSize="xs">
          Scorecard
        </Tabs.Trigger>
        <Tabs.Trigger value="transcript" fontFamily="heading" fontSize="xs">
          Transcript
        </Tabs.Trigger>
      </Tabs.List>
    </Tabs.Root>
  );
}

function TranscriptDetail({ session }: { session: Detail["sessions"][number] }) {
  const [tab, setTab] = useState<"scorecard" | "transcript">("scorecard");
  const v = session.verdict as
    | { summary?: string; stallPoint?: string; promptAttribution?: string }
    | undefined;
  // This scholar's own scores, in the SAME grouped grid as the sims aggregate
  // (a single verdict → aggregate of one).
  const verdict = session.verdict as SessionVerdict | undefined;
  const scores = verdict ? aggregate([verdict]) : null;
  return (
    // Less space above the tabs (pt=2); the tab content is indented to line up
    // with the "Scorecard" tab label (pl below), not the card edge.
    <Box px={4} pt={2} pb={3}>
      <DetailTabs tab={tab} setTab={setTab} />
      {tab === "scorecard" ? (
        <Box mt={3} pl={3}>
          {/* Verdict lives only on the Scorecard tab (the Transcript is just the
              conversation). */}
          {(v?.summary || (v?.stallPoint && v.stallPoint !== "none")) && (
            <Box mb={3}>
              <Text
                fontSize="xs"
                fontFamily="heading"
                fontWeight="semibold"
                letterSpacing="wide"
                textTransform="uppercase"
                color="charcoal.400"
                mb={1}
              >
                Verdict
              </Text>
              {v?.summary && (
                <Text fontSize="sm" color="charcoal.700" lineHeight="1.55">
                  {v.summary}
                </Text>
              )}
              {/* Sticking point reads as part of the verdict — same style, italic. */}
              {v?.stallPoint && v.stallPoint !== "none" && (
                <Text fontSize="sm" color="charcoal.700" lineHeight="1.55" fontStyle="italic" mt={2}>
                  <Text as="span" fontWeight="semibold">
                    Sticking point:
                  </Text>{" "}
                  {v.stallPoint}
                </Text>
              )}
            </Box>
          )}
          <ProbeScholarDetail probe={session.probe} skipReason={session.probeSkipReason} />
          {scores && <DimMeters agg={scores} sourceVerdict={verdict} />}
        </Box>
      ) : (
        <Stack gap={3} align="stretch" mt={3} pl={3}>
          {session.transcript.map((t, i) => (
            // Same chat UI as the curriculum bot: AI tutor → flat markdown,
            // scholar → right-aligned bubble (see AideMessageBubble).
            <AideMessageBubble
              key={i}
              role={t.role === "tutor" ? "assistant" : "user"}
              content={t.content}
            />
          ))}
        </Stack>
      )}
    </Box>
  );
}

function Debrief({
  grounding,
  onGround,
  loading,
}: {
  grounding: GroundingResult | undefined;
  onGround: () => void;
  loading: boolean;
}) {
  return (
    <Box pt={1}>
      <Text fontSize="sm" fontFamily="heading" fontWeight="semibold" color="charcoal.700" mb={1.5}>
        Debrief
      </Text>
      {!grounding && (
        <HStack gap={3}>
          <Button
            size="xs"
            variant="outline"
            borderColor="gray.300"
            color="charcoal.600"
            onClick={onGround}
            loading={loading}
            loadingText="Comparing…"
            fontFamily="heading"
          >
            Compare to real scholars
          </Button>
          <Text fontSize="xs" color="charcoal.400">
            Judge real scholar transcripts on this activity and check the sim
            isn&apos;t too rosy.
          </Text>
        </HStack>
      )}
      {grounding?.status === "no-data" && (
        <HStack gap={2}>
          <Text fontSize="xs" color="charcoal.400">
            {grounding.note}
          </Text>
          <Button size="2xs" variant="plain" color="cyan.500" onClick={onGround} loading={loading}>
            Retry
          </Button>
        </HStack>
      )}
      {grounding?.status === "error" && (
        <Text fontSize="xs" color="red.500">
          Grounding failed: {grounding.note}
        </Text>
      )}
      {grounding?.status === "done" && (
        <Box
          borderWidth="1px"
          borderColor={grounding.trustworthy ? "green.200" : "amber.300"}
          bg={grounding.trustworthy ? "green.50" : "amber.50"}
          borderRadius="md"
          p={2.5}
        >
          <HStack gap={2} mb={0.5}>
            <Badge
              size="xs"
              colorPalette={grounding.trustworthy ? "green" : "orange"}
              variant="subtle"
            >
              {grounding.trustworthy ? "Matches real scholars" : "Off from real scholars"}
            </Badge>
            <Text fontSize="xs" color="charcoal.500">
              Δfitness {grounding.fitnessDelta?.toFixed(2)} · {grounding.realN} real
              session{grounding.realN === 1 ? "" : "s"}
            </Text>
          </HStack>
          <Text fontSize="xs" color="charcoal.600" lineHeight="1.5">
            {grounding.note}
          </Text>
          {/* Grounding hygiene: goalAttainment specifically running hot — the
              sim kid declares understanding real kids don't reach, i.e. a
              too-eager [[DONE]]. Surfaced even when overall fit looks fine. */}
          {grounding.goalAttainmentOptimistic && (
            <Box
              mt={2}
              borderTopWidth="1px"
              borderColor="amber.200"
              pt={2}
            >
              <HStack gap={1.5} mb={0.5}>
                <Badge size="xs" colorPalette="orange" variant="solid">
                  [[DONE]] too easy
                </Badge>
                <Text fontSize="xs" color="charcoal.500">
                  goalAttainment Δ{grounding.goalAttainmentDelta?.toFixed(2)} sim over real
                </Text>
              </HStack>
              <Text fontSize="xs" color="charcoal.600" lineHeight="1.5">
                {grounding.goalAttainmentNote}
              </Text>
            </Box>
          )}
        </Box>
      )}
      {/* Scholar "got this wrong" flags on this activity — the qualitative
          half of the Debrief, shown whenever scholars caught the tutor out
          (independent of whether a sim baseline exists to calibrate against). */}
      {grounding?.scholarFeedback && grounding.scholarFeedback.count > 0 && (
        <Box
          mt={2.5}
          borderWidth="1px"
          borderColor="amber.200"
          bg="amber.50"
          borderRadius="md"
          p={2.5}
        >
          <HStack gap={2} mb={1}>
            <Box as="span" color="amber.700" display="inline-flex" aria-hidden>
              <ThumbsDown size={15} weight="fill" />
            </Box>
            <Text
              fontSize="xs"
              fontFamily="heading"
              fontWeight="semibold"
              color="amber.700"
            >
              Scholars flagged {grounding.scholarFeedback.count} response
              {grounding.scholarFeedback.count === 1 ? "" : "s"} as wrong
            </Text>
          </HStack>
          <Stack gap={1.5}>
            {grounding.scholarFeedback.examples.map((ex, i) => (
              <Box key={i} fontSize="xs" lineHeight="1.4">
                <Text
                  as="span"
                  color="charcoal.500"
                  css={{ fontStyle: "italic" }}
                >
                  &ldquo;{ex.snippet}&rdquo;
                </Text>
                {ex.reason && (
                  <Text as="span" color="amber.700">
                    {" "}
                    — {ex.reason}
                  </Text>
                )}
              </Box>
            ))}
          </Stack>
        </Box>
      )}
    </Box>
  );
}
