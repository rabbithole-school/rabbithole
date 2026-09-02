import { v } from "convex/values";

import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { authedMutation, authedQuery, teacherMutation } from "./lib/customFunctions";
import { AUTOMATON_MODEL } from "./lib/models";
import { isTeacherRole } from "./lib/roles";
import {
  DECISION_HASH_VERSION,
  MAX_AUTOMATA_PER_RUN,
  PROMPT_PROTOCOL_VERSION,
  RENDERER_PROTOCOL_VERSION,
  SIMULATOR_PROTOCOL_VERSION,
  type Hypothesis,
  type SimulatorSpec as SimulatorSpec,
} from "../lib/simulator/contract";
import {
  POLICY_INTERPRETER_VERSION,
  describePolicyRule,
  isGuaranteedCompiledPolicySet,
  policyCompileContextHash,
  type CompiledPolicyGuaranteeSlot,
  type PolicyIR,
} from "../lib/simulator/policyIR";
import { canonicalJson, sha256Hex } from "../lib/simulator/prompt";
import { getSimulatorTemplate as getSimulatorTemplate } from "../lib/simulator/templates/registry";
import {
  REDACTED_OBSERVATION_JSON,
  screenWorldText as screenSimulatorText,
} from "../lib/simulator/screenText";
import { appendNotebookEntry, resolveBenchSimulator, validateDeckForSpec } from "./simulatorBenches";
import { simulatorSpecForStorage as simulatorSpecForStorage } from "./seed/systemsAgents";
import {
  budgetWindowKeys,
  DEFAULT_BLOCK_RUN_LIMIT,
  DEFAULT_WEEK_RUN_LIMIT,
} from "./lib/simulatorRunBudget";
import { isPredictionEvidenceRun } from "./lib/simulatorRunEvidence";

export {
  budgetWindowKeys,
  DEFAULT_BLOCK_RUN_LIMIT,
  DEFAULT_WEEK_RUN_LIMIT,
} from "./lib/simulatorRunBudget";

const hypothesisArg = v.object({
  prediction: v.union(
    v.literal("better"),
    v.literal("worse"),
    v.literal("about_the_same"),
    v.literal("exploratory"),
  ),
  note: v.optional(v.string()),
});

function randomSeed(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

type CompiledPolicySlotSnapshot =
  | {
      slotId: string;
      status: "ready";
      policyHash: string;
      policy: PolicyIR;
    }
  | {
      slotId: string;
      status: "fallback";
      reason: "compiling" | "failed" | "missing";
    };

export const POPULATION_COMPILED_POLICY_ERROR =
  "Simulators this big need every species' rules fully compiled — no 'ask Haiku' gaps.";

export function assertPopulationRunCanLaunch(input: {
  automataCount: number;
  interpreterVersion?: number;
  policies?: readonly CompiledPolicyGuaranteeSlot[];
}): void {
  if (
    input.automataCount > MAX_AUTOMATA_PER_RUN &&
    !isGuaranteedCompiledPolicySet({
      interpreterVersion: input.interpreterVersion,
      policies: input.policies,
    })
  ) {
    throw new Error(POPULATION_COMPILED_POLICY_ERROR);
  }
}

export type CompiledPolicySource = {
  /** Slot id in the launched run (for example Tournament deck_a). */
  slotId: string;
  /** Frozen source bench artifact that compiled the prompt. */
  sourceDeckHash: string;
  sourceSlotId: string;
};

async function freezeCompiledPolicies(
  ctx: MutationCtx,
  input: {
    spec: SimulatorSpec;
    deckHash: string;
    deck: Doc<"simulatorRuns">["deckSnapshot"];
    policySources?: readonly CompiledPolicySource[];
  },
): Promise<{
  compiledPolicyHash: string;
  interpreterVersion: number;
  compiledPolicySnapshot: CompiledPolicySlotSnapshot[];
} | null> {
  if (input.spec.interpreter.kind !== "scripted") return null;
  const template = getSimulatorTemplate(input.spec.templateId);
  if (!template) throw new Error(`Unknown Simulator template "${input.spec.templateId}"`);
  const sourceBySlot = new Map(
    (input.policySources ?? []).map((source) => [source.slotId, source]),
  );
  const compiledPolicySnapshot = await Promise.all(
    input.deck.map(async (card): Promise<CompiledPolicySlotSnapshot> => {
      const slot = input.spec.speciesSlots.find(
        (candidate) => candidate.slotId === card.slotId,
      );
      if (!slot) throw new Error(`Unknown Species slot "${card.slotId}"`);
      const source = sourceBySlot.get(card.slotId);
      const sourceSlotId = source?.sourceSlotId ?? card.slotId;
      const compileContextHash = await policyCompileContextHash({
        templateId: input.spec.templateId,
        templateVersion: input.spec.templateVersion,
        slotId: sourceSlotId,
        senses: slot.senses,
        actionSchema: template.actionSchema,
      });
      const policy = await ctx.db
        .query("compiledPolicies")
        .withIndex("by_deck_slot_context", (query) =>
          query
            .eq("deckHash", source?.sourceDeckHash ?? input.deckHash)
            .eq("slotId", sourceSlotId)
            .eq("compileContextHash", compileContextHash),
        )
        .unique();
      if (
        policy?.status === "ready" &&
        policy.interpreterVersion === POLICY_INTERPRETER_VERSION &&
        policy.policy &&
        policy.policyHash
      ) {
        return {
          slotId: card.slotId,
          status: "ready",
          policyHash: policy.policyHash,
          policy: policy.policy as PolicyIR,
        };
      }
      return {
        slotId: card.slotId,
        status: "fallback",
        reason:
          policy?.status === "compiling"
            ? "compiling"
            : policy?.status === "failed" || policy?.status === "ready"
              ? "failed"
              : "missing",
      };
    }),
  );
  return {
    compiledPolicyHash: await sha256Hex(
      canonicalJson({
        interpreterVersion: POLICY_INTERPRETER_VERSION,
        slots: compiledPolicySnapshot.map((slot) =>
          slot.status === "ready"
            ? {
                slotId: slot.slotId,
                status: slot.status,
                policyHash: slot.policyHash,
              }
            : slot,
        ),
      }),
    ),
    interpreterVersion: POLICY_INTERPRETER_VERSION,
    compiledPolicySnapshot,
  };
}

/**
 * The one ordinary Simulator Run insertion path. Scholar launches add budget checks
 * before calling it; teacher-owned Preflight/Tournament orchestration supplies
 * isolated budget keys, but all three share the same frozen inputs, initial
 * physics state, queue admission, and worker dispatch.
 */
export async function enqueueSimulatorRun(
  ctx: MutationCtx,
  input: {
    sessionId: Id<"sessions">;
    scholarId: Id<"users">;
    activityId: Id<"activities">;
    assignmentId?: Id<"assignments">;
    runKind: "iteration" | "season";
    targetTicks: number;
    deckSnapshot: Doc<"simulatorRuns">["deckSnapshot"];
    deckVersion: number;
    deckHash?: string;
    compiledPolicySources?: readonly CompiledPolicySource[];
    /** Internal deterministic replay seam; ordinary launches always randomize. */
    seed?: string;
    simulatorSpec: SimulatorSpec;
    hypothesis?: Hypothesis;
    budgetBlockKey: string;
    budgetWeekKey: string;
    blockLimitSnapshot: number;
    weekLimitSnapshot: number;
    tournamentId?: Id<"tournaments">;
    tournamentPairingKey?: string;
  },
): Promise<Id<"simulatorRuns">> {
  const template = getSimulatorTemplate(input.simulatorSpec.templateId);
  if (!template) throw new Error(`Unknown Simulator template "${input.simulatorSpec.templateId}"`);
  template.validateSpec(input.simulatorSpec);
  const species = validateDeckForSpec(input.simulatorSpec, input.deckSnapshot);
  if (
    !Number.isInteger(input.targetTicks) ||
    input.targetTicks < 1 ||
    input.targetTicks > input.simulatorSpec.tickBudget.absoluteMaxTicks
  ) {
    throw new Error("Run exceeds the Simulator tick budget");
  }
  const seed = input.seed ?? randomSeed();
  const simulatorSpecHash = await sha256Hex(canonicalJson(input.simulatorSpec));
  const resolvedDeckHash =
    input.deckHash ?? (await sha256Hex(canonicalJson(input.deckSnapshot)));
  const compiled = await freezeCompiledPolicies(ctx, {
    spec: input.simulatorSpec,
    deckHash: resolvedDeckHash,
    deck: input.deckSnapshot,
    policySources: input.compiledPolicySources,
  });
  const automataCount = species.reduce((total, slot) => total + slot.count, 0);
  assertPopulationRunCanLaunch({
    automataCount,
    interpreterVersion: compiled?.interpreterVersion,
    policies: compiled?.compiledPolicySnapshot,
  });
  const state = template.initialState({
    config: input.simulatorSpec.config,
    species,
    seed,
  });
  const scene = template.renderScene({ state, tick: 0 });
  const now = Date.now();
  const runId = await ctx.db.insert("simulatorRuns", {
    sessionId: input.sessionId,
    scholarId: input.scholarId,
    activityId: input.activityId,
    assignmentId: input.assignmentId,
    runKind: input.runKind,
    targetTicks: input.targetTicks,
    deckSnapshot: input.deckSnapshot,
    deckVersion: input.deckVersion,
    deckHash: resolvedDeckHash,
    simulatorSpecSnapshot: simulatorSpecForStorage(input.simulatorSpec),
    simulatorSpecHash,
    ...(compiled ?? {}),
    hypothesis: input.hypothesis,
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
    budgetBlockKey: input.budgetBlockKey,
    budgetWeekKey: input.budgetWeekKey,
    blockLimitSnapshot: input.blockLimitSnapshot,
    weekLimitSnapshot: input.weekLimitSnapshot,
    modelId: AUTOMATON_MODEL,
    simulatorProtocolVersion: SIMULATOR_PROTOCOL_VERSION,
    promptProtocolVersion: PROMPT_PROTOCOL_VERSION,
    decisionHashVersion: DECISION_HASH_VERSION,
    physicsTemplateVersion: template.version,
    rendererProtocolVersion: RENDERER_PROTOCOL_VERSION,
    tournamentId: input.tournamentId,
    tournamentPairingKey: input.tournamentPairingKey,
    queuedAt: now,
    updatedAt: now,
  });
  const insertedRun = await ctx.db.get(runId);
  if (!insertedRun) throw new Error("New Simulator Run was not readable in its launch transaction");
  await ctx.db.patch(runId, { queuedAt: insertedRun._creationTime });
  await ctx.scheduler.runAfter(0, internal.simulatorEngine.dispatchQueued, {});
  return runId;
}

type RunReadAccess = { allowed: boolean; visibleSlotId?: string };

async function runReadAccess(
  ctx: Pick<QueryCtx, "db"> | Pick<MutationCtx, "db">,
  user: Doc<"users">,
  run: Doc<"simulatorRuns">,
): Promise<RunReadAccess> {
  if (isTeacherRole(user.role)) return { allowed: true };
  if (!run.tournamentId) return { allowed: run.scholarId === user._id };
  const tournament = await ctx.db.get(run.tournamentId);
  const pairing = tournament?.pairings.find(
    (candidate) => candidate.pairingKey === run.tournamentPairingKey,
  );
  const entrant = tournament?.entrants.find((candidate) => candidate.scholarId === user._id);
  if (!pairing || !entrant) return { allowed: false };
  if (pairing.simulatorEntrantABenchId === entrant.simulatorBenchId) {
    return { allowed: true, visibleSlotId: "deck_a" };
  }
  if (pairing.simulatorEntrantBBenchId === entrant.simulatorBenchId) {
    return { allowed: true, visibleSlotId: "deck_b" };
  }
  return { allowed: false };
}

function projectRunListItem(run: Doc<"simulatorRuns">) {
  return {
    _id: run._id,
    sessionId: run.sessionId,
    runKind: run.runKind,
    deckVersion: run.deckVersion,
    deckHash: run.deckHash,
    hypothesis: run.hypothesis,
    status: run.status,
    haltReason: run.haltReason,
    targetTicks: run.targetTicks,
    nextTick: run.nextTick,
    queuedAt: run.queuedAt,
    startedAt: run.startedAt,
    lastCommittedAt: run.lastCommittedAt,
    endedAt: run.endedAt,
    latestCommittedTick: run.latestCommittedTick,
    latestChunkStartTick: run.latestChunkStartTick,
    latestCheckpointTick: run.latestCheckpointTick,
    latestSceneJson: run.latestSceneJson,
    currentMetrics: run.currentMetrics,
    criterionScores: run.criterionScores,
    summarySeries: run.summarySeries,
    extinct: run.extinct ?? false,
    invalidActionCount: run.invalidActionCount,
    modelCallCount: run.modelCallCount,
    decisionCacheHitCount: run.decisionCacheHitCount,
    errorCode: run.errorCode,
    errorMessage: run.errorMessage,
  };
}

function projectRunDetail(run: Doc<"simulatorRuns">, visibleSlotId?: string) {
  return {
    ...projectRunListItem(run),
    // Compare fetches selected Runs individually. Keep the reactive list lean,
    // and expose frozen run inputs only on this detail projection. A renderer
    // must replay the spec captured at launch, never a later activity edit.
    simulatorSpecSnapshot: run.simulatorSpecSnapshot,
    deckSnapshot: visibleSlotId
      ? run.deckSnapshot.filter((card) => card.slotId === visibleSlotId)
      : run.deckSnapshot,
    compiledPolicyHash: run.compiledPolicyHash,
    interpreterVersion: run.interpreterVersion,
    compiledPolicySnapshot: run.compiledPolicySnapshot
      ?.filter((slot) => !visibleSlotId || slot.slotId === visibleSlotId)
      .map((slot) =>
        slot.status === "ready"
          ? {
              ...slot,
              ruleSummaries: slot.policy.rules.map((rule) =>
                screenSimulatorText(describePolicyRule(rule), {
                  maxChars: 500,
                }) ?? "Policy detail unavailable.",
              ),
              rawPolicyJson:
                screenSimulatorText(canonicalJson(slot.policy), {
                  maxChars: 32_000,
                }) ?? "Policy detail unavailable.",
            }
          : slot,
      ),
  };
}

function projectChunkForHumans(
  chunk: Doc<"simulatorRunChunks">,
  visibleSlotId?: string,
) {
  return {
    ...chunk,
    ticks: chunk.ticks.map((tick) => ({
      ...tick,
      automata: tick.automata.map((record) => ({
        ...record,
        detailsRedacted:
          visibleSlotId && record.slotId !== visibleSlotId ? true : undefined,
        source:
          visibleSlotId && record.slotId !== visibleSlotId
            ? undefined
            : record.source,
        observationJson:
          visibleSlotId && record.slotId !== visibleSlotId
            ? REDACTED_OBSERVATION_JSON
            : screenSimulatorText(record.observationJson, { maxChars: 32_000 }) ??
              "Content unavailable for display.",
        reasoning:
          visibleSlotId && record.slotId !== visibleSlotId
            ? "Opponent strategy details are private."
            : screenSimulatorText(record.reasoning, { maxChars: 500 }) ??
              "Content unavailable for display.",
        policyRuleId:
          visibleSlotId && record.slotId !== visibleSlotId
            ? undefined
            : record.policyRuleId,
        policyTrace:
          visibleSlotId && record.slotId !== visibleSlotId
            ? undefined
            : screenSimulatorText(record.policyTrace, { maxChars: 500 }),
        modelResponseJson:
          visibleSlotId && record.slotId !== visibleSlotId
            ? "[]"
            : screenSimulatorText(record.modelResponseJson, { maxChars: 32_000 }) ??
              "Content unavailable for display.",
        scratchBefore:
          visibleSlotId && record.slotId !== visibleSlotId
            ? undefined
            : screenSimulatorText(record.scratchBefore, { maxChars: 500 }),
        scratchAfter:
          visibleSlotId && record.slotId !== visibleSlotId
            ? undefined
            : screenSimulatorText(record.scratchAfter, { maxChars: 500 }),
      })),
    })),
  };
}

export const launchRun = authedMutation({
  args: {
    sessionId: v.id("sessions"),
    runKind: v.optional(v.union(v.literal("iteration"), v.literal("season"))),
    hypothesis: v.optional(hypothesisArg),
  },
  handler: async (ctx, args) => {
    const session = await ctx.db.get(args.sessionId);
    if (!session || session.userId !== ctx.user._id) throw new Error("Workbench session not found");
    if (session.sessionMode !== "workbench" || !session.activityId) {
      throw new Error("Session is not a Simulator Workbench");
    }
    const activity = await ctx.db.get(session.activityId);
    if (
      !activity ||
      activity.kind !== "simulator" ||
      !activity.simulatorSpec
    ) {
      throw new Error("Workbench activity has no valid Simulator");
    }
    const bench = await ctx.db
      .query("simulatorBenches")
      .withIndex("by_session", (query) => query.eq("sessionId", session._id))
      .unique();
    if (!bench) throw new Error("Workbench has not been opened");
    const resolved = resolveBenchSimulator(activity, bench);
    if (!resolved) throw new Error("Workbench activity has no valid Simulator");
    const { spec } = resolved;
    const completedRun = await ctx.db
      .query("simulatorRuns")
      .withIndex("by_session", (query) =>
        query.eq("sessionId", session._id),
      )
      .filter((query) =>
        query.and(
          query.eq(query.field("status"), "completed"),
          query.eq(query.field("tournamentId"), undefined),
        ),
      )
      .first();
    if (completedRun && isPredictionEvidenceRun(completedRun) && !args.hypothesis) {
      throw new Error("A hypothesis is required before this Run");
    }
    validateDeckForSpec(spec, bench.deck);

    const assignment = session.assignmentId ? await ctx.db.get(session.assignmentId) : null;
    if (session.assignmentId && !assignment) throw new Error("Assignment not found");
    if (assignment && !assignment.scholarIds.some((id) => id === session.userId)) {
      throw new Error("Assignment does not include this scholar");
    }
    // Durable pause latch (plan §8): "Pause all" blocks NEW launches for the
    // whole cohort, not just runs already in flight. A scholar clicking Run
    // mid-pause gets a clear rejection instead of slipping a run past the pause.
    if (assignment?.simulatorRunsPaused) {
      throw new Error("Simulator runs are paused for this class");
    }
    // A season run honors the assignment's per-cohort season override when set,
    // always clamped to the Simulator's own absolute ceiling (the override can widen
    // toward, never past, the template's hard max).
    const seasonTicks =
      assignment?.simulatorSeasonTicks !== undefined
        ? Math.min(
            assignment?.simulatorSeasonTicks ?? 0,
            spec.tickBudget.absoluteMaxTicks,
          )
        : spec.tickBudget.seasonTicks;
    const runKind =
      args.runKind ??
      (assignment?.simulatorSeasonTicks !== undefined ||
      spec.interpreter.kind === "scripted"
        ? "season"
        : "iteration");
    const targetTicks =
      runKind === "iteration" ? spec.tickBudget.iterationTicks : seasonTicks;
    if (targetTicks > spec.tickBudget.absoluteMaxTicks) throw new Error("Run exceeds the Simulator tick budget");

    const runBudget = assignment?.simulatorRunBudget;
    const blockLimit = runBudget?.perScholarBlock ?? DEFAULT_BLOCK_RUN_LIMIT;
    const weekLimit = runBudget?.perScholarWeek ?? DEFAULT_WEEK_RUN_LIMIT;
    if (
      !Number.isInteger(blockLimit) ||
      !Number.isInteger(weekLimit) ||
      blockLimit < 1 ||
      weekLimit < blockLimit
    ) {
      throw new Error("Assignment Simulator run budget is invalid");
    }
    const now = Date.now();
    const { blockKey, weekKey } = budgetWindowKeys(
      now,
      session.assignmentId,
      runBudget?.timeZone,
    );
    const blockGrant = bench.runGrants
      .filter((grant) => grant.scope === "block" && grant.windowKey === blockKey)
      .reduce((sum, grant) => sum + grant.count, 0);
    const weekGrant = bench.runGrants
      .filter((grant) => grant.scope === "week" && grant.windowKey === weekKey)
      .reduce((sum, grant) => sum + grant.count, 0);
    const effectiveBlockLimit = blockLimit + blockGrant;
    const effectiveWeekLimit = weekLimit + weekGrant;
    const blockReservations = await ctx.db
      .query("simulatorRuns")
      .withIndex("by_scholar_assignment_block", (query) =>
        query
          .eq("scholarId", session.userId)
          .eq("assignmentId", session.assignmentId)
          .eq("budgetBlockKey", blockKey)
          .eq("budgetState", "reserved"),
      )
      .take(effectiveBlockLimit + 1);
    const weekReservations = await ctx.db
      .query("simulatorRuns")
      .withIndex("by_scholar_assignment_week", (query) =>
        query
          .eq("scholarId", session.userId)
          .eq("assignmentId", session.assignmentId)
          .eq("budgetWeekKey", weekKey)
          .eq("budgetState", "reserved"),
      )
      .take(effectiveWeekLimit + 1);
    if (blockReservations.length >= effectiveBlockLimit) {
      throw new Error("Run budget exhausted for this block");
    }
    if (weekReservations.length >= effectiveWeekLimit) {
      throw new Error("Run budget exhausted for this week");
    }

    const runId = await enqueueSimulatorRun(ctx, {
      sessionId: session._id,
      scholarId: session.userId,
      activityId: session.activityId,
      assignmentId: session.assignmentId,
      runKind,
      targetTicks,
      deckSnapshot: [...bench.deck],
      deckVersion: bench.deckVersion,
      deckHash: bench.deckHash,
      simulatorSpec: spec,
      hypothesis: args.hypothesis as Hypothesis | undefined,
      budgetBlockKey: blockKey,
      budgetWeekKey: weekKey,
      blockLimitSnapshot: effectiveBlockLimit,
      weekLimitSnapshot: effectiveWeekLimit,
    });
    if (args.hypothesis) {
      await appendNotebookEntry(ctx, {
        sessionId: session._id,
        entry: {
          kind: "hypothesis",
          runId,
          prediction: args.hypothesis,
        },
      });
    }
    await ctx.db.patch(bench._id, {
      lastRunId: runId,
    });
    return { runId };
  },
});

export const stopRun = authedMutation({
  args: { runId: v.id("simulatorRuns") },
  handler: async (ctx, args) => {
    const run = await ctx.db.get(args.runId);
    if (
      !run ||
      (run.scholarId !== ctx.user._id && !isTeacherRole(ctx.user.role)) ||
      (run.tournamentId && !isTeacherRole(ctx.user.role))
    ) {
      throw new Error("Run not found");
    }
    if (run.status === "completed" || run.status === "crashed" || run.status === "halted") {
      return { status: run.status };
    }
    const now = Date.now();
    if (run.status === "queued") {
      await ctx.db.patch(run._id, {
        status: "halted",
        haltReason: "scholar_stop",
        endedAt: now,
        updatedAt: now,
        workId: undefined,
        ...(run.attempt > 0 || run.chunkCount > 0
          ? {}
          : { budgetState: "released" as const, reservationReleasedAt: now }),
      });
      await ctx.scheduler.runAfter(0, internal.simulatorEngine.dispatchQueued, {});
      return { status: "halted" as const };
    }
    await ctx.db.patch(run._id, { stopRequestedAt: now, updatedAt: now });
    return { status: "ticking" as const };
  },
});

export const pauseAssignment = teacherMutation({
  args: { assignmentId: v.id("assignments") },
  handler: async (ctx, args) => {
    const assignment = await ctx.db.get(args.assignmentId);
    if (!assignment) throw new Error("Assignment not found");
    if (assignment.teacherId !== ctx.user._id && ctx.user.role !== "platform_admin") {
      throw new Error("Only the assignment teacher can pause Runs");
    }
    // Set the durable latch FIRST so any launch racing this mutation is rejected
    // (launchRun re-reads the assignment). Then quiet the runs already in flight.
    await ctx.db.patch(args.assignmentId, {
      simulatorRunsPaused: true,
    });
    const runs = await ctx.db
      .query("simulatorRuns")
      .withIndex("by_assignment", (query) => query.eq("assignmentId", args.assignmentId))
      .collect();
    const now = Date.now();
    let affected = 0;
    for (const run of runs) {
      if (run.status === "queued") {
        await ctx.db.patch(run._id, {
          status: "halted",
          haltReason: "teacher_pause",
          pauseRequestedAt: now,
          endedAt: now,
          workId: undefined,
          updatedAt: now,
        });
        affected += 1;
      } else if (run.status === "ticking") {
        await ctx.db.patch(run._id, { pauseRequestedAt: now, updatedAt: now });
        affected += 1;
      }
    }
    await ctx.scheduler.runAfter(0, internal.simulatorEngine.dispatchQueued, {});
    return { affected };
  },
});

export const resumeAssignment = teacherMutation({
  args: { assignmentId: v.id("assignments") },
  handler: async (ctx, args) => {
    const assignment = await ctx.db.get(args.assignmentId);
    if (!assignment) throw new Error("Assignment not found");
    if (assignment.teacherId !== ctx.user._id && ctx.user.role !== "platform_admin") {
      throw new Error("Only the assignment teacher can resume Runs");
    }
    // Clear the latch so scholars can launch again.
    await ctx.db.patch(args.assignmentId, {
      simulatorRunsPaused: false,
    });
    const runs = await ctx.db
      .query("simulatorRuns")
      .withIndex("by_assignment", (query) => query.eq("assignmentId", args.assignmentId))
      .collect();
    const now = Date.now();
    let affected = 0;
    for (const run of runs) {
      if (run.status === "halted" && run.haltReason === "teacher_pause") {
        // A run that already committed its pause → requeue from where it stopped.
        await ctx.db.patch(run._id, {
          status: "queued",
          haltReason: undefined,
          pauseRequestedAt: undefined,
          endedAt: undefined,
          attempt: 0,
          workId: undefined,
          updatedAt: now,
        });
        affected += 1;
      } else if (run.status === "ticking" && run.pauseRequestedAt !== undefined) {
        // The zombie race: a run still ticking with a pending pause marker. Clear
        // the marker BEFORE commitChunk reads it, so the run continues seamlessly
        // instead of halting itself after the cohort was resumed.
        await ctx.db.patch(run._id, { pauseRequestedAt: undefined, updatedAt: now });
        affected += 1;
      }
    }
    await ctx.scheduler.runAfter(0, internal.simulatorEngine.dispatchQueued, {});
    return { affected };
  },
});

export const get = authedQuery({
  args: { runId: v.id("simulatorRuns") },
  handler: async (ctx, args) => {
    const run = await ctx.db.get(args.runId);
    if (!run) return null;
    const access = await runReadAccess(ctx, ctx.user, run);
    return access.allowed ? projectRunDetail(run, access.visibleSlotId) : null;
  },
});

export const listForBench = authedQuery({
  args: {
    sessionId: v.id("sessions"),
    beforeQueuedAt: v.optional(v.number()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const session = await ctx.db.get(args.sessionId);
    if (!session || (session.userId !== ctx.user._id && !isTeacherRole(ctx.user.role))) return [];
    const limit = Math.max(1, Math.min(args.limit ?? 30, 100));
    const runs = await ctx.db
      .query("simulatorRuns")
      .withIndex("by_session", (query) =>
        args.beforeQueuedAt
          ? query.eq("sessionId", args.sessionId).lt("queuedAt", args.beforeQueuedAt)
          : query.eq("sessionId", args.sessionId),
      )
      .order("desc")
      .take(limit);
    return runs.filter((run) => run.tournamentId === undefined).map(projectRunListItem);
  },
});

export const chunks = authedQuery({
  args: {
    runId: v.id("simulatorRuns"),
    fromTick: v.optional(v.number()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const run = await ctx.db.get(args.runId);
    if (!run) return { page: [], nextFromTick: null };
    const access = await runReadAccess(ctx, ctx.user, run);
    if (!access.allowed) {
      return { page: [], nextFromTick: null };
    }
    const limit = Math.max(1, Math.min(args.limit ?? 8, 40));
    const rows = await ctx.db
      .query("simulatorRunChunks")
      .withIndex("by_run_startTick", (query) =>
        query.eq("runId", args.runId).gte("startTick", args.fromTick ?? 0),
      )
      .take(limit + 1);
    const page = rows
      .slice(0, limit)
      .map((chunk) => projectChunkForHumans(chunk, access.visibleSlotId));
    return {
      page,
      nextFromTick: rows.length > limit ? rows[limit].startTick : null,
    };
  },
});

export const chunk = authedQuery({
  args: { runId: v.id("simulatorRuns"), startTick: v.number() },
  handler: async (ctx, args) => {
    const run = await ctx.db.get(args.runId);
    if (!run) return null;
    const access = await runReadAccess(ctx, ctx.user, run);
    if (!access.allowed) return null;
    const row = await ctx.db
      .query("simulatorRunChunks")
      .withIndex("by_run_startTick", (query) =>
        query.eq("runId", args.runId).eq("startTick", args.startTick),
      )
      .unique();
    return row ? projectChunkForHumans(row, access.visibleSlotId) : null;
  },
});

export const queueState = authedQuery({
  args: { runId: v.id("simulatorRuns") },
  handler: async (ctx, args) => {
    const run = await ctx.db.get(args.runId);
    if (!run || !(await runReadAccess(ctx, ctx.user, run)).allowed) return null;
    if (run.status !== "queued") return { status: run.status };
    const queued = await ctx.db
      .query("simulatorRuns")
      .withIndex("by_status_queue", (query) => query.eq("status", "queued"))
      .order("asc")
      .collect();
    // Position is within the Run's actual ceiling class. The dispatcher is
    // FIFO inside each assignment (or the deployment-only unassigned class);
    // a saturated assignment may be skipped so another class can use capacity.
    const ordered = queued.filter((candidate) =>
      run.assignmentId
        ? candidate.assignmentId === run.assignmentId
        : candidate.assignmentId === undefined,
    );
    return {
      status: run.status,
      position: ordered.findIndex((candidate) => candidate._id === run._id) + 1,
      queuedCount: ordered.length,
      ceilingClass: run.assignmentId ? "assignment" as const : "deployment" as const,
    };
  },
});
