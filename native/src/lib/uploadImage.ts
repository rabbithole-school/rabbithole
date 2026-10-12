import {
  cacheDirectory,
  deleteAsync,
  EncodingType,
  FileSystemUploadType,
  uploadAsync,
  writeAsStringAsync,
} from "expo-file-system/legacy";

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

export async function uploadImageDataUrl(
  uploadUrl: string,
  dataUrl: string,
): Promise<Id<"_storage">> {
  const match = /^data:(image\/(?:jpeg|png));base64,(.+)$/.exec(dataUrl);
  if (!match) throw new Error("Image was not a JPEG or PNG data URL");
  if (!cacheDirectory) throw new Error("No cache directory is available");
  const extension = match[1] === "image/png" ? "png" : "jpg";
  const uri =
    `${cacheDirectory}app-snapshot-${Date.now()}-` +
    `${Math.random().toString(36).slice(2)}.${extension}`;
  await writeAsStringAsync(uri, match[2], {
    encoding: EncodingType.Base64,
  });
  try {
    return await uploadFileUri(uploadUrl, uri, match[1]);
  } finally {
    await deleteAsync(uri, { idempotent: true }).catch((error) =>
      console.warn("[image] temporary upload cleanup failed", error),
    );
  }
}
