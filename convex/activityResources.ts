import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import {
  internalMutation,
  internalQuery,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import { finalizeAndSplit } from "./sessionHelpers";
import { requireUnitEditAccess, requireUnitEditAccessForUser } from "./lib/auth";
import { requireActiveScholarAccess } from "./lib/access";
import { authedMutation, authedQuery } from "./lib/customFunctions";
import { classifyAideUpload } from "./lib/aideUploadMimes";
import { resolveDeckAssetUrls, storedDeck } from "./lib/slideAssetUrls";
import { activityResourceDisplayRows } from "./lib/activityResourceDisplay";
import {
  isMaterialActivityResource,
  parsedPresentationDeck,
  presentationState,
} from "./lib/activityPresentationResources";
import { resolveReachableActivityResources } from "./lib/activityResourceReachability";
import { isTeacherRole } from "./lib/roles";
import { requireProgramHandoutAccess } from "./lib/programHandoutAccess";
import { validateActivityResourceUrl } from "../shared/activityResourceUrl";
import { effectiveActivityKind } from "../shared/appSurface";

/** Effective kinds whose activities carry tutor-facing resources (TRA-519:
 * an app activity, in either shape, is one). */
const RESOURCE_ACTIVITY_KINDS: ReadonlySet<string> = new Set(["online", "vibecode"]);

export const ACTIVITY_RESOURCE_MAX_BYTES = 25 * 1024 * 1024;
export const ACTIVITY_RESOURCE_AI_MAX_BYTES = 20 * 1024 * 1024;

function normalizedTitle(title: string, fallback: string): string {
  return title.trim() || fallback;
}

export function validateResourceUrl(raw: string): string {
  const result = validateActivityResourceUrl(raw);
  if (!result.ok) throw new Error(result.error);
  return result.url;
}

export function validateActivityResourceFile(args: {
  fileName: string;
  mimeType: string;
  sizeBytes: number;
}): "image" | "pdf" | "docx" | "rtf" | "text" {
  if (args.sizeBytes <= 0) throw new Error("The uploaded file is empty");
  if (args.sizeBytes > ACTIVITY_RESOURCE_MAX_BYTES) {
    throw new Error("Activity resource files must be 25 MB or smaller");
  }
  const lowerName = args.fileName.trim().toLowerCase();
  const lowerMime = args.mimeType.split(";")[0].trim().toLowerCase();
  if (lowerName.endsWith(".doc") || lowerMime === "application/msword") {
    throw new Error("Legacy .doc files are not supported; upload DOCX instead");
  }
  const kind = classifyAideUpload(lowerMime, lowerName);
  if (
    (kind === "image" || kind === "pdf") &&
    args.sizeBytes > ACTIVITY_RESOURCE_AI_MAX_BYTES
  ) {
    throw new Error("PDF and image resources must be 20 MB or smaller");
  }
  if (kind === "image") {
    const extension = lowerName.split(".").pop() ?? "";
    const inferredImageMime = {
      png: "image/png",
      jpg: "image/jpeg",
      jpeg: "image/jpeg",
      gif: "image/gif",
      webp: "image/webp",
    }[extension];
    if (
      !["image/jpeg", "image/png", "image/gif", "image/webp"].includes(
        lowerMime,
      ) &&
      !inferredImageMime
    ) {
      throw new Error("Images must be PNG, JPEG, GIF, or WebP");
    }
    return kind;
  }
  if (
    kind !== "pdf" &&
    kind !== "docx" &&
    kind !== "rtf" &&
    kind !== "text"
  ) {
    throw new Error(
      "Upload a PDF, image, DOCX, RTF, TXT, or Markdown file",
    );
  }
  return kind;
}

function canonicalResourceMime(
  kind: "image" | "pdf" | "docx" | "rtf" | "text",
  mimeType: string,
  fileName: string,
): string {
  if (kind === "pdf") return "application/pdf";
  if (kind === "docx") {
    return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  }
  if (kind === "rtf") return "application/rtf";
  if (kind === "text") return "text/plain";
  const normalizedMime = mimeType.split(";")[0].trim().toLowerCase();
  if (["image/jpeg", "image/png", "image/gif", "image/webp"].includes(normalizedMime)) {
    return normalizedMime;
  }
  const extension = fileName.trim().toLowerCase().split(".").pop() ?? "";
  const inferred = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
  }[extension];
  if (!inferred) throw new Error("Images must be PNG, JPEG, GIF, or WebP");
  return inferred;
}

async function nextOrder(
  ctx: MutationCtx,
  activityId: Id<"activities">,
): Promise<number> {
  const rows = await ctx.db
    .query("activityResources")
    .withIndex("by_activity", (query) => query.eq("activityId", activityId))
    .collect();
  return rows.reduce((max, row) => Math.max(max, row.order), -1) + 1;
}

async function editorRows(
  ctx: Parameters<typeof requireUnitEditAccess>[0],
  activityId: Id<"activities">,
) {
  const rows = await ctx.db
    .query("activityResources")
    .withIndex("by_activity", (query) => query.eq("activityId", activityId))
    .collect();
  return rows
    .filter(isMaterialActivityResource)
    .sort((a, b) => a.order - b.order);
}

// The resource edit gate, resolved against an explicitly-supplied user rather
// than `ctx.auth`. The aide/Slack/MCP path runs in an internal mutation with a
// verified callerUserId but no `ctx.user`, so it can't go through the
// auth-reading `requireResourceEditAccess`; it shares THIS so the tenancy and
// ownership checks are exactly the ones the teacher UI gets (TRA-245).
async function requireResourceEditAccessForUser(
  ctx: QueryCtx | MutationCtx,
  user: Doc<"users">,
  args: {
    activityId: Id<"activities">;
    assignmentId?: Id<"assignments">;
  },
) {
  if (args.assignmentId) {
    return {
      kind: "programHandout" as const,
      ...(await requireProgramHandoutAccess(
        { ...ctx, user },
        {
          activityId: args.activityId,
          assignmentId: args.assignmentId,
        },
      )),
    };
  }
  return {
    kind: "unit" as const,
    ...(await requireUnitEditAccessForUser(ctx, user, {
      activityId: args.activityId,
    })),
  };
}

async function requireResourceEditAccess(
  ctx: (QueryCtx | MutationCtx) & { user: Doc<"users"> },
  args: {
    activityId: Id<"activities">;
    assignmentId?: Id<"assignments">;
  },
) {
  return await requireResourceEditAccessForUser(ctx, ctx.user, args);
}

async function pruneResourceReferencesInUnit(
  ctx: MutationCtx,
  unitId: Id<"units">,
  resourceIds: Iterable<Id<"activityResources">>,
): Promise<void> {
  const removed = new Set([...resourceIds].map(String));
  if (removed.size === 0) return;
  const lessons = await ctx.db
    .query("lessons")
    .withIndex("by_unit", (query) => query.eq("unitId", unitId))
    .collect();
  const activities = (
    await Promise.all(
      lessons.map((lesson) =>
        ctx.db
          .query("activities")
          .withIndex("by_lesson", (query) =>
            query.eq("lessonId", lesson._id),
          )
          .collect(),
      ),
    )
  ).flat();
  for (const activity of activities) {
    if (!activity.referencedResourceIds?.some((id) => removed.has(String(id)))) {
      continue;
    }
    const referencedResourceIds = activity.referencedResourceIds.filter(
      (id) => !removed.has(String(id)),
    );
    await ctx.db.patch(activity._id, {
      referencedResourceIds:
        referencedResourceIds.length > 0 ? referencedResourceIds : undefined,
    });
  }
}

export const listForActivity = authedQuery({
  args: {
    activityId: v.id("activities"),
    assignmentId: v.optional(v.id("assignments")),
  },
  handler: async (ctx, args) => {
    await requireResourceEditAccess(ctx, args);
    const rows = await editorRows(ctx, args.activityId);
    return await Promise.all(
      rows.map(async (row) => ({
        _id: row._id,
        title: row.title,
        source: row.source,
        order: row.order,
        extractionStatus: row.extractionStatus ?? null,
        extractionError: row.extractionError ?? null,
        familyVisibility: row.familyVisibility ?? ("staff_only" as const),
        url:
          row.source.kind === "file"
            ? await ctx.storage.getUrl(row.source.fileStorageId)
            : row.source.url,
      })),
    );
  },
});

export const referenceOptionsForActivity = authedQuery({
  args: {
    activityId: v.id("activities"),
    assignmentId: v.optional(v.id("assignments")),
  },
  handler: async (ctx, args) => {
    const access = await requireResourceEditAccess(ctx, args);
    if (access.kind === "programHandout") {
      return { options: [], selectedResourceIds: [] };
    }
    const { unit } = access;
    const lessons = await ctx.db
      .query("lessons")
      .withIndex("by_unit", (query) => query.eq("unitId", unit._id))
      .collect();
    lessons.sort((a, b) => a.order - b.order);

    const options = [];
    for (const lesson of lessons) {
      const activities = await ctx.db
        .query("activities")
        .withIndex("by_lesson", (query) =>
          query.eq("lessonId", lesson._id),
        )
        .collect();
      activities.sort((a, b) => a.order - b.order);
      for (const activity of activities) {
        if (activity._id === args.activityId) continue;
        const resources = await editorRows(ctx, activity._id);
        for (const resource of resources) {
          options.push({
            resourceId: resource._id,
            title: resource.title,
            kind: resource.source.kind,
            fileName:
              resource.source.kind === "file"
                ? resource.source.fileName
                : null,
            mimeType:
              resource.source.kind === "file"
                ? resource.source.mimeType
                : null,
            ownerActivityId: activity._id,
            ownerActivityTitle: activity.title,
            ownerLessonTitle: lesson.title,
            url:
              resource.source.kind === "file"
                ? await ctx.storage.getUrl(resource.source.fileStorageId)
                : resource.source.url,
          });
        }
      }
    }
    const selectedResourceIds = (
      await resolveReachableActivityResources(ctx, args.activityId)
    ).referenced.map((resource) => resource._id);
    return { options, selectedResourceIds };
  },
});

export const setReferencedResources = authedMutation({
  args: {
    activityId: v.id("activities"),
    assignmentId: v.optional(v.id("assignments")),
    resourceIds: v.array(v.id("activityResources")),
  },
  handler: async (ctx, args) => {
    const access = await requireResourceEditAccess(ctx, args);
    if (access.kind === "programHandout") {
      if (args.resourceIds.length > 0) {
        throw new Error("Program handouts cannot reference unit resources");
      }
      await ctx.db.patch(args.activityId, { referencedResourceIds: undefined });
      return;
    }
    if (new Set(args.resourceIds.map(String)).size !== args.resourceIds.length) {
      throw new Error("Choose each referenced resource only once");
    }
    const resolved = await resolveReachableActivityResources(
      ctx,
      args.activityId,
      args.resourceIds,
    );
    if (resolved.invalidReferencedResourceIds.length > 0) {
      throw new Error(
        "Resources must be scholar-safe material from another activity in this unit",
      );
    }
    await ctx.db.patch(args.activityId, {
      referencedResourceIds:
        args.resourceIds.length > 0 ? args.resourceIds : undefined,
    });
  },
});

/** Teacher-only presentation metadata; never use this on scholar/session reads. */
export const presentationsForActivity = authedQuery({
  args: {
    activityId: v.id("activities"),
    assignmentId: v.optional(v.id("assignments")),
  },
  handler: async (ctx, args) => {
    await requireResourceEditAccess(ctx, args);
    const activity = await ctx.db.get(args.activityId);
    if (!activity) return [];
    const presentations = await presentationState(ctx, activity);
    const rows = [];
    if (presentations.rabbit) {
      rows.push({
        title:
          parsedPresentationDeck(presentations.rabbit.deck)?.title ??
          "Rabbit Slides",
        source: presentations.rabbit,
        principalKind: null,
        canActAsPrincipal: false,
      });
    }
    if (presentations.google) {
      const { principal, ...source } = presentations.google;
      rows.push({
        title: presentations.google.name?.trim() || "Google Slides",
        source,
        principalKind: principal.kind,
        canActAsPrincipal:
          principal.kind === "workspace_bot" ||
          (principal.kind === "personal_oauth" &&
            principal.userId === ctx.user._id),
      });
    }
    return rows;
  },
});

/**
 * Serving URLs for the activity's Rabbit Slides media, behind the same edit
 * gate as `presentationsForActivity`. Only ids in the stored deck, or slide
 * media the caller uploaded, resolve (TRA-389).
 */
export const presentationAssetUrls = authedQuery({
  args: {
    activityId: v.id("activities"),
    assignmentId: v.optional(v.id("assignments")),
    storageIds: v.array(v.id("_storage")),
  },
  handler: async (ctx, args) => {
    await requireResourceEditAccess(ctx, args);
    const activity = await ctx.db.get(args.activityId);
    if (!activity) return [];
    const presentations = await presentationState(ctx, activity);
    return await resolveDeckAssetUrls(ctx, {
      storageIds: args.storageIds,
      deck: storedDeck(presentations.rabbit?.deck),
      callerId: ctx.user._id,
    });
  },
});

export const listForSession = authedQuery({
  args: { sessionId: v.id("sessions") },
  handler: async (ctx, args) => {
    const session = await ctx.db.get(args.sessionId);
    if (!session) throw new Error("Session not found");
    const isTeacher = isTeacherRole(ctx.user.role);
    if (!isTeacher && session.userId !== ctx.user._id) {
      throw new Error("Forbidden");
    }
    const accessScholarId = session.isTestDrive
      ? session.testDriveAsScholarId
      : session.userId;
    if (accessScholarId && accessScholarId !== ctx.user._id) {
      await requireActiveScholarAccess(ctx, ctx.user, accessScholarId);
    }
    if (!session.activityId) return [];
    const activity = await ctx.db.get(session.activityId);
    // Online activities (an app activity included — the tutor reads its
    // resources too, matching sessionHelpers) carry tutor-facing resources.
    if (!activity || !RESOURCE_ACTIVITY_KINDS.has(effectiveActivityKind(activity))) return [];

    return await activityResourceDisplayRows(ctx, session.activityId);
  },
});

export const generateUploadUrl = authedMutation({
  args: {
    activityId: v.id("activities"),
    assignmentId: v.optional(v.id("assignments")),
  },
  handler: async (ctx, args) => {
    await requireResourceEditAccess(ctx, args);
    return await ctx.storage.generateUploadUrl();
  },
});

export const registerFile = authedMutation({
  args: {
    activityId: v.id("activities"),
    assignmentId: v.optional(v.id("assignments")),
    title: v.string(),
    fileName: v.string(),
    storageId: v.id("_storage"),
  },
  handler: async (ctx, args) => {
    await requireResourceEditAccess(ctx, args);
    const metadata = await ctx.db.system.get("_storage", args.storageId);
    if (!metadata) {
      return {
        ok: false as const,
        error: "The uploaded file is unavailable",
      };
    }
    const mimeType = metadata.contentType ?? "";
    let fileKind: "image" | "pdf" | "docx" | "rtf" | "text";
    try {
      fileKind = validateActivityResourceFile({
        fileName: args.fileName,
        mimeType,
        sizeBytes: metadata.size,
      });
    } catch (error) {
      await ctx.storage.delete(args.storageId);
      return {
        ok: false as const,
        error: error instanceof Error ? error.message : String(error),
      };
    }

    const id = await ctx.db.insert("activityResources", {
      activityId: args.activityId,
      title: normalizedTitle(args.title, args.fileName),
      source: {
        kind: "file",
        fileStorageId: args.storageId,
        fileName: args.fileName.trim() || "resource",
        mimeType: canonicalResourceMime(fileKind, mimeType, args.fileName),
        sizeBytes: metadata.size,
      },
      order: await nextOrder(ctx, args.activityId),
      uploadedBy: ctx.user._id,
      extractionStatus: "pending",
    });
    await ctx.scheduler.runAfter(
      0,
      internal.activityResourceActions.extractText,
      { resourceId: id },
    );
    return { ok: true as const, resourceId: id };
  },
});

// Insert a link/video resource on an activity. Shared by the teacher-UI
// addLink/addVideo mutations, the aide's aideAddUrlResource, and the YouTube
// dispatch rewrite in convex/assignments.ts — so a video resource is created
// exactly one way. Callers own the access check before calling this.
export async function addUrlResource(
  ctx: MutationCtx,
  user: Doc<"users">,
  args: {
    activityId: Id<"activities">;
    title: string;
    url: string;
    kind: "link" | "video";
  },
) {
  const url = validateResourceUrl(args.url);
  return await ctx.db.insert("activityResources", {
    activityId: args.activityId,
    title: normalizedTitle(
      args.title,
      args.kind === "video" ? "Video" : "Website",
    ),
    source: { kind: args.kind, url },
    order: await nextOrder(ctx, args.activityId),
    uploadedBy: user._id,
  });
}

export const addLink = authedMutation({
  args: {
    activityId: v.id("activities"),
    assignmentId: v.optional(v.id("assignments")),
    title: v.string(),
    url: v.string(),
  },
  handler: async (ctx, args) => {
    await requireResourceEditAccess(ctx, args);
    return await addUrlResource(ctx, ctx.user, { ...args, kind: "link" });
  },
});

export const addVideo = authedMutation({
  args: {
    activityId: v.id("activities"),
    assignmentId: v.optional(v.id("assignments")),
    title: v.string(),
    url: v.string(),
  },
  handler: async (ctx, args) => {
    await requireResourceEditAccess(ctx, args);
    return await addUrlResource(ctx, ctx.user, { ...args, kind: "video" });
  },
});

// Aide/Slack/MCP entry: add a link/video resource to an activity on behalf of a
// verified teacher (there is no `ctx.user` here). Reuses the SAME access gate
// and insert helper the teacher UI's addLink/addVideo use, so the tenancy and
// ownership checks can't drift from the UI (TRA-245). Returns the stored title
// so the tool can name it back to the teacher.
export const aideAddUrlResource = internalMutation({
  args: {
    callerUserId: v.id("users"),
    activityId: v.id("activities"),
    assignmentId: v.optional(v.id("assignments")),
    title: v.string(),
    url: v.string(),
    kind: v.union(v.literal("link"), v.literal("video")),
  },
  handler: async (
    ctx,
    { callerUserId, activityId, assignmentId, title, url, kind },
  ) => {
    const user = await ctx.db.get(callerUserId);
    if (!user) throw new Error("Caller not found.");
    if (!isTeacherRole(user.role)) {
      throw new Error("Adding an activity resource is teacher/admin only.");
    }
    await requireResourceEditAccessForUser(ctx, user, {
      activityId,
      assignmentId,
    });
    const resourceId = await addUrlResource(ctx, user, {
      activityId,
      title,
      url,
      kind,
    });
    return {
      resourceId,
      title: normalizedTitle(title, kind === "video" ? "Video" : "Website"),
    };
  },
});

export const rename = authedMutation({
  args: {
    resourceId: v.id("activityResources"),
    title: v.string(),
    assignmentId: v.optional(v.id("assignments")),
  },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.resourceId);
    if (!row || !isMaterialActivityResource(row)) {
      throw new Error("Material resource not found");
    }
    await requireResourceEditAccess(ctx, {
      activityId: row.activityId,
      assignmentId: args.assignmentId,
    });
    const title = args.title.trim();
    if (!title) throw new Error("Resource title is required");
    await ctx.db.patch(args.resourceId, { title });
  },
});

/**
 * Teacher opt-in that lets a family see one material resource in the parent
 * portal's course view. Same edit gate as every other resource write, so a
 * program-handout author can share their own handout's materials without
 * curriculum access. Presentation decks are teacher instruments and have no
 * family rendering — they are rejected rather than silently ignored.
 */
export const setFamilyVisibility = authedMutation({
  args: {
    resourceId: v.id("activityResources"),
    assignmentId: v.optional(v.id("assignments")),
    familyVisibility: v.union(
      v.literal("staff_only"),
      v.literal("families"),
    ),
  },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.resourceId);
    if (!row) throw new Error("Resource not found");
    await requireResourceEditAccess(ctx, {
      activityId: row.activityId,
      assignmentId: args.assignmentId,
    });
    if (!isMaterialActivityResource(row)) {
      throw new Error("Presentations cannot be shared with families");
    }
    await ctx.db.patch(args.resourceId, {
      familyVisibility: args.familyVisibility,
    });
  },
});

export const reorder = authedMutation({
  args: {
    activityId: v.id("activities"),
    assignmentId: v.optional(v.id("assignments")),
    resourceIds: v.array(v.id("activityResources")),
  },
  handler: async (ctx, args) => {
    await requireResourceEditAccess(ctx, args);
    const rows = await editorRows(ctx, args.activityId);
    const expected = new Set(rows.map((row) => String(row._id)));
    if (
      args.resourceIds.length !== expected.size ||
      args.resourceIds.some((id) => !expected.has(String(id)))
    ) {
      throw new Error("Resource order must include every activity resource");
    }
    await Promise.all(
      args.resourceIds.map((id, order) => ctx.db.patch(id, { order })),
    );
  },
});

export const retryExtraction = authedMutation({
  args: {
    resourceId: v.id("activityResources"),
    assignmentId: v.optional(v.id("assignments")),
  },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.resourceId);
    if (!row || row.source.kind !== "file") {
      throw new Error("File resource not found");
    }
    await requireResourceEditAccess(ctx, {
      activityId: row.activityId,
      assignmentId: args.assignmentId,
    });
    await ctx.db.patch(args.resourceId, {
      extractionStatus: "pending",
      extractionError: undefined,
      extractedText: undefined,
    });
    await ctx.scheduler.runAfter(
      0,
      internal.activityResourceActions.extractText,
      { resourceId: args.resourceId },
    );
  },
});

export const remove = authedMutation({
  args: {
    resourceId: v.id("activityResources"),
    assignmentId: v.optional(v.id("assignments")),
  },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.resourceId);
    if (!row) return;
    const access = await requireResourceEditAccess(ctx, {
      activityId: row.activityId,
      assignmentId: args.assignmentId,
    });
    if (!isMaterialActivityResource(row)) {
      throw new Error("Detach presentations through their presentation controls");
    }
    if (row.source.kind === "file") {
      await ctx.storage.delete(row.source.fileStorageId);
    }
    if (access.kind === "unit") {
      await pruneResourceReferencesInUnit(ctx, access.unit._id, [row._id]);
    }
    await ctx.db.delete(args.resourceId);
  },
});

export const discardUpload = authedMutation({
  args: {
    activityId: v.id("activities"),
    assignmentId: v.optional(v.id("assignments")),
    storageId: v.id("_storage"),
  },
  handler: async (ctx, args) => {
    await requireResourceEditAccess(ctx, args);
    const metadata = await ctx.db.system.get("_storage", args.storageId);
    if (!metadata) return;
    if (Date.now() - metadata._creationTime > 60 * 60 * 1000) {
      throw new Error("Upload cleanup window has expired");
    }
    const resources = await ctx.db
      .query("activityResources")
      .withIndex("by_activity", (query) =>
        query.eq("activityId", args.activityId),
      )
      .collect();
    const registered = resources.some(
      (resource) =>
        resource.source.kind === "file" &&
        resource.source.fileStorageId === args.storageId,
    );
    if (!registered) await ctx.storage.delete(args.storageId);
  },
});

export async function deleteResourcesForActivity(
  ctx: MutationCtx,
  activityId: Id<"activities">,
): Promise<void> {
  const rows = await ctx.db
    .query("activityResources")
    .withIndex("by_activity", (query) => query.eq("activityId", activityId))
    .collect();
  const activity = await ctx.db.get(activityId);
  const lesson = activity?.lessonId
    ? await ctx.db.get(activity.lessonId)
    : null;
  if (lesson) {
    await pruneResourceReferencesInUnit(
      ctx,
      lesson.unitId,
      rows.map((row) => row._id),
    );
  }
  for (const row of rows) {
    if (row.source.kind === "file") {
      await ctx.storage.delete(row.source.fileStorageId);
    }
    await ctx.db.delete(row._id);
  }
}

export const getForExtraction = internalQuery({
  args: { resourceId: v.id("activityResources") },
  handler: async (ctx, args) => {
    const resource = await ctx.db.get(args.resourceId);
    if (!resource || resource.source.kind !== "file") return null;
    const activity = await ctx.db.get(resource.activityId);
    if (!activity?.lessonId) return { ...resource, teacherId: null };
    const lesson = await ctx.db.get(activity.lessonId);
    if (!lesson) return { ...resource, teacherId: null };
    const unit = await ctx.db.get(lesson.unitId);
    return { ...resource, teacherId: unit?.teacherId ?? null };
  },
});

export const setExtractionStatus = internalMutation({
  args: {
    resourceId: v.id("activityResources"),
    status: v.union(
      v.literal("pending"),
      v.literal("extracting"),
      v.literal("ready"),
      v.literal("error"),
    ),
    error: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    if (!(await ctx.db.get(args.resourceId))) return;
    await ctx.db.patch(args.resourceId, {
      extractionStatus: args.status,
      extractionError: args.error,
    });
  },
});

export const setExtractedText = internalMutation({
  args: { resourceId: v.id("activityResources"), text: v.string() },
  handler: async (ctx, args) => {
    if (!(await ctx.db.get(args.resourceId))) return;
    await ctx.db.patch(args.resourceId, {
      extractedText: args.text,
      extractionStatus: "ready",
      extractionError: undefined,
    });
  },
});

export const shareFromTutor = internalMutation({
  args: {
    currentMessageId: v.id("messages"),
    sessionId: v.id("sessions"),
    resourceId: v.id("activityResources"),
    contentSoFar: v.string(),
  },
  handler: async (ctx, args) => {
    const session = await ctx.db.get(args.sessionId);
    if (!session?.activityId) {
      throw new Error("Session has no activity resources");
    }
    const activity = await ctx.db.get(session.activityId);
    if (!activity || !RESOURCE_ACTIVITY_KINDS.has(effectiveActivityKind(activity))) {
      throw new Error("Resources can only be shared in an online activity");
    }
    const resource = (
      await resolveReachableActivityResources(ctx, session.activityId)
    ).all.find((row) => row._id === args.resourceId);
    if (!resource) {
      throw new Error("Resource is not reachable from this session's activity");
    }

    const newAssistantMessageId = await finalizeAndSplit(ctx, {
      currentMessageId: args.currentMessageId,
      sessionId: args.sessionId,
      contentSoFar: args.contentSoFar,
      toolAction: "resource_share",
      toolContent: String(resource._id),
    });
    return {
      newAssistantMessageId,
      title: resource.title,
      kind: resource.source.kind,
    };
  },
});
