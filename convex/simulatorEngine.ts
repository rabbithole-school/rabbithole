import { v } from "convex/values";

import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { internalMutation } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import {
  CHECKPOINT_EVERY_TICKS,
  COMPILED_TICKS_PER_CHUNK,
  MAX_CHUNK_JSON_BYTES,
  MAX_SCENE_JSON_BYTES,
  MAX_SNAPSHOT_JSON_BYTES,
  TICKS_PER_CHUNK,
  SIMULATOR_QUEUE_WATCHDOG_MS,
  type ModelUsage,
  type SimulatorSpec,
} from "../lib/simulator/contract";
import {
  isGuaranteedCompiledPolicySet,
} from "../lib/simulator/policyIR";
import { canonicalJson, sha256Hex } from "../lib/simulator/prompt";
import { getSimulatorTemplate } from "../lib/simulator/templates/registry";

export const AUTOMATON_CALL_BATCH_SIZE = 8;
export const AUTOMATON_CALL_TIMEOUT_MS = 12_000;
export const MAX_CHUNK_ATTEMPTS = 3;
export const LEASE_MS = 90_000;
export const WATCHDOG_GRACE_MS = 15_000;
export const SIMULATOR_TICK_POOL_PARALLELISM = 4;
export const ASSIGNMENT_TICK_PARALLELISM = 2;
export const QUEUE_ADMISSION_SETTLE_MS = 1_000;

function ecosystemIsExtinct(state: unknown): boolean {
  return (
    typeof state === "object" &&
    state !== null &&
    "automata" in state &&
    Array.isArray(state.automata) &&
    state.automata.length === 0
  );
}

const usageArg = v.object({
  inputTokens: v.number(),
  cacheWriteTokens: v.number(),
  cacheReadTokens: v.number(),
  outputTokens: v.number(),
});

const automatonTickArg = v.object({
  automatonId: v.string(),
  slotId: v.string(),
  observationJson: v.string(),
  scratchBefore: v.optional(v.string()),
  tickPhase: v.string(),
  legalActionsJson: v.string(),
  decisionHash: v.string(),
  source: v.union(
    v.literal("model"),
    v.literal("decision_cache"),
    v.literal("compiled"),
    v.literal("compiled-fallback"),
  ),
  cacheOrigin: v.optional(
    v.object({
      runId: v.id("simulatorRuns"),
      startTick: v.number(),
      tick: v.number(),
      automatonId: v.string(),
    }),
  ),
  modelResponseJson: v.string(),
  reasoning: v.string(),
  policyRuleId: v.optional(v.string()),
  policyTrace: v.optional(v.string()),
  requestedActionJson: v.string(),
  acceptedActionJson: v.string(),
  accepted: v.boolean(),
  invalidCode: v.optional(v.string()),
  scratchAfter: v.optional(v.string()),
  usage: v.optional(usageArg),
});

const tickArg = v.object({
  tick: v.number(),
  phase: v.string(),
  physicsSeed: v.string(),
  automata: v.array(automatonTickArg),
  deltaJson: v.string(),
  metrics: v.array(v.object({ key: v.string(), value: v.number() })),
  invalidActionCount: v.number(),
});

const checkpointArg = v.object({
  tick: v.number(),
  stateJson: v.string(),
  sceneJson: v.string(),
  stateHash: v.string(),
});

const computedChunkArg = v.object({
  endTick: v.number(),
  ticks: v.array(tickArg),
  initialCheckpoint: v.optional(checkpointArg),
  checkpoint: v.optional(checkpointArg),
  finalStateJson: v.string(),
  finalSceneJson: v.string(),
  currentMetrics: v.array(v.object({ key: v.string(), value: v.number() })),
  terminal: v.boolean(),
  modelCallCount: v.number(),
  decisionCacheHitCount: v.number(),
});

type AttemptOutcome = "provider_error" | "worker_crash" | "lease_expired";
type ClaimResult =
  | { kind: "stale" }
  | { kind: "deferred" }
  | {
      kind: "claimed";
      attempt: number;
      leaseUntil: number;
      input: {
        runId: Id<"simulatorRuns">;
        sessionId: Id<"sessions">;
        startTick: number;
        endTick: number;
        targetTicks: number;
        seed: string;
        modelId: string;
        deckSnapshot: Doc<"simulatorRuns">["deckSnapshot"];
        simulatorSpecSnapshot: Doc<"simulatorRuns">["simulatorSpecSnapshot"];
        compiledPolicyHash?: string;
        interpreterVersion?: number;
        compiledPolicySnapshot?: Doc<"simulatorRuns">["compiledPolicySnapshot"];
        stateJson: string;
        scratchByAutomaton: Array<{ automatonId: string; scratch: string }>;
      };
    };
type CommitResult =
  | { kind: "stale" }
  | { kind: "committed"; status: "queued" | "completed" | "halted" };
type RetryResult = { kind: "stale" | "requeued" | "crashed" };

function boundedAttemptLog(
  run: Doc<"simulatorRuns">,
  entry: {
    startTick: number;
    attempt: number;
    outcome: AttemptOutcome;
    errorCode?: string;
    errorMessage?: string;
    usage?: ModelUsage;
    at: number;
  },
) {
  return [...run.attemptLog, entry].slice(-12);
}

function nextQueueToken(): string {
  return crypto.randomUUID();
}

function ticksPerChunk(run: Doc<"simulatorRuns">): number {
  const guaranteedCompiled = isGuaranteedCompiledPolicySet({
    interpreterVersion: run.interpreterVersion,
    policies: run.compiledPolicySnapshot,
  });
  return guaranteedCompiled ? COMPILED_TICKS_PER_CHUNK : TICKS_PER_CHUNK;
}

async function wakeDispatcher(ctx: Pick<MutationCtx, "scheduler">) {
  await ctx.scheduler.runAfter(0, internal.simulatorEngine.dispatchQueued, {});
}

async function refreshTournament(
  ctx: Pick<MutationCtx, "scheduler">,
  run: Doc<"simulatorRuns">,
) {
  if (run.tournamentId) {
    await ctx.scheduler.runAfter(0, internal.tournaments.refresh, {
      tournamentId: run.tournamentId,
    });
  }
}

export const claimLease = internalMutation({
  args: {
    runId: v.id("simulatorRuns"),
    expectedStartTick: v.number(),
    expectedAttempt: v.number(),
    dispatchToken: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<ClaimResult> => {
    const run = await ctx.db.get(args.runId);
    if (
      !run ||
      run.status !== "queued" ||
      run.nextTick !== args.expectedStartTick ||
      run.attempt !== args.expectedAttempt ||
      (args.dispatchToken === undefined
        ? run.workId !== undefined
        : run.workId !== args.dispatchToken)
    ) {
      return { kind: "stale" as const };
    }
    const activeDeployment = await ctx.db
      .query("simulatorRuns")
      .withIndex("by_status_queue", (query) => query.eq("status", "ticking"))
      .take(SIMULATOR_TICK_POOL_PARALLELISM);
    if (activeDeployment.length >= SIMULATOR_TICK_POOL_PARALLELISM) {
      return { kind: "deferred" as const };
    }
    if (run.assignmentId) {
      const activeAssignment = await ctx.db
        .query("simulatorRuns")
        .withIndex("by_assignment_status", (query) =>
          query.eq("assignmentId", run.assignmentId).eq("status", "ticking"),
        )
        .take(ASSIGNMENT_TICK_PARALLELISM);
      if (activeAssignment.length >= ASSIGNMENT_TICK_PARALLELISM) {
        return { kind: "deferred" as const };
      }
    }
    const now = Date.now();
    const attempt = args.expectedAttempt + 1;
    const leaseUntil = now + LEASE_MS;
    const latestChunk = await ctx.db
      .query("simulatorRunChunks")
      .withIndex("by_run_startTick", (query) => query.eq("runId", run._id))
      .order("desc")
      .first();
    const scratchByAutomaton = latestChunk
      ? [...latestChunk.ticks]
          .reverse()
          .flatMap((tick) => tick.automata)
          .filter((record) => record.scratchAfter !== undefined)
          .filter(
            (record, index, records) =>
              records.findIndex(
                (candidate) => candidate.automatonId === record.automatonId,
              ) === index,
          )
          .map((record) => ({
            automatonId: record.automatonId,
            scratch: record.scratchAfter!,
          }))
      : [];
    await ctx.db.patch(run._id, {
      status: "ticking",
      attempt,
      leasedAt: now,
      leaseUntil,
      startedAt: run.startedAt ?? now,
      workId: undefined,
      updatedAt: now,
    });
    await ctx.scheduler.runAfter(
      LEASE_MS + WATCHDOG_GRACE_MS,
      internal.simulatorEngine.watchdog,
      { runId: run._id, startTick: run.nextTick, attempt },
    );
    return {
      kind: "claimed" as const,
      attempt,
      leaseUntil,
      input: {
        runId: run._id,
        sessionId: run.sessionId,
        startTick: run.nextTick,
        endTick: Math.min(run.nextTick + ticksPerChunk(run), run.targetTicks),
        targetTicks: run.targetTicks,
        seed: run.seed,
        modelId: run.modelId,
        deckSnapshot: run.deckSnapshot,
        simulatorSpecSnapshot: run.simulatorSpecSnapshot,
        compiledPolicyHash: run.compiledPolicyHash,
        interpreterVersion: run.interpreterVersion,
        compiledPolicySnapshot: run.compiledPolicySnapshot,
        stateJson: run.latestSnapshotJson,
        scratchByAutomaton,
      },
    };
  },
});

export const deferQueuedRun = internalMutation({
  args: {
    runId: v.id("simulatorRuns"),
    startTick: v.number(),
    expectedAttempt: v.number(),
    dispatchToken: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<{ kind: "stale" | "deferred" }> => {
    const run = await ctx.db.get(args.runId);
    if (
      !run ||
      run.status !== "queued" ||
      run.nextTick !== args.startTick ||
      run.attempt !== args.expectedAttempt ||
      (args.dispatchToken === undefined
        ? run.workId !== undefined
        : run.workId !== args.dispatchToken)
    ) {
      return { kind: "stale" as const };
    }
    await ctx.db.patch(run._id, {
      workId: undefined,
      updatedAt: Date.now(),
    });
    await wakeDispatcher(ctx);
    return { kind: "deferred" as const };
  },
});

/**
 * One capacity-triggered dispatcher replaces per-Run polling. It reserves
 * queued rows in global FIFO order while skipping an assignment whose own
 * two-slot class is full, so unrelated classes never leave capacity idle.
 */
export const dispatchQueued = internalMutation({
  args: { skipSettle: v.optional(v.boolean()) },
  handler: async (ctx, args) => {
    const ticking = await ctx.db
      .query("simulatorRuns")
      .withIndex("by_status_queue", (query) => query.eq("status", "ticking"))
      .take(SIMULATOR_TICK_POOL_PARALLELISM);
    const queued = await ctx.db
      .query("simulatorRuns")
      .withIndex("by_status_queue", (query) => query.eq("status", "queued"))
      .order("asc")
      .take(100);
    const dispatched = queued.filter((run) => run.workId !== undefined);
    const firstWaiting = queued.find((run) => run.workId === undefined);
    if (firstWaiting && !args.skipSettle) {
      const age = Date.now() - firstWaiting.queuedAt;
      if (age < QUEUE_ADMISSION_SETTLE_MS) {
        await ctx.scheduler.runAfter(
          QUEUE_ADMISSION_SETTLE_MS - age,
          internal.simulatorEngine.dispatchQueued,
          {},
        );
        return { dispatched: [] as Id<"simulatorRuns">[], settling: true };
      }
    }
    let deploymentUsed = ticking.length + dispatched.length;
    if (deploymentUsed >= SIMULATOR_TICK_POOL_PARALLELISM) {
      return { dispatched: [] as Id<"simulatorRuns">[], settling: false };
    }
    const assignmentUsed = new Map<string, number>();
    for (const run of [...ticking, ...dispatched]) {
      if (!run.assignmentId) continue;
      const key = String(run.assignmentId);
      assignmentUsed.set(key, (assignmentUsed.get(key) ?? 0) + 1);
    }
    const selected: Id<"simulatorRuns">[] = [];
    const admittedAt = Date.now();
    for (const run of queued) {
      if (deploymentUsed >= SIMULATOR_TICK_POOL_PARALLELISM) break;
      if (run.workId !== undefined) continue;
      const assignmentKey = run.assignmentId ? String(run.assignmentId) : undefined;
      if (
        assignmentKey &&
        (assignmentUsed.get(assignmentKey) ?? 0) >= ASSIGNMENT_TICK_PARALLELISM
      ) {
        continue;
      }
      const dispatchToken = nextQueueToken();
      await ctx.db.patch(run._id, {
        workId: dispatchToken,
        // Admission to the bounded pool is the queue's service event. Stamp a
        // stable FIFO order here; scheduled actions may begin out of order.
        startedAt: run.startedAt ?? admittedAt + selected.length,
      });
      await ctx.scheduler.runAfter(0, internal.simulatorEngineNode.runTickChunk, {
        runId: run._id,
        startTick: run.nextTick,
        expectedAttempt: run.attempt,
        dispatchToken,
      });
      await ctx.scheduler.runAfter(
        SIMULATOR_QUEUE_WATCHDOG_MS,
        internal.simulatorEngine.queueWatchdog,
        {
          runId: run._id,
          startTick: run.nextTick,
          expectedAttempt: run.attempt,
          queueToken: dispatchToken,
        },
      );
      selected.push(run._id);
      deploymentUsed += 1;
      if (assignmentKey) {
        assignmentUsed.set(assignmentKey, (assignmentUsed.get(assignmentKey) ?? 0) + 1);
      }
    }
    return { dispatched: selected, settling: false };
  },
});

export const queueWatchdog = internalMutation({
  args: {
    runId: v.id("simulatorRuns"),
    startTick: v.number(),
    expectedAttempt: v.number(),
    queueToken: v.string(),
  },
  handler: async (ctx, args): Promise<{ kind: "stale" | "waiting" | "requeued" }> => {
    const run = await ctx.db.get(args.runId);
    if (
      !run ||
      run.status !== "queued" ||
      run.nextTick !== args.startTick ||
      run.attempt !== args.expectedAttempt ||
      run.workId !== args.queueToken
    ) {
      return { kind: "stale" };
    }
    await ctx.db.patch(run._id, {
      workId: undefined,
      updatedAt: Date.now(),
    });
    await wakeDispatcher(ctx);
    return { kind: "requeued" };
  },
});

function byteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

function downsample(
  series: Doc<"simulatorRuns">["summarySeries"],
): Doc<"simulatorRuns">["summarySeries"] {
  let result = series;
  while (result.length > 200) {
    result = result.filter((_, index) => index % 2 === 0 || index === result.length - 1);
  }
  return result;
}

export const commitChunk = internalMutation({
  args: {
    runId: v.id("simulatorRuns"),
    startTick: v.number(),
    attempt: v.number(),
    chunk: computedChunkArg,
  },
  handler: async (ctx, args): Promise<CommitResult> => {
    const run = await ctx.db.get(args.runId);
    if (
      !run ||
      run.status !== "ticking" ||
      run.nextTick !== args.startTick ||
      run.attempt !== args.attempt
    ) {
      return { kind: "stale" as const };
    }
    const existing = await ctx.db
      .query("simulatorRunChunks")
      .withIndex("by_run_startTick", (query) =>
        query.eq("runId", run._id).eq("startTick", args.startTick),
      )
      .unique();
    if (existing) return { kind: "stale" as const };
    if (
      args.chunk.endTick <= args.startTick ||
      args.chunk.endTick >
        Math.min(args.startTick + ticksPerChunk(run), run.targetTicks) ||
      args.chunk.ticks.length !== args.chunk.endTick - args.startTick
    ) {
      throw new Error("Computed World chunk has an invalid tick range");
    }
    const template = getSimulatorTemplate(run.simulatorSpecSnapshot.templateId);
    if (!template) throw new Error("Run references an unknown World template");
    template.validateSpec(run.simulatorSpecSnapshot as SimulatorSpec);
    const finalState = template.validateState(JSON.parse(args.chunk.finalStateJson));
    const finalScene = JSON.parse(args.chunk.finalSceneJson) as { tick?: unknown; templateId?: unknown };
    if (
      finalScene.tick !== args.chunk.endTick ||
      finalScene.templateId !== run.simulatorSpecSnapshot.templateId
    ) {
      throw new Error("Computed World scene does not match the chunk boundary");
    }
    const expectedScene = template.renderScene({
      state: finalState,
      tick: args.chunk.endTick,
    });
    if (canonicalJson(finalScene) !== canonicalJson(expectedScene)) {
      throw new Error("Computed World scene is not derived from the committed state");
    }
    if (byteLength(args.chunk.finalStateJson) > MAX_SNAPSHOT_JSON_BYTES) {
      throw new Error("World snapshot exceeds its byte limit");
    }
    if (byteLength(args.chunk.finalSceneJson) > MAX_SCENE_JSON_BYTES) {
      throw new Error("World scene exceeds its byte limit");
    }
    for (const [index, tick] of args.chunk.ticks.entries()) {
      if (tick.tick !== args.startTick + index) throw new Error("World chunk ticks are not contiguous");
      template.validateDelta(JSON.parse(tick.deltaJson));
      for (const record of tick.automata) {
        template.validateAction(JSON.parse(record.acceptedActionJson));
      }
    }
    if (args.startTick === 0) {
      if (!args.chunk.initialCheckpoint || args.chunk.initialCheckpoint.tick !== 0) {
        throw new Error("The first World chunk requires a tick-zero checkpoint");
      }
      template.validateState(JSON.parse(args.chunk.initialCheckpoint.stateJson));
      if (
        (await sha256Hex(args.chunk.initialCheckpoint.stateJson)) !==
        args.chunk.initialCheckpoint.stateHash
      ) {
        throw new Error("Initial World checkpoint hash does not match its state");
      }
    } else if (args.chunk.initialCheckpoint) {
      throw new Error("Only the first World chunk may carry the initial checkpoint");
    }
    const finalBoundary =
      args.chunk.terminal ||
      args.chunk.endTick >= run.targetTicks ||
      args.chunk.endTick % CHECKPOINT_EVERY_TICKS === 0;
    if (finalBoundary !== Boolean(args.chunk.checkpoint)) {
      throw new Error("World checkpoint cadence does not match the chunk boundary");
    }
    if (args.chunk.checkpoint) {
      if (args.chunk.checkpoint.tick !== args.chunk.endTick) {
        throw new Error("World checkpoint tick does not match the chunk boundary");
      }
      template.validateState(JSON.parse(args.chunk.checkpoint.stateJson));
      if ((await sha256Hex(args.chunk.checkpoint.stateJson)) !== args.chunk.checkpoint.stateHash) {
        throw new Error("World checkpoint hash does not match its state");
      }
    }
    const payload = {
      ticks: args.chunk.ticks,
      initialCheckpoint: args.chunk.initialCheckpoint,
      checkpoint: args.chunk.checkpoint,
    };
    const payloadJson = canonicalJson(payload);
    if (byteLength(payloadJson) > MAX_CHUNK_JSON_BYTES) {
      throw new Error("World chunk exceeds its byte limit");
    }
    const now = Date.now();
    const chunkHash = await sha256Hex(payloadJson);
    await ctx.db.insert("simulatorRunChunks", {
      runId: run._id,
      scholarId: run.scholarId,
      startTick: args.startTick,
      endTick: args.chunk.endTick,
      attempt: args.attempt,
      ticks: args.chunk.ticks,
      initialCheckpoint: args.chunk.initialCheckpoint,
      checkpoint: args.chunk.checkpoint,
      chunkHash,
      createdAt: now,
    });
    const summarySeries = downsample([
      ...run.summarySeries,
      ...args.chunk.ticks.map((tick) => ({
        tick: tick.tick + 1,
        values: tick.metrics.filter((metric) =>
          (template.summaryMetricKeys as readonly string[]).includes(metric.key),
        ),
      })),
    ]);
    const criterion = run.simulatorSpecSnapshot.criterion;
    const extinct =
      run.simulatorSpecSnapshot.templateId === "ecosystemGrid" && ecosystemIsExtinct(finalState);
    const criterionScores =
      criterion.kind === "measured" && !extinct
        ? args.chunk.currentMetrics.filter(
            (metric) => metric.key === criterion.metricKey,
          )
        : [];
    const invalidActionCount =
      run.invalidActionCount +
      args.chunk.ticks.reduce((sum, tick) => sum + tick.invalidActionCount, 0);
    const completed = args.chunk.terminal || args.chunk.endTick >= run.targetTicks;
    const halted = Boolean(run.stopRequestedAt || run.pauseRequestedAt);
    const basePatch = {
      nextTick: args.chunk.endTick,
      chunkCount: run.chunkCount + 1,
      latestCommittedTick: args.chunk.endTick,
      latestChunkStartTick: args.startTick,
      latestCheckpointTick: args.chunk.checkpoint?.tick ?? run.latestCheckpointTick,
      latestSnapshotJson: canonicalJson(finalState),
      latestSceneJson: args.chunk.finalSceneJson,
      currentMetrics: args.chunk.currentMetrics,
      summarySeries,
      criterionScores,
      extinct,
      invalidActionCount,
      modelCallCount: run.modelCallCount + args.chunk.modelCallCount,
      decisionCacheHitCount: run.decisionCacheHitCount + args.chunk.decisionCacheHitCount,
      lastCommittedAt: now,
      leaseUntil: undefined,
      leasedAt: undefined,
      workId: undefined,
      updatedAt: now,
    };
    if (completed) {
      await ctx.db.patch(run._id, {
        ...basePatch,
        status: "completed",
        haltReason: args.chunk.terminal ? "terminal_physics" : undefined,
        endedAt: now,
      });
      await wakeDispatcher(ctx);
      if (!run.tournamentId) {
        await ctx.db.insert("messages", {
          sessionId: run.sessionId,
          role: "system",
          content: `[Notebook run_marker] Run ${String(run._id)} completed at tick ${args.chunk.endTick}.`,
          notebookEntry: {
            kind: "run_marker",
            runId: run._id,
            deckVersion: run.deckVersion,
            outcomeMetrics: criterionScores,
          },
          flagged: false,
        });
      }
      await refreshTournament(ctx, run);
      return { kind: "committed" as const, status: "completed" as const };
    }
    if (halted) {
      await ctx.db.patch(run._id, {
        ...basePatch,
        status: "halted",
        haltReason: run.pauseRequestedAt ? "teacher_pause" : "scholar_stop",
        endedAt: now,
      });
      await refreshTournament(ctx, run);
      await wakeDispatcher(ctx);
      return { kind: "committed" as const, status: "halted" as const };
    }
    await ctx.db.patch(run._id, {
      ...basePatch,
      status: "queued",
      attempt: 0,
    });
    await wakeDispatcher(ctx);
    return { kind: "committed" as const, status: "queued" as const };
  },
});

async function requeueOrCrash(
  ctx: MutationCtx,
  run: Doc<"simulatorRuns">,
  entry: {
    startTick: number;
    attempt: number;
    outcome: AttemptOutcome;
    errorCode?: string;
    errorMessage?: string;
    usage?: ModelUsage;
    at: number;
  },
): Promise<RetryResult> {
  const attemptLog = boundedAttemptLog(run, entry);
  if (run.attempt >= MAX_CHUNK_ATTEMPTS) {
    await ctx.db.patch(run._id, {
      status: "crashed",
      attemptLog,
      leaseUntil: undefined,
      leasedAt: undefined,
      workId: undefined,
      endedAt: entry.at,
      updatedAt: entry.at,
      errorCode: entry.errorCode ?? "SIMULATOR_CHUNK_ATTEMPTS_EXHAUSTED",
      errorMessage: entry.errorMessage ?? "World chunk could not be completed",
    });
    await refreshTournament(ctx, run);
    await wakeDispatcher(ctx);
    return { kind: "crashed" as const };
  }
  await ctx.db.patch(run._id, {
    status: "queued",
    attemptLog,
    leaseUntil: undefined,
    leasedAt: undefined,
    workId: undefined,
    updatedAt: entry.at,
  });
  await wakeDispatcher(ctx);
  return { kind: "requeued" as const };
}

export const failAttempt = internalMutation({
  args: {
    runId: v.id("simulatorRuns"),
    startTick: v.number(),
    attempt: v.number(),
    outcome: v.union(v.literal("provider_error"), v.literal("worker_crash")),
    errorCode: v.optional(v.string()),
    errorMessage: v.optional(v.string()),
    usage: v.optional(usageArg),
  },
  handler: async (ctx, args): Promise<RetryResult> => {
    const run = await ctx.db.get(args.runId);
    if (
      !run ||
      run.status !== "ticking" ||
      run.nextTick !== args.startTick ||
      run.attempt !== args.attempt
    ) {
      return { kind: "stale" as const };
    }
    return await requeueOrCrash(ctx, run, {
      startTick: args.startTick,
      attempt: args.attempt,
      outcome: args.outcome,
      errorCode: args.errorCode,
      errorMessage: args.errorMessage,
      usage: args.usage,
      at: Date.now(),
    });
  },
});

export const watchdog = internalMutation({
  args: { runId: v.id("simulatorRuns"), startTick: v.number(), attempt: v.number() },
  handler: async (ctx, args): Promise<RetryResult> => {
    const run = await ctx.db.get(args.runId);
    const now = Date.now();
    if (
      !run ||
      run.status !== "ticking" ||
      run.nextTick !== args.startTick ||
      run.attempt !== args.attempt ||
      !run.leaseUntil ||
      run.leaseUntil > now
    ) {
      return { kind: "stale" as const };
    }
    return await requeueOrCrash(ctx, run, {
      startTick: args.startTick,
      attempt: args.attempt,
      outcome: "lease_expired",
      errorCode: "SIMULATOR_LEASE_EXPIRED",
      errorMessage: "World tick worker lease expired",
      at: now,
    });
  },
});
