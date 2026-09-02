"use client";

/**
 * Downscale a camera photo before upload: phone photos are 3–12 MB and
 * Anthropic image blocks cap at 5 MB / ~1568px useful resolution. Longest
 * side → 1568px, JPEG q0.85 (typically 200–500 KB). Used by the School Space
 * add-by-photo page and the equipment edit dialog.
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

export async function downscalePhoto(file: File): Promise<Blob> {
  const MAX_DIM = 1568;
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, MAX_DIM / Math.max(bitmap.width, bitmap.height));
  const w = Math.round(bitmap.width * scale);
  const h = Math.round(bitmap.height * scale);
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  canvas.getContext("2d")!.drawImage(bitmap, 0, 0, w, h);
  bitmap.close();
  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, "image/jpeg", 0.85),
  );
  if (!blob) throw new Error("Could not process the photo");
  return blob;
}
