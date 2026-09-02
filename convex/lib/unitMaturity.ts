// Unit maturity — the single "where is this unit on the quality ladder"
// model. See review/curriculum-rehearse-and-maturity.md.
//
// One legible rail, four stages earned by the actions that produce them:
//
//   Draft  →  Reviewed  →  Rehearsed  →  Debriefed
//   (built)   (coherent)   (sims ran ok) (matches real scholars)
//
// This file is PURE (no ctx, no Convex calls) so it's cheap to test and
// it's the shared source of truth for both the rail UI and any server
// query that needs a unit's standing. The Convex query in
// `convex/unitMaturity.ts` assembles the inputs from real data and calls
// `computeUnitMaturity`.

// ─── Completeness (what "Draft" measures) ────────────────────────────
//
// Folds in the old standalone "7/7" CompletenessMeter: a unit is past
// Draft once every structural essential is present. The component
// `components/CompletenessMeter.tsx` imports `buildCompletenessCriteria`
// so the checklist never drifts from the rail.

export interface CompletenessCriterion {
  label: string;
  met: boolean;
}

export interface CompletenessUnitInput {
  bigIdea?: string | null;
  essentialQuestions?: string[] | null;
  enduringUnderstandings?: string[] | null;
}

export interface CompletenessLessonInput {
  strand?: string | null;
  systemPrompt?: string | null;
}

export function buildCompletenessCriteria(
  unit: CompletenessUnitInput,
  lessons: CompletenessLessonInput[],
): CompletenessCriterion[] {
  return [
    { label: "Big Idea", met: !!unit.bigIdea?.trim() },
    { label: "Essential Questions", met: (unit.essentialQuestions?.length ?? 0) > 0 },
    {
      label: "Enduring Understandings",
      met: (unit.enduringUnderstandings?.length ?? 0) > 0,
    },
    { label: "Core lesson", met: lessons.some((l) => l.strand === "core") },
    { label: "Connections lesson", met: lessons.some((l) => l.strand === "connections") },
    { label: "Practice lesson", met: lessons.some((l) => l.strand === "practice") },
    {
      label: "All prompts generated",
      met: lessons.length > 0 && lessons.every((l) => l.systemPrompt?.trim()),
    },
  ];
}

/**
 * Cheap structural-completeness check: is the unit still in **Draft** (not
 * every structural essential present)? Wraps `buildCompletenessCriteria` so
 * "what counts as built" lives in one place. Pure — no `ctx`, no Convex — so
 * it's safe to import client-side and cheap to run per row (the caller passes
 * the unit + its lessons it already has in hand; no `getNodeStatuses` needed).
 */
export function isStructurallyDraft(
  unit: CompletenessUnitInput,
  lessons: CompletenessLessonInput[],
): boolean {
  return buildCompletenessCriteria(unit, lessons).some((c) => !c.met);
}

// ─── The maturity ladder ──────────────────────────────────────────────

export type MaturityStageId =
  | "draft"
  | "reviewed"
  | "rehearsed"
  | "assigned"
  | "debriefed";

export const MATURITY_STAGE_ORDER: MaturityStageId[] = [
  "draft",
  "reviewed",
  "rehearsed",
  "assigned",
  "debriefed",
];

// A rehearsal "passes" when its judged aggregate fitness clears this bar
// (fitness is the mean of the curriculum-fit dims, 1–5). Coarse on
// purpose — the rail is a legibility surface, not a gate. Tune alongside
// lib/curriculumScore thresholds.
export const REHEARSE_PASS_FITNESS = 3.5;

export interface MaturityInput {
  unit: CompletenessUnitInput;
  lessons: CompletenessLessonInput[];
  /** Latest durable coherence Review, or null if never reviewed. */
  review: { openGapCount: number } | null;
  /**
   * Rehearsal roll-up across the unit's ONLINE activities (the only kind
   * a sim can run). `passing` = activities with ≥1 rehearsal scorecard at
   * or above REHEARSE_PASS_FITNESS.
   */
  rehearsal: { onlineCount: number; passing: number } | null;
  /**
   * Whether the unit is live with real scholars — `activeCount` = active
   * (non-archived) assignments. The **bridge** between the sim-world rungs
   * and Debrief: Debrief compares sims to real scholars, and real-scholar
   * data only exists once the unit's been assigned. Lights **independently**
   * (you can ship at any maturity — it's an execution fact, not a design
   * grade), unlike the strictly-sequential confidence rungs.
   */
  assignment: { activeCount: number } | null;
  /** Sim-vs-real calibration for the unit's rehearsed activities. */
  grounding: { groundedCount: number; trustworthyCount: number } | null;
}

export interface MaturityStage {
  id: MaturityStageId;
  label: string;
  done: boolean;
  /** Short status shown under the lamp, e.g. "3/7 essentials". */
  detail: string;
}

export interface UnitMaturity {
  stages: MaturityStage[];
  /** Furthest stage earned (defaults to "draft" when none earned yet). */
  currentStageId: MaturityStageId;
  /** First un-earned stage — the suggested next action; null if all done. */
  frontierStageId: MaturityStageId | null;
  completeness: { completed: number; total: number; criteria: CompletenessCriterion[] };
}

const STAGE_LABEL: Record<MaturityStageId, string> = {
  draft: "Draft",
  // Renamed for clarity (PR #1072 §3): the cheap Curriculum-Bot coherence pass
  // is a "Heuristic review", the expensive sim pass is a "Scholar-bot rehearsal".
  reviewed: "Heuristic review",
  rehearsed: "Scholar-bot rehearsal",
  assigned: "Assigned",
  debriefed: "Debriefed",
};

export function computeUnitMaturity(input: MaturityInput): UnitMaturity {
  const criteria = buildCompletenessCriteria(input.unit, input.lessons);
  const completed = criteria.filter((c) => c.met).length;
  const total = criteria.length;

  // Each stage is gated on the previous being done — the ladder is
  // strictly sequential (you don't "rehearse" an incoherent unit).
  const draftDone = completed === total;

  const reviewedDone =
    draftDone && input.review !== null && input.review.openGapCount === 0;

  const onlineCount = input.rehearsal?.onlineCount ?? 0;
  const passing = input.rehearsal?.passing ?? 0;
  const rehearsedDone = reviewedDone && onlineCount > 0 && passing === onlineCount;

  // Assigned is the bridge to the real world — lit by an active
  // assignment, INDEPENDENT of the confidence rungs (you can ship a draft).
  const activeAssignments = input.assignment?.activeCount ?? 0;
  const assignedDone = activeAssignments > 0;

  const grounded = input.grounding?.groundedCount ?? 0;
  const trustworthy = input.grounding?.trustworthyCount ?? 0;
  // Debriefed needs the real-scholar grounding data (which only exists once
  // the unit's been assigned + worked). NOT gated on assignedDone being
  // CURRENTLY true — you might debrief, then archive the assignment.
  const debriefedDone =
    rehearsedDone && grounded > 0 && trustworthy === grounded;

  const stages: MaturityStage[] = [
    {
      id: "draft",
      label: STAGE_LABEL.draft,
      done: draftDone,
      detail: draftDone ? "Built" : `${completed}/${total} essentials`,
    },
    {
      id: "reviewed",
      label: STAGE_LABEL.reviewed,
      done: reviewedDone,
      detail:
        input.review === null
          ? "Not reviewed"
          : input.review.openGapCount > 0
            ? `${input.review.openGapCount} gap${input.review.openGapCount === 1 ? "" : "s"} open`
            : "Coherent",
    },
    {
      id: "rehearsed",
      label: STAGE_LABEL.rehearsed,
      done: rehearsedDone,
      detail:
        onlineCount === 0
          ? "No online activities"
          : `${passing}/${onlineCount} activities`,
    },
    {
      id: "assigned",
      label: STAGE_LABEL.assigned,
      done: assignedDone,
      detail: assignedDone
        ? `Assigned to ${activeAssignments} cohort${activeAssignments === 1 ? "" : "s"}`
        : "Not yet assigned",
    },
    {
      id: "debriefed",
      label: STAGE_LABEL.debriefed,
      done: debriefedDone,
      detail:
        input.grounding === null || grounded === 0
          ? "Not debriefed"
          : trustworthy === grounded
            ? "Matches real scholars"
            : "Off from real scholars",
    },
  ];

  // currentStage = furthest done; frontier = first not-done.
  let currentStageId: MaturityStageId = "draft";
  for (const s of stages) {
    if (s.done) currentStageId = s.id;
  }
  const frontier = stages.find((s) => !s.done);

  return {
    stages,
    currentStageId,
    frontierStageId: frontier ? frontier.id : null,
    completeness: { completed, total, criteria },
  };
}

// ─── Signal 1 · Readiness (the preflight gate, green) ─────────────────
//
// PR #1072 §4/§8 decomposes the single maturity scalar into two independent
// signals. Readiness is the one that FILLS: a monotonic gate a teacher
// finishes once, before assigning. It is NOT the field record (that's the
// Sessions signal, `lib/activitySessions.ts`), so it deliberately does NOT
// depend on assignments, real sessions, or the sim↔real `trustworthy`
// calibration (that bug — "Proven certifies sim-accuracy, not learning" — is
// killed by simply not consulting it here).
//
//   Built  →  Heuristic review  →  Scholar-bot rehearsal  →  ✓ Ready
//
// "Ready" = built AND heuristic-reviewed AND (rehearsal passed OR skipped OR
// nothing online to rehearse). The expensive rehearsal is skippable.

export type ReadinessStepId = "built" | "heuristicReview" | "scholarBotRehearsal";

export const READINESS_STEP_LABEL: Record<ReadinessStepId, string> = {
  built: "Built",
  heuristicReview: "Heuristic review",
  scholarBotRehearsal: "Scholar-bot rehearsal",
};

export type ReadinessStepState =
  | "todo" // not started
  | "running" // a review / rehearsal is in flight → Spinner
  | "done" // cleared (green)
  | "skipped" // deliberately skipped (hatched) — still counts toward Ready
  | "na"; // nothing to do at this altitude (e.g. no online activities)

export interface ReadinessStep {
  id: ReadinessStepId;
  label: string;
  state: ReadinessStepState;
  detail: string;
}

export interface Readiness {
  steps: ReadinessStep[];
  /** All gates cleared (done / skipped / n-a) ⇒ ready to assign. */
  ready: boolean;
  /** A gate is actively running (review or rehearsal in flight). */
  running: boolean;
  /** The running step, if any (drives the Spinner). */
  runningStepId: ReadinessStepId | null;
  /** First actionable (todo) step — the frontier; null once ready. */
  frontierStepId: ReadinessStepId | null;
  /** Whether the rehearsal gate was cleared by an explicit skip. */
  rehearsalSkipped: boolean;
}

export interface ReadinessInput {
  /** Built = structural completeness / has a system prompt at this altitude. */
  built: boolean;
  builtDetail: string;
  /** Latest durable heuristic review, or null if never reviewed. */
  review: { openGapCount: number } | null;
  /** A heuristic review is running right now. */
  reviewRunning?: boolean;
  /**
   * Scholar-bot rehearsal roll-up across ONLINE activities at this altitude.
   * `onlineCount === 0` ⇒ nothing to rehearse (n/a, doesn't block Ready).
   */
  rehearsal: { onlineCount: number; passing: number } | null;
  /** A scholar-bot rehearsal is running right now. */
  rehearsalRunning?: boolean;
  /** The (expensive) rehearsal was explicitly skipped — still counts as Ready. */
  rehearsalSkipped?: boolean;
}

export function deriveReadiness(input: ReadinessInput): Readiness {
  const builtStep: ReadinessStep = {
    id: "built",
    label: READINESS_STEP_LABEL.built,
    state: input.built ? "done" : "todo",
    detail: input.builtDetail,
  };

  // Heuristic review — actionable once built. Running only matters until clean.
  const reviewClean = input.review !== null && input.review.openGapCount === 0;
  const reviewStep: ReadinessStep = {
    id: "heuristicReview",
    label: READINESS_STEP_LABEL.heuristicReview,
    state: !input.built
      ? "todo"
      : reviewClean
        ? "done"
        : input.reviewRunning
          ? "running"
          : "todo",
    detail:
      input.review === null
        ? "Not reviewed"
        : input.review.openGapCount > 0
          ? `${input.review.openGapCount} gap${input.review.openGapCount === 1 ? "" : "s"} open`
          : "Coherent",
  };

  // Scholar-bot rehearsal — the expensive gate. Skip and n/a both satisfy it.
  const onlineCount = input.rehearsal?.onlineCount ?? 0;
  const passing = input.rehearsal?.passing ?? 0;
  const rehearseClean = onlineCount > 0 && passing === onlineCount;
  let rehearseState: ReadinessStepState;
  let rehearseDetail: string;
  if (input.rehearsalSkipped) {
    rehearseState = "skipped";
    rehearseDetail = "Skipped";
  } else if (onlineCount === 0) {
    rehearseState = "na";
    rehearseDetail = "No online activities";
  } else if (rehearseClean) {
    rehearseState = "done";
    rehearseDetail = `${passing}/${onlineCount} activities`;
  } else if (input.rehearsalRunning) {
    rehearseState = "running";
    rehearseDetail = "Running…";
  } else {
    rehearseState = "todo";
    rehearseDetail = `${passing}/${onlineCount} activities`;
  }
  const rehearseStep: ReadinessStep = {
    id: "scholarBotRehearsal",
    label: READINESS_STEP_LABEL.scholarBotRehearsal,
    state: rehearseState,
    detail: rehearseDetail,
  };

  const steps = [builtStep, reviewStep, rehearseStep];
  const satisfied = (s: ReadinessStep) =>
    s.state === "done" || s.state === "skipped" || s.state === "na";
  const ready = steps.every(satisfied);
  const runningStep = steps.find((s) => s.state === "running") ?? null;
  const frontierStep = steps.find((s) => s.state === "todo") ?? null;

  return {
    steps,
    ready,
    running: runningStep !== null,
    runningStepId: runningStep ? runningStep.id : null,
    frontierStepId: frontierStep ? frontierStep.id : null,
    rehearsalSkipped: rehearseState === "skipped",
  };
}

/** Build the unit-level Readiness input from an already-computed maturity +
 *  the runtime running/skip flags, so the query doesn't re-derive completeness. */
export function unitReadinessInput(
  maturity: UnitMaturity,
  input: MaturityInput,
  flags: { reviewRunning?: boolean; rehearsalRunning?: boolean; rehearsalSkipped?: boolean } = {},
): ReadinessInput {
  const { completed, total } = maturity.completeness;
  return {
    built: completed === total,
    builtDetail: completed === total ? "Built" : `${completed}/${total} essentials`,
    review: input.review,
    reviewRunning: flags.reviewRunning,
    rehearsal: input.rehearsal,
    rehearsalRunning: flags.rehearsalRunning,
    rehearsalSkipped: flags.rehearsalSkipped,
  };
}

// ─── Per-node status (the outline dot + the vertical Summary timeline) ──
//
// The maturity rail rolls up to the WHOLE unit, but rehearsal/debrief are
// activity-grained — so each node carries its OWN coarse status, shown as
// a dot in the outline (replacing the duration tag) and as a fuller
// vertical timeline on that node's Summary tab. See
// review/curriculum-rehearse-and-maturity.md.
//
//   built       non-rehearsable activity (offline/web/share-back) — its
//               quality is judged at the unit's Review, nothing to rehearse
//   draft       online, no rehearsal yet                          (hollow)
//   inProgress  rehearsed & passing, not yet debriefed            (half)
//   matured     debriefed and the sims match real scholars        (solid)
//   needsWork   a rehearsal failed, or the debrief said the sims
//               are off from real scholars                        (alert)

export type NodeStatus =
  | "built"
  | "draft"
  | "inProgress"
  | "matured"
  | "needsWork";

/** One online activity's place on its own Draft → Rehearsed → Debriefed
 *  ladder, from facts already reduced out of the variant/experiment tables.
 *  Non-online activities don't rehearse → always "built". */
export function activityNodeStatus(input: {
  isOnline: boolean;
  /** Highest variant fitness across this activity's rehearsals, null if none ran. */
  bestFitness: number | null;
  /** A debrief (grounding pass) has compared sims to real scholars. */
  grounded: boolean;
  /** …and it found the sims trustworthy (matched real scholars). */
  trustworthy: boolean;
}): NodeStatus {
  if (!input.isOnline) return "built";
  if (input.grounded) return input.trustworthy ? "matured" : "needsWork";
  if (input.bestFitness === null) return "draft";
  return input.bestFitness >= REHEARSE_PASS_FITNESS ? "inProgress" : "needsWork";
}

/** Roll a lesson's status up from its activities. Non-rehearsable children
 *  ("built") don't count toward the ladder; a lesson with only those (or
 *  none) is itself "built". */
export function rollupNodeStatus(children: NodeStatus[]): NodeStatus {
  const ladder = children.filter((s) => s !== "built");
  if (ladder.length === 0) return "built";
  if (ladder.some((s) => s === "needsWork")) return "needsWork";
  if (ladder.every((s) => s === "matured")) return "matured";
  if (ladder.some((s) => s === "matured" || s === "inProgress")) return "inProgress";
  return "draft";
}

/** The unit's dot, from its furthest-earned maturity stage. */
export function unitNodeStatus(stageId: MaturityStageId): NodeStatus {
  switch (stageId) {
    case "debriefed":
      return "matured";
    case "assigned":
    case "rehearsed":
    case "reviewed":
      return "inProgress";
    default:
      return "draft";
  }
}
