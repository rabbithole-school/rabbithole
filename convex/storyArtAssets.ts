"use node";

// One-off production attachment step for pre-baked story art. The image model
// never runs here: scripts/bake-story-art.mjs commits the finished PNG bytes,
// then this action uploads each asset and patches its far-end knowledge node.

import { createHash } from "node:crypto";
import { internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { base64ToBytes, toStorageBlob } from "./lib/imageBytes";
import { STORY_ART_ASSETS } from "./seed/storyArtAssets";

/**
 * Upload the committed story PNGs and attach them by knowledgeNodes.nodeKey.
 * Re-running is cheap: a ready row with the same sha256 is skipped before any
 * storage write. Replaced blobs are deleted after the row points at the new one.
 *
 * Run manually after deploying the baked assets:
 *   npx convex run storyArtAssets:attach
 */
export const attach = internalAction({
  args: {},
  handler: async (
    ctx,
  ): Promise<{ attached: number; skipped: number; missing: string[] }> => {
    let attached = 0;
    let skipped = 0;
    const missing: string[] = [];

    for (const [nodeKey, asset] of Object.entries(STORY_ART_ASSETS)) {
      const bytes = base64ToBytes(asset.pngBase64);
      const actualHash = createHash("sha256").update(bytes).digest("hex");
      if (actualHash !== asset.contentHash) {
        throw new Error(`Story art hash mismatch for "${nodeKey}"`);
      }

      const current = await ctx.runQuery(internal.storyArt.attachmentForNode, {
        nodeKey,
      });
      if (!current) {
        missing.push(nodeKey);
        continue;
      }
      if (
        current.artStatus === "ready" &&
        current.artStorageId &&
        current.artContentHash === asset.contentHash
      ) {
        skipped++;
        continue;
      }

      const artStorageId = await ctx.storage.store(
        toStorageBlob(bytes, "image/png"),
      );
      const { previousArtStorageId } = await ctx.runMutation(
        internal.storyArt.setAttachment,
        {
          nodeId: current.nodeId,
          artStorageId,
          artContentHash: asset.contentHash,
        },
      );
      if (previousArtStorageId && previousArtStorageId !== artStorageId) {
        await ctx.storage.delete(previousArtStorageId);
      }
      attached++;
    }

    return { attached, skipped, missing };
  },
});
