import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx, MutationCtx } from "../_generated/server";

type AttributionCtx = Pick<QueryCtx, "db"> | Pick<MutationCtx, "db">;

/**
 * Link rows are canonical once present. The singular field remains a read
 * fallback until its widen/backfill/narrow rollout finishes.
 */
export async function attributedScholarIds(
  ctx: AttributionCtx,
  item: Doc<"portfolioItems">,
): Promise<Id<"users">[]> {
  const rows = await ctx.db
    .query("portfolioAttributions")
    .withIndex("by_item", (q) => q.eq("portfolioItemId", item._id))
    .collect();
  return [
    ...new Set([
      ...rows.map((row) => row.scholarId),
      ...(item.scholarId ? [item.scholarId] : []),
    ]),
  ];
}

export async function isAttributedToScholar(
  ctx: AttributionCtx,
  item: Doc<"portfolioItems">,
  scholarId: Id<"users">,
): Promise<boolean> {
  return (await attributedScholarIds(ctx, item)).some((id) => id === scholarId);
}

/**
 * Remove one learner from shared portfolio evidence without deleting peers'
 * access. Callers own deletion of the returned orphaned items and their blobs.
 */
export async function detachScholarFromPortfolio(
  ctx: Pick<MutationCtx, "db">,
  scholarId: Id<"users">,
): Promise<{
  orphanedItems: Doc<"portfolioItems">[];
  deletedAttributions: number;
  deletedCaptures: number;
}> {
  const primaryItems = await ctx.db
    .query("portfolioItems")
    .withIndex("by_scholar", (q) => q.eq("scholarId", scholarId))
    .collect();
  const scholarAttributions = await ctx.db
    .query("portfolioAttributions")
    .withIndex("by_scholar", (q) => q.eq("scholarId", scholarId))
    .collect();
  const itemIds = new Set(primaryItems.map((item) => item._id));
  for (const attribution of scholarAttributions) {
    itemIds.add(attribution.portfolioItemId);
  }

  const orphanedItems: Doc<"portfolioItems">[] = [];
  let deletedAttributions = 0;
  let deletedCaptures = 0;
  for (const itemId of itemIds) {
    const item = await ctx.db.get(itemId);
    if (!item) continue;
    const attributions = await ctx.db
      .query("portfolioAttributions")
      .withIndex("by_item", (q) => q.eq("portfolioItemId", itemId))
      .collect();
    const departing = attributions.filter(
      (attribution) => attribution.scholarId === scholarId,
    );
    const survivingIds = [
      ...new Set([
        ...attributions
          .filter((attribution) => attribution.scholarId !== scholarId)
          .map((attribution) => attribution.scholarId),
        ...(item.scholarId && item.scholarId !== scholarId
          ? [item.scholarId]
          : []),
      ]),
    ];
    for (const attribution of departing) {
      await ctx.db.delete(attribution._id);
      deletedAttributions += 1;
    }

    const captures = await ctx.db
      .query("captureStationCaptures")
      .withIndex("by_portfolio_item", (q) => q.eq("portfolioItemId", itemId))
      .collect();
    if (survivingIds.length === 0) {
      orphanedItems.push(item);
      for (const capture of captures) {
        await ctx.db.delete(capture._id);
        deletedCaptures += 1;
      }
      continue;
    }

    if (item.scholarId === scholarId) {
      await ctx.db.patch(itemId, { scholarId: survivingIds[0] });
    }
    for (const capture of captures) {
      await ctx.db.patch(capture._id, { scholarIds: survivingIds });
    }
  }
  return { orphanedItems, deletedAttributions, deletedCaptures };
}
