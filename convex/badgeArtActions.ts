"use node";

// Badge-art generation — the one place that talks to the image model AND
// post-processes the result, so it lives in a "use node" action (PNG decode +
// chroma-key need Node's zlib via pngjs; the rest of badges.ts is V8-runtime
// mutations and can't be "use node").
//
// Flow: read the badge → build a topic-true prompt (rendered on a flat
// chroma-green screen) → call Gemini → strip the green to real transparency
// (lib/badgeChroma.ts) → store the PNG → patch the row. The image model can't
// emit alpha itself, which is why we green-screen + key instead.

import { v } from "convex/values";
import { internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { buildBadgePrompt } from "./lib/badgeArt";
import { geminiGenerateImage } from "./lib/gemini";
import { toStorageBlob } from "./lib/imageBytes";
import { removeGreenScreen } from "./lib/chromaImage";
import { recordImageUsage } from "./usage";

export const generateBadgeArt = internalAction({
  args: { badgeId: v.id("scholarUnitBadges") },
  handler: async (ctx, { badgeId }): Promise<void> => {
    const data = await ctx.runQuery(internal.badges.getBadgeForArt, { badgeId });
    if (!data) return;

    const prompt = buildBadgePrompt({
      unitTitle: data.unitTitle,
      description: data.description,
      subject: data.subject,
      style: data.style,
      colorway: data.colorway,
    });

    const image = await geminiGenerateImage([{ text: prompt }], {
      aspectRatio: "1:1",
    });
    if (!image) {
      await ctx.runMutation(internal.badges.setBadgeArtStatus, {
        badgeId,
        status: "failed",
      });
      return;
    }

    void recordImageUsage(ctx, { source: "badge-art", model: image.model });

    // Strip the chroma-green background to real transparency. If decode/key ever
    // fails, fall back to the raw image — a badge with a green square beats no
    // badge — so a codec hiccup can't drop the award.
    let bytes: Uint8Array = image.bytes;
    let mime = image.mimeType;
    try {
      bytes = removeGreenScreen(image.bytes);
      mime = "image/png";
    } catch (err) {
      console.error("[badgeArt] chroma-key failed; storing raw image", err);
    }

    const imageStorageId = await ctx.storage.store(toStorageBlob(bytes, mime));
    await ctx.runMutation(internal.badges.setBadgeArt, {
      badgeId,
      imageStorageId,
      previousImageStorageId: data.previousImageStorageId ?? undefined,
    });
  },
});

/**
 * Backfill: re-mint every existing badge's art so it picks up the green-screen
 * prompt + transparent cut. Existing badges were rendered on opaque white /
 * charcoal, which can't be keyed — so this REGENERATES them (new transparent
 * art), one scheduled `generateBadgeArt` per badge. Opt-in (run by hand):
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
