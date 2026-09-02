"use node";

import { v } from "convex/values";
import { internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { renderThumbnailJpeg } from "./lib/thumbnail";

/**
 * Server-side thumbnail generation for portfolioItems. Scheduled (runAfter 0)
 * from every ingest path once an item has its final stored file:
 *
 *   - insertSegment        — Drive sync, Drive pick, direct upload, webcam photo
 *   - extractAndMatch (end) — legacy manual upload (after any rotation bake-in)
 *
 * Reads the file from Convex storage, derives a ~512px JPEG (photon for images,
 * PDFium page-1 raster for PDFs — see lib/thumbnail.ts), stores it, and points
 * thumbStorageId at it. Failures are swallowed into thumbStatus="error" so a bad
 * thumbnail never breaks ingest; the UI just shows the file-type icon.
 */

function toBlob(bytes: Uint8Array, type: string): Blob {
  const ab = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
  return new Blob([ab], { type });
}

export const generate = internalAction({
  args: { itemId: v.id("portfolioItems") },
  handler: async (ctx, args) => {
    const item = await ctx.runQuery(internal.portfolio.aiGetItem, {
      itemId: args.itemId,
    });
    if (!item || !item.fileStorageId) {
      // Nothing to render — leave the item without a thumb (icon fallback).
      return { ok: false, reason: "no-file" };
    }
    // Don't regenerate an existing thumb (e.g. backfill racing a fresh ingest).
    if (item.thumbStorageId) return { ok: true, reason: "already" };

    try {
      const blob = await ctx.storage.get(item.fileStorageId);
      if (!blob) throw new Error("Storage blob missing");
      const bytes = new Uint8Array(await blob.arrayBuffer());
      const mime = item.fileMimeType ?? "application/pdf";

      const jpeg = await renderThumbnailJpeg(bytes, mime);
      if (!jpeg) {
        // Mime not thumbnailable — mark error so the UI stops waiting.
        await ctx.runMutation(internal.portfolio.aiSetThumb, {
          itemId: args.itemId,
          status: "error",
        });
        return { ok: false, reason: "unsupported-mime" };
      }

      const thumbStorageId = await ctx.storage.store(toBlob(jpeg, "image/jpeg"));
      await ctx.runMutation(internal.portfolio.aiSetThumb, {
        itemId: args.itemId,
        thumbStorageId,
        status: "ready",
      });
      return { ok: true, bytes: jpeg.length };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[portfolioThumbs.generate] ${args.itemId} FAILED: ${message}`);
      await ctx.runMutation(internal.portfolio.aiSetThumb, {
        itemId: args.itemId,
        status: "error",
      });
      return { ok: false, error: message };
    }
  },
});

/**
 * Backfill: schedule thumbnail generation for existing items that have a file
 * but no thumbnail yet. Idempotent — generate() skips items that already have a
 * thumb. Run on dev to verify; on prod with approval.
 *
 *   npx convex run portfolioThumbs:backfill '{}'
 *   npx convex run portfolioThumbs:backfill '{"limit": 50}'
 */
export const backfill = internalAction({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const items = await ctx.runQuery(internal.portfolio.itemsMissingThumb, {
      limit: args.limit ?? 200,
    });
    let scheduled = 0;
    for (const id of items) {
      // Mark pending so the UI shows a loading state, then queue generation.
      await ctx.runMutation(internal.portfolio.aiSetThumb, {
        itemId: id,
        status: "pending",
      });
      await ctx.scheduler.runAfter(0, internal.portfolioThumbs.generate, {
        itemId: id,
      });
      scheduled++;
    }
    return { scheduled };
  },
});
