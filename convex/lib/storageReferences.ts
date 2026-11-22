// Whether some feature still holds a `_storage` blob.
//
// `_storage` is one flat namespace shared by portfolio scans, health
// documents, slide media, practice work, family-message attachments, capture
// stations, and more, so a storage id on one feature's row is not proof that
// feature alone owns the blob. Paths that adopt or delete a blob they cannot
// fully prove they created ask `storageReferencedByAnotherOwner` first.
//
// Convex gives no uploader provenance, so this is a backstop behind each
// caller's own proof, not a substitute for it. It covers every top-level
// `v.id("_storage")` column that holds user- or staff-uploaded content, each
// through an index. Not covered, on purpose: columns nested inside arrays or
// objects (activity resources, message attachments, `appAssetIds`, `mediaStorageIds`, chat
// `renderCheck`), which no index can reach, and admin-curated art (flair,
// badges, theme icons, institution logos, wonder/display/print assets), which no
// kiosk-reachable id could name by accident.

import type { Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";

/**
 * The caller's own holders of the blob, which must not count against it:
 * - family messaging excludes its whole attachments table (its delete paths
 *   look for a sibling attachment on the same blob themselves);
 * - a capture reservation excludes only itself;
 * - a capture excludes its own row, its own portfolio item, and the
 *   reservations it finalized (media and poster).
 * - a Decibel meter take excludes nothing: it asks before adopting a blob,
 *   and after deleting its own rows when discarding one.
 */
export type StorageReferenceExclusion =
  | { table: "parentMessageAttachments" }
  | { table: "decibelMeterTakes" }
  | {
      table: "captureStationUploadReservations";
      id: Id<"captureStationUploadReservations">;
    }
  | {
      table: "captureStationCaptures";
      id: Id<"captureStationCaptures">;
      portfolioItemId: Id<"portfolioItems">;
    };

// Two rows are enough to see past one excluded row on any index.
const LOOKAHEAD = 2;

/** True when an indexed owner other than `exclude` references this blob. */
export async function storageReferencedByAnotherOwner(
  ctx: Pick<QueryCtx | MutationCtx, "db">,
  storageId: Id<"_storage">,
  exclude: StorageReferenceExclusion,
): Promise<boolean> {
  const capture = exclude.table === "captureStationCaptures" ? exclude : null;
  const any = <T extends { _id: unknown }>(
    rows: T[],
    skip: (row: T) => boolean = () => false,
  ) => rows.some((row) => !skip(row));

  const ownItem = (row: { _id: unknown }) =>
    row._id === capture?.portfolioItemId;

  const references = await Promise.all([
    ctx.db
      .query("portfolioItems")
      .withIndex("by_file_storage", (q) => q.eq("fileStorageId", storageId))
      .take(LOOKAHEAD)
      .then((rows) => any(rows, ownItem)),
    // A capture's own item may hold its poster as `thumbStorageId`; any other
    // item holding the blob as a thumbnail or magic render is a foreign owner.
    ctx.db
      .query("portfolioItems")
      .withIndex("by_thumb_storage", (q) => q.eq("thumbStorageId", storageId))
      .take(LOOKAHEAD)
      .then((rows) => any(rows, ownItem)),
    ctx.db
      .query("portfolioItems")
      .withIndex("by_magic_storage", (q) => q.eq("magicStorageId", storageId))
      .take(LOOKAHEAD)
      .then((rows) => any(rows, ownItem)),
    ctx.db
      .query("portfolioItems")
      .withIndex("by_magic_thumb_storage", (q) =>
        q.eq("magicThumbStorageId", storageId),
      )
      .take(LOOKAHEAD)
      .then((rows) => any(rows, ownItem)),
    ctx.db
      .query("deliverables")
      .withIndex("by_file_storage", (q) => q.eq("fileStorageId", storageId))
      .take(1)
      .then((rows) => any(rows)),
    ctx.db
      .query("practiceAttempts")
      .withIndex("by_work_image", (q) => q.eq("workImageId", storageId))
      .take(1)
      .then((rows) => any(rows)),
    ctx.db
      .query("messages")
      .withIndex("by_image_storage", (q) => q.eq("imageId", storageId))
      .take(1)
      .then((rows) => any(rows)),
    ctx.db
      .query("messages")
      .withIndex("by_app_snapshot_storage", (q) =>
        q.eq("appSnapshotStorageId", storageId),
      )
      .take(1)
      .then((rows) => any(rows)),
    ctx.db
      .query("bugReports")
      .withIndex("by_audio_storage", (q) => q.eq("audioStorageId", storageId))
      .take(1)
      .then((rows) => any(rows)),
    ctx.db
      .query("bugReports")
      .withIndex("by_screenshot_storage", (q) =>
        q.eq("screenshotStorageId", storageId),
      )
      .take(1)
      .then((rows) => any(rows)),
    ctx.db
      .query("slackFiles")
      .withIndex("by_storage", (q) => q.eq("storageId", storageId))
      .take(1)
      .then((rows) => any(rows)),
    ctx.db
      .query("scholarDocuments")
      .withIndex("by_file_storage", (q) => q.eq("fileStorageId", storageId))
      .take(1)
      .then((rows) => any(rows)),
    ctx.db
      .query("healthRecordFiles")
      .withIndex("by_storage", (q) => q.eq("storageId", storageId))
      .take(1)
      .then((rows) => any(rows)),
    ctx.db
      .query("slideAssets")
      .withIndex("by_storage", (q) => q.eq("storageId", storageId))
      .take(1)
      .then((rows) => any(rows)),
    ctx.db
      .query("practiceWorkImages")
      .withIndex("by_storage", (q) => q.eq("storageId", storageId))
      .take(1)
      .then((rows) => any(rows)),
    ctx.db
      .query("equipment")
      .withIndex("by_photo", (q) => q.eq("photoStorageId", storageId))
      .take(1)
      .then((rows) => any(rows)),
    ctx.db
      .query("physicalTasks")
      .withIndex("by_photo", (q) => q.eq("photoStorageId", storageId))
      .take(1)
      .then((rows) => any(rows)),
    ctx.db
      .query("customApps")
      .withIndex("by_thumbnail", (q) => q.eq("thumbnailStorageId", storageId))
      .take(1)
      .then((rows) => any(rows)),
    ctx.db
      .query("decibelMeterTakes")
      .withIndex("by_audio_storage", (q) => q.eq("audioStorageId", storageId))
      .take(1)
      .then((rows) => any(rows)),
    // A claimed upload is only a receipt: the take that adopted it owns the blob.
    ctx.db
      .query("decibelMeterUploads")
      .withIndex("by_storage", (q) => q.eq("storageId", storageId))
      .take(LOOKAHEAD)
      .then((rows) => any(rows, (row) => row.claimedItemId !== undefined)),
    ctx.db
      .query("talkRecordings")
      .withIndex("by_storage", (q) => q.eq("storageId", storageId))
      .take(1)
      .then((rows) => any(rows)),
    ctx.db
      .query("captureStationCaptures")
      .withIndex("by_storage", (q) => q.eq("storageId", storageId))
      .take(LOOKAHEAD)
      .then((rows) => any(rows, (row) => row._id === capture?.id)),
    ctx.db
      .query("captureStationCaptures")
      .withIndex("by_video_thumb_storage", (q) =>
        q.eq("videoThumbStorageId", storageId),
      )
      .take(LOOKAHEAD)
      .then((rows) => any(rows, (row) => row._id === capture?.id)),
    exclude.table === "parentMessageAttachments"
      ? false
      : // eslint-disable-next-line local/no-raw-message-table-reads -- storage-borrow check: existence only, no message content or access decision
        ctx.db
          .query("parentMessageAttachments")
          .withIndex("by_storage", (q) => q.eq("storageId", storageId))
          .take(1)
          .then((rows) => any(rows)),
    ctx.db
      .query("captureStationUploadReservations")
      .withIndex("by_storage", (q) => q.eq("storageId", storageId))
      .take(LOOKAHEAD)
      .then((rows) =>
        any(
          rows,
          (row) =>
            (exclude.table === "captureStationUploadReservations" &&
              row._id === exclude.id) ||
            (capture !== null && row.captureId === capture.id),
        ),
      ),
  ]);
  return references.some(Boolean);
}
