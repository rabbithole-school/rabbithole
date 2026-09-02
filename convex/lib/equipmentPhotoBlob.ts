/**
 * Conservative raw-input cap for one equipment-identification image.
 *
 * Base64 expands this 5 MiB source image to at most 6.67 MiB, leaving ample
 * room below Anthropic's 10 MB encoded-image and 32 MB request limits.
 */
export const MAX_EQUIPMENT_PHOTO_BYTES = 5 * 1024 * 1024;

type BlobLike = {
  readonly size: number;
  arrayBuffer(): Promise<ArrayBuffer>;
};

/**
 * Enforce the photo boundary before materializing its bytes for vision input.
 * Kept independent of Convex storage so callers and tests can prove the read
 * cannot happen for oversized blobs.
 */
export async function readBoundedEquipmentPhoto(
  blob: BlobLike,
): Promise<Uint8Array> {
  if (blob.size > MAX_EQUIPMENT_PHOTO_BYTES) {
    throw new Error("Photo is too large (max 5 MiB).");
  }
  return new Uint8Array(await blob.arrayBuffer());
}

export async function withBoundedEquipmentPhoto<T>(
  blob: BlobLike,
  identify: (bytes: Uint8Array) => Promise<T>,
): Promise<T> {
  const bytes = await readBoundedEquipmentPhoto(blob);
  return await identify(bytes);
}
