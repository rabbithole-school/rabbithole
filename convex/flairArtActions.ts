"use node";

import { v } from "convex/values";

import { internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { geminiGenerateImage } from "./lib/gemini";
import {
  GEMINI_IMAGE_MODEL,
  GEMINI_IMAGE_QUOTA_FALLBACK_MODEL,
} from "./lib/models";
import { removeChromaScreen } from "./lib/chromaImage";
import { toStorageBlob } from "./lib/imageBytes";
import { buildFlairArtPrompt } from "./lib/themeIconArt";
import { recordImageUsage } from "./usage";

const FLAIR_ART_MAX_DIM = 256;
const FLAIR_ART_DRAIN_BATCH_SIZE = 4;
const FLAIR_ART_DRAIN_DELAY_MS = 5_000;
const FLAIR_ART_RECOVERY_BATCH_MAX = 8;

export const generateFlairArt = internalAction({
  args: {
    id: v.id("flairArt"),
    modelOverride: v.optional(
      v.union(
        v.literal(GEMINI_IMAGE_MODEL),
        v.literal(GEMINI_IMAGE_QUOTA_FALLBACK_MODEL),
      ),
    ),
  },
  handler: async (ctx, { id, modelOverride }) => {
    const row = await ctx.runQuery(internal.flairArtInternal.getById, { id });
    if (!row || row.status !== "pending") return { status: "skipped" as const };

    const prompt = buildFlairArtPrompt(
      row.sourceLabel,
      row.sourceDescription,
    );
    let imageStorageId: Awaited<ReturnType<typeof ctx.storage.store>> | undefined;
    try {
      const image = await geminiGenerateImage([{ text: prompt }], {
        aspectRatio: "1:1",
        ...(modelOverride
          ? { model: modelOverride }
          : { quotaFallbackModel: GEMINI_IMAGE_QUOTA_FALLBACK_MODEL }),
      });
      if (!image) {
        await ctx.runMutation(internal.flairArtInternal.markFailed, { id });
        return { status: "failed" as const };
      }

      void recordImageUsage(ctx, {
        source: "flair-art",
        institutionId: row.institutionId,
        model: image.model,
      });
      const bytes = removeChromaScreen(image.bytes, {
        screen: "magenta",
        maxDim: FLAIR_ART_MAX_DIM,
        minAlphaComponentFraction: 0.0008,
        requireTransparentBackdrop: true,
      });
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
 * Model-pinned recovery for a precise failed-row list. Keep batches small: each
 * image call is awaited before the next begins so recovery cannot recreate the
 * backfill's original quota spike.
 */
export const generateIdsWithModel = internalAction({
  args: {
    ids: v.array(v.id("flairArt")),
    model: v.union(
      v.literal(GEMINI_IMAGE_MODEL),
      v.literal(GEMINI_IMAGE_QUOTA_FALLBACK_MODEL),
    ),
  },
  handler: async (ctx, { ids, model }) => {
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
          { id, modelOverride: model },
        );
        results.push({ id, ...result });
      } catch (error) {
        console.error(`[flairArt] model-pinned generation failed for ${id}`, error);
        await ctx.runMutation(internal.flairArtInternal.markFailed, { id }).catch(
          (statusError) => {
            console.error(
              `[flairArt] failed to record model-pinned failure for ${id}`,
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
