import type { Id } from "../../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../../_generated/server";
import type { FactFluencyStats } from "./factFluency";
import { fastMathProgress, type FastMathProgress } from "./fastMath";
import { scholarLatencyBaseline } from "./scholarLatencyBaseline";

/**
 * One scholar's Fast Math readiness, read from the canonical substrate.
 *
 * Two index reads per scholar: their `factFluency` ledger (`by_scholar`) and —
 * inside `scholarLatencyBaseline` — their `practiceMastery` rows, the same
 * self-relative baseline the heatmap and the sprint selector use. Kept here,
 * beside the pure roll-up, so every automaticity READ computes readiness the
 * same way.
 *
 * `baselineKnown` is surfaced for the same reason the heatmap surfaces it: with
 * no baseline the classifier caps every fact at "practicing", so a 0% reading
 * means "not calibrated yet", not "slow".
 */
export async function loadFastMathProgress(
  ctx: QueryCtx | MutationCtx,
  scholarId: Id<"users">,
): Promise<FastMathProgress & { baselineKnown: boolean }> {
  const [factRows, baseline] = await Promise.all([
    ctx.db
      .query("factFluency")
      .withIndex("by_scholar", (q) => q.eq("scholarId", scholarId))
      .collect(),
    scholarLatencyBaseline(ctx, scholarId),
  ]);

  const statsByFactKey = new Map<string, FactFluencyStats>();
  for (const row of factRows) statsByFactKey.set(row.factKey, row);

  return {
    ...fastMathProgress({ statsByFactKey, baseline }),
    baselineKnown: baseline !== undefined,
  };
}
