import { v } from "convex/values";

import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import {
  internalMutation,
  internalQuery,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import { authedMutation, authedQuery, teacherMutation } from "./lib/customFunctions";
import { isPlatformAdminRole, isSchoolAdminRole, isTeacherRole } from "./lib/roles";
import {
  MAX_AUTOMATA_COMPILED_RUN,
  MAX_NOTEBOOK_ENTRY_CHARS,
  MAX_PROMPT_CHARS,
  MAX_RUN_GRANTS_PER_BENCH,
  type DeckCard,
  type LaunchedSpecies,
  type SpeciesSlot,
  type SimulatorSpec as SimulatorSpec,
} from "../lib/simulator/contract";
import {
  POLICY_INTERPRETER_VERSION,
  policyCompileContextHash,
  policyCompilerFingerprint,
  shouldRecompileFailedPolicy,
  shouldRestartCompilingPolicy,
} from "../lib/simulator/policyIR";
import { canAddSpeciesSlot, criterionSentence } from "../lib/simulator/helpers";
import { canonicalJson, sha256Hex } from "../lib/simulator/prompt";
import { getSimulatorTemplate as getSimulatorTemplate } from "../lib/simulator/templates/registry";
import { ACTIVITY_KIND } from "../lib/activityKinds";
import {
  budgetWindowKeys,
  DEFAULT_BLOCK_RUN_LIMIT,
  DEFAULT_WEEK_RUN_LIMIT,
} from "./lib/simulatorRunBudget";
import { isPredictionEvidenceRun } from "./lib/simulatorRunEvidence";
import { simulatorSpecForStorage as simulatorSpecForStorage } from "./seed/systemsAgents";
import { simulatorSpecValidator } from "./schema";
import { MODELS } from "./lib/models";

const deckCardArg = v.object({
  slotId: v.string(),
  count: v.number(),
  prompt: v.string(),
});

const publicNotebookEntryArg = v.union(
  v.object({
    kind: v.literal("conclusion"),
    runIds: v.array(v.id("simulatorRuns")),
    text: v.string(),
  }),
  v.object({ kind: v.literal("note"), text: v.string() }),
);

type NotebookEntry = NonNullable<Doc<"messages">["notebookEntry"]>;

type DbCtx = Pick<QueryCtx, "db"> | Pick<MutationCtx, "db">;

export function resolveBenchSimulator(
  activity: Doc<"activities">,
  bench?: Doc<"simulatorBenches"> | null,
) {
  if (activity.kind !== "simulator") return null;
  const resolve = (storedSpec: NonNullable<Doc<"activities">["simulatorSpec"]>) => {
    const spec = storedSpec as SimulatorSpec;
    const template = getSimulatorTemplate(spec.templateId);
    if (!template) throw new Error(`Unknown Simulator template "${spec.templateId}"`);
    template.validateSpec(spec);
    return { spec, template };
  };

  if (bench?.effectiveSpec) {
    try {
      return { ...resolve(bench.effectiveSpec), forkInvalid: false };
    } catch {
      const activitySpec = activity.simulatorSpec ?? activity.simulatorSpec;
      if (!activitySpec) throw new Error("Workbench activity has no valid Simulator");
      return { ...resolve(activitySpec), forkInvalid: true };
    }
  }
  const activitySpec = activity.simulatorSpec ?? activity.simulatorSpec;
  if (!activitySpec) return null;
  return { ...resolve(activitySpec), forkInvalid: false };
}

async function simulatorSession(
  ctx: DbCtx,
  sessionId: Id<"sessions">,
  suppliedBench?: Doc<"simulatorBenches"> | null,
) {
  const session = await ctx.db.get(sessionId);
  if (!session) throw new Error("Session not found");
  if (session.sessionMode !== "workbench" || !session.activityId) {
    throw new Error("Session is not a Simulator Workbench");
  }
  const activity = await ctx.db.get(session.activityId);
  if (!activity) throw new Error("Workbench activity has no valid Simulator");
  const bench =
    suppliedBench === undefined
      ? await ctx.db
          .query("simulatorBenches")
          .withIndex("by_session", (query) => query.eq("sessionId", sessionId))
          .unique()
      : suppliedBench;
  const resolved = resolveBenchSimulator(activity, bench);
  if (!resolved) throw new Error("Workbench activity has no valid Simulator");
  return { session, activity, bench, ...resolved };
}

function mayReadSession(user: Doc<"users">, session: Doc<"sessions">): boolean {
  return session.userId === user._id || isTeacherRole(user.role);
}

function templateLabel(templateId: SimulatorSpec["templateId"]): string {
  return templateId === "ecosystemGrid" ? "Ecosystem Grid" : "Prisoner's Dilemma";
}

function scoreForRun(spec: SimulatorSpec, run: Doc<"simulatorRuns">): number | null {
  if (spec.criterion.kind !== "measured" || run.extinct) return null;
  const metricKey = spec.criterion.metricKey;
  return (
    run.criterionScores.find((metric) => metric.key === metricKey)?.value ?? null
  );
}

function summarizeBenchRuns(
  spec: SimulatorSpec,
  runs: readonly Doc<"simulatorRuns">[],
) {
  const benchRuns = runs.filter((run) => run.tournamentId === undefined);
  const scores = benchRuns
    .map((run) => scoreForRun(spec, run))
    .filter((score): score is number => score !== null);
  const direction =
    spec.criterion.kind === "measured"
      ? spec.criterion.direction
      : "maximize";
  const target =
    spec.criterion.kind === "measured" ? (spec.criterion.target ?? 0) : 0;
  const bestScore =
    scores.length === 0
      ? null
      : direction === "minimize"
        ? Math.min(...scores)
        : direction === "target"
          ? scores.reduce((best, score) =>
              Math.abs(score - target) < Math.abs(best - target)
                ? score
                : best,
            )
          : Math.max(...scores);
  const latest = benchRuns.reduce<Doc<"simulatorRuns"> | null>(
    (candidate, run) =>
      candidate === null || run._creationTime > candidate._creationTime
        ? run
        : candidate,
    null,
  );

  return {
    benchRuns,
    bestScore,
    latestOutcome: latest
      ? {
          runId: latest._id,
          runKind: latest.runKind,
          status: latest.status,
          score: scoreForRun(spec, latest),
          criterionScores: latest.criterionScores,
          extinct: latest.extinct ?? false,
          ticksCompleted: latest.latestCommittedTick,
          targetTicks: latest.targetTicks,
          haltReason: latest.haltReason ?? null,
          errorCode: latest.errorCode ?? null,
        }
      : null,
  };
}

function remainingRunGrants(
  bench: Doc<"simulatorBenches">,
  assignment: Doc<"assignments"> | null,
  runs: readonly Doc<"simulatorRuns">[],
) {
  if (!assignment) return [];
  const { blockKey, weekKey } = budgetWindowKeys(
    Date.now(),
    String(assignment._id),
    (assignment.simulatorRunBudget ?? assignment.simulatorRunBudget)?.timeZone,
  );
  const grouped = new Map<
    string,
    { scope: "block" | "week"; windowKey: string; granted: number }
  >();
  for (const grant of bench.runGrants) {
    if (
      (grant.scope === "block" && grant.windowKey !== blockKey) ||
      (grant.scope === "week" && grant.windowKey !== weekKey)
    ) {
      continue;
    }
    const key = `${grant.scope}\0${grant.windowKey}`;
    const existing = grouped.get(key);
    grouped.set(key, {
      scope: grant.scope,
      windowKey: grant.windowKey,
      granted: (existing?.granted ?? 0) + grant.count,
    });
  }

  return [...grouped.values()].map((grant) => {
    const baseLimit =
      grant.scope === "block"
        ? ((assignment?.simulatorRunBudget ?? assignment?.simulatorRunBudget)?.perScholarBlock ??
          DEFAULT_BLOCK_RUN_LIMIT)
        : ((assignment?.simulatorRunBudget ?? assignment?.simulatorRunBudget)?.perScholarWeek ??
          DEFAULT_WEEK_RUN_LIMIT);
    const reserved = runs.filter(
      (run) =>
        run.tournamentId === undefined &&
        run.budgetState === "reserved" &&
        (grant.scope === "block"
          ? run.budgetBlockKey === grant.windowKey
          : run.budgetWeekKey === grant.windowKey),
    ).length;
    const consumed = Math.max(0, reserved - baseLimit);
    return {
      ...grant,
      remaining: Math.max(0, grant.granted - consumed),
    };
  });
}

export function launchedSpeciesForDeck(spec: SimulatorSpec, deck: readonly DeckCard[]): LaunchedSpecies[] {
  const bySlot = new Map(deck.map((card) => [card.slotId, card]));
  return spec.speciesSlots.map((slot) => {
    const card = bySlot.get(slot.slotId);
    if (!card) throw new Error(`Prompt deck is missing Species slot "${slot.slotId}"`);
    return {
      slotId: slot.slotId,
      label: slot.label,
      count: card.count,
      countMax: slot.countMax,
      senses: slot.senses,
      prompt: card.prompt,
    };
  });
}

export function validateDeckForSpec(spec: SimulatorSpec, deck: readonly DeckCard[]): LaunchedSpecies[] {
  if (deck.length !== spec.speciesSlots.length) {
    throw new Error("Prompt deck must contain exactly one card per Species slot");
  }
  const seen = new Set<string>();
  let total = 0;
  for (const card of deck) {
    if (seen.has(card.slotId)) throw new Error(`Prompt deck repeats Species slot "${card.slotId}"`);
    seen.add(card.slotId);
    const slot = spec.speciesSlots.find((candidate) => candidate.slotId === card.slotId);
    if (!slot) throw new Error(`Prompt deck references unknown Species slot "${card.slotId}"`);
    if (!Number.isInteger(card.count) || card.count < slot.countMin || card.count > slot.countMax) {
      throw new Error(`Species count for "${card.slotId}" is outside its allowed range`);
    }
    if (card.prompt.length > MAX_PROMPT_CHARS) {
      throw new Error(`Species prompt for "${card.slotId}" exceeds ${MAX_PROMPT_CHARS} characters`);
    }
    // A LOCKED slot's deck is teacher-authored and read-only: the scholar may
    // still adjust the count within [countMin, countMax], but the prompt must
    // stay exactly the authored starterHint. Reject rather than silently
    // discard the scholar's edit, so the client can show a legible error.
    if (slot.locked && card.prompt !== (slot.starterHint ?? "")) {
      throw new Error(`The "${slot.label}" deck is locked by your teacher and can't be edited`);
    }
    total += card.count;
  }
  if (total > spec.config.maxAutomata || total > MAX_AUTOMATA_COMPILED_RUN) {
    throw new Error("Prompt deck exceeds the Simulator Automaton limit");
  }
  const species = launchedSpeciesForDeck(spec, deck);
  const template = getSimulatorTemplate(spec.templateId);
  if (!template) throw new Error(`Unknown Simulator template "${spec.templateId}"`);
  template.initialState({ config: spec.config, species, seed: "deck-validation" });
  return species;
}

async function deckHash(deck: readonly DeckCard[]): Promise<string> {
  return await sha256Hex(canonicalJson(deck));
}

async function schedulePolicyCompiles(
  ctx: MutationCtx,
  input: {
    spec: SimulatorSpec;
    deck: readonly DeckCard[];
    deckHash: string;
  },
) {
  if (input.spec.interpreter.kind !== "scripted") return;
  const template = getSimulatorTemplate(input.spec.templateId);
  if (!template) throw new Error(`Unknown Simulator template "${input.spec.templateId}"`);
  const fingerprint = await policyCompilerFingerprint({ modelId: MODELS.SONNET });
  const now = Date.now();
  for (const card of input.deck) {
    const slot = input.spec.speciesSlots.find(
      (candidate) => candidate.slotId === card.slotId,
    );
    if (!slot) throw new Error(`Unknown Species slot "${card.slotId}"`);
    const compileContextHash = await policyCompileContextHash({
      templateId: input.spec.templateId,
      templateVersion: input.spec.templateVersion,
      slotId: card.slotId,
      senses: slot.senses,
      actionSchema: template.actionSchema,
    });
    const existing = await ctx.db
      .query("compiledPolicies")
      .withIndex("by_deck_slot_context", (query) =>
        query
          .eq("deckHash", input.deckHash)
          .eq("slotId", card.slotId)
          .eq("compileContextHash", compileContextHash),
      )
      .unique();
    if (existing) {
      if (
        !shouldRecompileFailedPolicy(existing, { now, fingerprint }) &&
        !shouldRestartCompilingPolicy(existing, { now, fingerprint })
      ) {
        continue;
      }
      await ctx.db.patch(existing._id, {
        status: "compiling",
        policy: undefined,
        policyHash: undefined,
        errorCode: undefined,
        errorMessage: undefined,
        compilerFingerprint: fingerprint,
        compileAttempts:
          existing.compilerFingerprint === fingerprint
            ? (existing.compileAttempts ?? 0)
            : 0,
        compilerModelId: MODELS.SONNET,
        templateVersion: input.spec.templateVersion,
        interpreterVersion: POLICY_INTERPRETER_VERSION,
        updatedAt: now,
      });
      await ctx.scheduler.runAfter(
        0,
        internal.simulatorPolicyCompiler.compilePolicy,
        {
          policyId: existing._id,
          spec: simulatorSpecForStorage(input.spec),
          card: { slotId: card.slotId, prompt: card.prompt },
        },
      );
      continue;
    }
    const policyId = await ctx.db.insert("compiledPolicies", {
      deckHash: input.deckHash,
      slotId: card.slotId,
      templateId: input.spec.templateId,
      templateVersion: input.spec.templateVersion,
      compileContextHash,
      status: "compiling",
      interpreterVersion: POLICY_INTERPRETER_VERSION,
      compilerModelId: MODELS.SONNET,
      compilerFingerprint: fingerprint,
      compileAttempts: 0,
      createdAt: now,
      updatedAt: now,
    });
    await ctx.scheduler.runAfter(0, internal.simulatorPolicyCompiler.compilePolicy, {
      policyId,
      spec: simulatorSpecForStorage(input.spec),
      card: { slotId: card.slotId, prompt: card.prompt },
    });
  }
}

function defaultDeckForSpec(spec: SimulatorSpec): DeckCard[] {
  return spec.speciesSlots.map((slot) => ({
    slotId: slot.slotId,
    count: slot.defaultCount,
    prompt: slot.starterHint ?? "",
  }));
}

/**
 * Append one template-appropriate Species slot to an ecosystemGrid spec (the
 * owner add-species path). The new slot reuses the world-given Senses of the
 * first existing slot (already proven valid — the kid never GRANTS new senses),
 * takes a starter default count that stays inside the run's Automaton budget,
 * and carries an empty starter prompt the scholar then writes. The criterion is
 * untouched here; `updateBenchSpecCore` keeps it locked for a non-teacher owner.
 */
function appendDefaultSpeciesSlot(spec: SimulatorSpec): SimulatorSpec {
  const slots = spec.speciesSlots;
  const template = slots[0];
  const usedDefault = slots.reduce((total, slot) => total + slot.defaultCount, 0);
  const budget = Math.min(spec.config.maxAutomata, MAX_AUTOMATA_COMPILED_RUN);
  const headroom = Math.max(0, budget - usedDefault);
  const defaultCount = Math.min(headroom, 1);
  const countMax = Math.max(defaultCount, Math.min(template?.countMax ?? 6, budget));

  const existingIds = new Set(slots.map((slot) => slot.slotId));
  const existingLabels = new Set(slots.map((slot) => slot.label));
  let ordinal = 1;
  let slotId = `species-${ordinal}`;
  let label = `Species ${ordinal}`;
  while (existingIds.has(slotId) || existingLabels.has(label)) {
    ordinal += 1;
    slotId = `species-${ordinal}`;
    label = `Species ${ordinal}`;
  }

  const newSlot: SpeciesSlot = {
    slotId,
    label,
    countMin: 0,
    countMax,
    defaultCount,
    senses: (template?.senses ?? []).map((sense) => ({ ...sense })),
  };
  return { ...spec, speciesSlots: [...slots, newSlot] } as SimulatorSpec;
}

/**
 * Force every LOCKED slot's card prompt to its authored starterHint,
 * leaving unlocked slots' cards untouched. The single source of truth for a
 * locked deck's text is the spec, never the persisted card — used for DISPLAY
 * (getBench, so a client's next save always echoes the live hint). Note that
 * saveDeck does NOT call this helper; it applies its own conditional
 * normalization (silently reconciling only an unchanged stale echo) before
 * validation.
 */
function pinLockedPrompts(spec: SimulatorSpec, deck: readonly DeckCard[]): DeckCard[] {
  const slotsById = new Map(spec.speciesSlots.map((slot) => [slot.slotId, slot]));
  return deck.map((card) => {
    const slot = slotsById.get(card.slotId);
    return slot?.locked ? { ...card, prompt: slot.starterHint ?? "" } : card;
  });
}

export function reconcileDeckForSpec(spec: SimulatorSpec, deck: readonly DeckCard[]): DeckCard[] {
  const existingBySlot = new Map(deck.map((card) => [card.slotId, card]));
  const reconciled = spec.speciesSlots.map((slot) => {
    const existing = existingBySlot.get(slot.slotId);
    return {
      slotId: slot.slotId,
      count: existing
        ? Math.min(slot.countMax, Math.max(slot.countMin, existing.count))
        : slot.defaultCount,
      // A LOCKED slot's card is always pinned to the authored starterHint —
      // even across a spec fork that carried a different (or scholar-edited)
      // prompt forward, so a locked deck never resurfaces stale/rewritten text.
      prompt: slot.locked ? (slot.starterHint ?? "") : (existing?.prompt ?? slot.starterHint ?? ""),
      countMin: slot.countMin,
      countMax: slot.countMax,
    };
  });

  const capacity =
    spec.templateId === "ecosystemGrid"
      ? Math.min(
          spec.config.maxAutomata,
          MAX_AUTOMATA_COMPILED_RUN,
          spec.config.width * spec.config.height,
        )
      : Math.min(spec.config.maxAutomata, MAX_AUTOMATA_COMPILED_RUN);
  const minimumTotal = reconciled.reduce((total, card) => total + card.countMin, 0);
  if (minimumTotal > capacity) {
    throw new Error("This world is too small for its species");
  }
  let excess =
    reconciled.reduce((total, card) => total + card.count, 0) - capacity;
  for (let index = reconciled.length - 1; index >= 0 && excess > 0; index -= 1) {
    const card = reconciled[index];
    const reduction = Math.min(excess, card.count - card.countMin);
    card.count -= reduction;
    excess -= reduction;
  }

  if (spec.templateId === "prisonersDilemma") {
    let deficit =
      spec.config.maxAutomata - reconciled.reduce((total, card) => total + card.count, 0);
    for (const card of reconciled) {
      if (deficit <= 0) break;
      const increase = Math.min(deficit, card.countMax - card.count);
      card.count += increase;
      deficit -= increase;
    }
  }

  const result = reconciled.map(({ slotId, count, prompt }) => ({ slotId, count, prompt }));
  validateDeckForSpec(spec, result);
  return result;
}

export const ensureBench = authedMutation({
  args: { sessionId: v.id("sessions") },
  handler: async (ctx, args) => {
    const { session, spec, bench: existing } = await simulatorSession(ctx, args.sessionId);
    if (session.userId !== ctx.user._id) throw new Error("Only the scholar can open this Workbench");
    if (existing) {
      await schedulePolicyCompiles(ctx, {
        spec,
        deck: existing.deck,
        deckHash: existing.deckHash,
      });
      return { benchId: existing._id };
    }
    const deck = defaultDeckForSpec(spec);
    validateDeckForSpec(spec, deck);
    const now = Date.now();
    const initialDeckHash = await deckHash(deck);
    const benchId = await ctx.db.insert("simulatorBenches", {
      sessionId: session._id,
      scholarId: session.userId,
      activityId: session.activityId!,
      assignmentId: session.assignmentId,
      deck,
      deckVersion: 1,
      deckHash: initialDeckHash,
      runGrants: [],
      lastBenchActivityAt: now,
      createdAt: now,
      updatedAt: now,
    });
    await schedulePolicyCompiles(ctx, {
      spec,
      deck,
      deckHash: initialDeckHash,
    });

    return { benchId };
  },
});

// Backward-compatible endpoint for Stage B callers. `ensureBench` is the
// canonical UI contract: get-or-create one aggregate keyed by session.
export const ensureForSession = ensureBench;

export const getBench = authedQuery({
  args: { sessionId: v.id("sessions") },
  handler: async (ctx, args) => {
    const session = await ctx.db.get(args.sessionId);
    if (!session || !mayReadSession(ctx.user, session)) return null;
    if (session.sessionMode !== "workbench" || !session.activityId) return null;
    const activity = await ctx.db.get(session.activityId);
    if (!activity) return null;
    const bench = await ctx.db
      .query("simulatorBenches")
      .withIndex("by_session", (query) => query.eq("sessionId", args.sessionId))
      .unique();
    if (!bench) return null;
    const resolved = resolveBenchSimulator(activity, bench);
    if (!resolved) return null;
    const { spec, template } = resolved;
    const runs = await ctx.db
      .query("simulatorRuns")
      .withIndex("by_session", (query) => query.eq("sessionId", args.sessionId))
      .collect();
    const completedScholarRun = runs.find(isPredictionEvidenceRun);
    const { benchRuns, bestScore, latestOutcome } = summarizeBenchRuns(spec, runs);
    const compiledPolicies =
      spec.interpreter.kind === "scripted"
        ? await Promise.all(
            bench.deck.map(async (card) => {
              const slot = spec.speciesSlots.find(
                (candidate) => candidate.slotId === card.slotId,
              );
              if (!slot) throw new Error(`Unknown Species slot "${card.slotId}"`);
              const compileContextHash = await policyCompileContextHash({
                templateId: spec.templateId,
                templateVersion: spec.templateVersion,
                slotId: card.slotId,
                senses: slot.senses,
                actionSchema: template.actionSchema,
              });
              const policy = await ctx.db
                .query("compiledPolicies")
                .withIndex("by_deck_slot_context", (query) =>
                  query
                    .eq("deckHash", bench.deckHash)
                    .eq("slotId", card.slotId)
                    .eq("compileContextHash", compileContextHash),
                )
                .unique();
              return {
                slotId: card.slotId,
                status: policy?.status ?? ("compiling" as const),
                policyHash: policy?.policyHash ?? null,
                errorMessage: policy?.errorMessage ?? null,
              };
            }),
          )
        : [];
    return {
      benchId: bench._id,
      sessionId: bench.sessionId,
      activityId: bench.activityId,
      title: activity.title,
      // Scholar-facing bench payload — scholar copy only.
      description: activity.scholarDescription,
      emoji: ACTIVITY_KIND.simulator.emoji,
      simulatorSpec: spec,
      // worldBenches.getBench is a thin alias for this endpoint until the next
      // fleet release, so keep its released response contract intact.
      worldSpec: spec,
      specVersion: bench.specVersion ?? 0,
      specForkedAt: bench.specForkedAt ?? null,
      forkInvalid: resolved.forkInvalid,
      // Read-time reconciliation only (never persisted here): a teacher may
      // have locked a slot, or edited a locked slot's hint, since this deck
      // was last saved. Pin locked cards to the LIVE spec's starterHint so a
      // client's next save always echoes the current authored text instead
      // of resubmitting stale prompt content it never wrote itself.
      deck: pinLockedPrompts(spec, bench.deck),
      deckVersion: bench.deckVersion,
      compiledPolicies,
      bestScore,
      latestOutcome,
      runCount: benchRuns.length,
      hasCompletedRun: Boolean(completedScholarRun && isPredictionEvidenceRun(completedScholarRun)),
      lastBenchActivityAt: bench.lastBenchActivityAt,
    };
  },
});

export const saveDeck = authedMutation({
  args: {
    sessionId: v.id("sessions"),
    expectedDeckVersion: v.number(),
    deck: v.array(deckCardArg),
  },
  handler: async (ctx, args) => {
    const bench = await ctx.db
      .query("simulatorBenches")
      .withIndex("by_session", (query) => query.eq("sessionId", args.sessionId))
      .unique();
    const { session, spec } = await simulatorSession(ctx, args.sessionId, bench);
    if (session.userId !== ctx.user._id) throw new Error("Only the scholar can edit this prompt deck");
    if (!bench) throw new Error("Workbench has not been opened");
    if (bench.deckVersion !== args.expectedDeckVersion) {
      throw new Error(`Prompt deck changed (expected v${args.expectedDeckVersion}, found v${bench.deckVersion})`);
    }
    // A teacher may have locked a slot (or edited its authored hint) since
    // this deck was last read. If the submitted card for a locked slot is
    // UNCHANGED from what's already persisted, it's a stale echo (e.g. a
    // count-only save built from a client that hasn't re-subscribed yet),
    // not a real edit attempt — silently reconcile it to the live
    // starterHint so the save still goes through. A submitted prompt that
    // DIFFERS from what's persisted is a genuine local edit attempt; leave
    // it alone so validateDeckForSpec below still rejects it legibly.
    const priorPromptBySlot = new Map(bench.deck.map((card) => [card.slotId, card.prompt]));
    const slotsById = new Map(spec.speciesSlots.map((slot) => [slot.slotId, slot]));
    const deck = args.deck.map((card) => {
      const slot = slotsById.get(card.slotId);
      if (!slot?.locked) return card;
      const hint = slot.starterHint ?? "";
      const priorPrompt = priorPromptBySlot.get(card.slotId) ?? hint;
      return card.prompt === priorPrompt ? { ...card, prompt: hint } : card;
    });
    validateDeckForSpec(spec, deck);
    const now = Date.now();
    const nextVersion = bench.deckVersion + 1;
    const nextHash = await deckHash(deck);
    await ctx.db.patch(bench._id, {
      deck,
      deckVersion: nextVersion,
      deckHash: nextHash,
      lastBenchActivityAt: now,
      updatedAt: now,
    });
    await schedulePolicyCompiles(ctx, {
      spec,
      deck,
      deckHash: nextHash,
    });
    return { deckVersion: nextVersion, deckHash: nextHash };
  },
});

export async function updateBenchSpecCore(
  ctx: MutationCtx,
  args: {
    session: Doc<"sessions">;
    caller: Doc<"users">;
    submittedSpec: SimulatorSpec;
    allowCriterionChange: boolean;
    authorization: "owner" | "owner_or_assignment_staff";
    acceptPromptLoss?: boolean;
  },
) {
  const {
    session,
    caller,
    submittedSpec,
    allowCriterionChange,
    authorization,
    acceptPromptLoss,
  } = args;
  if (session.sessionMode !== "workbench" || !session.activityId) {
    throw new Error("Session is not a Simulator Workbench");
  }
  const activity = await ctx.db.get(session.activityId);
  if (!activity || activity.kind !== "simulator") {
    throw new Error("Workbench activity has no valid Simulator");
  }
  const assignment = session.assignmentId
    ? await ctx.db.get(session.assignmentId)
    : null;
  if (session.assignmentId && !assignment) {
    throw new Error("Assignment not found");
  }
  const isOwner = session.userId === caller._id;
  if (authorization === "owner") {
    if (!isOwner) {
      throw new Error("Only the session owner can edit this Workbench");
    }
  } else {
    const isAssignmentTeacher = assignment?.teacherId === caller._id;
    let isScopedSchoolAdmin = false;
    if (isSchoolAdminRole(caller.role)) {
      const scholar = await ctx.db.get(session.userId);
      if (scholar?.institutionId) {
        const memberships = await ctx.db
          .query("memberships")
          .withIndex("by_user", (query) => query.eq("userId", caller._id))
          .collect();
        isScopedSchoolAdmin = memberships.some(
          (membership) =>
            membership.role === "school_admin" &&
            membership.institutionId === scholar.institutionId,
        );
      }
    }
    const isAdmin =
      isPlatformAdminRole(caller.role) || isScopedSchoolAdmin;
    if (!isOwner && !isAssignmentTeacher && !isAdmin) {
      throw new Error(
        "Only the session owner or assignment teacher can edit this Workbench",
      );
    }
  }
  const bench = await ctx.db
    .query("simulatorBenches")
    .withIndex("by_session", (query) => query.eq("sessionId", session._id))
    .unique();
  if (!bench) throw new Error("Workbench has not been opened");

  const current = resolveBenchSimulator(activity, bench);
  if (!current) throw new Error("Workbench activity has no valid Simulator");
  if (submittedSpec.templateId !== current.spec.templateId) {
    throw new Error(
      "A Workbench cannot change Simulator templates after it has been opened",
    );
  }
  const currentSlotById = new Map(
    current.spec.speciesSlots.map((slot) => [slot.slotId, slot]),
  );
  // A non-staff caller (the scholar, or the sideline tutor's update_world
  // tool acting on the scholar's behalf) can fork most of a retained Species
  // slot, but never its LOCKED flag or — for an already-locked slot — its
  // authored starterHint. Explicitly trying to unlock a locked slot gets a
  // legible rejection; any other locked/starterHint drift (e.g. a stale
  // resubmission, or an attempt to self-lock a slot) is silently restored to
  // the authored value, mirroring the criterion/interpreter guard below.
  let speciesSlots = submittedSpec.speciesSlots;
  if (!allowCriterionChange) {
    const submittedSlotIds = new Set(speciesSlots.map((slot) => slot.slotId));
    for (const authored of current.spec.speciesSlots) {
      if (authored.locked && !submittedSlotIds.has(authored.slotId)) {
        throw new Error(
          `The "${authored.label}" Species slot is locked by your teacher and can't be removed`,
        );
      }
    }
    for (const slot of speciesSlots) {
      const authored = currentSlotById.get(slot.slotId);
      if (authored?.locked === true && slot.locked === false) {
        throw new Error(
          `The "${authored.label}" Species slot is locked by your teacher and can't be unlocked`,
        );
      }
    }
    speciesSlots = speciesSlots.map((slot) => {
      const authored = currentSlotById.get(slot.slotId);
      if (!authored) return slot;
      const authoredLocked = authored.locked === true;
      const submittedLocked = slot.locked === true;
      if (
        submittedLocked === authoredLocked &&
        (!authoredLocked || slot.starterHint === authored.starterHint)
      ) {
        return slot;
      }
      return {
        ...slot,
        locked: authored.locked,
        starterHint: authoredLocked ? authored.starterHint : slot.starterHint,
      };
    });
  }
  const criterionChanged =
    canonicalJson(submittedSpec.criterion) !==
    canonicalJson(current.spec.criterion);
  const spec = (allowCriterionChange
    ? { ...submittedSpec, speciesSlots }
    : {
        ...submittedSpec,
        criterion: current.spec.criterion,
        interpreter: current.spec.interpreter,
        speciesSlots,
      }) as SimulatorSpec;
  const template = getSimulatorTemplate(spec?.templateId);
  if (!template) throw new Error(`Unknown Simulator template "${spec?.templateId}"`);
  template.validateSpec(spec);
  const retainedSlotIds = new Set(
    spec.speciesSlots.map((slot) => slot.slotId),
  );
  const promptLossSlots = bench.deck
    .filter((card) => {
      if (retainedSlotIds.has(card.slotId) || card.prompt.length === 0) {
        return false;
      }
      return (
        card.prompt !==
        (currentSlotById.get(card.slotId)?.starterHint ?? "")
      );
    })
    .map((card) => card.slotId);
  if (promptLossSlots.length > 0 && !acceptPromptLoss) {
    throw new Error(
      `This edit would discard scholar prompts from slots: ${promptLossSlots.join(", ")}. ` +
        "Retry with acceptPromptLoss to confirm.",
    );
  }
  const deck = reconcileDeckForSpec(spec, bench.deck);
  const now = Date.now();
  const specForkedAt = bench.specForkedAt ?? now;
  const specVersion = (bench.specVersion ?? 0) + 1;
  const deckVersion = bench.deckVersion + 1;
  const nextDeckHash = await deckHash(deck);
  await ctx.db.patch(bench._id, {
    effectiveSpec: simulatorSpecForStorage(spec),
    specVersion,
    specForkedAt,
    deck,
    deckVersion,
    deckHash: nextDeckHash,
    lastBenchActivityAt: now,
    updatedAt: now,
  });
  await schedulePolicyCompiles(ctx, {
    spec,
    deck,
    deckHash: nextDeckHash,
  });
  return {
    specVersion,
    deckVersion,
    deckHash: nextDeckHash,
    specForkedAt,
    criterionLocked: !allowCriterionChange && criterionChanged,
  };
}

export const updateBenchSpec = authedMutation({
  args: {
    sessionId: v.id("sessions"),
    spec: simulatorSpecValidator,
    acceptPromptLoss: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const session = await ctx.db.get(args.sessionId);
    if (!session) throw new Error("Session not found");
    return await updateBenchSpecCore(ctx, {
      session,
      caller: ctx.user,
      submittedSpec: args.spec as SimulatorSpec,
      allowCriterionChange: isTeacherRole(ctx.user.role),
      authorization: "owner_or_assignment_staff",
      acceptPromptLoss: args.acceptPromptLoss,
    });
  },
});

/**
 * Owner add-species: append one Species slot to the bench's effective spec. A
 * bounded, owner-allowed roster edit — the criterion stays LOCKED (the caller is
 * the scholar, not a teacher, so `updateBenchSpecCore` forces the existing
 * criterion), and the deck reconcile adds the new slot's card. Only templates
 * with an open roster below the ecosystem ceiling accept this (see canAddSpeciesSlot).
 */
export const addSpeciesToBench = authedMutation({
  args: { sessionId: v.id("sessions") },
  handler: async (ctx, args) => {
    const session = await ctx.db.get(args.sessionId);
    if (!session) throw new Error("Session not found");
    if (session.sessionMode !== "workbench" || !session.activityId) {
      throw new Error("Session is not a Simulator Workbench");
    }
    const activity = await ctx.db.get(session.activityId);
    if (!activity || activity.kind !== "simulator") {
      throw new Error("Workbench activity has no valid Simulator");
    }
    const bench = await ctx.db
      .query("simulatorBenches")
      .withIndex("by_session", (query) => query.eq("sessionId", session._id))
      .unique();
    if (!bench) throw new Error("Workbench has not been opened");
    const current = resolveBenchSimulator(activity, bench);
    if (!current) throw new Error("Workbench activity has no valid Simulator");
    if (!canAddSpeciesSlot(current.spec)) {
      throw new Error("This Simulator's Species roster can't grow");
    }
    return await updateBenchSpecCore(ctx, {
      session,
      caller: ctx.user,
      submittedSpec: appendDefaultSpeciesSlot(current.spec),
      allowCriterionChange: false,
      authorization: "owner",
    });
  },
});

/**
 * Owner remove-species: remove an unlocked ecosystem slot and its deck card.
 * The shared fork core keeps the criterion/interpreter frozen for the scholar,
 * rejects prompt loss until explicitly confirmed, reconciles the deck, and
 * advances the spec and deck versions in one mutation.
 */
export const removeSpeciesFromBench = authedMutation({
  args: {
    sessionId: v.id("sessions"),
    slotId: v.string(),
    acceptPromptLoss: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const session = await ctx.db.get(args.sessionId);
    if (!session) throw new Error("Session not found");
    if (session.userId !== ctx.user._id) {
      throw new Error("Only the session owner can edit this Workbench");
    }
    if (session.sessionMode !== "workbench" || !session.activityId) {
      throw new Error("Session is not a Simulator Workbench");
    }
    const activity = await ctx.db.get(session.activityId);
    if (!activity || activity.kind !== "simulator") {
      throw new Error("Workbench activity has no valid Simulator");
    }
    const bench = await ctx.db
      .query("simulatorBenches")
      .withIndex("by_session", (query) => query.eq("sessionId", session._id))
      .unique();
    if (!bench) throw new Error("Workbench has not been opened");
    const current = resolveBenchSimulator(activity, bench);
    if (!current) throw new Error("Workbench activity has no valid Simulator");
    if (current.spec.templateId !== "ecosystemGrid") {
      throw new Error("Only ecosystem Simulators can remove Species");
    }
    const slot = current.spec.speciesSlots.find((candidate) => candidate.slotId === args.slotId);
    if (!slot) throw new Error(`Unknown Species slot "${args.slotId}"`);
    if (slot.locked) {
      throw new Error(`The "${slot.label}" Species slot is locked by your teacher and can't be removed`);
    }
    if (current.spec.speciesSlots.length <= 1) {
      throw new Error("An ecosystem needs at least one Species");
    }
    if (slot.countMin > 0) {
      throw new Error(
        `Your teacher requires at least ${slot.countMin} ${slot.label} in this ecosystem`,
      );
    }

    const terrain = current.spec.config.terrain;
    const submittedSpec: SimulatorSpec = {
      ...current.spec,
      speciesSlots: current.spec.speciesSlots.filter((candidate) => candidate.slotId !== slot.slotId),
      config: terrain
        ? {
            ...current.spec.config,
            terrain: {
              ...terrain,
              predatorSlotIds: terrain.predatorSlotIds.filter(
                (predatorSlotId) => predatorSlotId !== slot.slotId,
              ),
            },
          }
        : current.spec.config,
    };

    return await updateBenchSpecCore(ctx, {
      session,
      caller: ctx.user,
      submittedSpec,
      allowCriterionChange: false,
      authorization: "owner",
      acceptPromptLoss: args.acceptPromptLoss,
    });
  },
});

export const getWorkbenchForTutor = internalQuery({
  args: {
    sessionId: v.id("sessions"),
    userId: v.id("users"),
  },
  handler: async (ctx, args) => {
    const session = await ctx.db.get(args.sessionId);
    if (!session || session.userId !== args.userId) {
      throw new Error("Only the session owner can view this Workbench");
    }
    const { bench, spec, forkInvalid } = await simulatorSession(
      ctx,
      args.sessionId,
    );
    if (!bench) throw new Error("Workbench has not been opened");
    const runs = await ctx.db
      .query("simulatorRuns")
      .withIndex("by_session", (query) => query.eq("sessionId", args.sessionId))
      .collect();
    const assignment = session.assignmentId
      ? await ctx.db.get(session.assignmentId)
      : null;
    const { benchRuns, bestScore, latestOutcome } = summarizeBenchRuns(spec, runs);
    const resolvedDeck = reconcileDeckForSpec(spec, bench.deck);
    const deckBySlot = new Map(
      resolvedDeck.map((card) => [card.slotId, card]),
    );

    return {
      template: {
        id: spec.templateId,
        label: templateLabel(spec.templateId),
      },
      editableSpec: {
        templateId: spec.templateId,
        config: spec.config,
        speciesSlots: spec.speciesSlots,
        criterion: spec.criterion,
        tickBudget: spec.tickBudget,
        microWorld: spec.microWorld,
      },
      speciesSlots: spec.speciesSlots.map((slot) => ({
        slotId: slot.slotId,
        label: slot.label,
        countRange: {
          min: slot.countMin,
          default: slot.defaultCount,
          max: slot.countMax,
        },
        senses: slot.senses,
      })),
      configHighlights: spec.config,
      criterion: {
        sentence: criterionSentence(spec),
        spec: spec.criterion,
      },
      fork: {
        specVersion: bench.specVersion ?? 0,
        specForkedAt: bench.specForkedAt ?? null,
        forkedFromActivity: bench.effectiveSpec !== undefined,
        forkInvalid,
      },
      deck: {
        version: bench.deckVersion,
        slots: spec.speciesSlots.map((slot) => {
          const card = deckBySlot.get(slot.slotId);
          if (!card) {
            throw new Error(`Prompt deck is missing Species slot "${slot.slotId}"`);
          }
          return {
            slotId: slot.slotId,
            label: slot.label,
            count: card.count,
            hasPrompt: card.prompt.trim().length > 0,
            prompt: card.prompt,
          };
        }),
      },
      runs: {
        count: benchRuns.length,
        bestScore,
        latestOutcome,
      },
      remainingRunGrants: remainingRunGrants(bench, assignment, runs),
    };
  },
});

export const updateBenchSpecForTutor = internalMutation({
  args: {
    sessionId: v.id("sessions"),
    userId: v.id("users"),
    spec: simulatorSpecValidator,
  },
  handler: async (ctx, args) => {
    const session = await ctx.db.get(args.sessionId);
    const caller = await ctx.db.get(args.userId);
    if (!session || !caller || session.userId !== caller._id) {
      throw new Error("Only the session owner can edit this Workbench");
    }
    return await updateBenchSpecCore(ctx, {
      session,
      caller,
      submittedSpec: args.spec as SimulatorSpec,
      allowCriterionChange: false,
      authorization: "owner",
    });
  },
});

export async function appendNotebookEntry(
  ctx: MutationCtx,
  input: { sessionId: Id<"sessions">; entry: NotebookEntry },
) {
  const text =
    input.entry.kind === "hypothesis"
      ? input.entry.prediction.note ?? input.entry.prediction.prediction
      : input.entry.kind === "run_marker"
        ? `deck v${input.entry.deckVersion}`
        : input.entry.text;
  if (text.length > MAX_NOTEBOOK_ENTRY_CHARS) {
    throw new Error(`Notebook entry exceeds ${MAX_NOTEBOOK_ENTRY_CHARS} characters`);
  }
  const messageId = await ctx.db.insert("messages", {
    sessionId: input.sessionId,
    role: "user",
    content: `[Notebook ${input.entry.kind}] ${text}`,
    notebookEntry: input.entry,
    flagged: false,
  });
  const bench = await ctx.db
    .query("simulatorBenches")
    .withIndex("by_session", (query) => query.eq("sessionId", input.sessionId))
    .unique();
  if (bench) {
    const now = Date.now();
    await ctx.db.patch(bench._id, { lastBenchActivityAt: now, updatedAt: now });
  }
  return { entryId: messageId, messageId };
}

export const appendNotebook = authedMutation({
  args: { sessionId: v.id("sessions"), entry: publicNotebookEntryArg },
  handler: async (ctx, args) => {
    const { session } = await simulatorSession(ctx, args.sessionId);
    if (session.userId !== ctx.user._id) throw new Error("Only the scholar can write this Notebook");
    const runIds =
      args.entry.kind === "conclusion" ? args.entry.runIds : [];
    for (const runId of runIds) {
      const run = await ctx.db.get(runId);
      if (!run || run.sessionId !== session._id) throw new Error("Notebook run does not belong to this bench");
    }
    return await appendNotebookEntry(ctx, { sessionId: session._id, entry: args.entry });
  },
});

export const listNotebook = authedQuery({
  args: { sessionId: v.id("sessions") },
  handler: async (ctx, args) => {
    const { session } = await simulatorSession(ctx, args.sessionId);
    if (!mayReadSession(ctx.user, session)) throw new Error("Not authorized to read this Notebook");
    const messages = await ctx.db
      .query("messages")
      .withIndex("by_session", (query) => query.eq("sessionId", args.sessionId))
      .collect();
    return messages
      .filter((message) => message.notebookEntry !== undefined)
      .map((message) => ({
        entryId: message._id,
        role: message.role,
        entry: message.notebookEntry!,
        createdAt: message._creationTime,
      }));
  },
});

export const grantRuns = teacherMutation({
  args: {
    sessionId: v.id("sessions"),
    scope: v.union(v.literal("block"), v.literal("week")),
    windowKey: v.string(),
    count: v.number(),
  },
  handler: async (ctx, args) => {
    if (!Number.isInteger(args.count) || args.count < 1 || args.count > 100) {
      throw new Error("Run grant count must be an integer from 1 through 100");
    }
    const { session } = await simulatorSession(ctx, args.sessionId);
    if (!session.assignmentId) throw new Error("Run grants require an assignment");
    const assignment = await ctx.db.get(session.assignmentId);
    if (!assignment) throw new Error("Assignment not found");
    if (assignment.teacherId !== ctx.user._id && ctx.user.role !== "platform_admin") {
      throw new Error("Only the assignment teacher can grant runs");
    }
    const bench = await ctx.db
      .query("simulatorBenches")
      .withIndex("by_session", (query) => query.eq("sessionId", args.sessionId))
      .unique();
    if (!bench) throw new Error("Workbench has not been opened");
    const retained = bench.runGrants
      .filter((grant) => !(grant.scope === args.scope && grant.windowKey === args.windowKey))
      .slice(-(MAX_RUN_GRANTS_PER_BENCH - 1));
    const previous = bench.runGrants.find(
      (grant) => grant.scope === args.scope && grant.windowKey === args.windowKey,
    );
    const granted = (previous?.count ?? 0) + args.count;
    const now = Date.now();
    await ctx.db.patch(bench._id, {
      runGrants: [
        ...retained,
        {
          scope: args.scope,
          windowKey: args.windowKey,
          count: granted,
          grantedBy: ctx.user._id,
          grantedAt: now,
        },
      ],
      updatedAt: now,
    });
    return { granted };
  },
});
