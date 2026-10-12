/**
 * Text-free telemetry for segments removed by the scholar-visible text guard
 * (`lib/scholarSafeText.ts`). TRA-161: the guard drops machine-shaped sentences
 * silently, so nobody could tell whether it still fires in prod. Each drop
 * records only the matched pattern name, the segment length, the producing
 * surface, and (when known) the session — never the text.
 *
 * Read it with `npx convex run scholarSafeTextDrops:summary` (per-turn approval
 * on prod). Delete this file and its table together with the guard.
 */

import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";

const DEFAULT_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

/** Rows read per summary. The table is expected to stay near-empty; when a
 * window exceeds this, `truncated` flips so the counts are read as a floor. */
const SUMMARY_ROW_CAP = 5000;

export const record = internalMutation({
  args: {
    source: v.string(),
    pattern: v.string(),
    segmentLength: v.number(),
    sessionId: v.optional(v.id("sessions")),
  },
  returns: v.id("scholarSafeTextDrops"),
  handler: async (ctx, args) =>
    await ctx.db.insert("scholarSafeTextDrops", {
      ...args,
      createdAt: Date.now(),
    }),
});

export const summary = internalQuery({
  args: {
    sinceMs: v.optional(v.number()),
  },
  returns: v.object({
    total: v.number(),
    truncated: v.boolean(),
    bySource: v.record(v.string(), v.number()),
    byPattern: v.record(v.string(), v.number()),
    oldest: v.optional(v.number()),
    newest: v.optional(v.number()),
  }),
  handler: async (ctx, args) => {
    const sinceMs = args.sinceMs ?? Date.now() - DEFAULT_WINDOW_MS;
    // Newest-first so `newest` is exact even when the cap truncates the tail.
    const rows = await ctx.db
      .query("scholarSafeTextDrops")
      .withIndex("by_createdAt", (q) => q.gte("createdAt", sinceMs))
      .order("desc")
      .take(SUMMARY_ROW_CAP);
    const bySource: Record<string, number> = {};
    const byPattern: Record<string, number> = {};

    for (const row of rows) {
      bySource[row.source] = (bySource[row.source] ?? 0) + 1;
      byPattern[row.pattern] = (byPattern[row.pattern] ?? 0) + 1;
    }

    return {
      total: rows.length,
      truncated: rows.length === SUMMARY_ROW_CAP,
      bySource,
      byPattern,
      ...(rows.length > 0
        ? {
            newest: rows[0].createdAt,
            oldest: rows[rows.length - 1].createdAt,
          }
        : {}),
    };
  },
});
