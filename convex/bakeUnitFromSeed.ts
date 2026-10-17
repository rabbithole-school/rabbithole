// Seed → real unit "bake" (Curriculum Bot, headless on launch).
//
// When a scholar launches a quest from a *topic* seed (no unitId) or via the
// "Custom Quest" button (an empty independent-study unit), the tutor would
// otherwise just ad-lib around the topic. Instead we design a small, real unit
// on the fly — and hide the latency by launching the scholar straight into the
// ad-lib session while this runs in the background, then upgrading the session
// in place once an activity exists.
//
// DRY: this does NOT re-implement "what makes a good unit/activity." It RUNS
// THE ACTUAL CURRICULUM BOT one-shot — the same tool set
// (`assembleUnitDesignerTools`), the same system prompt
// (`buildUnitDesignerSystemText`), driven headlessly by `runAideLoop` (the
// non-SSE sibling of the bot's SSE runner) with a single seeded instruction.
// The only new prose here is the instruction telling the bot WHAT to build and
// that it must finish without asking questions.
//
// Full design + context: review/seed-to-unit-bake-plan.md.

import { v } from "convex/values";
import { describeLevelsForPrompt, levelsPromptLine } from "./lib/readingLevels";
import { customQuestTopic } from "./lib/customQuestTopic";
import type { ActionCtx } from "./_generated/server";
import { internalAction, internalMutation, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import type { Role } from "./lib/roles";
import { MODELS } from "./lib/models";
import { requireAnthropicApiKey } from "./lib/anthropic";
import { assembleUnitDesignerTools } from "./lib/unitDesignerTools";
import { runAideLoop, cachedSystem } from "./lib/aideStream";
import { recordUsage } from "./usage";
import { buildUnitDesignerSystemText } from "./unitDesignerStream";
import { buildDesignerPhysicalEnvironmentSection } from "./prompts";
import { curatedExplorationEntryForTopic } from "./lib/curatedExplorationCatalog";
import { ensureSessionActivitySetup } from "./lib/sessionActivitySetup";
import { effectiveActivityKind, isAppActivity } from "../shared/appSurface";
import { isLearningStep, type MissionActivity } from "./lib/mission";

// The scholar's chosen "way in" to the topic — picked from the live menu, whose
// 2-4 options are proposed by the Curriculum Bot itself (see convex/bakePaths.ts
// `suggestBakePaths`). NOT a fixed deep/wide/build archetype — a concrete,
// topic-specific angle (e.g. "Be a sound detective"). Threaded into the bake so
// the unit is designed around THIS angle. `{ title, blurb }` is exactly what the
// scholar saw on the card.
//
// `shape: "build"` marks the always-offered "Build a simulation" card
// (shared/missionCopy.ts BUILD_SIMULATION_PATH, TRA-519 B4): the bake ends in
// an app activity. The bake keys on `shape`, never on the title. Optional so
// older iPad builds keep validating.
export const chosenPathValidator = v.object({
  title: v.string(),
  blurb: v.string(),
  shape: v.optional(v.literal("build")),
});
export type ChosenPath = { title: string; blurb: string; shape?: "build" };

/** The "Build a simulation" path: the bake ends in an app activity. */
export function isBuildPath(path: ChosenPath | null | undefined): boolean {
  return path?.shape === "build";
}

/**
 * B6 learn before you build: no app activity may come before the first
 * learning step (a non-app online activity with a deliverable). Any app
 * activity ahead of it moves to just after it, keeping relative order.
 * Pure + stable; with no learning step at all the order is left as is.
 */
export function orderLearnBeforeBuild<A extends MissionActivity>(
  ordered: readonly A[],
): A[] {
  const firstLearning = ordered.findIndex((a) => isLearningStep(a));
  if (firstLearning < 0) return [...ordered];
  const early = ordered.slice(0, firstLearning);
  const movedApps = early.filter((a) => isAppActivity(a));
  if (movedApps.length === 0) return [...ordered];
  return [
    ...early.filter((a) => !isAppActivity(a)),
    ordered[firstLearning],
    ...movedApps,
    ...ordered.slice(firstLearning + 1),
  ];
}

const BAKE_STAGES = ["commit", "capture", "reckon", "extend"] as const;
type BakeStage = (typeof BAKE_STAGES)[number];

export function parseBakeStageMarker(
  notes: string | undefined,
): { stage: BakeStage; notes: string } | null {
  if (!notes) return null;
  const match = notes.match(
    /^\s*\[bake-stage:(commit|capture|reckon|extend)\]\s*/i,
  );
  if (!match) return null;
  const cleanedNotes = notes.slice(match[0].length).trim();
  if (!cleanedNotes) return null;
  return {
    stage: match[1].toLowerCase() as BakeStage,
    notes: cleanedNotes,
  };
}

/** A unit title can't be the scholar's whole rambling topic — cap it. */
function deriveUnitTitle(topic: string): string {
  const t = topic.trim().replace(/\s+/g, " ");
  if (t.length <= 80) return t;
  return t.slice(0, 77).trimEnd() + "…";
}

export interface BakeSpec {
  scholarId: Id<"users">;
  scholarRole: Role | null;
  unitId: Id<"units">;
  topic: string;
  domain: string | null;
  rationale: string | null;
  connectionTo: string | null;
  readingLevel: string | null;
  /** The scholar's chosen way in (from the live menu), if any. */
  path: ChosenPath | null;
}

/**
 * The one-shot instruction handed to the Curriculum Bot. Intentionally carries
 * NO "good unit/activity" guidance — that all lives in the shared system prompt
 * (`buildUnitDesignerSystemText`). This only states the goal + the headless
 * constraints (small, finish prompts, never ask questions).
 */
export function buildBakeInstruction(spec: BakeSpec): string {
  const steering: string[] = [];
  if (spec.connectionTo) steering.push(`What sparked it: ${spec.connectionTo}`);
  if (spec.rationale) steering.push(`Why it pulls them: ${spec.rationale}`);
  const anchor = curatedExplorationEntryForTopic(spec.topic)?.bakeAnchor;
  if (anchor) {
    steering.push(
      [
        `Verified discovery anchor — the mechanism this quest must eventually land: ${anchor.mechanism}`,
        "Treat that mechanism as the earned payoff, not the opening move: the scholar must derive it from evidence before the tutor names or explains it.",
        `Verified away-from-screen mission: ${anchor.mission.does}`,
        `Materials: ${anchor.mission.materials.join(", ")}.`,
        `No-materials or measurement fallback: ${anchor.mission.fallback}`,
        `Evidence commitment — the evidence-producing activity MUST use an auto deliverable with kind:"${anchor.evidence.kind}" and ask the scholar to produce: ${anchor.evidence.produces}`,
        `Make that learner-created evidence load-bearing later: ${anchor.evidence.laterUse}`,
        "Do not add an explainer video, slides, or another medium merely to look multimodal. The medium must function as an instrument or capture learner-created evidence; preserve a text-only arc when no medium genuinely changes the learning act.",
      ].join("\n"),
    );
  }

  const build = isBuildPath(spec.path);
  const stageMarkerRule =
    "Start each deliverable `notes` value with exactly one private stage marker: `[bake-stage:commit]`, `[bake-stage:capture]`, `[bake-stage:reckon]`, or `[bake-stage:extend]`.";
  const createStep = build
    ? [
        '3. create_activity — EXACTLY 4 activities on that lesson, created in the exact learner-facing sequence they should appear. The first three are ONLINE (kind:"online") design steps where the scholar FIGURES OUT how it works: commit (a bet or prediction they own), capture (gather evidence), reckon (name the rule in their own words). Each MUST include a deliverable with mode:"auto", a concrete scholar-facing `prompt`, `notes` capturing the quality bar, and an EMPTY `criteria` array (the per-scholar rubric is generated later). ' +
          stageMarkerRule +
          " Use each marker exactly once, in that order. The marker is stripped after the bake.",
        '   The 4th, `[bake-stage:extend]`, is THE BUILD: kind:"app". Its `systemPrompt` is the BUILD BRIEF: build a simulation that shows the rule the scholar named in the reckon step, in their own words — the builder can read their earlier work in this quest, so it never re-asks. Its deliverable is { kind:"artifact", mode:"auto", prompt: what their running simulation shows, notes: starting with `[bake-stage:extend]` then the quality bar, criteria: [] }. It ALWAYS carries a buildContract: `invariants` = 1-3 statements of the mechanism as testable cause→effect ("when X goes up, Y …"), `freedoms` = what the scholar owns (setting, characters, look, genre), `gate` = "The mechanism runs once with default settings."',
      ]
    : [
        '3. create_activity — 3-4 ONLINE activities on that lesson, created in the exact learner-facing sequence they should appear, each a focused step toward the topic. EVERY online activity MUST include a deliverable with mode:"auto", a concrete scholar-facing `prompt`, `notes` capturing the quality bar, and an EMPTY `criteria` array (the per-scholar rubric is generated later). ' +
          stageMarkerRule +
          " For 3 activities use commit, capture, reckon exactly once each; for 4 use all four exactly once. The marker is stripped after the bake. Learn before you build: if you make an app activity at all, it comes after at least one online activity with a deliverable where the scholar figures it out — never first.",
      ];
  const promptStep = build
    ? '5. generate_activity_prompt — write the tutor system prompt for EACH of the three design steps before you finish (NEVER for the app activity: its systemPrompt is the build brief you already wrote). In those prompts, tell the tutor to acknowledge the scholar NEUTRALLY and keep handing the thinking back — NOT to validate every turn with "that\'s exactly right" / "perfect" (constant praise short-circuits a gifted kid\'s own checking).'
    : "5. generate_activity_prompt — write the tutor system prompt for EACH online activity before you finish. In those prompts, tell the tutor to acknowledge the scholar NEUTRALLY and keep handing the thinking back — NOT to validate every turn with \"that's exactly right\" / \"perfect\" (constant praise short-circuits a gifted kid's own checking).";

  return [
    "You are designing a SMALL independent-study unit for ONE gifted elementary scholar who just chose, on their own, to explore this topic. This runs HEADLESS — there is no teacher to answer questions, so build the whole thing now with your tools and never ask me anything.",
    "",
    `Topic the scholar chose: "${spec.topic}"${spec.domain ? ` (${spec.domain})` : ""}`,
    steering.length
      ? `${steering.join("\n")}\n(Private steering — calibrate to it, don't read it back to the scholar.)`
      : "",
    levelsPromptLine(spec.readingLevel) ?? "Talk level: (not set — pick a sensible elementary default)",
    "",
    `STAY ON THE SCHOLAR'S ACTUAL QUESTION. The whole unit must lead them to genuinely understand the SPECIFIC thing in "${spec.topic}" — not a loosely-related neighbor. If it's a "why/how" question, the activities have to reach the real explanation (the mechanism, the cause), not stop at observing or describing something adjacent. The big idea, the lesson, and every activity should visibly build toward answering it.`,
    spec.path
      ? `\nTHE SCHOLAR PICKED THIS WAY IN: "${spec.path.title}" — ${spec.path.blurb}\nDesign the WHOLE unit around this angle — it's the spine of the quest, the lens every activity uses to reach the topic's core. Honor it specifically (don't flatten it back to a generic explainer), while still genuinely getting them to understand "${spec.topic}".`
      : "",
    "",
    "Build it end-to-end, in this order, using your tools:",
    "1. update_unit — set a big idea, 2 essential questions, and 1-2 enduring understandings grounded in THIS topic.",
    "2. create_lesson — exactly ONE lesson (core strand).",
    ...createStep,
    build
      ? "4. Verify that the saved activity order matches the intended arc (commit, capture, reckon, then the build last). The runtime will also normalize this order from the private markers before the unit can launch."
      : "4. Verify that the saved activity order matches the intended discovery arc (commit before capture, capture before reckon, optional extend last). The runtime will also normalize this order from the private markers before the unit can launch.",
    promptStep,
    "",
    "This is a real multi-sitting quest the scholar returns to — each activity is a meaty 15-30 minute sitting done as homework or independent work, NOT a one-sitting toy. Still exactly ONE lesson; still small enough to build now. At least ONE activity must carry an away-from-screen mission per the investigation bar's away-from-screen requirement: the activity's tutor prompt sends the scholar to do something real (measure, count, build, tally, test) with household items, and the NEXT sitting runs on what they bring back. Have an early activity open a gap the scholar owns (a bet, a prediction, a vote) and a later activity land the earned payoff — the concept's name arrives after the scholar has derived the thing, never in activity 1. Honor that they chose this — frame it as their exploration. When every online activity has a system prompt and an auto deliverable, you're done; end with a one-line summary.",
  ]
    .filter((l) => l !== "")
    .join("\n");
}

// ── Internal queries / mutations the orchestrator composes ────────────────

/**
 * Read everything the bake needs about a seed in one query: the scholar, the
 * topic/steering, the scholar's reading level, and whether this seed is already
 * structured (a unitId already present means it's a teacher offer or a prior
 * bake — do NOT bake again).
 */
export const loadBakeContextFromSeed = internalQuery({
  args: { seedId: v.id("seeds") },
  handler: async (ctx, args) => {
    const seed = await ctx.db.get(args.seedId);
    if (!seed) return null;
    const scholar = await ctx.db.get(seed.scholarId);
    return {
      scholarId: seed.scholarId,
      scholarRole: (scholar?.role ?? null) as Role | null,
      readingLevel: describeLevelsForPrompt(scholar),
      topic: seed.topic,
      domain: seed.domain ?? null,
      rationale: seed.rationale ?? null,
      connectionTo: seed.connectionTo ?? null,
      alreadyStructuredUnitId: seed.unitId ?? null,
    };
  },
});

/**
 * Read the bake spec for a Custom-Quest unit (no seed): the unit's title +
 * description are read TOGETHER as the scholar's idea (`customQuestTopic` —
 * a title that is only the scholar's own name yields to the description), and
 * the unit's owner is the scholar.
 */
export const loadBakeContextFromUnit = internalQuery({
  args: { unitId: v.id("units") },
  handler: async (ctx, args) => {
    const unit = await ctx.db.get(args.unitId);
    if (!unit) return null;
    const scholarId = unit.authorScholarId ?? unit.teacherId;
    const scholar = await ctx.db.get(scholarId);
    const { topic, rationale } = customQuestTopic(
      unit.title,
      unit.description,
      scholar,
    );
    return {
      scholarId,
      scholarRole: (scholar?.role ?? null) as Role | null,
      readingLevel: describeLevelsForPrompt(scholar),
      topic,
      domain: unit.subject ?? null,
      rationale,
      connectionTo: null as string | null,
    };
  },
});

/**
 * The institution that owns a unit, as the string scope the aide lens takes.
 * The bake runs the real Curriculum Bot toolset, so it must scope that
 * toolset's scholar lens to the unit's own school rather than let it fall back
 * to the caller's home institution.
 */
export const unitInstitutionScope = internalQuery({
  args: { unitId: v.id("units") },
  handler: async (ctx, args) => {
    const unit = await ctx.db.get(args.unitId);
    return unit?.institutionId ? String(unit.institutionId) : "";
  },
});

/** Find the first ONLINE activity in a (freshly baked) unit, in lesson→activity order. */
export const firstOnlineActivityInUnit = internalQuery({
  args: { unitId: v.id("units") },
  handler: async (
    ctx,
    args,
  ): Promise<{ lessonId: Id<"lessons">; activityId: Id<"activities"> } | null> => {
    const lessons = (
      await ctx.db
        .query("lessons")
        .withIndex("by_unit", (q) => q.eq("unitId", args.unitId))
        .collect()
    ).sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    for (const lesson of lessons) {
      const acts = (
        await ctx.db
          .query("activities")
          .withIndex("by_lesson", (q) => q.eq("lessonId", lesson._id))
          .collect()
      ).sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
      const online = acts.find((a) => effectiveActivityKind(a) === "online");
      if (online) return { lessonId: lesson._id, activityId: online._id };
    }
    return null;
  },
});

/**
 * The Curriculum Bot may create the right discovery stages in the wrong tool-call
 * order. Normalize them before the unit can link to a scholar session, then strip
 * the private stage markers so rubric generation sees only the real quality bar.
 */
export const normalizeBakedActivityOrder = internalMutation({
  args: {
    unitId: v.id("units"),
    // The "Build a simulation" path (TRA-519 B4): exactly 4 stages, and the
    // extend stage is repaired into an app activity if the bot missed it.
    build: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const lessons = await ctx.db
      .query("lessons")
      .withIndex("by_unit", (q) => q.eq("unitId", args.unitId))
      .collect();
    if (lessons.length !== 1) {
      return {
        normalized: false,
        reason: `Expected exactly one lesson, found ${lessons.length}`,
      };
    }

    const activities = await ctx.db
      .query("activities")
      .withIndex("by_lesson", (q) => q.eq("lessonId", lessons[0]._id))
      .collect();
    if (args.build ? activities.length !== 4 : activities.length !== 3 && activities.length !== 4) {
      return {
        normalized: false,
        reason: `Expected ${args.build ? "4" : "3-4"} activities, found ${activities.length}`,
      };
    }

    const staged = activities.map((activity) => ({
      activity,
      marker: parseBakeStageMarker(activity.deliverable?.notes),
    }));
    if (staged.some(({ marker }) => marker === null)) {
      return {
        normalized: false,
        reason: "Every activity must carry a valid bake-stage marker",
      };
    }

    const expectedStages = BAKE_STAGES.slice(0, activities.length);
    const actualStages = staged.map(({ marker }) => marker!.stage);
    if (
      new Set(actualStages).size !== actualStages.length ||
      expectedStages.some((stage) => !actualStages.includes(stage))
    ) {
      return {
        normalized: false,
        reason: `Expected stages ${expectedStages.join(", ")}, found ${actualStages.join(", ")}`,
      };
    }

    const stageOrder = new Map(
      BAKE_STAGES.map((stage, index) => [stage, index]),
    );
    staged.sort(
      (a, b) =>
        stageOrder.get(a.marker!.stage)! - stageOrder.get(b.marker!.stage)!,
    );

    // Build path: the extend stage IS the build. Repair a bot that made it a
    // plain online activity (set the app marker, make the deliverable the
    // app). A missing contract is logged, not fatal: the builder runs with
    // the default app gate (lib/mission.ts DEFAULT_APP_GATE).
    const repaired = new Map<Id<"activities">, Partial<Doc<"activities">>>();
    if (args.build) {
      const extend = staged.find(({ marker }) => marker!.stage === "extend")!;
      const a = extend.activity;
      const patch: Partial<Doc<"activities">> = {};
      if (!isAppActivity(a)) {
        patch.kind = "online";
        patch.appActivity = true;
        if (a.advanceRubric) patch.advanceRubric = undefined;
      }
      if (a.deliverable?.kind !== "artifact") {
        patch.deliverable = { ...a.deliverable!, kind: "artifact" };
      }
      if (!a.buildContract) {
        console.log(
          `[bake ${args.unitId}] build stage "${a.title}" has no buildContract; the default app gate applies`,
        );
      }
      if (Object.keys(patch).length > 0) {
        console.log(
          `[bake ${args.unitId}] repaired build stage "${a.title}": ${Object.keys(patch).join(", ")}`,
        );
        repaired.set(a._id, patch);
      }
    }

    // B6 learn before you build — every Quest bake, not only the build path.
    const shaped = staged.map((entry) => ({
      ...entry,
      shape: { ...entry.activity, ...(repaired.get(entry.activity._id) ?? {}) },
    }));
    const ordered = orderLearnBeforeBuild(
      shaped.map((entry) => ({ ...entry.shape, entry })),
    ).map((s) => s.entry);
    for (const [order, { activity, marker, shape }] of ordered.entries()) {
      const repair = repaired.get(activity._id) ?? {};
      await ctx.db.patch(activity._id, {
        ...repair,
        order,
        deliverable: {
          ...shape.deliverable!,
          notes: marker!.notes,
        },
      });
    }
    return { normalized: true, reason: null };
  },
});

/** Stamp a seed with the unit the bake produced (flips the star to "structured"). */
export const stampSeedUnit = internalMutation({
  args: { seedId: v.id("seeds"), unitId: v.id("units") },
  handler: async (ctx, args) => {
    const seed = await ctx.db.get(args.seedId);
    if (!seed) return;
    if (seed.unitId) return; // already structured — don't clobber
    await ctx.db.patch(args.seedId, { unitId: args.unitId });
  },
});

/**
 * Upgrade a live, still-anchorless session in place: point it at the baked
 * unit's first online activity. Idempotent + race-safe — refuses if the
 * session already has an activity (so a double-bake or a structured-seed launch
 * can't clobber a started activity), and verifies ownership.
 */
export const linkBakedUnitToSession = internalMutation({
  args: {
    sessionId: v.id("sessions"),
    scholarId: v.id("users"),
    unitId: v.id("units"),
    lessonId: v.id("lessons"),
    activityId: v.id("activities"),
  },
  handler: async (ctx, args): Promise<{ linked: boolean }> => {
    const session = await ctx.db.get(args.sessionId);
    if (!session) return { linked: false };
    if (session.userId !== args.scholarId) return { linked: false };
    // Already structured (a started activity, or a prior bake landed first) —
    // don't reattach.
    if (session.activityId) return { linked: false };
    const activity = await ctx.db.get(args.activityId);
    if (!activity) return { linked: false };
    const lesson = await ctx.db.get(args.lessonId);
    const unit = await ctx.db.get(args.unitId);
    await ctx.db.patch(args.sessionId, {
      unitId: args.unitId,
      lessonId: args.lessonId,
      activityId: args.activityId,
      // The wait is over: the client stops holding the opening turn and the
      // activity kickoff opens the session on the real task.
      questBakeStatus: undefined,
    });
    await ensureSessionActivitySetup(ctx, {
      sessionId: args.sessionId,
      activity,
      unitId: args.unitId,
      processId:
        activity.processId ??
        lesson?.processId ??
        unit?.processId ??
        undefined,
    });
    return { linked: true };
  },
});

/**
 * The inverse of `linkBakedUnitToSession`, for repairing an "Endless chat"
 * session that a bake upgraded in place before that choice stopped doing so
 * (2026-09-25): detach the baked activity and everything its setup stamped, so
 * the session reopens as the open chat the scholar picked. Keeps `unitId` —
 * the chat still lives in their quest. Run by hand against prod. Refuses
 * anything but an unassigned session in the scholar's own quest with no
 * submitted work, so it can never strip a teacher-assigned activity or orphan
 * a deliverable; the only artifact it removes is the untouched empty canvas
 * the setup seeded under the activity's title.
 */
export const reopenBakedSessionAsEndlessChat = internalMutation({
  args: { sessionId: v.id("sessions") },
  handler: async (ctx, args): Promise<{ reopened: boolean }> => {
    const session = await ctx.db.get(args.sessionId);
    if (!session?.activityId || !session.unitId || session.assignmentId) {
      return { reopened: false };
    }
    const unit = await ctx.db.get(session.unitId);
    if (!unit || unit.authorScholarId !== session.userId) {
      return { reopened: false };
    }
    const deliverable = await ctx.db
      .query("deliverables")
      .withIndex("by_session", (q) => q.eq("sessionId", args.sessionId))
      .first();
    if (deliverable) return { reopened: false };
    const activity = await ctx.db.get(session.activityId);
    const artifacts = await ctx.db
      .query("artifacts")
      .withIndex("by_session", (q) => q.eq("sessionId", args.sessionId))
      .collect();
    for (const artifact of artifacts) {
      if (artifact.content === "" && artifact.title === activity?.title) {
        await ctx.db.delete(artifact._id);
      }
    }
    await ctx.db.patch(args.sessionId, {
      activityId: undefined,
      lessonId: undefined,
      deliverableCriteria: undefined,
      deliverableCriteriaStatus: undefined,
      deliverableCriteriaError: undefined,
      reflection: undefined,
      reflectionStatus: undefined,
      reflectionError: undefined,
      questBakeStatus: undefined,
    });
    return { reopened: true };
  },
});

/**
 * Give up the client's opening-turn hold without attaching an activity.
 *
 * Every way a bake can end short of linking routes here, so a scholar's session
 * opens the old ad-lib way within a scheduler tick instead of sitting on the
 * "building your quest" state until the client-side cap expires. Only clears
 * `pending`, so it can never disturb a session another path already resolved.
 */
export const releaseQuestBakeHold = internalMutation({
  args: { sessionId: v.id("sessions") },
  handler: async (ctx, args): Promise<void> => {
    const session = await ctx.db.get(args.sessionId);
    if (!session || session.questBakeStatus !== "pending") return;
    await ctx.db.patch(args.sessionId, { questBakeStatus: undefined });
  },
});

/**
 * Run a bake and guarantee the session never keeps its hold unless the bake
 * actually attached an activity.
 *
 * The bail-outs are the point. Both bakes can end without linking from half a
 * dozen places — no context, a thrown design loop, `baked: false`, no online
 * activity, an ownership mismatch — and each one leaves a scholar looking at
 * "building your quest". A `finally` covers every existing branch and every
 * branch someone adds later, including a throw, which is exactly the failure a
 * per-return-site release would eventually miss.
 */
async function withQuestBakeHoldReleased<T extends { linked: boolean }>(
  ctx: ActionCtx,
  sessionId: Id<"sessions"> | undefined,
  run: () => Promise<T>,
): Promise<T> {
  let linked = false;
  try {
    const result = await run();
    linked = result.linked;
    return result;
  } finally {
    if (sessionId && !linked) {
      await ctx.runMutation(internal.bakeUnitFromSeed.releaseQuestBakeHold, {
        sessionId,
      });
    }
  }
}

// ── Shared orchestration core (plain helpers over ActionCtx) ──────────────

/**
 * Fill an empty unit by running the Curriculum Bot one-shot. Idempotent: if the
 * unit already has an online activity (a prior bake), it's a no-op. Returns
 * whether the unit now has an online activity.
 */
async function ensureUnitBaked(ctx: ActionCtx, spec: BakeSpec): Promise<boolean> {
  const existing = await ctx.runQuery(
    internal.bakeUnitFromSeed.firstOnlineActivityInUnit,
    { unitId: spec.unitId },
  );
  if (existing) return true; // already baked — don't redesign

  const designerCtx = await ctx.runQuery(
    internal.curriculumAssistant.getUnitDesignerContext,
    { teacherId: spec.scholarId, unitId: spec.unitId },
  );
  const processesDesc = (designerCtx?.processes ?? [])
    .map((p) => `- ${p.emoji} ${p.title} (id: ${p.id}): ${p.steps}`)
    .join("\n");

  // School gear registry (same inventory the tutor sees) so a baked quest's
  // offline/hands-on missions prefer equipment that actually exists. Resolved
  // off the scholar's institution; empty when there's none, in which case the
  // dynamic suffix stays undefined and the cached prefix is unchanged.
  const designerGear = await ctx.runQuery(
    internal.sessionHelpers.getDesignerPhysicalEnvironment,
    { userId: spec.scholarId },
  );
  const gearSuffix =
    buildDesignerPhysicalEnvironmentSection(designerGear) ?? undefined;

  const { Anthropic } = await import("@anthropic-ai/sdk");
  const anthropic = new Anthropic({ apiKey: requireAnthropicApiKey() });
  const institutionScope = await ctx.runQuery(
    internal.bakeUnitFromSeed.unitInstitutionScope,
    { unitId: spec.unitId },
  );
  const tools = await assembleUnitDesignerTools(ctx, () => {}, {
    teacherId: spec.scholarId,
    unitId: spec.unitId,
    role: spec.scholarRole,
    institutionScope,
  });

  const bakeResult = await runAideLoop({
    anthropic,
    model: MODELS.SONNET,
    maxTokens: 8192,
    system: cachedSystem(buildUnitDesignerSystemText(processesDesc), gearSuffix),
    messages: [{ role: "user", content: buildBakeInstruction(spec) }],
    tools,
    onToolUse: (name) => console.log(`[bake ${spec.unitId}] tool: ${name}`),
    label: "bake",
  });
  const institutionId = await ctx.runQuery(internal.usage.resolveInstitution, {
    userId: spec.scholarId,
    principal: "scholar",
  });
  await recordUsage(ctx, {
    source: "curriculum-bake",
    role: spec.scholarRole,
    model: bakeResult.model || MODELS.SONNET,
    usage: bakeResult.usage,
    institutionId,
  });

  const after = await ctx.runQuery(
    internal.bakeUnitFromSeed.firstOnlineActivityInUnit,
    { unitId: spec.unitId },
  );
  if (!after) return false;
  const normalized = await ctx.runMutation(
    internal.bakeUnitFromSeed.normalizeBakedActivityOrder,
    { unitId: spec.unitId, build: isBuildPath(spec.path) },
  );
  if (!normalized.normalized) {
    console.error(
      `[bake ${spec.unitId}] stage normalization failed: ${normalized.reason}`,
    );
    return false;
  }
  return true;
}

/**
 * Upgrade a live ad-lib session in place: point it at the baked unit's first
 * online activity and fire the per-session auto-rubric. Returns whether it
 * linked.
 */
async function upgradeSessionInPlace(
  ctx: ActionCtx,
  args: { sessionId: Id<"sessions">; scholarId: Id<"users">; unitId: Id<"units"> },
): Promise<boolean> {
  const first = await ctx.runQuery(
    internal.bakeUnitFromSeed.firstOnlineActivityInUnit,
    { unitId: args.unitId },
  );
  if (!first) return false;
  const res = await ctx.runMutation(internal.bakeUnitFromSeed.linkBakedUnitToSession, {
    sessionId: args.sessionId,
    scholarId: args.scholarId,
    unitId: args.unitId,
    lessonId: first.lessonId,
    activityId: first.activityId,
  });
  return res.linked;
}

// ── Entry points ──────────────────────────────────────────────────────────

/**
 * Topic-seed bake. Designs a small real unit from a topic seed, stamps the seed
 * (→ "structured"), and (when a live session is given) upgrades it in place.
 * Fired from `sessions.createFromSeed` via `scheduler.runAfter(0, …)` so the
 * scholar never waits. Idempotent per seed.
 */
export const bakeUnitFromSeed = internalAction({
  args: {
    seedId: v.id("seeds"),
    sessionId: v.optional(v.id("sessions")),
    path: v.optional(chosenPathValidator),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{ unitId: Id<"units"> | null; linked: boolean }> =>
    withQuestBakeHoldReleased(ctx, args.sessionId, () =>
      runSeedBake(ctx, args),
    ),
});

async function runSeedBake(
  ctx: ActionCtx,
  args: {
    seedId: Id<"seeds">;
    sessionId?: Id<"sessions">;
    path?: ChosenPath;
  },
): Promise<{ unitId: Id<"units"> | null; linked: boolean }> {
  const cx = await ctx.runQuery(internal.bakeUnitFromSeed.loadBakeContextFromSeed, {
    seedId: args.seedId,
  });
  if (!cx) return { unitId: null, linked: false };

  // Structured-seed / already-baked guard: a seed that already points at a
  // unit was a teacher offer or a prior bake — reuse it, don't redesign.
  let unitId: Id<"units">;
  if (cx.alreadyStructuredUnitId) {
    unitId = cx.alreadyStructuredUnitId;
  } else {
    // Create the empty scholar-owned unit (born-Draft; provenance stamped).
    const created = await ctx.runMutation(internal.teacherAide.createScholarQuest, {
      scholarId: cx.scholarId,
      authorId: cx.scholarId,
      title: deriveUnitTitle(cx.topic),
      bakedFromSeedId: args.seedId,
    });
    unitId = created.unitId;

    let baked = false;
    try {
      baked = await ensureUnitBaked(ctx, {
        scholarId: cx.scholarId,
        scholarRole: cx.scholarRole,
        unitId,
        topic: cx.topic,
        domain: cx.domain,
        rationale: cx.rationale,
        connectionTo: cx.connectionTo,
        readingLevel: cx.readingLevel,
        path: args.path ?? null,
      });
    } catch (err) {
      // The unit may be partially built; leave it (Draft) for inspection but
      // don't stamp the seed or upgrade the session off a broken bake.
      console.error(`[bake ${unitId}] loop failed:`, err);
      return { unitId, linked: false };
    }
    if (!baked) return { unitId, linked: false };

    // Stamp the seed → flips the star to "structured".
    await ctx.runMutation(internal.bakeUnitFromSeed.stampSeedUnit, {
      seedId: args.seedId,
      unitId,
    });
  }

  const linked = args.sessionId
    ? await upgradeSessionInPlace(ctx, {
        sessionId: args.sessionId,
        scholarId: cx.scholarId,
        unitId,
      })
    : false;
  return { unitId, linked };
}

/**
 * Custom-Quest bake. The scholar authored an (empty) independent-study unit via
 * the "Custom Quest" button; fill it with real activities so it's a structured
 * quest (and its completion badge becomes earnable), then upgrade the live
 * session in place. Fired from `units.createQuest` via
 * `scheduler.runAfter(0, …)`. Idempotent (skips a unit already baked).
 */
export const bakeCustomQuestUnit = internalAction({
  args: {
    unitId: v.id("units"),
    sessionId: v.optional(v.id("sessions")),
    path: v.optional(chosenPathValidator),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{ unitId: Id<"units">; linked: boolean }> =>
    withQuestBakeHoldReleased(ctx, args.sessionId, () =>
      runCustomQuestBake(ctx, args),
    ),
});

async function runCustomQuestBake(
  ctx: ActionCtx,
  args: {
    unitId: Id<"units">;
    sessionId?: Id<"sessions">;
    path?: ChosenPath;
  },
): Promise<{ unitId: Id<"units">; linked: boolean }> {
  const cx = await ctx.runQuery(internal.bakeUnitFromSeed.loadBakeContextFromUnit, {
    unitId: args.unitId,
  });
  if (!cx) return { unitId: args.unitId, linked: false };

  let baked = false;
  try {
    baked = await ensureUnitBaked(ctx, {
      scholarId: cx.scholarId,
      scholarRole: cx.scholarRole,
      unitId: args.unitId,
      topic: cx.topic,
      domain: cx.domain,
      rationale: cx.rationale,
      connectionTo: cx.connectionTo,
      readingLevel: cx.readingLevel,
      path: args.path ?? null,
    });
  } catch (err) {
    console.error(`[bake ${args.unitId}] custom-quest loop failed:`, err);
    return { unitId: args.unitId, linked: false };
  }
  if (!baked) return { unitId: args.unitId, linked: false };

  const linked = args.sessionId
    ? await upgradeSessionInPlace(ctx, {
        sessionId: args.sessionId,
        scholarId: cx.scholarId,
        unitId: args.unitId,
      })
    : false;
  return { unitId: args.unitId, linked };
}
