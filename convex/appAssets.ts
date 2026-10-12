// App assets — verified, storage-backed pictures for sandboxed HTML apps.
//
// App HTML stores only /app-assets/<storageId> references. The trusted host
// resolves those references before sandbox injection, after proving each blob
// belongs to the artifact's session or was inherited from a starter. Static
// launcher apps resolve only the copied blobs recorded on their customApps row.

import { v } from "convex/values";
import { internalQuery } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { isTeacherRole } from "./lib/roles";
import { requireActiveScholarAccess } from "./lib/access";
import { MAX_APP_ASSETS } from "../shared/appAssets";

type AuthorizedAsset = {
  id: Id<"_storage">;
  source: "session" | "starter";
};

export function uniqueAssetIds<T extends string>(rawIds: T[]): T[] {
  const ids = [...new Set(rawIds)];
  if (ids.length > MAX_APP_ASSETS) {
    throw new Error(`Apps may use at most ${MAX_APP_ASSETS} assets.`);
  }
  return ids;
}

export const authorizeArtifactAssets = internalQuery({
  args: {
    artifactId: v.id("artifacts"),
    callerUserId: v.id("users"),
    assetIds: v.array(v.id("_storage")),
  },
  handler: async (ctx, args): Promise<AuthorizedAsset[]> => {
    const ids = uniqueAssetIds(args.assetIds);
    const artifact = await ctx.db.get(args.artifactId);
    if (!artifact) throw new Error("Artifact not found");
    const session = await ctx.db.get(artifact.sessionId);
    if (!session) throw new Error("Artifact session not found");
    const caller = await ctx.db.get(args.callerUserId);
    if (!caller) throw new Error("Not authenticated");
    if (session.userId !== caller._id) {
      if (!isTeacherRole(caller.role)) throw new Error("Forbidden");
      await requireActiveScholarAccess(ctx, caller, session.userId);
    }

    const inherited = artifact.appAssetIds ?? [];
    const sessionAssets = session.appAssetIds ?? [];
    const messages = await ctx.db
      .query("messages")
      .withIndex("by_session", (q) => q.eq("sessionId", session._id))
      .collect();
    const sessionImages = messages.flatMap((message) =>
      message.imageId ? [message.imageId] : [],
    );

    const authorized: AuthorizedAsset[] = [];
    for (const id of ids) {
      const inheritedId = inherited.find((candidate) => candidate === id);
      if (inheritedId) {
        authorized.push({ id: inheritedId, source: "starter" });
        continue;
      }
      const sessionAssetId = sessionAssets.find(
        (candidate) => candidate === id,
      );
      if (sessionAssetId) {
        authorized.push({ id: sessionAssetId, source: "session" });
        continue;
      }
      const messageImageId = sessionImages.find(
        (candidate) => candidate === id,
      );
      if (messageImageId) {
        authorized.push({ id: messageImageId, source: "session" });
        continue;
      }
      throw new Error("That app asset does not belong to this session.");
    }
    return authorized;
  },
});

export const customAppForHost = internalQuery({
  args: { token: v.string() },
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("customApps")
      .withIndex("by_token", (q) => q.eq("token", args.token))
      .first();
    if (!row || row.status === "archived") return null;
    const thumbnailUrl = row.thumbnailStorageId
      ? await ctx.storage.getUrl(row.thumbnailStorageId)
      : null;
    return {
      kind: row.kind,
      name: row.name,
      status: row.status,
      html:
        row.kind === "static" && row.status === "live"
          ? row.html ?? ""
          : null,
      routePath:
        row.kind === "coded" && row.status === "live"
          ? row.routePath ?? null
          : null,
      origin: row.origin ?? null,
      thumbnailUrl,
      appAssetIds: row.appAssetIds ?? [],
    };
  },
});
