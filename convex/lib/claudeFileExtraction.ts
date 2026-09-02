// Shared Claude-backed extraction for PDFs and images.
//
// Claude reads PDFs and raster images natively, so the "extract the plain text
// of this file" path is a single Anthropic call with a strict prompt. This is
// the one home for that call + the file-block construction; scholarDocuments'
// extraction step is the first consumer. DOCX / RTF / plain text do NOT come
// here — they are parsed locally in lib/fileTextExtraction.ts.

import type { ActionCtx } from "../_generated/server";
import { recordAnthropicUsage } from "../usage";
import type { Id } from "../_generated/dataModel";
import { imageMediaType } from "./ingestMimes";
import { ROLES } from "./roles";
import { requireAnthropicApiKey } from "./anthropic";

const FILE_EXTRACTION_PROMPT = `Extract the full text content of the attached
document. Return plain text only — no markdown formatting, no headings, no
bullet characters unless they are present in the original. Preserve paragraph
breaks. Include tables and lists as plain text. Do not summarize, do not
abbreviate, do not editorialize. If a section is unreadable, write
"[unreadable]" in place of that section.`;

// The Anthropic content-block params we send. Kept structural (not the SDK's
// full union) so this module needn't pull in the SDK types eagerly.
type ClaudeFileBlock =
  | {
      type: "document";
      source: { type: "base64"; media_type: "application/pdf"; data: string };
    }
  | {
      type: "image";
      source: {
        type: "base64";
        media_type: "image/jpeg" | "image/png" | "image/gif" | "image/webp";
        data: string;
      };
    };

// Build the file block Claude needs for a stored upload: an image block for a
// supported raster image, otherwise a PDF document block. Anything that is
// neither a supported image nor a PDF is rejected loudly rather than mislabeled
// as a PDF. Image-type support is shared with the scanner pipeline via
// ingestMimes.imageMediaType so the accepted set stays in one place.
function buildClaudeFileBlock(
  bytes: Uint8Array,
  mimeType: string,
): ClaudeFileBlock {
  const data = Buffer.from(bytes).toString("base64");
  const imageMime = imageMediaType(mimeType);
  if (imageMime) {
    return {
      type: "image",
      source: { type: "base64", media_type: imageMime, data },
    };
  }
  if (mimeType !== "application/pdf") {
    throw new Error(`Unsupported AI extraction type: ${mimeType}`);
  }
  return {
    type: "document",
    source: { type: "base64", media_type: "application/pdf", data },
  };
}

export async function extractTextWithClaude(
  ctx: ActionCtx,
  args: {
    bytes: Uint8Array;
    mimeType: string;
    model: string;
    usageSource: string;
    institutionId?: Id<"institutions"> | null;
  },
): Promise<string> {
  // Imported lazily so this helper doesn't pull the SDK into a bundle until the
  // extraction actually runs (same dynamic-import idiom as observer.ts).
  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  const anthropic = new Anthropic({ apiKey: requireAnthropicApiKey() });
  const response = await anthropic.messages.create({
    model: args.model,
    max_tokens: 16384,
    messages: [
      {
        role: "user",
        content: [
          buildClaudeFileBlock(args.bytes, args.mimeType),
          { type: "text", text: FILE_EXTRACTION_PROMPT },
        ],
      },
    ],
  });
  await recordAnthropicUsage(ctx, {
    source: args.usageSource,
    role: ROLES.TEACHER,
    institutionId: args.institutionId,
    model: args.model,
    usage: response.usage,
  });
  const text = response.content
    .map((block) => (block.type === "text" ? block.text : ""))
    .join("")
    .trim();
  if (!text) {
    throw new Error(
      `Claude returned empty text (stop_reason: ${response.stop_reason ?? "unknown"})`,
    );
  }
  return text;
}
