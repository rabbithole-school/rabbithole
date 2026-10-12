"use client";

import {
  DOWNSCALED_JPEG_QUALITY,
  downscaleTarget,
  type ImageSize,
} from "@/shared/imageDownscale";

/**
 * Downscale a camera photo before upload: phone photos are 3–12 MB, and the
 * model can only use ~1568 px of long edge (`MODEL_IMAGE_MAX_EDGE_PX`, shared
 * with the native resizer). `createImageBitmap` applies EXIF orientation, and a
 * canvas re-encode writes no EXIF, so the result is upright and carries no
 * location data.
 */
/**
 * Downscale + upload an equipment photo to Convex storage. Shared by the
 * add-by-photo page and the equipment edit dialog so the two flows can't
 * drift. Returns the storage id plus a local object URL for preview (caller
 * revokes it when done).
 */
export async function uploadEquipmentPhoto(
  generateUploadUrl: () => Promise<string>,
  file: File,
): Promise<{ storageId: string; previewUrl: string }> {
  const blob = await downscalePhoto(file);
  const uploadUrl = await generateUploadUrl();
  const res = await fetch(uploadUrl, {
    method: "POST",
    headers: { "Content-Type": "image/jpeg" },
    body: blob,
  });
  if (!res.ok) throw new Error("Upload failed");
  const { storageId } = (await res.json()) as { storageId: string };
  return { storageId, previewUrl: URL.createObjectURL(blob) };
}

/** Always re-encodes to JPEG (capped at the model's size); throws on failure. */
export async function downscalePhoto(file: File): Promise<Blob> {
  const bitmap = await createImageBitmap(file);
  const size = { width: bitmap.width, height: bitmap.height };
  return encodeBitmap(bitmap, downscaleTarget(size) ?? size, "image/jpeg");
}

/**
 * The photo a scholar attaches to a tutor chat or a photo deliverable, capped
 * at the model's size. Returns the original file untouched when it already
 * fits, isn't a still photo, or can't be resized: a full-size upload is better
 * than a lost photo. A PNG stays a PNG (it may have transparency).
 */
export async function capPhotoForUpload(file: File): Promise<Blob> {
  if (!file.type.startsWith("image/") || file.type === "image/gif" || file.type === "image/svg+xml") {
    return file;
  }
  try {
    const bitmap = await createImageBitmap(file);
    const target = downscaleTarget({ width: bitmap.width, height: bitmap.height });
    if (!target) {
      bitmap.close();
      return file;
    }
    return await encodeBitmap(
      bitmap,
      target,
      file.type === "image/png" ? "image/png" : "image/jpeg",
    );
  } catch (error) {
    console.warn("[image] downscale failed, uploading the original", error);
    return file;
  }
}

async function encodeBitmap(
  bitmap: ImageBitmap,
  size: ImageSize,
  type: "image/jpeg" | "image/png",
): Promise<Blob> {
  const canvas = document.createElement("canvas");
  canvas.width = size.width;
  canvas.height = size.height;
  const context = canvas.getContext("2d");
  if (!context) {
    bitmap.close();
    throw new Error("Could not process the photo");
  }
  context.imageSmoothingQuality = "high";
  context.drawImage(bitmap, 0, 0, size.width, size.height);
  bitmap.close();
  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, type, DOWNSCALED_JPEG_QUALITY),
  );
  if (!blob) throw new Error("Could not process the photo");
  return blob;
}
