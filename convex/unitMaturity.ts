// Unit maturity query — assembles the real-data inputs for the maturity
// rail and runs the pure `computeUnitMaturity`. See
// review/curriculum-rehearse-and-maturity.md and lib/unitMaturity.ts.

import { v } from "convex/values";
import { authedQuery } from "./lib/customFunctions";
import { requireUnitEditAccess } from "./lib/auth";
import {
  activityNodeStatus,
  computeUnitMaturity,
  deriveReadiness,
  unitReadinessInput,
  REHEARSE_PASS_FITNESS,
  rollupNodeStatus,
  unitNodeStatus,
  type MaturityInput,
  type NodeStatus,
  type Readiness,
} from "./lib/unitMaturity";
import { granuleTexts } from "./lib/granules";

export const getForUnit = authedQuery({
  args: { unitId: v.id("units") },
  handler: async (ctx, args): Promise<ReturnType<typeof computeUnitMaturity>> => {
    const { unit } = await requireUnitEditAccess(ctx, { unitId: args.unitId });

    const lessons = await ctx.db
      .query("lessons")
      .withIndex("by_unit", (q) => q.eq("unitId", args.unitId))
      .collect();

    // Online activities are the only kind a sim can rehearse; the rail's
    // Rehearsed/Debriefed lamps roll up across them.
    const activityLists = await Promise.all(
      lessons.map((l) =>
        ctx.db
          .query("activities")
          .withIndex("by_lesson", (q) => q.eq("lessonId", l._id))
          .collect(),
      ),
    );
    const online = activityLists.flat().filter((a) => a.kind === "online");

    let passing = 0;
    let grounded = 0;
    let trustworthy = 0;
    for (const a of online) {
      const variants = await ctx.db
        .query("curriculumVariants")
        .withIndex("by_activity", (q) => q.eq("activityId", a._id))
        .collect();
      const bestFitness = variants.reduce((max, variant) => {
        const f = (variant.aggregateScores as { fitness?: number } | undefined)
          ?.fitness;
        return typeof f === "number" && f > max ? f : max;
      }, Number.NEGATIVE_INFINITY);
      if (bestFitness >= REHEARSE_PASS_FITNESS) passing++;

      const experiments = await ctx.db
        .query("curriculumExperiments")
        .withIndex("by_activity", (q) => q.eq("activityId", a._id))
        .collect();
      const groundedExps = experiments.filter(
        (e) => e.grounding && typeof e.grounding === "object",
      );
      if (groundedExps.length > 0) {
        grounded++;
        if (
          groundedExps.some(
            (e) => (e.grounding as { trustworthy?: boolean }).trustworthy === true,
          )
        ) {
          trustworthy++;
        }
      }
    }

    const latestReview = await ctx.db
      .query("unitReviews")
      .withIndex("by_unit", (q) => q.eq("unitId", args.unitId))
      .order("desc")
      .first();

    const assignments = await ctx.db
      .query("assignments")
      .withIndex("by_unit", (q) => q.eq("unitId", args.unitId))
      .collect();
    const activeCount = assignments.filter((a) => !a.archivedAt).length;

    const input: MaturityInput = {
      unit: {
        bigIdea: unit.bigIdea,
        essentialQuestions: granuleTexts(unit.essentialQuestions),
        enduringUnderstandings: granuleTexts(unit.enduringUnderstandings),
      },
      lessons,
      review: latestReview ? { openGapCount: latestReview.openGapCount } : null,
      rehearsal: { onlineCount: online.length, passing },
      assignment: { activeCount },
      grounding:
        grounded > 0
          ? { groundedCount: grounded, trustworthyCount: trustworthy }
          : null,
    };

    return computeUnitMaturity(input);
  },
});

// Per-node coarse status for the whole tree — drives the outline status
// dots (replacing the duration tags) and each node's vertical Summary
// timeline. One subscription for the unit, every lesson, and every
// activity. Activity-grained because rehearsal/debrief are; the unit dot
// rolls up via the full maturity ladder. See lib/unitMaturity.ts and
// review/curriculum-rehearse-and-maturity.md.
export const getNodeStatuses = authedQuery({
  args: { unitId: v.id("units") },
  handler: async (
    ctx,
    args,
  ): Promise<{
    unit: NodeStatus;
    unitAssigned: boolean;
    lessons: Record<string, NodeStatus>;
    activities: Record<string, NodeStatus>;
    activitiesAssigned: Record<string, boolean>;
    readiness: {
      unit: Readiness;
      lessons: Record<string, Readiness>;
      activities: Record<string, Readiness>;
    };
  }> => {
    const { unit } = await requireUnitEditAccess(ctx, { unitId: args.unitId });

    const lessons = await ctx.db
      .query("lessons")
      .withIndex("by_unit", (q) => q.eq("unitId", args.unitId))
      .collect();

    const activityLists = await Promise.all(
      lessons.map((l) =>
        ctx.db
          .query("activities")
          .withIndex("by_lesson", (q) => q.eq("lessonId", l._id))
          .collect(),
      ),
    );

    // Readiness gate (PR #1072 §8) runtime flags. The heuristic review is
    // fired-and-forgotten at the Curriculum Bot, so "running" = a start stamp
    // newer than the latest durable review. The expensive scholar-bot
    // rehearsal can be explicitly skipped (per unit) and still count as Ready.
    const latestReview = await ctx.db
      .query("unitReviews")
      .withIndex("by_unit", (q) => q.eq("unitId", args.unitId))
      .order("desc")
      .first();
    const unitReviewRunning =
      typeof unit.reviewStartedAt === "number" &&
      unit.reviewStartedAt > (latestReview?.reviewedAt ?? 0);
    const unitRehearsalSkipped = typeof unit.rehearsalSkippedAt === "number";
    const reviewInput = latestReview
      ? { openGapCount: latestReview.openGapCount }
      : null;

    const activities: Record<string, NodeStatus> = {};
    const activitiesReadiness: Record<string, Readiness> = {};
    // Per-activity "assigned" = ≥1 real (non-test-drive) scholar session —
    // the bridge fact the activity's Debrief rung needs.
    const activitiesAssigned: Record<string, boolean> = {};
    const lessonChildren: Record<string, NodeStatus[]> = {};
    const lessonReadiness: Record<string, Readiness> = {};
    // Unit-level rollup counts, reused for computeUnitMaturity below so we
    // don't re-walk the same variant/experiment rows.
    let onlineCount = 0;
    let passing = 0;
    let grounded = 0;
    let trustworthy = 0;
    let anyRehearsalRunning = false;

    for (let i = 0; i < lessons.length; i++) {
      const lesson = lessons[i];
      const kids: NodeStatus[] = [];
      let lessonOnline = 0;
      let lessonPassing = 0;
      let lessonRehearsalRunning = false;
      for (const a of activityLists[i]) {
        const isOnline = a.kind === "online";
        const contributesToRollup = a.archivedAt == null;
        let bestFitness: number | null = null;
        let isGrounded = false;
        let isTrustworthy = false;
        let activityRehearsalRunning = false;
        let activityPassing = false;
        if (isOnline) {
          if (contributesToRollup) {
            onlineCount++;
            lessonOnline++;
          }
          const variants = await ctx.db
            .query("curriculumVariants")
            .withIndex("by_activity", (q) => q.eq("activityId", a._id))
            .collect();
          for (const variant of variants) {
            const f = (
              variant.aggregateScores as { fitness?: number } | undefined
            )?.fitness;
            if (typeof f === "number") {
              bestFitness = bestFitness === null ? f : Math.max(bestFitness, f);
            }
          }
          if (bestFitness !== null && bestFitness >= REHEARSE_PASS_FITNESS) {
            activityPassing = true;
            if (contributesToRollup) {
              passing++;
              lessonPassing++;
            }
          }

          const experiments = await ctx.db
            .query("curriculumExperiments")
            .withIndex("by_activity", (q) => q.eq("activityId", a._id))
            .collect();
          activityRehearsalRunning = experiments.some(
            (e) => e.status === "running",
          );
          if (activityRehearsalRunning && contributesToRollup) {
            lessonRehearsalRunning = true;
            anyRehearsalRunning = true;
          }
          const groundedExps = experiments.filter(
            (e) => e.grounding && typeof e.grounding === "object",
          );
          if (groundedExps.length > 0) {
            isGrounded = true;
            isTrustworthy = groundedExps.some(
              (e) =>
                (e.grounding as { trustworthy?: boolean }).trustworthy === true,
            );
            if (contributesToRollup) {
              grounded++;
              if (isTrustworthy) trustworthy++;
            }
          }

          // "Assigned" for an online activity = a real scholar has worked on
          // it (a non-test-drive session). The bridge fact for its Debrief
          // rung. Cheap existence check via the by_activity index.
          const realSession = await ctx.db
            .query("sessions")
            .withIndex("by_activity", (q) => q.eq("activityId", a._id))
            .filter((q) =>
              q.and(
                q.neq(q.field("isTestDrive"), true),
                q.neq(q.field("isOffline"), true),
              ),
            )
            .first();
          activitiesAssigned[String(a._id)] = realSession !== null;
        }
        const status = activityNodeStatus({
          isOnline,
          bestFitness,
          grounded: isGrounded,
          trustworthy: isTrustworthy,
        });
        activities[String(a._id)] = status;
        // Per-activity Readiness — "Built" = an online activity carries a
        // system prompt; offline activities have nothing to build/rehearse.
        activitiesReadiness[String(a._id)] = deriveReadiness({
          built: isOnline ? !!a.systemPrompt?.trim() : true,
          builtDetail: isOnline
            ? a.systemPrompt?.trim()
              ? "Built"
              : "No system prompt"
            : "Built",
          review: reviewInput,
          reviewRunning: unitReviewRunning,
          rehearsal: isOnline
            ? { onlineCount: 1, passing: activityPassing ? 1 : 0 }
            : { onlineCount: 0, passing: 0 },
          rehearsalRunning: activityRehearsalRunning,
          rehearsalSkipped: unitRehearsalSkipped,
        });
        if (contributesToRollup) kids.push(status);
      }
      lessonChildren[String(lesson._id)] = kids;
      lessonReadiness[String(lesson._id)] = deriveReadiness({
        built: !!lesson.systemPrompt?.trim(),
        builtDetail: lesson.systemPrompt?.trim() ? "Built" : "No system prompt",
        review: reviewInput,
        reviewRunning: unitReviewRunning,
        rehearsal: { onlineCount: lessonOnline, passing: lessonPassing },
        rehearsalRunning: lessonRehearsalRunning,
        rehearsalSkipped: unitRehearsalSkipped,
      });
    }

    const lessonStatuses: Record<string, NodeStatus> = {};
    for (const l of lessons) {
      lessonStatuses[String(l._id)] = rollupNodeStatus(
        lessonChildren[String(l._id)] ?? [],
      );
    }

    const unitAssignments = await ctx.db
      .query("assignments")
      .withIndex("by_unit", (q) => q.eq("unitId", args.unitId))
      .collect();
    const activeAssignments = unitAssignments.filter((a) => !a.archivedAt).length;

    const maturityInput: MaturityInput = {
      unit: {
        bigIdea: unit.bigIdea,
        essentialQuestions: granuleTexts(unit.essentialQuestions),
        enduringUnderstandings: granuleTexts(unit.enduringUnderstandings),
      },
      lessons,
      review: reviewInput,
      rehearsal: { onlineCount, passing },
      assignment: { activeCount: activeAssignments },
      grounding:
        grounded > 0
          ? { groundedCount: grounded, trustworthyCount: trustworthy }
          : null,
    };
    const maturity = computeUnitMaturity(maturityInput);

    const unitReadiness = deriveReadiness(
      unitReadinessInput(maturity, maturityInput, {
        reviewRunning: unitReviewRunning,
        rehearsalRunning: anyRehearsalRunning,
        rehearsalSkipped: unitRehearsalSkipped,
      }),
    );

    return {
      unit: unitNodeStatus(maturity.currentStageId),
      unitAssigned: activeAssignments > 0,
      lessons: lessonStatuses,
      activities,
      activitiesAssigned,
      readiness: {
        unit: unitReadiness,
        lessons: lessonReadiness,
        activities: activitiesReadiness,
      },
    };
  },
});
