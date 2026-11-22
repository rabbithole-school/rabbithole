// Copy an app artifact's pictures so a static customApps row owns its own
// blobs and outlives the session that produced them. Shared by rehearsal
// starter promotion (vibecodeStarterActions.ts) and publishing a scholar's
// app (publishedApps.ts). The caller commits the rewritten HTML; when that
// commit fails it hands the copies to deleteAppAssetCopies, since nothing
// durable references them yet.

import type { ActionCtx } from "../_generated/server";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { MAX_STATIC_HTML_BYTES } from "../customApps";
import {
  MAX_APP_ASSETS,
  MAX_APP_ASSET_BYTES,
  requestedAppAssetIds,
  rewriteAppAssetRefs,
} from "../../shared/appAssets";
import { sniffImageMime } from "./imageBytes";
import { isCharmModelScript } from "./charmModelCode";

export async function copyArtifactAppAssets(
  ctx: ActionCtx,
  args: {
    artifactId: Id<"artifacts">;
    callerUserId: Id<"users">;
    html: string;
  },
): Promise<{ html: string; copied: Id<"_storage">[] }> {
  const sourceBytes = new TextEncoder().encode(args.html).length;
  if (sourceBytes > MAX_STATIC_HTML_BYTES) {
    throw new Error(
      `HTML is too large (${sourceBytes} bytes; max ${MAX_STATIC_HTML_BYTES}).`,
    );
  }
  const requested = requestedAppAssetIds(args.html);
  if (requested.length > MAX_APP_ASSETS) {
    throw new Error(`Apps may use at most ${MAX_APP_ASSETS} assets.`);
  }
  const authorized = await ctx.runQuery(
    internal.appAssets.authorizeArtifactAssets,
    {
      artifactId: args.artifactId,
      callerUserId: args.callerUserId,
      // The internal validator is the runtime guard for storage-id strings
      // parsed from the app HTML.
      assetIds: requested as Id<"_storage">[],
    },
  );

  const copied: Id<"_storage">[] = [];
  try {
    const replacements = new Map<string, string>();
    for (const { id, storageId } of authorized) {
      const blob = await ctx.storage.get(storageId);
      if (!blob) throw new Error("An app asset is no longer available.");
      const bytes = new Uint8Array(await blob.arrayBuffer());
      if (bytes.byteLength > MAX_APP_ASSET_BYTES) {
        throw new Error(
          `App assets must be ${MAX_APP_ASSET_BYTES} bytes or smaller.`,
        );
      }
      // A charm_model script travels with the app like a picture does.
      const mime = isCharmModelScript(bytes)
        ? "text/javascript"
        : sniffImageMime(bytes);
      if (!mime || mime === "image/gif") {
        throw new Error("App assets must be JPEG, PNG, or WebP images.");
      }
      const copy = await ctx.storage.store(
        new Blob([bytes as BlobPart], { type: mime }),
      );
      copied.push(copy);
      replacements.set(String(id), String(copy));
    }
    return { html: rewriteAppAssetRefs(args.html, replacements), copied };
  } catch (error) {
    await deleteAppAssetCopies(ctx, copied);
    throw error;
  }
}

/** Best-effort cleanup of copies no durable row references. */
export async function deleteAppAssetCopies(
  ctx: ActionCtx,
  copied: Id<"_storage">[],
): Promise<void> {
  for (const id of copied) {
    try {
      await ctx.storage.delete(id);
    } catch {
      // Nothing durable references this copy.
    }
  }
}
