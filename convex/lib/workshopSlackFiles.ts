// Which of a Workshop reply's Slack uploads can reach the scholar, and what to
// tell the staffer about the rest.
//
// A plain Slack reply under a Workshop idea becomes a message in the scholar's
// Messages (`slackBot.handleWorkshopIdeaThreadReply`). Its photos and files go
// with it, under the SAME rules as the in-app composer
// (`shared/messageAttachments.ts`), so a file Slack can carry and the app
// cannot is refused here rather than half-delivered. Pure: the download and
// storage live in the handler.

import {
  MESSAGE_ATTACHMENT_MAX_BYTES,
  MESSAGE_ATTACHMENT_MAX_COUNT,
  MESSAGE_ATTACHMENT_MAX_TOTAL_BYTES,
  isSupportedMessageAttachment,
  safeMessageAttachmentFileName,
} from "../../shared/messageAttachments";
import { isPdfBytes, sniffImageMime } from "./imageBytes";
import { escapeSlackText } from "./slackText";

/** The fields of a Slack file object this path reads. */
export type WorkshopReplyFile = {
  id: string;
  name?: string;
  title?: string;
  mimetype?: string;
  size?: number;
  url_private_download?: string;
};

export type SkippedFileReason =
  | "unsupported"
  | "too_large"
  | "over_total"
  | "too_many"
  | "download_failed"
  | "store_failed";

export type SkippedFile = { name: string; reason: SkippedFileReason };

/** The name the scholar sees on the attachment chip. */
export function workshopFileName(file: WorkshopReplyFile): string {
  return (
    safeMessageAttachmentFileName(file.name ?? file.title ?? "") ||
    "Slack attachment"
  );
}

/**
 * Why a file can't go, judged from Slack's own description of it before any
 * bytes are fetched, or null. The download link comes first: a stub Slack
 * sends without one (`hidden_by_limit`, `check_file_info`) has no name or type
 * either, and "couldn't download" is the true reason. Slack's `size` is what it
 * will serve; the handler re-checks the real size after download, because the
 * declared one can be absent.
 */
export function screenWorkshopReplyFile(
  file: WorkshopReplyFile,
  name: string,
): SkippedFileReason | null {
  if (!file.url_private_download) return "download_failed";
  if (!isSupportedMessageAttachment(file.mimetype ?? "", name)) {
    return "unsupported";
  }
  if ((file.size ?? 0) > MESSAGE_ATTACHMENT_MAX_BYTES) return "too_large";
  return null;
}

/**
 * Whether one more file of `nextBytes` still fits the message, given what is
 * already STORED. Counting only stored files means a file Slack withheld never
 * uses up the room a later one needs.
 */
export function messageBudgetRefusal(
  storedCount: number,
  storedBytes: number,
  nextBytes: number,
): "too_many" | "over_total" | null {
  if (storedCount >= MESSAGE_ATTACHMENT_MAX_COUNT) return "too_many";
  if (storedBytes + nextBytes > MESSAGE_ATTACHMENT_MAX_TOTAL_BYTES) {
    return "over_total";
  }
  return null;
}

/** Each extension the composer accepts, and the type it is served as. */
const EXTENSION_TYPES: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
  heic: "image/heic",
  heif: "image/heif",
  pdf: "application/pdf",
  txt: "text/plain",
  md: "text/markdown",
  rtf: "application/rtf",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
};

/** Whether the composer's list names this MIME type itself (an empty filename
 *  leaves `isSupportedMessageAttachment` nothing but the type to judge). */
function isAllowedType(mimeType: string): boolean {
  return isSupportedMessageAttachment(mimeType, "");
}

const OPAQUE_TYPES = new Set(["", "application/octet-stream", "binary/octet-stream"]);

/** Each image type's complete leading signature. `sniffImageMime` is loose on
 *  purpose for its callers (two bytes name a GIF), which is too little to
 *  overrule a file's own type: text starting "GI" would become a GIF. */
const IMAGE_SIGNATURES: Record<string, ReadonlyArray<number | null>> = {
  "image/png": [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
  "image/jpeg": [0xff, 0xd8, 0xff],
  "image/gif": [0x47, 0x49, 0x46, 0x38], // "GIF8", for both GIF87a and GIF89a
  // "RIFF", four bytes of length, "WEBP"
  "image/webp": [0x52, 0x49, 0x46, 0x46, null, null, null, null, 0x57, 0x45, 0x42, 0x50],
};

/** The image type these bytes are, judged on the full signature, or null. */
function imageTypeOf(head: Uint8Array): string | null {
  const sniffed = sniffImageMime(head);
  const signature = sniffed ? IMAGE_SIGNATURES[sniffed] : undefined;
  if (!sniffed || !signature) return null;
  return signature.every((byte, i) => byte === null || head[i] === byte)
    ? sniffed
    : null;
}

/**
 * The type to store a downloaded file under, always one the composer's list
 * names, or why the file can't go.
 *
 * - Slack answers a download it won't allow (a missing `files:read` scope, a
 *   withheld file) with its sign-in web page and a 200, so an HTML response is
 *   a failed download.
 * - The bytes correct Slack's label only where the label claims an image or a
 *   PDF, or says nothing, and only on a complete signature: a text file that
 *   happens to start "GI" is not a GIF, whatever its label.
 * - Anything else falls back to the type of its extension, so a label outside
 *   the list (`text/html` on a `.txt`, `image/svg+xml` on a `.png`) is never
 *   what storage serves to a scholar's device.
 */
export function storedMimeType(
  declared: string | undefined,
  head: Uint8Array,
  responseType: string,
  fileName: string,
): { mimeType: string } | { skip: SkippedFileReason } {
  if (responseType.toLowerCase().includes("text/html")) {
    return { skip: "download_failed" };
  }
  const declaredType = (declared ?? "").split(";")[0].trim().toLowerCase();
  const opaque = OPAQUE_TYPES.has(declaredType);
  if (opaque || declaredType.startsWith("image/")) {
    const imageType = imageTypeOf(head);
    if (imageType) return { mimeType: imageType };
  }
  if ((opaque || declaredType === "application/pdf") && isPdfBytes(head)) {
    return { mimeType: "application/pdf" };
  }
  if (isAllowedType(declaredType)) return { mimeType: declaredType };
  const extension = fileName.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? "";
  const byExtension = EXTENSION_TYPES[extension];
  return byExtension ? { mimeType: byExtension } : { skip: "unsupported" };
}

const MB = 1024 * 1024;

function reasonText(reason: SkippedFileReason): string {
  switch (reason) {
    case "unsupported":
      return "Rabbithole messages carry only photos, PDFs, text files and Word documents";
    case "too_large":
      return `over the ${MESSAGE_ATTACHMENT_MAX_BYTES / MB} MB limit per file`;
    case "over_total":
      return `over the ${MESSAGE_ATTACHMENT_MAX_TOTAL_BYTES / MB} MB limit per message`;
    case "too_many":
      return `over the ${MESSAGE_ATTACHMENT_MAX_COUNT}-file limit per message`;
    case "download_failed":
      return "Slack wouldn't let me download it";
    case "store_failed":
      return "something went wrong saving it";
  }
}

/** A filename as inline code, so its underscores and asterisks stay literal
 *  in Slack's mrkdwn and nothing in it can open a mention or link. */
function fileLabel(name: string): string {
  return `\`${escapeSlackText(name.replace(/`/g, "'"))}\``;
}

/** What a reply carried that will not reach the scholar. */
export type LeftBehind = {
  skipped: readonly SkippedFile[];
  /** The reply forwards another Slack message. Its words and files are not
   *  passed on: a forward can carry a staff-room conversation into a child's
   *  Messages, so the staffer posts what the child should see directly. */
  forwarded: boolean;
};

function leftBehindList({ skipped, forwarded }: LeftBehind): string[] {
  const items = skipped.map(
    (file) => `${fileLabel(file.name)} (${reasonText(file.reason)})`,
  );
  if (forwarded) {
    items.push(
      "the forwarded message (forwards aren't passed on to scholars, so post what they should see here directly)",
    );
  }
  return items;
}

/**
 * What to post under a RECORDED reply, or null when everything went. The ✅
 * reaction already says the reply reached the scholar; this names what did not
 * go with it, so a missing photo is never silent.
 */
export function skippedFilesNotice(left: LeftBehind): string | null {
  const items = leftBehindList(left);
  return items.length > 0
    ? `⚠️ Your reply reached the scholar without ${items.join(", ")}.`
    : null;
}

/** What to post when nothing was sent: no words, and nothing that could go. */
export function emptyReplyNotice(left: LeftBehind): string {
  const items = leftBehindList(left);
  return items.length > 0
    ? `⚠️ I didn't send that to the scholar. Nothing in it could go: ${items.join(", ")}.`
    : "⚠️ I didn't send that to the scholar: the reply was empty.";
}
