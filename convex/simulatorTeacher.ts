/**
 * TEACHER-facing World EXECUTION + DEBRIEF surfaces (plan §8, P2). The DESIGN
 * layer (Edit tab: worldDesign / saveSimulatorSpec) lives in convex/simulator.ts under
 * the canonical curriculum gate. This file owns only the execution/observation
 * reads the Preflight, Assign, and Debrief tabs need. It never edits the
 * committed engine/bench/run files; it reads the same tables and reuses their
 * exported helpers (pauseAssignment / resumeAssignment / grantRuns, the engine
 * internals, budgetWindowKeys) so each behaviour has one implementation.
 *
 * ACCESS (review P0): a teacher-role gate is not enough. Every read here is
 * ROW-SCOPED — design/Preflight/Debrief reads run requireUnitEditAccess (the
 * same curriculum gate the activity editor uses, so a curriculum designer works
 * and no teacher reads a unit they don't own); assignment reads check the
 * assignment owner AND that the activity belongs to the assignment's unit.
 *
 * DOCTRINE (plan §8, §9.5): every criterion number is a fact about a DECK, never
 * a rank of a child. No uncalibrated verdict or "worth discussing" classifier
 * ships (review T6); the Debrief serves factual, sortable trails.
 */
import { v } from "convex/values";

import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { teacherMutation, teacherQuery } from "./lib/customFunctions";
import { resolveActiveMembership } from "./lib/access";
import { requireUnitEditAccess } from "./lib/auth";
import { AUTOMATON_MODEL } from "./lib/models";
import {
  DECISION_HASH_VERSION,
  MAX_AUTOMATA_PER_RUN,
  PROMPT_PROTOCOL_VERSION,
  RENDERER_PROTOCOL_VERSION,
  SIMULATOR_PROTOCOL_VERSION,
  type DeckCard,
  type SimulatorSpec,
} from "../lib/simulator/contract";
import { canonicalJson, sha256Hex } from "../lib/simulator/prompt";
import type { ReferencePolicyDeck } from "../lib/simulator/policyIR";
import { getSimulatorTemplate } from "../lib/simulator/templates/registry";
import {
  ENDGAME_DISCOVERY_TEMPLATES,
  ENDGAME_DISCUSSION_QUESTION,
  detectEndgameDefection,
} from "../lib/simulator/endgameDiscovery";
import { hypothesisLabel } from "../lib/simulator/helpers";
import {
  lockedPoliciesForSystemsAgentsSpec,
  referenceDeckForSystemsAgentsSpec,
  simulatorSpecForStorage,
} from "./seed/systemsAgents";
import { launchedSpeciesForDeck, validateDeckForSpec } from "./simulatorBenches";
import {
  DEFAULT_BLOCK_RUN_LIMIT,
  DEFAULT_WEEK_RUN_LIMIT,
  assertPopulationRunCanLaunch,
  budgetWindowKeys,
} from "./simulatorRuns";
import {
  computeTrail,
  criterionSpread,
  invalidRate,
  strategySignature,
  zeroHypothesisScholars,
  type CriterionDirection,
  type RunFact,
  type ScholarTrailInput,
} from "../lib/simulator/teacherDigest";
import {
  buildDegenerateProbe,
  buildReferenceProbe,
  criterionSeparation,
  degenerateProbePlan,
  type DegenerateProbe,
  type DegenerateVariant,
} from "./lib/simulatorRedTeam";

type DbCtx = QueryCtx | MutationCtx;

// ── Preflight bounds (review P0: a hard, spec-independent ceiling) ───────────
// Fixed here in code, NOT derived from the author-controlled spec maxima, so a
// direct caller cannot request template-absolute ticks × many runs of paid work.
const PREFLIGHT_STARTER_RUNS = 2;
const PREFLIGHT_RUNS_PER_PROBE = 1;
const PREFLIGHT_REFERENCE_RUNS = 2;
const PREFLIGHT_MAX_TICKS = 25;
const PREFLIGHT_DEFAULT_TICKS = 20;
// Preflight rides the engine's per-window budget machinery: a small fixed number
// of BATCHES per two-hour block window per activity. No free-click paid launches.
const PREFLIGHT_BATCHES_PER_BLOCK = 3;

const PREFLIGHT_SESSION_PREFIX = "[Preflight] ";
const PREFLIGHT_TAG = "pf:";

function isPreflightRun(run: Doc<"simulatorRuns">): boolean {
  return run.hypothesis?.note?.startsWith(PREFLIGHT_TAG) ?? false;
}

function clampInt(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.round(value)));
}

function scholarName(user: Doc<"users"> | null): string {
  return user?.name ?? user?.username ?? "Scholar";
}

/**
 * Scoring facts for any criterion in the union. Measured → its metric+direction;
 * adversarial → its first score metric (maximize), so tournament worlds don't
 * crash the generic Debrief; gallery → no numeric score.
 */
function criterionScoring(criterion: SimulatorSpec["criterion"]): {
  metricKey: string | null;
  direction: CriterionDirection;
  target: number | undefined;
} {
  if (criterion.kind === "measured") {
    return { metricKey: criterion.metricKey, direction: criterion.direction, target: criterion.target };
  }
  if (criterion.kind === "adversarial") {
    return { metricKey: criterion.scoreMetricKeys[0] ?? null, direction: "maximize", target: undefined };
  }
  return { metricKey: null, direction: "maximize", target: undefined };
}

function runCriterionScore(run: Doc<"simulatorRuns">, metricKey: string | null): number | null {
  if (!metricKey) return null;
  return (
    run.criterionScores.find((metric) => metric.key === metricKey)?.value ??
    (run.status === "completed"
      ? run.currentMetrics.find((metric) => metric.key === metricKey)?.value
      : undefined) ??
    null
  );
}

function bestOnOwnCriterion(runs: readonly Doc<"simulatorRuns">[]): number | null {
  const latest = runs[0];
  if (!latest) return null;
  const latestCriterionJson = canonicalJson(latest.simulatorSpecSnapshot.criterion);
  const { metricKey, direction, target } = criterionScoring(
    latest.simulatorSpecSnapshot.criterion,
  );
  const scores = runs
    .filter(
      (run) =>
        canonicalJson(run.simulatorSpecSnapshot.criterion) === latestCriterionJson,
    )
    .map((run) => runCriterionScore(run, metricKey))
    .filter((score): score is number => score !== null);
  if (scores.length === 0) return null;
  if (direction === "minimize") return Math.min(...scores);
  if (direction === "target") {
    const targetValue = target ?? 0;
    return scores.reduce((best, score) =>
      Math.abs(score - targetValue) < Math.abs(best - targetValue) ? score : best,
    );
  }
  return Math.max(...scores);
}

function activitySimulatorSpec(activity: Doc<"activities"> | null): SimulatorSpec | null {
  const spec = activity?.simulatorSpec;
  if (!activity || activity.kind !== "simulator" || !spec) return null;
  return spec as SimulatorSpec;
}

async function assertAssignmentOwnerAndActivity(
  ctx: DbCtx & { user: Doc<"users"> },
  assignmentId: Id<"assignments">,
  activity: Doc<"activities">,
): Promise<Doc<"assignments">> {
  const assignment = await ctx.db.get(assignmentId);
  if (!assignment) throw new Error("Assignment not found");
  if (assignment.teacherId !== ctx.user._id && ctx.user.role !== "platform_admin") {
    throw new Error("Only the assignment teacher can read this cohort's Worlds");
  }
  // The activity must belong to the assignment's unit — an owner of assignment A
  // may not pass activity B from a unit they can't edit and read its Debrief.
  const lesson = activity.lessonId ? await ctx.db.get(activity.lessonId) : null;
  if (!lesson || lesson.unitId !== assignment.unitId) {
    throw new Error("Activity does not belong to this assignment");
  }
  return assignment;
}

// ── PREFLIGHT tab ────────────────────────────────────────────────────────────

async function ensurePreflightSession(
  ctx: MutationCtx & { user: Doc<"users"> },
  activity: Doc<"activities">,
): Promise<Doc<"sessions">> {
  const existing = (
    await ctx.db
      .query("sessions")
      .withIndex("by_user", (query) => query.eq("userId", ctx.user._id))
      .collect()
  ).find(
    (session) =>
      session.activityId === activity._id &&
      session.sessionMode === "workbench" &&
      (session.title ?? "").startsWith(PREFLIGHT_SESSION_PREFIX),
  );
  if (existing) return existing;
  const lesson = activity.lessonId
    ? await ctx.db.get(activity.lessonId)
    : null;
  const unit = lesson ? await ctx.db.get(lesson.unitId) : null;
  const institutionId =
    unit?.institutionId ??
    (await resolveActiveMembership(ctx, ctx.user))?.institutionId;
  const id = await ctx.db.insert("sessions", {
    userId: ctx.user._id,
    institutionId,
    activityId: activity._id,
    sessionMode: "workbench",
    title: `${PREFLIGHT_SESSION_PREFIX}${activity.title}`,
    isArchived: false,
  });
  return (await ctx.db.get(id))!;
}

async function preflightSessionFor(
  ctx: DbCtx & { user: Doc<"users"> },
  activityId: Id<"activities">,
): Promise<Doc<"sessions"> | null> {
  return (
    (
      await ctx.db
        .query("sessions")
        .withIndex("by_user", (query) => query.eq("userId", ctx.user._id))
        .collect()
    ).find(
      (session) =>
        session.activityId === activityId &&
        session.sessionMode === "workbench" &&
        (session.title ?? "").startsWith(PREFLIGHT_SESSION_PREFIX),
    ) ?? null
  );
}

async function launchPreflightRun(
  ctx: MutationCtx,
  input: {
    session: Doc<"sessions">;
    activity: Doc<"activities">;
    spec: SimulatorSpec;
    template: NonNullable<ReturnType<typeof getSimulatorTemplate>>;
    deck: DeckCard[];
    ticks: number;
    tag: string;
    blockKey: string;
    weekKey: string;
    compiled?: Pick<
      DegenerateProbe,
      "compiledPolicyHash" | "interpreterVersion" | "compiledPolicySnapshot"
    >;
    seed?: string;
  },
): Promise<Id<"simulatorRuns">> {
  const {
    session,
    activity,
    spec,
    template,
    deck,
    ticks,
    tag,
    blockKey,
    weekKey,
    compiled,
  } = input;
  const seed = input.seed ?? crypto.randomUUID().replace(/-/g, "");
  const species = preflightSpeciesForLaunch({ spec, deck, compiled });
  const state = template.initialState({
    config: spec.config,
    species,
    seed,
  });
  const scene = template.renderScene({ state, tick: 0 });
  const simulatorSpecHash = await sha256Hex(canonicalJson(spec));
  const now = Date.now();
  const runId = await ctx.db.insert("simulatorRuns", {
    sessionId: session._id,
    scholarId: session.userId,
    activityId: activity._id,
    runKind: "iteration",
    targetTicks: ticks,
    deckSnapshot: deck,
    deckVersion: 0,
    deckHash: await sha256Hex(canonicalJson(deck)),
    simulatorSpecSnapshot: simulatorSpecForStorage(spec),
    simulatorSpecHash,
    ...(compiled
      ? {
          compiledPolicyHash: compiled.compiledPolicyHash,
          interpreterVersion: compiled.interpreterVersion,
          compiledPolicySnapshot: compiled.compiledPolicySnapshot,
        }
      : {}),
    hypothesis: { prediction: "exploratory", note: tag },
    seed,
    status: "queued",
    nextTick: 0,
    attempt: 0,
    chunkCount: 0,
    latestCommittedTick: 0,
    latestSnapshotJson: canonicalJson(state),
    latestSceneJson: canonicalJson(scene),
    currentMetrics: [],
    summarySeries: [],
    criterionScores: [],
    extinct: false,
    invalidActionCount: 0,
    modelCallCount: 0,
    decisionCacheHitCount: 0,
    attemptLog: [],
    budgetState: "reserved",
    budgetBlockKey: blockKey,
    budgetWeekKey: weekKey,
    blockLimitSnapshot: DEFAULT_BLOCK_RUN_LIMIT,
    weekLimitSnapshot: DEFAULT_WEEK_RUN_LIMIT,
    modelId: AUTOMATON_MODEL,
    simulatorProtocolVersion: SIMULATOR_PROTOCOL_VERSION,
    promptProtocolVersion: PROMPT_PROTOCOL_VERSION,
    decisionHashVersion: DECISION_HASH_VERSION,
    physicsTemplateVersion: template.version,
    rendererProtocolVersion: RENDERER_PROTOCOL_VERSION,
    queuedAt: now,
    updatedAt: now,
  });
  await ctx.scheduler.runAfter(0, internal.simulatorEngine.dispatchQueued, {});
  return runId;
}

type PreflightCompiledPolicies = Pick<
  DegenerateProbe,
  "compiledPolicyHash" | "interpreterVersion" | "compiledPolicySnapshot"
>;

export function preflightSpeciesForLaunch(input: {
  spec: SimulatorSpec;
  deck: readonly DeckCard[];
  compiled?: PreflightCompiledPolicies;
}) {
  const species = launchedSpeciesForDeck(input.spec, input.deck);
  assertPopulationRunCanLaunch({
    automataCount: species.reduce((total, slot) => total + slot.count, 0),
    interpreterVersion: input.compiled?.interpreterVersion,
    policies: input.compiled?.compiledPolicySnapshot,
  });
  return species;
}

/**
 * Preflight achievability + criterion red-team (plan §8): two starter duplicates
 * calibrate the observed noise band; deterministic template-supported probes
 * test whether the criterion separates authored effort from degenerate behavior.
 *
 * REVIEW P0 — this is a BUDGETED, rate-limited path, not a free-click paid
 * launch: (1) rejects while a batch is already active (idempotency), (2) fixed
 * runs/ticks caps independent of spec maxima, (3) a small per-block-window
 * allowance riding the same reservation windows scholar launches use. A batch
 * is 2 starter runs + 1 per supported probe: currently 5 ecosystem runs and 4
 * Prisoner's Dilemma runs. New templates grow this only by explicitly adding a
 * probe to the registry-driven plan.
 */
export const startPreflight = teacherMutation({
  args: { activityId: v.id("activities"), ticks: v.optional(v.number()) },
  handler: async (ctx, args) => {
    await requireUnitEditAccess(ctx, { activityId: args.activityId });
    const activity = await ctx.db.get(args.activityId);
    const spec = activitySimulatorSpec(activity);
    if (!activity || !spec) throw new Error("Not a World activity");
    const template = getSimulatorTemplate(spec.templateId);
    if (!template) throw new Error(`Unknown World template "${spec.templateId}"`);
    template.validateSpec(spec);

    const ticks = clampInt(
      args.ticks ?? PREFLIGHT_DEFAULT_TICKS,
      5,
      Math.min(PREFLIGHT_MAX_TICKS, spec.tickBudget.absoluteMaxTicks),
    );
    const session = await ensurePreflightSession(ctx, activity);

    const preflightRuns = (
      await ctx.db
        .query("simulatorRuns")
        .withIndex("by_session", (query) => query.eq("sessionId", session._id))
        .collect()
    ).filter(isPreflightRun);

    // (1) Idempotency: never enqueue a second batch while one is in flight.
    if (preflightRuns.some((run) => run.status === "queued" || run.status === "ticking")) {
      throw new Error("A Preflight batch is already running — wait for it to finish.");
    }

    // (3) Per-block allowance: count distinct batches launched this window.
    const now = Date.now();
    const { blockKey, weekKey } = budgetWindowKeys(now, undefined);
    const batchesThisBlock = new Set(
      preflightRuns
        .filter((run) => run.budgetBlockKey === blockKey)
        .map((run) => run.hypothesis?.note?.match(/^pf:(\d+):/)?.[1])
        .filter((value): value is string => value !== undefined),
    );
    if (batchesThisBlock.size >= PREFLIGHT_BATCHES_PER_BLOCK) {
      throw new Error(
        `Preflight allowance for this block is used up (${PREFLIGHT_BATCHES_PER_BLOCK} batches). Try again in the next block.`,
      );
    }

    const reasonableDeck: DeckCard[] = spec.speciesSlots.map((slot) => ({
      slotId: slot.slotId,
      count: slot.defaultCount,
      prompt: slot.starterHint ?? "",
    }));
    validateDeckForSpec(spec, reasonableDeck);
    const referenceDeck = referenceDeckForSystemsAgentsSpec(spec);
    const lockedPolicies = lockedPoliciesForSystemsAgentsSpec(spec);
    const referenceProbe = referenceDeck
      ? await buildReferenceProbe(spec, referenceDeck)
      : null;
    const populationScale =
      reasonableDeck.reduce((total, card) => total + card.count, 0) >
      MAX_AUTOMATA_PER_RUN;
    const probePlan =
      spec.templateId === "prisonersDilemma" && spec.speciesSlots.length < 2
        ? {
            variants: [] as DegenerateVariant[],
            note: "Head-to-head red-team probes require two strategy slots.",
          }
        : lockedPolicies === null
          ? {
              variants: [] as DegenerateVariant[],
              note: "Shortcut checks need authored policies for every locked slot.",
            }
        : degenerateProbePlan(spec.templateId);
    const probes = new Map<
      DegenerateVariant,
      Awaited<ReturnType<typeof buildDegenerateProbe>>
    >();
    for (const variant of probePlan.variants) {
      const probe = await buildDegenerateProbe(spec, variant, {
        lockedPolicies: lockedPolicies ?? undefined,
      });
      validateDeckForSpec(probe.simulatorSpec, probe.deck);
      probes.set(variant, probe);
    }

    const batch = now;
    const runIds: Id<"simulatorRuns">[] = [];
    // Starter calibration still uses the authored prompt through live Haiku.
    // Population-scale Preflight therefore runs only the server-built compiled
    // probes; launching a >12 starter here would violate the live-run cap.
    if (!populationScale) {
      for (let i = 0; i < PREFLIGHT_STARTER_RUNS; i += 1) {
        runIds.push(
          await launchPreflightRun(ctx, {
            session,
            activity,
            spec,
            template,
            deck: reasonableDeck,
            ticks,
            tag: `${PREFLIGHT_TAG}${batch}:reasonable`,
            blockKey,
            weekKey,
          }),
        );
      }
    }
    if (referenceProbe) {
      for (let i = 0; i < PREFLIGHT_REFERENCE_RUNS; i += 1) {
        runIds.push(
          await launchPreflightRun(ctx, {
            session,
            activity,
            spec: referenceProbe.simulatorSpec,
            template,
            deck: referenceProbe.deck,
            ticks,
            tag: `${PREFLIGHT_TAG}${batch}:reference`,
            blockKey,
            weekKey,
            compiled: referenceProbe,
            seed: `reference:${activity._id}:${i}`,
          }),
        );
      }
    }
    for (const variant of probePlan.variants) {
      const probe = probes.get(variant)!;
      for (let i = 0; i < PREFLIGHT_RUNS_PER_PROBE; i += 1) {
        runIds.push(
          await launchPreflightRun(ctx, {
            session,
            activity,
            spec: probe.simulatorSpec,
            template,
            deck: probe.deck,
            ticks,
            tag: `${PREFLIGHT_TAG}${batch}:${variant}`,
            blockKey,
            weekKey,
            compiled: probe,
          }),
        );
      }
    }
    return { sessionId: session._id, batch, runIds, ticks };
  },
});

/**
 * Reactive Preflight readout: the latest batch's per-variant criterion spread,
 * invalid-action rate, calibrated degenerate-deck verdicts, the remaining human
 * review, and budget/active state.
 */
export const preflightStatus = teacherQuery({
  args: { activityId: v.id("activities") },
  handler: async (ctx, args) => {
    await requireUnitEditAccess(ctx, { activityId: args.activityId });
    const activity = await ctx.db.get(args.activityId);
    const spec = activitySimulatorSpec(activity);
    if (!activity || !spec) return null;
    const criterionKind = spec.criterion.kind;
    const speciesSlotCount = spec.speciesSlots.length;
    const adversarialScoreKeys =
      spec.criterion.kind === "adversarial"
        ? [...spec.criterion.scoreMetricKeys]
        : null;
    const probePlan =
      spec.templateId === "prisonersDilemma" && speciesSlotCount < 2
        ? {
            variants: [] as DegenerateVariant[],
            note: "Head-to-head red-team probes require two strategy slots.",
          }
        : degenerateProbePlan(spec.templateId);
    const { metricKey, direction, target } = criterionScoring(spec.criterion);
    const referenceDeck = referenceDeckForSystemsAgentsSpec(spec);
    const humanChecklist =
      spec.templateId === "ecosystemGrid"
        ? [
            {
              title: "Reproduction boom",
              detail:
                "Check whether the criterion rewards a population spike before the later starvation crash. This still needs judgment across the summary series.",
            },
          ]
        : [];

    const session = await preflightSessionFor(ctx, args.activityId);
    const emptyResult = {
      criterion: { kind: spec.criterion.kind, direction, target: target ?? null, metricKey },
      batch: null as string | null,
      variants: null as null | {
        reasonable: Awaited<ReturnType<typeof variantFacts>>;
        reference: Awaited<ReturnType<typeof variantFacts>> | null;
        probes: Array<{
          variant: DegenerateVariant;
          facts: Awaited<ReturnType<typeof variantFacts>>;
        }>;
      },
      redTeam: null as ReturnType<typeof redTeamFacts> | null,
      probeVariants: probePlan.variants,
      probeNote: probePlan.note,
      reference: referenceDeck
        ? {
            summary: referenceDeck.summary,
            preflightStory: referenceDeck.preflightStory ?? null,
            available: true,
          }
        : { summary: null, preflightStory: null, available: false },
      active: false,
      allowancePerBlock: PREFLIGHT_BATCHES_PER_BLOCK,
      batchesThisBlock: 0,
      humanChecklist,
      reading: {
        state: "not-run" as const,
        verdict: "Not rehearsed yet",
        title: "Rehearse before you assign this",
        summary:
          "Sims will check whether a scholar has to think this activity through, or could score just as well with one simple rule.",
        nextStep: "Run Preflight before assigning this activity.",
        evidence: null as null | {
          intendedLabel: string;
          intendedMean: number;
          referenceMean: number | null;
          shortcutMinMean: number;
          shortcutMaxMean: number;
          story: ReferencePolicyDeck["preflightStory"] | null;
        },
      },
    };
    if (!session) return emptyResult;

    const runs = (
      await ctx.db
        .query("simulatorRuns")
        .withIndex("by_session", (query) => query.eq("sessionId", session._id))
        .collect()
    ).filter(isPreflightRun);

    const now = Date.now();
    const { blockKey } = budgetWindowKeys(now, undefined);
    const batchesThisBlock = new Set(
      runs
        .filter((run) => run.budgetBlockKey === blockKey)
        .map((run) => run.hypothesis?.note?.match(/^pf:(\d+):/)?.[1])
        .filter((value): value is string => value !== undefined),
    ).size;
    const active = runs.some((run) => run.status === "queued" || run.status === "ticking");

    const batches = runs
      .map((run) => run.hypothesis?.note?.match(/^pf:(\d+):/)?.[1])
      .filter((value): value is string => value !== undefined);
    const latestBatch = batches.length > 0 ? batches.sort().at(-1)! : null;
    const batchRuns = runs.filter((run) =>
      run.hypothesis?.note?.startsWith(`${PREFLIGHT_TAG}${latestBatch}:`),
    );

    async function variantFacts(name: "reasonable" | "reference" | DegenerateVariant) {
      const rows = batchRuns.filter((run) => run.hypothesis?.note?.endsWith(`:${name}`));
      const completed = rows.filter((run) => run.status === "completed");
      const scores = completed
        .map((run) => runCriterionScore(run, metricKey))
        .filter((value): value is number => value !== null);
      const modelCalls = rows.reduce((sum, run) => sum + run.modelCallCount, 0);
      const fallbackToNeutralCount =
        name === "greedy"
          ? (
              await Promise.all(
                completed.map((run) =>
                  ctx.db
                    .query("simulatorRunChunks")
                    .withIndex("by_run_startTick", (query) =>
                      query.eq("runId", run._id),
                    )
                    .collect(),
                ),
              )
            )
              .flatMap((chunks) => chunks)
              .flatMap((chunk) => chunk.ticks)
              .flatMap((tick) => tick.automata)
              .filter((decision) =>
                decision.policyTrace?.includes(
                  "but that action was not legal now",
                ),
              ).length
          : null;
      return {
        total: rows.length,
        completed: completed.length,
        running: rows.filter((run) => run.status === "queued" || run.status === "ticking").length,
        crashed: rows.filter((run) => run.status === "crashed").length,
        spread: criterionSpread(scores),
        fallbackToNeutralCount,
        invalidRate:
          modelCalls === 0
            ? null
            : invalidRate(
                rows.map((run) => ({
                  runId: String(run._id),
                  deckVersion: 0,
                  status: run.status,
                  criterionScore: null,
                  invalidActionCount: run.invalidActionCount,
                  modelCallCount: run.modelCallCount,
                  queuedAt: run.queuedAt,
                  hasHypothesis: false,
                })),
              ),
      };
    }
    const variants = latestBatch
      ? {
          reasonable: await variantFacts("reasonable"),
          reference: referenceDeck ? await variantFacts("reference") : null,
          probes: await Promise.all(
            probePlan.variants.map(async (variant) => ({
              variant,
              facts: await variantFacts(variant),
            })),
          ),
        }
      : null;
    // The red-team calibration compares shortcuts against the starter strategy,
    // so this visible baseline must use that same spread. The authored reference
    // deck is valuable context, but it is not the calibrated comparison sample.
    const intendedSpread = variants?.reasonable.spread ?? null;
    const referenceMean = variants?.reference?.spread?.mean ?? null;
    const shortcutMeans =
      variants?.probes
        .map((probe) => probe.facts.spread?.mean)
        .filter((mean): mean is number => mean !== null && mean !== undefined) ??
      [];
    const evidence =
      intendedSpread && shortcutMeans.length > 0
        ? {
            intendedLabel:
              "Starter strategy",
            intendedMean: intendedSpread.mean,
            referenceMean,
            shortcutMinMean: Math.min(...shortcutMeans),
            shortcutMaxMean: Math.max(...shortcutMeans),
            story: referenceDeck?.preflightStory ?? null,
          }
        : null;
    function redTeamFacts() {
      if (!variants) return null;
      const hasHeadToHeadDecks =
        criterionKind === "adversarial" && speciesSlotCount > 1;
      return {
        noiseBand:
          variants.reasonable.spread && variants.reasonable.spread.count >= 2
            ? variants.reasonable.spread.max - variants.reasonable.spread.min
            : null,
        calibrationUnavailable:
          variants.reasonable.total === 0 &&
          variants.probes.some(({ facts }) => facts.total > 0),
        rows: variants.probes.map(({ variant, facts }) => {
          const referenceMetricKey =
            hasHeadToHeadDecks
              ? adversarialScoreKeys?.[1] ?? null
              : null;
          const reference =
            referenceMetricKey
              ? criterionSpread(
                  batchRuns
                    .filter(
                      (run) =>
                        run.status === "completed" &&
                        run.hypothesis?.note?.endsWith(`:${variant}`),
                    )
                    .map((run) =>
                      runCriterionScore(run, referenceMetricKey),
                    )
                    .filter((value): value is number => value !== null),
                )
              : undefined;
          return {
            variant,
            comparison:
              hasHeadToHeadDecks
                ? "starter-hint opponent"
                : "starter-hint runs",
            fallbackToNeutralCount: facts.fallbackToNeutralCount,
            separation: criterionSeparation({
              starter: variants.reasonable.spread,
              degenerate: facts.spread,
              direction,
              target,
              reference,
            }),
          };
        }),
      };
    }
    const redTeam = redTeamFacts();
    const readingBase = !variants
      ? emptyResult.reading
      : active
        ? {
            state: "running" as const,
            verdict: "Rehearsing now",
            title: "Sims are rehearsing",
            summary:
              referenceDeck?.preflightStory?.setup ??
              "Preflight is still collecting the reference, starter, and shortcut evidence.",
            nextStep: "Wait for the rehearsal to finish before changing the activity.",
          }
        : redTeam === null || redTeam.rows.length === 0
          ? {
              // No probe ran at all (e.g. a one-slot Prisoner's Dilemma, where
              // head-to-head probes need two strategy slots). Every `some()`
              // check below is vacuously false on an empty row set, so this
              // must be caught before the clear branch can claim a pass.
              state: "incomplete" as const,
              verdict: "Can't tell yet",
              title: "No shortcuts were tested",
              summary:
                "Preflight did not test any shortcuts for this configuration, so it cannot say whether a scholar could skip the thinking this activity is meant to teach.",
              nextStep:
                "Open the evidence to see why no shortcut ran, then ask Curriculum Bot what to check next.",
            }
          : redTeam.rows.some((row) => row.separation === null)
          ? {
              state: "incomplete" as const,
              verdict: "Can't tell yet",
              title: "Some checks didn't finish",
              summary:
                "Preflight did not complete every shortcut check, so it cannot yet say whether a simple rule beats the thinking this activity is meant to teach.",
              nextStep:
                "Open the evidence, then rehearse again or ask Curriculum Bot what to check next.",
            }
          : redTeam.rows.some(
                (row) => row.separation?.verdict === "degenerate-wins",
              )
            ? {
                state: "attention" as const,
                verdict: "Needs a change before you assign",
                title: "A shortcut wins",
                summary:
                  "A scholar could score as well as the intended strategy without doing the thinking this activity is meant to teach.",
                nextStep:
                  "Open the evidence, then ask Curriculum Bot for the smallest revision to test.",
              }
            : redTeam.rows.some((row) => row.separation?.verdict === "close")
              ? {
                  state: "attention" as const,
                  verdict: "Needs a change before you assign",
                  title: "A shortcut comes too close",
                  summary:
                    "A simple rule scores close enough to the intended strategy that a scholar may not need the thinking this activity is meant to teach.",
                  nextStep:
                    "Open the evidence, then ask Curriculum Bot for the smallest revision to test.",
                }
              : {
                  state: "clear" as const,
                  verdict: "Ready to assign",
                  title: "Scholars can't shortcut this one",
                  summary:
                    "Every simple rule Preflight tested scored well below the intended strategy, so the activity still rewards the thinking you designed it for.",
                  nextStep:
                    "No revision suggested. Keep the current configuration and rerun Preflight after a meaningful change.",
                };
    const reading = { ...readingBase, evidence };

    return {
      criterion: { kind: spec.criterion.kind, direction, target: target ?? null, metricKey },
      batch: latestBatch,
      variants,
      redTeam,
      probeVariants: probePlan.variants,
      probeNote: probePlan.note,
      reference: referenceDeck
        ? {
            summary: referenceDeck.summary,
            preflightStory: referenceDeck.preflightStory ?? null,
            available: true,
          }
        : { summary: null, preflightStory: null, available: false },
      active,
      allowancePerBlock: PREFLIGHT_BATCHES_PER_BLOCK,
      batchesThisBlock,
      humanChecklist,
      reading,
    };
  },
});

// ── ASSIGN tab ───────────────────────────────────────────────────────────────

/** Does this unit contain any World activities? Gates the World-only controls. */
export const unitHasWorld = teacherQuery({
  args: { unitId: v.id("units") },
  handler: async (ctx, args) => {
    const lessons = await ctx.db
      .query("lessons")
      .withIndex("by_unit", (query) => query.eq("unitId", args.unitId))
      .collect();
    let count = 0;
    let firstActivityId: Id<"activities"> | null = null;
    for (const lesson of lessons) {
      const activities = await ctx.db
        .query("activities")
        .withIndex("by_lesson", (query) => query.eq("lessonId", lesson._id))
        .collect();
      for (const activity of activities) {
        if (activity.kind !== "simulator") continue;
        count += 1;
        firstActivityId ??= activity._id;
      }
    }
    return { hasWorld: count > 0, count, firstActivityId };
  },
});

/** Per-assignment run-budget override (plan §8 Assign). Mirrors launchRun's invariant. */
export const setAssignmentWorldBudget = teacherMutation({
  args: {
    assignmentId: v.id("assignments"),
    perScholarBlock: v.number(),
    perScholarWeek: v.number(),
    timeZone: v.optional(v.string()),
    seasonTicks: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const assignment = await ctx.db.get(args.assignmentId);
    if (!assignment) throw new Error("Assignment not found");
    if (assignment.teacherId !== ctx.user._id && ctx.user.role !== "platform_admin") {
      throw new Error("Only the assignment teacher can manage this cohort's Worlds");
    }
    const block = Math.round(args.perScholarBlock);
    const week = Math.round(args.perScholarWeek);
    if (block < 1 || week < block) {
      throw new Error("Run budget must have block ≥ 1 and week ≥ block");
    }
    if (args.seasonTicks !== undefined && (!Number.isInteger(args.seasonTicks) || args.seasonTicks < 1)) {
      throw new Error("Season length must be a positive whole number of ticks");
    }
    const budget = {
        perScholarBlock: block,
        perScholarWeek: week,
        ...(args.timeZone ? { timeZone: args.timeZone } : {}),
      };
    await ctx.db.patch(args.assignmentId, {
      simulatorRunBudget: budget,
      // undefined clears the override (back to the Simulator's own season length).
      simulatorSeasonTicks: args.seasonTicks,
    });
    return { perScholarBlock: block, perScholarWeek: week, seasonTicks: args.seasonTicks ?? null };
  },
});

/**
 * The live classroom readout (plan §8 Assign): pause state, cohort active/queued
 * runs and model-call count, and one row PER BENCH (session) — not aggregated to
 * an arbitrary session — so the grant control targets exactly the bench it names
 * (review P1). Every scholar in the roster is represented; a scholar who hasn't
 * opened a bench gets a non-grantable row.
 *
 * REVIEW P1 (clock): window keys derive from a client-supplied, server-validated
 * clock (`clientNowMs`) so the reactive subscription re-derives at block/week
 * boundaries instead of freezing on a stale key until an unrelated write.
 */
export const assignmentReadout = teacherQuery({
  args: { assignmentId: v.id("assignments"), clientNowMs: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const assignment = await ctx.db.get(args.assignmentId);
    if (!assignment) return null;
    if (assignment.teacherId !== ctx.user._id && ctx.user.role !== "platform_admin") {
      throw new Error("Only the assignment teacher can read this cohort's Worlds");
    }
    const serverNow = Date.now();
    const now =
      args.clientNowMs !== undefined && Math.abs(args.clientNowMs - serverNow) < 15 * 60 * 1000
        ? args.clientNowMs
        : serverNow;
    const runBudget = assignment.simulatorRunBudget;
    const blockLimit = runBudget?.perScholarBlock ?? DEFAULT_BLOCK_RUN_LIMIT;
    const weekLimit = runBudget?.perScholarWeek ?? DEFAULT_WEEK_RUN_LIMIT;
    const { blockKey, weekKey } = budgetWindowKeys(
      now,
      String(args.assignmentId),
      runBudget?.timeZone,
    );

    // Benches keyed by session are the true grant target (grantRuns is bench-local).
    const benches = await ctx.db
      .query("simulatorBenches")
      .withIndex("by_assignment_scholar", (query) => query.eq("assignmentId", args.assignmentId))
      .collect();
    const runs = await ctx.db
      .query("simulatorRuns")
      .withIndex("by_assignment", (query) => query.eq("assignmentId", args.assignmentId))
      .collect();

    type Agg = { blockUsed: number; weekUsed: number; activeRuns: number; modelCalls: number };
    const bySession = new Map<string, Agg>();
    let activeRuns = 0;
    let queuedRuns = 0;
    let totalModelCalls = 0;
    for (const run of runs) {
      if (run.status === "ticking") activeRuns += 1;
      if (run.status === "queued") queuedRuns += 1;
      totalModelCalls += run.modelCallCount;
      const key = String(run.sessionId);
      const agg = bySession.get(key) ?? { blockUsed: 0, weekUsed: 0, activeRuns: 0, modelCalls: 0 };
      if (run.budgetState === "reserved" && run.budgetBlockKey === blockKey) agg.blockUsed += 1;
      if (run.budgetState === "reserved" && run.budgetWeekKey === weekKey) agg.weekUsed += 1;
      if (run.status === "ticking" || run.status === "queued") agg.activeRuns += 1;
      agg.modelCalls += run.modelCallCount;
      bySession.set(key, agg);
    }

    // Distinct World activities in the cohort (label bench rows when there is >1).
    const activityTitle = new Map<string, string>();
    for (const bench of benches) {
      if (!activityTitle.has(String(bench.activityId))) {
        const activity = await ctx.db.get(bench.activityId);
        if (activity) activityTitle.set(String(bench.activityId), activity.title);
      }
    }
    const multiWorld = activityTitle.size > 1;

    const rows = [];
    const seenScholars = new Set<string>();
    for (const bench of benches) {
      const user = await ctx.db.get(bench.scholarId);
      const agg = bySession.get(String(bench.sessionId)) ?? {
        blockUsed: 0,
        weekUsed: 0,
        activeRuns: 0,
        modelCalls: 0,
      };
      seenScholars.add(String(bench.scholarId));
      rows.push({
        scholarId: bench.scholarId,
        name: scholarName(user),
        sessionId: bench.sessionId,
        activityLabel: multiWorld ? activityTitle.get(String(bench.activityId)) ?? null : null,
        hasBench: true,
        blockUsed: agg.blockUsed,
        weekUsed: agg.weekUsed,
        activeRuns: agg.activeRuns,
        modelCalls: agg.modelCalls,
      });
    }
    // Roster scholars who never opened a bench — visible, but not grantable yet.
    for (const scholarId of assignment.scholarIds) {
      if (seenScholars.has(String(scholarId))) continue;
      const user = await ctx.db.get(scholarId);
      rows.push({
        scholarId,
        name: scholarName(user),
        sessionId: null,
        activityLabel: null,
        hasBench: false,
        blockUsed: 0,
        weekUsed: 0,
        activeRuns: 0,
        modelCalls: 0,
      });
    }
    rows.sort((left, right) => left.name.localeCompare(right.name));

    return {
      assignmentId: args.assignmentId,
      paused: assignment.simulatorRunsPaused ?? false,
      windowKeys: { blockKey, weekKey },
      limits: { blockLimit, weekLimit },
      budget: assignment.simulatorRunBudget ?? null,
      seasonTicks: assignment.simulatorSeasonTicks ?? null,
      totals: {
        activeRuns,
        queuedRuns,
        totalModelCalls,
        benchCount: benches.length,
        runCount: runs.length,
      },
      rows,
    };
  },
});

// ── DEBRIEF tab ──────────────────────────────────────────────────────────────

async function notebookHypothesisRunIds(
  ctx: DbCtx,
  sessionIds: readonly Id<"sessions">[],
): Promise<Set<string>> {
  const messagesBySession = await Promise.all(
    sessionIds.map((sessionId) =>
      ctx.db
        .query("messages")
        .withIndex("by_session", (query) => query.eq("sessionId", sessionId))
        .collect(),
    ),
  );
  return new Set(
    messagesBySession
      .flat()
      .flatMap((message) =>
        message.notebookEntry?.kind === "hypothesis"
          ? [String(message.notebookEntry.runId)]
          : [],
      ),
  );
}

async function notebookExcerpts(
  ctx: DbCtx,
  sessionId: Id<"sessions">,
  limit: number,
): Promise<{ kind: string; text: string }[]> {
  const messages = await ctx.db
    .query("messages")
    .withIndex("by_session", (query) => query.eq("sessionId", sessionId))
    .collect();
  const out: { kind: string; text: string }[] = [];
  for (const message of messages) {
    const entry = message.notebookEntry;
    if (!entry) continue;
    if (entry.kind === "conclusion" || entry.kind === "note") {
      out.push({ kind: entry.kind, text: entry.text });
    } else if (entry.kind === "hypothesis") {
      const label = hypothesisLabel(entry.prediction.prediction);
      out.push({
        kind: "hypothesis",
        text: entry.prediction.note ? `${label} — ${entry.prediction.note}` : label,
      });
    }
  }
  return out.slice(-limit);
}

/**
 * The Debrief read model (plan §8): FACTUAL direction trails (sortable), the
 * zero-hypothesis flag list, the prompt decks (the star exhibit) grouped by a
 * deterministic strategy signature (population shape — a config fact, not a
 * quality ranking), score distributions per scholar, and notebook excerpts.
 *
 * DROPPED per review: the uncalibrated "worth discussing" classifier (T6) and
 * the substitute gallery. The real exhibition path is P2: a scholar-chosen
 * shareBack submission (run + deck + reflection) rendered on a teacher-gated
 * projector with playlist/replay. This query intentionally exposes NO gallery.
 */
export const debrief = teacherQuery({
  args: {
    activityId: v.id("activities"),
    assignmentId: v.optional(v.id("assignments")),
  },
  handler: async (ctx, args) => {
    await requireUnitEditAccess(ctx, { activityId: args.activityId });
    const activity = await ctx.db.get(args.activityId);
    const spec = activitySimulatorSpec(activity);
    if (!activity || !spec) return null;
    if (args.assignmentId) {
      await assertAssignmentOwnerAndActivity(ctx, args.assignmentId, activity);
    }
    const { metricKey, direction, target } = criterionScoring(spec.criterion);
    const slotLabel = new Map(spec.speciesSlots.map((slot) => [slot.slotId, slot.label]));

    let runs = await ctx.db
      .query("simulatorRuns")
      .withIndex("by_activity", (query) => query.eq("activityId", args.activityId))
      .order("desc")
      .take(600);
    runs = runs.filter((run) => !isPreflightRun(run));
    if (args.assignmentId) runs = runs.filter((run) => run.assignmentId === args.assignmentId);
    const activitySpecJson = canonicalJson(spec);
    const comparableRuns = runs.filter(
      (run) => canonicalJson(run.simulatorSpecSnapshot) === activitySpecJson,
    );
    const forkedRunRows = runs.filter(
      (run) => canonicalJson(run.simulatorSpecSnapshot) !== activitySpecJson,
    );

    const byScholar = new Map<Id<"users">, Doc<"simulatorRuns">[]>();
    for (const run of comparableRuns) {
      const list = byScholar.get(run.scholarId) ?? [];
      list.push(run);
      byScholar.set(run.scholarId, list);
    }

    const trailsInput: (ScholarTrailInput & { user: Doc<"users"> | null })[] = [];
    for (const [scholarId, scholarRuns] of byScholar) {
      const user = await ctx.db.get(scholarId);
      const sessionId = scholarRuns[0].sessionId;
      const scholarRunIds = new Set(scholarRuns.map((run) => String(run._id)));
      const hypothesisRunIds = new Set(
        scholarRuns
          .filter((run) => run.hypothesis !== undefined)
          .map((run) => String(run._id)),
      );
      const notebookRunIds = await notebookHypothesisRunIds(
        ctx,
        [...new Set(scholarRuns.map((run) => run.sessionId))],
      );
      for (const runId of notebookRunIds) {
        if (scholarRunIds.has(runId)) hypothesisRunIds.add(runId);
      }
      const hypothesesCount = hypothesisRunIds.size;
      const facts: RunFact[] = scholarRuns.map((run) => ({
        runId: String(run._id),
        deckVersion: run.deckVersion,
        status: run.status,
        criterionScore: runCriterionScore(run, metricKey),
        invalidActionCount: run.invalidActionCount,
        modelCallCount: run.modelCallCount,
        queuedAt: run.queuedAt,
        hasHypothesis: run.hypothesis !== undefined,
      }));
      trailsInput.push({
        scholarId: String(scholarId),
        name: scholarName(user),
        sessionId: String(sessionId),
        runs: facts,
        hypothesesCount,
        user,
      });
    }

    const trails = trailsInput.map((input) => computeTrail(input, direction, target));
    const flaggedZeroHypothesis = zeroHypothesisScholars(trails).map((trail) => ({
      scholarId: trail.scholarId,
      name: trail.name,
      runCount: trail.runCount,
    }));

    const decks = [];
    const distribution = [];
    for (const [scholarId, scholarRuns] of byScholar) {
      const input = trailsInput.find((t) => t.scholarId === String(scholarId));
      const name = scholarName(input?.user ?? null);
      const latest = [...scholarRuns].sort(
        (a, b) => b.deckVersion - a.deckVersion || b.queuedAt - a.queuedAt,
      )[0];
      const cards = latest.deckSnapshot.map((card) => ({
        slotId: card.slotId,
        label: slotLabel.get(card.slotId) ?? "modified world",
        count: card.count,
        prompt: card.prompt,
      }));
      const excerpts = input ? await notebookExcerpts(ctx, latest.sessionId, 3) : [];
      decks.push({
        scholarId,
        name,
        deckVersion: latest.deckVersion,
        signature: strategySignature(cards),
        cards,
        excerpts,
      });

      for (const run of scholarRuns) {
        const score = runCriterionScore(run, metricKey);
        if (score !== null) {
          distribution.push({
            scholarId,
            name,
            deckVersion: run.deckVersion,
            score,
            forked: false,
          });
        }
      }
    }
    decks.sort((left, right) => left.name.localeCompare(right.name));

    // ── Endgame-defection discoveries (founder-approved, taste lane) ──────────
    // A read-model derivation, NOT stored state: for the finite-horizon game
    // templates, surface scholars whose COMPILED deck policy switches its move as
    // the last round(s) close — "found the last move" by backward induction. This
    // is celebrated as a discovery, never flagged as cheating; grim-trigger decks
    // key on the opponent's last move, not rounds_remaining, so they never appear.
    // See lib/simulator/endgameDiscovery.ts for why the compiled policy is the honest
    // signal (intent over luck) and its documented trade-off.
    const discoveryScholars: {
      scholarId: Id<"users">;
      name: string;
      slotLabels: string[];
      defectsAtEndgame: boolean;
    }[] = [];
    if (ENDGAME_DISCOVERY_TEMPLATES.has(spec.templateId)) {
      const trailsInputByScholar = new Map(
        trailsInput.map((input) => [input.scholarId, input]),
      );
      for (const [scholarId, scholarRuns] of byScholar) {
        const slotLabels = new Set<string>();
        let defectsAtEndgame = false;
        for (const run of scholarRuns) {
          for (const slot of run.compiledPolicySnapshot ?? []) {
            if (slot.status !== "ready") continue;
            const signal = detectEndgameDefection(slot.policy);
            if (!signal) continue;
            slotLabels.add(slotLabel.get(slot.slotId) ?? slot.slotId);
            defectsAtEndgame = defectsAtEndgame || signal.defectsAtEndgame;
          }
        }
        if (slotLabels.size > 0) {
          const input = trailsInputByScholar.get(String(scholarId));
          discoveryScholars.push({
            scholarId,
            name: scholarName(input?.user ?? null),
            slotLabels: [...slotLabels].sort(),
            defectsAtEndgame,
          });
        }
      }
      discoveryScholars.sort((left, right) => left.name.localeCompare(right.name));
    }
    const discoveries =
      discoveryScholars.length > 0
        ? { scholars: discoveryScholars, discussionQuestion: ENDGAME_DISCUSSION_QUESTION }
        : null;

    const forkedByScholar = new Map<Id<"users">, Doc<"simulatorRuns">[]>();
    for (const run of forkedRunRows) {
      const list = forkedByScholar.get(run.scholarId) ?? [];
      list.push(run);
      forkedByScholar.set(run.scholarId, list);
    }
    const forkedRuns = [];
    for (const [scholarId, scholarRuns] of forkedByScholar) {
      const user = await ctx.db.get(scholarId);
      const latest = scholarRuns[0];
      const forkedSlotLabel = new Map(
        latest.simulatorSpecSnapshot.speciesSlots.map((slot) => [
          slot.slotId,
          slot.label,
        ]),
      );
      forkedRuns.push({
        scholarId,
        name: scholarName(user),
        count: scholarRuns.length,
        bestOnOwnCriterion: bestOnOwnCriterion(scholarRuns),
        slots: [
          ...new Set(
            latest.deckSnapshot.map(
              (card) => forkedSlotLabel.get(card.slotId) ?? "modified world",
            ),
          ),
        ],
        forked: true,
      });
    }
    forkedRuns.sort((left, right) => left.name.localeCompare(right.name));

    return {
      activityId: activity._id,
      title: activity.title,
      criterion: {
        kind: spec.criterion.kind,
        direction,
        target: target ?? null,
        metricKey,
      },
      totals: {
        scholarCount: new Set(runs.map((run) => run.scholarId)).size,
        runCount: runs.length,
        comparableRunCount: comparableRuns.length,
        forkedRunCount: forkedRunRows.length,
      },
      trails: trails.sort((left, right) => left.name.localeCompare(right.name)),
      flaggedZeroHypothesis,
      discoveries,
      decks,
      distribution,
      forkedRuns,
    };
  },
});

/**
 * Invalid-action hot-spots (plan §8): which Species prompts confused automata
 * across the cohort — a writing lesson hiding in telemetry. Bounded: only the
 * worst few runs' chunks are read; the sample size is disclosed to the UI.
 */
export const invalidHotspots = teacherQuery({
  args: {
    activityId: v.id("activities"),
    assignmentId: v.optional(v.id("assignments")),
    maxRuns: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    await requireUnitEditAccess(ctx, { activityId: args.activityId });
    const activity = await ctx.db.get(args.activityId);
    const spec = activitySimulatorSpec(activity);
    if (!activity || !spec) return null;
    if (args.assignmentId) {
      await assertAssignmentOwnerAndActivity(ctx, args.assignmentId, activity);
    }
    const slotLabel = new Map(spec.speciesSlots.map((slot) => [slot.slotId, slot.label]));

    let runs = await ctx.db
      .query("simulatorRuns")
      .withIndex("by_activity", (query) => query.eq("activityId", args.activityId))
      .order("desc")
      .take(600);
    runs = runs.filter((run) => !isPreflightRun(run) && run.invalidActionCount > 0);
    if (args.assignmentId) runs = runs.filter((run) => run.assignmentId === args.assignmentId);
    const top = runs
      .sort((a, b) => b.invalidActionCount - a.invalidActionCount)
      .slice(0, clampInt(args.maxRuns ?? 5, 1, 12));

    type Hot = {
      slotId: string;
      label: string;
      invalid: number;
      codes: Map<string, number>;
      promptSample: string;
    };
    const bySlot = new Map<string, Hot>();
    let sampledRuns = 0;
    for (const run of top) {
      const deckBySlot = new Map(run.deckSnapshot.map((card) => [card.slotId, card.prompt]));
      const chunks = await ctx.db
        .query("simulatorRunChunks")
        .withIndex("by_run_startTick", (query) => query.eq("runId", run._id))
        .take(8);
      sampledRuns += 1;
      for (const chunk of chunks) {
        for (const tick of chunk.ticks) {
          for (const record of tick.automata) {
            if (record.accepted) continue;
            const hot = bySlot.get(record.slotId) ?? {
              slotId: record.slotId,
              label: slotLabel.get(record.slotId) ?? record.slotId,
              invalid: 0,
              codes: new Map<string, number>(),
              promptSample: deckBySlot.get(record.slotId) ?? "",
            };
            hot.invalid += 1;
            const code = record.invalidCode ?? "unknown";
            hot.codes.set(code, (hot.codes.get(code) ?? 0) + 1);
            bySlot.set(record.slotId, hot);
          }
        }
      }
    }

    const hotspots = [...bySlot.values()]
      .map((hot) => {
        const topCode = [...hot.codes.entries()].sort((a, b) => b[1] - a[1])[0];
        return {
          slotId: hot.slotId,
          label: hot.label,
          invalid: hot.invalid,
          topCode: topCode ? { code: topCode[0], count: topCode[1] } : null,
          promptSample: hot.promptSample,
        };
      })
      .sort((a, b) => b.invalid - a.invalid);

    return { sampledRuns, hotspots };
  },
});
