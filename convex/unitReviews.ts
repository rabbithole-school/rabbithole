// Durable coherence Review of a unit — the "Reviewed" rung of the
// maturity rail (review/curriculum-rehearse-and-maturity.md). Promotes
// the old ephemeral "Review unit" chat message into a re-runnable
// artifact: the EQ/EU ↔ activity coverage findings + the open-gap count
// that lights (or doesn't) the rail's Reviewed lamp.
//
// `record` is called by the Review tool/flow once it has computed the
// coverage. `latestForUnit` is the read the Rehearse tab uses to show the
// last Review without re-running it.

import { v } from "convex/values";
import { authedQuery, authedMutation } from "./lib/customFunctions";
import { internalMutation } from "./_generated/server";
import { requireUnitEditAccess } from "./lib/auth";
// One EQ/EU coverage row: which activities engage it, and the verdict.
const coverageRow = v.object({
  item: v.string(),
  kind: v.union(v.literal("essentialQuestion"), v.literal("enduringUnderstanding")),
  verdict: v.union(
    v.literal("covered"),
    v.literal("weak"),
    v.literal("uncovered"),
  ),
  activityTitles: v.optional(v.array(v.string())),
});

export const record = authedMutation({
  args: {
    unitId: v.id("units"),
    openGapCount: v.number(),
    summary: v.optional(
      v.object({
        coverage: v.optional(v.array(coverageRow)),
        // EQs/EUs the activities imply but the unit's lists are missing.
        missing: v.optional(v.array(v.string())),
        bloomGaps: v.optional(v.array(v.string())),
        note: v.optional(v.string()),
      }),
    ),
  },
  handler: async (ctx, args) => {
    const { user } = await requireUnitEditAccess(ctx, { unitId: args.unitId });
    if (args.openGapCount < 0) {
      throw new Error("openGapCount must be >= 0");
    }
    return await ctx.db.insert("unitReviews", {
      unitId: args.unitId,
      reviewedBy: user._id,
      reviewedAt: Date.now(),
      openGapCount: args.openGapCount,
      summary: args.summary,
    });
  },
});

// Internal variant for the Curriculum-Bot `record_unit_review` tool: the
// bot runs in an action with the teacher's id already resolved, so this
// trusts `reviewedBy` instead of re-deriving identity (same pattern as
// curriculumAssistant.*Internal). summary is v.any() — the bot's coverage
// findings are freeform and stored as-is (schema column is v.any() too).
export const recordInternal = internalMutation({
  args: {
    unitId: v.id("units"),
    reviewedBy: v.id("users"),
    openGapCount: v.number(),
    summary: v.optional(v.any()),
  },
  handler: async (ctx, args) => {
    if (args.openGapCount < 0) throw new Error("openGapCount must be >= 0");
    return await ctx.db.insert("unitReviews", {
      unitId: args.unitId,
      reviewedBy: args.reviewedBy,
      reviewedAt: Date.now(),
      openGapCount: args.openGapCount,
      summary: args.summary,
    });
  },
});

export const latestForUnit = authedQuery({
  args: { unitId: v.id("units") },
  handler: async (ctx, args) => {
    await requireUnitEditAccess(ctx, { unitId: args.unitId });
    return await ctx.db
      .query("unitReviews")
      .withIndex("by_unit", (q) => q.eq("unitId", args.unitId))
      .order("desc")
      .first();
  },
});

// Readiness gate (PR #1072 §8): the heuristic review is fired by pushing a
// prompt to the Curriculum Bot, so there's no durable in-flight row. Stamp
// `units.reviewStartedAt` when the teacher kicks it off so the gate can show a
// Spinner; it reads as "running" only while newer than the latest review.
export const markReviewStarted = authedMutation({
  args: { unitId: v.id("units") },
  handler: async (ctx, args) => {
    await requireUnitEditAccess(ctx, { unitId: args.unitId });
    await ctx.db.patch(args.unitId, { reviewStartedAt: Date.now() });
  },
});

// The scholar-bot rehearsal is expensive — let a teacher explicitly skip it
// (still counts toward "Ready"), or un-skip to bring the gate back.
export const setRehearsalSkipped = authedMutation({
  args: { unitId: v.id("units"), skipped: v.boolean() },
  handler: async (ctx, args) => {
    await requireUnitEditAccess(ctx, { unitId: args.unitId });
    await ctx.db.patch(args.unitId, {
      rehearsalSkippedAt: args.skipped ? Date.now() : undefined,
    });
  },
});

/**
 * PCM-coverage check (review/assessment-and-goals-plan.html §2/§4). Carl's
 * dependency: you can't assess a dimension unless the curriculum creates room
 * for it. This is a DETERMINISTIC read over the unit's lessons' `strand` (which
 * already enumerates the four PCM values) + their activities: for each
 * dimension, do any activities give a scholar the opportunity to produce
 * evidence? A unit that's all Core-shaped gets flagged at Review time — months
 * before the narrative is due. Rendered in the unit's Preflight/Review surface.
 */
export const pcmCoverage = authedQuery({
  args: { unitId: v.id("units") },
  handler: async (ctx, args) => {
    await requireUnitEditAccess(ctx, { unitId: args.unitId });
    const dims = ["core", "connections", "practice", "identity"] as const;

    const lessons = await ctx.db
      .query("lessons")
      .withIndex("by_unit", (q) => q.eq("unitId", args.unitId))
      .collect();

    const perDim: Record<
      string,
      { lessonCount: number; activityCount: number }
    > = {};
    for (const d of dims) perDim[d] = { lessonCount: 0, activityCount: 0 };
    let untagged = 0;

    for (const lesson of lessons) {
      const strand = lesson.strand;
      const activities = await ctx.db
        .query("activities")
        .withIndex("by_lesson", (q) => q.eq("lessonId", lesson._id))
        .collect();
      if (strand && dims.includes(strand as (typeof dims)[number])) {
        perDim[strand].lessonCount += 1;
        perDim[strand].activityCount += activities.length;
      } else {
        untagged += 1;
      }
    }

    const coverage = dims.map((d) => {
      const { lessonCount, activityCount } = perDim[d];
      const verdict =
        activityCount > 0 ? "covered" : lessonCount > 0 ? "weak" : "uncovered";
      return { dimension: d, lessonCount, activityCount, verdict };
    });
    const uncovered = coverage.filter((c) => c.verdict === "uncovered");
    const note =
      uncovered.length > 0
        ? `No activity gives scholars room to produce ${uncovered
            .map((c) => c.dimension)
            .join(", ")} evidence — add one before this unit's narratives are due.`
        : "Every PCM dimension has at least one activity that can produce evidence.";

    return { coverage, untaggedLessons: untagged, note };
  },
});
