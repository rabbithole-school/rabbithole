/**
 * Self-improving curricula — experiment lifecycle (default runtime).
 *
 * Teacher-facing kickoff + reactive progress/results queries for the
 * "Auto-improve this activity" loop, plus the internal helpers the
 * "use node" orchestrator (convex/curriculumSim.ts) calls back into to
 * persist sessions and finalize. Phase 1 = "analyze": simulate a cast
 * through the activity, judge, report — no edits. See
 * review/self-improving-curricula-plan.md.
 *
 * Gating: every teacher-facing entry point runs requireUnitEditAccess on
 * the activity's unit (same gate as activities.update), so only the
 * curriculum owner/staff can run or read an experiment. The tutor prompt
 * is assembled here via the PRODUCTION buildSystemPrompt so the sim
 * improves what actually ships; the node action only makes the Anthropic
 * calls.
 */
import { v } from "convex/values";
import type { ActivityKind } from "../lib/activityKinds";
import { authedMutation, authedQuery } from "./lib/customFunctions";
import { internalMutation, internalQuery } from "./_generated/server";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { requireUnitEditAccess } from "./lib/auth";
import {
  resolveActivityScopedContext,
  type ActivityResourceContext,
  type AdvanceRubricContext,
  type ConversationCompletionContext,
  type LessonActivityContext,
  type LessonContext,
  type StandaloneDeliverableContext,
  type UnitContext,
} from "./sessionHelpers";
import {
  buildTutorSystemPrompt,
  type TutorPromptContext,
} from "./sessionStreamHelpers";
import { DEFAULT_CAST } from "./lib/curriculumSimShared";
import { preflightResultValidator } from "./lib/curriculumPreflightResult";
import { meanProbe } from "./lib/curriculumProbe";
import { MAX_TURNS, turnsForMinutes } from "./lib/rehearsalBudget";
import { serializeUnitDesign } from "./lib/unitDesignSerializer";

// ─── Tutor prompt assembly (production builder) ──────────────────────

type ActivityMeta = {
  title: string;
  kind: ActivityKind;
  systemPrompt: string | null;
  learningGoal: string;
  deliverablePrompt: string | null;
  durationMinutes: number | null;
  unitDesign: string;
  unitContext: UnitContext | null;
  lessonContext: LessonContext | null;
  lessonActivityContext: LessonActivityContext | null;
  activityResourceContext: ActivityResourceContext[] | null;
  standaloneDeliverableContext: StandaloneDeliverableContext | null;
  advanceRubricContext: AdvanceRubricContext | null;
  conversationCompletionContext: ConversationCompletionContext | null;
  // Candidate target skills for the OUTCOME PROBE (adoptable #1). Resolved from
  // the activity's problemSet?.targetSkillKeys first, else its probeSkillKeys,
  // else []. The orchestrator filters these to the ones with a deterministic
  // template and skips the probe gracefully when none resolve.
  probeSkillKeys: string[];
};

/**
 * Assemble the production tutor system prompt for one synthetic scholar ×
 * the activity under test. Rehearse intentionally has no tutor tools, so its
 * capability flags keep the shared context informative without promising
 * resource-sharing, rubric, or completion mechanics the runtime cannot execute.
 */
function assembleTutorPrompt(
  profile: Pick<Doc<"syntheticScholarProfiles">, "readingLevel" | "name" | "dossier">,
  activity: ActivityMeta,
  isFirstTurn: boolean,
): string {
  const promptContext: TutorPromptContext = {
    teacherWhisper: null,
    readingLevel: profile.readingLevel,
    scholarName: profile.name,
    unitContext: activity.unitContext,
    personaContext: null,
    perspectiveContext: null,
    processContext: null,
    processStateData: null,
    artifactData: null,
    appStateContext: null,
    dossierContent: profile.dossier,
    documentNotes: null,
    seeds: [],
    masteryContext: null,
    signalContext: null,
    timingContext: null,
    lessonContext: activity.lessonContext,
    teacherDirectives: [],
    goals: [],
    weeklyGoals: [],
    lessonActivityContext: activity.lessonActivityContext,
    activityResourceContext: activity.activityResourceContext,
    priorActivityContext: null,
    gameRoundContexts: null,
    activityContext: null,
    standaloneDeliverableContext: activity.standaloneDeliverableContext,
    currentVerdictsContext: null,
    advanceRubricContext: activity.advanceRubricContext,
    conversationCompletionContext: activity.conversationCompletionContext,
    practiceSkillsContext: null,
    isFirstTurn,
    isFirstSession: true,
    lastSessionAt: null,
    webPracticeContext: null,
    granuleStatusContext: null,
    activityRecipe: activity.lessonActivityContext?.recipe ?? null,
    baselineEvidenceContext: null,
    seedOriginContext: null,
    physicalEnvironmentContext: null,
    runtimeCapabilities: {
      canShareResources: false,
      canScoreRubrics: false,
      canMarkActivityComplete: false,
    },
  };
  return buildTutorSystemPrompt(promptContext);
}

async function resolveActivityMeta(
  ctx: QueryCtx,
  activity: Doc<"activities">,
  systemPrompt: string | null,
  learningGoal: string,
): Promise<ActivityMeta> {
  const scoped = await resolveActivityScopedContext(ctx, {
    activityId: activity._id,
    activitySystemPrompt: systemPrompt,
  });
  return {
    title: activity.title,
    kind: activity.kind,
    systemPrompt,
    learningGoal,
    deliverablePrompt: activity.deliverable?.prompt ?? null,
    durationMinutes: activity.durationMinutes ?? null,
    unitDesign: await serializeUnitDesign(ctx, activity, systemPrompt),
    probeSkillKeys:
      activity.problemSet?.targetSkillKeys ?? activity.probeSkillKeys ?? [],
    unitContext: scoped.unitContext,
    lessonContext: scoped.lessonContext,
    lessonActivityContext: scoped.lessonActivityContext,
    activityResourceContext: scoped.activityResourceContext,
    standaloneDeliverableContext: scoped.standaloneDeliverableContext,
    advanceRubricContext: scoped.advanceRubricContext,
    conversationCompletionContext: scoped.conversationCompletionContext,
  };
}

// ─── Default cast ────────────────────────────────────────────────────

/**
 * Resolve the owner's reusable copies of the DEFAULT_CAST, creating any
 * that don't exist yet (idempotent by owner+name). Used when a teacher
 * kicks off without picking a cast.
 */
async function ensureDefaultCast(
  ctx: MutationCtx,
  ownerId: Id<"users">,
): Promise<Id<"syntheticScholarProfiles">[]> {
  const existing = await ctx.db
    .query("syntheticScholarProfiles")
    .withIndex("by_owner", (q) => q.eq("ownerId", ownerId))
    .collect();
  const ids: Id<"syntheticScholarProfiles">[] = [];
  for (const member of DEFAULT_CAST) {
    const match = existing.find((p) => p.name === member.name);
    if (match) {
      ids.push(match._id);
    } else {
      ids.push(
        await ctx.db.insert("syntheticScholarProfiles", {
          ownerId,
          name: member.name,
          readingLevel: member.readingLevel,
          dossier: member.dossier,
          traits: member.traits,
          archetype: member.archetype,
          misconception: member.misconception,
        }),
      );
    }
  }
  return ids;
}

function simRehearsalUnavailableMessage(
  activity: Pick<Doc<"activities">, "kind" | "title">,
): string {
  if (activity.kind === "vibecode") {
    return `Scholar-bot sims don't build apps yet — rehearse "${activity.title}" manually in the scholar workshop.`;
  }
  if (activity.kind === "simulator") {
    return `Simulator activities use their own Preflight instead of scholar-bot rehearsal.`;
  }
  return `Rehearse only runs on online activities (the kind with a tutor chat).`;
}

// ─── Kickoff ─────────────────────────────────────────────────────────

/**
 * The kickoff logic with the actor passed explicitly (no ctx.auth). Two
 * callers share it (the coreAide* pattern):
 *   - the public `start` mutation, which resolves identity + edit-access
 *     and passes user._id;
 *   - the `aideStartRehearsal` internal mutation, called from the
 *     Curriculum-Bot action where the caller is already verified.
 * Verifies the activity exists + supports scholar-bot sims and that any supplied cast is
 * owned by the actor; the unit-edit-access gate is the public caller's job
 * (the bot path gates by role at tool-assembly, like recordInternal).
 */
async function coreStart(
  ctx: MutationCtx,
  args: {
    activityId: Id<"activities">;
    teacherId: Id<"users">;
    mode?: "analyze" | "propose" | "loop";
    learningGoal?: string;
    maxTurns?: number;
    generations?: number;
    variantsPerGen?: number;
    castProfileIds?: Id<"syntheticScholarProfiles">[];
  },
): Promise<{ experimentId: Id<"curriculumExperiments"> }> {
  const activity = await ctx.db.get(args.activityId);
  if (!activity) throw new Error("Activity not found");
  if (activity.kind !== "online") {
    throw new Error(simRehearsalUnavailableMessage(activity));
  }

  const mode = args.mode ?? "analyze";

  // Resolve the cast.
  let castProfileIds = args.castProfileIds;
  if (!castProfileIds || castProfileIds.length === 0) {
    castProfileIds = await ensureDefaultCast(ctx, args.teacherId);
  } else {
    // Every supplied profile must be owned by the actor.
    for (const id of castProfileIds) {
      const p = await ctx.db.get(id);
      if (!p || p.ownerId !== args.teacherId) {
        throw new Error("Forbidden: synthetic profile not owned by you");
      }
    }
  }

  const derivedGoal = activity.deliverable?.prompt
    ? `Complete "${activity.title}": ${activity.deliverable.prompt}`
    : `Understand and work through "${activity.title}".`;
  const learningGoal = args.learningGoal?.trim() || derivedGoal;
  // Turn budget is DURATION-GROUNDED: by default a sim gets as many turns
  // as the activity's Duration allows (turnsForMinutes), so the rehearsal
  // asks "does this fit the time it was given?" rather than a flat cap the
  // sim kept running out of. An explicit `maxTurns` still overrides (tests /
  // power callers), clamped to the same ceiling. The budget is the loop
  // bound only — never injected into the prompt (no speed pressure; see
  // lib/rehearsalBudget.ts).
  const maxTurns =
    args.maxTurns != null
      ? Math.min(MAX_TURNS, Math.max(2, args.maxTurns))
      : turnsForMinutes(activity.durationMinutes);
  // Loop budget — clamped to keep cost bounded (Anthropic calls are
  // multiplicative; see the plan's "cost blowup" guard).
  const generations =
    mode === "loop"
      ? Math.min(Math.max(args.generations ?? 2, 1), 5)
      : undefined;
  const variantsPerGen =
    mode === "loop"
      ? Math.min(Math.max(args.variantsPerGen ?? 1, 1), 3)
      : undefined;

  // Estimate the total sessions for the progress bar:
  //  analyze  → 1 variant (baseline)
  //  propose  → 2 variants (baseline + 1 candidate)
  //  loop     → 1 + generations*variantsPerGen (worst case; may stop early)
  const variantCount =
    mode === "analyze"
      ? 1
      : mode === "propose"
        ? 2
        : 1 + (generations ?? 0) * (variantsPerGen ?? 0);
  const sessionsTotal = castProfileIds.length * variantCount;

  // Snapshot the current activity prompt as the baseline variant.
  const baselineVariantId = await ctx.db.insert("curriculumVariants", {
    activityId: args.activityId,
    generation: 0,
    systemPrompt: activity.systemPrompt ?? null,
    origin: "baseline",
    status: "candidate",
  });

  const experimentId = await ctx.db.insert("curriculumExperiments", {
    activityId: args.activityId,
    teacherId: args.teacherId,
    mode,
    config: {
      castProfileIds,
      maxTurns,
      learningGoal,
      generations,
      variantsPerGen,
    },
    status: "running",
    progress: { sessionsDone: 0, sessionsTotal },
    baselineVariantId,
    startedAt: Date.now(),
  });

  await ctx.db.patch(baselineVariantId, { experimentId });

  await ctx.scheduler.runAfter(0, internal.curriculumSim.runExperiment, {
    experimentId,
  });

  return { experimentId };
}

export const start = authedMutation({
  args: {
    activityId: v.id("activities"),
    // analyze (report, no edits) → propose (one AI edit) → loop (hill-climb).
    mode: v.optional(
      v.union(v.literal("analyze"), v.literal("propose"), v.literal("loop")),
    ),
    // Optional override of the learning goal the sim optimizes toward.
    learningGoal: v.optional(v.string()),
    maxTurns: v.optional(v.number()),
    // Loop-mode budget (ignored for analyze/propose).
    generations: v.optional(v.number()),
    variantsPerGen: v.optional(v.number()),
    // Optional explicit cast; defaults to the owner's DEFAULT_CAST copies.
    castProfileIds: v.optional(v.array(v.id("syntheticScholarProfiles"))),
  },
  handler: async (ctx, args) => {
    const { user } = await requireUnitEditAccess(ctx, {
      activityId: args.activityId,
    });
    return coreStart(ctx, { ...args, teacherId: user._id });
  },
});

export const cancel = authedMutation({
  args: { experimentId: v.id("curriculumExperiments") },
  handler: async (ctx, args) => {
    const exp = await ctx.db.get(args.experimentId);
    if (!exp) throw new Error("Experiment not found");
    await requireUnitEditAccess(ctx, { activityId: exp.activityId });
    if (exp.status === "running") {
      await ctx.db.patch(args.experimentId, {
        status: "cancelled",
        finishedAt: Date.now(),
      });
    }
    return { ok: true };
  },
});

/**
 * Promote a candidate variant to the LIVE activity — the teacher's approval of
 * an AI-proposed (or teacher-edited) diff. Same gate as activities.update;
 * writes the variant's systemPrompt onto the activity (mirroring the trim
 * semantics of activities.update), marks the variant `promoted`, and marks the
 * other still-`candidate` variants from the same experiment `rejected` for the
 * audit trail. Nothing here auto-runs — it's a human click. (The auto-promote-
 * on-dev path of Phase 3 routes through this same mutation with the gate.)
 */
export const promoteVariant = authedMutation({
  args: { variantId: v.id("curriculumVariants") },
  handler: async (ctx, args) => {
    const variant = await ctx.db.get(args.variantId);
    if (!variant) throw new Error("Variant not found");
    await requireUnitEditAccess(ctx, { activityId: variant.activityId });

    // Apply the variant's systemPrompt to the live activity (trim → undefined
    // when empty, exactly as activities.update does for systemPrompt).
    const trimmed = variant.systemPrompt?.trim() || undefined;
    await ctx.db.patch(variant.activityId, { systemPrompt: trimmed });

    await ctx.db.patch(args.variantId, { status: "promoted" });

    // Retire sibling candidates from the same experiment.
    if (variant.experimentId) {
      const siblings = await ctx.db
        .query("curriculumVariants")
        .withIndex("by_experiment", (q) =>
          q.eq("experimentId", variant.experimentId),
        )
        .collect();
      for (const s of siblings) {
        if (s._id !== args.variantId && s.status === "candidate") {
          await ctx.db.patch(s._id, { status: "rejected" });
        }
      }
    }
    return { ok: true };
  },
});

/**
 * Phase 4 — kick off sim-to-real calibration for a finished experiment: judge
 * the REAL transcripts on this activity with the same curriculum judge and
 * compare to the sim baseline. Teacher-gated; runs as a scheduled node action
 * (the judge is an Anthropic call). No-op-safe if there are no real transcripts
 * yet (the action records a "no real data" grounding).
 */
/**
 * Grounding (Debrief) kickoff with the access check left to the caller —
 * shared by the public `groundExperiment` and the `aideGroundLatest`
 * internal mutation (coreAide* pattern). Throws on the in-flight guards.
 */
async function coreGround(
  ctx: MutationCtx,
  experimentId: Id<"curriculumExperiments">,
): Promise<{ ok: true }> {
  const exp = await ctx.db.get(experimentId);
  if (!exp) throw new Error("Experiment not found");
  if (exp.status === "running") {
    throw new Error("Wait for the experiment to finish before grounding.");
  }
  // In-flight guard: a grounding run is an expensive Opus call ×many
  // transcripts. Repeated clicks would schedule overlapping runs that race.
  // Mark "running" before scheduling; recordGrounding overwrites the field
  // with a terminal status (done/no-data/error) on completion, clearing it.
  if (exp.grounding?.status === "running") {
    throw new Error("Grounding already running");
  }
  await ctx.db.patch(experimentId, {
    grounding: { status: "running", startedAt: Date.now() },
  });
  await ctx.scheduler.runAfter(0, internal.curriculumSim.runGrounding, {
    experimentId,
  });
  return { ok: true };
}

export const groundExperiment = authedMutation({
  args: { experimentId: v.id("curriculumExperiments") },
  handler: async (ctx, args) => {
    const exp = await ctx.db.get(args.experimentId);
    if (!exp) throw new Error("Experiment not found");
    await requireUnitEditAccess(ctx, { activityId: exp.activityId });
    return coreGround(ctx, args.experimentId);
  },
});

// ─── Curriculum-Bot aide tools (in-app Chat + Slack + MCP) ───────────
//
// The Curriculum Bot runs in an action with a VERIFIED callerUserId but no
// ctx.user, and the tool is only assembled for curriculum roles (see
// lib/aideTools.ts gating). These internal mutations trust callerUserId
// (like unitReviews.recordInternal) and resolve the activity by title
// within a unit the bot already named, then delegate to the shared cores.

/**
 * Resolve an activity by case-insensitive partial title within a unit.
 * Collects ALL title matches across the unit's lessons and PREFERS an
 * online one — so an offline activity whose title also matches (e.g. a
 * "… (worksheet)" sibling that sorts earlier) can't shadow the online
 * activity the rehearse/debrief caller actually means. Falls back to the
 * first match when no online match exists (so the caller still gets a
 * sensible "runs offline" / "no rehearsal yet" message).
 */
async function findActivityInUnit(
  ctx: MutationCtx,
  unitId: Id<"units">,
  activityTitle: string,
): Promise<Doc<"activities"> | null> {
  const lower = activityTitle.trim().toLowerCase();
  if (!lower) return null;
  const lessons = await ctx.db
    .query("lessons")
    .withIndex("by_unit", (q) => q.eq("unitId", unitId))
    .collect();
  const matches: Doc<"activities">[] = [];
  for (const lesson of lessons) {
    const acts = await ctx.db
      .query("activities")
      .withIndex("by_lesson", (q) => q.eq("lessonId", lesson._id))
      .collect();
    for (const a of acts) {
      if (a.title.toLowerCase().includes(lower)) matches.push(a);
    }
  }
  return matches.find((a) => a.kind === "online") ?? matches[0] ?? null;
}

/**
 * Count scholar "got this wrong" flags (messageFlags) across an activity's
 * real (non-test-drive, non-offline) sessions. Lets the Debrief kickoff tell
 * the teacher how much scholar feedback the grounding is about to weigh.
 *
 * Mirrors getGroundInput's session selection EXACTLY — same `hasScholar &&
 * hasTutor` gate and the same MAX_REAL_SESSIONS cap — so the number the
 * kickoff message states matches the `scholarFeedback.count` the grounding
 * later stores and the Debrief card renders. (messageFlags only ever sit on
 * assistant turns, so per-session `flags.length` == flagged judged turns.)
 */
async function countActivityScholarFlags(
  ctx: MutationCtx,
  activity: Doc<"activities">,
): Promise<number> {
  const lessonId = activity.lessonId;
  if (!lessonId) return 0;
  const sessions = await ctx.db
    .query("sessions")
    .withIndex("by_lesson", (q) => q.eq("lessonId", lessonId))
    .collect();
  let count = 0;
  let qualifying = 0;
  for (const p of sessions) {
    if (p.activityId !== activity._id) continue;
    if (p.isTestDrive || p.isOffline) continue;
    const msgs = await ctx.db
      .query("messages")
      .withIndex("by_session", (q) => q.eq("sessionId", p._id))
      .collect();
    const hasScholar = msgs.some((m) => m.role === "user");
    const hasTutor = msgs.some((m) => m.role === "assistant");
    if (!hasScholar || !hasTutor) continue;
    const flags = await ctx.db
      .query("messageFlags")
      .withIndex("by_session", (q) => q.eq("sessionId", p._id))
      .collect();
    count += flags.length;
    qualifying++;
    if (qualifying >= MAX_REAL_SESSIONS) break;
  }
  return count;
}

type AideResult =
  | {
      ok: true;
      message: string;
      activityDetails?: {
        id: Id<"activities">;
        title: string;
        kind: Doc<"activities">["kind"];
        systemPrompt: string | null;
        deliverable: Doc<"activities">["deliverable"] | null;
      };
    }
  | { ok: false; message: string };

export const aideStartRehearsal = internalMutation({
  args: {
    unitId: v.id("units"),
    activityTitle: v.string(),
    callerUserId: v.id("users"),
    // revise → propose a prompt edit alongside the run; else analyze only.
    // The bot never gets the multiplicative "loop" mode.
    revise: v.optional(v.boolean()),
  },
  handler: async (ctx, args): Promise<AideResult> => {
    const activity = await findActivityInUnit(ctx, args.unitId, args.activityTitle);
    if (!activity) {
      return {
        ok: false,
        message: `No activity matching "${args.activityTitle}" in this unit.`,
      };
    }
    if (activity.kind !== "online") {
      return {
        ok: false,
        message: simRehearsalUnavailableMessage(activity),
      };
    }
    const { experimentId } = await coreStart(ctx, {
      activityId: activity._id,
      teacherId: args.callerUserId,
      mode: args.revise ? "propose" : "analyze",
    });
    return {
      ok: true,
      message: `Started a ${args.revise ? "rehearse + revise" : "rehearse"} run on "${activity.title}". A set of sims is working through it now; results land in the activity's Rehearse tab. (experiment ${experimentId})`,
      activityDetails: {
        id: activity._id,
        title: activity.title,
        kind: activity.kind,
        systemPrompt: activity.systemPrompt ?? null,
        deliverable: activity.deliverable ?? null,
      },
    };
  },
});

export const aideGroundLatest = internalMutation({
  args: {
    unitId: v.id("units"),
    activityTitle: v.string(),
    callerUserId: v.id("users"),
  },
  handler: async (ctx, args): Promise<AideResult> => {
    const activity = await findActivityInUnit(ctx, args.unitId, args.activityTitle);
    if (!activity) {
      return {
        ok: false,
        message: `No activity matching "${args.activityTitle}" in this unit.`,
      };
    }
    // Debrief grounds the most recent SUCCESSFULLY-FINISHED rehearsal
    // (status "done") against real scholar transcripts. A cancelled/failed
    // latest run is skipped — grounding it would produce a "no-data"
    // result and silently target the wrong run; we ground the latest good
    // one instead. (Statuses: running | done | failed | cancelled.)
    const experiments = await ctx.db
      .query("curriculumExperiments")
      .withIndex("by_activity", (q) => q.eq("activityId", activity._id))
      .order("desc")
      .collect();
    const latestDone = experiments.find((e) => e.status === "done");
    if (!latestDone) {
      const anyRunning = experiments.some((e) => e.status === "running");
      return {
        ok: false,
        message: anyRunning
          ? `The rehearsal on "${activity.title}" is still running — wait for it to finish, then debrief.`
          : `No finished rehearsal to debrief on "${activity.title}" yet — run a Rehearse first.`,
      };
    }
    if (latestDone.grounding?.status === "running") {
      return { ok: false, message: `A debrief is already running on "${activity.title}".` };
    }
    await coreGround(ctx, latestDone._id);
    const flagCount = await countActivityScholarFlags(ctx, activity);
    const flagNote =
      flagCount > 0
        ? ` Heads up: scholars flagged ${flagCount} tutor response${
            flagCount === 1 ? "" : "s"
          } as wrong on this activity — the debrief weighs what they caught.`
        : "";
    return {
      ok: true,
      message: `Started a Debrief on "${activity.title}" — comparing the sim scorecards against real scholar transcripts.${flagNote} Results land in the activity's Rehearse tab.`,
    };
  },
});

// ─── Internal helpers for the node orchestrator ──────────────────────

/**
 * The run METADATA the node action needs (no per-variant tutor prompts — those
 * are assembled per candidate via assemblePromptsForVariant, since a propose/
 * loop run tests systemPrompts that differ from the baseline). `activity` here
 * carries the baseline systemPrompt as the gen-0 prompt under test.
 */
export const getRunInput = internalQuery({
  args: { experimentId: v.id("curriculumExperiments") },
  handler: async (ctx, args) => {
    const exp = await ctx.db.get(args.experimentId);
    if (!exp) throw new Error("Experiment not found");
    const activityDoc = await ctx.db.get(exp.activityId);
    if (!activityDoc) throw new Error("Activity not found");
    const baseline = exp.baselineVariantId
      ? await ctx.db.get(exp.baselineVariantId)
      : null;

    const systemPrompt =
      baseline?.systemPrompt ?? activityDoc.systemPrompt ?? null;
    const activity = {
      title: activityDoc.title,
      kind: activityDoc.kind,
      systemPrompt,
      learningGoal: exp.config.learningGoal,
      deliverablePrompt: activityDoc.deliverable?.prompt ?? null,
      durationMinutes: activityDoc.durationMinutes ?? null,
      unitDesign: await serializeUnitDesign(ctx, activityDoc, systemPrompt),
      probeSkillKeys:
        activityDoc.problemSet?.targetSkillKeys ??
        activityDoc.probeSkillKeys ??
        [],
    };

    const castMeta = [];
    for (const profileId of exp.config.castProfileIds) {
      const p = await ctx.db.get(profileId);
      if (!p) continue;
      castMeta.push({
        profileId: p._id,
        name: p.name,
        readingLevel: p.readingLevel,
        dossier: p.dossier,
        traits: p.traits,
        archetype: p.archetype ?? null,
        misconception: p.misconception ?? null,
      });
    }
    const expectedCastCount = exp.config.castProfileIds.length;
    const resolvedCastCount = castMeta.length;
    if (resolvedCastCount !== expectedCastCount) {
      console.warn(
        `curriculumExperiments: resolved ${resolvedCastCount} of ${expectedCastCount} configured sim profiles for ${args.experimentId}`,
      );
    }

    return {
      activityId: exp.activityId,
      teacherId: exp.teacherId,
      activity,
      mode: exp.mode,
      maxTurns: exp.config.maxTurns,
      generations: exp.config.generations ?? null,
      variantsPerGen: exp.config.variantsPerGen ?? null,
      baselineVariantId: exp.baselineVariantId!,
      sessionsTotal: exp.progress.sessionsTotal,
      castMeta,
      expectedCastCount,
      resolvedCastCount,
    };
  },
});

/**
 * Assemble the production tutor prompts (first-turn + later) for every cast
 * member, for ONE candidate `systemPrompt`. The node action calls this once
 * per variant it evaluates (it can't call buildSystemPrompt itself — wrong
 * runtime). Mirrors the baseline assembly in getRunInput.
 */
export const assemblePromptsForVariant = internalQuery({
  args: {
    experimentId: v.id("curriculumExperiments"),
    systemPrompt: v.union(v.string(), v.null()),
  },
  handler: async (ctx, args) => {
    const exp = await ctx.db.get(args.experimentId);
    if (!exp) throw new Error("Experiment not found");
    const activityDoc = await ctx.db.get(exp.activityId);
    if (!activityDoc) throw new Error("Activity not found");

    const activity = await resolveActivityMeta(
      ctx,
      activityDoc,
      args.systemPrompt,
      exp.config.learningGoal,
    );

    const cast = [];
    for (const profileId of exp.config.castProfileIds) {
      const p = await ctx.db.get(profileId);
      if (!p) continue;
      cast.push({
        profileId: p._id,
        name: p.name,
        readingLevel: p.readingLevel,
        dossier: p.dossier,
        traits: p.traits,
        archetype: p.archetype ?? null,
        misconception: p.misconception ?? null,
        firstTurnPrompt: assembleTutorPrompt(p, activity, true),
        laterPrompt: assembleTutorPrompt(p, activity, false),
      });
    }
    // Cast-mismatch warning is intentionally omitted here: this query runs once
    // per evaluated variant (repeatedly within a run), so warning would spam the
    // logs. getRunInput already emits the mismatch warning once per run. Callers
    // still get the counts below to detect a shrunken cast.
    const expectedCastCount = exp.config.castProfileIds.length;
    const resolvedCastCount = cast.length;
    return { activity, cast, expectedCastCount, resolvedCastCount };
  },
});

/** Insert an AI-proposed candidate variant mid-run (called from the node action). */
export const createVariant = internalMutation({
  args: {
    experimentId: v.id("curriculumExperiments"),
    activityId: v.id("activities"),
    parentVariantId: v.optional(v.id("curriculumVariants")),
    generation: v.number(),
    systemPrompt: v.union(v.string(), v.null()),
    rationale: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert("curriculumVariants", {
      activityId: args.activityId,
      experimentId: args.experimentId,
      parentVariantId: args.parentVariantId,
      generation: args.generation,
      systemPrompt: args.systemPrompt,
      origin: "ai-proposed",
      rationale: args.rationale,
      status: "candidate",
    });
  },
});

/** Record a variant's judge aggregate after the cast runs against it. */
export const recordVariantScores = internalMutation({
  args: {
    variantId: v.id("curriculumVariants"),
    aggregateScores: v.any(),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.variantId, {
      aggregateScores: args.aggregateScores,
    });
  },
});

/** Cap on real transcripts judged per grounding run — bounds the cost. */
const MAX_REAL_SESSIONS = 12;

/**
 * Everything runGrounding needs: the sim baseline aggregate (what we're
 * calibrating), the activity meta (for the judge), and up to MAX_REAL_SESSIONS
 * REAL transcripts on this activity (non-test-drive, non-offline, with at least
 * one scholar + one tutor turn), each tagged with the scholar's name + reading
 * level. Empty `realSessions` ⇒ the action records a "no real data" grounding.
 */
export const getGroundInput = internalQuery({
  args: { experimentId: v.id("curriculumExperiments") },
  handler: async (ctx, args) => {
    const exp = await ctx.db.get(args.experimentId);
    if (!exp) throw new Error("Experiment not found");
    const activityDoc = await ctx.db.get(exp.activityId);
    if (!activityDoc) throw new Error("Activity not found");
    const baseline = exp.baselineVariantId
      ? await ctx.db.get(exp.baselineVariantId)
      : null;

    const systemPrompt =
      baseline?.systemPrompt ?? activityDoc.systemPrompt ?? null;
    const activity = {
      title: activityDoc.title,
      kind: activityDoc.kind,
      systemPrompt,
      learningGoal: exp.config.learningGoal,
      deliverablePrompt: activityDoc.deliverable?.prompt ?? null,
      durationMinutes: activityDoc.durationMinutes ?? null,
      unitDesign: await serializeUnitDesign(ctx, activityDoc, systemPrompt),
    };

    // Real projects on this activity: query by the activity's lesson (indexed)
    // and filter to this activity, excluding test-drive + offline projects.
    // Scholar "got this wrong" flags (messageFlags) on the tutor turns are
    // carried through so the grounding judge — and the curriculum-bot debrief
    // it feeds — see what real scholars caught, not just the numeric scores.
    const realSessions: {
      sessionId: Id<"sessions">;
      scholarId: Id<"users">;
      profileName: string;
      readingLevel: string;
      messages: {
        role: string;
        content: string;
        scholarFlaggedWrong?: boolean;
        scholarFlagReason?: string;
      }[];
    }[] = [];
    // Roll-up of scholar flags across the real sessions, for the stored
    // debrief result (count + a few examples to show the teacher/bot).
    const scholarFeedbackExamples: { snippet: string; reason: string | null }[] =
      [];
    let scholarFlagCount = 0;
    if (activityDoc.lessonId) {
      const sessions = await ctx.db
        .query("sessions")
        .withIndex("by_lesson", (q) => q.eq("lessonId", activityDoc.lessonId))
        .collect();
      for (const p of sessions) {
        if (p.activityId !== exp.activityId) continue;
        if (p.isTestDrive || p.isOffline) continue;
        const msgs = await ctx.db
          .query("messages")
          .withIndex("by_session", (q) => q.eq("sessionId", p._id))
          .collect();
        const conversational = msgs.filter(
          (m) => m.role === "user" || m.role === "assistant",
        );
        const hasScholar = conversational.some((m) => m.role === "user");
        const hasTutor = conversational.some((m) => m.role === "assistant");
        if (!hasScholar || !hasTutor) continue;

        // Scholar flags for this session, keyed by the flagged messageId.
        const flagRows = await ctx.db
          .query("messageFlags")
          .withIndex("by_session", (q) => q.eq("sessionId", p._id))
          .collect();
        const flagByMessageId = new Map<string, string | null>();
        for (const f of flagRows) {
          flagByMessageId.set(String(f.messageId), f.reason ?? null);
        }

        const scholar = await ctx.db.get(p.userId);
        realSessions.push({
          sessionId: p._id,
          scholarId: p.userId,
          profileName: scholar?.name ?? "scholar",
          readingLevel: scholar?.readingLevel ?? "(unset)",
          messages: conversational.map((m) => {
            const flagged = flagByMessageId.has(String(m._id));
            if (flagged) {
              scholarFlagCount++;
              const reason = flagByMessageId.get(String(m._id)) ?? null;
              if (scholarFeedbackExamples.length < 5) {
                scholarFeedbackExamples.push({
                  snippet: m.content.replace(/\s+/g, " ").trim().slice(0, 140),
                  reason,
                });
              }
              return {
                role: m.role,
                content: m.content,
                scholarFlaggedWrong: true,
                scholarFlagReason: reason ?? undefined,
              };
            }
            return { role: m.role, content: m.content };
          }),
        });
        if (realSessions.length >= MAX_REAL_SESSIONS) break;
      }
    }

    return {
      activityId: exp.activityId,
      activity,
      baselineAggregate: baseline?.aggregateScores ?? null,
      realSessions,
      scholarFeedback: {
        count: scholarFlagCount,
        examples: scholarFeedbackExamples,
      },
    };
  },
});

/** Store a grounding calibration on the experiment (or a "no real data" note). */
export const recordGrounding = internalMutation({
  args: {
    experimentId: v.id("curriculumExperiments"),
    grounding: v.any(),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.experimentId, { grounding: args.grounding });
  },
});

/**
 * Persist the judge's per-real-session verdicts from a grounding run (sim-
 * realism adoptable #2). Grounding aggregates then discards these; keeping one
 * canonical row per (activity, session) makes the judge's ranking of real
 * sessions reproducible so judgeValidation.correlation can compare it to a
 * teacher's pairwise picks. Idempotent: upserts by (activityId, sessionId), so
 * re-grounding refreshes the verdict in place instead of duplicating.
 */
export const recordGroundedVerdicts = internalMutation({
  args: {
    experimentId: v.id("curriculumExperiments"),
    activityId: v.id("activities"),
    verdicts: v.array(
      v.object({
        sessionId: v.id("sessions"),
        scholarId: v.optional(v.id("users")),
        profileName: v.string(),
        readingLevel: v.string(),
        verdict: v.any(),
        fitness: v.number(),
        goalAttainment: v.number(),
        excerpt: v.string(),
      }),
    ),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    for (const v of args.verdicts) {
      const existing = await ctx.db
        .query("groundedSessionVerdicts")
        .withIndex("by_activity_session", (q) =>
          q.eq("activityId", args.activityId).eq("sessionId", v.sessionId),
        )
        .unique();
      const row = {
        activityId: args.activityId,
        sessionId: v.sessionId,
        experimentId: args.experimentId,
        scholarId: v.scholarId,
        profileName: v.profileName,
        readingLevel: v.readingLevel,
        verdict: v.verdict,
        fitness: v.fitness,
        goalAttainment: v.goalAttainment,
        excerpt: v.excerpt,
        judgedAt: now,
      };
      if (existing) {
        await ctx.db.patch(existing._id, row);
      } else {
        await ctx.db.insert("groundedSessionVerdicts", row);
      }
    }
  },
});

export const getStatus = internalQuery({
  args: { experimentId: v.id("curriculumExperiments") },
  handler: async (ctx, args) => {
    const exp = await ctx.db.get(args.experimentId);
    return exp?.status ?? null;
  },
});

export const recordProgress = internalMutation({
  args: {
    experimentId: v.id("curriculumExperiments"),
    sessionsDone: v.number(),
    generation: v.optional(v.number()),
    message: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const exp = await ctx.db.get(args.experimentId);
    if (!exp) return;
    await ctx.db.patch(args.experimentId, {
      progress: {
        ...exp.progress,
        sessionsDone: args.sessionsDone,
        generation: args.generation ?? exp.progress.generation,
        // Don't wipe a prior progress message when none is supplied.
        message: args.message ?? exp.progress.message,
      },
    });
  },
});

// Stream the in-flight session's conversation to the experiment's progress so
// the running view can show it building up turn-by-turn (called after each turn
// by runSession via its onTurn hook). Passing an empty transcript at the start
// of a member's session lights up the spinner + name before the first turn.
export const recordLiveTurn = internalMutation({
  args: {
    experimentId: v.id("curriculumExperiments"),
    scholarName: v.string(),
    scholarReadingLevel: v.string(),
    transcript: v.array(
      v.object({
        role: v.union(v.literal("tutor"), v.literal("scholar")),
        content: v.string(),
      }),
    ),
  },
  handler: async (ctx, args) => {
    const exp = await ctx.db.get(args.experimentId);
    if (!exp) return;
    // A cancel landed mid-run — stop streaming into a closed experiment.
    if (exp.status !== "running") return;
    await ctx.db.patch(args.experimentId, {
      progress: {
        ...exp.progress,
        liveScholarName: args.scholarName,
        liveScholarReadingLevel: args.scholarReadingLevel,
        liveTranscript: args.transcript,
      },
    });
  },
});

export const recordSession = internalMutation({
  args: {
    experimentId: v.id("curriculumExperiments"),
    variantId: v.id("curriculumVariants"),
    profileId: v.id("syntheticScholarProfiles"),
    transcript: v.array(
      v.object({
        role: v.union(v.literal("tutor"), v.literal("scholar")),
        content: v.string(),
      }),
    ),
    stopReason: v.union(
      v.literal("goal"),
      v.literal("stuck"),
      v.literal("maxTurns"),
    ),
    verdict: v.optional(v.any()),
    goalReached: v.optional(v.boolean()),
    // Outcome probe (adoptable #1) — mirrors the simulatedSessions.probe shape.
    probe: v.optional(
      v.object({
        skills: v.array(v.string()),
        itemsPerProbe: v.number(),
        preScore: v.number(),
        postScore: v.number(),
        delta: v.number(),
        items: v.array(
          v.object({
            skillKey: v.string(),
            stem: v.string(),
            preStem: v.string(),
            preCorrect: v.boolean(),
            postCorrect: v.boolean(),
          }),
        ),
      }),
    ),
    probeSkipReason: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert("simulatedSessions", {
      experimentId: args.experimentId,
      variantId: args.variantId,
      profileId: args.profileId,
      transcript: args.transcript,
      stopReason: args.stopReason,
      verdict: args.verdict,
      goalReached: args.goalReached,
      probe: args.probe,
      probeSkipReason: args.probeSkipReason,
    });
  },
});

export const finalize = internalMutation({
  args: {
    experimentId: v.id("curriculumExperiments"),
    variantId: v.id("curriculumVariants"),
    aggregateScores: v.optional(v.any()),
    status: v.union(v.literal("done"), v.literal("failed")),
    error: v.optional(v.string()),
    message: v.optional(v.string()),
    overallVerdict: v.optional(v.string()),
    // The structured, editor-routable findings twin of overallVerdict — see
    // convex/lib/curriculumPreflightResult.ts. Additive; a failure/legacy path
    // omits it and finalize() preserves whatever the experiment already has.
    preflightResult: v.optional(preflightResultValidator),
    // Adoptable #3 — the pairwise promote-gate result (per-cast winners + net
    // preference + how the decision was reached). Stored as-is for the results
    // view; shape is ExperimentPairwise in convex/lib/curriculumScore.ts.
    pairwise: v.optional(v.any()),
  },
  handler: async (ctx, args) => {
    const exp = await ctx.db.get(args.experimentId);
    if (!exp) return;
    // A cancel that landed mid-run wins — don't flip it back to done/failed.
    if (exp.status === "cancelled") return;
    if (args.aggregateScores !== undefined) {
      await ctx.db.patch(args.variantId, {
        aggregateScores: args.aggregateScores,
      });
    }
    await ctx.db.patch(args.experimentId, {
      status: args.status,
      error: args.error,
      finishedAt: Date.now(),
      bestVariantId: args.variantId,
      // Don't wipe a prior verdict when none is supplied (e.g. a failure path).
      overallVerdict: args.overallVerdict ?? exp.overallVerdict,
      // Same for the structured findings result (failure paths don't send it).
      preflightResult: args.preflightResult ?? exp.preflightResult,
      // Same for the pairwise result (analyze mode / failure paths don't send it).
      pairwise: args.pairwise ?? exp.pairwise,
      progress: {
        ...exp.progress,
        // Terminal finalize: peg the bar to 100% (skipped candidate slots /
        // early stop can leave sessionsDone < sessionsTotal).
        sessionsDone: exp.progress.sessionsTotal,
        // Don't wipe a prior progress message when none is supplied.
        message: args.message ?? exp.progress.message,
        // The run is over — drop the live-feed fields so the results view
        // doesn't show a stale in-flight conversation.
        liveScholarName: undefined,
        liveScholarReadingLevel: undefined,
        liveTranscript: undefined,
      },
    });
  },
});

// ─── Teacher-facing reads ────────────────────────────────────────────

export const get = authedQuery({
  args: { experimentId: v.id("curriculumExperiments") },
  handler: async (ctx, args) => {
    const exp = await ctx.db.get(args.experimentId);
    if (!exp) return null;
    await requireUnitEditAccess(ctx, { activityId: exp.activityId });

    const sessions = await ctx.db
      .query("simulatedSessions")
      .withIndex("by_experiment", (q) => q.eq("experimentId", exp._id))
      .collect();

    // Resolve profile names for the report (cast may be reused/edited).
    const profilesById = new Map<string, Doc<"syntheticScholarProfiles">>();
    for (const id of exp.config.castProfileIds) {
      const p = await ctx.db.get(id);
      if (p) profilesById.set(p._id, p);
    }
    const baseline = exp.baselineVariantId
      ? await ctx.db.get(exp.baselineVariantId)
      : null;

    // All variants for this experiment (baseline + any AI-proposed candidates),
    // oldest first so generation order reads top-down. The UI computes the
    // diff + keep/reject decision from the variants' aggregateScores.
    const variants = await ctx.db
      .query("curriculumVariants")
      .withIndex("by_experiment", (q) => q.eq("experimentId", exp._id))
      .collect();
    variants.sort((a, b) => a.generation - b.generation);

    // Per-variant OUTCOME PROBE aggregate (adoptable #1): mean pre/post/delta
    // over the variant's sessions that carried a probe. Keyed by variantId so
    // the UI can show a compact "pre X% → post Y% (Δ)" per variant — read as a
    // DELTA BETWEEN VARIANTS over the same cast, never as an absolute.
    const probeByVariant: Record<
      string,
      { preScore: number; postScore: number; delta: number; n: number }
    > = {};
    for (const variant of variants) {
      const summaries = sessions
        .filter((s) => s.variantId === variant._id && s.probe)
        .map((s) => s.probe!);
      const mean = meanProbe(summaries);
      if (mean) probeByVariant[variant._id] = mean;
    }

    return {
      experiment: exp,
      baselineVariant: baseline,
      variants,
      probeByVariant,
      sessions: sessions.map((s) => ({
        ...s,
        profile: profilesById.get(s.profileId) ?? null,
      })),
      // The full cast in run order — lets the running view show every scholar
      // from the start (done / streaming / queued) instead of growing the list.
      roster: exp.config.castProfileIds
        .map((id) => profilesById.get(id))
        .filter((p): p is Doc<"syntheticScholarProfiles"> => !!p)
        .map((p) => ({
          profileId: p._id,
          name: p.name,
          readingLevel: p.readingLevel,
        })),
    };
  },
});

export const listByActivity = authedQuery({
  args: { activityId: v.id("activities") },
  handler: async (ctx, args) => {
    await requireUnitEditAccess(ctx, { activityId: args.activityId });
    return await ctx.db
      .query("curriculumExperiments")
      .withIndex("by_activity", (q) => q.eq("activityId", args.activityId))
      .order("desc")
      .collect();
  },
});

/**
 * The caller's currently-RUNNING experiments, enriched for the global header's
 * background-tasks indicator (components/BackgroundTasksIndicator). Auto-improve
 * runs in a scheduled node action, so a teacher can kick one off in an activity
 * and navigate away; this query (reactive — progress updates land live) is what
 * surfaces "a run is still going" anywhere in the app, with a deep link back to
 * the activity that owns it.
 *
 * Scoped to the caller by teacherId (the field every experiment is stamped with
 * at kickoff), so no per-experiment unit-edit check is needed — you only ever
 * see your own. Non-teachers never start experiments, so they get an empty list.
 */
export const listRunning = authedQuery({
  args: {},
  handler: async (ctx) => {
    const running = await ctx.db
      .query("curriculumExperiments")
      .withIndex("by_teacher_status", (q) =>
        q.eq("teacherId", ctx.user._id).eq("status", "running"),
      )
      .collect();
    // Newest first — matches the activity-editor history order.
    running.sort((a, b) => b.startedAt - a.startedAt);

    return await Promise.all(
      running.map(async (exp) => {
        const activity = await ctx.db.get(exp.activityId);
        // Resolve the owning unit for a deep link to the unit designer.
        // Online activities launched from the editor always have a lesson;
        // guard the standalone case so the indicator still lists the run.
        const lesson = activity?.lessonId
          ? await ctx.db.get(activity.lessonId)
          : null;
        return {
          experimentId: exp._id,
          activityId: exp.activityId,
          unitId: lesson?.unitId ?? null,
          activityTitle: activity?.title ?? "Activity",
          mode: exp.mode,
          sessionsDone: exp.progress.sessionsDone,
          sessionsTotal: exp.progress.sessionsTotal,
          message: exp.progress.message ?? null,
        };
      }),
    );
  },
});

export const listProfiles = authedQuery({
  args: {},
  handler: async (ctx) => {
    return await ctx.db
      .query("syntheticScholarProfiles")
      .withIndex("by_owner", (q) => q.eq("ownerId", ctx.user._id))
      .collect();
  },
});
