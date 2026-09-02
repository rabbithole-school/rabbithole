import { v } from "convex/values";
import { internalQuery } from "./_generated/server";
import { staffQuery, staffMutation } from "./lib/customFunctions";
import { resolveInstitutionLens } from "./lib/institutionLens";
import type { Doc } from "./_generated/dataModel";
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

function periodInLens(
  period: Doc<"reportingPeriods">,
  lens: Awaited<ReturnType<typeof resolveInstitutionLens>>,
): boolean {
  return (
    period.institutionId === undefined ||
    lens.scope === "all" ||
    period.institutionId === lens.institution?._id ||
    lens.allowedInstitutionIds.has(period.institutionId)
  );
}

export async function currentReportingPeriod(
  ctx: QueryCtx,
  user: Doc<"users">,
  requestedScope?: string,
) {
  let rows = await ctx.db.query("reportingPeriods").collect();
  if (requestedScope !== undefined) {
    const lens = await resolveInstitutionLens(ctx, user, requestedScope);
    rows = rows.filter((period) => periodInLens(period, lens));
  }
  return (
    rows.find((period) => period.status === "writing") ??
    rows.find((period) => period.status === "open") ??
    null
  );
}

/** All periods, newest first. */
export const list = staffQuery({
  args: { scope: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const periods = await ctx.db.query("reportingPeriods").order("desc").collect();
    if (args.scope === undefined) return periods;
    const lens = await resolveInstitutionLens(ctx, ctx.user, args.scope);
    // Active institution lens: global periods stay visible; institution periods
    // follow the resolved staff lens.
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
    return await ctx.db.get(args.periodId);
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
  },
  handler: async (ctx, args) => {
    const label = args.label.trim();
    if (!label) throw new Error("Period needs a label");
    if (args.endsAt <= args.startsAt)
      throw new Error("Period end must be after its start");
    const id = await ctx.db.insert("reportingPeriods", {
      label,
      startsAt: args.startsAt,
      endsAt: args.endsAt,
      narrativesDueAt: args.narrativesDueAt,
      status: args.status ?? "upcoming",
      institutionId: args.institutionId ?? ctx.user.institutionId ?? undefined,
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
    // Refuse to delete a period that already has narratives against it.
    const narrative = await ctx.db
      .query("courseNarratives")
      .withIndex("by_period", (q) => q.eq("periodId", args.periodId))
      .first();
    if (narrative)
      throw new Error("Period has narratives — close it instead of deleting");
    await ctx.db.delete(args.periodId);
  },
});

/**
 * The current "writing"/"open" period id, for bot tools that act on a mapped
 * user (no Convex Auth identity, so they can't call the staffQuery `current`).
 */
export const currentInternal = internalQuery({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db.query("reportingPeriods").collect();
    return (
      rows.find((p) => p.status === "writing") ??
      rows.find((p) => p.status === "open") ??
      null
    );
  },
});
