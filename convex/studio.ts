/**
 * Studio persistence — the scholar's saved source per level, and the best
 * verdict any run has produced for it. See `shared/studioContract.ts` for the
 * full contract this table backs, and `schema.ts`'s `studioPrograms` comment
 * for why `levelId` is a string (a level is code, not a row) and why saved
 * source + progress share one table.
 */

import { v } from "convex/values";
import { authedMutation, authedQuery, teacherQuery } from "./lib/customFunctions";
import { accessibleScholarIds, resolveActiveMembership } from "./lib/access";
import { isPlatformAdminRole, ROLES } from "./lib/roles";
import type { Id } from "./_generated/dataModel";

/**
 * ~20 KB — a kid's Studio program is a few dozen lines, many times over. A
 * runaway paste (or a bug in the editor's autosave) must not bloat a row.
 */
const MAX_SOURCE_LENGTH = 20_000;

const studioRunStatusValidator = v.union(
  v.literal("win"),
  v.literal("short"),
  v.literal("error"),
  v.literal("stopped"),
);

/** Upsert the scholar's saved source for one level. The scholar is always the
 *  CALLER — never accept a scholarId from the client. */
export const saveProgram = authedMutation({
  args: { levelId: v.string(), source: v.string() },
  handler: async (ctx, args) => {
    if (args.source.length > MAX_SOURCE_LENGTH) {
      throw new Error(
        `Program is too large to save (max ${MAX_SOURCE_LENGTH} characters).`,
      );
    }
    const existing = await ctx.db
      .query("studioPrograms")
      .withIndex("by_scholar_level", (q) =>
        q.eq("scholarId", ctx.user._id).eq("levelId", args.levelId),
      )
      .unique();
    const updatedAt = Date.now();
    if (existing) {
      await ctx.db.patch(existing._id, { source: args.source, updatedAt });
      return existing._id;
    }
    return await ctx.db.insert("studioPrograms", {
      scholarId: ctx.user._id,
      levelId: args.levelId,
      source: args.source,
      updatedAt,
      solved: false,
    });
  },
});

/** The caller's own saved sources across every level, for restoring the editor. */
export const myPrograms = authedQuery({
  args: {},
  handler: async (ctx) => {
    return await ctx.db
      .query("studioPrograms")
      .withIndex("by_scholar", (q) => q.eq("scholarId", ctx.user._id))
      .collect();
  },
});

/**
 * Record a run's verdict against the caller's own progress. Mirrors
 * `StudioRunResult` (shared/studioContract.ts) so the client can send the
 * verdict object straight through. Only `status` and `steps` are persisted —
 * `solved` is STICKY (a later non-winning run never un-solves a level) and
 * `bestSteps` keeps the fewest robot steps any winning run has taken.
 */
export const recordRun = authedMutation({
  args: {
    levelId: v.string(),
    status: studioRunStatusValidator,
    steps: v.number(),
    message: v.string(),
    line: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const won = args.status === "win";
    const existing = await ctx.db
      .query("studioPrograms")
      .withIndex("by_scholar_level", (q) =>
        q.eq("scholarId", ctx.user._id).eq("levelId", args.levelId),
      )
      .unique();
    if (existing) {
      const solved = existing.solved || won;
      const bestSteps = won
        ? existing.bestSteps === undefined
          ? args.steps
          : Math.min(existing.bestSteps, args.steps)
        : existing.bestSteps;
      await ctx.db.patch(existing._id, { solved, bestSteps });
      return;
    }
    // A run can land before the first autosave lands (the scholar pressed Run
    // before the debounced saveProgram caught up) — start the row with an
    // empty source; saveProgram fills it in on its own schedule.
    await ctx.db.insert("studioPrograms", {
      scholarId: ctx.user._id,
      levelId: args.levelId,
      source: "",
      updatedAt: Date.now(),
      solved: won,
      bestSteps: won ? args.steps : undefined,
    });
  },
});

/**
 * Teacher-facing: which levels each accessible scholar has solved, for
 * watching the room live during the elective. Institution-scoped —
 * `accessibleScholarIds` is the same boundary `concepts.allScholars` uses, so
 * a teacher only ever sees their own institution's scholars (or every scholar,
 * for a platform admin). A role check alone would be a cross-tenant leak; the
 * scoping happens here, per-handler, not just at the `teacherQuery` gate.
 */
export const roomProgress = teacherQuery({
  args: {},
  handler: async (ctx) => {
    const isPlatformAdmin = isPlatformAdminRole(ctx.user.role);
    const membership = isPlatformAdmin
      ? null
      : await resolveActiveMembership(ctx, ctx.user);
    const scholarIds: Set<Id<"users">> = isPlatformAdmin
      ? new Set(
          (
            await ctx.db
              .query("users")
              .withIndex("by_role", (q) => q.eq("role", ROLES.SCHOLAR))
              .collect()
          ).map((u) => u._id),
        )
      : membership
        ? await accessibleScholarIds(ctx, membership)
        : new Set<Id<"users">>();

    const rows = await Promise.all(
      [...scholarIds].map(async (scholarId) => {
        const scholar = await ctx.db.get(scholarId);
        if (!scholar) return null;
        const programs = await ctx.db
          .query("studioPrograms")
          .withIndex("by_scholar", (q) => q.eq("scholarId", scholarId))
          .collect();
        return {
          scholarId,
          name: scholar.name ?? scholar.username ?? "Scholar",
          levels: programs.map((p) => ({
            levelId: p.levelId,
            solved: p.solved,
            bestSteps: p.bestSteps,
          })),
        };
      }),
    );
    return rows
      .filter((r): r is NonNullable<typeof r> => r !== null)
      .sort((a, b) => a.name.localeCompare(b.name));
  },
});
