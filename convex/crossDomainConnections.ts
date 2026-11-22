import { v } from "convex/values";
import { internalMutation } from "./_generated/server";
import { authedQuery } from "./lib/customFunctions";
import { requireTeacherOrSelf } from "./lib/auth";
import { requireActiveScholarAccess } from "./lib/access";
import { pcmDimensionValidator } from "./lib/pcm";
import type { Doc } from "./_generated/dataModel";

/** Identity of a connection within a session: its domains, order- and case-free. */
function domainSetKey(domains: string[]): string {
  return [...new Set(domains.map((d) => d.trim().toLowerCase()))].sort().join("\u0000");
}

function oldestFirst(
  rows: Doc<"crossDomainConnections">[],
): Doc<"crossDomainConnections">[] {
  return [...rows].sort(
    (a, b) =>
      a._creationTime - b._creationTime || String(a._id).localeCompare(String(b._id)),
  );
}

/**
 * Record a cross-domain connection (called by the observer action). Upserts on
 * (session, domain set) — see the handler comment.
 */
export const record = internalMutation({
  args: {
    scholarId: v.id("users"),
    sessionId: v.id("sessions"),
    domains: v.array(v.string()),
    conceptLabels: v.array(v.string()),
    description: v.string(),
    studentInitiated: v.boolean(),
    transcriptExcerpt: v.optional(v.string()),
    pcmDimension: v.optional(pcmDimensionValidator),
  },
  handler: async (ctx, args) => {
    if (args.domains.length < 2) return null;

    // One row per (session, domain set). The observer re-reads its transcript
    // window on every run and restates the same connection in fresh words
    // ("Republican government × Game design", then "Civic institutions × Game
    // and software design"), so a plain insert recorded one link dozens of
    // times — and every copy carried a new `_creationTime`, which is the date
    // keyMoments / practiceDigest / assessmentBinder read. A week-old
    // connection resurfaced as today's (TRA-101). The domain set is the part
    // that stays stable across restatements; the labels drift.
    //
    // Keep the OLDEST row so the connection stays dated to when it was first
    // seen, refresh its wording from the latest reading, and drop any other
    // copies (rows written before this upsert existed).
    const key = domainSetKey(args.domains);
    const rows = (
      await ctx.db
        .query("crossDomainConnections")
        .withIndex("by_session", (q) => q.eq("sessionId", args.sessionId))
        .collect()
    ).filter((row) => domainSetKey(row.domains) === key);
    const [keep, ...duplicates] = oldestFirst(rows);
    if (keep) {
      await ctx.db.patch(keep._id, {
        scholarId: args.scholarId,
        conceptLabels: args.conceptLabels,
        description: args.description,
        studentInitiated: args.studentInitiated,
        transcriptExcerpt: args.transcriptExcerpt,
        pcmDimension: args.pcmDimension,
      });
      for (const duplicate of duplicates) await ctx.db.delete(duplicate._id);
      return keep._id;
    }

    return await ctx.db.insert("crossDomainConnections", {
      scholarId: args.scholarId,
      sessionId: args.sessionId,
      domains: args.domains,
      conceptLabels: args.conceptLabels,
      description: args.description,
      studentInitiated: args.studentInitiated,
      transcriptExcerpt: args.transcriptExcerpt,
      pcmDimension: args.pcmDimension,
    });
  },
});

/**
 * Inventory and (by default, dry-run) repair the per-run duplicates `record`
 * wrote before it upserted: one row per (session, domain set), keeping the
 * oldest so each connection stays dated to its first sighting. Run once on
 * prod after the upsert deploys — dry run first.
 */
export const repairDuplicates = internalMutation({
  args: { dryRun: v.optional(v.boolean()) },
  handler: async (ctx, args) => {
    const rows = await ctx.db.query("crossDomainConnections").collect();
    const groups = new Map<string, Doc<"crossDomainConnections">[]>();
    for (const row of rows) {
      const key = `${row.sessionId}:${domainSetKey(row.domains)}`;
      groups.set(key, [...(groups.get(key) ?? []), row]);
    }
    const candidates = [...groups.values()]
      .filter((group) => group.length > 1)
      .map((group) => {
        const [keep, ...duplicates] = oldestFirst(group);
        return {
          sessionId: keep.sessionId,
          domains: keep.domains,
          keepId: keep._id,
          duplicateIds: duplicates.map((row) => row._id),
        };
      });
    const duplicateRows = candidates.reduce((n, c) => n + c.duplicateIds.length, 0);
    if (args.dryRun ?? true) {
      return { dryRun: true, totalRows: rows.length, duplicateRows, candidates };
    }
    for (const candidate of candidates) {
      for (const id of candidate.duplicateIds) await ctx.db.delete(id);
    }
    return { dryRun: false, totalRows: rows.length, duplicateRows, candidates };
  },
});

/**
 * List all cross-domain connections for a scholar.
 */
export const listByScholar = authedQuery({
  args: { scholarId: v.id("users") },
  handler: async (ctx, args) => {
    const isTeacher = requireTeacherOrSelf(ctx.user, args.scholarId);
    if (isTeacher) await requireActiveScholarAccess(ctx, ctx.user, args.scholarId);

    return await ctx.db
      .query("crossDomainConnections")
      .withIndex("by_scholar", (q) => q.eq("scholarId", args.scholarId))
      .order("desc")
      .collect();
  },
});
