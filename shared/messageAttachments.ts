export const MESSAGE_ATTACHMENT_MAX_BYTES = 25 * 1024 * 1024;
export const MESSAGE_ATTACHMENT_MAX_TOTAL_BYTES = 30 * 1024 * 1024;
export const MESSAGE_ATTACHMENT_MAX_COUNT = 10;
export const MESSAGE_ATTACHMENT_ACCEPT =
  "image/*,application/pdf,.txt,.md,text/plain,text/markdown,.rtf,application/rtf,text/rtf,.doc,.docx,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document";

const supportedMimeTypes = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "image/heic",
  "image/heif",
  "application/pdf",
  "text/plain",
  "text/markdown",
  "application/rtf",
  "text/rtf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
]);

const supportedExtensions = new Set([
  "jpg",
  "jpeg",
  "png",
  "gif",
  "webp",
  "heic",
  "heif",
  "pdf",
  "txt",
  "md",
  "rtf",
  "doc",
  "docx",
]);

export type MessageAttachment<TStorageId extends string = string> = {
  storageId: TStorageId;
  fileName: string;
  mimeType?: string;
  sizeBytes?: number;
  /** Whisper transcript of a recorded audio clip or a video's audio track,
   *  produced ONCE at attach time (`audioActions.transcribeAttachment`) so the
   *  model can read what was said — Claude cannot ingest audio or video. */
  transcript?: string;
  /** Video only: a client-rendered contact sheet (up to 4 evenly spaced
   *  frames) so the model gets one glance at what the camera saw. */
  posterStorageId?: TStorageId;
  /** Audio/video only: recorded length, for the "0:42" chip label. */
  durationMs?: number;
};

// Recording caps for the composer's Capture Video / Record Audio dialogs.
// Calibrated to the caps this file already enforces and to Whisper's 25 MB
// per-file limit: 60 s of video at 2.5 Mbps ≈ 19 MB, under
// MESSAGE_ATTACHMENT_MAX_BYTES; 5 min of Opus at 64 kbps ≈ 2.4 MB.
export const MESSAGE_VIDEO_MAX_MS = 60_000;
export const MESSAGE_VIDEO_BITS_PER_SECOND = 2_500_000;
export const MESSAGE_AUDIO_MAX_MS = 5 * 60_000;
export const MESSAGE_AUDIO_BITS_PER_SECOND = 64_000;

export type MessageAttachmentMediaKind = "audio" | "video";

/** "audio" / "video" for a recorded clip, null for every other attachment. */
export function messageAttachmentMediaKind(
  mimeType: string | null | undefined,
): MessageAttachmentMediaKind | null {
  const mime = (mimeType ?? "").split(";")[0].trim().toLowerCase();
  if (mime.startsWith("audio/")) return "audio";
  if (mime.startsWith("video/")) return "video";
  return null;
}

export type MessageAttachmentFileDescriptor = {
  name: string;
  type: string;
  size: number;
};

function extensionOf(fileName: string): string {
  return fileName.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? "";
}

export function safeMessageAttachmentFileName(value: string): string {
  const baseName = value.split(/[\\/]/).at(-1)?.trim() ?? "";
  return baseName.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 200);
}

export function isSupportedMessageAttachment(
  mimeType: string,
  fileName: string,
): boolean {
  return (
    supportedMimeTypes.has(mimeType.toLowerCase()) ||
    supportedExtensions.has(extensionOf(fileName))
  );
}

export function validateMessageAttachmentFile(
  file: MessageAttachmentFileDescriptor,
): string | null {
  if (file.size <= 0) return "Choose a non-empty file.";
  if (file.size > MESSAGE_ATTACHMENT_MAX_BYTES) {
    return "Each file must be 25 MB or smaller.";
  }
  if (!isSupportedMessageAttachment(file.type, file.name)) {
    return "Choose a photo, PDF, text file, or Word document.";
  }
  if (!safeMessageAttachmentFileName(file.name)) {
    return "Choose a file with a valid name.";
  }
  return null;
}

export function validateMessageAttachmentSelection(
  currentCount: number,
  incoming: readonly MessageAttachmentFileDescriptor[],
  currentBytes = 0,
): string | null {
  if (currentCount + incoming.length > MESSAGE_ATTACHMENT_MAX_COUNT) {
    return `Attach no more than ${MESSAGE_ATTACHMENT_MAX_COUNT} files to one message.`;
  }
  for (const file of incoming) {
    const error = validateMessageAttachmentFile(file);
    if (error) return error;
  }
  const totalBytes =
    currentBytes +
    incoming.reduce((total, file) => total + file.size, 0);
  if (totalBytes > MESSAGE_ATTACHMENT_MAX_TOTAL_BYTES) {
    return "Attachments must total 30 MB or smaller.";
  }
  return null;
}
