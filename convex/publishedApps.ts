// Publishing a scholar's app to other scholars. A teacher picks an app a
// scholar built (the teacher Apps page's scholar rows) and publishes it: the
// app's HTML and pictures are copied into a static custom app with its own
// launcher tile, which the teacher then grants through the existing app
// access drawer. The copy is frozen — the builder's later edits do not reach
// classmates until a teacher publishes the latest version, which replaces
// the copy in place (same tile, same grants, same saved state).
//
// Published apps are ordinary custom apps from there on: the /custom-apps
// launcher renders them, `appAudiences` grants control who sees the tile, and
// archiving the tile retires them. `customApps.publishedFrom` is what makes
// one a published copy (schema.ts).

import { getAuthUserId } from "@convex-dev/auth/server";
import { v } from "convex/values";
import { action, internalMutation, internalQuery } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import type { ActionCtx, QueryCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { assertWritableAction } from "./lib/auth";
import { isTeacherRole } from "./lib/roles";
import { requireActiveScholarAccess } from "./lib/access";
import { requireScholarAdminScope } from "./lib/externalAppsResolve";
import { liveReachOfExternalApp } from "./lib/externalAppReach";
import { couldHoldBuiltApp } from "./lib/homeOrigin";
import { writeAuditLog } from "./lib/auditLog";
import {
  copyArtifactAppAssets,
  deleteAppAssetCopies,
} from "./lib/appAssetCopy";
import {
  contentDigest,
  isPublishedCopyCurrent,
  livePublishedApp,
  publishSource,
} from "./lib/publishedAppSource";
import { generateAppToken, customAppPath } from "./customApps";
import { looksLikeHtml } from "../lib/vibecode/helpers";

/** What the access drawer needs to open on the published tile. */
export type PublishedAppTarget = {
  customAppId: Id<"customApps">;
  externalAppId: Id<"externalApps">;
  name: string;
  webUrl: string;
};

type Source = {
  rootSessionId: Id<"sessions">;
  builderId: Id<"users">;
  artifactId: Id<"artifacts">;
  revision: number;
  title: string;
  html: string;
};

const NO_APP = "This scholar has no app to publish yet.";
const OUT_OF_REACH =
  "This app reaches scholars outside your school, so it can't be republished from here.";
// Superseded pictures outlive a republish by a day: a classmate may have the
// old version open, or be mid-launch with its picture urls.
const SUPERSEDED_ASSET_GRACE_MS = 24 * 60 * 60 * 1000;
// Character and judge calls run against the scholar's session (appAi), which
// a launcher tile does not have — publishing would ship an app that breaks.
const USES_APP_AI =
  "This app talks to an AI character or judge, which only works inside the scholar's session, so it can't be published yet.";

/** The caller, if they are a teacher who can reach this session's scholar. */
async function requirePublisher(
  ctx: QueryCtx,
  callerUserId: Id<"users">,
  session: Doc<"sessions">,
): Promise<Doc<"users">> {
  const caller = await ctx.db.get(callerUserId);
  if (!caller) throw new Error("Not authenticated");
  // Teacher roles only, like the Apps page's archive (sessions.archiveApp),
  // and only for a scholar this teacher can reach.
  if (!isTeacherRole(caller.role)) throw new Error("Forbidden");
  await requireActiveScholarAccess(ctx, caller, session.userId);
  return caller;
}

async function readSource(
  ctx: QueryCtx,
  session: Doc<"sessions">,
): Promise<Source> {
  // Rehearsals and stubs are not a scholar's build (scholarBuiltApps.cardFor).
  if (session.isTestDrive || session.isOffline || session.seedExemplar) {
    throw new Error(NO_APP);
  }
  const activity = session.activityId
    ? await ctx.db.get(session.activityId)
    : null;
  if (!couldHoldBuiltApp(session, activity)) throw new Error(NO_APP);
  const { root, current } = await publishSource(ctx, session);
  if (!current || !looksLikeHtml(current.artifact.content)) {
    throw new Error(NO_APP);
  }
  if (current.artifact.appAi) throw new Error(USES_APP_AI);
  return {
    rootSessionId: root._id,
    builderId: session.userId,
    artifactId: current.artifact._id,
    revision: current.artifact.revision ?? 0,
    title: current.artifact.title || current.session.title,
    html: current.artifact.content,
  };
}

function targetFor(
  app: Doc<"customApps">,
  catalog: Doc<"externalApps">,
): PublishedAppTarget {
  return {
    customAppId: app._id,
    externalAppId: catalog._id,
    name: catalog.name,
    webUrl: catalog.webUrl,
  };
}

export const preparePublish = internalQuery({
  args: { sessionId: v.id("sessions"), callerUserId: v.id("users") },
  handler: async (
    ctx,
    args,
  ): Promise<
    | { kind: "existing"; target: PublishedAppTarget }
    | { kind: "new"; source: Source }
  > => {
    const session = await ctx.db.get(args.sessionId);
    if (!session) throw new Error("Session not found");
    await requirePublisher(ctx, args.callerUserId, session);
    const source = await readSource(ctx, session);
    const existing = await livePublishedApp(ctx, source.rootSessionId);
    if (existing) {
      return {
        kind: "existing",
        target: targetFor(existing.app, existing.catalog),
      };
    }
    return { kind: "new", source };
  },
});

export const commitPublish = internalMutation({
  args: {
    sessionId: v.id("sessions"),
    callerUserId: v.id("users"),
    artifactId: v.id("artifacts"),
    revision: v.number(),
    html: v.string(),
    appAssetIds: v.array(v.id("_storage")),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{ target: PublishedAppTarget; reused: boolean }> => {
    const session = await ctx.db.get(args.sessionId);
    if (!session) throw new Error("Session not found");
    const caller = await requirePublisher(ctx, args.callerUserId, session);
    const source = await readSource(ctx, session);
    // A second teacher (or a double click) published meanwhile: hand back
    // that copy and let the action drop the blobs this run copied.
    const existing = await livePublishedApp(ctx, source.rootSessionId);
    if (existing) {
      return {
        target: targetFor(existing.app, existing.catalog),
        reused: true,
      };
    }
    if (source.artifactId !== args.artifactId || source.revision !== args.revision) {
      throw new Error("The app changed while it was being published. Try again.");
    }
    const token = generateAppToken();
    const name = source.title.trim() || "Untitled app";
    const externalAppId = await ctx.db.insert("externalApps", {
      name,
      webUrl: customAppPath(token),
      createdBy: caller._id,
    });
    const customAppId = await ctx.db.insert("customApps", {
      token,
      name,
      kind: "static",
      status: "live",
      html: args.html,
      appAssetIds: args.appAssetIds.length > 0 ? args.appAssetIds : undefined,
      externalAppId,
      createdBy: caller._id,
      updatedAt: Date.now(),
      sourceArtifactId: source.artifactId,
      sourceRevision: source.revision,
      sourceDigest: contentDigest(source.html),
      publishedFrom: {
        sessionId: source.rootSessionId,
        builderId: source.builderId,
      },
    });
    await writeAuditLog(ctx, {
      actorUserId: caller._id,
      action: "scholar_app.published",
      targetUserId: source.builderId,
      detail: JSON.stringify({
        customAppId: String(customAppId),
        sessionId: String(source.rootSessionId),
        revision: source.revision,
      }),
      institutionId: session.institutionId ?? null,
    });
    const app = (await ctx.db.get(customAppId))!;
    const catalog = (await ctx.db.get(externalAppId))!;
    return { target: targetFor(app, catalog), reused: false };
  },
});

export const preparePublishLatest = internalQuery({
  args: { customAppId: v.id("customApps"), callerUserId: v.id("users") },
  handler: async (
    ctx,
    args,
  ): Promise<{ kind: "current" } | { kind: "update"; source: Source }> => {
    const { app, session } = await publishedRow(ctx, args.customAppId);
    const caller = await requirePublisher(ctx, args.callerUserId, session);
    await requireReachContained(ctx, caller, app);
    const source = await readSource(ctx, session);
    if (
      isPublishedCopyCurrent(app, {
        _id: source.artifactId,
        revision: source.revision,
        content: source.html,
      })
    ) {
      return { kind: "current" };
    }
    return { kind: "update", source };
  },
});

export const commitPublishLatest = internalMutation({
  args: {
    customAppId: v.id("customApps"),
    callerUserId: v.id("users"),
    artifactId: v.id("artifacts"),
    revision: v.number(),
    html: v.string(),
    appAssetIds: v.array(v.id("_storage")),
  },
  handler: async (ctx, args): Promise<void> => {
    const { app, session } = await publishedRow(ctx, args.customAppId);
    const caller = await requirePublisher(ctx, args.callerUserId, session);
    await requireReachContained(ctx, caller, app);
    const source = await readSource(ctx, session);
    if (source.artifactId !== args.artifactId || source.revision !== args.revision) {
      throw new Error("The app changed while it was being published. Try again.");
    }
    // Same token, tile and grants; only the copied app changes. The previous
    // copy's pictures are referenced by nothing once the html is replaced, but
    // open launchers may still be showing them, so they go after a grace.
    const retained = new Set(args.appAssetIds.map(String));
    const superseded = (app.appAssetIds ?? []).filter(
      (id) => !retained.has(String(id)),
    );
    await ctx.db.patch(app._id, {
      html: args.html,
      appAssetIds: args.appAssetIds.length > 0 ? args.appAssetIds : undefined,
      sourceArtifactId: source.artifactId,
      sourceRevision: source.revision,
      sourceDigest: contentDigest(source.html),
      updatedAt: Date.now(),
    });
    if (superseded.length > 0) {
      await ctx.scheduler.runAfter(
        SUPERSEDED_ASSET_GRACE_MS,
        internal.publishedApps.deleteSupersededAssets,
        { customAppId: app._id, storageIds: superseded },
      );
    }
    await writeAuditLog(ctx, {
      actorUserId: caller._id,
      action: "scholar_app.republished",
      targetUserId: source.builderId,
      detail: JSON.stringify({
        customAppId: String(app._id),
        revision: source.revision,
      }),
      institutionId: session.institutionId ?? null,
    });
  },
});

/**
 * Republishing replaces HTML every scholar the tile reaches will load, so the
 * caller must be able to see all of them — not just the builder, who may have
 * moved schools while classmates at the old one still have the tile. Same
 * containment rule as the catalog write gate (lib/externalAppReach.ts); a tile
 * granted to no one yet stays republishable by any teacher of the builder.
 */
async function requireReachContained(
  ctx: QueryCtx,
  caller: Doc<"users">,
  app: Doc<"customApps">,
): Promise<void> {
  if (!app.externalAppId) return;
  const reach = await liveReachOfExternalApp(ctx, app.externalAppId);
  if (reach.size === 0) return;
  const { scholars } = await requireScholarAdminScope(ctx, caller._id);
  if (scholars === "all") return;
  for (const id of reach) {
    if (!scholars.has(id)) throw new Error(OUT_OF_REACH);
  }
}

/** A live published copy and the lineage root it was published from. */
async function publishedRow(
  ctx: QueryCtx,
  customAppId: Id<"customApps">,
): Promise<{ app: Doc<"customApps">; session: Doc<"sessions"> }> {
  const app = await ctx.db.get(customAppId);
  if (!app?.publishedFrom || app.status !== "live" || app.kind !== "static") {
    throw new Error("That app isn't a published scholar app.");
  }
  const session = await ctx.db.get(app.publishedFrom.sessionId);
  if (!session) throw new Error(NO_APP);
  return { app, session };
}

/** Delete a republished copy's old pictures once the grace has passed —
 *  skipping any the copy uses again by then. */
export const deleteSupersededAssets = internalMutation({
  args: {
    customAppId: v.id("customApps"),
    storageIds: v.array(v.id("_storage")),
  },
  handler: async (ctx, args) => {
    const app = await ctx.db.get(args.customAppId);
    const inUse = new Set((app?.appAssetIds ?? []).map(String));
    for (const id of args.storageIds) {
      if (inUse.has(String(id))) continue;
      await deleteStorageIfPresent(ctx, id);
    }
  },
});

async function deleteStorageIfPresent(
  ctx: MutationCtx,
  id: Id<"_storage">,
): Promise<void> {
  if (await ctx.db.system.get(id)) await ctx.storage.delete(id);
}

async function callerFor(ctx: ActionCtx): Promise<Id<"users">> {
  const callerUserId = await getAuthUserId(ctx);
  if (!callerUserId) throw new Error("Not authenticated");
  await assertWritableAction(ctx);
  return callerUserId;
}

/**
 * Publish the app in this scholar session (any session of its free-play
 * lineage). Idempotent per lineage: an already-published app returns its
 * existing tile. Grants nothing — the caller opens the access drawer on the
 * returned tile so the teacher picks who gets it.
 */
export const publish = action({
  args: { sessionId: v.id("sessions") },
  handler: async (ctx, args): Promise<PublishedAppTarget> => {
    const callerUserId = await callerFor(ctx);
    const prepared = await ctx.runQuery(internal.publishedApps.preparePublish, {
      sessionId: args.sessionId,
      callerUserId,
    });
    if (prepared.kind === "existing") return prepared.target;
    const { source } = prepared;
    const { html, copied } = await copyArtifactAppAssets(ctx, {
      artifactId: source.artifactId,
      callerUserId,
      html: source.html,
    });
    try {
      const result = await ctx.runMutation(
        internal.publishedApps.commitPublish,
        {
          sessionId: args.sessionId,
          callerUserId,
          artifactId: source.artifactId,
          revision: source.revision,
          html,
          appAssetIds: copied,
        },
      );
      if (result.reused) await deleteAppAssetCopies(ctx, copied);
      return result.target;
    } catch (error) {
      await deleteAppAssetCopies(ctx, copied);
      throw error;
    }
  },
});

/** Replace a published copy with the builder's current app, in place. */
export const publishLatest = action({
  args: { customAppId: v.id("customApps") },
  handler: async (ctx, args): Promise<{ updated: boolean }> => {
    const callerUserId = await callerFor(ctx);
    const prepared = await ctx.runQuery(
      internal.publishedApps.preparePublishLatest,
      { customAppId: args.customAppId, callerUserId },
    );
    if (prepared.kind === "current") return { updated: false };
    const { source } = prepared;
    const { html, copied } = await copyArtifactAppAssets(ctx, {
      artifactId: source.artifactId,
      callerUserId,
      html: source.html,
    });
    try {
      await ctx.runMutation(internal.publishedApps.commitPublishLatest, {
        customAppId: args.customAppId,
        callerUserId,
        artifactId: source.artifactId,
        revision: source.revision,
        html,
        appAssetIds: copied,
      });
      return { updated: true };
    } catch (error) {
      await deleteAppAssetCopies(ctx, copied);
      throw error;
    }
  },
});
