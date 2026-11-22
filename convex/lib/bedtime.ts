import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import {
  SCHOOL_BEDTIME,
  familyBedtimeProblem,
  type BedtimeWindow,
} from "../../shared/bedtime";
import { getActiveOverlay } from "./auth";
import { ROLES } from "./roles";
import { scholarInstitutionId } from "./scholarEnrollment";
import { effectiveInstitutionTimeZone } from "./institutionTime";

/**
 * Whose Rabbithole goes to sleep at night (`shared/bedtime.ts`), and in which
 * zone. Returns the zone for a scholar at the PRIMARY institution, else null.
 *
 * First-party only, on purpose: bedtime is the primary institution's policy for its own
 * kids. A pilot school or the Albatross demo community (adult teachers
 * enrolled as learners) hasn't chosen it, so it doesn't follow them home.
 * Build a per-institution setting when a second school asks for one.
 *
 * Adult learner accounts carry a staff role, so the role check alone keeps
 * them out. A platform admin's view-as overlay is skipped too — inspecting a
 * scholar's home at 9 pm shouldn't put the admin to bed.
 */
export async function bedtimeTimeZoneFor(
  ctx: QueryCtx,
  user: Doc<"users">,
): Promise<string | null> {
  if (await getActiveOverlay(ctx)) return null;
  return scholarBedtimeTimeZone(ctx, user);
}

/**
 * The zone bedtime runs in for this scholar, or null when bedtime doesn't
 * apply to them: the same first-party rule as `bedtimeTimeZoneFor`, without
 * the caller's view-as overlay, for a reader who is not the scholar (a
 * parent setting the bedtime, a teacher reading it).
 */
export async function scholarBedtimeTimeZone(
  ctx: QueryCtx,
  scholar: Doc<"users">,
): Promise<string | null> {
  if (scholar.role !== ROLES.SCHOLAR) return null;
  const institutionId = await scholarInstitutionId(ctx, scholar._id);
  const institution = institutionId ? await ctx.db.get(institutionId) : null;
  if (institution?.isPrimary !== true) return null;
  return effectiveInstitutionTimeZone(institution.timeZone);
}

/**
 * A child's nightly window: the one a guardian set (`scholarBedtimes`), else
 * the school's. A stored window that fails today's bounds (they were
 * tightened since it was saved) falls back to the school's rather than
 * loosening anything.
 */
export async function bedtimeWindowFor(
  ctx: QueryCtx,
  scholarId: Id<"users">,
): Promise<BedtimeWindow & { setByFamily: boolean }> {
  const row = await ctx.db
    .query("scholarBedtimes")
    .withIndex("by_scholar", (q) => q.eq("scholarId", scholarId))
    .first();
  if (!row) return { ...SCHOOL_BEDTIME, setByFamily: false };
  const window = { startMinutes: row.startMinutes, endMinutes: row.endMinutes };
  if (familyBedtimeProblem(window)) {
    return { ...SCHOOL_BEDTIME, setByFamily: false };
  }
  return { ...window, setByFamily: true };
}
