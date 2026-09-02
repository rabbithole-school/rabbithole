import { v } from "convex/values";
import { internalMutation, type MutationCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { assertNotImpersonating, requireUser } from "./lib/auth";
import { requireActiveScholarAccess } from "./lib/access";
import {
  documentKindUsesExtraction,
  requireKindAccess,
} from "./lib/documentKinds";
import {
  hasHealthAccessAtInstitution,
  hasSchoolOperationsAccessAtInstitution,
} from "./lib/staffCapabilities";
import { attributedScholarIds } from "./lib/portfolioAttributions";
import { deletePortfolioItem } from "./portfolio";
import { attachStaffHealthDocumentFromStorage } from "./scholarHealthRecords";
import { HEALTH_DOCUMENT_MAX_BYTES } from "../shared/healthDocuments";

const refileKindValidator = v.union(
  v.literal("assessment"), v.literal("iep"), v.literal("report_card"),
  v.literal("identity_document"), v.literal("parent_email"),
  v.literal("observation"), v.literal("other"),
  v.literal("immunization_record"), v.literal("medication_authorization"),
  v.literal("action_plan_document"),
  v.literal("action_plan_document_allergy"),
  v.literal("action_plan_document_asthma"), v.literal("custody_document"),
  v.literal("support_plan_document"),
);

type RefileKind =
  | "assessment" | "iep" | "report_card" | "identity_document"
  | "parent_email" | "observation" | "other" | "immunization_record"
  | "medication_authorization" | "action_plan_document"
  | "action_plan_document_allergy" | "action_plan_document_asthma"
  | "custody_document" | "support_plan_document";

async function refileContext(
  ctx: MutationCtx,
  args: { itemId: Id<"portfolioItems">; kind: RefileKind; institutionScope?: string },
) {
  const user = await requireUser(ctx);
  await assertNotImpersonating(ctx);
  const item = await ctx.db.get(args.itemId);
  if (!item?.fileStorageId) throw new Error("Scanned file is unavailable");
  const scholarIds = await attributedScholarIds(ctx, item);
  if (scholarIds.length !== 1) {
    throw new Error("Assign exactly one scholar before filing this scan");
  }
  const scholarId = scholarIds[0];
  const scholar = await ctx.db.get(scholarId);
  if (!scholar || scholar.role !== "scholar") throw new Error("Scholar not found");
  if (item.institutionId && scholar.institutionId !== item.institutionId) {
    throw new Error("Scholar is not in this scan's institution");
  }
  if (
    !scholar.institutionId ||
    !(await hasSchoolOperationsAccessAtInstitution(ctx, user, scholar.institutionId))
  ) {
    throw new Error("Forbidden: scanner access required");
  }
  await requireActiveScholarAccess(ctx, user, scholarId);
  const hasHealthAccess = await hasHealthAccessAtInstitution(
    ctx, user, scholar.institutionId,
  );
  const spec = requireKindAccess(
    user.role,
    args.kind,
    false,
    hasHealthAccess,
  );
  return { user, item, scholar, scholarId, spec };
}

export const prepare = internalMutation({
  args: {
    itemId: v.id("portfolioItems"),
    kind: refileKindValidator,
    institutionScope: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { item, spec } = await refileContext(ctx, args);
    const metadata = await ctx.db.system.get("_storage", item.fileStorageId!);
    if (!metadata) throw new Error("Scanned file is unavailable");
    if (
      spec.store === "healthRecordFiles" &&
      metadata.size > HEALTH_DOCUMENT_MAX_BYTES
    ) {
      throw new Error("Records must be 10 MB or smaller");
    }
    return {
      fileStorageId: item.fileStorageId!,
      title: item.label?.trim() || item.title,
      fileMimeType: item.fileMimeType,
    };
  },
});

export const commit = internalMutation({
  args: {
    itemId: v.id("portfolioItems"),
    kind: refileKindValidator,
    institutionScope: v.optional(v.string()),
    copiedStorageId: v.id("_storage"),
    sourceStorageId: v.id("_storage"),
    sourceContentType: v.optional(v.string()),
    fileName: v.string(),
    detectedContentType: v.union(
      v.null(), v.literal("application/pdf"), v.literal("image/jpeg"),
      v.literal("image/png"),
    ),
  },
  handler: async (ctx, args) => {
    const { user, item, scholar, scholarId, spec } = await refileContext(ctx, args);
    if (item.fileStorageId !== args.sourceStorageId) {
      throw new Error("The scanned file changed; reopen it and try again");
    }
    let destination:
      | { store: "scholarDocuments"; id: Id<"scholarDocuments"> }
      | { store: "healthRecordFiles"; id: Id<"healthRecordFiles"> };
    if (spec.store === "scholarDocuments") {
      const documentId = await ctx.db.insert("scholarDocuments", {
        scholarId,
        kind: args.kind as Extract<RefileKind, "assessment" | "iep" | "report_card" | "identity_document" | "parent_email" | "observation" | "other">,
        format: "file",
        title: item.label?.trim() || item.title || "Scanned document",
        fileStorageId: args.copiedStorageId,
        fileMimeType: item.fileMimeType,
        fileSizeBytes: item.fileSizeBytes,
        uploadedBy: user._id,
        processingStatus: documentKindUsesExtraction(args.kind)
          ? "pending"
          : "ready",
        feedsTutor: false,
      });
      await ctx.db.insert("documentAccessLog", {
        documentId, scholarId, userId: user._id, action: "upload",
      });
      if (documentKindUsesExtraction(args.kind)) {
        await ctx.scheduler.runAfter(
          0,
          internal.scholarDocumentActions.extractAndRedact,
          { documentId },
        );
      }
      destination = { store: "scholarDocuments", id: documentId };
    } else {
      const document = await attachStaffHealthDocumentFromStorage(ctx, {
        user,
        scholarId,
        kind: args.kind as Extract<RefileKind, "immunization_record" | "medication_authorization" | "action_plan_document" | "action_plan_document_allergy" | "action_plan_document_asthma" | "custody_document" | "support_plan_document">,
        storageId: args.copiedStorageId,
        fileName: args.fileName,
        declaredContentType: args.sourceContentType,
        detectedContentType: args.detectedContentType,
        institutionScope: args.institutionScope,
      });
      destination = { store: "healthRecordFiles", id: document.fileId };
    }
    await deletePortfolioItem(ctx, item, {
      dismissDriveFile: true,
      dismissedBy: user._id,
    });
    return {
      scholarId,
      scholarName: scholar.name ?? scholar.username ?? "Scholar",
      kind: args.kind,
      destination,
    };
  },
});
