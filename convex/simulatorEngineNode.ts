"use node";

import { v } from "convex/values";

import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { internalAction } from "./_generated/server";
import type { ActionCtx } from "./_generated/server";
import {
  AUTOMATON_CALL_BATCH_SIZE,
  AUTOMATON_CALL_TIMEOUT_MS,
} from "./simulatorEngine";
import {
  MAX_REASONING_CHARS,
  MAX_SCRATCH_CHARS,
  MAX_CHUNK_JSON_BYTES,
  type DeckCard,
  type DecisionSource,
  type ModelUsage,
  type SimulatorSpec,
} from "../lib/simulator/contract";
import {
  evaluatePolicy,
  POLICY_INTERPRETER_VERSION,
  type PolicyEvaluation,
  type PolicyIR,
} from "../lib/simulator/policyIR";
import {
  buildAutomatonPrompt,
  canonicalJson,
  decisionHash,
  isExactLegalAction,
  sha256Hex,
  type AutomatonPrompt,
} from "../lib/simulator/prompt";
import { appendCanonicalJsonArrayByteLength } from "../lib/simulator/chunkByteAccounting";
import {
  getSimulatorTemplate,
  type SimulatorTemplateAny,
} from "../lib/simulator/templates/registry";
import { recordUsage } from "./usage";
import { ROLES } from "./lib/roles";
import type AnthropicClient from "@anthropic-ai/sdk";

type RawUsage = {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
};

type ModelResponse = {
  content: unknown[];
  usage?: RawUsage;
};

type ModelDecision = {
  content: unknown[];
  input: unknown;
  usage: ModelUsage;
};

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
        deckSnapshot: DeckCard[];
        simulatorSpecSnapshot: SimulatorSpec;
        compiledPolicyHash?: string;
        interpreterVersion?: number;
        compiledPolicySnapshot?: Array<
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
            }
        >;
        stateJson: string;
        scratchByAutomaton: Array<{ automatonId: string; scratch: string }>;
      };
    };
type WorkerResult = {
  kind: "committed" | "deferred" | "stale" | "handled_failure";
};

const COMPILED_CHUNK_SOFT_BYTES = 256 * 1024;

type PendingDecision = {
  automatonId: string;
  slotId: string;
  deckCard: DeckCard;
  observation: unknown;
  legalActions: readonly unknown[];
  scratchBefore?: string;
  phase: string;
  hash: string;
  prompt?: AutomatonPrompt;
};

type AcceptedRecord = {
  automatonId: string;
  slotId: string;
  observationJson: string;
  scratchBefore?: string;
  tickPhase: string;
  legalActionsJson: string;
  decisionHash: string;
  source: DecisionSource;
  cacheOrigin?: {
    runId: Id<"simulatorRuns">;
    startTick: number;
    tick: number;
    automatonId: string;
  };
  modelResponseJson: string;
  reasoning: string;
  policyRuleId?: string;
  policyTrace?: string;
  requestedActionJson: string;
  acceptedActionJson: string;
  accepted: boolean;
  invalidCode?: string;
  scratchAfter?: string;
  usage?: ModelUsage;
};

class ProviderWaveError extends Error {
  constructor(
    message: string,
    readonly attemptUsage: ModelUsage,
    readonly unrecordedUsage: ModelUsage,
  ) {
    super(message);
  }
}

function zeroUsage(): ModelUsage {
  return { inputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0, outputTokens: 0 };
}

function addUsage(left: ModelUsage, right: ModelUsage): ModelUsage {
  return {
    inputTokens: left.inputTokens + right.inputTokens,
    cacheWriteTokens: left.cacheWriteTokens + right.cacheWriteTokens,
    cacheReadTokens: left.cacheReadTokens + right.cacheReadTokens,
    outputTokens: left.outputTokens + right.outputTokens,
  };
}

function normalizeUsage(usage?: RawUsage): ModelUsage {
  return {
    inputTokens: usage?.input_tokens ?? 0,
    cacheWriteTokens: usage?.cache_creation_input_tokens ?? 0,
    cacheReadTokens: usage?.cache_read_input_tokens ?? 0,
    outputTokens: usage?.output_tokens ?? 0,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function neutralAction(legalActions: readonly unknown[]): unknown {
  const neutral =
    legalActions.find(
      (action) => isRecord(action) && action.kind === "noop",
    ) ??
    legalActions[0];
  if (
    neutral === undefined ||
    !isExactLegalAction(neutral, legalActions)
  ) {
    throw new Error("World template produced no valid legal action");
  }
  return neutral;
}

function parseToolDecision(content: unknown[]): { input: unknown } | null {
  for (const block of content) {
    if (
      isRecord(block) &&
      block.type === "tool_use" &&
      block.name === "choose_action" &&
      "input" in block
    ) {
      return { input: block.input };
    }
  }
  return null;
}

async function createModelClient(): Promise<AnthropicClient> {
  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  return new Anthropic();
}

async function callModel(
  anthropic: AnthropicClient,
  modelId: string,
  prompt: AutomatonPrompt,
): Promise<ModelDecision> {
  const systemBlock = prompt.cacheControlEligible
    ? {
        type: "text" as const,
        text: prompt.cacheablePrefix,
        cache_control: { type: "ephemeral" as const },
      }
    : { type: "text" as const, text: prompt.cacheablePrefix };
  const response = (await anthropic.messages.create(
    {
      model: modelId,
      max_tokens: 256,
      temperature: 0,
      system: [systemBlock],
      tools: [prompt.chooseActionTool],
      tool_choice: { type: "tool", name: "choose_action" },
      messages: [{ role: "user", content: prompt.dynamicSuffix }],
    },
    { timeout: AUTOMATON_CALL_TIMEOUT_MS, maxRetries: 0 },
  )) as ModelResponse;
  const tool = parseToolDecision(response.content);
  return {
    content: response.content,
    input: tool?.input,
    usage: normalizeUsage(response.usage),
  };
}

function acceptedFromModel(
  template: SimulatorTemplateAny,
  pending: PendingDecision,
  result: ModelDecision,
  provenance?: {
    source: "compiled-fallback";
    policyRuleId?: string;
    policyTrace: string;
  },
): AcceptedRecord {
  const raw = result.input;
  const responseJson = JSON.stringify(result.content);
  let requestedAction: unknown = null;
  let acceptedAction: unknown = neutralAction(pending.legalActions);
  let reasoning = "";
  let scratch: string | undefined;
  let invalidCode: string | undefined;
  if (!isRecord(raw)) {
    invalidCode = "INVALID_MODEL_RESPONSE";
  } else {
    requestedAction = raw.action ?? null;
    if (typeof raw.reasoning !== "string" || raw.reasoning.length > MAX_REASONING_CHARS) {
      invalidCode = "INVALID_REASONING";
    } else {
      reasoning = raw.reasoning;
    }
    if (
      raw.scratch !== undefined &&
      (typeof raw.scratch !== "string" || raw.scratch.length > MAX_SCRATCH_CHARS)
    ) {
      invalidCode ??= "INVALID_SCRATCH";
    } else if (typeof raw.scratch === "string") {
      scratch = raw.scratch;
    }
    if (!invalidCode) {
      try {
        // Haiku sometimes obeys the inner action schema semantically but wraps
        // that object in one JSON string. Decode exactly one layer, then apply
        // the identical strict template + current-legal-set validation.
        const actionPayload =
          typeof raw.action === "string" ? JSON.parse(raw.action) : raw.action;
        const parsed = template.validateAction(actionPayload);
        if (isExactLegalAction(parsed, pending.legalActions)) acceptedAction = parsed;
        else invalidCode = "ACTION_NOT_LEGAL";
      } catch {
        invalidCode = "INVALID_ACTION_SCHEMA";
      }
    }
  }
  return {
    automatonId: pending.automatonId,
    slotId: pending.slotId,
    observationJson: canonicalJson(pending.observation),
    scratchBefore: pending.scratchBefore,
    tickPhase: pending.phase,
    legalActionsJson: canonicalJson(pending.legalActions),
    decisionHash: pending.hash,
    source: provenance?.source ?? "model",
    modelResponseJson: responseJson,
    reasoning,
    policyRuleId: provenance?.policyRuleId,
    policyTrace: provenance?.policyTrace,
    requestedActionJson: canonicalJson(requestedAction),
    acceptedActionJson: canonicalJson(acceptedAction),
    accepted: invalidCode === undefined,
    invalidCode,
    scratchAfter: invalidCode ? pending.scratchBefore : scratch,
    usage: result.usage,
  };
}

function acceptedFromPolicy(
  template: SimulatorTemplateAny,
  pending: PendingDecision,
  evaluation: Extract<PolicyEvaluation, { kind: "action" }>,
): AcceptedRecord {
  let acceptedAction = neutralAction(pending.legalActions);
  try {
    const parsed = template.validateAction(evaluation.action);
    if (isExactLegalAction(parsed, pending.legalActions)) {
      acceptedAction = parsed;
    }
  } catch {
    // evaluatePolicy already fails closed to the current neutral legal action.
    acceptedAction = neutralAction(pending.legalActions);
  }
  return {
    automatonId: pending.automatonId,
    slotId: pending.slotId,
    observationJson: canonicalJson(pending.observation),
    scratchBefore: pending.scratchBefore,
    tickPhase: pending.phase,
    legalActionsJson: canonicalJson(pending.legalActions),
    decisionHash: pending.hash,
    source: "compiled",
    modelResponseJson: "[]",
    reasoning: evaluation.trace,
    policyRuleId: evaluation.ruleId,
    policyTrace: evaluation.trace,
    requestedActionJson: canonicalJson(evaluation.action),
    acceptedActionJson: canonicalJson(acceptedAction),
    accepted: true,
    scratchAfter: pending.scratchBefore,
  };
}

function correctionPrompt(
  pending: PendingDecision,
  rejected: AcceptedRecord,
): AutomatonPrompt {
  if (!pending.prompt) throw new Error("LLM correction is missing its prompt");
  return {
    ...pending.prompt,
    dynamicSuffix: [
      pending.prompt.dynamicSuffix,
      "CORRECTION REQUIRED",
      `The previous action was rejected as ${rejected.invalidCode ?? "invalid"}.`,
      `Rejected action: ${rejected.requestedActionJson}`,
      "Return one exact object copied from the LEGAL ACTION MENU NOW. Do not reuse or repair the rejected coordinates.",
    ].join("\n"),
  };
}

async function correctionHash(
  pending: PendingDecision,
  rejected: AcceptedRecord,
): Promise<string> {
  return await sha256Hex(
    canonicalJson({
      correctionOfDecisionHash: pending.hash,
      invalidCode: rejected.invalidCode,
      rejectedActionJson: rejected.requestedActionJson,
    }),
  );
}

type CompiledSlot =
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
    }
  | {
      slotId: string;
      status: "fallback";
      reason: "version_mismatch";
    };

type ResolvedDecision = {
  record: AcceptedRecord;
  usage: ModelUsage;
  modelCalls: number;
};

function compileFallbackTrace(slot: CompiledSlot | undefined): string {
  if (!slot) return "No compiled policy was frozen for this species, so this tick asks Haiku.";
  if (slot.status === "ready") return "The compiled policy abstained, so this tick asks Haiku.";
  if (slot.reason === "compiling") {
    return "The prompt was still compiling when this run started, so this tick asks Haiku.";
  }
  if (slot.reason === "failed") {
    return "The prompt couldn't be compiled, so this tick asks Haiku.";
  }
  if (slot.reason === "version_mismatch") {
    return "This run's compiled policy uses a different interpreter version, so this tick asks Haiku.";
  }
  return "The compiled policy was unavailable when this run started, so this tick asks Haiku.";
}

async function resolveDecision(input: {
  pending: PendingDecision;
  template: SimulatorTemplateAny;
  spec: SimulatorSpec;
  tick: number;
  modelId: string;
  compiledSlot?: CompiledSlot;
  getAnthropic: () => Promise<AnthropicClient>;
}): Promise<ResolvedDecision> {
  if (input.spec.interpreter.kind === "scripted" && input.compiledSlot?.status === "ready") {
    const evaluation = evaluatePolicy(
      input.compiledSlot.policy,
      input.pending.observation,
      input.pending.legalActions,
      input.tick,
      input.pending.scratchBefore,
      input.pending.phase,
    );
    if (evaluation.kind === "action") {
      return {
        record: acceptedFromPolicy(input.template, input.pending, evaluation),
        usage: zeroUsage(),
        modelCalls: 0,
      };
    }
    const prompt = await buildAutomatonPrompt({
      template: input.template,
      spec: input.spec,
      deckCard: input.pending.deckCard,
      observation: input.pending.observation,
      legalActions: input.pending.legalActions,
      tick: input.tick,
      phase: input.pending.phase,
      scratch: input.pending.scratchBefore,
    });
    const model = await callModel(
      await input.getAnthropic(),
      input.modelId,
      prompt,
    );
    return {
      record: acceptedFromModel(input.template, input.pending, model, {
        source: "compiled-fallback",
        policyRuleId: evaluation.ruleId,
        policyTrace: evaluation.trace,
      }),
      usage: model.usage,
      modelCalls: 1,
    };
  }

  if (input.spec.interpreter.kind === "scripted") {
    const prompt = await buildAutomatonPrompt({
      template: input.template,
      spec: input.spec,
      deckCard: input.pending.deckCard,
      observation: input.pending.observation,
      legalActions: input.pending.legalActions,
      tick: input.tick,
      phase: input.pending.phase,
      scratch: input.pending.scratchBefore,
    });
    const model = await callModel(
      await input.getAnthropic(),
      input.modelId,
      prompt,
    );
    const trace = compileFallbackTrace(input.compiledSlot);
    return {
      record: acceptedFromModel(input.template, input.pending, model, {
        source: "compiled-fallback",
        policyTrace: trace,
      }),
      usage: model.usage,
      modelCalls: 1,
    };
  }

  const prompt = input.pending.prompt;
  if (!prompt) throw new Error("LLM decision is missing its prompt");
  const model = await callModel(
    await input.getAnthropic(),
    input.modelId,
    prompt,
  );
  return {
    record: acceptedFromModel(input.template, input.pending, model),
    usage: model.usage,
    modelCalls: 1,
  };
}

export const runTickChunk = internalAction({
  args: {
    runId: v.id("simulatorRuns"),
    startTick: v.number(),
    expectedAttempt: v.number(),
    dispatchToken: v.optional(v.string()),
  },
  handler: async (ctx: ActionCtx, args): Promise<WorkerResult> => {
    const claim: ClaimResult = await ctx.runMutation(internal.simulatorEngine.claimLease, {
      runId: args.runId,
      expectedStartTick: args.startTick,
      expectedAttempt: args.expectedAttempt,
      dispatchToken: args.dispatchToken,
    });
    if (claim.kind === "stale") return { kind: "stale" as const };
    if (claim.kind === "deferred") {
      await ctx.runMutation(internal.simulatorEngine.deferQueuedRun, {
        runId: args.runId,
        startTick: args.startTick,
        expectedAttempt: args.expectedAttempt,
        dispatchToken: args.dispatchToken,
      });
      return { kind: "deferred" as const };
    }
    const institutionId = await ctx.runQuery(
      internal.usage.resolveSessionInstitution,
      { sessionId: claim.input.sessionId },
    );

    let failedUsage = zeroUsage();
    try {
      const input = claim.input;
      const spec = input.simulatorSpecSnapshot as SimulatorSpec;
      const template = getSimulatorTemplate(spec.templateId);
      if (!template) throw new Error(`Unknown World template "${spec.templateId}"`);
      template.validateSpec(spec);
      let anthropic: AnthropicClient | undefined =
        spec.interpreter.kind === "llm" ? await createModelClient() : undefined;
      const getAnthropic = async () => {
        anthropic ??= await createModelClient();
        return anthropic;
      };
      let state = template.validateState(JSON.parse(input.stateJson));
      const initialStateJson = canonicalJson(state);
      const initialSceneJson = canonicalJson(
        template.renderScene({ state, tick: input.startTick }),
      );
      const deckBySlot = new Map(input.deckSnapshot.map((card) => [card.slotId, card]));
      const compiledVersionMatches =
        input.interpreterVersion === POLICY_INTERPRETER_VERSION;
      const compiledBySlot = new Map<string, CompiledSlot>(
        (input.compiledPolicySnapshot ?? []).map((slot) => [
          slot.slotId,
          compiledVersionMatches
            ? slot
            : {
                slotId: slot.slotId,
                status: "fallback" as const,
                reason: "version_mismatch" as const,
              },
        ]),
      );
      // P0 measured zero safe exact-cache hits because the decision hash includes
      // absolute tick, self identity/position, scratch, and the local legal set.
      // Keep hashes as forensic provenance, but skip all guaranteed-miss lookup
      // reads. Scratch continuity is independent and arrives explicitly.
      const scratchByAutomaton = new Map(
        input.scratchByAutomaton.map(({ automatonId, scratch }) => [
          automatonId,
          scratch,
        ]),
      );
      const ticks = [];
      // canonicalJson([]) is two ASCII bytes. Each appended canonical tick adds
      // its UTF-8 bytes and one comma after the first tick.
      let ticksJsonByteLength = 2;
      let terminal = false;
      let modelCallCount = 0;
      const decisionCacheHitCount = 0;
      for (let tick = input.startTick; tick < input.endTick && !terminal; tick += 1) {
        if (
          ticks.length > 0 &&
          input.endTick - input.startTick > 5 &&
          ticksJsonByteLength >=
            Math.min(COMPILED_CHUNK_SOFT_BYTES, MAX_CHUNK_JSON_BYTES / 2)
        ) {
          break;
        }
        const previousState = state;
        const phase = template.tickPhase({ state, tick });
        const pending: PendingDecision[] = [];
        for (const automaton of [...template.listAutomata(state)].sort((left, right) =>
          left.id.localeCompare(right.id),
        )) {
          const deckCard = deckBySlot.get(automaton.slotId);
          if (!deckCard) throw new Error(`Run has no Species card for "${automaton.slotId}"`);
          const observation = template.buildObservation({
            state,
            automatonId: automaton.id,
            senses: automaton.senses,
            tick,
          });
          const legalActions = template.legalActions({
            state,
            automatonId: automaton.id,
            observation,
            tick,
          });
          const prompt =
            spec.interpreter.kind === "llm"
              ? await buildAutomatonPrompt({
                  template,
                  spec,
                  deckCard,
                  observation,
                  legalActions,
                  tick,
                  phase,
                  scratch: scratchByAutomaton.get(automaton.id),
                })
              : undefined;
          const hash =
            prompt !== undefined
              ? await decisionHash({
                  modelId: input.modelId,
                  cacheablePrefixHash: prompt.cacheablePrefixHash,
                  templateId: spec.templateId,
                  templateVersion: spec.templateVersion,
                  speciesPrompt: deckCard.prompt,
                  slotId: deckCard.slotId,
                  observation,
                  scratch: scratchByAutomaton.get(automaton.id),
                  tick,
                  tickPhase: phase,
                  legalActions,
                })
              : await sha256Hex(
                  canonicalJson({
                    compiledPolicyHash: input.compiledPolicyHash ?? null,
                    interpreterVersion: input.interpreterVersion ?? null,
                    slot: compiledBySlot.get(automaton.slotId) ?? null,
                    automatonId: automaton.id,
                    observation,
                    scratch: scratchByAutomaton.get(automaton.id) ?? null,
                    tick,
                    tickPhase: phase,
                    legalActions,
                  }),
                );
          pending.push({
            automatonId: automaton.id,
            slotId: automaton.slotId,
            deckCard,
            observation,
            legalActions,
            scratchBefore: scratchByAutomaton.get(automaton.id),
            phase,
            hash,
            prompt,
          });
        }

        const records = new Map<string, AcceptedRecord>();
        const misses = pending;
        let waveUsage = zeroUsage();
        for (let index = 0; index < misses.length; index += AUTOMATON_CALL_BATCH_SIZE) {
          const slice = misses.slice(index, index + AUTOMATON_CALL_BATCH_SIZE);
          const settled = await Promise.allSettled(
            slice.map(async (decision) => ({
              decision,
              result: await resolveDecision({
                pending: decision,
                template,
                spec,
                tick,
                modelId: input.modelId,
                compiledSlot: compiledBySlot.get(decision.slotId),
                getAnthropic,
              }),
            })),
          );
          for (const result of settled) {
            if (result.status === "fulfilled") {
              waveUsage = addUsage(waveUsage, result.value.result.usage);
              records.set(
                result.value.decision.automatonId,
                result.value.result.record,
              );
              modelCallCount += result.value.result.modelCalls;
            }
          }
          const rejected = settled.find(
            (result): result is PromiseRejectedResult => result.status === "rejected",
          );
          if (rejected) {
            failedUsage = addUsage(failedUsage, waveUsage);
            throw new ProviderWaveError(
              rejected.reason instanceof Error ? rejected.reason.message : String(rejected.reason),
              failedUsage,
              waveUsage,
            );
          }
          if (spec.interpreter.kind === "llm") {
            const correctionCandidates = slice.filter(
              (decision) => !records.get(decision.automatonId)?.accepted,
            );
            const corrected = await Promise.allSettled(
              correctionCandidates.map(async (decision) => {
                const first = records.get(decision.automatonId)!;
                const result = await callModel(
                  await getAnthropic(),
                  input.modelId,
                  correctionPrompt(decision, first),
                );
                return { decision, first, result };
              }),
            );
            for (const result of corrected) {
              if (result.status !== "fulfilled") continue;
              waveUsage = addUsage(waveUsage, result.value.result.usage);
              modelCallCount += 1;
              const record = acceptedFromModel(
                template,
                result.value.decision,
                result.value.result,
              );
              record.decisionHash = await correctionHash(
                result.value.decision,
                result.value.first,
              );
              records.set(result.value.decision.automatonId, record);
            }
            const correctionRejected = corrected.find(
              (result): result is PromiseRejectedResult => result.status === "rejected",
            );
            if (correctionRejected) {
              failedUsage = addUsage(failedUsage, waveUsage);
              throw new ProviderWaveError(
                correctionRejected.reason instanceof Error
                  ? correctionRejected.reason.message
                  : String(correctionRejected.reason),
                failedUsage,
                waveUsage,
              );
            }
          }
        }
        failedUsage = addUsage(failedUsage, waveUsage);
        await recordUsage(ctx, {
          source: "world_automaton",
          role: ROLES.SCHOLAR,
          model: input.modelId,
          usage: waveUsage,
          sessionId: input.sessionId,
          institutionId,
        });
        const orderedRecords = pending.map((decision) => {
          const record = records.get(decision.automatonId);
          if (!record) throw new Error(`Automaton "${decision.automatonId}" has no decision`);
          if (record.scratchAfter !== undefined) {
            scratchByAutomaton.set(record.automatonId, record.scratchAfter);
          }
          return record;
        });
        const actionMap = new Map<string, unknown>(
          orderedRecords.map((record) => [
            record.automatonId,
            template.validateAction(JSON.parse(record.acceptedActionJson)),
          ]),
        );
        const physicsSeed = `${input.seed}:${tick}`;
        const applied = template.applyActions({
          state,
          actions: actionMap,
          tick,
          tickSeed: physicsSeed,
        });
        const modelInvalidIds = orderedRecords
          .filter((record) => !record.accepted)
          .map((record) => record.automatonId);
        state =
          modelInvalidIds.length === 0
            ? applied.state
            : template.withInvalidActions({
                state: applied.state,
                count: modelInvalidIds.length,
              });
        const delta =
          modelInvalidIds.length === 0
            ? applied.delta
            : template.withInvalidActionDelta({
                delta: applied.delta,
                automatonIds: modelInvalidIds,
              });
        const metrics = template.metrics({ previousState, state, tick });
        const tickRecord = {
          tick,
          phase: applied.phase,
          physicsSeed,
          automata: orderedRecords,
          deltaJson: canonicalJson(delta),
          metrics: Object.entries(metrics).map(([key, value]) => ({ key, value })),
          invalidActionCount: modelInvalidIds.length,
        };
        const canonicalTickJson = canonicalJson(tickRecord);
        ticksJsonByteLength = appendCanonicalJsonArrayByteLength(
          ticksJsonByteLength,
          canonicalTickJson,
        );
        ticks.push(tickRecord);
        terminal = applied.terminal;
      }
      const endTick = input.startTick + ticks.length;
      const finalStateJson = canonicalJson(state);
      const finalSceneJson = canonicalJson(template.renderScene({ state, tick: endTick }));
      const shouldCheckpoint = terminal || endTick >= input.targetTicks || endTick % 20 === 0;
      const checkpoint =
        shouldCheckpoint
          ? {
              tick: endTick,
              stateJson: finalStateJson,
              sceneJson: finalSceneJson,
              stateHash: await sha256Hex(finalStateJson),
            }
          : undefined;
      const currentMetrics = ticks.at(-1)?.metrics ?? [];
      const commit: { kind: "stale" | "committed" } = await ctx.runMutation(
        internal.simulatorEngine.commitChunk,
        {
        runId: input.runId,
        startTick: input.startTick,
        attempt: claim.attempt,
        chunk: {
          endTick,
          ticks,
          initialCheckpoint:
            input.startTick === 0
              ? {
                  tick: 0,
                  stateJson: initialStateJson,
                  sceneJson: initialSceneJson,
                  stateHash: await sha256Hex(initialStateJson),
                }
              : undefined,
          checkpoint,
          finalStateJson,
          finalSceneJson,
          currentMetrics,
          terminal,
          modelCallCount,
          decisionCacheHitCount,
        },
        },
      );
      return commit.kind === "committed"
        ? { kind: "committed" as const }
        : { kind: "stale" as const };
    } catch (error) {
      const provider = error instanceof ProviderWaveError;
      if (provider) {
        await recordUsage(ctx, {
          source: "world_automaton",
          role: ROLES.SCHOLAR,
          model: claim.input.modelId,
          usage: error.unrecordedUsage,
          sessionId: claim.input.sessionId,
          institutionId,
        });
      }
      await ctx.runMutation(internal.simulatorEngine.failAttempt, {
        runId: args.runId,
        startTick: args.startTick,
        attempt: claim.attempt,
        outcome: provider ? "provider_error" : "worker_crash",
        errorCode: provider ? "AUTOMATON_PROVIDER_ERROR" : "SIMULATOR_WORKER_ERROR",
        errorMessage: error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500),
        usage: provider ? error.attemptUsage : failedUsage,
      });
      return { kind: "handled_failure" as const };
    }
  },
});
