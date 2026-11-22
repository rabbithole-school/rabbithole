// Runtime app-asset hydration. These actions are separate from appAssets.ts's
// internal queries so generated function references do not create a recursive
// type cycle inside one Convex module.

import { getAuthUserId } from "@convex-dev/auth/server";
import { ConvexError, v } from "convex/values";
import { action, type ActionCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import {
  MAX_APP_ASSET_BYTES,
  appAssetScriptUrl,
  requestedAppAssetIds,
} from "../shared/appAssets";
import { isCharmModelScript } from "./lib/charmModelCode";
import { uniqueAssetIds } from "./appAssets";

type HostedAppAsset = {
  id: string;
  url: string;
};

const APP_ASSET_IMAGE_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
]);

// ConvexError so the reason reaches the host (a plain Error is scrubbed to
// "Server Error" on the client), where the builder shows it to the scholar
// and the render check reports it to the tutor.
async function hostedAppAsset(
  ctx: Pick<ActionCtx, "storage">,
  id: Id<"_storage">,
  /** The blob to serve for `id` (a chat photo's app-usable copy). */
  storageId: Id<"_storage"> = id,
): Promise<HostedAppAsset> {
  const metadata = await ctx.storage.getMetadata(storageId);
  if (!metadata) throw new ConvexError("An app asset is no longer available.");
  if (metadata.size > MAX_APP_ASSET_BYTES) {
    throw new ConvexError(
      `App assets must be ${MAX_APP_ASSET_BYTES} bytes or smaller.`,
    );
  }
  const contentType = metadata.contentType?.split(";")[0].trim().toLowerCase();
  if (contentType === "text/javascript") {
    // A charm_model script: the sandbox CSP runs only inline scripts, so ship
    // the source itself and let the host inline it (inlineAppAssetScripts).
    const blob = await ctx.storage.get(storageId);
    if (!blob) throw new ConvexError("An app asset is no longer available.");
    const bytes = new Uint8Array(await blob.arrayBuffer());
    if (!isCharmModelScript(bytes)) {
      throw new ConvexError("App assets must be JPEG, PNG, or WebP images.");
    }
    return { id: String(id), url: appAssetScriptUrl(new TextDecoder().decode(bytes)) };
  }
  if (!contentType || !APP_ASSET_IMAGE_TYPES.has(contentType)) {
    throw new ConvexError("App assets must be JPEG, PNG, or WebP images.");
  }
  const url = await ctx.storage.getUrl(storageId);
  if (!url) throw new ConvexError("An app asset is no longer available.");
  return { id: String(id), url };
}

export const resolveArtifactAssets = action({
  args: {
    artifactId: v.id("artifacts"),
    html: v.string(),
  },
  handler: async (
    ctx,
    args,
  ): Promise<HostedAppAsset[]> => {
    const callerUserId = await getAuthUserId(ctx);
    if (!callerUserId) throw new Error("Not authenticated");
    const requested = uniqueAssetIds(requestedAppAssetIds(args.html));
    const authorized: Array<{
      id: Id<"_storage">;
      storageId: Id<"_storage">;
      source: "session" | "starter" | "charm";
    }> = await ctx.runQuery(internal.appAssets.authorizeArtifactAssets, {
      artifactId: args.artifactId,
      callerUserId,
      // The internal validator is the runtime guard for the storage-id strings
      // parsed from HTML.
      assetIds: requested as Id<"_storage">[],
    });
    return await Promise.all(
      authorized.map(({ id, storageId }) =>
        hostedAppAsset(ctx, id, storageId),
      ),
    );
  },
});

type CustomAppHostResult = {
  kind: "static" | "coded";
  name: string;
  status: "building" | "live";
  html: string | null;
  routePath: string | null;
  origin: "starter" | null;
  thumbnailUrl: string | null;
  appAssets: HostedAppAsset[];
  /** The builder's first name when a teacher published a scholar's app. */
  credit: string | null;
};

export const resolveCustomAppForHost = action({
  args: { token: v.string() },
  handler: async (ctx, args): Promise<CustomAppHostResult | null> => {
    const app = await ctx.runQuery(internal.appAssets.customAppForHost, {
      token: args.token.trim(),
    });
    if (!app || app.kind !== "static" || app.html === null) {
      return app
        ? {
            kind: app.kind,
            name: app.name,
            status: app.status,
            html: app.html,
            routePath: app.routePath,
            origin: app.origin,
            thumbnailUrl: app.thumbnailUrl,
            appAssets: [],
            credit: app.credit,
          }
        : null;
    }

    const requested = uniqueAssetIds(requestedAppAssetIds(app.html));
    const allowed = new Set(app.appAssetIds.map(String));
    const appAssets: HostedAppAsset[] = [];
    for (const rawId of requested) {
      if (!allowed.has(rawId)) {
        throw new Error("That app contains an unowned asset reference.");
      }
      const id = app.appAssetIds.find(
        (candidate: Id<"_storage">) => String(candidate) === rawId,
      );
      if (!id) throw new Error("That app asset is not available.");
      appAssets.push(await hostedAppAsset(ctx, id));
    }
    return {
      kind: app.kind,
      name: app.name,
      status: app.status,
      html: app.html,
      routePath: app.routePath,
      origin: app.origin,
      thumbnailUrl: app.thumbnailUrl,
      appAssets,
      credit: app.credit,
    };
  },
});
