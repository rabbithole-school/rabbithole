"use node";

// Badge-art generation — the one place that talks to the image model, so it
// lives in a "use node" action (the rest of badges.ts is V8-runtime mutations
// and can't be "use node").
//
// Flow: read the badge → build a topic-true prompt → call GPT-Image-2.5 with
// `background: "transparent"` → store the PNG → patch the row. The model emits
// real alpha, so there is no chroma screen to key out — which matters most
// here: a keyer could never cut a patch's merrowed stitched border or a
// medallion's specular falloff without fringing the edge that sells the object.

import { v } from "convex/values";
import { internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { buildBadgePrompt } from "./lib/badgeArt";
import { openaiGenerateImage } from "./lib/openaiImage";
import { openaiImageUsageKey } from "./lib/models";
import { toStorageBlob } from "./lib/imageBytes";
import { recordImageUsage } from "./usage";

export const generateBadgeArt = internalAction({
  args: { badgeId: v.id("scholarUnitBadges") },
  handler: async (ctx, { badgeId }): Promise<void> => {
    const data = await ctx.runQuery(internal.badges.getBadgeForArt, { badgeId });
    if (!data) return;
    // Never paint generative art over a Calculator License badge: its image
    // is the license card (calculatorLicenseCardActions.ts).
    if (data.kind === "calculator_license") return;

    const prompt = buildBadgePrompt({
      unitTitle: data.unitTitle,
      description: data.description,
      subject: data.subject,
      style: data.style,
      colorway: data.colorway,
    });

    // Unlike the tiled charm sprites, a badge is shown LARGE (the award
    // moment, then the portfolio), so it earns the "medium" tier.
    const image = await openaiGenerateImage(prompt, { quality: "medium" });
    if (!image) {
      await ctx.runMutation(internal.badges.setBadgeArtStatus, {
        badgeId,
        status: "failed",
      });
      return;
    }

    void recordImageUsage(ctx, {
      source: "badge-art",
      model: openaiImageUsageKey(image.model, image.quality),
    });

    const imageStorageId = await ctx.storage.store(
      toStorageBlob(image.bytes, image.mimeType),
    );
    await ctx.runMutation(internal.badges.setBadgeArt, {
      badgeId,
      imageStorageId,
      previousImageStorageId: data.previousImageStorageId ?? undefined,
    });
  },
});

/**
 * Backfill: re-mint every existing badge's art on the current prompt + model,
 * one scheduled `generateBadgeArt` per badge. Opt-in (run by hand):
 *   npx convex run badgeArtActions:regenerateAllBadgeArt
 *   npx convex run badgeArtActions:regenerateAllBadgeArt --prod
 */
export const regenerateAllBadgeArt = internalAction({
  args: {},
  handler: async (ctx): Promise<number> => {
    const ids = await ctx.runQuery(internal.badges.allBadgeIds, {});
    for (const badgeId of ids) {
      await ctx.runMutation(internal.badges.setBadgeArtStatus, {
        badgeId,
        status: "generating",
      });
      await ctx.scheduler.runAfter(0, internal.badgeArtActions.generateBadgeArt, {
        badgeId,
      });
    }
    return ids.length;
  },
});
