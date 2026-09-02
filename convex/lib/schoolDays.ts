import type { Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import {
  closureForInstitutionOnDay,
  loadInstitutionClosures,
} from "../masterSchedule";
import { isClosedDay } from "../../shared/schoolClosures";
import {
  dayKeyForTimezone,
  dayStartForDayKey,
  shiftDayKey,
  weekdayForDayKey,
} from "../../shared/institutionDay";

/**
 * The next `count` weekdays that are not closed for this institution, in
 * ascending order, starting the day AFTER `dayKey`. Weekends and calendar
 * closures are skipped, so the window rolls into next week rather than
 * truncating at Friday — the stable horizon the scholar "Coming up" lookahead
 * needs regardless of which weekday it is read on.
 *
 * Closures have no duration limit (`schoolClosures.startDayKey…endDayKey` is an
 * inclusive range), so a closed candidate JUMPS to the day after the covering
 * closure's `endDayKey` rather than scanning day-by-day. That keeps the search
 * correct across arbitrarily long closures (e.g. a summer break > 60 days),
 * which a bounded calendar-offset scan would truncate. A safety cap on total
 * iterations still guarantees termination if an institution were closed
 * indefinitely.
 */
export async function nextOpenSchoolDayKeys(
  ctx: QueryCtx,
  institutionId: Id<"institutions"> | undefined,
  dayKey: string,
  timeZone: string,
  count: number,
  opts?: { maxCalendarDays?: number },
): Promise<string[]> {
  void timeZone;
  const closures = await loadInstitutionClosures(ctx, institutionId);
  const out: string[] = [];
  // Optional calendar horizon: callers that encode a product contract like
  // "tonight's boundary looks at most two weeks ahead" (the historical
  // nextOpenSchoolDayKey behavior) pass maxCalendarDays; forecast/default
  // callers omit it and search across closures of any length.
  const lastCandidate =
    opts?.maxCalendarDays != null
      ? shiftDayKey(dayKey, opts.maxCalendarDays)
      : null;
  let candidate = shiftDayKey(dayKey, 1);
  // Bound purely as a termination guard for a hypothetically always-closed
  // institution; a normal search exits via `out.length >= count` long before.
  for (let iterations = 0; iterations < 5000 && out.length < count; iterations += 1) {
    if (lastCandidate != null && candidate > lastCandidate) break;
    const weekday = weekdayForDayKey(candidate);
    if (weekday === 0 || weekday === 6) {
      candidate = shiftDayKey(candidate, 1);
      continue;
    }
    const closure = isClosedDay(candidate, closures);
    if (closure) {
      // Jump past the whole closure range in one step, honoring closures of any
      // length. `endDayKey` is inclusive, so resume the day after it (or after
      // `candidate` when the row is stored end-before-start).
      const jumpTo =
        closure.endDayKey >= candidate ? closure.endDayKey : candidate;
      candidate = shiftDayKey(jumpTo, 1);
      continue;
    }
    out.push(candidate);
    candidate = shiftDayKey(candidate, 1);
  }
  return out;
}

/** The next weekday that is not closed for this institution, looking at most
 *  14 calendar days ahead. The bounded horizon is a deliberate product
 *  contract for the "tonight" boundary (takeHomePlans, todayScheduleForSelf):
 *  deep inside a long closure there is no meaningful "next open school day",
 *  and returning null keeps far-future homework out of tonight's list. The
 *  unbounded search lives in {@link nextOpenSchoolDayKeys} /
 *  {@link nextOpenSchoolDayEndAt} for forecast and due-date-default callers. */
export async function nextOpenSchoolDayKey(
  ctx: QueryCtx,
  institutionId: Id<"institutions"> | undefined,
  dayKey: string,
  timeZone: string,
): Promise<string | null> {
  const [first] = await nextOpenSchoolDayKeys(
    ctx,
    institutionId,
    dayKey,
    timeZone,
    1,
    { maxCalendarDays: 14 },
  );
  return first ?? null;
}

/** The most recent PRIOR weekday that is not closed for this institution. The
 *  backward twin of {@link nextOpenSchoolDayKey}, used to name "homework that
 *  was due by this morning" (the prior open school day). A bounded backward
 *  scan is deliberate: right after a long closure there is no meaningful
 *  "last night", and returning null renders an empty morning-after lane. */
export async function prevOpenSchoolDayKey(
  ctx: QueryCtx,
  institutionId: Id<"institutions">,
  dayKey: string,
  timeZone: string,
): Promise<string | null> {
  for (let offset = 1; offset <= 14; offset += 1) {
    const candidate = shiftDayKey(dayKey, -offset);
    const weekday = weekdayForDayKey(candidate);
    if (weekday === 0 || weekday === 6) continue;
    const atMs = dayStartForDayKey(candidate, timeZone);
    if (!(await closureForInstitutionOnDay(ctx, institutionId, atMs))) {
      return candidate;
    }
  }
  return null;
}

/** Last millisecond of an institution-local calendar day. */
export function schoolDayEndAt(dayKey: string, timeZone: string): number {
  return dayStartForDayKey(shiftDayKey(dayKey, 1), timeZone) - 1;
}

/**
 * The default homework deadline: end of the next weekday the institution is
 * open, derived from the institution calendar rather than a fixed duration.
 */
export async function nextOpenSchoolDayEndAt(
  ctx: QueryCtx,
  institutionId: Id<"institutions"> | undefined,
  fromMs: number,
  timeZone: string,
): Promise<{ dayKey: string; dueAt: number }> {
  // Unbounded deliberately: a teacher assigning homework right before or
  // during a long closure still deserves a real default (the first day back),
  // unlike the 14-day-capped "tonight" boundary in nextOpenSchoolDayKey.
  const [dayKey] = await nextOpenSchoolDayKeys(
    ctx,
    institutionId,
    dayKeyForTimezone(fromMs, timeZone),
    timeZone,
    1,
  );
  if (!dayKey) {
    throw new Error("No open school day found.");
  }
  return { dayKey, dueAt: schoolDayEndAt(dayKey, timeZone) };
}
