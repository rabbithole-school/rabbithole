import { v } from "convex/values";

import type { Doc, Id } from "./_generated/dataModel";
import { internalMutation } from "./_generated/server";
import { authedMutation, authedQuery, teacherQuery } from "./lib/customFunctions";
import { requireUnitEditAccess } from "./lib/auth";
import { isTeacherRole } from "./lib/roles";
import {
  MAX_AUTOMATA_COMPILED_RUN,
  MAX_AUTOMATA_PER_RUN,
  MAX_ECOSYSTEM_SPECIES_SLOTS,
  MAX_PROMPT_CHARS,
  MAX_SPECIES_SLOTS,
  type SimulatorSpec,
} from "../lib/simulator/contract";
import {
  SIMULATOR_TEMPLATE_IDS,
  SIMULATOR_TEMPLATES,
  getSimulatorTemplate,
} from "../lib/simulator/templates/registry";
import {
  SYSTEMS_AGENTS_UNIT_SLUG,
  resyncSystemsAgentsContent,
  simulatorSpecForStorage as simulatorSpecForStorage,
} from "./seed/systemsAgents";
import { resyncCooperationConflictContent } from "./seed/cooperationConflict";
import { resolveBenchSimulator } from "./simulatorBenches";
import { scholarInstitutionId } from "./lib/scholarEnrollment";

function validatedSimulator(activity: Doc<"activities">) {
  const stored = activity.simulatorSpec;
  if (activity.kind !== "simulator" || !stored) return null;
  const spec = stored as SimulatorSpec;
  const template = getSimulatorTemplate(spec.templateId);
  if (!template) throw new Error(`Unknown Simulator template "${spec.templateId}"`);
  template.validateSpec(spec);
  return { spec, template };
}

function projectSimulator(activity: Doc<"activities">, resolved: NonNullable<ReturnType<typeof validatedSimulator>>) {
  return {
    activityId: activity._id,
    title: activity.title,
    // Scholar-facing Workbench payload — scholar copy only.
    description: activity.scholarDescription ?? null,
    simulatorSpec: resolved.spec,
    // Kept through the fleet transition: worlds.getWorldSpec is a thin alias
    // of this canonical endpoint, and released clients still read worldSpec.
    worldSpec: resolved.spec,
    template: {
      id: resolved.template.id,
      version: resolved.template.version,
      rendererProtocolVersion: resolved.template.rendererProtocolVersion,
      senseIds: resolved.template.senseIds,
      actionKinds: resolved.template.actionKinds,
      metricKeys: resolved.template.metricKeys,
    },
  };
}

export const listSimulatorActivities = teacherQuery({
  args: {},
  handler: async (ctx) => {
    const activities = await ctx.db.query("activities").collect();
    const rows = [];
    for (const activity of activities) {
      const resolved = validatedSimulator(activity);
      if (!resolved) continue;
      const lesson = activity.lessonId ? await ctx.db.get(activity.lessonId) : null;
      const unit = lesson ? await ctx.db.get(lesson.unitId) : null;
      if (ctx.user.role !== "platform_admin" && unit?.teacherId !== ctx.user._id) continue;
      rows.push({
        ...projectSimulator(activity, resolved),
        lessonId: lesson?._id ?? null,
        lessonTitle: lesson?.title ?? null,
        unitId: unit?._id ?? null,
        unitTitle: unit?.title ?? null,
      });
    }
    return rows.sort(
      (left, right) =>
        (left.unitTitle ?? "").localeCompare(right.unitTitle ?? "") ||
        (left.lessonTitle ?? "").localeCompare(right.lessonTitle ?? "") ||
        left.title.localeCompare(right.title),
    );
  },
});

export const getSimulatorSpec = authedQuery({
  args: {
    sessionId: v.optional(v.id("sessions")),
    activityId: v.optional(v.id("activities")),
  },
  handler: async (ctx, args) => {
    if ((args.sessionId === undefined) === (args.activityId === undefined)) {
      throw new Error("Provide exactly one of sessionId or activityId");
    }

    let activityId: Id<"activities">;
    let bench: Doc<"simulatorBenches"> | null = null;
    if (args.sessionId) {
      const session = await ctx.db.get(args.sessionId);
      if (!session || (session.userId !== ctx.user._id && !isTeacherRole(ctx.user.role))) {
        return null;
      }
      if (!session.activityId) return null;
      activityId = session.activityId;
      bench = await ctx.db
        .query("simulatorBenches")
        .withIndex("by_session", (query) => query.eq("sessionId", session._id))
        .unique();
    } else {
      activityId = args.activityId!;
      if (!isTeacherRole(ctx.user.role)) {
        const sessions = await ctx.db
          .query("sessions")
          .withIndex("by_user", (query) => query.eq("userId", ctx.user._id))
          .collect();
        if (!sessions.some((session) => session.activityId === activityId)) return null;
      }
    }

    const activity = await ctx.db.get(activityId);
    if (!activity) return null;
    const resolved = args.sessionId ? resolveBenchSimulator(activity, bench) : validatedSimulator(activity);
    return resolved ? projectSimulator(activity, resolved) : null;
  },
});

// ── Design layer (Edit tab) — curriculum-gated, the canonical home ──────────
// The teacher Simulator editor reads/writes here, under the SAME access gate as
// every other activity design surface (requireUnitEditAccess → curriculum roles
// or the unit author), so a curriculum designer who can open the activity editor
// can author a Simulator, and no teacher can edit a unit they don't own. Templates
// are code; the editor parameterizes them and validateSpec is the authoring
// boundary (an illegal combination throws with a human-readable reason).

export const simulatorDesign = authedQuery({
  args: { activityId: v.id("activities") },
  handler: async (ctx, args) => {
    await requireUnitEditAccess(ctx, { activityId: args.activityId });
    const activity = await ctx.db.get(args.activityId);
    if (!activity) return null;
    const templates = SIMULATOR_TEMPLATE_IDS.map((id) => {
      const template = SIMULATOR_TEMPLATES[id];
      return {
        id: template.id,
        version: template.version,
        senseIds: [...template.senseIds],
        actionKinds: [...template.actionKinds],
        metricKeys: [...template.metricKeys],
        summaryMetricKeys: [...template.summaryMetricKeys],
      };
    });
    let simulatorSpec: SimulatorSpec | null = null;
    let specError: string | null = null;
    const stored = activity.simulatorSpec;
    if (activity.kind === "simulator" && stored) {
      simulatorSpec = stored as SimulatorSpec;
      const template = getSimulatorTemplate(simulatorSpec.templateId);
      try {
        if (!template) throw new Error(`Unknown template "${simulatorSpec.templateId}"`);
        template.validateSpec(simulatorSpec);
      } catch (error) {
        specError = error instanceof Error ? error.message : String(error);
      }
    }
    return {
      activityId: activity._id,
      title: activity.title,
      kind: activity.kind,
      simulatorSpec,
      // worlds.worldDesign remains callable by the released iPad build.
      worldSpec: simulatorSpec,
      specError,
      templates,
      limits: {
        maxSpeciesSlots: MAX_SPECIES_SLOTS,
        maxEcosystemSpeciesSlots: MAX_ECOSYSTEM_SPECIES_SLOTS,
        maxAutomataPerRun: MAX_AUTOMATA_PER_RUN,
        maxAutomataCompiledRun: MAX_AUTOMATA_COMPILED_RUN,
        maxPromptChars: MAX_PROMPT_CHARS,
      },
    };
  },
});

export const saveSimulatorSpec = authedMutation({
  args: { activityId: v.id("activities"), spec: v.any() },
  handler: async (ctx, args) => {
    await requireUnitEditAccess(ctx, { activityId: args.activityId });
    const activity = await ctx.db.get(args.activityId);
    if (!activity) throw new Error("Activity not found");
    const spec = args.spec as SimulatorSpec;
    const template = getSimulatorTemplate(spec?.templateId);
    if (!template) throw new Error(`Unknown Simulator template "${spec?.templateId}"`);
    template.validateSpec(spec);
    const stored = simulatorSpecForStorage(spec);
    const patch: Partial<Doc<"activities">> = { simulatorSpec: stored };
    if (activity.kind !== "simulator") {
      patch.kind = "simulator";
      // Recipes (baseline/exitTicket) apply to online+offline only — clear it
      // so a converted activity doesn't still claim to be an EQ/EU assessment.
      if (activity.recipe !== undefined) patch.recipe = undefined;
    }
    await ctx.db.patch(args.activityId, patch);
    return { ok: true as const };
  },
});

// Shared validate → storage-shape transform for the bot-authoring mutations
// below. Throws the template's own human-readable error on an invalid spec
// (the Curriculum Bot's tool catches it and returns the message so the model
// self-corrects). Mirrors saveSimulatorSpec's validate step exactly.
function validateAndStoreSimulatorSpec(
  spec: unknown,
): NonNullable<Doc<"activities">["simulatorSpec"]> {
  const s = spec as SimulatorSpec;
  const template = getSimulatorTemplate(s?.templateId);
  if (!template) throw new Error(`Unknown Simulator template "${s?.templateId}"`);
  template.validateSpec(s);
  return simulatorSpecForStorage(s);
}

// ── Curriculum Bot world-authoring path ───────────────────────────────────
// The internal twins of saveSimulatorSpec, for the shared create_simulator_activity /
// update_simulator_spec tools (convex/lib/activityKindTools). No auth gate here:
// each tool assembler already passed its staff/role gate and resolves the
// target lesson/activity through its surface-specific resolver. Both validate
// the spec BEFORE any write, so an invalid spec throws (the tool surfaces the
// exact error) without leaving a half-configured row.

export const createSimulatorActivityInternal = internalMutation({
  args: {
    lessonId: v.id("lessons"),
    title: v.string(),
    description: v.optional(v.string()),
    durationMinutes: v.optional(v.number()),
    /** Optional zero-based insertion slot; collisions shift occupied peers. */
    position: v.optional(v.number()),
    spec: v.any(),
  },
  handler: async (ctx, args) => {
    // Validate FIRST — never create a dead shell for an invalid spec.
    const stored = validateAndStoreSimulatorSpec(args.spec);
    if (
      args.position !== undefined &&
      (!Number.isInteger(args.position) || args.position < 0)
    ) {
      throw new Error("position must be a non-negative integer");
    }

    // Idempotency by title within the lesson: a retry (or filling an empty
    // world Draft made by create_activity) reconfigures the SAME world instead
    // of duplicating it. Only reuse a match that is ALREADY a world — a title
    // collision with a non-world activity must NOT silently convert it (that
    // would clobber its kind and strand a recipe); insert a new world instead.
    const title = args.title.trim();
    if (!title) throw new Error("title must not be empty");
    const titleLower = title.toLowerCase();
    const peers = await ctx.db
      .query("activities")
      .withIndex("by_lesson", (q) => q.eq("lessonId", args.lessonId))
      .collect();
    const existing =
      peers.find(
        (a) => a.kind === "simulator" && a.title.trim().toLowerCase() === titleLower,
      ) ?? null;

    if (existing) {
      const patch: Partial<Doc<"activities">> = { simulatorSpec: stored };
      if (
        args.description !== undefined &&
        (args.description.trim() || "") !== (existing.description ?? "")
      ) {
        patch.description = args.description.trim() || undefined;
      }
      if (
        args.durationMinutes !== undefined &&
        args.durationMinutes !== existing.durationMinutes
      ) {
        patch.durationMinutes = args.durationMinutes;
      }
      await ctx.db.patch(existing._id, patch);
      return {
        activityId: existing._id,
        existed: true as const,
        title: existing.title,
      };
    }

    const order =
      args.position ??
      peers.reduce((m, a) => Math.max(m, a.order), -1) + 1;
    if (args.position !== undefined) {
      const occupied = new Set(peers.map((p) => p.order));
      let firstOpen = order;
      while (occupied.has(firstOpen)) firstOpen += 1;
      for (const sibling of peers) {
        if (sibling.order >= order && sibling.order < firstOpen) {
          await ctx.db.patch(sibling._id, { order: sibling.order + 1 });
        }
      }
    }

    const insertedId = await ctx.db.insert("activities", {
      lessonId: args.lessonId,
      title,
      description: args.description?.trim() || undefined,
      kind: "simulator",
      order,
      durationMinutes: args.durationMinutes,
      simulatorSpec: stored,
    });
    return { activityId: insertedId, existed: false as const, title };
  },
});

export const setSimulatorSpecInternal = internalMutation({
  args: { activityId: v.id("activities"), spec: v.any() },
  handler: async (ctx, args) => {
    const activity = await ctx.db.get(args.activityId);
    if (!activity) throw new Error("Activity not found");
    const stored = validateAndStoreSimulatorSpec(args.spec);
    const patch: Partial<Doc<"activities">> = { simulatorSpec: stored };
    if (activity.kind !== "simulator") {
      patch.kind = "simulator";
      // Recipes (baseline/exitTicket) apply to online+offline only — clear it
      // so a converted activity doesn't still claim to be an EQ/EU assessment.
      if (activity.recipe !== undefined) patch.recipe = undefined;
    }
    await ctx.db.patch(args.activityId, patch);
    return { ok: true as const, title: activity.title };
  },
});

function assertPrivateDevDeployment() {
  const cloudUrl = process.env.CONVEX_CLOUD_URL ?? "";
  let isPrivateDeployment = false;
  if (isPrivateDeployment) {
    throw new Error("Live Simulator smoke helpers are private-dev only");
  }
}

/**
 * Dev-only fixture setup for real-model smoke tests. It creates the ordinary
 * session that public bench/run mutations require; it never writes a run.
 */
/** Dev-only: re-apply current Systems & Agents copy/specs to already-seeded
 *  activities AND clear their benches (destructive — throws away materialized
 *  deck/effective-spec state and run grants; simulatorRuns persist). Run after editing
 *  SYSTEMS_AGENTS_LESSONS:
 *    npx convex run worlds:resyncSystemsAgents */
export const resyncSystemsAgents = internalMutation({
  args: {},
  handler: async (ctx) => {
    assertPrivateDevDeployment();
    return resyncSystemsAgentsContent(ctx, { clearBenches: true });
  },
});

/**
 * PROD-SAFE one-shot: backfill the corrected Systems & Agents curriculum copy
 * (titles, descriptions, durationMinutes, and simulatorSpec) onto already-seeded
 * activities, WITHOUT touching any scholar's bench. Non-destructive and
 * idempotent — safe to run on production to fix content
 * seeded before the First Automaton regrounding. Existing benches keep their own
 * deck and any effectiveSpec; only benches without an effectiveSpec resolve the
 * updated activity simulatorSpec. New benches pick up the corrected starterHint. No
 * dev gate on purpose (it's the prod path).
 *   npx convex run worlds:backfillSystemsAgentsContent
 */
export const backfillSystemsAgentsContent = internalMutation({
  args: {},
  handler: async (ctx) => resyncSystemsAgentsContent(ctx, { clearBenches: false }),
});

/** Dev-only: re-apply current Cooperation & conflict copy/specs to already-seeded
 *  activities AND clear their benches (destructive — throws away materialized
 *  deck/effective-spec state and run grants; simulatorRuns persist). Run after editing
 *  COOPERATION_CONFLICT_LESSONS:
 *    npx convex run worlds:resyncCooperationConflict */
export const resyncCooperationConflict = internalMutation({
  args: {},
  handler: async (ctx) => {
    assertPrivateDevDeployment();
    return resyncCooperationConflictContent(ctx, { clearBenches: true });
  },
});

/**
 * PROD-SAFE one-shot: backfill the corrected Cooperation & conflict curriculum
 * copy (titles, descriptions, durationMinutes, and simulatorSpec) onto already-seeded
 * activities, WITHOUT touching any scholar's bench. Non-destructive and
 * idempotent — safe to run on prod. New benches pick up the corrected
 * starterHint. No dev gate on purpose (it's the prod path).
 *   npx convex run worlds:backfillCooperationConflictContent
 */
export const backfillCooperationConflictContent = internalMutation({
  args: {},
  handler: async (ctx) => resyncCooperationConflictContent(ctx, { clearBenches: false }),
});

export const prepareLiveSmoke = internalMutation({
  args: {
    scholarUsername: v.string(),
    activityTitle: v.string(),
    iterationTicks: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    assertPrivateDevDeployment();
    const scholar = await ctx.db
      .query("users")
      .withIndex("by_username", (query) => query.eq("username", args.scholarUsername))
      .unique();
    if (!scholar || scholar.role !== "scholar") throw new Error("Smoke scholar not found");

    const unit = await ctx.db
      .query("units")
      .withIndex("by_slug", (query) => query.eq("slug", SYSTEMS_AGENTS_UNIT_SLUG))
      .unique();
    if (!unit) throw new Error("Systems & Agents seed is missing");
    const lessons = await ctx.db
      .query("lessons")
      .withIndex("by_unit", (query) => query.eq("unitId", unit._id))
      .collect();
    const activities = (
      await Promise.all(
        lessons.map((lesson) =>
          ctx.db
            .query("activities")
            .withIndex("by_lesson", (query) => query.eq("lessonId", lesson._id))
            .collect(),
        ),
      )
    ).flat();
    const source = activities.find((activity) => activity.title === args.activityTitle);
    if (!source) throw new Error(`Seeded Simulator "${args.activityTitle}" not found`);
    const resolved = validatedSimulator(source);
    if (!resolved) throw new Error("Smoke source is not a valid Simulator");

    let activity = source;
    if (
      args.iterationTicks !== undefined &&
      args.iterationTicks !== resolved.spec.tickBudget.iterationTicks
    ) {
      if (!Number.isInteger(args.iterationTicks) || args.iterationTicks < 1) {
        throw new Error("Smoke iterationTicks must be a positive integer");
      }
      const smokeTitle = `[Smoke ${args.iterationTicks}] ${source.title}`;
      const smokeLesson =
        lessons.find((lesson) => lesson.title === "Live smoke") ??
        (await (async () => {
          const lessonId = await ctx.db.insert("lessons", {
            unitId: unit._id,
            title: "Live smoke",
            order: 99,
            strand: "practice",
          });
          return (await ctx.db.get(lessonId))!;
        })());
      const existingSmoke = activities.find((candidate) => candidate.title === smokeTitle);
      if (existingSmoke) {
        activity = existingSmoke;
      } else {
        const smokeSpec: SimulatorSpec = {
          ...resolved.spec,
          tickBudget: {
            iterationTicks: args.iterationTicks,
            seasonTicks: Math.max(args.iterationTicks, resolved.spec.tickBudget.seasonTicks),
            absoluteMaxTicks: Math.max(
              args.iterationTicks,
              resolved.spec.tickBudget.absoluteMaxTicks,
            ),
          },
        };
        resolved.template.validateSpec(smokeSpec);
        const activityId = await ctx.db.insert("activities", {
          lessonId: smokeLesson._id,
          title: smokeTitle,
          order: 0,
          kind: "simulator",
          description: "Private-dev live-model smoke fixture.",
          simulatorSpec: simulatorSpecForStorage(smokeSpec),
        });
        activity = (await ctx.db.get(activityId))!;
      }
    }

    const scholarSessions = await ctx.db
      .query("sessions")
      .withIndex("by_user", (query) => query.eq("userId", scholar._id))
      .collect();
    const existingSession = scholarSessions.find(
      (session) => session.activityId === activity._id && session.sessionMode === "workbench",
    );
    const institutionId = await scholarInstitutionId(ctx, scholar._id);
    if (
      existingSession &&
      institutionId &&
      existingSession.institutionId === undefined
    ) {
      await ctx.db.patch(existingSession._id, { institutionId });
    }
    const sessionId =
      existingSession?._id ??
      (await ctx.db.insert("sessions", {
        userId: scholar._id,
        institutionId: institutionId ?? undefined,
        activityId: activity._id,
        sessionMode: "workbench",
        title: `${activity.title} Workbench`,
        isArchived: false,
      }));
    const authSessionId = await ctx.db.insert("authSessions", {
      userId: scholar._id,
      expirationTime: Date.now() + 60 * 60 * 1000,
    });
    return {
      sessionId,
      activityId: activity._id,
      identity: {
        subject: `${scholar._id}|${authSessionId}`,
        issuer: "https://convex.dev",
      },
    };
  },
});
