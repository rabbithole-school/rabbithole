import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import { internalMutation } from "./_generated/server";
import {
  deleteScholarOwnedRows,
  scholarOwnedRowSources,
  type ScholarOwnedRowSource,
  type ScholarOwnedTableName,
} from "./lib/cascade";

type OrphanCounts = {
  orphanRows: number;
  distinctScholars: number;
};

export const purgeOrphanScholarRows = internalMutation({
  args: {
    dryRun: v.optional(v.boolean()),
    // Explicit per-call slice. One call over every ledger can exceed a
    // mutation's document-read budget, even in dry-run mode, so an operator
    // runs the report/purge table by table.
    tables: v.optional(v.array(v.string())),
  },
  handler: async (ctx, args) => {
    const dryRun = args.dryRun ?? true;
    if (!args.tables?.length) {
      throw new Error(
        "Orphan purge requires an explicit non-empty tables slice",
      );
    }
    const only = args.tables ? new Set(args.tables) : null;
    if (only) {
      const known = new Set<string>(scholarOwnedRowSources.map((s) => s.table));
      for (const t of only) if (!known.has(t)) throw new Error(`Unknown table: ${t}`);
    }
    const userExists = new Map<Id<"users">, boolean>();
    const orphanScholarIds = new Set<Id<"users">>();
    const perTable: Partial<Record<ScholarOwnedTableName, OrphanCounts>> = {};

    for (const source of scholarOwnedRowSources) {
      if (only && !only.has(source.table)) continue;
      await scanSource(source);
    }

    async function scanSource(source: ScholarOwnedRowSource) {
      const rows = await source.collectAll(ctx);
      const tableScholarIds = new Set<Id<"users">>();
      const orphanRowsToDelete: Awaited<
        ReturnType<ScholarOwnedRowSource["collectAll"]>
      > = [];
      let orphanRows = 0;

      for (const row of rows) {
        let exists = userExists.get(row.scholarId);
        if (exists === undefined) {
          exists = (await ctx.db.get("users", row.scholarId)) !== null;
          userExists.set(row.scholarId, exists);
        }
        if (exists) continue;

        orphanRows += 1;
        tableScholarIds.add(row.scholarId);
        orphanScholarIds.add(row.scholarId);
        orphanRowsToDelete.push(row);
      }

      if (!dryRun) {
        await deleteScholarOwnedRows(ctx, {}, source, orphanRowsToDelete);
      }

      perTable[source.table as ScholarOwnedTableName] = {
        orphanRows,
        distinctScholars: tableScholarIds.size,
      };
    }

    return {
      dryRun,
      perTable,
      scholarIds: [...orphanScholarIds].sort((a, b) => a.localeCompare(b)),
    };
  },
});
