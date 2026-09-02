// Eval-only support for the baked-vs-ad-lib comparison (evals/seed-bake).
//
// Internal (never public) — invoked from the harness via `npx convex run`
// against a DEV deployment. It runs the REAL bake (same code path the launch
// flow schedules) on an ephemeral scholar + seed, times it, and returns the
// resulting first online activity's content so the harness can drive a
// synthetic-scholar conversation against it. Sibling pattern to
// convex/evalExport.ts / convex/seedUnitForTesting.ts.

import { v } from "convex/values";
import type { ActivityKind } from "../lib/activityKinds";
import { internalAction, internalMutation, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";

type EvalDeliverable = {
  kind: "photo" | "artifact" | "slides" | "text" | "audio" | "map";
  mode: "manual" | "auto" | "none";
  prompt: string;
  notes: string | null;
  criteria: { label: string; description: string | null }[];
} | null;

type EvalDesignActivity = {
  title: string;
  description: string | null;
  kind: ActivityKind;
  systemPrompt: string | null;
  durationMinutes: number | null;
  deliverable: EvalDeliverable;
};

type EvalBakedDesign = {
  title: string;
  description: string | null;
  systemPrompt: string | null;
  bigIdea: string | null;
  essentialQuestions: string[];
  enduringUnderstandings: string[];
  lessons: {
    title: string;
    systemPrompt: string | null;
    durationMinutes: number | null;
    activities: EvalDesignActivity[];
  }[];
};

type EvalBakedActivity = {
  title: string;
  systemPrompt: string | null;
  deliverablePrompt: string | null;
  durationMinutes: number | null;
  design: EvalBakedDesign;
};

export const createEphemeralScholar = internalMutation({
  args: { readingLevel: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const suffix = Math.random().toString(36).slice(2, 8);
    return await ctx.db.insert("users", {
      name: `Eval Scholar ${suffix}`,
      username: `eval-bake-${suffix}`,
      role: "scholar",
      ...(args.readingLevel ? { readingLevel: args.readingLevel } : {}),
    });
  },
});

export const createEvalSeed = internalMutation({
  args: {
    scholarId: v.id("users"),
    topic: v.string(),
    domain: v.optional(v.string()),
    rationale: v.optional(v.string()),
    connectionTo: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert("seeds", {
      scholarId: args.scholarId,
      origin: "ai",
      status: "active",
      topic: args.topic,
      domain: args.domain,
      suggestionType: "frontier",
      rationale: args.rationale ?? "Eval bake.",
      connectionTo: args.connectionTo,
    });
  },
});

export const readBakedActivity = internalQuery({
  args: {
    unitId: v.id("units"),
    activityId: v.id("activities"),
  },
  handler: async (ctx, args): Promise<EvalBakedActivity | null> => {
    const unit = await ctx.db.get(args.unitId);
    const a = await ctx.db.get(args.activityId);
    if (!unit || !a) return null;
    const lessons = (
      await ctx.db
        .query("lessons")
        .withIndex("by_unit", (q) => q.eq("unitId", args.unitId))
        .collect()
    ).sort((left, right) => left.order - right.order);

    const designLessons: EvalBakedDesign["lessons"] = [];
    for (const lesson of lessons) {
      const activities = (
        await ctx.db
          .query("activities")
          .withIndex("by_lesson", (q) => q.eq("lessonId", lesson._id))
          .collect()
      ).sort((left, right) => left.order - right.order);
      designLessons.push({
        title: lesson.title,
        systemPrompt: lesson.systemPrompt ?? null,
        durationMinutes: lesson.durationMinutes ?? null,
        activities: activities.map((activity) => ({
          title: activity.title,
          description: activity.description ?? null,
          kind: activity.kind,
          systemPrompt: activity.systemPrompt ?? null,
          durationMinutes: activity.durationMinutes ?? null,
          deliverable: activity.deliverable
            ? {
                kind: activity.deliverable.kind,
                mode: activity.deliverable.mode,
                prompt: activity.deliverable.prompt,
                notes: activity.deliverable.notes ?? null,
                criteria: activity.deliverable.criteria.map((criterion) => ({
                  label: criterion.label,
                  description: criterion.description ?? null,
                })),
              }
            : null,
        })),
      });
    }

    return {
      title: a.title,
      systemPrompt: a.systemPrompt ?? null,
      deliverablePrompt: a.deliverable?.prompt ?? null,
      durationMinutes: a.durationMinutes ?? null,
      design: {
        title: unit.title,
        description: unit.description ?? null,
        systemPrompt: unit.systemPrompt ?? null,
        bigIdea: unit.bigIdea ?? null,
        essentialQuestions: unit.essentialQuestions?.map((question) => question.text) ?? [],
        enduringUnderstandings:
          unit.enduringUnderstandings?.map((understanding) => understanding.text) ?? [],
        lessons: designLessons,
      },
    };
  },
});

/**
 * Bake one topic end-to-end and return the produced activity + wall-clock
 * latency (the cost the in-place upgrade hides). Used by evals/seed-bake.
 */
export const bakeTopicForEval = internalAction({
  args: {
    topic: v.string(),
    domain: v.optional(v.string()),
    rationale: v.optional(v.string()),
    connectionTo: v.optional(v.string()),
    readingLevel: v.optional(v.string()),
  },
  handler: async (
    ctx,
    args,
  ): Promise<
    | {
        ok: true;
        ms: number;
        unitId: Id<"units">;
        activity: EvalBakedActivity;
      }
    | { ok: false; ms: number; reason: string }
  > => {
    const scholarId = await ctx.runMutation(internal.bakeEval.createEphemeralScholar, {
      readingLevel: args.readingLevel,
    });
    const seedId = await ctx.runMutation(internal.bakeEval.createEvalSeed, {
      scholarId,
      topic: args.topic,
      domain: args.domain,
      rationale: args.rationale,
      connectionTo: args.connectionTo,
    });

    const t0 = Date.now();
    const res = await ctx.runAction(internal.bakeUnitFromSeed.bakeUnitFromSeed, {
      seedId,
    });
    const ms = Date.now() - t0;

    if (!res.unitId) return { ok: false, ms, reason: "bake produced no unit" };
    const first = await ctx.runQuery(
      internal.bakeUnitFromSeed.firstOnlineActivityInUnit,
      { unitId: res.unitId },
    );
    if (!first) return { ok: false, ms, reason: "no online activity in baked unit" };
    const activity = await ctx.runQuery(internal.bakeEval.readBakedActivity, {
      unitId: res.unitId,
      activityId: first.activityId,
    });
    if (!activity) return { ok: false, ms, reason: "activity not found" };
    return { ok: true, ms, unitId: res.unitId, activity };
  },
});
