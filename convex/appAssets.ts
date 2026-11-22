// App assets — verified, storage-backed pictures for sandboxed HTML apps.
//
// App HTML stores only /app-assets/<storageId> references. The trusted host
// resolves those references before sandbox injection, after proving each blob
// belongs to the artifact's session or was inherited from a starter. Static
// launcher apps resolve only the copied blobs recorded on their customApps row.

import { ConvexError, v } from "convex/values";
import { internalQuery } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { isTeacherRole } from "./lib/roles";
import { requireActiveScholarAccess } from "./lib/access";
import { MAX_APP_ASSETS } from "../shared/appAssets";
import { assertMayReadTeacherArchived } from "./lib/teacherArchive";

type AuthorizedAsset = {
  /** The id the app HTML references. */
  id: Id<"_storage">;
  /** The blob to serve for it. Differs from `id` for a raw chat-photo
   *  reference whose message carries an app-usable copy (`appAssetId`): the
   *  copy is served so an app built before photos were prepared still loads. */
  storageId: Id<"_storage">;
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
    // A put-away app's pictures stay with it (teachers still resolve them).
    assertMayReadTeacherArchived(caller, session);

    const inherited = artifact.appAssetIds ?? [];
    const sessionAssets = session.appAssetIds ?? [];
    const messages = await ctx.db
      .query("messages")
      .withIndex("by_session", (q) => q.eq("sessionId", session._id))
      .collect();
    // A chat photo's app-usable copy stands in for the raw upload, and is an
    // asset in its own right (it is what the builder is told to reference).
    const sessionImages = new Map<Id<"_storage">, Id<"_storage">>();
    for (const message of messages) {
      if (message.appAssetId) {
        sessionImages.set(message.appAssetId, message.appAssetId);
      }
      if (message.imageId) {
        sessionImages.set(
          message.imageId,
          message.appAssetId ?? message.imageId,
        );
      }
    }

    const authorized: AuthorizedAsset[] = [];
    for (const id of ids) {
      const inheritedId = inherited.find((candidate) => candidate === id);
      if (inheritedId) {
        authorized.push({
          id: inheritedId,
          storageId: inheritedId,
          source: "starter",
        });
        continue;
      }
      const sessionAssetId = sessionAssets.find(
        (candidate) => candidate === id,
      );
      if (sessionAssetId) {
        authorized.push({
          id: sessionAssetId,
          storageId: sessionAssetId,
          source: "session",
        });
        continue;
      }
      const servedImageId = sessionImages.get(id);
      if (servedImageId) {
        authorized.push({ id, storageId: servedImageId, source: "session" });
        continue;
      }
      throw new ConvexError("That app asset does not belong to this session.");
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
    // A scholar's app a teacher published to classmates credits its builder
    // by first name (convex/publishedApps.ts). Like the app itself, the
    // credit reaches whoever holds the token — normally the classmates it was
    // granted to, but the link is a bearer link, so only a first name.
    const builder = row.publishedFrom
      ? await ctx.db.get(row.publishedFrom.builderId)
      : null;
    const credit = builder?.name?.trim().split(/\s+/)[0] || null;
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
      credit,
    };
  },
});
