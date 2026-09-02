import type { Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { resolveActiveMembership } from "./access";
import { scholarInstitutionId } from "./scholarEnrollment";
import {
  DEFAULT_TIMEZONE,
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
  ctx: QueryCtx,
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
