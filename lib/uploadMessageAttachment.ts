import {
  safeMessageAttachmentFileName,
  validateMessageAttachmentFile,
  type MessageAttachment,
} from "@/shared/messageAttachments";

export async function uploadMessageAttachment<TStorageId extends string>(
  file: File,
  generateUploadUrl: () => Promise<string>,
): Promise<MessageAttachment<TStorageId>> {
  const validationError = validateMessageAttachmentFile(file);
  if (validationError) throw new Error(validationError);

  const uploadUrl = await generateUploadUrl();
  const response = await fetch(uploadUrl, {
    method: "POST",
    headers: file.type ? { "Content-Type": file.type } : undefined,
    body: file,
  });
  if (!response.ok) {
    throw new Error(`Upload failed for ${file.name}`);
  }
  const result = (await response.json()) as { storageId?: string };
  if (!result.storageId) {
    throw new Error(`Upload did not return a file id for ${file.name}`);
  }
  return {
    storageId: result.storageId as TStorageId,
    fileName: safeMessageAttachmentFileName(file.name),
    mimeType: file.type || undefined,
    sizeBytes: file.size,
  };
}
