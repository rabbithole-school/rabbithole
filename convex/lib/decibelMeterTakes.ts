// Deleting a Decibel meter take's own row (see decibelMeterTakes in
// schema.ts) when its portfolio item goes, from any of the delete paths:
// staff deleting from the inbox, a scholar's or a school's deletion. The
// item's own blobs (the video and its poster) are the caller's to delete; the
// take's sound file, which only exists until it is transcribed, is this
// row's.

import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { storageReferencedByAnotherOwner } from "./storageReferences";

/** Deletes the take row; returns its sound file, still to be deleted, if it had one. */
export async function detachMeterTakeRow(
  ctx: Pick<MutationCtx, "db">,
  portfolioItemId: Id<"portfolioItems">,
): Promise<Id<"_storage"> | null> {
  const take = await ctx.db
    .query("decibelMeterTakes")
    .withIndex("by_portfolio_item", (q) => q.eq("portfolioItemId", portfolioItemId))
    .unique();
  if (!take) return null;
  await ctx.db.delete(take._id);
  return take.audioStorageId ?? null;
}

/** Deletes the take row and its sound file. */
export async function deleteMeterTakeRow(
  ctx: Pick<MutationCtx, "db" | "storage">,
  portfolioItemId: Id<"portfolioItems">,
): Promise<void> {
  const audioStorageId = await detachMeterTakeRow(ctx, portfolioItemId);
  if (
    audioStorageId &&
    !(await storageReferencedByAnotherOwner(ctx, audioStorageId, { table: "decibelMeterTakes" }))
  ) {
    await ctx.storage.delete(audioStorageId);
  }
}

/**
 * Staff have touched a Decibel meter take (decibelMeterTakes.staffTookOverAt):
 * every staff edit of a portfolio item calls this, and the recorder's say
 * over the take ends for good.
 */
export async function markStaffTookOver(
  ctx: Pick<MutationCtx, "db">,
  item: { _id: Id<"portfolioItems">; source: string },
): Promise<void> {
  if (item.source !== "decibel_meter") return;
  const take = await ctx.db
    .query("decibelMeterTakes")
    .withIndex("by_portfolio_item", (q) => q.eq("portfolioItemId", item._id))
    .unique();
  if (take && take.staffTookOverAt === undefined) {
    await ctx.db.patch(take._id, { staffTookOverAt: Date.now() });
  }
}
