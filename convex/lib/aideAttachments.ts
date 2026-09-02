import type { Anthropic } from "@anthropic-ai/sdk";
import type { GenericActionCtx } from "convex/server";
import type { DataModel, Id } from "../_generated/dataModel";
import { classifyAideUpload } from "./aideUploadMimes";
import { extractDirectText } from "./fileTextExtraction";
import { getValidAccessToken } from "./googleTokens";
import { bytesToBase64, sniffImageMime } from "./imageBytes";

const MAX_EXTRACTED_TEXT_CHARS = 100_000;

// A linked Drive file is downloaded whole into the isolate before it's base64'd
// into the request, so cap it — and cap it at the limit the MODEL will accept,
// not just what the isolate survives. Anthropic rejects a base64 image over
// 5 MB, so a 6 MB Drive photo that passed a generic 20 MB guard would sail
// through here and then 400 the whole turn. Per-kind caps keep an oversize file
// on the graceful `{ note }` path instead.
const MAX_DRIVE_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_DRIVE_DOWNLOAD_BYTES = 20 * 1024 * 1024;

const GOOGLE_NATIVE_PREFIX = "application/vnd.google-apps.";

// Google-native files have no bytes to download — they only come out through
// /export, and only in the formats Google offers for that type.
const GOOGLE_NATIVE_EXPORT_MIME: Record<string, string> = {
  "application/vnd.google-apps.document": "text/plain",
  "application/vnd.google-apps.presentation": "text/plain",
  "application/vnd.google-apps.spreadsheet": "text/csv",
};

type AideContentBlock = Anthropic.Beta.BetaContentBlockParam;

export type AideContextAttachment = {
  storageId: Id<"_storage">;
  fileName: string;
  mimeType: string | null;
  sizeBytes: number | null;
  url: string | null;
};

export type AideDriveAttachment = {
  driveFileId: string;
  url: string;
  name: string;
  mimeType: string;
  thumbnailUrl?: string;
};

export type AideContextMessage = {
  role: "user" | "assistant";
  content: string;
  attachments?: AideContextAttachment[];
  driveAttachments?: AideDriveAttachment[];
};

export function aideMessageHasFiles(m: AideContextMessage): boolean {
  return (
    (m.attachments?.length ?? 0) > 0 ||
    (m.driveAttachments?.length ?? 0) > 0
  );
}

export async function buildAideUserContent(
  ctx: GenericActionCtx<DataModel>,
  userId: Id<"users">,
  m: AideContextMessage,
): Promise<AideContentBlock[] | string> {
  const attachments = m.attachments ?? [];
  const driveAttachments = m.driveAttachments ?? [];

  if (
    m.role !== "user" ||
    (attachments.length === 0 && driveAttachments.length === 0)
  ) {
    return m.content;
  }

  const noteParts: string[] = [];
  const fileBlocks: AideContentBlock[] = [];
  const notShownInline: string[] = [];

  if (m.content.trim()) noteParts.push(m.content);

  for (const attachment of attachments) {
    const title = attachment.fileName || "attachment";
    const kind = classifyAideUpload(attachment.mimeType, title);

    if (kind === "image") {
      if (attachment.url) {
        fileBlocks.push({
          type: "image",
          source: { type: "url", url: attachment.url },
        });
      } else {
        notShownInline.push(title);
      }
      continue;
    }

    if (kind === "pdf") {
      if (attachment.url) {
        fileBlocks.push({
          type: "document",
          source: { type: "url", url: attachment.url },
        });
      } else {
        notShownInline.push(title);
      }
      continue;
    }

    if (kind === "other") {
      notShownInline.push(title);
      continue;
    }

    if (!attachment.url) {
      noteParts.push(`[Could not extract text from ${title}]`);
      continue;
    }

    try {
      const bytes = await fetchBytes(attachment.url);
      fileBlocks.push(textDocumentBlock(title, extractDirectText(bytes, kind)));
    } catch {
      noteParts.push(`[Could not extract text from ${title}]`);
    }
  }

  if (notShownInline.length > 0) {
    noteParts.push(
      `[Attached file(s) not shown inline: ${notShownInline.join(", ")}]`,
    );
  }

  if (driveAttachments.length > 0) {
    let accessToken: string | null = null;
    try {
      accessToken = await getValidAccessToken(ctx, userId);
    } catch {
      for (const doc of driveAttachments) {
        noteParts.push(`[Could not read linked Google Drive file "${doc.name}"]`);
      }
    }

    if (accessToken) {
      for (const doc of driveAttachments) {
        try {
          const result = await driveAttachmentToBlock(doc, accessToken);
          if ("note" in result) noteParts.push(result.note);
          else fileBlocks.push(result.block);
        } catch {
          noteParts.push(
            `[Could not read linked Google Drive file "${doc.name}"]`,
          );
        }
      }
    }
  }

  const blocks: AideContentBlock[] = [];
  if (noteParts.length > 0) {
    blocks.push({ type: "text", text: noteParts.join("\n\n") });
  }
  blocks.push(...fileBlocks);

  if (blocks.length === 0) {
    return [{ type: "text", text: m.content || "(file attached)" }];
  }
  return blocks;
}

async function fetchBytes(url: string): Promise<Uint8Array> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Attachment fetch failed: ${response.status}`);
  }
  return new Uint8Array(await response.arrayBuffer());
}

async function exportDriveFileText(
  driveFileId: string,
  accessToken: string,
  exportMime: string,
): Promise<string> {
  const url = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(
    driveFileId,
  )}/export?mimeType=${encodeURIComponent(exportMime)}`;
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) {
    throw new Error(`Drive export failed: ${response.status}`);
  }
  return await response.text();
}

/** Download a non-Google-native Drive file's bytes. Returns null when the
 *  file exceeds `maxBytes` so the caller can note it instead of blowing up. */
async function downloadDriveFileBytes(
  driveFileId: string,
  accessToken: string,
  maxBytes: number,
): Promise<Uint8Array | null> {
  const url = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(
    driveFileId,
  )}?alt=media`;
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) {
    throw new Error(`Drive download failed: ${response.status}`);
  }
  // Bail on the declared size before buffering the body when Drive tells us
  // (it usually does); the post-read check below is the backstop for when it
  // doesn't.
  const declared = Number(response.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > maxBytes) {
    return null;
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  return bytes.byteLength > maxBytes ? null : bytes;
}

/**
 * Turn a picked Drive file into a model-visible content block.
 *
 * Two worlds: Google-native files (Docs / Slides / Sheets / ...) have no bytes
 * to download and only come out through /export; everything else is a real
 * binary we fetch with ?alt=media and then run through the SAME classifier +
 * extractors the direct-upload path uses, so a linked PDF / image / docx
 * behaves exactly like an uploaded one.
 *
 * Returns a `{ note }` sentinel instead of throwing when a file is reachable
 * but can't be shown inline (a Drawing, a Form, an unsupported binary, an
 * oversized download) — the caller mentions it in the text preamble rather than
 * failing the whole turn.
 */
async function driveAttachmentToBlock(
  doc: AideDriveAttachment,
  accessToken: string,
): Promise<{ block: AideContentBlock } | { note: string }> {
  const title = doc.name || "Drive file";
  const mime = doc.mimeType ?? "";

  if (mime.startsWith(GOOGLE_NATIVE_PREFIX)) {
    const exportMime = GOOGLE_NATIVE_EXPORT_MIME[mime];
    if (!exportMime) {
      return {
        note: `[Linked Google Drive file "${title}" is a Google ${mime.slice(
          GOOGLE_NATIVE_PREFIX.length,
        )} and can't be shown inline]`,
      };
    }
    const text = await exportDriveFileText(
      doc.driveFileId,
      accessToken,
      exportMime,
    );
    return { block: textDocumentBlock(title, text) };
  }

  // Classify BEFORE downloading — it's a pure mime/name function, and the size
  // cap the model will tolerate depends on the kind.
  const kind = classifyAideUpload(mime, title);
  const maxBytes =
    kind === "image" ? MAX_DRIVE_IMAGE_BYTES : MAX_DRIVE_DOWNLOAD_BYTES;

  if (kind === "other") {
    return {
      note: `[Linked Google Drive file "${title}" can't be shown inline]`,
    };
  }

  const bytes = await downloadDriveFileBytes(
    doc.driveFileId,
    accessToken,
    maxBytes,
  );
  if (bytes === null) {
    return {
      note: `[Linked Google Drive file "${title}" is too large to read inline]`,
    };
  }

  if (kind === "image") {
    // classifyAideUpload says "image" for ANY image/* (HEIC, TIFF, BMP, SVG…),
    // but the model takes only jpeg/png/gif/webp — so trust the magic bytes,
    // never a guessed fallback. No signature => note it rather than send a
    // mislabeled block that would 400 the entire turn.
    const mediaType = sniffImageMime(bytes);
    if (!mediaType) {
      return {
        note: `[Linked Google Drive file "${title}" is an image format that can't be shown inline]`,
      };
    }
    return {
      block: {
        type: "image",
        source: {
          type: "base64",
          media_type: mediaType,
          data: bytesToBase64(bytes),
        },
      },
    };
  }

  if (kind === "pdf") {
    return {
      block: {
        type: "document",
        source: {
          type: "base64",
          media_type: "application/pdf",
          data: bytesToBase64(bytes),
        },
        title,
      },
    };
  }

  return { block: textDocumentBlock(title, extractDirectText(bytes, kind)) };
}

function textDocumentBlock(title: string, data: string): AideContentBlock {
  return {
    type: "document",
    source: {
      type: "text",
      media_type: "text/plain",
      data: capExtractedText(data),
    },
    title,
  };
}

function capExtractedText(text: string): string {
  if (text.length <= MAX_EXTRACTED_TEXT_CHARS) return text;
  return `${text.slice(0, MAX_EXTRACTED_TEXT_CHARS)}…[truncated]`;
}
