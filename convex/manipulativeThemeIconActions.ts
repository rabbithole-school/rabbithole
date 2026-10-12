"use node";

// Generative manipulative theme-icon art — the one place that talks to the
// image model AND post-processes the result, so it's a "use node" action (the
// downscale needs Node's zlib via pngjs). Same pipeline as quest-badge art
// (convex/badgeArtActions.ts): build a fill-icon prompt → GPT-Image-2.5, which
// returns real alpha → downscale to sprite size → store → patch the row.
// Fire-and-forget from the resolver `ensure` mutation.

import { v } from "convex/values";
import { internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { buildThemeIconPrompt } from "./lib/themeIconArt";
import { openaiGenerateImage } from "./lib/openaiImage";
import { openaiImageUsageKey } from "./lib/models";
import { recordImageUsage } from "./usage";
import { toStorageBlob } from "./lib/imageBytes";
import { downscaleTransparentPng } from "./lib/spriteImage";

/** Longer-edge cap for a theme icon. It tiles at ~30–64px; 256 stays crisp on
 *  retina while making the stored PNG a small, fast first paint. */
export const THEME_ICON_MAX_DIM = 256;

/** A theme icon is never shown above ~64px, so the cheap tier is the honest
 *  one: "low" is a quarter of "medium"'s image-output tokens and the difference
 *  is invisible once the 1024px render is boxed down to THEME_ICON_MAX_DIM. */
const THEME_ICON_QUALITY = "low" as const;

export const generateThemeIcon = internalAction({
  args: {
    id: v.id("manipulativeThemeIcons"),
    preserveExistingOnFailure: v.optional(v.boolean()),
  },
  handler: async (
    ctx,
    { id, preserveExistingOnFailure },
  ): Promise<{ status: "ready"; model: string } | { status: "failed" }> => {
    const row = await ctx.runQuery(
      internal.manipulativeThemeIcons.getForGeneration,
      { id },
    );
    if (!row) return { status: "failed" };

    try {
      // Species rows carry the `world:<setting>:<species>` namespace on their
      // cache key (`row.label`); manipulative rows do not. Feed the FULL key to
      // the prompt builder for species so it can apply the charm camera + the
      // setting-phrase referent steering (buildThemeIconPrompt branches on the
      // `world:` prefix). Manipulative rows keep using `displayLabel` — the
      // original-cased drawable noun — so their prompt is byte-identical to
      // before. `displayLabel` alone drops the namespace, which is why it can't
      // carry the species branch.
      const promptLabel = row.label.startsWith("world:")
        ? row.label
        : row.displayLabel;
      const prompt = buildThemeIconPrompt(promptLabel);
      const image = await openaiGenerateImage(prompt, {
        quality: THEME_ICON_QUALITY,
      });
      if (!image) {
        if (!preserveExistingOnFailure) {
          await ctx.runMutation(internal.manipulativeThemeIcons.setStatus, {
            id,
            status: "failed",
          });
        }
        return { status: "failed" };
      }

      void recordImageUsage(ctx, {
        source: "theme-icon",
        model: openaiImageUsageKey(image.model, image.quality),
      });

      // The model already returned alpha; all that is left is size. Theme icons
      // tile small (~30–64px), so cap the stored PNG — a 1024px render is ~800KB
      // of detail nobody ever sees.
      //
      // A decode failure here is NOT recoverable and must not be swallowed. The
      // old pipeline could fall back to storing the raw bytes, because those
      // bytes were a valid image that had merely failed to be keyed. Now the
      // only way this throws is that the response was not a decodable PNG at
      // all, so storing it would publish a permanently broken asset and mark
      // the row ready — worse than failing and letting the label retry.
      const bytes = downscaleTransparentPng(image.bytes, THEME_ICON_MAX_DIM);

      const imageStorageId = await ctx.storage.store(
        toStorageBlob(bytes, "image/png"),
      );
      await ctx.runMutation(internal.manipulativeThemeIcons.setArt, {
        id,
        imageStorageId,
        prompt,
        generationModel: image.model,
      });
      return { status: "ready", model: image.model };
    } catch (err) {
      console.error("[themeIcon] generation failed", err);
      try {
        if (!preserveExistingOnFailure) {
          await ctx.runMutation(internal.manipulativeThemeIcons.setStatus, {
            id,
            status: "failed",
          });
        }
      } catch (statusErr) {
        console.error("[themeIcon] failed to record generation failure", statusErr);
      }
      throw err;
    }
  },
});

/**
 * Re-mint a precise cache-key list, one label at a time.
 *
 * Probe one label before a batch:
 *   npx convex run manipulativeThemeIconActions:regenerateLabels \
 *     '{"labels":["world:coral reef ecosystem:fish"]}'
 *
 * Ready assets remain live if generation fails, so a re-mint can never replace
 * working art with a blank.
 */
export const regenerateLabels = internalAction({
  args: {
    labels: v.array(v.string()),
  },
  handler: async (ctx, { labels }) => {
    const results: Array<{
      label: string;
      status: "ready" | "failed" | "invalid";
      model?: string;
    }> = [];
    for (const label of labels) {
      const prepared = await ctx.runMutation(
        internal.manipulativeThemeIcons.prepareManualGeneration,
        { label },
      );
      if (!prepared) {
        results.push({ label, status: "invalid" });
        continue;
      }
      try {
        const result = await ctx.runAction(
          internal.manipulativeThemeIconActions.generateThemeIcon,
          {
            id: prepared.id,
            preserveExistingOnFailure: prepared.preserveExisting,
          },
        );
        results.push({ label, ...result });
      } catch (error) {
        console.error(`[themeIcon] re-mint failed for ${label}`, error);
        results.push({ label, status: "failed" });
      }
    }
    return results;
  },
});

/**
 * Warm a set of labels (opt-in, run by hand) — e.g. pre-generate the labels the
 * static practice library uses so their first render isn't a plain-shape flash:
 *   npx convex run manipulativeThemeIconActions:warmLabels '{"labels":["pig","apple","cauldron"]}'
 * Idempotent: a label already cached is skipped.
 */
export const warmLabels = internalAction({
  args: { labels: v.array(v.string()) },
  handler: async (ctx, { labels }): Promise<number> => {
    let scheduled = 0;
    for (const label of labels) {
      const id = await ctx.runMutation(
        internal.manipulativeThemeIcons.ensureInternal,
        { label },
      );
      if (id) scheduled += 1;
    }
    return scheduled;
  },
});

/**
 * ONE-OFF migration: shrink every cached icon that was baked before the
 * sprite-size cap, IN PLACE — fetch the stored PNG, area-downscale it (art
 * preserved, no Gemini reroll), and re-store. Icons already under the cap are
 * left untouched. Run by hand after deploying the cap:
 *   npx convex run manipulativeThemeIconActions:downscaleExisting
 */
export const downscaleExisting = internalAction({
  args: {},
  handler: async (ctx): Promise<{ shrunk: number; skipped: number }> => {
    const rows = await ctx.runQuery(
      internal.manipulativeThemeIcons.listReadyWithAsset,
      {},
    );
    let shrunk = 0;
    let skipped = 0;
    for (const row of rows) {
      const blob = await ctx.storage.get(row.imageStorageId);
      if (!blob) {
        skipped += 1;
        continue;
      }
      const before = new Uint8Array(await blob.arrayBuffer());
      const after = downscaleTransparentPng(before, THEME_ICON_MAX_DIM);
      if (after.byteLength === before.byteLength) {
        // Unchanged → already within the cap; leave the asset as-is.
        skipped += 1;
        continue;
      }
      const imageStorageId = await ctx.storage.store(
        toStorageBlob(after, "image/png"),
      );
      await ctx.runMutation(internal.manipulativeThemeIcons.setArt, {
        id: row.id,
        imageStorageId,
        prompt: row.prompt,
        generationModel: row.generationModel,
      });
      shrunk += 1;
    }
    return { shrunk, skipped };
  },
});
