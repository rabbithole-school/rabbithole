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
};

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
