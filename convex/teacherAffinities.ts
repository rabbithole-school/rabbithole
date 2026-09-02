import { v } from "convex/values";
import { scholarAdminQuery, scholarAdminMutation } from "./lib/customFunctions";
import { requireActiveScholarAccess } from "./lib/access";
import type { Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";

// Per-teacher "my scholars" affinity. Convenience only — NOT an ACL.
// Drives default sort-to-top and an optional "my scholars only" filter.
// One row per teacher; absence is treated as empty. See schema.ts.

/**
 * The current teacher's affinity, normalized so callers never have to
 * handle the no-row case. `scholarIds` / `groupIds` are the raw marks;
 * the client expands groupIds against the live group list to compute
 * the effective "my scholars" set (a deleted group simply drops out).
 */
export const getMine = scholarAdminQuery({
  args: {},
  handler: async (ctx) => {
    const row = await ctx.db
      .query("teacherAffinities")
      .withIndex("by_teacher", (q) => q.eq("teacherId", ctx.user._id))
      .first();
    return {
      scholarIds: row?.scholarIds ?? [],
      groupIds: row?.groupIds ?? [],
    };
  },
});

/**
 * Toggle a single scholar in/out of the current teacher's affinity.
 */
export const toggleScholar = scholarAdminMutation({
  args: { scholarId: v.id("users") },
  handler: async (ctx, args) => {
    await requireActiveScholarAccess(ctx, ctx.user, args.scholarId);
    const row = await getOrCreateRow(ctx, ctx.user._id);
    const has = row.scholarIds.includes(args.scholarId);
    await ctx.db.patch(row._id, {
      scholarIds: has
        ? row.scholarIds.filter((id) => id !== args.scholarId)
        : [...row.scholarIds, args.scholarId],
    });
    return !has;
  },
});

/**
 * Toggle a whole group in/out of the current teacher's affinity.
 */
export const toggleGroup = scholarAdminMutation({
  args: { groupId: v.id("scholarGroups") },
  handler: async (ctx, args) => {
    const row = await getOrCreateRow(ctx, ctx.user._id);
    const has = row.groupIds.includes(args.groupId);
    await ctx.db.patch(row._id, {
      groupIds: has
        ? row.groupIds.filter((id) => id !== args.groupId)
        : [...row.groupIds, args.groupId],
    });
    return !has;
  },
});

/**
 * Replace the affinity marks wholesale (used by a "manage" surface).
 */
export const set = scholarAdminMutation({
  args: {
    scholarIds: v.array(v.id("users")),
    groupIds: v.array(v.id("scholarGroups")),
  },
  handler: async (ctx, args) => {
    const row = await getOrCreateRow(ctx, ctx.user._id);
    await ctx.db.patch(row._id, {
      scholarIds: dedupe(args.scholarIds),
      groupIds: dedupe(args.groupIds),
    });
  },
});

/**
 * Clear all affinity marks for the current teacher.
 */
export const clear = scholarAdminMutation({
  args: {},
  handler: async (ctx) => {
    const row = await ctx.db
      .query("teacherAffinities")
      .withIndex("by_teacher", (q) => q.eq("teacherId", ctx.user._id))
      .first();
    if (row) await ctx.db.patch(row._id, { scholarIds: [], groupIds: [] });
  },
});

// ── helpers ──────────────────────────────────────────────────────────

async function getOrCreateRow(ctx: MutationCtx, teacherId: Id<"users">) {
  const existing = await ctx.db
    .query("teacherAffinities")
    .withIndex("by_teacher", (q) => q.eq("teacherId", teacherId))
    .first();
  if (existing) return existing;
  const id = await ctx.db.insert("teacherAffinities", {
    teacherId,
    scholarIds: [],
    groupIds: [],
  });
  const row = await ctx.db.get(id);
  if (!row) throw new Error("Failed to create affinity row.");
  return row;
}

function dedupe<T>(ids: T[]): T[] {
  return Array.from(new Set(ids));
}
