"use node";

import { v } from "convex/values";
import { internal } from "./_generated/api";
import { internalAction } from "./_generated/server";
import { classifyAideUpload } from "./lib/aideUploadMimes";
import { extractTextWithClaude } from "./lib/claudeFileExtraction";
import { extractDirectText } from "./lib/fileTextExtraction";
import { MODELS } from "./lib/models";

export const ACTIVITY_RESOURCE_STORED_TEXT_CHARS = 100_000;

function resourceModel(): string {
  return process.env.ACTIVITY_RESOURCE_MODEL || MODELS.SONNET;
}

export const extractText = internalAction({
  args: { resourceId: v.id("activityResources") },
  handler: async (ctx, args) => {
    const resource = await ctx.runQuery(
      internal.activityResources.getForExtraction,
      args,
    );
    if (!resource || resource.source.kind !== "file") return null;
    const institutionId = resource.teacherId
      ? await ctx.runQuery(internal.usage.resolveInstitution, {
          userId: resource.teacherId,
          principal: "staff",
        })
      : null;

    await ctx.runMutation(internal.activityResources.setExtractionStatus, {
      resourceId: args.resourceId,
      status: "extracting",
    });

    try {
      const blob = await ctx.storage.get(resource.source.fileStorageId);
      if (!blob) throw new Error("Storage blob missing");
      const bytes = new Uint8Array(await blob.arrayBuffer());
      const kind = classifyAideUpload(
        resource.source.mimeType,
        resource.source.fileName,
      );
      const text =
        kind === "docx" || kind === "rtf" || kind === "text"
          ? extractDirectText(bytes, kind)
          : await extractTextWithClaude(ctx, {
              bytes,
              mimeType: resource.source.mimeType,
              model: resourceModel(),
              usageSource: "activity-resource-extract",
              institutionId,
            });
      if (!text.trim()) throw new Error("No readable text found");
      const storedText =
        text.length > ACTIVITY_RESOURCE_STORED_TEXT_CHARS
          ? `${text.slice(0, ACTIVITY_RESOURCE_STORED_TEXT_CHARS)}\n[truncated]`
          : text;
      await ctx.runMutation(internal.activityResources.setExtractedText, {
        resourceId: args.resourceId,
        text: storedText,
      });
      return { ok: true as const };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await ctx.runMutation(internal.activityResources.setExtractionStatus, {
        resourceId: args.resourceId,
        status: "error",
        error: message.slice(0, 500),
      });
      return { ok: false as const, error: message };
    }
  },
});
