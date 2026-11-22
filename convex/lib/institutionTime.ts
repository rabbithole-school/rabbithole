import type { Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { resolveActiveMembership } from "./access";
import { scholarInstitutionId } from "./scholarEnrollment";
import {
  DEFAULT_TIMEZONE,
  dayKeyForTimezone,
  isValidTimeZone,
} from "../../shared/institutionDay";

export function effectiveInstitutionTimeZone(timeZone?: string): string {
  // This is a static legacy-calendar default, never a lookup of the primary
  // institution. A second school with an unset/invalid value cannot inherit
  // another school's timezone.
  return timeZone && isValidTimeZone(timeZone)
    ? timeZone
    : DEFAULT_TIMEZONE;
}

export async function timeZoneForInstitution(
  ctx: Pick<QueryCtx, "db">,
  institutionId?: Id<"institutions">,
): Promise<string> {
  const institution = institutionId ? await ctx.db.get(institutionId) : null;
  return effectiveInstitutionTimeZone(institution?.timeZone);
}

export async function timeZoneForScholar(
  ctx: QueryCtx,
  scholarId: Id<"users">,
): Promise<string> {
  const scholar = await ctx.db.get(scholarId);
  if (!scholar) throw new Error("Scholar not found");

  return timeZoneForInstitution(
    ctx,
    await scholarInstitutionId(ctx, scholarId),
  );
}

/** How far a device clock may sit from the server's at institution midnight. */
export const DAY_KEY_CLOCK_SKEW_MS = 15 * 60 * 1000;

/**
 * The institution-local day a day-scoped query answers for, given the `dayKey`
 * its client sent (T11, TRA-420).
 *
 * Clients compute `dayKey` with `useInstitutionDay`: the institution's time zone
 * read on the device clock, re-armed at institution midnight. A query that
 * answers for THAT day returns a function of its args, so its subscription
 * cannot hold yesterday's answer under today's key. That happened when the
 * server derived the day itself: a client whose midnight landed a moment before
 * the server's re-subscribed while the server still saw yesterday, and that
 * result stayed cached until some unrelated write happened to re-run it.
 *
 * The server clock only bounds the request: the server's own day, or the
 * neighbouring day within {@link DAY_KEY_CLOCK_SKEW_MS} of institution
 * midnight. So tomorrow's planned work leaves the server at most a few minutes
 * early, and a hand-made key can read nothing further. An awake client with a
 * sane clock always lands inside the bound, so the clock never decides its
 * answer. Outside it, `honored` is false and `dayKey` is the server's own day;
 * the caller picks whichever fallback suits it.
 */
export function institutionDayForRequest(
  requested: string,
  timeZone: string,
): { dayKey: string; honored: boolean } {
  const now = Date.now();
  const serverDayKey = dayKeyForTimezone(now, timeZone);
  const honored =
    requested === serverDayKey ||
    requested === dayKeyForTimezone(now - DAY_KEY_CLOCK_SKEW_MS, timeZone) ||
    requested === dayKeyForTimezone(now + DAY_KEY_CLOCK_SKEW_MS, timeZone);
  return { dayKey: honored ? requested : serverDayKey, honored };
}

/** Resolve timezone for work performed in the caller's staff context. */
export async function timeZoneForStaff(
  ctx: QueryCtx,
  userId: Id<"users">,
): Promise<string> {
  const user = await ctx.db.get(userId);
  if (!user) throw new Error("User not found");
  return timeZoneForInstitution(
    ctx,
    user.institutionId ?? (await resolveActiveMembership(ctx, user))?.institutionId,
  );
}
