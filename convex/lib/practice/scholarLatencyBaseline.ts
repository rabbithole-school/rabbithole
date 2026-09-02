import type { Id } from "../../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../../_generated/server";
import { latencyBaselineFromSkillMedians } from "./scheduler";

/**
 * The canonical fact-automaticity baseline for one scholar. Its scope is ALL
 * `practiceMastery` rows across every domain, so sprint selection and teacher
 * projections cannot disagree because a composition branch loaded a subset.
 */
export async function scholarLatencyBaseline(
  ctx: QueryCtx | MutationCtx,
  scholarId: Id<"users">,
): Promise<number | undefined> {
  const masteryRows = await ctx.db
    .query("practiceMastery")
    .withIndex("by_scholar", (q) => q.eq("scholarId", scholarId))
    .collect();
  return latencyBaselineFromSkillMedians(
    masteryRows.map((row) => row.latencyMedianMs ?? NaN),
  );
}
