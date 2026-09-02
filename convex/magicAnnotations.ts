"use node";

/**
 * Magic Annotations — model-calling actions (Node runtime).
 *
 * Two entry points, one per upload surface:
 *   - processChatImage     — a scholar uploaded an image in chat (http.ts).
 *   - processPortfolioItem — a scan landed in the portfolio (portfolioActions).
 *
 * Both run the SAME two-step pipeline (Andy's "same process for all uploads"
 * call): a cheap Haiku detection pass for Magic Corners, then — only on a
 * confident hit — a Gemini whole-image edit that redraws the framed region.
 * Pure logic (prompt, parser, instruction builder) lives in
 * `lib/magicAnnotations.ts`; this file just wires it to the models + storage.
 */

import { v } from "convex/values";
import { internalAction } from "./_generated/server";
import type { ActionCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { MODELS } from "./lib/models";
import { recordAnthropicUsage, recordImageUsage } from "./usage";
import { ROLES } from "./lib/roles";
import { detectImageMime, bytesToBase64, isPdfBytes, toStorageBlob, type ImageMime } from "./lib/imageBytes";
import { geminiGenerateImage } from "./lib/gemini";
import { rasterizePdfPages, renderThumbnailJpeg } from "./lib/thumbnail";
import { substitutePdfPages, type PageImage } from "./lib/pdfSubstitute";
import {
  DETECT_PROMPT,
  MAGIC_CONFIDENCE_THRESHOLD,
  buildEditInstruction,
  parseDetection,
  type MagicDetection,
} from "./lib/magicAnnotations";

/** Haiku vision pass: is there a Magic Corners marker, and what's inside it? */
async function detectFromBytes(
  ctx: ActionCtx,
  bytes: Uint8Array,
  mime: ReturnType<typeof detectImageMime>,
  institutionId: Id<"institutions"> | null = null,
): Promise<MagicDetection> {
  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  const anthropic = new Anthropic();
  const resp = await anthropic.messages.create({
    model: MODELS.HAIKU,
    max_tokens: 500,
    temperature: 0,
    messages: [
      {
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: mime, data: bytesToBase64(bytes) } },
          { type: "text", text: DETECT_PROMPT },
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ] as any,
      },
    ],
  });
  await recordAnthropicUsage(ctx, {
    source: "magic-annotation",
    role: ROLES.TEACHER,
    model: MODELS.HAIKU,
    usage: resp.usage,
    institutionId,
  });
  const text = resp.content.map((b) => (b.type === "text" ? b.text : "")).join("");
  return parseDetection(text);
}

/**
 * Gemini whole-image edit: send an image + instructions, get back a new image
 * with every framed region redrawn. One call handles all frames on the page.
 * Returns the raw bytes (caller stores or embeds them), or null on any failure.
 */
async function redrawImage(
  bytes: Uint8Array,
  mime: string,
  instructions: string[],
): Promise<{ bytes: Uint8Array; mime: string; model: string } | null> {
  const result = await geminiGenerateImage([
    { inlineData: { mimeType: mime, data: bytesToBase64(bytes) } },
    { text: buildEditInstruction(instructions) },
  ]);
  return result ? { bytes: result.bytes, mime: result.mimeType, model: result.model } : null;
}

/**
 * One image's full Magic step: detect ALL Magic Corners frames and, on at least
 * one confident hit, redraw every confident frame in a single edit. Returns the
 * redraw + a combined instruction (frames joined with "; "), or null when
 * there's no marker (or the redraw failed). The shared core of every path —
 * chat upload, single image item, and each page of a PDF.
 */
async function detectThenRedraw(
  ctx: ActionCtx,
  bytes: Uint8Array,
  mime: ImageMime,
  institutionId: Id<"institutions"> | null = null,
): Promise<{ redraw: { bytes: Uint8Array; mime: string }; instruction: string } | null> {
  const detection = await detectFromBytes(ctx, bytes, mime, institutionId);
  const instructions = detection.regions
    .filter((r) => r.confidence >= MAGIC_CONFIDENCE_THRESHOLD)
    .map((r) => r.instruction);
  if (instructions.length === 0) return null;

  const redraw = await redrawImage(bytes, mime, instructions);
  if (!redraw) return null;
  void recordImageUsage(ctx, {
    source: "magic-annotation",
    role: ROLES.TEACHER,
    institutionId,
    model: redraw.model,
  });
  return { redraw, instruction: instructions.join("; ") };
}

type ChatResult = {
  transformed: boolean;
  resultStorageId?: Id<"_storage">;
  instruction?: string;
};

/**
 * Chat path. Given an uploaded image's storageId, detect + (if a confident
 * marker) redraw. Returns the new image's storageId so the caller (http.ts) can
 * insert the message and emit the SSE event. Never throws — a failure just
 * returns `{ transformed: false }` and the normal tutor flow continues.
 */
export const processChatImage = internalAction({
  args: {
    storageId: v.id("_storage"),
    institutionId: v.optional(v.id("institutions")),
  },
  handler: async (ctx, args): Promise<ChatResult> => {
    if (!process.env.ANTHROPIC_API_KEY) return { transformed: false };
    try {
      const blob = await ctx.storage.get(args.storageId);
      if (!blob) return { transformed: false };
      const bytes = new Uint8Array(await blob.arrayBuffer());

      const r = await detectThenRedraw(
        ctx,
        bytes,
        detectImageMime(bytes),
        args.institutionId,
      );
      if (!r) return { transformed: false };
      const resultStorageId = await ctx.storage.store(
        toStorageBlob(r.redraw.bytes, r.redraw.mime),
      );
      return { transformed: true, resultStorageId, instruction: r.instruction };
    } catch (err) {
      console.error("[magicAnnotations.processChatImage]", err);
      return { transformed: false };
    }
  },
});

/**
 * Render + store a thumbnail of the magic result so a card can preview the
 * redraw cheaply (and so a magic PDF, whose redraw is a PDF, still has an
 * inline image preview). Best-effort — a thumb failure never blocks the magic
 * result itself.
 */
async function storeMagicThumb(
  ctx: ActionCtx,
  bytes: Uint8Array,
  mime: string,
): Promise<Id<"_storage"> | undefined> {
  try {
    const thumb = await renderThumbnailJpeg(bytes, mime);
    if (!thumb) return undefined;
    return await ctx.storage.store(toStorageBlob(thumb, "image/jpeg"));
  } catch (err) {
    console.error("[magicAnnotations] magic thumbnail failed", err);
    return undefined;
  }
}

/** Image portfolio item: one redraw, stored as the item's magic image. */
async function processImageItem(
  ctx: ActionCtx,
  itemId: Id<"portfolioItems">,
  fileBytes: Uint8Array,
  institutionId: Id<"institutions"> | null,
): Promise<void> {
  const r = await detectThenRedraw(
    ctx,
    fileBytes,
    detectImageMime(fileBytes),
    institutionId,
  );
  if (!r) return;
  const magicStorageId = await ctx.storage.store(
    toStorageBlob(r.redraw.bytes, r.redraw.mime),
  );
  const magicThumbStorageId = await storeMagicThumb(ctx, r.redraw.bytes, r.redraw.mime);
  await ctx.runMutation(internal.portfolio.setMagicResult, {
    itemId,
    magicStorageId,
    magicThumbStorageId,
    magicInstruction: r.instruction,
  });
}

/**
 * PDF portfolio item: a multi-page student submission. Look at EVERY page,
 * redraw any that carry a marker, and rebuild the PDF with those pages
 * substituted in place — so the stored magic version is a same-length PDF with
 * the kid's framed drawings turned into art, page-for-page.
 */
async function processPdfItem(
  ctx: ActionCtx,
  itemId: Id<"portfolioItems">,
  pdfBytes: Uint8Array,
  institutionId: Id<"institutions"> | null,
): Promise<void> {
  const { pages, total } = await rasterizePdfPages(pdfBytes);
  if (total > pages.length) {
    console.warn(
      `[magicAnnotations] item ${itemId}: scanned first ${pages.length}/${total} pages for markers (cap)`,
    );
  }

  const replacements = new Map<number, PageImage>();
  const instructions: string[] = [];
  for (let i = 0; i < pages.length; i++) {
    const r = await detectThenRedraw(ctx, pages[i], "image/png", institutionId);
    if (!r) continue;
    replacements.set(i, { bytes: r.redraw.bytes, mime: r.redraw.mime });
    instructions.push(pages.length > 1 ? `p${i + 1}: ${r.instruction}` : r.instruction);
  }
  if (replacements.size === 0) return;

  const substituted = await substitutePdfPages(pdfBytes, replacements);
  const magicStorageId = await ctx.storage.store(
    toStorageBlob(substituted, "application/pdf"),
  );
  const magicThumbStorageId = await storeMagicThumb(ctx, substituted, "application/pdf");
  await ctx.runMutation(internal.portfolio.setMagicResult, {
    itemId,
    magicStorageId,
    magicThumbStorageId,
    magicInstruction: instructions.join("; "),
  });
}

/**
 * Scanner path. Scheduled after a portfolio item lands. Handles image AND PDF
 * items (PDFs — what a network scanner like the Brother drops in Drive — are
 * scanned page-by-page and substituted in place). Non-blocking and
 * failure-tolerant by design; a per-item failure never breaks ingest.
 */
export const processPortfolioItem = internalAction({
  args: { itemId: v.id("portfolioItems") },
  handler: async (ctx, args): Promise<void> => {
    if (!process.env.ANTHROPIC_API_KEY) return;
    try {
      const item = await ctx.runQuery(internal.portfolio.aiGetItem, { itemId: args.itemId });
      if (!item || !item.fileStorageId) return;
      const institutionId = item.scholarId
        ? await ctx.runQuery(internal.usage.resolveInstitution, {
            userId: item.scholarId,
            principal: "scholar",
          })
        : null;
      const fileMime = item.fileMimeType ?? "";

      const blob = await ctx.storage.get(item.fileStorageId);
      if (!blob) return;
      const fileBytes = new Uint8Array(await blob.arrayBuffer());

      if (fileMime.startsWith("image/")) {
        await processImageItem(ctx, args.itemId, fileBytes, institutionId);
      } else if (fileMime === "application/pdf") {
        await processPdfItem(ctx, args.itemId, fileBytes, institutionId);
      }
    } catch (err) {
      console.error("[magicAnnotations.processPortfolioItem]", err);
    }
  },
});

/**
 * One-time backfill: give a magic thumbnail to magic items that were processed
 * before magic thumbnails existed (so their card can preview the redraw inline
 * + toggle, instead of only being able to OPEN it). Re-uses the stored magic
 * file — does NOT re-run detection/Gemini. Idempotent; run until thumbed=0.
 *   npx convex run magicAnnotations:backfillMagicThumbnails '{}'
 */
export const backfillMagicThumbnails = internalAction({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, args): Promise<{ scanned: number; thumbed: number }> => {
    const items = await ctx.runQuery(internal.portfolio.itemsMissingMagicThumb, {
      limit: args.limit ?? 200,
    });
    let thumbed = 0;
    for (const it of items) {
      try {
        const blob = await ctx.storage.get(it.magicStorageId);
        if (!blob) continue;
        const bytes = new Uint8Array(await blob.arrayBuffer());
        // A magic PDF starts with "%PDF"; anything else is an image redraw.
        const mime = isPdfBytes(bytes) ? "application/pdf" : detectImageMime(bytes);
        const thumbId = await storeMagicThumb(ctx, bytes, mime);
        if (thumbId) {
          await ctx.runMutation(internal.portfolio.setMagicThumb, {
            itemId: it.itemId,
            magicThumbStorageId: thumbId,
          });
          thumbed++;
        }
      } catch (err) {
        console.error("[magicAnnotations.backfillMagicThumbnails]", it.itemId, err);
      }
    }
    return { scanned: items.length, thumbed };
  },
});
