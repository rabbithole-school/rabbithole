"use node";

import { v } from "convex/values";
import { action, internalAction } from "./_generated/server";
import type { ActionCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import {
  sirFizXCleanJsonToAsnEntries,
  type AsnStandardsDataset,
  type SirFizXCleanEntry,
} from "./lib/asnStandardsAdapter";

interface ImportResult {
  documentId: Id<"standardsDocuments">;
  totalStandards: number;
  parentLinksPatched: number;
}

type ImportRow = {
  asnId: string;
  notation?: string;
  description: string;
  gradeLevels: string[];
  subject: string;
  statementLabel: string;
  isLeaf: boolean;
  documentId: Id<"standardsDocuments">;
  asnParentId?: string;
};

const asnStandardEntryValidator = v.object({
  id: v.string(),
  notation: v.optional(v.string()),
  description: v.string(),
  gradeLevels: v.array(v.string()),
  isLeaf: v.boolean(),
  parent: v.optional(v.string()),
  label: v.string(),
});

const CHUNK = 200;

const COMMON_CORE_MATH_SOURCE = {
  url: "https://raw.githubusercontent.com/SirFizX/standards-data/master/clean-data/CC/math/CC-math-0.8.0.json",
  subject: "Mathematics",
  jurisdiction: "Common Core",
  documentTitle: "Common Core State Standards for Mathematics",
  asnDocumentId: "D10003FB",
};

const COMMON_CORE_ELA_SOURCE = {
  url: "https://raw.githubusercontent.com/SirFizX/standards-data/master/clean-data/CC/literacy/CC-literacy-0.8.0.json",
  subject: "ELA/Literacy",
  jurisdiction: "Common Core",
  documentTitle: "Common Core State Standards for English Language Arts & Literacy",
  asnDocumentId: "D10003FC",
};

async function importAsnDataset(
  ctx: ActionCtx,
  dataset: AsnStandardsDataset,
): Promise<ImportResult> {
  console.log(`Importing ${dataset.title} (${dataset.asnDocumentId})...`);

  const documentId = await ctx.runMutation(
    internal.standardsImportHelpers.upsertDocument,
    {
      asnDocumentId: dataset.asnDocumentId,
      title: dataset.title,
      subject: dataset.subject,
      jurisdiction: dataset.jurisdiction,
    },
  );

  const entries: ImportRow[] = dataset.entries.map((s) => ({
    asnId: s.id,
    notation: s.notation,
    description: s.description,
    gradeLevels: s.gradeLevels,
    subject: dataset.subject,
    statementLabel: s.label,
    isLeaf: s.isLeaf,
    documentId,
    asnParentId: s.parent,
  }));

  const asnToConvex = new Map<string, Id<"standards">>();

  for (let i = 0; i < entries.length; i += CHUNK) {
    const chunk = entries.slice(i, i + CHUNK);
    console.log(
      `Inserting batch ${Math.floor(i / CHUNK) + 1}/${Math.ceil(entries.length / CHUNK)}`,
    );

    const results = await ctx.runMutation(
      internal.standardsImportHelpers.batchInsert,
      { entries: chunk },
    );

    for (const r of results) {
      asnToConvex.set(r.asnId, r.convexId as Id<"standards">);
    }
  }

  const parentPatches: {
    convexId: Id<"standards">;
    parentConvexId: Id<"standards">;
  }[] = [];
  for (const entry of entries) {
    if (!entry.asnParentId) continue;
    const childConvexId = asnToConvex.get(entry.asnId);
    const parentConvexId = asnToConvex.get(entry.asnParentId);
    if (childConvexId && parentConvexId) {
      parentPatches.push({ convexId: childConvexId, parentConvexId });
    }
  }

  for (let i = 0; i < parentPatches.length; i += CHUNK) {
    const chunk = parentPatches.slice(i, i + CHUNK);
    console.log(
      `Patching parents ${Math.floor(i / CHUNK) + 1}/${Math.ceil(parentPatches.length / CHUNK)}`,
    );

    await ctx.runMutation(internal.standardsImportHelpers.batchPatchParents, {
      patches: chunk,
    });
  }

  console.log(
    `Done! Imported ${entries.length} standards, patched ${parentPatches.length} parent links.`,
  );
  return {
    documentId,
    totalStandards: entries.length,
    parentLinksPatched: parentPatches.length,
  };
}

// ─── Canonical adapter action ─────────────────────────────────────────

export const importFromAsnData = internalAction({
  args: {
    asnDocumentId: v.string(),
    title: v.string(),
    subject: v.string(),
    jurisdiction: v.string(),
    entries: v.array(asnStandardEntryValidator),
  },
  handler: async (ctx, args): Promise<ImportResult> => {
    return await importAsnDataset(ctx, args);
  },
});

// ─── Clean ASN mirror fetcher (CCSS) ───────────────────────────────────
// CCSS still fetches SirFizX's clean JSON mirror because this refactor is
// behavior-preserving: switching the source transport to raw ASN RDF/JSON-LD or
// CSP should be a separate equivalence-proved change. The fetched rows are
// immediately normalized into the same AsnStandardsDataset adapter as NGSS and
// Historical Thinking.

export const importFromUrl = internalAction({
  args: {
    url: v.string(),
    subject: v.string(),
    jurisdiction: v.string(),
    documentTitle: v.string(),
    asnDocumentId: v.string(),
  },
  handler: async (ctx, args): Promise<ImportResult> => {
    console.log(`Fetching standards from: ${args.url}`);
    const res = await fetch(args.url);
    if (!res.ok) {
      throw new Error(`Failed to fetch ${args.url}: ${res.status} ${res.statusText}`);
    }

    const rawData = (await res.json()) as SirFizXCleanEntry[];
    console.log(`Fetched ${rawData.length} entries`);

    return await importAsnDataset(ctx, {
      asnDocumentId: args.asnDocumentId,
      title: args.documentTitle,
      subject: args.subject,
      jurisdiction: args.jurisdiction,
      entries: sirFizXCleanJsonToAsnEntries(rawData),
    });
  },
});

// ─── Public action wrappers ────────────────────────────────────────────

export const importCommonCoreMath = action({
  args: {},
  handler: async (ctx): Promise<ImportResult> => {
    return await ctx.runAction(
      internal.standardsImport.importFromUrl,
      COMMON_CORE_MATH_SOURCE,
    );
  },
});

export const importCommonCoreELA = action({
  args: {},
  handler: async (ctx): Promise<ImportResult> => {
    return await ctx.runAction(
      internal.standardsImport.importFromUrl,
      COMMON_CORE_ELA_SOURCE,
    );
  },
});

export const importUCLAHistoricalThinking = action({
  args: {},
  handler: async (ctx): Promise<ImportResult> => {
    const { HISTORICAL_THINKING_DATASET } = await import("./historicalThinkingData");
    return await ctx.runAction(
      internal.standardsImport.importFromAsnData,
      HISTORICAL_THINKING_DATASET,
    );
  },
});

// ─── NGSS Science (K-12) ───────────────────────────────────────────────
// Full Next Generation Science Standards Performance Expectations, sourced
// from Common Standards Project's ASN-derived D2454348 standard sets. Leaves
// carry K/1-5/MS/HS grade codes and are parented under NGSS topic + discipline
// folders, so the acceleration view gains a Science row without UI changes.
export const importNGSSFromData = internalAction({
  args: {},
  handler: async (ctx): Promise<ImportResult> => {
    const { NGSS_DATASET } = await import("./ngssData");
    return await ctx.runAction(
      internal.standardsImport.importFromAsnData,
      NGSS_DATASET,
    );
  },
});

//   npx convex run standardsImport:importNGSS
export const importNGSS = action({
  args: {},
  handler: async (ctx): Promise<ImportResult> => {
    return await ctx.runAction(internal.standardsImport.importNGSSFromData, {});
  },
});

// Backward-compatible wrapper for the original proof-of-concept action name:
//   npx convex run standardsImport:importNGSSScience
export const importNGSSScience = action({
  args: {},
  handler: async (ctx): Promise<ImportResult> => {
    return await ctx.runAction(internal.standardsImport.importNGSSFromData, {});
  },
});
