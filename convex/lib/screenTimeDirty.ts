// Mark a scholar-day's screen-time summary as stale (convex/screenTimeDays.ts).
// The write path calls this on every device-activity batch; only the call that
// INSERTS the mark schedules the recompute, so the recompute runs at most once
// per SCREEN_TIME_RECOMPUTE_DELAY_MS for a scholar who keeps using their
// BunnyPad. A mark is per scholar, day AND school (the school the device
// stamps its events with), matching the summary row it refreshes.

import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { internal } from "../_generated/api";

/** How long after the first new activity a scholar-day's summary is redone. */
export const SCREEN_TIME_RECOMPUTE_DELAY_MS = 2 * 60_000;
/**
 * A mark this old outlived its recompute, which must have failed (its delete
 * of the mark rolled back with it): the next batch schedules a fresh one.
 */
export const SCREEN_TIME_STALE_MARK_MS = 10 * 60_000;

export async function markScreenTimeDirty(
  ctx: MutationCtx,
  scholarId: Id<"users">,
  dayKey: string,
  institutionId: Id<"institutions"> | undefined,
): Promise<boolean> {
  // Events with no school are in no school's read, so there is no row to refresh.
  if (!institutionId) return false;
  const now = Date.now();
  const pending = (
    await ctx.db
      .query("screenTimeDirty")
      .withIndex("by_scholar_day", (q) => q.eq("scholarId", scholarId).eq("dayKey", dayKey))
      .collect()
  ).find((mark) => mark.institutionId === institutionId);
  if (pending && now - pending.markedAt < SCREEN_TIME_STALE_MARK_MS) return false;
  if (pending) await ctx.db.patch(pending._id, { markedAt: now });
  else {
    await ctx.db.insert("screenTimeDirty", { scholarId, dayKey, institutionId, markedAt: now });
  }
  await ctx.scheduler.runAfter(
    SCREEN_TIME_RECOMPUTE_DELAY_MS,
    internal.screenTimeDays.recompute,
    { scholarId, dayKey, institutionId },
  );
  return true;
}
