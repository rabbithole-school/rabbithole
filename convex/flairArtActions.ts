"use node";

import { v } from "convex/values";

import { internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { openaiGenerateImage } from "./lib/openaiImage";
import { openaiImageUsageKey } from "./lib/models";
import {
  assertTransparentBackdrop,
  downscaleTransparentPng,
} from "./lib/spriteImage";
import { toStorageBlob } from "./lib/imageBytes";
import { buildFlairArtPrompt } from "./lib/themeIconArt";
import { recordImageUsage } from "./usage";

const FLAIR_ART_MAX_DIM = 256;
/** Flair renders in a 36px chip. "low" is the honest tier at that size. */
const FLAIR_ART_QUALITY = "low" as const;
const FLAIR_ART_DRAIN_BATCH_SIZE = 4;
const FLAIR_ART_DRAIN_DELAY_MS = 5_000;
const FLAIR_ART_RECOVERY_BATCH_MAX = 8;

export const generateFlairArt = internalAction({
  args: {
    id: v.id("flairArt"),
  },
  handler: async (ctx, { id }) => {
    const row = await ctx.runQuery(internal.flairArtInternal.getById, { id });
    if (!row || row.status !== "pending") return { status: "skipped" as const };

    const prompt = buildFlairArtPrompt(
      row.sourceLabel,
      row.sourceDescription,
    );
    let imageStorageId: Awaited<ReturnType<typeof ctx.storage.store>> | undefined;
    try {
      const image = await openaiGenerateImage(prompt, {
        quality: FLAIR_ART_QUALITY,
      });
      if (!image) {
        await ctx.runMutation(internal.flairArtInternal.markFailed, { id });
        return { status: "failed" as const };
      }

      void recordImageUsage(ctx, {
        source: "flair-art",
        institutionId: row.institutionId,
        model: openaiImageUsageKey(image.model, image.quality),
      });
      // The model returns real alpha, so the magenta screen and its keying
      // heuristics are gone. One guard survives the move, because alpha does
      // not make it unnecessary: the model can still PAINT an opaque tile into
      // the canvas, and publishing that would put a solid rectangle in the chip
      // row. Throwing here marks the row failed, same as before.
      assertTransparentBackdrop(image.bytes);
      const bytes = downscaleTransparentPng(image.bytes, FLAIR_ART_MAX_DIM);
      imageStorageId = await ctx.storage.store(
        toStorageBlob(bytes, "image/png"),
      );
      const accepted = await ctx.runMutation(internal.flairArtInternal.markReady, {
        id,
        imageStorageId,
        prompt,
        generationModel: image.model,
      });
      if (!accepted) {
        await ctx.storage.delete(imageStorageId);
        imageStorageId = undefined;
        return { status: "skipped" as const };
      }
      return { status: "ready" as const, model: image.model };
    } catch (error) {
      console.error("[flairArt] generation failed", error);
      if (imageStorageId) {
        await ctx.storage.delete(imageStorageId).catch((deleteError) => {
          console.error("[flairArt] failed to remove orphaned image", deleteError);
        });
      }
      await ctx.runMutation(internal.flairArtInternal.markFailed, { id });
      return { status: "failed" as const };
    }
  },
});

/**
 * Drain staged Flair art in small sequential batches. Backfills use this instead
 * of scheduling hundreds of independent provider calls at once.
 */
export const drainPending = internalAction({
  args: {},
  handler: async (
    ctx,
  ): Promise<{
    processed: number;
    ready: number;
    failed: number;
    scheduledNext: boolean;
  }> => {
    const rows = await ctx.runQuery(
      internal.flairArtInternal.listPendingForGeneration,
      { limit: FLAIR_ART_DRAIN_BATCH_SIZE },
    );
    let ready = 0;
    let failed = 0;
    for (const row of rows) {
      try {
        const result = await ctx.runAction(
          internal.flairArtActions.generateFlairArt,
          { id: row._id },
        );
        if (result.status === "ready") ready += 1;
        if (result.status === "failed") failed += 1;
      } catch (error) {
        console.error(`[flairArt] pending drain failed for ${row._id}`, error);
        await ctx.runMutation(internal.flairArtInternal.markFailed, {
          id: row._id,
        }).catch((statusError) => {
          console.error(
            `[flairArt] failed to record pending-drain failure for ${row._id}`,
            statusError,
          );
        });
        failed += 1;
      }
    }
    const scheduledNext = rows.length === FLAIR_ART_DRAIN_BATCH_SIZE;
    if (scheduledNext) {
      await ctx.scheduler.runAfter(
        FLAIR_ART_DRAIN_DELAY_MS,
        internal.flairArtActions.drainPending,
        {},
      );
    }
    return { processed: rows.length, ready, failed, scheduledNext };
  },
});

/**
 * Recovery for a precise failed-row list. Keep batches small: each image call is
 * awaited before the next begins so recovery cannot recreate the backfill's
 * original rate spike.
 */
export const regenerateIds = internalAction({
  args: {
    ids: v.array(v.id("flairArt")),
  },
  handler: async (ctx, { ids }) => {
    const uniqueIds = [...new Set(ids)];
    if (uniqueIds.length > FLAIR_ART_RECOVERY_BATCH_MAX) {
      throw new Error(
        `Flair art recovery batches are limited to ${FLAIR_ART_RECOVERY_BATCH_MAX} rows`,
      );
    }
    const results: Array<{
      id: (typeof uniqueIds)[number];
      status: "ready" | "failed" | "skipped";
      model?: string;
    }> = [];
    for (const id of uniqueIds) {
      const prepared = await ctx.runMutation(
        internal.flairArtInternal.prepareManualGeneration,
        { id },
      );
      if (!prepared) {
        results.push({ id, status: "skipped" });
        continue;
      }
      try {
        const result = await ctx.runAction(
          internal.flairArtActions.generateFlairArt,
          { id },
        );
        results.push({ id, ...result });
      } catch (error) {
        console.error(`[flairArt] re-mint failed for ${id}`, error);
        await ctx.runMutation(internal.flairArtInternal.markFailed, { id }).catch(
          (statusError) => {
            console.error(
              `[flairArt] failed to record re-mint failure for ${id}`,
              statusError,
            );
          },
        );
        results.push({ id, status: "failed" });
      }
    }
    return results;
  },
});
