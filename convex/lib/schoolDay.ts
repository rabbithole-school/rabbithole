// Is the scholar currently "at school"? A soft, surface-only gate: the physical
// inventory (rooms + gear the tutor may invite a scholar to use with their
// hands) is only offered to the tutor DURING the scholar's school day, derived
// from the Master Schedule bell blocks (`scheduleBlocks`) evaluated in the
// scholar's institution timezone. Off-hours → the equipment read in
// `getSessionContext` is skipped, so the PHYSICAL ENVIRONMENT prompt section and
// the `suggest_physical_task` tool are not offered. Fails CLOSED.

import type { Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { localWeekdayAndTime, isValidHHMM } from "./metaBlocks";
import { effectiveInstitutionTimeZone } from "./institutionTime";

export interface SchoolDayBlock {
  startLocal: string; // "08:30"
  endLocal: string; // "15:00"
  weekdays: number[]; // ISO: 1=Mon … 5=Fri, 7=Sun  (matches scheduleBlocks.weekdays AND localWeekdayAndTime's isoWeekday)
}

/**
 * True iff `nowMs`, evaluated in `timeZone`, falls within TODAY's school-day span
 * derived from the given bell blocks: [earliest startLocal, latest endLocal) among
 * the blocks scheduled for today's ISO weekday. Fails CLOSED — returns false when
 * there are no blocks for today (weekend, or a term with no configured schedule).
 * Half-open interval [start, end) matches isWithinPrepWindow.
 */
export function isWithinSchoolDay(
  blocks: SchoolDayBlock[],
  timeZone: string,
  nowMs: number,
): boolean {
  // isoWeekday 1..7 (Mon..Sun), hhmm "HH:MM"
  const { isoWeekday, hhmm } = localWeekdayAndTime(nowMs, timeZone);
  const today = blocks.filter(
    (b) =>
      Array.isArray(b.weekdays) &&
      b.weekdays.includes(isoWeekday) &&
      isValidHHMM(b.startLocal) &&
      isValidHHMM(b.endLocal) &&
      b.endLocal > b.startLocal,
  );
  if (today.length === 0) return false; // fail closed
  // "HH:MM" strings compare lexicographically == chronologically.
  const start = today.reduce((m, b) => (b.startLocal < m ? b.startLocal : m), today[0].startLocal);
  const end = today.reduce((m, b) => (b.endLocal > m ? b.endLocal : m), today[0].endLocal);
  return hhmm >= start && hhmm < end;
}

/**
 * Resolve whether an institution is currently within its school day, deriving the
 * span from the Master Schedule (scheduleBlocks) of its active reporting period.
 * Fails CLOSED (false) when there is no active period or no blocks scheduled for
 * today. Read-only.
 */
export async function isInstitutionInSchoolDay(
  ctx: QueryCtx,
  institutionId: Id<"institutions">,
  timeZone: string,
  nowMs: number,
): Promise<boolean> {
  // Active reporting period for this institution. Mirror reportingPeriods.current's
  // status preference ("writing" ?? "open") but WITHOUT the staffQuery auth wrapper,
  // scoped to the institution. A period with institutionId === undefined (a global
  // period) is also considered visible. Query the two index ranges independently,
  // then restore their shared creation order before choosing the active period.
  const [scoped, global] = await Promise.all([
    ctx.db
      .query("reportingPeriods")
      .withIndex("by_institution", (q) => q.eq("institutionId", institutionId))
      .order("asc")
      .collect(),
    ctx.db
      .query("reportingPeriods")
      .withIndex("by_institution", (q) => q.eq("institutionId", undefined))
      .order("asc")
      .collect(),
  ]);
  const visible = [...scoped, ...global].sort(
    (a, b) =>
      a._creationTime - b._creationTime ||
      String(a._id).localeCompare(String(b._id)),
  );
  const active =
    visible.find((p) => p.status === "writing") ??
    visible.find((p) => p.status === "open") ??
    null;
  if (!active) return false; // fail closed

  const blocks = await ctx.db
    .query("scheduleBlocks")
    .withIndex("by_period", (q) => q.eq("periodId", active._id))
    .collect();

  return isWithinSchoolDay(
    blocks.map((b) => ({
      startLocal: b.startLocal,
      endLocal: b.endLocal,
      weekdays: b.weekdays,
    })),
    timeZone,
    nowMs,
  );
}

/**
 * Compatibility wrapper for scholar callers. Loads the scholar and institution
 * once, then delegates the schedule lookup to the institution-level predicate.
 */
export async function isScholarInSchoolDay(
  ctx: QueryCtx,
  scholarId: Id<"users">,
  nowMs: number,
): Promise<boolean> {
  const scholar = await ctx.db.get(scholarId);
  const institutionId = scholar?.institutionId ?? null;
  if (!institutionId) return false; // fail closed — no school, no school day
  const institution = await ctx.db.get(institutionId);

  return await isInstitutionInSchoolDay(
    ctx,
    institutionId,
    effectiveInstitutionTimeZone(institution?.timeZone),
    nowMs,
  );
}
