// Runtime app-asset hydration. These actions are separate from appAssets.ts's
// internal queries so generated function references do not create a recursive
// type cycle inside one Convex module.

import { getAuthUserId } from "@convex-dev/auth/server";
import { v } from "convex/values";
import { action, type ActionCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import {
  MAX_APP_ASSET_BYTES,
  requestedAppAssetIds,
} from "../shared/appAssets";
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

async function hostedAppAsset(
  ctx: Pick<ActionCtx, "storage">,
  id: Id<"_storage">,
): Promise<HostedAppAsset> {
  const metadata = await ctx.storage.getMetadata(id);
  if (!metadata) throw new Error("An app asset is no longer available.");
  if (metadata.size > MAX_APP_ASSET_BYTES) {
    throw new Error(
      `App assets must be ${MAX_APP_ASSET_BYTES} bytes or smaller.`,
    );
  }
  const contentType = metadata.contentType?.split(";")[0].trim().toLowerCase();
  if (!contentType || !APP_ASSET_IMAGE_TYPES.has(contentType)) {
    throw new Error("App assets must be JPEG, PNG, or WebP images.");
  }
  const url = await ctx.storage.getUrl(id);
  if (!url) throw new Error("An app asset is no longer available.");
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
      source: "session" | "starter" | "charm";
    }> = await ctx.runQuery(internal.appAssets.authorizeArtifactAssets, {
      artifactId: args.artifactId,
      callerUserId,
      // The internal validator is the runtime guard for the storage-id strings
      // parsed from HTML.
      assetIds: requested as Id<"_storage">[],
    });
    return await Promise.all(
      authorized.map(({ id }) => hostedAppAsset(ctx, id)),
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
    };
  },
});
