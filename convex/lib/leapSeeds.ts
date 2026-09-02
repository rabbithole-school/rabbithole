// The cohort's Interpretive stars — the shared read for the roster-wide
// Interpretive surfaces (the Class Galaxy and the Trophy Case).
//
// A seed is included if it's an Interpretive-constellation star
// (`sourceLens === "interpretive"`) OR explicitly typed `"leap"` (the
// observer can emit a bare leap with no lens), and it isn't dismissed.
//
// We read that subset via two NARROW indexes and union them, rather than
// `query("seeds").collect()` over the whole table. That matters because
// these are reactive `teacherQuery` subscriptions on always-on kiosk
// displays:
//   • read-bound — reads scale with the (small) Interpretive-star subset,
//     not with every observer/teacher seed in the school, so they never hit
//     the per-query document read limit as the table grows; and
//   • invalidation-bound — an unrelated seed write (an observer frontier
//     seed, a teacher suggestion) no longer re-runs them for every client.

import type { QueryCtx } from "../_generated/server";
import type { Doc } from "../_generated/dataModel";

/** All non-dismissed Interpretive stars across the roster (deduped). */
export async function collectInterpretiveStars(
  ctx: QueryCtx,
): Promise<Doc<"seeds">[]> {
  const [interpretive, leaps] = await Promise.all([
    ctx.db
      .query("seeds")
      .withIndex("by_sourceLens", (q) => q.eq("sourceLens", "interpretive"))
      .collect(),
    ctx.db
      .query("seeds")
      .withIndex("by_suggestionType", (q) => q.eq("suggestionType", "leap"))
      .collect(),
  ]);
  const byId = new Map<string, Doc<"seeds">>();
  for (const s of interpretive) byId.set(s._id, s);
  for (const s of leaps) byId.set(s._id, s);
  return [...byId.values()].filter((s) => s.status !== "dismissed");
}
