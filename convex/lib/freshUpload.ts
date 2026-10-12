// Whether a caller-supplied storage id may be written onto the caller's row.
//
// `_storage` is one flat namespace shared with scanned health documents and
// portfolio files, and a storage id carries no uploader. A row that stores a
// caller-supplied id lets an authorized read (`imageUrl`, `photoUrl`,
// `fileUrl`) and the tutor's vision input serve that blob back, so an id the
// caller merely learned must not be accepted (TRA-394). Every client uploads
// right before it names the blob, so an honest id is always a fresh blob; an
// old scan or portfolio file is not. `registerSlideAsset` applies the same
// recency rule to slide media.

import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";

// The native chat composer uploads when a picture is attached, not when the
// message is sent, so the window covers a scholar composing text around it.
// Matches the lifetime of a Convex upload URL.
export const FRESH_UPLOAD_WINDOW_MS = 60 * 60 * 1000;

export async function assertFreshUpload(
  ctx: Pick<MutationCtx, "db">,
  storageId: Id<"_storage">,
): Promise<void> {
  const storage = await ctx.db.system.get("_storage", storageId);
  if (!storage || Date.now() - storage._creationTime > FRESH_UPLOAD_WINDOW_MS) {
    throw new Error("Upload expired. Add the picture again.");
  }
}
