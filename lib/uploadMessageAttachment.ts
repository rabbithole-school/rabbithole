import {
  safeMessageAttachmentFileName,
  validateMessageAttachmentFile,
  type MessageAttachment,
} from "@/shared/messageAttachments";

/**
 * Raw upload to Convex storage — POST the file to a generated upload URL and
 * return its storage id. No content-type validation, so recorded audio/video
 * clips (and their poster JPEGs), whose mime types are not in the picked-file
 * allow-list, share exactly one upload path with picked files.
 */
export async function uploadToConvexStorage<TStorageId extends string>(
  file: File,
  generateUploadUrl: () => Promise<string>,
): Promise<TStorageId> {
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
  return result.storageId as TStorageId;
}

export async function uploadMessageAttachment<TStorageId extends string>(
  file: File,
  generateUploadUrl: () => Promise<string>,
): Promise<MessageAttachment<TStorageId>> {
  const validationError = validateMessageAttachmentFile(file);
  if (validationError) throw new Error(validationError);

  const storageId = await uploadToConvexStorage<TStorageId>(
    file,
    generateUploadUrl,
  );
  return {
    storageId,
    fileName: safeMessageAttachmentFileName(file.name),
    mimeType: file.type || undefined,
    sizeBytes: file.size,
  };
}
