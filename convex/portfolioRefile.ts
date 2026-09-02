import { v } from "convex/values";
import { action } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { getAuthUserId } from "@convex-dev/auth/server";
import { detectHealthDocumentContentType } from "./scholarHealthRecords";

const refileKindValidator = v.union(
  v.literal("assessment"),
  v.literal("iep"),
  v.literal("report_card"),
  v.literal("identity_document"),
  v.literal("parent_email"),
  v.literal("observation"),
  v.literal("other"),
  v.literal("immunization_record"),
  v.literal("medication_authorization"),
  v.literal("action_plan_document"),
  v.literal("action_plan_document_allergy"),
  v.literal("action_plan_document_asthma"),
  v.literal("custody_document"),
  v.literal("support_plan_document"),
);

function fileNameFor(title: string, contentType: string): string {
  if (/\.[a-z0-9]+$/i.test(title)) return title;
  const extension =
    contentType === "application/pdf"
      ? ".pdf"
      : contentType === "image/jpeg"
        ? ".jpg"
        : contentType === "image/png"
          ? ".png"
          : "";
  return `${title || "Scanned document"}${extension}`;
}

/**
 * Move one scanner row into its canonical secure record destination. The action
 * copies the blob before the transactional commit deletes the portfolio source,
 * so the destination never borrows a scanner-owned storage id.
 */
export const fileAsRecord = action({
  args: {
    itemId: v.id("portfolioItems"),
    kind: refileKindValidator,
    institutionScope: v.optional(v.string()),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{
    scholarId: Id<"users">;
    scholarName: string;
    kind: string;
    destination:
      | { store: "scholarDocuments"; id: Id<"scholarDocuments"> }
      | { store: "healthRecordFiles"; id: Id<"healthRecordFiles"> };
  }> => {
    if (!(await getAuthUserId(ctx))) throw new Error("Not signed in");
    const source: {
      fileStorageId: Id<"_storage">;
      title: string;
      fileMimeType?: string;
    } = await ctx.runMutation(
      internal.portfolioRefileMutations.prepare,
      args,
    );
    const blob = await ctx.storage.get(source.fileStorageId);
    if (!blob) throw new Error("Scanned file is unavailable");
    const contentType = source.fileMimeType || blob.type;
    const signature = new Uint8Array(
      await blob.slice(0, 8).arrayBuffer(),
    );
    const copiedStorageId = await ctx.storage.store(
      blob.slice(0, blob.size, contentType),
    );
    try {
      return await ctx.runMutation(internal.portfolioRefileMutations.commit, {
        ...args,
        copiedStorageId,
        sourceStorageId: source.fileStorageId,
        sourceContentType: source.fileMimeType,
        detectedContentType: detectHealthDocumentContentType(signature),
        fileName: fileNameFor(source.title, contentType),
      });
    } catch (error) {
      await ctx.storage.delete(copiedStorageId).catch(() => {});
      throw error;
    }
  },
});
