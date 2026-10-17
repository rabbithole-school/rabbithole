// Sessions signal query — the field record (PR #1072 §7). Assembles per-activity
// real-session counts + judged fitness from the `sessions` and
// `groundedSessionVerdicts` tables and rolls them up activity → lesson → unit
// with the pure `rollupSessions`. One subscription for the whole tree, mirroring
// `unitMaturity.getNodeStatuses`.

import { v } from "convex/values";
import { authedQuery } from "./lib/customFunctions";
import { canGroundUnit, requireUnitEditAccess } from "./lib/auth";
import { MIN_REAL_N_WITHOUT_GROUNDING } from "./lib/curriculumGround";
import type { QueryCtx } from "./_generated/server";
import { curriculumRunnerScopeForUnit } from "./lib/curriculumRun";
import type { Id } from "./_generated/dataModel";
import {
  activitySessions,
  rollupSessions,
  EMPTY_SESSIONS,
  type SessionsSignal,
} from "./lib/activitySessions";

/** One activity's real-session numbers from the DB. A "real" session is a
 *  non-test-drive session stamped with an assignment (a genuine cohort run);
 *  active = no completion yet, complete = `activityCompletedAt` set. */
async function activitySignal(
  ctx: QueryCtx,
  activityId: Id<"activities">,
  canGround: boolean,
  // curriculum:run: only sessions under her own runnable assignments count
  // (null = unscoped, everyone else's existing behavior).
  runnerScope: Set<string> | null,
): Promise<SessionsSignal> {
  const sessions = await ctx.db
    .query("sessions")
    .withIndex("by_activity", (q) => q.eq("activityId", activityId))
    .filter((q) =>
      q.and(
        q.neq(q.field("isTestDrive"), true),
        q.neq(q.field("isOffline"), true),
      ),
    )
    .collect();
  const real = sessions.filter(
    (s) =>
      s.assignmentId != null &&
      (runnerScope === null || runnerScope.has(String(s.assignmentId))),
  );
  const realIds = new Set(real.map((s) => String(s._id)));
  let activeCount = 0;
  let completeCount = 0;
  for (const s of real) {
    if (s.activityCompletedAt != null) completeCount++;
    else activeCount++;
  }

  const verdicts = await ctx.db
    .query("groundedSessionVerdicts")
    .withIndex("by_activity", (q) => q.eq("activityId", activityId))
    .collect();
  const judged = verdicts
    // A runner's judged scores come only from her own runs' sessions.
    .filter((v) => runnerScope === null || realIds.has(String(v.sessionId)))
    .map((v) => v.fitness)
    .filter((f): f is number => typeof f === "number");
  // A unit editor without grounding rights (canGroundUnit) sees judged scores
  // only once enough sessions back them that no one scholar's score shows.
  const fitnesses =
    canGround || judged.length >= MIN_REAL_N_WITHOUT_GROUNDING ? judged : [];

  // The sims' prediction for the calibration overlay — the best rehearsal
  // fitness across this activity's variants (what §8's dashed "sim said" line
  // draws). Kept separate from the real mean; never fused into it.
  const variants = await ctx.db
    .query("curriculumVariants")
    .withIndex("by_activity", (q) => q.eq("activityId", activityId))
    .collect();
  let simMean: number | null = null;
  let simSessionCount = 0;
  for (const variant of variants) {
    const agg = variant.aggregateScores as
      | { fitness?: number; n?: number }
      | undefined;
    const f = agg?.fitness;
    if (typeof f === "number") {
      // Pair the count with the prediction we surface: `simMean` is the BEST
      // (max-fitness) variant, so `simSessionCount` is that variant's sim n.
      if (simMean === null || f > simMean) {
        simMean = f;
        simSessionCount = typeof agg?.n === "number" ? agg.n : 0;
      }
    }
  }

  return activitySessions({
    activeCount,
    completeCount,
    fitnesses,
    simMean,
    simSessionCount,
  });
}

export const getForUnit = authedQuery({
  args: { unitId: v.id("units") },
  handler: async (
    ctx,
    args,
  ): Promise<{
    unit: SessionsSignal;
    lessons: Record<string, SessionsSignal>;
    activities: Record<string, SessionsSignal>;
  }> => {
    const access = await requireUnitEditAccess(ctx, { unitId: args.unitId });
    const canGround = await canGroundUnit(ctx, access.user, access.unit);
    const runnerScope = await curriculumRunnerScopeForUnit(
      ctx,
      access.user,
      args.unitId,
    );

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

    const activities: Record<string, SessionsSignal> = {};
    const lessonSignals: Record<string, SessionsSignal> = {};

    for (let i = 0; i < lessons.length; i++) {
      const kids: SessionsSignal[] = [];
      for (const a of activityLists[i]) {
        const sig = await activitySignal(ctx, a._id, canGround, runnerScope);
        activities[String(a._id)] = sig;
        kids.push(sig);
      }
      lessonSignals[String(lessons[i]._id)] =
        kids.length > 0 ? rollupSessions(kids) : EMPTY_SESSIONS;
    }

    const unit = rollupSessions(Object.values(lessonSignals));

    return { unit, lessons: lessonSignals, activities };
  },
});
