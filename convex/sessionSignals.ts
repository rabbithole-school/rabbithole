import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";
import { authedQuery } from "./lib/customFunctions";
import { requireTeacherOrSelf } from "./lib/auth";
import { requireActiveScholarAccess } from "./lib/access";
import { pcmDimensionValidator } from "./lib/pcm";
import type { Doc } from "./_generated/dataModel";

/**
 * Record a session signal (called by the observer action).
 */
export const record = internalMutation({
  args: {
    scholarId: v.id("users"),
    sessionId: v.id("sessions"),
    signalType: v.string(),
    description: v.string(),
    intensity: v.string(),
    transcriptExcerpt: v.optional(v.string()),
    pcmDimension: v.optional(pcmDimensionValidator),
  },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("sessionSignals")
      .withIndex("by_session", (q) => q.eq("sessionId", args.sessionId))
      .filter((q) => q.eq(q.field("signalType"), args.signalType))
      .collect();
    // Keep the newest historical row as the stable representative, and remove
    // older duplicates while updating it with the latest observation.
    const keep = rows.sort((a, b) => b._creationTime - a._creationTime)[0];
    if (keep) {
      await ctx.db.patch(keep._id, {
        scholarId: args.scholarId,
        description: args.description,
        intensity: args.intensity,
        transcriptExcerpt: args.transcriptExcerpt,
        pcmDimension: args.pcmDimension,
      });
      for (const duplicate of rows) {
        if (duplicate._id !== keep._id) await ctx.db.delete(duplicate._id);
      }
      return keep._id;
    }
    return await ctx.db.insert("sessionSignals", args);
  },
});

/** Inventory and (by default) repair exact session/type duplicates. */
export const repairDuplicates = internalMutation({
  args: { dryRun: v.optional(v.boolean()) },
  handler: async (ctx, args) => {
    const rows = await ctx.db.query("sessionSignals").collect();
    const groups = new Map<string, Doc<"sessionSignals">[]>();
    for (const row of rows) {
      const key = `${row.sessionId}:${row.signalType}`;
      groups.set(key, [...(groups.get(key) ?? []), row]);
    }
    const candidates = [...groups.entries()]
      .filter(([, group]) => group.length > 1)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, group]) => {
        const ordered = [...group].sort(
          (a, b) => b._creationTime - a._creationTime || String(b._id).localeCompare(String(a._id)),
        );
        return {
          key,
          sessionId: ordered[0].sessionId,
          signalType: ordered[0].signalType,
          keepId: ordered[0]._id,
          duplicateIds: ordered.slice(1).map((row) => row._id),
        };
      });
    if (args.dryRun ?? true) return { dryRun: true, candidates };
    for (const candidate of candidates) {
      for (const id of candidate.duplicateIds) await ctx.db.delete(id);
    }
    return { dryRun: false, candidates };
  },
});

/**
 * Get recent signals for a scholar (used by observer for context).
 */
export const recentByScholar = internalQuery({
  args: { scholarId: v.id("users"), limit: v.number() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("sessionSignals")
      .withIndex("by_scholar", (q) => q.eq("scholarId", args.scholarId))
      .order("desc")
      .take(args.limit);
  },
});

/**
 * Learner profile: aggregate signals by type for a scholar.
 */
export const signalProfile = authedQuery({
  args: { scholarId: v.id("users") },
  handler: async (ctx, args) => {
    const isTeacher = requireTeacherOrSelf(ctx.user, args.scholarId);
    if (isTeacher) await requireActiveScholarAccess(ctx, ctx.user, args.scholarId);

    const signals = await ctx.db
      .query("sessionSignals")
      .withIndex("by_scholar", (q) => q.eq("scholarId", args.scholarId))
      .collect();

    const byType: Record<
      string,
      { count: number; highCount: number; recent: typeof signals[0] | null }
    > = {};
    for (const s of signals) {
      if (!byType[s.signalType]) {
        byType[s.signalType] = { count: 0, highCount: 0, recent: null };
      }
      byType[s.signalType].count++;
      if (s.intensity === "high") byType[s.signalType].highCount++;
      if (
        !byType[s.signalType].recent ||
        s._creationTime > byType[s.signalType].recent!._creationTime
      ) {
        byType[s.signalType].recent = s;
      }
    }
    return byType;
  },
});
