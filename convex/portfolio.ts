import { v } from "convex/values";
import {
  internalMutation,
  internalQuery,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import { authedQuery, authedMutation } from "./lib/customFunctions";
import { requireGuardianOf } from "./lib/auth";
import { ROLES, isScholarAdminRole } from "./lib/roles";
import {
  requireProgramCaptureReviewAccess,
  reviewableProgramGroups,
} from "./lib/programGroupAccess";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import {
  assignmentResolved,
  needsReview,
  openFields,
} from "./lib/portfolioStatus";
import { reconcilePortfolioMaterialization } from "./portfolioMaterialize";
import { clearScanAssessment } from "./portfolioAssess";
import { maybeScheduleArtifactAssessment } from "./granuleAssessment";
import {
  entryTargetsScholar,
  liveActivityAt,
} from "./assignments";
import {
  canUserAccessScholar,
  requireActiveScholarAccess,
} from "./lib/access";
import {
  resolveInstitutionLens,
  institutionIdInLens,
  type ResolvedInstitutionLens,
} from "./lib/institutionLens";
import { timeZoneForScholar } from "./lib/institutionTime";
import {
  attributedScholarIds,
} from "./lib/portfolioAttributions";
import {
  portfolioItemContainsIdentifiableMedia,
  portfolioFamilySharingEligibility,
} from "./lib/schoolMediaConsent";
import { activityResourceDisplayRows } from "./lib/activityResourceDisplay";
import { normalizeDocumentHeading } from "./lib/pdfSegments";
import {
  hasSchoolOperationsAccessAtInstitution,
  schoolOperationsInstitutionIds,
} from "./lib/staffCapabilities";
// The cap is shared with the kiosk's own naming path (and the native input),
// so it lives in shared/ rather than being restated per surface.
import { LABEL_MAX_LENGTH } from "../shared/portfolioLabel";

const LABEL_BATCH_MAX = 200;
const ASSIGNMENT_BATCH_MAX = 200;
const RECENT_LABEL_DEFAULT_LIMIT = 10;
const RECENT_LABEL_MAX_LIMIT = 50;
const RECENT_LABEL_SCAN_LIMIT = 500;

/** Action-side target validation before external scan/Drive work starts. */
export const assertSchoolOperationsForCaller = internalQuery({
  args: {
    userId: v.id("users"),
    institutionId: v.optional(v.id("institutions")),
  },
  handler: async (ctx, args) => {
    const user = await ctx.db.get(args.userId);
    if (
      !user ||
      !args.institutionId ||
      !(await hasSchoolOperationsAccessAtInstitution(
        ctx,
        user,
        args.institutionId,
      ))
    ) {
      throw new Error("Forbidden: school operations access required");
    }
  },
});

/**
 * Portfolio — a scholar's body of WORK (scanned worksheets, drawings,
 * projects, photos). Sibling of `scholarDocuments`, but different in kind:
 *
 *  - scholarDocuments = sensitive ADULT source material (assessments, IEPs)
 *    that must never reach the scholar → load-bearing redaction pass.
 *  - portfolioItems   = the kid's OWN output → no redaction; we just extract
 *    a caption + any text for search/surfacing.
 *
 * The headline ingestion path is a classroom printer dropping scans into a
 * watched Google Drive folder (see `driveSync.ts`). Each scan is matched to a
 * scholar by the name written in the corner (Claude vision + `lib/scholarMatch`).
 * Confident matches auto-file; uncertain ones land in `listNeedsReview` for a
 * teacher to assign in one click.
 *
 * All public functions are gated to scholar-admin roles (teacher, admin,
 * operations staff). Scholars don't manage their own portfolio in this surface;
 * staff curate attribution. Registrars triage the scanner inbox but do
 * not configure Drive sync (that stays curriculum-access in driveSync.ts).
 */

// ── Internal helpers ────────────────────────────────────────────────────

/** Coarse gate; every target-bound operation also checks its school below. */
function requireScholarAdmin(ctx: { user: Doc<"users"> }): Doc<"users"> {
  if (!isScholarAdminRole(ctx.user.role) && ctx.user.role !== "staff") {
    throw new Error("Forbidden: scholar-admin role required");
  }
  return ctx.user;
}

async function scannerInstitutionLens(
  ctx: QueryCtx & { user: Doc<"users"> },
  lens: ResolvedInstitutionLens,
): Promise<ResolvedInstitutionLens | null> {
  const operationsIds = await schoolOperationsInstitutionIds(ctx, ctx.user);
  if (lens.scope === "all") {
    if (operationsIds === "all") return lens;
    const allowedInstitutionIds = new Set(
      [...lens.allowedInstitutionIds].filter((institutionId) =>
        operationsIds.has(institutionId),
      ),
    );
    if (allowedInstitutionIds.size === 0) {
      return null;
    }
    return { ...lens, allowedInstitutionIds };
  }
  if (
    !lens.institution ||
    !(await hasSchoolOperationsAccessAtInstitution(
      ctx,
      ctx.user,
      lens.institution._id,
    ))
  ) {
    return null;
  }
  return lens;
}

async function assignmentInstitutionId(
  ctx: QueryCtx,
  assignment: Doc<"assignments">,
): Promise<Id<"institutions"> | null> {
  if (assignment.scholarGroupId) {
    const group = await ctx.db.get(assignment.scholarGroupId);
    if (group?.institutionId) return group.institutionId;
  }
  if (assignment.unitId) {
    const unit = await ctx.db.get(assignment.unitId);
    if (unit?.institutionId) return unit.institutionId;
  }
  const scholars = await Promise.all(
    assignment.scholarIds.map((scholarId) => ctx.db.get(scholarId)),
  );
  const institutionIds = new Set(
    scholars.flatMap((scholar) =>
      scholar?.institutionId ? [scholar.institutionId] : [],
    ),
  );
  return institutionIds.size === 1 ? [...institutionIds][0] : null;
}

async function canManageAssignment(
  ctx: QueryCtx & { user: Doc<"users"> },
  assignment: Doc<"assignments">,
): Promise<boolean> {
  const institutionId = await assignmentInstitutionId(ctx, assignment);
  return (
    institutionId !== null &&
    (await hasSchoolOperationsAccessAtInstitution(
      ctx,
      ctx.user,
      institutionId,
    ))
  );
}

// How long a thumbnail may sit "pending" before the UI stops showing a spinner
// and falls back to the file icon. Real generation is sub-second; anything this
// old means the generate action never completed (e.g. it hit the action time
// limit and was killed before its catch could mark the item "error"), so an
// eternal spinner would be a lie. A backfill can still re-drive it to "ready".
const THUMB_PENDING_STALE_MS = 5 * 60 * 1000;

/** Derive the UI thumbnail state, degrading a stuck-"pending" item (whose
 *  generate action never finished) to "error" so the card shows the file icon
 *  instead of spinning forever. A stored thumb always wins. */
function thumbStatusFor(
  r: Doc<"portfolioItems">,
): "pending" | "ready" | "error" | undefined {
  if (r.thumbStorageId) return "ready";
  if (
    r.thumbStatus === "pending" &&
    Date.now() - r._creationTime > THUMB_PENDING_STALE_MS
  ) {
    return "error";
  }
  return r.thumbStatus ?? undefined;
}

// Public list/detail shape — keep the projection in one place so list and
// review-inbox views can't drift.
function publicView(r: Doc<"portfolioItems">) {
  return {
    _id: r._id,
    _creationTime: r._creationTime,
    scholarId: r.scholarId,
    title: r.title,
    source: r.source,
    fileMimeType: r.fileMimeType,
    fileSizeBytes: r.fileSizeBytes,
    aiCaption: r.aiCaption,
    documentHeading: r.documentHeading,
    label: r.label,
    detectedName: r.detectedName,
    matchStatus: r.matchStatus,
    matchConfidence: r.matchConfidence,
    assignmentId: r.assignmentId,
    assignmentStatus: r.assignmentStatus,
    activityId: r.activityId,
    familyVisibility: r.familyVisibility,
    processingStatus: r.processingStatus,
    processingError: r.processingError,
    uploadedBy: r.uploadedBy,
    pageRange: r.pageRange,
    hasFile: r.fileStorageId != null,
    // Thumbnail state — the URL itself is resolved per-list (needs ctx.storage),
    // but the status lets the UI show a loading shimmer vs. the icon fallback.
    // A stuck-"pending" item degrades to the icon (see thumbStatusFor) so it
    // never spins forever.
    thumbStatus: thumbStatusFor(r),
    // Magic Annotations: present when a Magic Corners marker was redrawn. The
    // URL is fetched on demand via getMagicFileUrl (needs ctx.storage).
    hasMagic: r.magicStorageId != null,
    magicInstruction: r.magicInstruction ?? null,
  };
}

async function previewUrl(
  ctx: Pick<QueryCtx, "storage"> | Pick<MutationCtx, "storage">,
  item: Doc<"portfolioItems">,
) {
  if (item.thumbStorageId) {
    return await ctx.storage.getUrl(item.thumbStorageId);
  }
  if (item.fileStorageId && item.fileMimeType?.startsWith("image/")) {
    return await ctx.storage.getUrl(item.fileStorageId);
  }
  return null;
}

async function requirePortfolioItemAccess(
  ctx: QueryCtx & { user: Doc<"users"> },
  item: Doc<"portfolioItems">,
) {
  if (item.source === "capture_station") {
    const capture = await ctx.db
      .query("captureStationCaptures")
      .withIndex("by_portfolio_item", (q) =>
        q.eq("portfolioItemId", item._id),
      )
      .unique();
    if (!capture) throw new Error("Capture provenance is missing");
    const station = await ctx.db.get(capture.captureStationId);
    await requireProgramCaptureReviewAccess(
      ctx,
      ctx.user,
      station ? await ctx.db.get(station.scholarGroupId) : null,
    );
    return;
  }
  const scholarIds = await attributedScholarIds(ctx, item);
  if (scholarIds.length > 0) {
    for (const scholarId of scholarIds) {
      await requireActiveScholarAccess(ctx, ctx.user, scholarId);
    }
    return;
  }
  const lens = await resolveInstitutionLens(ctx, ctx.user);
  if (!institutionIdInLens(lens, item.institutionId)) {
    throw new Error("Portfolio item is outside your school");
  }
}

// ── Mutations (public, teacher + admin only) ────────────────────────────

/** Short-lived upload URL for the manual-upload path. */
export const generateUploadUrl = authedMutation({
  args: {},
  handler: async (ctx) => {
    requireScholarAdmin(ctx);
    return await ctx.storage.generateUploadUrl();
  },
});

/**
 * Register a manually-uploaded portfolio item. The scholar is known at
 * upload time, so it skips matching and lands as "confirmed". Extraction
 * (caption + text) still runs in the background.
 */
export const registerUpload = authedMutation({
  args: {
    scholarId: v.id("users"),
    title: v.string(),
    fileStorageId: v.id("_storage"),
    fileMimeType: v.optional(v.string()),
    fileSizeBytes: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const user = requireScholarAdmin(ctx);
    const scholar = await ctx.db.get(args.scholarId);
    if (!scholar) throw new Error("Scholar not found");
    await requireActiveScholarAccess(ctx, user, args.scholarId);

    const itemId = await ctx.db.insert("portfolioItems", {
      scholarId: args.scholarId,
      title: args.title.trim() || "Untitled work",
      source: "manual",
      fileStorageId: args.fileStorageId,
      fileMimeType: args.fileMimeType,
      fileSizeBytes: args.fileSizeBytes,
      matchStatus: "confirmed",
      matchConfidence: 1,
      // Manual uploads aren't part of an assignment flow — default to "none"
      // so they're fully resolved (scholar known + no assignment) and skip
      // the review queue. The teacher can still tag an assignment later.
      assignmentStatus: "none",
      uploadedBy: user._id,
      processingStatus: "pending",
      thumbStatus: "pending",
      institutionId: scholar.institutionId,
      familyVisibility: "attributed_families",
    });
    await ctx.db.insert("portfolioAttributions", {
      portfolioItemId: itemId,
      scholarId: args.scholarId,
      attributedAt: Date.now(),
      attributedBy: user._id,
    });

    await ctx.scheduler.runAfter(0, internal.portfolioActions.extractAndMatch, {
      itemId,
    });
    return { itemId };
  },
});

/**
 * Assign (or re-assign) a scholar to an item and mark it confirmed. This is
 * how a teacher clears the review queue, and also how they fix a bad
 * auto-match.
 */
async function setAttributionSet(
  ctx: MutationCtx & { user: Doc<"users"> },
  itemId: Id<"portfolioItems">,
  scholarIds: Id<"users">[],
) {
  const item = await ctx.db.get(itemId);
  if (!item) throw new Error("Item not found");
  const uniqueIds = [...new Set(scholarIds)];
  const scholars = await Promise.all(uniqueIds.map((id) => ctx.db.get(id)));
  if (scholars.some((scholar) => !scholar)) throw new Error("Scholar not found");
  if (item.source === "capture_station") {
    await requirePortfolioItemAccess(ctx, item);
  } else {
    for (const scholarId of uniqueIds) {
      await requireActiveScholarAccess(ctx, ctx.user, scholarId);
    }
    for (const scholarId of await attributedScholarIds(ctx, item)) {
      await requireActiveScholarAccess(ctx, ctx.user, scholarId);
    }
  }
  const institutionIds = new Set(
    scholars.map((scholar) => scholar!.institutionId).filter(Boolean).map(String),
  );
  if (institutionIds.size > 1) {
    throw new Error("All attributed scholars must belong to the same institution");
  }
  const institutionId = scholars.find((scholar) => scholar!.institutionId)
    ?.institutionId;
  if (
    item.institutionId &&
    institutionId &&
    item.institutionId !== institutionId
  ) {
    throw new Error("Scholar is not in this item's institution");
  }
  // Scanner filing records work that already happened. It may legitimately be
  // retrospective (a game-time classroom decision), so attribution does not
  // require or mutate the assignment's planned roster.
  if (item.source === "capture_station") {
    const capture = await ctx.db
      .query("captureStationCaptures")
      .withIndex("by_portfolio_item", (q) => q.eq("portfolioItemId", itemId))
      .unique();
    if (!capture) {
      throw new Error("Capture provenance is missing");
    }
    const station = await ctx.db.get(capture.captureStationId);
    const group = station ? await ctx.db.get(station.scholarGroupId) : null;
    const allowedIds = new Set(group?.scholarIds ?? []);
    if (
      !station ||
      !group ||
      uniqueIds.some((scholarId) => !allowedIds.has(scholarId))
    ) {
      throw new Error("Capture attributions must stay within its program group");
    }
  }

  const existing = await ctx.db
    .query("portfolioAttributions")
    .withIndex("by_item", (q) => q.eq("portfolioItemId", itemId))
    .collect();
  const existingIds = new Set(existing.map((row) => row.scholarId));
  const nextIds = new Set(uniqueIds);
  const attributionsChanged =
    existingIds.size !== nextIds.size ||
    [...existingIds].some((scholarId) => !nextIds.has(scholarId));
  for (const row of existing) {
    if (!nextIds.has(row.scholarId)) await ctx.db.delete(row._id);
  }
  for (const scholarId of uniqueIds) {
    if (!existingIds.has(scholarId)) {
      await ctx.db.insert("portfolioAttributions", {
        portfolioItemId: itemId,
        scholarId,
        attributedAt: Date.now(),
        attributedBy: ctx.user._id,
      });
    }
  }
  await ctx.db.patch(itemId, {
    scholarId: uniqueIds[0],
    matchStatus: uniqueIds.length > 0 ? "confirmed" : "unmatched",
    ...(item.institutionId || !institutionId ? {} : { institutionId }),
  });
  if (attributionsChanged) {
    await clearScanAssessment(ctx, itemId);
  }
  await reconcilePortfolioMaterialization(ctx, itemId);
}

export const setAttributions = authedMutation({
  args: {
    itemId: v.id("portfolioItems"),
    scholarIds: v.array(v.id("users")),
  },
  handler: async (ctx, args) => {
    requireScholarAdmin(ctx);
    await setAttributionSet(ctx, args.itemId, args.scholarIds);
  },
});

export const setLabels = authedMutation({
  args: {
    itemIds: v.array(v.id("portfolioItems")),
    label: v.string(),
  },
  handler: async (ctx, args) => {
    requireScholarAdmin(ctx);
    if (args.itemIds.length > LABEL_BATCH_MAX) {
      throw new Error(
        `Cannot label more than ${LABEL_BATCH_MAX} portfolio items at once`,
      );
    }
    const itemIds = [...new Set(args.itemIds)];

    const items = await Promise.all(itemIds.map((itemId) => ctx.db.get(itemId)));
    for (const item of items) {
      if (!item) throw new Error("Item not found");
      await requirePortfolioItemAccess(ctx, item);
    }

    const label =
      args.label.trim().slice(0, LABEL_MAX_LENGTH) || undefined;
    for (const itemId of itemIds) {
      await ctx.db.patch(itemId, { label });
    }
    return { updated: itemIds.length };
  },
});

export const assignScholar = authedMutation({
  args: {
    itemId: v.id("portfolioItems"),
    scholarId: v.id("users"),
  },
  handler: async (ctx, args) => {
    requireScholarAdmin(ctx);
    await setAttributionSet(ctx, args.itemId, [args.scholarId]);
  },
});

export const setFamilyVisibility = authedMutation({
  args: {
    itemId: v.id("portfolioItems"),
    familyVisibility: v.union(
      v.literal("staff_only"),
      v.literal("attributed_families"),
    ),
  },
  handler: async (ctx, args) => {
    requireScholarAdmin(ctx);
    const item = await ctx.db.get(args.itemId);
    if (!item) throw new Error("Item not found");
    await requirePortfolioItemAccess(ctx, item);
    if ((await attributedScholarIds(ctx, item)).length === 0) {
      throw new Error("Assign at least one scholar before sharing");
    }
    if (args.familyVisibility === "attributed_families") {
      const shareableCapture = item.source === "capture_station";
      if (
        (!item.assignmentId && !shareableCapture) ||
        !assignmentResolved(item)
      ) {
        throw new Error("File this scan to an assignment before sharing");
      }
      const scholarIds = await attributedScholarIds(ctx, item);
      const eligibility = await portfolioFamilySharingEligibility(
        ctx,
        scholarIds,
        portfolioItemContainsIdentifiableMedia(item),
      );
      if (!eligibility.allowed) {
        throw new Error(eligibility.blocker ?? "Family sharing is unavailable.");
      }
    }
    await ctx.db.patch(item._id, {
      familyVisibility: args.familyVisibility,
    });
  },
});

/**
 * Resolve an item's assignment. Pass an `assignmentId` to tag it, or omit it
 * to mark the item as not belonging to any assignment ("none"). Either way the
 * assignment field becomes "filled", so the item can leave the review queue.
 */
async function applyPortfolioItemAssignment(
  ctx: MutationCtx & { user: Doc<"users"> },
  item: Doc<"portfolioItems">,
  assignment: Doc<"assignments"> | null,
) {
  const attributedIds = await attributedScholarIds(ctx, item);
  for (const scholarId of attributedIds) {
    await requireActiveScholarAccess(ctx, ctx.user, scholarId);
  }
  if (assignment) {
    // This is evidence filing, not assignment dispatch. Keep the roster intact:
    // the scan can appear with this assignment without exposing its other
    // scheduled work to a scholar who joined only for the game-time activity.
    const clearActivity =
      item.activityId != null && item.assignmentId !== assignment._id;
    const familyVisibility =
      item.assignmentId && item.familyVisibility === "staff_only"
        ? "staff_only"
        : "attributed_families";
    await ctx.db.patch(item._id, {
      assignmentId: assignment._id,
      assignmentStatus: "confirmed",
      familyVisibility,
      ...(clearActivity ? { activityId: undefined } : {}),
    });
  } else {
    await ctx.db.patch(item._id, {
      assignmentId: undefined,
      assignmentStatus: "none",
      familyVisibility: "staff_only",
      activityId: undefined,
    });
  }
  await reconcilePortfolioMaterialization(ctx, item._id);
}

export const setAssignment = authedMutation({
  args: {
    itemId: v.id("portfolioItems"),
    assignmentId: v.optional(v.id("assignments")),
  },
  handler: async (ctx, args) => {
    requireScholarAdmin(ctx);
    const item = await ctx.db.get(args.itemId);
    if (!item) throw new Error("Item not found");
    const assignment = args.assignmentId
      ? await ctx.db.get(args.assignmentId)
      : null;
    if (args.assignmentId && !assignment) throw new Error("Assignment not found");
    await applyPortfolioItemAssignment(ctx, item, assignment);
  },
});

/** Apply one assignment to a selected batch in a single transaction. */
export const setAssignments = authedMutation({
  args: {
    itemIds: v.array(v.id("portfolioItems")),
    assignmentId: v.id("assignments"),
  },
  handler: async (ctx, args) => {
    requireScholarAdmin(ctx);
    const itemIds = [...new Set(args.itemIds)];
    if (itemIds.length > ASSIGNMENT_BATCH_MAX) {
      throw new Error(`Choose at most ${ASSIGNMENT_BATCH_MAX} scans at a time`);
    }
    const assignment = await ctx.db.get(args.assignmentId);
    if (!assignment) throw new Error("Assignment not found");
    for (const itemId of itemIds) {
      const item = await ctx.db.get(itemId);
      if (!item) throw new Error("Item not found");
      await applyPortfolioItemAssignment(ctx, item, assignment);
    }
    return { updated: itemIds.length };
  },
});

/**
 * Set (or clear) the activity an item belongs to — the second axis within an
 * assignment. Setting it (with a resolved scholar) materializes the offline
 * project + deliverable so the scan flows into the activity's submissions and
 * any Share Back that lists it. Pass no `activityId` to clear it.
 */
export const setActivity = authedMutation({
  args: {
    itemId: v.id("portfolioItems"),
    activityId: v.optional(v.id("activities")),
  },
  handler: async (ctx, args) => {
    requireScholarAdmin(ctx);
    const item = await ctx.db.get(args.itemId);
    if (!item) throw new Error("Item not found");
    const attributedIds = await attributedScholarIds(ctx, item);
    for (const scholarId of attributedIds) {
      await requireActiveScholarAccess(ctx, ctx.user, scholarId);
    }
    if (args.activityId) {
      const activity = await ctx.db.get(args.activityId);
      if (!activity) throw new Error("Activity not found");
      // Guard the trust boundary: an activity may only be filed under the
      // item's assignment if it lives in that assignment's unit. The picker
      // already constrains this, but a direct API call must not be able to
      // materialize a deliverable whose activity/assignment span two cohorts.
      if (item.assignmentId) {
        const assignment = await ctx.db.get(item.assignmentId);
        const lesson = activity.lessonId
          ? await ctx.db.get(activity.lessonId)
          : null;
        if (!assignment || !lesson || lesson.unitId !== assignment.unitId) {
          throw new Error("Activity is not part of this assignment's unit");
        }
      }
    }
    await ctx.db.patch(args.itemId, { activityId: args.activityId });
    await reconcilePortfolioMaterialization(ctx, args.itemId);
  },
});

/** Hard-delete an item + its storage file (and any materialized deliverable). */
export async function deletePortfolioItem(
  ctx: MutationCtx,
  item: Doc<"portfolioItems">,
  options: {
    dismissDriveFile: boolean;
    dismissedBy?: Id<"users">;
  },
): Promise<void> {
    const itemId = item._id;
    const messageAttachmentStorageIds = new Set(
      (
        item.fileStorageId
          ? await ctx.db
              .query("parentMessageAttachments")
              .withIndex("by_storage", (q) =>
                q.eq("storageId", item.fileStorageId!),
              )
              .collect()
          : []
      ).map((attachment) => attachment.storageId),
    );
    for (const blobId of [
      item.fileStorageId,
      item.thumbStorageId,
      item.magicStorageId,
      item.magicThumbStorageId,
    ]) {
      if (!blobId) continue;
      // A sent family message is a durable record. Its portfolio-backed
      // attachment borrows this blob, so deleting the source item cannot break
      // the message it already sent.
      if (messageAttachmentStorageIds.has(blobId)) continue;
      try {
        await ctx.storage.delete(blobId);
      } catch (err) {
        console.warn(
          `[portfolio.deleteItem] storage.delete failed for ${blobId}:`,
          err
        );
      }
    }
    for (const attribution of await ctx.db
      .query("portfolioAttributions")
      .withIndex("by_item", (q) => q.eq("portfolioItemId", itemId))
      .collect()) {
      await ctx.db.delete(attribution._id);
    }
    const capture = await ctx.db
      .query("captureStationCaptures")
      .withIndex("by_portfolio_item", (q) =>
        q.eq("portfolioItemId", itemId),
      )
      .unique();
    if (capture) await ctx.db.delete(capture._id);
    // Tombstone the Drive provenance BEFORE the row goes away: the folder
    // sync + watch webhook treat "file with no portfolioItems row" as unseen
    // and would re-ingest the file, resurrecting the deleted scan in the
    // inbox. See the driveFileDismissals schema comment.
    if (item.driveFileId && options.dismissDriveFile) {
      if (!options.dismissedBy) {
        throw new Error("Drive dismissal requires an actor");
      }
      const dismissed = await ctx.db
        .query("driveFileDismissals")
        .withIndex("by_driveFileId", (q) =>
          q.eq("driveFileId", item.driveFileId!),
        )
        .first();
      if (!dismissed) {
        await ctx.db.insert("driveFileDismissals", {
          driveFileId: item.driveFileId,
          institutionId: item.institutionId,
          dismissedBy: options.dismissedBy,
        });
      }
    }
    await ctx.db.delete(itemId);
    // Item is gone → reconcile tears down its offline project + deliverable
    // (the by_portfolioItem lookup still resolves the now-orphaned rows).
    await reconcilePortfolioMaterialization(ctx, itemId);
}

/** Hard-delete an item + its storage file (and any materialized deliverable). */
export const deleteItem = authedMutation({
  args: { itemId: v.id("portfolioItems") },
  handler: async (ctx, args) => {
    requireScholarAdmin(ctx);
    const item = await ctx.db.get(args.itemId);
    if (!item) return;
    await requirePortfolioItemAccess(ctx, item);
    await deletePortfolioItem(ctx, item, {
      dismissDriveFile: true,
      dismissedBy: ctx.user._id,
    });
  },
});

// ── Queries (public, teacher + admin only) ──────────────────────────────

/** Portfolio items for a scholar, newest-first. */
export const listForScholar = authedQuery({
  args: { scholarId: v.id("users") },
  handler: async (ctx, args) => {
    const user = requireScholarAdmin(ctx);
    await requireActiveScholarAccess(ctx, user, args.scholarId);
    const legacyRows = await ctx.db
      .query("portfolioItems")
      .withIndex("by_scholar", (q) => q.eq("scholarId", args.scholarId))
      .order("desc")
      .collect();
    const attributedRows = await ctx.db
      .query("portfolioAttributions")
      .withIndex("by_scholar", (q) => q.eq("scholarId", args.scholarId))
      .collect();
    const rows = new Map(legacyRows.map((row) => [row._id, row]));
    for (const attribution of attributedRows) {
      const item = await ctx.db.get(attribution.portfolioItemId);
      if (item) rows.set(item._id, item);
    }
    // Program captures belong in the uploads queue and Run page Submissions. Keeping
    // them out of the general scholar Portfolio also prevents ordinary staff
    // from receiving signed media URLs outside the program-coach capability.
    const visibleRows = [...rows.values()].filter(
      (row) => row.source !== "capture_station",
    );
    return await Promise.all(
      visibleRows.map(async (r) => ({
        ...publicView(r),
        thumbUrl: await previewUrl(ctx, r),
        // Magic Annotations: thumbnail of the redraw, so the card can preview
        // the magic version inline (and toggle to the original).
        magicThumbUrl: r.magicThumbStorageId
          ? await ctx.storage.getUrl(r.magicThumbStorageId)
          : null,
      })),
    );
  },
});

/** One item's metadata (no storage URL — see getFileUrl). */
export const get = authedQuery({
  args: { itemId: v.id("portfolioItems") },
  handler: async (ctx, args) => {
    requireScholarAdmin(ctx);
    const item = await ctx.db.get(args.itemId);
    if (!item) return null;
    await requirePortfolioItemAccess(ctx, item);
    return { ...publicView(item), extractedText: item.extractedText ?? null };
  },
});

/** Signed URL for inline preview / download of the original file. */
export const getFileUrl = authedQuery({
  args: { itemId: v.id("portfolioItems") },
  handler: async (ctx, args) => {
    requireScholarAdmin(ctx);
    const item = await ctx.db.get(args.itemId);
    if (!item || !item.fileStorageId) return null;
    await requirePortfolioItemAccess(ctx, item);
    return await ctx.storage.getUrl(item.fileStorageId);
  },
});

/** Signed URL for the Magic-Annotations-redrawn image (before/after viewer). */
export const getMagicFileUrl = authedQuery({
  args: { itemId: v.id("portfolioItems") },
  handler: async (ctx, args) => {
    requireScholarAdmin(ctx);
    const item = await ctx.db.get(args.itemId);
    if (!item || !item.magicStorageId) return null;
    await requirePortfolioItemAccess(ctx, item);
    return await ctx.storage.getUrl(item.magicStorageId);
  },
});

// ── Parent (guardian) read-only access ──────────────────────────────────
// Parents see their OWN child's work samples, read-only. Separate from the
// scholar-admin functions above so the guardian gate is explicit and a
// parent can never reach the scanner inbox / mutations.

async function itemFamilySharingEligibility(
  ctx: Pick<QueryCtx, "db">,
  item: Doc<"portfolioItems">,
): Promise<{ allowed: boolean; blocker: string | null }> {
  const scholarIds = await attributedScholarIds(ctx, item);
  return await portfolioFamilySharingEligibility(
    ctx,
    scholarIds,
    portfolioItemContainsIdentifiableMedia(item),
  );
}

/** A guardian's read-only list of their child's portfolio items. */
export const listForGuardian = authedQuery({
  args: { scholarId: v.id("users") },
  handler: async (ctx, args) => {
    await requireGuardianOf(ctx, args.scholarId);
    const legacyRows = await ctx.db
      .query("portfolioItems")
      .withIndex("by_scholar", (q) => q.eq("scholarId", args.scholarId))
      .order("desc")
      .collect();
    const attributedRows = await ctx.db
      .query("portfolioAttributions")
      .withIndex("by_scholar", (q) => q.eq("scholarId", args.scholarId))
      .collect();
    const rows = new Map(legacyRows.map((row) => [row._id, row]));
    for (const attribution of attributedRows) {
      const item = await ctx.db.get(attribution.portfolioItemId);
      if (item) rows.set(item._id, item);
    }
    const visibleItems = [];
    for (const item of [...rows.values()].sort(
      (a, b) => b._creationTime - a._creationTime,
    )) {
      if (
        item.familyVisibility !== "staff_only" &&
        assignmentResolved(item) &&
        (await itemFamilySharingEligibility(ctx, item)).allowed
      ) {
        visibleItems.push(item);
      }
    }
    const fileItems = await Promise.all(
      visibleItems.map(async (item) => {
        const attributed = await attributedScholarIds(ctx, item);
        const activity = item.activityId
          ? await ctx.db.get(item.activityId)
          : null;
        return {
          _id: item._id,
          _creationTime: item._creationTime,
          kind: "file" as const,
          title: item.title,
          fileMimeType: item.fileMimeType,
          pageRange: item.pageRange,
          aiCaption:
            attributed.length <= 1 ? (item.aiCaption ?? undefined) : undefined,
          hasFile: item.fileStorageId != null,
          fileUrl: item.fileStorageId
            ? await ctx.storage.getUrl(item.fileStorageId)
            : null,
          attributionCount: attributed.length,
          activityTitle: activity?.title ?? null,
          thumbUrl: await previewUrl(ctx, item),
        };
      }),
    );
    const sharedDeliverables = [];
    const digitalRows = await ctx.db
      .query("deliverables")
      .withIndex("by_scholar", (q) => q.eq("scholarId", args.scholarId))
      .collect();
    for (const deliverable of digitalRows) {
      if (
        deliverable.familyVisibility === "attributed_families" &&
        deliverable.familySnapshot !== undefined &&
        deliverable.familyPublishedAt !== undefined &&
        (
          await portfolioFamilySharingEligibility(
            ctx,
            [deliverable.scholarId],
            false,
          )
        ).allowed
      ) {
        sharedDeliverables.push(deliverable);
      }
    }
    const digitalItems = await Promise.all(
      sharedDeliverables.map(async (deliverable) => {
        const activity = await ctx.db.get(deliverable.activityId);
        const snapshot = deliverable.familySnapshot!;
        return {
          _id: deliverable._id,
          _creationTime: deliverable.familyPublishedAt!,
          kind: snapshot.kind,
          title: snapshot.title,
          content: snapshot.content,
          hasTutorTranscription:
            snapshot.kind === "text"
              ? (snapshot.hasTutorTranscription ?? false)
              : false,
          hasFile: false,
          fileUrl: null,
          attributionCount: 1,
          activityTitle: activity?.title ?? null,
          thumbUrl: null,
        };
      }),
    );
    return [...fileItems, ...digitalItems].sort(
      (a, b) => b._creationTime - a._creationTime,
    );
  },
});

/** Signed file URL for a guardian, scoped to their own child's item. */
export const getFileUrlForGuardian = authedQuery({
  args: { itemId: v.id("portfolioItems") },
  handler: async (ctx, args) => {
    const item = await ctx.db.get(args.itemId);
    if (
      !item ||
      !item.fileStorageId ||
      item.familyVisibility === "staff_only" ||
      !assignmentResolved(item) ||
      !(await itemFamilySharingEligibility(ctx, item)).allowed
    ) {
      return null;
    }
    const guardianChildren = await ctx.db
      .query("guardianships")
      .withIndex("by_parent", (q) => q.eq("parentUserId", ctx.user._id))
      .collect();
    const attributed = new Set((await attributedScholarIds(ctx, item)).map(String));
    if (!guardianChildren.some((link) => attributed.has(String(link.scholarUserId)))) {
      throw new Error("Forbidden");
    }
    return await ctx.storage.getUrl(item.fileStorageId);
  },
});

// ── Scholar (self) read-only access ─────────────────────────────────────
// The portfolio is the kid's own body of work — they can SEE it (it's the
// "things you've made" section of My Learning; review/learner-parent-
// pedagogy.md). Curation (attribution, deletion, the scanner inbox) stays
// scholar-admin via the functions above.

/** The current scholar's own portfolio items, read-only, with thumbnails. */
export const listForSelf = authedQuery({
  args: {},
  handler: async (ctx) => {
    const legacyRows = await ctx.db
      .query("portfolioItems")
      .withIndex("by_scholar", (q) => q.eq("scholarId", ctx.user._id))
      .order("desc")
      .collect();
    const attributedRows = await ctx.db
      .query("portfolioAttributions")
      .withIndex("by_scholar", (q) => q.eq("scholarId", ctx.user._id))
      .collect();
    const rows = new Map(legacyRows.map((row) => [row._id, row]));
    for (const attribution of attributedRows) {
      const item = await ctx.db.get(attribution.portfolioItemId);
      if (item) rows.set(item._id, item);
    }
    const visibleItems = [...rows.values()]
      .filter(assignmentResolved)
      .sort((a, b) => b._creationTime - a._creationTime);
    return await Promise.all(
      visibleItems.map(async (item) => {
          const attributionCount = (await attributedScholarIds(ctx, item)).length;
          return {
            _id: item._id,
            _creationTime: item._creationTime,
            title: item.title,
            fileMimeType: item.fileMimeType,
            hasFile: item.fileStorageId != null,
            attributionCount,
            thumbUrl: await previewUrl(ctx, item),
          };
        }),
    );
  },
});

/** Signed file URL for the scholar's own item. */
export const getFileUrlForSelf = authedQuery({
  args: { itemId: v.id("portfolioItems") },
  handler: async (ctx, args) => {
    const item = await ctx.db.get(args.itemId);
    if (!item || !item.fileStorageId || !assignmentResolved(item)) {
      return null;
    }
    if (
      !(await attributedScholarIds(ctx, item)).some(
        (scholarId) => scholarId === ctx.user._id,
      )
    ) {
      throw new Error("Forbidden");
    }
    return await ctx.storage.getUrl(item.fileStorageId);
  },
});

/**
 * Scanner feed for the inbox panel: every processed-pipeline item split into
 * "To Review" (scholar and/or assignment still open) and "Processed" (both
 * resolved). Each item is enriched with the resolved scholar name + assignment
 * title and which fields are still open, so the panel can render the right
 * pickers without extra round-trips.
 */
function enrich(
  r: Doc<"portfolioItems">,
  scholarName: string | null,
  assignmentTitle: string | null,
  activityTitle: string | null,
) {
  return {
    ...publicView(r),
    scholarName,
    assignmentTitle,
    activityTitle,
    open: openFields(r),
  };
}

function institutionValuesForLens(
  lens: ResolvedInstitutionLens,
): (Id<"institutions"> | undefined)[] | null {
  if (lens.scope === "all") {
    if (lens.isAdmin) return null;
    const institutionIds = [...lens.allowedInstitutionIds];
    return lens.primaryInstitution &&
      lens.allowedInstitutionIds.has(lens.primaryInstitution._id)
      ? [...institutionIds, undefined]
      : institutionIds;
  }
  if (!lens.institution) return [];
  return lens.institution._id === lens.primaryInstitution?._id
    ? [lens.institution._id, undefined]
    : [lens.institution._id];
}

export const listRecentLabels = authedQuery({
  // Same scope inputs as scannerFeed/scannerCounts (#2448): the institution
  // `scope` (platform-admin school switcher) and the optional `programGroupId`
  // sub-scope. Recent labels MUST be drawn from exactly the queue population
  // the caller already sees, not a second independently-scoped scan.
  args: {
    limit: v.optional(v.number()),
    scope: v.optional(v.string()),
    programGroupId: v.optional(v.id("scholarGroups")),
  },
  handler: async (ctx, args) => {
    // Reuse the scanner queue's scope resolution + row filter so three failure
    // modes are structurally impossible rather than re-guarded here:
    //   (a) cross-tenant — an admin viewing school B via `scope` reads B's
    //       lens, never the caller's default (primary) school;
    //   (b) capture-label leak — a staffer without captures:review has an
    //       empty reviewable-group set, so no capture-station rows survive
    //       `filterScannerScope`;
    //   (c) dead-for-target — a captures:review-only coach has no school-
    //       operations (ordinary) lens but still gets their reviewable group's
    //       capture labels through the same capture-station scoping.
    const scope = await resolveScannerScope(ctx, args);
    if (!scope.ordinaryLens && scope.reviewableGroups.length === 0) {
      return [];
    }

    const requestedLimit =
      typeof args.limit === "number" && Number.isFinite(args.limit)
        ? Math.floor(args.limit)
        : RECENT_LABEL_DEFAULT_LIMIT;
    const limit = Math.max(
      1,
      Math.min(RECENT_LABEL_MAX_LIMIT, requestedLimit),
    );

    const candidates = await takeNewestScannerRows(
      ctx,
      scope.lens,
      RECENT_LABEL_SCAN_LIMIT,
    );
    const rows = await filterScannerScope(ctx, candidates, scope);

    const labels: string[] = [];
    const seen = new Set<string>();
    for (const row of rows) {
      const label = row.label?.trim();
      if (!label || seen.has(label)) continue;
      seen.add(label);
      labels.push(label);
      if (labels.length === limit) break;
    }
    return labels;
  },
});

function newestRows(
  groups: Doc<"portfolioItems">[][],
  limit: number,
): Doc<"portfolioItems">[] {
  const rows = new Map(
    groups.flat().map((row) => [row._id, row]),
  );
  return [...rows.values()]
    .sort((a, b) => b._creationTime - a._creationTime)
    .slice(0, limit);
}

/**
 * Newest portfolio rows within the caller's institution lens — the candidate
 * pool for recent-label extraction. Mirrors the by-institution reads the
 * scanner feed uses (an "all"-scope admin reads across every institution),
 * so the subsequent `filterScannerScope` narrows to exactly the queue's
 * population. Returned newest-first.
 */
async function takeNewestScannerRows(
  ctx: Pick<QueryCtx, "db">,
  lens: ResolvedInstitutionLens,
  limit: number,
): Promise<Doc<"portfolioItems">[]> {
  const institutionValues = institutionValuesForLens(lens);
  if (institutionValues === null) {
    return await ctx.db.query("portfolioItems").order("desc").take(limit);
  }
  return newestRows(
    await Promise.all(
      institutionValues.map((institutionId) =>
        ctx.db
          .query("portfolioItems")
          .withIndex("by_institution", (q) =>
            q.eq("institutionId", institutionId),
          )
          .order("desc")
          .take(limit),
      ),
    ),
    limit,
  );
}

async function takeByProcessingStatus(
  ctx: Pick<QueryCtx, "db">,
  lens: ResolvedInstitutionLens,
  status: Doc<"portfolioItems">["processingStatus"],
  limit: number,
) {
  const institutionValues = institutionValuesForLens(lens);
  if (institutionValues === null) {
    return await ctx.db
      .query("portfolioItems")
      .withIndex("by_processingStatus", (q) => q.eq("processingStatus", status))
      .order("desc")
      .take(limit);
  }
  return newestRows(
    await Promise.all(
      institutionValues.map((institutionId) =>
        ctx.db
          .query("portfolioItems")
          .withIndex("by_institution_processing_status", (q) =>
            q
              .eq("institutionId", institutionId)
              .eq("processingStatus", status),
          )
          .order("desc")
          .take(limit),
      ),
    ),
    limit,
  );
}

async function takeByProcessingMatch(
  ctx: Pick<QueryCtx, "db">,
  lens: ResolvedInstitutionLens,
  matchStatus: Doc<"portfolioItems">["matchStatus"],
  limit: number,
) {
  const institutionValues = institutionValuesForLens(lens);
  if (institutionValues === null) {
    return await ctx.db
      .query("portfolioItems")
      .withIndex("by_processing_match", (q) =>
        q.eq("processingStatus", "ready").eq("matchStatus", matchStatus),
      )
      .order("desc")
      .take(limit);
  }
  return newestRows(
    await Promise.all(
      institutionValues.map((institutionId) =>
        ctx.db
          .query("portfolioItems")
          .withIndex("by_institution_processing_match", (q) =>
            q
              .eq("institutionId", institutionId)
              .eq("processingStatus", "ready")
              .eq("matchStatus", matchStatus),
          )
          .order("desc")
          .take(limit),
      ),
    ),
    limit,
  );
}

async function takeByProcessingAssignment(
  ctx: Pick<QueryCtx, "db">,
  lens: ResolvedInstitutionLens,
  assignmentStatus: Doc<"portfolioItems">["assignmentStatus"],
  limit: number,
) {
  const institutionValues = institutionValuesForLens(lens);
  if (institutionValues === null) {
    return await ctx.db
      .query("portfolioItems")
      .withIndex("by_processing_assignment", (q) =>
        q
          .eq("processingStatus", "ready")
          .eq("assignmentStatus", assignmentStatus),
      )
      .order("desc")
      .take(limit);
  }
  return newestRows(
    await Promise.all(
      institutionValues.map((institutionId) =>
        ctx.db
          .query("portfolioItems")
          .withIndex("by_institution_processing_assignment", (q) =>
            q
              .eq("institutionId", institutionId)
              .eq("processingStatus", "ready")
              .eq("assignmentStatus", assignmentStatus),
          )
          .order("desc")
          .take(limit),
      ),
    ),
    limit,
  );
}

type ScannerScope = {
  lens: ResolvedInstitutionLens;
  ordinaryLens: ResolvedInstitutionLens | null;
  captureStationIds: Set<Id<"captureStations">>;
  programGroupId: Id<"scholarGroups"> | undefined;
  reviewableGroups: Array<{ groupId: Id<"scholarGroups">; label: string }>;
};

async function resolveScannerScope(
  ctx: QueryCtx & { user: Doc<"users"> },
  args: { scope?: string; programGroupId?: Id<"scholarGroups"> },
): Promise<ScannerScope> {
  const lens = await resolveInstitutionLens(ctx, ctx.user, args.scope);
  const groups = await reviewableProgramGroups(ctx, ctx.user, args.scope);
  const scopedGroups = args.programGroupId
    ? groups.filter((group) => group._id === args.programGroupId)
    : groups;
  if (args.programGroupId && scopedGroups.length === 0) {
    throw new Error("Program group is not available.");
  }
  const stations = await Promise.all(
    scopedGroups.map((group) =>
      ctx.db
        .query("captureStations")
        .withIndex("by_group", (q) => q.eq("scholarGroupId", group._id))
        .unique(),
    ),
  );
  return {
    lens,
    ordinaryLens: args.programGroupId
      ? null
      : await scannerInstitutionLens(ctx, lens),
    captureStationIds: new Set(
      stations.flatMap((station) => (station ? [station._id] : [])),
    ),
    programGroupId: args.programGroupId,
    reviewableGroups: groups.map((group) => ({
      groupId: group._id,
      label: group.name,
    })),
  };
}

/** The roster a capture may be retagged against: its station's group. */
async function captureStationRosterIds(
  ctx: Pick<QueryCtx, "db">,
  capture: Doc<"captureStationCaptures">,
) {
  const station = await ctx.db.get(capture.captureStationId);
  const group = station ? await ctx.db.get(station.scholarGroupId) : null;
  return group?.scholarIds ?? [];
}

async function captureForPortfolioItem(
  ctx: Pick<QueryCtx, "db">,
  item: Doc<"portfolioItems">,
) {
  return item.source === "capture_station"
    ? await ctx.db
        .query("captureStationCaptures")
        .withIndex("by_portfolio_item", (q) =>
          q.eq("portfolioItemId", item._id),
        )
        .unique()
    : null;
}

async function filterScannerScope(
  ctx: Pick<QueryCtx, "db">,
  rows: Doc<"portfolioItems">[],
  scope: ScannerScope,
) {
  const matches = await Promise.all(
    rows.map(async (item) => {
      if (item.source === "capture_station") {
        const capture = await captureForPortfolioItem(ctx, item);
        return (
          !!capture && scope.captureStationIds.has(capture.captureStationId)
        );
      }
      return (
        !scope.programGroupId &&
        scope.ordinaryLens !== null &&
        institutionIdInLens(scope.ordinaryLens, item.institutionId)
      );
    }),
  );
  return rows.filter((_, index) => matches[index]);
}

export const scannerFeed = authedQuery({
  args: {
    scope: v.optional(v.string()),
    programGroupId: v.optional(v.id("scholarGroups")),
  },
  handler: async (ctx, args) => {
    // Institution lens: the inbox is per-institution, so a teacher only triages
    // their own school's scans. platform_admin can switch schools via `scope`;
    // legacy rows (no institutionId) ride the primary school so nothing that
    // predates the backfill vanishes.
    const scope = await resolveScannerScope(ctx, args);
    if (!scope.ordinaryLens && scope.reviewableGroups.length === 0) {
      throw new Error("Forbidden: school operations access required");
    }
    // In-progress items (pending/extracting/matching) get a separate "processing"
    // bucket so the UI can show a spinner immediately on upload — otherwise a
    // freshly-dropped scan vanishes for the ~10s until the AI pipeline finishes,
    // which reads as a bug.
    //
    // Filter: only show items younger than STALE_MS. A crashed action can leave
    // a row stuck in pending/extracting forever; if we showed those, the spinner
    // section would grow unbounded and never clear. Stale rows still exist in
    // the DB — a cron sweep should move them to `error`, but until then we just
    // don't render them in the live feed.
    const STALE_MS = 10 * 60 * 1000; // 10 min — far longer than any real run
    const cutoff = Date.now() - STALE_MS;
    const inProgressStatuses = ["pending", "extracting", "matching"] as const;
    const inProgressRows = (
      await filterScannerScope(
        ctx,
        (
          await Promise.all(
            inProgressStatuses.map((s) =>
              takeByProcessingStatus(ctx, scope.lens, s, 100),
            ),
          )
        ).flat(),
        scope,
      )
    )
      .filter((r) => r._creationTime >= cutoff)
      .sort((a, b) => b._creationTime - a._creationTime);
    const processing = inProgressRows.map((r) => ({
      _id: r._id,
      _creationTime: r._creationTime,
      title: r.title,
      source: r.source,
      processingStatus: r.processingStatus,
      fileMimeType: r.fileMimeType,
    }));

    // Bound every index read before enrichment. Review candidates are selected
    // separately so older unresolved scans do not disappear behind newer filed
    // work as portfolio history grows.
    const REVIEW_CANDIDATE_LIMIT = 100;
    const PROCESSED_CANDIDATE_LIMIT = 150;
    const reviewCandidateGroups = await Promise.all([
      takeByProcessingMatch(
        ctx,
        scope.lens,
        "unmatched",
        REVIEW_CANDIDATE_LIMIT,
      ),
      takeByProcessingMatch(
        ctx,
        scope.lens,
        "ambiguous",
        REVIEW_CANDIDATE_LIMIT,
      ),
      takeByProcessingAssignment(
        ctx,
        scope.lens,
        undefined,
        REVIEW_CANDIDATE_LIMIT,
      ),
      takeByProcessingAssignment(
        ctx,
        scope.lens,
        "unresolved",
        REVIEW_CANDIDATE_LIMIT,
      ),
    ]);
    const latestReady = await takeByProcessingStatus(
      ctx,
      scope.lens,
      "ready",
      PROCESSED_CANDIDATE_LIMIT,
    );
    const candidates = new Map(
      (
        await filterScannerScope(
          ctx,
          [...reviewCandidateGroups.flat(), ...latestReady],
          scope,
        )
      ).map((row) => [row._id, row]),
    );
    const readyRows = [...candidates.values()].sort(
      (a, b) => b._creationTime - a._creationTime,
    );
    const rows = [
      ...readyRows.filter(needsReview).slice(0, REVIEW_CANDIDATE_LIMIT),
      ...readyRows.filter((row) => !needsReview(row)).slice(0, 100),
    ];

    // Resolve scholar names + assignment titles in batch.
    const attributionIdsByItem = new Map(
      await Promise.all(
        rows.map(async (row) => [
          row._id,
          await attributedScholarIds(ctx, row),
        ] as const),
      ),
    );
    const scholarIds = new Set(
      [...attributionIdsByItem.values()].flat().map(String),
    );
    const assignmentIds = new Set(rows.map((r) => r.assignmentId).filter(Boolean));
    const scholarName = new Map<string, string>();
    for (const id of scholarIds) {
      const u = await ctx.db.get(id as Doc<"users">["_id"]);
      if (u) scholarName.set(id, u.name ?? u.username ?? "Scholar");
    }
    const assignmentTitle = new Map<string, string>();
    for (const id of assignmentIds) {
      const a = await ctx.db.get(id as Doc<"assignments">["_id"]);
      if (a) {
        // A standing (unitId-less) assignment has no unit to fall back to.
        const unit = a.unitId ? await ctx.db.get(a.unitId) : null;
        assignmentTitle.set(id as string, a.title ?? unit?.title ?? "Assignment");
      }
    }
    const activityIds = new Set(rows.map((r) => r.activityId).filter(Boolean));
    const activityTitle = new Map<string, string>();
    for (const id of activityIds) {
      const a = await ctx.db.get(id as Doc<"activities">["_id"]);
      if (a) activityTitle.set(id as string, a.title);
    }

    const toReview = [];
    const processed = [];
    for (const r of rows) {
      const attributionIds = attributionIdsByItem.get(r._id) ?? [];
      const attributionNames = attributionIds.map(
        (id) => scholarName.get(String(id)) ?? "Scholar",
      );
      const familySharing = await portfolioFamilySharingEligibility(
        ctx,
        attributionIds,
        portfolioItemContainsIdentifiableMedia(r),
      );
      const capture = await captureForPortfolioItem(ctx, r);
      const item = {
        ...enrich(
          r,
          attributionNames[0] ?? null,
          r.assignmentId ? (assignmentTitle.get(r.assignmentId as string) ?? null) : null,
          r.activityId ? (activityTitle.get(r.activityId as string) ?? null) : null,
        ),
        scholarIds: attributionIds,
        scholarNames: attributionNames,
        familyVisibility: r.familyVisibility ?? "attributed_families",
        canShareWithFamilies: familySharing.allowed,
        familySharingBlocker: familySharing.blocker,
        thumbUrl: r.thumbStorageId
          ? await ctx.storage.getUrl(r.thumbStorageId)
          : null,
        videoThumbUrl: capture?.videoThumbStorageId
          ? await ctx.storage.getUrl(capture.videoThumbStorageId)
          : null,
        videoDurationMs: capture?.videoDurationMs ?? null,
        // Retagging a capture offers the STATION'S group roster, not the whole
        // school: a program cohort is mostly program guests, who are filtered
        // out of the ordinary scholar picker.
        captureRosterIds: capture
          ? await captureStationRosterIds(ctx, capture)
          : undefined,
      };
      if (needsReview(r)) toReview.push(item);
      else processed.push(item);
    }
    return { processing, toReview, processed };
  },
});

/**
 * Counts for the header control: items needing review (badge) + items still
 * processing (spinner). One always-on query so the header reflects in-flight
 * work even while the drawer is closed (scannerFeed is skipped when closed).
 */
export const scannerCounts = authedQuery({
  args: {
    scope: v.optional(v.string()),
    programGroupId: v.optional(v.id("scholarGroups")),
  },
  handler: async (ctx, args) => {
    const scope = await resolveScannerScope(ctx, args);
    const { reviewableGroups } = scope;
    if (!scope.ordinaryLens && scope.reviewableGroups.length === 0) {
      return { toReview: 0, processing: 0, reviewableGroups };
    }
    const reviewGroups = await Promise.all([
      takeByProcessingMatch(ctx, scope.lens, "unmatched", 100),
      takeByProcessingMatch(ctx, scope.lens, "ambiguous", 100),
      takeByProcessingAssignment(ctx, scope.lens, undefined, 100),
      takeByProcessingAssignment(ctx, scope.lens, "unresolved", 100),
    ]);
    const reviewCandidates = await filterScannerScope(
      ctx,
      reviewGroups.flat(),
      scope,
    );
    const reviewRows = new Map(
      reviewCandidates
        .filter(needsReview)
        .map((row) => [row._id, row]),
    );
    const toReview = reviewRows.size;

    // Mirror scannerFeed's "processing" bucket: in-flight statuses, younger
    // than STALE_MS (a crashed action can strand a row in pending forever, and
    // we don't want the header spinner stuck on).
    const STALE_MS = 10 * 60 * 1000;
    const cutoff = Date.now() - STALE_MS;
    const inProgressStatuses = ["pending", "extracting", "matching"] as const;
    const processingCandidates = (
      await Promise.all(
        inProgressStatuses.map((s) =>
          takeByProcessingStatus(ctx, scope.lens, s, 100),
        ),
      )
    ).flat();
    const processingRows = (
      await filterScannerScope(ctx, processingCandidates, scope)
    ).filter(
      (row) =>
        row._creationTime >= cutoff,
    );

    return { toReview, processing: processingRows.length, reviewableGroups };
  },
});

/** Active (non-archived) assignments a teacher can tag items into. */
export const listAssignmentsForPicker = authedQuery({
  args: {},
  handler: async (ctx) => {
    requireScholarAdmin(ctx);
    const rows = await ctx.db.query("assignments").collect();
    const active = [];
    for (const assignment of rows) {
      if (
        assignment.archivedAt == null &&
        (await canManageAssignment(ctx, assignment))
      ) {
        active.push(assignment);
      }
    }
    const out = [];
    for (const a of active) {
      // A standing (unitId-less) assignment has no unit title fallback.
      const unit = a.unitId ? await ctx.db.get(a.unitId) : null;
      out.push({
        id: a._id,
        title: a.title ?? unit?.title ?? "Assignment",
        createdAt: a._creationTime,
      });
    }
    return out;
  },
});

/**
 * Activities a scanned item can be filed to within a given assignment — the
 * assignment's unit walked lessons → activities, newest lesson order first.
 * Excludes Share Back activities (you don't scan INTO a digest). Each row
 * notes its kind + lesson so the picker can group them.
 */
export const listActivitiesForAssignment = authedQuery({
  args: { assignmentId: v.id("assignments") },
  handler: async (ctx, args) => {
    requireScholarAdmin(ctx);
    const assignment = await ctx.db.get(args.assignmentId);
    if (!assignment) return [];
    if (!(await canManageAssignment(ctx, assignment))) {
      throw new Error("Forbidden: school operations access required");
    }
    // A standing (unitId-less) assignment has no unit/lessons to file into.
    if (!assignment.unitId) return [];
    const lessons = await ctx.db
      .query("lessons")
      .withIndex("by_unit", (q) => q.eq("unitId", assignment.unitId!))
      .collect();
    lessons.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    const out: Array<{
      id: Id<"activities">;
      title: string;
      kind: "online" | "offline";
      lessonTitle: string;
      order: number;
    }> = [];
    for (const lesson of lessons) {
      const acts = await ctx.db
        .query("activities")
        .withIndex("by_lesson", (q) => q.eq("lessonId", lesson._id))
        .collect();
      acts.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
      for (const a of acts) {
        // No scans attach to Share Backs or external-site (web) work, nor to
        // adaptive problem sets, games, or simulators (no scanned artifact — a
        // game's record is its evidence digest, a simulator's is its run log).
        if (
          a.kind === "shareBack" ||
          a.kind === "web" ||
          a.kind === "problem_set" ||
          a.kind === "game" ||
          a.kind === "simulator" ||
          a.kind === "vibecode"
        )
          continue;
        out.push({
          id: a._id,
          title: a.title,
          kind: a.kind,
          lessonTitle: lesson.title,
          order: a.order ?? 0,
        });
      }
    }
    return out;
  },
});

/**
 * Read-only view of an OFFLINE project: its scanned deliverables, each with a
 * thumbnail + file URL + caption + grading. Backs the read-only drill-in when
 * a teacher opens an offline project (it has no chat to render). Visible to
 * scholar-admins and to the owning scholar (their own work).
 */
export const offlineSessionView = authedQuery({
  args: { sessionId: v.id("sessions") },
  handler: async (ctx, args) => {
    const session = await ctx.db.get(args.sessionId);
    if (!session || session.isOffline !== true) return null;
    const isOwner = session.userId === ctx.user._id;
    const canAdministerScholar =
      !isOwner &&
      !!session.userId &&
      (await canUserAccessScholar(ctx, ctx.user, session.userId));
    if (!isOwner && !canAdministerScholar) {
      throw new Error("Forbidden");
    }
    // The teacher grade control + AI-assess are teacher-only mutations; only a
    // staff viewer should see them. The owning scholar gets a read-only,
    // portrait-not-report-card view (Phase 2 — deliverable-kinds §6).
    const viewerCanGrade = !isOwner && isScholarAdminRole(ctx.user.role);
    const deliverables = await ctx.db
      .query("deliverables")
      .withIndex("by_session", (q) => q.eq("sessionId", args.sessionId))
      .collect();
    const items = (
      await Promise.all(
        deliverables.map(async (d) => {
          const item = d.portfolioItemId
            ? await ctx.db.get(d.portfolioItemId)
            : null;
          // A capture station item is not a general offline deliverable. Without
          // this check, this route could mint a signed URL after the staff-facing
          // capture boundary denied it. Owning scholars retain the explicit
          // portfolio self-read route; staff need the current capture-review
          // capability for this group.
          if (item?.source === "capture_station") {
            try {
              await requirePortfolioItemAccess(ctx, item);
            } catch {
              return null;
            }
          }
          return {
            deliverableId: d._id,
            title: item?.title ?? "Scanned work",
            caption: item?.aiCaption ?? null,
            thumbUrl: item?.thumbStorageId
              ? await ctx.storage.getUrl(item.thumbStorageId)
              : null,
            fileUrl: item?.fileStorageId
              ? await ctx.storage.getUrl(item.fileStorageId)
              : null,
            // Magic version (Magic Corners redrawn), alongside the original —
            // the UI decides which to show. null when there was no marker.
            magicUrl: item?.magicStorageId
              ? await ctx.storage.getUrl(item.magicStorageId)
              : null,
            overall: d.overall ?? null,
            rubricPassed: d.rubricPassed ?? null,
            // Scholar-facing "Checked by your teacher" state (Phase 2). A stamp
            // exists once a teacher grade or an assess has run; feedback is the
            // teacher's written note, shown only when present.
            checkedAt: d.rubricCheckedAt ?? null,
            checkedBy: d.rubricCheckedBy ?? null,
            teacherFeedback:
              d.rubricFeedback && d.rubricFeedback.trim().length > 0
                ? d.rubricFeedback
                : null,
            submittedAt: d.submittedAt,
          };
        }),
      )
    ).filter((item): item is NonNullable<typeof item> => item !== null);
    items.sort((a, b) => b.submittedAt - a.submittedAt);

    const activity = session.activityId
      ? await ctx.db.get(session.activityId)
      : null;
    const lesson = session.lessonId ? await ctx.db.get(session.lessonId) : null;
    const unit = session.unitId ? await ctx.db.get(session.unitId) : null;
    const assignment = session.assignmentId
      ? await ctx.db.get(session.assignmentId)
      : null;
    const teacher = assignment ? await ctx.db.get(assignment.teacherId) : null;
    const scheduleEntry = assignment?.activitySchedule?.find(
      (entry) =>
        String(entry.activityId) === String(session.activityId) &&
        entryTargetsScholar(entry, session.userId),
    );
    const resources = activity
      ? await activityResourceDisplayRows(ctx, activity._id)
      : [];

    return {
      title: session.title,
      // Scholar-visible (owning scholar reads their own offline work), so the
      // payload `description` carries the scholar-facing copy — never the
      // teacher-facing `activity.description`.
      description:
        activity?.scholarDescription && activity.scholarDescription.trim().length > 0
          ? activity.scholarDescription
          : null,
      unitTitle: unit?.title ?? null,
      unitEmoji: unit?.emoji ?? null,
      lessonTitle: lesson?.title ?? null,
      teacherName: teacher?.name ?? null,
      dueAt: scheduleEntry?.dueAt ?? null,
      isHomework: scheduleEntry?.mode === "homework",
      timeZone: await timeZoneForScholar(ctx, session.userId),
      resources,
      items,
      viewerCanGrade,
    };
  },
});

// ── Internal API (consumed by portfolioActions + driveSync) ─────────────

/** Internal: fetch a row including text/storage fields. */
export const aiGetItem = internalQuery({
  args: { itemId: v.id("portfolioItems") },
  handler: async (ctx, args) => {
    return await ctx.db.get(args.itemId);
  },
});

/**
 * Internal: the set of Drive file ids already ingested. The sync action uses
 * this to skip downloading files it's seen, so a poll over a folder of N
 * scans only fetches the new ones.
 */
export const knownDriveFileIds = internalQuery({
  args: {},
  handler: async (ctx) => {
    // "Known" = don't auto-ingest: files that still have items, plus files
    // whose items a teacher deleted (dismissals) — otherwise the folder sync
    // resurrects deleted scans.
    const rows = await ctx.db.query("portfolioItems").collect();
    const dismissals = await ctx.db.query("driveFileDismissals").collect();
    return [
      ...rows
        .map((r) => r.driveFileId)
        .filter((id): id is string => id != null),
      ...dismissals.map((d) => d.driveFileId),
    ];
  },
});

/** Internal: roster of scholars for the matcher (id + name + username).
 *
 * When `institutionId` is given, the roster is CONSTRAINED to that
 * institution's scholars (plus unassigned scholars when it's the primary
 * school — mirrors `scholarInLens`). This is the cross-tenant correctness fix:
 * a page scanned at School A can never match School B's roster. With no
 * institutionId (legacy / unscoped callers) the full roster is returned. */
export const listScholarsForMatch = internalQuery({
  args: { institutionId: v.optional(v.id("institutions")) },
  handler: async (ctx, args) => {
    const scholars = await ctx.db
      .query("users")
      .withIndex("by_role", (q) => q.eq("role", ROLES.SCHOLAR))
      .collect();
    let roster = scholars;
    if (args.institutionId) {
      const inst = await ctx.db.get(args.institutionId);
      const isPrimary = !!inst?.isPrimary;
      roster = scholars.filter(
        (s) =>
          s.institutionId === args.institutionId ||
          (s.institutionId === undefined && isPrimary),
      );
    }
    return roster.map((s) => ({
      id: s._id as string,
      name: s.name ?? null,
      username: s.username ?? null,
    }));
  },
});

/** Internal: patch processingStatus (+ optional error). */
export const aiPatchProcessingStatus = internalMutation({
  args: {
    itemId: v.id("portfolioItems"),
    status: v.union(
      v.literal("pending"),
      v.literal("extracting"),
      v.literal("matching"),
      v.literal("ready"),
      v.literal("error"),
    ),
    error: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.itemId, {
      processingStatus: args.status,
      processingError: args.error,
    });
    // Processing just finished. This is the ONE moment the ingest pipeline
    // (portfolioActions.extractAndMatch) hands an item off with a resolved
    // scholar and no teacher touch, so it's where an activity-LESS scan gets
    // its observer pass scheduled (reconcile's non-materializing branch →
    // portfolioAssess). Only on "ready": reconciling a still-processing or
    // errored item would materialize/tear down deliverables mid-flight.
    if (args.status === "ready") {
      await reconcilePortfolioMaterialization(ctx, args.itemId);
    }
  },
});

/** Internal: set the thumbnail status (+ optional storage id). */
export const aiSetThumb = internalMutation({
  args: {
    itemId: v.id("portfolioItems"),
    thumbStorageId: v.optional(v.id("_storage")),
    status: v.union(
      v.literal("pending"),
      v.literal("ready"),
      v.literal("error"),
    ),
  },
  handler: async (ctx, args) => {
    const item = await ctx.db.get(args.itemId);
    if (!item) {
      if (args.thumbStorageId) {
        await ctx.storage.delete(args.thumbStorageId);
      }
      return false;
    }
    const patch: Partial<Doc<"portfolioItems">> = { thumbStatus: args.status };
    if (args.thumbStorageId !== undefined) patch.thumbStorageId = args.thumbStorageId;
    await ctx.db.patch(args.itemId, patch);
    return true;
  },
});

/**
 * Internal: atomically swap in a page-rotation repair and invalidate every
 * derived rendering. The action stores the replacement first; if the item was
 * deleted meanwhile, this mutation cleans that orphaned blob.
 */
export const replaceFileAfterRotation = internalMutation({
  args: {
    itemId: v.id("portfolioItems"),
    expectedOldStorageId: v.id("_storage"),
    newStorageId: v.id("_storage"),
    newSizeBytes: v.number(),
  },
  handler: async (ctx, args) => {
    const item = await ctx.db.get(args.itemId);
    if (!item) {
      await ctx.storage.delete(args.newStorageId);
      return { replaced: false, regenerateMagic: false };
    }
    if (item.fileStorageId !== args.expectedOldStorageId) {
      await ctx.storage.delete(args.newStorageId);
      return { replaced: false, regenerateMagic: false };
    }
    if (item.fileMimeType !== "application/pdf" || !item.fileStorageId) {
      await ctx.storage.delete(args.newStorageId);
      throw new Error("Only stored PDF portfolio items can be rotation-repaired");
    }

    const borrowedOriginal = await ctx.db
      .query("parentMessageAttachments")
      .withIndex("by_storage", (q) => q.eq("storageId", item.fileStorageId!))
      .first();
    const staleDerivedIds = [
      item.thumbStorageId,
      item.magicStorageId,
      item.magicThumbStorageId,
    ].filter((id): id is Id<"_storage"> => id != null);
    const regenerateMagic = item.magicStorageId != null;

    await ctx.db.patch(args.itemId, {
      fileStorageId: args.newStorageId,
      fileSizeBytes: args.newSizeBytes,
      thumbStorageId: undefined,
      thumbStatus: "pending",
      magicStorageId: undefined,
      magicThumbStorageId: undefined,
      magicInstruction: undefined,
    });

    if (!borrowedOriginal) {
      await ctx.storage.delete(item.fileStorageId);
    }
    for (const storageId of staleDerivedIds) {
      await ctx.storage.delete(storageId);
    }
    return { replaced: true, regenerateMagic };
  },
});

/** Internal: store the Magic-Annotations redraw (+ its thumbnail + instruction) on an item. */
export const setMagicResult = internalMutation({
  args: {
    itemId: v.id("portfolioItems"),
    magicStorageId: v.id("_storage"),
    magicThumbStorageId: v.optional(v.id("_storage")),
    magicInstruction: v.string(),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.itemId, {
      magicStorageId: args.magicStorageId,
      magicThumbStorageId: args.magicThumbStorageId,
      magicInstruction: args.magicInstruction,
    });
  },
});

/** Internal: set just the magic thumbnail (used by the backfill). */
export const setMagicThumb = internalMutation({
  args: {
    itemId: v.id("portfolioItems"),
    magicThumbStorageId: v.id("_storage"),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.itemId, { magicThumbStorageId: args.magicThumbStorageId });
  },
});

/**
 * Internal: items that HAVE a magic redraw but no magic thumbnail yet —
 * i.e. magic items processed before magic thumbnails existed. Drives the
 * one-time backfill in magicAnnotations.backfillMagicThumbnails.
 */
export const itemsMissingMagicThumb = internalQuery({
  args: { limit: v.number() },
  handler: async (ctx, args) => {
    const rows = await ctx.db.query("portfolioItems").collect();
    return rows
      .filter((r) => r.magicStorageId != null && r.magicThumbStorageId == null)
      .slice(0, args.limit)
      .map((r) => ({ itemId: r._id, magicStorageId: r.magicStorageId! }));
  },
});

/**
 * Internal: ids of items that have a file but no thumbnail yet (and aren't
 * already queued). Drives the backfill in portfolioThumbs.backfill. Items stuck
 * in "pending" past THUMB_PENDING_STALE_MS ARE included so a hung/killed
 * generate action can be re-driven (a fresh, still-generating item is left
 * alone to avoid racing its in-flight generate).
 */
export const itemsMissingThumb = internalQuery({
  args: { limit: v.number() },
  handler: async (ctx, args) => {
    const rows = await ctx.db.query("portfolioItems").collect();
    return rows
      .filter(
        (r) =>
          r.fileStorageId != null &&
          r.thumbStorageId == null &&
          (r.thumbStatus !== "pending" ||
            Date.now() - r._creationTime > THUMB_PENDING_STALE_MS),
      )
      .slice(0, args.limit)
      .map((r) => r._id);
  },
});

/** Internal: write the vision-extraction outputs. */
export const aiPatchExtraction = internalMutation({
  args: {
    itemId: v.id("portfolioItems"),
    caption: v.optional(v.string()),
    extractedText: v.optional(v.string()),
    detectedName: v.optional(v.string()),
    documentHeading: v.optional(v.string()),
    // Optionally upgrade the title from the AI caption when the Drive
    // filename was junk ("scan_0042.pdf").
    title: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const patch: Partial<Doc<"portfolioItems">> = {};
    if (args.caption !== undefined) patch.aiCaption = args.caption;
    if (args.extractedText !== undefined) patch.extractedText = args.extractedText;
    if (args.detectedName !== undefined) patch.detectedName = args.detectedName;
    if (args.documentHeading !== undefined) {
      patch.documentHeading = normalizeDocumentHeading(args.documentHeading);
    }
    if (args.title !== undefined) patch.title = args.title;
    await ctx.db.patch(args.itemId, patch);

    // OCR/caption just landed — if this item already materialized a
    // deliverable for a baseline/exit-ticket activity, (re)assess it now
    // that there's text. Covers the tag-then-OCR ordering (reconcile fired
    // at tag time before any text existed).
    if (args.extractedText !== undefined || args.caption !== undefined) {
      const deliverables = await ctx.db
        .query("deliverables")
        .withIndex("by_portfolioItem", (q) =>
          q.eq("portfolioItemId", args.itemId),
        )
        .collect();
      for (const deliverable of deliverables) {
        await maybeScheduleArtifactAssessment(ctx, deliverable._id);
      }
    }
  },
});

/** Internal: write only the printed document heading (used by the backfill). */
export const aiPatchDocumentHeading = internalMutation({
  args: {
    itemId: v.id("portfolioItems"),
    documentHeading: v.string(),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.itemId, {
      documentHeading: normalizeDocumentHeading(args.documentHeading),
    });
  },
});

/**
 * Backfill ready scans whose ingest predated printed-heading extraction.
 * By default, the "" result sentinel remains terminal. Operators can retry
 * empty results or every eligible scan after extraction improvements.
 */
export const sweepMissingHeadings = internalMutation({
  args: {
    limit: v.optional(v.number()),
    redoEmpty: v.optional(v.boolean()),
    redoAll: v.optional(v.boolean()),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{ considered: number; scheduled: number }> => {
    const limit = Math.max(1, args.limit ?? 50);
    const force = (args.redoEmpty ?? false) || (args.redoAll ?? false);
    const candidates = await ctx.db
      .query("portfolioItems")
      .withIndex("by_processingStatus", (q) =>
        q.eq("processingStatus", "ready"),
      )
      .collect();

    let scheduled = 0;
    for (const item of candidates) {
      if (scheduled >= limit) break;
      if (
        !args.redoAll &&
        item.documentHeading !== undefined &&
        !(args.redoEmpty && item.documentHeading === "")
      ) {
        continue;
      }
      if (item.fileStorageId == null) continue;
      await ctx.scheduler.runAfter(
        0,
        internal.portfolioActions.extractHeadingOnly,
        { itemId: item._id, force },
      );
      scheduled++;
    }
    return { considered: candidates.length, scheduled };
  },
});

/**
 * Internal: write the match verdict. For Drive-sourced items only — manual
 * uploads are already "confirmed" and we never overwrite a teacher's choice.
 */
export const aiSetMatch = internalMutation({
  args: {
    itemId: v.id("portfolioItems"),
    scholarId: v.optional(v.id("users")),
    matchStatus: v.union(
      v.literal("unmatched"),
      v.literal("ambiguous"),
      v.literal("matched"),
      v.literal("confirmed"),
    ),
    matchConfidence: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const item = await ctx.db.get(args.itemId);
    if (!item) return;
    if (item.matchStatus === "confirmed") return; // never clobber a human/manual decision
    await ctx.db.patch(args.itemId, {
      scholarId: args.scholarId,
      matchStatus: args.matchStatus,
      matchConfidence: args.matchConfidence,
    });
    // Keep the canonical attribution table in step with the legacy field, so
    // these rows survive the eventual legacy-scholarId narrow. Any existing
    // rows here are AI-written too (a teacher touch sets "confirmed", which
    // bailed above), so reconciling them away on a re-match is safe.
    const existing = await ctx.db
      .query("portfolioAttributions")
      .withIndex("by_item", (q) => q.eq("portfolioItemId", args.itemId))
      .collect();
    const keep = args.scholarId ?? null;
    for (const row of existing) {
      if (row.scholarId !== keep) await ctx.db.delete(row._id);
    }
    if (keep && !existing.some((row) => row.scholarId === keep)) {
      await ctx.db.insert("portfolioAttributions", {
        portfolioItemId: args.itemId,
        scholarId: keep,
        attributedAt: Date.now(),
      });
    }
  },
});

/**
 * Internal: has this Drive file already been ingested? Dedupe gate so a
 * re-delivered webhook (or a safety-net poll overlapping a push) never
 * double-ingests. A file can split into several items, so we check existence
 * rather than uniqueness.
 */
export const hasItemsForDriveFile = internalQuery({
  args: { driveFileId: v.string() },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("portfolioItems")
      .withIndex("by_driveFileId", (q) => q.eq("driveFileId", args.driveFileId))
      .first();
    return existing !== null;
  },
});

/**
 * Internal: should an AUTOMATIC ingest path (watch re-delivery) skip this
 * Drive file? True when items still exist for it OR a teacher deleted its
 * items (a dismissal). The explicit re-pick (`ingestDriveFileById`) keeps
 * using `hasItemsForDriveFile` so a deliberate re-import beats a dismissal.
 */
export const driveFileAlreadyHandled = internalQuery({
  args: { driveFileId: v.string() },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("portfolioItems")
      .withIndex("by_driveFileId", (q) => q.eq("driveFileId", args.driveFileId))
      .first();
    if (existing !== null) return true;
    const dismissed = await ctx.db
      .query("driveFileDismissals")
      .withIndex("by_driveFileId", (q) => q.eq("driveFileId", args.driveFileId))
      .first();
    return dismissed !== null;
  },
});

/**
 * Internal: create one finished portfolio item (a segment of a scan, or a
 * whole single-page scan). Called by the ingestion action AFTER it has
 * extracted + matched, so the row lands "ready" with its scholar verdict.
 * One Drive file may produce several of these (a stack of submissions).
 */
export const insertSegment = internalMutation({
  args: {
    source: v.union(
      v.literal("google_drive"),
      v.literal("upload"),
      v.literal("photo"),
    ),
    driveFileId: v.optional(v.string()),
    title: v.string(),
    fileStorageId: v.id("_storage"),
    fileMimeType: v.optional(v.string()),
    fileSizeBytes: v.optional(v.number()),
    pageRange: v.optional(v.object({ start: v.number(), end: v.number() })),
    detectedName: v.optional(v.string()),
    documentHeading: v.optional(v.string()),
    aiCaption: v.optional(v.string()),
    extractedText: v.optional(v.string()),
    scholarId: v.optional(v.id("users")),
    matchStatus: v.union(
      v.literal("unmatched"),
      v.literal("ambiguous"),
      v.literal("matched"),
    ),
    matchConfidence: v.optional(v.number()),
    assignmentId: v.optional(v.id("assignments")),
    assignmentStatus: v.union(
      v.literal("unresolved"),
      v.literal("matched"),
      v.literal("none"),
    ),
    institutionId: v.optional(v.id("institutions")),
  },
  handler: async (ctx, args) => {
    if (args.driveFileId) {
      const existing = (
        await ctx.db
          .query("portfolioItems")
          .withIndex("by_driveFileId", (q) =>
            q.eq("driveFileId", args.driveFileId!),
          )
          .collect()
      ).find((item) =>
        item.pageRange == null && args.pageRange == null
          ? true
          : item.pageRange != null &&
            args.pageRange != null &&
            item.pageRange.start === args.pageRange.start &&
            item.pageRange.end === args.pageRange.end,
      );
      if (existing) {
        if (existing.fileStorageId !== args.fileStorageId) {
          await ctx.storage.delete(args.fileStorageId);
        }
        return existing._id;
      }
    }
    const itemId = await ctx.db.insert("portfolioItems", {
      title: args.title.trim() || "Untitled scan",
      source: args.source,
      driveFileId: args.driveFileId,
      fileStorageId: args.fileStorageId,
      fileMimeType: args.fileMimeType,
      fileSizeBytes: args.fileSizeBytes,
      pageRange: args.pageRange,
      detectedName: args.detectedName,
      documentHeading:
        args.documentHeading === undefined
          ? undefined
          : normalizeDocumentHeading(args.documentHeading),
      aiCaption: args.aiCaption,
      extractedText: args.extractedText,
      scholarId: args.scholarId,
      matchStatus: args.matchStatus,
      matchConfidence: args.matchConfidence,
      assignmentId: args.assignmentId,
      assignmentStatus: args.assignmentStatus,
      institutionId: args.institutionId,
      processingStatus: "ready",
      thumbStatus: "pending",
      familyVisibility:
        args.assignmentId && args.assignmentStatus === "matched"
          ? "attributed_families"
          : "staff_only",
    });
    if (args.scholarId) {
      await ctx.db.insert("portfolioAttributions", {
        portfolioItemId: itemId,
        scholarId: args.scholarId,
        attributedAt: Date.now(),
      });
    }
    // The segment file is final here (rotated copies already stored), so the
    // thumbnail can render off it immediately.
    await ctx.scheduler.runAfter(0, internal.portfolioThumbs.generate, { itemId });

    // Capstone: auto-file by the live activity window. When the scholar is
    // matched and the assignment is known, the activity the cohort was doing
    // at scan time is inferable — `liveActivityAt` returns the activity whose
    // LIVE window contained the timestamp. If it resolves, tag it and
    // materialize, so a printed worksheet flows straight to a graded-pending
    // submission with no teacher touch. If no window matches (e.g. the scan
    // arrived after a class-focus push auto-cleared), the activity stays open
    // for the teacher — the same conservative stance as assignment matching.
    //
    // Uses ingest time as the capture-time proxy. For the printer→Drive path
    // that's within seconds of the scan; a future refinement could thread the
    // Drive file's capture/modified time for work scanned well after class.
    if (args.matchStatus === "matched" && args.scholarId && args.assignmentId) {
      const activityId = await liveActivityAt(
        ctx,
        args.assignmentId,
        args.scholarId,
        Date.now(),
      );
      if (activityId) {
        await ctx.db.patch(itemId, { activityId });
      }
    }
    // Always reconcile: with an activity this materializes the offline session
    // + deliverable (as before); WITHOUT one it schedules the scan observer for
    // an item that would otherwise produce nothing downstream (portfolioAssess).
    // The row lands "ready" here, so this is the segment path's hand-off point.
    await reconcilePortfolioMaterialization(ctx, itemId);
    return itemId;
  },
});

/**
 * Internal: active assignments for the AI classifier — id, title, unit title +
 * topic, and the enrolled scholar ids (so the classifier can cross-check that a
 * guessed assignment actually includes the matched scholar).
 */
export const activeAssignmentsForMatch = internalQuery({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db.query("assignments").collect();
    const active = rows.filter((a) => a.archivedAt == null);
    const out = [];
    for (const a of active) {
      // A standing (unitId-less) assignment has no unit to describe.
      const unit = a.unitId ? await ctx.db.get(a.unitId) : null;
      out.push({
        id: a._id as string,
        title: a.title ?? unit?.title ?? "Assignment",
        unitTitle: unit?.title ?? null,
        description: unit?.description ?? null,
        scholarIds: (a.scholarIds as string[]) ?? [],
      });
    }
    return out;
  },
});

/**
 * Internal: insert a placeholder portfolioItem row the instant a teacher
 * starts an ingest, so the UI shows a spinner immediately. ingestScan picks
 * up the placeholderItemId, patches it through extracting/matching states,
 * then deletes it once the real segment row(s) land. If the action throws
 * before it gets to delete, the cron sweep (sweepStaleProcessing) marks the
 * row as `error` after 10 min so it falls off the live feed.
 *
 * Kept separate from `insertSegment` because a single ingest can produce
 * MULTIPLE segment rows (a stacked-PDF scan) — the placeholder is 1:1 with
 * the upload action, not 1:1 with the final items.
 */
export const insertPlaceholder = internalMutation({
  args: {
    source: v.union(
      v.literal("google_drive"),
      v.literal("upload"),
      v.literal("photo"),
    ),
    title: v.string(),
    fileStorageId: v.id("_storage"),
    fileMimeType: v.optional(v.string()),
    fileSizeBytes: v.optional(v.number()),
    driveFileId: v.optional(v.string()),
    uploadedBy: v.id("users"),
    institutionId: v.optional(v.id("institutions")),
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert("portfolioItems", {
      title: args.title,
      source: args.source,
      fileStorageId: args.fileStorageId,
      fileMimeType: args.fileMimeType,
      fileSizeBytes: args.fileSizeBytes,
      driveFileId: args.driveFileId,
      uploadedBy: args.uploadedBy,
      institutionId: args.institutionId,
      matchStatus: "unmatched",
      processingStatus: "pending",
      familyVisibility: "staff_only",
    });
  },
});

/**
 * Internal: delete a placeholder iff it's safe to drop. Two gates:
 *
 *   1. processingStatus must still be in-flight (pending/extracting/matching).
 *      Anything else means the placeholder already settled or errored and
 *      isn't ours to delete.
 *   2. The teacher hasn't manually triaged the row mid-flight. The classifier
 *      ("matching" state) takes a few seconds, and a teacher who picks
 *      Scholar/Activity during that window must not have their decision
 *      silently vaporized when ingestScan replaces the placeholder with real
 *      segment rows. If matchStatus or assignmentStatus is "confirmed", we
 *      leave the placeholder as a real item alongside whatever segments
 *      ingestScan inserts — slight duplication beats silent data loss.
 */
export const deletePlaceholderIfPending = internalMutation({
  args: { itemId: v.id("portfolioItems") },
  handler: async (ctx, args) => {
    const item = await ctx.db.get(args.itemId);
    if (!item) return { deleted: false };
    const inFlight =
      item.processingStatus === "pending" ||
      item.processingStatus === "extracting" ||
      item.processingStatus === "matching";
    if (!inFlight) return { deleted: false };
    // Teacher already triaged it — promote, don't delete.
    if (item.matchStatus === "confirmed" || item.assignmentStatus === "confirmed") {
      await ctx.db.patch(args.itemId, { processingStatus: "ready" });
      // Now "ready" and teacher-triaged — same hand-off as aiPatchProcessingStatus.
      await reconcilePortfolioMaterialization(ctx, args.itemId);
      return { deleted: false, promoted: true };
    }
    await ctx.db.delete(args.itemId);
    return { deleted: true };
  },
});

/**
 * Internal: sweep portfolioItems stuck in pending/extracting/matching past a
 * 10-minute cutoff and mark them `error`. The live scannerFeed already
 * filters these out of the in-progress section by _creationTime, but the DB
 * rows themselves linger, which (a) clogs status-keyed indexes and (b) shows
 * up as a stuck placeholder if a teacher pokes around the underlying tables.
 * Run by the "sweep stale portfolio ingest" cron every 5 min.
 */
export const sweepStaleProcessing = internalMutation({
  args: {},
  handler: async (ctx) => {
    const STALE_MS = 10 * 60 * 1000;
    const cutoff = Date.now() - STALE_MS;
    const stuck = ["pending", "extracting", "matching"] as const;
    let marked = 0;
    for (const status of stuck) {
      const rows = await ctx.db
        .query("portfolioItems")
        .withIndex("by_processingStatus", (q) => q.eq("processingStatus", status))
        .collect();
      for (const r of rows) {
        if (r._creationTime < cutoff) {
          await ctx.db.patch(r._id, {
            processingStatus: "error",
            processingError: "Processing timed out — ingest action did not complete",
          });
          marked++;
        }
      }
    }
    return { marked };
  },
});

/**
 * Internal: swap an item's stored file for a new one (used to bake in a
 * rotation on the manual-upload path), deleting the old blob.
 */
export const aiReplaceFile = internalMutation({
  args: {
    itemId: v.id("portfolioItems"),
    newStorageId: v.id("_storage"),
  },
  handler: async (ctx, args) => {
    const item = await ctx.db.get(args.itemId);
    if (!item) return;
    if (item.fileStorageId && item.fileStorageId !== args.newStorageId) {
      try {
        await ctx.storage.delete(item.fileStorageId);
      } catch {
        // ignore
      }
    }
    await ctx.db.patch(args.itemId, { fileStorageId: args.newStorageId });
  },
});

// ── Test/fixture helpers (dev-only, internal — not browser-reachable) ────

/**
 * Insert a portfolio item directly in a target state, bypassing storage +
 * the extraction action. Used by tests and dev verification so we don't burn
 * Claude credits round-tripping a fake scan. Only ever pointed at test data.
 */
export const adminFixtureInsert = internalMutation({
  args: {
    scholarId: v.optional(v.id("users")),
    title: v.string(),
    source: v.union(
      v.literal("google_drive"),
      v.literal("manual"),
      v.literal("upload"),
      v.literal("photo"),
    ),
    fileMimeType: v.optional(v.string()),
    driveFileId: v.optional(v.string()),
    detectedName: v.optional(v.string()),
    aiCaption: v.optional(v.string()),
    matchStatus: v.union(
      v.literal("unmatched"),
      v.literal("ambiguous"),
      v.literal("matched"),
      v.literal("confirmed"),
    ),
    assignmentId: v.optional(v.id("assignments")),
    assignmentStatus: v.optional(
      v.union(
        v.literal("unresolved"),
        v.literal("matched"),
        v.literal("confirmed"),
        v.literal("none"),
      ),
    ),
    processingStatus: v.union(
      v.literal("pending"),
      v.literal("extracting"),
      v.literal("matching"),
      v.literal("ready"),
      v.literal("error"),
    ),
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert("portfolioItems", {
      scholarId: args.scholarId,
      title: args.title,
      source: args.source,
      fileMimeType: args.fileMimeType,
      driveFileId: args.driveFileId,
      detectedName: args.detectedName,
      aiCaption: args.aiCaption,
      matchStatus: args.matchStatus,
      assignmentId: args.assignmentId,
      assignmentStatus: args.assignmentStatus,
      processingStatus: args.processingStatus,
      familyVisibility:
        args.assignmentId &&
        (args.assignmentStatus === "matched" ||
          args.assignmentStatus === "confirmed")
          ? "attributed_families"
          : "staff_only",
    });
  },
});
