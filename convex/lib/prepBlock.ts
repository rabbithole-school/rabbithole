// The single source of truth for WHEN "Scholar's Prep" happens (Move 5 ruling).
//
// The master-schedule bell block (a kind:"prep" `scheduleBlocks` row) and the
// group's "Scholar's Prep" ritual are THE SAME THING; we were merely
// inconsistent about naming. So the bell schedule owns the window, and both the
// scholar-facing Workshop pin (metaChat) and Special Delivery's print timing
// resolve prep blocks through here — they can never disagree about the clock.
//
// The group's `scholarGroups.dailyBlocks` "prepTime" entry degrades to pure
// PARTICIPATION ("does this pod run the ritual?"); its start/end times are no
// longer read (see metaBlocks.participatesInPrep).

import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { effectiveInstitutionTimeZone } from "./institutionTime";
import { PREP_TIME_KEY, type DailyBlock } from "./metaBlocks";

type DbCtx = QueryCtx | MutationCtx;

/**
 * The active reporting period ("Term") for an institution — a "writing" or
 * "open" period scoped to it, else a global (institution-less) one. Mirrors the
 * status preference the other schedule surfaces already use (specialDelivery's
 * former inline resolution; lib/schoolDay's school-day span).
 */
export async function activePrepPeriod(
  ctx: DbCtx,
  institutionId: Id<"institutions">,
): Promise<Doc<"reportingPeriods"> | null> {
  const periods = await ctx.db.query("reportingPeriods").collect();
  return (
    periods.find(
      (row) =>
        row.institutionId === institutionId &&
        (row.status === "writing" || row.status === "open"),
    ) ??
    periods.find(
      (row) =>
        row.institutionId === undefined &&
        (row.status === "writing" || row.status === "open"),
    ) ??
    null
  );
}

/**
 * The institution's kind:"prep" bell blocks for its active reporting period.
 * Pass `weekday` (ISO 1=Mon … 7=Sun) to keep only blocks scheduled for that day
 * — the exact filter Special Delivery uses for today's print timing. Returns []
 * when there is no active period or no prep block.
 */
export async function prepScheduleBlocks(
  ctx: DbCtx,
  institutionId: Id<"institutions">,
  opts?: { weekday?: number },
): Promise<Doc<"scheduleBlocks">[]> {
  const period = await activePrepPeriod(ctx, institutionId);
  if (!period) return [];
  return (
    await ctx.db
      .query("scheduleBlocks")
      .withIndex("by_period", (q) => q.eq("periodId", period._id))
      .collect()
  ).filter(
    (block) =>
      block.kind === "prep" &&
      (opts?.weekday === undefined || block.weekdays.includes(opts.weekday)),
  );
}

/**
 * Deterministically pick the institution-wide Scholar's Prep block among the
 * period's prep blocks: prefer the SHARED (non-group-override) rows, then order
 * by (order, startLocal, _id). One shared prep block is the norm; the sort just
 * makes any multi-block config deterministic instead of "first row wins" — the
 * arbitrary pick this ruling deletes.
 */
export function pickCanonicalPrepBlock(
  blocks: Doc<"scheduleBlocks">[],
): Doc<"scheduleBlocks"> | null {
  if (blocks.length === 0) return null;
  const shared = blocks.filter((b) => !b.groupId);
  const pool = shared.length > 0 ? shared : blocks;
  return [...pool].sort(
    (a, b) =>
      a.order - b.order ||
      a.startLocal.localeCompare(b.startLocal) ||
      String(a._id).localeCompare(String(b._id)),
  )[0];
}

/**
 * Adapt a bell-schedule prep block to the WINDOW shape the Workshop clients
 * expect (`startLocal`/`endLocal`/`days`/`timezone`/`label`, keyed "prepTime"),
 * so `isWithinPrepWindow` and `formatLocalTimeLabel` consume it unchanged. The
 * adapter is the one careful seam between the two encodings: `scheduleBlocks`
 * carries a `weekdays` array + the institution/period timezone, while the old
 * `dailyBlocks` carried `days` + its own timezone. Both weekday encodings are
 * ISO 1=Mon … 7=Sun, so it's a rename plus the institution timezone.
 */
export function prepBlockToWindow(
  block: Pick<
    Doc<"scheduleBlocks">,
    "label" | "startLocal" | "endLocal" | "weekdays"
  >,
  timezone: string,
): DailyBlock {
  return {
    key: PREP_TIME_KEY,
    label: block.label,
    startLocal: block.startLocal,
    endLocal: block.endLocal,
    days: block.weekdays,
    timezone,
  };
}

/**
 * The institution's canonical Scholar's Prep WINDOW (all its weekdays), or null
 * when the institution has no active period / no prep block. This is the single
 * "when does Scholar's Prep happen" answer the whole app reasons about; the
 * client still owns the same-day time-window math (isWithinPrepWindow).
 */
export async function canonicalPrepWindow(
  ctx: DbCtx,
  institutionId: Id<"institutions">,
): Promise<DailyBlock | null> {
  const block = pickCanonicalPrepBlock(
    await prepScheduleBlocks(ctx, institutionId),
  );
  if (!block) return null;
  const institution = await ctx.db.get(institutionId);
  return prepBlockToWindow(block, effectiveInstitutionTimeZone(institution?.timeZone));
}
