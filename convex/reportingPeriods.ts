import { v } from "convex/values";
import { internalQuery } from "./_generated/server";
import { staffQuery, staffMutation } from "./lib/customFunctions";
import { resolveInstitutionLens } from "./lib/institutionLens";
import { scholarInstitutionId } from "./lib/scholarEnrollment";
import type { Doc, Id } from "./_generated/dataModel";
import type { QueryCtx } from "./_generated/server";

/**
 * Reporting calendar (review/assessment-and-goals-plan.html §13).
 *
 * Beginning/Middle/End of the year. A "snapshot" is the binder rollup evaluated
 * at a frozen date range (assessmentBinder respects a period's startsAt/endsAt);
 * growth-over-period is two snapshots diffed. `narrativesDueAt` drives the
 * composer's nudges. Staff-managed config — not sensitive, so any staffer reads;
 * writes gate to staff too (a small school hand-manages a couple of periods/yr).
 */

const periodStatusValidator = v.union(
  v.literal("upcoming"),
  v.literal("open"),
  v.literal("writing"),
  v.literal("closed"),
);

/**
 * Which periods a staff lens may see. A period with no `institutionId` is a
 * legacy / single-school period and is visible everywhere. Otherwise:
 *   - a single-school lens sees only that school's periods, so a staffer who
 *     belongs to two schools never gets the other school's term by default;
 *   - the "all" lens sees every school the caller actually belongs to (every
 *     live school for a platform admin), never a stranger school's calendar.
 * TRA-406: this used to also admit every school in `allowedInstitutionIds` on
 * a single-school lens, and every school at all on "all".
 */
function periodInLens(
  period: Doc<"reportingPeriods">,
  lens: Awaited<ReturnType<typeof resolveInstitutionLens>>,
): boolean {
  if (period.institutionId === undefined) return true;
  if (lens.scope === "all") return lens.allowedInstitutionIds.has(period.institutionId);
  return period.institutionId === lens.institution?._id;
}

/**
 * The current writing/open period in the caller's lens. An omitted scope is
 * the caller's home school (never "every school"), so an unscoped caller
 * can't land in another school's term.
 */
export async function currentReportingPeriod(
  ctx: QueryCtx,
  user: Doc<"users">,
  requestedScope?: string,
) {
  const lens = await resolveInstitutionLens(ctx, user, requestedScope);
  const rows = (await ctx.db.query("reportingPeriods").collect()).filter(
    (period) => periodInLens(period, lens),
  );
  return (
    rows.find((period) => period.status === "writing") ??
    rows.find((period) => period.status === "open") ??
    null
  );
}

/**
 * Refuse to file a scholar's report against another school's period. Shared
 * by every report type's `open` (course narratives, Whole Child, interim
 * check-ins). Unscoped legacy periods stay usable by everyone.
 */
export async function requirePeriodForScholar(
  ctx: QueryCtx,
  periodId: Id<"reportingPeriods">,
  scholarId: Id<"users">,
): Promise<Doc<"reportingPeriods">> {
  const period = await ctx.db.get(periodId);
  if (!period) throw new Error("Reporting period not found");
  if (
    period.institutionId !== undefined &&
    (await scholarInstitutionId(ctx, scholarId)) !== period.institutionId
  )
    throw new Error("That reporting period belongs to a different school");
  return period;
}

/**
 * Period config is per school: reading or changing a period needs membership
 * at its school (every live school for a platform admin). Legacy unscoped
 * periods stay open to any staffer, as before.
 */
async function requirePeriodInCallerSchools(
  ctx: QueryCtx,
  user: Doc<"users">,
  period: Doc<"reportingPeriods">,
): Promise<void> {
  if (period.institutionId === undefined) return;
  const lens = await resolveInstitutionLens(ctx, user, "all");
  if (!lens.allowedInstitutionIds.has(period.institutionId))
    throw new Error("Period not found");
}

/** All periods, newest first. */
export const list = staffQuery({
  args: { scope: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const periods = await ctx.db.query("reportingPeriods").order("desc").collect();
    // An omitted scope is the caller's home school (see periodInLens).
    const lens = await resolveInstitutionLens(ctx, ctx.user, args.scope);
    return periods.filter((period) => periodInLens(period, lens));
  },
});

/** The single "open" or "writing" period, if any (the one you'd write into). */
export const current = staffQuery({
  args: { scope: v.optional(v.string()) },
  handler: (ctx, args) =>
    currentReportingPeriod(ctx, ctx.user, args.scope),
});

export const get = staffQuery({
  args: { periodId: v.id("reportingPeriods") },
  handler: async (ctx, args) => {
    const period = await ctx.db.get(args.periodId);
    if (!period) return null;
    await requirePeriodInCallerSchools(ctx, ctx.user, period);
    return period;
  },
});

export const create = staffMutation({
  args: {
    label: v.string(),
    startsAt: v.number(),
    endsAt: v.number(),
    narrativesDueAt: v.optional(v.number()),
    status: v.optional(periodStatusValidator),
    institutionId: v.optional(v.id("institutions")),
    // The page's active school lens; the period is stamped with that school
    // unless `institutionId` names one explicitly.
    scope: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const label = args.label.trim();
    if (!label) throw new Error("Period needs a label");
    if (args.endsAt <= args.startsAt)
      throw new Error("Period end must be after its start");
    const lens = await resolveInstitutionLens(ctx, ctx.user, args.scope);
    const institutionId = args.institutionId ?? lens.institution?._id;
    if (!institutionId) throw new Error("Pick a school before creating a period");
    if (!lens.allowedInstitutionIds.has(institutionId))
      throw new Error("You can only create periods for your own school");
    const id = await ctx.db.insert("reportingPeriods", {
      label,
      startsAt: args.startsAt,
      endsAt: args.endsAt,
      narrativesDueAt: args.narrativesDueAt,
      status: args.status ?? "upcoming",
      institutionId,
    });
    return await ctx.db.get(id);
  },
});

export const update = staffMutation({
  args: {
    periodId: v.id("reportingPeriods"),
    label: v.optional(v.string()),
    startsAt: v.optional(v.number()),
    endsAt: v.optional(v.number()),
    narrativesDueAt: v.optional(v.number()),
    status: v.optional(periodStatusValidator),
  },
  handler: async (ctx, args) => {
    const period = await ctx.db.get(args.periodId);
    if (!period) throw new Error("Period not found");
    await requirePeriodInCallerSchools(ctx, ctx.user, period);
    const patch: Record<string, unknown> = {};
    if (args.label !== undefined) {
      const l = args.label.trim();
      if (!l) throw new Error("Period needs a label");
      patch.label = l;
    }
    if (args.startsAt !== undefined) patch.startsAt = args.startsAt;
    if (args.endsAt !== undefined) patch.endsAt = args.endsAt;
    if (args.narrativesDueAt !== undefined)
      patch.narrativesDueAt = args.narrativesDueAt;
    if (args.status !== undefined) patch.status = args.status;
    const startsAt = (patch.startsAt as number) ?? period.startsAt;
    const endsAt = (patch.endsAt as number) ?? period.endsAt;
    if (endsAt <= startsAt) throw new Error("Period end must be after its start");
    await ctx.db.patch(args.periodId, patch);
    return await ctx.db.get(args.periodId);
  },
});

export const remove = staffMutation({
  args: { periodId: v.id("reportingPeriods") },
  handler: async (ctx, args) => {
    const period = await ctx.db.get(args.periodId);
    if (!period) return;
    await requirePeriodInCallerSchools(ctx, ctx.user, period);
    // Refuse to delete a period that already has narratives against it.
    const narrative = await ctx.db
      .query("courseNarratives")
      .withIndex("by_period", (q) => q.eq("periodId", args.periodId))
      .first();
    if (narrative)
      throw new Error("Period has narratives — close it instead of deleting");
    const checkin = await ctx.db
      .query("interimCheckins")
      .withIndex("by_period", (q) => q.eq("periodId", args.periodId))
      .first();
    if (checkin)
      throw new Error("Period has interim check-ins — close it instead of deleting");
    await ctx.db.delete(args.periodId);
  },
});

/**
 * The current "writing"/"open" period for one scholar's school, for bot tools
 * that act on a mapped user (no Convex Auth identity, so they can't call the
 * staffQuery `current`). Scoped by the scholar so a bot never files a report
 * in another school's term (TRA-406).
 */
export const currentInternal = internalQuery({
  args: { scholarId: v.id("users") },
  handler: async (ctx, args) => {
    const institutionId = await scholarInstitutionId(ctx, args.scholarId);
    const rows = (await ctx.db.query("reportingPeriods").collect()).filter(
      (p) => p.institutionId === undefined || p.institutionId === institutionId,
    );
    return (
      rows.find((p) => p.status === "writing") ??
      rows.find((p) => p.status === "open") ??
      null
    );
  },
});
