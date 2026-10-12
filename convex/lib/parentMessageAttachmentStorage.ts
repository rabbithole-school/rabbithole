// Which blobs a family-message attachment may delete.
//
// `_storage` is one flat namespace shared with portfolio scans, health
// documents, slide media, and practice work, so a storage id on an attachment
// row is not proof the attachment owns the blob. Every path that deletes an
// attachment's blob (discarding a staged upload, the 24h abandoned-upload
// sweep, and the account-deletion cascade) asks `attachmentOwnsBlob` first.

import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";

// Matches the lifetime of a Convex upload URL.
export const UPLOAD_RESERVATION_TTL_MS = 60 * 60 * 1000;

// Rows registered before upload reservations existed carry no reservation. The
// old client registered right after uploading and staged rows expire after
// 24h, so an honest legacy row (or a copy made when it was sent) is at most
// ~25h younger than its blob. An older blob was named, not uploaded.
const LEGACY_UPLOAD_WINDOW_MS = 25 * 60 * 60 * 1000;

/**
 * Whether deleting this attachment may delete its blob. An upload must prove
 * the uploader created the blob; a portfolio row never owns a blob its item
 * still holds; and no attachment deletes a blob another feature references.
 */
export async function attachmentOwnsBlob(
  ctx: Pick<MutationCtx, "db">,
  attachment: Doc<"parentMessageAttachments">,
): Promise<boolean> {
  if (attachment.source === "portfolio") {
    const item = attachment.portfolioItemId
      ? await ctx.db.get(attachment.portfolioItemId)
      : null;
    if (item?.fileStorageId === attachment.storageId) return false;
  } else {
    const storage = await ctx.db.system.get("_storage", attachment.storageId);
    if (!storage) return false;
    const proven =
      attachment.uploadReservedAt !== undefined
        ? storage._creationTime > attachment.uploadReservedAt
        : attachment._creationTime - storage._creationTime <=
          LEGACY_UPLOAD_WINDOW_MS;
    // An unproven row may name someone else's file. An orphaned blob is
    // recoverable; a deleted scan is not.
    if (!proven) return false;
  }
  return !(await storageReferencedOutsideParentMessages(
    ctx,
    attachment.storageId,
  ));
}

/**
 * True when a feature other than family messaging holds this blob. Only
 * tables with a storage index are checked, so this is a backstop behind the
 * upload proof above, not a substitute for it.
 */
export async function storageReferencedOutsideParentMessages(
  ctx: Pick<QueryCtx | MutationCtx, "db">,
  storageId: Id<"_storage">,
): Promise<boolean> {
  const references = await Promise.all([
    ctx.db
      .query("portfolioItems")
      .withIndex("by_file_storage", (q) => q.eq("fileStorageId", storageId))
      .first(),
    ctx.db
      .query("healthRecordFiles")
      .withIndex("by_storage", (q) => q.eq("storageId", storageId))
      .first(),
    ctx.db
      .query("slideAssets")
      .withIndex("by_storage", (q) => q.eq("storageId", storageId))
      .first(),
    ctx.db
      .query("practiceWorkImages")
      .withIndex("by_storage", (q) => q.eq("storageId", storageId))
      .first(),
    ctx.db
      .query("captureStationCaptures")
      .withIndex("by_storage", (q) => q.eq("storageId", storageId))
      .first(),
    ctx.db
      .query("captureStationCaptures")
      .withIndex("by_video_thumb_storage", (q) =>
        q.eq("videoThumbStorageId", storageId),
      )
      .first(),
    ctx.db
      .query("captureStationUploadReservations")
      .withIndex("by_storage", (q) => q.eq("storageId", storageId))
      .first(),
  ]);
  return references.some((row) => row !== null);
}
