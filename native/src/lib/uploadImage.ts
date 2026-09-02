import { uploadAsync, FileSystemUploadType } from "expo-file-system/legacy";

import type { Id } from "@/lib/convex";

/**
 * Stream a local `file://` image to Convex storage and return its storage id.
 *
 * The one place composer-attachment bytes go up, shared by
 * `useImageAttachment`.
 *
 * `uploadAsync` rather than `fetch(uri).blob()`: in React Native the blob() path
 * silently produces an empty/invalid body for `file://` URIs, which is why
 * camera attach once "did nothing". Throws on a non-2xx so callers own their own
 * error copy.
 */
export async function uploadFileUri(
  uploadUrl: string,
  uri: string,
  mime: string,
  headers: Record<string, string> = {},
): Promise<Id<"_storage">> {
  const res = await uploadAsync(uploadUrl, uri, {
    httpMethod: "POST",
    uploadType: FileSystemUploadType.BINARY_CONTENT,
    headers: { ...headers, "Content-Type": mime },
  });
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`upload failed (${res.status})`);
  }

  const { storageId } = JSON.parse(res.body) as { storageId: Id<"_storage"> };
  return storageId;
}

// Existing image callers retain their focused name; capture stations also send video.
export const uploadImageUri = uploadFileUri;
