import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { deletePortfolioItem } from "./portfolio";
import { reconcilePortfolioMaterialization } from "./portfolioMaterialize";

function samePageRange(
  a: Doc<"portfolioItems">["pageRange"],
  b: Doc<"portfolioItems">["pageRange"],
): boolean {
  return (
    a != null &&
    b != null &&
    a.start === b.start &&
    a.end === b.end
  );
}

async function attributionMap(
  ctx: Parameters<typeof deletePortfolioItem>[0],
  itemId: Id<"portfolioItems">,
) {
  const rows = await ctx.db
    .query("portfolioAttributions")
    .withIndex("by_item", (q) => q.eq("portfolioItemId", itemId))
    .collect();
  return new Map(rows.map((row) => [row.scholarId, row]));
}

function normalizedFamilyVisibility(
  value: Doc<"portfolioItems">["familyVisibility"],
) {
  // Legacy rows predate the explicit value but have the same family-visible behavior.
  return value ?? "attributed_families";
}

async function prepareMerge(
  ctx: Parameters<typeof deletePortfolioItem>[0],
  keep: Doc<"portfolioItems">,
  remove: Doc<"portfolioItems">,
) {
  if (
    keep.assignmentId !== remove.assignmentId ||
    keep.assignmentStatus !== remove.assignmentStatus ||
    keep.activityId !== remove.activityId ||
    normalizedFamilyVisibility(keep.familyVisibility) !==
      normalizedFamilyVisibility(remove.familyVisibility) ||
    keep.label !== remove.label
  ) {
    throw new Error("Duplicate items have different teacher filing metadata");
  }

  const [keepAttributions, removeAttributions] = await Promise.all([
    attributionMap(ctx, keep._id),
    attributionMap(ctx, remove._id),
  ]);
  const keepScholarIds = [...keepAttributions.keys()].sort();
  const removeScholarIds = [...removeAttributions.keys()].sort();
  if (
    keepScholarIds.length !== removeScholarIds.length ||
    keepScholarIds.some((id, index) => id !== removeScholarIds[index])
  ) {
    throw new Error("Duplicate items have different scholar attributions");
  }

  for (const scholarId of keepScholarIds) {
    const keepAttribution = keepAttributions.get(scholarId)!;
    const removeAttribution = removeAttributions.get(scholarId)!;
    if (
      keepAttribution.reflection &&
      removeAttribution.reflection &&
      keepAttribution.reflection !== removeAttribution.reflection
    ) {
      throw new Error("Duplicate items have conflicting scholar reflections");
    }
  }

  const attachments = remove.fileStorageId
    ? await ctx.db
        .query("parentMessageAttachments")
        .withIndex("by_storage", (q) => q.eq("storageId", remove.fileStorageId!))
        .collect()
    : [];
  return {
    attachments,
    keepAttributions,
    keepScholarIds,
    removeAttributions,
  };
}

async function applyMerge(
  ctx: Parameters<typeof deletePortfolioItem>[0],
  keep: Doc<"portfolioItems">,
  remove: Doc<"portfolioItems">,
  prepared: Awaited<ReturnType<typeof prepareMerge>>,
  dismissal: { dismissDriveFile: boolean; dismissedBy?: Id<"users"> },
) {
  for (const scholarId of prepared.keepScholarIds) {
    const keepAttribution = prepared.keepAttributions.get(scholarId)!;
    const removeAttribution = prepared.removeAttributions.get(scholarId)!;
    if (!keepAttribution.reflection && removeAttribution.reflection) {
      await ctx.db.patch(keepAttribution._id, {
        reflection: removeAttribution.reflection,
        reflectionUpdatedAt: removeAttribution.reflectionUpdatedAt,
      });
    }
  }
  for (const attachment of prepared.attachments) {
    if (attachment.portfolioItemId === remove._id) {
      await ctx.db.patch(attachment._id, { portfolioItemId: keep._id });
    }
  }
  await deletePortfolioItem(ctx, remove, dismissal);
  await reconcilePortfolioMaterialization(ctx, keep._id);
}

function textCoverage(needle: string | undefined, haystack: string | undefined) {
  const words = (text: string | undefined) =>
    new Set(text?.toLowerCase().match(/[a-z0-9]{3,}/g) ?? []);
  const needleWords = words(needle);
  const haystackWords = words(haystack);
  if (needleWords.size < 12) return 0;
  return (
    [...needleWords].filter((word) => haystackWords.has(word)).length /
    needleWords.size
  );
}

/**
 * Internal dry-run inventory. Within one Drive file, normalized segments never
 * overlap, so repeated page ranges can only come from repeated ingestion.
 */
export const findDuplicateDriveItems = internalQuery({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db.query("portfolioItems").collect();
    const groups = new Map<string, Doc<"portfolioItems">[]>();
    for (const item of rows) {
      if (!item.driveFileId || !item.pageRange) continue;
      const key = `${item.driveFileId}:${item.pageRange.start}-${item.pageRange.end}`;
      const group = groups.get(key) ?? [];
      group.push(item);
      groups.set(key, group);
    }
    return [...groups.values()]
      .filter((group) => group.length > 1)
      .map((group) => {
        const ordered = group.sort((a, b) => a._creationTime - b._creationTime);
        return {
          driveFileId: ordered[0].driveFileId!,
          pageRange: ordered[0].pageRange!,
          keepCandidateId: ordered[0]._id,
          duplicateIds: ordered.slice(1).map((item) => item._id),
        };
      });
  },
});

/**
 * Merge one proven duplicate into its canonical item. The caller chooses which
 * rendering to keep after the rotation dry-run; this mutation independently
 * revalidates provenance, page range, and scholar attribution before writing.
 */
export const mergeDuplicateDriveItems = internalMutation({
  args: {
    keepItemId: v.id("portfolioItems"),
    removeItemId: v.id("portfolioItems"),
    dryRun: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    if (args.keepItemId === args.removeItemId) {
      throw new Error("Duplicate merge requires two different items");
    }
    const [keep, remove] = await Promise.all([
      ctx.db.get(args.keepItemId),
      ctx.db.get(args.removeItemId),
    ]);
    if (!keep || !remove) throw new Error("Portfolio item not found");
    if (
      keep.source !== "google_drive" ||
      remove.source !== "google_drive" ||
      !keep.driveFileId ||
      keep.driveFileId !== remove.driveFileId ||
      keep.institutionId !== remove.institutionId ||
      !samePageRange(keep.pageRange, remove.pageRange)
    ) {
      throw new Error("Items are not duplicate segments from the same Drive scan");
    }
    const prepared = await prepareMerge(ctx, keep, remove);
    const plan = {
      keepItemId: keep._id,
      removeItemId: remove._id,
      driveFileId: keep.driveFileId,
      pageRange: keep.pageRange!,
      attachmentLinksToMove: prepared.attachments.filter(
        (attachment) => attachment.portfolioItemId === remove._id,
      ).length,
    };
    if (args.dryRun ?? true) return { dryRun: true, ...plan };

    await applyMerge(ctx, keep, remove, prepared, { dismissDriveFile: false });
    return { dryRun: false, ...plan };
  },
});

/**
 * Remove a reviewed one-page item whose content is retained inside a larger
 * PDF. This covers historical divergent segmentation and an occasional later
 * rescan without turning fuzzy text similarity into automatic deletion.
 */
export const mergeContainedPageItem = internalMutation({
  args: {
    keepItemId: v.id("portfolioItems"),
    removeItemId: v.id("portfolioItems"),
    expectedKeepStorageId: v.id("_storage"),
    expectedRemoveStorageId: v.id("_storage"),
    containedPageNumber: v.number(),
    dismissedBy: v.optional(v.id("users")),
    dryRun: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    if (args.keepItemId === args.removeItemId) {
      throw new Error("Contained-page merge requires two different items");
    }
    const [keep, remove] = await Promise.all([
      ctx.db.get(args.keepItemId),
      ctx.db.get(args.removeItemId),
    ]);
    if (!keep || !remove) throw new Error("Portfolio item not found");
    if (
      keep.source !== "google_drive" ||
      remove.source !== "google_drive" ||
      keep.fileMimeType !== "application/pdf" ||
      remove.fileMimeType !== "application/pdf" ||
      !keep.driveFileId ||
      !remove.driveFileId ||
      !keep.pageRange ||
      !remove.pageRange ||
      keep.institutionId !== remove.institutionId
    ) {
      throw new Error("Items are not compatible Drive-derived PDFs");
    }
    if (
      keep.fileStorageId !== args.expectedKeepStorageId ||
      remove.fileStorageId !== args.expectedRemoveStorageId
    ) {
      throw new Error("Portfolio PDF changed after the contained-page review");
    }
    const keepPageCount = keep.pageRange.end - keep.pageRange.start + 1;
    const removePageCount = remove.pageRange.end - remove.pageRange.start + 1;
    if (
      keepPageCount <= 1 ||
      removePageCount !== 1 ||
      !Number.isInteger(args.containedPageNumber) ||
      args.containedPageNumber < 1 ||
      args.containedPageNumber > keepPageCount ||
      (keep.driveFileId !== remove.driveFileId &&
        remove._creationTime >= keep._creationTime)
    ) {
      throw new Error("Reviewed containment direction or page number is invalid");
    }
    if (
      keep.driveFileId === remove.driveFileId &&
      (remove.pageRange.start < keep.pageRange.start ||
        remove.pageRange.end > keep.pageRange.end)
    ) {
      throw new Error("Same-scan page range is not contained by the kept item");
    }
    const coverage = textCoverage(remove.extractedText, keep.extractedText);
    if (coverage < 0.7) {
      throw new Error("Contained-page text overlap is below the safety threshold");
    }
    const dismissDriveFile = keep.driveFileId !== remove.driveFileId;
    if (dismissDriveFile && !args.dismissedBy) {
      throw new Error("Cross-file contained-page repair requires a dismissal actor");
    }

    const prepared = await prepareMerge(ctx, keep, remove);
    const plan = {
      keepItemId: keep._id,
      removeItemId: remove._id,
      containedPageNumber: args.containedPageNumber,
      textCoverage: coverage,
      dismissRemovedDriveFile: dismissDriveFile,
      attachmentLinksToMove: prepared.attachments.filter(
        (attachment) => attachment.portfolioItemId === remove._id,
      ).length,
    };
    if (args.dryRun ?? true) return { dryRun: true, ...plan };

    await applyMerge(ctx, keep, remove, prepared, {
      dismissDriveFile,
      dismissedBy: args.dismissedBy,
    });
    return { dryRun: false, ...plan };
  },
});
